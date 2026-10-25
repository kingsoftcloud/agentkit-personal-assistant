import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

/**
 * DSH 客户端插件构建器。
 *
 * 运行入口是 `dist/client.js`（`package.json` 的 `exports['./client']`），
 * 不是 `src/client/*.mjs`；改完源码必须重新构建，Studio 里按 Cmd+R 刷新即可生效，
 * 不需要退出应用（只有 Host 代码、插件树/package.json bundles 变更才需要重启）。
 *
 * 用法：
 *   node scripts/build-client.mjs
 *   node scripts/build-client.mjs --watch
 *   node scripts/build-client.mjs --watch --out-dir ~/.dsh/profiles/<profile>/node_modules/@kingsoftcloud/agentkit-personal-assistant/dist
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
const outDirArg = argv.includes('--out-dir') ? argv[argv.indexOf('--out-dir') + 1] : '';
const outDir = outDirArg ? resolve(outDirArg.replace(/^~(?=$|\/)/u, process.env.HOME || '~')) : resolve(root, 'dist');

const stamp = new Date().toISOString();

const options = {
  absWorkingDir: root,
  entryPoints: ['src/client/entry.mjs'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  write: false,
  metafile: true,
  logLevel: 'silent',
  // 面板可在页脚渲染构建时间，便于确认 Cmd+R 后拿到的是最新产物。
  define: { __PA_CLIENT_BUILD__: JSON.stringify(stamp) },
};

function verifiedOutput(result) {
  const output = result.outputFiles?.[0]?.text || '';
  if (!output) throw new Error('客户端构建没有产物');
  if (!output.includes('window.__ModuleLoader__.load({') || !output.includes('@kingsoftcloud/agentkit-personal-assistant')) throw new Error('DSH 客户端注册入口丢失');
  if (Object.keys(result.metafile.inputs).some(path => !path.startsWith('src/client/'))) throw new Error('浏览器产物含 Host 代码');
  return output;
}

async function emit(result) {
  const output = verifiedOutput(result);
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'client.js'), output);
  return output;
}

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{
      name: 'emit-verified-client',
      setup(build) {
        build.onEnd(async result => {
          if (result.errors.length) return;
          try {
            const output = await emit(result);
            const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            console.log(`[${time}] dist/client.js ${output.length} 字节 → ${outDir}（Studio 里 Cmd+R 刷新）`);
          } catch (error) {
            console.error(`[build:client] ${error.message}`);
          }
        });
      },
    }],
  });
  await ctx.watch();
  console.log(`watching src/client → ${outDir}（改完在 Studio 按 Cmd+R，无需重启应用）`);
} else {
  const result = await build(options);
  const output = await emit(result);
  console.log(`dist/client.js ${output.length} 字节 → ${outDir}（build ${stamp}）`);
}
