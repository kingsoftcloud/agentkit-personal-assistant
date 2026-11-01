import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('npm 产物包含欢迎页及其运行时资源', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.files.includes('web'), 'package.json files 必须声明 web 目录');
  await access(join(root, 'web', 'welcome.html'));

  const { stdout } = await exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, env: process.env });
  const files = JSON.parse(stdout)[0]?.files?.map(value => value.path) || [];
  assert.ok(files.includes('web/welcome.html'), `npm archive 缺少欢迎页：${files.join(', ')}`);
});
