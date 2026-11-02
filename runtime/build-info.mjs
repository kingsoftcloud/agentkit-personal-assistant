import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function manifestValue(path, field) {
  try {
    const value = require(path)?.[field];
    return typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text && !/[\u0000\r\n]/u.test(text) ? text.slice(0, 160) : 'unknown';
}

/**
 * Build identity is deliberately read from the image environment first. The
 * package/manifest fallbacks keep local and packaged computer artifacts
 * diagnosable even when the deployment did not inject release metadata.
 */
export function createBuildInfo(env = process.env) {
  return Object.freeze({
    packageVersion: clean(env.AGENTKIT_PERSONAL_ASSISTANT_VERSION || manifestValue('../package.json', 'version')),
    manifestVersion: clean(env.AGENTKIT_PERSONAL_ASSISTANT_MANIFEST_VERSION || manifestValue('../personal-assistant.plugin.json', 'version')),
    runtimeBuild: clean(env.AGENTKIT_RUNTIME_BUILD || env.AGENTKIT_BUILD_ID),
    computerImage: clean(env.AGENTKIT_COMPUTER_IMAGE || env.AGENTKIT_IMAGE || env.AGENTKIT_IMAGE_DIGEST),
    buildTimestamp: clean(env.AGENTKIT_BUILD_TIMESTAMP),
  });
}

export const DESKTOP_DOCK_LAYOUT = Object.freeze({
  position: 'bottom-center',
  panelPosition: 'bottom center horizontal',
  shrink: true,
  iconCount: 3,
  height: 56,
});
