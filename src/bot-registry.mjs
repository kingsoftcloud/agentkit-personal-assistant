/**
 * Multi-Bot registry for one personal-assistant profile.
 *
 * The registry owns Bot definitions. The DSH bridge installs each Bot prompt;
 * its scoped tool guard enforces this registry's current policy on every call.
 * Native session execution and approval decisions remain owned by DSH.
 */

import { readFileSync } from 'node:fs';

const BOT_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const PROFILE_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/u;
const POLICY_MODES = new Set(['allowlist', 'denylist']);
const BOT_ROLES = new Set(['primary', 'custom']);
const BOT_STATUSES = new Set(['running', 'idle', 'offline']);
const CAPABILITY_SOURCES = new Set(['builtin', 'mcp']);
const CAPABILITY_STATUSES = new Set(['ready', 'error']);
const MAX_MODEL_LENGTH = 120;
const MAX_MEMORY_ITEMS = 200;

function requiredString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${field} must be a non-empty string`);
  return text;
}

/** 模型名只做长度/控制字符校验：不同云端的模型 id 形态差别很大，不在这里推断。 */
function optionalModel(value) {
  if (value === undefined) return undefined;
  const text = requiredString(value, 'model');
  if (text.length > MAX_MODEL_LENGTH || /[\u0000-\u001f\u007f]/u.test(text)) throw new TypeError('model has an invalid format');
  return text;
}

function optionalEnum(value, field, allowed) {
  if (value === undefined) return undefined;
  const text = requiredString(value, field);
  if (!allowed.has(text)) throw new TypeError(`${field} is not supported`);
  return text;
}

function optionalStamp(value, field) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!text || text.length > 40 || /[\u0000-\u001f]/u.test(text)) throw new TypeError(`${field} has an invalid format`);
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
  const agentPreset = input.agentPreset === undefined ? undefined : requiredString(input.agentPreset, 'agentPreset');
  const memoryNamespace = input.memoryNamespace === undefined
    ? `assistant:${normalizedProfile}:bot:${botId}`
    : requiredString(input.memoryNamespace, 'memoryNamespace');
  const metadata = input.metadata === undefined ? {} : input.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('metadata must be an object');
  // model/role/status/createdAt 是面板展示用的可选字段：缺省时由 Host 推导，
  // 老配置文件（只有 botId/systemPromptRevision）保持完全兼容。
  const model = optionalModel(input.model);
  const role = optionalEnum(input.role, 'role', BOT_ROLES);
  const status = optionalEnum(input.status, 'status', BOT_STATUSES);
  const createdAt = optionalStamp(input.createdAt, 'createdAt');
  return freezeDefinition({
    botId,
    displayName,
    systemPromptRevision,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(model === undefined ? {} : { model }),
    ...(role === undefined ? {} : { role }),
    ...(status === undefined ? {} : { status }),
    ...(createdAt === undefined ? {} : { createdAt }),
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
      ...(bot.agentPreset === undefined ? {} : { agentPreset: bot.agentPreset }),
      memoryNamespace: bot.memoryNamespace,
      toolPolicy: bot.toolPolicy,
    };
  }

  /**
   * 面板 Bot 详情的公开身份字段。role 缺省时按「第一个 Bot 是主助理」推导，
   * 不把内部逻辑 Bot 变成用户必须理解的概念。
   */
  describe(botId) {
    const bot = this.require(botId);
    return Object.freeze({
      id: bot.botId,
      name: bot.displayName,
      role: this.roleOf(bot.botId),
      status: bot.status ?? 'idle',
      model: bot.model ?? '',
    });
  }

  roleOf(botId) {
    const bot = this.require(botId);
    if (bot.role) return bot.role;
    const primary = this.list().find(item => item.role === 'primary');
    if (primary) return primary === bot ? 'primary' : 'custom';
    return this.list()[0] === bot ? 'primary' : 'custom';
  }

  createdAt(botId) {
    return this.require(botId).createdAt ?? '';
  }

  /**
   * 能力清单只接受登记在 metadata.capabilities 里的白名单行；缺省为空，
   * 不用默认文案替用户宣称某项能力已启用。
   */
  capabilities(botId) {
    const bot = this.require(botId);
    const rows = Array.isArray(bot.metadata?.capabilities) ? bot.metadata.capabilities : [];
    const result = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const id = String(row.id ?? '').trim();
      const label = String(row.label ?? '').trim();
      if (!BOT_ID_PATTERN.test(id) || !label) continue;
      result.push({
        id,
        label: label.slice(0, 80),
        source: CAPABILITY_SOURCES.has(row.source) ? row.source : 'builtin',
        status: CAPABILITY_STATUSES.has(row.status) ? row.status : 'ready',
      });
      if (result.length >= 32) break;
    }
    return Object.freeze(result);
  }

  /** 模型切换只改下一条消息的默认模型；不改正在运行的回合。 */
  setModel(botId, model) {
    const bot = this.require(botId);
    const next = optionalModel(model);
    if (next === undefined) throw new TypeError('model is required');
    const updated = Object.freeze({ ...bot, model: next });
    this._bots.set(bot.botId, updated);
    return updated;
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

/**
 * 记忆行的白名单投影：历史记忆以 key 作为稳定标识，正文是 content；
 * scope 缺省为 bot。只输出 id/text/scope，不带存储路径与 metadata 其它字段。
 */
export function publicMemoryItem(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const id = String(row.metadata?.id ?? row.key ?? '').trim();
  const content = String(row.content ?? '').trim();
  if (!id || id.length > 128 || !content) return undefined;
  const scope = typeof row.metadata?.scope === 'string' && row.metadata.scope.trim()
    ? row.metadata.scope.trim().slice(0, 40) : 'bot';
  return { id, text: content.slice(0, 2000), scope };
}

export function publicMemoryItems(rows) {
  const result = [];
  for (const row of Array.isArray(rows) ? rows.slice(0, MAX_MEMORY_ITEMS) : []) {
    const item = publicMemoryItem(row);
    if (item) result.push(item);
  }
  return result;
}

/**
 * 从显式配置或 BOT_REGISTRY_PATH 加载 registry；与 src/index.mjs 的 configuredBots
 * 语义保持一致，供 Host 面板在没有运行时实例时取得 Bot 元数据。
 */
export function loadBotRegistry({ bots, env = process.env, profileId = 'default' } = {}) {
  if (Array.isArray(bots)) return new BotRegistry({ profileId, bots });
  const path = String(env?.BOT_REGISTRY_PATH ?? '').trim();
  if (!path) return new BotRegistry({ profileId, bots: [] });
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.bots) ? parsed.bots : []);
    return new BotRegistry({ profileId, bots: rows });
  } catch (error) {
    throw Object.assign(new Error('Personal Assistant Bot registry could not be loaded'), { code: 'PERSONAL_ASSISTANT_BOT_REGISTRY_INVALID', cause: error });
  }
}
