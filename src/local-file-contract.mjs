export const LOCAL_FILE_BYTES = 64 * 1024;
export const LOCAL_FILE_ACTIONS = Object.freeze(['file.list', 'file.read', 'file.write']);

export function validateLocalWrite({ path, text, expectedSha256 }) {
  const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
  if (typeof path !== 'string' || path.length > 4096 || /[\u0000-\u001f\\:]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw fail('LOCAL_PATH_INVALID', '写入需要授权目录内的相对文件路径');
  }
  if (typeof text !== 'string') throw fail('LOCAL_TEXT_INVALID', '写入内容必须是文本');
  if (Buffer.byteLength(text) > LOCAL_FILE_BYTES) throw fail('LOCAL_FILE_LIMIT', '当前支持写入不超过 64 KiB 的 UTF-8 文本', 413);
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw fail('LOCAL_FILE_REVISION_INVALID', '文件版本无效，请先读取现有文件');
  }
}
