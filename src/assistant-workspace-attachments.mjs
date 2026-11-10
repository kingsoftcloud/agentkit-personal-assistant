/** Verified native attachments copied into one already-owned managed workspace. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ASSISTANT_ATTACHMENT_LIMITS } from './contracts/assistant-attachments.mjs';

const fail = () => Object.assign(new Error('附件工作区副本无法验证，请核对工作区后重新发送'), { code: 'ASSISTANT_ATTACHMENT_INVALID', status: 409 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || await realpath(path) !== path) throw fail();
}

export function createAssistantWorkspaceAttachmentCopies({ agent, workspaceRoot }) {
  const prompt = agent.ctx?.get('systemPrompt');
  let closed = false;
  const release = typeof prompt?.section === 'function' ? agent.ctx.effect(() => prompt.section({
    name: 'agentkit:assistant-attachments', order: 10310, interpolate: false,
    text: 'Generic files uploaded to this managed Session have verified working copies in the private workspace under .assistant-inputs/<SHA256>/<original filename>. '
      + 'Native file handles describe internal attachment storage, which is outside your file-tool authority. For an uploaded file, use glob with path ".assistant-inputs" to locate its matching filename/digest, then read the workspace copy. '
      + 'These are editable working copies; the original native attachment and its download receipt remain unchanged. Do not try to read the internal DSH attachment path or request wider permissions.',
  })) : undefined;
  return {
    async stage(ref, bytes) {
      if (closed || typeof prompt?.section !== 'function' || !(bytes instanceof Uint8Array)
        || !/^sha256:[a-f0-9]{64}$/.test(ref?.attachmentId || '') || ref.bytes !== bytes.byteLength
        || bytes.byteLength > ASSISTANT_ATTACHMENT_LIMITS.maxAttachmentBytes || digest(bytes) !== ref.attachmentId.slice(7)
        || typeof ref.name !== 'string' || !ref.name || ref.name.length > ASSISTANT_ATTACHMENT_LIMITS.maxNameLength
        || /[\\/\x00-\x1f\x7f]/.test(ref.name) || ['.', '..'].includes(ref.name)) throw fail();
      const base = join(workspaceRoot, '.assistant-inputs'), directory = join(base, ref.attachmentId.slice(7));
      await privateDirectory(base); if (closed) throw fail();
      await privateDirectory(directory); if (closed) throw fail();
      const path = join(directory, ref.name);
      let file;
      try { file = await open(path, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A repeated receipt may reuse only an unchanged regular private copy.
        // Never follow an alias or overwrite a file the user/Agent has edited.
        const before = await lstat(path);
        if (closed || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.mode & 0o077) throw fail();
        const existing = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const info = await existing.stat();
          if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size !== ref.bytes) throw fail();
          const buffer = Buffer.alloc(ref.bytes + 1); let length = 0;
          while (length < buffer.length) {
            const result = await existing.read(buffer, length, buffer.length - length, length);
            if (!result.bytesRead) break; length += result.bytesRead;
          }
          if (closed || length !== ref.bytes || digest(buffer.subarray(0, length)) !== ref.attachmentId.slice(7)) throw fail();
          return;
        } finally { await existing.close(); }
      }
      try {
        if (closed) throw fail();
        await file.writeFile(bytes); if (closed) throw fail();
        await file.sync(); if (closed) throw fail();
      }
      catch (error) { await unlink(path).catch(() => {}); throw error; }
      finally { await file.close(); }
    },
    dispose() { if (closed) return; closed = true; release?.(); },
  };
}
