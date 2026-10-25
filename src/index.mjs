import { BotRegistry } from './bot-registry.mjs';
import { createComputerBrokerClient, createHttpComputerBrokerTransport } from './computer-broker.mjs';
import { createComputerToolset, registerComputerTools } from './cloud-computer-tools.mjs';
import { createScheduleManager } from './schedule-manager.mjs';
import { workspaceDir } from './workspace.mjs';
import { createDshTurnBridge, sessionControllerFromContext } from './dsh-session-bridge.mjs';
import { readFileSync } from 'node:fs';
import { registerPersonalAssistantHostGateway } from './host-gateway.mjs';
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

function runtimeEnvironment() {
  return typeof process === 'object' && process?.env ? process.env : {};
}

function configuredBots(value, env) {
  if (Array.isArray(value)) return value;
  const path = String(env.BOT_REGISTRY_PATH || '').trim();
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.bots) ? parsed.bots : []);
  } catch (error) {
    throw Object.assign(new Error('Personal Assistant Bot registry could not be loaded'), { code: 'PERSONAL_ASSISTANT_BOT_REGISTRY_INVALID', cause: error });
  }
}

/**
 * Construct the host runtime without reaching a real Computer by default.
 * A deployment must explicitly provide a documented broker transport.
 */
export function createRuntime(ctx, config = {}) {
  const env = runtimeEnvironment();
  const identity = {
    userId: config.userId ?? env.USER_ID,
    assistantId: config.assistantId ?? env.ASSISTANT_ID ?? env.AGENTENGINE_AGENT_ID,
    computerId: config.computerId ?? env.COMPUTER_ID,
  };
  const brokerEndpoint = config.computerBrokerUrl ?? env.COMPUTER_BROKER_URL ?? env.AGENTKIT_COMPUTER_URL;
  const computerTransport = config.computerTransport ?? (typeof brokerEndpoint === 'string' && brokerEndpoint.trim()
    ? createHttpComputerBrokerTransport({ baseUrl: brokerEndpoint }) : undefined);
  const registry = new BotRegistry({ profileId: config.profileId ?? identity.assistantId ?? 'default', bots: configuredBots(config.bots, env) });
  const computerBroker = config.computerBroker ?? createComputerBrokerClient({ transport: computerTransport });
  const scheduleManager = config.scheduleManager ?? createScheduleManager({ now: config.now });
  const workspace = workspaceDir(config.workspace);
  const turnBridge = config.turnBridge ?? createDshTurnBridge({
    ctx,
    sessionController: config.sessionController ?? sessionControllerFromContext(ctx),
    registry,
    setupAgent: async (agent, botId) => {
      if (!identity.assistantId || !identity.computerId || !computerTransport) return;
      const toolset = createComputerToolset({ broker: computerBroker, userId: identity.userId, assistantId: identity.assistantId, computerId: identity.computerId, botId, taskId: `dsh:${agent.id}` });
      const registration = registerComputerTools({ agent, toolset });
      agent.ctx.effect?.(() => () => { for (const dispose of registration.disposers) dispose(); void toolset.dispose(); }, 'personal-assistant.computer-tools');
    },
  });
  const createBotComputerToolset = ({ botId, ...options } = {}) => createComputerToolset({
    broker: computerBroker, userId: identity.userId, assistantId: identity.assistantId, computerId: identity.computerId,
    botId: botId ?? config.botId, ...options,
  });
  return Object.freeze({
    ctx,
    config: Object.freeze({ ...config }),
    enabled: config.enabled === undefined ? env.AGENTKIT_PERSONAL_ASSISTANT_ENABLED === '1' : config.enabled === true,
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
  const runtime = createRuntime(ctx, config);
  if (typeof ctx.effect === 'function' && typeof ctx.connection?.fetch?.register === 'function') {
    ctx.effect(() => registerPersonalAssistantHostGateway(ctx, config), 'personal-assistant:gateway');
  }
  const env = runtimeEnvironment();
  if (env.AGENTKIT_PERSONAL_ASSISTANT_SERVE === '1') {
    if (!runtime.turnBridge.available) throw Object.assign(new Error('Cloud Personal Assistant requires the DSH Session Controller'), { code: 'DSH_SESSION_CONTROLLER_UNAVAILABLE' });
    const serve = async () => {
      const { startAssistantRuntime } = await import('../runtime/assistant-runtime.mjs');
      const handle = await startAssistantRuntime({ runtime, env });
      console.info(JSON.stringify({ event: 'personal-assistant.host.ready', assistantId: env.ASSISTANT_ID, port: Number(env.AGENTKIT_RUNTIME_PORT), dshSessionController: true }));
      return () => handle.close();
    };
    if (typeof ctx.effect !== 'function') throw new Error('DSH effect lifecycle is required');
    ctx.effect(serve, 'personal-assistant.http');
  }
  return runtime;
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
