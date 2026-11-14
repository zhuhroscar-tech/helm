// LEAN 沙盒测试：node test/sandbox.test.mjs（真实 LEAN，约半分钟）
// agent 写的策略在 LEAN 里运行。这里直接调用 runLean（绕过 compile 的静态检查，测的是第二道防线：macOS 沙盒 + 环境变量白名单），
// 让一个探针策略去尝试联网、读仓库 .env、列 ~/.ssh、写 data/、读别的项目和尝试记录、看环境变量，
// 全部应该失败；同一次运行里正常的 SPY 日线交易照常出结果。另外跑一次用 HelmUniverse / HelmSignals 的真实项目副本。
import { mkdtemp, rm, mkdir, writeFile, readFile, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-sandbox-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
process.env.HELM_TRIALS_FILE = path.join(TMP, 'trials.jsonl');
process.env.HELM_ALPACA_FILE = path.join(TMP, 'secrets', 'alpaca.json');
// 这些不应该传进 LEAN
process.env.HELM_SANDBOX_CANARY = 'canary-value';
process.env.ALPACA_API_KEY_ID = 'dummy-not-a-key';
process.env.HELM_TOKEN = 'token-not-real';
process.env.HELM_URL = 'http://127.0.0.1:4377';

const E = await import('../lib/engine.mjs');
const ROOT = E.ROOT;

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};

const status = await E.engineStatus();
if (!status.ok) {
  check('本地 LEAN 引擎就绪', false, `缺少 ${(status.missing || []).join(', ')}`);
  process.exit(1);
}

// 本机的假服务：探针连它，不应该收到任何请求（证明 127.0.0.1 也连不上）
let hits = 0;
const srv = http.createServer((req, res) => { hits += 1; res.end('ok'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

// 准备被拦的目标：仓库 .env（不存在就在另一个应被拦的地方放一个假文件）、别的项目、尝试记录、密钥
const envFile = existsSync(path.join(ROOT, '.env')) ? path.join(ROOT, '.env') : null;
const dummyEnv = path.join(os.homedir(), `.helm-sandbox-dummy-${process.pid}`);
if (!envFile) await writeFile(dummyEnv, 'DUMMY=1\n');
const denyRead = envFile || dummyEnv;
await mkdir(path.join(TMP, 'projects', '1001'), { recursive: true });
await writeFile(path.join(TMP, 'projects', '1001', 'main.py'), '# other project\n');
await writeFile(process.env.HELM_TRIALS_FILE, '{"x":1}\n');
await mkdir(path.dirname(process.env.HELM_ALPACA_FILE), { recursive: true });
await writeFile(process.env.HELM_ALPACA_FILE, '{"secret":"sandbox-secret"}');
const tag = `${process.pid}-${Date.now()}`;
const writeTargets = {
  data: path.join(ROOT, 'data', `sandbox-probe-${tag}.txt`),
  engine: path.join(ROOT, 'engine', 'Lean', 'Data', `sandbox-probe-${tag}.txt`),
  home: path.join(os.homedir(), `sandbox-probe-${tag}.txt`),
  tmproot: path.join(os.tmpdir(), `sandbox-probe-${tag}.txt`),
};

const probe = `from AlgorithmImports import *
import os, tempfile, urllib.request

def _try(algo, name, fn):
    try:
        r = fn()
        algo.debug("PROBE %s=OPEN:%s" % (name, str(r)[:60]))
    except Exception as e:
        algo.debug("PROBE %s=BLOCKED:%s" % (name, type(e).__name__))

def _w(p):
    with open(p, "w") as f:
        f.write("x")
    return "written"

class Probe(QCAlgorithm):
    def initialize(self):
        self.set_start_date(2024, 1, 2)
        self.set_end_date(2024, 3, 1)
        self.set_cash(100000)
        self.spy = self.add_equity("SPY", Resolution.DAILY).symbol
        _try(self, "helm4377", lambda: urllib.request.urlopen("http://127.0.0.1:4377/api/engine/status", timeout=3).status)
        _try(self, "localport", lambda: urllib.request.urlopen("http://127.0.0.1:${port}/", timeout=3).status)
        _try(self, "https", lambda: urllib.request.urlopen("https://example.com/", timeout=5).status)
        # 只看能不能打开，绝不读内容
        _try(self, "envfile", lambda: (open(${JSON.stringify(denyRead)}, "rb").close(), "opened")[1])
        self.debug("PROBE envexists=%s" % os.path.exists(${JSON.stringify(denyRead)}))
        _try(self, "ssh", lambda: len(os.listdir(os.path.expanduser("~/.ssh"))))
        _try(self, "homelist", lambda: len(os.listdir(os.path.expanduser("~"))))
        _try(self, "otherproject", lambda: open(${JSON.stringify(path.join(TMP, 'projects', '1001', 'main.py'))}).read())
        _try(self, "trials", lambda: open(${JSON.stringify(process.env.HELM_TRIALS_FILE)}).read())
        _try(self, "secret", lambda: open(${JSON.stringify(process.env.HELM_ALPACA_FILE)}).read())
${Object.entries(writeTargets).map(([k, p]) => `        _try(self, "write_${k}", lambda: _w(${JSON.stringify(p)}))`).join('\n')}
        _try(self, "write_tmp", lambda: _w(os.path.join(tempfile.gettempdir(), "ok.txt")))
        self.debug("PROBE envkeys=" + ",".join(sorted(os.environ.keys())))

    def on_data(self, data):
        if not self.portfolio.invested:
            self.set_holdings(self.spy, 0.98)
`;

const dir = path.join(TMP, 'projects', '1002', 'backtests', 'probe');
await mkdir(path.join(dir, 'code'), { recursive: true });
await writeFile(path.join(dir, 'code', 'main.py'), probe);
await E.fetchData(['SPY']);
const lr = await E.runLean({ algorithmFile: path.join(dir, 'code', 'main.py'), className: 'Probe', outDir: path.join(dir, 'out'), id: 'probe' });
let log = '';
try { log = await readFile(path.join(dir, 'out', 'probe-log.txt'), 'utf8'); } catch { /* none */ }
const got = {};
for (const m of log.matchAll(/PROBE (\w+)=(.*)/g)) got[m[1]] = m[2].trim();
const blocked = (k) => /^BLOCKED:/.test(got[k] || '');

check('探针策略跑完并有结果', Boolean(lr.result) && lr.result.state && lr.result.state.Status !== 'RuntimeError', lr.error || '');
check('正常 SPY 交易出结果', lr.result && Number(String(lr.result.statistics?.['Total Orders'] || '0')) >= 1, `orders=${lr.result && lr.result.statistics?.['Total Orders']}`);
check('连不上本机 Helm 接口 127.0.0.1:4377', blocked('helm4377'), got.helm4377);
check('连不上本机其他端口（假服务没收到请求）', blocked('localport') && hits === 0, `${got.localport} hits=${hits}`);
check('连不上外网 https://example.com', blocked('https'), got.https);
check(`打不开 ${envFile ? '仓库 .env' : '家目录下的假 .env'}`, blocked('envfile') && got.envexists === 'False', `${got.envfile} exists=${got.envexists}`);
check('列不出 ~/.ssh', blocked('ssh'), got.ssh);
check('列不出 $HOME', blocked('homelist'), got.homelist);
check('读不到别的项目', blocked('otherproject'), got.otherproject);
check('读不到尝试记录', blocked('trials'), got.trials);
check('读不到 Alpaca 密钥', blocked('secret') && !log.includes('sandbox-secret'), got.secret);
for (const [k, p] of Object.entries(writeTargets)) {
  check(`写不进 ${k}（${path.dirname(p)}）`, blocked(`write_${k}`) && !existsSync(p), got[`write_${k}`]);
  await rm(p, { force: true });
}
check('私有临时目录可写', got.write_tmp === 'OPEN:written', got.write_tmp);
const keys = (got.envkeys || '').split(',').filter(Boolean);
const allowed = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z]+|TZ|TMPDIR|DOTNET_[A-Za-z0-9_]+|PYTHONNET_PYDLL|PYTHONHOME|PYTHONPATH|PYTHONDONTWRITEBYTECODE|MPLCONFIGDIR|__CF_USER_TEXT_ENCODING|PYTHONIOENCODING|LC_CTYPE)$/;
const extra = keys.filter((k) => !allowed.test(k));
check('环境变量只有白名单（没有 HELM_* / ALPACA_* / API key）', keys.length > 0 && !extra.length && !log.includes('canary-value') && !log.includes('dummy-not-a-key'), extra.join(',') || `${keys.length} keys`);
check('HELM_TOKEN / HELM_URL 和任何 HELM_* 变量都不在 LEAN 里', !keys.some((k) => /^HELM_/.test(k)) && !log.includes('token-not-real'), keys.filter((k) => /^HELM_/.test(k)).join(',') || 'none');
if (!envFile) await rm(dummyEnv, { force: true });
srv.close();

// 真实项目副本：用 HelmUniverse / HelmSignals 的策略（读 engine/Lean/Data/helm/*）在沙盒里照常运行
const src = path.join(ROOT, 'projects');
let helmProj = null;
for (const d of existsSync(src) ? await readdir(src) : []) {
  try { if (/HelmUniverse|HelmSignals/.test(await readFile(path.join(src, d, 'main.py'), 'utf8'))) { helmProj = d; break; } } catch { /* skip */ }
}
if (!helmProj) {
  console.log('SKIP  没有用 HelmUniverse 的项目可以复制');
} else {
  const hdir = path.join(TMP, 'projects', helmProj, 'backtests', 'helm');
  await mkdir(path.join(hdir, 'code'), { recursive: true });
  for (const f of (await readdir(path.join(src, helmProj))).filter((f) => f.endsWith('.py'))) await cp(path.join(src, helmProj, f), path.join(hdir, 'code', f));
  // 只跑一小段（几个月），够证明数据读得到
  let code = await readFile(path.join(hdir, 'code', 'main.py'), 'utf8');
  code = code.replace(/self\.set_start_date\([^)]*\)/, 'self.set_start_date(2023, 1, 3)').replace(/self\.set_end_date\([^)]*\)/, 'self.set_end_date(2023, 4, 1)');
  await writeFile(path.join(hdir, 'code', 'main.py'), code);
  const t0 = Date.now();
  const hr = await E.runLean({ algorithmFile: path.join(hdir, 'code', 'main.py'), className: E.findAlgorithmClass(code), outDir: path.join(hdir, 'out'), id: 'helm' });
  const st = hr.result && hr.result.state;
  check(`HelmUniverse 项目 ${helmProj} 在沙盒里照常回测`, Boolean(hr.result) && st.Status !== 'RuntimeError' && !st.RuntimeError,
    hr.error || (st && st.RuntimeError) || `orders=${hr.result.statistics?.['Total Orders']} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
