export const PERSONAL_ASSISTANT_CLOUD_PROVIDER = 'personal-assistant-cloud';
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,100}$/u;

// Keep the per-turn generation budget independent of the gateway's context window.
const TURN_OUTPUT_BUDGET = 8192;

function tokenLimit(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : 0;
  if (typeof value !== 'string') return 0;
  const match = /^(\d+)\s*([km]?)$/iu.exec(value.trim());
  if (!match) return 0;
  const unit = match[2].toLowerCase();
  const tokens = Number(match[1]) * (unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 0;
}

function hasModality(values, ...names) {
  return Array.isArray(values) && values.some(value => typeof value === 'string' && names.includes(value.toLowerCase()));
}

/** Translate the gateway's text generation models into DSH provider definitions. */
export function gatewayChatModels(catalog) {
  if (!Array.isArray(catalog?.data)) throw new Error('MANAGED_MODEL_CATALOG_INVALID');
  const models = new Map();
  for (const entry of catalog.data) {
    const { id, architecture, context_length, max_completion_tokens } = entry ?? {};
    if (typeof id !== 'string' || !MODEL_NAME.test(id)) continue;
    if (!hasModality(architecture?.input_modalities, 'text', '文字') || !hasModality(architecture?.output_modalities, 'text', '文字')) continue;
    const contextWindow = tokenLimit(context_length);
    const maxTokens = Math.min(tokenLimit(max_completion_tokens), TURN_OUTPUT_BUDGET);
    if (!maxTokens || contextWindow <= maxTokens) continue;
    if (models.has(id)) throw new Error('MANAGED_MODEL_CATALOG_DUPLICATE_ID');
    const input = hasModality(architecture.input_modalities, 'image', '图片') ? ['text', 'image'] : ['text'];
    models.set(id, { id, name: id, contextWindow, maxTokens, input });
  }
  return [...models.values()];
}

/** Load model metadata with the exact endpoint and credential used for inference. */
export async function fetchGatewayChatModels({ baseURL, apiKey, fetchImpl = fetch }) {
  const endpoint = new URL(baseURL);
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') + '/models';
  const response = await fetchImpl(endpoint, {
    headers: { Authorization: 'Bearer ' + apiKey },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('MANAGED_MODEL_CATALOG_HTTP_' + response.status);
  // Response parsing errors can include upstream body text. Keep that out of startup logs.
  const catalog = await response.json().catch(() => { throw new Error('MANAGED_MODEL_CATALOG_INVALID'); });
  return gatewayChatModels(catalog);
}

/** Expose only models and context windows resolved by the running DSH provider. */
export async function listCloudModels(llm) {
  const provider = PERSONAL_ASSISTANT_CLOUD_PROVIDER;
  const models = await llm.listModels(provider);
  return Promise.all(models.map(async ({ id }) => {
    const { context } = await llm.resolveModelInfo(provider, id);
    return { id, contextWindow: context.contextWindow };
  }));
}
