import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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


for (const [remote, expected] of [
  [{ type: 'error', code: 'DESKTOP_MESSAGE_UNSUPPORTED' }, { code: 'PERSONAL_ASSISTANT_DIRECTORY_UNSUPPORTED', status: 409 }],
  [{ type: 'error', code: 'DESKTOP_DIRECTORY_SCOPE_REQUIRED', status: 403 }, { code: 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED', status: 403 }],
  [{ type: 'error', code: 'DESKTOP_UNAUTHORIZED', status: 401 }, { code: 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED', status: 401 }],
]) {
  test(`目录错误保留可恢复与鉴权拒绝边界：${remote.code}`, async () => {
    class Socket {
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send() { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(remote) })); }
      close() {}
    }
    const gateway = createPersonalAssistantHostGateway({ gatewayUrl: 'https://gateway.example/', agentId: 'ar-test', apiKey: 'host-secret' }, {
      env: {}, WebSocketImpl: Socket,
      fetchImpl: async () => Response.json({ Code: 0, Data: { AgentId: 'ar-test', BotId: DIRECTORY_BOT_ID, Ticket: 't'.repeat(43), WsPath: 'personal-assistant/desktop/ws' } }),
    });
    await assert.rejects(gateway.request('personal-assistant.bots.list'), expected);
  });
}


for (const status of [401, 403, 503]) test(`HTTP 升级拒绝 ${status} 不丢失鉴权或临时错误分类`, async () => {
  let drained = false, closed = false;
  class Socket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('unexpected-response', {}, { statusCode: status, resume() { drained = true; } })); }
    close() { closed = true; }
  }
  const gateway = createPersonalAssistantHostGateway({ gatewayUrl: 'https://gateway.example/', agentId: 'ar-test', apiKey: 'host-secret' }, {
    env: {}, WebSocketImpl: Socket,
    fetchImpl: async () => Response.json({ Code: 0, Data: { AgentId: 'ar-test', BotId: DIRECTORY_BOT_ID, Ticket: 't'.repeat(43), WsPath: 'personal-assistant/desktop/ws' } }),
  });
  await assert.rejects(gateway.request('personal-assistant.bots.list'), { code: status === 503 ? 'PERSONAL_ASSISTANT_DIRECTORY_UNAVAILABLE' : 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED', status });
  assert.equal(drained, true); assert.equal(closed, true);
});

test('未完成 WS 握手的不透明错误不会被当成可回退目录', async () => {
  class Socket {
    constructor() { queueMicrotask(() => this.onerror?.({})); }
    close() {}
  }
  const gateway = createPersonalAssistantHostGateway({ gatewayUrl: 'https://gateway.example/', agentId: 'ar-test', apiKey: 'host-secret' }, {
    env: {}, WebSocketImpl: Socket,
    fetchImpl: async () => Response.json({ Code: 0, Data: { AgentId: 'ar-test', BotId: DIRECTORY_BOT_ID, Ticket: 't'.repeat(43), WsPath: 'personal-assistant/desktop/ws' } }),
  });
  await assert.rejects(gateway.request('personal-assistant.bots.list'), { code: 'PERSONAL_ASSISTANT_DIRECTORY_REFUSED', status: 502 });
});

for (const code of [1006, 1008]) test(`目录关闭只保留安全诊断码 ${code}，不暴露原始 reason`, async () => {
  class Socket {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send() { queueMicrotask(() => this.onclose?.({ code, reason: 'agentkit.desktop.ticket.must-never-leak' })); }
    close() {}
  }
  const gateway = createPersonalAssistantHostGateway({ gatewayUrl: 'https://gateway.example/', agentId: 'ar-test', apiKey: 'host-secret' }, {
    env: {}, WebSocketImpl: Socket,
    fetchImpl: async () => Response.json({ Code: 0, Data: { AgentId: 'ar-test', BotId: DIRECTORY_BOT_ID, Ticket: 't'.repeat(43), WsPath: 'personal-assistant/desktop/ws' } }),
  });
  await assert.rejects(gateway.request('personal-assistant.bots.list'), error => {
    assert.equal(error.closeCode, code);
    assert.equal(error.status, code === 1008 ? 403 : 502);
    assert.match(error.message, new RegExp(String(code)));
    assert.equal(error.message.includes('must-never-leak'), false);
    return true;
  });
});
