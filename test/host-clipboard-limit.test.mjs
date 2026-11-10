/**
 * Host 侧本机剪贴板的 64 KiB 口径：与云端 desktop-session、面板组件一致。
 * 这里只覆盖「在 spawn 系统剪贴板命令之前就被拒绝」的路径，
 * 不写真实系统剪贴板，避免测试污染开发机剪贴板。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalAssistantHostGateway } from '../src/host-gateway.mjs';

const config = { gatewayUrl: 'https://gateway.example/', agentId: 'ar-real', apiKey: 'host-only-secret' };
const gatewayOf = () => createPersonalAssistantHostGateway(config, { env: {} });

test('Host 拒绝超过 64 KiB 的本机剪贴板写入：413 PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE', async () => {
  const gateway = gatewayOf();
  await assert.rejects(
    gateway.request('personal-assistant.clipboard.write', { text: 'a'.repeat(64 * 1024 + 1) }),
    error => {
      assert.equal(error.code, 'PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE');
      assert.equal(error.status, 413);
      assert.match(error.message, /64 KiB/);
      return true;
    },
  );
});

test('Host 本机剪贴板写入参数校验：非字符串 400，不进入系统命令', async () => {
  const gateway = gatewayOf();
  for (const text of [42, null, undefined, { text: 'a' }, ['a']]) {
    await assert.rejects(
      gateway.request('personal-assistant.clipboard.write', { text }),
      error => {
        assert.equal(error.code, 'PERSONAL_ASSISTANT_REQUEST_INVALID');
        assert.equal(error.status, 400);
        return true;
      },
    );
  }
});

test('本机剪贴板读写属于 Host 支持的 operation，且在绑定之前处理', async () => {
  // clipboard.* 在 binding() 之前处理（见 src/host-gateway.mjs 的 dispatch 顺序），
  // 所以面板刚打开、账号尚未绑定时也能用；这里用超长写入确认请求走到了剪贴板实现而不是 404。
  const gateway = gatewayOf();
  await assert.rejects(
    gateway.request('personal-assistant.clipboard.write', { text: '超'.repeat(22_000) }),
    { code: 'PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE', status: 413 },
  );
});

const tooLargeError = () => Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });

test('Host 读取本机剪贴板超过 64 KiB：413 内容过大，而不是 503 暂时不可用', async () => {
  // 注入系统命令执行器，复现 execFile 的 maxBuffer 超限；不读开发机真实剪贴板。
  const gateway = createPersonalAssistantHostGateway(config, { env: {}, clipboardExecFile: async () => { throw tooLargeError(); } });
  await assert.rejects(
    gateway.request('personal-assistant.clipboard.read'),
    error => {
      assert.equal(error.code, 'PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE');
      assert.equal(error.status, 413);
      assert.match(error.message, /64 KiB/);
      return true;
    },
  );
});

test('Host 读取本机剪贴板其它失败：保持 503 暂时不可用，不误报超长', async () => {
  const gateway = createPersonalAssistantHostGateway(config, { env: {}, clipboardExecFile: async () => { throw Object.assign(new Error('spawn pbpaste ENOENT'), { code: 'ENOENT' }); } });
  await assert.rejects(
    gateway.request('personal-assistant.clipboard.read'),
    { code: 'PERSONAL_ASSISTANT_CLIPBOARD_UNAVAILABLE', status: 503 },
  );
});

test('Host 读取本机剪贴板成功：透传文本，且读路径同样在绑定之前可用', async () => {
  const gateway = createPersonalAssistantHostGateway(config, { env: {}, clipboardExecFile: async () => ({ stdout: '从本机复制的内容\n' }) });
  assert.deepEqual(await gateway.request('personal-assistant.clipboard.read'), { text: '从本机复制的内容\n' });
});

// macOS 的 pbpaste/pbcopy 默认按 MacRoman 处理文本：中文读出来是「????」、写进去是
// 「‰Ω†Â•Ω」。必须显式带上 __CF_USER_TEXT_ENCODING 的 UTF-8 编码才能两个方向都对。
test('macOS 读本机剪贴板时显式指定 UTF-8 文本编码', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  const gateway = createPersonalAssistantHostGateway(config, {
    env: {},
    clipboardExecFile: async (command, args, options) => {
      calls.push({ command, args, env: options?.env });
      return { stdout: Buffer.from('你好世界', 'utf8') };
    },
  });
  const value = await gateway.request('personal-assistant.clipboard.read');
  assert.equal(value.text, '你好世界');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/usr/bin/pbpaste');
  assert.equal(calls[0].env?.__CF_USER_TEXT_ENCODING, '0x1F5:0x08000100:0');
});
