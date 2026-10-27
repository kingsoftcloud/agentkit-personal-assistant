import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { verifyDesktopPermit } from './desktop-permit.mjs';
import { createCloudBrowser } from './cloud-browser.mjs';
import { createCloudExecutor } from './cloud-execution.mjs';
import { createDesktopController, DESKTOP_CLIPBOARD_MAX_BYTES } from './desktop-session.mjs';

export function createComputerAgentServer({ env = process.env, desktopFactory = createDesktopController, browserFactory = createCloudBrowser, executorFactory = createCloudExecutor, logger = console } = {}) {
const host = env.COMPUTER_HOST || '127.0.0.1';
const port = Number(env.COMPUTER_PORT || 8787);
const workspace = env.AGENTKIT_WORKSPACE_DIR || '/workspace';
const identity = Object.freeze({ userId: env.USER_ID || '', assistantId: env.ASSISTANT_ID || '', computerId: env.COMPUTER_ID || '' });
const leases = new Map();
const agentDesktopSessions = new Map();
const agentExecutions = new Map();
const controlGrants = new Map(), usedControlPermits = new Map();
const actionContext = new AsyncLocalStorage();
let starting = env.AGENTKIT_DESKTOP_MODE === '1', startupFailure, warmup, warmupMs = 0, closing = false;
let resolveReady, rejectReady, closePromise;
const whenReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
// 库调用方可以只查询 health；主入口仍消费拒绝并明确退出，避免未处理拒绝。
void whenReady.catch(() => {});
let browser;
let desktopBrowserOpening;
let desktopBrowserClosing;
let executor;
let desktop;
// 桌面首屏由 desktop-session 的本地桥提供；浏览器创建时把地址透传过去。
const browserEnv = () => (env.AGENTKIT_DESKTOP_MODE === '1' && typeof desktop?.welcomeUrl === 'string' && desktop.welcomeUrl
  ? { ...env, AGENTKIT_WELCOME_URL: desktop.welcomeUrl } : env);
const browserOptions = () => ({ workspace, env: browserEnv(), beforeCommand: () => { const owner = actionContext.getStore(); if (owner) assertAgentLease(owner); },
  ...(env.AGENTKIT_DESKTOP_MODE === '1' ? { userDataDir: join(env.AGENTKIT_COMPUTER_STATE_DIR || '/var/lib/agentkit/computer', 'chromium-profile'), preserveUserDataDir: true } : {}),
});
const closeDesktopBrowser = () => {
  if (desktopBrowserClosing) return desktopBrowserClosing;
  if (!browser) return Promise.resolve();
  const current = browser;
  desktopBrowserOpening = undefined;
  desktopBrowserClosing = (async () => {
    await current.close?.().catch?.(() => {});
    await current.dispose?.();
    if (browser === current) browser = undefined;
  })();
  // 停止失败保留拒绝状态，不能随后创建第二个进程抢同一持久 profile。
  void desktopBrowserClosing.then(() => { desktopBrowserClosing = undefined; }, () => {});
  return desktopBrowserClosing;
};
// 云端 DSH 网页地址：runtime 侧把 127.0.0.1:8081 的带 token 地址推过来，只存内存、不落盘。
let dshWebUrl = null;
const acceptsDshWebUrl = value => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 512) return false;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch { return false; }
};
const ensureDesktopBrowser = async (options = {}) => {
  if (closing) throw Object.assign(new Error('云电脑正在关闭'), { code: 'DESKTOP_LAUNCH_CLOSED' });
  if (desktopBrowserClosing) await desktopBrowserClosing;
  if (closing) throw Object.assign(new Error('云电脑正在关闭'), { code: 'DESKTOP_LAUNCH_CLOSED' });
  if (desktopBrowserOpening) return desktopBrowserOpening;
  browser ||= browserFactory(browserOptions());
  if (!browser.available) throw Object.assign(new Error(browser.resolution?.reason || 'desktop browser unavailable'), { code: 'ASSISTANT_BROWSER_UNAVAILABLE', status: 503 });
  // 桌面窗口和助理工具始终复用同一个可见 Chromium 实例。
  // 首帧只等待本地窗口，外网页面加载由明确的浏览器操作触发。
  desktopBrowserOpening = browser.openDesktopWindow(options);
  try {
    const result = await desktopBrowserOpening;
    if (closing) throw Object.assign(new Error('云电脑正在关闭'), { code: 'DESKTOP_LAUNCH_CLOSED' });
    return result;
  } finally { desktopBrowserOpening = undefined; }
};
const openDshWeb = async ({ signal } = {}) => {
  if (closing || signal?.aborted) throw Object.assign(new Error('桌面入口已停止'), { code: 'DESKTOP_LAUNCH_CLOSED' });
  if (!dshWebUrl) throw Object.assign(new Error('云端助理网页还没准备好'), { code: 'DSH_WEB_UNAVAILABLE' });
  const target = dshWebUrl;
  const view = await ensureDesktopBrowser({ browsing: true });
  if (closing || signal?.aborted) throw Object.assign(new Error('桌面入口已停止'), { code: 'DESKTOP_LAUNCH_CLOSED' });
  browser ||= browserFactory(browserOptions());
  const page = await browser.navigate(target);
  return { ...view, ...page };
};
desktop = desktopFactory({ applications: env.AGENTKIT_DESKTOP_MODE === '1', workspace,
  dshWebUrl: () => dshWebUrl, onLaunchDshWeb: openDshWeb,
  onLaunchBrowser: async ({ signal } = {}) => {
    if (closing || signal?.aborted) throw Object.assign(new Error('桌面入口已停止'), { code: 'DESKTOP_LAUNCH_CLOSED' });
    // 用户主动点“浏览器”：欢迎页应用窗口切换成带地址栏的普通浏览器窗口。
    const result = await ensureDesktopBrowser({ browsing: true });
    if (closing || signal?.aborted) throw Object.assign(new Error('桌面入口已停止'), { code: 'DESKTOP_LAUNCH_CLOSED' });
    return result;
  },
  onLaunchError: event => logger.error(JSON.stringify({ event: 'desktop-app-launch-failed', ...event })),
  onStop: closeDesktopBrowser, onIdle: async owner => {
  if (!owner.releaseLeaseOnIdle || !owner.leaseId) return;
  const lease = leases.get(identity.computerId);
  if (leaseIdentityMatches(lease, { ...identity, botId: owner.botId, taskId: owner.taskId, leaseId: owner.leaseId })) leases.delete(identity.computerId);
} });
const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};
const sendFrame = (response, status, frame) => {
  response.writeHead(status, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-desktop-seq': String(frame.seq || 0), 'x-desktop-width': String(frame.width || 1280), 'x-desktop-height': String(frame.height || 800), 'x-desktop-bytes': String(frame.bytes || 0), 'x-desktop-next-frame-delay-ms': String(frame.nextFrameDelayMs || 80), ...(frame.unchanged ? { 'x-desktop-unchanged': '1' } : {}) });
  if (frame.data && !frame.unchanged) response.end(frame.data); else response.end();
};
const readBody = request => new Promise((resolve, reject) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(error); }
  });
  request.on('error', reject);
});
function identityMatches(body) {
  return body.userId === identity.userId && body.assistantId === identity.assistantId && body.computerId === identity.computerId;
}
function closeAgentSessions(leaseId) {
  for (const controller of agentExecutions.get(leaseId) || []) controller.abort(Object.assign(new Error('电脑租约已撤销；命令可能已部分执行，请核对结果，不要重放'), { code: 'COMPUTER_LEASE_REVOKED', status: 409 }));
  agentExecutions.delete(leaseId);
  agentDesktopSessions.delete(leaseId); desktop.closeSessionsForLease(leaseId);
}
function expireLeases() {
  const now = Date.now();
  for (const [computerId, lease] of leases) if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= now) {
    if (lease.kind === 'human') {
      if (!lease.expiring) {
        lease.expiring = true;
        void desktop.setSessionControl({ sessionId: lease.sessionId, controllable: false }).finally(() => {
          if (leases.get(computerId) === lease) leases.delete(computerId);
        }).catch(() => {});
      }
      continue;
    }
    leases.delete(computerId);
    closeAgentSessions(lease.leaseId);
  }
}
function leaseIdentityMatches(lease, body) {
  return identityMatches(body) && lease && lease.botId === body.botId && lease.taskId === body.taskId && lease.leaseId === body.leaseId && lease.expiresAt > Date.now();
}
function assertAgentLease(body) {
  actionContext.getStore()?.signal?.throwIfAborted();
  const lease = leaseFor(body);
  if (lease.kind === 'human') throw Object.assign(new Error('用户正在操作云电脑，请等待交还后继续'), { code: 'COMPUTER_USER_CONTROLLED', status: 409 });
  return lease;
}
function leaseFor(body) {
  expireLeases();
  const lease = leases.get(body.computerId);
  if (!leaseIdentityMatches(lease, body)) throw Object.assign(new Error(lease?.kind === 'human' ? '用户正在操作云电脑，请等待交还后继续' : 'COMPUTER_LEASE_REQUIRED'), { code: lease?.kind === 'human' ? 'COMPUTER_USER_CONTROLLED' : 'COMPUTER_LEASE_REQUIRED', status: 409 });
  return lease;
}
async function action(body, { signal } = {}) {
  signal?.throwIfAborted();
  const lease = assertAgentLease(body);
  return actionContext.run({ ...body, leaseId: lease.leaseId, signal }, async () => {
  const args = body.args || {};
  if (body.action.startsWith('desktop.')) {
    let session = desktop.getSession(agentDesktopSessions.get(lease.leaseId));
    if (!session) {
      const opened = await desktop.openSession({ identity, botId: body.botId, taskId: body.taskId, leaseId: lease.leaseId, controllable: true });
      // 预热/打开期间可能已被人接管，旧授权不得跨过异步边界。
      try { assertAgentLease(body); } catch (error) { desktop.closeSession(opened.sessionId); throw error; }
      agentDesktopSessions.set(lease.leaseId, opened.sessionId);
      session = desktop.getSession(opened.sessionId);
    }
    assertAgentLease(body);
    if (body.action === 'desktop.capture') {
      const frame = await desktop.frame({ sessionId: session.sessionId });
      assertAgentLease(body);
      return { image: { data: frame.data, mediaType: 'image/jpeg', width: frame.width, height: frame.height, bytes: frame.bytes } };
    }
    if (body.action === 'desktop.input') {
      const events = args.events ?? [args.event];
      if (!Array.isArray(events) || events.length < 1 || events.length > 32) throw Object.assign(new Error('invalid desktop input batch'), { status: 400 });
      try {
        for (const event of events) {
          assertAgentLease(body);
          await desktop.input({ sessionId: session.sessionId, controlEpoch: session.controlEpoch, event });
        }
        return { accepted: true, events: events.length };
      } catch (error) {
        // 同一手势始终绑定最初租约。接管/错误时关闭旧会话，释放按键，不跨新租约续发剩余事件。
        desktop.closeSession(session.sessionId); agentDesktopSessions.delete(lease.leaseId);
        throw error;
      }
    }
    if (body.action === 'desktop.windows') return { windows: await desktop.windows() };
    if (body.action === 'desktop.focus') return desktop.focusWindow(args.windowId, () => assertAgentLease(body));
    if (body.action === 'desktop.launch') {
      if (!['browser', 'terminal', 'files'].includes(args.application)) throw Object.assign(new Error('unsupported desktop application'), { status: 400 });
      await desktop.launchApplication(args.application, { beforeCommand: () => assertAgentLease(body) });
      assertAgentLease(body);
      return { application: args.application, opened: true };
    }
  }
  if (body.action === 'clipboard.read' || body.action === 'clipboard.write') {
    // 剪贴板是 X11 桌面资源；未启用桌面模式时不能假装同步成功。
    if (env.AGENTKIT_DESKTOP_MODE !== '1') throw Object.assign(new Error('云电脑桌面未启用'), { code: 'DESKTOP_UNAVAILABLE', status: 503 });
    if (body.action === 'clipboard.read') return { text: await desktop.readClipboard() };
    if (typeof args.text !== 'string') throw Object.assign(new Error('clipboard text must be a string'), { code: 'CLIPBOARD_TEXT_INVALID', status: 400 });
    if (Buffer.byteLength(args.text, 'utf8') > DESKTOP_CLIPBOARD_MAX_BYTES) throw Object.assign(new Error(`clipboard text must not exceed ${DESKTOP_CLIPBOARD_MAX_BYTES} bytes`), { code: 'CLIPBOARD_TEXT_TOO_LARGE', status: 413 });
    const written = await desktop.writeClipboard(args.text);
    return { written: written?.written === true };
  }
  if (body.action === 'open') {
    if (env.AGENTKIT_DESKTOP_MODE === '1') {
      await desktop.ensureDisplay();
      assertAgentLease(body);
      await ensureDesktopBrowser();
    }
    assertAgentLease(body);
    return (browser ||= browserFactory(browserOptions())).open(args.url);
  }
  if (body.action === 'snapshot') return browser?.snapshot();
  if (body.action === 'click') return browser?.click(args);
  if (body.action === 'type') return browser?.type(args);
  if (body.action === 'press') return browser?.press(args);
  if (body.action === 'screenshot') return browser?.screenshot();
  if (body.action === 'download') return browser?.download(args);
  if (body.action === 'stop') { desktopBrowserOpening = undefined; return browser?.close(); }
  if (body.action === 'terminal.exec') {
    executor ||= executorFactory({ workspaceRoot: workspace });
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const active = agentExecutions.get(lease.leaseId) || new Set();
    agentExecutions.set(lease.leaseId, active); active.add(controller);
    try {
      assertAgentLease(body);
      return await (args.language === 'shell' ? executor.runBash(args, { signal: controller.signal }) : executor.runCode(args, { signal: controller.signal }));
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason || error : error;
      const failure = reason instanceof Error ? reason : new Error('云端命令已中断');
      if (failure.code !== 'ASSISTANT_CLOUD_EXEC_REFUSED') failure.outcomeUnknown = true;
      throw failure;
    } finally {
      signal?.removeEventListener('abort', abort); active.delete(controller);
      if (!active.size && agentExecutions.get(lease.leaseId) === active) agentExecutions.delete(lease.leaseId);
    }
  }
  throw new Error(`unsupported computer action: ${body.action}`);
  });
}
function desktopIdentity(body) {
  if (!identityMatches(body)) throw Object.assign(new Error('COMPUTER_IDENTITY_MISMATCH'), { code: 'COMPUTER_IDENTITY_MISMATCH', status: 403 });
  return { userId: identity.userId, assistantId: identity.assistantId, computerId: identity.computerId };
}
function desktopLease(body) {
  expireLeases();
  const lease = leases.get(body.computerId);
  if (!leaseIdentityMatches(lease, body)) {
    throw Object.assign(new Error('COMPUTER_LEASE_REQUIRED'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
  }
  return lease;
}
const viewControl = session => ({ sessionId: session.sessionId, readOnly: !session.controllable, controlAvailable: controlGrants.has(session.sessionId), controlEpoch: session.controlEpoch, handoffProtocol: 'desktop-handoff/v1' });
function controlSession(body, checkEpoch = true) {
  desktopIdentity(body);
  const session = desktop.getSession(body.sessionId);
  if (!session) throw Object.assign(new Error('DESKTOP_SESSION_NOT_FOUND'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
  const grant = controlGrants.get(session.sessionId);
  if (!grant || grant.botId !== body.botId || grant.taskId !== body.taskId || session.botId !== body.botId || session.taskId !== body.taskId) throw Object.assign(new Error('桌面只读授权不能取得控制权'), { code: 'DESKTOP_CONTROL_GRANT_REQUIRED', status: 403 });
  if (checkEpoch && (!Number.isSafeInteger(body.controlEpoch) || body.controlEpoch !== session.controlEpoch)) throw Object.assign(new Error('桌面控制代次已改变'), { code: 'DESKTOP_CONTROL_EPOCH_CHANGED', status: 409 });
  return session;
}
async function releaseControl(body) {
  const session = controlSession(body), lease = leases.get(identity.computerId);
  if (!session.controllable) return viewControl(session);
  if (!leaseIdentityMatches(lease, body) || lease.kind !== 'human' || lease.sessionId !== session.sessionId) throw Object.assign(new Error('COMPUTER_LEASE_REQUIRED'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
  // 清掉鼠标/修饰键后才开放租约，避免助理接到卡住的按键状态。
  const changed = await desktop.setSessionControl({ sessionId: session.sessionId, controllable: false, controlEpoch: body.controlEpoch });
  if (leases.get(identity.computerId) === lease) leases.delete(identity.computerId);
  return { ...changed, controlAvailable: true, handoffProtocol: 'desktop-handoff/v1' };
}
const server = createServer(async (request, response) => {
  if (closing) return send(response, 503, { error: 'COMPUTER_CLOSING' });
  if (request.method === 'GET' && ['/health', '/v1/status'].includes(request.url) && (starting || startupFailure)) return send(response, 503, { status: starting ? 'starting' : 'error', error: startupFailure?.code || (startupFailure ? 'DESKTOP_STARTUP_FAILED' : undefined), desktopReady: false, ...identity });
  if (request.method === 'GET' && request.url === '/health') return send(response, 200, { status: 'ok', desktopReady: !starting, warmupMs, ...identity });
  if (request.method === 'GET' && request.url === '/v1/status') return send(response, 200, { status: 'ready', desktopReady: !starting, warmupMs, ...identity, capabilities: ['computer-broker/v1'] });
  if (request.method !== 'POST' || !request.url?.startsWith('/broker/')) return send(response, 404, { error: 'not_found' });
  try {
    const body = await readBody(request);
    if (request.url === '/broker/status') {
      if (!identityMatches(body)) return send(response, 403, { error: 'COMPUTER_IDENTITY_MISMATCH' });
      return send(response, 200, { protocol: body.protocol, computerId: identity.computerId, connected: true });
    }
    if (request.url === '/broker/lease/acquire') {
      expireLeases();
      if (!identityMatches(body)) return send(response, 403, { error: 'COMPUTER_IDENTITY_MISMATCH' });
      if (typeof body.botId !== 'string' || !body.botId.trim() || body.botId.length > 128 || typeof body.taskId !== 'string' || !body.taskId.trim() || body.taskId.length > 128) return send(response, 400, { error: 'COMPUTER_LEASE_IDENTITY_INVALID' });
      const existing = leases.get(body.computerId);
      if (existing && existing.botId === body.botId && existing.taskId === body.taskId && body.idempotencyKey && existing.idempotencyKey === body.idempotencyKey) return send(response, 200, { protocol: body.protocol, lease: existing });
      if (existing) return send(response, 409, { error: existing.kind === 'human' ? 'COMPUTER_USER_CONTROLLED' : 'COMPUTER_LEASE_CONFLICT' });
      const ttlMs = Number(body.ttlMs || 60000);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) return send(response, 400, { error: 'COMPUTER_LEASE_TTL_INVALID' });
      const lease = { ...identity, kind: 'agent', botId: body.botId, taskId: body.taskId, idempotencyKey: body.idempotencyKey, ttlMs, leaseId: randomUUID(), expiresAt: Date.now() + ttlMs };
      leases.set(body.computerId, lease);
      return send(response, 200, { protocol: body.protocol, lease });
    }
    if (request.url === '/broker/lease/renew') {
      const lease = leaseFor(body);
      const ttlMs = Number(body.ttlMs || lease.ttlMs);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) return send(response, 400, { error: 'COMPUTER_LEASE_TTL_INVALID' });
      lease.expiresAt = Date.now() + ttlMs;
      return send(response, 200, { protocol: body.protocol, lease });
    }
    if (request.url === '/broker/lease/release') {
      const lease = leases.get(body.computerId);
      const released = Boolean(leaseIdentityMatches(lease, body));
      if (released && lease.kind === 'human') await releaseControl({ ...body, sessionId: lease.sessionId, controlEpoch: desktop.getSession(lease.sessionId)?.controlEpoch });
      else if (released) { leases.delete(body.computerId); closeAgentSessions(body.leaseId); }
      return send(response, 200, { protocol: body.protocol, released });
    }
    if (request.url === '/broker/action') {
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableEnded) controller.abort(Object.assign(new Error('请求连接已取消；动作可能已部分执行，请核对结果'), { code: 'COMPUTER_ACTION_ABORTED', status: 499 })); };
      response.on('close', disconnected); if (response.destroyed) disconnected();
      try { return send(response, 200, { protocol: body.protocol, ...(await action(body, { signal: controller.signal })) }); }
      finally { response.off('close', disconnected); }
    }
    // 云端 DSH 网页地址：宿主就绪后由运行时写入。这里不涉及桌面控制权（不是桌面动作），
    // 所以不要求 agent lease；只接受本机回环地址，且不落盘、不写日志。
    if (request.url === '/broker/dsh-web') {
      // 注意：请求体在上面已经读过一次，这里不能再 readBody（流已消费会一直挂住）。
      if (!acceptsDshWebUrl(body?.url)) return send(response, 400, { error: 'DSH_WEB_URL_INVALID' });
      dshWebUrl = body.url;
      logger.info(JSON.stringify({ event: 'desktop.dsh-web.registered', host: new URL(body.url).hostname, port: new URL(body.url).port }));
      return send(response, 200, { registered: true });
    }
    if (request.url === '/broker/desktop/session') {
      const desktopIdentityValue = desktopIdentity(body);
      expireLeases();
      let controlGrant;
      if (body.mode === 'observe') {
        const claims = await verifyDesktopPermit(body.controlPermit, { assistantId: identity.assistantId, env });
        if (claims.mode !== 'control' || claims.botId === '__directory__' || claims.botId !== body.botId || !body.taskId || body.leaseId) throw Object.assign(new Error('桌面接管需要具名助理控制授权'), { code: 'DESKTOP_CONTROL_GRANT_REQUIRED', status: 403 });
        for (const [nonce, expiry] of usedControlPermits) if (expiry <= Date.now()) usedControlPermits.delete(nonce);
        if (usedControlPermits.has(claims.jti)) throw Object.assign(new Error('desktop permit already used'), { code: 'DESKTOP_UNAUTHORIZED', status: 401 });
        usedControlPermits.set(claims.jti, claims.exp * 1000);
        controlGrant = { botId: body.botId, taskId: body.taskId };
      }
      const lease = body.leaseId ? desktopLease({ ...body, ...desktopIdentityValue }) : null;
      const opened = await desktop.openSession({ identity: desktopIdentityValue, botId: body.botId || null, controllable: Boolean(lease), leaseId: lease?.leaseId || null, taskId: body.taskId || null, releaseLeaseOnIdle: body.releaseLeaseOnIdle === true });
      try { await ensureDesktopBrowser(); }
      catch (error) { desktop.closeSession(opened.sessionId); throw error; }
      if (controlGrant) controlGrants.set(opened.sessionId, controlGrant);
      return send(response, 200, { ...opened, controlAvailable: Boolean(controlGrant), handoffProtocol: 'desktop-handoff/v1' });
    }
    if (request.url === '/broker/desktop/control/acquire') {
      const session = controlSession(body);
      expireLeases();
      const previous = leases.get(identity.computerId);
      if (previous?.kind === 'human') {
        if (previous.sessionId !== session.sessionId || previous.expiring) return send(response, 409, { error: 'COMPUTER_LEASE_CONFLICT' });
        return send(response, 200, { ...viewControl(session), lease: previous });
      }
      const lease = { ...identity, kind: 'human', sessionId: session.sessionId, botId: body.botId, taskId: body.taskId, leaseId: randomUUID(), ttlMs: 120000, expiresAt: Date.now() + 120000 };
      // 先封住旧助理租约；CDP 每次发命令前会再次检查，旧异步回调不能穿透。
      leases.set(identity.computerId, lease);
      if (previous) closeAgentSessions(previous.leaseId);
      try {
        await browser?.releaseInput?.();
        await ensureDesktopBrowser();
        const changed = await desktop.setSessionControl({ sessionId: session.sessionId, controllable: true, leaseId: lease.leaseId, taskId: body.taskId, controlEpoch: body.controlEpoch });
        return send(response, 200, { ...changed, controlAvailable: true, handoffProtocol: 'desktop-handoff/v1', lease });
      } catch (error) { if (leases.get(identity.computerId) === lease) leases.delete(identity.computerId); throw error; }
    }
    if (request.url === '/broker/desktop/control/state') {
      const session = controlSession(body, false);
      expireLeases();
      const lease = leases.get(identity.computerId);
      return send(response, 200, { ...viewControl(session), lease: lease?.kind === 'human' && lease.sessionId === session.sessionId && !lease.expiring ? lease : null });
    }
    if (request.url === '/broker/desktop/control/release') return send(response, 200, await releaseControl(body));
    if (['/broker/desktop/idle', '/broker/desktop/resume'].includes(request.url)) {
      desktopIdentity(body);
      const session = desktop.getSession(body.sessionId);
      if (!session) throw Object.assign(new Error('DESKTOP_SESSION_NOT_FOUND'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
      if (!session.botId || !session.taskId || session.botId !== body.botId || session.taskId !== body.taskId) throw Object.assign(new Error('DESKTOP_SESSION_OWNER_MISMATCH'), { code: 'DESKTOP_SESSION_OWNER_MISMATCH', status: 403 });
      if (request.url.endsWith('/idle')) {
        if (!session.idle && session.leaseId && (body.leaseId !== session.leaseId || !leaseIdentityMatches(leases.get(identity.computerId), body))) throw Object.assign(new Error('COMPUTER_LEASE_REQUIRED'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
        return send(response, 200, await desktop.suspendSession(body.sessionId));
      }
      const lease = body.leaseId ? desktopLease(body) : null;
      return send(response, 200, await desktop.resumeSession({ sessionId: body.sessionId, controllable: Boolean(lease), leaseId: lease?.leaseId || null, releaseLeaseOnIdle: body.releaseLeaseOnIdle === true }));
    }
    if (request.url === '/broker/desktop/frame') {
      desktopIdentity(body);
      return send(response, 200, await desktop.frame({ sessionId: body.sessionId, afterSeq: body.afterSeq }));
    }
    if (request.url === '/broker/desktop/frame-binary') {
      desktopIdentity(body);
      return sendFrame(response, 200, await desktop.frameBinary({ sessionId: body.sessionId, afterSeq: body.afterSeq }));
    }
    if (request.url === '/broker/desktop/input') {
      desktopIdentity(body);
      const session = desktop.getSession(body.sessionId);
      if (!session || session.identity.computerId !== identity.computerId) throw Object.assign(new Error('DESKTOP_SESSION_NOT_FOUND'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
      if (session.idle) throw Object.assign(new Error('DESKTOP_SESSION_IDLE'), { code: 'DESKTOP_SESSION_IDLE', status: 409 });
      if (controlGrants.has(session.sessionId) && body.controlEpoch !== session.controlEpoch) throw Object.assign(new Error('桌面控制代次已改变'), { code: 'DESKTOP_CONTROL_EPOCH_CHANGED', status: 409 });
      if (session.leaseId !== body.leaseId || session.taskId !== body.taskId) throw Object.assign(new Error('COMPUTER_LEASE_REQUIRED'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
      desktopLease({ ...body, computerId: identity.computerId });
      return send(response, 202, await desktop.input({ sessionId: body.sessionId, event: body.event, controlEpoch: body.controlEpoch }));
    }
    if (request.url === '/broker/desktop/close') {
      desktopIdentity(body);
      const session = desktop.getSession(body.sessionId), lease = leases.get(identity.computerId);
      if (controlGrants.has(body.sessionId) && lease?.kind === 'human' && lease.sessionId === body.sessionId) {
        await releaseControl({ ...body, botId: session.botId, taskId: session.taskId, leaseId: lease.leaseId, controlEpoch: session.controlEpoch });
      }
      const closed = desktop.closeSession(body.sessionId);
      controlGrants.delete(body.sessionId);
      // 关闭观察面板只停止采集，不关闭桌面窗口。
      return send(response, 200, { closed });
    }
    return send(response, 404, { error: 'not_found' });
  } catch (error) {
    if (response.destroyed || response.writableEnded) return;
    return send(response, Number(error?.status) || 400, { error: error?.code || error?.message || 'COMPUTER_ACTION_FAILED', ...(error?.outcomeUnknown ? { outcomeUnknown: true, message: '动作已中断，可能已部分执行；请先核对结果，不要盲目重放' } : {}) });
  }
});
const leaseReaper = setInterval(expireLeases, 1000);
leaseReaper.unref();
const close = () => {
  if (closePromise) return closePromise;
  closing = true; clearInterval(leaseReaper);
  for (const leaseId of agentExecutions.keys()) closeAgentSessions(leaseId);
  closePromise = (async () => {
    const failures = [];
    try { await desktop.stopLauncher?.(); } catch (error) { failures.push(error); }
    await warmup;
    try { await desktop.stopLauncher?.(); } catch (error) { failures.push(error); }
    for (const cleanup of [() => browser?.dispose?.(), () => executor?.dispose?.(), () => desktop.dispose()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    await new Promise(resolve => server.close(resolve));
    if (failures.length) throw new AggregateError(failures, 'computer shutdown cleanup failed');
  })();
  return closePromise;
};
return { server, whenReady, listen: () => server.listen(port, host, () => {
  if (!starting) { resolveReady({ desktopReady: true, warmupMs: 0 }); return; }
  const began = Date.now();
  warmup = (async () => {
    try {
      await desktop.ensureDisplay();
      if (!closing) await ensureDesktopBrowser();
      warmupMs = Date.now() - began;
      if (!closing) logger.info(JSON.stringify({ event: 'desktop-ready', warmupMs, computerId: identity.computerId }));
      resolveReady({ desktopReady: !closing, warmupMs });
    } catch (error) {
      startupFailure = error;
      logger.error(JSON.stringify({ event: 'desktop-startup-failed', code: error.code || 'DESKTOP_STARTUP_FAILED', message: String(error.message).slice(0, 500), diagnostics: error.desktopDiagnostics }));
      rejectReady(error);
    } finally { starting = false; }
  })();
}), close };
}

// 生产入口在一次预热失败后清理并非零退出；恢复由 Kubernetes 显式重启承担。
// exit/onSignal 可注入，单测无需退出测试进程，也不在库内悄悄重试。
export function runComputerAgentDaemon({ service = createComputerAgentServer(), exit = code => process.exit(code), onSignal = handler => { process.once('SIGTERM', handler); process.once('SIGINT', handler); } } = {}) {
  let shutdown, resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const stop = (code = 0) => {
    if (shutdown) return shutdown;
    shutdown = (async () => {
      try { await service.close(); }
      catch (error) { code = 1; console.error(JSON.stringify({ event: 'computer-shutdown-failed', message: String(error.message).slice(0, 500) })); }
      try { exit(code); } finally { resolveStopped(); }
    })();
    return shutdown;
  };
  void service.whenReady.catch(() => stop(1));
  onSignal(() => { void stop(0); });
  service.listen();
  return { service, stop, stopped };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runComputerAgentDaemon();
}
