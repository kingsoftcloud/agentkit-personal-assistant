// 欢迎页本机桥（建议放在 personal-assistant-computer/runtime/welcome-server.mjs）
// 职责：
//   1) 在 127.0.0.1 上起一个只本机可达的 HTTP 服务，静态提供 web/ 目录（无目录穿越）
//   2) POST /launch 只接受 {"action":"browser"|"terminal"|"files"|"dsh"}，再交给 launch() 执行
//   3) GET /dsh-web.json 返回云端 DSH 网页的本机回环地址（由 runtime 侧注入，不落盘、不写日志）
//
// 安全边界（与既有 launcher 一致）：
//   - 只监听 127.0.0.1，端口随机（port 0）
//   - 只允许 GET/HEAD（静态）与 POST（/launch）
//   - 请求体上限 256 字节，content-type 必须是 application/json
//   - action 白名单硬编码，永不接受 URL / 路径 / 命令
//   - 静态路径用 resolve + 前缀校验，且只允许白名单后缀

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const ACTIONS = new Set(['browser', 'terminal', 'files', 'dsh']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
const MAX_BODY = 256;
const failure = (code, message) => Object.assign(new Error(message), { code, expose: true });

const sendJson = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

export async function createWelcomeServer({ webDir, launch, timeoutMs = 8000, onError = () => {}, timeZone = process.env.AGENTKIT_DESKTOP_TIME_ZONE || 'Asia/Shanghai', dshWeb = null }) {
  const root = resolve(webDir);
  let closing = false;
  // 欢迎页时钟按桌面时区显示：容器通常是 UTC，而用户按北京时间读表。
  const config = Object.freeze({ timeZone: String(timeZone) });
  // 云端 DSH 网页地址只允许本机回环：这是同一 Pod 内的服务，不能让欢迎页把用户带去外网。
  const dshWebUrl = () => {
    if (typeof dshWeb !== 'function') return null;
    let value;
    try { value = dshWeb(); } catch { return null; }
    if (typeof value !== 'string' || !value) return null;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return null;
      return parsed.href;
    } catch { return null; }
  };

  const serveStatic = async (pathname, res) => {
    // 只映射到 root 内的白名单后缀文件
    const rel = pathname === '/' || pathname === '/welcome.html' ? 'welcome.html' : pathname.replace(/^\/+/, '');
    const target = resolve(join(root, rel));
    if (target !== root && !target.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const type = MIME[extname(target).toLowerCase()];
    if (!type) { res.writeHead(404).end(); return; }
    let data;
    try { data = await readFile(target); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'content-type': type,
      'content-length': data.length,
      // 每次打开都要拿到最新页面：不缓存
      'cache-control': 'no-store, must-revalidate',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  };

  const handleLaunch = (req, res) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().startsWith('application/json')) { sendJson(res, 415, { ok: false, code: 'WELCOME_CONTENT_TYPE' }); return; }
    let body = Buffer.alloc(0);
    let done = false;
    const finish = (status, value) => { if (done) return; done = true; sendJson(res, status, value); };
    req.on('data', chunk => {
      if (done) return;
      body = Buffer.concat([body, chunk]);
      if (body.length > MAX_BODY) { req.destroy(); finish(413, { ok: false, code: 'WELCOME_BODY_TOO_LARGE' }); }
    });
    req.on('error', () => { if (!done) { done = true; res.destroy(); } });
    req.on('end', () => {
      if (done) return;
      let action;
      try { action = JSON.parse(body.toString('utf8')).action; } catch { finish(400, { ok: false, code: 'WELCOME_INVALID' }); return; }
      if (!ACTIONS.has(action)) { finish(400, { ok: false, code: 'WELCOME_ACTION_DENIED' }); return; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      void (async () => {
        try {
          if (closing) throw failure('WELCOME_CLOSED', '桌面入口已停止');
          await launch(action, { signal: controller.signal });
          if (!done) finish(200, { ok: true });
        } catch (error) {
          const code = String(error && error.code || 'WELCOME_LAUNCH_FAILED').slice(0, 64);
          if (!closing) onError({ action, code });
          if (!done) finish(code === 'WELCOME_CLOSED' ? 503 : 500, { ok: false, code });
        } finally { clearTimeout(timer); }
      })();
    });
  };

  const server = createServer((req, res) => {
    if (closing) { sendJson(res, 503, { ok: false, code: 'WELCOME_CLOSED' }); return; }
    const pathname = (req.url || '/').split('?')[0];
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/config.json') { sendJson(res, 200, config); return; }
      if (pathname === '/dsh-web.json') {
        const url = dshWebUrl();
        if (url) sendJson(res, 200, { url });
        else sendJson(res, 404, { ok: false, code: 'DSH_WEB_UNAVAILABLE' });
        return;
      }
      void serveStatic(pathname, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/launch') { handleLaunch(req, res); return; }
    sendJson(res, 405, { ok: false, code: 'WELCOME_METHOD' });
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const { port } = server.address();

  return Object.freeze({
    port,
    url: `http://127.0.0.1:${port}/welcome.html`,
    async close() {
      closing = true;
      await new Promise(resolvePromise => server.close(() => resolvePromise()));
    },
  });
}
