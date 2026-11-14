// 落盘的三个基本动作，所有记录文件都走这里：
// - writeJsonAtomic：写临时文件 → fsync → rename。rename 只保证不会读到写了一半的文件；不先 fsync 的话，
//   断电后 rename 可能已经生效、内容却还没落盘，读到的是空文件。
// - appendLine：追加一行 JSON 到 .jsonl。追加前先看文件最后一个字节：上次崩溃留下了半行时先补一个换行，
//   不然这一行会接在半行后面，两条记录一起读不出来（尝试记录少一条 = 去膨胀夏普的次数少算）。
// - readJsonFile：文件不存在返回默认值；文件存在但解析不了（损坏）时也返回默认值，但在日志里说一声，不再悄悄当成“没有”。
import { open, readFile, rename } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

const warned = new Set();
export async function readJsonFile(file, fallback = null) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return fallback; }
  try { return JSON.parse(text); } catch (e) {
    if (!warned.has(file)) { warned.add(file); console.error(`[helm] 文件损坏，读不出来：${path.basename(path.dirname(file))}/${path.basename(file)}（${e.message}）`); }
    return fallback;
  }
}

export async function writeJsonAtomic(file, data, { space = 1 } = {}) {
  // 临时文件名每次都不同：同一个进程里并发写同一个文件时，共用一个临时文件会让后一个 rename 找不到文件
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(data, null, space));
    await fh.sync();
  } finally { await fh.close(); }
  await rename(tmp, file);
}

export async function appendLine(file, line) {
  const fh = await open(file, 'a+');
  try {
    const { size } = await fh.stat();
    let prefix = '';
    if (size > 0) {
      const b = Buffer.alloc(1);
      await fh.read(b, 0, 1, size - 1);
      if (b[0] !== 0x0a) prefix = '\n';
    }
    await fh.write(`${prefix}${String(line).replace(/\n+$/, '')}\n`);
    await fh.datasync();
  } finally { await fh.close(); }
}
