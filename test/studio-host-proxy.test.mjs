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
  assert.deepEqual(await unbound.request('personal-assistant.configuration'), { configured: false });
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
