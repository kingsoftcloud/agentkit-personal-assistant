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
