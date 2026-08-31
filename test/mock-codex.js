#!/usr/bin/env node
// codex exec --json 의 JSONL 출력을 흉내내는 목(mock). 프롬프트는 stdin 으로 받는다.
// 사용 형태: mock-codex.js exec [resume <id>] --json ... -
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const rIdx = args.indexOf('resume');
const threadId = rIdx > -1 ? args[rIdx + 1] : crypto.randomUUID();
const mIdx = args.indexOf('-m');
const model = mIdx > -1 ? args[mIdx + 1] : 'codex-default';

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  prompt = prompt.trim();
  out({ type: 'thread.started', thread_id: threadId });
  await sleep(300);
  out({ type: 'item.started', item: { type: 'command_execution', command: 'echo hello-from-codex-mock' } });
  await sleep(400);
  out({ type: 'item.completed', item: { type: 'command_execution', command: 'echo hello-from-codex-mock', aggregated_output: 'hello-from-codex-mock', exit_code: 0 } });
  await sleep(300);
  out({ type: 'item.completed', item: { type: 'agent_message', text: `(mock codex/${model}) 요청 "${prompt}" 처리 완료. thread=${threadId.slice(0, 8)}` } });
  out({ type: 'turn.completed', usage: { input_tokens: 120, output_tokens: 34 } });
});
