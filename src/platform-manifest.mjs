import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** 只读取平台挂载的原始声明；不从 Studio 或本地 profile 获取云端提示词。 */
export function loadPersonalAssistantManifest(env, { parseDocument } = {}) {
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  if (env.AGENTENGINE_MANIFEST_PROTOCOL !== 'runtime-manifest/v1' || env.AGENTENGINE_MANAGED_RUNTIME_NAME !== 'personal-assistant'
    || !env.AGENTENGINE_MANAGED_RUNTIME_VERSION || !/^[a-f0-9]{64}$/u.test(env.AGENTENGINE_MANIFEST_SHA256 || '')) fail('MANAGED_RUNTIME_IDENTITY_INVALID');
  const raw = readFileSync(env.AGENTENGINE_MANIFEST_PATH);
  if (raw.length > 900 * 1024 || createHash('sha256').update(raw).digest('hex') !== env.AGENTENGINE_MANIFEST_SHA256) fail('MANAGED_MANIFEST_DIGEST_MISMATCH');
  let manifest;
  try {
    const parse = parseDocument ?? createRequire('/opt/agentkit/dsh-runtime/package.json')('yaml').parseDocument;
    const document = parse(new TextDecoder('utf-8', { fatal: true }).decode(raw), { uniqueKeys: true, version: '1.2' });
    if (document.errors.length || document.warnings.length) throw Error('invalid YAML');
    manifest = document.toJS({ maxAliasCount: 0 });
  } catch { fail('MANAGED_MANIFEST_INVALID'); }
  if (!manifest || manifest.framework !== 'personal-assistant' || manifest.artifact_type !== 'ManagedRuntime'
    || manifest.runtime?.name !== 'personal-assistant' || manifest.runtime?.version !== env.AGENTENGINE_MANAGED_RUNTIME_VERSION) fail('MANAGED_RUNTIME_IDENTITY_MISMATCH');
  if (typeof manifest.model !== 'string' || !manifest.model.trim() || manifest.model.length > 512) fail('MANAGED_MODEL_REQUIRED');
  if (typeof manifest.prompt !== 'string' || Buffer.byteLength(manifest.prompt) > 900 * 1024 || manifest.prompt.includes('\0')) fail('MANAGED_PROMPT_INVALID');
  return manifest;
}
