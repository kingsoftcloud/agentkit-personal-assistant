import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installLocal } from '../scripts/install-local.mjs';

const PA = '@kingsoftcloud/agentkit-personal-assistant', SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar-right';
const hash = value => createHash('sha256').update(value).digest('hex');
function archive(files) {
  const chunks = [];
  for (const [path, body, type = '0'] of files) {
    const data = Buffer.from(body), header = Buffer.alloc(512);
    const put = (offset, length, value) => header.write(value, offset, Math.min(length, Buffer.byteLength(value)));
    put(0, 100, path); put(100, 8, '0000644\0'); put(108, 8, '0000000\0'); put(116, 8, '0000000\0');
    put(124, 12, data.length.toString(8).padStart(11, '0') + '\0'); put(136, 12, '00000000000\0');
    header.fill(32, 148, 156); put(156, 1, type); put(257, 6, 'ustar\0'); put(263, 2, '00');
    put(148, 8, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let size = Buffer.byteLength(body) + 2;
  while (size !== Buffer.byteLength(body) + String(size).length + 1) size = Buffer.byteLength(body) + String(size).length + 1;
  return `${size} ${body}`;
}
async function fixture(t, { links = false, failDump = false } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'pa-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = join(root, 'home/profiles/probe'), delivery = join(root, 'delivery');
  await fs.mkdir(join(profile, 'node_modules'), { recursive: true }); await fs.mkdir(delivery);
  const oldPackage = JSON.stringify({ name: 'test-profile', dependencies: { retained: '1.0.0', [PA]: 'old-pa', [SIDEBAR]: 'old-sidebar' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2) + '\n';
  const config = '- insert:\n  - name: ' + PA + '\n    config:\n      apiKey: KEEP_SECRET_EXACTLY\n';
  await fs.writeFile(join(profile, 'package.json'), oldPackage); await fs.writeFile(join(profile, 'cordis.patch.yml'), config, { mode: 0o640 });
  for (const name of [PA, SIDEBAR]) {
    const [scope, leaf] = name.split('/'), external = join(root, 'external', scope), namespace = join(profile, 'node_modules', scope);
    if (links) {
      await fs.mkdir(join(external, leaf), { recursive: true });
      await fs.writeFile(join(external, leaf, 'sentinel'), 'ORIGINAL');
      await fs.mkdir(join(external, 'other')); await fs.writeFile(join(external, 'other/sentinel'), 'OTHER');
      await fs.symlink(external, namespace);
    } else { await fs.mkdir(join(namespace, leaf), { recursive: true }); await fs.writeFile(join(namespace, leaf, 'sentinel'), 'ORIGINAL'); }
  }
  const packages = [];
  for (const name of [PA, SIDEBAR]) {
    const filename = name.split('/')[1] + '.tgz';
    const bytes = archive([['package/package.json', JSON.stringify({ name, version: '1.2.3' })],
      [name === PA ? 'package/dist/client.js' : 'package/lib/client.js', name === PA ? 'plugin-client' : 'registerPanelSurface']]);
    await fs.writeFile(join(delivery, filename), bytes); packages.push({ pkgName: name, version: '1.2.3', filename, sha256: hash(bytes) });
  }
  const manifest = join(delivery, 'release-manifest.json'), release = { packages, sidebar: { sourceCommit: 'a'.repeat(40), upstreamCommit: 'b'.repeat(40) } };
  await fs.writeFile(manifest, JSON.stringify(release));
  const verifier = join(root, 'dsh-dump-stub.mjs');
  await fs.writeFile(verifier, `import fs from 'node:fs'; import path from 'node:path';
const profile=path.join(process.env.DSH_HOME,'profiles',process.argv[3]);
const p=JSON.parse(fs.readFileSync(path.join(profile,'package.json')));
for(const n of ${JSON.stringify([PA, SIDEBAR])}) {
 if(!fs.existsSync(path.join(profile,'node_modules',n,'package.json')))process.exit(23);
 const dep=p.dependencies[n];if(!dep.startsWith('file:./.pa-artifacts/')||!fs.existsSync(path.join(profile,dep.slice(5))))process.exit(24);
}
if(!p.dsh.profile.bundles.includes('${PA}'))process.exit(25);
if(${failDump}) {fs.writeFileSync(path.join(profile,'cordis.patch.yml'),'CHANGED SECRET');fs.writeFileSync(path.join(profile,'cordis.yml'),'UNWANTED');console.error('SECRET_MUST_NOT_PRINT');process.exit(42);}
console.log('composed\\n2 lines');`);
  return { root, profile, delivery, manifest, release, oldPackage, config, dshNode: process.execPath, dshBin: verifier };
}

test('组合安装默认只检查，不写 profile、缓存或配置', async t => {
  const f = await fixture(t, { links: true }); const before = await fs.readdir(f.profile);
  const result = await installLocal(f);
  assert.equal(result.dryRun, true); assert.equal(result.packages.length, 2);
  assert.equal(result.cloudBindingCreated, false); assert.equal(result.credentialsChanged, false);
  assert.deepEqual(await fs.readdir(f.profile), before);
  assert.equal(await fs.readFile(join(f.profile, 'package.json'), 'utf8'), f.oldPackage);
});

test('双命名空间拆链只替换本 profile，离线缓存与配置保留，重复安装幂等', async t => {
  const f = await fixture(t, { links: true }); const result = await installLocal({ ...f, apply: true });
  assert.equal(result.dumpConfigExit, 0); assert.equal(result.studioRestarted, false);
  for (const name of [PA, SIDEBAR]) {
    const [scope, leaf] = name.split('/');
    assert.equal((await fs.lstat(join(f.profile, 'node_modules', scope))).isSymbolicLink(), false);
    assert.equal(await fs.readFile(join(f.root, 'external', scope, leaf, 'sentinel'), 'utf8'), 'ORIGINAL');
    assert.equal(await fs.readFile(join(f.profile, 'node_modules', scope, 'other/sentinel'), 'utf8'), 'OTHER');
  }
  assert.equal(await fs.readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), f.config);
  const p = JSON.parse(await fs.readFile(join(f.profile, 'package.json')));
  assert.deepEqual(p.dsh.profile.bundles, ['@deepseek-ai/dsh-base', PA]);
  assert.equal(p.dependencies.retained, '1.0.0');
  for (const item of f.release.packages) assert.equal(hash(await fs.readFile(join(f.profile, p.dependencies[item.pkgName].slice(5)))), item.sha256);
  await installLocal({ ...f, apply: true });
  assert.equal(JSON.parse(await fs.readFile(join(f.profile, 'package.json'))).dsh.profile.bundles.filter(name => name === PA).length, 1);
  await fs.rm(f.delivery, { recursive: true });
  for (const item of f.release.packages) assert.ok((await fs.stat(join(f.profile, p.dependencies[item.pkgName].slice(5)))).isFile());
});

for (const links of [false, true]) test(`dump 失败完整回滚双包、配置及${links ? '命名空间链接' : '真实命名空间'}`, async t => {
  const f = await fixture(t, { links, failDump: true });
  await assert.rejects(installLocal({ ...f, apply: true }), error => {
    assert.equal(error.installResult.rolledBack, true); assert.match(error.message, /42/); assert.doesNotMatch(error.message, /SECRET/); return true;
  });
  assert.equal(await fs.readFile(join(f.profile, 'package.json'), 'utf8'), f.oldPackage);
  assert.equal(await fs.readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), f.config);
  assert.equal((await fs.stat(join(f.profile, 'cordis.patch.yml'))).mode & 0o777, 0o640);
  await assert.rejects(fs.lstat(join(f.profile, 'cordis.yml')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(join(f.profile, '.pa-artifacts')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(join(f.profile, '.pa-install.lock')), { code: 'ENOENT' });
  for (const name of [PA, SIDEBAR]) {
    assert.equal((await fs.lstat(join(f.profile, 'node_modules', name.split('/')[0]))).isSymbolicLink(), links);
    assert.equal(await fs.readFile(join(f.profile, 'node_modules', name, 'sentinel'), 'utf8'), 'ORIGINAL');
  }
});

test('坏摘要与路径逃逸归档在任何写操作前被拒绝', async t => {
  const f = await fixture(t), before = await fs.readdir(f.profile);
  f.release.packages[1].sha256 = '0'.repeat(64); await fs.writeFile(f.manifest, JSON.stringify(f.release));
  await assert.rejects(installLocal({ ...f, apply: true }), /SHA256/);
  assert.deepEqual(await fs.readdir(f.profile), before);
  const bad = archive([['package/../../escape', 'BAD']]);
  await fs.writeFile(join(f.delivery, f.release.packages[1].filename), bad);
  f.release.packages[1].sha256 = hash(bad); await fs.writeFile(f.manifest, JSON.stringify(f.release));
  await assert.rejects(installLocal({ ...f, apply: true }), /路径不安全/);
  assert.deepEqual(await fs.readdir(f.profile), before);
});

test('node_modules 或缓存为链接时拒绝越界，CLI 不接受密钥参数', async t => {
  const f = await fixture(t); await fs.rename(join(f.profile, 'node_modules'), join(f.root, 'shared-modules'));
  await fs.symlink(join(f.root, 'shared-modules'), join(f.profile, 'node_modules'));
  await assert.rejects(installLocal(f), /node_modules/);
  await fs.unlink(join(f.profile, 'node_modules')); await fs.rename(join(f.root, 'shared-modules'), join(f.profile, 'node_modules'));
  await fs.symlink(f.delivery, join(f.profile, '.pa-artifacts')); await assert.rejects(installLocal(f), /pa-artifacts/);
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/install-local.mjs');
  const result = spawnSync(process.execPath, [cli, '--api-key', 'SECRET_MUST_NOT_PRINT'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stdout + result.stderr, /SECRET_MUST_NOT_PRINT/);
});

test('npm 中文 PAX 路径正确解包，扩展路径逃逸与链接依然拒绝', async t => {
  const f = await fixture(t), item = f.release.packages[0];
  const writeArchive = async (path, type = '0') => {
    const bytes = archive([['package/package.json', JSON.stringify({ name: PA, version: '1.2.3' })], ['package/dist/client.js', 'client'],
      ['PaxHeader/中文', paxRecord('path', path), 'x'], ['package/docs/truncated', '中文内容', type]]);
    await fs.writeFile(join(f.delivery, item.filename), bytes); item.sha256 = hash(bytes); await fs.writeFile(f.manifest, JSON.stringify(f.release));
  };
  await writeArchive('package/docs/中文验收.md'); await installLocal({ ...f, apply: true });
  assert.equal(await fs.readFile(join(f.profile, 'node_modules', PA, 'docs/中文验收.md'), 'utf8'), '中文内容');
  await writeArchive('package/../../escape'); await assert.rejects(installLocal(f), /路径不安全/);
  await writeArchive('package/docs/link', '2'); await assert.rejects(installLocal(f), /不允许链接/);
});

test('未开通的新 profile 安装只注册 bundle，不伪造云绑定', async t => {
  const f = await fixture(t); await fs.rm(join(f.profile, 'cordis.patch.yml'));
  const result = await installLocal({ ...f, apply: true }); assert.equal(result.cloudBindingCreated, false);
  const p = JSON.parse(await fs.readFile(join(f.profile, 'package.json')));
  assert.equal(p.dsh.profile.bundles.includes(PA), true);
  await assert.rejects(fs.lstat(join(f.profile, 'cordis.patch.yml')), { code: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(p), /gatewayUrl|agentId|apiKey|defaultBotId/);
});

test('损坏的 profile JSON 不把配置片段泄露到安装错误', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.profile, 'package.json'), 'PRIVATE_CREDENTIAL_SHOULD_STAY_PRIVATE');
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/install-local.mjs');
  const result = spawnSync(process.execPath, [cli, '--profile', f.profile, '--manifest', f.manifest, '--apply'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /不是有效 JSON/);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_CREDENTIAL_SHOULD_STAY_PRIVATE/);
  await assert.rejects(fs.lstat(join(f.profile, '.pa-backups')), { code: 'ENOENT' });
});
