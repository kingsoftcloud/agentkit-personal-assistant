import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAssistantHostGateway } from '../src/host-gateway.mjs';
import { DIRECTORY_BOT_ID, publicBotDirectory } from '../src/client/bot-directory.mjs';

test('真实目录通过已有网关鉴权通道查询，Host 不再返回固定空数组', async () => {
  const calls = [], sockets = [];
  class Socket {
    constructor(url, protocols) { this.url = url; this.protocols = protocols; sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      assert.deepEqual(JSON.parse(raw), { type: 'bots.list' });
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'bots', bots: [{ botId: 'default', displayName: 'Personal Assistant', systemPrompt: 'private', apiKey: 'private' }] }) }));
    }
    close() { this.closed = true; }
  }
  const gateway = createPersonalAssistantHostGateway({ gatewayUrl: 'https://gateway.example/', agentId: 'ar-test', apiKey: 'host-secret' }, {
    env: {}, WebSocketImpl: Socket,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({ Code: 0, Data: { AgentId: 'ar-test', BotId: DIRECTORY_BOT_ID, Ticket: 't'.repeat(43), WsPath: 'personal-assistant/desktop/ws' } });
    },
  });
  const directory = await gateway.request('personal-assistant.bots.list');
  assert.deepEqual(directory, { bots: [{ botId: 'default', displayName: '默认助理' }], directoryAvailable: true });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).Mode, 'read');
  assert.equal(JSON.parse(calls[0].options.body).BotId, DIRECTORY_BOT_ID);
  assert.equal(sockets[0].url, 'wss://gateway.example/personal-assistant/desktop/ws');
  assert.equal(new URL(sockets[0].url).search, '');
  assert.equal(sockets[0].closed, true);
  assert.equal(JSON.stringify(directory).includes('private'), false);
});

test('目录只保留名称与身份，拒绝重复身份和格式越界', () => {
  assert.deepEqual(publicBotDirectory([{ botId: 'writer', displayName: '写作助理', memoryNamespace: 'private', toolPolicy: {} }]), [{ botId: 'writer', displayName: '写作助理' }]);
  assert.throws(() => publicBotDirectory([{ botId: 'same' }, { botId: 'same' }]));
  assert.throws(() => publicBotDirectory([{ botId: DIRECTORY_BOT_ID }]));
});
