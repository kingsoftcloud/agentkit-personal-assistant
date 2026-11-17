import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAssistantHostGateway, registerPersonalAssistantHostGateway } from '../src/host-gateway.mjs';
import { BotRegistry } from '../src/bot-registry.mjs';
import { createLocalAccess } from '../src/local-access.mjs';

const config = { gatewayUrl: 'https://gateway.example/', agentId: 'ar-real', apiKey: 'host-only-secret' };
const ticket = 'a'.repeat(43);
test('Host locks cloud origin and identity, normalizes tickets without disclosing its key', async () => {
  const calls = [];
  const gateway = createPersonalAssistantHostGateway(config, { env: {}, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ Code: 0, Data: { Ticket: ticket, AgentId: 'ar-real', BotId: 'researcher', WsPath: 'personal-assistant/desktop/ws', ExpiresAt: '2026-10-25T00:01:00Z' } });
  } });
  const status = await gateway.request('personal-assistant.configuration');
  assert.equal(status.configured, true);
  // 设置页需要显示当前绑定的云端环境；只暴露 origin，凭据仍然不出 Host。
  assert.equal(status.gatewayUrl, 'https://gateway.example');
  assert.equal(JSON.stringify(status).includes(config.apiKey), false);
  const result = await gateway.request('personal-assistant.desktop.ticket', { agentId: 'ar-real', botId: 'researcher', mode: 'read' });
  assert.equal(result.wsUrl, 'wss://gateway.example/personal-assistant/desktop/ws');
  assert.equal(result.ticket, ticket);
  assert.equal(result.readOnly, true);
  assert.equal(calls[0].url, 'https://gateway.example/IssuePersonalAssistantDesktopTicket');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${config.apiKey}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { AgentId: 'ar-real', BotId: 'researcher', Mode: 'read' });
  await assert.rejects(gateway.request('personal-assistant.desktop.ticket', { agentId: 'ar-another', botId: 'b' }), { status: 403 });
  assert.equal(calls.length, 1);
});

test('Host refuses prefixes, credentials and browser-supplied ticket routing', async () => {
  for (const gatewayUrl of ['https://gateway.example/api', 'https://name:secret@gateway.example', 'https://gateway.example?token=secret']) {
    assert.throws(() => createPersonalAssistantHostGateway({ ...config, gatewayUrl }, { env: {} }), { code: 'PERSONAL_ASSISTANT_GATEWAY_INVALID' });
  }
  const gateway = createPersonalAssistantHostGateway(config, { env: {}, fetchImpl: async () => Response.json({ Code: 0, Data: { Ticket: ticket, AgentId: 'ar-real', BotId: 'b', WsPath: 'https://evil.example/ws' } }) });
  await assert.rejects(gateway.request('personal-assistant.desktop.ticket', { botId: 'b' }), { status: 502 });
});

test('DSH owner-only Connection Fetch carries the standard RPC envelope and cleans up', async () => {
  let route, removed = false;
  const dispose = registerPersonalAssistantHostGateway({ connection: { fetch: { register(value) { route = value; return () => { removed = true; }; } } } }, {});
  assert.equal(route.path, '/api/personal-assistant');
  assert.deepEqual(route.methods, ['POST']);
  const handler = async (operation, payload) => {
    const result = await route.fetch(new Request('https://studio.example/api/personal-assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'request-1', method: 'personal-assistant', payload: { operation, payload } }) }));
    const envelope = await result.json(); assert.equal(envelope.rpcId, 'request-1'); assert.equal(envelope.type, 'server-response'); return envelope.result;
  };
  const status = await handler('personal-assistant.configuration', {});
  assert.equal(status.ok, true);
  assert.equal(status.value.configured, false);
  const directory = await handler('personal-assistant.bots.list', {});
  assert.deepEqual(directory.value.bots, []);
  assert.equal(directory.value.directoryAvailable, false);
  const result = await handler('personal-assistant.desktop.ticket', { botId: 'b' });
  assert.equal(result.ok, false);
  assert.equal(result.error.details.status, 409);
  assert.equal((await handler('arbitrary.operation', {})).error.details.status, 404);
  const oversized = await route.fetch(new Request('https://studio.example/api/personal-assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(16_385) }));
  assert.equal((await oversized.json()).result.error.details.status, 413);
  dispose(); assert.equal(removed, true);
});

test('unbound Host refuses placeholder grants and local operations remain unauthorized', async () => {
  const gateway = createPersonalAssistantHostGateway({}, { env: {} });
  assert.equal((await gateway.request('personal-assistant.local-access.status')).authorized, false);
  await assert.rejects(gateway.request('personal-assistant.local-control.session.create'), { status: 403 });
  await assert.rejects(gateway.request('personal-assistant.local-access.grant', { scopes: ['session.create'] }));
  assert.equal((await gateway.request('personal-assistant.local-access.status')).authorized, false);
  gateway.dispose();
});

test('新增本机 operation 在未绑定云端时降级返回，且不改变既有 operation 语义', async () => {
  const registry = new BotRegistry({ bots: [{ botId: 'default', displayName: '默认助理', systemPromptRevision: '1', model: 'm1' }] });
  const gateway = createPersonalAssistantHostGateway({}, {
    env: {}, botRegistry: registry, localAccess: createLocalAccess({ probeConnection: () => false }),
  });
  const overview = await gateway.request('personal-assistant.bots.overview');
  assert.deepEqual(overview.bots, [{ id: 'default', name: '默认助理', role: 'primary', status: 'idle', model: 'm1', memoryCount: 0, capabilityCount: 0, computer: 'idle' }]);
  assert.equal(overview.degraded, true);
  const detail = await gateway.request('personal-assistant.bot.detail', { botId: 'default' });
  assert.equal(detail.bot.model, 'm1');
  assert.equal(detail.degraded, true);
  await assert.rejects(gateway.request('personal-assistant.bot.detail', { botId: 'missing' }),
    { code: 'PERSONAL_ASSISTANT_BOT_NOT_FOUND', status: 404 });

  // 既有 operation 语义未变：未绑定仍是空目录、桌面出票 409。
  assert.deepEqual(await gateway.request('personal-assistant.bots.list'), { bots: [], directoryAvailable: false });
  await assert.rejects(gateway.request('personal-assistant.desktop.ticket', { botId: 'default' }), { status: 409 });
});

test('注册层把 local-control.* 交给授权校验，而不是直接回 404', async () => {
  let route;
  const dispose = registerPersonalAssistantHostGateway({ connection: { fetch: { register(value) { route = value; return () => {}; } } } }, {});
  const handler = async (operation, payload) => {
    const result = await route.fetch(new Request('https://studio.example/api/personal-assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'request-1', method: 'personal-assistant', payload: { operation, payload } }) }));
    return (await result.json()).result;
  };
  const denied = await handler('personal-assistant.local-control.session.create', {});
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'PERSONAL_ASSISTANT_LOCAL_NOT_AUTHORIZED');
  assert.equal(denied.error.details.status, 403);
  const granted = await handler('personal-assistant.local-access.grant', { scopes: ['session.create'], riskConfirm: false });
  assert.equal(granted.ok, false);
  const unsupported = await handler('personal-assistant.local-control.session.create', {});
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.details.status, 403);
  dispose();
});

test('a stale authorization page cannot grant directories to another bound assistant', async () => {
  let granted = false;
  const gateway = createPersonalAssistantHostGateway(config, { env: {}, localAccess: { grant() { granted = true; } } });
  await assert.rejects(gateway.request('personal-assistant.local-access.grant', { agentId: 'ar-old-view', botId: 'default', scopes: ['file.read'], roots: ['/documents'] }), { code: 'PERSONAL_ASSISTANT_AGENT_MISMATCH' });
  assert.equal(granted, false);
  gateway.dispose();
});
