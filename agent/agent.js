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
// claudeBin 에 경로가 들어오면(예: 목 테스트) 설정 파일 위치 기준으로 절대경로화
const CLAUDE_BIN = (() => {
  const bin = cfg.claudeBin || 'claude';
  if (bin.includes('/') || bin.includes('\\')) {
    return path.resolve(path.dirname(path.resolve(configPath)), bin);
  }
  return bin;
})();
const PERMISSION_MODE = cfg.permissionMode || 'acceptEdits';
const MODEL = cfg.model || null;
const INCLUDE_PARTIAL = Boolean(cfg.includePartialMessages);

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
      projects: PROJECTS.map((p) => ({ name: p.name, path: p.path })),
      sessions: [...sessions.values()].map((s) => ({
        key: s.key,
        sessionId: s.sessionId,
        project: s.project.name,
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

function buildArgs(resumeId) {
  const args = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', PERMISSION_MODE,
  ];
  if (INCLUDE_PARTIAL) args.push('--include-partial-messages');
  if (MODEL) args.push('--model', MODEL);
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
  const proc = spawn(CLAUDE_BIN, buildArgs(resumeId), {
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

function startSession({ project: projectName, prompt }) {
  const project = PROJECTS.find((p) => p.name === projectName);
  if (!project) return;
  const key = crypto.randomBytes(4).toString('hex');
  const session = {
    key,
    project,
    proc: null,
    sessionId: null,
    status: 'starting',
    title: (prompt || '').slice(0, 60) || '(새 세션)',
    updatedAt: Date.now(),
    pendingTurn: Boolean(prompt),
  };
  sessions.set(key, session);
  log(`세션 시작: ${project.name} [${key}]`);
  spawnClaude(session);
  if (prompt) {
    emitEvent(key, { type: 'user_input', text: prompt, ts: Date.now() });
    writeUserMessage(session, prompt);
    session.status = 'running';
  }
  reportState();
}

function promptSession({ sessionKey, text }) {
  const session = sessions.get(sessionKey);
  if (!session || !text) return;
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
