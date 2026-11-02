import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudSessionChannel } from '../runtime/cloud-session-channel.mjs';
import { BotRegistry } from '../src/bot-registry.mjs';

function fixture() {
  const sessions = {
    writer: [{ sessionId: 'writer-session', title: '写作会话', updatedAt: '2026-10-30T00:00:00.000Z' }],
    researcher: [{ sessionId: 'research-session', title: '研究会话', updatedAt: '2026-10-29T00:00:00.000Z' }],
  };
  const messages = [{ botId: 'writer', sessionId: 'writer-session', messageId: 'm1', role: 'user', content: '保留这条', metadata: { clientTurnId: 'turn-1' } }];
  const store = {
    sessions: async botId => sessions[botId] || [],
    messages: async ({ botId, sessionId }) => messages.filter(row => row.botId === botId && row.sessionId === sessionId),
    turns: async () => [{ turnId: 'turn-1', status: 'completed', error: null, metadata: { clientTurnId: 'turn-1' }, progress: null }],
  };
  const registry = new BotRegistry({ profileId: 'ar-test', bots: [
    { botId: 'writer', displayName: '写作助理', systemPromptRevision: 'writer-1' },
    { botId: 'researcher', displayName: '研究助理', systemPromptRevision: 'research-1' },
  ] });
  const channel = createCloudSessionChannel({
    assistantId: 'ar-test', computerId: 'computer-1', runtimeInstanceId: 'runtime-1', stateStore: store, registry,
    sessionCreate: async ({ botId, title }) => ({ sessionId: `${botId}-new`, title }),
    turnWrite: async () => ({ turnId: 'turn-1', sessionId: 'writer-session' }),
    scheduleWrite: async value => value,
    cloudFiles: { upload: async () => ({}), download: async () => ({}), attachment: async () => Buffer.from('') },
  });
  return { channel };
}

test('cloud session channel returns stable runtime diagnostics and isolates Bot session directories', async () => {
  const { channel } = fixture();
  const writer = await channel({ agentId: 'ar-test', botId: 'writer', operation: 'personal-assistant.sessions.list' });
  assert.deepEqual({
    agentId: writer.agentId, botId: writer.botId, computerId: writer.computerId,
    executionTarget: writer.executionTarget, runtimeInstanceId: writer.runtimeInstanceId, stateStorage: writer.stateStorage,
  }, { agentId: 'ar-test', botId: 'writer', computerId: 'computer-1', executionTarget: 'cloud', runtimeInstanceId: 'runtime-1', stateStorage: 'state-path' });
  assert.deepEqual(writer.sessions.map(row => row.sessionId), ['writer-session']);

  const researcher = await channel({ agentId: 'ar-test', botId: 'researcher', operation: 'personal-assistant.sessions.list' });
  assert.deepEqual(researcher.sessions.map(row => row.sessionId), ['research-session']);

  const snapshot = await channel({ agentId: 'ar-test', botId: 'writer', operation: 'personal-assistant.session.snapshot', payload: { sessionId: 'writer-session' } });
  assert.equal(snapshot.runtimeInstanceId, 'runtime-1');
  assert.equal(snapshot.stateStorage, 'state-path');
  assert.equal(snapshot.sessionId, 'writer-session');
  assert.equal(snapshot.cursor, 1);
  assert.equal(snapshot.messages[0].clientTurnId, 'turn-1');
});

test('cloud session channel rejects unknown Bot instead of crossing session scope', async () => {
  const { channel } = fixture();
  await assert.rejects(channel({ agentId: 'ar-test', botId: 'ghost', operation: 'personal-assistant.sessions.list' }), { code: 'BOT_NOT_FOUND', status: 404 });
});
