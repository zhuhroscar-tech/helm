// 波动率目标 HelmVol：node test/helm-vol.test.mjs
// 1) 跑 engine/test_helm_vol.py（无前视、预测比常数好、后备规则、仓位上限、回撤下降、速度）
// 2) 用 HelmVol 的策略能通过回测前的代码检查
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };

const py = existsSync(path.join(ROOT, 'engine/.venv/bin/python')) ? path.join(ROOT, 'engine/.venv/bin/python') : 'python3';
const r = spawnSync(py, ['-I', path.join(ROOT, 'engine', 'test_helm_vol.py')], { encoding: 'utf8' });
const out = `${r.stdout || ''}${r.stderr || ''}`;
check('engine/test_helm_vol.py 全部通过', r.status === 0 && /ALL PASSED/.test(out), out.split('\n').filter((l) => /FAIL|Error/.test(l)).join(' | '));

const E = await import('../lib/engine.mjs');
const code = `from AlgorithmImports import *
from helm_data import HelmVol

class VolTarget(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2006, 1, 1)
        self.set_end_date(2019, 12, 31)
        self.set_cash(100000)
        self.spy = self.add_equity("SPY", Resolution.DAILY).symbol
        self.set_benchmark("SPY")
        self.target_vol = self.get_parameter("target_vol", 0.10)
        self.vol = HelmVol(target=self.target_vol, max_leverage=1.0)
        self.prev = None

    def on_data(self, data):
        bar = data.bars.get(self.spy)
        if bar is None or bar.close <= 0:
            return
        if self.prev:
            self.vol.update(self.time, bar.close / self.prev - 1)
        self.prev = bar.close
        self.set_holdings(self.spy, 0.98 * self.vol.scale())
`;
const L = await E.lintSources([{ name: 'main.py', content: code }]);
check('用 HelmVol 的策略通过代码检查（没有 error）', !L.errors.length, JSON.stringify(L.errors.slice(0, 2)));
const bad = await E.lintSources([{ name: 'main.py', content: code.replace('self.vol.scale()', 'self.vol._r2[-1]') }]);
check('读 HelmVol 的下划线属性被拦（不能绕过 update / forecast）', bad.errors.length > 0);
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
