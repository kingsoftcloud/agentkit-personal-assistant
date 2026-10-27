import { pathToFileURL } from 'node:url';
import { loadPersonalAssistantManifest } from '../src/platform-manifest.mjs';

export const PERSONAL_ASSISTANT_MANIFEST_PATH = '/app/code/agentengine.yaml';

/** 独立init校验只读声明及公开身份，不需要模型key、runtime token或可写目录。 */
export function checkPersonalAssistantManifest(env = process.env, { loadManifest = loadPersonalAssistantManifest } = {}) {
  if (env.AGENTENGINE_MANIFEST_PATH !== PERSONAL_ASSISTANT_MANIFEST_PATH) throw Object.assign(new Error('MANAGED_MANIFEST_PATH_INVALID'), { code: 'MANAGED_MANIFEST_PATH_INVALID' });
  const manifest = loadManifest(env);
  return { verified: true, runtime: manifest.runtime.name, version: manifest.runtime.version, manifestSha256: env.AGENTENGINE_MANIFEST_SHA256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--manifest' || process.argv[3] !== PERSONAL_ASSISTANT_MANIFEST_PATH) throw Object.assign(new Error('MANAGED_MANIFEST_ARGUMENTS_INVALID'), { code: 'MANAGED_MANIFEST_ARGUMENTS_INVALID' });
    console.info(JSON.stringify(checkPersonalAssistantManifest()));
  } catch (error) {
    console.error(JSON.stringify({ error: error.code || 'MANAGED_MANIFEST_CHECK_FAILED' }));
    process.exitCode = 1;
  }
}
