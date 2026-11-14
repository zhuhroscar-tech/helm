#!/bin/bash
# Launcher for the quant-strategy engine.
# Finds an existing Python that already has qlib + lightgbm (reuse, don't reinstall),
# caches the choice, and runs qs_pipeline.py from a neutral directory so a cloned
# `qlib/` source folder in the project can never shadow the installed package.
#
#   run.sh run --target QQQ --workdir "/path/to/project"
#   run.sh status --target QQQ --workdir "/path/to/project"
#   run.sh run --target QQQ --workdir DIR --idea-file idea.json   # idea test (dev period only)
#   run.sh --which-python        # print the interpreter that would be used
#   run.sh --test                # run the engine's unit tests
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$HOME/.cache/quant-strategy"
mkdir -p "$CACHE_DIR"

has_stack() {
  "$1" -I -c "import qlib, lightgbm, pandas, numpy, matplotlib" >/dev/null 2>&1
}

find_python() {
  if [ -n "${QS_PYTHON:-}" ] && has_stack "$QS_PYTHON"; then echo "$QS_PYTHON"; return 0; fi
  if [ -f "$CACHE_DIR/python" ]; then
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
    if [ -x "$c" ] && has_stack "$c"; then echo "$c" > "$CACHE_DIR/python"; echo "$c"; return 0; fi
  done
  return 1
}

PY="$(find_python || true)"
if [ -z "$PY" ]; then
  echo "No Python with qlib+lightgbm+pandas+matplotlib found." >&2
  echo "Install into ONE interpreter (Python 3.8-3.12), e.g.:" >&2
  echo "  python3.12 -m pip install pyqlib lightgbm matplotlib yfinance" >&2
  echo "then re-run, or set QS_PYTHON=/path/to/python." >&2
  exit 3
fi

case "${1:-}" in
  --which-python) echo "$PY"; exit 0 ;;
  --test) cd /tmp && "$PY" "$HERE/test_qs_core.py" && "$PY" "$HERE/test_qs_data.py" && "$PY" "$HERE/test_qs_fund.py" && "$PY" "$HERE/test_qs_idea.py" && exec "$PY" "$HERE/test_qs_qlib.py" ;;
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
