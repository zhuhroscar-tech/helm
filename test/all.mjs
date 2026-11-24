// 跑全部测试：npm test（含真实 LEAN）或 npm test -- --fast（不跑 LEAN 的部分）
// 每个测试文件单独一个进程，互不影响；任何一个失败，整体退出码非 0。
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
// 沙盒规则文件写到临时目录，测试不往仓库的 data/sandbox 里写（子进程继承这个变量）
const SB_DIR = process.env.HELM_SANDBOX_DIR ? null : mkdtempSync(path.join(os.tmpdir(), 'helm-test-sandbox-'));
if (SB_DIR) process.env.HELM_SANDBOX_DIR = SB_DIR;
const { sandboxReady, sandboxArgs, scrubEnv } = await import('../lib/exec-sandbox.mjs');

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FAST = process.argv.includes('--fast');
// [文件, 完整模式参数, 快速模式参数（null = 快速模式跳过，因为要跑 LEAN）]
const SUITES = [
  ['smoke.mjs', [], ['--fast']],
  ['lint.test.mjs', [], []],
  ['consistency.test.mjs', ['--lean'], []],
  ['fingerprint.test.mjs', [], []],
  ['alpaca.test.mjs', [], []],
  ['quantconnect.test.mjs', [], []],
  ['layer.test.mjs', [], []],
  ['attribution.test.mjs', [], []],
  ['timing.test.mjs', [], []],
  ['critic.test.mjs', [], []],
  ['install.test.mjs', [], []],
  ['server-auth.test.mjs', [], []],
  ['i18n.test.mjs', [], []],
  ['paper-drift.test.mjs', [], ['--fast']],
  ['paper-safety.test.mjs', [], ['--fast']],
  ['calendar.test.mjs', [], []],
  ['handoff-card.test.mjs', [], []],
  ['drift.test.mjs', [], []],
  ['journal.test.mjs', [], []],
  ['research-list.test.mjs', [], []],
  ['project-delete.test.mjs', [], []],
  ['project-rename.test.mjs', [], []],
  ['main-needs.test.mjs', [], []],
  ['macro.test.mjs', [], []],
  ['helm-vol.test.mjs', [], []],
  ['short.test.mjs', [], []],
  ['updater.test.mjs', [], []],
  ['dataset.test.mjs', [], []],
  ['risk-gate.test.mjs', [], []],
  ['robust.test.mjs', [], []],
  ['robust-analysis.test.mjs', [], []],
  ['server-robust.test.mjs', [], []],
  ['handoff-flow.test.mjs', [], []],
  ['pipeline-agents.test.mjs', [], []],
  ['self-fix.test.mjs', [], []],
  ['tune.test.mjs', [], []],
  ['ask-user.test.mjs', [], []],
  ['agent-eval.test.mjs', [], []],
  ['autopilot.test.mjs', [], []],
  ['autopilot-flow.test.mjs', [], []],
  ['local-http.test.mjs', [], []],
  ['ai-connect.test.mjs', [], []],
  ['translate.test.mjs', [], []],
  ['deck.test.mjs', [], []],
  ['project-names.test.mjs', [], []],
  ['contract.test.mjs', [], []],
  ['round2.test.mjs', [], []],
  ['sensitivity.test.mjs', [], ['--fast']],
  ['validate-cache.test.mjs', [], []],
  ['audit-fixes.test.mjs', [], []],
  ['p0-fixes.test.mjs', [], []],
  ['efficiency.test.mjs', [], []],
  ['first-run.test.mjs', [], []],
  ['sandbox.test.mjs', [], null],
];
// 清单里没写的 *.test.mjs 也会跑（两种模式都不带参数），免得新加的测试文件被悄悄漏掉。
// 但这些文件 agent 不经批准就能新建（change-policy.mjs）：只能放进 agent 沙盒里跑（读不到密钥、改不了仓库），
// 沙盒不可用时跳过。要在沙盒外跑，把它写进上面的清单（改 all.mjs 要批准）。
const listed = new Set(SUITES.map((s) => s[0]));
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.test.mjs') && !listed.has(x)).sort()) SUITES.push([f, [], []]);
// 每个文件最多跑 10 分钟（完整模式的 LEAN 冒烟测试约半分钟）：一个测试卡住不会让整套测试一直挂着
const TIMEOUT_MS = Number(process.env.HELM_TEST_TIMEOUT_MS || 10 * 60 * 1000);
const failed = [];
for (const [file, full, fast] of SUITES) {
  if (!existsSync(path.join(DIR, file))) continue;
  const args = FAST ? fast : full;
  if (args == null) { console.log(`\n—— 跳过 ${file}（快速模式不跑 LEAN）`); continue; }
  console.log(`\n—— ${file} ${args.join(' ')}${listed.has(file) ? '' : '（不在清单里，自动加入）'}`);
  let cmd = process.execPath; let argv = [path.join(DIR, file), ...args]; let env = process.env;
  if (!listed.has(file)) {
    if (!sandboxReady('agent')) { console.log(`跳过 ${file}：不在清单里，且 agent 沙盒不可用（不在沙盒外运行未经批准的测试）`); continue; }
    [cmd, argv] = sandboxArgs('agent', cmd, argv); env = scrubEnv();
  }
  const r = spawnSync(cmd, argv, { stdio: 'inherit', timeout: TIMEOUT_MS, killSignal: 'SIGKILL', env });
  if (r.error && r.error.code === 'ETIMEDOUT') console.log(`超时：${file} 超过 ${Math.round(TIMEOUT_MS / 60000)} 分钟，已停止`);
  if (r.status !== 0) failed.push(file);
}
if (SB_DIR) rmSync(SB_DIR, { recursive: true, force: true });
console.log(failed.length ? `\n失败：${failed.join('、')}` : '\n全部测试文件通过');
process.exit(failed.length ? 1 : 0);
