import { randomUUID } from 'node:crypto';
import {
  COMPUTER_BROKER_ACTIONS,
  createActionRequest,
  createLeaseRequest,
  createReleaseRequest,
  createStatusRequest,
} from './computer-broker-protocol.mjs';

export class ComputerBrokerUnavailableError extends Error {
  constructor(message = 'Cloud Computer Broker is not connected') {
    super(message);
    this.name = 'ComputerBrokerUnavailableError';
    this.code = 'COMPUTER_BROKER_UNAVAILABLE';
  }
}

export class ComputerLeaseConflictError extends Error {
  constructor(computerId) {
    super(`Computer is already leased: ${computerId}`);
    this.name = 'ComputerLeaseConflictError';
    this.code = 'COMPUTER_LEASE_CONFLICT';
  }
}

function requestTransport(transport) {
  if (!transport || typeof transport.request !== 'function') throw new ComputerBrokerUnavailableError();
  return transport;
}

/**
 * Create the runtime-side client. A real transport is intentionally required;
 * the default is disconnected so a deployment cannot claim computer access.
 */
export function createComputerBrokerClient({ transport, now = () => Date.now() } = {}) {
  const transportOrNull = transport ?? null;
  const call = async (operation, payload) => {
    const active = requestTransport(transportOrNull);
    if (!COMPUTER_BROKER_ACTIONS.includes(operation)) throw new TypeError(`Unsupported computer broker operation: ${operation}`);
    return active.request(operation, payload);
  };
  return Object.freeze({
    connected: () => Boolean(transportOrNull),
    status: input => call('computer.status', createStatusRequest(input)),
    acquireLease: input => call('computer.lease.acquire', createLeaseRequest(input)),
    releaseLease: input => call('computer.lease.release', createReleaseRequest(input)),
    action: input => call('computer.action', createActionRequest(input)),
    now,
  });
}

/**
 * In-memory lease manager used by adapters and tests. It does not execute a
 * computer action; it only serializes access to one computer ID.
 */
export class ComputerLeaseManager {
  constructor({ now = () => Date.now(), leaseId = () => randomUUID() } = {}) {
    this.now = now;
    this.leaseId = leaseId;
    this.leases = new Map();
    this.idempotency = new Map();
  }

  _expire() {
    const now = this.now();
    for (const [computerId, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(computerId);
        this.idempotency.delete(lease.idempotencyKey);
      }
    }
  }

  acquire(input) {
    this._expire();
    const existingByKey = this.idempotency.get(input.idempotencyKey);
    if (existingByKey && existingByKey.expiresAt > this.now()) return existingByKey;
    const existing = this.leases.get(input.computerId);
    if (existing) throw new ComputerLeaseConflictError(input.computerId);
    const lease = Object.freeze({
      leaseId: this.leaseId(),
      computerId: input.computerId,
      assistantId: input.assistantId,
      botId: input.botId,
      taskId: input.taskId,
      idempotencyKey: input.idempotencyKey,
      expiresAt: this.now() + input.ttlMs,
    });
    this.leases.set(lease.computerId, lease);
    this.idempotency.set(lease.idempotencyKey, lease);
    return lease;
  }

  release(input) {
    this._expire();
    const lease = this.leases.get(input.computerId);
    if (!lease || lease.leaseId !== input.leaseId) return false;
    this.leases.delete(input.computerId);
    this.idempotency.delete(lease.idempotencyKey);
    return true;
  }

  assert(input) {
    this._expire();
    const lease = this.leases.get(input.computerId);
    if (!lease || lease.leaseId !== input.leaseId || lease.taskId !== input.taskId) {
      throw new Error('COMPUTER_LEASE_REQUIRED');
    }
    return lease;
  }
}

/**
 * Explicitly simulated transport for unit tests and local contract demos.
 * The response includes `simulated: true` to prevent it being mistaken for a
 * real Cloud Computer connection.
 */
export function createMockComputerBroker({ computerId = 'mock-computer', now = () => Date.now() } = {}) {
  const leases = new ComputerLeaseManager({ now, leaseId: () => `mock-lease-${Math.random().toString(16).slice(2)}` });
  const actions = [];
  const transport = {
    async request(operation, payload) {
      if (operation === 'computer.status') return { protocol: payload.protocol, computerId, connected: true, simulated: true };
      if (operation === 'computer.lease.acquire') return { protocol: payload.protocol, simulated: true, lease: leases.acquire(payload) };
      if (operation === 'computer.lease.release') return { protocol: payload.protocol, simulated: true, released: leases.release(payload) };
      if (operation === 'computer.action') {
        leases.assert(payload);
        const event = Object.freeze({ protocol: payload.protocol, simulated: true, computerId, taskId: payload.taskId, action: payload.action, args: payload.args });
        actions.push(event);
        return { ...event, accepted: true };
      }
      throw new Error(`Unsupported mock operation: ${operation}`);
    },
  };
  return Object.freeze({ client: createComputerBrokerClient({ transport, now }), actions, leases });
}
