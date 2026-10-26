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

const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.round(Number(value))));
const inputError = (message, code = 'DESKTOP_INPUT_INVALID', status = 400) => Object.assign(new Error(message), { code, status });

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
} = {}) {
  const sessions = new Map();
  let xvfb;
  let wm;
  let windowManagerFailure;
  let terminalProcess;
  let collector;
  let collectorStarting;
  let collectorStopping;
  let displayStopping;
  let wmConfiguration;
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
  const stopProcess = child => new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    let timer;
    const finish = () => { clearTimeout(timer); resolve(); };
    child.once('exit', finish); child.once('error', finish);
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 500);
    child.kill('SIGTERM');
  });
  const spawnDisplay = () => {
    if (xvfb && xvfb.exitCode === null && !xvfb.killed) return;
    xvfb = spawn('Xvfb', [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-ac'], { env: environment, stdio: 'ignore' });
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
      await writeFile(join(wmConfiguration, 'style'), 'background: solid\nbackground.color: #182233\nwindow.title.height: 24\nwindow.focus.title.color: #34445f\nwindow.label.focus.textColor: #ffffff\nmenu.title.font: Noto Sans CJK SC-10:bold\nmenu.frame.font: Noto Sans CJK SC-10\nmenu.hilite.font: Noto Sans CJK SC-10:bold\nwindow.font: Noto Sans CJK SC-9\ntoolbar.clock.font: Noto Sans CJK SC-9\ntoolbar.workspace.font: Noto Sans CJK SC-9\ntoolbar.iconbar.focused.font: Noto Sans CJK SC-9\ntoolbar.iconbar.unfocused.font: Noto Sans CJK SC-9\n');
      await writeFile(join(wmConfiguration, 'menu'), '[begin] (云电脑)\n[exec] (终端) {/usr/bin/xterm -u8 -fa "Noto Sans Mono CJK SC" -fs 12}\n[end]\n');
      const config = `session.configVersion: 13\nsession.styleFile: ${join(wmConfiguration, 'style')}\nsession.menuFile: ${join(wmConfiguration, 'menu')}\nsession.keyFile: ${join(wmConfiguration, '.fluxbox', 'keys')}\nsession.screen0.rootCommand: /usr/bin/fbsetroot -solid '#182233'\nsession.screen0.workspaces: 1\nsession.screen0.workspaceNames: 云电脑\nsession.screen0.toolbar.visible: false\nsession.screen0.focusModel: ClickFocus\nsession.screen0.clickRaises: true\nsession.screen0.focusNewWindows: true\n`;
      await writeFile(join(wmConfiguration, '.fluxbox', 'init'), config);
      await writeFile(join(wmConfiguration, 'init'), config);
    }
    windowManagerFailure = undefined;
    const child = spawn('fluxbox', ['-display', display, '-rc', join(wmConfiguration, 'init'), '-no-slit', '-no-toolbar'], { env: { ...environment, HOME: wmConfiguration }, stdio: 'ignore' });
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
  const spawnTerminal = () => {
    if (!terminal || (terminalProcess && terminalProcess.exitCode === null && !terminalProcess.killed)) return;
    // Use the image's fontconfig fonts; xterm's legacy bitmap font is absent
    // from the deliberately small desktop image and cannot render Unicode.
    terminalProcess = spawn('xterm', ['-display', display, '-u8', '-fa', 'Noto Sans Mono CJK SC', '-fs', '12', '-xrm', 'XTerm*VT100.translations: #override\\nShift <Key>Insert: insert-selection(PRIMARY,CLIPBOARD)\\nCtrl Shift <Key>V: insert-selection(CLIPBOARD)', '-geometry', '76x27+20+65', '-title', 'AgentKit Cloud Desktop'], { env: environment, stdio: 'ignore' });
    terminalProcess.once?.('exit', () => { terminalProcess = undefined; });
  };
  const waitDisplay = async () => {
    if (displayReady) return displayReady;
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
          const hasWindow = name => {
            const value = output.match(new RegExp(`^${name}\\(WINDOW\\): window id # (0x[0-9a-f]+)\\s*$`, 'im'))?.[1];
            return value !== undefined && BigInt(value) !== 0n;
          };
          wmReady = hasWindow('_NET_SUPPORTING_WM_CHECK') && (!terminal || hasWindow('_NET_ACTIVE_WINDOW'));
          if (windowManagerFailure) throw windowManagerFailure;
          if (wmReady) break;
        } catch (error) { probeError = error; }
        if (windowManagerFailure) throw windowManagerFailure;
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(50, wmDeadline - performance.now()))));
      }
      if (!wmReady) throw Object.assign(new Error(`Fluxbox on ${display} did not publish a ready desktop within ${windowManagerReadyTimeoutMs}ms`), { code: 'DESKTOP_WINDOW_MANAGER_UNAVAILABLE', status: 503, cause: probeError });
      return true;
    })();
    try { await displayReady; } catch (error) { displayReady = undefined; await stopDisplay(); throw error; }
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
      const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-f', 'x11grab', '-draw_mouse', '1', '-video_size', `${width}x${height}`, '-framerate', String(DESKTOP_CAPTURE_FPS), '-i', `${display}.0+0,0`, '-an', '-vf', `setpts=N/(${DESKTOP_CAPTURE_FPS}*TB)`, '-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p', '-filter_threads', '2', '-q:v', '8', '-threads', '2', '-fps_mode', 'passthrough', '-f', 'image2pipe', 'pipe:1'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const keyNames = Object.freeze({ ctrl: 'Control_L', Control: 'Control_L', Alt: 'Alt_L', alt: 'Alt_L', Shift: 'Shift_L', shift: 'Shift_L', Meta: 'Super_L', meta: 'Super_L', Enter: 'Return', Escape: 'Escape', Esc: 'Escape', ' ': 'space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backspace: 'BackSpace' });
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
  const pasteText = async text => {
    await ensureDisplay();
    // xclip must own the selection while the target requests its data. Waiting
    // for it to exit before sending paste deadlocks. Keep a tracked foreground
    // owner, verify its UTF-8 value, send the paste, then reap the owner.
    const child = spawn('xclip', ['-quiet', '-selection', 'clipboard', '-display', display, '-loops', '0', '-target', 'UTF8_STRING'], { env: environment, stdio: ['pipe', 'ignore', 'pipe'] });
    let spawnFailure, stderr = '';
    child.on('error', error => { spawnFailure = error; });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2048); });
    const closed = new Promise(resolve => child.once('close', resolve));
    child.stdin.on('error', () => {});
    child.stdin.end(text, 'utf8');
    try {
      const deadline = Date.now() + 2000;
      let ready = false;
      while (Date.now() < deadline) {
        if (spawnFailure || child.exitCode !== null) throw spawnFailure || new Error(stderr || 'clipboard owner exited');
        try {
          const selected = await exec('xclip', ['-selection', 'clipboard', '-out', '-display', display, '-target', 'UTF8_STRING'], { env: environment, encoding: 'utf8', timeout: 500, maxBuffer: 64 * 1024 });
          if (selected.stdout === text) { ready = true; break; }
        } catch { /* the owner may still be establishing the selection */ }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!ready) throw new Error('clipboard selection did not become ready');
      const requestsSeen = () => Math.max(0, ...Array.from(stderr.matchAll(/Waiting for selection request number (\d+)/gu), match => Number(match[1])));
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
      child.kill('SIGTERM');
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 200))]);
      if (child.exitCode === null) child.kill('SIGKILL');
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
      await releasePressedInput();
      await stopCollector();
      const processes = [wm, terminalProcess, xvfb];
      wm = undefined; terminalProcess = undefined; xvfb = undefined; displayReady = undefined;
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
  const stats = () => ({ display, width, height, sessions: sessions.size, idleSessions: [...sessions.values()].filter(value => value.idle).length, xserverRunning: Boolean(xvfb && xvfb.exitCode === null), windowManagerRunning: Boolean(wm && wm.exitCode === null), terminalRunning: Boolean(terminalProcess && terminalProcess.exitCode === null), collectorRunning: Boolean(collector && collector.exitCode === null), collectorPid: collector?.pid, captureFps: DESKTOP_CAPTURE_FPS, capturedFrames, droppedFrames, lastActivityAt });
  const reaper = setInterval(reap, 1000);
  reaper.unref?.();
  return Object.freeze({ openSession, getSession, suspendSession, resumeSession, setSessionControl, frame, frameBinary, input, closeSession, closeSessionsForLease, ensureDisplay, dispose, stats, injectInput, captureFrame });
}
