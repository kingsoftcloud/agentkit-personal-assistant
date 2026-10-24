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
    terminalProcess = spawn('xterm', ['-display', display, '-geometry', '96x28+20+20', '-title', 'AgentKit Cloud Desktop'], { env: environment, stdio: 'ignore' });
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
    await exec('xdotool', args, { env: environment, maxBuffer: 32 * 1024 });
  };
  const pasteText = async text => {
    await ensureDisplay();
    await new Promise((resolve, reject) => {
      // Keep one clipboard owner per paste; without -loops 1 xclip remains
      // resident forever waiting for future selection requests.
      const child = spawn('xclip', ['-selection', 'clipboard', '-display', display, '-loops', '1'], { env: environment, stdio: ['pipe', 'ignore', 'pipe'] });
      const errors = [];
      child.stderr?.on('data', chunk => errors.push(chunk));
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(Object.assign(new Error(Buffer.concat(errors).toString('utf8') || `xclip exited ${code}`), { code: 'DESKTOP_CLIPBOARD_FAILED' })));
      child.stdin.end(text, 'utf8');
    });
    // xdotool's type action only accepts X keysyms and rejects CJK/emoji. The
    // clipboard path preserves UTF-8 and leaves modifier state untouched.
    return runXdotool(['key', 'ctrl+shift+v']);
  };
  const injectInput = async event => {
    if (!event || typeof event !== 'object') throw inputError('event must be an object');
    const type = safeText(event.type, 'event.type', 32);
    if (type === 'pointermove') return runXdotool(['mousemove', '--sync', String(clamp(event.x, 0, width - 1)), String(clamp(event.y, 0, height - 1))]);
    if (type === 'button') {
      const button = Number(event.button || 1);
      if (![1, 2, 3].includes(button)) throw inputError('button must be 1, 2 or 3');
      if (event.x !== undefined || event.y !== undefined) await runXdotool(['mousemove', '--sync', String(clamp(event.x, 0, width - 1)), String(clamp(event.y, 0, height - 1))]);
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
      const key = safeText(event.key, 'event.key', 64);
      if (!/^[A-Za-z0-9+_:-]+$/u.test(key)) throw inputError('event.key contains unsupported characters');
      return runXdotool(['key', key]);
    }
    throw inputError(`unsupported desktop input type: ${type}`);
  };
  const touchActivity = () => { lastActivityAt = now(); for (const session of sessions.values()) session.lastInputAt = now(); };
  const encodeFrame = (bytes, session) => ({ sessionId: session.sessionId, seq: ++sequence, format: 'jpeg', width, height, bytes: bytes.length, data: bytes.toString('base64') });
  const openSession = async ({ identity, controllable = false, leaseId = null, taskId = null } = {}) => {
    await ensureDisplay();
    const sessionId = randomUUID();
    const session = { sessionId, identity: Object.freeze({ ...identity }), controllable: Boolean(controllable), leaseId, taskId, createdAt: now(), lastInputAt: now(), lastFrameAt: 0, lastFrame: null };
    sessions.set(sessionId, session);
    return { sessionId, readOnly: !session.controllable, controllable: session.controllable, display: { width, height }, idleTimeoutMs: DESKTOP_IDLE_TIMEOUT_MS, frameMaxBytes: DESKTOP_MAX_FRAME_BYTES };
  };
  const getSession = sessionId => sessions.get(String(sessionId || ''));
  const frame = async ({ sessionId, afterSeq } = {}) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    await ensureDisplay();
    const nowValue = now();
    const active = nowValue - session.lastInputAt < 1000;
    if (!active && session.lastFrame && nowValue - session.lastFrameAt < DESKTOP_IDLE_INTERVAL_MS) return { ...session.lastFrame, sessionId, unchanged: true, afterSeq: Number(afterSeq || 0) };
    const bytes = await captureFrame();
    const output = encodeFrame(bytes, session);
    session.lastFrame = output;
    session.lastFrameAt = nowValue;
    return output;
  };
  const input = async ({ sessionId, event } = {}) => {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('desktop session not found'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
    if (!session.controllable || !session.leaseId) throw Object.assign(new Error('desktop session is read-only'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
    touchActivity();
    await injectInput(event);
    return { accepted: true, sessionId, at: now() };
  };
  const closeSession = sessionId => sessions.delete(String(sessionId || ''));
  const closeSessionsForLease = leaseId => { for (const [id, session] of sessions) if (session.leaseId === leaseId) sessions.delete(id); };
  const reap = () => {
    if (sessions.size === 0 && lastActivityAt && now() - lastActivityAt >= DESKTOP_IDLE_TIMEOUT_MS) stopDisplay();
  };
  const stopDisplay = () => {
    for (const button of pressedButtons) { try { void runXdotool(['mouseup', String(button)]); } catch {} }
    pressedButtons.clear();
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
  return Object.freeze({ openSession, getSession, frame, input, closeSession, closeSessionsForLease, ensureDisplay, dispose, stats, injectInput, captureFrame });
}
