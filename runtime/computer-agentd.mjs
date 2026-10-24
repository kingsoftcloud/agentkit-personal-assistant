import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createCloudBrowser } from './cloud-browser.mjs';
import { createCloudExecutor } from './cloud-execution.mjs';
import { createDesktopController } from './desktop-session.mjs';

const host = process.env.COMPUTER_HOST || '127.0.0.1';
const port = Number(process.env.COMPUTER_PORT || 8787);
const workspace = process.env.AGENTKIT_WORKSPACE_DIR || '/workspace';
const identity = Object.freeze({ userId: process.env.USER_ID || '', assistantId: process.env.ASSISTANT_ID || '', computerId: process.env.COMPUTER_ID || '' });
const leases = new Map();
let browser;
let executor;
let desktop;
const closeDesktopBrowser = async () => {
  if (!browser) return;
  const current = browser;
  browser = undefined;
  await current.close?.().catch?.(() => {});
  await current.dispose?.().catch?.(() => {});
};
const ensureDesktopBrowser = async () => {
  browser ||= createCloudBrowser({ workspace });
  if (!browser.available) throw Object.assign(new Error(browser.resolution?.reason || 'desktop browser unavailable'), { code: 'ASSISTANT_BROWSER_UNAVAILABLE', status: 503 });
  // A visible browser window is part of the desktop session.  The desktop
  // mode launcher uses DISPLAY=:99 and kiosk/X11 flags; this is intentionally
  // separate from the headless cloud_browser tool path.
  return browser.open('https://example.com');
};
desktop = createDesktopController({ onStop: closeDesktopBrowser });
const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};
const sendFrame = (response, status, frame) => {
  response.writeHead(status, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-desktop-seq': String(frame.seq || 0), 'x-desktop-width': String(frame.width || 1280), 'x-desktop-height': String(frame.height || 800), 'x-desktop-bytes': String(frame.bytes || 0), ...(frame.unchanged ? { 'x-desktop-unchanged': '1' } : {}) });
  if (frame.data && !frame.unchanged) response.end(Buffer.from(frame.data, 'base64')); else response.end();
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
function expireLeases() {
  const now = Date.now();
  for (const [computerId, lease] of leases) if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= now) leases.delete(computerId);
}
function leaseFor(body) {
  expireLeases();
  const lease = leases.get(body.computerId);
  if (!identityMatches(body) || !lease || lease.leaseId !== body.leaseId || lease.taskId !== body.taskId || lease.expiresAt <= Date.now()) throw new Error('COMPUTER_LEASE_REQUIRED');
  return lease;
}
async function action(body) {
  leaseFor(body);
  const args = body.args || {};
  if (body.action === 'open') return (browser ||= createCloudBrowser({ workspace })).open(args.url);
  if (body.action === 'snapshot') return browser?.snapshot();
  if (body.action === 'click') return browser?.click(args);
  if (body.action === 'type') return browser?.type(args);
  if (body.action === 'press') return browser?.press(args);
  if (body.action === 'screenshot') return browser?.screenshot();
  if (body.action === 'download') return browser?.download(args);
  if (body.action === 'stop') return browser?.close();
  if (body.action === 'terminal.exec') {
    executor ||= createCloudExecutor({ workspaceRoot: workspace });
    return args.language === 'shell' ? executor.runBash(args) : executor.runCode(args);
  }
  throw new Error(`unsupported computer action: ${body.action}`);
}
function desktopIdentity(body) {
  if (!identityMatches(body)) throw Object.assign(new Error('COMPUTER_IDENTITY_MISMATCH'), { code: 'COMPUTER_IDENTITY_MISMATCH', status: 403 });
  return { userId: identity.userId, assistantId: identity.assistantId, computerId: identity.computerId };
}
function desktopLease(body) {
  const lease = leases.get(body.computerId);
  if (!lease || lease.leaseId !== body.leaseId || lease.taskId !== body.taskId || lease.expiresAt <= Date.now()) {
    throw Object.assign(new Error('COMPUTER_LEASE_REQUIRED'), { code: 'COMPUTER_LEASE_REQUIRED', status: 409 });
  }
  return lease;
}
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return send(response, 200, { status: 'ok', ...identity });
  if (request.method === 'GET' && request.url === '/v1/status') return send(response, 200, { status: 'ready', ...identity, capabilities: ['computer-broker/v1'] });
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
      if (leases.has(body.computerId)) return send(response, 409, { error: 'COMPUTER_LEASE_CONFLICT' });
      const ttlMs = Number(body.ttlMs || 60000);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 300000) return send(response, 400, { error: 'COMPUTER_LEASE_TTL_INVALID' });
      const lease = { leaseId: randomUUID(), ...body, expiresAt: Date.now() + ttlMs };
      leases.set(body.computerId, lease);
      return send(response, 200, { protocol: body.protocol, lease });
    }
    if (request.url === '/broker/lease/release') {
      const lease = leases.get(body.computerId);
      const released = Boolean(lease && identityMatches(body) && lease.leaseId === body.leaseId);
      if (released) { leases.delete(body.computerId); desktop.closeSessionsForLease(body.leaseId); }
      return send(response, 200, { protocol: body.protocol, released });
    }
    if (request.url === '/broker/action') return send(response, 200, { protocol: body.protocol, ...(await action(body)) });
    if (request.url === '/broker/desktop/session') {
      const desktopIdentityValue = desktopIdentity(body);
      expireLeases();
      const lease = body.leaseId ? desktopLease({ ...body, ...desktopIdentityValue }) : null;
      const opened = await desktop.openSession({ identity: desktopIdentityValue, controllable: Boolean(lease), leaseId: lease?.leaseId || null, taskId: lease?.taskId || null });
      try { await ensureDesktopBrowser(); }
      catch (error) { desktop.closeSession(opened.sessionId); throw error; }
      return send(response, 200, opened);
    }
    if (request.url === '/broker/desktop/frame') {
      desktopIdentity(body);
      return send(response, 200, await desktop.frame({ sessionId: body.sessionId, afterSeq: body.afterSeq }));
    }
    if (request.url === '/broker/desktop/frame-binary') {
      desktopIdentity(body);
      return sendFrame(response, 200, await desktop.frame({ sessionId: body.sessionId, afterSeq: body.afterSeq }));
    }
    if (request.url === '/broker/desktop/input') {
      desktopIdentity(body);
      const session = desktop.getSession(body.sessionId);
      if (!session || session.identity.computerId !== identity.computerId) throw Object.assign(new Error('DESKTOP_SESSION_NOT_FOUND'), { code: 'DESKTOP_SESSION_NOT_FOUND', status: 404 });
      desktopLease({ ...body, computerId: identity.computerId });
      return send(response, 202, await desktop.input({ sessionId: body.sessionId, event: body.event }));
    }
    if (request.url === '/broker/desktop/close') {
      desktopIdentity(body);
      const closed = desktop.closeSession(body.sessionId);
      if (desktop.stats().sessions === 0) await closeDesktopBrowser();
      return send(response, 200, { closed });
    }
    return send(response, 404, { error: 'not_found' });
  } catch (error) {
    return send(response, Number(error?.status) || 400, { error: error?.code || error?.message || 'COMPUTER_ACTION_FAILED' });
  }
});
server.listen(port, host);
const close = async () => { await browser?.dispose?.(); executor?.dispose?.(); desktop.dispose(); server.close(() => process.exit(0)); };
process.on('SIGTERM', close);
