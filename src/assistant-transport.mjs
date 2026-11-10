/** Bounded JSON transport for receipt-owned assistant operations. */
import { ASSISTANT_UPLOAD_BODY_BYTES } from './contracts/assistant-attachments.mjs';

export const ASSISTANT_INPUT_BODY_BYTES = 256 * 1024;
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export const assistantInputLimit = operation => operation === 'attachment-upload' ? ASSISTANT_UPLOAD_BODY_BYTES : ASSISTANT_INPUT_BODY_BYTES;

export function encodeAssistantInput(operation, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('ASSISTANT_INPUT_INVALID', '助理请求格式无效');
  const body = JSON.stringify(input);
  if (Buffer.byteLength(body) > assistantInputLimit(operation)) throw fail('ASSISTANT_INPUT_TOO_LARGE', '消息或附件超过云端传输限制', 413);
  return body;
}

/** Never buffer an unbounded cloud response, including an error body. */
export async function readAssistantResponse(response) {
  const limit = ASSISTANT_UPLOAD_BODY_BYTES;
  const declared = response.headers?.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel();
    throw fail('ASSISTANT_RESPONSE_TOO_LARGE', '云端返回内容超过查看限制', 502);
  }
  const chunks = []; let bytes = 0;
  if (!response.body) throw fail('ASSISTANT_RESPONSE_INVALID', '云端助理返回格式无法识别', 502);
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw fail('ASSISTANT_RESPONSE_TOO_LARGE', '云端返回内容超过查看限制', 502);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('ASSISTANT_RESPONSE_INVALID', '云端助理返回格式无法识别', 502); }
}

/** Localized allowlist; raw provider diagnostics never reach the browser. */
export function assistantCloudFailure(status, value) {
  const messages = {
    ASSISTANT_NATIVE_UNAVAILABLE: '此云端镜像尚未提供安全的原生会话连接，请更新后重试',
    ASSISTANT_NATIVE_REQUEST_INVALID: '原生会话请求格式无效，请刷新后重试',
    ASSISTANT_NATIVE_OPERATION_FORBIDDEN: '此操作不在当前原生会话支持范围内',
    ASSISTANT_NATIVE_SESSION_FORBIDDEN: '此连接不属于当前云端会话，请重新连接',
    ASSISTANT_NATIVE_STALE: '原生会话连接已释放，请重新连接',
    ASSISTANT_NATIVE_STREAM_STALE: '会话更新连接已释放，请重新连接',
    ASSISTANT_NATIVE_STREAM_LIMIT: '会话更新连接较多，请关闭重复页面后重试',
    ASSISTANT_NATIVE_POLL_CONFLICT: '会话更新正在读取，请重新连接',
    ASSISTANT_NATIVE_INFLIGHT_LIMIT: '原生会话连接繁忙，请稍后重试',
    ASSISTANT_NATIVE_CARRIER_LIMIT: '原生会话页面较多，请关闭不用的页面后重试',
    ASSISTANT_NATIVE_STREAM_OVERFLOW: '会话更新较多，请重新连接以恢复历史',
    ASSISTANT_NATIVE_PROJECTION_INVALID: '云端历史暂时无法安全展示，请更新云端版本',
    ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE: '云端历史暂时无法安全展示，请更新云端版本',
    ASSISTANT_NATIVE_RECEIPT_INVALID: '云端尚未确认当前请求，请用原请求继续核对',
    ASSISTANT_NATIVE_RESPONSE_TOO_LARGE: '云端历史返回内容超过查看限制，请缩小读取范围',
    ASSISTANT_INPUT_INVALID: '消息内容、请求标识或时区无效，请核对后重试',
    ASSISTANT_ATTACHMENT_UNAVAILABLE: '当前云端版本不支持所需附件能力，请更新后重试',
    ASSISTANT_ATTACHMENT_EXPIRED: '附件回执已过期，请重新选择附件后发送',
    ASSISTANT_ATTACHMENT_NOT_FOUND: '附件不属于当前会话或已失效，请重新选择',
    ASSISTANT_ATTACHMENT_TOO_LARGE: '附件超过大小限制，请选择较小文件',
    ASSISTANT_ATTACHMENT_INVALID: '附件格式无法验证，请重新选择',
    ASSISTANT_IMAGE_INVALID: '图片格式无法验证，请选择受支持的图片',
    ASSISTANT_IMAGE_TOO_LARGE: '图片超过大小限制，请选择较小图片',
    ASSISTANT_FILE_NOT_FOUND: '文件不属于当前可见会话，或已无法读取',
    ASSISTANT_FILE_UNAVAILABLE: '当前云端会话尚不能读取文件，请刷新或更新云端版本',
    ASSISTANT_FILE_TOO_LARGE: '文件超过下载大小限制',
    ASSISTANT_PERSISTENCE_UNAVAILABLE: '云端尚未确认保存，请用原请求继续确认，避免重复发送',
    ASSISTANT_REQUEST_CONFLICT: '此请求标识已用于不同内容，请核对原请求',
  };
  const code = value?.error?.code;
  return typeof code === 'string' && Object.hasOwn(messages, code) ? fail(code, messages[code], status)
    : fail('ASSISTANT_CLOUD_REQUEST_FAILED', `云端助理请求未完成（${status}）；请刷新核对状态`, status);
}
