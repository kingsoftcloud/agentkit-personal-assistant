#!/usr/bin/env node
/** 将个人助理与原生侧栏补丁一起离线安装到指定 DSH profile；默认仅检查。 */
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const PA = '@kingsoftcloud/agentkit-personal-assistant';
const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar-right';
const NODE = '/Applications/AgentKit Studio.app/Contents/MacOS/AgentKit Studio';
const DSH = '/Applications/AgentKit Studio.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stat = async path => fs.lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const fail = message => { throw new Error(message); };

function readTar(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 200 * 1024 * 1024 });
  const files = [], paths = new Set();
  let offset = 0, unpacked = 0, pax = null;
  const field = (header, start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) break;
    const checksum = Number.parseInt(field(header, 148, 8).trim(), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual) fail('tar 头校验失败');
    const sizeText = field(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) fail('tar 文件长度无效');
    const size = Number.parseInt(sizeText, 8), type = field(header, 156, 1);
    if (offset + size > tar.length || !Number.isSafeInteger(size)) fail('tar 文件被截断');
    if (type === 'x') {
      if (pax) fail('tar PAX 扩展头不能重叠');
      pax = Object.create(null);
      const data = tar.subarray(offset, offset + size);
      for (let cursor = 0; cursor < data.length;) {
        const space = data.indexOf(32, cursor), lengthText = data.subarray(cursor, space).toString();
        if (space < cursor || !/^[1-9][0-9]*$/.test(lengthText)) fail('tar PAX 长度无效');
        const end = cursor + Number(lengthText);
        if (!Number.isSafeInteger(end) || end > data.length || end <= space + 2 || data[end - 1] !== 10) fail('tar PAX 内容无效');
        const record = data.subarray(space + 1, end - 1).toString(), equal = record.indexOf('='), key = record.slice(0, equal);
        if (equal < 1 || !['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key) || Object.hasOwn(pax, key)) fail('tar PAX 字段不安全');
        pax[key] = record.slice(equal + 1); cursor = end;
      }
      offset += Math.ceil(size / 512) * 512; continue;
    }
    if (!['', '0', '5'].includes(type)) fail('tar 不允许链接或特殊文件');
    if (pax?.size !== undefined && (!/^[0-9]+$/.test(pax.size) || Number(pax.size) !== size)) fail('tar PAX 文件长度不一致');
    const prefix = field(header, 345, 155), name = pax?.path ?? ((prefix ? prefix + '/' : '') + field(header, 0, 100));
    pax = null;
    const normalized = name.replace(/\/$/, '');
    if (!normalized.startsWith('package/') || normalized.includes('\\') || normalized.includes('\n') ||
        posix.normalize(normalized) !== normalized || normalized.split('/').some(part => part === '..' || part === '.')) {
      fail('tar 成员路径不安全');
    }
    if (paths.has(normalized)) fail('tar 成员路径重复');
    paths.add(normalized);
    const path = normalized.slice('package/'.length);
    unpacked += size;
    if (unpacked > 200 * 1024 * 1024) fail('tar 解包大小超限');
    files.push({ path, directory: type === '5', mode: Number.parseInt(field(header, 100, 8).trim(), 8) & 0o777,
      data: tar.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  if (pax) fail('tar PAX 扩展头缺少后续文件');
  // 写入前检查文件/目录冲突，避免归档顺序改变路径解析。
  const regular = new Set(files.filter(file => !file.directory).map(file => file.path));
  for (const file of files) for (let parent = posix.dirname(file.path); parent !== '.'; parent = posix.dirname(parent)) {
    if (regular.has(parent)) fail('tar 文件与目录冲突');
  }
  return files;
}

async function requireDirectory(path, description, optional = false) {
  const info = await stat(path);
  if (!info && optional) return false;
  if (!info?.isDirectory() || info.isSymbolicLink()) fail(description + '必须为真实目录，拒绝链接');
  return true;
}

async function extract(files, directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  for (const file of files) {
    const target = join(directory, file.path);
    await fs.mkdir(file.directory ? target : dirname(target), { recursive: true });
    if (!file.directory) await fs.writeFile(target, file.data, { flag: 'wx', mode: file.mode || 0o644 });
  }
}

export async function installLocal({ profile, manifest, apply = false, dshNode = NODE, dshBin = DSH }) {
  if (!isAbsolute(profile || '')) fail('--profile 必须是绝对路径');
  profile = resolve(profile);
  if (basename(dirname(profile)) !== 'profiles' || !basename(profile)) fail('目标必须是 <DSH_HOME>/profiles/<名称>');
  await requireDirectory(profile, 'profile');
  await requireDirectory(dirname(profile), 'profiles');
  await requireDirectory(dirname(dirname(profile)), 'DSH_HOME');
  const packagePath = join(profile, 'package.json');
  const packageInfo = await stat(packagePath);
  if (!packageInfo?.isFile()) fail('profile package.json 不存在或为链接');
  const original = await fs.readFile(packagePath), pkg = JSON.parse(original);
  const manifestPath = resolve(manifest), manifestBytes = await fs.readFile(manifestPath);
  const release = JSON.parse(manifestBytes);
  if (!Array.isArray(release.packages) || release.packages.length !== 2) fail('manifest 必须恰好包含两个包');
  const names = release.packages.map(item => item.pkgName);
  if (new Set(names).size !== 2 || !names.includes(PA) || !names.includes(SIDEBAR)) fail('manifest 包集合不正确');
  const sourceCommit = release.sidebar?.sourceCommit || release.packages.find(item => item.pkgName === SIDEBAR).sourceCommit;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '')) fail('manifest 缺少侧栏 sourceCommit');
  const prepared = [];
  for (const item of release.packages) {
    if (!item.version || typeof item.version !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256 || '') ||
        !item.filename || basename(item.filename) !== item.filename || item.filename.includes('\\')) fail('包版本、文件名或 SHA256 无效');
    const source = join(dirname(manifestPath), item.filename);
    if (!(await stat(source))?.isFile()) fail('安装包不存在或为链接：' + item.filename);
    const archive = await fs.readFile(source);
    if (sha256(archive) !== item.sha256) fail('安装包 SHA256 不匹配：' + item.pkgName);
    const files = readTar(archive), metaFile = files.find(file => file.path === 'package.json' && !file.directory);
    const meta = metaFile && JSON.parse(metaFile.data.toString());
    if (meta?.name !== item.pkgName || meta?.version !== item.version) fail('归档包名或版本不匹配：' + item.pkgName);
    const clientPath = item.pkgName === PA ? 'dist/client.js' : 'lib/client.js';
    const client = files.find(file => file.path === clientPath && !file.directory);
    if (!client?.data.length || (item.pkgName === SIDEBAR && !client.data.includes(Buffer.from('registerPanelSurface')))) fail('客户端产物缺失：' + item.pkgName);
    const [scope, leaf] = item.pkgName.split('/');
    prepared.push({ item, source, archive, files, scope, leaf });
  }
  const modules = join(profile, 'node_modules'), cache = join(profile, '.pa-artifacts'), backups = join(profile, '.pa-backups');
  const modulesExisted = await requireDirectory(modules, 'node_modules', true);
  const cacheExisted = await requireDirectory(cache, '.pa-artifacts', true);
  await requireDirectory(backups, '.pa-backups', true);
  for (const entry of prepared) {
    const scopeInfo = await stat(join(modules, entry.scope));
    if (scopeInfo && !scopeInfo.isDirectory() && !scopeInfo.isSymbolicLink()) fail('包命名空间不是目录');
    if (scopeInfo?.isSymbolicLink()) await fs.realpath(join(modules, entry.scope));
    entry.namespaceIsLink = scopeInfo?.isSymbolicLink() || false;
    entry.cacheName = entry.item.sha256 + '-' + entry.item.filename;
    const cachePath = join(cache, entry.cacheName), cached = await stat(cachePath);
    if (cached && (!cached.isFile() || sha256(await fs.readFile(cachePath)) !== entry.item.sha256)) fail('制品缓存存在冲突');
  }
  if (pkg.dependencies != null && (typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies))) fail('profile dependencies 格式无效');
  if (pkg.dsh != null && (typeof pkg.dsh !== 'object' || Array.isArray(pkg.dsh))) fail('profile dsh 格式无效');
  if (pkg.dsh?.profile != null && (typeof pkg.dsh.profile !== 'object' || Array.isArray(pkg.dsh.profile))) fail('profile dsh.profile 格式无效');
  if (pkg.dsh?.profile?.bundles != null && !Array.isArray(pkg.dsh.profile.bundles)) fail('profile bundles 格式无效');
  const plan = { dryRun: !apply, profile, manifestSha256: sha256(manifestBytes), sidebarSourceCommit: sourceCommit,
    packages: prepared.map(({ item, namespaceIsLink }) => ({ ...item, namespaceIsLink })),
    credentialsChanged: false, cloudBindingCreated: false, requiresUserRestart: true, appReplaced: false };
  if (!apply) return plan;

  const lock = join(profile, '.pa-install.lock');
  const handle = await fs.open(lock, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') fail('该 profile 已有安装锁，请确认没有并发安装'); throw error; });
  await handle.close();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const backup = join(backups, stamp + '-personal-assistant'), stage = join(profile, '.pa-stage-' + stamp);
  const changed = [], newCache = [], configNames = ['cordis.patch.yml', 'cordis.yml'], configModes = new Map();
  let packageChanged = false, setupStarted = false;
  try {
    await fs.mkdir(backups, { recursive: true, mode: 0o700 });
    await fs.mkdir(backup, { mode: 0o700 });
    await fs.writeFile(join(backup, 'package.json'), original, { mode: 0o600 });
    for (const name of configNames) {
      const info = await stat(join(profile, name)); configModes.set(name, info?.mode);
      if (info) {
        await fs.cp(join(profile, name), join(backup, name), { dereference: false, verbatimSymlinks: true });
        if (!info.isSymbolicLink()) await fs.chmod(join(backup, name), 0o600);
      }
    }
    await fs.mkdir(stage, { mode: 0o700 });
    for (const entry of prepared) await extract(entry.files, join(stage, entry.leaf));
    setupStarted = true;
    await fs.mkdir(modules, { recursive: true });
    await fs.mkdir(cache, { recursive: true, mode: 0o700 });
    for (const entry of prepared) {
      const namespace = join(modules, entry.scope), target = join(namespace, entry.leaf);
      const record = { namespace, target, namespaceBackup: join(backup, entry.scope + '.original'),
        packageBackup: join(backup, entry.leaf + '.original'), namespaceCreated: false, namespaceMoved: false, packageMoved: false, installed: false };
      changed.push(record);
      const scopeInfo = await stat(namespace);
      if (scopeInfo?.isSymbolicLink()) {
        const oldRoot = await fs.realpath(namespace), children = await fs.readdir(oldRoot);
        await fs.rename(namespace, record.namespaceBackup); record.namespaceMoved = true;
        await fs.mkdir(namespace); record.namespaceCreated = true;
        for (const child of children) if (child !== entry.leaf) await fs.symlink(join(oldRoot, child), join(namespace, child));
      } else {
        if (scopeInfo && !scopeInfo.isDirectory()) fail('包命名空间在安装过程中被替换');
        if (!scopeInfo) { await fs.mkdir(namespace); record.namespaceCreated = true; }
        if (await stat(target)) { await fs.rename(target, record.packageBackup); record.packageMoved = true; }
      }
      await fs.rename(join(stage, entry.leaf), target); record.installed = true;
      await fs.writeFile(join(target, 'agentkit-local-release.json'), JSON.stringify({ ...entry.item, sidebarSourceCommit: sourceCommit }, null, 2) + '\n');
      const cached = join(cache, entry.cacheName);
      if (!await stat(cached)) { await fs.writeFile(cached, entry.archive, { flag: 'wx', mode: 0o600 }); newCache.push(cached); }
      pkg.dependencies ??= {};
      pkg.dependencies[entry.item.pkgName] = 'file:./.pa-artifacts/' + entry.cacheName;
    }
    pkg.dsh ??= {}; pkg.dsh.profile ??= {}; pkg.dsh.profile.bundles ??= [];
    if (!pkg.dsh.profile.bundles.includes(PA)) pkg.dsh.profile.bundles.push(PA);
    const pending = join(stage, 'package.json');
    await fs.writeFile(pending, JSON.stringify(pkg, null, 2) + '\n', { mode: packageInfo.mode & 0o777 });
    await fs.rename(pending, packagePath); packageChanged = true;
    const dump = spawnSync(dshNode, [dshBin, '--profile', basename(profile), '--dump-config'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dirname(dirname(profile)) },
      timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
    if (dump.error || dump.status !== 0) fail('DSH 配置合成失败，退出码 ' + String(dump.status ?? dump.error?.code ?? 'unknown') + '；输出可能含凭据，不打印');
    const proof = { ...plan, dryRun: false, backup, dumpConfigExit: 0, dumpConfigLines: dump.stdout.split('\n').length,
      dumpConfigWarningLines: dump.stderr.split('\n').filter(Boolean).length, artifactCache: cache, studioRestarted: false };
    await fs.writeFile(join(backup, 'install-proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
    return proof;
  } catch (error) {
    const rollbackErrors = [];
    const restore = async action => { try { await action(); } catch (rollbackError) { rollbackErrors.push(rollbackError.code || 'RESTORE_FAILED'); } };
    for (const record of changed.reverse()) {
      if (record.installed) await restore(() => fs.rm(record.target, { recursive: true, force: true }));
      if (record.namespaceMoved) {
        await restore(() => fs.rm(record.namespace, { recursive: true, force: true }));
        await restore(() => fs.rename(record.namespaceBackup, record.namespace));
      } else {
        if (record.packageMoved) await restore(() => fs.rename(record.packageBackup, record.target));
        if (record.namespaceCreated) await restore(() => fs.rmdir(record.namespace));
      }
    }
    if (packageChanged) await restore(async () => {
      const pending = join(profile, '.pa-package-restore-' + stamp);
      await fs.writeFile(pending, original, { mode: packageInfo.mode & 0o777 }); await fs.rename(pending, packagePath);
    });
    for (const name of configNames) if (configModes.has(name)) await restore(async () => {
      await fs.rm(join(profile, name), { force: true });
      if (configModes.get(name) !== undefined) {
        await fs.cp(join(backup, name), join(profile, name), { dereference: false, verbatimSymlinks: true });
        if (!(await stat(join(profile, name))).isSymbolicLink()) await fs.chmod(join(profile, name), configModes.get(name) & 0o777);
      }
    });
    for (const file of newCache) await restore(() => fs.rm(file, { force: true }));
    if (setupStarted && !cacheExisted) await restore(() => fs.rmdir(cache));
    if (setupStarted && !modulesExisted) await restore(() => fs.rmdir(modules));
    error.installResult = { rolledBack: rollbackErrors.length === 0, rollbackErrors, backup, studioRestarted: false };
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(lock, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--apply') { options.apply = true; continue; }
      const key = { '--profile': 'profile', '--manifest': 'manifest', '--dsh-node': 'dshNode', '--dsh-bin': 'dshBin' }[args[i]];
      if (!key || !args[i + 1] || args[i + 1].startsWith('--')) fail('参数无效；用法：node install-local.mjs --profile <绝对路径> --manifest <release-manifest.json> [--apply]');
      if (options[key] !== undefined) fail('参数重复'); options[key] = args[++i];
    }
    if (!options.manifest) fail('缺少 --manifest');
    console.log(JSON.stringify(await installLocal(options), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, ...error.installResult })); process.exitCode = 1;
  }
}
