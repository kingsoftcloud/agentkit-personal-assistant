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
