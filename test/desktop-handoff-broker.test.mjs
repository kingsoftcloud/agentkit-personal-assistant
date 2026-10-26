import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createComputerAgentServer, runComputerAgentDaemon } from '../runtime/computer-agentd.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const env = { USER_ID: 'u', ASSISTANT_ID: 'a', COMPUTER_ID: 'c', COMPUTER_HOST: '127.0.0.1', COMPUTER_PORT: '0',
  AGENTKIT_DESKTOP_JWKS_JSON: JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'handoff-test' }] }) };
function permit(mode = 'control', botId = 'bot') {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'agentkit-desktop+jwt', kid: 'handoff-test' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: 'agentengine-server', aud: 'agentkit-personal-assistant-desktop', scope: 'desktop', agentId: 'a', botId, mode, iat: now, exp: now + 60, jti: randomUUID() })).toString('base64url');
  return `${header}.${body}.${sign(null, Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
}
async function fixture(t, { browserFactory } = {}) {
  const sessions = new Map(), inputs = [];
  const view = session => ({ sessionId: session.sessionId, readOnly: !session.controllable, controlEpoch: session.controlEpoch, idleMode: 'retain-desktop' });
  const service = createComputerAgentServer({ env, browserFactory: browserFactory || (() => ({ available: true, openDesktopWindow: async () => ({}), dispose: async () => {} })), desktopFactory: () => ({
    ensureDisplay: async () => {},
    openSession: async value => { const session = { ...value, sessionId: randomUUID(), controlEpoch: 0 }; sessions.set(session.sessionId, session); return view(session); },
    getSession: id => sessions.get(id),
    setSessionControl: async ({ sessionId, controllable, leaseId, taskId }) => { const session = sessions.get(sessionId); Object.assign(session, { controllable, leaseId, taskId, controlEpoch: session.controlEpoch + 1 }); return view(session); },
    input: async value => { inputs.push(value); return { accepted: true }; },
    closeSessionsForLease: leaseId => { for (const [id, session] of sessions) if (session.leaseId === leaseId) sessions.delete(id); },
    closeSession: id => sessions.delete(id),
    stats: () => ({ sessions: sessions.size }), dispose: async () => {},
    frame: async ({ sessionId }) => ({ sessionId, data: 'frame' }),
  }) });
  service.listen(); await once(service.server, 'listening'); t.after(() => service.close());
  const post = async (path, body = {}) => { const response = await fetch(`http://127.0.0.1:${service.server.address().port}/broker/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u', assistantId: 'a', computerId: 'c', botId: 'bot', taskId: 'human', ...body }) }); return { status: response.status, value: await response.json() }; };
  return { post, sessions, inputs };
}

test('human control requires a signed control grant; read/forged/replayed grants never acquire', async t => {
  const { post } = await fixture(t);
  assert.equal((await post('desktop/session', { mode: 'observe', controlPermit: permit('read') })).status, 403);
  assert.equal((await post('desktop/session', { mode: 'observe', controlPermit: 'forged' })).status, 401);
  const reader = await post('desktop/session', { controlAvailable: true });
  assert.equal((await post('desktop/control/acquire', { sessionId: reader.value.sessionId, controlEpoch: 0 })).status, 403);
  const token = permit();
  const opened = await post('desktop/session', { mode: 'observe', controlPermit: token });
  assert.equal(opened.status, 200); assert.equal(opened.value.controlAvailable, true); assert.equal(opened.value.readOnly, true);
  assert.equal((await post('desktop/session', { mode: 'observe', controlPermit: token })).status, 401);
});

test('human takeover preserves video session, fences old input, rejects second client and releases to agent', async t => {
  const { post, sessions, inputs } = await fixture(t);
  const agentLease = (await post('lease/acquire', { taskId: 'agent-task', ttlMs: 60000 })).value.lease;
  const sessionId = (await post('desktop/session', { mode: 'observe', controlPermit: permit() })).value.sessionId;
  assert.equal((await post('lease/renew', { taskId: 'agent-task', leaseId: agentLease.leaseId })).status, 200);
  const acquired = await post('desktop/control/acquire', { sessionId, controlEpoch: 0 });
  assert.equal(acquired.status, 200); assert.equal(acquired.value.readOnly, false); assert.equal(acquired.value.controlEpoch, 1);
  assert.equal(sessions.has(sessionId), true);
  const leaseId = acquired.value.lease.leaseId;
  assert.equal((await post('action', { taskId: 'agent-task', leaseId: agentLease.leaseId, action: 'stop' })).value.error, 'COMPUTER_USER_CONTROLLED');
  assert.equal((await post('lease/acquire', { botId: 'other', taskId: 'other', kind: 'human' })).status, 409);
  const secondId = (await post('desktop/session', { mode: 'observe', controlPermit: permit(), taskId: 'second-client' })).value.sessionId;
  assert.equal((await post('desktop/control/acquire', { sessionId: secondId, taskId: 'second-client', controlEpoch: 0 })).status, 409);
  assert.equal((await post('desktop/input', { sessionId, leaseId, controlEpoch: 0, event: { type: 'button', action: 'down' } })).status, 409);
  assert.equal((await post('desktop/input', { sessionId, leaseId, controlEpoch: 1, event: { type: 'button', action: 'down' } })).status, 202);
  assert.equal(inputs.length, 1);
  const released = await post('desktop/control/release', { sessionId, leaseId, controlEpoch: 1 });
  assert.equal(released.status, 200); assert.equal(released.value.readOnly, true); assert.equal(released.value.controlEpoch, 2);
  assert.equal((await post('desktop/frame', { sessionId })).status, 200);
  assert.equal(sessions.has(sessionId), true);
  assert.equal((await post('lease/acquire', { botId: 'other', taskId: 'other' })).status, 200);
  assert.equal((await post('desktop/input', { sessionId, leaseId, controlEpoch: 1, event: { type: 'text', text: 'stale' } })).status, 409);
});

test('an agent CDP command already waiting cannot mutate after human takeover', async t => {
  let beforeCommand, reached;
  const ready = new Promise(resolve => { reached = resolve; });
  let proceed;
  const wait = new Promise(resolve => { proceed = resolve; });
  const { post } = await fixture(t, { browserFactory: options => { beforeCommand = options.beforeCommand; return { available: true, openDesktopWindow: async () => ({}), dispose: async () => {}, open: async () => { await beforeCommand(); reached(); await wait; await beforeCommand(); throw new Error('old command escaped fencing'); } }; } });
  const leaseId = (await post('lease/acquire', { taskId: 'agent-task' })).value.lease.leaseId;
  const pending = post('action', { taskId: 'agent-task', leaseId, action: 'open', args: { url: 'https://example.com/' } });
  await ready;
  const sessionId = (await post('desktop/session', { mode: 'observe', controlPermit: permit() })).value.sessionId;
  assert.equal((await post('desktop/control/acquire', { sessionId, controlEpoch: 0 })).status, 200);
  proceed();
  assert.equal((await pending).value.error, 'COMPUTER_USER_CONTROLLED');
});

test('computer readiness stays 503 until the real desktop warmup completes without acquiring a lease', async t => {
  let finishDisplay, browserStarts = 0, disposed = false;
  const displayReady = new Promise(resolve => { finishDisplay = resolve; });
  const service = createComputerAgentServer({ env: { ...env, AGENTKIT_DESKTOP_MODE: '1' },
    desktopFactory: () => ({ ensureDisplay: () => displayReady, dispose: async () => { disposed = true; } }),
    browserFactory: () => ({ available: true, openDesktopWindow: async () => { browserStarts++; }, dispose: async () => {} }),
  });
  service.listen(); await once(service.server, 'listening');
  t.after(() => service.close());
  const endpoint = `http://127.0.0.1:${service.server.address().port}`;
  assert.equal((await fetch(`${endpoint}/health`)).status, 503);
  assert.equal((await fetch(`${endpoint}/v1/status`)).status, 503);
  finishDisplay();
  await new Promise(resolve => setImmediate(resolve));
  const health = await fetch(`${endpoint}/health`); assert.equal(health.status, 200);
  assert.equal((await health.json()).desktopReady, true); assert.equal(browserStarts, 1); assert.equal(disposed, false);
});

test('预热失败清理桌面和浏览器、关闭 HTTP 后以非零退出，不在进程内静默重试', async () => {
  const events = [], logs = [];
  const failure = Object.assign(new Error('fixture WM failed'), { code: 'DESKTOP_WINDOW_MANAGER_UNAVAILABLE',
    desktopDiagnostics: { elapsedMs: 5000, lastProbe: { stdout: 'not found' } }, secret: 'MUST_NOT_LOG' });
  let starts = 0, exitCode;
  const service = createComputerAgentServer({ env: { ...env, AGENTKIT_DESKTOP_MODE: '1' }, logger: { info() {}, error: line => logs.push(JSON.parse(line)) },
    desktopFactory: () => ({ ensureDisplay: async () => { events.push('desktop-ready'); }, dispose: async () => events.push('desktop-dispose') }),
    browserFactory: () => ({ available: true, openDesktopWindow: async () => { starts++; throw failure; }, dispose: async () => events.push('browser-dispose') }),
  });
  const daemon = runComputerAgentDaemon({ service, exit: code => { exitCode = code; events.push('exit'); }, onSignal: () => {} });
  await assert.rejects(service.whenReady, { code: 'DESKTOP_WINDOW_MANAGER_UNAVAILABLE' });
  await daemon.stopped;
  assert.equal(starts, 1); assert.equal(exitCode, 1); assert.equal(service.server.listening, false);
  assert.deepEqual(events, ['desktop-ready', 'browser-dispose', 'desktop-dispose', 'exit']);
  assert.equal(logs[0].event, 'desktop-startup-failed'); assert.equal(logs[0].diagnostics.lastProbe.stdout, 'not found');
  assert.equal(JSON.stringify(logs).includes('MUST_NOT_LOG'), false);
});

test('预热成功不会请求退出，显式停止时只清理一次', async () => {
  let exits = 0, disposals = 0;
  const service = createComputerAgentServer({ env: { ...env, AGENTKIT_DESKTOP_MODE: '1' }, logger: { info() {}, error() {} },
    desktopFactory: () => ({ ensureDisplay: async () => {}, dispose: async () => { disposals++; } }),
    browserFactory: () => ({ available: true, openDesktopWindow: async () => {}, dispose: async () => {} }),
  });
  const daemon = runComputerAgentDaemon({ service, exit: code => { assert.equal(code, 0); exits++; }, onSignal: () => {} });
  await service.whenReady;
  assert.equal(exits, 0); assert.equal(service.server.listening, true);
  await Promise.all([daemon.stop(0), daemon.stop(0)]);
  assert.equal(exits, 1); assert.equal(disposals, 1);
});
