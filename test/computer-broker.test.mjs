import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ComputerBrokerUnavailableError,
  ComputerLeaseConflictError,
  ComputerLeaseManager,
  createComputerBrokerClient,
  createMockComputerBroker,
} from '../src/computer-broker.mjs';

test('client stays disconnected until an explicit transport is supplied', async () => {
  const client = createComputerBrokerClient();
  assert.equal(client.connected(), false);
  await assert.rejects(client.status({ assistantId: 'a', botId: 'b', computerId: 'c' }), ComputerBrokerUnavailableError);
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
