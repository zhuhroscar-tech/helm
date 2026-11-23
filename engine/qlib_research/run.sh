#!/bin/bash
# Launcher for the quant-strategy engine.
#
# Light jobs (idea tests --idea-file, universe exports --stop-after data/design, status) need only
# pandas + numpy + matplotlib (+ yfinance to download prices): formulas run in qs_expr, no qlib.
# They prefer engine/.venv (Helm's own environment), then the same list as below.
#
# Full factor research needs qlib + lightgbm. Picks the Python for it in this order:
#   1. QS_PYTHON (if it has the stack)
#   2. engine/.qlib-venv/bin/python   <- recommended dedicated env
#   3. engine/.venv/bin/python        (if someone installed qlib there)
#   4. the cached / system-wide search (legacy fallback)
# and runs qs_pipeline.py from a neutral directory so a cloned `qlib/` source
# folder in the project can never shadow the installed package.
#
# Create the dedicated env (Python 3.8-3.12; qlib has no wheels for newer):
#   uv venv --python 3.11 engine/.qlib-venv
#   uv pip install --python engine/.qlib-venv/bin/python pyqlib lightgbm matplotlib yfinance
#
#   run.sh run --target QQQ --workdir "/path/to/project"
#   run.sh status --target QQQ --workdir "/path/to/project"
#   run.sh run --target QQQ --workdir DIR --idea-file idea.json   # idea test (dev period only)
#   run.sh --which-python        # print the interpreter that full research would use
#   run.sh --which-python-light  # print the interpreter that idea tests / exports would use
#   run.sh --test                # run the engine's unit tests
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$HOME/.cache/quant-strategy"
mkdir -p "$CACHE_DIR"

LIGHT=0; prev=""
for a in "$@"; do
  case "$a" in --idea-file|--which-python-light) LIGHT=1 ;; esac
  if [ "$prev" = "--stop-after" ]; then case "$a" in env|universe|data|design) LIGHT=1 ;; esac; fi
  prev="$a"
done
[ "${1:-}" = "status" ] && LIGHT=1

has_stack() {
  if [ "$LIGHT" = 1 ]; then
    "$1" -I -c "import pandas, numpy, matplotlib" >/dev/null 2>&1
  else
    "$1" -I -c "import qlib, lightgbm, pandas, numpy, matplotlib" >/dev/null 2>&1
  fi
}

ENGINE_DIR="$(cd "$HERE/.." && pwd)"
QLIB_VENV="$ENGINE_DIR/.qlib-venv/bin/python"

find_python() {
  if [ -n "${QS_PYTHON:-}" ] && has_stack "$QS_PYTHON"; then echo "$QS_PYTHON"; return 0; fi
  # dedicated envs first: never silently pick some unrelated system Python when one of these works
  local order=("$QLIB_VENV" "$ENGINE_DIR/.venv/bin/python")
  if [ "$LIGHT" = 1 ]; then order=("$ENGINE_DIR/.venv/bin/python" "$QLIB_VENV"); fi
  for c in "${order[@]}"; do
    if [ -x "$c" ] && has_stack "$c"; then echo "$c"; return 0; fi
  done
  if [ "$LIGHT" = 0 ] && [ -f "$CACHE_DIR/python" ]; then
    local c; c="$(cat "$CACHE_DIR/python")"
    if [ -x "$c" ] && has_stack "$c"; then echo "$c"; return 0; fi
  fi
  local cands=()
  for v in 3.12 3.11 3.10 3.9 3.8; do
    cands+=("/Library/Frameworks/Python.framework/Versions/$v/bin/python$v" "/opt/homebrew/bin/python$v" "/usr/local/bin/python$v")
  done
  for n in python3.12 python3.11 python3.10 python3.9 python3.8 python3 python; do
    while IFS= read -r p; do cands+=("$p"); done < <(which -a "$n" 2>/dev/null || true)
  done
  for d in "$HOME"/miniconda3/envs/*/bin/python "$HOME"/anaconda3/envs/*/bin/python "$HOME"/miniforge3/envs/*/bin/python \
           "$HOME"/.pyenv/versions/*/bin/python "$HOME"/miniconda3/bin/python "$HOME"/anaconda3/bin/python; do
    [ -x "$d" ] && cands+=("$d")
  done
  for c in "${cands[@]}"; do
    if [ -x "$c" ] && has_stack "$c"; then [ "$LIGHT" = 0 ] && echo "$c" > "$CACHE_DIR/python"; echo "$c"; return 0; fi
  done
  return 1
}

PY="$(find_python || true)"
if [ -z "$PY" ] && [ "$LIGHT" = 1 ]; then
  {
    echo "No Python with pandas + numpy + matplotlib was found for idea tests / universe exports."
    echo "Helm's own environment engine/.venv has them: from the Helm folder run  npm run doctor  and follow it."
    echo "Or set QS_PYTHON=/path/to/python in .env."
  } >&2
  exit 3
fi
if [ -z "$PY" ]; then
  {
    echo "qlib is not installed: no Python with qlib + lightgbm + pandas + matplotlib was found."
    echo "Only full factor research needs it; idea tests and universe exports run without qlib."
    if [ -n "${QS_PYTHON:-}" ]; then echo "QS_PYTHON=$QS_PYTHON is set but cannot import those packages."; fi
    if [ -x "$QLIB_VENV" ]; then
      echo "engine/.qlib-venv exists but is missing packages. Install them with:"
      echo "  uv pip install --python \"$QLIB_VENV\" pyqlib lightgbm matplotlib yfinance"
    else
      echo "Create the dedicated research environment (Python 3.8-3.12), from the Helm folder:"
      echo "  uv venv --python 3.11 engine/.qlib-venv"
      echo "  uv pip install --python engine/.qlib-venv/bin/python pyqlib lightgbm matplotlib yfinance"
    fi
    echo "Then re-run, or set QS_PYTHON=/path/to/python in .env."
  } >&2
  exit 3
fi

case "${1:-}" in
  --which-python|--which-python-light) echo "$PY"; exit 0 ;;
  --test) cd /tmp && "$PY" "$HERE/test_qs_core.py" && "$PY" "$HERE/test_qs_data.py" && "$PY" "$HERE/test_qs_fund.py" && "$PY" "$HERE/test_qs_idea.py" \
            && "$PY" "$HERE/test_qs_expr.py" && "$PY" "$HERE/test_qs_light.py" && exec "$PY" "$HERE/test_qs_qlib.py" ;;
esac

# Resolve --workdir to an absolute path before changing directory.
args=(); prev=""
for a in "$@"; do
  if [ "$prev" = "--workdir" ]; then mkdir -p "$a"; a="$(cd "$a" && pwd)"; fi
  if [ "$prev" = "--membership-file" ]; then a="$(cd "$(dirname "$a")" && pwd)/$(basename "$a")"; fi
  args+=("$a"); prev="$a"
done
if [[ " ${args[*]} " != *" --workdir "* ]]; then args+=("--workdir" "$(pwd)"); fi
cd /tmp
exec "$PY" "$HERE/qs_pipeline.py" "${args[@]}"
