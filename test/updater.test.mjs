// 自动更新：node test/updater.test.mjs
// 在临时目录里建一个「GitHub」（裸仓库）和一个「安装好的 Helm」（克隆），模拟 GitHub 上出了新版本。
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as U from '../lib/updater.mjs';

const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-upd-'));
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };
const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

const REMOTE = path.join(TMP, 'github.git');
const DEV = path.join(TMP, 'dev');      // 作者自己的仓库：往 GitHub 推新版本
const APP = path.join(TMP, 'app');      // 用户装好的 Helm
const DATA = path.join(TMP, 'data');
try {
  execFileSync('git', ['init', '--bare', '-b', 'main', REMOTE]);
  execFileSync('git', ['init', '-b', 'main', DEV]);
  await writeFile(path.join(DEV, 'server.mjs'), 'export const v = 1;\n');
  await mkdir(path.join(DEV, 'mcp'));
  await writeFile(path.join(DEV, 'mcp', 'qc-mcp.mjs'), 'export const m = 1;\n');
  g(DEV, 'add', '.'); g(DEV, 'commit', '-qm', 'v1'); g(DEV, 'remote', 'add', 'origin', REMOTE); g(DEV, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', '-b', 'main', REMOTE, APP]);
  const publish = async (file, text, msg) => { await writeFile(path.join(DEV, file), text); g(DEV, 'add', '.'); g(DEV, 'commit', '-qm', msg); g(DEV, 'push', '-q', 'origin', 'main'); };

  check('默认不自动更新', (await U.readUpdateState(DATA)).autoUpdate === false);
  await U.setAutoUpdate(DATA, true);
  check('开关存进 data/update.json', (await U.readUpdateState(DATA)).autoUpdate === true);

  let c = await U.checkForUpdate({ root: APP, dataDir: DATA });
  check('没有新版本：已是最新', c.ok && c.behind === 0);

  await publish('server.mjs', 'export const v = 2;\n', 'v2: new feature');
  c = await U.checkForUpdate({ root: APP, dataDir: DATA });
  check('GitHub 有新版本：检查到 1 个，带提交说明', c.ok && c.behind === 1 && c.commits[0].subject === 'v2: new feature');
  check('检查只 fetch，不改文件', (await readFile(path.join(APP, 'server.mjs'), 'utf8')).includes('v = 1'));

  let r = await U.applyUpdate({ root: APP, dataDir: DATA, isIdle: false });
  check('有 agent 在跑：不更新（busy）', !r.ok && r.blockers.includes('busy') && (await readFile(path.join(APP, 'server.mjs'), 'utf8')).includes('v = 1'));

  await writeFile(path.join(APP, 'server.mjs'), 'export const v = 1; // 用户自己改过\n');
  r = await U.applyUpdate({ root: APP, dataDir: DATA });
  check('本地有未提交的改动：不更新、不覆盖', !r.ok && r.blockers.includes('dirty') && (await readFile(path.join(APP, 'server.mjs'), 'utf8')).includes('用户自己改过'));
  g(APP, 'checkout', '--', 'server.mjs');

  g(APP, 'checkout', '-q', '-b', 'experiment');
  r = await U.applyUpdate({ root: APP, dataDir: DATA });
  check('不在 main 分支：不更新', !r.ok && r.blockers.includes('branch'));
  g(APP, 'checkout', '-q', 'main');

  r = await U.applyUpdate({ root: APP, dataDir: DATA });
  check('条件都满足：快进到新版本', r.ok && r.updated && (await readFile(path.join(APP, 'server.mjs'), 'utf8')).includes('v = 2'), JSON.stringify(r.blockers || r.error));
  check('记下这次更新（从哪个版本到哪个版本）', (await U.readUpdateState(DATA)).lastUpdate.to === r.to);

  await publish('server.mjs', 'export const v = ;\n', 'v3: broken');
  await U.checkForUpdate({ root: APP, dataDir: DATA });
  r = await U.applyUpdate({ root: APP, dataDir: DATA });
  check('新版本语法不通过：自动退回原版本', !r.ok && r.error === 'rolled-back' && (await readFile(path.join(APP, 'server.mjs'), 'utf8')).includes('v = 2'));
  check('退回后工作区干净', g(APP, 'status', '--porcelain') === '');

  await publish('server.mjs', 'export const v = 4;\n', 'v4: fix');
  await publish('scripts-setup.txt', 'x', 'unrelated');
  await mkdir(path.join(DEV, 'macos'), { recursive: true });
  await publish('macos/App.swift', '// app', 'v5: mac app change');
  c = await U.checkForUpdate({ root: APP, dataDir: DATA });
  check('改到 Mac App：提示要重新运行安装脚本', c.ok && c.needsApp === true && c.needsSetup === false);

  g(APP, 'commit', '--allow-empty', '-qm', 'local only');
  await U.checkForUpdate({ root: APP, dataDir: DATA });
  r = await U.applyUpdate({ root: APP, dataDir: DATA });
  check('本地有没推送的提交：不更新', !r.ok && r.blockers.includes('ahead'));
  g(APP, 'reset', '-q', '--hard', 'HEAD~1');

  // 定时器：关掉开关就什么都不做；打开后更新并回调
  await U.setAutoUpdate(DATA, false);
  let called = null;
  const t1 = U.startAutoUpdater({ root: APP, dataDir: DATA, isIdle: () => true, onUpdated: async (x) => { called = x; }, firstDelay: 1e9, every: 1e9 });
  await t1.tick(); t1.stop();
  check('关着开关：定时器不更新', called === null && (await readFile(path.join(APP, 'server.mjs'), 'utf8')).includes('v = 2'));
  await U.setAutoUpdate(DATA, true);
  const t2 = U.startAutoUpdater({ root: APP, dataDir: DATA, isIdle: () => true, onUpdated: async (x) => { called = x; }, firstDelay: 1e9, every: 1e9 });
  await t2.tick(); t2.stop();
  check('打开开关：定时器检查、更新并通知重启', called && called.updated && (await readFile(path.join(APP, 'server.mjs'), 'utf8')).includes('v = 4'));

  const notGit = await U.localState(path.join(TMP, 'data'));
  check('不是 git 安装：报出来，不出错', notGit.git === false && U.blockers(notGit)[0] === 'not-git');
} catch (e) {
  check('没有异常', false, e.stack);
}
await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
