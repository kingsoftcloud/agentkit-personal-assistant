import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPersonalAssistantManifest } from '../src/platform-manifest.mjs';
import { fetchGatewayChatModels, PERSONAL_ASSISTANT_CLOUD_PROVIDER as provider } from '../src/cloud-model.mjs';

const env = process.env;
const manifest = loadPersonalAssistantManifest(env);
const baseURL = new URL(env.OPENAI_BASE_URL);
if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.search || baseURL.hash || !env.AGENTKIT_MODEL_API_KEY) throw new Error('MANAGED_MODEL_CONFIGURATION_INVALID');
const models = await fetchGatewayChatModels({ baseURL, apiKey: env.AGENTKIT_MODEL_API_KEY });
const selected = models.find(model => model.id === manifest.model);
if (!selected) throw new Error('MANAGED_MODEL_NOT_IN_GATEWAY_CATALOG: ' + manifest.model);
const overlay = [
  { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { [provider]: { displayName: '个人助理云端模型', apiKeyEnv: 'AGENTKIT_MODEL_API_KEY', api: 'openai-completions', baseURL: baseURL.href.replace(/\/+$/u, ''), models } } } },
  { id: 'agent-default-model', config: { provider, model: selected.id } },
];
await mkdir(env.DSH_HOME, { recursive: true, mode: 0o700 });
await writeFile(join(env.DSH_HOME, 'platform-model.patch.yml'), JSON.stringify(overlay, null, 2), { mode: 0o600 });
console.info(JSON.stringify({ event: 'personal-assistant.model.configured', model: selected.id, contextWindow: selected.contextWindow, catalogSize: models.length, manifestSha256: env.AGENTENGINE_MANIFEST_SHA256 }));
