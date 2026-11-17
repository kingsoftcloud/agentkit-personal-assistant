import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalAssistantStateStore } from '../src/persistent-state.mjs';
import { createLocalAccess, LOCAL_ACCESS_NOT_AUTHORIZED, isLocalControlOperation } from '../src/local-access.mjs';

const target = { agentId: 'ar-test', botId: 'default', authority: 'account-a' };
const waitingTransport = async (_scope, operation, _input, signal) => {
  if (!operation.endsWith('.poll')) return { connected: true };
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
};
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'pa-local-'));
  const stateStore = await createPersonalAssistantStateStore(join(root, 'state')).init();
  const instances = [];
  const create = (extra = {}) => {
    const access = createLocalAccess({ stateStore, transport: waitingTransport, getTarget: async () => target, ...extra });
    instances.push(access); return access;
  };
  try { await run({ root, create }); } finally { for (const access of instances) access.dispose(); await rm(root, { recursive: true, force: true }); }
}
test('no storage/transport means unavailable, never a successful placeholder grant', async () => {
  const access = createLocalAccess();
  assert.equal((await access.status()).available, false);
  assert.throws(() => access.assertAuthorized(), { code: LOCAL_ACCESS_NOT_AUTHORIZED });
  assert.equal(isLocalControlOperation('personal-assistant.local-control.file.read'), true);
  assert.equal(isLocalControlOperation('personal-assistant.local-access.status'), false);
});
test('directory grant survives Host restart, revocation is durable and blocks old commands', async () => fixture(async ({ root, create }) => {
  await writeFile(join(root, 'note.txt'), 'local-only');
  const access = create();
  const granted = await access.grant({ scopes: ['file.read'], roots: [root], target });
  const command = { action: 'file.read', path: 'note.txt', rootId: granted.roots[0].id, grantId: access.record.grantId };
  assert.equal((await access.execute(command)).text, 'local-only');
  await assert.rejects(access.execute({ ...command, action: 'file.write', text: 'modified' }), { code: 'LOCAL_WRITE_DENIED' });
  access.dispose();
  const restarted = create(); await restarted.load();
  assert.equal((await restarted.status()).authorized, true);
  assert.equal((await restarted.execute(command)).text, 'local-only');
  await restarted.revoke();
  await assert.rejects(restarted.execute(command), { code: LOCAL_ACCESS_NOT_AUTHORIZED });
  assert.equal((await create().status()).authorized, false);
}));
test('unsupported scopes and relative roots are rejected before registering a device', async () => fixture(async ({ create }) => {
  const access = create();
  await assert.rejects(access.grant({ scopes: ['session.create'], roots: ['/'], target }), { code: 'PERSONAL_ASSISTANT_LOCAL_ACCESS_SCOPE_INVALID' });
  await assert.rejects(access.grant({ scopes: ['file.read'], roots: ['.'], target }), { code: 'PERSONAL_ASSISTANT_LOCAL_ACCESS_INVALID' });
  assert.equal((await access.status()).authorized, false);
}));
test('disconnected cloud retains the explicit grant; account change stops reconnecting', async () => fixture(async ({ root, create }) => {
  let calls = 0;
  const access = create({ getTarget: async () => ({ ...target, authority: 'account-b' }), retryMs: 5,
    transport: async () => { calls++; } });
  const grant = await access.grant({ scopes: ['file.read'], roots: [root], target });
  assert.match(grant.lastError, /绑定已改变/);
  assert.equal((await access.status()).authorized, true);
  assert.equal((await access.status()).connected, false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 0);
  assert.equal(access.retry, undefined);
}));
test('storage errors are visible and cannot produce an in-memory-only authorization', async () => fixture(async ({ root, create }) => {
  const access = create({ stateStore: { read: async () => [], mutate: async () => { throw new Error('storage denied'); } } });
  await assert.rejects(access.grant({ scopes: ['file.read'], roots: [root], target }), /storage denied/);
  assert.equal((await access.status()).authorized, false);
}));
