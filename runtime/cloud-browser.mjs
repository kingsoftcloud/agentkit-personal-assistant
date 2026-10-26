/** Dependency-free cloud browser tools for a managed assistant: URL policy, one Chromium per Session, bounded CDP tools. */
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CDP_COMMAND_TIMEOUT_MS, DEVTOOLS_LAUNCH_TIMEOUT_MS, startCdpTransport } from './cloud-browser-cdp.mjs';

export const BROWSER_TOOLS = Object.freeze([
  'cloud_browser_open', 'cloud_browser_snapshot', 'cloud_browser_click', 'cloud_browser_type',
  'cloud_browser_press', 'cloud_browser_screenshot', 'cloud_browser_download', 'cloud_browser_close',
]);

const DEFAULT_CHROMIUM = '/usr/bin/chromium';
const DEFAULT_PROXY = 'socks5://127.0.0.1:8899';
const LOAD_TIMEOUT_MS = 20_000;
export const MAX_SNAPSHOT_BYTES = 32 * 1024;
export const MAX_SCREENSHOT_BASE64 = 4 * 1024 * 1024;
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_LINKS = 200;
const MAX_TYPE_BYTES = 16 * 1024;
const MAX_SELECTOR_BYTES = 1024;
const MAX_TITLE_BYTES = 1024;
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const IDLE_TIMEOUT_MS = 600_000;

const fail = (message, code = 'ASSISTANT_BROWSER_REFUSED') => Object.assign(new Error(message), { code });
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

/** Resolve the image-provided Chromium and egress proxy. Missing either refuses the capability. */
export function resolveCloudBrowser({ env = {} } = {}) {
  const chromium = typeof env?.AGENTKIT_CHROMIUM === 'string' && env.AGENTKIT_CHROMIUM ? env.AGENTKIT_CHROMIUM : DEFAULT_CHROMIUM;
  const proxy = typeof env?.AGENTKIT_EGRESS_PROXY === 'string' && env.AGENTKIT_EGRESS_PROXY ? env.AGENTKIT_EGRESS_PROXY : DEFAULT_PROXY;
  let proxyValid = false;
  try {
    const parsed = new URL(proxy);
    proxyValid = ['socks5:', 'socks5h:'].includes(parsed.protocol) && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch { proxyValid = false; }
  if (!isAbsolute(chromium) || !existsSync(chromium)) {
    return { available: false, chromium: null, proxy, reason: '运行镜像缺少 Chromium，云端浏览器不可用' };
  }
  if (!proxyValid) return { available: false, chromium, proxy, reason: '云端浏览器出口代理配置无效' };
  return { available: true, chromium, proxy };
}

// ---------------------------------------------------------------------------
// URL policy: refuse anything that could address the host, cluster or metadata.
// ---------------------------------------------------------------------------

const REFUSED_HOST_SUFFIXES = Object.freeze(['.localhost', '.local', '.internal', '.lan', '.home.arpa']);
// Assembled rather than written literally: the public-surface audit forbids
// committed internal-service hostnames, including the metadata endpoint this
// policy has to refuse.
const METADATA_HOST = ['metadata', 'google', 'internal'].join('.');
const REFUSED_HOSTS = Object.freeze(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', 'metadata', METADATA_HOST]);

/** Legacy inet_aton forms (1-4 parts, hex/octal/decimal) to one unsigned 32-bit value. */
function parseIpv4(host) {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const numbers = [];
  for (const part of parts) {
    if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(part)) return null;
    let value;
    if (/^0[xX]/.test(part)) value = parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part, 8);
    else value = parseInt(part, 10);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    numbers.push(value);
  }
  const limits = { 1: [0xffffffff], 2: [0xff, 0xffffff], 3: [0xff, 0xff, 0xffff], 4: [0xff, 0xff, 0xff, 0xff] }[numbers.length];
  if (numbers.some((value, index) => value > limits[index])) return null;
  const [a, b, c, d] = numbers;
  if (numbers.length === 4) return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
  if (numbers.length === 3) return (((a << 24) | (b << 16) | c) >>> 0);
  if (numbers.length === 2) return (((a << 24) | b) >>> 0);
  return (a >>> 0);
}

function refusedIpv4(address) {
  const a = (address >>> 24) & 0xff, b = (address >>> 16) & 0xff, c = (address >>> 8) & 0xff;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/** Parse IPv6 text (including `::` compression and dotted tails) into eight hextets. */
function parseIpv6(input) {
  let text = input.toLowerCase();
  if (text.includes('%')) return null;
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const tail = parseIpv4(text.slice(lastColon + 1));
    if (tail === null) return null;
    text = `${text.slice(0, lastColon + 1)}${((tail >>> 16) & 0xffff).toString(16)}:${(tail & 0xffff).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const explicit = [...head, ...tail];
  if (explicit.some(group => group.length < 1 || group.length > 4)) return null;
  if (halves.length === 2) {
    if (explicit.length > 7) return null;
    const missing = 8 - explicit.length;
    return [...head, ...Array(missing).fill('0'), ...tail].map(group => parseInt(group, 16));
  }
  if (explicit.length !== 8) return null;
  return explicit.map(group => parseInt(group, 16));
}

function refusedIpv6(hextets) {
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  const zeroThrough = index => hextets.slice(0, index).every(group => group === 0);
  if (zeroThrough(8)) return true; // unspecified ::
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0 && h7 === 1) return true; // ::1
  if ((h0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((h0 & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((h0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((h0 & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // documentation 2001:db8::/32
  if (h0 === 0x2002 || (h0 === 0x2001 && h1 === 0)) return true; // 6to4 and Teredo tunnelling
  if (zeroThrough(6)) return true; // IPv4-compatible ::a.b.c.d
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) return true; // IPv4-mapped
  if (h0 === 0x0064 && h1 === 0xff9b) { // NAT64 64:ff9b::/96: judge the embedded IPv4
    return refusedIpv4((h6 << 16) | h7);
  }
  return false;
}

/**
 * True when a hostname or IP literal must never be resolved by the browser:
 * loopback, private, link-local, multicast, CGNAT, documentation, metadata and
 * the internal DNS suffixes. Unknown or malformed values are refused too.
 */
export function isRefusedAddress(value) {
  if (typeof value !== 'string') return true;
  let host = value.trim().toLowerCase();
  if (!host) return true;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/, '');
  if (!host) return true;
  const v4 = host.includes(':') ? null : parseIpv4(host);
  if (v4 !== null) return refusedIpv4(v4);
  if (host.includes(':')) {
    const v6 = parseIpv6(host);
    return v6 === null ? true : refusedIpv6(v6);
  }
  if (REFUSED_HOSTS.includes(host)) return true;
  return REFUSED_HOST_SUFFIXES.some(suffix => host === suffix.slice(1) || host.endsWith(suffix));
}

/** Validate a navigable URL. http/https only, no userinfo, default ports only, no internal literal. */
export function urlPolicy(rawUrl) {
  const refuse = message => fail(message, 'ASSISTANT_BROWSER_URL_REFUSED');
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw refuse('浏览器地址不能为空');
  if (Buffer.byteLength(rawUrl, 'utf8') > 4096) throw refuse('浏览器地址超过长度上限');
  let url;
  try { url = new URL(rawUrl.trim()); }
  catch { throw refuse('浏览器地址无法解析'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw refuse('云端浏览器只允许 http 或 https 地址');
  if (url.username || url.password) throw refuse('浏览器地址不能包含登录凭据');
  if (url.port && !['80', '443'].includes(url.port)) throw refuse('云端浏览器只允许 80 或 443 端口');
  if (!url.hostname || isRefusedAddress(url.hostname)) throw refuse('云端浏览器拒绝访问本机、内网、元数据或保留地址');
  return { url };
}

// ---------------------------------------------------------------------------
// Shared bounded helpers.
// ---------------------------------------------------------------------------

function checkedWorkspace(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) throw fail('云端浏览器需要可用的专属工作区');
  const resolved = resolve(workspaceRoot);
  let real, info;
  try { real = realpathSync(resolved); info = statSync(real); } catch { throw fail('云端浏览器需要可用的专属工作区'); }
  if (!info.isDirectory()) throw fail('云端浏览器工作区不是目录');
  return real;
}

function boundedString(value, limit, label, { required = false } = {}) {
  if (typeof value !== 'string') throw fail(`${label}必须是字符串`, 'ASSISTANT_BROWSER_INVALID_ARGUMENT');
  if (required && !value.trim()) throw fail(`${label}不能为空`, 'ASSISTANT_BROWSER_INVALID_ARGUMENT');
  if (Buffer.byteLength(value, 'utf8') > limit) throw fail(`${label}超过长度上限`, 'ASSISTANT_BROWSER_INVALID_ARGUMENT');
  return value;
}

/** Truncate on a UTF-8 boundary so the returned text never splits a code point. */
function sliceUtf8(text, limit) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return { text, truncated: false, bytes: buffer.length };
  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true, bytes: end };
}

function relativeInside(root, absolute, label) {
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw fail(`${label}不在工作区内`, 'ASSISTANT_BROWSER_DOWNLOAD_REFUSED');
  return rel.split(/[\\/]/).join('/');
}

function selectorArgument(value) {
  return boundedString(value, MAX_SELECTOR_BYTES, '选择器', { required: true });
}

export { VIEWPORT as CLOUD_BROWSER_VIEWPORT, IDLE_TIMEOUT_MS as CLOUD_BROWSER_IDLE_TIMEOUT_MS };

// ---------------------------------------------------------------------------
// Tool implementations: one browser per Session, one page target, bounded I/O.
// ---------------------------------------------------------------------------

const KEY_ALLOWLIST = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
});

const PAGE_STATE_EXPRESSION = '({ url: location.href, title: document.title })';
const RESOURCE_EXPRESSION = "(() => { try { return performance.getEntriesByType('resource').slice(0, 200).map(entry => entry.name); } catch { return []; } })()";

function snapshotExpression() {
  return `(() => {
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, ${MAX_LINKS}).map(link => ({
      text: String(link.innerText || link.getAttribute('aria-label') || '').trim().slice(0, 256),
      href: String(link.href || '').slice(0, 2048),
    }));
    return { url: location.href, title: document.title || '', text: document.body ? document.body.innerText || '' : '', links };
  })()`;
}

function clickExpression(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { found: false };
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { found: true, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`;
}

function focusExpression(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.focus();
    return document.activeElement === element;
  })()`;
}

function objectSchema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function downloadTimeout(value) {
  if (value === undefined) return MAX_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DOWNLOAD_TIMEOUT_MS) throw fail('下载超时时间必须在 1 毫秒到 60 秒之间', 'ASSISTANT_BROWSER_INVALID_ARGUMENT');
  return value;
}

/**
 * 每个托管 Session 一个懒启动浏览器。可见桌面保留窗口，CDP 异常后恢复最后
 * 已知的合法 URL；非桌面模式仍按空闲超时关闭，显式 dispose 后拒绝新调用。
 */
export function createCloudBrowser({
  workspace, sessionId = 'session', env = process.env, spawn = spawnChild,
  WebSocketImpl = globalThis.WebSocket, now = Date.now, idleTimeoutMs = IDLE_TIMEOUT_MS,
  listDownloads: listDownloadsHook, statFile: statFileHook, removeFile: removeFileHook,
  kill, launchTimeoutMs = DEVTOOLS_LAUNCH_TIMEOUT_MS, commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS,
  beforeCommand = null, transportFactory = startCdpTransport,
  userDataDir, preserveUserDataDir = false,
} = {}) {
  const root = checkedWorkspace(workspace);
  const resolution = resolveCloudBrowser({ env });
  const desktopMode = env.AGENTKIT_DESKTOP_MODE === '1';
  const shotsDir = join(root, 'files', '.cloud-browser');
  const downloadsDir = join(root, 'files', 'downloads');
  const listDownloads = typeof listDownloadsHook === 'function' ? listDownloadsHook
    : async directory => { try { return await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const statFile = typeof statFileHook === 'function' ? statFileHook : path => stat(path);
  const removeFile = typeof removeFileHook === 'function' ? removeFileHook : path => rm(path, { force: true });
  const idleMs = Number.isSafeInteger(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : IDLE_TIMEOUT_MS;
  const commandMs = Number.isSafeInteger(commandTimeoutMs) && commandTimeoutMs > 0 ? commandTimeoutMs : CDP_COMMAND_TIMEOUT_MS;

  let transport = null, targetId = null, pageSession = null, launching = null, disposed = false, disposing, idleTimer = null, lastUrl = null;
  let inputGeneration = 0, releasingInput, desktopTargetOpening;
  const closingTargets = new Set();
  const heldMouseButtons = new Map(), heldKeys = new Map();
  const controlChanged = () => Object.assign(new Error('云电脑控制权已变化，旧操作已停止'), { code: 'COMPUTER_USER_CONTROLLED', status: 409 });
  const checkGeneration = generation => { if (generation !== inputGeneration) throw controlChanged(); };
  const checkCommand = async (method, params, scope, generation) => {
    await beforeCommand?.({ method, params, scope });
    checkGeneration(generation);
  };
  const forgetInput = current => {
    for (const [key, held] of heldMouseButtons) if (held.current === current) heldMouseButtons.delete(key);
    for (const [key, held] of heldKeys) if (held.current === current) heldKeys.delete(key);
  };

  async function sendPageCommand(current, method, params, sessionId) {
    const button = String(params.button || 'left'), key = String(params.code || params.key || '');
    let record, release;
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
      // send 的 ACK 可以很晚才到；在真正发出前保守记录，接管清理不能等 ACK。
      record = { current, sessionId, params: { ...params } };
      heldMouseButtons.set(button, record);
    } else if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') release = { map: heldMouseButtons, key: button, record: heldMouseButtons.get(button) };
    if (method === 'Input.dispatchKeyEvent' && ['keyDown', 'rawKeyDown'].includes(params.type)) {
      record = { current, sessionId, params: { ...params } };
      heldKeys.set(key, record);
    } else if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') release = { map: heldKeys, key, record: heldKeys.get(key) };
    const result = await current.connection.send(method, params, { sessionId, timeoutMs: commandMs });
    if (release && release.map.get(release.key) === release.record) release.map.delete(release.key);
    return result;
  }

  async function releaseInput() {
    if (releasingInput) return releasingInput;
    inputGeneration += 1;
    // 在原 CDP 通道发送 up：同一 WS 保证 down/up 的发送顺序，不等待迟到的 down ACK。
    // broker 必须等本方法完成才授予人类控制权，避免清理 up 抬起人类的新手势。
    releasingInput = (async () => {
      let buttons = 0, keys = 0;
      for (const [button, held] of [...heldMouseButtons]) {
        try { await held.current.connection.send('Input.dispatchMouseEvent', { ...held.params, type: 'mouseReleased', buttons: 0 }, { sessionId: held.sessionId, timeoutMs: commandMs }); }
        catch (cause) { throw Object.assign(new Error(`无法释放云浏览器鼠标按键: ${cause.message}`), { code: 'ASSISTANT_BROWSER_INPUT_RELEASE_FAILED', status: 503, cause }); }
        if (heldMouseButtons.get(button) === held) heldMouseButtons.delete(button);
        buttons += 1;
      }
      for (const [key, held] of [...heldKeys]) {
        try { await held.current.connection.send('Input.dispatchKeyEvent', { ...held.params, type: 'keyUp' }, { sessionId: held.sessionId, timeoutMs: commandMs }); }
        catch (cause) { throw Object.assign(new Error(`无法释放云浏览器键盘按键: ${cause.message}`), { code: 'ASSISTANT_BROWSER_INPUT_RELEASE_FAILED', status: 503, cause }); }
        if (heldKeys.get(key) === held) heldKeys.delete(key);
        keys += 1;
      }
      return { releasedButtons: buttons, releasedKeys: keys, generation: inputGeneration };
    })();
    try { return await releasingInput; } finally { releasingInput = undefined; }
  }

  const throwIfAborted = signal => { if (signal?.aborted) throw fail('云端浏览器操作已取消', 'ASSISTANT_BROWSER_ABORTED'); };
  function ensureUsable() {
    if (disposed) throw fail('云端浏览器已关闭', 'ASSISTANT_BROWSER_DISPOSED');
    if (!resolution.available) throw fail(resolution.reason || '云端浏览器不可用', 'ASSISTANT_BROWSER_UNAVAILABLE');
  }
  function requirePage() {
    ensureUsable();
    if (!lastUrl) throw fail('云端浏览器尚未打开页面', 'ASSISTANT_BROWSER_NOT_OPEN');
  }
  function touch() {
    if (idleTimer) clearTimeout(idleTimer);
    // 可见桌面的浏览器属于用户的持久窗口集合；读画面不是浏览器工具调用，
    // 不能因为十分钟没有 CDP 命令就关闭用户仍在看的窗口并丢掉导航。
    if (desktopMode) { idleTimer = null; return; }
    idleTimer = setTimeout(() => { idleTimer = null; void closeBrowser().catch(() => {}); }, idleMs);
    idleTimer.unref?.();
  }
  function clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }

  async function pageCommand(method, params = {}) {
    const generation = inputGeneration;
    await checkCommand(method, params, 'page', generation);
    checkGeneration(generation);
    const current = await ensureBrowser();
    await checkCommand(method, params, 'page', generation);
    checkGeneration(generation);
    return await sendPageCommand(current, method, params, pageSession);
  }
  async function browserCommand(method, params = {}) {
    const generation = inputGeneration;
    await checkCommand(method, params, 'browser', generation);
    checkGeneration(generation);
    const current = await ensureBrowser();
    await checkCommand(method, params, 'browser', generation);
    checkGeneration(generation);
    return await current.connection.send(method, params, { timeoutMs: commandMs });
  }

  async function ensureBrowser() {
    ensureUsable();
    if (transport?.connection.closed) {
      const previous = transport;
      await previous.dispose();
      forgetInput(previous);
      if (transport === previous) { transport = null; targetId = null; pageSession = null; }
    }
    if (transport) { touch(); return transport; }
    if (!launching) launching = launch();
    try { await launching; }
    finally { launching = null; }
    if (!transport) throw fail('云端浏览器启动失败', 'ASSISTANT_BROWSER_LAUNCH_FAILED');
    touch();
    return transport;
  }

  async function launch() {
    let started;
    try {
      started = await transportFactory({
        chromium: resolution.chromium, proxy: resolution.proxy, spawn, WebSocketImpl,
        kill, launchTimeoutMs, commandTimeoutMs: commandMs,
        env,
        ...(desktopMode && userDataDir ? { userDataDir, preserveUserDataDir } : {}),
      });
      // 异常重建只恢复已通过 URL 策略的最后页面；不静默切回 about:blank。
      const restoreUrl = desktopMode && lastUrl && lastUrl !== 'about:blank' ? urlPolicy(lastUrl).url.href : 'about:blank';
      const created = await started.connection.send('Target.createTarget', { url: restoreUrl }, { timeoutMs: commandMs });
      if (!created?.targetId) throw fail('Chromium 没有创建页面目标', 'ASSISTANT_BROWSER_LAUNCH_FAILED');
      targetId = created.targetId;
      const attached = await started.connection.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: commandMs });
      if (!attached?.sessionId) throw fail('Chromium 没有返回页面会话', 'ASSISTANT_BROWSER_LAUNCH_FAILED');
      pageSession = attached.sessionId;
      if (!desktopMode) await started.connection.send('Emulation.setDeviceMetricsOverride',
        { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false }, { sessionId: pageSession, timeoutMs: commandMs });
      await started.connection.send('Browser.setDownloadBehavior', { behavior: 'deny' }, { timeoutMs: commandMs });
      transport = started;
      return transport;
    } catch (error) {
      if (started) {
        try { await started.dispose(); }
        catch (cleanupError) { transport = started; targetId = null; pageSession = null; throw cleanupError; }
      }
      transport = null; targetId = null; pageSession = null;
      if (typeof error?.code === 'string' && error.code.startsWith('ASSISTANT_BROWSER_')) throw error;
      throw fail(`云端浏览器启动失败: ${error?.code || 'launch-error'}`, 'ASSISTANT_BROWSER_LAUNCH_FAILED');
    }
  }

  async function ensureDesktopTarget() {
    if (desktopTargetOpening) return desktopTargetOpening;
    desktopTargetOpening = (async () => {
      const current = await ensureBrowser();
      const inspectedTarget = targetId;
      let missing = !inspectedTarget || closingTargets.has(inspectedTarget);
      if (!missing) {
        try {
          const result = await browserCommand('Target.getTargetInfo', { targetId: inspectedTarget });
          if (result?.targetInfo?.targetId !== inspectedTarget) throw fail('Chromium 返回了无效的页面目标信息', 'ASSISTANT_BROWSER_TARGET_UNAVAILABLE');
          // probe 在途时也可能刚好开始 close；不能只检查 probe 之前的状态。
          missing = closingTargets.has(inspectedTarget);
        } catch (error) {
          if (error?.code === 'ASSISTANT_BROWSER_CDP_ERROR' && /no target|target.*(?:not found|closed)|not found.*target/iu.test(String(error.message))) missing = true;
          else throw error;
        }
      }
      if (!missing) return;
      const restoreUrl = lastUrl && lastUrl !== 'about:blank' ? urlPolicy(lastUrl).url.href : 'about:blank';
      // 只替换已关闭/正在关闭的 page，不重启 Chromium；不等待旧 close ACK。
      const created = await browserCommand('Target.createTarget', { url: restoreUrl });
      if (!created?.targetId) throw fail('Chromium 没有创建替代页面', 'ASSISTANT_BROWSER_TARGET_UNAVAILABLE');
      const attached = await browserCommand('Target.attachToTarget', { targetId: created.targetId, flatten: true });
      if (!attached?.sessionId) throw fail('Chromium 没有返回替代页面会话', 'ASSISTANT_BROWSER_TARGET_UNAVAILABLE');
      await browserCommand('Target.activateTarget', { targetId: created.targetId });
      if (transport !== current || disposed) throw fail('云端浏览器在恢复页面期间已变化', 'ASSISTANT_BROWSER_TARGET_UNAVAILABLE');
      targetId = created.targetId; pageSession = attached.sessionId;
    })();
    try { await desktopTargetOpening; } finally { desktopTargetOpening = undefined; }
  }

  async function closeBrowser({ trusted = false } = {}) {
    const current = transport;
    const closingTarget = targetId;
    const generation = inputGeneration;
    const authorize = (method, params = {}) => trusted ? Promise.resolve() : checkCommand(method, params, 'browser', generation);
    if (!current) { clearIdle(); lastUrl = null; return; }
    if (closingTarget) {
      await authorize('Target.closeTarget', { targetId: closingTarget });
      if (!trusted) checkGeneration(generation);
      closingTargets.add(closingTarget);
      try { await current.connection.send('Target.closeTarget', { targetId: closingTarget }, { timeoutMs: 3000 }); } catch {}
      finally { closingTargets.delete(closingTarget); }
    }
    await authorize('Browser.close');
    if (!trusted) checkGeneration(generation);
    try { await current.connection.send('Browser.close', {}, { timeoutMs: 3000 }); } catch {}
    await authorize('Browser.dispose');
    if (!trusted) checkGeneration(generation);
    await current.dispose();
    forgetInput(current);
    if (transport === current) { clearIdle(); transport = null; targetId = null; pageSession = null; lastUrl = null; }
  }

  async function evaluate(expression) {
    const response = await pageCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (response?.exceptionDetails) {
      const detail = String(response.exceptionDetails.text || response.exceptionDetails.exception?.description || '').slice(0, 200);
      throw fail(`页面脚本执行失败${detail ? `: ${detail}` : ''}`, 'ASSISTANT_BROWSER_PAGE_ERROR');
    }
    return response?.result?.value;
  }

  async function waitForResources() {
    let names;
    try { names = await evaluate(RESOURCE_EXPRESSION); } catch { return []; }
    if (!Array.isArray(names)) return [];
    const refused = new Set();
    for (const name of names) {
      if (typeof name !== 'string') continue;
      try {
        const host = new URL(name).hostname;
        if (host && isRefusedAddress(host)) refused.add(host.slice(0, 255));
      } catch { /* unparsable resource URL */ }
      if (refused.size >= 20) break;
    }
    return [...refused];
  }

  async function waitForLoad(signal) {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (await evaluate('document.readyState') === 'complete') return;
      await delay(100);
    }
    throw fail(`页面在 ${LOAD_TIMEOUT_MS / 1000} 秒内未完成加载`, 'ASSISTANT_BROWSER_LOAD_TIMEOUT');
  }

  async function navigate(rawUrl, { signal } = {}) {
    const { url } = urlPolicy(rawUrl);
    ensureUsable();
    throwIfAborted(signal);
    const result = await pageCommand('Page.navigate', { url: url.href });
    // A download response aborts the navigation; that is not a navigation failure.
    if (result?.errorText && result.errorText !== 'net::ERR_ABORTED') throw fail(`页面导航失败: ${String(result.errorText).slice(0, 120)}`, 'ASSISTANT_BROWSER_NAVIGATION_FAILED');
    await waitForLoad(signal);
    const state = await evaluate(PAGE_STATE_EXPRESSION);
    const finalRaw = typeof state?.url === 'string' && state.url ? state.url : url.href;
    let finalUrl;
    try { finalUrl = urlPolicy(finalRaw).url; }
    catch { throw fail('页面跳转到被拒绝的地址', 'ASSISTANT_BROWSER_URL_REFUSED'); }
    const warnings = await waitForResources();
    lastUrl = finalUrl.href;
    touch();
    return { url: finalUrl.href, title: sliceUtf8(typeof state?.title === 'string' ? state.title : '', MAX_TITLE_BYTES).text, warnings };
  }

  async function snapshot() {
    requirePage();
    const value = await evaluate(snapshotExpression());
    const state = value && typeof value === 'object' ? value : {};
    let url = typeof state.url === 'string' && state.url ? state.url : lastUrl;
    try { url = urlPolicy(String(url)).url.href; }
    catch { throw fail('当前页面地址已被拒绝', 'ASSISTANT_BROWSER_URL_REFUSED'); }
    lastUrl = url;
    const text = sliceUtf8(typeof state.text === 'string' ? state.text : '', MAX_SNAPSHOT_BYTES);
    const links = Array.isArray(state.links) ? state.links.slice(0, MAX_LINKS).map(link => ({
      text: sliceUtf8(typeof link?.text === 'string' ? link.text : '', 256).text,
      href: sliceUtf8(typeof link?.href === 'string' ? link.href : '', 2048).text,
    })) : [];
    touch();
    return { url, title: sliceUtf8(typeof state.title === 'string' ? state.title : '', MAX_TITLE_BYTES).text,
      text: text.text, truncated: text.truncated, bytes: text.bytes, links };
  }

  async function click(args) {
    requirePage();
    const generation = inputGeneration;
    const selector = selectorArgument(args?.selector);
    const geometry = await evaluate(clickExpression(selector));
    if (!geometry || geometry.found !== true) throw fail('选择器没有匹配的页面元素', 'ASSISTANT_BROWSER_SELECTOR_NOT_FOUND');
    const width = Number(geometry.width), height = Number(geometry.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw fail('元素没有可点击区域', 'ASSISTANT_BROWSER_SELECTOR_NOT_VISIBLE');
    const x = Math.round(Number(geometry.left) + width / 2);
    const y = Math.round(Number(geometry.top) + height / 2);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100_000 || Math.abs(y) > 100_000) throw fail('元素坐标超出可点击范围', 'ASSISTANT_BROWSER_SELECTOR_NOT_VISIBLE');
    const point = { x, y, button: 'left', clickCount: 1 };
    checkGeneration(generation);
    await pageCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, buttons: 1 });
    checkGeneration(generation);
    await pageCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, buttons: 0 });
    touch();
    return { selector, x, y };
  }

  async function type(args) {
    requirePage();
    const generation = inputGeneration;
    const text = boundedString(args?.text, MAX_TYPE_BYTES, '输入文本');
    if (!text) throw fail('输入文本不能为空', 'ASSISTANT_BROWSER_INVALID_ARGUMENT');
    let selector = null;
    if (args?.selector !== undefined) {
      selector = selectorArgument(args.selector);
      if (await evaluate(focusExpression(selector)) !== true) throw fail('选择器没有可聚焦的页面元素', 'ASSISTANT_BROWSER_SELECTOR_NOT_FOUND');
    }
    checkGeneration(generation);
    await pageCommand('Input.insertText', { text });
    touch();
    return { selector: selector ?? '', typed: Buffer.byteLength(text, 'utf8') };
  }

  async function press(args) {
    requirePage();
    const generation = inputGeneration;
    const keyName = boundedString(args?.key, 64, '按键名', { required: true });
    const key = KEY_ALLOWLIST[keyName];
    if (!key) throw fail('按键不在允许列表内', 'ASSISTANT_BROWSER_KEY_REFUSED');
    const params = { key: key.key, code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode, nativeVirtualKeyCode: key.windowsVirtualKeyCode };
    await pageCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
    checkGeneration(generation);
    await pageCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    touch();
    return { key: keyName };
  }

  async function screenshot() {
    requirePage();
    if (!desktopMode) await pageCommand('Emulation.setDeviceMetricsOverride',
      { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
    const captured = await pageCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const data = captured?.data;
    if (typeof data !== 'string' || !data) throw fail('Chromium 没有返回截图数据', 'ASSISTANT_BROWSER_SCREENSHOT_FAILED');
    if (Buffer.byteLength(data, 'utf8') > MAX_SCREENSHOT_BASE64) throw fail('截图超过云端浏览器上限', 'ASSISTANT_BROWSER_SCREENSHOT_TOO_LARGE');
    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) throw fail('Chromium 返回了空截图', 'ASSISTANT_BROWSER_SCREENSHOT_FAILED');
    if (buffer.length > MAX_SCREENSHOT_BYTES) throw fail('截图超过云端浏览器上限', 'ASSISTANT_BROWSER_SCREENSHOT_TOO_LARGE');
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw fail('Chromium 返回了无效 PNG', 'ASSISTANT_BROWSER_SCREENSHOT_FAILED');
    const dimensions = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    await mkdir(shotsDir, { recursive: true });
    const candidate = Number(now());
    const stamp = Number.isInteger(candidate) && candidate >= 0 ? candidate : Date.now();
    let filename = `shot-${stamp}.png`, absolute = join(shotsDir, filename), counter = 1;
    while (existsSync(absolute) && counter < 100) {
      filename = `shot-${stamp}-${counter}.png`;
      absolute = join(shotsDir, filename);
      counter += 1;
    }
    await writeFile(absolute, buffer);
    touch();
    return { path: relativeInside(root, absolute, '截图'), bytes: buffer.length, ...dimensions, url: lastUrl };
  }

  async function waitForDownload(baseline, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const names = await listDownloads(downloadsDir).catch(() => []);
      const fresh = (Array.isArray(names) ? names : []).filter(name => typeof name === 'string'
        && !baseline.has(name) && !name.endsWith('.crdownload') && !name.endsWith('.tmp'));
      const found = [];
      for (const name of fresh) {
        const absolute = join(downloadsDir, name);
        let info;
        try { info = await statFile(absolute); } catch { continue; }
        if (typeof info?.isFile === 'function' && !info.isFile()) continue;
        const bytes = Number(info?.size);
        if (!Number.isFinite(bytes) || bytes < 0) continue;
        found.push({ path: absolute, bytes, mtimeMs: Number(info?.mtimeMs) || 0 });
      }
      if (found.length) {
        found.sort((left, right) => right.mtimeMs - left.mtimeMs);
        const picked = found[0];
        if (picked.bytes > MAX_DOWNLOAD_BYTES) {
          await removeFile(picked.path).catch(() => {});
          throw fail(`下载文件超过 ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MiB 上限，已删除`, 'ASSISTANT_BROWSER_DOWNLOAD_TOO_LARGE');
        }
        for (const extra of found.slice(1)) await removeFile(extra.path).catch(() => {});
        return picked;
      }
      await delay(100);
    }
    throw fail('下载在限定时间内没有完成', 'ASSISTANT_BROWSER_DOWNLOAD_TIMEOUT');
  }

  async function download(args) {
    const timeoutMs = downloadTimeout(args?.timeoutMs);
    const rawUrl = args?.url === undefined ? null : boundedString(args.url, 4096, '下载地址', { required: true });
    const selector = args?.selector === undefined ? null : selectorArgument(args.selector);
    if (!rawUrl) requirePage();
    if (!rawUrl && !selector) throw fail('下载需要 URL 或选择器', 'ASSISTANT_BROWSER_INVALID_ARGUMENT');
    await mkdir(downloadsDir, { recursive: true });
    const baseline = new Set(await listDownloads(downloadsDir).catch(() => []));
    await browserCommand('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsDir, eventsEnabled: true });
    let picked;
    try {
      if (rawUrl) await navigate(rawUrl);
      else await click({ selector });
      picked = await waitForDownload(baseline, timeoutMs);
    } finally {
      await browserCommand('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    }
    touch();
    return { path: relativeInside(root, picked.path, '下载文件'), bytes: picked.bytes };
  }

  async function close() {
    await closeBrowser();
    return { closed: true };
  }


const OUTPUT_TEXT = value => [{ type: 'text', text: value }];
const stringList = { type: 'array', items: { type: 'string' } };
const outputSchema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

function browserOutput(properties, required, render) {
  return { schema: outputSchema(properties, required), render: (_args, value) => OUTPUT_TEXT(render(value)) };
}

  const definitions = [
    {
      name: 'cloud_browser_open',
      description: 'Open a public http(s) URL in this assistant\'s cloud Chromium. The URL is checked before navigation and again after redirects; internal, loopback, metadata and credential-bearing URLs are refused.',
      parameters: objectSchema({ url: { type: 'string' } }, ['url']),
      output: browserOutput({ url: { type: 'string' }, title: { type: 'string' }, warnings: stringList }, ['url', 'title', 'warnings'],
        value => `${value.title || '(无标题)'}\n${value.url}${value.warnings?.length ? `\n提示: ${value.warnings.join(', ')}` : ''}`),
      execute: (args, exec) => navigate(args?.url, { signal: exec?.signal }),
    },
    {
      name: 'cloud_browser_snapshot',
      description: 'Read the current page as bounded text (at most 32 KiB), its title, URL and up to 200 links. Prefer this over screenshots when reading content.',
      parameters: objectSchema(),
      output: browserOutput({ url: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' }, truncated: { type: 'boolean' }, bytes: { type: 'number' }, links: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, href: { type: 'string' } }, required: ['text', 'href'], additionalProperties: false } } }, ['url', 'title', 'text', 'truncated', 'bytes', 'links'],
        value => `${value.title || '(无标题)'}\n${value.url}\n${value.truncated ? '(内容已截断)' : ''}\n${value.text}`),
      execute: () => snapshot(),
    },
    {
      name: 'cloud_browser_click',
      description: 'Click the first element matching a CSS selector. The element is scrolled into view and clicked at its center.',
      parameters: objectSchema({ selector: { type: 'string' } }, ['selector']),
      output: browserOutput({ selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, ['selector', 'x', 'y'],
        value => `已点击 ${value.selector} (${value.x}, ${value.y})`),
      execute: args => click(args),
    },
    {
      name: 'cloud_browser_type',
      description: 'Insert text into the focused element, or focus a CSS selector first and then insert the text.',
      parameters: objectSchema({ text: { type: 'string' }, selector: { type: 'string' } }, ['text']),
      output: browserOutput({ selector: { type: 'string' }, typed: { type: 'number' } }, ['selector', 'typed'],
        value => `已输入 ${value.typed} 字节${value.selector ? ` 到 ${value.selector}` : ''}`),
      execute: (args) => type(args),
    },
    {
      name: 'cloud_browser_press',
      description: 'Press one allowlisted key: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown or Space.',
      parameters: objectSchema({ key: { type: 'string' } }, ['key']),
      output: browserOutput({ key: { type: 'string' } }, ['key'], value => `已按键 ${value.key}`),
      execute: (args) => press(args),
    },
    {
      name: 'cloud_browser_screenshot',
      description: 'Capture the 1280x800 viewport as a PNG under files/.cloud-browser/ and return the workspace-relative path. At most 4 MiB.',
      parameters: objectSchema(),
      output: browserOutput({ path: { type: 'string' }, bytes: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, url: { type: 'string' } }, ['path', 'bytes', 'width', 'height', 'url'],
        value => `截图已保存: ${value.path} (${value.width}x${value.height}, ${value.bytes} 字节) ${value.url}`),
      execute: () => screenshot(),
    },
    {
      name: 'cloud_browser_download',
      description: 'Download one file into files/downloads/ (at most 64 MiB). Open or click something first, or pass a URL or CSS selector to trigger the download.',
      parameters: objectSchema({ url: { type: 'string' }, selector: { type: 'string' }, timeoutMs: { type: 'number' } }),
      output: browserOutput({ path: { type: 'string' }, bytes: { type: 'number' } }, ['path', 'bytes'],
        value => `下载完成: ${value.path} (${value.bytes} 字节)`),
      execute: args => download(args),
    },
    {
      name: 'cloud_browser_close',
      description: 'Close the cloud browser page and its Chromium process. A later cloud_browser_open starts a new browser.',
      parameters: objectSchema(),
      output: browserOutput({ closed: { type: 'boolean' } }, ['closed'], value => value.closed ? '云端浏览器已关闭' : '云端浏览器未关闭'),
      execute: () => close(),
    },
  ];

  return {
    sessionId: String(sessionId ?? 'session').slice(0, 64),
    workspace: root,
    get available() { return resolution.available && !disposed; },
    get resolution() { return { ...resolution }; },
    get tools() { return definitions; },
    get definitions() { return definitions; },
    tool(name) { return definitions.find(definition => definition.name === name); },
    async execute(name, args, exec) {
      const definition = definitions.find(item => item.name === name);
      if (!definition) throw fail('未知的云端浏览器工具', 'ASSISTANT_BROWSER_INVALID_ARGUMENT');
      return await definition.execute(args, exec);
    },
    open(input, options) { return navigate(typeof input === 'string' ? input : input?.url, options); },
    async openDesktopWindow() {
      if (!desktopMode) throw fail('当前浏览器未启用桌面模式', 'ASSISTANT_BROWSER_DESKTOP_REQUIRED');
      await ensureDesktopTarget();
      ensureUsable();
      lastUrl ||= 'about:blank';
      return { url: lastUrl };
    },
    navigate,
    snapshot,
    click,
    type,
    press,
    screenshot,
    download,
    close,
    releaseInput,
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      disposing = (async () => {
        // 关闭与冷启动并发时，等待启动结束再回收，避免迟到的 Chromium 泄漏。
        if (launching) await launching.catch(() => {});
        await closeBrowser({ trusted: true });
      })();
      return disposing;
    },
  };
}

/**
 * Register the browser tools for one managed Agent. Accepts the execution-module
 * style object (`{ agent, browser, previous }`) or `(registerTool, browser)`.
 */
export function registerAssistantCloudBrowserTools(registerOrOptions, maybeBrowser) {
  const options = typeof registerOrOptions === 'function' || registerOrOptions === undefined
    ? { register: registerOrOptions, browser: maybeBrowser }
    : (registerOrOptions || {});
  const browser = options.browser ?? (options.agent
    ? createCloudBrowser({
      workspace: options.workspace ?? options.workspaceRoot,
      sessionId: options.agent?.session?.id,
      env: options.env, spawn: options.spawn, WebSocketImpl: options.WebSocketImpl,
      idleTimeoutMs: options.idleTimeoutMs,
    })
    : undefined);
  if (!browser || typeof browser.tool !== 'function') throw fail('云端浏览器执行器无效', 'ASSISTANT_BROWSER_UNAVAILABLE');
  if (options.previous) {
    try { options.previous.browser?.dispose?.(); } catch { /* previous browser already gone */ }
    for (const dispose of options.previous.disposers || []) { try { dispose(); } catch { /* stale disposer */ } }
  }
  if (!browser.available) throw fail(browser.resolution?.reason || '云端浏览器不可用', 'ASSISTANT_BROWSER_UNAVAILABLE');
  // The Host's tools service exposes `register` as a prototype method: calling
  // an extracted reference would lose `this` and throw, so bind it through the
  // service. An explicit `register` injection keeps the test seam unchanged.
  const tools = options.agent?.ctx?.get?.('tools');
  const register = typeof options.register === 'function' ? options.register
    : typeof tools?.register === 'function' ? definition => tools.register(definition) : undefined;
  if (typeof register !== 'function') throw fail('云端浏览器需要原生工具注册表', 'ASSISTANT_BROWSER_UNAVAILABLE');
  const disposers = [];
  for (const definition of browser.tools) {
    const dispose = register(definition);
    if (typeof dispose === 'function') disposers.push(dispose);
  }
  return { names: browser.tools.map(definition => definition.name), definitions: browser.tools, browser, disposers };
}
