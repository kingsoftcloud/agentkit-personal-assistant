#!/usr/bin/env node
/**
 * 全量静态检查：对 src/ 与 runtime/ 下所有 .mjs 逐个 node --check，再跑单元测试。
 *
 * 早先 package.json 里是一条手写的 node --check && ... 长链，新增文件容易漏掉，
 * 还出现过同一文件重复三次、两个文件挤进同一条命令导致实际没被检查的情况。
 * 改成遍历目录后，新增文件自动纳入。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const ROOTS = ['src', 'runtime'];

function collect(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const absolute = join(directory, name);
    if (statSync(absolute).isDirectory()) files.push(...collect(absolute));
    else if (name.endsWith('.mjs')) files.push(absolute);
  }
  return files;
}

const files = ROOTS.flatMap(directory => collect(join(root, directory))).sort();
const failed = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) failed.push({ file: relative(root, file), error: (result.stderr || '').trim().split('\n').slice(0, 4).join('\n') });
}

console.log(JSON.stringify({ event: 'personal-assistant.check', files: files.length, failed: failed.length }));
if (failed.length > 0) {
  for (const item of failed) console.error(`${item.file}\n${item.error}`);
  process.exit(1);
}

const tests = spawnSync('npm', ['test'], { cwd: root, stdio: 'inherit' });
process.exit(tests.status ?? 1);
