import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAssistantHostGateway } from '../src/host-gateway.mjs';

test('云端未绑定时会话失败关闭，绝不使用注入的本地会话控制器', async () => {
  let localCalls = 0;
  const gateway = createPersonalAssistantHostGateway({}, { env: {}, sessionChannel: {
    listSessions() { localCalls++; return { sessions: [{ sessionId: 'local-only' }] }; },
    submitTurn() { localCalls++; return { turnId: 'local-turn' }; },
  } });
  await assert.rejects(gateway.request('personal-assistant.sessions.list', { botId: 'default' }), { code: 'PERSONAL_ASSISTANT_GATEWAY_UNCONFIGURED' });
  await assert.rejects(gateway.request('personal-assistant.turn.submit', { botId: 'default', sessionId: 's1', text: 'hello' }), { code: 'PERSONAL_ASSISTANT_GATEWAY_UNCONFIGURED' });
  assert.equal(localCalls, 0);
});
