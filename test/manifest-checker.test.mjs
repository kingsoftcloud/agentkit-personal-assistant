import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkPersonalAssistantManifest, PERSONAL_ASSISTANT_MANIFEST_PATH } from '../runtime/check-manifest.mjs';

test('固定manifest checker只读取公开声明身份，不要求密钥或写状态', () => {
  const env = { AGENTENGINE_MANIFEST_PATH: PERSONAL_ASSISTANT_MANIFEST_PATH, AGENTENGINE_MANIFEST_SHA256: 'a'.repeat(64) };
  const result = checkPersonalAssistantManifest(env, { loadManifest: value => { assert.deepEqual(Object.keys(value).sort(), ['AGENTENGINE_MANIFEST_PATH', 'AGENTENGINE_MANIFEST_SHA256']); return { runtime: { name: 'personal-assistant', version: 'candidate' } }; } });
  assert.deepEqual(result, { verified: true, runtime: 'personal-assistant', version: 'candidate', manifestSha256: 'a'.repeat(64) });
  assert.throws(() => checkPersonalAssistantManifest({ ...env, AGENTENGINE_MANIFEST_PATH: '/other' }), { code: 'MANAGED_MANIFEST_PATH_INVALID' });
  assert.throws(() => checkPersonalAssistantManifest(env, { loadManifest: () => { throw Object.assign(new Error('mismatch'), { code: 'MANAGED_MANIFEST_DIGEST_MISMATCH' }); } }), { code: 'MANAGED_MANIFEST_DIGEST_MISMATCH' });
});

test('checker命令行拒绝外部路径且失败输出不泄漏环境凭据', () => {
  const result = spawnSync(process.execPath, ['runtime/check-manifest.mjs', '--manifest', '/other'], { cwd: new URL('..', import.meta.url), env: { AGENTKIT_MODEL_API_KEY: 'sensitive-fixture-do-not-log' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MANAGED_MANIFEST_ARGUMENTS_INVALID/);
  assert.doesNotMatch(result.stderr + result.stdout, /sensitive-fixture/);
});
