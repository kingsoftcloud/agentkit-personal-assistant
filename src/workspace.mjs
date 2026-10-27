/** Workspace contract shared by runtime tools and the computer broker. */
export const PERSONAL_ASSISTANT_WORKSPACE_CAPABILITY = 'personal-assistant-workspace-managed/v1';
export const WORKSPACE_PATH_ENV = 'WORKSPACE_PATH';

import { isAbsolute, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

export function workspaceDir(value = process.env.WORKSPACE_PATH ?? '/workspace') {
  const result = String(value).trim();
  if (!isAbsolute(result)) throw new TypeError('workspace path must be absolute');
  return resolve(result);
}

export async function ensureWorkspace(value) {
  const directory = workspaceDir(value);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function workspaceMount({ path = process.env.WORKSPACE_PATH, readOnly = false } = {}) {
  return Object.freeze({ path: workspaceDir(path), readOnly: Boolean(readOnly) });
}
