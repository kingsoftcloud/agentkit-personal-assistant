// 文件和技能均由电脑上的相同 Landlock/租约链执行，不读取 Runtime 私有目录。
export function createWorkspaceTool({ action } = {}) {
  return {
    name: 'cloud_workspace',
    description: 'List/read/write files in the shared cloud workspace, discover skill SKILL.md files, or read a chosen skill before running its commands with cloud_bash. Paths must be relative to the workspace. Text read/write is bounded to 64 KiB. Deliver generated files with a Markdown link [下载文件](cloud-file:URL_ENCODED_RELATIVE_PATH); downloads are limited to 512 KiB per file. Internet is available by default for installing public dependencies and skills.',
    parameters: { type: 'object', required: ['action'], additionalProperties: false, properties: {
      action: { type: 'string', enum: ['list', 'read', 'write', 'skills'] }, path: { type: 'string' }, text: { type: 'string' },
    } },
    output: { schema: { type: 'object', required: ['result'], properties: { result: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value.result }] },
    async execute(args, execution) {
      if (!['list', 'read', 'write', 'skills'].includes(args.action)) throw new TypeError('unsupported workspace action');
      const path = String(args.path || '.');
      if (path.startsWith('/') || path.split(/[\\/]/u).includes('..') || /[\u0000-\u001f]/u.test(path) || path.length > 2048) throw new TypeError('path must stay inside the cloud workspace');
      if (args.action === 'write' && (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 65536)) throw new TypeError('text exceeds 64 KiB');
      const request = JSON.stringify({ ...args, path });
      const code = `import json,pathlib,os\na=json.loads(${JSON.stringify(request)})\np=pathlib.Path(a['path'])\nroot=pathlib.Path.cwd().resolve()\np=p.resolve()\nassert p==root or root in p.parents,'path escapes workspace'\nif a['action']=='skills':\n rows=[]\n for folder,dirs,files in os.walk(root/'skills',followlinks=False):\n  dirs[:]=[d for d in dirs if not pathlib.Path(folder,d).is_symlink()][:128]\n  if 'SKILL.md' in files:\n   rows.append(str(pathlib.Path(folder,'SKILL.md').relative_to(root)))\n  if len(rows)>=100: break\n print(json.dumps({'skills':rows},ensure_ascii=False))\nelif a['action']=='list':\n print(json.dumps({'files':[{'name':q.name,'directory':q.is_dir()} for q in sorted(p.iterdir())[:200]]},ensure_ascii=False))\nelif a['action']=='read':\n with p.open('rb') as f: data=f.read(65537)\n assert len(data)<=65536,'file exceeds 64 KiB; use cloud_bash for bounded processing'\n print(json.dumps({'path':str(p.relative_to(root)),'text':data.decode('utf-8')},ensure_ascii=False))\nelse:\n p.parent.mkdir(parents=True,exist_ok=True)\n p.write_text(a['text'],encoding='utf-8')\n print(json.dumps({'path':str(p.relative_to(root)),'bytes':len(a['text'].encode())}))`;
      const result = await action('terminal.exec', { language: 'python', code }, execution);
      if (result.exitCode !== 0) throw new Error(result.stderr || 'cloud workspace operation failed');
      return { result: result.stdout.trim() };
    },
  };
}
