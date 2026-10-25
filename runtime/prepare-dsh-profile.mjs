import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPersonalAssistantManifest } from '../src/platform-manifest.mjs';

// 只借用固定 DSH 安装里的 YAML 解析器；配置中只写凭据变量名，不写密钥。
const env = process.env;
const manifest = loadPersonalAssistantManifest(env);
const baseURL = new URL(env.OPENAI_BASE_URL);
if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.search || baseURL.hash || !env.AGENTKIT_MODEL_API_KEY) throw new Error('MANAGED_MODEL_CONFIGURATION_INVALID');
const overlay = [
  { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { 'personal-assistant-cloud': { displayName: '个人助理云端模型', apiKeyEnv: 'AGENTKIT_MODEL_API_KEY', api: 'openai-completions', baseURL: baseURL.href.replace(/\/$/, ''), models: [{ id: manifest.model, name: manifest.model, contextWindow: 131072, maxTokens: 8192 }] } } } },
  { id: 'agent-default-model', config: { provider: 'personal-assistant-cloud', model: manifest.model } },
];
await mkdir(env.DSH_HOME, { recursive: true, mode: 0o700 });
await writeFile(join(env.DSH_HOME, 'platform-model.patch.yml'), JSON.stringify(overlay, null, 2), { mode: 0o600 });
console.info(JSON.stringify({ event: 'personal-assistant.model.configured', model: manifest.model, manifestSha256: env.AGENTENGINE_MANIFEST_SHA256 }));
