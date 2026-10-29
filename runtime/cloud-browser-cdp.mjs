/** Minimal Chromium DevTools Protocol transport: one browser, one WebSocket, no reconnect. */
import { spawn as spawnChild } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';
export const DEVTOOLS_LAUNCH_TIMEOUT_MS = 30_000;
export const CDP_COMMAND_TIMEOUT_MS = 30_000;
const CDP_CONNECT_TIMEOUT_MS = 10_000;
const MAX_STDERR_BYTES = 4096;
const persistentProfileOwners = new Map();

const fail = (message, code = 'ASSISTANT_BROWSER_CDP_UNAVAILABLE') => Object.assign(new Error(message), { code });
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

/**
 * Chromium flags for the managed image. Chromium's own sandbox is unavailable in
 * most managed containers, so the egress proxy stays authoritative for network
 * policy; `--proxy-bypass-list=<-loopback>` keeps loopback inside the proxy too.
 * 桌面模式的首屏是本机 127.0.0.1 的欢迎页，因此回环必须显式放行，否则页面会被
 * 出口代理吃掉而白屏；公网流量仍然全部走代理。
 * 桌面窗口固定 `--class=Chromium`：否则 `--app=<地址>` 会把 WM_CLASS 设成地址本身，
 * dock 的任务按钮匹配不到 chromium.desktop，只能显示一个灰色兜底图标。
 * 托管容器里 Chromium 自带沙箱不可用，`--no-sandbox` 会让窗口版 Chromium 顶部弹出
 * “You are using an unsupported command-line flag” 信息栏；`--test-type` 抑制该提示栏，
 * 不改变 CDP/自动化语义，也不影响页面能力。
 */
export function chromiumArgs({ userDataDir, proxy, windowSize = '1280,800', desktop = false, startUrl, openUrl }) {
  return [
    ...(desktop ? ['--ozone-platform=x11', '--test-type', '--lang=zh-CN', '--accept-lang=zh-CN,zh', '--class=Chromium', '--hide-crash-restore-bubble'] : ['--headless=new']),
    // 欢迎页是云电脑的门面，必须铺满整块 1280x800 屏幕：`--app` 无地址栏 +
    // `--kiosk` 全屏（旧实现是 740x620 固定窗口偏在右下角，四圈都是灰底）。
    ...(desktop && startUrl ? [`--app=${startUrl}`, '--kiosk', '--window-position=0,0'] : []),
    // 普通窗口模式：把首页作为位置参数交给 Chromium，避免先出一个空白标签再补一个页面；同时最大化。
    ...(desktop && !startUrl && openUrl ? ['--window-position=0,0', '--start-maximized', openUrl] : []),
    ...(desktop && !startUrl && !openUrl ? ['--window-position=0,0', '--start-maximized'] : []),
    '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter',
    '--disable-translate', '--mute-audio', '--hide-scrollbars',
    `--window-size=${desktop ? '1280,800' : windowSize}`,
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    `--proxy-server=${proxy}`,
    '--proxy-bypass-list=<-loopback>,127.0.0.1,localhost',
  ];
}

/** Read `<user-data-dir>/DevToolsActivePort`; Chromium writes port and browser WebSocket path. */
export function readDevToolsEndpoint(userDataDir) {
  let content;
  try { content = readFileSync(join(userDataDir, DEVTOOLS_PORT_FILE), 'utf8'); } catch { return null; }
  const [portLine, pathLine] = content.split(/\r?\n/);
  const port = Number(portLine);
  const path = (pathLine || '').trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.startsWith('/')) return null;
  return { port, path, endpoint: `ws://127.0.0.1:${port}${path}` };
}

export function createProfileDir() {
  return mkdtempSync(join(tmpdir(), 'agentkit-cloud-browser-'));
}

/** Kill the detached Chromium process group; fall back to the single pid. */
export function killProcessTree(pid, signal = 'SIGKILL') {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

function collectStderr(child, state) {
  child?.stderr?.on?.('data', chunk => {
    if (state.bytes >= MAX_STDERR_BYTES) return;
    const slice = chunk.subarray(0, MAX_STDERR_BYTES - state.bytes);
    state.text += slice.toString('utf8');
    state.bytes += slice.length;
  });
}

const childExited = child => child.exitCode !== null && child.exitCode !== undefined || Boolean(child.signalCode);
const waitForOwnChild = (child, timeoutMs) => {
  if (!child || childExited(child)) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = error => { clearTimeout(timer); child.removeListener?.('exit', exited); error ? rejectPromise(error) : resolvePromise(); };
    const exited = () => finish();
    const timer = setTimeout(() => finish(fail('自有 Chromium 进程仍未退出，拒绝复用私有配置目录', 'ASSISTANT_BROWSER_PROCESS_STILL_RUNNING')), timeoutMs);
    child.once('exit', exited);
    if (childExited(child)) finish();
  });
};
async function stopOwnChromium(child, kill, { wait = false, graceMs = 0 } = {}) {
  if (!child?.pid || childExited(child)) return;
  // 正常关窗/Browser.close 可先完成 SQLite 等状态写入；只等待自己的 child。
  if (wait && graceMs) { try { await waitForOwnChild(child, graceMs); return; } catch (error) { if (error.code !== 'ASSISTANT_BROWSER_PROCESS_STILL_RUNNING') throw error; } }
  try { kill(child.pid, 'SIGKILL'); } catch {
    if (wait) throw fail('无法停止自有 Chromium，拒绝复用私有配置目录', 'ASSISTANT_BROWSER_PROCESS_STILL_RUNNING');
  }
  if (wait) await waitForOwnChild(child, 2000);
}

function preparePersistentProfile(userDataDir) {
  if (!userDataDir || !isAbsolute(userDataDir)) throw fail('持久浏览器配置目录必须为绝对路径', 'ASSISTANT_BROWSER_PROFILE_INVALID');
  try {
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(userDataDir).isDirectory() || lstatSync(userDataDir).isSymbolicLink()) throw fail('浏览器私有配置目录不能是符号链接', 'ASSISTANT_BROWSER_PROFILE_INVALID');
    chmodSync(userDataDir, 0o700);
    // 旧 child 已由调用方 dispose 等待退出。只清调试端口元数据，不碰锁或登录数据。
    rmSync(join(userDataDir, DEVTOOLS_PORT_FILE), { force: true });
  } catch (error) {
    if (String(error.code).startsWith('ASSISTANT_BROWSER_')) throw error;
    throw fail(`浏览器私有配置目录不可用: ${error.code || 'filesystem-error'}`, 'ASSISTANT_BROWSER_PROFILE_UNAVAILABLE');
  }
}

export async function launchChromium({
  chromium, proxy, userDataDir, spawn = spawnChild,
  launchTimeoutMs = DEVTOOLS_LAUNCH_TIMEOUT_MS, now = Date.now, pollMs = 25, env = process.env,
  preserveUserDataDir = false, startUrl, openUrl,
} = {}) {
  if (preserveUserDataDir) {
    const previous = persistentProfileOwners.get(userDataDir);
    if (previous && !childExited(previous)) throw fail('自有 Chromium 仍占用私有配置目录，拒绝启动第二个实例', 'ASSISTANT_BROWSER_PROCESS_STILL_RUNNING');
    preparePersistentProfile(userDataDir);
  }
  else if (userDataDir === undefined) userDataDir = createProfileDir();
  const cleanupProfile = () => { if (!preserveUserDataDir) rmSync(userDataDir, { recursive: true, force: true }); };
  const desktop = env.AGENTKIT_DESKTOP_MODE === '1';
  // 桌面浏览器展示的是本地时间（欢迎页时钟、页面里的 Date），必须与桌面其它
  // 进程同一时区；非桌面模式只沿用宿主 TZ，不改变既有口径。
  const timeZone = typeof env.TZ === 'string' && env.TZ
    ? env.TZ
    : desktop ? String(env.AGENTKIT_DESKTOP_TIME_ZONE || 'Asia/Shanghai') : undefined;
  const args = chromiumArgs({ userDataDir, proxy, desktop, startUrl, openUrl });
  const stderr = { text: '', bytes: 0 };
  let child;
  try {
    child = spawn(chromium, args, {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin', HOME: userDataDir, TMPDIR: '/tmp',
        // 桌面窗口给用户看：界面与页面语言都用简体中文；LC_ALL 会盖过 LANG，桌面模式不能设。
        // 无头自动化不改变既有口径（历史行为是 C.UTF-8 + 默认语言）。
        ...(desktop
          ? { LANG: 'zh_CN.UTF-8', LANGUAGE: 'zh_CN:zh' }
          : { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }),
        ...(timeZone ? { TZ: timeZone } : {}),
        ...(desktop ? { DISPLAY: env.DISPLAY || ':99' } : {}),
      },
    });
  } catch (error) {
    cleanupProfile();
    throw fail(`Chromium 启动失败: ${error?.code || 'spawn-error'}`, 'ASSISTANT_BROWSER_LAUNCH_FAILED');
  }
  if (preserveUserDataDir && child?.pid) {
    persistentProfileOwners.set(userDataDir, child);
    child.once('exit', () => { if (persistentProfileOwners.get(userDataDir) === child) persistentProfileOwners.delete(userDataDir); });
  }
  collectStderr(child, stderr);
  let exit, spawnError;
  child?.once?.('exit', (code, signal) => { exit = { code, signal }; });
  child?.once?.('error', error => { spawnError = error; });
  const deadline = now() + launchTimeoutMs;
  while (now() < deadline) {
    const endpoint = readDevToolsEndpoint(userDataDir);
    if (endpoint) return { child, userDataDir, endpoint, stderr };
    if (spawnError) { cleanupProfile(); throw fail(`Chromium 启动失败: ${spawnError.code || 'spawn-error'}`, 'ASSISTANT_BROWSER_LAUNCH_FAILED'); }
    if (exit) {
      await stopOwnChromium(child, killProcessTree, { wait: preserveUserDataDir });
      cleanupProfile();
      const detail = stderr.text.trim().slice(0, 500);
      throw fail(`Chromium 在调试端口就绪前退出（${exit.code ?? exit.signal}）${detail ? `: ${detail}` : ''}`, 'ASSISTANT_BROWSER_LAUNCH_FAILED');
    }
    await delay(pollMs);
  }
  await stopOwnChromium(child, killProcessTree, { wait: preserveUserDataDir });
  cleanupProfile();
  throw fail('Chromium 调试端口在限定时间内未就绪', 'ASSISTANT_BROWSER_LAUNCH_FAILED');
}

/** One JSON-RPC channel. Commands time out individually; a closed channel never reconnects. */
export class CdpConnection {
  #ws; #pending = new Map(); #nextId = 0; #closed = false; #commandTimeoutMs;

  constructor(ws, { commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS } = {}) {
    this.#ws = ws;
    this.#commandTimeoutMs = commandTimeoutMs;
    ws.addEventListener?.('message', event => this.#onMessage(event));
    ws.addEventListener?.('close', () => this.#rejectAll(fail('云端浏览器调试连接已关闭', 'ASSISTANT_BROWSER_CDP_CLOSED')));
    ws.addEventListener?.('error', () => this.#rejectAll(fail('云端浏览器调试连接出错', 'ASSISTANT_BROWSER_CDP_ERROR')));
  }

  get closed() { return this.#closed; }

  send(method, params = {}, { sessionId, timeoutMs = this.#commandTimeoutMs } = {}) {
    if (this.#closed) return Promise.reject(fail('云端浏览器调试连接已关闭', 'ASSISTANT_BROWSER_CDP_CLOSED'));
    if (typeof method !== 'string' || !method) return Promise.reject(fail('CDP 方法名无效', 'ASSISTANT_BROWSER_CDP_ERROR'));
    const id = ++this.#nextId;
    return new Promise((resolvePromise, rejectPromise) => {
      // Keep the timeout ref'd: an in-flight command must keep the process
      // alive long enough for the timeout to fire instead of leaving a
      // promise that the event loop silently abandons (Node 22 cancels it).
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(fail(`云端浏览器命令 ${method} 超时`, 'ASSISTANT_BROWSER_CDP_TIMEOUT'));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
      try { this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch {
        this.#pending.delete(id);
        clearTimeout(timer);
        rejectPromise(fail(`云端浏览器命令 ${method} 发送失败`, 'ASSISTANT_BROWSER_CDP_ERROR'));
      }
    });
  }

  #onMessage(event) {
    let message;
    try { message = JSON.parse(typeof event === 'string' ? event : event?.data); } catch { return; }
    if (!message || typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(fail(`CDP ${pending.method} 失败: ${String(message.error.message || '').slice(0, 300)}`, 'ASSISTANT_BROWSER_CDP_ERROR'));
    else pending.resolve(message.result || {});
  }

  #rejectAll(error) {
    if (this.#closed && this.#pending.size === 0) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  close() {
    if (this.#closed) return;
    this.#rejectAll(fail('云端浏览器调试连接已关闭', 'ASSISTANT_BROWSER_CDP_CLOSED'));
    try { this.#ws.close(); } catch {}
  }
}

/** Connect once to the browser-level WebSocket endpoint. */
export async function connectCdp({
  endpoint, WebSocketImpl = globalThis.WebSocket,
  commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS, connectTimeoutMs = CDP_CONNECT_TIMEOUT_MS,
} = {}) {
  if (typeof WebSocketImpl !== 'function') throw fail('运行环境缺少 WebSocket 实现', 'ASSISTANT_BROWSER_CDP_UNAVAILABLE');
  if (typeof endpoint !== 'string' || !endpoint.startsWith('ws://')) throw fail('Chromium 调试端点无效', 'ASSISTANT_BROWSER_LAUNCH_FAILED');
  const ws = new WebSocketImpl(endpoint);
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      rejectPromise(fail('连接 Chromium 调试端口超时', 'ASSISTANT_BROWSER_CDP_TIMEOUT'));
    }, connectTimeoutMs);
    timer.unref?.();
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error); else resolvePromise();
    };
    ws.addEventListener?.('open', () => finish());
    ws.addEventListener?.('error', () => finish(fail('无法连接 Chromium 调试端口', 'ASSISTANT_BROWSER_CDP_UNAVAILABLE')));
    ws.addEventListener?.('close', () => finish(fail('Chromium 调试端口连接已关闭', 'ASSISTANT_BROWSER_CDP_UNAVAILABLE')));
  });
  return new CdpConnection(ws, { commandTimeoutMs });
}

/**
 * Launch and connect one Chromium. `dispose()` closes the channel, kills the
 * process group. 普通临时配置会删除；Computer 明确声明的持久私有配置保留。
 */
export async function startCdpTransport({
  chromium, proxy, spawn = spawnChild, WebSocketImpl = globalThis.WebSocket,
  kill = killProcessTree, launchTimeoutMs = DEVTOOLS_LAUNCH_TIMEOUT_MS,
  commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS, now = Date.now, userDataDir, endpoint: fixedEndpoint,
  env = process.env,
  preserveUserDataDir = false, startUrl,
} = {}) {
  if (preserveUserDataDir && (!userDataDir || !isAbsolute(userDataDir))) throw fail('持久浏览器配置目录必须为绝对路径', 'ASSISTANT_BROWSER_PROFILE_INVALID');
  const launched = fixedEndpoint
    ? { child: undefined, userDataDir, endpoint: { endpoint: fixedEndpoint }, stderr: { text: '' } }
    : await launchChromium({ chromium, proxy, spawn, launchTimeoutMs, now, userDataDir, env, preserveUserDataDir, startUrl });
  let connection;
  try { connection = await connectCdp({ endpoint: launched.endpoint.endpoint, WebSocketImpl, commandTimeoutMs }); }
  catch (error) {
    await stopOwnChromium(launched.child, kill, { wait: preserveUserDataDir });
    if (launched.userDataDir && !preserveUserDataDir) await rm(launched.userDataDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  let disposing;
  return {
    connection,
    child: launched.child,
    userDataDir: launched.userDataDir,
    stderr: launched.stderr,
    dispose() {
      if (disposing) return disposing;
      disposing = (async () => {
        try { connection.close(); } catch {}
        await stopOwnChromium(launched.child, kill, { wait: preserveUserDataDir, graceMs: preserveUserDataDir ? 1000 : 0 });
        if (launched.userDataDir && !preserveUserDataDir) await rm(launched.userDataDir, { recursive: true, force: true }).catch(() => {});
      })();
      return disposing;
    },
  };
}
