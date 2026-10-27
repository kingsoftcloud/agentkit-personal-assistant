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
 * In-memory scheduler with stable nextRunAt/cancel semantics. A host can
 * persist `snapshot()` and restore it on restart before scheduling callbacks.
 */
export class ScheduleManager {
  constructor({ now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
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
      await task({ scheduleId: id, scheduledAt: nextRunAt });
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
