import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ComputerBrokerUnavailableError,
  ComputerLeaseConflictError,
  ComputerLeaseManager,
  createComputerBrokerClient,
  createMockComputerBroker,
  createHttpComputerBrokerTransport,
} from '../src/computer-broker.mjs';

test('HTTP broker transport maps the localhost sidecar protocol', async () => {
  const requests = [];
  const transport = createHttpComputerBrokerTransport({
    baseUrl: 'http://127.0.0.1:8787',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({ connected: true, protocol: 'personal-assistant.computer-broker/v1' }) };
    },
  });
  const client = createComputerBrokerClient({ transport });
  const result = await client.status({ assistantId: 'a', botId: 'b', computerId: 'c' });
  assert.equal(result.connected, true);
  assert.equal(requests[0].url, 'http://127.0.0.1:8787/broker/status');
  assert.equal(requests[0].options.method, 'POST');
  assert.match(requests[0].options.headers['content-type'], /json/);
  assert.throws(() => createHttpComputerBrokerTransport({ baseUrl: 'http://computer.default.svc:8787' }), /loopback/);
});
import { createActionRequest, createLeaseRequest, createStatusRequest } from '../src/computer-broker-protocol.mjs';

test('client stays disconnected until an explicit transport is supplied', async () => {
  const client = createComputerBrokerClient();
  assert.equal(client.connected(), false);
  await assert.rejects(client.status({ assistantId: 'a', botId: 'b', computerId: 'c' }), ComputerBrokerUnavailableError);
});

test('broker requests carry optional owning user identity for computer-side validation', () => {
  assert.equal(createActionRequest({ userId: 'user-1', assistantId: 'a', botId: 'b', computerId: 'c', taskId: 't', leaseId: 'l', action: 'screenshot', args: {} }).userId, 'user-1');
  assert.equal(createLeaseRequest({ userId: 'user-1', assistantId: 'a', botId: 'b', computerId: 'c', taskId: 't', idempotencyKey: 'k' }).userId, 'user-1');
  assert.equal(createStatusRequest({ userId: 'user-1', assistantId: 'a', botId: 'b', computerId: 'c' }).userId, 'user-1');
});

test('lease serializes simulated access and actions carry task identity', async () => {
  const mock = createMockComputerBroker({ computerId: 'computer-1' });
  const client = mock.client;
  const status = await client.status({ assistantId: 'assistant-1', botId: 'researcher', computerId: 'computer-1' });
  assert.deepEqual(status, { protocol: 'personal-assistant.computer-broker/v1', computerId: 'computer-1', connected: true, simulated: true });
  const leaseInput = { assistantId: 'assistant-1', botId: 'researcher', computerId: 'computer-1', taskId: 'task-1', idempotencyKey: 'task-1:lease' };
  const first = await client.acquireLease(leaseInput);
  const replay = await client.acquireLease(leaseInput);
  assert.equal(first.lease.leaseId, replay.lease.leaseId);
  await assert.rejects(client.acquireLease({ ...leaseInput, botId: 'operator', taskId: 'task-2', idempotencyKey: 'task-2:lease' }), ComputerLeaseConflictError);
  const action = await client.action({ ...leaseInput, leaseId: first.lease.leaseId, action: 'screenshot', args: {} });
  assert.equal(action.accepted, true);
  assert.equal(action.simulated, true);
  assert.equal(mock.actions.length, 1);
  await client.releaseLease({ ...leaseInput, leaseId: first.lease.leaseId });
  assert.equal(mock.leases.leases.size, 0);
});

test('lease manager expires leases and allows a later Bot to acquire the computer', () => {
  let now = 1000;
  const manager = new ComputerLeaseManager({ now: () => now, leaseId: () => 'lease-1' });
  const input = { assistantId: 'a', botId: 'one', computerId: 'c', taskId: 't1', idempotencyKey: 'k1', ttlMs: 10 };
  manager.acquire(input);
  assert.throws(() => manager.acquire({ ...input, botId: 'two', taskId: 't2', idempotencyKey: 'k2' }), error => error?.code === 'COMPUTER_LEASE_CONFLICT');
  now = 1011;
  const lease = manager.acquire({ ...input, botId: 'two', taskId: 't2', idempotencyKey: 'k2' });
  assert.equal(lease.botId, 'two');
});

test('computer-backed browser and terminal tools acquire one Bot lease lazily', async () => {
  const mock = createMockComputerBroker({ computerId: 'computer-1' });
  const { createComputerToolset } = await import('../src/cloud-computer-tools.mjs');
  const toolset = createComputerToolset({ broker: mock.client, assistantId: 'assistant-1', botId: 'researcher', computerId: 'computer-1', taskId: 'task-1' });
  assert.equal(toolset.lease, null);
  const open = await toolset.executeRaw('cloud_browser_open', { url: 'https://example.com' });
  assert.equal(open.accepted, true);
  assert.equal(toolset.lease.taskId, 'task-1');
  const terminal = await toolset.executeRaw('cloud_bash', { command: 'printf ok' });
  assert.equal(terminal.accepted, true);
  assert.equal(mock.actions.at(-1).action, 'terminal.exec');
  await toolset.dispose();
  assert.equal(mock.leases.leases.size, 0);
});

test('computer-backed adapters validate browser selectors, keys, and code languages', async () => {
  const mock = createMockComputerBroker();
  const { createComputerToolset } = await import('../src/cloud-computer-tools.mjs');
  const toolset = createComputerToolset({ broker: mock.client, assistantId: 'a', botId: 'b', computerId: 'mock-computer' });
  await assert.rejects(toolset.execute('cloud_browser_press', { key: 'F12' }), /allowlisted/);
  await assert.rejects(toolset.execute('cloud_run_code', { language: 'ruby', code: '1' }), /Unsupported/);
  await assert.rejects(toolset.execute('cloud_browser_click', { selector: '' }), /non-empty/);
  await toolset.dispose();
});
