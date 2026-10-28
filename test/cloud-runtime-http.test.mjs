import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startAssistantRuntime } from '../runtime/assistant-runtime.mjs';
import { BotRegistry } from '../src/bot-registry.mjs';

const token = 'test-runtime-token-is-at-least-24';
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function fixture(t, turnBridge) {
  const root = await mkdtemp(join(tmpdir(), 'pa-runtime-http-'));
  const port = await freePort();
  const env = { USER_ID: 'user-1', ASSISTANT_ID: 'assistant-1', COMPUTER_ID: 'computer-1', COMPUTER_BROKER_URL: 'http://127.0.0.1:8787', AGENTKIT_RUNTIME_HOST: '127.0.0.1', AGENTKIT_RUNTIME_PORT: String(port), AGENTKIT_RUNTIME_TOKEN: token, WORKSPACE_PATH: root, ASSISTANT_STATE_PATH: join(root, 'state') };
  const registry = new BotRegistry({ bots: [{ botId: 'writer', systemPromptRevision: 'writer@1' }, { botId: 'researcher', systemPromptRevision: 'researcher@1' }] });
  const handle = await startAssistantRuntime({ env, runtime: { registry, turnBridge } });
  t.after(async () => { await handle.close(); await rm(root, { recursive: true, force: true }); });
  return { handle, async request(path, body, authenticated = true) { const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; } };
}

test('cloud API fails readiness without DSH and protects state routes with the runtime token', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/health', undefined, false)).status, 503);
  assert.equal((await f.request('/ready', undefined, false)).status, 503);
  assert.equal((await f.request('/v1/bots', undefined, false)).status, 401);
  const session = (await f.request('/v1/sessions', { botId: 'writer' })).body;
  const receipt = await f.request(`/v1/sessions/${session.sessionId}/turns`, { botId: 'writer', input: 'hello' });
  assert.equal(receipt.status, 503);
  assert.equal(receipt.body.error, 'DSH_SESSION_CONTROLLER_UNAVAILABLE');
});

test('HTTP /ready 真实依赖注入的DSH就绪状态，不依赖可写文件或总是200', async t => {
  const bridge = { available: false };
  const f = await fixture(t, bridge);
  assert.equal((await f.request('/ready', undefined, false)).status, 503);
  bridge.available = true;
  const ready = await f.request('/ready', undefined, false);
  assert.equal(ready.status, 200);
  assert.equal(ready.body.dshSessionController, true);
  bridge.available = false;
  assert.equal((await f.request('/ready', undefined, false)).status, 503);
});

test('cloud API records the DSH result and refuses another Bot on the owned Session', async t => {
  const calls = [];
  const f = await fixture(t, { available: true, async submitTurn(value) { calls.push(value); return { accepted: true, execution: 'dsh-session-controller', requestId: value.requestId }; }, async waitForTurn() { return { status: 'completed', messages: ['真实宿主返回内容'] }; } });
  const session = (await f.request('/v1/sessions', { botId: 'writer' })).body;
  const mismatch = await f.request(`/v1/sessions/${session.sessionId}/turns`, { botId: 'researcher', input: 'read writer data' });
  assert.equal(mismatch.status, 404);
  assert.equal(calls.length, 0);
  const receipt = await f.request(`/v1/sessions/${session.sessionId}/turns`, { botId: 'writer', input: 'hello' });
  assert.equal(receipt.status, 202);
  assert.equal(receipt.body.execution, 'dsh-session-controller');
  assert.equal(calls[0].sessionId, session.sessionId);
  await f.handle.waitForIdle();
  const messages = await f.request(`/v1/sessions/${session.sessionId}/messages?botId=writer`);
  assert.equal(messages.body.messages.at(-1).content, '真实宿主返回内容');
  const turns = await f.request(`/v1/sessions/${session.sessionId}/turns?botId=writer`);
  assert.equal(turns.body.turns[0].status, 'completed');
});

test('云端回合按 clientTurnId 持久幂等，并发重复提交仅执行一次；改正文拒绝', async t => {
  let calls = 0;
  const f = await fixture(t, { available: true, async submitTurn(value) { calls++; return { accepted: true, requestId: value.requestId }; }, async waitForTurn() { return { status: 'completed', messages: ['done'] }; } });
  const session = (await f.request('/v1/sessions', { botId: 'writer' })).body;
  const body = { botId: 'writer', input: 'hello', metadata: { clientTurnId: 'stable-key' } };
  const [first, second] = await Promise.all([f.request(`/v1/sessions/${session.sessionId}/turns`, body), f.request(`/v1/sessions/${session.sessionId}/turns`, body)]);
  assert.equal(first.body.turnId, second.body.turnId);
  assert.equal(calls, 1);
  const mismatch = await f.request(`/v1/sessions/${session.sessionId}/turns`, { ...body, input: 'changed' });
  assert.equal(mismatch.status, 409);
  await f.handle.waitForIdle();
});


test('同一会话的两轮对话排队执行，不再把“上一轮未结束”记成失败任务', async t => {
  const submits = [];
  let releaseFirst;
  const firstStarted = new Promise(resolve => { releaseFirst = resolve; });
  let firstRunning = false;
  const f = await fixture(t, {
    available: true,
    async submitTurn(value) { submits.push(value); return { accepted: true, execution: 'dsh-session-controller', requestId: value.requestId }; },
    async waitForTurn({ requestId }) {
      if (!firstRunning) { firstRunning = true; await firstStarted; return { status: 'completed', messages: ['first done'] }; }
      return { status: 'completed', messages: ['second done'] };
    },
  });
  const session = (await f.request('/v1/sessions', { botId: 'writer' })).body;
  const first = await f.request(`/v1/sessions/${session.sessionId}/turns`, { botId: 'writer', input: 'one' });
  assert.equal(first.status, 202);
  assert.equal(submits.length, 1);
  const second = await f.request(`/v1/sessions/${session.sessionId}/turns`, { botId: 'writer', input: 'two' });
  assert.equal(second.status, 202);
  assert.equal(second.body.status, 'queued', '上一轮未结束时应排到 queued，而不是直接提交成失败轮次');
  assert.equal(submits.length, 1, '上一轮结束前不能提交下一轮');
  releaseFirst();
  await f.handle.waitForIdle();
  const turns = (await f.request(`/v1/sessions/${session.sessionId}/turns?botId=writer`)).body.turns;
  assert.deepEqual(turns.map(turn => turn.status), ['completed', 'completed']);
  assert.deepEqual(turns.map(turn => turn.error), [null, null]);
  assert.equal(submits.length, 2);
  const messages = (await f.request(`/v1/sessions/${session.sessionId}/messages?botId=writer`)).body.messages;
  assert.deepEqual(messages.filter(row => row.role === 'assistant').map(row => row.content), ['first done', 'second done']);
});
