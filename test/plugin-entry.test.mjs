import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createRuntime, name } from '../src/index.mjs';
import { createPersonalAssistantClient, PersonalAssistantGatewayUnavailableError } from '../src/client/index.mjs';

test('host entry is disabled and has no implicit Computer connection', () => {
  const runtime = apply({ kind: 'test-context' }, { bots: [{ botId: 'writer', systemPromptRevision: 'w1' }] });
  assert.equal(name, '@kingsoftcloud/agentkit-personal-assistant');
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.computerBroker.connected(), false);
  assert.equal(runtime.registry.require('writer').systemPromptRevision, 'w1');
});

test('client adapter requires an explicit gateway', async () => {
  const client = createPersonalAssistantClient();
  assert.throws(() => client.listBots(), PersonalAssistantGatewayUnavailableError);
  assert.equal(createRuntime(null, { enabled: true }).enabled, true);
});
