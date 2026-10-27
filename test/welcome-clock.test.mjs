import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWelcomeServer } from '../runtime/welcome-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');

const fetchText = async (url, options) => {
  const response = await fetch(url, options);
  return { status: response.status, body: await response.text() };
};

test('欢迎页桥以 /config.json 暴露桌面时区，默认 Asia/Shanghai', async () => {
  const server = await createWelcomeServer({ webDir, launch: async () => {}, timeZone: 'Asia/Shanghai' });
  try {
    const { status, body } = await fetchText(`http://127.0.0.1:${server.port}/config.json`);
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body), { timeZone: 'Asia/Shanghai' });
  } finally {
    await server.close();
  }
});

test('欢迎页时钟按 /config.json 的时区格式化，而不是浏览器本地时区', async () => {
  const html = await readFile(join(webDir, 'welcome.html'), 'utf8');
  assert.match(html, /fetch\('\/config\.json'/u);
  assert.match(html, /Intl\.DateTimeFormat\([^)]*timeZone:\s*cfg\.timeZone/u);
  // 静态兜底必须仍然存在：拿不到配置时用本地时间，不能空白。
  assert.match(html, /d\.getHours\(\)/u);
});

test('欢迎页桥只接受 GET 的 config.json，POST 仍走 /launch 白名单', async () => {
  let launched = 0;
  const server = await createWelcomeServer({ webDir, launch: async () => { launched += 1; } });
  try {
    const denied = await fetchText(`http://127.0.0.1:${server.port}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rm -rf /' }),
    });
    assert.equal(denied.status, 400);
    assert.equal(JSON.parse(denied.body).code, 'WELCOME_ACTION_DENIED');
    assert.equal(launched, 0);
  } finally {
    await server.close();
  }
});
