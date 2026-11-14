#!/usr/bin/env bash
# Helm setup for macOS: implements the install steps of README.md (「安装」).
# Idempotent: every step checks first and skips what is already in place.
#
#   scripts/setup.sh --check    report only, change nothing
#   scripts/setup.sh            show each action and ask before doing it
#   scripts/setup.sh --yes      no prompts
#   scripts/setup.sh --force    continue on a non-macOS system (unsupported)
#
# Never uses sudo. Never reads or writes .env or data/.
set -euo pipefail

# Versions pinned by the README
DOTNET_CHANNEL="10.0"
DOTNET_MAJOR="10"
PY_VERSION="3.11"
PY_PACKAGES=(numpy==1.26.4 pandas==2.3.3 scipy==1.13.1 matplotlib==3.8.4 scikit-learn==1.6.1 statsmodels==0.14.6 yfinance)
PINNED_IMPORTS=(numpy pandas scipy matplotlib scikit-learn statsmodels)   # distribution names checked with importlib.metadata
LEAN_REPO="https://github.com/QuantConnect/Lean.git"
NODE_MIN=20

CHECK=0
YES=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --yes|-y) YES=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [ ! -f server.mjs ] || [ ! -f package.json ]; then
  echo "This does not look like the Helm repository root: $ROOT" >&2
  exit 2
fi

DOTNET="${DOTNET_BIN:-$HOME/.dotnet/dotnet}"
VENV_PY="$ROOT/engine/.venv/bin/python"
LEAN_DLL="$ROOT/engine/Lean/Launcher/bin/Release/QuantConnect.Lean.Launcher.dll"

MISSING_REQUIRED=()   # things this script cannot or did not fix
PENDING=()            # things --check found that a normal run would fix

say()  { printf '%s\n' "$*"; }
ok()   { printf '  [ok]      %s\n' "$*"; }
todo() { printf '  [missing] %s\n' "$*"; }
info() { printf '  [info]    %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

if [ "$(uname -s)" != "Darwin" ]; then
  if [ "$FORCE" -eq 1 ]; then
    say "Warning: not macOS. Continuing because of --force; Helm's sandbox and several checks assume macOS."
  else
    say "This installer supports macOS only (detected: $(uname -s))."
    say "Helm's sandboxing uses macOS sandbox-exec. Re-run with --force to try anyway (unsupported)."
    exit 1
  fi
fi

# confirm "what will happen": returns 0 to proceed, 1 to skip. In --check mode records the pending action.
confirm() {
  local what="$1"
  if [ "$CHECK" -eq 1 ]; then PENDING+=("$what"); return 1; fi
  say "  will do:  $what"
  if [ "$YES" -eq 1 ]; then return 0; fi
  if [ ! -t 0 ]; then say "  skipped:  not interactive and --yes not given"; return 1; fi
  local reply
  read -r -p "  proceed? [y/N] " reply || return 1
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

# ---------------------------------------------------------------- prerequisites
step "Prerequisites"

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$node_major" -ge "$NODE_MIN" ]; then ok "Node $(node -v)"; else
    todo "Node $(node -v) is older than $NODE_MIN; install Node $NODE_MIN or newer (nvm, Homebrew or nodejs.org)"
    MISSING_REQUIRED+=("node>=$NODE_MIN")
  fi
else
  todo "Node not found; install Node $NODE_MIN or newer (nvm, Homebrew or nodejs.org)"
  MISSING_REQUIRED+=("node")
fi

if command -v git >/dev/null 2>&1; then ok "$(git --version)"; else
  todo "git not found; run: xcode-select --install"
  MISSING_REQUIRED+=("git")
fi

if command -v claude >/dev/null 2>&1 || [ -n "${CLAUDE_BIN:-}" ]; then
  ok "claude command present ($(command -v "${CLAUDE_BIN:-claude}" 2>/dev/null || echo "$CLAUDE_BIN"))"
  info "This script cannot check that you are logged in; run 'claude' once if you have not."
else
  todo "claude not found. Install and log in yourself: npm install -g @anthropic-ai/claude-code, then run: claude"
  info "Not on PATH after installing? Put CLAUDE_BIN=/absolute/path/to/claude in .env (this script does not edit .env)."
  MISSING_REQUIRED+=("claude")
fi

if command -v uv >/dev/null 2>&1; then ok "uv $(uv --version 2>/dev/null | awk '{print $2}')"; else
  if command -v brew >/dev/null 2>&1; then
    if confirm "install uv with Homebrew: brew install uv"; then
      brew install uv && ok "uv installed" || { todo "brew install uv failed"; MISSING_REQUIRED+=("uv"); }
    else
      [ "$CHECK" -eq 1 ] && todo "uv not found (a normal run offers: brew install uv)" || MISSING_REQUIRED+=("uv")
    fi
  else
    todo "uv not found and Homebrew is not available; install uv from its documentation, then re-run"
    MISSING_REQUIRED+=("uv")
  fi
fi

# ---------------------------------------------------------------- .NET
step ".NET $DOTNET_MAJOR SDK"
dotnet_ok=0
if [ -x "$DOTNET" ]; then
  dv="$("$DOTNET" --version 2>/dev/null || true)"
  if [ "${dv%%.*}" = "$DOTNET_MAJOR" ]; then ok ".NET SDK $dv at $DOTNET"; dotnet_ok=1
  else info "found $DOTNET but version is '${dv:-unknown}', README pins $DOTNET_MAJOR"; fi
fi
if [ "$dotnet_ok" -eq 0 ]; then
  if command -v curl >/dev/null 2>&1 && confirm "install .NET SDK channel $DOTNET_CHANNEL into ~/.dotnet (curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel $DOTNET_CHANNEL --install-dir ~/.dotnet)"; then
    curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel "$DOTNET_CHANNEL" --install-dir "$HOME/.dotnet"
    DOTNET="$HOME/.dotnet/dotnet"
    [ -x "$DOTNET" ] && dotnet_ok=1 && ok ".NET SDK installed"
  else
    todo ".NET SDK $DOTNET_MAJOR missing"
    [ "$CHECK" -eq 1 ] || MISSING_REQUIRED+=("dotnet")
  fi
fi

# ---------------------------------------------------------------- LEAN
step "LEAN engine (engine/Lean)"
if [ -f "$LEAN_DLL" ]; then
  ok "LEAN is built"
else
  if [ -d engine/Lean/Launcher ]; then
    info "engine/Lean exists; skipping the clone"
    lean_cloned=1
  else
    lean_cloned=0
    if command -v git >/dev/null 2>&1 && confirm "clone LEAN: git clone --depth 1 $LEAN_REPO engine/Lean"; then
      git clone --depth 1 "$LEAN_REPO" engine/Lean && lean_cloned=1
    else
      todo "engine/Lean missing"
    fi
  fi
  if [ "$lean_cloned" -eq 1 ] && [ "$dotnet_ok" -eq 1 ]; then
    if confirm "build LEAN: $DOTNET build engine/Lean/Launcher/QuantConnect.Lean.Launcher.csproj -c Release (takes a while)"; then
      "$DOTNET" build engine/Lean/Launcher/QuantConnect.Lean.Launcher.csproj -c Release
      [ -f "$LEAN_DLL" ] && ok "LEAN built" || { todo "build finished but $LEAN_DLL is missing"; MISSING_REQUIRED+=("lean"); }
    else
      todo "LEAN is not built"
      [ "$CHECK" -eq 1 ] || MISSING_REQUIRED+=("lean")
    fi
  else
    todo "LEAN is not built (needs the clone and a .NET SDK first)"
    [ "$CHECK" -eq 1 ] || MISSING_REQUIRED+=("lean")
  fi
fi

# ---------------------------------------------------------------- Python
step "Python $PY_VERSION environment (engine/.venv)"
venv_ok=0
if [ -x "$VENV_PY" ]; then
  pv="$("$VENV_PY" -I -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || true)"
  if [ "$pv" = "$PY_VERSION" ]; then ok "engine/.venv is Python $pv"; venv_ok=1
  else info "engine/.venv is Python '${pv:-unknown}', README pins $PY_VERSION. Remove or rename engine/.venv yourself, then re-run (this script never deletes)."; MISSING_REQUIRED+=("python-version"); fi
fi
if [ ! -x "$VENV_PY" ]; then
  if command -v uv >/dev/null 2>&1 && confirm "create the venv: uv venv --python $PY_VERSION engine/.venv"; then
    uv venv --python "$PY_VERSION" engine/.venv && venv_ok=1
  else
    todo "engine/.venv missing"
    [ "$CHECK" -eq 1 ] || MISSING_REQUIRED+=("python")
  fi
fi
if [ "$venv_ok" -eq 1 ]; then
  # packages: compare pinned versions; yfinance only needs to be present
  need_pkgs=0
  for spec in "${PY_PACKAGES[@]}"; do
    name="${spec%%==*}"; want="${spec#*==}"
    if [ "$name" = "yfinance" ]; then want=""; fi
    have="$("$VENV_PY" -I -c "import importlib.metadata as m,sys
try: print(m.version('$name'))
except Exception: print('')" 2>/dev/null || true)"
    if [ -z "$have" ] || { [ -n "$want" ] && [ "$have" != "$want" ]; }; then need_pkgs=1; fi
  done
  if [ "$need_pkgs" -eq 0 ]; then ok "pinned packages present"; else
    if command -v uv >/dev/null 2>&1 && confirm "install packages: uv pip install --python engine/.venv/bin/python ${PY_PACKAGES[*]}"; then
      uv pip install --python "$VENV_PY" "${PY_PACKAGES[@]}"
    else
      todo "Python packages missing or at the wrong version"
      [ "$CHECK" -eq 1 ] || MISSING_REQUIRED+=("python-packages")
    fi
  fi
  # libpython: the same test the health check uses
  libpy="$("$VENV_PY" -I -c 'import sys,sysconfig,os
ver="%d.%d"%sys.version_info[:2]
p=os.path.join(sysconfig.get_config_var("LIBDIR") or "","libpython"+ver+(".dylib" if sys.platform=="darwin" else ".so"))
print(p if os.path.exists(p) else "")' 2>/dev/null || true)"
  if [ -n "$libpy" ]; then ok "libpython found"; else
    todo "libpython not found for engine/.venv. Rename or remove engine/.venv, recreate it with a uv-managed Python $PY_VERSION, and reinstall the packages (this script will not delete it)."
    MISSING_REQUIRED+=("libpython")
  fi
fi

# ---------------------------------------------------------------- optional pieces
step "Optional (not installed by this script)"
if [ -d "$HOME/.qlib/qlib_data/us_data" ]; then ok "qlib US data present (~/.qlib/qlib_data/us_data)"; else
  info "qlib US data not found. Only idea tests, factor research and index universes need it; see docs/GETTING-STARTED.md."
fi
if [ -x engine/qlib_research/run.sh ] || [ -f engine/qlib_research/run.sh ]; then
  if bash engine/qlib_research/run.sh --which-python >/dev/null 2>&1; then ok "a Python with qlib was found"; else
    info "no Python with qlib + lightgbm found (optional). Hint from run.sh: python3.12 -m pip install pyqlib lightgbm matplotlib yfinance"
  fi
fi
info "Alpaca paper keys are entered in the web page, never in this script."

# ---------------------------------------------------------------- summary
step "Summary"
if [ "$CHECK" -eq 1 ]; then
  if [ "${#PENDING[@]}" -gt 0 ]; then
    say "A normal run (scripts/setup.sh) would do:"
    for p in "${PENDING[@]}"; do say "  - $p"; done
  fi
  if [ "${#MISSING_REQUIRED[@]}" -gt 0 ]; then
    say "Things you must handle yourself: ${MISSING_REQUIRED[*]}"
  fi
  if [ "${#PENDING[@]}" -eq 0 ] && [ "${#MISSING_REQUIRED[@]}" -eq 0 ]; then say "Everything required is in place."; exit 0; fi
  exit 1
fi
if [ "${#MISSING_REQUIRED[@]}" -gt 0 ]; then
  say "Not finished. Still missing: ${MISSING_REQUIRED[*]}"
  say "Fix these (or re-run and answer yes), then run scripts/setup.sh --check."
  exit 1
fi
say "Required components are in place. Start Helm with: npm start   then open http://localhost:4377"
say "The page's environment check (/api/health) shows anything still missing."
