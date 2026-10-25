import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRuntime } from '../src/index.mjs';
import { createDshTurnBridge } from '../src/dsh-session-bridge.mjs';
import { BotRegistry } from '../src/bot-registry.mjs';
import { startAssistantRuntime } from '../runtime/assistant-runtime.mjs';

const bots = [{ botId: 'writer', systemPromptRevision: 'w1', systemPrompt: '写作专属 {{writer_literal}}' }, { botId: 'researcher', systemPromptRevision: 'r1', systemPrompt: '研究专属 {{research_literal}}' }];
const token = 'fixture-bots-runtime-token-at-least-24';
async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function eventually(read) { const until = Date.now() + 3000; while (Date.now() < until) { const v = await read(); if (v) return v; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition did not settle'); }
function nativeController() {
  const records = new Map(), calls = [];
  return { records, calls, async projections({ sessionId }) { return records.has(sessionId) ? {} : null; },
    async create({ sessionId }) { const sections = [], contexts = []; records.set(sessionId, { sections, contexts, events: [], agent: { ctx: { on() {}, get: name => name === 'tools' ? { restrict: value => assert.deepEqual(value, { allow: [] }), guard() {}, register() {} } : ({ section: value => sections.push(value), context: value => contexts.push(value) }) } } }); },
    async resolveAgent(id) { return { agent: records.get(id).agent }; },
    async inspect(id) { return { events: records.get(id)?.events || [] }; },
    async prompt({ sessionId, content }) { const record = records.get(sessionId); calls.push({ sessionId, input: content[0].text,
      sections: record.sections.map(row => ({ ...row, text: typeof row.text === 'function' ? row.text() : row.text })),
      contexts: record.contexts.map(row => ({ ...row, text: row.text() })) });
      record.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'fixture-model-result' }] } } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }); return { accepted: true }; },
  };
}

test('平台/Bot 提示词与记忆作用于独立 Agent，花括号保持原文，重建 bridge 后仍验证持久归属', async () => {
  const controller = nativeController();
  const runtime = createRuntime({ sessionController: controller }, { platformSystemPrompt: '平台约束 {{platform_literal}}', bots });
  runtime.turnBridge.setMemoryProvider(async botId => [{ key: 'project', content: `${botId}-private-memory` }]);
  for (const botId of ['writer', 'researcher']) {
    const receipt = await runtime.submitTurn({ botId, sessionId: `session-${botId}`, input: 'test' });
    await runtime.turnBridge.waitForTurn(receipt);
  }
  for (const [index, botId] of ['writer', 'researcher'].entries()) {
    const call = controller.calls[index];
    assert.equal(call.sections[0].text, '平台约束 {{platform_literal}}');
    assert.equal(call.sections[1].text, bots[index].systemPrompt);
    assert.ok(call.sections.every(row => row.interpolate === false));
    assert.match(call.contexts[0].text, new RegExp(`${botId}-private-memory`));
    assert.ok(!call.contexts[0].text.includes(`${index ? 'writer' : 'researcher'}-private-memory`));
  }
  const restored = createDshTurnBridge({ sessionController: controller, registry: runtime.registry });
  restored.setSessionOwnerResolver(async () => 'writer');
  await assert.rejects(restored.submitTurn({ botId: 'researcher', sessionId: 'session-writer', input: 'steal' }), { code: 'DSH_SESSION_BOT_CONFLICT' });
  assert.equal(controller.calls.length, 2);
});

test('默认 Bot 也获得独立身份提示词，缺少真正 Agent prompt 服务时拒绝执行', async () => {
  const controller = nativeController(), registry = new BotRegistry({ bots: [{ botId: 'default', systemPromptRevision: 'd1' }, { botId: 'researcher', systemPromptRevision: 'r1' }] });
  const bridge = createDshTurnBridge({ sessionController: controller, registry });
  for (const botId of ['default', 'researcher']) { const receipt = await bridge.submitTurn({ botId, sessionId: `session-${botId}`, input: 'hello' }); await bridge.waitForTurn(receipt); }
  assert.match(controller.calls[0].sections[0].text, /标识：default/u);
  assert.match(controller.calls[1].sections[0].text, /标识：researcher/u);
  const broken = createDshTurnBridge({ registry, sessionController: { create() {}, resolveAgent: async () => ({ agent: { ctx: { get() {} } } }), prompt: async () => assert.fail('cannot execute without prompt') } });
  await assert.rejects(broken.submitTurn({ botId: 'default', sessionId: 'broken', input: 'hello' }), { code: 'DSH_SESSION_CONTROLLER_UNAVAILABLE' });
});

test('HTTP 会话隔离、定时任务真实触发 bridge，关闭停止计时，重启恢复待执行任务与数据', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-bots-lifecycle-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = []; let handle, port;
  const start = async () => {
    port = await freePort();
    handle = await startAssistantRuntime({ env: { USER_ID: 'u1', ASSISTANT_ID: 'assistant-1', COMPUTER_ID: 'computer-1', COMPUTER_BROKER_URL: 'http://127.0.0.1:8787', AGENTKIT_RUNTIME_HOST: '127.0.0.1', AGENTKIT_RUNTIME_PORT: String(port), AGENTKIT_RUNTIME_TOKEN: token, WORKSPACE_PATH: root, ASSISTANT_STATE_PATH: join(root, 'state') }, runtime: { registry: new BotRegistry({ bots }), turnBridge: { available: true,
      async submitTurn(value) { calls.push(value); return { accepted: true, execution: 'dsh-session-controller', requestId: value.requestId }; }, async waitForTurn() { return { status: 'completed', messages: ['scheduled-result'] }; } } } });
  };
  const request = async (path, body, method = body ? 'POST' : 'GET') => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };
  await start(); t.after(() => handle.close());
  const session = (await request('/v1/sessions', { botId: 'writer' })).body;
  assert.equal((await request(`/v1/sessions/${session.sessionId}/messages?botId=researcher`)).status, 404);
  assert.equal((await request(`/v1/sessions/${session.sessionId}/messages`, { botId: 'researcher', role: 'user', content: 'steal' })).status, 404);
  await request('/v1/memory', { botId: 'writer', key: 'same-key', content: 'writer-only' });
  await request('/v1/memory', { botId: 'researcher', key: 'same-key', content: 'research-only' });
  assert.equal((await request('/v1/memory?botId=writer')).body.memories[0].content, 'writer-only');
  assert.equal((await request('/v1/schedules', { botId: 'writer', scheduleId: 'empty', runAt: Date.now() + 1000 })).status, 400);
  for (const botId of ['writer', 'researcher']) assert.equal((await request('/v1/schedules', { botId, scheduleId: 'same-id', runAt: Date.now() + 120, input: `${botId}-scheduled` })).status, 201);
  await handle.close(); await new Promise(r => setTimeout(r, 180)); assert.equal(calls.length, 0);
  await start();
  await eventually(async () => (await request('/v1/schedules?botId=writer')).body.schedules[0]?.status === 'completed');
  await eventually(async () => (await request('/v1/schedules?botId=researcher')).body.schedules[0]?.status === 'completed');
  assert.deepEqual(calls.map(row => row.botId).sort(), ['researcher', 'writer']);
  assert.equal((await request('/v1/memory?botId=writer')).body.memories[0].content, 'writer-only');
  assert.ok((await request('/v1/sessions?botId=writer')).body.sessions.some(row => row.sessionId === session.sessionId));
});
