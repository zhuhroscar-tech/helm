// 一行安装脚本（install.sh）测试：node test/install.test.mjs
// 不联网、不装任何东西：从本地的假「远端仓库」克隆，uname / sw_vers / open / claude / curl / swift 都用替身，
// scripts/setup.sh 和 macos/build.sh 也是假的（只记录被怎样调用）。
import { mkdtemp, rm, writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'install.sh');
const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-install-'));
let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${String(extra).slice(0, 400)})` : ''}`);
  if (!cond) failed += 1;
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
const sh = async (file, body) => { await writeFile(file, `#!/bin/bash\n${body}\n`); await chmod(file, 0o755); };

// 假远端仓库
const REMOTE = path.join(TMP, 'remote');
await mkdir(path.join(REMOTE, 'scripts'), { recursive: true });
await mkdir(path.join(REMOTE, 'macos'), { recursive: true });
await writeFile(path.join(REMOTE, 'server.mjs'), '// fake\n');
await writeFile(path.join(REMOTE, 'package.json'), '{"name":"helm-qc-console","version":"1.0.0"}\n');
await sh(path.join(REMOTE, 'scripts', 'setup.sh'), 'echo "FAKE-SETUP args=[$*] tty=$([ -t 0 ] && echo y || echo n)" >> "$HOME/calls.log"; exit "${FAKE_SETUP_EXIT:-0}"');
await sh(path.join(REMOTE, 'macos', 'build.sh'), 'echo "FAKE-BUILD $*" >> "$HOME/calls.log"; mkdir -p "$HOME/Applications/Helm.app"');
git(REMOTE, 'init', '-q', '-b', 'main'); git(REMOTE, 'add', '-A'); git(REMOTE, 'commit', '-qm', 'v1');

// 替身命令
const BIN = path.join(TMP, 'bin');
await mkdir(BIN);
await sh(path.join(BIN, 'uname'), 'case "$1" in -s) echo "${FAKE_OS:-Darwin}";; -m) echo arm64;; *) echo "${FAKE_OS:-Darwin}";; esac');
await sh(path.join(BIN, 'sw_vers'), 'echo 15.1');
await sh(path.join(BIN, 'open'), 'echo "OPEN $*" >> "$HOME/calls.log"');
await sh(path.join(BIN, 'xcode-select'), 'echo "XCODE $*" >> "$HOME/calls.log"');
// 「官方安装程序」替身：curl 输出一段脚本，执行后在 ~/.local/bin 放一个 claude
await sh(path.join(BIN, 'curl'), 'echo "CURL $*" >> "$HOME/calls.log"; echo \'mkdir -p "$HOME/.local/bin"; printf "#!/bin/bash\\necho fake-claude\\n" > "$HOME/.local/bin/claude"; chmod +x "$HOME/.local/bin/claude"\'');
const CLAUDE_BIN_DIR = path.join(TMP, 'claude-bin');
await mkdir(CLAUDE_BIN_DIR);
await sh(path.join(CLAUDE_BIN_DIR, 'claude'), 'echo fake');
const SWIFT_DIR = path.join(TMP, 'swift-bin');
await mkdir(SWIFT_DIR);
await sh(path.join(SWIFT_DIR, 'swift'), 'echo fake');

const basePath = (extra = []) => [...extra, BIN, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
let homeN = 0;
async function run({ env = {}, input = null, home = null, paths = [CLAUDE_BIN_DIR], args = [], viaPipe = false, scriptText = null } = {}) {
  const HOME = home || path.join(TMP, `home${++homeN}`);
  await mkdir(HOME, { recursive: true });
  const e = { PATH: basePath(paths), HOME, LANG: 'en_US.UTF-8', HELM_REPO: REMOTE, HELM_NO_START: '1', ...env };
  return new Promise((resolve) => {
    // detached = 新会话，没有控制终端（模拟没有 /dev/tty 的情况，也避免读到测试机的终端）
    const child = viaPipe || scriptText
      ? spawn('bash', ['-s', '--', ...args], { env: e, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('bash', [SCRIPT, ...args], { env: e, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', async (code) => {
      const calls = existsSync(path.join(HOME, 'calls.log')) ? await readFile(path.join(HOME, 'calls.log'), 'utf8') : '';
      resolve({ code, out, calls, HOME });
    });
    if (viaPipe || scriptText) child.stdin.end(scriptText ?? execFileSync('cat', [SCRIPT]));
    else child.stdin.end(input ?? '');
  });
}

try {
  {
    const r = await run();
    check('没有终端、没给 HELM_YES：停下并说明', r.code === 1 && /No terminal/.test(r.out) && !existsSync(path.join(r.HOME, 'Helm')), r.out);
  }
  {
    const r = await run({ env: { HELM_YES: '1', FAKE_OS: 'Linux' } });
    check('不是 macOS：停下', r.code === 1 && /macOS only/.test(r.out) && !existsSync(path.join(r.HOME, 'Helm')), r.out);
  }
  let home;
  {
    const r = await run({ env: { HELM_YES: '1' } });
    home = r.HOME;
    check('全新安装：成功', r.code === 0, r.out);
    check('克隆到 ~/Helm', existsSync(path.join(r.HOME, 'Helm', 'server.mjs')));
    check('跑了 scripts/setup.sh --yes', /FAKE-SETUP args=\[--yes\]/.test(r.calls), r.calls);
    check('没有 swift：跳过 App、提示用浏览器', /Skipped: building the app/.test(r.out) && !/FAKE-BUILD/.test(r.calls));
    check('结尾写了怎样启动 / 更新 / 卸载', /npm start/.test(r.out) && /Update later/.test(r.out) && /Uninstall/.test(r.out));
    check('已有 claude：不调用官方安装程序', !/CURL/.test(r.calls));
  }
  {
    await writeFile(path.join(REMOTE, 'NEW.md'), 'v2\n'); git(REMOTE, 'add', '-A'); git(REMOTE, 'commit', '-qm', 'v2');
    const r = await run({ env: { HELM_YES: '1' }, home });
    check('再运行一次：更新到新版本', r.code === 0 && /updating/.test(r.out) && existsSync(path.join(home, 'Helm', 'NEW.md')), r.out);
  }
  {
    await writeFile(path.join(home, 'Helm', 'server.mjs'), '// my local edit\n');
    await writeFile(path.join(REMOTE, 'NEW2.md'), 'v3\n'); git(REMOTE, 'add', '-A'); git(REMOTE, 'commit', '-qm', 'v3');
    const r = await run({ env: { HELM_YES: '1' }, home });
    check('有本地改动：不更新、改动保留', r.code === 0 && /local code changes/.test(r.out) && !existsSync(path.join(home, 'Helm', 'NEW2.md')) && /my local edit/.test(await readFile(path.join(home, 'Helm', 'server.mjs'), 'utf8')), r.out);
  }
  {
    const r = await run({ env: { HELM_YES: '1', FAKE_SETUP_EXIT: '1' } });
    check('setup 没装完：停下并说明，不继续', r.code === 1 && /Setup did not finish/.test(r.out) && !/==> Done/.test(r.out), r.out);
  }
  {
    const h = path.join(TMP, 'home-busy');
    await mkdir(path.join(h, 'Helm'), { recursive: true });
    await writeFile(path.join(h, 'Helm', 'mine.txt'), 'x');
    const r = await run({ env: { HELM_YES: '1' }, home: h });
    check('~/Helm 已存在且不是 Helm：停下，不碰', r.code === 1 && /not empty/.test(r.out) && existsSync(path.join(h, 'Helm', 'mine.txt')), r.out);
    const r2 = await run({ env: { HELM_YES: '1', HELM_DIR: path.join(h, 'Other') }, home: h });
    check('HELM_DIR 换位置安装', r2.code === 0 && existsSync(path.join(h, 'Other', 'server.mjs')));
  }
  {
    const r = await run({ env: { HELM_YES: '1', HELM_NO_START: '0' }, paths: [CLAUDE_BIN_DIR, SWIFT_DIR] });
    check('有 swift：构建并安装 App', /FAKE-BUILD --install/.test(r.calls), r.calls);
    check('最后打开 App', /OPEN .*Applications\/Helm\.app/.test(r.calls), r.calls);
    const r2 = await run({ env: { HELM_YES: '1' }, paths: [CLAUDE_BIN_DIR, SWIFT_DIR], args: ['--no-app'] });
    check('--no-app：不构建 App', r2.code === 0 && !/FAKE-BUILD/.test(r2.calls));
  }
  {
    const r = await run({ env: { HELM_YES: '1' }, paths: [] });
    check('没有 claude：用官方安装程序装上，并提醒登录', r.code === 0 && /CURL -fsSL https:\/\/claude\.ai\/install\.sh/.test(r.calls) && /Log in to Claude Code/.test(r.out), r.out);
  }
  {
    const r = await run({ env: { HELM_YES: '1' }, viaPipe: true });
    check('curl | bash 的方式（从 stdin 读脚本）也能装', r.code === 0 && existsSync(path.join(r.HOME, 'Helm', 'server.mjs')), r.out);
  }
  {
    const full = await readFile(SCRIPT, 'utf8');
    const half = full.slice(0, Math.floor(full.length * 0.6));
    const r = await run({ env: { HELM_YES: '1' }, scriptText: half });
    check('下载到一半断了：什么都不做', !existsSync(path.join(r.HOME, 'Helm')) && !/FAKE-SETUP/.test(r.calls), r.out.slice(0, 200));
  }
  {
    const r = await run({ env: { HELM_YES: '1', LANG: 'zh_CN.UTF-8' } });
    check('中文系统：中文提示', r.code === 0 && /安装位置/.test(r.out) && /以后更新/.test(r.out));
  }
  {
    const r = await run({ args: ['--bogus'], env: { HELM_YES: '1' } });
    check('不认识的参数：报错退出', r.code === 2 && /Unknown option/.test(r.out));
  }
} finally {
  await rm(TMP, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
