import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// runtime 镜像里只有 runtime 产物清单中的文件。任何一个 runtime 产物文件静态导入了
// 只存在于 computer 产物的模块，都会让云端插件在启动时抛 ERR_MODULE_NOT_FOUND，
// 表现是 DSH 网页起来了但 8080 不监听（前端「无法连接」）。这条测试把清单钉住。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_FILES = new Set([
  'assistant-runtime.mjs',
  'cloud-session-channel.mjs',
  'desktop-ws.mjs',
  'desktop-permit.mjs',
  'desktop-clipboard-limit.mjs',
  'prepare-dsh-profile.mjs',
  'check-manifest.mjs',
]);

const importsOf = source => [...source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/gu)].map(match => match[1]);

test('runtime 产物内的相对导入只落在 runtime 产物文件或 src/ 内', async () => {
  const offenders = [];
  for (const name of RUNTIME_FILES) {
    const source = await readFile(join(root, 'runtime', name), 'utf8');
    for (const specifier of importsOf(source)) {
      if (!specifier.startsWith('.')) continue;
      const absolute = resolve(root, 'runtime', specifier);
      const insideSrc = absolute.startsWith(join(root, 'src') + '/');
      const insideRuntime = dirname(absolute) === join(root, 'runtime') && RUNTIME_FILES.has(absolute.slice(absolute.lastIndexOf('/') + 1));
      if (!insideSrc && !insideRuntime) offenders.push(`runtime/${name} → ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], `runtime 产物导入了不在产物清单里的模块：${offenders.join(', ')}`);
});

test('desktop-ws 的剪贴板上限与 computer 容器的 desktop-session 保持一致', async () => {
  const { DESKTOP_CLIPBOARD_MAX_BYTES: shared } = await import('../runtime/desktop-clipboard-limit.mjs');
  const { DESKTOP_CLIPBOARD_MAX_BYTES: canonical } = await import('../runtime/desktop-session.mjs');
  assert.equal(shared, canonical);
});
