// qlib 择时过滤（市场宽度）：node test/timing.test.mjs
// 1) 跑 engine/qlib_research/test_qs_timing.py（宽度、无前视、时间序列检验、多重检验计数、HelmBreadth 只给前一天的值）
// 2) 用 HelmBreadth 的策略能通过回测前的代码检查，读下划线属性被拦
// 3) 数据指纹包含宽度文件（重算宽度后能看出数据变了）
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };

const py = existsSync(path.join(ROOT, 'engine/.venv/bin/python')) ? path.join(ROOT, 'engine/.venv/bin/python') : 'python3';
const tmpReg = await mkdtemp(path.join(os.tmpdir(), 'helm-timing-'));
const r = spawnSync(py, ['-I', path.join(ROOT, 'engine', 'qlib_research', 'test_qs_timing.py')], { encoding: 'utf8', env: { ...process.env, QS_TIMING_REGISTRY: path.join(tmpReg, 'reg.jsonl') }, timeout: 300000 });
const out = `${r.stdout || ''}${r.stderr || ''}`;
check('engine/qlib_research/test_qs_timing.py 全部通过', r.status === 0 && /全部通过/.test(out), out.split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 4).join(' | '));

const E = await import('../lib/engine.mjs');
const code = `from AlgorithmImports import *
from helm_data import HelmBreadth

class BreadthFilter(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2010, 1, 1)
        self.set_cash(100000)
        self.spy = self.add_equity("SPY", Resolution.DAILY).symbol
        self.agg = self.add_equity("AGG", Resolution.DAILY).symbol
        self.breadth = HelmBreadth("sp500")

    def on_data(self, data):
        b = self.breadth.value(self.time, "pct_above_200")
        if b is not None and b > 0.5:
            self.set_holdings(self.spy, 1.0, True)
        else:
            self.set_holdings(self.agg, 1.0, True)
`;
const L = await E.lintSources([{ name: 'main.py', content: code }]);
check('用 HelmBreadth 的策略通过代码检查', !L.errors.length, JSON.stringify(L.errors.slice(0, 2)));
const bad = await E.lintSources([{ name: 'main.py', content: code.replace('self.breadth.value(self.time, "pct_above_200")', 'self.breadth._rows[-1]["pct_above_200"]') }]);
check('读 HelmBreadth 的下划线属性被拦（不能看到未来的行）', bad.errors.length > 0);

const FP = await import('../lib/fingerprint.mjs');
const dataDir = path.join(tmpReg, 'Data');
await mkdir(path.join(dataDir, 'helm', 'breadth'), { recursive: true });
await writeFile(path.join(dataDir, 'helm', 'breadth', 'sp500.csv'), 'date,pct_above_200\n2020-01-02,0.5\n');
const inp = await FP.strategyInputs({ dataDir, code, baseTickers: ['SPY'] });
check('数据指纹包含宽度文件', inp.files.includes('helm/breadth/sp500.csv'), inp.files.join(','));
const inp2 = await FP.strategyInputs({ dataDir, code: code.replace('HelmBreadth("sp500")', 'HelmBreadth()'), baseTickers: ['SPY'] });
check('HelmBreadth() 默认 sp500 也记进指纹', inp2.files.includes('helm/breadth/sp500.csv'));

await rm(tmpReg, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
