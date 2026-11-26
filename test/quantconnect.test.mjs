// 发到 QuantConnect 的客户端测试：node test/quantconnect.test.mjs
// 全程 mock globalThis.fetch，不发任何真实网络请求；凭据文件写到临时目录，使用假凭据。
import { mkdtemp, rm, readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-qc-'));
const CREDS = path.join(TMP, 'secrets', 'quantconnect.json');
process.env.HELM_QC_FILE = CREDS;
process.env.HELM_QC_POLL_MS = '1';

let calls = [];
let handler = () => { throw new Error('unexpected fetch'); };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push({ url: u, ep: u.pathname.replace('/api/v2/', ''), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined });
  return handler(u.pathname.replace('/api/v2/', ''), init.body ? JSON.parse(init.body) : {}, init);
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const QC = await import('../lib/quantconnect.mjs');

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed += 1;
};
const FAKE = { userId: '123456', token: 'fake0token0do0not0use0abcdef1234567890' };
const FILES = [
  { name: 'main.py', content: 'from AlgorithmImports import *\nclass A(QCAlgorithm):\n    pass\n' },
  { name: 'util.py', content: 'X = 1\n' },
];

try {
  /* ---------- 签名 ---------- */
  {
    const h = QC.authHeaders(FAKE, 1700000000000);
    const hash = crypto.createHash('sha256').update(`${FAKE.token}:1700000000`).digest('hex');
    check('签名：Timestamp 是秒', h.Timestamp === '1700000000');
    check('签名：Basic base64(userId:sha256(token:ts))', h.Authorization === `Basic ${Buffer.from(`123456:${hash}`).toString('base64')}`);
    check('签名：token 原文不在头里', !JSON.stringify(h).includes(FAKE.token) && !Buffer.from(h.Authorization.slice(6), 'base64').toString().includes(FAKE.token));
    check('User ID 打码', QC.maskUserId('123456') === '12**56' && QC.maskUserId('12') === '****');
  }

  /* ---------- 连接 ---------- */
  {
    calls = [];
    const r = await QC.saveCreds({ userId: 'abc', token: 'short' });
    check('格式不对：不联网、不保存', !r.success && calls.length === 0 && !existsSync(CREDS), r.errors.join(';'));
  }
  {
    calls = [];
    handler = () => new Response('', { status: 401 });
    const r = await QC.saveCreds(FAKE);
    check('QC 拒绝：不保存，错误不含 token', !r.success && !existsSync(CREDS) && !JSON.stringify(r).includes(FAKE.token), r.errors.join(';'));
    check('验证走 /authenticate', calls.length === 1 && calls[0].ep === 'authenticate' && calls[0].url.origin === 'https://www.quantconnect.com');
  }
  {
    handler = () => json(200, { success: true });
    const r = await QC.saveCreds(FAKE);
    check('验证通过：保存', r.success && r.status.userIdMasked === '12**56');
    check('保存：文件权限 0600', ((await stat(CREDS)).mode & 0o777) === 0o600);
    check('保存：返回值不含 token', !JSON.stringify(r).includes(FAKE.token));
    const s = await QC.status();
    check('status 默认不联网、不含 token', s.connected && !JSON.stringify(s).includes(FAKE.token));
  }

  /* ---------- helm_data 检测 / 项目名 ---------- */
  {
    check('helm_data：import 识别', QC.helmDataUsage([{ name: 'main.py', content: 'from helm_data import HelmSignals\n' }]).uses);
    check('helm_data：干净代码不误报', !QC.helmDataUsage(FILES).uses);
    const n = QC.qcProjectName('SPY 50/200 <均线>', 'abcdef123456', new Date('2026-11-23T10:05:00Z'));
    check('项目名：Helm 文件夹、去掉特殊字符', n === 'Helm/SPY 50 200 均线 abcdef 2026-11-23 1005', n);
  }

  /* ---------- 发送：建项目 → main.py 用 update、其余 create → 编译轮询 ---------- */
  {
    calls = [];
    let reads = 0;
    handler = (ep, b) => {
      if (ep === 'projects/create') return json(200, { success: true, projects: [{ projectId: 987, name: b.name }] });
      if (ep === 'files/read') return json(200, { success: true, files: [{ name: 'main.py' }, { name: 'research.ipynb' }] });
      if (ep === 'files/update' || ep === 'files/create') return json(200, { success: true });
      if (ep === 'compile/create') return json(200, { success: true, compileId: 'c-1', state: 'InQueue' });
      if (ep === 'compile/read') { reads += 1; return json(200, { success: true, compileId: 'c-1', state: reads < 2 ? 'InQueue' : 'BuildSuccess', logs: ['ok'] }); }
      return json(404, { success: false, errors: ['?'] });
    };
    const r = await QC.pushProject({ name: 'Helm/x', files: [...FILES, { name: 'spec.md', content: '# not py' }] });
    check('发送成功、项目链接', r.success && r.project.projectId === 987 && r.project.url === 'https://www.quantconnect.com/project/987', JSON.stringify(r.errors));
    check('建项目：Python', calls.find((c) => c.ep === 'projects/create').body.language === 'Py');
    check('main.py 用 files/update', calls.some((c) => c.ep === 'files/update' && c.body.name === 'main.py' && c.body.projectId === 987));
    check('util.py 用 files/create', calls.some((c) => c.ep === 'files/create' && c.body.name === 'util.py'));
    check('只发 .py（spec.md 不发）', !calls.some((c) => c.body && c.body.name === 'spec.md') && r.uploaded.length === 2);
    check('编译轮询到 BuildSuccess', r.compile.state === 'BuildSuccess' && reads === 2 && !r.compile.error);
    check('只调用白名单接口（没有 backtests / live）', calls.every((c) => ['projects/create', 'files/read', 'files/create', 'files/update', 'compile/create', 'compile/read'].includes(c.ep)));
    check('每个请求都带签名、不带 token 原文', calls.every((c) => c.headers.Authorization && c.headers.Timestamp && !JSON.stringify(c.headers).includes(FAKE.token)));
  }
  {
    handler = (ep, b) => {
      if (ep === 'projects/create') return json(200, { success: true, projects: [{ projectId: 5, name: b.name }] });
      if (ep === 'files/read') return json(200, { success: true, files: [{ name: 'main.py' }] });
      if (ep.startsWith('files/')) return json(200, { success: true });
      if (ep === 'compile/create') return json(200, { success: true, compileId: 'c-2', state: 'BuildError', logs: ['main.py:3 SyntaxError'] });
      return json(500, {});
    };
    const r = await QC.pushProject({ name: 'Helm/y', files: FILES });
    check('编译失败：仍算发送成功，带日志', r.success && r.compile.state === 'BuildError' && r.compile.logs[0].includes('SyntaxError'));
  }
  {
    handler = (ep) => (ep === 'projects/create' ? json(200, { success: false, errors: ['Project name already exists'] }) : json(500, {}));
    const r = await QC.pushProject({ name: 'Helm/z', files: FILES });
    check('建项目失败：返回 QC 的错误', !r.success && r.errors[0].includes('already exists'), r.errors.join(';'));
  }
  {
    calls = [];
    const r = await QC.pushProject({ name: 'Helm/z', files: [{ name: 'util.py', content: 'x' }] });
    check('没有 main.py：不联网', !r.success && calls.length === 0);
    const r2 = await QC.pushProject({ name: 'Helm/z', files: [{ name: '../evil.py', content: 'x' }, { name: 'main.py', content: '' }] });
    check('可疑文件名：拒绝', !r2.success && calls.length === 0);
  }

  /* ---------- 发送记录 ---------- */
  {
    const pd = path.join(TMP, 'projects');
    await mkdir(path.join(pd, '7'), { recursive: true });
    await QC.logExport(pd, 7, { backtestId: 'aa11', url: 'https://www.quantconnect.com/project/1' });
    await QC.logExport(pd, 7, { backtestId: 'bb22', url: 'https://www.quantconnect.com/project/2' });
    const all = await QC.listExports(pd, 7);
    const one = await QC.listExports(pd, 7, 'bb22');
    check('发送记录：追加、按回测筛选', all.length === 2 && one.length === 1 && one[0].url.endsWith('/2'));
    check('发送记录：不含凭据', !(await readFile(path.join(pd, '7', 'qc-exports.jsonl'), 'utf8')).includes(FAKE.token));
  }

  /* ---------- 断开 ---------- */
  {
    await QC.clearCreds();
    check('断开：删除凭据文件', !existsSync(CREDS) && !(await QC.status()).connected);
    const r = await QC.pushProject({ name: 'x', files: FILES });
    check('断开后发送：提示先连接', !r.success && /还没有连接/.test(r.errors[0]));
  }
} finally {
  await rm(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
