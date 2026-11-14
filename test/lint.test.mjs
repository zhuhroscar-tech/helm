// 策略静态检查（engine/lint_strategy.py）测试：node test/lint.test.mjs
// 项目都建在临时目录里；真实 projects/ 只读，用来确认现有策略没有误报。
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_PROJECTS = path.join(ROOT, 'projects');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-lint-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');

const E = await import('../lib/engine.mjs');

let failed = 0;
let n = 0;
const check = (name, cond, extra = '') => {
  n += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};

const HEAD = `from AlgorithmImports import *
`;
// 一个干净的策略骨架；body 插在 initialize 末尾，extra 是额外的方法/顶层代码
const strat = ({ imports = '', body = '', methods = '', setup = true } = {}) => `${HEAD}${imports}

class T(QCAlgorithm):
    def initialize(self):
${setup ? `        self.set_start_date(2015, 1, 1)
        self.set_cash(100000)
        self.set_benchmark("SPY")
` : ''}        self.spy = self.add_equity("SPY", Resolution.DAILY).symbol
${body ? body.split('\n').map((l) => `        ${l}`).join('\n') : ''}

    def on_data(self, data):
        pass
${methods}`;

const lint = (content, more = []) => E.lintSources([{ name: 'main.py', content }, ...more]);
const codes = (arr) => arr.map((d) => d.code);
const has = (arr, code) => arr.some((d) => d.code === code);

/* ---------- 干净的代码 ---------- */
{
  const r = await lint(strat());
  check('干净策略：没有错误也没有警告', !r.errors.length && !r.warnings.length, JSON.stringify(r));

  for (const [k, code] of Object.entries(E.TEMPLATES)) {
    const t = await lint(code);
    check(`内置模板 ${k}：零错误`, !t.errors.length, JSON.stringify(t.errors));
    if (t.warnings.length) console.log(`      模板 ${k} 的警告：${t.warnings.map((w) => `${w.line}:${w.code}`).join(', ')}`);
  }

  const helm = await lint(strat({
    imports: 'from helm_data import HelmSignals, HelmUniverse\nimport numpy as np\nimport pandas as pd\nfrom datetime import timedelta',
    body: 'self.uni = HelmUniverse("sp500")\nfor t in self.uni.tickers():\n    self.add_equity(t, Resolution.DAILY)\nself.sig = HelmSignals("p1_x")',
    methods: `
    def rebalance(self):
        picks = self.sig.top(self.time, 10, allowed=self.uni.members(self.time))
        h = self.history(self.spy, 20, Resolution.DAILY)
        for t in picks:
            self.set_holdings(t, 0.09)
`,
  }));
  check('helm_data（HelmSignals / HelmUniverse）用法：通过', !helm.errors.length && !helm.warnings.length, JSON.stringify(helm));

  const local = await lint(strat({ imports: 'from utils import helper\nimport signals_lib' }), [
    { name: 'utils.py', content: 'def helper():\n    return 1\n' }, { name: 'signals_lib.py', content: 'X = 1\n' }]);
  check('导入项目里的本地模块：不报警告，辅助模块不要求 QCAlgorithm 类', !local.errors.length && !local.warnings.length, JSON.stringify(local));

  const branches = await lint(strat({ methods: `
    def rebalance(self):
        if self.time.month > 6:
            self.set_holdings("SPY", 0.98)
        else:
            self.set_holdings("TLT", 0.98)
` }));
  check('if/else 两个分支各自 0.98：不算超过 1.0', !has(branches.warnings, 'holdings-over-1'), JSON.stringify(branches.warnings));

  const seeded = await lint(strat({ imports: 'import random\nimport numpy as np', body: 'random.seed(7)\nnp.random.seed(7)\nself.x = random.random() + np.random.normal()' }));
  check('随机数固定了种子：不警告', !has(seeded.warnings, 'random-no-seed'), JSON.stringify(seeded.warnings));
}

/* ---------- errors：每条规则都会触发 ---------- */
{
  const mods = ['os', 'sys', 'subprocess', 'socket', 'shutil', 'ctypes', 'multiprocessing', 'threading', 'importlib',
    'pickle', 'requests', 'urllib', 'http', 'ftplib', 'smtplib', 'asyncio'];
  const missed = [];
  for (const m of mods) {
    const a = await lint(strat({ imports: `import ${m}` }));
    const b = await lint(strat({ imports: `from ${m === 'urllib' ? 'urllib.request' : m} import something` }));
    if (!has(a.errors, 'import-forbidden') || !has(b.errors, 'import-forbidden')) missed.push(m);
  }
  check(`禁止导入（import 和 from x import 两种写法，${mods.length} 个模块）`, !missed.length, missed.join(','));

  const imp = await lint(strat({ imports: 'import os.path as osp' }));
  check('禁止导入：行号正确', imp.errors.length === 1 && imp.errors[0].line === 2 && imp.errors[0].file === 'main.py', JSON.stringify(imp.errors));

  const calls = ['open("x.csv")', 'exec("1")', 'eval("1")', 'compile("1", "f", "exec")', '__import__("os")', 'globals()'];
  const missedC = [];
  for (const c of calls) {
    const r = await lint(strat({ body: `self.x = ${c}` }));
    if (!r.errors.some((e) => e.code === 'call-forbidden')) missedC.push(c);
  }
  check('禁止调用 open / exec / eval / compile / __import__ / globals', !missedC.length, missedC.join(' '));

  const sa = await lint(strat({ imports: 'import numpy as np', body: 'setattr(np, "mean", lambda x: 0)' }));
  check('禁止 setattr 修改模块', has(sa.errors, 'setattr-module'), JSON.stringify(sa.errors));
  // 绕过写法：不 import 直接用星号导入带进来的 os、别名、属性链、运行时拼出来的双下划线名字
  const bypass = [
    { body: "os.system('id')" },
    { imports: 'from helm_data import os as o', body: 'self.x = 1' },
    { imports: 'import pandas as pd', body: "pd.io.common.os.system('id')" },
    { imports: 'from pandas import read_csv', body: 'self.x = 1' },
    { imports: 'import pandas as pd', body: 'r = pd.read_csv' },
    { imports: 'import pandas as pd', body: "getattr(pd, 'read_csv')" },
    { body: 'e = eval' },
    { body: "n = '__class__'" },
    { body: "getattr(self, '__cl' + 'ass__')" },
    { body: 'vars()' },
    { imports: 'import clr', body: 'self.x = 1' },
    { imports: 'import zipfile', body: 'self.x = 1' },
    { body: "self.download('http://x')" },
  ];
  const slipped = [];
  for (const b of bypass) { const r = await lint(strat(b)); if (!r.errors.length) slipped.push(JSON.stringify(b)); }
  check('绕过写法（别名 / 属性链 / 拼接双下划线 / 星号导入带进来的 os）都是错误', !slipped.length, slipped.join(' '));
  const legit = [
    { body: 'open = 1.0' },
    { imports: 'import numpy as np', body: 'self.x = np.select([True], [1])' },
    { body: "self.y = getattr(self, 'fast_' + 'n', None)" },
  ];
  const wrongly = [];
  for (const b of legit) { const r = await lint(strat(b)); if (r.errors.length) wrongly.push(JSON.stringify(b) + ' → ' + JSON.stringify(r.errors)); }
  check('正常写法不误报（变量名 open、np.select、getattr 取自己的属性）', !wrongly.length, wrongly.join(' '));

  const saObj = await lint(strat({ body: 'setattr(self, "k", 3)' }));
  check('setattr 设置自己的属性：允许', !saObj.errors.length, JSON.stringify(saObj.errors));

  const dun = await lint(strat({ body: 'x = ().__class__.__bases__[0].__subclasses__()\ny = getattr(self, "__dict__")\nz = __builtins__' }));
  check('禁止双下划线属性（__class__ / __subclasses__ / getattr 字符串 / __builtins__）', dun.errors.filter((e) => e.code === 'dunder').length >= 5, codes(dun.errors).join(','));
  const okDun = await lint(strat({ methods: `
class Fee(FeeModel):
    def __init__(self, rate):
        super().__init__()
        self.rate = rate

    def name(self, e):
        return type(e).__name__
` }));
  check('__init__ / super().__init__() / type(e).__name__：允许', !okDun.errors.length, JSON.stringify(okDun.errors));

  const resMissed = [];
  for (const r of ['MINUTE', 'SECOND', 'TICK', 'HOUR', 'Minute']) {
    const x = await lint(strat({ body: `self.add_equity("QQQ", Resolution.${r})` }));
    if (!has(x.errors, 'resolution')) resMissed.push(r);
  }
  check('非日线 Resolution（MINUTE/SECOND/TICK/HOUR）是错误', !resMissed.length, resMissed.join(','));

  const uni1 = await lint(strat({ body: 'self.add_universe(self.coarse)', methods: '\n    def coarse(self, c):\n        return [x.symbol for x in c]\n' }));
  const uni2 = await lint(strat({ body: 'self.set_universe_selection(FineFundamentalUniverseSelectionModel(self.c, self.f))' }));
  check('LEAN add_universe / coarse / fine 选股是错误', has(uni1.errors, 'universe') && has(uni2.errors, 'universe'), `${codes(uni1.errors)} | ${codes(uni2.errors)}`);

  const io = await lint(strat({ imports: 'import pandas as pd', body: 'df = pd.read_csv("prices.csv")\ndf.to_csv("out.csv")' }));
  check('策略自己读写文件（pd.read_csv / to_csv）是错误', io.errors.filter((e) => e.code === 'file-io').length === 2, JSON.stringify(io.errors));

  const nocls = await lint(`${HEAD}\nclass T:\n    def initialize(self):\n        pass\n`);
  check('main.py 没有 QCAlgorithm 子类是错误', has(nocls.errors, 'no-algorithm'), JSON.stringify(nocls.errors));

  const syn = await lint(`${HEAD}\nclass T(QCAlgorithm):\n    def initialize(self)\n        pass\n`);
  check('语法错误照样报出（带行号）', syn.errors.length === 1 && syn.errors[0].code === 'syntax' && syn.errors[0].line === 4, JSON.stringify(syn.errors));
  const ret = await lint(`${HEAD}\nreturn 1\nclass T(QCAlgorithm):\n    pass\n`);
  check('编译期错误（函数外的 return）也能查出', has(ret.errors, 'syntax'), JSON.stringify(ret.errors));
}

/* ---------- warnings：每条规则都会触发 ---------- */
{
  const unl = await lint(strat({ imports: 'import sklearn\nfrom statsmodels.api import OLS' }));
  check('清单外的导入是警告', unl.warnings.filter((w) => w.code === 'import-unlisted').length === 2 && !unl.errors.length, JSON.stringify(unl));

  const nosetup = await lint(strat({ setup: false }));
  check('缺 set_start_date / set_cash / set_benchmark 各一条警告',
    ['missing-set-start-date', 'missing-set-cash', 'missing-set-benchmark'].every((c) => has(nosetup.warnings, c)) && !nosetup.errors.length, codes(nosetup.warnings).join(','));

  const qty = await lint(strat({ body: 'self.market_order(self.spy, 100)\nself.limit_order(self.spy, -50, 400.0)\nself.market_order(self.spy, quantity=10)\nself.market_order(self.spy, self.calc())' }));
  check('market_order / limit_order 写死股数是警告（变量数量不报）', qty.warnings.filter((w) => w.code === 'fixed-quantity').length === 3, JSON.stringify(qty.warnings));

  const lev = await lint(strat({ methods: `
    def rebalance(self):
        self.set_holdings("SPY", 0.6)
        self.set_holdings("TLT", 0.6)
` }));
  check('同一个方法里 set_holdings 权重加起来 > 1.0 是警告', has(lev.warnings, 'holdings-over-1'), JSON.stringify(lev.warnings));

  const rnd = await lint(strat({ imports: 'import random', body: 'self.pick = random.choice(["SPY", "QQQ"])' }));
  const rndNp = await lint(strat({ imports: 'import numpy as np', body: 'self.noise = np.random.normal(0, 1)' }));
  check('用随机数没有种子是警告（random 和 np.random）', has(rnd.warnings, 'random-no-seed') && has(rndNp.warnings, 'random-no-seed'), `${codes(rnd.warnings)} | ${codes(rndNp.warnings)}`);
}

/* ---------- compileProject：状态和日志格式 ---------- */
{
  const p = await E.createProject({ name: 'Lint Test', code: strat({ imports: 'import os\nimport sklearn', setup: false }) });
  const pid = p.projects[0].projectId;
  const c = await E.compileProject({ projectId: pid });
  const logs = c.logs.join('\n');
  const iFix = logs.indexOf('必须修复'); const iWarn = logs.indexOf('警告');
  check('有错误时 state = BuildError，日志先「必须修复」后「警告」，带行号',
    c.success && c.state === 'BuildError' && iFix === 0 && iWarn > iFix && /main\.py 第 2 行 \[import-forbidden\]/.test(logs) && c.lint.errors.length === 1, logs.slice(0, 160));

  const bt = await E.createBacktest({ projectId: pid, name: 'x', role: 'debug', period: 'dev' });
  check('createBacktest 先跑检查：有错误时不启动回测', bt.success && bt.backtest === null && bt.compile.state === 'BuildError');

  await E.writeProjectFile({ projectId: pid, name: 'main.py', content: strat({ imports: 'import sklearn' }) });
  const c2 = await E.compileProject({ projectId: pid });
  check('只有警告时 state = BuildSuccess，日志里有警告', c2.state === 'BuildSuccess' && c2.logs[0].startsWith('警告') && c2.lint.warnings.length === 1, c2.logs.join(' | '));

  await E.writeProjectFile({ projectId: pid, name: 'main.py', content: strat() });
  await E.writeProjectFile({ projectId: pid, name: 'benchmark.py', content: `${HEAD}\nclass B:\n    pass\n` });
  const c3 = await E.compileProject({ projectId: pid, entry: 'benchmark.py' });
  check('入口文件 benchmark.py 也要求 QCAlgorithm 子类', c3.state === 'BuildError' && c3.lint.errors.some((e) => e.file === 'benchmark.py' && e.code === 'no-algorithm'), c3.logs.join(' | '));
  const c4 = await E.compileProject({ projectId: pid });
  check('不作为入口时 benchmark.py 当辅助模块，不要求类', c4.state === 'BuildSuccess', c4.logs.join(' | '));
}

/* ---------- 真实项目（只读）：零错误 ---------- */
{
  const dirs = (await readdir(REAL_PROJECTS).catch(() => [])).filter((d) => /^\d+$/.test(d));
  let nFiles = 0; const errs = []; const warns = [];
  for (const d of dirs) {
    const names = (await readdir(path.join(REAL_PROJECTS, d))).filter((f) => f.endsWith('.py'));
    const files = await Promise.all(names.map(async (name) => ({ name, content: await readFile(path.join(REAL_PROJECTS, d, name), 'utf8') })));
    nFiles += files.length;
    const r = await E.lintSources(files);
    errs.push(...r.errors.map((e) => `${d}/${e.file}:${e.line} ${e.code}`));
    warns.push(...r.warnings.map((w) => `${d}/${w.file}:${w.line} ${w.code}`));
  }
  check(`真实项目 projects/*/*.py（${nFiles} 个文件）：零错误`, !errs.length, errs.join('; '));
  console.log(`      真实项目的警告：${warns.length ? warns.join('; ') : '无'}`);
}

/* ---------- 性能：500 行文件 ---------- */
{
  const method = (i) => `
    def step_${i}(self):
        h = self.history(self.spy, 20, Resolution.DAILY)
        if h is None or len(h) == 0:
            return
        w = min(0.98, max(0.0, float(h["close"].pct_change().mean()) * ${i}))
        self.set_holdings(self.spy, w)
        self.debug(f"step ${i} {w:.3f}")
`;
  let big = strat({ imports: 'import numpy as np\nimport pandas as pd' });
  for (let i = 0; big.split('\n').length < 500; i++) big += method(i);
  const lines = big.split('\n').length;
  const t0 = performance.now();
  const r = await lint(big);
  const ms = performance.now() - t0;
  check(`500 行文件的检查耗时 < 1 秒（${lines} 行）`, ms < 1000 && !r.errors.length, `${ms.toFixed(0)} ms`);
}

/* ---------- 自建数据集读取器 HelmDataset ---------- */
{
  const ok = await lint(strat({
    imports: 'from helm_data import HelmDataset',
    body: 'self.ds = HelmDataset("sp500_adds")\nfor t in self.ds.tickers():\n    self.add_equity(t, Resolution.DAILY)',
    methods: `
    def rebalance(self):
        for t in self.ds.symbols_with("sector", "Tech", self.time):
            self.set_holdings(t, 0.1)
        ev = self.ds.events_until(self.time, "AAPL")
        v = self.ds.value("AAPL", "sector", self.time)
`,
  }));
  check('HelmDataset：from helm_data import 通过，没有错误也没有警告', !ok.errors.length && !ok.warnings.length, JSON.stringify(ok));
  const star = await lint(strat({ imports: 'from helm_data import *', body: 'self.ds = HelmDataset("x_y")' }));
  check('from helm_data import * 用 HelmDataset：通过', !star.errors.length, JSON.stringify(star.errors));
  const bad1 = await lint(strat({ imports: 'from helm_data import HelmDataset, os' }));
  check('helm_data 里借 os：仍然拦下', has(bad1.errors, 'import-forbidden'), JSON.stringify(bad1.errors));
  const bad2 = await lint(strat({ imports: 'import helm_data as h', body: 'self.f = h.os.popen("ls")' }));
  check('helm_data.os 仍然拦下（读取器不放宽沙盒）', bad2.errors.length > 0, JSON.stringify(bad2.errors));
  const bad3 = await lint(strat({ imports: 'from helm_data import HelmDataset', body: 'self.f = open("data.csv")' }));
  check('用了 HelmDataset 仍然不能自己 open 文件', has(bad3.errors, 'call-forbidden'), JSON.stringify(bad3.errors));
}

/* ---------- 自建数据集读取器 HelmDataset ---------- */
{
  const ok = await lint(strat({
    imports: 'from helm_data import HelmDataset',
    body: 'self.ds = HelmDataset("sp500_adds")\nfor t in self.ds.tickers():\n    self.add_equity(t, Resolution.DAILY)',
    methods: `
    def rebalance(self):
        for t in self.ds.symbols_with("sector", "Tech", self.time):
            self.set_holdings(t, 0.1)
        ev = self.ds.events_until(self.time, "AAPL")
        v = self.ds.value("AAPL", "sector", self.time)
`,
  }));
  check('HelmDataset：from helm_data import 通过，没有错误也没有警告', !ok.errors.length && !ok.warnings.length, JSON.stringify(ok));
  const star = await lint(strat({ imports: 'from helm_data import *', body: 'self.ds = HelmDataset("x_y")' }));
  check('from helm_data import * 用 HelmDataset：通过', !star.errors.length, JSON.stringify(star.errors));
  const bad1 = await lint(strat({ imports: 'from helm_data import HelmDataset, os' }));
  check('helm_data 里借 os：仍然拦下', has(bad1.errors, 'import-forbidden'), JSON.stringify(bad1.errors));
  const bad2 = await lint(strat({ imports: 'import helm_data as h', body: 'self.f = h.os.popen("ls")' }));
  check('helm_data.os 仍然拦下（读取器不放宽沙盒）', bad2.errors.length > 0, JSON.stringify(bad2.errors));
  const bad3 = await lint(strat({ imports: 'from helm_data import HelmDataset', body: 'self.f = open("data.csv")' }));
  check('用了 HelmDataset 仍然不能自己 open 文件', has(bad3.errors, 'call-forbidden'), JSON.stringify(bad3.errors));
}

/* ---------- get_parameter（参数敏感性要用）不能被误报 ---------- */
{
  const r = await lint(strat({ body: 'self.fast = int(self.get_parameter("fast", 20))\nself.thr = self.GetParameter("thr", 0.5)\nself.get_parameter("w", 10)' }));
  check('self.get_parameter / GetParameter 不会被检查拦下', !r.errors.length && !r.warnings.length, JSON.stringify(r));
}

await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed}/${n} 项失败` : `\n全部通过（${n} 项）`);
process.exit(failed ? 1 : 0);
