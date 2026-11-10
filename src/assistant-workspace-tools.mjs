/** Trusted, approval-only operations for a receipt-owned assistant workspace. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const ASSISTANT_DELETE_FILE_TOOL = 'assistant_delete_workspace_file';
const registrations = new WeakMap();
const fail = message => Object.assign(new Error(message), { code: 'ASSISTANT_WORKSPACE_DELETE_REFUSED' });
const MAX_DELETE_BYTES = 20 * 1024 * 1024;

function inspect(root, input) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(input) || realpathSync(root) !== root) throw fail('Workspace file cannot be verified');
  const path = resolve(root, input), name = relative(root, path);
  if (!name || name === '..' || name.startsWith('..' + sep) || isAbsolute(name)) throw fail('Only a file inside this assistant workspace may be deleted');
  let current = root;
  for (const part of name.split(sep)) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw fail('Symbolic links cannot be deleted by this tool');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_DELETE_BYTES) throw fail('Only one regular file up to 20 MiB may be deleted');
    const buffer = Buffer.alloc(info.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, length); if (count === 0) break; length += count; }
    const bytes = buffer.subarray(0, length), after = fstatSync(fd);
    if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw fail('File changed while preparing its deletion preview');
    return { path, name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dev: info.dev, ino: info.ino,
      mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  } finally { closeSync(fd); }
}

/** No filesystem deletion is possible without the same execution's preview. */
export function registerAssistantWorkspaceTools({ agent, workspaceRoot }) {
  const tools = agent.ctx.get('tools');
  const previous = registrations.get(agent);
  if (previous) {
    if (previous.root !== workspaceRoot || tools.get(ASSISTANT_DELETE_FILE_TOOL, agent) !== previous.definition) throw fail('Workspace tool registration changed');
    return previous.catalog;
  }
  const previews = new WeakMap();
  const definition = {
    name: ASSISTANT_DELETE_FILE_TOOL,
    description: 'Delete one regular file inside this assistant workspace after explicit one-shot approval of its exact path, SHA256 and byte count. No directories, links, recursive deletion or outside paths.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { deleted: { type: 'boolean' }, path: { type: 'string' }, bytes: { type: 'number' }, sha256: { type: 'string' } }, required: ['deleted', 'path', 'bytes', 'sha256'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: `Deleted approved workspace file ${JSON.stringify(value.path)} (${value.bytes} bytes, SHA256 ${value.sha256}).` }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const preview = previews.get(exec.token); previews.delete(exec.token);
      if (!preview) throw fail('This invocation has no approved deletion preview');
      const current = inspect(workspaceRoot, args.file_path);
      if (JSON.stringify(current) !== JSON.stringify(preview)) throw fail('File changed after approval; request a fresh preview');
      // No await separates final identity/content verification and unlink. This
      // excludes competing JS tool tasks, not a hostile same-UID OS process.
      exec.signal.throwIfAborted();
      unlinkSync(current.path);
      return { deleted: true, path: current.name, bytes: current.bytes, sha256: current.sha256 };
    },
  };
  tools.register(definition);
  const catalog = [{ name: definition.name, category: 'destructive-delete', definition,
    describe(args, exec) {
      const preview = inspect(workspaceRoot, args.file_path);
      previews.set(exec.token, preview);
      return `Permanently delete only workspace file ${JSON.stringify(preview.name)} (${preview.bytes} bytes; SHA256 ${preview.sha256}). This cannot be undone by this tool.`;
    } }];
  registrations.set(agent, { root: workspaceRoot, definition, catalog });
  return catalog;
}
