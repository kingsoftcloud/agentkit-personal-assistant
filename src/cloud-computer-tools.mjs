/**
 * DSH tool adapters for the dedicated Cloud Computer.
 *
 * The Personal Assistant runtime never opens Chromium or executes a host
 * command itself. Every browser/terminal operation crosses the versioned
 * Computer Broker protocol and is bound to one Bot task lease. The computer
 * image owns `computer-agentd`, Chromium/CDP and the terminal sandbox.
 */
import {
  COMPUTER_ACTION_NAMES,
  createActionRequest,
  createLeaseRequest,
  createReleaseRequest,
} from './computer-broker-protocol.mjs';

export const PERSONAL_ASSISTANT_BROWSER_CAPABILITY = 'personal-assistant-browser/v1';
export const PERSONAL_ASSISTANT_CODE_EXECUTION_CAPABILITY = 'personal-assistant-code-execution/v1';
export const CLOUD_COMPUTER_CAPABILITY = 'cloud-computer/v1';
export const COMPUTER_AGENTD_CONTRACT = 'computer-agentd';
export const COMPUTER_BROKER_URL_ENV = 'COMPUTER_BROKER_URL';
// computer-agentd owns the real Chromium/CDP process and the terminal
// executor. These explicit contracts keep capability discovery tied to the
// implementation instead of to a capability-name string alone.
export const CLOUD_BROWSER_BACKEND = Object.freeze({ engine: 'chromium', protocol: 'cdp', owner: COMPUTER_AGENTD_CONTRACT });
export const CLOUD_EXECUTION_BACKEND = Object.freeze({ command: 'runCommand', code: 'executeCode', owner: COMPUTER_AGENTD_CONTRACT });

export const CLOUD_BROWSER_TOOL_NAMES = Object.freeze([
  'cloud_browser_open',
  'cloud_browser_snapshot',
  'cloud_browser_click',
  'cloud_browser_type',
  'cloud_browser_press',
  'cloud_browser_screenshot',
  'cloud_browser_download',
  'cloud_browser_close',
]);
export const CLOUD_EXECUTION_TOOL_NAMES = Object.freeze(['cloud_bash', 'cloud_run_code']);

const CODE_LANGUAGES = Object.freeze(['javascript', 'python']);
const KEY_ALLOWLIST = Object.freeze([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space',
]);
const ACTIONS = new Set(COMPUTER_ACTION_NAMES);
const text = (value, field) => {
  const result = String(value ?? '').trim();
  if (!result) throw new TypeError(`${field} must be a non-empty string`);
  return result;
};
const bounded = (value, field, maxBytes) => {
  const result = text(value, field);
  if (Buffer.byteLength(result, 'utf8') > maxBytes) throw new TypeError(`${field} exceeds ${maxBytes} bytes`);
  return result;
};
const taskIdOf = (value) => bounded(value ?? 'interactive', 'taskId', 128);
const output = value => [{ type: 'text', text: String(value?.result || '') }];
const resultSchema = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] };
const envelope = value => ({ result: typeof value === 'string' ? value : JSON.stringify(value) ?? '' });
const schema = (properties = {}, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});

function actionDefinition(name, description, properties, required, operation, operationExecutor, mapArgs = args => ({ ...args })) {
  return {
    name,
    description,
    parameters: schema(properties, required),
    output: { schema: resultSchema, render: (_args, value) => output(value) },
    execute: async (args, execution) => envelope(await operationExecutor(operation, mapArgs(args || {}), execution)),
  };
}

/**
 * Create broker-backed tools for one Bot. A lease is acquired lazily on the
 * first action, so simply loading the plugin cannot claim a user's computer.
 */
export function createComputerToolset({
  broker,
  userId,
  assistantId,
  botId,
  computerId,
  taskId = 'interactive',
  leaseTtlMs = 60_000,
  now = () => Date.now(),
} = {}) {
  if (!broker || typeof broker.action !== 'function' || typeof broker.acquireLease !== 'function') {
    throw new TypeError('A connected Computer Broker client is required');
  }
  const identity = {
    ...(userId === undefined ? {} : { userId: text(userId, 'userId') }),
    assistantId: text(assistantId, 'assistantId'),
    botId: text(botId, 'botId'),
    computerId: text(computerId, 'computerId'),
  };
  const initialTaskId = taskIdOf(taskId);
  let activeLease = null;
  let disposed = false;

  async function ensureLease(requestedTaskId = initialTaskId) {
    if (disposed) throw new Error('COMPUTER_TOOLSET_DISPOSED');
    const activeTaskId = taskIdOf(requestedTaskId);
    if (activeLease && activeLease.taskId === activeTaskId && activeLease.expiresAt > now()) return activeLease;
    if (activeLease) await release().catch(() => {});
    const idempotencyKey = `${identity.assistantId}:${identity.botId}:${identity.computerId}:${activeTaskId}`;
    const response = await broker.acquireLease(createLeaseRequest({ ...identity, taskId: activeTaskId, idempotencyKey, ttlMs: leaseTtlMs }));
    const lease = response?.lease;
    if (!lease?.leaseId) throw new Error('COMPUTER_LEASE_INVALID');
    activeLease = lease;
    return lease;
  }

  async function release() {
    if (!activeLease) return false;
    const lease = activeLease;
    activeLease = null;
    const response = await broker.releaseLease(createReleaseRequest({ ...identity, taskId: lease.taskId, leaseId: lease.leaseId, botId: identity.botId }));
    return response?.released === true;
  }

  async function action(name, args = {}, execution = {}) {
    if (!ACTIONS.has(name)) throw new TypeError(`Unsupported computer action: ${name}`);
    const lease = await ensureLease(execution?.taskId);
    const request = createActionRequest({
      ...identity,
      taskId: lease.taskId,
      leaseId: lease.leaseId,
      action: name,
      args,
    });
    try { return await broker.action(request); }
    catch (error) {
      // 旧租约已被用户接管或撤销。只清缓存，不重放可能已经执行的动作。
      if (Number(error?.status) === 409) activeLease = null;
      throw error;
    }
  }

  const definitions = [
    actionDefinition('cloud_browser_open', 'Open a public URL in the dedicated Cloud Computer browser.', { url: { type: 'string' } }, ['url'], 'open', action, args => ({ url: bounded(args.url, 'url', 4096) })),
    actionDefinition('cloud_browser_snapshot', 'Read bounded text and links from the current Cloud Computer page.', {}, [], 'snapshot', action),
    actionDefinition('cloud_browser_click', 'Click a CSS selector in the Cloud Computer browser.', { selector: { type: 'string' } }, ['selector'], 'click', action, args => ({ selector: bounded(args.selector, 'selector', 1024) })),
    actionDefinition('cloud_browser_type', 'Type bounded text into the focused Cloud Computer browser element.', { text: { type: 'string' }, selector: { type: 'string' } }, ['text'], 'type', action, args => ({ text: bounded(args.text, 'text', 16 * 1024), ...(args.selector === undefined ? {} : { selector: bounded(args.selector, 'selector', 1024) }) })),
    actionDefinition('cloud_browser_press', 'Press one allowlisted key in the Cloud Computer browser.', { key: { type: 'string' } }, ['key'], 'press', action, args => {
      const key = bounded(args.key, 'key', 64);
      if (!KEY_ALLOWLIST.includes(key)) throw new TypeError(`Key is not allowlisted: ${key}`);
      return { key };
    }),
    actionDefinition('cloud_browser_screenshot', 'Capture the current Cloud Computer browser viewport.', {}, [], 'screenshot', action),
    actionDefinition('cloud_browser_download', 'Download a bounded file through the Cloud Computer browser.', { url: { type: 'string' }, selector: { type: 'string' }, timeoutMs: { type: 'number' } }, [], 'download', action, args => ({
      ...(args.url === undefined ? {} : { url: bounded(args.url, 'url', 4096) }),
      ...(args.selector === undefined ? {} : { selector: bounded(args.selector, 'selector', 1024) }),
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
    })),
    actionDefinition('cloud_browser_close', 'Close the Cloud Computer browser session.', {}, [], 'stop', action),
    actionDefinition('cloud_bash', 'Run one command inside the Cloud Computer terminal sandbox.', { command: { type: 'string' }, timeoutMs: { type: 'number' } }, ['command'], 'terminal.exec', action, args => ({
      language: 'shell', command: bounded(args.command, 'command', 16 * 1024), ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
    })),
    actionDefinition('cloud_run_code', 'Run bounded JavaScript or Python inside the Cloud Computer terminal sandbox.', { language: { type: 'string', enum: [...CODE_LANGUAGES] }, code: { type: 'string' }, timeoutMs: { type: 'number' } }, ['language', 'code'], 'terminal.exec', action, args => {
      const language = bounded(args.language, 'language', 32);
      if (!CODE_LANGUAGES.includes(language)) throw new TypeError(`Unsupported code language: ${language}`);
      return { language, code: bounded(args.code, 'code', 64 * 1024), ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }) };
    }),
  ];

  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    capabilities: Object.freeze([PERSONAL_ASSISTANT_BROWSER_CAPABILITY, PERSONAL_ASSISTANT_CODE_EXECUTION_CAPABILITY, CLOUD_COMPUTER_CAPABILITY]),
    tools: Object.freeze(definitions),
    get lease() { return activeLease; },
    execute(name, args, execution) {
      const definition = definitions.find(item => item.name === name);
      if (!definition) throw new TypeError(`Unknown personal assistant computer tool: ${name}`);
      return definition.execute(args, execution);
    },
    async executeRaw(name, args, execution) {
      const result = await this.execute(name, args, execution);
      try { return JSON.parse(result.result); } catch { return result.result; }
    },
    async release() { return release(); },
    async dispose() { disposed = true; await release().catch(() => {}); },
  });
}

/** Execute a bounded command through computer-agentd's terminal executor. */
export function runCommand(toolset, command, options = {}, execution) {
  if (!toolset || typeof toolset.execute !== 'function') throw new TypeError('toolset is required');
  return toolset.execute('cloud_bash', { command, ...options }, execution);
}

/** Execute bounded JavaScript/Python code through computer-agentd. */
export function executeCode(toolset, language, code, options = {}, execution) {
  if (!toolset || typeof toolset.execute !== 'function') throw new TypeError('toolset is required');
  return toolset.execute('cloud_run_code', { language, code, ...options }, execution);
}

/** Register broker-backed tools through the public DSH tools service. */
export function registerComputerTools({ agent, register, toolset } = {}) {
  if (!toolset || typeof toolset.tools?.[Symbol.iterator] !== 'function') throw new TypeError('toolset is required');
  const injected = agent?.ctx?.get?.('tools');
  const add = typeof register === 'function' ? register : injected?.register?.bind(injected);
  if (typeof add !== 'function') throw new TypeError('A public DSH tools.register function is required');
  const disposers = toolset.tools.map(definition => add(definition)).filter(item => typeof item === 'function');
  return Object.freeze({ names: Object.freeze(toolset.tools.map(item => item.name)), definitions: toolset.tools, disposers });
}
