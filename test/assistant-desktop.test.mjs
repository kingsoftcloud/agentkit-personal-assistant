import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantDesktop } from '../src/assistant-desktop.mjs';

const AGENT = 'ar-20261110220000-catalog';
const KEY = `ak-${'0123456789abcdef'.repeat(2)}`;
const configuration = { resolve: async () => ({ values: { cloudRegion: 'pre-online' } }) };

function harness({ env = {}, catalog = { '0.1.56': {}, '0.1.58': {} } } = {}) {
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
  const client = { action: async name => {
    if (name === 'ListAgents') return { data: { Agents: created ? [{ AgentId: AGENT, Name: '个人助理', Framework: 'personal-assistant', Status: 'RUNNING' }] : [] } };
    if (name === 'CreateAgentApiKey') return { data: { ApiKey: KEY } };
    throw new Error(`unexpected action ${name}`);
  } };
  const deployment = {
    getBootstrapConfig: async () => ({ Data: { Configs: { 'runtime.catalog': { 'personal-assistant': { versions: catalog } } } } }),
    createAgent: async payload => { request = payload; created = true; return { data: { AgentId: AGENT } }; },
  };
  return {
    storeDirPromise,
    get request() { return request; },
    options: { env, fetchImpl, configuration, getClient: async () => client, getDeploymentClient: async () => deployment },
  };
}

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

