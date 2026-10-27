import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPersonalAssistantManifest } from '../src/platform-manifest.mjs';

// JSON 是 YAML 子集；此处单测摘要/身份/提示词约束，真实 YAML 解析由已安装 DSH 验收覆盖。
const parseDocument = source => ({ errors: [], warnings: [], toJS: () => JSON.parse(source) });
test('平台提示词只来自摘要与三元组均匹配的挂载声明', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pa-platform-manifest-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'manifest.yaml');
  const declaration = { framework: 'personal-assistant', artifact_type: 'ManagedRuntime', runtime: { name: 'personal-assistant', version: '0.1.2' }, model: 'model', prompt: '平台字面量 {{unknown}}' };
  const raw = JSON.stringify(declaration); await writeFile(path, raw);
  const env = { AGENTENGINE_MANIFEST_PATH: path, AGENTENGINE_MANIFEST_PROTOCOL: 'runtime-manifest/v1', AGENTENGINE_MANAGED_RUNTIME_NAME: 'personal-assistant', AGENTENGINE_MANAGED_RUNTIME_VERSION: '0.1.2', AGENTENGINE_MANIFEST_SHA256: createHash('sha256').update(raw).digest('hex') };
  assert.equal(loadPersonalAssistantManifest(env, { parseDocument }).prompt, declaration.prompt);
  assert.throws(() => loadPersonalAssistantManifest({ ...env, AGENTENGINE_MANIFEST_SHA256: '0'.repeat(64) }, { parseDocument }), { code: 'MANAGED_MANIFEST_DIGEST_MISMATCH' });
  assert.throws(() => loadPersonalAssistantManifest({ ...env, AGENTENGINE_MANAGED_RUNTIME_VERSION: 'other' }, { parseDocument }), { code: 'MANAGED_RUNTIME_IDENTITY_MISMATCH' });
  assert.throws(() => loadPersonalAssistantManifest({ ...env, AGENTENGINE_MANIFEST_PROTOCOL: 'other' }, { parseDocument }), { code: 'MANAGED_RUNTIME_IDENTITY_INVALID' });
});
