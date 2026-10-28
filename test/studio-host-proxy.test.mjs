import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAssistantHostGateway, registerPersonalAssistantHostGateway } from '../src/host-gateway.mjs';

const ticket = 'p'.repeat(43);
const status = (agentId = 'ar-studio') => ({ configured: true, agentId, apiKey: 'must-stay-in-studio' });
const grant = (input, extra = {}) => ({
  ticket, expiresAt: new Date(Date.now() + 30_000).toISOString(),
  agentId: input.agentId, botId: input.botId,
  wsUrl: 'wss://desktop.example/personal-assistant/desktop/ws',
  protocol: 'agentkit.personal-assistant.desktop.v1', leaseId: null,
  readOnly: input.mode === 'read', ...extra,
});
const offline = async () => { throw new Error('插件不得自行读取凭据或调用签票 HTTP'); };

test('空插件配置通过 Studio Host 出票，RPC 只返回公开绑定与短时授权', async () => {
  let route, seen, signal;
  const controller = new AbortController();
  const service = { async configuration() { return status(); }, async issueTicket(input, abort) { seen = input; signal = abort; return grant(input, { apiKey: 'must-stay-in-studio', headers: { authorization: 'secret' } }); } };
  const ctx = {
    get(name) { assert.equal(name, 'studioPersonalAssistantDesktop'); return service; },
    connection: { fetch: { register(value) { route = value; return () => {}; } } },
  };
  registerPersonalAssistantHostGateway(ctx, {});
  const rpc = async (operation, payload = {}) => {
    const response = await route.fetch(new Request('https://studio.example/api/personal-assistant', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ type: 'client-request', rpcId: 'proxy-test', method: 'personal-assistant', payload: { operation, payload } }),
    }));
    return (await response.json()).result;
  };
  assert.deepEqual(await rpc('personal-assistant.configuration'), { ok: true, value: { configured: true, agentId: 'ar-studio' } });
  const result = await rpc('personal-assistant.desktop.ticket', { botId: 'default', mode: 'read', leaseId: 'lease-owned' });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, { agentId: 'ar-studio', botId: 'default', mode: 'read', leaseId: 'lease-owned' });
  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(result.value.wsUrl, 'wss://desktop.example/personal-assistant/desktop/ws');
  assert.equal(result.value.apiKey, undefined);
  assert.equal(result.value.headers, undefined);
  assert.equal(JSON.stringify(result).includes('must-stay-in-studio'), false);
});

test('服务晚加载和换实例即时生效，卸载后不降级使用旧凭据', async () => {
  let service;
  const gateway = createPersonalAssistantHostGateway({}, { env: {}, getStudioDesktop: () => service, fetchImpl: offline });
  assert.deepEqual(await gateway.request('personal-assistant.configuration'), { configured: false });
  let selected = 'ar-first';
  service = { configuration: async () => status(selected), issueTicket: async input => grant(input) };
  assert.equal((await gateway.request('personal-assistant.configuration')).agentId, 'ar-first');
  selected = 'ar-second';
  await assert.rejects(gateway.request('personal-assistant.desktop.ticket', { agentId: 'ar-first', botId: 'default' }), { status: 403 });
  assert.equal((await gateway.request('personal-assistant.desktop.ticket', { botId: 'default', mode: 'read' })).agentId, 'ar-second');
  service = undefined;
  await assert.rejects(gateway.request('personal-assistant.desktop.ticket', { botId: 'default' }), { code: 'PERSONAL_ASSISTANT_STUDIO_UNAVAILABLE', status: 503 });
});

test('Studio 拒绝、未绑定或代理异常均不回退静态 API key，原始错误不泄漏', async () => {
  const direct = { gatewayUrl: 'https://legacy.example', agentId: 'ar-legacy', apiKey: 'legacy-secret' };
  for (const code of [401, 403, 409, 503]) {
    const gateway = createPersonalAssistantHostGateway(direct, { env: {}, fetchImpl: offline,
      getStudioDesktop: () => ({ configuration: async () => status(), issueTicket: async () => { throw Object.assign(new Error('Authorization: secret-in-error'), { status: code }); } }),
    });
    await assert.rejects(gateway.request('personal-assistant.desktop.ticket', { botId: 'default' }), error => error.status === code && !error.message.includes('secret-in-error'));
  }
  const unbound = createPersonalAssistantHostGateway(direct, { env: {}, fetchImpl: offline,
    getStudioDesktop: () => ({ configuration: async () => ({ configured: false }), issueTicket: offline }),
  });
  assert.deepEqual(await unbound.request('personal-assistant.configuration'), { configured: false, gatewayUrl: 'https://legacy.example' });
  await assert.rejects(unbound.request('personal-assistant.desktop.ticket', { botId: 'default' }), { status: 409 });
});

test('代理票据绑定、有效期与 WS 地址严格校验，不透传任意返回字段', async () => {
  for (const extra of [
    { agentId: 'ar-other' }, { botId: 'other' }, { readOnly: false },
    { wsUrl: 'wss://desktop.example/personal-assistant/desktop/ws?token=secret' },
    { wsUrl: 'wss://user:secret@desktop.example/personal-assistant/desktop/ws' },
    { wsUrl: 'https://desktop.example/personal-assistant/desktop/ws' },
    { wsUrl: 'ws://desktop.example/personal-assistant/desktop/ws' },
    { wsUrl: 'wss://desktop.example/other' },
    { protocol: 'wrong' }, { ticket: 'short' },
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
    { expiresAt: new Date(Date.now() + 120_000).toISOString() },
  ]) {
    const gateway = createPersonalAssistantHostGateway({}, { env: {}, fetchImpl: offline,
      getStudioDesktop: () => ({ configuration: async () => status(), issueTicket: async input => grant(input, extra) }),
    });
    await assert.rejects(gateway.request('personal-assistant.desktop.ticket', { botId: 'default', mode: 'read' }), { code: 'PERSONAL_ASSISTANT_TICKET_INVALID', status: 502 });
  }
});

test('目录继续使用 __directory__ 只读票据，代理不授予控制', async () => {
  let issued;
  class Socket {
    constructor(_url, protocols) { assert.ok(protocols.includes(`agentkit.desktop.ticket.${ticket}`)); queueMicrotask(() => this.onopen?.()); }
    send(raw) { assert.deepEqual(JSON.parse(raw), { type: 'bots.list' }); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'bots', bots: [{ botId: 'default', displayName: 'Personal Assistant' }] }) })); }
    close() {}
  }
  const gateway = createPersonalAssistantHostGateway({}, { env: {}, fetchImpl: offline, WebSocketImpl: Socket,
    getStudioDesktop: () => ({ configuration: async () => status(), issueTicket: async input => { issued = input; return grant(input); } }),
  });
  assert.deepEqual(await gateway.request('personal-assistant.bots.list'), { bots: [{ botId: 'default', displayName: '默认助理' }], directoryAvailable: true });
  assert.deepEqual(issued, { agentId: 'ar-studio', botId: '__directory__', mode: 'read' });
});

test('绑定操作只把公开状态转给页面：发现、凭据恢复与创建都在 Studio 内完成', async () => {
  const calls = [];
  const service = {
    async configuration() { return { configured: false }; },
    async issueTicket() { throw new Error('not used'); },
    async status() { return { configured: true, agentId: 'ar-studio', gatewayUrl: 'https://gw.example', reason: '', candidates: [{ agentId: 'ar-studio', name: '我的个人助理', status: 'RUNNING', createdAt: '2026-10-26T06:34:22Z', apiKey: 'never' }] }; },
    async connect(input) { calls.push(['connect', input]); return { configured: true, agentId: 'ar-studio' }; },
    async create(input) { calls.push(['create', input]); return { configured: true, agentId: 'ar-studio' }; },
    async disconnect() { calls.push(['disconnect', {}]); return { configured: false }; },
  };
  const gateway = createPersonalAssistantHostGateway({}, { env: {}, fetchImpl: offline, getStudioDesktop: () => service });
  const status = await gateway.request('personal-assistant.desktop.status');
  assert.equal(status.configured, true);
  assert.equal(status.mode, 'studio');
  assert.equal(status.candidates.length, 1);
  assert.equal(status.candidates[0].apiKey, undefined);
  assert.equal(JSON.stringify(status).includes('gw.example'), false);
  assert.deepEqual(await gateway.request('personal-assistant.desktop.connect', { agentId: 'ar-studio' }), { configured: true, agentId: 'ar-studio', mode: 'studio' });
  assert.deepEqual(await gateway.request('personal-assistant.desktop.create'), { configured: true, agentId: 'ar-studio', mode: 'studio' });
  assert.deepEqual(await gateway.request('personal-assistant.desktop.disconnect'), { configured: false, agentId: undefined, mode: 'studio' });
  assert.deepEqual(calls, [['connect', { agentId: 'ar-studio' }], ['create', {}], ['disconnect', {}]]);
});

test('没有 Studio 服务时绑定操作明确报错，不会静默退回本地配置', async () => {
  const gateway = createPersonalAssistantHostGateway({ gatewayUrl: 'https://legacy.example', agentId: 'ar-legacy', apiKey: 'legacy-secret' }, { env: {}, fetchImpl: offline });
  await assert.rejects(gateway.request('personal-assistant.desktop.status'), { code: 'PERSONAL_ASSISTANT_STANDALONE', status: 409 });
  await assert.rejects(gateway.request('personal-assistant.desktop.connect', { agentId: '../bad' }), { code: 'PERSONAL_ASSISTANT_AGENT_INVALID' });
});

test('Studio 绑定错误保留可读原因且不泄漏凭据', async () => {
  const service = {
    async configuration() { return { configured: false }; },
    async issueTicket() { throw new Error('nope'); },
    async status() { throw Object.assign(new Error('云端暂时无法获取连接凭证'), { status: 503, code: 'ASSISTANT_CREDENTIAL_UNAVAILABLE' }); },
    async connect() { throw Object.assign(new Error('ak-secret-123 不可用'), { status: 503 }); },
  };
  const gateway = createPersonalAssistantHostGateway({}, { env: {}, fetchImpl: offline, getStudioDesktop: () => service });
  await assert.rejects(gateway.request('personal-assistant.desktop.status'), { status: 503, code: 'ASSISTANT_CREDENTIAL_UNAVAILABLE' });
  const error = await gateway.request('personal-assistant.desktop.connect').catch(value => value);
  assert.equal(error.status, 503);
  assert.equal(error.code, 'PERSONAL_ASSISTANT_BINDING_FAILED');
});


test('关闭个人助理必须由页面确认实例标识，且只关闭当前绑定', async () => {
  const seen = [];
  const gateway = createPersonalAssistantHostGateway({}, { env: {}, fetchImpl: offline,
    getStudioDesktop: () => ({
      configuration: async () => status(),
      issueTicket: async input => grant(input),
      destroy: async (input, signal) => { seen.push({ input, signal }); return { configured: false, agentId: input.agentId, closed: true }; },
    }),
  });
  await assert.rejects(gateway.request('personal-assistant.desktop.destroy'), { code: 'PERSONAL_ASSISTANT_AGENT_INVALID' });
  await assert.rejects(gateway.request('personal-assistant.desktop.destroy', { confirmAgentId: 'bad id' }), { code: 'PERSONAL_ASSISTANT_AGENT_INVALID' });
  const closed = await gateway.request('personal-assistant.desktop.destroy', { confirmAgentId: 'ar-studio' });
  assert.deepEqual(closed, { configured: false, mode: 'studio', closed: true });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].input, { agentId: 'ar-studio', confirmAgentId: 'ar-studio' });
  assert.equal(seen[0].signal instanceof AbortSignal, true);
  assert.equal(JSON.stringify(closed).includes('must-stay-in-studio'), false);
});

test('设置读写经 Studio Host 转发，页面参数被收敛且凭据不出 Host', async () => {
  const seen = [];
  const service = {
    configuration: async () => status('ar-studio'),
    issueTicket: async () => { throw new Error('unused'); },
    settings: async input => { seen.push(['settings', input]); return { configured: true, agentId: 'ar-studio', recordSource: 'studio',
      model: 'deepseek-v4.1-flash-1017', prompt: 'p', runtime: { name: 'personal-assistant', version: '0.1.37' },
      environmentVariables: [{ key: 'OPENAI_API_KEY', value: '', sensitive: true }] }; },
    settingsUpdate: async input => { seen.push(['update', input]); return { configured: true, agentId: 'ar-studio', saved: true, version: '0.1.37' }; },
    settingsVersions: async input => { seen.push(['versions', input]); return { currentVersion: '0.1.37', versions: [], catalogAvailable: false }; },
  };
  const gateway = createPersonalAssistantHostGateway({}, { env: {}, fetchImpl: offline, getStudioDesktop: () => service });
  const inspected = await gateway.request('personal-assistant.settings.inspect', {});
  assert.equal(inspected.model, 'deepseek-v4.1-flash-1017');
  assert.deepEqual(seen[0], ['settings', {}]);
  const updated = await gateway.request('personal-assistant.settings.update', {
    model: 'deepseek-v4.1-flash-1017', prompt: '新提示词', runtimeVersion: '0.1.37',
    environmentVariables: [{ key: 'FLAG', value: '1' }], deleteKeys: ['OLD'],
    apiKey: 'page-secret', gatewayUrl: 'https://evil.example',
  });
  assert.equal(updated.saved, true);
  assert.deepEqual(seen[1], ['update', { model: 'deepseek-v4.1-flash-1017', prompt: '新提示词', runtimeVersion: '0.1.37',
    environmentVariables: [{ key: 'FLAG', value: '1' }], deleteKeys: ['OLD'] }]);
  const versions = await gateway.request('personal-assistant.settings.versions', { currentVersion: '0.1.37', agentId: 'ar-studio' });
  assert.equal(versions.currentVersion, '0.1.37');
  assert.deepEqual(seen[2], ['versions', { currentVersion: '0.1.37' }]);
});

test('设置写入的云端拒绝保留可读错误码，不把原始异常暴露为成功', async () => {
  const gateway = createPersonalAssistantHostGateway({}, { env: {}, fetchImpl: offline, getStudioDesktop: () => ({
    configuration: async () => status('ar-studio'),
    issueTicket: async () => { throw new Error('unused'); },
    settingsUpdate: async () => { throw Object.assign(new Error('当前云端平台版本还不支持个人助理的配置更新'), { code: 'ASSISTANT_SETTINGS_UNSUPPORTED', status: 409 }); },
  }) });
  await assert.rejects(() => gateway.request('personal-assistant.settings.update', { model: 'm' }),
    error => error.code === 'ASSISTANT_SETTINGS_UNSUPPORTED' && error.status === 409 && /不支持/u.test(error.message));
});
