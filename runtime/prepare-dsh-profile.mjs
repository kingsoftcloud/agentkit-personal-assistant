import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPersonalAssistantManifest } from '../src/platform-manifest.mjs';
import { fetchGatewayChatModels, PERSONAL_ASSISTANT_CLOUD_PROVIDER as provider } from '../src/cloud-model.mjs';

const env = process.env;
const manifest = loadPersonalAssistantManifest(env);
const baseURL = new URL(env.OPENAI_BASE_URL);
if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.search || baseURL.hash || !env.AGENTKIT_MODEL_API_KEY) throw new Error('MANAGED_MODEL_CONFIGURATION_INVALID');
const models = await fetchGatewayChatModels({ baseURL, apiKey: env.AGENTKIT_MODEL_API_KEY });
if (!models.length) throw new Error('MANAGED_MODEL_CATALOG_EMPTY');
const selected = models.find(model => model.id === manifest.model);
const overlay = [
  { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { [provider]: { displayName: '个人助理云端模型', apiKeyEnv: 'AGENTKIT_MODEL_API_KEY', api: 'openai-completions', baseURL: baseURL.href.replace(/\/+$/u, ''), models } } } },
  // A retired selection stays visible so the user can replace it in settings.
  { id: 'agent-default-model', config: { provider, model: manifest.model } },
];
await mkdir(env.DSH_HOME, { recursive: true, mode: 0o700 });
await writeFile(join(env.DSH_HOME, 'platform-model.patch.yml'), JSON.stringify(overlay, null, 2), { mode: 0o600 });
if (!selected) console.warn(JSON.stringify({ event: 'personal-assistant.model.not-in-catalog', model: manifest.model }));
console.info(JSON.stringify({ event: 'personal-assistant.model.configured', model: manifest.model, contextWindow: selected?.contextWindow ?? null, catalogSize: models.length, manifestSha256: env.AGENTENGINE_MANIFEST_SHA256 }));
