/**
 * Small deterministic schedule manager owned by one assistant profile.
 *
 * It stores schedule metadata and asks the host to run a callback at a future
 * time. Durable persistence is supplied by the runtime image's state path;
 * this class deliberately has no process-wide timers or cross-user state.
 */
export const PERSONAL_ASSISTANT_SCHEDULE_CAPABILITY = 'personal-assistant-schedule-manager/v1';

const ID = /^[a-z][a-z0-9._:-]{0,127}$/u;
function identifier(value, field) {
  const result = String(value ?? '').trim();
  if (!ID.test(result)) throw new TypeError(`${field} has an invalid format`);
  return result;
}
function at(value) {
  const time = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isSafeInteger(time) || time < 0) throw new TypeError('runAt must be a non-negative timestamp');
  return time;
}

/**
 * 任务异常默认不吞：输出一行结构化日志，便于在 runtime 日志里定位是哪条定时任务失败。
 * 定时器回调里的 rejection 没人 await，按 Node 默认策略会直接结束进程——把「某次任务失败
 * （例如云端暂时不可达）」降级成可观测错误，而不是让整个助理进程掉线。
 */
export const defaultScheduleTaskErrorHandler = (error, context = {}) => {
  try {
    console.error(JSON.stringify({
      event: 'personal-assistant.schedule.task-failed',
      scheduleId: String(context.scheduleId ?? ''),
      scheduledAt: Number(context.scheduledAt) || null,
      code: String(error?.code || 'SCHEDULE_TASK_FAILED'),
      message: String(error?.message || error || ''),
    }));
  } catch { /* 日志失败不能反过来影响调度 */ }
};

/**
 * In-memory scheduler with stable nextRunAt/cancel semantics. A host can
 * persist `snapshot()` and restore it on restart before scheduling callbacks.
 */
export class ScheduleManager {
  constructor({ now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, onTaskError = defaultScheduleTaskErrorHandler } = {}) {
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.onTaskError = onTaskError;
    this.schedules = new Map();
  }

  scheduleOnce({ scheduleId, runAt, task, metadata = {} } = {}) {
    const id = identifier(scheduleId, 'scheduleId');
    if (typeof task !== 'function') throw new TypeError('task must be a function');
    const nextRunAt = at(runAt);
    if (nextRunAt <= this.now()) throw new RangeError('runAt must be in the future');
    this.cancel(id);
    const record = { scheduleId: id, nextRunAt, metadata: Object.freeze({ ...metadata }), timer: null };
    const delay = Math.max(1, nextRunAt - this.now());
    record.timer = this.setTimeoutFn(async () => {
      this.schedules.delete(id);
      try {
        await task({ scheduleId: id, scheduledAt: nextRunAt });
      } catch (error) {
        try { this.onTaskError?.(error, Object.freeze({ scheduleId: id, scheduledAt: nextRunAt })); }
        catch { /* 错误处理自身失败也不能泄漏成 unhandledRejection */ }
      }
    }, delay);
    record.timer?.unref?.();
    this.schedules.set(id, record);
    return this.describe(id);
  }

  cancel(scheduleId) {
    const id = identifier(scheduleId, 'scheduleId');
    const record = this.schedules.get(id);
    if (!record) return false;
    this.clearTimeoutFn(record.timer);
    this.schedules.delete(id);
    return true;
  }

  nextRunAt(scheduleId) {
    const id = identifier(scheduleId, 'scheduleId');
    return this.schedules.get(id)?.nextRunAt;
  }

  describe(scheduleId) {
    const id = identifier(scheduleId, 'scheduleId');
    const record = this.schedules.get(id);
    if (!record) return undefined;
    return Object.freeze({ scheduleId: record.scheduleId, nextRunAt: record.nextRunAt, metadata: record.metadata });
  }

  snapshot() {
    return Object.freeze([...this.schedules.values()].map(record => ({
      scheduleId: record.scheduleId,
      nextRunAt: record.nextRunAt,
      metadata: { ...record.metadata },
    })));
  }

  dispose() {
    for (const record of this.schedules.values()) this.clearTimeoutFn(record.timer);
    this.schedules.clear();
  }
}

export function createScheduleManager(options) {
  return new ScheduleManager(options);
}
