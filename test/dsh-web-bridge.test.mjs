/**
 * 云端 DSH 网页入口：从启动日志里取地址、只接受回环地址、推给云电脑。
 * token 属于 Pod 内的短期凭据，这里只验证不落盘/不打印。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractDshWebUrl,
  findDshWebUrl,
  readDshWebUrlFile,
  isLoopbackDshWebUrl,
  publishDshWebUrl,
  startDshWebBridge,
} from '../src/dsh-web-bridge.mjs';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LOG_LINE = `[dsh] 云端 DSH 网页已启动：http://127.0.0.1:8081/?token=${TOKEN}&lang=zh`;

test('从启动日志里取出本机 DSH 网页地址', () => {
  assert.equal(extractDshWebUrl(LOG_LINE), `http://127.0.0.1:8081/?token=${TOKEN}`);
  assert.equal(extractDshWebUrl('没有网页地址'), null);
  assert.equal(extractDshWebUrl('http://example.com/?token=' + TOKEN), null, '外网地址不能当成本机网页');
  assert.equal(extractDshWebUrl(null), null);
});

test('只接受本机回环地址', () => {
  assert.equal(isLoopbackDshWebUrl(`http://127.0.0.1:8081/?token=${TOKEN}`), true);
  assert.equal(isLoopbackDshWebUrl('http://localhost:8081/'), true);
  assert.equal(isLoopbackDshWebUrl('http://10.0.0.1:8081/'), false);
  assert.equal(isLoopbackDshWebUrl('file:///etc/passwd'), false);
  assert.equal(isLoopbackDshWebUrl(undefined), false);
});

test('/run 地址文件优先，且只接受本机回环地址', async () => {
  assert.equal(await readDshWebUrlFile({ file: '/run/agentkit/dsh-web-url', readFile: async () => `http://127.0.0.1:8081/?token=${TOKEN}\n` }), `http://127.0.0.1:8081/?token=${TOKEN}`);
  assert.equal(await readDshWebUrlFile({ file: '/run/x', readFile: async () => 'http://example.com/?token=abcdefgh' }), null);
  assert.equal(await readDshWebUrlFile({ file: '/run/x', readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } }), null);
});

test('取最新的一份启动日志，旧日志里的过期 token 不会顶掉新的', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pa-dsh-home-'));
  const logs = join(home, 'logs');
  await mkdir(logs, { recursive: true });
  const oldFile = join(logs, 'startup-old.log');
  const newFile = join(logs, 'startup-new.log');
  await writeFile(oldFile, 'http://127.0.0.1:8081/?token=0000000000000000\n');
  await writeFile(newFile, LOG_LINE + '\n');
  await utimes(oldFile, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(await findDshWebUrl({ dshHome: home, readdir: (await import('node:fs/promises')).readdir, stat: (await import('node:fs/promises')).stat, readFile: (await import('node:fs/promises')).readFile }),
    `http://127.0.0.1:8081/?token=${TOKEN}`);
  assert.equal(await findDshWebUrl({ dshHome: join(home, 'missing') , readdir: (await import('node:fs/promises')).readdir, stat: (await import('node:fs/promises')).stat, readFile: (await import('node:fs/promises')).readFile }), null);
});

test('推送只调用 dsh-web 路由，且不把 token 写进日志', async () => {
  const seen = [];
  const result = await publishDshWebUrl({
    brokerUrl: 'http://127.0.0.1:8787/',
    url: `http://127.0.0.1:8081/?token=${TOKEN}`,
    fetchImpl: async (target, options) => {
      seen.push({ target: String(target), body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ registered: true }) };
    },
  });
  assert.deepEqual(result, { published: true, url: `http://127.0.0.1:8081/?token=${TOKEN}` });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].target, 'http://127.0.0.1:8787/broker/dsh-web');
  assert.equal(seen[0].body.url, `http://127.0.0.1:8081/?token=${TOKEN}`);
  await assert.rejects(publishDshWebUrl({ brokerUrl: 'http://127.0.0.1:8787/', url: 'http://example.com/?x=1', fetchImpl: async () => { throw new Error('should not call'); } }),
    error => error.code === 'DSH_WEB_URL_INVALID');
});

test('日志还没出现时后台重试，出现后只推一次', async () => {
  const published = [];
  const logs = [];
  let ticks = 0;
  const bridge = startDshWebBridge({
    env: { DSH_HOME: '/tmp/whatever', COMPUTER_BROKER_URL: 'http://127.0.0.1:8787/' },
    attempts: 3,
    intervalMs: 1,
    timers: { setTimeout: (fn) => { if (ticks < 3) { ticks += 1; queueMicrotask(fn); } return 1; }, clearTimeout: () => {} },
    logger: { info: message => logs.push(message), warn: message => logs.push(message) },
    findUrl: async () => (ticks >= 2 ? `http://127.0.0.1:8081/?token=${TOKEN}` : null),
    publish: async ({ url }) => { published.push(url); return { published: true }; },
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  bridge.stop();
  assert.deepEqual(published, [`http://127.0.0.1:8081/?token=${TOKEN}`], '地址出现后只推一次');
  assert.ok(logs.every(message => !message.includes(TOKEN)), '日志里不能出现 token');
  assert.ok(logs.some(message => message.includes('personal-assistant.dsh-web.registered')));
});
