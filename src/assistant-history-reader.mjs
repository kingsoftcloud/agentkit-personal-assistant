/** Read exact DSH cuts; display pages never decide the current execution state. */
import { assistantFailure, displayEvents, displayMessages, displayQueue, displayAttachment } from './assistant-history.mjs';

const fail = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const signal = () => new AbortController().signal;
const rawEvents = page => (page.records || []).filter(row => row.type === 'event').map(row => row.event);
const requestMatches = (message, requestId) => message?.source?.kind === 'user' && message.source.rpcId === requestId;
const messageReceipt = (events, requestId) => events.some(event => event.type === 'user/message' && requestMatches(event.data, requestId)
  || event.type === 'agent/inbox/spliced' && (event.data?.inserted || []).some(message => requestMatches(message, requestId)));
const hasBoundary = events => events.some(event => event.type === 'turn/start');

async function pageAt(controller, sessionId, asOfSeq, beforeSeq) {
  const page = await controller.page({ address: { kind: 'session', sessionId }, throughSeq: asOfSeq, maxMessages: 200,
    turnWindow: { minMessages: 50, minTurns: 1 }, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, signal());
  const events = rawEvents(page);
  if (events.some((event, index) => !Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq > asOfSeq
    || (beforeSeq !== undefined && event.seq >= beforeSeq) || (index && event.seq <= events[index - 1].seq))
    || (page.hasMore && (!events.length || events[0].seq === 0))) {
    throw fail('ASSISTANT_HISTORY_INVALID', '云端历史暂时无法完整读取，请刷新重试');
  }
  return { events, hasMore: page.hasMore === true };
}

/** Reconstruct only retry identity from native inbox splices, including pre-step failures. */
function retryFor(events, end) {
  const start = events.findLast(event => event.type === 'turn/start' && event.seq < end.seq);
  if (!start) return null;
  const inbox = { 'next-turn': [], 'next-step': [] }, candidates = [];
  const completePrefix = events[0]?.seq === 0;
  for (const event of events) {
    if (event.seq >= end.seq) break;
    if (event.type === 'agent/inbox/spliced') {
      const data = event.data, queue = inbox[data.target];
      const removedCount = data.removedCount ?? 0, end = data.start + removedCount;
      if (!queue || !Number.isSafeInteger(data.start) || data.start < 0 || !Number.isSafeInteger(removedCount) || removedCount < 0 || !Number.isSafeInteger(end)) return null;
      if (completePrefix && end > queue.length) return null;
      // Missing prefix positions are unknown, not an empty inbox. Avoid allocating
      // unbounded placeholder arrays for a truncated or malformed queue window.
      if (end > 100000) return null;
      if (end > queue.length) queue.length = end;
      const removed = queue.splice(data.start, removedCount, ...(data.inserted || []));
      if (event.seq > start.seq && data.outcome !== 'canceled') {
        if (removed.includes(undefined)) return null;
        candidates.push(...removed);
      }
    }
    if (event.type === 'user/message' && event.seq > start.seq) candidates.push(event.data);
  }
  if (candidates.some(message => message?.source?.kind === 'schedule')) return null;
  const manual = new Map(candidates.filter(message => message?.source?.kind === 'user' && typeof message.source.rpcId === 'string')
    .map(message => [message.source.rpcId, message]));
  // A combined turn cannot safely be retried by picking just one of its inputs.
  if (manual.size !== 1) return null;
  const [requestId, message] = [...manual][0];
  const text = (message.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('');
  if (!text.trim() || text.length > 32000 || message.content.some(part => part.type !== 'text')) return null;
  // Retry text is the same redacted public text the user can review, never a raw context envelope.
  const safe = displayQueue({ 'next-turn': [message] })[0];
  if (!safe || safe.text !== text) return null;
  return { requestId, text, turn: end.data.turn, endSeq: end.seq };
}

export async function readAssistantHistory(controller, sessionId, { beforeSeq, requestId } = {}) {
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0 || Object.is(beforeSeq, -0))) throw fail('ASSISTANT_CURSOR_INVALID', '历史游标无效', 400);
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(requestId))) throw fail('ASSISTANT_INPUT_INVALID', '请求标识无效', 400);
  const projection = await controller.projections({ sessionId }, signal());
  const empty = { events: [], messages: [], queued: [], queuedCount: 0, receipt: null, failure: null, retry: null, hasMore: false,
    currentTurn: null, lastTurn: null, turnStartSeq: null, lastTurnEndSeq: null };
  if (!projection) return { ...empty, asOfSeq: -1, historyState: 'ready', status: 'idle' };
  if (projection.kind === 'migration-required') return { ...empty, historyState: 'migration-required', status: 'migration-required',
    failure: { code: 'ASSISTANT_HISTORY_MIGRATION_REQUIRED', message: '云端会话需要升级后才能恢复，请更新云端运行环境。' } };
  const asOfSeq = projection.asOfSeq;
  if (!Number.isSafeInteger(asOfSeq) || asOfSeq < -1) throw fail('ASSISTANT_HISTORY_INVALID', '云端历史版本无法识别');
  const latest = await pageAt(controller, sessionId, asOfSeq);
  const queued = displayQueue(projection.values?.inbox);
  const rawQueued = ['next-turn', 'next-step'].flatMap(target => projection.values?.inbox?.[target] || []);
  let observed = Boolean(requestId && rawQueued.some(message => requestMatches(message, requestId)));
  let events = latest.events, hasMore = latest.hasMore;
  let ending;
  while (true) {
    observed ||= Boolean(requestId && messageReceipt(events, requestId));
    ending = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
    // Status and retry ownership only need the latest complete turn suffix.
    // Older inbox claims without proof of all consumed inputs are non-retryable.
    // Only an explicit receipt lookup may continue beyond that suffix.
    if (!hasMore || ((hasBoundary(events) || projection.values?.sessionListMetadata?.blank === true) && (!requestId || observed))) break;
    const older = await pageAt(controller, sessionId, asOfSeq, events[0]?.seq);
    events = [...older.events, ...events]; hasMore = older.hasMore;
  }
  const boundary = projection.values?.turnBoundary;
  const running = boundary ? Number.isSafeInteger(boundary.openTurnStartSeq) : ending?.type === 'turn/start';
  // Injected policy/context notices are not outstanding user tasks.
  const status = running ? 'running' : queued.length ? 'queued' : ending?.type === 'turn/end'
    ? ending.data?.reason?.kind === 'completed' ? 'completed' : ending.data?.reason?.kind === 'aborted' ? 'cancelled' : 'failed' : 'idle';
  const page = beforeSeq === undefined ? latest : await pageAt(controller, sessionId, asOfSeq, beforeSeq);
  const visible = displayEvents(page.events);
  const turn = Number.isSafeInteger(ending?.data?.turn) ? ending.data.turn : null;
  return { asOfSeq, historyState: 'ready', currentTurn: running ? turn : null, lastTurn: turn,
    turnStartSeq: running ? events.findLast(event => event.type === 'turn/start')?.seq ?? null : null,
    lastTurnEndSeq: ending?.type === 'turn/end' ? ending.seq : null, events: visible, messages: displayMessages(sessionId, visible),
    status, queued, queuedCount: queued.length, receipt: observed ? { requestId, accepted: true, observed: true } : null,
    failure: status === 'failed' ? assistantFailure() : null, retry: status === 'failed' && ending ? retryFor(events, ending) : null,
    hasMore: page.hasMore, ...(page.events.length ? { beforeSeq: page.events[0].seq } : {}) };
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const imageIn = (content, attachmentId) => (content || []).find(part => part.type === 'image' && part.attachment?.attachmentId === attachmentId)?.attachment;
export async function readAssistantImage(controller, sessionId, attachmentId) {
  if (typeof controller.attachment !== 'function') throw fail('ASSISTANT_IMAGE_UNAVAILABLE', '此云端版本暂不支持图片查看', 409);
  if (typeof attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(attachmentId)) throw fail('ASSISTANT_IMAGE_INVALID', '图片标识无效', 400);
  const projection = await controller.projections({ sessionId }, signal());
  if (!projection || projection.kind === 'migration-required') throw fail('ASSISTANT_IMAGE_UNAVAILABLE', '图片所在会话暂时无法读取', 409);
  let ref = displayQueue(projection.values?.inbox).map(message => imageIn(message.content, attachmentId)).find(Boolean);
  let beforeSeq;
  while (!ref) {
    const page = await pageAt(controller, sessionId, projection.asOfSeq, beforeSeq);
    ref = displayEvents(page.events).map(event => imageIn(['user/message', 'tool/ptc-dispatch'].includes(event.type) ? event.data.content : event.data.message?.content, attachmentId)).find(Boolean);
    if (ref || !page.hasMore) break;
    beforeSeq = page.events[0].seq;
  }
  if (!ref) throw fail('ASSISTANT_IMAGE_NOT_FOUND', '这张图片不属于当前可见会话', 404);
  if (ref.bytes > MAX_IMAGE_BYTES) throw fail('ASSISTANT_IMAGE_TOO_LARGE', '图片超过 20 MiB 查看限制', 413);
  const value = await controller.attachment({ sessionId, attachmentId });
  const attachment = displayAttachment(value?.attachment, true);
  if (!attachment || attachment.attachmentId !== ref.attachmentId || attachment.mediaType !== ref.mediaType || attachment.bytes !== ref.bytes
    || typeof value.data !== 'string' || value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
    || Buffer.byteLength(value.data, 'base64') !== ref.bytes) throw fail('ASSISTANT_IMAGE_INVALID', '云端图片数据校验失败');
  return { attachment, data: value.data };
}
