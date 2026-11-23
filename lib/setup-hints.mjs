// 安装提示：环境体检（/api/health）、启动日志、helm doctor 共用。
// 首选「运行 scripts/setup.sh」，原始命令只作为补充细节（cmd）。Python 包清单以 engine/requirements.txt 为准。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQ = path.join(INSTALL_DIR, 'engine', 'requirements.txt');
// requirements.txt 不在时的后备（和它保持一致）
const FALLBACK_PKGS = ['numpy==1.26.4', 'pandas==2.3.3', 'scipy==1.13.1', 'matplotlib==3.8.4', 'scikit-learn==1.6.1', 'statsmodels==0.14.6', 'yfinance==1.8.0', 'python-pptx==1.0.2', 'pypdfium2==5.15.2'];

export function pipPackages(file = REQ) {
  try {
    const pk = readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l && !l.startsWith('-'));
    if (pk.length) return pk;
  } catch { /* 没有文件 */ }
  return FALLBACK_PKGS;
}
// LEAN 固定的版本：scripts/setup.sh 里的 LEAN_COMMIT（唯一来源）
export function leanCommit(file = path.join(INSTALL_DIR, 'scripts', 'setup.sh')) {
  try { return (readFileSync(file, 'utf8').match(/^LEAN_COMMIT="([0-9a-f]{7,40})"/m) || [])[1] || null; } catch { return null; }
}
export const pipCommand = () => (existsSync(REQ)
  ? 'uv pip install --python engine/.venv/bin/python -r engine/requirements.txt'
  : `uv pip install --python engine/.venv/bin/python ${pipPackages().join(' ')}`);

export const SETUP_CMD = 'scripts/setup.sh';
const q = (p) => (/^[\w./~-]+$/.test(p) ? p : `"${p}"`);
export const setupCommand = (dir = INSTALL_DIR) => `cd ${q(dir)} && ${SETUP_CMD}`;
export const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

// 每项：zh / en 提示 + cmd（原始命令，次要）。venvExists：engine/.venv 在不在（libpython 的提示不同）
export function setupHints({ venvExists = existsSync(path.join(INSTALL_DIR, 'engine', '.venv')) } = {}) {
  const c = leanCommit();
  const LEAN_BUILD = `git clone https://github.com/QuantConnect/Lean.git engine/Lean${c ? ` && git -C engine/Lean checkout ${c}` : ''} && ~/.dotnet/dotnet build engine/Lean/Launcher/QuantConnect.Lean.Launcher.csproj -c Release`;
  const VENV = `uv venv --python 3.11 engine/.venv && ${pipCommand()}`;
  return {
    claude: {
      zh: `安装 Claude Code：在终端运行 ${CLAUDE_INSTALL} （也可以用 npm install -g @anthropic-ai/claude-code，但用 nodejs.org 安装包装的 Node 不加 sudo 会报 EACCES）。装好后运行一次 claude 登录，然后重启 Helm。claude 不在 PATH 里的话，在 helm 目录的 .env 里加一行 CLAUDE_BIN=/绝对路径/claude`,
      en: `Install Claude Code: run ${CLAUDE_INSTALL} in a terminal (npm install -g @anthropic-ai/claude-code also works, but fails with EACCES on Node from the nodejs.org installer unless you use sudo). Then run claude once to sign in, and restart Helm. If claude is not on your PATH, add CLAUDE_BIN=/absolute/path/to/claude to .env in the helm folder.`,
      cmd: CLAUDE_INSTALL,
    },
    dotnet: {
      zh: `在 helm 目录运行 ${SETUP_CMD}（会装好 .NET、LEAN 和 Python 环境）。装在别处的话，在 .env 里加一行 DOTNET_BIN=/绝对路径/dotnet`,
      en: `In the helm folder run ${SETUP_CMD} (it installs .NET, LEAN and the Python environment). If dotnet is installed elsewhere, add DOTNET_BIN=/absolute/path/to/dotnet to .env.`,
      cmd: 'curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir ~/.dotnet',
    },
    lean: {
      zh: `在 helm 目录运行 ${SETUP_CMD}（会下载并编译 LEAN 引擎）`,
      en: `In the helm folder run ${SETUP_CMD} (it downloads and builds the LEAN engine).`,
      cmd: LEAN_BUILD,
    },
    python: {
      zh: `在 helm 目录运行 ${SETUP_CMD}（会建好 engine/.venv 并装好依赖）`,
      en: `In the helm folder run ${SETUP_CMD} (it creates engine/.venv and installs the dependencies).`,
      cmd: VENV,
    },
    libpython: venvExists ? {
      zh: `engine/.venv 里的 Python 缺少 libpython 动态库（LEAN 要用）。用 uv 管理的 Python 3.11 重建：先把 engine/.venv 改名备份，再运行 ${SETUP_CMD}`,
      en: `The Python in engine/.venv lacks the libpython shared library LEAN needs. Rebuild it with a uv-managed Python 3.11: rename engine/.venv as a backup, then run ${SETUP_CMD}.`,
      cmd: `mv engine/.venv engine/.venv.bak && ${VENV}`,
    } : {
      zh: `先装好 Python 环境：在 helm 目录运行 ${SETUP_CMD}`,
      en: `Install the Python environment first: in the helm folder run ${SETUP_CMD}.`,
      cmd: VENV,
    },
  };
}
