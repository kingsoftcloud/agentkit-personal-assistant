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

/**
 * 乱码自愈：把「UTF-8 字节被当成单字节编码解码」的文本还原回原文。
 *
 * 线上两条链路的指纹非常明确：
 *   ‰Ω†Â•Ω  ←  「你好」（E4 BD A0 E5 A5 BD 被按 MacRoman 解码）
 *   ？？？？  ←  中文逐字符变成问号（有损编码，不可逆，只能拦不能修）
 * 前者可逆：按同一张单字节表把每个字符反查成字节，再按 UTF-8 解码即可拿回原文。
 * 只有「文本里没有中日韩字符 + 出现乱码指纹区字符 + 反查结果是合法 UTF-8」时才动手，
 * 正常的中文、英文、法文内容一个字节都不会被改。
 */
const SINGLE_BYTE_TABLES = (() => {
  // 真正的 latin-1 表必须手搓：TextDecoder('iso-8859-1') 按规范被别名到 windows-1252，
  // 而 0x80-0x9F 的 C1 控制字符在两者里解释完全不同，latin1 转坏的中文只有这张表能反查。
  const latin1 = new Map();
  for (let byte = 0x80; byte < 0x100; byte += 1) latin1.set(String.fromCharCode(byte), byte);
  const tables = [Object.freeze({ label: 'latin1', map: latin1 })];
  for (const label of ['macintosh', 'windows-1252']) {
    try {
      const decoder = new TextDecoder(label);
      const map = new Map();
      for (let byte = 0x80; byte < 0x100; byte += 1) {
        const char = decoder.decode(Uint8Array.of(byte));
        if (char && !map.has(char)) map.set(char, byte);
      }
      tables.push(Object.freeze({ label, map }));
    } catch { /* 运行时没有这张表就跳过，不影响另一张 */ }
  }
  return Object.freeze(tables);
})();
const CJK_PATTERN = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
const MOJIBAKE_SIGNATURE = /[\u00a0-\u00ff\u0152-\u0178\u2000-\u206f]/u;
const hasCjk = text => CJK_PATTERN.test(text);
const looksLikeMojibake = text => !hasCjk(text) && MOJIBAKE_SIGNATURE.test(text);
function encodeSingleByte(text, table) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const code = char.charCodeAt(0);
    // ASCII 在所有单字节编码里都是恒等的，表里只收了 0x80-0xFF。
    const byte = code < 0x80 ? code : table.map.get(char);
    if (byte === undefined) return null;
    bytes[index] = byte;
  }
  return bytes;
}
/**
 * 候选文本的"像正文"程度。同一串乱码常常能被多张单字节表解释（MacRoman 的 0xCC
 * 和 CP1252 的 0xC3 都是「Ã」），必须打分挑最像正文的那个，不能先到先得。
 */
function textPlausibility(text) {
  let score = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) score += 1;
    else if (code >= 0x0300 && code <= 0x036f) score -= 6; // 组合变音符：选错表的典型症状
    else if (CJK_PATTERN.test(char)) score += 4;
    else score -= 1;
  }
  return score;
}
/** 还原被单字节编码转坏的中文；认不出来就原样返回，绝不猜。 */
export function repairClipboardText(value) {
  let text = String(value ?? '');
  // 最多两轮：双重转坏（utf-8 → 单字节 → 再编码一次）需要连着还原两次。
  // 最多三轮：双重转坏（utf-8 → 单字节 → 再编码一次）要连着还原两次才能见到原文。
  for (let round = 0; round < 3; round += 1) {
    if (!looksLikeMojibake(text)) break;
    let best = null;
    let bestScore = textPlausibility(text);
    for (const table of SINGLE_BYTE_TABLES) {
      const bytes = encodeSingleByte(text, table);
      if (!bytes) continue;
      try {
        const candidate = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!candidate || candidate === text) continue;
        const score = textPlausibility(candidate);
        // 只接受「比原文更像正文」的还原：fatal 解码已经挡掉了绝大多数误判。
        if (score > bestScore) { best = candidate; bestScore = score; }
      } catch { /* 这条编码解释不通，换下一条 */ }
    }
    if (best === null) break;
    text = best;
  }
  return text;
}

/**
 * 回声窗口：粘贴把文本写进云电脑剪贴板后，紧接着的「复制」如果读到同一段文本，
 * 说明应用并没有真正复制，只是把刚写进去的内容原样读回（X11 selection 变了而已）。
 * 这时不能再写回本机，否则两端来回覆盖，用户原本的本机剪贴板会被静默替换。
 */
export const CLIPBOARD_ECHO_WINDOW_MS = 2000;

/** 回声判定器：生产用模块级默认实例；测试注入新实例即可避免用例之间互相污染。 */
export function createClipboardEchoGuard({ windowMs = CLIPBOARD_ECHO_WINDOW_MS, now = () => Date.now() } = {}) {
  let lastWrite = null;
  return Object.freeze({
    /** 记录刚写入云电脑剪贴板的文本（粘贴成功后调用）。 */
    remember(text) { lastWrite = { text: String(text ?? ''), at: now() }; },
    /** 云端读到的内容是否就是窗口内刚写入的同一段文本。 */
    isEcho(text) {
      const value = String(text ?? '');
      if (!value || !lastWrite) return false;
      return lastWrite.text === value && now() - lastWrite.at <= windowMs;
    },
  });
}

const defaultEchoGuard = createClipboardEchoGuard();
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 应用把内容发布到 X selection 是**异步**的：合成 Ctrl+C 之后立刻读云端剪贴板，
 * 拿到的往往还是上一次的内容。150ms 一把梭的写法让「应用根本没复制」和「读得太早」
 * 看起来一模一样——用户看到的就是「网页正文根本没法复制」。
 * 这里按调用方给的间隔轮询，直到内容相对复制前的基线发生变化。
 */
export const COPY_POLL_DELAYS_MS = Object.freeze([140, 200, 280, 400, 600]);

/** 写进云端剪贴板的内容再读回来是否已经变了形；读回失败/为空都不算不一致（不阻断流程）。 */
async function clipboardRoundTripMismatch({ readCloud, text, verifyDelayMs = 0, sleep = defaultSleep }) {
  try {
    if (verifyDelayMs) await sleep(verifyDelayMs);
    const value = clipboardTextOf(await readCloud());
    if (!value) return null;
    // 云端可能统一行尾；除此之外任何差异都意味着字符集被动过。
    const normalize = input => String(input ?? '').replace(/\r\n/gu, '\n');
    return normalize(value) === normalize(text) ? null : value;
  } catch { return null; }
}

/** 按 UTF-8 字符边界截断，保证不产生半个汉字（与云端 desktop-session 的截断口径一致）。 */
export function truncateUtf8(text, maxBytes = MAX_CLIPBOARD_BYTES) {
  const value = String(text ?? '');
  if (byteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let result = '';
  for (const char of value) {
    const size = byteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += char;
  }
  return result;
}

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

/**
 * 云端桌面里的复制快捷键也始终是 Linux 的 Control+C。
 * 宿主是 macOS 时，页面收到的是 ⌘C，但不能把 Super_L 发给 X11；
 * Super_L+C 不会触发大多数 Linux 应用的复制动作。
 */
export function copyShortcutEvents() {
  // 必须是一条原子事件：客户端的每个 input 事件各自走一趟 WS + broker 往返，
  // 拆成 down/up 四条时云端是并发处理、xdotool 各自独立结束，顺序不受保证——
  // 轻则 c 没带 Ctrl（复制不生效），重则 c↑ 先于 c↓ 执行（c 永远按着，X11 自动重复）。
  // 云端 pressKey 的 tap 特别处理 Ctrl+c：keydown Control_L c / keyup c Control_L，
  // 各自一次 xdotool 调用，顺序由进程本身保证。
  return Object.freeze([Object.freeze({ type: 'key', action: 'tap', key: 'ctrl+c' })]);
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
  // Host 侧的本机剪贴板错误码：不映射就只能显示「暂时不可用」，会把 64 KiB 超限说成临时故障。
  if (code === 'PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE') return '剪贴板内容超过 64 KiB，无法同步到本机';
  if (code === 'PERSONAL_ASSISTANT_CLIPBOARD_UNAVAILABLE') return '本机剪贴板暂时不可用，请稍后重试或手动复制';
  if (code === 'CLIPBOARD_TIMEOUT') return '云端助理版本较旧，剪贴板通道未启用（重新部署后可用）';
  if (code === 'CLIPBOARD_UNAVAILABLE') return '云电脑尚未连接，剪贴板暂不可用';
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
 *
 * 传了 readCloud 时，写完会回读一次做**字节级对账**：云端旧版本的桌面 agentd 把剪贴板
 * 字节硬按 UTF-8 解码（GBK/latin1 都解坏），写进去的中文读回来已经不是原文。这时继续按
 * Ctrl+V 只会把乱码贴进应用，所以宁可停在提示上，也不要让用户以为粘贴成功。
 */
export async function pasteToCloud({ readLocal, writeCloud, readCloud, sendKeys, ensureControl, notify = () => {}, echoGuard = defaultEchoGuard, verifyDelayMs = 80, sleep = defaultSleep } = {}) {
  const read = readLocal || (() => readLocalClipboard());
  let text = '';
  try { text = await read(); }
  catch (error) { notify(clipboardFriendlyError(error) || '浏览器不允许读取剪贴板，请按 ⌘V / Ctrl+V 再试'); return { ok: false, code: error?.code || 'CLIPBOARD_READ_FAILED' }; }
  // 本机剪贴板里的中文如果已经被转成乱码，先还原再写进云端，避免把坏内容运过去。
  text = repairClipboardText(text);
  if (!text) { notify('本地剪贴板是空的，没有可粘贴的内容'); return { ok: false, code: 'CLIPBOARD_EMPTY' }; }
  if (byteLength(text) > MAX_CLIPBOARD_BYTES) { notify('剪贴板内容超过 64 KiB，云电脑剪贴板放不下'); return { ok: false, code: 'CLIPBOARD_TOO_LARGE' }; }
  if (typeof ensureControl === 'function') {
    try {
      if (!await ensureControl()) { notify('需要先接管云电脑，才能粘贴到云电脑'); return { ok: false, code: 'CLIPBOARD_CONTROL_REQUIRED' }; }
    } catch (error) {
      notify(clipboardFriendlyError(error) || '接管云电脑失败，请重试');
      return { ok: false, code: error?.code || 'CLIPBOARD_CONTROL_REQUIRED' };
    }
  }
  try { await writeCloud(text); }
  catch (error) { notify(clipboardFriendlyError(error) || '写入云电脑剪贴板失败，请重试'); return { ok: false, code: 'CLIPBOARD_WRITE_FAILED' }; }
  echoGuard.remember(text);
  if (typeof readCloud === 'function') {
    const mismatch = await clipboardRoundTripMismatch({ readCloud, text, verifyDelayMs, sleep });
    if (mismatch) {
      notify('云端把剪贴板内容转坏了（读回来与写入不一致），已取消粘贴；升级云电脑镜像前请改用文件或对话传输');
      return { ok: false, code: 'CLIPBOARD_ROUNDTRIP_MISMATCH', expected: text, actual: mismatch };
    }
  }
  if (typeof sendKeys === 'function') {
    let sent = false;
    try { sent = sendKeys(pasteShortcutEvents()) !== false; }
    // 内容已经写进云端剪贴板，但按键没发出去：必须提示用户手动粘贴，不能假装成功。
    catch (error) { notify('文字已写入云电脑剪贴板，但没能自动按 Ctrl+V，请手动在云桌面粘贴'); return { ok: true, code: 'CLIPBOARD_KEY_FAILED', error }; }
    // 只读旁观时输入通道拒发按键：内容已到云端剪贴板，但要明确告诉用户还差接管这一步。
    if (!sent) { notify('已写入云电脑剪贴板，但当前没有控制权；接管云电脑后再按 Ctrl+V'); return { ok: true, code: 'CLIPBOARD_KEY_NOT_SENT' }; }
  }
  notify('已粘贴到云电脑');
  return { ok: true };
}

/** 复制：云电脑剪贴板 → 本地剪贴板。
 * 传了 previousText（复制前云端剪贴板的内容）时会轮询到内容变化为止：
 * 否则「应用没响应复制」会被误判成「复制成功」，把旧内容写回本机剪贴板。 */
export async function copyCloudClipboard({ readCloud, writeLocal, notify = () => {}, echoGuard = defaultEchoGuard, previousText = undefined, pollDelays = COPY_POLL_DELAYS_MS, sleep = defaultSleep } = {}) {
  const write = writeLocal || (text => writeLocalClipboard(text));
  const hasPrevious = typeof previousText === 'string';
  let value;
  let text = '';
  let failure = null;
  // 第一次立即读；只有已知基线时才值得等应用把 selection 换掉。
  const delays = hasPrevious ? [0, ...pollDelays] : [0];
  for (const delay of delays) {
    if (delay) await sleep(delay);
    try { value = await readCloud(); failure = null; }
    // 保留**首个**失败：轮询到后面可能换成「控制权变更」等次生错误，那不是用户该看到的原因。
    catch (error) { if (!failure) failure = error; continue; }
    // 乱码自愈：云端字节可能在某一段被按单字节编码解码过，还原后再写回本机。
    text = repairClipboardText(clipboardTextOf(value));
    if (hasPrevious && text === repairClipboardText(previousText)) continue;
    break;
  }
  if (failure) {
    notify(clipboardFriendlyError(failure) || '读取云电脑剪贴板失败，请重试');
    // 对外保持稳定的业务码：具体原因已经在提示文案里，调用方只需要知道「读失败了」。
    return { ok: false, code: 'CLIPBOARD_READ_FAILED' };
  }
  if (!text) { notify('云电脑剪贴板是空的，没有可复制的内容'); return { ok: false, code: 'CLIPBOARD_EMPTY' }; }
  // 轮询到超时还是复制前那一段：应用没有响应这次复制，别把旧内容当成本次的结果。
  if (hasPrevious && text === previousText) {
    notify('云桌面没有响应这次复制，请先在云桌面里选中内容，再按 ⌘C');
    return { ok: false, code: 'CLIPBOARD_NOT_COPIED', text };
  }
  // 读回的是刚粘贴进去的内容：应用没有真正复制，别用回声覆盖本机剪贴板。
  if (echoGuard.isEcho(text)) { notify('云电脑剪贴板里还是本机刚粘贴的内容，没有可复制的新内容'); return { ok: true, echoed: true, text }; }
  const truncated = byteLength(text) > MAX_CLIPBOARD_BYTES;
  const outgoing = truncated ? truncateUtf8(text) : text;
  try { await write(outgoing); }
  catch (error) { notify(clipboardFriendlyError(error) || '浏览器不允许写入剪贴板，请重试'); return { ok: false, code: 'CLIPBOARD_WRITE_FAILED' }; }
  // 云端读侧也会截断到 64 KiB；这里显式告诉用户「只复制了前 64 KiB」，不静默丢内容。
  notify(truncated ? '云端剪贴板内容超过 64 KiB，已复制前 64 KiB' : '已复制到本地');
  return truncated ? { ok: true, text: outgoing, truncated: true } : { ok: true, text: outgoing };
}
