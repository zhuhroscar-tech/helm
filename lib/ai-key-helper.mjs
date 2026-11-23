#!/usr/bin/env node
// Claude Code 的 apiKeyHelper：把 data/secrets/ai.json 里的 API key 打到标准输出。
// 由 lib/ai.mjs 的 claudeLaunch 通过 --settings 配置，参数是密钥文件路径。只输出密钥本身，别的什么都不打印。
import { readFileSync } from 'node:fs';

try {
  const j = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (typeof j.apiKey !== 'string' || !j.apiKey) throw new Error('no key');
  process.stdout.write(j.apiKey);
} catch {
  process.stderr.write('Helm: no API key saved. Open Helm and set up the AI connection again.\n');
  process.exit(1);
}
