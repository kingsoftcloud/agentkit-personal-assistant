import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalAssistantStateStore } from '../src/persistent-state.mjs';
import {
  LOCAL_ACCESS_NOT_AUTHORIZED,
  LOCAL_ACCESS_SCOPES,
  LOCAL_ACCESS_STATE_COLLECTION,
  createLocalAccess,
  isLocalControlOperation,
} from '../src/local-access.mjs';

const now = () => new Date('2026-01-02T03:04:05.000Z');

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'personal-assistant-local-access-'));
  try {
    return await run(await createPersonalAssistantStateStore(root).init(), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('默认未授权：状态可读、local-control 命名空间可识别，且不领取中止信号', async () => {
  const access = createLocalAccess({ probeConnection: () => true, platform: 'darwin', hostVersion: '1.2.3' });
  await access.load();
  assert.deepEqual(await access.status(), {
    connected: true,
    authorized: false,
    scopes: [],
    riskConfirm: false,
    grantedAt: null,
    host: { platform: 'darwin', hostVersion: '1.2.3' },
  });
  assert.equal(isLocalControlOperation('personal-assistant.local-control.session.create'), true);
  assert.equal(isLocalControlOperation('personal-assistant.local-access.status'), false);
  assert.equal(isLocalControlOperation('personal-assistant.desktop.ticket'), false);
  assert.throws(() => access.assertAuthorized(), { code: LOCAL_ACCESS_NOT_AUTHORIZED, status: 403 });
  assert.equal(access.controlSignal().signal.aborted, true);
});

test('授权授予按契约子集校验并持久化，重启后仍保持授权', async () => {
  await withStore(async store => {
    const access = createLocalAccess({ stateStore: store, probeConnection: () => true, now, platform: 'darwin' });
    await access.load();
    assert.deepEqual(await access.grant({ scopes: ['session.create', 'window.input'], riskConfirm: true }),
      { authorized: true, grantedAt: '2026-01-02T03:04:05.000Z' });
    const status = await access.status();
    assert.equal(status.authorized, true);
    assert.deepEqual(status.scopes, ['session.create', 'window.input']);
    assert.equal(status.riskConfirm, true);
    assert.equal(status.grantedAt, '2026-01-02T03:04:05.000Z');

    // 存档只含 scope 与时间戳，不含凭据。
    const rows = await store.read(LOCAL_ACCESS_STATE_COLLECTION);
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows).includes('ticket'), false);
    assert.equal(JSON.stringify(rows).includes('apiKey'), false);

    const restarted = createLocalAccess({ stateStore: store, probeConnection: () => true, platform: 'darwin' });
    await restarted.load();
    const restored = await restarted.status();
    assert.equal(restored.authorized, true);
    assert.deepEqual(restored.scopes, ['session.create', 'window.input']);
    assert.equal(restored.grantedAt, '2026-01-02T03:04:05.000Z');

    await assert.rejects(access.grant({ scopes: ['root'], riskConfirm: true }),
      { code: 'PERSONAL_ASSISTANT_LOCAL_ACCESS_SCOPE_INVALID', status: 400 });
    await assert.rejects(access.grant({ scopes: 'session.create', riskConfirm: true }),
      { code: 'PERSONAL_ASSISTANT_LOCAL_ACCESS_INVALID', status: 400 });
    await assert.rejects(access.grant({ scopes: ['session.create'], riskConfirm: 'yes' }),
      { code: 'PERSONAL_ASSISTANT_LOCAL_ACCESS_INVALID', status: 400 });
    assert.deepEqual(LOCAL_ACCESS_SCOPES, ['session.create', 'window.input', 'file.read-write']);
  });
});

test('撤销授权同步中止在途任务，并把未授权状态持久化', async () => {
  await withStore(async store => {
    const access = createLocalAccess({ stateStore: store, probeConnection: () => true, now });
    await access.load();
    await access.grant({ scopes: ['session.create', 'file.read-write'], riskConfirm: false });
    const controller = access.controlSignal();
    assert.equal(controller.signal.aborted, false);

    assert.deepEqual(await access.revoke(), { authorized: false });
    assert.equal(controller.signal.aborted, true);
    const status = await access.status();
    assert.equal(status.authorized, false);
    assert.deepEqual(status.scopes, []);
    assert.equal(status.grantedAt, null);

    const restarted = createLocalAccess({ stateStore: store, probeConnection: () => true });
    await restarted.load();
    assert.equal((await restarted.status()).authorized, false);
  });
});

test('status 三态：连接探测失败只把 connected 置为 false，不改变授权记录', async () => {
  const access = createLocalAccess({ stateStore: null, probeConnection: () => true });
  await access.load();
  await access.grant({ scopes: ['session.create'], riskConfirm: true });

  const offline = createLocalAccess({ stateStore: null, probeConnection: () => false });
  await offline.grant({ scopes: ['session.create'], riskConfirm: true });
  const offlineStatus = await offline.status();
  assert.equal(offlineStatus.connected, false);
  assert.equal(offlineStatus.authorized, true);

  const broken = createLocalAccess({ stateStore: null, probeConnection: () => { throw new Error('studio gone'); } });
  await broken.grant({ scopes: ['session.create'], riskConfirm: true });
  const brokenStatus = await broken.status();
  assert.equal(brokenStatus.connected, false);
  assert.equal(brokenStatus.authorized, true);
});

test('状态目录不可用或存档损坏时降级：不抛错，内存授权仍可用', async () => {
  const unavailable = { read: async () => { throw new Error('denied'); }, mutate: async () => { throw new Error('denied'); } };
  const degraded = createLocalAccess({ stateStore: unavailable, probeConnection: () => true });
  await degraded.load();
  assert.equal((await degraded.status()).authorized, false);
  assert.deepEqual(await degraded.grant({ scopes: ['session.create'], riskConfirm: false }),
    { authorized: true, grantedAt: degraded.record.grantedAt });
  assert.equal((await degraded.status()).authorized, true);
  assert.doesNotThrow(() => degraded.assertAuthorized());

  await withStore(async store => {
    await store.write(LOCAL_ACCESS_STATE_COLLECTION, [{ version: 1, authorized: 'yes' }]);
    const invalid = createLocalAccess({ stateStore: store, probeConnection: () => true });
    await invalid.load();
    assert.equal((await invalid.status()).authorized, false);

    await store.write(LOCAL_ACCESS_STATE_COLLECTION, [{
      version: 1, authorized: true, scopes: ['root'], riskConfirm: true, grantedAt: '2026-01-02T00:00:00.000Z',
    }]);
    const unknownScope = createLocalAccess({ stateStore: store, probeConnection: () => true });
    await unknownScope.load();
    assert.equal((await unknownScope.status()).authorized, false);
  });
});
