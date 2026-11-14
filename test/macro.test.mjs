// FRED 宏观序列：解析、下载（假 fetch）、代码识别；HelmMacro 只给当时已公布的值
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseFredCsv, medianGapDays, fetchMacro, macroInCode } from '../lib/macro.mjs';

const daily = 'observation_date,DGS2\n2024-01-02,4.33\n2024-01-03,.\n2024-01-04,4.38\n2024-01-05,4.40\n';
const monthly = 'observation_date,UNRATE\n2024-01-01,3.7\n2024-02-01,3.9\n2024-03-01,3.8\n';
assert.deepEqual(parseFredCsv(daily), [['2024-01-02', 4.33], ['2024-01-04', 4.38], ['2024-01-05', 4.4]]);
assert.equal(medianGapDays(parseFredCsv(monthly)) > 25, true);
assert.deepEqual(macroInCode('a = HelmMacro("dgs2"); b = HelmMacro( \'BAMLH0A0HYM2\' )'), ['DGS2', 'BAMLH0A0HYM2']);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'helm-macro-'));
try {
  const fake = async (url) => {
    const id = new URL(url).searchParams.get('id');
    const body = { DGS2: daily, UNRATE: monthly }[id];
    return body ? { ok: true, status: 200, text: async () => body } : { ok: false, status: 404, text: async () => 'nope' };
  };
  const r = await fetchMacro(['dgs2', 'UNRATE', 'NOPE_X', 'bad id'], { dataDir: tmp, fetchImpl: fake });
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(by.DGS2.status, 'ok'); assert.equal(by.DGS2.rows, 3); assert.equal(by.DGS2.end, '2024-01-05');
  assert.equal(by.NOPE_X.status, 'error');
  assert.equal(by['BAD ID'].status, 'error');
  assert.ok(readFileSync(path.join(tmp, 'helm/macro/DGS2.csv'), 'utf8').startsWith('date,value\n2024-01-02,4.33'));
  // 20 小时内不重复下载
  let calls = 0;
  const r2 = await fetchMacro(['DGS2'], { dataDir: tmp, fetchImpl: async (...a) => { calls++; return fake(...a); } });
  assert.equal(r2.results[0].status, 'cached'); assert.equal(calls, 0);

  // HelmMacro：日度只用严格早于今天的值；月度默认滞后 45 天
  const py = existsSync('engine/.venv/bin/python') ? 'engine/.venv/bin/python' : 'python3';
  const out = execFileSync(py, ['-I', '-c', `
import sys; sys.path.insert(0, 'engine')
import helm_data as h
d = h.HelmMacro('DGS2'); u = h.HelmMacro('UNRATE')
print(d.lag, d.value('2024-01-02'), d.value('2024-01-03'), d.value('2024-01-05'), d.value('2024-01-06'), round(d.change('2024-01-06', 3), 2))
print(u.lag, u.value('2024-02-14'), u.value('2024-02-15'), u.value('2024-03-20'), u.as_of('2024-03-20')[0])
`], { env: { ...process.env, HELM_LEAN_DATA: tmp }, encoding: 'utf8' }).trim().split('\n');
  // 1/2 当天还看不到 1/2 的值；1/3 看到 1/2；1/5 看到 1/4（1/5 的值当天不可用）；1/6 看到 1/5；1/6 比 1/3 变化 4.40−4.33
  assert.equal(out[0], '1 None 4.33 4.38 4.4 0.07');
  // 1 月数据 2/15 才能用；3/20 只能看到 2 月（3/1 的数据要 4/15）
  assert.equal(out[1], '45 None 3.7 3.9 2024-02-01');
  console.log('macro: FRED 解析/下载/缓存、HelmMacro 无前视 ✓');
} finally { rmSync(tmp, { recursive: true, force: true }); }
