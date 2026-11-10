/** Cloud attachment admission and bounded reads through public DSH services only. */
import { createHash } from 'node:crypto';
import { displayAttachment, displayEvents, displayQueue } from './assistant-history.mjs';
import { ASSISTANT_ATTACHMENT_LIMITS as limits, ASSISTANT_IMAGE_MEDIA_TYPES } from './contracts/assistant-attachments.mjs';

const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const signal = () => new AbortController().signal;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const receiptId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const nameValid = value => typeof value === 'string' && value.length > 0 && value.length <= limits.maxNameLength
  && !/[\\/\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..';
const exactKeys = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const invalid = () => fail('ASSISTANT_ATTACHMENT_INVALID', '附件格式无效，请重新选择文件');
const expired = () => fail('ASSISTANT_ATTACHMENT_EXPIRED', '附件上传凭据已失效或不属于当前会话，请重新选择文件', 409);
const tooLarge = () => fail('ASSISTANT_ATTACHMENT_TOO_LARGE', '附件超过云端大小或数量限制', 413);
function clientTimeZone(value = 'Asia/Shanghai') {
  const zone = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/;
  if (typeof value !== 'string' || value.length > 128 || value.trim() !== value || value !== 'UTC' && !zone.test(value)) throw fail('ASSISTANT_INPUT_INVALID', '消息时区无效，请刷新后重试');
  let canonical;
  try { canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; }
  catch (error) { throw fail('ASSISTANT_INPUT_INVALID', '消息时区无效，请刷新后重试'); }
  if (canonical !== 'UTC' && !zone.test(canonical)) throw fail('ASSISTANT_INPUT_INVALID', '消息时区无效，请刷新后重试');
  return canonical;
}

/** Capabilities describe available native services; provider errors remain explicit. */
export function assistantAttachmentCapabilities(ctx) {
  const uploads = ctx.get('fileUploads'), store = ctx.get('attachments');
  const files = typeof uploads?.upload === 'function' && typeof uploads?.resolve === 'function' && typeof uploads?.bindPrompt === 'function';
  const read = typeof store?.readFileStream === 'function';
  const images = files && read && typeof store?.validateImage === 'function';
  return { input: { attachments: files, files, images, limits,
    imageMediaTypes: [...ASSISTANT_IMAGE_MEDIA_TYPES], maxImageBytes: Math.min(limits.maxAttachmentBytes, store?.imageLimits?.maxImageBytes ?? limits.maxAttachmentBytes) }, read };
}

/** Normalize every submitted field before hashing; image bytes stay in the cloud. */
export function normalizeAssistantInput(payload) {
  if (!exactKeys(payload, ['conversation', 'requestId', 'text', 'content', 'timezone'])) throw fail('ASSISTANT_INPUT_INVALID', '消息包含不支持的字段');
  const timezone = clientTimeZone(payload.timezone);
  if (payload.content === undefined) {
    if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > limits.maxTextLength) throw fail('ASSISTANT_INPUT_INVALID', '请输入 1 至 32000 字的消息或添加附件');
    return { content: [{ type: 'text', text: payload.text }], timezone, fingerprint: digest(payload.text) };
  }
  if (payload.text !== undefined || !Array.isArray(payload.content) || !payload.content.length || payload.content.length > limits.maxAttachments + 32) throw invalid();
  let textLength = 0, count = 0, meaningful = false;
  const content = payload.content.map(part => {
    if (part?.type === 'text') {
      if (!exactKeys(part, ['type', 'text']) || typeof part.text !== 'string') throw invalid();
      textLength += part.text.length; meaningful ||= Boolean(part.text.trim());
      return { type: 'text', text: part.text };
    }
    if (!['image', 'file'].includes(part?.type) || !receiptId(part.receiptId)
      || !exactKeys(part, part.type === 'file' ? ['type', 'receiptId'] : ['type', 'receiptId', 'mediaType', 'name'])) throw invalid();
    count++; meaningful = true;
    if (part.type === 'file') return { type: 'file', receiptId: part.receiptId };
    if (!ASSISTANT_IMAGE_MEDIA_TYPES.includes(part.mediaType) || (part.name !== undefined && !nameValid(part.name))) throw invalid();
    return { type: 'image', receiptId: part.receiptId, mediaType: part.mediaType, ...(part.name === undefined ? {} : { name: part.name }) };
  });
  if (!meaningful || textLength > limits.maxTextLength) throw fail('ASSISTANT_INPUT_INVALID', '请输入 1 至 32000 字的消息或添加附件');
  if (count > limits.maxAttachments) throw tooLarge();
  return { content, timezone, fingerprint: digest(JSON.stringify({ content, timezone })) };
}

/** Reject oversized/noncanonical encodings before allocation or native storage. */
function decode(data) {
  if (typeof data !== 'string') throw invalid();
  if (data.length > Math.ceil(limits.maxAttachmentBytes / 3) * 4) throw tooLarge();
  const bytes = Buffer.from(data, 'base64');
  if (bytes.byteLength > limits.maxAttachmentBytes) throw tooLarge();
  if (bytes.toString('base64') !== data) throw invalid();
  return bytes;
}
function fileRef(value) {
  return record(value) && /^sha256:[a-f0-9]{64}$/.test(value.attachmentId || '') && nameValid(value.name)
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0 ? { attachmentId: value.attachmentId, name: value.name, bytes: value.bytes } : null;
}

/** Persist exact bytes using a native Session-scoped receipt; no facade receipt store. */
export async function uploadAssistantAttachment(ctx, agent, payload) {
  const capabilities = assistantAttachmentCapabilities(ctx);
  if (!capabilities.input.files || payload.kind === 'image' && !capabilities.input.images) throw fail('ASSISTANT_ATTACHMENT_UNAVAILABLE', '此云端版本暂不支持附件上传', 409);
  if (!exactKeys(payload, ['conversation', 'kind', 'name', 'mediaType', 'data']) || !['file', 'image'].includes(payload.kind)
    || !nameValid(payload.name) || payload.kind === 'file' && payload.mediaType !== undefined
    || payload.kind === 'image' && !ASSISTANT_IMAGE_MEDIA_TYPES.includes(payload.mediaType)) throw invalid();
  const bytes = decode(payload.data);
  if (payload.kind === 'image') {
    if (!bytes.length) throw invalid();
    if (bytes.length > capabilities.input.maxImageBytes) throw tooLarge();
    try { await ctx.get('attachments').validateImage({ data: bytes, mediaType: payload.mediaType, name: payload.name }); }
    catch (error) { throw fail('ASSISTANT_ATTACHMENT_INVALID', '图片格式或尺寸无效，请选择受支持的图片'); }
  }
  const result = await ctx.get('fileUploads').upload(agent, { data: payload.data, name: payload.name }, signal());
  const attachment = fileRef(result?.file);
  if (!receiptId(result?.receiptId) || !attachment || attachment.bytes !== bytes.length || attachment.attachmentId !== `sha256:${digest(bytes)}`) {
    throw fail('ASSISTANT_ATTACHMENT_INVALID', '云端未能验证附件保存结果，请重新选择文件', 503);
  }
  return { receiptId: result.receiptId, attachment: displayAttachment(attachment), kind: payload.kind,
    ...(payload.kind === 'image' ? { mediaType: payload.mediaType } : {}) };
}

/** Verify complete length and digest before returning any bytes to a caller. */
async function readBytes(store, ref) {
  if (ref.bytes > limits.maxAttachmentBytes) throw tooLarge();
  const chunks = []; let size = 0;
  for await (const chunk of store.readFileStream(ref, signal())) {
    if (!(chunk instanceof Uint8Array)) throw invalid();
    size += chunk.byteLength;
    if (size > ref.bytes || size > limits.maxAttachmentBytes) throw fail('ASSISTANT_ATTACHMENT_INVALID', '云端附件数据校验失败', 503);
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  if (size !== ref.bytes || `sha256:${digest(bytes)}` !== ref.attachmentId) throw fail('ASSISTANT_ATTACHMENT_INVALID', '云端附件数据校验失败', 503);
  return bytes;
}

/** Resolve receipts only after duplicate lookup, preserving native image and file semantics. */
export async function prepareAssistantPrompt(ctx, agent, content, { stageFile } = {}) {
  const attachments = content.filter(part => part.type !== 'text');
  if (!attachments.length) return { content, imageReceipts: [] };
  const capabilities = assistantAttachmentCapabilities(ctx);
  if (!capabilities.input.files) throw fail('ASSISTANT_ATTACHMENT_UNAVAILABLE', '此云端版本暂不支持附件消息', 409);
  let total = 0;
  const resolved = attachments.map(part => {
    const ref = fileRef(ctx.get('fileUploads').resolve(agent, part.receiptId));
    if (!ref) throw expired();
    if (ref.bytes > limits.maxAttachmentBytes || (total += ref.bytes) > limits.maxMessageAttachmentBytes) throw tooLarge();
    if (part.type === 'image' && (!capabilities.input.images || part.name !== undefined && part.name !== displayAttachment(ref).name)) throw invalid();
    return ref;
  });
  const imageReceipts = [], prepared = []; let next = 0;
  for (const part of content) {
    if (part.type === 'text') { prepared.push(part); continue; }
    const ref = resolved[next++];
    if (part.type === 'file') {
      if (stageFile) await stageFile(ref, await readBytes(ctx.get('attachments'), ref));
      prepared.push(part); continue;
    }
    if (!ref.bytes || ref.bytes > capabilities.input.maxImageBytes) throw tooLarge();
    const bytes = await readBytes(ctx.get('attachments'), ref);
    imageReceipts.push(part.receiptId);
    prepared.push({ type: 'image', mediaType: part.mediaType, data: bytes.toString('base64'), name: ref.name });
  }
  return { content: prepared, imageReceipts: [...new Set(imageReceipts)] };
}

async function* nativePages(controller, sessionId, projection) {
  const asOfSeq = projection.asOfSeq;
  if (!Number.isSafeInteger(asOfSeq) || asOfSeq < -1) throw fail('ASSISTANT_HISTORY_INVALID', '云端会话记录暂时无法验证', 503);
  let beforeSeq;
  while (true) {
    const page = await controller.page({ address: { kind: 'session', sessionId }, throughSeq: asOfSeq, maxMessages: 200,
      turnWindow: { minMessages: 50, minTurns: 1 }, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, signal());
    const events = (page.records || []).filter(row => row.type === 'event').map(row => row.event);
    if (events.some((event, index) => !Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq > asOfSeq
      || beforeSeq !== undefined && event.seq >= beforeSeq || index > 0 && event.seq <= events[index - 1].seq)
      || page.hasMore && (!events.length || events[0].seq === 0)) throw fail('ASSISTANT_HISTORY_INVALID', '云端会话记录暂时无法验证', 503);
    yield events;
    if (!page.hasMore) break;
    beforeSeq = events[0].seq;
  }
}

/** Native durable request identity survives receipt consumption and Host restart. */
export async function assistantRequestObserved(controller, sessionId, requestId, fingerprint) {
  const projection = await controller.projections({ sessionId }, signal());
  if (!projection) return false;
  if (projection.kind === 'migration-required') throw fail('ASSISTANT_HISTORY_MIGRATION_REQUIRED', '云端会话需要升级后才能恢复', 409);
  const matches = message => {
    if (message?.source?.kind !== 'user' || message.source.rpcId !== requestId) return false;
    if (message.source.requestFingerprint !== fingerprint) throw fail('ASSISTANT_REQUEST_CONFLICT', '请求标识已用于另一条消息，请刷新核对原消息', 409);
    return true;
  };
  if (['next-turn', 'next-step'].some(target => (projection.values?.inbox?.[target] || []).some(matches))) return true;
  for await (const events of nativePages(controller, sessionId, projection)) {
    if (events.some(event => event.type === 'user/message' && matches(event.data)
      || event.type === 'agent/inbox/spliced' && (event.data?.inserted || []).some(matches))) return true;
  }
  return false;
}

const fileIn = (content, id) => (Array.isArray(content) ? content : []).find(part => part?.type === 'file' && part.attachment?.attachmentId === id)?.attachment;
const contentOf = event => ['user/message', 'tool/ptc-dispatch'].includes(event.type) ? event.data.content : event.data.message?.content;

/** Only visible native file references authorize a download; path-only deliveries never do. */
export async function readAssistantFile(ctx, controller, sessionId, attachmentId) {
  if (!assistantAttachmentCapabilities(ctx).read) throw fail('ASSISTANT_FILE_UNAVAILABLE', '此云端版本暂不支持文件下载', 409);
  if (typeof attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(attachmentId)) throw invalid();
  const projection = await controller.projections({ sessionId }, signal());
  if (!projection || projection.kind === 'migration-required') throw fail('ASSISTANT_FILE_UNAVAILABLE', '文件所在会话暂时无法读取', 409);
  const visibleQueued = displayQueue(projection.values?.inbox);
  let ref;
  for (const target of ['next-turn', 'next-step']) {
    for (const message of projection.values?.inbox?.[target] || []) {
      const raw = fileIn(message.content, attachmentId);
      if (raw && visibleQueued.some(item => item.id === message.id && fileIn(item.content, attachmentId))) ref = fileRef(raw);
    }
  }
  if (!ref) for await (const events of nativePages(controller, sessionId, projection)) {
    for (const event of events) {
      const visible = displayEvents([event])[0];
      if (visible && fileIn(contentOf(visible), attachmentId)) ref = fileRef(fileIn(contentOf(event), attachmentId));
      if (ref) break;
    }
    if (ref) break;
  }
  if (!ref) throw fail('ASSISTANT_FILE_NOT_FOUND', '这个文件不属于当前可见会话', 404);
  const bytes = await readBytes(ctx.get('attachments'), ref);
  return { attachment: displayAttachment(ref), data: bytes.toString('base64') };
}
