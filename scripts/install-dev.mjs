#!/usr/bin/env node
/**
 * 把当前分支的「面板相关改动」同步进一个已安装的 DSH profile，用于本地验收。
 *
 * 为什么不是整包覆盖：profile 里装的可能是比本分支更新的发布版（例如 0.1.13），
 * 整包 rsync 会把那个版本独有的 runtime/、web/ 改动降级掉。这里只同步本分支为
 * 「按原型实现」而改动/新增的文件，其余一律不动。
 *
 * 用法：
 *   node scripts/install-dev.mjs --profile ~/.dsh/profiles/desktop-agentkit-studio            # 预演，只打印
 *   node scripts/install-dev.mjs --profile ~/.dsh/profiles/desktop-agentkit-studio --apply     # 真正写入（会先备份）
 *   node scripts/install-dev.mjs --profile ~/.dsh/profiles/desktop-agentkit-studio --rollback <备份目录>
 *
 * 备份目录形如 <包目录>/.dev-backup-20261104-0230，回滚只需把其中的文件按相对路径复制回去。
 */
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = '@kingsoftcloud/agentkit-personal-assistant';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 只同步这些相对路径：本分支新增/改动的面板相关文件。 */
const SYNC = [
  'src/host-gateway.mjs',        // 新增 bot / local-access / create.status 等 operation
  'src/local-access.mjs',        // 本机授权状态机（新增）
  'src/bot-registry.mjs',        // Bot 元数据与记忆
  'src/persistent-state.mjs',    // bots / local-access 状态目录
  'src/client/index.mjs',        // 面板外壳与路由
  'src/client/conversation.mjs', // 对话视图（骨架 + 快照回显）
  'src/client/views',            // 7 个视图（新增目录）
  'src/client/components',       // 剪贴板等既有组件
  'dist/client.js',              // 客户端产物（build:client 生成，dist 被 gitignore）
];

const fail = message => { throw new Error(message); };

async function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') { options.apply = true; continue; }
    if (flag === '--rollback') { options.rollback = argv[++i]; continue; }
    if (flag === '--profile') { options.profile = argv[++i]; continue; }
    fail(`未知参数 ${flag}`);
  }
  if (!options.profile) fail('缺少 --profile');
  return options;
}

async function exists(path) {
  try { await fs.access(path); return true; } catch { return false; }
}

/** 收集要同步的真实文件（目录递归展开）。 */
async function collect() {
  const files = [];
  for (const entry of SYNC) {
    const absolute = join(root, entry);
    if (!await exists(absolute)) throw fail(`源文件缺失：${entry}（先跑 npm run build:client）`);
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(absolute)) {
        if (name.endsWith('.mjs')) files.push(`${entry}/${name}`);
      }
    } else files.push(entry);
  }
  return files;
}

async function copyInto(target, files, backupDir) {
  for (const relative of files) {
    const from = join(root, relative);
    const to = join(target, relative);
    await fs.mkdir(dirname(to), { recursive: true });
    if (backupDir && await exists(to)) {
      const keep = join(backupDir, relative);
      await fs.mkdir(dirname(keep), { recursive: true });
      await fs.copyFile(to, keep);
    }
    await fs.copyFile(from, to);
  }
}

async function main() {
  const options = await parseArgs(process.argv.slice(2));
  const profile = options.profile.replace(/^~(?=$|\/)/u, process.env.HOME || '~');
  const target = resolve(profile, 'node_modules', PKG);
  if (!await exists(target)) fail(`目标包目录不存在：${target}`);

  const files = await collect();
  const stamp = new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 13);
  const backupDir = join(target, `.dev-backup-${stamp}`);

  if (options.rollback) {
    const source = resolve(options.rollback);
    if (!await exists(source)) fail(`备份目录不存在：${source}`);
    let restored = 0;
    for (const relative of await collect()) {
      const from = join(source, relative);
      if (!await exists(from)) continue;
      await fs.copyFile(from, join(target, relative));
      restored += 1;
    }
    console.log(JSON.stringify({ rolledBack: restored, from: source }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    target,
    files,
    backup: options.apply ? backupDir : '(dry-run 不写)',
    hint: options.apply ? `回滚：node scripts/install-dev.mjs --profile ${options.profile} --rollback ${backupDir}` : '确认后加 --apply',
  }, null, 2));

  if (!options.apply) return;
  await copyInto(target, files, backupDir);
  console.log(JSON.stringify({ applied: files.length, backup: backupDir, next: '在 Studio 里 Cmd+R 重开右侧面板' }, null, 2));
}

main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
