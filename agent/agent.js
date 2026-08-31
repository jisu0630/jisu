// claude-fleet PC 에이전트
// 각 PC에서 상주하며:
// - 허브에 WebSocket 으로 접속해 이 PC의 프로젝트/세션 상태를 보고
// - 대시보드에서 온 명령(세션 시작 / 프롬프트 / 중지)을 받아
//   `claude --print --input-format stream-json --output-format stream-json` 프로세스를 관리
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const configPath = process.argv[2] || 'fleet-agent.config.json';
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`설정 파일을 읽을 수 없습니다: ${configPath}\n${e.message}`);
  console.error('agent/fleet-agent.config.example.json 을 복사해서 만드세요.');
  process.exit(1);
}

const HUB = cfg.hub;                       // 예: ws://hub-host:8787
const TOKEN = cfg.token;
const PC_NAME = cfg.pcName || os.hostname();
const PROJECTS = (cfg.projects || []).map((p) => ({ name: p.name, path: path.resolve(p.path) }));
// 실행 파일에 경로가 들어오면(예: 목 테스트) 설정 파일 위치 기준으로 절대경로화
function resolveBin(bin) {
  if (bin.includes('/') || bin.includes('\\')) {
    return path.resolve(path.dirname(path.resolve(configPath)), bin);
  }
  return bin;
}
const CLAUDE_BIN = resolveBin(cfg.claudeBin || 'claude');
const PERMISSION_MODE = cfg.permissionMode || 'acceptEdits';
const MODEL = cfg.model || null;
const INCLUDE_PARTIAL = Boolean(cfg.includePartialMessages);

// Codex CLI 지원 (선택): 설정에 engines.codex 가 있으면 대시보드에서 Codex 세션도 시작 가능
// 예: "engines": { "codex": { "bin": "codex", "extraArgs": ["--full-auto"] } }
const CODEX = cfg.engines && cfg.engines.codex ? {
  bin: resolveBin(cfg.engines.codex.bin || 'codex'),
  extraArgs: Array.isArray(cfg.engines.codex.extraArgs) ? cfg.engines.codex.extraArgs : ['--full-auto'],
} : null;
const ENGINES = CODEX ? ['claude', 'codex'] : ['claude'];

// 대시보드 모델 드롭다운에 보여줄 목록. 설정의 models 로 덮어쓸 수 있다.
// 예: "models": { "claude": ["opus", "sonnet"], "codex": ["gpt-5.1-codex"] }
const MODELS = {
  claude: cfg.models?.claude || ['fable', 'opus', 'sonnet', 'haiku'],
  codex: cfg.models?.codex || ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1'],
};

if (!HUB || !TOKEN) {
  console.error('설정에 hub 와 token 이 필요합니다.');
  process.exit(1);
}

/** sessionKey -> { key, project, proc, sessionId, status, title, updatedAt } */
const sessions = new Map();
let ws = null;
let reconnectDelay = 2000;
let stateTimer = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sendToHub(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function reportState() {
  // 잦은 변경을 200ms 로 묶어서 전송
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    sendToHub({
      type: 'state',
      platform: `${os.platform()} ${os.release()}`,
      engines: ENGINES,
      models: MODELS,
      projects: PROJECTS.map((p) => ({ name: p.name, path: p.path })),
      sessions: [...sessions.values()].map((s) => ({
        key: s.key,
        sessionId: s.sessionId,
        project: s.project.name,
        engine: s.engine,
        model: s.model,
        status: s.status,
        title: s.title,
        updatedAt: s.updatedAt,
      })),
    });
  }, 200);
}

function emitEvent(sessionKey, event) {
  sendToHub({ type: 'event', sessionKey, event });
}

function buildArgs(session, resumeId) {
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', PERMISSION_MODE,
  ];
  if (INCLUDE_PARTIAL) args.push('--include-partial-messages');
  const model = session.model || MODEL;
  if (model) args.push('--model', model);
  if (resumeId) args.push('--resume', resumeId);
  return args;
}

function writeUserMessage(session, text) {
  const line = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
  session.proc.stdin.write(line + '\n');
}

function spawnClaude(session, resumeId) {
  const proc = spawn(CLAUDE_BIN, buildArgs(session, resumeId), {
    cwd: session.project.path,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // Windows 에서는 claude 가 .cmd 심이라 shell 필요
  });
  session.proc = proc;
  session.status = 'starting';
  session.updatedAt = Date.now();

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      emitEvent(session.key, { type: 'stderr', text: line });
      return;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      session.sessionId = event.session_id || session.sessionId;
      session.status = session.pendingTurn ? 'running' : 'idle';
    } else if (event.type === 'result') {
      session.status = 'idle';
      session.pendingTurn = false;
    } else if (event.type === 'assistant') {
      session.status = 'running';
    }
    session.updatedAt = Date.now();
    emitEvent(session.key, event);
    reportState();
  });

  const rlErr = readline.createInterface({ input: proc.stderr });
  rlErr.on('line', (line) => {
    if (line.trim()) emitEvent(session.key, { type: 'stderr', text: line });
  });

  proc.on('error', (err) => {
    session.status = 'error';
    session.updatedAt = Date.now();
    emitEvent(session.key, { type: 'stderr', text: `claude 실행 실패: ${err.message}` });
    reportState();
  });

  proc.on('exit', (code) => {
    if (session.status !== 'stopped' && session.status !== 'error') {
      session.status = code === 0 ? 'exited' : 'error';
    }
    session.updatedAt = Date.now();
    emitEvent(session.key, { type: 'agent', text: `프로세스 종료 (code ${code})` });
    reportState();
  });
}

/* ---------------- Codex 어댑터 ----------------
 * codex exec --json 은 JSONL 이벤트(thread.started / item.* / turn.completed)를 내보낸다.
 * 이를 대시보드가 아는 Claude 이벤트 형식으로 변환한다. 턴마다 프로세스를 새로 띄우고
 * 이후 턴은 `codex exec resume <thread_id>` 로 이어간다. 프롬프트는 stdin('-')으로 전달. */

function codexToolUse(name, hint) {
  return { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'codex', name, input: { command: String(hint || '').slice(0, 200) } },
  ] } };
}

function normalizeCodexEvent(ev) {
  const out = [];
  const item = ev.item || {};
  switch (ev.type) {
    case 'thread.started':
      out.push({ type: 'system', subtype: 'init', session_id: ev.thread_id, model: 'codex' });
      break;
    case 'turn.completed':
      out.push({ type: 'result', subtype: 'success', num_turns: 1, usage: ev.usage || {} });
      break;
    case 'turn.failed':
    case 'error':
      out.push({ type: 'stderr', text: ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 500) });
      break;
    case 'item.started':
      if (item.type === 'command_execution') out.push(codexToolUse('Bash', item.command));
      else if (item.type === 'mcp_tool_call') out.push(codexToolUse(item.tool || 'MCP', item.server));
      break;
    case 'item.completed':
      if (item.type === 'agent_message' && item.text) {
        out.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: item.text }] } });
      } else if (item.type === 'command_execution') {
        out.push({ type: 'user', message: { role: 'user', content: [{
          type: 'tool_result', is_error: item.exit_code != null && item.exit_code !== 0,
          content: String(item.aggregated_output || '').slice(0, 4000),
        }] } });
      } else if (item.type === 'file_change') {
        const desc = (item.changes || []).map((c) => `${c.kind || ''} ${c.path || ''}`).join(', ');
        out.push(codexToolUse('FileChange', desc));
      }
      break;
    default:
      break;
  }
  return out;
}

function runCodexTurn(session, text) {
  const resuming = Boolean(session.sessionId);
  const args = ['exec'];
  if (resuming) args.push('resume', session.sessionId);
  args.push('--json', ...CODEX.extraArgs);
  if (session.model) args.push('-m', session.model);
  args.push('-');
  const proc = spawn(CODEX.bin, args, {
    cwd: session.project.path,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  session.proc = proc;
  session.status = 'running';
  session.updatedAt = Date.now();
  proc.stdin.write(text);
  proc.stdin.end();

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; } // codex 는 JSON 외 안내 문구도 출력할 수 있음
    if (ev.type === 'thread.started') {
      if (ev.thread_id) session.sessionId = ev.thread_id;
      if (resuming) return; // 이어지는 턴에서는 "세션 시작" 표시 생략
    }
    for (const norm of normalizeCodexEvent(ev)) emitEvent(session.key, norm);
    session.updatedAt = Date.now();
  });
  const rlErr = readline.createInterface({ input: proc.stderr });
  rlErr.on('line', (line) => {
    if (line.trim()) emitEvent(session.key, { type: 'stderr', text: line });
  });
  proc.on('error', (err) => {
    session.status = 'error';
    emitEvent(session.key, { type: 'stderr', text: `codex 실행 실패: ${err.message}` });
    reportState();
  });
  proc.on('exit', (code) => {
    if (session.status !== 'stopped') session.status = code === 0 ? 'idle' : 'error';
    session.updatedAt = Date.now();
    const next = session.queue.shift();
    if (next && session.status === 'idle') {
      emitEvent(session.key, { type: 'user_input', text: next, ts: Date.now() });
      runCodexTurn(session, next);
    }
    reportState();
  });
  reportState();
}

function startSession({ project: projectName, prompt, engine, model }) {
  const project = PROJECTS.find((p) => p.name === projectName);
  if (!project) return;
  const eng = engine === 'codex' ? 'codex' : 'claude';
  if (eng === 'codex' && !CODEX) return;
  const key = crypto.randomBytes(4).toString('hex');
  const session = {
    key,
    project,
    engine: eng,
    model: typeof model === 'string' && model.trim() ? model.trim().slice(0, 64) : null,
    proc: null,
    sessionId: null,
    status: 'starting',
    title: (prompt || '').slice(0, 60) || '(새 세션)',
    updatedAt: Date.now(),
    pendingTurn: Boolean(prompt),
    queue: [],
  };
  sessions.set(key, session);
  log(`세션 시작: ${project.name} [${key}] (${eng})`);
  if (eng === 'codex') {
    if (prompt) {
      emitEvent(key, { type: 'user_input', text: prompt, ts: Date.now() });
      runCodexTurn(session, prompt);
    } else {
      session.status = 'idle';
    }
  } else {
    spawnClaude(session);
    if (prompt) {
      emitEvent(key, { type: 'user_input', text: prompt, ts: Date.now() });
      writeUserMessage(session, prompt);
      session.status = 'running';
    }
  }
  reportState();
}

function promptSession({ sessionKey, text }) {
  const session = sessions.get(sessionKey);
  if (!session || !text) return;
  if (session.engine === 'codex') {
    const busy = session.proc && session.proc.exitCode === null && !session.proc.killed;
    if (busy) {
      session.queue.push(text); // 진행 중인 턴이 끝나면 자동 전송
      emitEvent(sessionKey, { type: 'agent', text: '이전 턴이 끝나면 전송됩니다 (대기열)' });
    } else {
      emitEvent(sessionKey, { type: 'user_input', text, ts: Date.now() });
      runCodexTurn(session, text);
    }
    return;
  }
  emitEvent(sessionKey, { type: 'user_input', text, ts: Date.now() });
  const alive = session.proc && session.proc.exitCode === null && !session.proc.killed;
  if (!alive) {
    if (!session.sessionId) {
      emitEvent(sessionKey, { type: 'stderr', text: '세션이 종료되었고 session_id 가 없어 재개할 수 없습니다.' });
      return;
    }
    log(`세션 재개: ${session.project.name} [${sessionKey}] (${session.sessionId})`);
    spawnClaude(session, session.sessionId);
  }
  session.pendingTurn = true;
  session.status = 'running';
  session.updatedAt = Date.now();
  writeUserMessage(session, text);
  reportState();
}

function stopSession({ sessionKey }) {
  const session = sessions.get(sessionKey);
  if (!session) return;
  session.status = 'stopped';
  session.updatedAt = Date.now();
  if (session.proc && session.proc.exitCode === null) session.proc.kill();
  reportState();
}

function connect() {
  const url = `${HUB.replace(/\/$/, '')}/ws?role=agent&token=${encodeURIComponent(TOKEN)}&pc=${encodeURIComponent(PC_NAME)}`;
  ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectDelay = 2000;
    log(`허브 접속 완료: ${HUB} (pc=${PC_NAME})`);
    reportState();
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'start_session': startSession(msg); break;
      case 'prompt': promptSession(msg); break;
      case 'stop_session': stopSession(msg); break;
      default: break;
    }
  });

  ws.on('close', (code) => {
    log(`허브 연결 끊김 (${code}). ${Math.round(reconnectDelay / 1000)}초 후 재접속`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });

  ws.on('error', (err) => {
    log(`허브 연결 오류: ${err.message}`);
    ws.close();
  });
}

log(`claude-fleet 에이전트 시작 (pc=${PC_NAME}, 프로젝트 ${PROJECTS.length}개, permissionMode=${PERMISSION_MODE})`);
connect();
