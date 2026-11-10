/** Explicit projection of portable resources; resolved credentials never leave the Host. */
import { createHash } from 'node:crypto';
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePortableNativeBuiltins } from './portable-native-tools.mjs';
import { nativeVisionProfileId } from './native-vision-model.mjs';

export const portableError = (code, message) => Object.assign(new Error(message), { code });
export const sha256 = data => createHash('sha256').update(data).digest('hex');
const idOf = value => String(value?.resourceId || value?.id || value || '');
const refName = value => String(value || '').replace(/^env:\/\//, '');
const validEnv = value => /^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(value);

export function validatePortableCredentialNames(requirements) {
  // Settings generate suffixed model keys; these and bundle model/MCP keys
  // are resource credentials, while other AGENTKIT_* names remain Host controls.
  const reserved = requirements.find(item => /^(?:NODE_|DSH_|CODEX_|AGENTKIT_(?!(?:MODEL_API_KEY(?:_[A-Z0-9_]+)?$|BUNDLE_(?:MODEL|MCP)_))|XDG_|LD_|DYLD_|npm_|pnpm_)/i.test(item.name)
    || ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(item.name));
  if (reserved) {
    throw portableError('BUNDLE_HOST_CREDENTIAL_RESERVED', `资源凭证名称不能覆盖 Host 启动配置：${reserved.name}。请调整模型或 MCP 的凭证引用`);
  }
}

function endpoint(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw portableError('PORTABLE_ENDPOINT_UNSUPPORTED', '运行包暂不支持带账号、查询参数或片段的服务地址，请改用凭证引用');
  }
  return url.href.replace(/\/$/, '');
}

// Inline secrets in arbitrary Agent/plugin configuration cannot be migrated safely.
export function rejectInlineSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (item && /^(?:api[_-]?key|access[_-]?key|secret[_-]?key|password|token|authorization|headers|secrets|modelProfileKeys)$/i.test(key)
      && (typeof item !== 'object' || Object.keys(item).length)) {
      throw portableError('PORTABLE_INLINE_SECRET', 'Agent 定义含内联凭证，请先改为 Host 凭证引用再导出');
    }
    rejectInlineSecrets(item);
  }
}

async function collectDirectory(root, prefix, files, limits, depth = 0) {
  if (depth > 20 || !(await lstat(root)).isDirectory()) throw portableError('PORTABLE_SKILL_PATH_INVALID', 'Skill 文件目录无效或嵌套过深');
  for (const name of (await readdir(root)).sort()) {
    if (/^(?:\.env(?:\..*)?|credentials(?:\.json|\.ya?ml)?|auth\.json)$/i.test(name)) throw portableError('PORTABLE_SKILL_SECRET_FILE', 'Skill 目录含凭证文件，请移出目录并改用目标 Host 的环境变量');
    if (/[\\\0]/.test(name)) throw portableError('PORTABLE_SKILL_PATH_INVALID', 'Skill 文件名无效');
    const path = join(root, name), info = await lstat(path), archiveName = `${prefix}/${name}`;
    if (info.isSymbolicLink()) throw portableError('PORTABLE_SKILL_SYMLINK', 'Skill 含符号链接，请将依赖文件放入 Skill 目录后再导出');
    if (info.isDirectory()) { await collectDirectory(path, archiveName, files, limits, depth + 1); continue; }
    if (!info.isFile()) throw portableError('PORTABLE_SKILL_PATH_INVALID', 'Skill 含不支持的文件类型');
    limits.bytes += info.size; limits.count += 1;
    if (info.size > 8 * 1024 * 1024 || limits.bytes > 16 * 1024 * 1024 || limits.count > 1500) throw portableError('PORTABLE_SKILL_TOO_LARGE', 'Skill 文件超过运行包上限（单文件 8 MiB、总计 16 MiB、1500 个文件）');
    const data = await readFile(path);
    if (data.length !== info.size) throw portableError('PORTABLE_SKILL_CHANGED', '导出过程中 Skill 文件发生变化，请重试');
    files.push({ name: archiveName, data, executable: Boolean(info.mode & 0o111) });
  }
}

export async function capturePortableResources({ record, models, adapters, configuration, credentials }) {
  rejectInlineSecrets(record.spec);
  rejectInlineSecrets(record.metadata);
  const bindings = record.spec.bindings || record.bindings || {}, runtime = record.spec.runtime?.type;
  if (!['dsh-native', 'harness', 'codex'].includes(runtime)) throw portableError('PORTABLE_RUNTIME_UNSUPPORTED', '运行包仅支持 DSH Native、Codex 和自研 Harness');
  // Concrete Node builtin capabilities travel only with a Frozen Native engine
  // build. Optional services still require target Host configuration; a tool
  // binding is never permission to execute or a substitute for credentials.
  const nativeBuiltins = resolvePortableNativeBuiltins(record);
  if (nativeBuiltins.kind === 'invalid') throw portableError('PORTABLE_BINDING_INVALID', '该 Agent 绑定的内置工具形状无效，请修正 Tool 绑定后重新导出');
  if (nativeBuiltins.kind === 'unsupported') throw portableError('PORTABLE_BUILTIN_UNSUPPORTED',
    nativeBuiltins.unknown ? `该 Agent 绑定的内置工具尚不能导出为可迁移运行包：${nativeBuiltins.unknown.join(', ')}`
      : '导出内置工具需要固定 Native 执行引擎的 Build，请先重新构建');
  const plugins = bindings.plugins || [];
  if (plugins.some(item => item.enabled === false)) throw portableError('PORTABLE_DISABLED_PLUGIN_UNSUPPORTED', '请先移除已停用的资源插件绑定，当前运行包不迁移其遗留配置');
  const cloudResources = plugins.filter(item => item.enabled !== false).map(item => item.config?.binding?.resource);
  if (cloudResources.some(item => !['knowledge-base', 'memory-instance', 'skill-space'].includes(item?.kind))) {
    throw portableError('PORTABLE_PLUGIN_UNSUPPORTED', '运行包尚不支持迁移此 Agent 的扩展插件，请保留在原 Host 运行');
  }
  const requirements = [];
  function requireEnv(name, resourceId, purpose) {
    if (!validEnv(name)) throw portableError('PORTABLE_CREDENTIAL_REF_INVALID', '凭证引用不是可注入的环境变量名称');
    if (!requirements.some(item => item.name === name && item.resourceId === resourceId)) requirements.push({ name, resourceId, purpose });
    return name;
  }
  const boundModels = [...new Set([bindings.modelProfileId, ...(bindings.modelProfileIds || []).map(idOf)].filter(Boolean))];
  if (!boundModels.length) throw portableError('PORTABLE_MODEL_REQUIRED', '请先为 Agent 显式绑定模型，再导出运行包');
  const visionId = nativeVisionProfileId(record);
  if (visionId && !boundModels.includes(visionId)) boundModels.push(visionId);
  const profiles = [];
  for (const id of boundModels) {
    let profile;
    try { profile = await models.profile(id); }
    catch (error) {
      if (runtime === 'codex' && ['MODEL_NOT_FOUND', 'MODEL_CREDENTIAL_MISSING'].includes(error?.code)) {
        throw portableError('PORTABLE_CODEX_MODEL_UNAVAILABLE', '部分绑定模型缺少可迁移的网关配置或凭证。Codex 账户模型不能随包导出；请在 Agent 编辑页只保留已配置的网关模型，再重新构建。');
      }
      throw error;
    }
    const credentialName = requireEnv(refName(profile.credentialName) || `AGENTKIT_BUNDLE_MODEL_${sha256(id).slice(0, 12).toUpperCase()}`, id, 'model');
    rejectInlineSecrets(profile.parameters);
    profiles.push({ id, provider: profile.provider, modelName: profile.modelName, baseUrl: endpoint(profile.baseUrl),
      credentialName, enabled: true, default: profiles.length === 0, ...(profile.input ? { input: profile.input } : {}),
      ...(profile.codexApi ? { codexApi: profile.codexApi } : {}),
      ...Object.fromEntries(['protocol', 'contextWindow', 'maxOutputTokens', 'requestTimeoutMs', 'parameters']
        .filter(key => profile[key] !== undefined).map(key => [key, structuredClone(profile[key])])) });
  }
  const mcps = [];
  for (const binding of bindings.mcpServers || []) {
    const detail = await adapters.describeMcp(binding), envRefs = {}, headers = {};
    const inline = Object.entries(detail.headers || {});
    for (const [header, value] of inline) {
      if (/^(accept|content-type|mcp-protocol-version)$/i.test(header)) { headers[header] = String(value); continue; }
      const name = `AGENTKIT_BUNDLE_MCP_${sha256(`${detail.resourceId}:${header.toLowerCase()}`).slice(0, 16).toUpperCase()}`;
      envRefs[header] = requireEnv(name, detail.resourceId, `MCP header ${header}`);
    }
    for (const [header, ref] of Object.entries(detail.envRefs || {})) {
      if (inline.some(([key, value]) => key.toLowerCase() === header.toLowerCase() && String(value).trim())) continue;
      envRefs[header] = requireEnv(refName(ref), detail.resourceId, `MCP header ${header}`);
    }
    if ((detail.apiKey || detail.credentialRef) && ![...Object.keys(headers), ...Object.keys(envRefs)].some(key => key.toLowerCase() === 'authorization')) {
      envRefs.Authorization = requireEnv(!detail.apiKey && refName(detail.credentialRef) || `AGENTKIT_BUNDLE_MCP_${sha256(detail.resourceId).slice(0, 16).toUpperCase()}`, detail.resourceId, 'MCP Authorization');
    }
    mcps.push({ resourceId: detail.resourceId, endpointUrl: endpoint(detail.endpoint), headers, envRefs });
  }
  const skills = [], files = [], limits = { bytes: 0, count: 0 };
  const skillIds = [...new Set([...(bindings.skills || []).map(idOf), ...cloudResources.filter(item => item.kind === 'skill-space').map(idOf)])];
  for (const resourceId of skillIds) {
    const loaded = await adapters.loadSkill(resourceId), roots = [];
    if (!loaded.definitions?.length) throw portableError('PORTABLE_SKILL_EMPTY', '绑定的 Skill 没有可打包的文件');
    for (const [index, definition] of loaded.definitions.entries()) {
      const root = `skills/${sha256(resourceId).slice(0, 24)}/${index}`;
      if (definition.resourceBase?.kind !== 'directory') throw portableError('PORTABLE_SKILL_PATH_INVALID', 'Skill 没有可打包的目录');
      await collectDirectory(definition.resourceBase.path, root, files, limits);
      if (!files.some(file => file.name === `${root}/SKILL.md`)) throw portableError('PORTABLE_SKILL_PATH_INVALID', 'Skill 根目录缺少 SKILL.md');
      roots.push(root);
    }
    skills.push({ resourceId, roots });
  }
  const remote = cloudResources.filter(item => ['knowledge-base', 'memory-instance'].includes(item.kind));
  const cloud = {};
  if (remote.length) {
    const { values } = await configuration.resolve();
    cloud.cloudServerUrl = endpoint(values.cloudServerUrl || 'https://aicp.ksyun.com');
    cloud.cloudRegion = values.cloudRegion || 'cn-beijing-6';
    if (values.cloudCustomSource) cloud.cloudCustomSource = values.cloudCustomSource;
    requireEnv('KSYUN_ACCESS_KEY', 'cloud', 'cloud access key');
    requireEnv('KSYUN_SECRET_KEY', 'cloud', 'cloud secret key');
    if (values.cloudSessionToken) requireEnv('KSYUN_SESSION_TOKEN', 'cloud', 'cloud session token');
  }
  // Managed personal assistants mount DSH's DeepSeek search provider, which
  // reads DEEPSEEK_API_KEY for every search. Freeze the credential only when
  // the Host can resolve one: provisioning must still work for users without a
  // DeepSeek account (they keep public web_fetch, and the runtime advertises
  // only the web tools it can actually execute).
  if (record.spec?.security?.assistantPermissions?.profile === 'workspace-managed/v1' && typeof credentials?.resolve === 'function') {
    const search = await credentials.resolve('DEEPSEEK_API_KEY').catch(() => null);
    if (typeof search?.value === 'string' && search.value.trim()) requireEnv('DEEPSEEK_API_KEY', 'web-search', 'personal assistant web search');
  }
  return { resources: { profiles, mcps, skills, cloud, remote }, requirements, files,
    nativeBuiltin: nativeBuiltins.kind === 'native' ? nativeBuiltins.manifest : undefined };
}
