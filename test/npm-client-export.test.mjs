import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(join(tmpdir(), 'pa-npm-client-'));
after(() => rmSync(outDir, { recursive: true, force: true }));

test('npm 客户端子集只包含面板与宿主代码', () => {
  execFileSync(process.execPath, ['scripts/export-npm-client.mjs', '--out', outDir], { cwd: root, stdio: 'pipe' });
  const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@kingsoftcloud/agentkit-personal-assistant');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(pkg.publishConfig.access, 'public');
  for (const dir of ['runtime', 'scripts', 'test', 'docs']) {
    assert.equal(existsSync(join(outDir, dir)), false, `${dir}/ 不应出现在 npm 包中`);
  }
  assert.ok(existsSync(join(outDir, 'dist/client.js')));
  assert.ok(existsSync(join(outDir, 'personal-assistant.plugin.json')));
});
