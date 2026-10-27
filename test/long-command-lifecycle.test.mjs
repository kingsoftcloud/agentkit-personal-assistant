import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpComputerBrokerTransport, createMockComputerBroker } from '../src/computer-broker.mjs';
import { createComputerToolset } from '../src/cloud-computer-tools.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('命令120秒期限不被30秒RPC裁掉，普通查询仍30秒超时', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = [];
  const transport = createHttpComputerBrokerTransport({ baseUrl: 'http://127.0.0.1:8787', fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
    pending.push({ signal, resolve }); signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  const command = transport.request('computer.action', { action: 'terminal.exec', args: { timeoutMs: 120000 } });
  const status = assert.rejects(transport.request('computer.status', {}), { code: 'COMPUTER_BROKER_TIMEOUT' });
  t.mock.timers.tick(30001); await status;
  assert.equal(pending[0].signal.aborted, false);
  pending[0].resolve({ ok: true, status: 200, json: async () => ({ exitCode: 0 }) });
  assert.deepEqual(await command, { exitCode: 0 });
});

test('RPC JSON回传也受期限约束；外部取消不触发任何重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const transport = createHttpComputerBrokerTransport({ baseUrl: 'http://127.0.0.1:8787', timeoutMs: 1000, fetchImpl: async (_url, { signal }) => {
    requests++; return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) };
  } });
  const hung = assert.rejects(transport.request('computer.status', {}), { code: 'COMPUTER_BROKER_TIMEOUT' });
  await tick(); t.mock.timers.tick(1001); await hung;
  const cancel = new AbortController();
  const action = assert.rejects(transport.request('computer.action', { action: 'terminal.exec', args: {} }, { signal: cancel.signal }), error => error.code === 'COMPUTER_ACTION_ABORTED' && error.outcomeUnknown === true);
  await tick(); cancel.abort(); await action; assert.equal(requests, 2);
});

test('长动作定期续同一租约，动作完成后停止续租', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0, finish, actions = 0, renewals = 0;
  const mock = createMockComputerBroker({ computerId: 'c', now: () => now });
  const broker = { ...mock.client, renewLease: async (...args) => { renewals++; return mock.client.renewLease(...args); }, action: async () => { actions++; return new Promise(resolve => { finish = resolve; }); } };
  const tools = createComputerToolset({ broker, assistantId: 'a', botId: 'b', computerId: 'c', leaseTtlMs: 150, now: () => now });
  const action = tools.execute('cloud_bash', { command: 'long-command' }); await tick();
  const leaseId = mock.leases.leases.get('c').leaseId;
  for (let i = 0; i < 4; i++) { now += 50; t.mock.timers.tick(50); await tick(); assert.equal(mock.leases.leases.get('c').leaseId, leaseId); assert.ok(mock.leases.leases.get('c').expiresAt > now); }
  assert.ok(renewals >= 4); assert.equal(actions, 1);
  finish({ exitCode: 0, stdout: 'ok', stderr: '' }); await action;
  const stoppedAt = renewals; t.mock.timers.tick(5000); await tick(); assert.equal(renewals, stoppedAt);
  await tools.dispose();
});

test('续租被真人接管拒绝后取消原动作，不重新申请租约或重放', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const mock = createMockComputerBroker({ computerId: 'c' });
  let renewals = 0, actions = 0, acquires = 0;
  const broker = { ...mock.client,
    acquireLease: (...args) => { acquires++; return mock.client.acquireLease(...args); },
    renewLease: async (...args) => { if (++renewals === 1) return mock.client.renewLease(...args); throw Object.assign(new Error('human owns control'), { code: 'COMPUTER_USER_CONTROLLED', status: 409 }); },
    action: async (_request, { signal }) => { actions++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
  };
  const tools = createComputerToolset({ broker, assistantId: 'a', botId: 'b', computerId: 'c', leaseTtlMs: 150 });
  const action = assert.rejects(tools.execute('cloud_bash', { command: 'unknown-side-effect' }), { code: 'COMPUTER_USER_CONTROLLED', status: 409 });
  await tick(); t.mock.timers.tick(50); await action;
  assert.equal(actions, 1); assert.equal(acquires, 1); await tools.dispose();
});

test('续租验证原Bot、任务、租约和有效期，不允许借其他Bot续租', async () => {
  let now = 1000;
  const mock = createMockComputerBroker({ computerId: 'c', now: () => now });
  const scope = { assistantId: 'a', botId: 'owner', computerId: 'c', taskId: 'task', idempotencyKey: 'task', ttlMs: 1000 };
  const first = await mock.client.acquireLease(scope); now += 500;
  const renewed = await mock.client.renewLease({ ...scope, leaseId: first.lease.leaseId });
  assert.equal(renewed.lease.leaseId, first.lease.leaseId); assert.equal(renewed.lease.expiresAt, 2500);
  await assert.rejects(mock.client.renewLease({ ...scope, leaseId: first.lease.leaseId, botId: 'other' }), /COMPUTER_LEASE_REQUIRED/);
  await assert.rejects(mock.client.renewLease({ ...scope, leaseId: 'wrong' }), /COMPUTER_LEASE_REQUIRED/);
  assert.throws(() => mock.client.renewLease({ ...scope, leaseId: first.lease.leaseId, ttlMs: 300001 }), /300000/);
  now = 2501; await assert.rejects(mock.client.renewLease({ ...scope, leaseId: first.lease.leaseId }), /COMPUTER_LEASE_REQUIRED/);
});
