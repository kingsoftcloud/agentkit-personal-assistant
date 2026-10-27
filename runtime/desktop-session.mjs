/**
 * In-memory desktop session manager for the Personal Assistant Computer.
 *
 * The desktop is a real X11 display (Xvfb + fluxbox); frames are captured to
 * stdout and never written to disk.  The manager is deliberately stateless
 * across Pod restarts: a new Pod has no valid session or lease.
 */
import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createDesktopLauncherServer } from './desktop-launcher.mjs';
import { createWelcomeServer } from './welcome-server.mjs';

const execFile = promisify(execFileCallback);
export const DESKTOP_WIDTH = 1280;
export const DESKTOP_HEIGHT = 800;
export const DESKTOP_MAX_FRAME_BYTES = 300 * 1024;
export const DESKTOP_ACTIVE_INTERVAL_MS = 80;
export const DESKTOP_IDLE_INTERVAL_MS = 1000;
export const DESKTOP_CAPTURE_FPS = 15;
export const DESKTOP_ACTIVITY_WINDOW_MS = 10_000;
export const DESKTOP_IDLE_TIMEOUT_MS = Number(process.env.AGENTKIT_DESKTOP_IDLE_TIMEOUT_MS || 10 * 60_000);
export const DESKTOP_IDLE_RETENTION_MS = Number(process.env.AGENTKIT_DESKTOP_IDLE_RETENTION_MS || 15 * 60_000);
export const DESKTOP_TEXT_COALESCE_MS = 30;
export const DESKTOP_CLIPBOARD_MAX_BYTES = 64 * 1024;

const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.round(Number(value))));
const inputError = (message, code = 'DESKTOP_INPUT_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const truncateUtf8 = (value, maxBytes) => {
  const buffer = Buffer.from(String(value ?? ''), 'utf8');
  if (buffer.length <= maxBytes) return buffer.toString('utf8');
  // 按 UTF-8 字符边界截断，不能把多字节字符切一半。
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
};

// 仅在系统默认文件缺失时使用；正常镜像逐字复制 /etc/X11/fluxbox/keys。
// 正文点击由 ClickFocus/clickRaises 处理并转交应用，不用 OnWindow Mouse1 抢走应用单击。
const desktopWindowBindings = [
  'OnDesktop Mouse1 :HideMenus',
  'OnDesktop Mouse3 :RootMenu',
  'OnTitlebar Mouse1 :MacroCmd {Raise} {Focus} {ActivateTab}',
  'OnTitlebar Move1 :StartMoving',
  'OnTitlebar Mouse3 :WindowMenu',
  'OnWindowBorder Move1 :StartMoving',
  'OnLeftGrip Move1 :StartResizing bottomleft',
  'OnRightGrip Move1 :StartResizing bottomright',
  'OnWindow Mod1 Mouse1 :MacroCmd {Raise} {Focus} {StartMoving}',
  'Mod1 Tab :NextWindow {groups} (workspace=[current])',
  'Mod1 Shift Tab :PrevWindow {groups} (workspace=[current])',
  '',
].join('\n');

function safeText(value, name, max = 4096) {
  const result = String(value ?? '');
  if (!result || result.length > max || /[\u0000\r\n]/u.test(result)) throw inputError(`${name} is invalid`);
  return result;
}

/** Parse image2pipe MJPEG without retaining oversized or incomplete frames. */
export function createMjpegFrameParser({ onFrame, onDrop = () => {}, maxFrameBytes = DESKTOP_MAX_FRAME_BYTES } = {}) {
  const start = Buffer.from([0xff, 0xd8]), end = Buffer.from([0xff, 0xd9]);
  let pending = Buffer.alloc(0), skipping = false;
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length) {
      if (skipping) {
        const index = pending.indexOf(end);
        if (index < 0) { pending = pending.subarray(-1); return; }
        pending = pending.subarray(index + 2); skipping = false;
      }
      const beginning = pending.indexOf(start);
      if (beginning < 0) { pending = pending.subarray(-1); return; }
      if (beginning > 0) pending = pending.subarray(beginning);
      const ending = pending.indexOf(end, 2);
      if (ending >= 0) {
        const length = ending + 2;
        if (length <= maxFrameBytes) onFrame(Buffer.from(pending.subarray(0, length))); else onDrop();
        pending = pending.subarray(length);
      } else {
        if (pending.length > maxFrameBytes) { onDrop(); skipping = true; pending = pending.subarray(-1); }
        return;
      }
    }
  };
}

export function createDesktopController({
  display = process.env.DISPLAY || ':99',
  width = DESKTOP_WIDTH,
  height = DESKTOP_HEIGHT,
  spawn = spawnChild,
  exec = execFile,
  readWindowBindings = readFile,
  now = () => Date.now(),
  capture = null,
  terminal = true,
  onStop = null,
  onIdle = null,
  idleTimeoutMs = DESKTOP_IDLE_TIMEOUT_MS,
  idleRetentionMs = DESKTOP_IDLE_RETENTION_MS,
  windowManagerReadyTimeoutMs = 5000,
  applications = false,
  workspace = process.env.AGENTKIT_WORKSPACE_DIR || '/workspace',
  onLaunchBrowser = null,
  onLaunchError = () => {},
} = {}) {
  const sessions = new Map();
  let xvfb;
  let wm;
  let windowManagerFailure;
  let terminalProcess;
  let dockProcess, fileManagerProcess, launcher, welcome, welcomeUrl, launcherStopped = false, launcherShutdown = false;
  let appQueue = Promise.resolve();
  const processGroups = new Set();
  // X11 剪贴板由 owner 进程持有；只保留最新一份写入，避免旧 selection 被读到。
  const clipboardOwners = new Set();
  let collector;
  let collectorStarting;
  let collectorStopping;
  let displayStopping;
  let wmConfiguration;
  const processDiagnostics = new Map();
  let latestFrame;
  let capturedFrames = 0, droppedFrames = 0;
  let collectorFailure;
  let displayReady;
  let lastActivityAt = 0;
  let sequence = 0;
  let disposed = false;
  const pressedButtons = new Set();
  const pressedKeys = new Set();
  const syntheticModifiers = new Set();
  const keyPresses = new Map();
  let inputQueue = Promise.resolve();
  let inputOwner;
  let pendingText;
  const enqueueInput = operation => {
    const pending = inputQueue.then(operation);
    inputQueue = pending.catch(() => {});
    return pending;
  };
  // 只合并相邻文本；按键、指针、控制权切换都是屏障，不能跨屏障重排。
  const flushPendingText = () => {
    const batch = pendingText;
    if (!batch) return;
    pendingText = undefined;
    clearTimeout(batch.timer);
    batch.flush();
  };

  const environment = Object.freeze({ ...process.env, DISPLAY: display, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  const trackStartupProcess = (name, child) => {
    const diagnostic = { stderr: '', exitCode: null, signal: null };
    processDiagnostics.set(name, diagnostic);
    child.stderr?.on('data', chunk => { diagnostic.stderr = (diagnostic.stderr + chunk.toString('utf8')).slice(-2048); });
    child.once?.('exit', (code, signal) => { diagnostic.exitCode = code; diagnostic.signal = signal || null; });
    child.once?.('error', error => { diagnostic.error = { code: error.code, message: String(error.message).slice(0, 500) }; });
    return child;
  };
  const stopProcess = child => new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    let timer;
    const finish = () => { clearTimeout(timer); resolve(); };
    child.once('exit', finish); child.once('error', finish);
    const kill = signal => {
      if (processGroups.has(child) && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      } else child.kill(signal);
    };
    timer = setTimeout(() => { kill('SIGKILL'); finish(); }, 500);
    kill('SIGTERM');
  });
  const spawnDisplay = () => {
    if (xvfb && xvfb.exitCode === null && !xvfb.killed) return;
    xvfb = trackStartupProcess('Xvfb', spawn('Xvfb', [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-ac'], { env: environment, stdio: ['ignore', 'ignore', 'pipe'] }));
    xvfb.once?.('exit', () => { xvfb = undefined; displayReady = undefined; });
  };
  const spawnWindowManager = async () => {
    if (wm && wm.exitCode === null && !wm.killed) return;
    if (!wmConfiguration) {
      // 先读取再创建配置目录：权限等错误不降级，也不留下可被下次启动复用的半成品。
      let bindings;
      try { bindings = await readWindowBindings('/etc/X11/fluxbox/keys'); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        bindings = desktopWindowBindings;
      }
      // Only configuration is written. Desktop pixels remain memory-only.
      wmConfiguration = await mkdtemp(join(tmpdir(), 'agentkit-desktop-wm-'));
      // Fluxbox 首次启动会向 HOME/.fluxbox 复制系统默认配置；提前完整创建，
      // 避免覆盖 -rc 指定的设置或弹出默认壁纸错误窗口。
      await mkdir(join(wmConfiguration, '.fluxbox'));
      await writeFile(join(wmConfiguration, '.fluxbox', 'keys'), bindings);
      await writeFile(join(wmConfiguration, '.fluxbox', 'apps'), '');
      // 真实桌面采用浅蓝灰背景与平面窗口装饰；菜单仍使用系统 Noto 中文字体。
      await writeFile(join(wmConfiguration, 'style'), [
        'background: solid', 'background.color: #dce5f0',
        'window.title.height: 28', 'window.bevelWidth: 3',
        'window.title.focus: flat solid', 'window.title.focus.color: #f6f9fd',
        'window.label.focus: parentrelative', 'window.label.focus.textColor: #23334d',
        'window.title.unfocus: flat solid', 'window.title.unfocus.color: #eaf0f7',
        'window.label.unfocus: parentrelative', 'window.label.unfocus.textColor: #66758b',
        'window.focus.borderColor: #8da9d0', 'window.unfocus.borderColor: #c1cddd',
        'window.borderWidth: 1', 'window.handleWidth: 3',
        'window.button.focus: parentrelative', 'window.button.focus.picColor: #506882',
        'window.button.unfocus: parentrelative', 'window.button.unfocus.picColor: #8a99ad',
        'window.button.pressed: flat solid', 'window.button.pressed.color: #cbdcf2',
        'window.handle.focus: flat solid', 'window.handle.focus.color: #d5e1f1',
        'window.handle.unfocus: flat solid', 'window.handle.unfocus.color: #e4ebf4',
        'window.grip.focus: parentrelative', 'window.grip.unfocus: parentrelative',
        'menu.title: flat solid', 'menu.title.color: #f0f5fc', 'menu.title.textColor: #23334d',
        'menu.frame: flat solid', 'menu.frame.color: #ffffff', 'menu.frame.textColor: #33435a',
        'menu.hilite: flat solid', 'menu.hilite.color: #dce8f9', 'menu.hilite.textColor: #1e3658',
        'menu.borderColor: #c5d2e3', 'menu.borderWidth: 1', 'menu.bevelWidth: 6',
        'toolbar: flat solid', 'toolbar.color: #f8fbff', 'toolbar.height: 32',
        'toolbar.borderColor: #c5d2e3', 'toolbar.borderWidth: 1', 'toolbar.bevelWidth: 4',
        'toolbar.clock: parentrelative', 'toolbar.clock.textColor: #40516b',
        'toolbar.workspace: parentrelative', 'toolbar.workspace.textColor: #40516b',
        'toolbar.button: parentrelative', 'toolbar.button.picColor: #506882',
        'toolbar.button.pressed: flat solid', 'toolbar.button.pressed.color: #dce8f9',
        'toolbar.iconbar.focused: flat solid', 'toolbar.iconbar.focused.color: #dfebfa',
        'toolbar.iconbar.focused.textColor: #23334d',
        'toolbar.iconbar.unfocused: parentrelative', 'toolbar.iconbar.unfocused.textColor: #66758b',
        'menu.title.font: Noto Sans CJK SC-10:bold', 'menu.frame.font: Noto Sans CJK SC-10',
        'menu.hilite.font: Noto Sans CJK SC-10:bold', 'window.font: Noto Sans CJK SC-9',
        'toolbar.clock.font: Noto Sans CJK SC-9', 'toolbar.workspace.font: Noto Sans CJK SC-9',
        'toolbar.iconbar.focused.font: Noto Sans CJK SC-9', 'toolbar.iconbar.unfocused.font: Noto Sans CJK SC-9', '',
      ].join('\n'));
      let menu = '[begin] (云电脑)\n[exec] (终端) {/usr/bin/xterm -u8 -fa "DejaVu Sans Mono" -fs 12 -geometry 56x24+20+65}\n[end]\n';
      if (applications) {
        if (launcherShutdown) throw Object.assign(new Error('桌面入口已停止'), { code: 'DESKTOP_LAUNCH_CLOSED' });
        launcherStopped = false;
        launcher = await createDesktopLauncherServer({ launch: launchApplication, onError: onLaunchError });
        // 欢迎页由本地回环桥提供：页面上的磁贴点击会走与 dock 相同的 launchApplication。
        try {
          welcome = await createWelcomeServer({
            webDir: fileURLToPath(new URL('../web', import.meta.url)),
            launch: launchApplication,
            onError: onLaunchError,
          });
          welcomeUrl = welcome.url;
        } catch (error) {
          welcome = undefined; welcomeUrl = undefined;
          onLaunchError?.(error);
        }
        const helper = fileURLToPath(new URL('./desktop-launcher.mjs', import.meta.url));
        const quote = value => `"${String(value).replace(/[\\"`$]/g, '\\$&')}"`;
        const command = action => [quote(process.execPath), quote(helper), '--socket', quote(launcher.socketPath), '--action', action].join(' ');
        const entries = [
          ['browser', '浏览器', '/usr/share/icons/hicolor/48x48/apps/chromium.png'],
          ['terminal', '终端', '/usr/share/icons/Adwaita/48x48/legacy/utilities-terminal.png'],
          ['files', '文件', '/usr/share/icons/Adwaita/48x48/places/folder.png'],
        ];
        for (const [action, name, icon] of entries) await writeFile(join(wmConfiguration, `${action}.desktop`), `[Desktop Entry]\nType=Application\nName=${name}\nExec=${command(action)}\nIcon=${icon}\nTerminal=false\nStartupNotify=false\n`);
        menu = '[begin] (云电脑)\n' + entries.map(([action, name]) => `[exec] (${name}) {${command(action)}}\n`).join('') + '[end]\n';
        await writeFile(join(wmConfiguration, 'tint2rc'), [
          'rounded = 0', 'border_width = 1', 'background_color = #f8fbff 100', 'border_color = #c5d2e3 100',
          'panel_items = LTC', 'panel_size = 240 56', 'panel_margin = 0 12', 'panel_padding = 12 7 12',
          'time1_format = %H:%M', 'time1_font = Noto Sans CJK SC 10', 'clock_font_color = #3d4a5c 100',
          'time1_timezone = Asia/Shanghai', 'clock_padding = 4 0 6 0', 'clock_background_id = 0',
          'panel_background_id = 1', 'panel_position = bottom center horizontal', 'panel_layer = top',
          'panel_monitor = primary', 'panel_dock = 0', 'panel_shrink = 0', 'panel_window_name = AgentKit Dock',
          'disable_transparency = 1', 'mouse_effects = 1', 'wm_menu = 0',
          'launcher_padding = 4 0 14', 'launcher_icon_size = 36', 'launcher_background_id = 0',
          'launcher_icon_background_id = 0', 'launcher_icon_asb = 100 0 0', 'launcher_tooltip = 1',
          ...entries.map(([action]) => `launcher_item_app = ${join(wmConfiguration, `${action}.desktop`)}`), '',
        ].join('\n'));
      }
      await writeFile(join(wmConfiguration, 'menu'), menu);
      const config = `session.configVersion: 13\nsession.styleFile: ${join(wmConfiguration, 'style')}\nsession.menuFile: ${join(wmConfiguration, 'menu')}\nsession.keyFile: ${join(wmConfiguration, '.fluxbox', 'keys')}\nsession.screen0.rootCommand: /usr/bin/fbsetroot -solid '#dce5f0'\nsession.screen0.workspaces: 1\nsession.screen0.workspaceNames: 云电脑\nsession.screen0.toolbar.visible: ${applications ? 'false' : 'true'}\nsession.screen0.focusModel: ClickFocus\nsession.screen0.clickRaises: true\nsession.screen0.focusNewWindows: true\n`;
      await writeFile(join(wmConfiguration, '.fluxbox', 'init'), config);
      await writeFile(join(wmConfiguration, 'init'), config);
    }
    windowManagerFailure = undefined;
    const child = trackStartupProcess('fluxbox', spawn('fluxbox', ['-display', display, '-rc', join(wmConfiguration, 'init'), '-no-slit'], { env: { ...environment, HOME: wmConfiguration }, stdio: ['ignore', 'ignore', 'pipe'] }));
    wm = child;
    child.once?.('error', error => {
      if (wm !== child) return;
      windowManagerFailure = Object.assign(new Error(`Fluxbox failed to start: ${error.message}`), { code: 'DESKTOP_WINDOW_MANAGER_UNAVAILABLE', status: 503, cause: error });
      displayReady = undefined;
    });
    child.once?.('exit', code => {
      if (wm !== child) return;
      wm = undefined; displayReady = undefined;
      windowManagerFailure = Object.assign(new Error(`Fluxbox exited before desktop shutdown (${code})`), { code: 'DESKTOP_WINDOW_MANAGER_UNAVAILABLE', status: 503 });
    });
  };
  const spawnTerminal = (force = false) => {
    if ((!terminal && !force) || (terminalProcess && terminalProcess.exitCode === null && !terminalProcess.killed)) return;
    // Latin 使用等宽 DejaVu 主字体；中文和 emoji 由 fontconfig 使用已安装的
    // Noto 后备字体。不要把 CJK 字体作为 -fa，或用 -fd 锁定所有宽字符，
    // 否则分别会拉宽英文单元格、破坏彩色 emoji 后备。56 列为多窗口留出空间。
    terminalProcess = trackStartupProcess('xterm', spawn('xterm', ['-display', display, '-u8', '-fa', 'DejaVu Sans Mono', '-fs', '12', '-xrm', 'XTerm*VT100.translations: #override\\nShift <Key>Insert: insert-selection(PRIMARY,CLIPBOARD)\\nCtrl Shift <Key>V: insert-selection(CLIPBOARD)', '-geometry', '56x24+20+65', '-title', 'AgentKit Cloud Desktop'], { env: environment, stdio: ['ignore', 'ignore', 'pipe'] }));
    const child = terminalProcess;
    child.once?.('exit', () => { if (terminalProcess === child) terminalProcess = undefined; });
    return child;
  };
  const assertApplicationActive = signal => {
    if (disposed || launcherStopped || signal?.aborted) throw Object.assign(new Error('桌面入口已停止'), { code: 'DESKTOP_LAUNCH_CLOSED' });
  };
  const activateApplication = async (args, signal, beforeCommand) => {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      assertApplicationActive(signal);
      let result;
      try { result = await exec('xdotool', ['search', '--onlyvisible', ...args], { env: environment, timeout: 1000 }); }
      catch (error) { if (error.code !== 1) throw error; }
      assertApplicationActive(signal);
      const id = String(result?.stdout || '').trim().split('\n')[0];
      if (id) { beforeCommand?.(); await exec('xdotool', ['windowactivate', '--sync', id], { env: environment, timeout: 1000 }); return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Object.assign(new Error('桌面应用尚未显示窗口'), { code: 'DESKTOP_APP_WINDOW_UNAVAILABLE' });
  };
  const launchApplication = (action, { signal, beforeCommand } = {}) => {
    const pending = appQueue.then(async () => {
      assertApplicationActive(signal); beforeCommand?.();
      await ensureDisplay();
      assertApplicationActive(signal); beforeCommand?.();
      if (action === 'browser') {
        if (!onLaunchBrowser) throw Object.assign(new Error('浏览器入口尚未连接'), { code: 'DESKTOP_BROWSER_UNAVAILABLE' });
        await onLaunchBrowser({ signal });
        // CDP 的 activateTarget 只选择标签页；应用入口还需让同一窗口获得 WM 焦点。
        await activateApplication(['--class', '^Chromium$'], signal, beforeCommand);
      } else if (action === 'terminal') {
        if (terminalProcess && terminalProcess.exitCode === null && !terminalProcess.killed) await activateApplication(['--pid', String(terminalProcess.pid)], signal, beforeCommand);
        else { const child = spawnTerminal(true); await activateApplication(['--pid', String(child.pid)], signal, beforeCommand); }
      } else if (action === 'files') {
        if (fileManagerProcess && fileManagerProcess.exitCode === null && !fileManagerProcess.killed) await activateApplication(['--class', '^Thunar$'], signal, beforeCommand);
        else {
          const child = trackStartupProcess('thunar', spawn('/usr/bin/dbus-run-session', ['--', '/usr/bin/thunar', workspace], { env: environment, stdio: ['ignore', 'ignore', 'pipe'], detached: true }));
          fileManagerProcess = child; processGroups.add(child);
          child.once?.('exit', () => { processGroups.delete(child); if (fileManagerProcess === child) fileManagerProcess = undefined; });
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          await activateApplication(['--class', '^Thunar$'], signal, beforeCommand);
        }
      }
      assertApplicationActive(signal); beforeCommand?.();
    });
    appQueue = pending.catch(() => {});
    return pending;
  };
  const stopLauncher = async ({ permanent = true } = {}) => {
    launcherShutdown ||= permanent; launcherStopped = true;
    const current = launcher; launcher = undefined; welcomeUrl = undefined;
    const currentWelcome = welcome; welcome = undefined;
    await currentWelcome?.close();
    await current?.close();
  };
  const waitDisplay = async () => {
    if (displayReady) return displayReady;
    const began = performance.now();
    let lastProbe;
    displayReady = (async () => {
      // 启动本身计入活动，避免首个清理周期把尚未就绪的桌面当成长期空闲。
      lastActivityAt = now();
      spawnDisplay();
      const deadline = now() + 5000;
      let lastError;
      while (now() < deadline) {
        // 1280x800 X11 visuals can make xdpyinfo exceed 32 KiB; the probe is
        // only a readiness check and must not reject a healthy Xvfb display.
        try { await exec('xdpyinfo', ['-display', display], { env: environment, maxBuffer: 128 * 1024 }); break; }
        catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      if (now() >= deadline) throw Object.assign(new Error(`Xvfb display ${display} did not become ready`), { code: 'DESKTOP_DISPLAY_UNAVAILABLE', cause: lastError });
      await spawnWindowManager();
      spawnTerminal();
      // Xvfb 可连接、Fluxbox 进程存在均不能证明窗口已被 WM 接管。
      // xprop 在属性不存在时也可能 exit 0，必须检查 WINDOW 类型的非零 XID。
      const wmDeadline = performance.now() + windowManagerReadyTimeoutMs;
      let wmReady = false, probeError;
      while (performance.now() < wmDeadline) {
        if (disposed) throw Object.assign(new Error('desktop controller is disposed'), { code: 'DESKTOP_DISPOSED' });
        if (windowManagerFailure) throw windowManagerFailure;
        if (!wm || wm.exitCode !== null || wm.killed) break;
        try {
          const result = await exec('xprop', ['-display', display, '-root', '_NET_SUPPORTING_WM_CHECK', '_NET_ACTIVE_WINDOW'], {
            env: environment, maxBuffer: 4096, timeout: Math.max(1, Math.min(500, Math.ceil(wmDeadline - performance.now()))),
          });
          const output = String(result.stdout);
          lastProbe = { stdout: output.slice(-2048), stderr: String(result.stderr || '').slice(-2048) };
          const hasWindow = name => {
            const value = output.match(new RegExp(`^${name}\\(WINDOW\\): window id # (0x[0-9a-f]+)\\s*$`, 'im'))?.[1];
            return value !== undefined && BigInt(value) !== 0n;
          };
          wmReady = hasWindow('_NET_SUPPORTING_WM_CHECK') && (!terminal || hasWindow('_NET_ACTIVE_WINDOW'));
          if (windowManagerFailure) throw windowManagerFailure;
          if (wmReady) break;
        } catch (error) {
          probeError = error;
          lastProbe = { code: error.code, signal: error.signal || null, killed: Boolean(error.killed), message: String(error.message).slice(0, 500), stdout: String(error.stdout || '').slice(-2048), stderr: String(error.stderr || '').slice(-2048) };
        }
        if (windowManagerFailure) throw windowManagerFailure;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(50, wmDeadline - performance.now()))));
      }
      if (!wmReady) throw Object.assign(new Error(`Fluxbox on ${display} did not publish a ready desktop within ${windowManagerReadyTimeoutMs}ms`), { code: 'DESKTOP_WINDOW_MANAGER_UNAVAILABLE', status: 503, cause: probeError });
      if (applications) {
        const child = trackStartupProcess('tint2', spawn('/usr/bin/tint2', ['-c', join(wmConfiguration, 'tint2rc')], { env: environment, stdio: ['ignore', 'ignore', 'pipe'] }));
        dockProcess = child;
        child.once?.('exit', () => { if (dockProcess === child) { dockProcess = undefined; displayReady = undefined; } });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const deadline = performance.now() + 2000;
        let visible = false;
        while (performance.now() < deadline && child.exitCode === null && !child.killed) {
          assertApplicationActive();
          try { visible = Boolean(String((await exec('xdotool', ['search', '--onlyvisible', '--pid', String(child.pid)], { env: environment, timeout: 500 })).stdout).trim()); }
          catch (error) { if (error.code !== 1) throw error; }
          if (visible) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!visible) throw Object.assign(new Error('桌面应用底栏未显示'), { code: 'DESKTOP_DOCK_UNAVAILABLE' });
        assertApplicationActive();
      }
      return true;
    })();
    try { await displayReady; } catch (error) {
      // 只保存启动工具的有限诊断，不采集 env、命令行、终端内容或画面。
      // 必须先快照再清理，否则 SIGTERM/断开 X11 会覆盖真正的失败原因。
      error.desktopDiagnostics = { elapsedMs: Math.round(performance.now() - began), lastProbe, processes: Object.fromEntries([...processDiagnostics].map(([name, value]) => [name, { ...value }])) };
      displayReady = undefined; await stopDisplay(); throw error;
    }
    return displayReady;
  };
  const ensureDisplay = async () => {
    if (disposed) throw Object.assign(new Error('desktop controller is disposed'), { code: 'DESKTOP_DISPOSED' });
    if (displayStopping) await displayStopping;
    await waitDisplay();
  };
  const stopCollector = () => {
    const child = collector;
    if (!child) return collectorStopping || Promise.resolve();
    collector = undefined; latestFrame = undefined;
    const stopped = stopProcess(child);
    collectorStopping = stopped;
    void stopped.finally(() => { if (collectorStopping === stopped) collectorStopping = undefined; });
    return stopped;
  };
  const ensureCollector = async () => {
    if (capture) return;
    if (collectorStarting) return collectorStarting;
    if (collector && collector.exitCode === null && !collector.killed) return;
    collectorStarting = (async () => {
      if (collectorStopping) await collectorStopping;
      await ensureDisplay();
      collectorFailure = undefined; latestFrame = undefined;
      let stderr = '';
      const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${width}x${height}`, '-framerate', String(DESKTOP_CAPTURE_FPS), '-i', `${display}.0+0,0`, '-an', '-vf', `setpts=N/(${DESKTOP_CAPTURE_FPS}*TB)`, '-c:v', 'mjpeg', '-pix_fmt', 'yuvj444p', '-filter_threads', '2', '-q:v', '3', '-threads', '2', '-fps_mode', 'passthrough', '-f', 'image2pipe', 'pipe:1'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      collector = child;
      const receive = createMjpegFrameParser({ onFrame: data => {
        if (collector !== child || disposed) return;
        latestFrame = { seq: ++sequence, capturedAt: now(), data }; capturedFrames += 1;
      }, onDrop: () => { droppedFrames += 1; } });
      child.stdout.on('data', receive);
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2048); });
      child.on('error', error => { collectorFailure = Object.assign(new Error(`desktop collector failed: ${error.message}`), { code: 'DESKTOP_FRAME_CAPTURE_FAILED', cause: error }); });
      child.once('exit', code => {
        if (collector !== child) return;
        collector = undefined;
        collectorFailure = Object.assign(new Error(`desktop collector exited ${code}: ${stderr}`), { code: 'DESKTOP_FRAME_CAPTURE_FAILED' });
      });
      const deadline = Date.now() + 2500;
      while (!latestFrame && collector === child && Date.now() < deadline && !collectorFailure) await new Promise(resolve => setTimeout(resolve, 10));
      if (!latestFrame) { await stopCollector(); throw collectorFailure || Object.assign(new Error('desktop first frame timed out'), { code: 'DESKTOP_FRAME_CAPTURE_FAILED' }); }
    })();
    try { await collectorStarting; } finally { collectorStarting = undefined; }
  };
  const captureFrame = async () => {
    await ensureDisplay();
    if (capture) return capture({ display, width, height });
    await ensureCollector();
    if (collectorFailure) throw collectorFailure;
    return latestFrame.data;
  };
  const runXdotool = async (args) => {
    await ensureDisplay();
    await exec('xdotool', args, { env: environment, maxBuffer: 32 * 1024, timeout: 2000 });
  };
  const keyNames = Object.freeze({ Ctrl: 'Control_L', Cmd: 'Super_L', Command: 'Super_L', Option: 'Alt_L', ctrl: 'Control_L', Control: 'Control_L', Alt: 'Alt_L', alt: 'Alt_L', Shift: 'Shift_L', shift: 'Shift_L', Meta: 'Super_L', meta: 'Super_L', Enter: 'Return', Escape: 'Escape', Esc: 'Escape', ' ': 'space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backspace: 'BackSpace' });
  const parsedKey = value => {
    const source = safeText(value, 'event.key', 64);
    const parts = source === ' ' ? [' '] : source.split('+');
    const keys = [...new Set(parts.map(part => keyNames[part] || part))];
    if (!keys.length || keys.some(key => !/^[A-Za-z0-9_:-]+$/u.test(key))) throw inputError('event.key contains unsupported characters');
    return { primary: keys.at(-1), modifiers: keys.slice(0, -1) };
  };
  const pressKey = async (value, action = 'tap') => {
    const { primary, modifiers } = parsedKey(value);
    if (action === 'up') {
      keyPresses.delete(primary);
      syntheticModifiers.delete(primary);
      const release = [primary, ...[...syntheticModifiers].filter(key => !keyPresses.has(key) && ![...keyPresses.values()].some(press => press.modifiers.includes(key)))];
      await runXdotool(['keyup', ...release]);
      for (const key of release) { pressedKeys.delete(key); syntheticModifiers.delete(key); }
      return;
    }
    if (action !== 'down' && action !== 'tap') throw inputError('event.key action must be down or up');
    if (action === 'down' && keyPresses.has(primary)) return runXdotool(['keydown', primary]);
    const addedModifiers = modifiers.filter(key => !pressedKeys.has(key));
    await runXdotool(['keydown', ...addedModifiers, primary]);
    for (const key of [...addedModifiers, primary]) pressedKeys.add(key);
    if (action === 'down') { for (const key of addedModifiers) syntheticModifiers.add(key); keyPresses.set(primary, { modifiers }); return; }
    await runXdotool(['keyup', primary, ...addedModifiers.toReversed()]);
    for (const key of [primary, ...addedModifiers]) pressedKeys.delete(key);
  };
  const releasePressedInput = async () => {
    const buttons = [...pressedButtons], keys = [...pressedKeys];
    pressedButtons.clear(); pressedKeys.clear(); syntheticModifiers.clear(); keyPresses.clear(); inputOwner = undefined;
    // Never call ensureDisplay here: cleanup must not create a fresh Xvfb.
    if (!xvfb || xvfb.killed) return;
    for (const button of buttons) await exec('xdotool', ['mouseup', String(button)], { env: environment, timeout: 2000 }).catch(() => {});
    if (keys.length) await exec('xdotool', ['keyup', ...keys], { env: environment, timeout: 2000 }).catch(() => {});
  };
  const stopClipboardOwner = async owner => {
    clipboardOwners.delete(owner);
    const child = owner.child;
    if (child.exitCode !== null) return;
    try { child.kill('SIGTERM'); } catch { /* 进程已退出 */ }
    await Promise.race([owner.closed, new Promise(resolve => setTimeout(resolve, 200))]);
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* 进程已退出 */ } }
  };
  const releaseClipboardOwners = async () => { await Promise.all([...clipboardOwners].map(stopClipboardOwner)); };
  // xclip must own the selection while the target requests its data. Waiting
  // for it to exit before sending paste deadlocks. Keep a tracked foreground
  // owner, verify its UTF-8 value, then hand it to the caller.
  const ownClipboard = async text => {
    await ensureDisplay();
    // 新写入就是新的 selection；旧的 owner 必须先退出，不能留下两份文本。
    await releaseClipboardOwners();
    const child = spawn('xclip', ['-quiet', '-selection', 'clipboard', '-display', display, '-loops', '0', '-target', 'UTF8_STRING'], { env: environment, stdio: ['pipe', 'ignore', 'pipe'] });
    const owner = { child, stderr: '', closed: new Promise(resolve => child.once('close', resolve)) };
    let spawnFailure;
    child.on('error', error => { spawnFailure = error; });
    child.stderr?.on('data', chunk => { owner.stderr = (owner.stderr + chunk.toString('utf8')).slice(-2048); });
    child.stdin.on('error', () => {});
    child.stdin.end(text, 'utf8');
    try {
      const deadline = Date.now() + 2000;
      let ready = false;
      while (Date.now() < deadline) {
        if (spawnFailure || child.exitCode !== null) throw spawnFailure || new Error(owner.stderr || 'clipboard owner exited');
        try {
          const selected = await exec('xclip', ['-selection', 'clipboard', '-out', '-display', display, '-target', 'UTF8_STRING'], { env: environment, encoding: 'utf8', timeout: 500, maxBuffer: DESKTOP_CLIPBOARD_MAX_BYTES });
          if (selected.stdout === text) { ready = true; break; }
        } catch { /* the owner may still be establishing the selection */ }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!ready) throw new Error('clipboard selection did not become ready');
      clipboardOwners.add(owner);
      return owner;
    } catch (error) {
      await stopClipboardOwner(owner);
      throw error;
    }
  };
  const readClipboard = async () => {
    await ensureDisplay();
    try {
      const result = await exec('xclip', ['-selection', 'clipboard', '-out', '-display', display, '-target', 'UTF8_STRING'], { env: environment, encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024 });
      return truncateUtf8(result?.stdout, DESKTOP_CLIPBOARD_MAX_BYTES);
    } catch {
      // 没有 owner、selection 为空或 X 尚不可用都等价于“没有可读文本”，
      // 读剪贴板不能因为空 selection 打断宿主同步。
      return '';
    }
  };
  const writeClipboard = async text => {
    const value = String(text ?? '');
    try { await ownClipboard(value); }
    catch (error) { throw Object.assign(new Error(`desktop clipboard write failed: ${error.message}`), { code: 'DESKTOP_CLIPBOARD_FAILED', cause: error }); }
    // owner 进程留在后台继续提供 selection，直到下一次写入或桌面停止。
    return { written: true };
  };
  const pasteText = async text => {
    let owner;
    try {
      owner = await ownClipboard(text);
      const requestsSeen = () => Math.max(0, ...Array.from(owner.stderr.matchAll(/Waiting for selection request number (\d+)/gu), match => Number(match[1])));
      const beforePaste = requestsSeen();
      await pressKey('ctrl+shift+v');
      // The key event is queued by X11 before the target asks for selection
      // data. xclip reports that request in quiet mode; keep it alive until
      // this transfer completes, with a bounded fallback for slow clients.
      const deadlinePaste = Date.now() + 1000;
      while (requestsSeen() <= beforePaste && Date.now() < deadlinePaste) await new Promise(resolve => setTimeout(resolve, 10));
      if (requestsSeen() <= beforePaste) throw new Error('focused application did not consume pasted text');
    } catch (error) {
      throw Object.assign(new Error(`desktop clipboard input failed: ${error.message}`), { code: 'DESKTOP_CLIPBOARD_FAILED', cause: error });
    } finally {
      if (owner) await stopClipboardOwner(owner);
    }
  };
  const injectInput = async event => {
    if (!event || typeof event !== 'object') throw inputError('event must be an object');
    const type = safeText(event.type, 'event.type', 32);
    if (type === 'pointermove') return runXdotool(['mousemove', String(clamp(event.x, 0, width - 1)), String(clamp(event.y, 0, height - 1))]);
    if (type === 'button') {
      const button = Number(event.button || 1);
      if (![1, 2, 3].includes(button)) throw inputError('button must be 1, 2 or 3');
      if (event.x !== undefined || event.y !== undefined) await runXdotool(['mousemove', String(clamp(event.x, 0, width - 1)), String(clamp(event.y, 0, height - 1))]);
      if (event.action === 'up') { pressedButtons.delete(button); return runXdotool(['mouseup', String(button)]); }
      if (event.action === 'down') { pressedButtons.add(button); return runXdotool(['mousedown', String(button)]); }
      if (event.action === 'double') return runXdotool(['click', '--repeat', '2', '--delay', '100', String(button)]);
      return runXdotool(['click', String(button)]);
    }
    if (type === 'wheel') {
      const amount = clamp(event.deltaY || event.delta || 0, -20, 20);
      const button = amount < 0 ? 4 : 5;
      return runXdotool(['click', '--repeat', String(Math.max(1, Math.min(20, Math.abs(amount)))), String(button)]);
    }
    if (type === 'text') {
      const text = safeText(event.text, 'event.text', 16 * 1024);
      if (text.length <= 64 && /^[\x20-\x7e]+$/u.test(text)) {
        // 只有没有物理按住的键/鼠标时才清修饰键，避免 Shift+点击/拖动被破坏。
        const clearModifiers = pressedKeys.size === 0 && pressedButtons.size === 0 ? ['--clearmodifiers'] : [];
        try { return await runXdotool(['type', ...clearModifiers, '--delay', '0', '--', text]); }
        catch (error) { throw Object.assign(new Error(`desktop text input failed: ${error.message}`), { code: 'DESKTOP_TEXT_INPUT_FAILED', cause: error }); }
      }
      return pasteText(text);
    }
    if (type === 'key') {
      return pressKey(event.key, event.action || 'tap');
    }
    throw inputError(`unsupported desktop input type: ${type}`);
  };
  const touchActivity = () => { lastActivityAt = now(); for (const session of sessions.values()) session.lastInputAt = now(); };
  const encodeFrame = (bytes, session, frameSequence) => ({ sessionId: session.sessionId, seq: frameSequence ?? ++sequence, format: 'jpeg', width, height, bytes: bytes.length, data: bytes });
  const describe = session => ({ sessionId: session.sessionId, readOnly: !session.controllable, controllable: session.controllable, controlEpoch: session.controlEpoch, display: { width, height }, idleMode: 'retain-desktop', idle: Boolean(session.idle), idleTimeoutMs, idleRetentionMs, frameMaxBytes: DESKTOP_MAX_FRAME_BYTES, captureFps: DESKTOP_CAPTURE_FPS });
  const openSession = async ({ identity, botId = null, controllable = false, leaseId = null, taskId = null, releaseLeaseOnIdle = false } = {}) => {
    await ensureDisplay();
    lastActivityAt = now();
    const sessionId = randomUUID();
    const session = { sessionId, identity: Object.freeze({ ...identity }), botId, taskId, controllable: Boolean(controllable), leaseId, releaseLeaseOnIdle: Boolean(releaseLeaseOnIdle), controlEpoch: 0, idle: false, createdAt: now(), lastInputAt: now(), lastFrameAt: 0, lastFrame: null };
    sessions.set(sessionId, session);
    return describe(session);
  };
  const getSession = sessionId => sessions.get(String(sessionId || ''));
  const idleError = () => Object.assign(new Error('desktop session is idle'), { code: 'DESKTOP_SESSION_IDLE', status: 409 });
  const suspendSession = async sessionId => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    if (session.idleTransition) await session.idleTransition;
    if (session.idle) return describe(session);
    const owner = { sessionId: session.sessionId, botId: session.botId, taskId: session.taskId, leaseId: session.leaseId, releaseLeaseOnIdle: session.releaseLeaseOnIdle };
    session.idle = true; session.idleAt = now(); session.controllable = false; session.leaseId = null; session.lastFrame = null; session.controlEpoch += 1;
    flushPendingText();
    session.idleTransition = (async () => {
      if (inputOwner === session.sessionId) await enqueueInput(releasePressedInput);
      // 输入已释放后才能让其他 Bot 获得租约；不能先删租约再释放修饰键。
      await onIdle?.(owner);
      if (![...sessions.values()].some(value => !value.idle)) await stopCollector();
    })();
    try { await session.idleTransition; } finally { session.idleTransition = null; }
    return describe(session);
  };
  const resumeSession = async ({ sessionId, controllable = false, leaseId = null, releaseLeaseOnIdle = false } = {}) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    await session.idleTransition;
    if (!session.idle) throw Object.assign(new Error('desktop session is already active'), { code: 'DESKTOP_SESSION_ALREADY_ACTIVE', status: 409 });
    await ensureDisplay();
    if (getSession(sessionId) !== session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    session.idle = false; session.idleAt = null; session.controllable = Boolean(controllable); session.leaseId = leaseId;
    session.controlEpoch += 1;
    session.releaseLeaseOnIdle = Boolean(releaseLeaseOnIdle); session.lastInputAt = now(); session.lastFrameAt = 0; lastActivityAt = now();
    return describe(session);
  };
  const frameBinary = async ({ sessionId, afterSeq } = {}) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    if (session.idle) { if (![...sessions.values()].some(value => !value.idle)) await stopCollector(); throw idleError(); }
    await ensureDisplay();
    if (getSession(sessionId) !== session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    if (session.idle) throw idleError();
    const nowValue = now();
    const active = nowValue - session.lastInputAt < DESKTOP_ACTIVITY_WINDOW_MS;
    const cadence = { nextFrameDelayMs: active ? DESKTOP_ACTIVE_INTERVAL_MS : DESKTOP_IDLE_INTERVAL_MS, captureFps: DESKTOP_CAPTURE_FPS };
    if (!active && session.lastFrame && nowValue - session.lastFrameAt < DESKTOP_IDLE_INTERVAL_MS) return { ...session.lastFrame, ...cadence, sessionId, unchanged: true, afterSeq: Number(afterSeq || 0) };
    const bytes = await captureFrame();
    if (getSession(sessionId) !== session) { if (sessions.size === 0) await stopCollector(); throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 }); }
    if (session.idle) { if (![...sessions.values()].some(value => !value.idle)) await stopCollector(); throw idleError(); }
    if (!Buffer.isBuffer(bytes) || bytes.length > DESKTOP_MAX_FRAME_BYTES) throw Object.assign(new Error(`desktop frame exceeds ${DESKTOP_MAX_FRAME_BYTES} bytes`), { code: 'DESKTOP_FRAME_TOO_LARGE' });
    const output = { ...encodeFrame(bytes, session, capture ? undefined : latestFrame.seq), ...cadence };
    if (Number(afterSeq || 0) >= output.seq) return { ...output, unchanged: true };
    session.lastFrame = output;
    session.lastFrameAt = nowValue;
    return output;
  };
  const frame = async options => { const result = await frameBinary(options); return { ...result, data: result.data?.toString('base64') }; };
  const input = async ({ sessionId, event, controlEpoch } = {}) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    if (session.idle) throw idleError();
    if (!session.controllable || !session.leaseId) throw Object.assign(new Error('desktop session is read-only'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
    const inputLease = session.leaseId;
    const inputEpoch = controlEpoch ?? session.controlEpoch;
    const validateControl = () => {
      if (!getSession(sessionId)) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
      if (session.idle || !session.controllable || session.leaseId !== inputLease || session.controlEpoch !== inputEpoch) throw Object.assign(new Error('desktop control lease changed'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
    };
    validateControl();
    const execute = async inputEvent => {
      validateControl();
      touchActivity(); inputOwner = sessionId;
      await injectInput(inputEvent);
      return { accepted: true, sessionId, at: now() };
    };
    if (event?.type === 'text') {
      const text = safeText(event.text, 'event.text', 16 * 1024);
      if (pendingText?.sessionId === sessionId && pendingText.leaseId === inputLease && pendingText.epoch === inputEpoch && pendingText.text.length + text.length <= 16 * 1024) {
        pendingText.text += text;
        return pendingText.result;
      }
      flushPendingText();
      let flush;
      const ready = new Promise(resolve => { flush = resolve; });
      const batch = { sessionId, leaseId: inputLease, epoch: inputEpoch, text, flush };
      pendingText = batch;
      batch.timer = setTimeout(() => { if (pendingText === batch) flushPendingText(); }, DESKTOP_TEXT_COALESCE_MS);
      batch.result = enqueueInput(async () => { await ready; return execute({ type: 'text', text: batch.text }); });
      return batch.result;
    }
    flushPendingText();
    return enqueueInput(() => execute(event));
  };
  const setSessionControl = async ({ sessionId, controllable = false, leaseId = null, taskId, controlEpoch } = {}) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    if (controlEpoch !== undefined && controlEpoch !== session.controlEpoch) throw Object.assign(new Error('desktop control lease changed'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
    // 先封住旧代次，再等待已开始的输入结束并清键；旧排队事件不得借新租约执行。
    const epoch = ++session.controlEpoch;
    session.controllable = false; session.leaseId = null;
    flushPendingText();
    return enqueueInput(async () => {
      if (inputOwner === sessionId) await releasePressedInput();
      if (getSession(sessionId) !== session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
      if (session.controlEpoch !== epoch) throw Object.assign(new Error('desktop control lease changed'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
      session.controllable = Boolean(controllable && leaseId); session.leaseId = session.controllable ? leaseId : null;
      if (taskId !== undefined) session.taskId = taskId;
      return describe(session);
    });
  };
  const closeSession = sessionId => {
    const id = String(sessionId || ''), removed = sessions.delete(id);
    if (pendingText?.sessionId === id) flushPendingText();
    if (inputOwner === id) void enqueueInput(releasePressedInput);
    if (removed && ![...sessions.values()].some(value => !value.idle)) void stopCollector();
    if (removed && sessions.size === 0) lastActivityAt = now();
    return removed;
  };
  const closeSessionsForLease = leaseId => { for (const [id, session] of sessions) if (session.leaseId === leaseId) closeSession(id); };
  const reap = () => {
    for (const [id, session] of sessions) {
      if (session.idle && now() - session.idleAt >= idleRetentionMs) closeSession(id);
      // 活跃会话本身就是观察者；没有输入也不能收回用户正在看的桌面。
    }
    // 没有观察者时仅停采集；X/WM/应用保持到 Pod 退出，恢复后还是原窗口。
    if (sessions.size === 0) void stopCollector();
  };
  const stopDisplay = () => {
    if (displayStopping) return displayStopping;
    const stopping = (async () => {
      await stopLauncher({ permanent: false });
      await releasePressedInput();
      await releaseClipboardOwners();
      await stopCollector();
      const processes = [dockProcess, fileManagerProcess, wm, terminalProcess, xvfb];
      dockProcess = undefined; fileManagerProcess = undefined; wm = undefined; terminalProcess = undefined; xvfb = undefined; displayReady = undefined;
      await Promise.all(processes.map(stopProcess));
      const directory = wmConfiguration; wmConfiguration = undefined;
      if (directory) await rm(directory, { recursive: true, force: true });
      await onStop?.();
    })();
    displayStopping = stopping;
    void stopping.finally(() => { if (displayStopping === stopping) displayStopping = undefined; }).catch(() => {});
    return stopping;
  };
  const dispose = () => { disposed = true; sessions.clear(); flushPendingText(); clearInterval(reaper); return inputQueue.then(stopDisplay); };
  const stats = () => ({ display, width, height, sessions: sessions.size, idleSessions: [...sessions.values()].filter(value => value.idle).length, xserverRunning: Boolean(xvfb && xvfb.exitCode === null), windowManagerRunning: Boolean(wm && wm.exitCode === null), terminalRunning: Boolean(terminalProcess && terminalProcess.exitCode === null), dockRunning: Boolean(dockProcess && dockProcess.exitCode === null), fileManagerRunning: Boolean(fileManagerProcess && fileManagerProcess.exitCode === null), collectorRunning: Boolean(collector && collector.exitCode === null), collectorPid: collector?.pid, captureFps: DESKTOP_CAPTURE_FPS, capturedFrames, droppedFrames, lastActivityAt });
  const reaper = setInterval(reap, 1000);
  reaper.unref?.();
  const windows = async () => {
    await ensureDisplay();
    const result = await exec('xprop', ['-root', '_NET_CLIENT_LIST'], { env: environment, timeout: 2000 });
    const ids = [...new Set(String(result.stdout).match(/0x[0-9a-f]+/giu) || [])].filter(id => Number(id) > 0).slice(0, 64);
    return Promise.all(ids.map(async windowId => {
      const name = await exec('xdotool', ['getwindowname', windowId], { env: environment, timeout: 2000 });
      return { windowId, title: String(name.stdout).trim().slice(0, 512) };
    }));
  };
  const focusWindow = async (windowId, beforeCommand) => {
    const id = String(windowId || '');
    if (!/^0x[0-9a-f]{1,16}$/iu.test(id) || !(await windows()).some(row => Number(row.windowId) === Number(id))) throw inputError('windowId must identify a current desktop window');
    beforeCommand?.();
    await exec('xdotool', ['windowactivate', '--sync', id], { env: environment, timeout: 2000 });
    return { windowId: id, focused: true };
  };
  return Object.freeze({ openSession, getSession, suspendSession, resumeSession, setSessionControl, frame, frameBinary, input, closeSession, closeSessionsForLease, ensureDisplay, stopLauncher, dispose, stats, injectInput, captureFrame, windows, focusWindow, launchApplication, readClipboard, writeClipboard, get welcomeUrl() { return welcomeUrl; } });
}
