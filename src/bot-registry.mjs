/**
 * Multi-Bot registry for one personal-assistant profile.
 *
 * The registry stores Bot identity and policy metadata only. Prompt execution,
 * session creation, and persistence are owned by the DSH host and are wired in
 * through documented services by a later integration.
 */

const BOT_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const PROFILE_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/u;
const POLICY_MODES = new Set(['allowlist', 'denylist']);

function requiredString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${field} must be a non-empty string`);
  return text;
}

function identifier(value, field, pattern) {
  const text = requiredString(value, field);
  if (!pattern.test(text)) throw new TypeError(`${field} has an invalid format`);
  return text;
}

function uniqueStrings(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of strings`);
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const text = requiredString(item, `${field} item`);
    if (!seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function normalizeToolPolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('toolPolicy must be an object');
  }
  const mode = policy.mode === undefined ? 'allowlist' : requiredString(policy.mode, 'toolPolicy.mode');
  if (!POLICY_MODES.has(mode)) throw new TypeError('toolPolicy.mode must be allowlist or denylist');
  return Object.freeze({
    mode,
    allow: Object.freeze(uniqueStrings(policy.allow, 'toolPolicy.allow')),
    deny: Object.freeze(uniqueStrings(policy.deny, 'toolPolicy.deny')),
    requireApproval: Object.freeze(uniqueStrings(policy.requireApproval, 'toolPolicy.requireApproval')),
  });
}

function freezeDefinition(definition) {
  return Object.freeze({
    ...definition,
    toolPolicy: normalizeToolPolicy(definition.toolPolicy),
  });
}

/**
 * @param {object} input
 * @param {string} [profileId]
 * @returns {Readonly<{botId:string,displayName:string,systemPromptRevision:string,systemPrompt?:string,memoryNamespace:string,toolPolicy:object,metadata:object}>}
 */
export function normalizeBotDefinition(input = {}, profileId = 'default') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Bot definition must be an object');
  const normalizedProfile = identifier(profileId, 'profileId', PROFILE_PATTERN);
  const botId = identifier(input.botId ?? input.id, 'botId', BOT_ID_PATTERN);
  const displayName = requiredString(input.displayName ?? input.name ?? botId, 'displayName');
  const systemPromptRevision = requiredString(input.systemPromptRevision, 'systemPromptRevision');
  const systemPrompt = input.systemPrompt === undefined ? undefined : requiredString(input.systemPrompt, 'systemPrompt');
  const memoryNamespace = input.memoryNamespace === undefined
    ? `assistant:${normalizedProfile}:bot:${botId}`
    : requiredString(input.memoryNamespace, 'memoryNamespace');
  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('metadata must be an object');
  return freezeDefinition({
    botId,
    displayName,
    systemPromptRevision,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    memoryNamespace,
    toolPolicy: input.toolPolicy ?? {},
    metadata: Object.freeze({ ...metadata }),
  });
}

export class BotRegistry {
  constructor({ profileId = 'default', bots = [] } = {}) {
    this.profileId = identifier(profileId, 'profileId', PROFILE_PATTERN);
    this._bots = new Map();
    for (const definition of bots) this.register(definition);
  }

  register(definition) {
    const bot = normalizeBotDefinition(definition, this.profileId);
    if (this._bots.has(bot.botId)) throw new Error(`BOT_ALREADY_EXISTS: ${bot.botId}`);
    this._bots.set(bot.botId, bot);
    return bot;
  }

  upsert(definition) {
    const bot = normalizeBotDefinition(definition, this.profileId);
    this._bots.set(bot.botId, bot);
    return bot;
  }

  get(botId) {
    const id = identifier(botId, 'botId', BOT_ID_PATTERN);
    return this._bots.get(id);
  }

  require(botId) {
    const bot = this.get(botId);
    if (!bot) throw new Error(`BOT_NOT_FOUND: ${botId}`);
    return bot;
  }

  has(botId) {
    return this._bots.has(String(botId ?? '').trim());
  }

  remove(botId) {
    const id = identifier(botId, 'botId', BOT_ID_PATTERN);
    return this._bots.delete(id);
  }

  list() {
    return [...this._bots.values()];
  }

  resolve(botId) {
    const bot = this.require(botId);
    return {
      botId: bot.botId,
      systemPromptRevision: bot.systemPromptRevision,
      ...(bot.systemPrompt === undefined ? {} : { systemPrompt: bot.systemPrompt }),
      memoryNamespace: bot.memoryNamespace,
      toolPolicy: bot.toolPolicy,
    };
  }

  snapshot() {
    return Object.freeze({
      profileId: this.profileId,
      bots: Object.freeze(this.list().map(bot => ({ ...bot, toolPolicy: { ...bot.toolPolicy } }))),
    });
  }
}

export function createBotRegistry(options) {
  return new BotRegistry(options);
}
