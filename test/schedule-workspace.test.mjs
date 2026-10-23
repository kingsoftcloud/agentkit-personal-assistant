import test from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleManager } from '../src/schedule-manager.mjs';
import { workspaceDir, workspaceMount } from '../src/workspace.mjs';

test('ScheduleManager exposes nextRunAt and runs one task', async () => {
  let now = 1000;
  const timers = [];
  const manager = new ScheduleManager({ now: () => now, setTimeoutFn: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeoutFn: () => {} });
  const seen = [];
  const schedule = manager.scheduleOnce({ scheduleId: 'morning', runAt: 1200, task: event => { seen.push(event); } });
  assert.equal(schedule.nextRunAt, 1200);
  assert.equal(manager.nextRunAt('morning'), 1200);
  assert.equal(timers[0].delay, 200);
  await timers[0].fn();
  assert.deepEqual(seen, [{ scheduleId: 'morning', scheduledAt: 1200 }]);
  assert.equal(manager.nextRunAt('morning'), undefined);
});

test('workspace contract only accepts absolute paths and retains read-only intent', () => {
  assert.equal(workspaceDir('/workspace/data'), '/workspace/data');
  assert.deepEqual(workspaceMount({ path: '/workspace/data', readOnly: true }), { path: '/workspace/data', readOnly: true });
  assert.throws(() => workspaceDir('relative'), /absolute/);
});
