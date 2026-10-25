/** Pure browser-side helpers for the Personal Assistant desktop view. */

export const DEFAULT_DESKTOP_DISPLAY = Object.freeze({ width: 1280, height: 800 });
export const DESKTOP_STREAM_IDLE_MS = 10_000;
export const DESKTOP_ACTIVE_POLL_MS = 100;
export const DESKTOP_IDLE_POLL_MS = 1_000;
export const DESKTOP_MOUSE_HZ = 30;

export function normalizeDisplay(display = {}) {
  const width = Number(display.width) || DEFAULT_DESKTOP_DISPLAY.width;
  const height = Number(display.height) || DEFAULT_DESKTOP_DISPLAY.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return DEFAULT_DESKTOP_DISPLAY;
  }
  return Object.freeze({ width: Math.round(width), height: Math.round(height) });
}

/** Map client/canvas coordinates without stretching the 16:10 desktop. */
export function mapDisplayPoint({ clientX, clientY, rect, display = DEFAULT_DESKTOP_DISPLAY }) {
  const target = normalizeDisplay(display);
  const width = Number(rect?.width) || target.width;
  const height = Number(rect?.height) || target.height;
  const offsetX = Number(rect?.left) || 0;
  const offsetY = Number(rect?.top) || 0;
  const scale = Math.min(width / target.width, height / target.height);
  const left = offsetX + (width - target.width * scale) / 2;
  const top = offsetY + (height - target.height * scale) / 2;
  const x = Math.max(0, Math.min(target.width - 1, Math.round((Number(clientX) - left) / scale)));
  const y = Math.max(0, Math.min(target.height - 1, Math.round((Number(clientY) - top) / scale)));
  return { x, y };
}

export function framePayload(frame) {
  if (!frame || typeof frame !== 'object') return null;
  const seq = Number(frame.seq);
  const data = String(frame.data || '');
  if (!Number.isSafeInteger(seq) || seq < 0 || !data) return null;
  const display = normalizeDisplay(frame);
  const format = String(frame.format || 'image/jpeg').toLowerCase();
  const mime = format === 'webp' || format === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const bytes = Number(frame.bytes);
  if (Number.isFinite(bytes) && bytes > 300 * 1024) return null;
  return Object.freeze({ seq, data, mime, width: display.width, height: display.height, bytes: Number.isFinite(bytes) ? bytes : undefined });
}

export function frameDataUrl(frame) {
  const value = framePayload(frame);
  return value ? `data:${value.mime};base64,${value.data}` : null;
}

export function nextPollDelay({ lastInputAt = 0, now = Date.now(), idleMs = DESKTOP_STREAM_IDLE_MS } = {}) {
  return now - Number(lastInputAt || 0) >= idleMs ? DESKTOP_IDLE_POLL_MS : DESKTOP_ACTIVE_POLL_MS;
}

export function shouldAcceptFrame(frame, lastSeq = -1) {
  const value = framePayload(frame);
  return value ? value.seq > Number(lastSeq) : false;
}

export function isLeaseConflict(error) {
  return Number(error?.status || error?.statusCode || error?.httpStatus) === 409
    || String(error?.code || error?.error || '').toUpperCase().includes('LEASE_CONFLICT')
    || String(error?.message || '').includes('409');
}

export function isInputEventWritable({ connected, readOnly } = {}) {
  return Boolean(connected && !readOnly);
}
