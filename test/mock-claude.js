#!/usr/bin/env node
// claude CLI 의 stream-json 입출력을 흉내내는 목(mock).
// API 토큰 소모 없이 허브/에이전트/대시보드 전체 흐름을 시험할 때 사용한다.
// 사용: 에이전트 설정에서 "claudeBin": "node", 는 불가하므로 test/demo.config.json 처럼
//       claudeBin 에 이 파일을 실행하는 래퍼를 지정한다.
import readline from 'node:readline';
import crypto from 'node:crypto';

const resumeIdx = process.argv.indexOf('--resume');
const sessionId = resumeIdx > -1 ? process.argv[resumeIdx + 1] : crypto.randomUUID();

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'mock-model', cwd: process.cwd() });

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== 'user') return;
  const text = (msg.message?.content || []).map((c) => c.text || '').join(' ');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(300);
  out({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: `(mock) 요청 확인: "${text}"\n작업을 시작합니다.` },
    { type: 'tool_use', id: 'toolu_mock', name: 'Bash', input: { command: 'echo hello-from-mock' } },
  ] } });
  await sleep(400);
  out({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_mock', content: 'hello-from-mock' },
  ] } });
  await sleep(400);
  out({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: '완료했습니다. `echo` 결과까지 확인했습니다.' },
  ] } });
  out({ type: 'result', subtype: 'success', duration_ms: 1100, total_cost_usd: 0, num_turns: 1, session_id: sessionId });
});
