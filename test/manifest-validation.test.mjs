import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDshPackageManifest, validatePersonalAssistantManifest } from '../src/plugin-manifest.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function json(name) {
  return JSON.parse(await readFile(join(root, name), 'utf8'));
}

test('package.json uses only the DSH loader manifest surfaces', async () => {
  const manifest = await json('package.json');
  assert.equal(validateDshPackageManifest(manifest), manifest);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(Array.isArray(manifest.dsh.client.inject));
  assert.ok(Array.isArray(manifest.dsh.client.external));
  assert.equal(manifest.main, './src/index.mjs');
});

test('application metadata manifest validates product-only feature flags', async () => {
  const manifest = await json('personal-assistant.plugin.json');
  assert.equal(validatePersonalAssistantManifest(manifest), manifest);
  assert.equal(manifest.metadata.defaultEnabled, false);
  assert.equal(manifest.metadata.autoConnect, false);
  assert.equal('host' in manifest, false);
  assert.equal('client' in manifest, false);
  assert.equal('defaultEnabled' in manifest, false);
  assert.equal('autoConnect' in manifest, false);
});

test('application metadata rejects unrecognized top-level loader-looking fields', () => {
  assert.throws(() => validatePersonalAssistantManifest({
    format: 'agentkit-personal-assistant.plugin/v1',
    pluginId: '@kingsoftcloud/agentkit-personal-assistant',
    version: '0.1.0',
    compatibility: { requiredDsh: '0.2.1-rc.2', requiredHostApi: 'dsh-native/0.2.1-rc.2', requiredHostContract: 1 },
    metadata: { defaultEnabled: false, autoConnect: false, capabilities: [], contributes: [], entrypoints: { host: '.', client: './client' } },
    host: './src/index.mjs',
  }), /unrecognized/);
});
