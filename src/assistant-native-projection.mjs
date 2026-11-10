/** Privacy-limited native Client presentation, never a model-replay or execution log.
 * Source events keep their cursor and surface positions; hidden non-surface events
 * have explicit ignorable placeholders. The authoritative Session is not mutated.
 */
import { Buffer } from 'node:buffer';
import { displayContent, displayText } from './assistant-history.mjs';

const bad = () => Object.assign(new Error('云端原生会话暂时无法安全展示'), { code: 'ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE', status: 409 });
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(); return value; };
const array = value => { if (!Array.isArray(value)) throw bad(); return value; };
const integer = (value, min = 0) => { if (!Number.isSafeInteger(value) || value < min || Object.is(value, -0)) throw bad(); return value; };
const text = value => { if (typeof value !== 'string') throw bad(); return value; };
const identity = value => { if (typeof value !== 'string' || !value.length || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw bad(); return value; };
const boolean = value => { if (typeof value !== 'boolean') throw bad(); return value; };
const choice = (value, values) => { if (!values.includes(value)) throw bad(); return value; };
const nullableSeq = value => value === null ? null : integer(value);
const surfaceTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const simpleSources = new Set(['system-prompt', 'tool-registry', 'ptc-mode', 'working-directory', 'cordis-host-runner',
  'runtime-context', 'schedule', 'model-selection', 'plan-mode', 'tool-goal', 'time-context', 'tmux-context', 'user-approval',
  'repeat-tool-reminder', 'tool-jobs', 'dsh-session-title-llm', 'hooks-claude-code', 'hooks-codex']);
const target = value => choice(value, ['next-turn', 'next-step']);

function contextForm(source) {
  if (source.form === undefined) return {};
  const form = choice(source.form, ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall']);
  return { form, ...(form === 'snapshot' ? { sections: [] } : form === 'notice' ? { summary: '' } : {}) };
}
function sourceOf(value) {
  const source = object(value), kind = text(source.kind);
  if (simpleSources.has(kind)) return { kind, ...contextForm(source) };
  switch (kind) {
    case 'user': return { kind, ...(source.rpcId === undefined ? {} : { rpcId: identity(source.rpcId) }) };
    case 'model': return { kind, provider: '', model: '' };
    case 'tool': return { kind, callId: identity(source.callId) };
    case 'skill-invocation': return { kind, form: 'instructions', name: '' };
    case 'skill-catalog': return { kind, form: 'catalog', entries: [], ...(source.update === true ? { update: true } : {}) };
    case 'agent-instructions': return { kind, form: 'instructions', changes: [], ...(source.baseline === true ? { baseline: true } : {}) };
    case 'session-reference': return { kind, form: 'recall', version: 1, references: [] };
    case 'compact-checkpoint': return { kind, compactionId: identity(source.compactionId),
      ...(source.sourceCommandId === undefined ? {} : { sourceCommandId: identity(source.sourceCommandId) }) };
    case 'goal': return { kind, goalId: identity(source.goalId), revision: integer(source.revision), round: integer(source.round, 1) };
    case 'user-question-reply': return { kind, callId: identity(source.callId), outcome: choice(source.outcome, ['answered']) };
    case 'agent-message': return { kind, form: 'relay', senderSessionId: '' };
    case 'subagent-settled': return { kind, form: 'notice', summary: '', senderSessionId: '' };
    case 'team-message': return { kind, teamId: '', messageId: identity(source.messageId), senderId: '', senderName: '' };
    case 'webhook': return { kind, provider: '', source: '', deliveryId: '', ruleId: '', form: 'notice', summary: '' };
    default: throw bad(); // Future surface producers need an explicit source-field review.
  }
}
// The native facade is a display preview. This bound is per complete message,
// after credential redaction, including JSON escaping and attachment metadata.
export const ASSISTANT_NATIVE_PREVIEW_BYTES = 32 * 1024;
export const ASSISTANT_NATIVE_PREVIEW_NOTICE = '【展示预览已截断：源消息未改动，勿作执行输入】';
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
function boundedContent(content) {
  if (jsonBytes(content) <= ASSISTANT_NATIVE_PREVIEW_BYTES) return content;
  const notice = { type: 'text', text: ASSISTANT_NATIVE_PREVIEW_NOTICE }, result = [];
  let remaining = ASSISTANT_NATIVE_PREVIEW_BYTES - jsonBytes([notice]);
  for (const part of content) {
    const bytes = jsonBytes(part) + 1;
    if (bytes <= remaining) { result.push(part); remaining -= bytes; continue; }
    if (part.type === 'text') {
      // Binary search serialized bytes, not UTF-16 length; do not split a pair.
      let low = 0, high = part.text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (jsonBytes({ type: 'text', text: part.text.slice(0, middle) }) + 1 <= remaining) low = middle;
        else high = middle - 1;
      }
      if (low && /[\uD800-\uDBFF]/u.test(part.text[low - 1])) low--;
      if (low) result.push({ type: 'text', text: part.text.slice(0, low) });
    }
    break;
  }
  result.push(notice);
  return result;
}
function visibleContent(value) {
  // Do not feed unbounded input through the credential recognizers. Withhold
  // the entire body here; a prefix taken before redaction could expose secrets.
  if (jsonBytes(value) > 128 * 1024) return [{ type: 'text', text: ASSISTANT_NATIVE_PREVIEW_NOTICE }];
  const raw = value.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
  for (const token of raw.matchAll(/[A-Za-z0-9_.-]+/gu)) if (token[0].length >= 16384) return [{ type: 'text', text: ASSISTANT_NATIVE_PREVIEW_NOTICE }];
  const content = displayContent(value);
  const displayed = content.filter(part => part.type === 'text').map(part => part.text).join('');
  // A credential can span multiple durable text blocks as well as live deltas.
  // Preserve attachment positions, but withhold the text when per-block
  // redaction differs from redaction of the complete displayed text.
  return boundedContent(displayText(raw) === displayed ? content : content.map(part => part.type === 'text'
    ? { type: 'text', text: '[已隐藏凭据]' } : part));
}
function messageOf(value, expectedRole) {
  const message = object(value), role = choice(message.role, [expectedRole]);
  const source = sourceOf(message.source);
  if (role === 'system' && source.kind !== 'system-prompt' || role === 'assistant' && source.kind !== 'model'
    || role === 'tool' && source.kind !== 'tool') throw bad();
  array(message.content);
  const visible = role === 'assistant' || role === 'user' && source.kind === 'user';
  return { id: identity(message.id), role, source, content: visible ? visibleContent(message.content) : [],
    ...(role === 'tool' ? { toolCallId: identity(message.toolCallId), ...(message.isError === undefined ? {} : { isError: boolean(message.isError) }) } : {}) };
}
function envelopeOf(event) {
  const result = { type: text(event.type), seq: integer(event.seq), time: integer(event.time, Number.MIN_SAFE_INTEGER) };
  if (event.ignorable !== undefined) { if (event.ignorable !== true) throw bad(); result.ignorable = true; }
  if (surfaceTypes.has(event.type)) {
    const op = event.surfaceOp;
    if (op === 'append') result.surfaceOp = op;
    else {
      object(op); const startSeq = integer(op.startSeq), endSeq = integer(op.endSeq);
      if (op.op !== 'replace' || startSeq > endSeq || endSeq >= event.seq) throw bad();
      result.surfaceOp = { op: 'replace', startSeq, endSeq };
    }
    if (event.sourceEventSeqs !== undefined) {
      if (event.type === 'assistant/message') throw bad();
      const seqs = array(event.sourceEventSeqs).map(seq => integer(seq));
      if (!seqs.length || seqs.some(seq => seq >= event.seq) || new Set(seqs).size !== seqs.length) throw bad();
      result.sourceEventSeqs = seqs;
    }
  } else if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) throw bad();
  return result;
}
const failure = () => ({ code: 'ASSISTANT_TURN_FAILED', message: '助理本次任务未完成。' });
function turnReason(value) {
  const reason = object(value), kind = choice(reason.kind, ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']);
  if (kind === 'error') return { kind, error: failure() };
  if (kind !== 'aborted') return { kind };
  const cause = object(reason.reason), causeKind = choice(cause.kind, ['user', 'parent', 'hook', 'disposed', 'legacy']);
  return { kind, reason: { kind: causeKind, ...(causeKind === 'hook' ? { reason: '' } : {}) } };
}
function usageOf(value) {
  const usage = object(value), result = { inputTokens: integer(usage.inputTokens), outputTokens: integer(usage.outputTokens) };
  for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) if (usage[key] !== undefined) result[key] = integer(usage[key]);
  return result;
}
function finishOf(value) {
  const kind = choice(object(value).kind, ['stop', 'tool-calls', 'max-tokens', 'aborted', 'error']);
  return { kind, ...(['aborted', 'error'].includes(kind) ? { failure: failure() } : {}) };
}
function blockOf(value) {
  const block = object(value);
  if (block.type === 'text') return { type: 'text', text: '' };
  if (block.type === 'reasoning') return { type: 'reasoning', text: '' };
  if (block.type === 'tool-call') return { type: 'tool-call', id: identity(block.id), name: '', arguments: '' };
  const content = displayContent([block]);
  if (content.length !== 1) throw bad();
  return content[0];
}
function chunkOf(value) {
  const chunk = object(value), type = text(chunk.type);
  switch (type) {
    case 'block-start': return { type, index: integer(chunk.index), blockType: choice(chunk.blockType, ['text', 'reasoning', 'image', 'file', 'tool-call']) };
    // Raw deltas can split a credential across chunks. Only the assembled
    // durable message is safe to redact without a second stream accumulator.
    case 'text-delta': return { type, index: integer(chunk.index), text: '' };
    case 'reasoning-delta': return { type, index: integer(chunk.index), text: '' };
    case 'tool-call-delta': return { type, index: integer(chunk.index), id: identity(chunk.id), ...(chunk.name === undefined ? {} : { name: '' }), argumentsDelta: '' };
    case 'block-end': return { type, index: integer(chunk.index), block: blockOf(chunk.block) };
    case 'usage': return { type, usage: usageOf(chunk.usage) };
    case 'finish': return { type, reason: finishOf(chunk.reason) };
    default: throw bad();
  }
}
function streamOf(value) {
  const projected = array(value).map(value => {
    const row = object(value), type = choice(row.type, ['chunk', 'text-chunks', 'reasoning-chunks', 'tool-call-chunks']);
    if (type === 'chunk') return { type, time: integer(row.time, Number.MIN_SAFE_INTEGER), chunk: chunkOf(row.chunk) };
    const dt = array(row.dt).map(value => integer(value, Number.MIN_SAFE_INTEGER));
    const members = array(type === 'tool-call-chunks' ? row.args : row.texts);
    if (!members.length || dt.length !== members.length - 1) throw bad();
    const base = { type, time0: integer(row.time0, Number.MIN_SAFE_INTEGER), index: integer(row.index), dt };
    return type === 'tool-call-chunks' ? { ...base, id: identity(row.id), ...(row.name === undefined ? {} : { name: '' }), args: members.map(value => { text(value); return ''; }) }
      : { ...base, texts: members.map(value => { text(value); return ''; }) };
  });
  // Replay chunks are presentation-only. Keep the real baseline nextIndex and
  // revision outside this array so new live frames and settlements stay dense.
  return jsonBytes(projected) <= 32 * 1024 ? projected : [];
}

function inboxMessages(value) {
  const messages = array(value).map(value => messageOf(value, 'user'));
  if (jsonBytes(messages) <= 32 * 1024) return messages;
  // Native echo matching depends on positions, id and rpcId, never body text.
  const identities = messages.map(message => ({ ...message, content: [] }));
  if (jsonBytes(identities) > 32 * 1024) throw bad();
  return identities;
}

/** Project exactly one source event, preserving its durable position and safe structural references. */
export function projectAssistantNativeEvent(value) {
  const event = object(value), envelope = envelopeOf(event);
  if (!surfaceTypes.has(event.type) && !['turn/start', 'turn/end', 'step/start', 'step/end', 'assistant/attempt',
    'request/header', 'request/context', 'agent/inbox/spliced'].includes(event.type)) {
    return { type: 'agentkit/privacy-redacted', seq: envelope.seq, time: envelope.time, ignorable: true, data: { sourceSeq: envelope.seq } };
  }
  const data = object(event.data);
  const turn = () => integer(data.turn), step = () => integer(data.step);
  switch (event.type) {
    case 'turn/start': return { ...envelope, data: { turn: turn() } };
    case 'turn/end': return { ...envelope, data: { turn: turn(), reason: turnReason(data.reason) } };
    case 'step/start': case 'step/end': return { ...envelope, data: { turn: turn(), step: step() } };
    case 'user/message': return { ...envelope, data: messageOf(data, 'user') };
    case 'system/message': case 'developer/message': return { ...envelope, data: { turn: turn(), step: step(), message: messageOf(data.message, event.type.split('/')[0]) } };
    case 'assistant/message': return { ...envelope, data: { turn: turn(), step: step(), message: messageOf(data.message, 'assistant'), stream: streamOf(data.stream),
      ...(data.interrupted === true ? { interrupted: true } : {}), ...(data.usage === undefined ? {} : { usage: usageOf(data.usage) }) } };
    case 'assistant/attempt': return { ...envelope, data: { turn: turn(), step: step(), stream: streamOf(data.stream) } };
    case 'tool/result': return { ...envelope, data: { turn: turn(), step: step(), message: messageOf(data.message, 'tool') } };
    case 'request/header': return { ...envelope, data: { reason: choice(data.reason, ['initial', 'resume', 'change', 'series']),
      ...(data.startsSeries === true ? { startsSeries: true } : {}), header: { config: { provider: '', model: '' } } } };
    case 'request/context': return { ...envelope, data: { provider: '', model: '' } };
    case 'agent/inbox/spliced': return { ...envelope, data: { target: target(data.target), start: integer(data.start),
      ...(data.removedCount === undefined ? {} : { removedCount: integer(data.removedCount) }), inserted: inboxMessages(data.inserted),
      ...(data.outcome === undefined ? {} : { outcome: choice(data.outcome, ['canceled']) }) } };
    default: return { type: 'agentkit/privacy-redacted', seq: envelope.seq, time: envelope.time, ignorable: true, data: { sourceSeq: envelope.seq } };
  }
}

function projectionValue(key, value) {
  const data = object(value);
  switch (key) {
    case 'inbox': return { 'next-turn': inboxMessages(data['next-turn']), 'next-step': inboxMessages(data['next-step']) };
    case 'turnBoundary': return { openTurnStartSeq: nullableSeq(data.openTurnStartSeq), lastStepStartSeq: nullableSeq(data.lastStepStartSeq),
      lastStepBoundary: data.lastStepBoundary === null ? null : { kind: choice(object(data.lastStepBoundary).kind, ['start', 'end']), seq: integer(data.lastStepBoundary.seq) }, lastTurn: integer(data.lastTurn) };
    case 'sessionListMetadata': return { blank: boolean(data.blank), lastPromptAt: data.lastPromptAt === null ? null : integer(data.lastPromptAt) };
    default: return undefined;
  }
}
const projectionKeys = ['inbox', 'turnBoundary', 'sessionListMetadata'];
function projectionValues(value) {
  const values = object(value), result = {};
  for (const key of projectionKeys) if (Object.hasOwn(values, key)) result[key] = projectionValue(key, values[key]);
  return result;
}
/** Allow only Controller input/lifecycle projections; no model, tool, approval or cross-Session capabilities. */
export function projectAssistantNativeProjectionBaseline(value) {
  const baseline = object(value); return { asOfSeq: integer(baseline.asOfSeq, -1), values: projectionValues(baseline.values) };
}
/** Retain only the bound Session's running flag; every other forwarded Host event stays out.
 * An unrecognized event shape is dropped, never allowed to break the read stream. */
export function projectAssistantNativeStatusEvent(value, sessionId) {
  const frame = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!frame || frame.event !== 'api-session/status' || !Array.isArray(frame.args)) return null;
  if (frame.args.length !== 2 || frame.args[0] !== sessionId || typeof frame.args[1] !== 'boolean') return null;
  return { type: 'emit', event: 'api-session/status', args: [sessionId, frame.args[1]] };
}
/** Project the public nullable/migration-aware SessionController.projections response. */
export function projectAssistantNativeProjections(value) {
  if (value === null) return null;
  const result = object(value);
  if (result.kind === 'migration-required') return { kind: 'migration-required', values: {} };
  if (result.kind !== 'sequenced') throw bad();
  return { kind: 'sequenced', ...projectAssistantNativeProjectionBaseline(result) };
}
/** Preserve dense live frame indexes/revisions while excluding reasoning and provider replay payloads. */
export function projectAssistantNativeAssistantFrame(value) {
  const frame = object(value), type = choice(frame.type, ['start', 'chunk', 'end']);
  const base = { type, attemptId: identity(frame.attemptId), revision: integer(frame.revision) };
  if (type === 'start') return { ...base, startedAfterSeq: integer(frame.startedAfterSeq, -1), turn: integer(frame.turn), step: integer(frame.step) };
  if (type === 'chunk') return { ...base, index: integer(frame.index), time: integer(frame.time, Number.MIN_SAFE_INTEGER), chunk: chunkOf(frame.chunk) };
  const outcome = object(frame.outcome), kind = choice(outcome.kind, ['committed', 'abandoned']);
  return { ...base, index: integer(frame.index), outcome: { kind, ...(kind === 'committed' ? { eventType: choice(outcome.eventType, ['assistant/message', 'assistant/attempt']), seq: integer(outcome.seq) } : {}) } };
}
/** Sanitize reconnect stream prefixes with the same rules used for live and settled chunks. */
export function projectAssistantNativeAssistantBaseline(value) {
  const baseline = object(value), result = { revision: integer(baseline.revision) };
  if (baseline.activeAttempt !== undefined) {
    const active = object(baseline.activeAttempt);
    result.activeAttempt = { attemptId: identity(active.attemptId), startedAfterSeq: integer(active.startedAfterSeq, -1), turn: integer(active.turn), step: integer(active.step), nextIndex: integer(active.nextIndex), stream: streamOf(active.stream) };
  }
  return result;
}
/** Native header identity is session-scoped; workspace and preset configuration never cross this facade. */
export function projectAssistantNativeHeader(value, sessionId) {
  const header = object(value);
  if (header.id !== sessionId) throw bad();
  return { version: integer(header.version, 1), id: identity(header.id), createdAt: integer(header.createdAt), isSeeded: boolean(header.isSeeded) };
}
/** One-to-one contiguous source page; no public cursor renumbering or extra persistent store. */
export function projectAssistantNativePage(value) {
  const page = object(value), records = array(page.records).map(record => {
    if (object(record).type !== 'event') throw bad();
    return { type: 'event', event: projectAssistantNativeEvent(record.event) };
  });
  if (records.some((record, index) => index && record.event.seq !== records[index - 1].event.seq + 1)) throw bad();
  return { records, hasMore: boolean(page.hasMore) };
}
/** Sanitize every follow path, including the opening baseline and assistant live side-channel. */
export function projectAssistantNativeFollowFrame(value, sessionId) {
  const frame = object(value);
  if (frame.type === 'event') return { type: 'event', event: projectAssistantNativeEvent(frame.event) };
  if (frame.type === 'assistant-stream') return { type: 'assistant-stream', frame: projectAssistantNativeAssistantFrame(frame.frame) };
  if (frame.type !== 'snapshot') throw bad();
  return { type: 'snapshot', header: projectAssistantNativeHeader(frame.header, sessionId), cursor: integer(frame.cursor, -1),
    ...projectAssistantNativePage(frame), projections: projectAssistantNativeProjectionBaseline(frame.projections),
    ...(frame.assistantStream === undefined ? {} : { assistantStream: projectAssistantNativeAssistantBaseline(frame.assistantStream) }) };
}
/** Retain only one bound Session in the Host control stream; unrelated or unsupported keys are omitted. */
export function projectAssistantNativeControlFrame(value, sessionId) {
  const frame = object(value);
  if (frame.type === 'baseline') {
    const projections = object(object(frame.value).projections), result = {};
    if (Object.hasOwn(projections, sessionId)) result[sessionId] = projectAssistantNativeProjectionBaseline(projections[sessionId]);
    return { type: 'baseline', value: { projections: result } };
  }
  if (frame.type !== 'projection') throw bad();
  if (frame.sessionId !== sessionId || !projectionKeys.includes(frame.key)) return null;
  return { type: 'projection', sessionId, key: frame.key, seq: integer(frame.seq, -1), value: projectionValue(frame.key, frame.value) };
}
