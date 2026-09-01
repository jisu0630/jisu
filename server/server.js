// claude-fleet 중앙 허브
// - dashboard/index.html 정적 서빙
// - /ws 로 에이전트(각 PC)와 대시보드(브라우저)를 연결하고 메시지를 중계
// - 세션별 최근 이벤트를 버퍼링해서 나중에 접속한 대시보드에도 히스토리 제공
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
// 토큰: FLEET_TOKEN 환경변수 → .fleet-token 파일(npm run setup 이 생성) 순으로 찾는다
const TOKEN = process.env.FLEET_TOKEN || (() => {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.fleet-token'), 'utf8').trim();
  } catch { return null; }
})();
if (!TOKEN || TOKEN.length < 16) {
  console.error('토큰이 없습니다. `npm run setup` 을 먼저 실행하거나 FLEET_TOKEN 환경변수(16자 이상)를 설정하세요.');
  process.exit(1);
}

const DASHBOARD_HTML = path.join(__dirname, '..', 'dashboard', 'index.html');

const MAX_EVENTS_PER_SESSION = 500;
const MAX_SESSION_BUFFERS = 200;

/* ---- 통합 메모리 (fleet-memory) ----
 * 허브가 도는 메인 PC 에 모든 PC 의 세션 대화를 영구 기록한다.
 * - log/          세션별 원본 이벤트(JSONL) — 허브 재시작 후에도 대시보드 히스토리 복원
 * - transcripts/  PC/프로젝트별 읽기 좋은 마크다운 대화록 — 메인 PC 의 Claude 가 검색/참조 가능
 * - INDEX.md      전체 세션 색인
 * 끄려면 FLEET_MEMORY=off, 위치 변경은 FLEET_MEMORY_DIR */
const MEMORY_ENABLED = process.env.FLEET_MEMORY !== 'off';
const MEMORY_DIR = process.env.FLEET_MEMORY_DIR || path.join(__dirname, '..', 'fleet-memory');

function safeName(s) { return String(s || 'unknown').replace(/[^\w.-]/g, '_').slice(0, 64) || 'unknown'; }
function eventLogPath(pc, key) { return path.join(MEMORY_DIR, 'log', `${safeName(pc)}__${safeName(key)}.jsonl`); }
function transcriptPath(pc, project, key) {
  return path.join(MEMORY_DIR, 'transcripts', safeName(pc), safeName(project), `${safeName(key)}.md`);
}

if (MEMORY_ENABLED) {
  fs.mkdirSync(path.join(MEMORY_DIR, 'log'), { recursive: true });
  fs.mkdirSync(path.join(MEMORY_DIR, 'transcripts'), { recursive: true });
  const claudeMd = path.join(MEMORY_DIR, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(claudeMd, [
      '# Fleet 통합 메모리',
      '',
      '이 폴더는 Claude Fleet 허브가 기록한, **모든 PC 에서 진행된 코딩 세션의 대화 기록 보관소**다.',
      '',
      '- `INDEX.md` — 전체 세션 색인 (최신순: 시각 · PC · 프로젝트 · 엔진 · 제목 · 파일 경로)',
      '- `transcripts/<PC>/<프로젝트>/<세션>.md` — 세션별 대화록 (사용자 요청과 어시스턴트 답변)',
      '- `log/` — 원본 이벤트 로그 (도구 실행 내역 포함, JSONL)',
      '',
      '"다른 PC 에서 무슨 작업을 했는지", "예전에 어떻게 해결했는지" 같은 질문을 받으면',
      'INDEX.md 로 세션을 찾은 뒤 해당 대화록을 읽고 답하라.',
      '',
    ].join('\n'));
  }
}

function renderTranscriptMd(ev, engine) {
  if (ev.type === 'user_input') return `\n## 사용자\n${ev.text}\n`;
  if (ev.type === 'assistant') {
    const texts = (ev.message?.content || [])
      .filter((b) => b.type === 'text' && b.text && b.text.trim())
      .map((b) => b.text);
    return texts.map((t) => `\n### 어시스턴트(${engine || 'claude'})\n${t}\n`).join('');
  }
  if (ev.type === 'agent') return `\n> ${ev.text}\n`;
  return '';
}

function persistEvent(pc, msg) {
  if (!MEMORY_ENABLED) return;
  const ev = msg.event || {};
  if (ev.type === 'stream_event') return; // 토큰 단위 부분 출력은 기록하지 않음
  try {
    fs.appendFileSync(eventLogPath(pc, msg.sessionKey), JSON.stringify({ t: Date.now(), event: ev }) + '\n');
    const md = renderTranscriptMd(ev, msg.engine);
    if (md) {
      const p = transcriptPath(pc, msg.project, msg.sessionKey);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, `# ${pc} / ${msg.project || '?'} — 세션 ${msg.sessionKey}\n\n시작: ${new Date().toISOString()}\n`);
      }
      fs.appendFileSync(p, md);
    }
  } catch (e) {
    console.error('[memory] 기록 실패:', e.message);
  }
}

function loadBufferFromDisk(pc, key) {
  if (!MEMORY_ENABLED) return [];
  try {
    const lines = fs.readFileSync(eventLogPath(pc, key), 'utf8').trim().split('\n');
    return lines.slice(-MAX_EVENTS_PER_SESSION)
      .map((l) => { try { return JSON.parse(l).event; } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const indexPath = path.join(MEMORY_DIR, 'index.json');
let memIndex = {};
try { memIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch {}
let indexTimer = null;

function updateIndex(pc, sessions) {
  if (!MEMORY_ENABLED || !Array.isArray(sessions)) return;
  for (const s of sessions) {
    memIndex[`${pc}/${s.key}`] = {
      pc, project: s.project, key: s.key, engine: s.engine, title: s.title, updatedAt: s.updatedAt,
      file: path.relative(MEMORY_DIR, transcriptPath(pc, s.project, s.key)),
    };
  }
  if (indexTimer) return;
  indexTimer = setTimeout(() => { indexTimer = null; writeIndex(); }, 1000);
}

function writeIndex() {
  try {
    fs.writeFileSync(indexPath, JSON.stringify(memIndex, null, 2));
    const rows = Object.values(memIndex).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    let md = '# Fleet 세션 기록 색인\n\n모든 PC 의 세션 대화 기록. 상세 내용은 파일 열람.\n\n'
      + '| 최근 활동 | PC | 프로젝트 | 엔진 | 제목 | 파일 |\n|---|---|---|---|---|---|\n';
    for (const r of rows.slice(0, 500)) {
      md += `| ${r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0, 16) : ''} | ${r.pc} | ${r.project} | ${r.engine || ''} | ${(r.title || '').replace(/\|/g, '/')} | ${r.file} |\n`;
    }
    fs.writeFileSync(path.join(MEMORY_DIR, 'INDEX.md'), md);
  } catch (e) {
    console.error('[memory] 색인 기록 실패:', e.message);
  }
}

/** pcName -> { ws|null, online, platform, lastSeen, projects[], sessions[] } */
const pcs = new Map();
/** 살아있는 에이전트 소켓: pcName -> ws */
const agentSockets = new Map();
const dashboards = new Set();
/** `${pc}\u0000${sessionKey}` -> event[] */
const buffers = new Map();

function safeTokenEqual(a) {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(TOKEN);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function fleetSnapshot() {
  return {
    type: 'fleet',
    pcs: [...pcs.values()].map((p) => ({
      name: p.name,
      online: p.online,
      platform: p.platform,
      lastSeen: p.lastSeen,
      engines: p.engines,
      models: p.models,
      projects: p.projects,
      sessions: p.sessions,
    })),
  };
}

function broadcastFleet() {
  const snap = fleetSnapshot();
  for (const ws of dashboards) send(ws, snap);
}

function bufferKey(pc, sessionKey) {
  return `${pc}\u0000${sessionKey}`;
}

function pushEvent(pc, sessionKey, event) {
  const key = bufferKey(pc, sessionKey);
  let buf = buffers.get(key);
  if (!buf) {
    if (buffers.size >= MAX_SESSION_BUFFERS) {
      const oldest = buffers.keys().next().value;
      buffers.delete(oldest);
    }
    buf = [];
    buffers.set(key, buf);
  }
  buf.push(event);
  if (buf.length > MAX_EVENTS_PER_SESSION) buf.splice(0, buf.length - MAX_EVENTS_PER_SESSION);
}

function handleAgentMessage(pcName, msg) {
  const pc = pcs.get(pcName);
  if (!pc) return;
  switch (msg.type) {
    case 'state':
      pc.platform = msg.platform ?? pc.platform;
      pc.engines = msg.engines ?? pc.engines;
      pc.models = msg.models ?? pc.models;
      pc.projects = msg.projects ?? pc.projects;
      pc.sessions = msg.sessions ?? pc.sessions;
      pc.lastSeen = Date.now();
      updateIndex(pcName, msg.sessions);
      broadcastFleet();
      break;
    case 'event':
      pc.lastSeen = Date.now();
      pushEvent(pcName, msg.sessionKey, msg.event);
      persistEvent(pcName, msg);
      for (const ws of dashboards) {
        send(ws, { type: 'event', pc: pcName, sessionKey: msg.sessionKey, event: msg.event });
      }
      break;
    case 'screenshot_data':
      // 화면 캡처 결과는 저장하지 않고 대시보드로만 중계
      if (msg.image && msg.image.length > 8 * 1024 * 1024) break;
      for (const ws of dashboards) {
        send(ws, { type: 'screenshot_data', pc: pcName, ts: msg.ts, mime: msg.mime, image: msg.image, error: msg.error });
      }
      break;
    default:
      break;
  }
}

function handleDashboardMessage(ws, msg) {
  switch (msg.type) {
    case 'subscribe': {
      let buf = buffers.get(bufferKey(msg.pc, msg.sessionKey));
      if (!buf || !buf.length) {
        // 허브 재시작 등으로 메모리 버퍼가 비었으면 디스크 기록에서 복원
        buf = loadBufferFromDisk(msg.pc, msg.sessionKey);
        if (buf.length) buffers.set(bufferKey(msg.pc, msg.sessionKey), buf);
      }
      send(ws, { type: 'history', pc: msg.pc, sessionKey: msg.sessionKey, events: buf || [] });
      break;
    }
    case 'start_session':
    case 'prompt':
    case 'set_model':
    case 'set_engine':
    case 'screenshot':
    case 'stop_session': {
      const agent = agentSockets.get(msg.pc);
      if (!agent) {
        send(ws, { type: 'error', message: `PC "${msg.pc}" 가 오프라인입니다.` });
        return;
      }
      send(agent, msg);
      break;
    }
    default:
      break;
  }
}

/* ---- HTTP API ----
 * 대시보드 없이도(예: 외부 자동화, 클라우드의 Claude 채팅) 허브에 명령을 내릴 수 있다.
 * 인증: Authorization: Bearer <FLEET_TOKEN>
 *   GET  /api/fleet                              PC/프로젝트/세션 현황
 *   POST /api/start   {pc, project, prompt, engine?, model?}  → {sessionKey}
 *   POST /api/prompt  {pc, sessionKey, text}
 *   POST /api/stop    {pc, sessionKey}
 *   GET  /api/history?pc=..&sessionKey=..&format=text|json    세션 대화 조회 */
function apiAuthed(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') && safeTokenEqual(h.slice(7).trim());
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 256 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function historyToText(events) {
  const lines = [];
  for (const ev of events) {
    if (ev.type === 'user_input') lines.push(`[사용자] ${ev.text}`);
    else if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) lines.push(`[어시스턴트] ${b.text}`);
        else if (b.type === 'tool_use') lines.push(`[도구] ${b.name} ${String(b.input?.command || b.input?.file_path || '').slice(0, 120)}`);
      }
    } else if (ev.type === 'result') lines.push('[턴 완료]');
    else if (ev.type === 'stderr') lines.push(`[오류] ${ev.text}`);
    else if (ev.type === 'agent') lines.push(`[안내] ${ev.text}`);
  }
  return lines.join('\n');
}

async function handleApi(req, res, u) {
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (!apiAuthed(req)) return json(401, { error: 'unauthorized' });

  try {
    if (req.method === 'GET' && u.pathname === '/api/fleet') {
      return json(200, fleetSnapshot());
    }
    if (req.method === 'GET' && u.pathname === '/api/history') {
      const pc = u.searchParams.get('pc');
      const sessionKey = u.searchParams.get('sessionKey');
      let buf = buffers.get(bufferKey(pc, sessionKey));
      if (!buf || !buf.length) buf = loadBufferFromDisk(pc, sessionKey);
      if (u.searchParams.get('format') === 'json') return json(200, { events: buf });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(historyToText(buf) || '(기록 없음)');
    }
    if (req.method === 'POST' && ['/api/start', '/api/prompt', '/api/stop'].includes(u.pathname)) {
      const body = await readJsonBody(req);
      const agent = agentSockets.get(body.pc);
      if (!agent) return json(404, { error: `PC "${body.pc}" 가 오프라인이거나 없습니다`, online_pcs: [...agentSockets.keys()] });
      if (u.pathname === '/api/start') {
        if (!body.project) return json(400, { error: 'project 필요' });
        const sessionKey = crypto.randomBytes(4).toString('hex');
        send(agent, { type: 'start_session', sessionKey, pc: body.pc, project: body.project, engine: body.engine, model: body.model, prompt: body.prompt });
        return json(200, {
          ok: true, sessionKey,
          hint: `진행 상황: GET /api/history?pc=${body.pc}&sessionKey=${sessionKey}`,
          live_view: `/#s=${encodeURIComponent(body.pc)}/${sessionKey}`,
        });
      }
      if (u.pathname === '/api/prompt') {
        if (!body.sessionKey || !body.text) return json(400, { error: 'sessionKey 와 text 필요' });
        send(agent, { type: 'prompt', pc: body.pc, sessionKey: body.sessionKey, text: body.text });
        return json(200, { ok: true });
      }
      send(agent, { type: 'stop_session', pc: body.pc, sessionKey: body.sessionKey });
      return json(200, { ok: true });
    }
    return json(404, { error: 'unknown endpoint' });
  } catch (e) {
    return json(400, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) { handleApi(req, res, u); return; }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    fs.readFile(DASHBOARD_HTML, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('dashboard/index.html 을 찾을 수 없습니다');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  if (u.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pcs: pcs.size, dashboards: dashboards.size }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const role = u.searchParams.get('role');
  if (!safeTokenEqual(u.searchParams.get('token'))) {
    ws.close(4401, 'invalid token');
    return;
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'agent') {
    const pcName = (u.searchParams.get('pc') || '').slice(0, 64);
    if (!pcName) {
      ws.close(4400, 'pc name required');
      return;
    }
    // 같은 이름으로 재접속하면 이전 소켓을 끊고 교체
    const prev = agentSockets.get(pcName);
    if (prev && prev !== ws) prev.terminate();
    agentSockets.set(pcName, ws);

    const pc = pcs.get(pcName) || {
      name: pcName, platform: null, projects: [], sessions: [],
    };
    pc.online = true;
    pc.lastSeen = Date.now();
    pcs.set(pcName, pc);
    console.log(`[agent] ${pcName} 접속`);
    broadcastFleet();

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      handleAgentMessage(pcName, msg);
    });
    ws.on('close', () => {
      if (agentSockets.get(pcName) === ws) {
        agentSockets.delete(pcName);
        const p = pcs.get(pcName);
        if (p) { p.online = false; p.lastSeen = Date.now(); }
        console.log(`[agent] ${pcName} 연결 끊김`);
        broadcastFleet();
      }
    });
    return;
  }

  if (role === 'dashboard') {
    dashboards.add(ws);
    send(ws, fleetSnapshot());
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      handleDashboardMessage(ws, msg);
    });
    ws.on('close', () => dashboards.delete(ws));
    return;
  }

  ws.close(4400, 'unknown role');
});

// 죽은 연결 정리
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`claude-fleet 허브 실행 중: http://localhost:${PORT}  (ws: /ws)`);
});
