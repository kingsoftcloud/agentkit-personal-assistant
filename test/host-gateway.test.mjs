import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAssistantHostGateway, registerPersonalAssistantHostGateway } from '../src/host-gateway.mjs';

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
