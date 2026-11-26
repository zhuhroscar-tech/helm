// 自动更新：从 GitHub（安装时的 origin 远端）的 main 分支拿最新版本。
//
// 只在「安全」的时候更新，否则只提示、不动任何文件：
//   - 当前在 main 分支上（开发用的其它分支不碰）
//   - 已跟踪的文件没有未提交的改动（不会覆盖你改过的东西）
//   - 本地没有没推送的提交，能快进（git merge --ff-only，不会产生合并提交）
//   - 没有 agent 正在运行、没有等你批准 / 回答的请求（由调用方传 isIdle）
// 更新后先做一次语法检查（node --check），不通过就退回原版本。
// 设置（是否自动更新）和上次检查的结果存在 data/update.json（data/ 不进 git，更新不会覆盖它）。
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const UPDATE_BRANCH = 'main';
export const CHECK_EVERY_MS = 6 * 3600 * 1000;
export const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
export const BUSY_RETRY_MS = 10 * 60 * 1000;
// 改到这些文件时，光换代码不够：要重新跑安装脚本（装依赖 / 重新编译 Mac App）
const NEEDS_SETUP = [/^scripts\/setup\.sh$/, /^install\.sh$/, /^package(-lock)?\.json$/, /^engine\/requirements\.txt$/, /^engine\/qlib_research\/run\.sh$/];
const NEEDS_APP = [/^macos\//];
const SYNTAX_CHECK = ['server.mjs', 'mcp/qc-mcp.mjs'];

function git(root, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' }, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() }));
  });
}
function nodeCheck(root, file) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--check', path.join(root, file)], { timeout: 30000 }, (err, _o, stderr) => resolve({ ok: !err, err: String(stderr || (err && err.message) || '').trim() }));
  });
}

const settingsFile = (dataDir) => path.join(dataDir, 'update.json');
export async function readUpdateState(dataDir) {
  try { return { autoUpdate: false, ...JSON.parse(await readFile(settingsFile(dataDir), 'utf8')) }; } catch { return { autoUpdate: false }; }
}
async function writeUpdateState(dataDir, patch) {
  const cur = await readUpdateState(dataDir);
  const next = { ...cur, ...patch };
  await mkdir(dataDir, { recursive: true });
  const f = settingsFile(dataDir);
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await rename(tmp, f);
  return next;
}
export const setAutoUpdate = (dataDir, on) => writeUpdateState(dataDir, { autoUpdate: Boolean(on) });

// 本地仓库现在的样子：版本、分支、有没有改动、和 origin/main 比差多少（不联网，用上次 fetch 的结果）
export async function localState(root, branch = UPDATE_BRANCH) {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') return { git: false };
  const [head, cur, dirty, remote, upstream] = await Promise.all([
    git(root, ['log', '-1', '--format=%H%x09%h%x09%cI%x09%s']),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['status', '--porcelain', '--untracked-files=no']),
    git(root, ['remote', 'get-url', 'origin']),
    git(root, ['rev-parse', '--verify', '--quiet', `origin/${branch}`]),
  ]);
  const [sha, short, date, subject] = head.out.split('\t');
  const s = { git: true, sha, short, date, subject, branch: cur.out, dirty: dirty.out ? dirty.out.split('\n').length : 0, remote: remote.ok ? remote.out : null, hasUpstream: upstream.ok && Boolean(upstream.out) };
  if (s.hasUpstream) {
    const [behind, ahead, ff] = await Promise.all([
      git(root, ['rev-list', '--count', `HEAD..origin/${branch}`]),
      git(root, ['rev-list', '--count', `origin/${branch}..HEAD`]),
      git(root, ['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]),
    ]);
    s.behind = Number(behind.out) || 0; s.ahead = Number(ahead.out) || 0; s.canFastForward = ff.ok;
    s.remoteShort = (await git(root, ['rev-parse', '--short', `origin/${branch}`])).out;
  }
  return s;
}

// 能不能现在更新：返回 [原因…]（空 = 可以）
export function blockers(s, { isIdle = true, branch = UPDATE_BRANCH } = {}) {
  const why = [];
  if (!s.git) return ['not-git'];
  if (!s.remote) why.push('no-remote');
  if (s.branch !== branch) why.push('branch');
  if (s.dirty) why.push('dirty');
  if (s.hasUpstream && s.ahead) why.push('ahead');
  if (s.hasUpstream && s.behind && !s.canFastForward) why.push('diverged');
  if (!isIdle) why.push('busy');
  return why;
}

// 联网检查：git fetch origin main，然后报告有几个新版本、改了什么
export async function checkForUpdate({ root, dataDir, branch = UPDATE_BRANCH }) {
  const before = await localState(root, branch);
  if (!before.git) return { ok: false, error: 'not-git', state: before };
  if (!before.remote) return { ok: false, error: 'no-remote', state: before };
  const f = await git(root, ['fetch', '--quiet', 'origin', branch], { timeout: 90000 });
  if (!f.ok) {
    await writeUpdateState(dataDir, { lastCheck: new Date().toISOString(), lastError: f.err.slice(0, 300) });
    return { ok: false, error: 'fetch', detail: f.err.slice(0, 300), state: before };
  }
  const s = await localState(root, branch);
  let commits = []; let files = [];
  if (s.behind) {
    const log = await git(root, ['log', '--format=%h%x09%cI%x09%s', `HEAD..origin/${branch}`, '-n', '20']);
    commits = log.out ? log.out.split('\n').map((l) => { const [h, d, ...m] = l.split('\t'); return { sha: h, date: d, subject: m.join('\t') }; }) : [];
    const diff = await git(root, ['diff', '--name-only', `HEAD..origin/${branch}`]);
    files = diff.out ? diff.out.split('\n') : [];
  }
  const info = { behind: s.behind || 0, commits, needsSetup: files.some((x) => NEEDS_SETUP.some((r) => r.test(x))), needsApp: files.some((x) => NEEDS_APP.some((r) => r.test(x))), latest: s.remoteShort || null };
  await writeUpdateState(dataDir, { lastCheck: new Date().toISOString(), lastError: null, available: info });
  return { ok: true, state: s, ...info };
}

// 应用更新：条件都满足才快进；之后语法检查，不过就退回
export async function applyUpdate({ root, dataDir, branch = UPDATE_BRANCH, isIdle = true }) {
  const s = await localState(root, branch);
  const why = blockers(s, { isIdle, branch });
  if (why.length) return { ok: false, blockers: why, state: s };
  if (!s.behind) return { ok: true, updated: false, state: s };
  const from = s.sha;
  const m = await git(root, ['merge', '--ff-only', '--quiet', `origin/${branch}`]);
  if (!m.ok) return { ok: false, error: 'merge', detail: m.err.slice(0, 300), state: s };
  for (const f of SYNTAX_CHECK) {
    const c = await nodeCheck(root, f);
    if (!c.ok) {
      // 新版本连语法检查都过不了：退回原版本（工作区本来是干净的，--keep 不会丢任何东西）
      await git(root, ['reset', '--keep', from]);
      await writeUpdateState(dataDir, { lastError: `rolled back: ${f} failed syntax check` });
      return { ok: false, error: 'rolled-back', detail: `${f}: ${c.err.slice(0, 200)}`, state: await localState(root, branch) };
    }
  }
  const after = await localState(root, branch);
  const st = await readUpdateState(dataDir);
  const avail = st.available || {};
  await writeUpdateState(dataDir, { lastUpdate: { at: new Date().toISOString(), from: from.slice(0, 7), to: after.short, needsSetup: Boolean(avail.needsSetup), needsApp: Boolean(avail.needsApp) }, available: null });
  return { ok: true, updated: true, from: from.slice(0, 7), to: after.short, needsSetup: Boolean(avail.needsSetup), needsApp: Boolean(avail.needsApp), state: after };
}

// 后台定时器：开了自动更新才动。onUpdated 由服务端决定怎么重启
export function startAutoUpdater({ root, dataDir, isIdle, onUpdated, log = () => {}, every = CHECK_EVERY_MS, firstDelay = FIRST_CHECK_DELAY_MS }) {
  let timer = null; let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const st = await readUpdateState(dataDir);
      if (!st.autoUpdate) return;
      const c = await checkForUpdate({ root, dataDir });
      if (!c.ok || !c.behind) return;
      const r = await applyUpdate({ root, dataDir, isIdle: isIdle() });
      if (r.ok && r.updated) { log(`auto-update: ${r.from} → ${r.to}`); await onUpdated(r); }
      else if (!r.ok) {
        log(`auto-update skipped: ${(r.blockers || [r.error]).join(', ')}`);
        // 只是因为正在干活：10 分钟后再试，不用等下一个 6 小时
        if (r.blockers && r.blockers.length === 1 && r.blockers[0] === 'busy') { const t = setTimeout(tick, BUSY_RETRY_MS); t.unref?.(); }
      }
    } catch (e) { log(`auto-update error: ${e.message}`); } finally { busy = false; }
  };
  const first = setTimeout(tick, firstDelay); first.unref?.();
  timer = setInterval(tick, every); timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); }, tick };
}
