// 统计检验缓存测试：node test/validate-cache.test.mjs
// 缓存和不缓存的输出必须深度相等；尝试记录 / 项目声明的检验模式 / 验证期记录变了，缓存必须失效。
// 全程在临时目录里；样本回测从真实 projects/ 只读拷贝一份（没有已完成的回测就跳过）。
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-vcache-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');
const E = await import('../lib/engine.mjs');
const PD = process.env.HELM_PROJECTS_DIR;

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };

try {
  // 找一个真实的已完成回测当样本
  let sample = null;
  const real = path.join(ROOT, 'projects');
  if (existsSync(real)) {
    for (const p of await readdir(real)) {
      const root = path.join(real, p, 'backtests');
      if (!/^\d+$/.test(p) || !existsSync(root)) continue;
      for (const b of await readdir(root)) {
        try { const m = JSON.parse(await readFile(path.join(root, b, 'meta.json'), 'utf8')); if (/Completed/.test(m.status) && m.role !== 'benchmark' && existsSync(path.join(root, b, 'out', `${b}.json`))) { sample = { p, b, dir: path.join(root, b) }; break; } } catch { /* next */ }
      }
      if (sample) break;
    }
  }
  if (!sample) check('没有可用的样本回测，跳过', true);
  else {
    const pid = Number(sample.p); const bid = sample.b;
    const dst = path.join(PD, String(pid), 'backtests', bid);
    await mkdir(path.dirname(dst), { recursive: true });
    await cp(sample.dir, dst, { recursive: true, filter: (s) => !/sensitivity|\.tmp$/.test(s) });
    await writeFile(path.join(PD, String(pid), 'project.json'), JSON.stringify({ id: pid, name: 't' }));
    const args = { projectId: pid, backtestId: bid };
    const C = E._validateCache; C.clear();

    const u0 = await E.validateBacktestUncached(args);
    const c1 = await E.validateBacktest(args); // 未命中：算一遍
    const m1 = C.misses; const h1 = C.hits;
    const c2 = await E.validateBacktest(args); // 命中
    check('检验能算出来', u0.success && c1.success);
    check('缓存和不缓存的输出深度相等（未命中、命中两次都是）', isDeepStrictEqual(c1, u0) && isDeepStrictEqual(c2, u0));
    check('第二次是命中，没有重算', C.hits === h1 + 1 && C.misses === m1, `${h1}->${C.hits}`);
    c2.validation.pass = 'tampered'; c2.validation.gates.length = 0;
    check('调用方改返回值不会污染缓存', isDeepStrictEqual(await E.validateBacktest(args), u0));

    // 尝试记录里多了一次同一段历史的尝试 → 「试了几次」变了 → 缓存失效，结果和重算一致
    const trials = (await readFile(process.env.HELM_TRIALS_FILE, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const mine = trials.find((t) => t.backtestId === bid);
    check('第一次检验把这个回测登记进尝试记录', Boolean(mine));
    const before = await E.validateBacktest(args);
    const missBefore = C.misses;
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(process.env.HELM_TRIALS_FILE, `${trials.map((t) => JSON.stringify(t)).join('\n')}\n${JSON.stringify({ ...mine, backtestId: 'f'.repeat(32), sharpe: (mine.sharpe || 0) + 1.5 })}\n`);
    const after = await E.validateBacktest(args);
    const fresh = await E.validateBacktestUncached(args);
    check('往尝试记录里加一次尝试：缓存失效并重算', C.misses === missBefore + 1);
    check('重算后的结果和不缓存的一致，并且确实变了（尝试次数 / deflated Sharpe）', isDeepStrictEqual(after, fresh) && !isDeepStrictEqual(after, before), `${JSON.stringify(before.validation.trials ?? null)} -> ${JSON.stringify(after.validation.trials ?? null)}`);

    // 项目声明 validation 模式
    await E.validateBacktest(args); const m2 = C.misses;
    await writeFile(path.join(PD, String(pid), 'project.json'), JSON.stringify({ id: pid, name: 't', validation: 'risk-adjusted' }));
    const ra = await E.validateBacktest(args);
    check('项目声明 validation: risk-adjusted：缓存失效，结果带 gateMode', C.misses === m2 + 1 && ra.validation.gateMode === 'risk-adjusted' && isDeepStrictEqual(ra, await E.validateBacktestUncached(args)));

    // 验证期记录
    await E.validateBacktest(args); const m3 = C.misses;
    await writeFile(path.join(PD, String(pid), 'holdout_log.json'), JSON.stringify([{ backtestId: 'e'.repeat(32), at: new Date().toISOString() }]));
    await E.validateBacktest(args);
    check('验证期记录变了：缓存失效', C.misses === m3 + 1);

    // 失败的不缓存
    const bad = await E.validateBacktest({ projectId: pid, backtestId: 'abcdef0123' });
    check('失败结果不缓存', !bad.success && C.size() >= 1 && !(await E.validateBacktest({ projectId: pid, backtestId: 'abcdef0123' })).success);
  }
} catch (e) {
  console.log(`FAIL  测试异常：${e.stack || e}`); failed += 1;
} finally {
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
