#!/usr/bin/env node
// 把当前提交导出成面向 GitHub 的公开快照：
//   - 排除内部文档 docs/、本地产物 .artifacts/；不携带内部提交历史（单条初始提交）
//   - 公开仓库只作为发布镜像，主仓仍在 ezone
// 用法：
//   node scripts/sync-public.mjs --remote git@github.com:kingsoftcloud/agentkit-personal-assistant.git [--apply]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const remote = args.includes('--remote') ? args[args.indexOf('--remote') + 1] : '';
const EXCLUDE = ['docs/', '.artifacts/', '.worktrees/', 'output/'];

const run = (file, args = []) => execFileSync(file, args, { cwd: root, stdio: 'pipe' }).toString();

const dirty = run('git', ['status', '--porcelain']).trim();
if (dirty) throw new Error('工作区不干净，先提交再同步：\n' + dirty);

const files = run('git', ['ls-files']).trim().split('\n')
  .filter(file => file && !EXCLUDE.some(prefix => file.startsWith(prefix)));
if (!files.length) throw new Error('没有可导出的文件');

const staging = mkdtempSync(join(tmpdir(), 'pa-public-'));
try {
  // 用 checkout-index 一次性导出当前索引（即 HEAD 的已跟踪文件）。
  execFileSync('git', ['checkout-index', '-a', '-f', `--prefix=${staging}/`], { cwd: root, stdio: 'inherit' });
  for (const prefix of EXCLUDE) rmSync(join(staging, prefix), { recursive: true, force: true });

  const version = JSON.parse(run('git', ['show', 'HEAD:package.json'])).version;
  const git = (...rest) => execFileSync('git', rest, { cwd: staging, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=AgentKit', '-c', 'user.email=agentkit@kingsoft.cloud',
    'commit', '-q', '-m', `AgentKit personal assistant ${version}`);
  const head = git('rev-parse', '--short', 'HEAD').toString().trim();
  console.log(`公开快照已生成：${staging}（${files.length} 个文件，提交 ${head}）`);
  if (!apply) {
    console.log('未传 --apply，未推送。');
    process.exit(0);
  }
  if (!remote) throw new Error('--apply 需要同时提供 --remote <git url>');
  git('remote', 'add', 'origin', remote);
  git('push', '--force', 'origin', 'main');
  console.log(`已推送到 ${remote} main`);
}
finally {
  if (!apply) rmSync(staging, { recursive: true, force: true });
}
