import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalAssistantStateStore } from '../src/persistent-state.mjs';

test('sessions, memory, and schedules survive a runtime restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-assistant-state-'));
  try {
    const first = await createPersonalAssistantStateStore(root).init();
    const session = await first.createSession({ botId: 'default', title: 'Research plan', metadata: { source: 'test' } });
    const turn = await first.createTurn({ botId: 'default', sessionId: session.sessionId, input: 'remember this marker' });
    await first.appendMessage({ botId: 'default', sessionId: session.sessionId, role: 'assistant', content: 'stored' });
    await first.putMemory({ botId: 'default', key: 'project', content: 'PA_DATA_RESTART_MARKER' });
    await first.putSchedule({ botId: 'default', scheduleId: 'daily-review', runAt: Date.now() + 60_000, metadata: { kind: 'review' } });

    const restarted = await createPersonalAssistantStateStore(root).init();
    assert.equal((await restarted.sessions('default')).find(item => item.sessionId === session.sessionId)?.title, 'Research plan');
    assert.equal((await restarted.turns('default', session.sessionId)).find(item => item.turnId === turn.turnId)?.status, 'queued');
    assert.deepEqual((await restarted.messages({ botId: 'default', sessionId: session.sessionId })).map(item => item.role), ['assistant']);
    assert.deepEqual((await restarted.memory('default', 'RESTART_MARKER')).map(item => item.content), ['PA_DATA_RESTART_MARKER']);
    assert.deepEqual((await restarted.schedules('default')).map(item => item.scheduleId), ['daily-review']);
    assert.equal(await restarted.removeSchedule('default', 'daily-review'), true);
    assert.deepEqual(await restarted.schedules('default'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
