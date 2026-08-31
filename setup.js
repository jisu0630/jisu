#!/usr/bin/env node
// claude-fleet 대화형 설치 도우미
// 사용: npm run setup
// - 허브: 토큰 자동 생성(.fleet-token), 접속 주소 안내
// - 에이전트: 설정 파일 작성 + 허브 연결/토큰 검증까지 자동 수행
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let finished = false;
rl.on('close', () => {
  if (!finished) {
    console.error('\n입력이 중단되어 설치를 종료합니다.');
    process.exit(1);
  }
});
const ask = async (q, def) => {
  const a = (await rl.question(def ? `${q} [${def}] ` : `${q} `)).trim();
  return a || def || '';
};

console.log('\n=== Claude Fleet 설치 도우미 ===\n');
console.log('이 머신의 역할을 고르세요:');
console.log('  1) 허브 서버   — 항상 켜져 있을 머신 1대 (대시보드 제공)');
console.log('  2) 에이전트    — Claude Code 세션을 돌릴 각 PC\n');

const role = await ask('번호 입력 (1 또는 2):');

/* ---------------- 허브 ---------------- */
if (role === '1') {
  const tokenPath = path.join(__dirname, '.fleet-token');
  let token;
  if (fs.existsSync(tokenPath)) {
    token = fs.readFileSync(tokenPath, 'utf8').trim();
    console.log('\n기존 토큰(.fleet-token)을 재사용합니다.');
  } else {
    token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
    console.log('\n토큰을 생성해 .fleet-token 에 저장했습니다.');
  }

  const port = await ask('포트', '8787');

  const ips = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) ips.push(`${a.address} (${name})`);
    }
  }

  console.log('\n────────────────────────────────────────────');
  console.log('설정 완료! 허브 실행:');
  console.log(`\n  npm run server\n`);
  console.log('  (백그라운드 상주: npx pm2 start "npm run server" --name fleet-hub)');
  console.log('\n이 머신의 IP 주소 (에이전트/브라우저에서 사용):');
  for (const ip of ips) console.log(`  - ${ip}`);
  console.log(`\n브라우저 접속:  http://<위 IP>:${port}`);
  console.log(`접속 토큰:      ${token}`);
  console.log('\n각 PC 에서는 같은 저장소를 받아 npm run setup → 2번(에이전트)을 선택하고,');
  console.log('위 IP 와 토큰을 입력하면 됩니다.');
  console.log('⚠ 다른 네트워크의 PC 와 연결하려면 Tailscale 설치 후 Tailscale IP 를 쓰세요.');
  console.log('────────────────────────────────────────────\n');
  if (port !== '8787') console.log(`포트를 바꿨으므로 실행 시: PORT=${port} npm run server\n`);
  finished = true;
  rl.close();
  process.exit(0);
}

/* ---------------- 에이전트 ---------------- */
if (role === '2') {
  let hub = await ask('허브 주소 (IP 또는 ws://host:port):');
  if (!hub) { console.error('허브 주소는 필수입니다.'); process.exit(1); }
  if (!hub.startsWith('ws://') && !hub.startsWith('wss://')) {
    hub = 'ws://' + hub + (hub.includes(':') ? '' : ':8787');
  }
  const token = await ask('허브 토큰:');
  if (!token) { console.error('토큰은 필수입니다.'); process.exit(1); }

  // 연결 + 토큰 검증 (dashboard 역할로 붙어보면 PC 목록에 흔적이 남지 않음)
  process.stdout.write('허브 연결 확인 중... ');
  const check = await new Promise((resolve) => {
    const ws = new WebSocket(`${hub.replace(/\/$/, '')}/ws?role=dashboard&token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => { ws.terminate(); resolve('허브에 연결할 수 없습니다 (주소/방화벽 확인)'); }, 6000);
    ws.on('open', () => { clearTimeout(timer); ws.close(); resolve(null); });
    ws.on('close', (code) => { clearTimeout(timer); resolve(code === 4401 ? '토큰이 올바르지 않습니다' : null); });
    ws.on('error', (e) => { clearTimeout(timer); resolve(`연결 실패: ${e.message}`); });
  });
  if (check) {
    console.log('실패 ✗');
    console.log(`  → ${check}`);
    const cont = await ask('그래도 설정 파일을 저장할까요? (y/N)', 'N');
    if (cont.toLowerCase() !== 'y') { finished = true; rl.close(); process.exit(1); }
  } else {
    console.log('성공 ✓');
  }

  const pcName = await ask('이 PC 이름', os.hostname());

  console.log('\n이 PC 에서 세션을 돌릴 프로젝트를 등록합니다. (빈 입력으로 종료)');
  const projects = [];
  for (;;) {
    const p = await ask(`프로젝트 ${projects.length + 1} 경로:`);
    if (!p) break;
    const abs = path.resolve(p.replace(/^~(?=$|\/|\\)/, os.homedir()));
    if (!fs.existsSync(abs)) { console.log(`  ⚠ 경로가 없습니다: ${abs} (건너뜀)`); continue; }
    const name = await ask('  표시 이름', path.basename(abs));
    projects.push({ name, path: abs });
  }
  if (!projects.length) console.log('⚠ 프로젝트를 하나도 등록하지 않았습니다. 나중에 fleet-agent.config.json 에 추가하세요.');

  const useCodex = (await ask('\n이 PC 에서 OpenAI Codex CLI 도 쓸까요? (codex 설치·로그인 필요) (y/N)', 'N')).toLowerCase() === 'y';

  console.log('\n권한 모드 선택:');
  console.log('  1) acceptEdits       — 파일 편집 자동 허용, 그 외 도구는 제한 (기본, 안전)');
  console.log('  2) bypassPermissions — 모든 도구 자동 허용 (편하지만 위험 — 사설망에서만!)');
  const pm = await ask('번호 입력', '1');

  const config = {
    hub,
    token,
    pcName,
    permissionMode: pm === '2' ? 'bypassPermissions' : 'acceptEdits',
    includePartialMessages: false,
    projects,
  };
  if (useCodex) config.engines = { codex: { bin: 'codex', extraArgs: ['--full-auto'] } };
  const cfgPath = path.join(__dirname, 'fleet-agent.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });

  console.log('\n────────────────────────────────────────────');
  console.log(`설정 저장 완료: ${cfgPath}`);
  console.log('\n에이전트 실행:');
  console.log('\n  npm run agent\n');
  console.log('  (백그라운드 상주: npx pm2 start "npm run agent" --name fleet-agent && npx pm2 save)');
  if (process.platform === 'win32') {
    console.log('  (Windows 부팅 시 자동 실행: 작업 스케줄러 → 로그온 시 → node agent\\agent.js)');
  }
  console.log('────────────────────────────────────────────\n');
  finished = true;
  rl.close();
  process.exit(0);
}

console.error('1 또는 2 를 입력하세요.');
process.exit(1);
