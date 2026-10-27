#!/usr/bin/env node
// 导出发给 npm 的客户端子集：
//   - 宿主 + 面板代码在 src/（不依赖 runtime/，本地运行不会用到云电脑运行时）
//   - 面板构建产物在 dist/client.js
//   - 插件清单 / cordis patch / 协议文件
// 运行时（runtime/）、构建脚本（scripts/）、内部文档（docs/）、测试（test/）不进入 npm。
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '.artifacts/npm-client');

const INCLUDE = [
  'src',
  'dist/client.js',
  'personal-assistant.plugin.json',
  'personal-assistant.plugin.schema.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'NOTICE',
];

const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

// 只保留客户端子集需要的导出；runtime 相关入口不对外。
const exports = Object.fromEntries(Object.entries(source.exports || {})
  .filter(([key]) => key === '.' || key === './client' || key === './manifest' || key === './plugin-manifest'));

// npm 上使用干净 semver（内部镜像版本带 -desktop.<日期> 后缀），可用 NPM_VERSION 显式覆盖。
const npmVersion = process.env.NPM_VERSION || String(source.version).replace(/-desktop\..*$/u, '');

const published = {
  name: source.name,
  version: npmVersion,
  description: source.description,
  homepage: source.homepage?.replace('ezone.ksyun.com/code/agentkit/', 'github.com/kingsoftcloud/'),
  repository: { type: 'git', url: 'git+https://github.com/kingsoftcloud/agentkit-personal-assistant.git' },
  license: source.license,
  type: 'module',
  engines: source.engines,
  exports,
  files: INCLUDE,
  peerDependencies: source.peerDependencies,
  dsh: source.dsh,
  main: './src/index.mjs',
  publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
for (const entry of INCLUDE) await cp(join(root, entry), join(outDir, entry), { recursive: true });
await writeFile(join(outDir, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
await writeFile(join(outDir, '.gitignore'), '*.tgz\n');
console.log(`npm 客户端子集已生成：${outDir}`);
