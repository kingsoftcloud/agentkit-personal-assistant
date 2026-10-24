import { BotRegistry } from './bot-registry.mjs';
import { createComputerBrokerClient } from './computer-broker.mjs';
import { createComputerToolset } from './cloud-computer-tools.mjs';
import { createScheduleManager } from './schedule-manager.mjs';
import { workspaceDir } from './workspace.mjs';
import { createDshTurnBridge, sessionControllerFromContext } from './dsh-session-bridge.mjs';
export { IMPLEMENTED_RUNTIME_CAPABILITIES } from './implementation-capabilities.mjs';
export { DshSessionControllerUnavailableError, createDshTurnBridge, sessionControllerFromContext } from './dsh-session-bridge.mjs';

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
  const scheduleManager = config.scheduleManager ?? createScheduleManager({ now: config.now });
  const workspace = workspaceDir(config.workspace);
  const turnBridge = config.turnBridge ?? createDshTurnBridge({
    ctx,
    sessionController: config.sessionController ?? sessionControllerFromContext(ctx),
    registry,
  });
  const createBotComputerToolset = ({ botId, ...options } = {}) => createComputerToolset({
    broker: computerBroker, userId: config.userId, assistantId: config.assistantId, computerId: config.computerId,
    botId: botId ?? config.botId, ...options,
  });
  return Object.freeze({
    ctx,
    config: Object.freeze({ ...config }),
    enabled: config.enabled === true,
    registry,
    computerBroker,
    scheduleManager,
    workspace,
    turnBridge,
    submitTurn: turnBridge.submitTurn,
    createComputerToolset: createBotComputerToolset,
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
  createHttpComputerBrokerTransport,
  createMockComputerBroker,
} from './computer-broker.mjs';
export * from './computer-broker-protocol.mjs';
export * from './cloud-computer-tools.mjs';
export * from './schedule-manager.mjs';
export * from './workspace.mjs';
