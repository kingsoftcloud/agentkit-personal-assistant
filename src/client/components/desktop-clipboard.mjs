/**
 * 云电脑剪贴板：本地 ⇄ 云端的两个可见入口。
 *
 * 云端桌面是 Linux（Xvfb + fluxbox），宿主可能是 macOS，所以「粘贴」永远是两步：
 *   1) 读**本地**剪贴板（navigator.clipboard.readText，浏览器可能直接拒绝）；
 *   2) 写**云电脑**剪贴板（computer.action / clipboard.write），再向云桌面合成一次
 *      **Ctrl+V**（不是 ⌘V）——云桌面不认识 macOS 的 Command 键。
 * 「复制」方向相反：读云电脑剪贴板 → 写本地剪贴板。
 *
 * 所有外部能力都从 props 注入（readCloud / writeCloud / sendKeys），因此这个模块既能被
 * 面板直接渲染，也能在 Node 测试里跑真实的编排逻辑，不需要浏览器环境。
 */

/** 云端 desktop-session 的剪贴板上限是 64 KiB，客户端先拦一次，避免发一半才 413。 */
export const MAX_CLIPBOARD_BYTES = 64 * 1024;

const clipError = (code, message, cause) => Object.assign(new Error(message), { code, cause });

const byteLength = value => {
  try { return new TextEncoder().encode(value).length; }
  catch { return value.length; }
};

/** clipboardRead() 兼容 `{ text }` 与裸字符串两种返回。 */
export const clipboardTextOf = value => (typeof value === 'string' ? value : String(value?.text ?? ''));

/** 读本地剪贴板：非安全上下文 / 未授权时浏览器会抛错，必须换成用户能懂的提示。 */
export async function readLocalClipboard({ clipboard } = {}) {
  const api = clipboard || globalThis.navigator?.clipboard;
  if (!api || typeof api.readText !== 'function') throw clipError('CLIPBOARD_UNAVAILABLE', '当前环境不允许读取剪贴板，请点「粘贴」按钮再试');
  try {
    const text = await api.readText();
    return typeof text === 'string' ? text : '';
  } catch (error) {
    throw clipError('CLIPBOARD_READ_DENIED', '浏览器不允许读取剪贴板，请按 ⌘V / Ctrl+V 再试', error);
  }
}

/** 写本地剪贴板：同样要兜住浏览器拒绝（页面失焦、权限被拒都会走到这里）。 */
export async function writeLocalClipboard(text, { clipboard } = {}) {
  const api = clipboard || globalThis.navigator?.clipboard;
  if (!api || typeof api.writeText !== 'function') throw clipError('CLIPBOARD_UNAVAILABLE', '当前环境不允许写入剪贴板，请手动复制');
  try { await api.writeText(String(text ?? '')); }
  catch (error) { throw clipError('CLIPBOARD_WRITE_DENIED', '浏览器不允许写入剪贴板，请重试', error); }
}

/**
 * 云桌面里的粘贴快捷键：Linux 桌面要 Control_L + v。
 * 无论宿主是 macOS 还是 Windows，最终发给云端的都是这组 X11 keysym。
 */
export function pasteShortcutEvents() {
  return Object.freeze([
    Object.freeze({ type: 'key', action: 'down', key: 'Control_L' }),
    Object.freeze({ type: 'key', action: 'down', key: 'v' }),
    Object.freeze({ type: 'key', action: 'up', key: 'v' }),
    Object.freeze({ type: 'key', action: 'up', key: 'Control_L' }),
  ]);
}

/** 把云端的错误码翻成用户能照做的中文；英文原文只作为兜底。 */
export function clipboardFriendlyError(error) {
  const code = String(error?.code || '');
  if (['COMPUTER_LEASE_REQUIRED', 'DESKTOP_CONTROL_GRANT_REQUIRED', 'DESKTOP_READ_ONLY', 'DESKTOP_CONTROL_EPOCH_CHANGED'].includes(code)) {
    return '需要先点画面接管云电脑，才能读写云端剪贴板';
  }
  if (['DESKTOP_SESSION_IDLE', 'DESKTOP_SESSION_NOT_FOUND', 'CLIPBOARD_CLOSED'].includes(code)) {
    return '云电脑已空闲或断开，请先恢复画面再试';
  }
  if (code === 'CLIPBOARD_TEXT_TOO_LARGE') return '剪贴板内容超过 64 KiB，云电脑剪贴板放不下';
  if (['DESKTOP_UNAVAILABLE', 'DESKTOP_FRAME_FAILED', 'DESKTOP_SESSION_FAILED'].includes(code)) return '云电脑暂时不可用，请稍后重试';
  if (['CLIPBOARD_FAILED', 'CLOUD_SESSION_FAILED'].includes(code)) return '剪贴板操作失败，请重试';
  if (code === 'CLIPBOARD_TEXT_INVALID') return '剪贴板内容格式不被云端接受，请重试';
  if (error?.message) return String(error.message);
  return code ? `剪贴板操作失败（${code}）` : '剪贴板操作失败，请重试';
}

let requestSequence = 0;
const nextRequestId = () => {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `clip-${random}` : `clip-${Date.now().toString(36)}-${(requestSequence += 1)}`;
};

/**
 * 云电脑桌面 WS 上的剪贴板请求通道（一个连接一个实例）。
 *
 * 云端契约（runtime/desktop-ws.mjs）：
 *   发 `{ type: 'clipboard.read' | 'clipboard.write', requestId, text? }`
 *   收 `{ type: 'clipboard.response', requestId, ok, value | error }`
 * 超时是必需的：旧版云端会直接回 DESKTOP_MESSAGE_UNSUPPORTED（不带 requestId），
 * 没有超时按钮就会一直转圈，所以这里超时即明确提示"云端待更新"。
 */
export function createClipboardChannel({ send, timeoutMs = 5000, controlEpoch, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map();
  const settle = (entry, settleWith) => {
    pending.delete(entry.id);
    clearTimer(entry.timer);
    settleWith();
  };
  const request = (type, extra) => new Promise((resolve, reject) => {
    const id = nextRequestId();
    const timer = setTimer(() => {
      const entry = pending.get(id);
      if (!entry) return;
      settle(entry, () => reject(clipError('CLIPBOARD_TIMEOUT', '云端助理版本较旧，剪贴板通道未启用（重新部署后可用）')));
    }, timeoutMs);
    pending.set(id, {
      id, timer, resolve,
      reject: error => reject(error),
    });
    let sent = false;
    // handoff 会话里云端要求与 input 一样带 controlEpoch；非 handoff 会话会忽略它。
    let epoch;
    try { epoch = typeof controlEpoch === 'function' ? controlEpoch() : undefined; }
    catch { epoch = undefined; }
    try { sent = send({ type, requestId: id, ...(Number.isSafeInteger(epoch) ? { controlEpoch: epoch } : {}), ...extra }) !== false; }
    catch (error) { settle(pending.get(id), () => reject(clipError('CLIPBOARD_UNAVAILABLE', '云电脑尚未连接，剪贴板暂不可用', error))); return; }
    // send() 返回 false 表示 socket 不在 OPEN：立刻失败，别让用户白等 5 秒。
    if (!sent) settle(pending.get(id), () => reject(clipError('CLIPBOARD_UNAVAILABLE', '云电脑尚未连接，剪贴板暂不可用')));
  });
  return Object.freeze({
    read: () => request('clipboard.read').then(value => ({ text: clipboardTextOf(value) })),
    write: text => request('clipboard.write', { text: String(text) }).then(value => ({ written: value?.written !== false })),
    /** socket.onmessage 里把 clipboard.response 交给它；返回是否消费了这条消息。 */
    accept(message) {
      if (!message || message.type !== 'clipboard.response') return false;
      const entry = pending.get(String(message.requestId || ''));
      if (!entry) return false;
      settle(entry, () => {
        if (message.ok !== false) entry.resolve(message.value);
        else entry.reject(clipError(message.error?.code || 'CLIPBOARD_FAILED', message.error?.message || '', message.error));
      });
      return true;
    },
    /** 连接断开/关闭时把在途请求全部失败掉，避免按钮永远转圈。 */
    rejectAll(error = clipError('CLIPBOARD_CLOSED', '云电脑连接已断开，剪贴板操作未完成')) {
      for (const entry of [...pending.values()]) settle(entry, () => entry.reject(error));
    },
    get size() { return pending.size; },
  });
}

/** 画布上的 ⌘V / Ctrl+V 是否该走"本地→云端"的粘贴流程（而不是把按键原样转给云桌面）。 */
export function isPasteShortcut(event) {
  if (!event || String(event.key ?? '').toLowerCase() !== 'v') return false;
  if (event.altKey || event.shiftKey) return false;
  if (event.isComposing || event.nativeEvent?.isComposing) return false;
  return event.metaKey === true || event.ctrlKey === true;
}

/** ⌘C / Ctrl+C：把云电脑剪贴板内容取回本地（面板不再放按钮，只用快捷键）。 */
export function isCopyShortcut(event) {
  if (!event || String(event.key ?? '').toLowerCase() !== 'c') return false;
  if (event.altKey || event.shiftKey) return false;
  if (event.isComposing || event.nativeEvent?.isComposing) return false;
  return event.metaKey === true || event.ctrlKey === true;
}

/**
 * 粘贴：本地剪贴板 → 云电脑剪贴板 → 云桌面 Ctrl+V。
 * notify 负责把结果写进面板上的轻提示；返回结构化结果方便调用方/测试断言。
 */
export async function pasteToCloud({ readLocal, writeCloud, sendKeys, notify = () => {} } = {}) {
  const read = readLocal || (() => readLocalClipboard());
  let text = '';
  try { text = await read(); }
  catch (error) { notify(clipboardFriendlyError(error) || '浏览器不允许读取剪贴板，请按 ⌘V / Ctrl+V 再试'); return { ok: false, code: error?.code || 'CLIPBOARD_READ_FAILED' }; }
  if (!text) { notify('本地剪贴板是空的，没有可粘贴的内容'); return { ok: false, code: 'CLIPBOARD_EMPTY' }; }
  if (byteLength(text) > MAX_CLIPBOARD_BYTES) { notify('剪贴板内容超过 64 KiB，云电脑剪贴板放不下'); return { ok: false, code: 'CLIPBOARD_TOO_LARGE' }; }
  try { await writeCloud(text); }
  catch (error) { notify(clipboardFriendlyError(error) || '写入云电脑剪贴板失败，请重试'); return { ok: false, code: 'CLIPBOARD_WRITE_FAILED' }; }
  if (typeof sendKeys === 'function') {
    let sent = false;
    try { sent = sendKeys(pasteShortcutEvents()) !== false; }
    catch (error) { return { ok: true, code: 'CLIPBOARD_KEY_FAILED', error }; }
    // 只读旁观时输入通道拒发按键：内容已到云端剪贴板，但要明确告诉用户还差接管这一步。
    if (!sent) { notify('已写入云电脑剪贴板，但当前没有控制权；接管云电脑后再按 Ctrl+V'); return { ok: true, code: 'CLIPBOARD_KEY_NOT_SENT' }; }
  }
  notify('已粘贴到云电脑');
  return { ok: true };
}

/** 复制：云电脑剪贴板 → 本地剪贴板。 */
export async function copyCloudClipboard({ readCloud, writeLocal, notify = () => {} } = {}) {
  const write = writeLocal || (text => writeLocalClipboard(text));
  let value;
  try { value = await readCloud(); }
  catch (error) { notify(clipboardFriendlyError(error) || '读取云电脑剪贴板失败，请重试'); return { ok: false, code: 'CLIPBOARD_READ_FAILED' }; }
  const text = clipboardTextOf(value);
  if (!text) { notify('云电脑剪贴板是空的，没有可复制的内容'); return { ok: false, code: 'CLIPBOARD_EMPTY' }; }
  try { await write(text); }
  catch (error) { notify(clipboardFriendlyError(error) || '浏览器不允许写入剪贴板，请重试'); return { ok: false, code: 'CLIPBOARD_WRITE_FAILED' }; }
  notify('已复制到本地');
  return { ok: true, text };
}
