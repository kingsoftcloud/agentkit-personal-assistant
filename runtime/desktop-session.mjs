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

const execFile = promisify(execFileCallback);
export const DESKTOP_WIDTH = 1280;
export const DESKTOP_HEIGHT = 800;
export const DESKTOP_MAX_FRAME_BYTES = 300 * 1024;
export const DESKTOP_ACTIVE_INTERVAL_MS = 100;
export const DESKTOP_IDLE_INTERVAL_MS = 1000;
export const DESKTOP_IDLE_TIMEOUT_MS = Number(process.env.AGENTKIT_DESKTOP_IDLE_TIMEOUT_MS || 60_000);

const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.round(Number(value))));
const inputError = (message, code = 'DESKTOP_INPUT_INVALID', status = 400) => Object.assign(new Error(message), { code, status });

function safeText(value, name, max = 4096) {
  const result = String(value ?? '');
  if (!result || result.length > max || /[\u0000\r\n]/u.test(result)) throw inputError(`${name} is invalid`);
  return result;
}

export function createDesktopController({
  display = process.env.DISPLAY || ':99',
  width = DESKTOP_WIDTH,
  height = DESKTOP_HEIGHT,
  spawn = spawnChild,
  exec = execFile,
  now = () => Date.now(),
  capture = null,
  terminal = true,
  onStop = null,
} = {}) {
  const sessions = new Map();
  let xvfb;
  let wm;
  let terminalProcess;
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
  const enqueueInput = operation => {
    const pending = inputQueue.then(operation);
    inputQueue = pending.catch(() => {});
    return pending;
  };

  const environment = Object.freeze({ ...process.env, DISPLAY: display, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  const spawnDisplay = () => {
    if (xvfb && xvfb.exitCode === null && !xvfb.killed) return;
    xvfb = spawn('Xvfb', [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-ac'], { env: environment, stdio: 'ignore' });
    xvfb.once?.('exit', () => { xvfb = undefined; displayReady = undefined; });
  };
  const spawnWindowManager = () => {
    if (wm && wm.exitCode === null && !wm.killed) return;
    wm = spawn('fluxbox', ['-display', display, '-no-slit', '-no-toolbar'], { env: environment, stdio: 'ignore' });
    wm.once?.('exit', () => { wm = undefined; });
  };
  const spawnTerminal = () => {
    if (!terminal || (terminalProcess && terminalProcess.exitCode === null && !terminalProcess.killed)) return;
    // Use the image's fontconfig fonts; xterm's legacy bitmap font is absent
    // from the deliberately small desktop image and cannot render Unicode.
    terminalProcess = spawn('xterm', ['-display', display, '-u8', '-fa', 'DejaVu Sans Mono', '-fs', '12', '-xrm', 'XTerm*VT100.translations: #override\\nCtrl Shift <Key>V: insert-selection(CLIPBOARD)', '-geometry', '96x28+20+20', '-title', 'AgentKit Cloud Desktop'], { env: environment, stdio: 'ignore' });
    terminalProcess.once?.('exit', () => { terminalProcess = undefined; });
  };
  const waitDisplay = async () => {
    if (displayReady) return displayReady;
    displayReady = (async () => {
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
      spawnWindowManager();
      spawnTerminal();
      return true;
    })();
    try { await displayReady; } catch (error) { displayReady = undefined; throw error; }
    return displayReady;
  };
  const ensureDisplay = async () => {
    if (disposed) throw Object.assign(new Error('desktop controller is disposed'), { code: 'DESKTOP_DISPOSED' });
    await waitDisplay();
    lastActivityAt = now();
  };
  const captureFrame = async () => {
    await ensureDisplay();
    if (capture) return capture({ display, width, height });
    const qualities = [72, 60, 48, 36];
    let last;
    for (const quality of qualities) {
      try {
        const result = await exec('import', ['-display', display, '-window', 'root', '-quality', String(quality), 'jpeg:-'], { env: environment, encoding: 'buffer', maxBuffer: DESKTOP_MAX_FRAME_BYTES + 64 * 1024 });
        const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
        if (bytes.length <= DESKTOP_MAX_FRAME_BYTES) return bytes;
        last = bytes;
      } catch (error) { last = error; }
    }
    if (Buffer.isBuffer(last)) throw Object.assign(new Error(`desktop frame exceeds ${DESKTOP_MAX_FRAME_BYTES} bytes`), { code: 'DESKTOP_FRAME_TOO_LARGE' });
    throw Object.assign(new Error('desktop frame capture failed'), { code: 'DESKTOP_FRAME_CAPTURE_FAILED', cause: last });
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
      return pasteText(text);
    }
    if (type === 'key') {
      return pressKey(event.key, event.action || 'tap');
    }
    throw inputError(`unsupported desktop input type: ${type}`);
  };
  const touchActivity = () => { lastActivityAt = now(); for (const session of sessions.values()) session.lastInputAt = now(); };
  const encodeFrame = (bytes, session) => ({ sessionId: session.sessionId, seq: ++sequence, format: 'jpeg', width, height, bytes: bytes.length, data: bytes });
  const openSession = async ({ identity, controllable = false, leaseId = null, taskId = null } = {}) => {
    await ensureDisplay();
    const sessionId = randomUUID();
    const session = { sessionId, identity: Object.freeze({ ...identity }), controllable: Boolean(controllable), leaseId, taskId, createdAt: now(), lastInputAt: now(), lastFrameAt: 0, lastFrame: null };
    sessions.set(sessionId, session);
    return { sessionId, readOnly: !session.controllable, controllable: session.controllable, display: { width, height }, idleTimeoutMs: DESKTOP_IDLE_TIMEOUT_MS, frameMaxBytes: DESKTOP_MAX_FRAME_BYTES };
  };
  const getSession = sessionId => sessions.get(String(sessionId || ''));
  const frameBinary = async ({ sessionId, afterSeq } = {}) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    await ensureDisplay();
    const nowValue = now();
    const active = nowValue - session.lastInputAt < 1000;
    if (!active && session.lastFrame && nowValue - session.lastFrameAt < DESKTOP_IDLE_INTERVAL_MS) return { ...session.lastFrame, sessionId, unchanged: true, afterSeq: Number(afterSeq || 0) };
    const bytes = await captureFrame();
    if (!Buffer.isBuffer(bytes) || bytes.length > DESKTOP_MAX_FRAME_BYTES) throw Object.assign(new Error(`desktop frame exceeds ${DESKTOP_MAX_FRAME_BYTES} bytes`), { code: 'DESKTOP_FRAME_TOO_LARGE' });
    const output = encodeFrame(bytes, session);
    session.lastFrame = output;
    session.lastFrameAt = nowValue;
    return output;
  };
  const frame = async options => { const result = await frameBinary(options); return { ...result, data: result.data?.toString('base64') }; };
  const input = async ({ sessionId, event } = {}) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    if (!session.controllable || !session.leaseId) throw Object.assign(new Error('desktop session is read-only'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
    return enqueueInput(async () => {
      if (!getSession(sessionId)) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
      touchActivity(); inputOwner = sessionId;
      await injectInput(event);
      return { accepted: true, sessionId, at: now() };
    });
  };
  const closeSession = sessionId => {
    const id = String(sessionId || ''), removed = sessions.delete(id);
    if (inputOwner === id) void enqueueInput(releasePressedInput);
    return removed;
  };
  const closeSessionsForLease = leaseId => { for (const [id, session] of sessions) if (session.leaseId === leaseId) closeSession(id); };
  const reap = () => {
    if (sessions.size === 0 && lastActivityAt && now() - lastActivityAt >= DESKTOP_IDLE_TIMEOUT_MS) stopDisplay();
  };
  const stopDisplay = () => {
    void releasePressedInput();
    if (wm) { try { wm.kill('SIGTERM'); } catch {} wm = undefined; }
    if (xvfb) { try { xvfb.kill('SIGTERM'); } catch {} xvfb = undefined; }
    if (terminalProcess) { try { terminalProcess.kill('SIGTERM'); } catch {} terminalProcess = undefined; }
    displayReady = undefined;
    try { void onStop?.(); } catch { /* cleanup callback is best effort */ }
  };
  const dispose = () => { disposed = true; sessions.clear(); stopDisplay(); };
  const stats = () => ({ display, width, height, sessions: sessions.size, xserverRunning: Boolean(xvfb && xvfb.exitCode === null), windowManagerRunning: Boolean(wm && wm.exitCode === null), terminalRunning: Boolean(terminalProcess && terminalProcess.exitCode === null), lastActivityAt });
  const reaper = setInterval(reap, 1000);
  reaper.unref?.();
  return Object.freeze({ openSession, getSession, frame, frameBinary, input, closeSession, closeSessionsForLease, ensureDisplay, dispose, stats, injectInput, captureFrame });
}
