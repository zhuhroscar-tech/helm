#!/usr/bin/env bash
# Helm one-line installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/zhuhroscar-tech/helm/main/install.sh | bash
#
# What it does (asks before every step that changes something; never uses sudo):
#   1. checks macOS, git and Node 20+ (offers Homebrew's Node if Node is missing)
#   2. offers to install Claude Code with Anthropic's official installer if `claude` is missing
#   3. downloads Helm into ~/Helm (or updates it there if it is already installed)
#   4. runs scripts/setup.sh (.NET, Python, the LEAN engine, data folders)
#   5. offers to build the Helm Mac app, then opens Helm
# Run it again at any time to update. Nothing is changed outside ~/Helm, ~/.dotnet, the
# Python/uv caches, Claude Code's own folder and (if you agree) /Applications/Helm.app.
#
# Options (environment variables, or flags when you run the file directly: bash install.sh --yes):
#   HELM_DIR=~/Helm        where to install           HELM_YES=1 / --yes      answer yes to every question
#   HELM_BRANCH=main       which branch to install    HELM_NO_APP=1 / --no-app  don't build the Mac app
#   HELM_REPO=<git url>    install from a fork        HELM_NO_START=1 / --no-start  don't open Helm at the end
#
# Note: --yes also says yes to running the official installers it would otherwise ask about (Anthropic's
# Claude Code installer and, in scripts/setup.sh, Microsoft's dotnet-install.sh), fetched with curl.
# Updating an existing install fetches from its own `origin` remote (HELM_REPO is only used for a fresh clone).
#
# Messages follow your system language (LANG starting with zh = Chinese, else English).

# Everything is inside main(), called on the last line: if the download is cut off halfway,
# bash never runs a partial script.
main() {
  set -euo pipefail

  local REPO="${HELM_REPO:-https://github.com/zhuhroscar-tech/helm.git}"
  local BRANCH="${HELM_BRANCH:-main}"
  local DIR="${HELM_DIR:-$HOME/Helm}"
  local YES="${HELM_YES:-0}" NO_APP="${HELM_NO_APP:-0}" NO_START="${HELM_NO_START:-0}"
  local arg
  for arg in "$@"; do
    case "$arg" in
      --yes|-y) YES=1 ;;
      --no-app) NO_APP=1 ;;
      --no-start) NO_START=1 ;;
      -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//' || true; return 0 ;;
      *) echo "Unknown option: $arg (try --help)" >&2; return 2 ;;
    esac
  done

  local ZH=0
  case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in zh*) ZH=1 ;; esac
  m() { if [ "$ZH" -eq 1 ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
  say()  { printf '%s\n' "$*"; }
  step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
  fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

  # With `curl | bash`, stdin is the script itself, not the keyboard. Questions (and scripts/setup.sh)
  # read from the terminal instead; without a terminal you must pass HELM_YES=1.
  local TTY=""
  if [ -t 0 ]; then TTY=/dev/stdin; elif (exec </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi
  if [ -z "$TTY" ] && [ "$YES" != "1" ]; then
    fail "$(m 'No terminal to ask questions in. Run this in Terminal, or set HELM_YES=1 to answer yes to everything.' \
              '没有可以提问的终端。请在「终端」里运行，或者设置 HELM_YES=1 自动回答「是」。')"
  fi
  ask() { # ask "question" → 0 = yes
    if [ "$YES" = "1" ]; then say "  $1 $(m '[yes]' '[是]')"; return 0; fi
    local reply=""
    read -r -p "  $1 [y/N] " reply <"$TTY" || return 1
    [ "$reply" = "y" ] || [ "$reply" = "Y" ]
  }

  say "$(m 'Helm installer — a local quant research console (macOS).' 'Helm 安装程序：本机量化研究控制台（macOS）。')"
  say "$(m "Install folder: $DIR    Source: $REPO ($BRANCH)" "安装位置：$DIR    来源：${REPO}（${BRANCH}）")"

  # ---------------------------------------------------------------- 1. system
  step "$(m 'Checking your Mac' '检查这台 Mac')"
  [ "$(uname -s)" = "Darwin" ] || fail "$(m "Helm runs on macOS only (this is $(uname -s))." "Helm 只支持 macOS（当前系统：$(uname -s)）。")"
  say "  macOS $(sw_vers -productVersion 2>/dev/null || echo '?') · $(uname -m)"

  if ! command -v git >/dev/null 2>&1; then
    say "  $(m 'git is missing. macOS will now offer to install the Command Line Tools; when that finishes, run this installer again.' \
               '缺少 git。macOS 接下来会弹窗安装「命令行工具」；装好后再运行一次这个安装程序。')"
    xcode-select --install >/dev/null 2>&1 || true
    exit 1
  fi
  say "  [ok] $(git --version)"

  local node_major=0
  if command -v node >/dev/null 2>&1; then node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; fi
  if [ "$node_major" -lt 20 ]; then
    if command -v brew >/dev/null 2>&1 && ask "$(m 'Node 20+ is needed. Install it with Homebrew (brew install node)?' '需要 Node 20 或更新版本。用 Homebrew 安装（brew install node）吗？')"; then
      brew install node
      hash -r
      node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    fi
    [ "$node_major" -ge 20 ] || fail "$(m 'Node 20 or newer is required. Install it from https://nodejs.org (LTS), open a new Terminal window and run this installer again.' \
                                        '需要 Node 20 或更新版本。请从 https://nodejs.org 安装（LTS 版），开一个新的终端窗口，再运行一次这个安装程序。')"
  fi
  say "  [ok] Node $(node -v)"

  # ---------------------------------------------------------------- 2. Claude Code
  step "Claude Code"
  # The official installer puts claude in ~/.local/bin, which may not be on PATH in this shell yet
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) [ -d "$HOME/.local/bin" ] && PATH="$HOME/.local/bin:$PATH" ;; esac
  local need_login=0
  if command -v claude >/dev/null 2>&1; then
    say "  [ok] $(command -v claude)"
  else
    say "  $(m "Helm's agents run on Claude Code, which needs a Claude subscription (Pro / Max / Team) or Anthropic API credit." \
               'Helm 的智能体跑在 Claude Code 上，需要 Claude 订阅（Pro / Max / Team）或 Anthropic API 额度。')"
    if ask "$(m "Install Claude Code with Anthropic's official installer (curl -fsSL https://claude.ai/install.sh | bash)?" \
                '用 Anthropic 官方安装程序安装 Claude Code（curl -fsSL https://claude.ai/install.sh | bash）吗？')"; then
      curl -fsSL https://claude.ai/install.sh | bash
      PATH="$HOME/.local/bin:$PATH"; hash -r
    fi
    command -v claude >/dev/null 2>&1 || fail "$(m 'Claude Code is required. Install it (https://claude.ai/install.sh), then run this installer again.' \
                                                   '需要 Claude Code。请先安装（https://claude.ai/install.sh），再运行一次这个安装程序。')"
    need_login=1
    say "  [ok] $(command -v claude)"
  fi

  # ---------------------------------------------------------------- 3. download / update Helm
  step "$(m 'Getting Helm' '获取 Helm')"
  if [ -d "$DIR/.git" ]; then
    [ -f "$DIR/server.mjs" ] && [ -f "$DIR/scripts/setup.sh" ] || fail "$(m "$DIR is a git folder but not Helm. Set HELM_DIR to another folder." "$DIR 是一个 git 文件夹，但不是 Helm。请用 HELM_DIR 换一个文件夹。")"
    if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
      say "  $(m 'Helm is already installed and has local code changes, so it was not updated (your changes are kept).' \
                 'Helm 已经装过，而且代码有本地改动，所以这次没有更新（你的改动保持不变）。')"
    elif [ "$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)" != "$BRANCH" ]; then
      # 用户自己切到了别的分支：不替他切回来
      say "  $(m "Helm is already installed on another branch ($(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)), so it was not updated." \
                 "Helm 已经装过，现在在另一个分支（$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)）上，所以这次没有更新。")"
    else
      say "  $(m 'Already installed: updating' '已经装过：更新到最新') (${BRANCH})"
      if git -C "$DIR" fetch --quiet origin "$BRANCH"; then
        git -C "$DIR" merge --ff-only --quiet "origin/$BRANCH" || say "  $(m 'Could not fast-forward; kept your current version.' '没法快进更新；保留当前版本。')"
      else
        say "  $(m 'Could not download the update (network?); kept your current version.' '没能下载更新（网络问题？）；保留当前版本。')"
      fi
    fi
  elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    fail "$(m "$DIR already exists and is not empty. Move it away, or set HELM_DIR to another folder." "$DIR 已经存在而且不是空的。请把它移走，或者用 HELM_DIR 换一个文件夹。")"
  else
    git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
    say "  [ok] $(m 'Downloaded to' '已下载到') $DIR"
  fi
  say "  $(m 'Version:' '版本：') $(git -C "$DIR" log -1 --format='%h %cd' --date=short)"

  # ---------------------------------------------------------------- 4. engine
  step "$(m 'Installing the engine (.NET, Python, LEAN): first time about 2-3 GB and 15-30 minutes' '安装引擎（.NET、Python、LEAN）：第一次大约 2–3 GB、15–30 分钟')"
  local setup_args=()
  [ "$YES" = "1" ] && setup_args+=(--yes)
  local setup_in="${TTY:-/dev/null}"
  if ! bash "$DIR/scripts/setup.sh" ${setup_args[@]+"${setup_args[@]}"} <"$setup_in"; then
    fail "$(m "Setup did not finish (see the list above). Fix what it says, then run this installer again, or run: $DIR/scripts/setup.sh" \
              "引擎还没装完（见上面的清单）。按提示补上后再运行一次这个安装程序，或者运行：$DIR/scripts/setup.sh")"
  fi

  # ---------------------------------------------------------------- 5. Mac app + start
  local app=""
  if [ "$NO_APP" != "1" ]; then
    step "$(m 'Mac app' 'Mac App')"
    if ! command -v swift >/dev/null 2>&1; then
      say "  $(m 'Skipped: building the app needs the Xcode Command Line Tools (xcode-select --install). You can use Helm in the browser instead.' \
                 '跳过：构建 App 需要 Xcode 命令行工具（xcode-select --install）。也可以直接在浏览器里用 Helm。')"
    elif ask "$(m 'Build the Helm app and put it in Applications? (about 1 minute, recommended)' '构建 Helm App 并放进「应用程序」吗？（约 1 分钟，推荐）')"; then
      if bash "$DIR/macos/build.sh" --install; then
        if [ -d "/Applications/Helm.app" ]; then app="/Applications/Helm.app"; elif [ -d "$HOME/Applications/Helm.app" ]; then app="$HOME/Applications/Helm.app"; fi
      else
        say "  $(m 'The app build failed; you can still use Helm in the browser.' 'App 构建失败；仍然可以在浏览器里用 Helm。')"
      fi
    fi
  fi

  step "$(m 'Done' '完成')"
  if [ "$need_login" = "1" ]; then
    say "  $(m 'Log in to Claude Code once before using the agents: open a new Terminal window and run  claude' \
               '使用智能体之前先登录一次 Claude Code：开一个新的终端窗口，运行  claude')"
  fi
  if [ -n "$app" ]; then
    say "  $(m 'Start Helm from Applications (or Spotlight: Helm).' '从「应用程序」打开 Helm（或者 Spotlight 搜 Helm）。')"
  else
    say "  $(m "Start Helm:  cd $DIR && npm start   then open http://localhost:4377" "启动 Helm：cd $DIR && npm start   然后打开 http://localhost:4377")"
  fi
  say "  $(m 'Update later: run the same install command again.' '以后更新：再运行一次同样的安装命令。')"
  say "  $(m "Uninstall: delete $DIR, Helm.app, ~/Library/Application Support/Helm and ~/Library/Logs/Helm (your projects live in $DIR/projects)." \
             "卸载：删掉 ${DIR}、Helm.app、~/Library/Application Support/Helm 和 ~/Library/Logs/Helm（你的项目在 $DIR/projects 里）。")"

  if [ "$NO_START" != "1" ]; then
    if [ -n "$app" ]; then
      open "$app"
    elif ask "$(m 'Start Helm now in this window? (Ctrl-C stops it)' '现在就在这个窗口里启动 Helm 吗？（Ctrl-C 停止）')"; then
      ( sleep 3; open "http://localhost:4377" >/dev/null 2>&1 || true ) &
      cd "$DIR" && exec node server.mjs
    fi
  fi
}

main "$@"
