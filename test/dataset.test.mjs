// 自建数据集：node test/dataset.test.mjs
// 校验 / 保存 / 列表 / 读取 / 升版本、MCP 工具往返、Python 读取器的「当天公开的行当天看不到」、
// 指纹包含数据集版本。全程用临时目录，不碰真实 LEAN 数据。
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-ds-'));
const DATA = path.join(TMP, 'Data');
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const D = await import('../lib/datasets.mjs');
const F = await import('../lib/fingerprint.mjs');

const SRC = [{ url: 'https://example.com/a', title: '公告 A', retrieved_at: '2026-11-01' }, { url: 'https://example.org/b', title: '公告 B', retrieved_at: '2026-11-02' }];
const COLS_EV = ['available_date', 'symbol', 'event', 'source'];
const COLS_EVV = ['available_date', 'symbol', 'event', 'value', 'source'];
const COLS_AT = ['available_date', 'symbol', 'field', 'value', 'source'];
const COLS_TS = ['available_date', 'date', 'value', 'source'];
const ev = (extra = {}) => ({
  name: 'adds_demo', description: '示例：指数调入公告', kind: 'events', columns: COLS_EV, sources: SRC,
  rows: [
    { available_date: '2024-03-01', symbol: 'AAPL', event: 'index_add', source: 0 },
    { available_date: '2024-06-10', symbol: 'MSFT', event: 'index_add', source: 1 },
    { available_date: '2024-06-10', symbol: 'AAPL', event: 'index_remove', source: 'https://example.com/a' },
  ], ...extra,
});
const attr = (rows, extra = {}) => ev({ kind: 'attributes', columns: COLS_AT, rows, ...extra });
const rejects = async (label, input, re) => {
  const r = await D.saveDataset(input, { dataDir: DATA });
  check(`拒绝：${label}`, r.success === false && r.errors.length > 0 && (!re || re.test(r.errors.join('\n'))), r.errors && r.errors.join(' | ').slice(0, 140));
};
const withRows = (rows, extra = {}) => ev({ rows, ...extra });

/* ---------- 校验 ---------- */
await rejects('缺 available_date', withRows([{ symbol: 'AAPL', event: 'x', source: 0 }]), /第 1 行.*available_date/);
await rejects('日期格式不对', withRows([{ available_date: '2024/03/01', symbol: 'AAPL', event: 'x', source: 0 }]), /YYYY-MM-DD/);
await rejects('不存在的日期', withRows([{ available_date: '2024-02-31', symbol: 'AAPL', event: 'x', source: 0 }]), /有效/);
await rejects('未来的公开日期', withRows([{ available_date: '2999-01-01', symbol: 'AAPL', event: 'x', source: 0 }]), /未来/);
await rejects('source 序号越界', withRows([{ available_date: '2024-03-01', symbol: 'AAPL', event: 'x', source: 5 }]), /source/);
await rejects('缺 source', withRows([{ available_date: '2024-03-01', symbol: 'AAPL', event: 'x' }]), /source/);
await rejects('value 不是有限数字（字符串 NaN）', withRows([{ available_date: '2024-03-01', symbol: 'AAPL', event: 'x', value: 'NaN', source: 0 }], { columns: COLS_EVV }), /有限/);
await rejects('value 不是有限数字（Infinity）', withRows([{ available_date: '2024-03-01', symbol: 'AAPL', event: 'x', value: Infinity, source: 0 }], { columns: COLS_EVV }), /有限/);
await rejects('重复行', withRows([{ available_date: '2024-03-01', symbol: 'AAPL', event: 'x', source: 0 }, { available_date: '2024-03-01', symbol: 'aapl', event: 'x', source: 1 }]), /重复/);
await rejects('坏代码', withRows([{ available_date: '2024-03-01', symbol: 'not a ticker', event: 'x', source: 0 }]), /symbol/);
await rejects('名字不合规（大写）', ev({ name: 'Bad-Name' }), /name/);
await rejects('名字太短', ev({ name: 'a' }), /name/);
await rejects('缺来源', ev({ sources: [] }), /sources/);
await rejects('来源不是 http(s)', ev({ sources: [{ url: 'javascript:alert(1)', title: 'x', retrieved_at: '2026-11-01' }] }), /http/);
await rejects('列名缺必填列', ev({ columns: ['available_date', 'symbol', 'source'] }), /event/);
await rejects('列名不支持', ev({ columns: [...COLS_EV, 'extra'] }), /不支持/);
await rejects('attributes 缺 value', attr([{ available_date: '2024-01-02', symbol: 'AAPL', field: 'sector', source: 0 }]), /value/);
await rejects('attributes 缺 symbol', attr([{ available_date: '2024-01-02', field: 'sector', value: 'x', source: 0 }]), /symbol/);
await rejects('timeseries 的 date 晚于 available_date', ev({ kind: 'timeseries', columns: COLS_TS, rows: [{ available_date: '2024-01-02', date: '2024-02-01', value: 1, source: 0 }] }), /晚于/);
await rejects('timeseries value 不是数字', ev({ kind: 'timeseries', columns: COLS_TS, rows: [{ available_date: '2024-02-02', date: '2024-02-01', value: 'abc', source: 0 }] }), /数字/);
{
  const rows = Array.from({ length: D.MAX_ROWS + 1 }, (_, i) => ({ available_date: '2024-01-02', symbol: 'AAPL', event: `e${i}`, source: 0 }));
  await rejects('超过 50,000 行', withRows(rows), /50000/);
  const big = Array.from({ length: 40000 }, (_, i) => ({ available_date: '2024-01-02', symbol: 'AAPL', event: `${'x'.repeat(110)}${i}`, source: 0 }));
  await rejects('超过 5 MB', withRows(big), /5 MB/);
  const many = withRows(Array.from({ length: 30 }, () => ({ symbol: 'AAPL', event: 'x', source: 0 })));
  const r = await D.saveDataset(many, { dataDir: DATA });
  check('错误行只列前几行，不刷屏', r.errors.length <= 12, String(r.errors.length));
}
// 敏感特征
await rejects('敏感：名字（autism）', ev({ name: 'autism_execs' }), /敏感/);
await rejects('敏感：说明（中文）', ev({ description: '高管的自闭症名单' }), /敏感.*代理指标/);
await rejects('敏感：说明（disability）', ev({ description: 'CEOs with a disability' }), /敏感/);
await rejects('敏感：field 的值（宗教）', attr([{ available_date: '2024-01-02', symbol: 'AAPL', field: '宗教信仰', value: 'x', source: 0 }]), /敏感/);
await rejects('敏感：field（sexual orientation）', attr([{ available_date: '2024-01-02', symbol: 'AAPL', field: 'sexual orientation', value: 'x', source: 0 }]), /敏感/);
await rejects('敏感：列名', ev({ kind: 'attributes', columns: [...COLS_AT, 'health condition'], rows: [] }), /敏感/);
await rejects('敏感：event（diagnosis）', withRows([{ available_date: '2024-01-02', symbol: 'AAPL', event: 'CEO diagnosis', source: 0 }]), /敏感/);
check('失败的保存不留任何文件', (await D.listDatasets({ dataDir: DATA })).datasets.length === 0);
{
  const r = await D.saveDataset(ev({ name: 'dx_companies', description: '诊断设备公司（diagnostics）名单，公司层面' }), { dataDir: DATA });
  check('公司层面的 diagnostics 不误伤', r.success === true, JSON.stringify(r.errors));
}

/* ---------- 保存 / 列表 / 读取 / 升版本 ---------- */
const r1 = await D.saveDataset(ev(), { dataDir: DATA });
check('保存成功，v1，provenance=web', r1.success && r1.meta.version === 1 && r1.meta.provenance === 'web' && r1.meta.rows === 3 && r1.meta.symbols === 2, JSON.stringify(r1.meta || r1.errors).slice(0, 200));
check('URL 形式的 source 被换成序号', (await readFile(path.join(DATA, 'helm/custom/adds_demo.csv'), 'utf8')).trim().split('\n').slice(1).every((l) => /,[01]$/.test(l)));
check('.csv 和 .meta.json 都在 helm/custom/', (await readFile(path.join(DATA, 'helm/custom/adds_demo.meta.json'), 'utf8')).includes('"hash"'));
const l1 = await D.listDatasets({ dataDir: DATA });
const m1 = l1.datasets.find((m) => m.name === 'adds_demo');
check('list：行数、代码数、日期范围、来源数', m1 && m1.rows === 3 && m1.symbols === 2 && m1.firstAvailable === '2024-03-01' && m1.lastAvailable === '2024-06-10' && m1.sources.length === 2);
const rd = await D.readDataset({ dataDir: DATA, name: 'adds_demo', start: 1, limit: 1 });
check('read：分页', rd.success && rd.total === 3 && rd.rows.length === 1 && rd.rows[0].symbol === 'MSFT', JSON.stringify(rd.rows));
check('read：不存在 / 非法名字', (await D.readDataset({ dataDir: DATA, name: 'nope_x' })).success === false && (await D.readDataset({ dataDir: DATA, name: '../x' })).success === false);
const r2 = await D.saveDataset(ev({ rows: [...ev().rows, { available_date: '2024-07-01', symbol: 'NVDA', event: 'index_add', source: 0 }] }), { dataDir: DATA });
check('同名再存：替换并升到 v2，created 不变，hash 变了', r2.success && r2.meta.version === 2 && r2.replaced && r2.meta.created === r1.meta.created && r2.meta.hash !== r1.meta.hash && r2.meta.rows === 4);
const r3 = await D.saveDataset(ev({ rows: [...ev().rows, { available_date: '2024-07-01', symbol: 'NVDA', event: 'index_add', source: 0 }] }), { dataDir: DATA });
check('内容相同再存一次：v3', r3.success && r3.meta.version === 3 && r3.meta.hash === r2.meta.hash);
const sa = await D.saveDataset(attr([
  { available_date: '2024-01-10', symbol: 'AAPL', field: 'sector', value: 'Tech', source: 0 }, { available_date: '2024-09-03', symbol: 'AAPL', field: 'sector', value: 'Consumer, Tech "x"', source: 0 },
  { available_date: '2024-01-10', symbol: 'XOM', field: 'sector', value: 'Energy', source: 1 }, { available_date: '2024-01-10', symbol: 'AAPL', field: 'beta', value: 1.25, source: 1 }],
{ name: 'sector_attr', description: '行业属性（变化过）', notes: '缺 2019 年之前' }), { dataDir: DATA });
check('attributes 保存成功（值里带逗号和引号）', sa.success, JSON.stringify(sa.errors));
const ts = await D.saveDataset(ev({ name: 'ts_demo', description: '时间序列', kind: 'timeseries', columns: COLS_TS,
  rows: [{ available_date: '2024-02-05', date: '2024-02-01', value: 10, source: 0 }, { available_date: '2024-03-06', date: '2024-03-01', value: 12.5, source: 0 }] }), { dataDir: DATA });
check('timeseries 保存成功', ts.success, JSON.stringify(ts.errors));

/* ---------- Python 读取器：点在时间上的可见性 ---------- */
const py = (code) => execFileSync('python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'engine'))})\nimport helm_data as h\n${code}`], { env: { ...process.env, HELM_LEAN_DATA: DATA }, encoding: 'utf8' }).trim();
{
  const out = py(`
d = h.HelmDataset('adds_demo')
print(len(d.events_until('2024-03-01')), len(d.events_until('2024-03-02')), len(d.events_until('2024-06-10')), len(d.events_until('2024-06-11')))
print([e['symbol'] for e in d.events_until('2024-12-31', 'AAPL')], [e['event'] for e in d.events_until('2024-12-31', 'aapl')], len(d.events_until('2024-12-31', 'TSLA')))
print(d.last_available_date, d.tickers())
import datetime
print(len(d.events_until(datetime.datetime(2024, 3, 1, 15, 0))), len(d.events_until(datetime.datetime(2024, 3, 2, 0, 0))))
print(all(e['available_date'] < '2024-06-10' for e in d.events_until('2024-06-10')))
`).split('\n');
  check('当天公开的行当天看不到，第二天才看到', out[0] === '0 1 1 3', out[0]);
  check('按代码过滤（大小写不敏感），没有的代码返回空', out[1] === "['AAPL', 'AAPL'] ['index_add', 'index_remove'] 0", out[1]);
  check('last_available_date 和 tickers()', out[2] === "2024-07-01 ['AAPL', 'MSFT', 'NVDA']", out[2]);
  check('datetime 传入：当天任何时刻都看不到当天的行', out[3] === '0 1', out[3]);
  check('每个返回的行都严格早于查询日', out[4] === 'True', out[4]);
}
{
  const out = py(`
d = h.HelmDataset('sector_attr')
q = lambda day: (d.value('AAPL', 'sector', day), d.value('aapl', 'beta', day), d.value('XOM', 'sector', day))
print(q('2024-01-10')); print(q('2024-01-11')); print(q('2024-09-03')); print(q('2024-09-04'))
print(d.symbols_with('sector', 'Tech', '2024-02-01'), d.symbols_with('sector', 'Tech', '2024-10-01'), d.symbols_with('sector', lambda v: v.startswith('E'), '2024-10-01'))
print(d.symbols_with('sector', 'Tech', '2024-01-10'), d.value('TSLA', 'sector', '2025-01-01'))
`).split('\n');
  check('属性：公开当天看不到', out[0] === '(None, None, None)', out[0]);
  check('属性：次日可见（数值列转成数字）', out[1] === "('Tech', 1.25, 'Energy')", out[1]);
  check('属性随时间变化：新值要等到更晚的 available_date 之后', out[2] === "('Tech', 1.25, 'Energy')" && out[3] === "('Consumer, Tech \"x\"', 1.25, 'Energy')", `${out[2]} / ${out[3]}`);
  check('symbols_with：按当时已知的最新值（含判断函数）', out[4] === "['AAPL'] [] ['XOM']", out[4]);
  check('symbols_with 当天为空；未知代码返回 None', out[5] === '[] None', out[5]);
}
{
  const out = py(`
t = h.HelmDataset('ts_demo')
print(t.value(None, None, '2024-02-05'), t.value(None, None, '2024-02-06'), t.value(None, None, '2024-03-06'), t.value(None, None, '2024-03-07'))
try:
    h.HelmDataset('missing_one')
except FileNotFoundError as e:
    print('FNF', 'save_dataset' in str(e))
print('HelmDataset' in h.__all__)
`).split('\n');
  check('时间序列：available_date 当天不可见，次日可见', out[0] === 'None 10.0 10.0 12.5', out[0]);
  check('不存在的数据集：FileNotFoundError 带提示；__all__ 含 HelmDataset', out[1] === 'FNF True' && out[2] === 'True', `${out[1]} ${out[2]}`);
}

/* ---------- 指纹 ---------- */
{
  const code = 'from helm_data import HelmDataset\nds = HelmDataset("adds_demo")\n';
  const inp = await F.strategyInputs({ dataDir: DATA, code, baseTickers: [] });
  check('指纹输入包含数据集的 csv 和说明文件', inp.files.includes('helm/custom/adds_demo.csv') && inp.files.includes('helm/custom/adds_demo.meta.json'), inp.files.join(','));
  const f1 = await F.dataFingerprint({ dataDir: DATA, tickers: [], files: inp.files });
  check('指纹记录了数据集文件的哈希', Boolean(f1.files['helm/custom/adds_demo.csv'].sha256) && !f1.files['helm/custom/adds_demo.meta.json'].missing);
  const f1b = await F.dataFingerprint({ dataDir: DATA, tickers: [], files: inp.files });
  check('数据集没变：指纹不变', f1.hash === f1b.hash);
  await D.saveDataset(ev({ rows: [...ev().rows, { available_date: '2024-08-01', symbol: 'TSLA', event: 'index_add', source: 0 }] }), { dataDir: DATA });
  const f2 = await F.dataFingerprint({ dataDir: DATA, tickers: [], files: inp.files });
  check('数据集变了（新版本）：指纹变了，能比出是这个数据集', f2.hash !== f1.hash && F.diffData(f1, f2).files.some((x) => x.file === 'helm/custom/adds_demo.csv'));
  const meta = JSON.parse(await readFile(path.join(DATA, 'helm/custom/adds_demo.meta.json'), 'utf8'));
  const usage = await D.datasetUsage({ dataDir: DATA, names: ['adds_demo', 'gone_x'] });
  check('datasetUsage：版本、来源、provenance；缺的标 missing', usage[0].version === meta.version && usage[0].provenance === 'web' && usage[0].sources.length === 2 && usage[1].missing === true);
  check('代码识别：datasetsInCode', JSON.stringify(D.datasetsInCode('HelmDataset("a_b"); HelmDataset( \'c_d\' )')) === '["a_b","c_d"]');
}

/* ---------- MCP 工具往返（stdio） ---------- */
async function mcpOne([name, args]) {
  const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp', 'qc-mcp.mjs')], { env: { ...process.env, HELM_LEAN_DATA: DATA }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; mcp.stdout.on('data', (c) => { out += c; }); mcp.stdin.on('error', () => {});
  const done = new Promise((res) => mcp.on('close', res));
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`);
  mcp.stdin.end();
  await Promise.race([done, new Promise((r) => setTimeout(() => { mcp.kill('SIGKILL'); r(); }, 20000))]);
  try { return JSON.parse(out.split('\n').filter(Boolean)[0]).result; } catch { return null; }
}
async function mcpCall(calls) { const res = []; for (const c of calls) res.push(await mcpOne(c)); return res; } // 一个一个调，和 agent 一样
{
  const good = { name: 'mcp_demo', description: '往返测试', kind: 'events', columns: COLS_EV, sources: SRC, rows: [{ available_date: '2024-03-01', symbol: 'AAPL', event: 'x', source: 0 }] };
  const bad = { ...good, name: 'mcp_bad', rows: [{ symbol: 'AAPL', event: 'x', source: 0 }] };
  const sens = { ...good, name: 'mcp_sens', description: '患有自闭症的高管' };
  const [a, b, c, l, rd2, a2, tooMany] = await mcpCall([['save_dataset', good], ['save_dataset', bad], ['save_dataset', sens], ['list_datasets', {}], ['read_dataset', { name: 'mcp_demo' }], ['save_dataset', good], ['save_dataset', { ...good, rows: new Array(50001).fill({}) }]]);
  check('MCP save_dataset：成功，返回 v1', a && !a.isError && /mcp_demo v1/.test(a.content[0].text), a && a.content[0].text.slice(0, 100));
  check('MCP save_dataset：缺 available_date 报错（isError，列出坏行）', b && b.isError && /第 1 行/.test(b.content[0].text), b && b.content[0].text.slice(0, 100));
  check('MCP save_dataset：敏感特征被拒', c && c.isError && /敏感/.test(c.content[0].text));
  check('MCP list_datasets / read_dataset', l && rd2 && /mcp_demo v1/.test(l.content[0].text) && /"symbol": "AAPL"/.test(rd2.content[0].text));
  check('MCP 同名再存：v2', a2 && /mcp_demo v2.*替换/.test(a2.content[0].text), a2 && a2.content[0].text.slice(0, 80));
  check('MCP：rows 超过 50000 项被挡，不进业务代码', tooMany && tooMany.isError && /50000/.test(tooMany.content[0].text), tooMany && tooMany.content[0].text.slice(0, 80));
}

await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
