/**
 * Public protocol boundary between Personal Assistant Runtime and Computer.
 *
 * These helpers validate and shape messages. They do not open sockets, spawn a
 * browser, control a display, or imply that a computer is connected.
 */

export const COMPUTER_BROKER_PROTOCOL = 'personal-assistant.computer-broker/v1';
export const COMPUTER_BROKER_ACTIONS = Object.freeze([
  'computer.status',
  'computer.lease.acquire',
  'computer.lease.release',
  'computer.action',
]);
export const COMPUTER_ACTION_NAMES = Object.freeze([
  'open',
  'screenshot',
  'stream',
  'click',
  'type',
  'scroll',
  'clipboard.read',
  'clipboard.write',
  'files.list',
  'files.read',
  'files.write',
  'terminal.exec',
  'stop',
]);

function text(value, field) {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(`${field} must be a non-empty string`);
  return result;
}

function positiveInteger(value, field, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result <= 0) throw new TypeError(`${field} must be a positive integer`);
  return result;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

export function createLeaseRequest(input = {}) {
  return Object.freeze({
    protocol: COMPUTER_BROKER_PROTOCOL,
    assistantId: text(input.assistantId, 'assistantId'),
    botId: text(input.botId, 'botId'),
    computerId: text(input.computerId, 'computerId'),
    taskId: text(input.taskId, 'taskId'),
    idempotencyKey: text(input.idempotencyKey ?? `${input.assistantId}:${input.botId}:${input.taskId}`, 'idempotencyKey'),
    ttlMs: positiveInteger(input.ttlMs, 'ttlMs', 60_000),
  });
}

export function createReleaseRequest(input = {}) {
  return Object.freeze({
    protocol: COMPUTER_BROKER_PROTOCOL,
    assistantId: text(input.assistantId, 'assistantId'),
    botId: text(input.botId, 'botId'),
    computerId: text(input.computerId, 'computerId'),
    taskId: text(input.taskId, 'taskId'),
    leaseId: text(input.leaseId, 'leaseId'),
  });
}

export function createActionRequest(input = {}) {
  const action = text(input.action, 'action');
  if (!COMPUTER_ACTION_NAMES.includes(action)) throw new TypeError(`Unsupported computer action: ${action}`);
  return Object.freeze({
    protocol: COMPUTER_BROKER_PROTOCOL,
    assistantId: text(input.assistantId, 'assistantId'),
    botId: text(input.botId, 'botId'),
    computerId: text(input.computerId, 'computerId'),
    taskId: text(input.taskId, 'taskId'),
    leaseId: text(input.leaseId, 'leaseId'),
    action,
    args: Object.freeze({ ...object(input.args ?? {}, 'args') }),
  });
}

export function createStatusRequest(input = {}) {
  return Object.freeze({
    protocol: COMPUTER_BROKER_PROTOCOL,
    assistantId: text(input.assistantId, 'assistantId'),
    botId: text(input.botId, 'botId'),
    computerId: text(input.computerId, 'computerId'),
  });
}

export function isComputerBrokerMessage(value) {
  return Boolean(value && typeof value === 'object' && value.protocol === COMPUTER_BROKER_PROTOCOL);
}
