/** Safe, read-only presentation of DSH-owned history. Never a second session store. */
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value) ? value : '';
export const assistantFailure = () => ({ code: 'ASSISTANT_TURN_FAILED', message: '助理本次任务未完成，请重试；若仍失败，请检查模型和工具连接。' });

/** Remove common credential representations; diagnostic payloads are omitted altogether. */
export function displayText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[已隐藏凭据]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_+./=:-]+/gi, '[已隐藏凭据]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b/g, '[已隐藏凭据]')
    .replace(/(^|[\r\n])([ \t]*(?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, '$1$2[已隐藏凭据]')
    .replace(/(["']?[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|private[_-]?key|secret[_-]?key|client[_-]?secret|password|passwd|authorization|auth[_-]?token|session[_-]?(?:credential|token|key)|credentials?|secret|token|cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[已隐藏凭据]')
    .replace(/(--(?:api[_-]?key|token|auth[_-]?token|access[_-]?token|private[_-]?key|password|secret|credential)\s+)(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/gi, '$1[已隐藏凭据]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏凭据]@')
    .replace(/([?&](?:token|key|signature|sig|credential|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#\s)\]>]+/gi, '$1[已隐藏凭据]');
}
const basename = value => displayText(typeof value === 'string' ? value.split(/[\\/]/).at(-1) : '').slice(0, 255);

export function displayAttachment(value, image = false) {
  if (!record(value) || !/^sha256:[a-f0-9]{64}$/i.test(value.attachmentId || '') || !Number.isSafeInteger(value.bytes) || value.bytes < 0) return null;
  const attachment = { attachmentId: value.attachmentId, bytes: value.bytes };
  if (value.name) attachment.name = basename(value.name);
  if (!image) return { ...attachment, name: attachment.name || '文件' };
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mediaType)
    || !Number.isSafeInteger(value.width) || value.width < 1 || !Number.isSafeInteger(value.height) || value.height < 1) return null;
  const dimensions = value.originalDimensions;
  return { ...attachment, mediaType: value.mediaType, width: value.width, height: value.height,
    ...(Number.isSafeInteger(dimensions?.width) && dimensions.width > 0 && Number.isSafeInteger(dimensions?.height) && dimensions.height > 0
      ? { originalDimensions: { width: dimensions.width, height: dimensions.height } } : {}) };
}

export function displayContent(value, { tools = false } = {}) {
  return list(value).flatMap(part => {
    if (!record(part)) return [];
    if (part.type === 'text') return [{ type: 'text', text: displayText(part.text) }];
    if (part.type === 'image' || part.type === 'file') {
      const attachment = displayAttachment(part.attachment, part.type === 'image');
      return attachment ? [{ type: part.type, attachment, ...(part.offloaded === true ? { offloaded: true } : {}) }] : [];
    }
    if (tools && part.type === 'tool-call' && identifier(part.id)) return [{ type: 'tool-call', id: identifier(part.id), name: identifier(part.name), arguments: '{}' }];
    // No reasoning, prompt/catalog blocks, raw provider objects or extension payloads.
    return [];
  });
}
export const contentText = content => list(content).filter(part => part.type === 'text').map(part => part.text).join('');

export function displayUser(message, fallbackId = '') {
  if (!['user', 'schedule'].includes(message?.source?.kind)) return null;
  const schedule = message.source.kind === 'schedule';
  const source = schedule ? { kind: 'schedule' } : { kind: 'user', ...(identifier(message.source.rpcId) ? { rpcId: identifier(message.source.rpcId) } : {}) };
  return { id: identifier(message.id) || fallbackId, role: 'user', source,
    content: schedule ? [{ type: 'text', text: '定时任务已触发。' }] : displayContent(message.content) };
}

function envelope(event, data) {
  const result = { type: event.type, seq: number(event.seq), time: number(event.time), data };
  if (event.surfaceOp === 'append') result.surfaceOp = 'append';
  else if (record(event.surfaceOp) && event.surfaceOp.op === 'replace'
    && Number.isSafeInteger(event.surfaceOp.startSeq) && event.surfaceOp.startSeq >= 0
    && Number.isSafeInteger(event.surfaceOp.endSeq) && event.surfaceOp.endSeq >= event.surfaceOp.startSeq) {
    result.surfaceOp = { op: 'replace', startSeq: event.surfaceOp.startSeq, endSeq: event.surfaceOp.endSeq };
  }
  if (Array.isArray(event.sourceEventSeqs)) result.sourceEventSeqs = event.sourceEventSeqs.filter(seq => Number.isSafeInteger(seq) && seq >= 0 && seq < event.seq);
  return result;
}

/** Native event vocabulary, deliberately restricted to visible conversation facts. */
export function displayEvents(events) {
  return list(events).flatMap(event => {
    if (!record(event) || !Number.isSafeInteger(event.seq) || event.seq < 0 || !record(event.data)) return [];
    const data = event.data, boundary = { turn: number(data.turn), step: number(data.step) };
    if (event.type === 'turn/start') return [envelope(event, { turn: boundary.turn })];
    if (event.type === 'step/start') return [envelope(event, boundary)];
    if (event.type === 'step/end') return [envelope(event, { ...boundary, reason: { kind: ['completed', 'aborted', 'tool-calls', 'stop'].includes(data.reason?.kind) ? data.reason.kind : 'error' } })];
    if (event.type === 'turn/end') {
      const kind = data.reason?.kind;
      const reason = kind === 'aborted' ? { kind, reason: { kind: 'legacy' } }
        : ['completed', 'interrupted', 'blocked', 'max-tokens'].includes(kind) ? { kind }
        : { kind: 'error', error: assistantFailure() };
      return [envelope(event, { turn: boundary.turn, reason })];
    }
    if (event.type === 'user/message') {
      const message = displayUser(data, `user-${event.seq}`);
      return message ? [envelope(event, message)] : [];
    }
    if (event.type === 'assistant/message') {
      const content = displayContent(data.message?.content, { tools: true });
      if (!content.length) return [];
      return [envelope(event, { ...boundary, stream: [], ...(data.interrupted === true ? { interrupted: true } : {}), message: { id: identifier(data.message?.id) || `assistant-${event.seq}`,
        role: 'assistant', source: { kind: 'model', provider: '', model: '' }, content } })];
    }
    if (event.type === 'tool/call' && identifier(data.callId)) return [envelope(event, {
      ...boundary, callId: identifier(data.callId), name: identifier(data.name), arguments: '{}',
    })];
    if (event.type === 'tool/result') {
      const message = data.message, callId = identifier(message?.toolCallId || message?.source?.callId);
      if (!callId) return [];
      const isError = message.isError === true || Boolean(data.error);
      return [envelope(event, { ...boundary, message: { id: identifier(message.id) || `tool-${event.seq}`, role: 'tool',
        toolCallId: callId, source: { kind: 'tool', callId }, isError,
        content: isError ? [{ type: 'text', text: '工具未能完成操作。请检查连接后重试。' }] : displayContent(message.content) },
      })];
    }
    if (['tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event.type)
      && identifier(data.rootCallId) && identifier(data.parentCallId) && identifier(data.subCallId)) {
      const dispatch = { rootCallId: identifier(data.rootCallId), parentCallId: identifier(data.parentCallId), subCallId: identifier(data.subCallId), name: identifier(data.name), arguments: {} };
      if (event.type === 'tool/ptc-dispatch') {
        dispatch.isError = data.isError === true || Boolean(data.error);
        dispatch.content = dispatch.isError ? [{ type: 'text', text: '工具未能完成操作。请检查连接后重试。' }] : displayContent(data.content);
      }
      return [envelope(event, dispatch)];
    }
    if (event.type === 'approval/asked' && identifier(data.id)) return [envelope(event, {
      id: identifier(data.id), toolName: identifier(data.toolName), ...(identifier(data.callId) ? { callId: identifier(data.callId) } : {}),
    })];
    if (event.type === 'approval/decided' && identifier(data.id)
      && ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(data.outcome)) return [envelope(event, { id: identifier(data.id), outcome: data.outcome })];
    if (event.type === 'goal/change' && data.version === 1) {
      if (data.operation === 'clear' && identifier(data.cleared?.id)) return [envelope(event, {
        kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: identifier(data.cleared.id), revision: number(data.cleared.revision) }, clearedAt: number(data.clearedAt),
      })];
      if (identifier(data.goal?.id) && ['active', 'paused', 'blocked', 'complete'].includes(data.goal.phase)) return [envelope(event, {
        kind: 'goal/change', version: 1, operation: ['create', 'edit', 'pause', 'resume', 'complete', 'block'].includes(data.operation) ? data.operation : 'edit',
        goal: { id: identifier(data.goal.id), revision: number(data.goal.revision), objective: displayText(data.goal.objective), phase: data.goal.phase,
          maxGoalRounds: number(data.goal.maxGoalRounds), ...(data.goal.phase === 'blocked' ? { blockedReason: { code: 'assistant-action-required', message: '云端任务需要处理，请检查连接和权限。' } } : {}) },
        roundsStarted: number(data.roundsStarted), createdAt: number(data.createdAt), updatedAt: number(data.updatedAt),
      })];
      return [];
    }
    if (event.type === 'deliverables/presented' && identifier(data.callId)) {
      const files = list(data.files).flatMap(file => {
        const name = basename(file?.path);
        return name && name !== '.' && name !== '..' ? [{ path: name, ...(typeof file.description === 'string' ? { description: displayText(file.description) } : {}) }] : [];
      });
      return files.length ? [envelope(event, { turn: boundary.turn, callId: identifier(data.callId), files })] : [];
    }
    return [];
  });
}

export function displayMessages(sessionId, events) {
  return events.flatMap(event => {
    const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : null;
    if (!role) return [];
    const message = role === 'user' ? event.data : event.data.message;
    const text = contentText(message.content);
    if (role === 'assistant' && !text.trim()) return [];
    return [{ id: `${sessionId}:${event.seq}`, seq: event.seq, role, text, source: message.source?.kind, requestId: message.source?.rpcId || '' }];
  });
}

export function displayQueue(inbox) {
  return ['next-turn', 'next-step'].flatMap(target => list(inbox?.[target]).flatMap((message, index) => {
    const safe = displayUser(message, `${target}-${index}`);
    return safe ? [{ ...safe, target, requestId: safe.source.rpcId || '', text: contentText(safe.content) }] : [];
  }));
}
