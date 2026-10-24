import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createRuntime, name } from '../src/index.mjs';
import {
  apply as applyClient,
  createPersonalAssistantClient,
  PersonalAssistantGatewayUnavailableError,
  PersonalAssistantPanel,
  PersonalAssistantPanelIcon,
  PERSONAL_ASSISTANT_CLIENT_DEFAULTS,
  PERSONAL_ASSISTANT_PANEL_ID,
  inject as clientInject,
} from '../src/client/index.mjs';

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

test('client exposes broker-backed browser and terminal operations without auto-connect', async () => {
  const requests = [];
  const client = createPersonalAssistantClient({ profileId: 'profile-1', gateway: { request: async (operation, payload) => { requests.push({ operation, payload }); return { ok: true }; } } });
  client.selectBot('researcher');
  await client.browserOpen('https://example.com');
  await client.browserSnapshot();
  await client.cloudBash('printf ok');
  await client.cloudRunCode('python', 'print(1)');
  assert.deepEqual(requests.map(item => item.payload.action), ['open', 'snapshot', 'terminal.exec', 'terminal.exec']);
  assert.equal(requests[0].payload.profileId, 'profile-1');
  assert.equal(requests[2].payload.args.language, 'shell');
});

test('client maps durable session, memory, and schedule operations to the public gateway', async () => {
  const requests = [];
  const client = createPersonalAssistantClient({ gateway: { request: async (operation, payload) => { requests.push({ operation, payload }); return { ok: true }; } } });
  client.selectBot('researcher');
  await client.createSession({ title: 'Plan' });
  await client.listSessions();
  await client.listMessages('session-1');
  await client.appendMessage('session-1', { role: 'user', content: 'hello' });
  await client.listTurns('session-1');
  await client.submitTurn('session-1', { input: 'continue' });
  await client.remember({ key: 'project', content: 'marker' });
  await client.searchMemory('marker');
  await client.createSchedule({ scheduleId: 'review', runAt: 123 });
  await client.listSchedules();
  await client.deleteSchedule('review');
  assert.deepEqual(requests.map(item => item.operation), [
    'personal-assistant.sessions.create', 'personal-assistant.sessions.list',
    'personal-assistant.sessions.messages.list', 'personal-assistant.sessions.messages.append',
    'personal-assistant.sessions.turns.list', 'personal-assistant.sessions.turns.submit',
    'personal-assistant.memory.upsert', 'personal-assistant.memory.search',
    'personal-assistant.schedules.create', 'personal-assistant.schedules.list',
    'personal-assistant.schedules.delete',
  ]);
  assert.equal(requests[0].payload.botId, 'researcher');
  assert.equal(requests.find(item => item.operation === 'personal-assistant.memory.upsert').payload.key, 'project');
});


test('public DSH client entry registers a closed main panel and sidebar row', () => {
  const entries = [];
  const ctx = {
    slots: {
      inject(name, factory) {
        entries.push(factory());
        assert.ok(['main', 'sidebar.panellist'].includes(name));
      },
      register(definition, component) {
        return { definition, component };
      },
    },
  };
  applyClient(ctx);
  assert.deepEqual(clientInject, ['slots']);
  assert.deepEqual(entries.map(entry => entry.definition.name), ['main', 'sidebar.panellist']);
  assert.equal(entries[0].definition.key, PERSONAL_ASSISTANT_PANEL_ID);
  assert.equal(entries[1].definition.id, PERSONAL_ASSISTANT_PANEL_ID);
  assert.equal(entries[0].component(), 'Personal Assistant is disabled by default. Enable the plugin to connect.');
  assert.equal(entries[1].component(), 'PA');
  assert.deepEqual(PERSONAL_ASSISTANT_CLIENT_DEFAULTS, { enabled: false, autoConnect: false });
});

test('client apply rejects a context without the public DSH slots service', () => {
  assert.throws(() => applyClient({}), /public DSH slots service/);
});
