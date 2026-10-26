import { createServer, createConnection } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const actions = new Set(['browser', 'terminal', 'files']);
const MAX_REQUEST_BYTES = 256;
const failure = (code, message) => Object.assign(new Error(message), { code });
const assertRequest = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,v' || value.v !== 1 || !actions.has(value.action)) {
    throw failure('DESKTOP_LAUNCH_INVALID', '桌面入口仅接受浏览器、终端或文件管理器');
  }
  return value.action;
};

// 此 socket 只承接本机桌面的固定应用入口，不提供 URL、路径、命令或远程输入接口。
export async function createDesktopLauncherServer({ launch, timeoutMs = 3000, onError = () => {} } = {}) {
  const directory = await mkdtemp('/tmp/agentkit-desktop-launcher-');
  await chmod(directory, 0o700);
  const socketPath = join(directory, 'launcher.sock');
  const clients = new Map();
  let closing = false, closePromise;
  const server = createServer(socket => {
    if (closing) { socket.destroy(); return; }
    const controller = new AbortController();
    clients.set(socket, controller);
    let body = Buffer.alloc(0), accepted = false, finished = false, action;
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n');
    };
    const timer = setTimeout(() => {
      controller.abort();
      if (action) onError({ action, code: 'DESKTOP_LAUNCH_TIMEOUT' });
      finish({ ok: false, code: 'DESKTOP_LAUNCH_TIMEOUT' });
    }, timeoutMs);
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); controller.abort(); clients.delete(socket); });
    socket.on('data', chunk => {
      if (accepted || finished) return;
      body = Buffer.concat([body, chunk]);
      if (body.length > MAX_REQUEST_BYTES) { controller.abort(); finish({ ok: false, code: 'DESKTOP_LAUNCH_INVALID' }); return; }
      if (!body.includes(10)) return;
      accepted = true;
      try { action = assertRequest(JSON.parse(body.toString('utf8'))); }
      catch { finish({ ok: false, code: 'DESKTOP_LAUNCH_INVALID' }); return; }
      void (async () => {
        try {
          if (closing || controller.signal.aborted) throw failure('DESKTOP_LAUNCH_CLOSED', '桌面入口已停止');
          await launch(action, { signal: controller.signal });
          if (closing || controller.signal.aborted) throw failure('DESKTOP_LAUNCH_CLOSED', '桌面入口已停止');
          finish({ ok: true });
        } catch (error) {
          if (!closing && !controller.signal.aborted) onError({ action, code: String(error.code || 'DESKTOP_LAUNCH_FAILED').slice(0, 64) });
          finish({ ok: false, code: String(error.code || 'DESKTOP_LAUNCH_FAILED').slice(0, 64) });
        }
      })();
    });
  });
  server.maxConnections = 8;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    for (const [socket, controller] of clients) { controller.abort(); socket.destroy(); }
    closePromise = new Promise(resolve => server.close(resolve)).then(() => rm(directory, { recursive: true, force: true }));
    return closePromise;
  };
  return Object.freeze({ socketPath, close });
}

export function requestDesktopLaunch(socketPath, action, { timeoutMs = 3000 } = {}) {
  assertRequest({ v: 1, action });
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(failure('DESKTOP_LAUNCH_TIMEOUT', '桌面入口响应超时')), timeoutMs);
    socket.once('connect', () => socket.write(JSON.stringify({ v: 1, action }) + '\n'));
    socket.on('error', () => finish(failure('DESKTOP_LAUNCH_UNAVAILABLE', '桌面入口暂时不可用')));
    socket.on('data', chunk => {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body) > 1024) { finish(failure('DESKTOP_LAUNCH_INVALID', '桌面入口响应无效')); return; }
      if (!body.includes('\n')) return;
      try {
        const value = JSON.parse(body);
        if (value.ok !== true) throw failure(value.code || 'DESKTOP_LAUNCH_FAILED', '无法打开桌面应用');
        finish(null, value);
      } catch (error) { finish(error); }
    });
    socket.once('close', () => { if (!settled) finish(failure('DESKTOP_LAUNCH_CLOSED', '桌面入口已停止')); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 4 || args[0] !== '--socket' || args[2] !== '--action') throw failure('DESKTOP_LAUNCH_INVALID', '桌面入口参数无效');
    await requestDesktopLaunch(args[1], args[3]);
  } catch (error) { console.error(JSON.stringify({ event: 'desktop-launch-failed', code: error.code || 'DESKTOP_LAUNCH_FAILED' })); process.exitCode = 1; }
}
