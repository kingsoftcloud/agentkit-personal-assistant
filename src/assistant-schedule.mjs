/** Receipt-scoped management over native DSH Schedule storage and delivery history. */
import { isAssistantScheduleOperation } from './contracts/assistant-schedule.mjs';
const fail = message => Object.assign(new Error(message), { code: 'ASSISTANT_SCHEDULE_INPUT_INVALID', status: 400 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const fields = { after: ['afterSeconds'], at: [], every: ['everySeconds'], daily: ['time', 'timeZone'], weekly: ['time', 'timeZone', 'weekdays'], cron: ['expression', 'timeZone'] };
// The manager keeps the flat rule selector its callers already send; the pinned
// rc1 Host accepts only the typed `timing` member of a create request.
const TIMING = Object.freeze({ after_seconds: 'after', at: 'at', every_seconds: 'every', daily: 'daily', weekly: 'weekly', cron: 'cron' });

/** Require the complete observed native record; never fabricate a fresh comparison target. */
export function assistantScheduleExpected(value, taskId) {
  if (!object(value) || !Object.hasOwn(fields, value.kind)) throw fail('请刷新任务详情后再修改');
  const known = ['id', 'kind', 'title', 'prompt', 'scheduledAt', ...fields[value.kind]];
  const keys = value.updatedAt === undefined ? known : [...known, 'updatedAt'];
  if (!exact(value, keys) || Object.keys(value).length !== keys.length || value.id !== taskId
    || !['id', 'title', 'prompt', 'scheduledAt'].every(key => typeof value[key] === 'string' && value[key].length)
    || value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || !value.updatedAt.length)
    || fields[value.kind].some(key => key === 'weekdays' ? !Array.isArray(value[key]) || !value[key].length || value[key].some(day => !Number.isInteger(day))
      : ['afterSeconds', 'everySeconds'].includes(key) ? !Number.isSafeInteger(value[key]) || value[key] < 1 : typeof value[key] !== 'string' || !value[key])) throw fail('请刷新任务详情后再修改');
  return value;
}

/** Translate the flat manager rule into the typed timing the pinned Host validates. */
function nativeTiming(spec) {
  const selected = Object.keys(TIMING).filter(key => spec[key] !== undefined);
  if (selected.length !== 1) throw fail('请输入原生定时任务规则');
  return { kind: TIMING[selected[0]], [selected[0]]: spec[selected[0]] };
}

/** Keep only the durable record fields the manager has always returned. */
function recordOf(entry) {
  const { target, involvedSessionIds, createdAt, updatedAt, executionActive, deliveryFloorEndsAt, lastDelivery, sessionId, status, ...record } = entry ?? {};
  return record;
}

/** Project one rc1 catalog entry onto the retained manager contract. */
function project(entry) {
  return {
    ...recordOf(entry),
    ...(entry?.target?.kind === 'session' ? { sessionId: entry.target.sessionId } : {}),
    status: entry?.status === 'active' ? 'active' : 'inactive',
    ...(entry?.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
    ...(entry?.lastDelivery === undefined ? {} : { lastDelivery: entry.lastDelivery }),
  };
}

/** Read the tasks that deliver to one Session, in the retained catalog order. */
async function scoped(schedule, sessionId) {
  // rc1 dropped the owning Session field: a task belongs to the Sessions that created,
  // edited or receive it, which is exactly the recorded involvement set.
  const tasks = (await schedule.catalog()).filter(task => Array.isArray(task?.involvedSessionIds) && task.involvedSessionIds.includes(sessionId)
    || task?.target?.kind === 'session' && task.target.sessionId === sessionId);
  return tasks.map(project).sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)) || String(left.id).localeCompare(String(right.id)));
}

/** rc1 edits address a task directly, so ownership is proven against the Session catalog first. */
async function owned(schedule, sessionId, taskId) {
  return (await scoped(schedule, sessionId)).some(item => item.id === taskId);
}
const notFound = request => ({ id: request.id, ...(request.action === 'delete' ? { deleted: false } : { updated: false }), code: 'schedule_not_found' });

/** Execute only for the server-derived Session, retaining native CAS and cancellation semantics. */
export async function executeAssistantSchedule({ schedule, operation, payload, sessionId, ensure, serialize, signal }) {
  if (!isAssistantScheduleOperation(operation)) throw fail('不支持的定时任务操作');
  if (!schedule) throw Object.assign(new Error('请在云端镜像启用 DSH 官方定时任务插件'), { code: 'ASSISTANT_SCHEDULE_UNAVAILABLE', status: 503 });
  const allowed = operation === 'schedule-create' ? ['spec'] : operation === 'schedule-update' ? ['id', 'expected', 'change', 'title', 'prompt']
    : operation === 'schedule-history' ? ['id', 'limit', 'before'] : ['schedule-get', 'schedule-delete'].includes(operation) ? ['id'] : [];
  if (!exact(payload, ['conversation', ...allowed]) || allowed.includes('id') && !id(payload.id)) throw fail('任务操作只接受当前助理会话的任务标识');
  signal?.throwIfAborted();
  if (['schedule-catalog', 'schedule-list', 'schedule-get'].includes(operation)) {
    const items = await scoped(schedule, sessionId);
    signal?.throwIfAborted();
    if (operation === 'schedule-get') return { item: items.find(item => item.id === payload.id) ?? null };
    // Preserve schedule-list's original retained-catalog behavior for existing clients.
    return { sessionId, items };
  }
  if (operation === 'schedule-history') {
    if (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 100 || payload.before !== undefined && !id(payload.before)) throw fail('请选择有效的投递记录页');
    if (!await owned(schedule, sessionId, payload.id)) return { id: payload.id, code: 'schedule_not_found' };
    signal?.throwIfAborted();
    const result = await schedule.history({ id: payload.id, limit: payload.limit, ...(payload.before === undefined ? {} : { before: payload.before }) });
    signal?.throwIfAborted(); return result;
  }
  if (operation === 'schedule-create') {
    if (!exact(payload.spec, ['title', 'prompt', 'after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'])) throw fail('请输入原生定时任务规则');
    const timing = nativeTiming(payload.spec);
    return serialize(sessionId, async () => {
      signal?.throwIfAborted();
      await ensure(sessionId);
      signal?.throwIfAborted();
      // Once native persistence starts, a lost response is an unknown outcome.
      // Callers must inspect the catalog instead of retrying a create automatically.
      return schedule.create({ title: payload.spec.title, prompt: payload.spec.prompt, timing,
        target: { kind: 'session', sessionId } }, sessionId, signal);
    });
  }
  const request = operation === 'schedule-delete' ? { id: payload.id, action: 'delete' }
    : { id: payload.id, action: 'update',
      patch: { ...(payload.title === undefined ? {} : { title: payload.title }), ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
        ...(payload.change === undefined ? {} : { timing: payload.change }) },
      // rc1 compares the observed revision; an older caller without it keeps an unconditional update.
      expectedUpdatedAt: assistantScheduleExpected(payload.expected, payload.id).updatedAt ?? null };
  if (!await owned(schedule, sessionId, payload.id)) return notFound(request);
  signal?.throwIfAborted();
  const result = await schedule.edit(request, undefined, signal);
  if (request.action === 'delete' || result?.code !== undefined) return result;
  return { id: result.id, updated: true, record: recordOf(result) };
}
