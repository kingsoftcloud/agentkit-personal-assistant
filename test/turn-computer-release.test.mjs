import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshTurnBridge } from '../src/dsh-session-bridge.mjs';

test('云端回合完成即交还电脑，后续定时任务不等待旧回合租约 TTL', async () => {
  let events = [], created = false, released = 0, installed = 0;
  const agent = { ctx: { get: () => ({ section() {} }) } };
  const bridge = createDshTurnBridge({
    setupAgent: () => { installed++; return async () => { released++; }; },
    sessionController: {
      resolveAgent: async () => ({ agent }),
      inspect: async () => created ? { events } : undefined,
      create: async () => { created = true; },
      prompt: async () => { events.push({ seq: events.length + 1, type: 'tool/call', data: { name: 'cloud_bash', callId: 'test-call' } }, { seq: events.length + 2, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'test-call', content: [] } } }, { seq: events.length + 3, type: 'turn/end', data: { reason: { kind: 'completed' } } }); return { accepted: true }; },
    },
  });
  let progress;
  for (const requestId of ['one', 'two']) {
    await bridge.submitTurn({ botId: 'default', sessionId: 'cloud-test', input: 'task', requestId });
    const before = released;
    assert.equal((await bridge.waitForTurn({ botId: 'default', sessionId: 'cloud-test', requestId, onProgress: value => { progress = value; } })).status, 'completed');
    assert.equal(released, before + 1);
  }
  assert.equal(installed, 1);
  assert.deepEqual(progress, { tool: 'cloud_bash', state: 'settled' });
});

test('DSH 0.2.2 public SessionController.events 可观察回合结束', async () => {
  const events = [];
  const agent = { ctx: { get: () => ({ section() {} }) } };
  let created = false;
  const controller = {
    async projections() { return created ? {} : null; },
    async create() { created = true; },
    async resolveAgent() { return { agent }; },
    async events() {
      return { cursor: events.at(-1)?.seq ?? -1, records: events.map(event => ({ type: 'event', event })) };
    },
    async prompt() {
      events.push(
        { seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'public-events-ok' }] } } },
        { seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } },
      );
      return { accepted: true };
    },
  };
  const bridge = createDshTurnBridge({ sessionController: controller });
  const receipt = await bridge.submitTurn({ botId: 'default', sessionId: 'public-events', input: 'hello', requestId: 'public-events-request' });
  const result = await bridge.waitForTurn(receipt);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.messages, ['public-events-ok']);
});
