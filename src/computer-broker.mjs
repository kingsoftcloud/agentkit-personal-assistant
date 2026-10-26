import { randomUUID } from 'node:crypto';
import {
  COMPUTER_BROKER_ACTIONS,
  createActionRequest,
  createLeaseRequest,
  createReleaseRequest,
  createRenewRequest,
  createStatusRequest,
} from './computer-broker-protocol.mjs';

const BROKER_PATHS = Object.freeze({
  'computer.status': '/broker/status',
  'computer.lease.acquire': '/broker/lease/acquire',
  'computer.lease.renew': '/broker/lease/renew',
  'computer.lease.release': '/broker/lease/release',
  'computer.action': '/broker/action',
});

function loopbackHost(value) {
  const host = String(value || '').replace(/^\[|\]$/gu, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * HTTP transport for the localhost Computer Broker sidecar.
 *
 * The runtime and Computer containers share a network namespace. Keeping this
 * transport loopback-only prevents a bad deployment from turning the broker
 * into a cluster-reachable control endpoint. Tests can inject fetchImpl, but
 * production callers should use the default fetch implementation.
 */
export function createHttpComputerBrokerTransport({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new TypeError('baseUrl must be a non-empty string');
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new TypeError('baseUrl must be a valid URL'); }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new TypeError('baseUrl must use http or https');
  if (endpoint.username || endpoint.password) throw new TypeError('baseUrl must not contain credentials');
  if (!loopbackHost(endpoint.hostname)) throw new TypeError('Computer Broker URL must resolve to loopback');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new TypeError('timeoutMs must be between 1 and 300000');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  return Object.freeze({
    endpoint: endpoint.toString(),
    async request(operation, payload, { signal } = {}) {
      const path = BROKER_PATHS[operation];
      if (!path) throw new TypeError(`Unsupported computer broker operation: ${operation}`);
      const target = new URL(path, endpoint);
      const controller = new AbortController();
      // 长命令的执行期限由 Computer 自身约束；RPC 留出终止进程组及回传结果的余量。
      const requested = payload?.action === 'terminal.exec' ? (payload.args?.timeoutMs ?? 120_000) : 0;
      const executionMs = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 300_000) : 0;
      const deadlineMs = executionMs ? Math.max(timeoutMs, executionMs + 5000) : timeoutMs;
      const timer = setTimeout(() => controller.abort(), deadlineMs);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        const response = await fetchImpl(target, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: combined,
        });
        const body = await response.json().catch(error => {
          if (combined.aborted) throw error;
          throw Object.assign(new Error(`Computer Broker returned non-JSON response (${response.status})`), { code: 'COMPUTER_BROKER_FAILED', status: response.ok ? 502 : response.status });
        });
        if (!response.ok) throw Object.assign(new Error(body.message || body.error || `Computer Broker returned HTTP ${response.status}`), { code: body.error || 'COMPUTER_BROKER_FAILED', status: response.status, ...(body.outcomeUnknown ? { outcomeUnknown: true } : {}) });
        return body;
      } catch (error) {
        if (error.status) throw error;
        const wrapped = new Error(`Computer Broker request failed: ${error?.message || 'network error'}`);
        wrapped.code = signal?.aborted ? (typeof signal.reason?.code === 'string' ? signal.reason.code : 'COMPUTER_ACTION_ABORTED') : controller.signal.aborted ? 'COMPUTER_BROKER_TIMEOUT' : 'COMPUTER_BROKER_UNAVAILABLE';
        if (operation === 'computer.action') { wrapped.outcomeUnknown = true; wrapped.message += '；动作可能已部分执行，请先核对结果，勿盲目重放'; }
        if (signal?.reason?.status) wrapped.status = signal.reason.status;
        wrapped.cause = error;
        throw wrapped;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

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
  const call = async (operation, payload, options) => {
    const active = requestTransport(transportOrNull);
    if (!COMPUTER_BROKER_ACTIONS.includes(operation)) throw new TypeError(`Unsupported computer broker operation: ${operation}`);
    return active.request(operation, payload, options);
  };
  return Object.freeze({
    connected: () => Boolean(transportOrNull),
    status: input => call('computer.status', createStatusRequest(input)),
    acquireLease: input => call('computer.lease.acquire', createLeaseRequest(input)),
    renewLease: (input, options) => call('computer.lease.renew', createRenewRequest(input), options),
    releaseLease: input => call('computer.lease.release', createReleaseRequest(input)),
    action: (input, options) => call('computer.action', createActionRequest(input), options),
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
      ...(input.userId === undefined ? {} : { userId: input.userId }),
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

  renew(input) {
    const lease = this.assert(input);
    if (lease.assistantId !== input.assistantId || lease.botId !== input.botId || lease.userId !== input.userId) throw new Error('COMPUTER_LEASE_REQUIRED');
    const renewed = Object.freeze({ ...lease, expiresAt: this.now() + input.ttlMs });
    this.leases.set(lease.computerId, renewed); this.idempotency.set(lease.idempotencyKey, renewed);
    return renewed;
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
      if (operation === 'computer.lease.renew') return { protocol: payload.protocol, simulated: true, lease: leases.renew(payload) };
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
