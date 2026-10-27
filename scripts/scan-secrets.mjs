#!/usr/bin/env node
// 轻量密钥扫描：公开仓库 CI 用，检测 AK/SK、令牌、私钥和高危赋值。
// 只做行级启发式检查；发现命中即失败，避免把凭证带进公开镜像。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;

const RULES = [
  { name: '私钥块', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: 'AWS/金山云 AccessKey', pattern: /\bAKID[0-9A-Za-z]{16,}|\bAKIA[0-9A-Z]{16}\b|\bAKLT[0-9A-Za-z-]{10,}\b/u },
  { name: '疑似 SecretKey 赋值', pattern: /(?:secret[_-]?key|access[_-]?key[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9/+=]{24,}['"]/iu },
  { name: 'npm token', pattern: /npm_[A-Za-z0-9]{36,}/u },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u },
  { name: 'Bearer 硬编码', pattern: /Bearer\s+[A-Za-z0-9._~+/-]{32,}/u },
];

const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')
  .filter(file => file && !/^(?:node_modules|\.artifacts)\//u.test(file));

const hits = [];
for (const file of files) {
  let text;
  try { text = readFileSync(ROOT + '/' + file, 'utf8'); }
  catch { continue; }
  // 测试夹具里允许出现假令牌（只保留私钥规则），避免把 mock 当成凭证。
  const fixture = /^(?:test|\.artifacts)\//u.test(file);
  text.split('\n').forEach((line, index) => {
    for (const rule of RULES) {
      if (fixture && rule.name !== '私钥块') continue;
      if (rule.pattern.test(line)) hits.push(`${file}:${index + 1} [${rule.name}]`);
    }
  });
}

if (hits.length) {
  console.error(`发现 ${hits.length} 处疑似密钥：`);
  for (const hit of hits.slice(0, 50)) console.error('  ' + hit);
  process.exit(1);
}
console.log(`密钥扫描通过：${files.length} 个文件，未发现疑似凭证`);
