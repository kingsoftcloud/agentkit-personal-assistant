import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBuildInfo, DESKTOP_DOCK_LAYOUT } from '../runtime/build-info.mjs';
import { createDesktopController } from '../runtime/desktop-session.mjs';

function fakeProcess() {
  const process = new EventEmitter();
  process.exitCode = null; process.killed = false;
  process.kill = () => { process.killed = true; process.exitCode = 0; process.emit('exit', 0); };
  return process;
}

test('构建诊断优先使用镜像元数据，并保留包与插件清单版本', () => {
  const info = createBuildInfo({
    AGENTKIT_PERSONAL_ASSISTANT_VERSION: '0.1.11-test',
    AGENTKIT_PERSONAL_ASSISTANT_MANIFEST_VERSION: 'desktop-test',
    AGENTKIT_RUNTIME_BUILD: 'runtime-142',
    AGENTKIT_COMPUTER_IMAGE: 'computer:142@sha256:test',
    AGENTKIT_BUILD_TIMESTAMP: '2026-10-31T00:00:00Z',
  });
  assert.deepEqual(info, {
    packageVersion: '0.1.11-test', manifestVersion: 'desktop-test', runtimeBuild: 'runtime-142',
    computerImage: 'computer:142@sha256:test', buildTimestamp: '2026-10-31T00:00:00Z',
  });
  assert.deepEqual(DESKTOP_DOCK_LAYOUT, { position: 'bottom-center', panelPosition: 'bottom center horizontal', shrink: true, iconCount: 3, height: 56 });
});

test('桌面 ready 与 stats 同时暴露版本和 Dock 诊断', async () => {
  const controller = createDesktopController({
    buildInfo: { packageVersion: 'test-package', manifestVersion: 'test-manifest', runtimeBuild: 'test-runtime', computerImage: 'test-image', buildTimestamp: 'test-time' },
    terminal: false,
    spawn: () => fakeProcess(),
    exec: async file => ({ stdout: file === 'xprop' ? '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400001\n' : '' }),
  });
  try {
    const session = await controller.openSession({ identity: {} });
    assert.equal(session.diagnostics.packageVersion, 'test-package');
    assert.equal(session.diagnostics.computerImage, 'test-image');
    assert.deepEqual(session.diagnostics.dock, DESKTOP_DOCK_LAYOUT);
    assert.deepEqual(controller.stats().diagnostics, session.diagnostics);
  } finally { await controller.dispose(); }
});
