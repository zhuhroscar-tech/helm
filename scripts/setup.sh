#!/usr/bin/env bash
# Helm setup for macOS: implements the install steps of README.md.
# Idempotent: every step checks first and skips what is already in place.
#
#   scripts/setup.sh --check    report only, change nothing
#   scripts/setup.sh            show each action and ask before doing it
#   scripts/setup.sh --yes      no prompts
#   scripts/setup.sh --force    continue on a non-macOS system (unsupported)
#
# Never uses sudo. Never reads or writes .env or data/.
# Messages follow the system language (LANG starting with zh = Chinese, else English).
set -euo pipefail

# ---- Pinned versions. Change them here, nowhere else.
DOTNET_CHANNEL="10.0"
DOTNET_MAJOR="10"
PY_VERSION="3.11"
LEAN_REPO="https://github.com/QuantConnect/Lean.git"
LEAN_COMMIT="cc98c42f5543256cea0a33e4521401e42303b7d7"   # known-good LEAN commit (2026-11-06)
NODE_MIN=20
# Python packages: engine/requirements.txt (one name==version per line)

CHECK=0
YES=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --yes|-y) YES=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ---- language: m "English" "中文"
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in zh*) HELM_ZH=1 ;; *) HELM_ZH=0 ;; esac
m() { if [ "$HELM_ZH" -eq 1 ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [ ! -f server.mjs ] || [ ! -f package.json ]; then
  echo "$(m "This does not look like the Helm repository root: $ROOT" "这里不像是 Helm 仓库的根目录：$ROOT")" >&2
  exit 2
fi

DOTNET="${DOTNET_BIN:-$HOME/.dotnet/dotnet}"
VENV_PY="$ROOT/engine/.venv/bin/python"
LEAN_DLL="$ROOT/engine/Lean/Launcher/bin/Release/QuantConnect.Lean.Launcher.dll"
REQS="$ROOT/engine/requirements.txt"

MISSING_REQUIRED=()   # things this script cannot or did not fix
PENDING=()            # things --check found that a normal run would do

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [ok]      %s\n' "$*"; }
todo() { printf '  [%s] %s\n' "$(m 'missing' '缺少   ')" "$*"; }
info() { printf '  [info]    %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

if [ "$(uname -s)" != "Darwin" ]; then
  if [ "$FORCE" -eq 1 ]; then
    say "$(m "Warning: not macOS. Continuing because of --force; Helm's sandbox and several checks assume macOS." \
             "警告：不是 macOS。因为加了 --force 继续；Helm 的沙盒和好几项检查都假定是 macOS。")"
  else
    say "$(m "This installer supports macOS only (detected: $(uname -s))." "这个安装脚本只支持 macOS（当前系统：$(uname -s)）。")"
    say "$(m "Helm's sandboxing uses macOS sandbox-exec. Re-run with --force to try anyway (unsupported)." \
             "Helm 的沙盒依赖 macOS 的 sandbox-exec。一定要试的话加 --force（不受支持）。")"
    exit 1
  fi
fi

# confirm "what will happen": returns 0 to proceed, 1 to skip. In --check mode records the pending action.
confirm() {
  local what="$1"
  if [ "$CHECK" -eq 1 ]; then PENDING+=("$what"); return 1; fi
  say "  $(m 'will do: ' '将要做：') $what"
  if [ "$YES" -eq 1 ]; then return 0; fi
  if [ ! -t 0 ]; then say "  $(m 'skipped:  not interactive and --yes not given' '跳过：不是交互终端，也没有加 --yes')"; return 1; fi
  local reply
  read -r -p "  $(m 'proceed? [y/N] ' '继续吗？[y/N] ')" reply || return 1
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}
# pending "what": in --check mode, record a step that a normal run would do later (after an earlier step)
pending() { [ "$CHECK" -eq 1 ] && PENDING+=("$1"); return 0; }

# ---------------------------------------------------------------- prerequisites
step "$(m 'Prerequisites' '前置条件')"

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$node_major" -ge "$NODE_MIN" ]; then ok "Node $(node -v)"; else
    todo "$(m "Node $(node -v) is older than $NODE_MIN; install Node $NODE_MIN or newer (Homebrew, nvm or nodejs.org)" \
              "Node $(node -v) 低于 $NODE_MIN；请装 Node $NODE_MIN 或更新版本（Homebrew、nvm 或 nodejs.org）")"
    MISSING_REQUIRED+=("node>=$NODE_MIN")
  fi
else
  todo "$(m "Node not found; install Node $NODE_MIN or newer (Homebrew, nvm or nodejs.org)" \
            "找不到 Node；请装 Node $NODE_MIN 或更新版本（Homebrew、nvm 或 nodejs.org）")"
  MISSING_REQUIRED+=("node")
fi

if command -v git >/dev/null 2>&1; then ok "$(git --version)"; else
  todo "$(m 'git not found; run: xcode-select --install' '找不到 git；运行：xcode-select --install')"
  MISSING_REQUIRED+=("git")
fi

if command -v claude >/dev/null 2>&1 || [ -n "${CLAUDE_BIN:-}" ]; then
  ok "$(m 'claude command present' '找到 claude 命令') ($(command -v "${CLAUDE_BIN:-claude}" 2>/dev/null || echo "$CLAUDE_BIN"))"
  info "$(m "This script cannot check that you are logged in; run 'claude' once if you have not." \
            "这个脚本查不了你有没有登录；没登录过的话先运行一次 claude。")"
else
  todo "$(m 'claude (Claude Code) not found. Install it yourself: curl -fsSL https://claude.ai/install.sh | bash   then run: claude   (to log in)' \
            '找不到 claude（Claude Code）。请自己安装：curl -fsSL https://claude.ai/install.sh | bash   然后运行 claude 登录')"
  info "$(m 'Not on PATH after installing? Open a new terminal, or put CLAUDE_BIN=/absolute/path/to/claude in .env (copy .env.example; this script does not edit .env).' \
            '装好后还找不到？开一个新终端，或者在 .env 里写 CLAUDE_BIN=/claude/的/绝对路径（从 .env.example 复制；这个脚本不改 .env）。')"
  MISSING_REQUIRED+=("claude")
fi

UV_URL="https://docs.astral.sh/uv/getting-started/installation/"
if command -v uv >/dev/null 2>&1; then ok "uv $(uv --version 2>/dev/null | awk '{print $2}')"; else
  if command -v brew >/dev/null 2>&1; then
    if confirm "$(m 'install uv with Homebrew: brew install uv (~40 MB, <1 min)' '用 Homebrew 装 uv：brew install uv（约 40 MB，不到 1 分钟）')"; then
      brew install uv && ok "$(m 'uv installed' 'uv 已安装')" || { todo "$(m 'brew install uv failed' 'brew install uv 失败')"; MISSING_REQUIRED+=("uv"); }
    else
      [ "$CHECK" -eq 1 ] && todo "$(m 'uv not found' '找不到 uv')" || MISSING_REQUIRED+=("uv")
    fi
  else
    todo "$(m "uv not found and Homebrew is not available. Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh   (details: $UV_URL), then open a new terminal and re-run" \
              "找不到 uv，也没有 Homebrew。安装 uv：curl -LsSf https://astral.sh/uv/install.sh | sh   （说明：$UV_URL），然后开一个新终端再运行本脚本")"
    MISSING_REQUIRED+=("uv")
  fi
fi
have_uv=0; command -v uv >/dev/null 2>&1 && have_uv=1

# ---------------------------------------------------------------- .NET
step ".NET $DOTNET_MAJOR SDK"
dotnet_ok=0
if [ -x "$DOTNET" ]; then
  dv="$("$DOTNET" --version 2>/dev/null || true)"
  if [ "${dv%%.*}" = "$DOTNET_MAJOR" ]; then ok ".NET SDK $dv ($DOTNET)"; dotnet_ok=1
  else info "$(m "found $DOTNET but version is '${dv:-unknown}', Helm needs $DOTNET_MAJOR" "找到 $DOTNET，但版本是 '${dv:-未知}'，Helm 需要 $DOTNET_MAJOR")"; fi
fi
if [ "$dotnet_ok" -eq 0 ]; then
  if command -v curl >/dev/null 2>&1 && confirm "$(m "install .NET SDK $DOTNET_CHANNEL into ~/.dotnet (~650 MB on disk, 2-5 min): curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel $DOTNET_CHANNEL --install-dir ~/.dotnet" \
                                                     "把 .NET SDK $DOTNET_CHANNEL 装到 ~/.dotnet（占用约 650 MB，2–5 分钟）：curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel $DOTNET_CHANNEL --install-dir ~/.dotnet")"; then
    curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel "$DOTNET_CHANNEL" --install-dir "$HOME/.dotnet"
    DOTNET="$HOME/.dotnet/dotnet"
    [ -x "$DOTNET" ] && dotnet_ok=1 && ok "$(m '.NET SDK installed' '.NET SDK 已安装')"
  else
    todo "$(m ".NET SDK $DOTNET_MAJOR missing" "缺少 .NET SDK $DOTNET_MAJOR")"
    [ "$CHECK" -eq 1 ] || MISSING_REQUIRED+=("dotnet")
  fi
fi

# ---------------------------------------------------------------- LEAN
step "$(m 'LEAN engine (engine/Lean)' 'LEAN 回测引擎（engine/Lean）')"
LEAN_BUILD_MSG="$(m "build LEAN: $DOTNET build engine/Lean/Launcher/QuantConnect.Lean.Launcher.csproj -c Release (3-10 min)" \
                    "编译 LEAN：$DOTNET build engine/Lean/Launcher/QuantConnect.Lean.Launcher.csproj -c Release（3–10 分钟）")"
if [ -f "$LEAN_DLL" ]; then
  ok "$(m 'LEAN is built' 'LEAN 已编译')"
  have="$(git -C engine/Lean rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$have" ] && [ "$have" != "$LEAN_COMMIT" ]; then
    info "$(m "engine/Lean is at ${have:0:12}, Helm is tested with ${LEAN_COMMIT:0:12}. Keeping yours." \
              "engine/Lean 的版本是 ${have:0:12}，Helm 测试过的是 ${LEAN_COMMIT:0:12}。保留你现有的。")"
  fi
else
  lean_cloned=0
  if [ -d engine/Lean/Launcher ]; then
    info "$(m 'engine/Lean exists; skipping the download' 'engine/Lean 已存在，跳过下载')"
    lean_cloned=1
  elif [ -d engine/Lean ] && [ ! -d engine/Lean/.git ] && [ -n "$(ls -A engine/Lean 2>/dev/null)" ]; then
    todo "$(m 'engine/Lean exists but is not a LEAN checkout. Move it away yourself, then re-run (this script never deletes).' \
              'engine/Lean 存在，但不是 LEAN 源码。请自己挪走，再重新运行（这个脚本从不删除文件）。')"
    MISSING_REQUIRED+=("lean")
  elif command -v git >/dev/null 2>&1 && confirm "$(m "download LEAN ${LEAN_COMMIT:0:12} into engine/Lean (~950 MB incl. sample data, 2-10 min depending on network)" \
                                                     "下载 LEAN ${LEAN_COMMIT:0:12} 到 engine/Lean（约 950 MB，含示例数据，2–10 分钟，看网速）")"; then
    # Fetch exactly the pinned commit (shallow). Safe to re-run after an interrupted download.
    mkdir -p engine/Lean
    git -C engine/Lean init -q
    git -C engine/Lean remote add origin "$LEAN_REPO" 2>/dev/null || git -C engine/Lean remote set-url origin "$LEAN_REPO"
    if git -C engine/Lean fetch --depth 1 origin "$LEAN_COMMIT" && git -C engine/Lean checkout -q FETCH_HEAD; then
      lean_cloned=1; ok "$(m "LEAN ${LEAN_COMMIT:0:12} downloaded" "LEAN ${LEAN_COMMIT:0:12} 已下载")"
    else
      todo "$(m 'LEAN download failed; check the network and re-run' 'LEAN 下载失败；检查网络后重新运行')"
      MISSING_REQUIRED+=("lean")
    fi
  else
    todo "$(m 'engine/Lean missing' '缺少 engine/Lean')"
    [ "$CHECK" -eq 1 ] || MISSING_REQUIRED+=("lean")
  fi
  if [ "$lean_cloned" -eq 1 ] && [ "$dotnet_ok" -eq 1 ]; then
    if confirm "$LEAN_BUILD_MSG"; then
      "$DOTNET" build engine/Lean/Launcher/QuantConnect.Lean.Launcher.csproj -c Release
      [ -f "$LEAN_DLL" ] && ok "$(m 'LEAN built' 'LEAN 编译完成')" || { todo "$(m "build finished but $LEAN_DLL is missing" "编译结束，但没有 $LEAN_DLL")"; MISSING_REQUIRED+=("lean"); }
    else
      [ "$CHECK" -eq 1 ] || { todo "$(m 'LEAN is not built' 'LEAN 还没编译')"; MISSING_REQUIRED+=("lean"); }
    fi
  elif [ "$CHECK" -eq 1 ]; then
    todo "$(m 'LEAN is not built' 'LEAN 还没编译')"
    pending "$LEAN_BUILD_MSG"
  else
    todo "$(m 'LEAN is not built yet: it needs the LEAN download and the .NET SDK first' 'LEAN 还没编译：要先下载 LEAN 并装好 .NET SDK')"
    MISSING_REQUIRED+=("lean")
  fi
fi

# ---------------------------------------------------------------- Python
step "$(m "Python $PY_VERSION environment (engine/.venv)" "Python $PY_VERSION 环境（engine/.venv）")"
PIP_MSG="$(m "install Python packages: uv pip install --python engine/.venv/bin/python -r engine/requirements.txt (~370 MB, 1-3 min)" \
             "安装 Python 包：uv pip install --python engine/.venv/bin/python -r engine/requirements.txt（约 370 MB，1–3 分钟）")"
venv_ok=0
if [ -x "$VENV_PY" ]; then
  pv="$("$VENV_PY" -I -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || true)"
  if [ "$pv" = "$PY_VERSION" ]; then ok "$(m "engine/.venv is Python $pv" "engine/.venv 是 Python $pv")"; venv_ok=1
  else
    info "$(m "engine/.venv is Python '${pv:-unknown}', Helm needs $PY_VERSION. Remove or rename engine/.venv yourself, then re-run (this script never deletes)." \
              "engine/.venv 是 Python '${pv:-未知}'，Helm 需要 $PY_VERSION。请自己删除或改名 engine/.venv，再重新运行（这个脚本从不删除文件）。")"
    MISSING_REQUIRED+=("python-version")
  fi
fi
if [ ! -x "$VENV_PY" ]; then
  if [ "$have_uv" -eq 1 ] && confirm "$(m "create the venv: uv venv --python $PY_VERSION engine/.venv (uv downloads Python $PY_VERSION if needed, ~60 MB)" \
                                          "建虚拟环境：uv venv --python $PY_VERSION engine/.venv（需要时 uv 会下载 Python $PY_VERSION，约 60 MB）")"; then
    uv venv --python "$PY_VERSION" engine/.venv && venv_ok=1
  elif [ "$CHECK" -eq 1 ]; then
    todo "$(m 'engine/.venv missing' '缺少 engine/.venv')"
    [ "$have_uv" -eq 1 ] || pending "$(m "create the venv: uv venv --python $PY_VERSION engine/.venv (after installing uv)" "建虚拟环境：uv venv --python $PY_VERSION engine/.venv（装好 uv 之后）")"
    pending "$PIP_MSG"
  else
    todo "$(m 'engine/.venv missing' '缺少 engine/.venv')"
    MISSING_REQUIRED+=("python")
  fi
fi
if [ "$venv_ok" -eq 1 ]; then
  # packages: every name==version line of engine/requirements.txt must match exactly
  bad="$("$VENV_PY" -I -c 'import sys, importlib.metadata as m
bad = []
for line in open(sys.argv[1]):
    line = line.split("#")[0].strip()
    if not line: continue
    name, _, want = line.partition("==")
    try: have = m.version(name.strip())
    except Exception: have = ""
    if have != want.strip(): bad.append(name.strip())
print(" ".join(bad))' "$REQS" 2>/dev/null || echo "?")"
  if [ -z "$bad" ]; then ok "$(m 'packages in engine/requirements.txt are installed' 'engine/requirements.txt 里的包都已装好')"; else
    info "$(m "missing or wrong version: $bad" "缺少或版本不对：$bad")"
    if [ "$have_uv" -eq 1 ] && confirm "$PIP_MSG"; then
      uv pip install --python "$VENV_PY" -r "$REQS"
    else
      [ "$CHECK" -eq 1 ] || { todo "$(m 'Python packages missing or at the wrong version' 'Python 包缺少或版本不对')"; MISSING_REQUIRED+=("python-packages"); }
    fi
  fi
  # libpython: the same test the health check uses
  libpy="$("$VENV_PY" -I -c 'import sys,sysconfig,os
ver="%d.%d"%sys.version_info[:2]
p=os.path.join(sysconfig.get_config_var("LIBDIR") or "","libpython"+ver+(".dylib" if sys.platform=="darwin" else ".so"))
print(p if os.path.exists(p) else "")' 2>/dev/null || true)"
  if [ -n "$libpy" ]; then ok "$(m 'libpython found' '找到 libpython')"; else
    todo "$(m "libpython not found for engine/.venv. Rename or remove engine/.venv, then re-run (it will be recreated with a uv-managed Python $PY_VERSION; this script never deletes)." \
              "engine/.venv 找不到 libpython。请把 engine/.venv 改名或删掉，再重新运行（会用 uv 管理的 Python $PY_VERSION 重建；这个脚本从不删除文件）。")"
    MISSING_REQUIRED+=("libpython")
  fi
fi

# ---------------------------------------------------------------- optional pieces
step "$(m 'Optional (not installed by this script)' '选装（这个脚本不装）')"
if [ -d "$HOME/.qlib/qlib_data/us_data" ]; then ok "$(m 'qlib US data present' '有 qlib 美股数据') (~/.qlib/qlib_data/us_data)"; else
  info "$(m 'qlib US data not found (optional extra for stock-picking research; see docs/GETTING-STARTED.md).' \
            '没有 qlib 美股数据（选股研究的选装数据，见 docs/GETTING-STARTED.zh.md）。')"
fi
if [ -f engine/qlib_research/run.sh ]; then
  if bash engine/qlib_research/run.sh --which-python >/dev/null 2>&1; then ok "$(m 'a Python with qlib was found' '找到装了 qlib 的 Python')"; else
    info "$(m 'no Python with qlib + lightgbm found (optional; uv venv --python 3.11 engine/.qlib-venv, see the qlib section of docs/GETTING-STARTED.md)' \
              '没找到装了 qlib + lightgbm 的 Python（选装：uv venv --python 3.11 engine/.qlib-venv，见 docs/GETTING-STARTED.zh.md 的 qlib 一节）')"
  fi
fi
if [ -x /Applications/LibreOffice.app/Contents/MacOS/soffice ] || command -v soffice >/dev/null 2>&1; then
  ok "$(m 'LibreOffice found (research decks can be exported as PDF)' '找到 LibreOffice（研发汇报可以导出 PDF）')"
else
  info "$(m 'LibreOffice not found: research decks are made as PowerPoint only. For PDF: brew install --cask libreoffice' \
            '没有 LibreOffice：研发汇报只出 PowerPoint。要 PDF 的话：brew install --cask libreoffice')"
fi
info "$(m 'Alpaca paper keys are entered in the web page, never in this script.' 'Alpaca 模拟盘的密钥在网页上填，不在这个脚本里。')"

# ---------------------------------------------------------------- summary
step "$(m 'Summary' '总结')"
if [ "$CHECK" -eq 1 ]; then
  if [ "${#PENDING[@]}" -gt 0 ]; then
    say "$(m 'A normal run (scripts/setup.sh) would do, in order:' '正式运行（scripts/setup.sh）会依次做：')"
    for p in "${PENDING[@]}"; do say "  - $p"; done
    say "$(m 'A full first install needs about 2-3 GB of disk and 15-30 minutes, depending on your network.' \
             '第一次完整安装大约要 2–3 GB 硬盘空间、15–30 分钟（看网速）。')"
  fi
  if [ "${#MISSING_REQUIRED[@]}" -gt 0 ]; then
    say "$(m 'Things you must handle yourself:' '需要你自己处理的：') ${MISSING_REQUIRED[*]}"
  fi
  if [ "${#PENDING[@]}" -eq 0 ] && [ "${#MISSING_REQUIRED[@]}" -eq 0 ]; then say "$(m 'Everything required is in place.' '必需的组件都已就绪。')"; exit 0; fi
  exit 1
fi
if [ "${#MISSING_REQUIRED[@]}" -gt 0 ]; then
  say "$(m 'Not finished. Still missing:' '还没装完，仍缺少：') ${MISSING_REQUIRED[*]}"
  say "$(m 'Fix these (or re-run and answer yes), then run scripts/setup.sh --check.' '补上这些（或重新运行并回答 y），然后运行 scripts/setup.sh --check。')"
  exit 1
fi
say "$(m 'Required components are in place.' '必需的组件都已就绪。')"
say "$(m 'Start Helm with: npm start   then open http://localhost:4377' '启动 Helm：npm start   然后打开 http://localhost:4377')"
say "$(m "The page's environment check shows anything still missing." '网页上的环境体检会列出还缺什么。')"
