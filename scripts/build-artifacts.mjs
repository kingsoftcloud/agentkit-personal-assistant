import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.PA_ARTIFACT_OUTPUT || join(root, 'dist', 'artifacts'));
if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error(`artifact build requires Node 22, got ${process.versions.node}`);

async function hash(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function pack(role, files) {
  await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(output, `.stage-${role}-`));
  try {
    for (const [relative, source] of files) {
      const target = join(stage, relative);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true });
    }
    const archive = join(output, `agentkit-personal-assistant-${role}.tar`);
    try {
      await exec('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', archive, '-C', stage, '.']);
    } catch (error) {
      const detail = String(error?.stderr || error?.message);
      if (!detail.includes('unrecognized option') && !detail.includes('not supported')) throw error;
      await exec('python3', [join(root, 'scripts', 'deterministic_tar.py'), stage, archive]);
    }
    const context = join(output, `${role}-context`, 'artifact');
    await mkdir(context, { recursive: true });
    await cp(archive, join(context, archive.split('/').at(-1)));
    return { role, archive, context: dirname(context), sha256: await hash(archive) };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const results = [
  await pack('runtime', [
    ['bin/assistant-runtime', join(root, 'scripts', 'assistant-runtime-launcher.sh')],
    ['runtime/assistant-runtime.mjs', join(root, 'runtime', 'assistant-runtime.mjs')],
    ['src', join(root, 'src')],
  ]),
  await pack('computer', [
    ['bin/computer-agentd', join(root, 'scripts', 'computer-agentd-launcher.sh')],
    ['runtime/computer-agentd.mjs', join(root, 'runtime', 'computer-agentd.mjs')],
    ['runtime/cloud-browser.mjs', join(root, 'runtime', 'cloud-browser.mjs')],
    ['runtime/cloud-browser-cdp.mjs', join(root, 'runtime', 'cloud-browser-cdp.mjs')],
    ['runtime/cloud-execution.mjs', join(root, 'runtime', 'cloud-execution.mjs')],
  ]),
];
console.log(JSON.stringify({ node: process.versions.node, artifacts: results }, null, 2));
