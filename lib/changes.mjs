// agent 自己改代码时的安全网：每次运行一个「改动集」。
// 改每个文件之前先存一份原文（快照）；改完跑相关测试；测试没过就把文件恢复成原文；用户随时可以一键撤销。
// 快照存在 data/changes/<id>/，不碰 git（不会动你的暂存区和提交）。
import { readFile, writeFile, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { sandboxArgs, scrubEnv } from './exec-sandbox.mjs';

const MAX_KEEP = 300;
const hash = (t) => (t == null ? null : crypto.createHash('sha256').update(t).digest('hex').slice(0, 16));
const readOrNull = async (f) => { try { return await readFile(f, 'utf8'); } catch { return null; } };
export const readTextSync = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };

// 改了哪些文件 → 跑哪些测试；服务进程自己加载的文件改了要重启 Helm 才生效
export function testPlan(rels) {
  const js = rels.some((r) => /\.(m?js|json)$/.test(r) && !r.startsWith('engine/'));
  const py = rels.some((r) => /^engine\/.*\.py$/.test(r));
  return { js, py };
}
export const needsRestart = (rels) => rels.some((r) => r === 'server.mjs' || /^lib\/[^/]+\.mjs$/.test(r) || r === 'agents.json');

// 改完后的自动检查会执行 agent 刚写的代码：在 agent 沙盒里跑（读不到密钥、连不上 Helm、改不了仓库），环境变量去掉密钥
function run(cmd0, args0, { cwd, timeout = 600000, env } = {}) {
  const [cmd, args] = sandboxArgs('agent', cmd0, args0);
  return new Promise((resolve) => {
    let out = '';
    const ch = spawn(cmd, args, { cwd, env: scrubEnv(env || process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => { out += '\n（超时，已停止）'; ch.kill('SIGTERM'); }, timeout);
    ch.stdout.on('data', (c) => { out = (out + c).slice(-60000); });
    ch.stderr.on('data', (c) => { out = (out + c).slice(-60000); });
    ch.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: `${out}\n${e.message}` }); });
    ch.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

// 默认的测试：JS 跑快速测试集，Python 跑引擎单元测试。返回 [{ name, state: pass|fail|skipped, tail }]
// 两套测试合起来不能超过 13 分钟：agent 的 verify_changes 15 分钟就超时，超时后它以为「检查失败」去做别的，
// 这边测试跑完却可能自动撤销它的改动。以前两套各 10 分钟、依次跑，最长 20 分钟
const VERIFY_BUDGET_MS = Number(process.env.HELM_VERIFY_BUDGET_MS || 13 * 60 * 1000);
export async function defaultRunTests(plan, { root, env }) {
  const res = [];
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  const left = () => Math.max(30000, Math.min(600000, deadline - Date.now()));
  if (plan.js) {
    const r = await run(process.execPath, [path.join(root, 'test', 'all.mjs'), '--fast'], { cwd: root, env, timeout: left() });
    res.push({ name: 'npm test -- --fast', state: r.code === 0 ? 'pass' : 'fail', tail: r.out.split('\n').filter((l) => /FAIL|失败|Error|错误/.test(l)).slice(-40).join('\n') || r.out.slice(-3000) });
  }
  if (plan.py) {
    const r = await run(path.join(root, 'engine', 'qlib_research', 'run.sh'), ['--test'], { cwd: root, env, timeout: left() });
    // 退出码 3 = 本机没有装好 qlib 的 Python：测不了，不算失败
    res.push({ name: 'engine/qlib_research/run.sh --test', state: r.code === 0 ? 'pass' : r.code === 3 ? 'skipped' : 'fail', tail: r.out.slice(-3000) });
  }
  return res;
}

export class ChangeStore {
  constructor({ dir, root, runTests = defaultRunTests, env }) {
    this.dir = dir; this.root = root; this.runTests = runTests; this.env = env;
    this.index = null; this.byRun = new Map(); this.lock = Promise.resolve();
  }
  async load() {
    if (this.index) return this.index;
    await mkdir(this.dir, { recursive: true });
    try { this.index = JSON.parse(await readFile(path.join(this.dir, 'index.json'), 'utf8')); } catch { this.index = []; }
    // 服务重启前还开着的改动集：没验证过，标出来让用户决定
    for (const c of this.index) if (c.status === 'open' || c.status === 'verifying') c.status = 'unverified';
    return this.index;
  }
  async save() {
    const f = path.join(this.dir, 'index.json');
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(this.index.slice(0, MAX_KEEP), null, 1));
    await rename(tmp, f);
  }
  serial(fn) { const p = this.lock.then(fn, fn); this.lock = p.catch(() => {}); return p; }
  get(id) { return (this.index || []).find((c) => c.id === id) || null; }
  current(runKey) { const id = this.byRun.get(runKey); return id ? this.get(id) : null; }

  // 改文件之前调用：这次运行的改动集里还没有这个文件就存一份原文
  snapshot(runKey, meta, abs) {
    return this.serial(async () => {
      await this.load();
      let c = this.current(runKey);
      if (!c) {
        c = { id: `c${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, threadId: meta.threadId, agent: meta.agent, title: meta.title || '', at: Date.now(), status: 'open', files: [], tests: null, approvals: [] };
        this.index.unshift(c); this.byRun.set(runKey, c.id);
        await mkdir(path.join(this.dir, c.id), { recursive: true });
      }
      const rel = path.relative(this.root, abs).split(path.sep).join('/');
      if (!c.files.some((f) => f.rel === rel)) {
        const before = await readOrNull(abs);
        const backup = before == null ? null : `${c.files.length}.orig`;
        if (backup) await writeFile(path.join(this.dir, c.id, backup), before);
        c.files.push({ rel, existed: before != null, backup, beforeHash: hash(before) });
      }
      c.status = 'open';
      await this.save();
      return c;
    });
  }
  async noteApproval(runKey, entry) {
    return this.serial(async () => { await this.load(); const c = this.current(runKey); if (c) { c.approvals.push(entry); await this.save(); } });
  }

  // 跑测试；没过就自动恢复。返回 { ok, status, suites, reverted, needsRestart }
  async verify(runKey, { autoRevert = true } = {}) {
    await this.load();
    const c = this.current(runKey);
    if (!c || !c.files.length) return { ok: true, status: 'none', suites: [] };
    c.status = 'verifying'; await this.save();
    const rels = c.files.map((f) => f.rel);
    const suites = await this.runTests(testPlan(rels), { root: this.root, env: this.env });
    // 测试可能跑十几分钟：这期间用户可能已经点了「撤销」。结果要在锁里写，撤销过的不能再改回「已保留」
    return this.serial(async () => {
    if (c.status === 'reverted') return { ok: false, status: 'reverted', suites, reverted: true, needsRestart: false, change: c };
    const failed = suites.filter((s) => s.state === 'fail');
    c.tests = { at: Date.now(), suites };
    for (const f of c.files) f.afterHash = hash(await readOrNull(path.join(this.root, f.rel)));
    c.needsRestart = needsRestart(rels);
    if (failed.length && autoRevert) {
      await this.restore(c);
      c.status = 'reverted'; c.revertReason = `测试没过：${failed.map((s) => s.name).join('、')}`;
    } else {
      c.status = failed.length ? 'failed' : suites.length ? 'verified' : 'kept';
    }
    await this.save();
    return { ok: !failed.length, status: c.status, suites, reverted: c.status === 'reverted', needsRestart: c.needsRestart && c.status !== 'reverted', change: c };
    });
  }

  async restore(c) {
    for (const f of c.files) {
      const abs = path.join(this.root, f.rel);
      if (f.existed) {
        const orig = await readFile(path.join(this.dir, c.id, f.backup), 'utf8');
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, orig);
      } else {
        await unlink(abs).catch(() => {});
      }
    }
  }

  // 用户点「撤销」：文件在这之后又被改过时，先报冲突，force 才覆盖
  revert(id, { force = false, by = 'user' } = {}) {
    return this.serial(async () => {
      await this.load();
      const c = this.get(id);
      if (!c) return { error: '没有这个改动' };
      if (c.status === 'reverted') return { error: '已经撤销过了' };
      const conflicts = [];
      for (const f of c.files) {
        if (!f.afterHash) continue;
        const now = hash(await readOrNull(path.join(this.root, f.rel)));
        if (now !== f.afterHash) conflicts.push(f.rel);
      }
      if (conflicts.length && !force) return { conflicts };
      await this.restore(c);
      c.status = 'reverted'; c.revertReason = by === 'user' ? '你撤销了' : by === 'agent' ? 'agent 自己撤销了' : by;
      c.revertedAt = Date.now();
      await this.save();
      return { change: c, needsRestart: needsRestart(c.files.map((f) => f.rel)) };
    });
  }

  // 列表 / 详情（详情带每个文件的差异：原文 vs 现在）
  async list() { await this.load(); return this.index.slice(0, 100).map(({ approvals, ...c }) => ({ ...c, approvals: approvals.length })); }
  async detail(id, diffFn) {
    await this.load();
    const c = this.get(id);
    if (!c) return null;
    const files = [];
    for (const f of c.files) {
      const before = f.backup ? await readOrNull(path.join(this.dir, c.id, f.backup)) : '';
      const now = await readOrNull(path.join(this.root, f.rel));
      files.push({ ...f, exists: now != null, diff: diffFn(before ?? '', now ?? '') });
    }
    return { ...c, files };
  }
  async fileExists(rel) { try { await stat(path.join(this.root, rel)); return true; } catch { return false; } }
}
