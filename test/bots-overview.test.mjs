import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalAssistantHostGateway } from '../src/host-gateway.mjs';
import { BotRegistry } from '../src/bot-registry.mjs';
import { createPersonalAssistantStateStore } from '../src/persistent-state.mjs';
import { createLocalAccess } from '../src/local-access.mjs';

const ticket = 't'.repeat(43);
const config = { gatewayUrl: 'https://gateway.example/', agentId: 'ar-test', apiKey: 'host-only-secret' };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function bots() {
  return [
    {
      botId: 'default', displayName: '默认助理', systemPromptRevision: '1', model: 'deepseek-v4.1-flash-1017',
      status: 'running', createdAt: '2026-10-28T00:00:00Z',
      metadata: { computer: 'connected', capabilities: [
        { id: 'cloud-computer', label: '云电脑', source: 'builtin', status: 'ready' },
        { id: 'calendar', label: '工作日历', source: 'mcp', status: 'ready' },
      ] },
    },
    { botId: 'docs', displayName: '文档助理', systemPromptRevision: '1', model: 'deepseek-v4.1' },
  ];
}

function directorySocket(sockets, rows) {
  return class Socket extends EventEmitter {
    constructor(url) { super(); this.url = url; sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    send(raw) { this.sent = raw; queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'bots', bots: rows }) })); }
    close() { this.closed = true; }
  };
}

async function seed(store) {
  await store.write('turns', [
    { botId: 'default', sessionId: 's-1', turnId: 'turn-running', input: '把周报整理成 Markdown', status: 'running', metadata: {}, updatedAt: '2026-11-01T10:00:00Z' },
    { botId: 'default', sessionId: 's-1', turnId: 'turn-done', input: '清理临时文件', status: 'completed', metadata: { title: '清理完成' }, updatedAt: '2026-11-02T09:00:00Z' },
    { botId: 'default', sessionId: 's-1', turnId: 'turn-failed', input: '失败任务', status: 'failed', metadata: {}, updatedAt: '2026-11-02T08:00:00Z' },
  ]);
  await store.putMemory({ botId: 'default', key: 'pref', content: '回复先给结论' });
  await store.putMemory({ botId: 'default', key: 'report', content: '周报用 Markdown' });
}

function workspace() {
  return {
    async open({ rows = [{ botId: 'default', displayName: 'Personal Assistant' }, { botId: 'docs', displayName: '文档助理' }, { botId: 'cloud-only', displayName: '云端助理' }] } = {}) {
      const root = await mkdtemp(join(tmpdir(), 'personal-assistant-overview-'));
      const store = await createPersonalAssistantStateStore(root).init();
      await seed(store);
      const registry = new BotRegistry({ profileId: 'p', bots: bots() });
      const access = createLocalAccess({ stateStore: store, probeConnection: () => true });
      const sockets = [];
      const gateway = createPersonalAssistantHostGateway(config, {
        env: {}, WebSocketImpl: directorySocket(sockets, rows),
        fetchImpl: async () => Response.json({ Code: 0, Data: { Ticket: ticket, AgentId: 'ar-test', BotId: '__directory__', WsPath: 'personal-assistant/desktop/ws', ExpiresAt: '2026-11-04T00:01:00Z' } }),
        botRegistry: registry, stateStore: store, localAccess: access,
      });
      return { root, store, registry, access, gateway, sockets };
    },
  };
}

test('概览合并云目录、本机 registry 与状态目录，且不透传私有字段', async () => {
  const opened = await workspace().open();
  try {
    const overview = await opened.gateway.request('personal-assistant.bots.overview');
    assert.deepEqual(overview.bots, [
      { id: 'default', name: '默认助理', role: 'primary', status: 'running', model: 'deepseek-v4.1-flash-1017', memoryCount: 2, capabilityCount: 2, computer: 'connected' },
      { id: 'docs', name: '文档助理', role: 'custom', status: 'idle', model: 'deepseek-v4.1', memoryCount: 0, capabilityCount: 0, computer: 'idle' },
      { id: 'cloud-only', name: '云端助理', role: 'custom', status: 'idle', model: '', memoryCount: 0, capabilityCount: 0, computer: 'idle' },
    ]);
    assert.deepEqual(overview.active, [{ kind: 'turn', botId: 'default', title: '把周报整理成 Markdown', detail: '正在执行' }]);
    assert.deepEqual(overview.recent, [
      { id: 'turn-done', title: '清理完成', status: 'done', at: '2026-11-02T09:00:00Z' },
      { id: 'turn-failed', title: '失败任务', status: 'failed', at: '2026-11-02T08:00:00Z' },
    ]);
    assert.deepEqual(overview.counts, { schedules: 0, memories: 2, files: 0 });
    assert.equal('degraded' in overview, false);
    const serialized = JSON.stringify(overview);
    for (const secret of ['systemPrompt', 'toolPolicy', 'memoryNamespace', 'host-only-secret']) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(opened.sockets.length, 1);
    assert.deepEqual(JSON.parse(opened.sockets[0].sent), { type: 'bots.list' });
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('云端目录不可达或未绑定时概览降级为本地数据，不抛错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-assistant-overview-'));
  try {
    const store = await createPersonalAssistantStateStore(root).init();
    await seed(store);
    const registry = new BotRegistry({ bots: bots() });
    const offline = createPersonalAssistantHostGateway(config, {
      env: {}, fetchImpl: async () => { throw new Error('offline'); },
      botRegistry: registry, stateStore: store, localAccess: createLocalAccess({ stateStore: store, probeConnection: () => true }),
    });
    const degraded = await offline.request('personal-assistant.bots.overview');
    assert.deepEqual(degraded.bots.map(bot => bot.id), ['default', 'docs']);
    assert.equal(degraded.degraded, true);
    assert.deepEqual(degraded.counts, { schedules: 0, memories: 2, files: 0 });

    const unbound = createPersonalAssistantHostGateway({}, {
      env: {}, botRegistry: registry, stateStore: store, localAccess: createLocalAccess({ probeConnection: () => false }),
    });
    const local = await unbound.request('personal-assistant.bots.overview');
    assert.deepEqual(local.bots.map(bot => bot.id), ['default', 'docs']);
    assert.equal(local.degraded, true);
    assert.equal(local.active.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Bot 详情按契约白名单返回；记忆删除与模型更新在重启后仍生效', async () => {
  const opened = await workspace().open();
  try {
    const detail = await opened.gateway.request('personal-assistant.bot.detail', { botId: 'default' });
    assert.deepEqual(detail, {
      bot: { id: 'default', name: '默认助理', role: 'primary', status: 'running', model: 'deepseek-v4.1-flash-1017' },
      memory: { count: 2, items: [{ id: 'pref', text: '回复先给结论', scope: 'bot' }, { id: 'report', text: '周报用 Markdown', scope: 'bot' }] },
      capabilities: [
        { id: 'cloud-computer', label: '云电脑', source: 'builtin', status: 'ready' },
        { id: 'calendar', label: '工作日历', source: 'mcp', status: 'ready' },
      ],
      computer: null,
      createdAt: '2026-10-28T00:00:00Z',
    });
    assert.equal(JSON.stringify(detail).includes('systemPrompt'), false);

    assert.deepEqual(await opened.gateway.request('personal-assistant.bot.model.update', { botId: 'default', model: 'deepseek-v4.1' }), { model: 'deepseek-v4.1' });
    assert.equal(opened.registry.get('default').model, 'deepseek-v4.1');
    assert.deepEqual(await opened.gateway.request('personal-assistant.bot.memory.delete', { botId: 'default', memoryId: 'pref' }), { deleted: true });
    assert.deepEqual(await opened.gateway.request('personal-assistant.bot.memory.delete', { botId: 'default', memoryId: 'pref' }), { deleted: false });

    // 模拟 Host 重启：新 gateway + 同一状态目录，模型覆盖与记忆删除都要保留。
    const restartedRegistry = new BotRegistry({ bots: [{ botId: 'default', displayName: '默认助理', systemPromptRevision: '1' }] });
    const restarted = createPersonalAssistantHostGateway(config, {
      env: {}, fetchImpl: async () => { throw new Error('offline'); },
      botRegistry: restartedRegistry, stateStore: opened.store, localAccess: createLocalAccess({ stateStore: opened.store }),
    });
    const after = await restarted.request('personal-assistant.bot.detail', { botId: 'default' });
    assert.equal(after.bot.model, 'deepseek-v4.1');
    assert.deepEqual(after.memory.items.map(item => item.id), ['report']);
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('新建 Bot 需要合法名称，删除必须名称确认，删除后重启不回生', async () => {
  const opened = await workspace().open({ rows: [{ botId: 'default', displayName: 'Personal Assistant' }] });
  try {
    await assert.rejects(opened.gateway.request('personal-assistant.bot.create', { name: '  ' }),
      { code: 'PERSONAL_ASSISTANT_BOT_INVALID', status: 400 });
    const created = await opened.gateway.request('personal-assistant.bot.create', { name: '新品助理' });
    assert.deepEqual(Object.keys(created), ['bot']);
    assert.deepEqual(Object.keys(created.bot), ['id', 'name']);
    assert.match(created.bot.id, /^bot-[0-9a-f]{8}$/u);
    assert.equal(created.bot.name, '新品助理');

    const withCreated = await opened.gateway.request('personal-assistant.bots.overview');
    const row = withCreated.bots.find(bot => bot.id === created.bot.id);
    assert.equal(row.role, 'custom');
    assert.equal(row.memoryCount, 0);

    await assert.rejects(opened.gateway.request('personal-assistant.bot.delete', { botId: created.bot.id, confirmName: '写错了' }),
      { code: 'PERSONAL_ASSISTANT_BOT_CONFIRM_MISMATCH', status: 400 });
    assert.deepEqual(await opened.gateway.request('personal-assistant.bot.delete', { botId: created.bot.id, confirmName: '新品助理' }), { deleted: true });
    await assert.rejects(opened.gateway.request('personal-assistant.bot.delete', { botId: created.bot.id, confirmName: '新品助理' }),
      { code: 'PERSONAL_ASSISTANT_BOT_NOT_FOUND', status: 404 });

    const restarted = createPersonalAssistantHostGateway({}, {
      env: {}, botRegistry: new BotRegistry({ bots: [] }), stateStore: opened.store, localAccess: createLocalAccess({ stateStore: opened.store }),
    });
    const after = await restarted.request('personal-assistant.bots.overview');
    assert.equal(after.bots.some(bot => bot.id === created.bot.id), false);
  } finally {
    await rm(opened.root, { recursive: true, force: true });
  }
});

test('创建进度只把实例阶段标为 active，完成后全部 done，失败保留可读原因', async () => {
  function deferredHost() {
    let resolveCreate, rejectCreate;
    return {
      service: {
        configuration: async () => ({ configured: true, agentId: 'ar-studio' }),
        issueTicket: async () => { throw new Error('unused'); },
        create: () => new Promise((resolve, reject) => { resolveCreate = resolve; rejectCreate = reject; }),
      },
      resolve: value => resolveCreate(value),
      reject: error => rejectCreate(error),
    };
  }

  const idle = createPersonalAssistantHostGateway({}, { env: {}, getHostDesktop: () => undefined, localAccess: createLocalAccess({ probeConnection: () => false }) });
  const before = await idle.request('personal-assistant.create.status');
  assert.deepEqual(before, {
    instanceId: '', stage: 'instance',
    stages: [
      { id: 'instance', status: 'pending', detail: '' },
      { id: 'runtime', status: 'pending', detail: '' },
      { id: 'computer', status: 'pending', detail: '' },
      { id: 'assistant', status: 'pending', detail: '' },
    ],
    elapsedMs: 0, estimatedRemainingMs: 0,
  });

  const host = deferredHost();
  const gateway = createPersonalAssistantHostGateway({}, { env: {}, getHostDesktop: () => host.service, localAccess: createLocalAccess({ probeConnection: () => true }) });
  const pending = gateway.request('personal-assistant.desktop.create');
  await tick();
  const active = await gateway.request('personal-assistant.create.status');
  assert.equal(active.stage, 'instance');
  assert.deepEqual(active.stages.map(stage => stage.status), ['active', 'pending', 'pending', 'pending']);
  assert.equal(active.stages[0].detail, '正在创建云端实例');
  assert.equal(active.instanceId, '');
  assert.ok(active.elapsedMs >= 0);
  assert.ok(active.estimatedRemainingMs > 0);

  host.resolve({ configured: true, agentId: 'ar-created' });
  assert.deepEqual(await pending, { configured: true, agentId: 'ar-created', mode: 'host' });
  const done = await gateway.request('personal-assistant.create.status');
  assert.equal(done.stage, 'done');
  assert.equal(done.instanceId, 'ar-created');
  assert.deepEqual(done.stages.map(stage => stage.status), ['done', 'done', 'done', 'done']);
  assert.equal(done.estimatedRemainingMs, 0);

  const failing = deferredHost();
  const failingGateway = createPersonalAssistantHostGateway({}, { env: {}, getHostDesktop: () => failing.service, localAccess: createLocalAccess({ probeConnection: () => true }) });
  const failingPending = failingGateway.request('personal-assistant.desktop.create');
  await tick();
  failing.reject(Object.assign(new Error('创建失败：配额不足'), { code: 'HOST_CREATE_FAILED', status: 500 }));
  await assert.rejects(failingPending, { code: 'HOST_CREATE_FAILED', status: 500 });
  const failed = await failingGateway.request('personal-assistant.create.status');
  assert.equal(failed.stage, 'failed');
  assert.equal(failed.error, '创建失败：配额不足');
  assert.equal(failed.stages[0].status, 'failed');
  assert.deepEqual(failed.stages.slice(1).map(stage => stage.status), ['pending', 'pending', 'pending']);
  assert.equal(failed.estimatedRemainingMs, 0);
});
