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

export const createClientPlugin = createPersonalAssistantClient;
