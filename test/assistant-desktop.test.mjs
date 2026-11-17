import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantDesktop } from '../src/assistant-desktop.mjs';

const AGENT = 'ar-20261110220000-catalog';
const KEY = `ak-${'0123456789abcdef'.repeat(2)}`;

test('an unavailable bound instance keeps its identity while another instance is running', async t => {
  const storeDir = await mkdtemp(join(tmpdir(), 'pa-binding-roll-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const path = join(storeDir, 'assistant-binding.json');
  const gatewayUrl = 'https://gateway.example';
  const saved = { format: 'agentkit.personal-assistant-binding/v1', agentId: AGENT, apiKey: KEY, gatewayUrl };
  await writeFile(path, JSON.stringify(saved));
  const alternative = { AgentId: 'ar-newer', Name: 'Alternate', Status: 'RUNNING', Framework: 'personal-assistant' };
  let status = 'UPDATING';
  const client = { action: async (name, input) => {
    if (name === 'ListAgents') return { data: { Agents: [alternative] } };
    assert.equal(name, 'GetAgent');
    assert.equal(input.AgentId, AGENT);
    return { data: { Basic: { AgentId: AGENT, Status: status }, Deployment: { Framework: 'personal-assistant' } } };
  } };
  let ticketUnavailable = true;
  const fetchImpl = async (_, { body }) => {
    assert.equal(JSON.parse(body).AgentId, AGENT);
    return ticketUnavailable ? Response.json({ Code: 404 }, { status: 404 })
      : Response.json({ Code: 0, Data: { Ticket: 't'.repeat(43) } });
  };
  const options = { storeDir, fetchImpl, getClient: async () => client };
  assert.deepEqual(await createAssistantDesktop(options).configuration(), { configured: true, agentId: AGENT });
  status = 'RUNNING';
  assert.deepEqual(await createAssistantDesktop(options).configuration(), { configured: true, agentId: AGENT });
  ticketUnavailable = false;
  assert.deepEqual(await createAssistantDesktop(options).configuration(), { configured: true, agentId: AGENT });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), saved);
});

test('the control plane can confirm a removed binding and discover another running instance', async t => {
  const storeDir = await mkdtemp(join(tmpdir(), 'pa-binding-removed-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const path = join(storeDir, 'assistant-binding.json');
  const gatewayUrl = 'https://gateway.example';
  await writeFile(path, JSON.stringify({ format: 'agentkit.personal-assistant-binding/v1', agentId: AGENT, apiKey: KEY, gatewayUrl }));
  const newId = 'ar-replacement';
  const getClient = async () => ({ action: async (name, input) => {
    if (name === 'ListAgents') return { data: { Agents: [{ AgentId: newId, Status: 'RUNNING', Framework: 'personal-assistant' }] } };
    if (name === 'GetAgent') {
      assert.equal(input.AgentId, AGENT);
      throw Object.assign(new Error('Not found'), { status: 404 });
    }
    assert.equal(name, 'CreateAgentApiKey');
    assert.equal(input.AgentId, newId);
    return { data: { ApiKey: KEY } };
  } });
  const fetchImpl = async (_, { body }) => {
    assert.equal(JSON.parse(body).AgentId, newId);
    return Response.json({ Code: 0, Data: { Ticket: 't'.repeat(43) } });
  };
  const service = createAssistantDesktop({ storeDir, fetchImpl, getClient,
    env: { AGENTKIT_PERSONAL_ASSISTANT_GATEWAY_URL: gatewayUrl } });
  assert.deepEqual(await service.configuration(), { configured: true, agentId: newId });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).agentId, newId);
});
function harness({ env = {}, catalog = { '0.1.56': {}, '0.1.58': {} }, region = 'pre-online', agentStatus, agentApiKey, deploymentApiKey, failCreateKey = false, onStatusRead } = {}) {
  const storeDirPromise = mkdtemp(join(tmpdir(), 'pa-assistant-desktop-'));
  let created = false;
  let request;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    return Response.json({ Code: 0, Data: {
      Ticket: 't'.repeat(43), ExpiresAt: Math.floor(Date.now() / 1000) + 45,
      AgentId: body.AgentId, BotId: body.BotId, WsPath: 'personal-assistant/desktop/ws',
      Protocol: 'agentkit.personal-assistant.desktop.v1', LeaseId: null,
    } });
  };
  const client = { action: async (name, payload) => {
    if (name === 'ListAgents') {
      onStatusRead?.(name);
      return { data: { Agents: created && !agentStatus ? [{ AgentId: AGENT, Name: '个人助理', Framework: 'personal-assistant', Status: 'RUNNING' }] : [] } };
    }
    if (name === 'GetAgent') {
      assert.equal(payload.AgentId, AGENT);
      onStatusRead?.(name);
      return { data: { Basic: { AgentId: AGENT, Name: '个人助理', Status: agentStatus || 'RUNNING' },
        Deployment: { Framework: 'personal-assistant' },
        ...(agentApiKey ? { QuickAccess: { ApiKey: agentApiKey } } : {}) } };
    }
    if (name === 'CreateAgentApiKey') {
      if (failCreateKey) throw Object.assign(new Error('CreateAgentApiKey unavailable'), { status: 500 });
      return { data: { ApiKey: KEY } };
    }
    throw new Error(`unexpected action ${name}`);
  } };
  const deployment = {
    getBootstrapConfig: async () => ({ Data: { Configs: { 'runtime.catalog': { 'personal-assistant': { versions: catalog } } } } }),
    createAgent: async payload => { request = payload; created = true; return { data: { AgentId: AGENT } }; },
    ...(deploymentApiKey ? { forAgent: () => ({ get: async () => ({ data: { QuickAccess: { ApiKey: deploymentApiKey } } }) }) } : {}),
  };
  return {
    storeDirPromise,
    get request() { return request; },
    options: { env, fetchImpl, configuration: { resolve: async () => ({ values: { cloudRegion: region } }) }, getClient: async () => client, getDeploymentClient: async () => deployment },
  };
}

test('按订单返回的实例查询真实状态，即使列表缓存还没有该实例', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let notify;
  const read = new Promise(resolve => { notify = resolve; });
  const abort = new AbortController();
  const h = harness({ agentStatus: 'RUNNING', onStatusRead: action => { notify(action); } });
  const service = createAssistantDesktop({ ...h.options, storeDir: await h.storeDirPromise });
  const creating = service.create({}, abort.signal);
  const statusAction = await read;
  if (statusAction !== 'GetAgent') {
    abort.abort();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(5_000);
    await creating.catch(() => {});
  }
  assert.equal(statusAction, 'GetAgent');
  assert.deepEqual(await creating, { configured: true, agentId: AGENT });
});

test('实例已失败时结束开通等待，不把失败误报成仍在创建', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let notify;
  const read = new Promise(resolve => { notify = resolve; });
  const abort = new AbortController();
  const h = harness({ agentStatus: 'FAILED', onStatusRead: action => { notify(action); } });
  const service = createAssistantDesktop({ ...h.options, storeDir: await h.storeDirPromise });
  const result = assert.rejects(service.create({}, abort.signal), { code: 'ASSISTANT_CREATE_FAILED' });
  if (await read !== 'GetAgent') {
    abort.abort();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(5_000);
  }
  await result;
});

test('创建个人助理跟随 catalog 最新版本，而不是使用已下架的旧版本', async () => {
  const harnessValue = harness();
  const storeDir = await harnessValue.storeDirPromise;
  const service = createAssistantDesktop({ ...harnessValue.options, storeDir });
  assert.deepEqual(await service.create({}), { configured: true, agentId: AGENT });
  assert.equal(harnessValue.request.ManagedRuntimeConfig.RuntimeVersion, '0.1.58');
  assert.match(harnessValue.request.ManagedRuntimeConfig.Manifest, /version: 0\.1\.58/u);
});

test('显式运行时版本仍优先于 catalog 自动选择', async () => {
  const harnessValue = harness({ env: { AGENTKIT_PERSONAL_ASSISTANT_RUNTIME_VERSION: '0.1.42' } });
  const storeDir = await harnessValue.storeDirPromise;
  const service = createAssistantDesktop({ ...harnessValue.options, storeDir });
  assert.deepEqual(await service.create({}), { configured: true, agentId: AGENT });
  assert.equal(harnessValue.request.ManagedRuntimeConfig.RuntimeVersion, '0.1.42');
});

test('线上区域自动绑定线上 PA 网关，不再误报未配置', async () => {
  const harnessValue = harness({ region: 'cn-beijing-6' });
  const storeDir = await harnessValue.storeDirPromise;
  const service = createAssistantDesktop({ ...harnessValue.options, storeDir });
  assert.deepEqual(await service.create({}), { configured: true, agentId: AGENT });
  const binding = JSON.parse(await readFile(join(storeDir, 'assistant-binding.json'), 'utf8'));
  assert.equal(binding.gatewayUrl, 'https://pa-desktop.agent.kspmas.ksyun.com');
});

test('新建实例凭证接口失败时复用 GetAgent 的 QuickAccess key', async () => {
  const harnessValue = harness({ region: 'cn-beijing-6', failCreateKey: true, agentApiKey: KEY });
  const storeDir = await harnessValue.storeDirPromise;
  const service = createAssistantDesktop({ ...harnessValue.options, storeDir });
  assert.deepEqual(await service.create({}), { configured: true, agentId: AGENT });
  const binding = JSON.parse(await readFile(join(storeDir, 'assistant-binding.json'), 'utf8'));
  assert.equal(binding.apiKey, KEY);
});

test('优先通过 deployment client 读取已有 QuickAccess key', async () => {
  const harnessValue = harness({ region: 'cn-beijing-6', failCreateKey: true, deploymentApiKey: KEY });
  const storeDir = await harnessValue.storeDirPromise;
  const service = createAssistantDesktop({ ...harnessValue.options, storeDir });
  assert.deepEqual(await service.create({}), { configured: true, agentId: AGENT });
  const binding = JSON.parse(await readFile(join(storeDir, 'assistant-binding.json'), 'utf8'));
  assert.equal(binding.apiKey, KEY);
});
