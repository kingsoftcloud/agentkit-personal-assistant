/**
 * Browser-safe client adapter. The UI can use this adapter with the official
 * DSH gateway/remotes service; no private DSH module is imported here.
 */

export class PersonalAssistantGatewayUnavailableError extends Error {
  constructor() {
    super('Personal Assistant gateway is not connected');
    this.name = 'PersonalAssistantGatewayUnavailableError';
    this.code = 'PERSONAL_ASSISTANT_GATEWAY_UNAVAILABLE';
  }
}

function gatewayRequest(gateway, operation, payload) {
  if (!gateway || typeof gateway.request !== 'function') throw new PersonalAssistantGatewayUnavailableError();
  return gateway.request(operation, payload);
}

export function createPersonalAssistantClient({ gateway, profileId = 'default' } = {}) {
  let selectedBotId = null;
  const request = (operation, payload = {}) => gatewayRequest(gateway, operation, { ...payload, profileId });
  return Object.freeze({
    listBots: () => request('personal-assistant.bots.list'),
    getBot: botId => request('personal-assistant.bots.get', { botId }),
    selectBot(botId) {
      selectedBotId = String(botId ?? '').trim();
      if (!selectedBotId) throw new TypeError('botId must be a non-empty string');
      return selectedBotId;
    },
    selectedBot: () => selectedBotId,
    session: input => request('personal-assistant.session.create', { ...input, botId: input?.botId ?? selectedBotId }),
    listSessions: botId => request('personal-assistant.sessions.list', { botId: botId ?? selectedBotId }),
    createSession: input => request('personal-assistant.sessions.create', { ...input, botId: input?.botId ?? selectedBotId }),
    listMessages: sessionId => request('personal-assistant.sessions.messages.list', { sessionId, botId: selectedBotId }),
    appendMessage: (sessionId, input) => request('personal-assistant.sessions.messages.append', { sessionId, ...input, botId: input?.botId ?? selectedBotId }),
    listTurns: sessionId => request('personal-assistant.sessions.turns.list', { sessionId, botId: selectedBotId }),
    submitTurn: (sessionId, input) => request('personal-assistant.sessions.turns.submit', { sessionId, ...input, botId: input?.botId ?? selectedBotId }),
    searchMemory: query => request('personal-assistant.memory.search', { query, botId: selectedBotId }),
    remember: input => request('personal-assistant.memory.upsert', { ...input, botId: input?.botId ?? selectedBotId }),
    listSchedules: botId => request('personal-assistant.schedules.list', { botId: botId ?? selectedBotId }),
    createSchedule: input => request('personal-assistant.schedules.create', { ...input, botId: input?.botId ?? selectedBotId }),
    deleteSchedule: scheduleId => request('personal-assistant.schedules.delete', { scheduleId, botId: selectedBotId }),
    computerStatus: computerId => request('personal-assistant.computer.status', { computerId, botId: selectedBotId }),
    computerAction: input => request('personal-assistant.computer.action', { ...input, botId: input?.botId ?? selectedBotId }),
    browserOpen: url => request('personal-assistant.computer.action', { action: 'open', args: { url }, botId: selectedBotId }),
    browserSnapshot: () => request('personal-assistant.computer.action', { action: 'snapshot', args: {}, botId: selectedBotId }),
    browserClick: selector => request('personal-assistant.computer.action', { action: 'click', args: { selector }, botId: selectedBotId }),
    browserType: (text, selector) => request('personal-assistant.computer.action', { action: 'type', args: { text, ...(selector === undefined ? {} : { selector }) }, botId: selectedBotId }),
    browserPress: key => request('personal-assistant.computer.action', { action: 'press', args: { key }, botId: selectedBotId }),
    browserScreenshot: () => request('personal-assistant.computer.action', { action: 'screenshot', args: {}, botId: selectedBotId }),
    browserDownload: args => request('personal-assistant.computer.action', { action: 'download', args: args || {}, botId: selectedBotId }),
    browserClose: () => request('personal-assistant.computer.action', { action: 'stop', args: {}, botId: selectedBotId }),
    cloudBash: (command, timeoutMs) => request('personal-assistant.computer.action', { action: 'terminal.exec', args: { language: 'shell', command, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, botId: selectedBotId }),
    cloudRunCode: (language, code, timeoutMs) => request('personal-assistant.computer.action', { action: 'terminal.exec', args: { language, code, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, botId: selectedBotId }),
  });
}

/**
 * Public DSH client entry contract. The loader calls `apply(ctx)` after the
 * renderer and layout services are available. The default panel is inert:
 * it does not select itself, open a gateway, or create a Computer connection.
 * The returned strings are valid ReactNodes and keep this skeleton free of a
 * private React/DOM dependency; the product UI can replace these slot entries
 * with a real component in a later plugin revision.
 */
export const inject = Object.freeze(['slots']);
export const PERSONAL_ASSISTANT_PANEL_ID = 'personal-assistant';
export const PERSONAL_ASSISTANT_CLIENT_DEFAULTS = Object.freeze({
  enabled: false,
  autoConnect: false,
});

export function PersonalAssistantPanel() {
  return 'Personal Assistant is disabled by default. Enable the plugin to connect.';
}

export function PersonalAssistantPanelIcon() {
  return 'PA';
}

export function apply(ctx) {
  if (!ctx?.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
    throw new TypeError('Personal Assistant client requires the public DSH slots service');
  }
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PERSONAL_ASSISTANT_PANEL_ID },
    PersonalAssistantPanel,
  ));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    {
      name: 'sidebar.panellist',
      id: PERSONAL_ASSISTANT_PANEL_ID,
      order: 90,
      label: 'Personal Assistant',
    },
    PersonalAssistantPanelIcon,
  ));
}

export const createClientPlugin = createPersonalAssistantClient;
