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
  assert.equal((await f.request('/v1/bots', undefined, false)).status, 401);
  const session = (await f.request('/v1/sessions', { botId: 'writer' })).body;
  const receipt = await f.request(`/v1/sessions/${session.sessionId}/turns`, { botId: 'writer', input: 'hello' });
  assert.equal(receipt.status, 503);
  assert.equal(receipt.body.error, 'DSH_SESSION_CONTROLLER_UNAVAILABLE');
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
