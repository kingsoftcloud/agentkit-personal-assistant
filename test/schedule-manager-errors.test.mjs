/**
 * ScheduleManager 的失败路径：定时任务异常不能变成 unhandledRejection，
 * 否则「云端一次不可达」会按 Node 默认策略结束整个助理进程。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleManager } from '../src/schedule-manager.mjs';

const manualTimers = () => {
  const timers = new Map();
  let seq = 0;
  return {
    setTimeoutFn: (fn, delay) => { const id = ++seq; timers.set(id, { fn, delay }); return id; },
    clearTimeoutFn: id => { timers.delete(id); },
    get size() { return timers.size; },
    ids: () => [...timers.keys()],
    // 真实 setTimeout 触发一次后就不存在了，假定时器也要跟着移除，才能观察「残留」。
    fnOf: id => { const fn = timers.get(id).fn; timers.delete(id); return fn; },
  };
};

const managerOf = (timers, extra = {}) => new ScheduleManager({
  now: () => 1000,
  setTimeoutFn: timers.setTimeoutFn,
  clearTimeoutFn: timers.clearTimeoutFn,
  ...extra,
});

const withUnhandledProbe = async run => {
  const rejections = [];
  const onUnhandled = reason => rejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    // 未处理拒绝在微任务队列排空后才报告，多等一轮事件循环让探针可靠。
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  return rejections;
};

test('任务异步抛错不会产生 unhandledRejection，且 onTaskError 收到错误与调度信息', async () => {
  const timers = manualTimers();
  const reported = [];
  const manager = managerOf(timers, { onTaskError: (error, context) => reported.push({ error, context }) });
  manager.scheduleOnce({
    scheduleId: 'cloud-down',
    runAt: 1200,
    task: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
  });
  const rejections = await withUnhandledProbe(async () => { timers.fnOf(timers.ids()[0])(); });
  assert.deepEqual(rejections, [], '定时任务失败不能泄漏成未处理拒绝');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].error.code, 'ECONNREFUSED');
  assert.deepEqual({ ...reported[0].context }, { scheduleId: 'cloud-down', scheduledAt: 1200 });
  assert.equal(manager.nextRunAt('cloud-down'), undefined, '失败后记录要释放，不能卡在运行中');
});

test('任务同步抛错同样被隔离，onTaskError 自身抛错也不会泄漏', async () => {
  const timers = manualTimers();
  const manager = managerOf(timers, { onTaskError: () => { throw new Error('handler broke'); } });
  manager.scheduleOnce({ scheduleId: 'sync-boom', runAt: 1200, task: () => { throw new Error('sync boom'); } });
  const rejections = await withUnhandledProbe(async () => { timers.fnOf(timers.ids()[0])(); });
  assert.deepEqual(rejections, []);
  assert.equal(manager.snapshot().length, 0);
});

test('未注入 onTaskError 时默认输出结构化错误日志，而不是静默吞掉', async () => {
  const timers = manualTimers();
  const manager = managerOf(timers);
  const lines = [];
  const original = console.error;
  console.error = line => { lines.push(String(line)); };
  try {
    manager.scheduleOnce({ scheduleId: 'default-log', runAt: 1200, task: async () => { throw Object.assign(new Error('cloud unreachable'), { code: 'SCHEDULE_UNREACHABLE' }); } });
    timers.fnOf(timers.ids()[0])();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.event, 'personal-assistant.schedule.task-failed');
  assert.equal(payload.scheduleId, 'default-log');
  assert.equal(payload.scheduledAt, 1200);
  assert.equal(payload.code, 'SCHEDULE_UNREACHABLE');
  assert.equal(payload.message, 'cloud unreachable');
});

test('任务失败后同一 scheduleId 可以重新调度，旧定时器不残留', async () => {
  const timers = manualTimers();
  const reported = [];
  const manager = managerOf(timers, { onTaskError: error => reported.push(error) });
  manager.scheduleOnce({ scheduleId: 'retry-me', runAt: 1200, task: async () => { throw new Error('第一次失败'); } });
  timers.fnOf(timers.ids()[0])();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reported.length, 1);
  assert.equal(timers.size, 0, '失败后不能留下已触发的定时器');

  const schedule = manager.scheduleOnce({ scheduleId: 'retry-me', runAt: 1400, task: async () => {} });
  assert.equal(schedule.nextRunAt, 1400);
  assert.equal(timers.size, 1);
  assert.equal(manager.nextRunAt('retry-me'), 1400);
});

test('dispose 清空所有未触发的定时器，避免关闭后仍触发投递', async () => {
  const timers = manualTimers();
  const manager = managerOf(timers);
  manager.scheduleOnce({ scheduleId: 'a.one', runAt: 1200, task: async () => {} });
  manager.scheduleOnce({ scheduleId: 'b.two', runAt: 1300, task: async () => {} });
  assert.equal(timers.size, 2);
  manager.dispose();
  assert.equal(timers.size, 0);
  assert.deepEqual(manager.snapshot(), []);
});
