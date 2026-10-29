/** Pure browser-side helpers for the Personal Assistant desktop view. */

export const DEFAULT_DESKTOP_DISPLAY = Object.freeze({ width: 1280, height: 800 });
export const DESKTOP_STREAM_IDLE_MS = 10_000;
export const DESKTOP_ACTIVE_POLL_MS = 100;
export const DESKTOP_IDLE_POLL_MS = 1_000;
export const DESKTOP_MOUSE_HZ = 30;
/**
 * 滚轮一个"刻度"对应的像素距离：runtime 把 wheel 的 deltaY 当成刻度数转成
 * `xdotool click --repeat N`，所以客户端必须先把像素累计成刻度再发。
 * 鼠标滚轮一格通常 100px 左右（正好 1 次），触控板平滑滚动的碎事件靠累计凑满。
 */
export const WHEEL_PIXEL_STEP = 100;

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

/**
 * 把远端桌面按 contain 方式装进可用区域：同时受可用宽、可用高与 maxWidth 约束，
 * 保证整幅画面（含顶部输入条）永远完整可见，永远不会被容器或滚动位置切掉。
 * 与 mapDisplayPoint 使用同一套 contain 数学，因此点击映射始终按真实 rect 计算。
 */
export function fitDesktopBox({ availableWidth, availableHeight, display = DEFAULT_DESKTOP_DISPLAY, maxWidth = Number.POSITIVE_INFINITY } = {}) {
  const target = normalizeDisplay(display);
  const width = Number(availableWidth) > 0 ? Number(availableWidth) : 0;
  const height = Number(availableHeight) > 0 ? Number(availableHeight) : 0;
  const cap = Number(maxWidth) > 0 ? Number(maxWidth) : Number.POSITIVE_INFINITY;
  if (!width || !height) return { width: 0, height: 0 };
  const boxWidth = Math.min(width, cap, height * (target.width / target.height));
  const round = value => Math.round(value * 100) / 100;
  return { width: round(boxWidth), height: round(boxWidth * (target.height / target.width)) };
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

/**
 * 把同一动画帧内的多个原生 wheel 事件合并成一次远端输入。
 * pending 保存"还不够一格"的像素余数（跨帧保留，触控板碎事件不会丢），
 * 返回的 clicks 是本次要发的刻度数（0 表示这一帧不用发，省掉一次远端 xdotool）。
 */
export function mergeWheel(pending = { x: 0, y: 0 }, { deltaX = 0, deltaY = 0 } = {}, step = WHEEL_PIXEL_STEP) {
  const size = Number(step) > 0 ? Number(step) : WHEEL_PIXEL_STEP;
  const x = (Number(pending?.x) || 0) + (Number(deltaX) || 0);
  const y = (Number(pending?.y) || 0) + (Number(deltaY) || 0);
  const clicksX = Math.trunc(x / size);
  const clicksY = Math.trunc(y / size);
  return {
    pending: Object.freeze({ x: x - clicksX * size, y: y - clicksY * size }),
    clicks: Object.freeze({ deltaX: clicksX, deltaY: clicksY }),
  };
}
