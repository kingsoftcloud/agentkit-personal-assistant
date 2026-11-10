#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const forbidden = [
  /agentkit-host/iu,
  /@kingsoftcloud\/agentkit-host/u,
  /hostPersonalAssistantDesktop/u,
  /host-pure-dsh/u,
];
const ignored = new Set(['scripts/check-standalone-boundary.mjs', 'CHANGELOG.zh.md']);
const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root });
const files = stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)
  .filter(file => !ignored.has(file))
  .filter(file => /^(?:src|runtime|scripts|test|package\.json|personal-assistant\.plugin\.json|README\.md)/u.test(file));
const failures = [];
for (const file of files) {
  let text;
  try { text = await readFile(resolve(root, file), 'utf8'); } catch { continue; }
  for (const pattern of forbidden) if (pattern.test(text)) failures.push({ file, pattern: String(pattern) });
}
if (failures.length) {
  console.error(JSON.stringify({ event: 'personal-assistant.standalone-boundary', passed: false, failures }, null, 2));
  process.exitCode = 1;
} else console.log(JSON.stringify({ event: 'personal-assistant.standalone-boundary', passed: true, files: files.length }));
