import { BotRegistry } from './bot-registry.mjs';
import { createComputerBrokerClient } from './computer-broker.mjs';

export const name = '@kingsoftcloud/agentkit-personal-assistant';
export const inject = Object.freeze([
  'llm',
  'tools',
  'systemPrompt',
  'sessionController',
  'sessions',
  'connection',
]);

/**
 * Construct the host runtime without reaching a real Computer by default.
 * A deployment must explicitly provide a documented broker transport.
 */
export function createRuntime(ctx, config = {}) {
  const registry = new BotRegistry({ profileId: config.profileId ?? 'default', bots: config.bots ?? [] });
  const computerBroker = config.computerBroker ?? createComputerBrokerClient({ transport: config.computerTransport });
  return Object.freeze({
    ctx,
    config: Object.freeze({ ...config }),
    enabled: config.enabled === true,
    registry,
    computerBroker,
  });
}

export function apply(ctx, config = {}) {
  return createRuntime(ctx, config);
}

export { BotRegistry, createBotRegistry, normalizeBotDefinition } from './bot-registry.mjs';
export {
  ComputerBrokerUnavailableError,
  ComputerLeaseConflictError,
  ComputerLeaseManager,
  createComputerBrokerClient,
  createMockComputerBroker,
} from './computer-broker.mjs';
export * from './computer-broker-protocol.mjs';
