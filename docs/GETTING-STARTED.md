# Getting started on macOS

This guide takes a clean Mac to a first backtest. Every command below comes from `README.md` (the Chinese source of truth), the `/api/health` hints in `server.mjs`, or `engine/qlib_research/run.sh`. Where the README does not say how to do something (for example how to install Node or `uv`), this guide says so rather than inventing a recipe.

The web UI is Chinese-only. Section 6 lists the Chinese labels you will meet.

If you prefer automation: `scripts/setup.sh --check` reports what is missing and `scripts/setup.sh` installs it. The manual steps below are exactly what the script does.

## 1. Prerequisites

| Need | Check | Notes |
|---|---|---|
| macOS | `sw_vers` | Helm's sandboxing uses `sandbox-exec`. Without macOS, agent-edited code and research runs fall back to asking for your approval. |
| Node 20+ | `node -v` | `package.json` requires `>=20`. The README does not say how to install it; use your usual method (nvm, Homebrew, nodejs.org). |
| Git | `git --version` | Needed to fetch LEAN. |
| Claude Code, logged in | `claude --version` | `npm install -g @anthropic-ai/claude-code`, then run `claude` once and complete login. |
| `uv` | `uv --version` | Creates the Python 3.11 environment. The README does not say how to install it; Homebrew (`brew install uv`) is one option. |
| .NET 10 SDK | `~/.dotnet/dotnet --version` | Installed in step 2 below. |

## 2. Install Helm's engine

From the repository root (the folder containing `server.mjs`):

```
# .NET 10 SDK into ~/.dotnet
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir ~/.dotnet

# LEAN source (skip the clone if engine/Lean already exists), then build
git clone --depth 1 https://github.com/QuantConnect/Lean.git engine/Lean
~/.dotnet/dotnet build engine/Lean/Launcher/QuantConnect.Lean.Launcher.csproj -c Release

# Python 3.11 environment, versions pinned to LEAN's
uv venv --python 3.11 engine/.venv
uv pip install --python engine/.venv/bin/python numpy==1.26.4 pandas==2.3.3 scipy==1.13.1 matplotlib==3.8.4 scikit-learn==1.6.1 statsmodels==0.14.6 yfinance
```

Use a uv-managed Python 3.11 as shown. If `engine/.venv` is built on a Python without `libpython`, the health check reports `libpython` missing (see Troubleshooting).

There is nothing to `npm install`: Helm has no npm dependencies.

## 3. Optional: qlib research engine and data

Needed only for idea tests, factor research and the index universes (S&P 500, Nasdaq 100). Plain ETF strategies written directly in LEAN do not need it.

- A Python (3.8-3.12) that has `qlib`, `lightgbm`, `pandas`, `numpy` and `matplotlib`. `engine/qlib_research/run.sh` searches common locations and prints its choice with `engine/qlib_research/run.sh --which-python`. Its own hint when none is found: `python3.12 -m pip install pyqlib lightgbm matplotlib yfinance`. To pin an interpreter, put `QS_PYTHON=/absolute/path/to/python` in `.env`.
- qlib US daily data in `~/.qlib/qlib_data/us_data`, a directory that contains `calendars`, `features` and `instruments`. The README describes this folder (about 2.8 GB with SEC fundamentals and S&P 500 history caches, shared with the earlier "Quant Strategy" project) To get a starting copy, use qlib's own downloader: `python -m qlib.run.get_data qlib_data --target_dir ~/.qlib/qlib_data/us_data --region us` (see the qlib documentation for current options). That public snapshot is not kept up to date by Helm, and the SEC fundamentals and S&P 500 history caches are built by the research engine on first use.

## 4. Optional: Alpaca paper keys

Only for broker-side paper trading; Helm's internal simulation needs no account.

1. On app.alpaca.markets, switch to a **Paper** account and generate an API key and secret.
2. In Helm, open a finished backtest, click the start-paper-trading button (Chinese: 开始模拟实盘), choose the Alpaca paper account mode and enter the key in the dialog. This calls `/api/actions/alpaca-connect`.
3. The key is stored in `data/secrets/alpaca.json` (mode 0600). Do not paste keys into agent chats; agents cannot read them and will not ask for them. Keys are never placed in environment variables for agents or LEAN.

Alpaca mode only works from a `main` backtest that passed validation, or one you marked `main` yourself on the backtest page. Otherwise use the internal simulation. The endpoint is hard-wired to Alpaca's paper API, so real-money trading is impossible.

## 5. First run

```
npm start
```

Expected output: `Helm 已启动 -> http://localhost:4377` followed by the LEAN engine status (`就绪` means ready; otherwise it lists what is missing). Open http://localhost:4377.

Optional settings go in `.env` (all optional, see `.env.example`): `PORT`, `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `DOTNET_BIN`. Do not commit `.env`.

### Reading the health check

`/api/health` (also shown in the page when something is missing; add `?refresh=1` to force a re-check, or use the re-check button in the UI) lists eight components. The first five are required, the last three optional.

| id | Checks | Required |
|---|---|---|
| `claude` | Claude Code CLI runs and reports a version | yes |
| `dotnet` | .NET runtime at `~/.dotnet/dotnet` or `DOTNET_BIN` | yes |
| `lean` | LEAN built in `engine/Lean/Launcher/bin/Release` | yes |
| `python` | `engine/.venv/bin/python` exists | yes |
| `libpython` | the venv's Python has a `libpython` dynamic library LEAN can load | yes |
| `priceData` | local price files exist (count of tickers) | no, downloaded on first backtest |
| `qlib` | a Python with qlib found via `engine/qlib_research/run.sh` | no |
| `qlibData` | `~/.qlib/qlib_data/us_data` present | no |

Each failing item includes the command to fix it. After fixing, click re-check; no restart of the page is needed (a restart of `npm start` is, for a missing `claude`).

## 6. First idea to backtest

1. On the home page, choose an agent and type your idea in plain language. For a first run, the orchestrator (总控) is the natural entry: it writes the rules, creates the project and hands each stage to a specialist. Example prompts that ship with the agents: "write a SPY 50/200 moving-average crossover strategy, create a project and backtest it" (an ETF strategy needs no qlib), or "test: stocks that fell a lot in the past month without a volume spike rebound afterwards" (a stock-selection idea, needs qlib).
2. Before any code, the agent writes a rules table (规则说明, saved as `spec.md` in the project) covering universe, entries/exits, sizing, rebalancing, costs, benchmark and dates. Read it. If an ambiguity could change results, a question card appears; answer it, or let it default after 15 minutes.
3. For stock-selection ideas, the researcher first runs an **idea test** on the development period only. "No signal" is a valid end of the road; do not ask for variants until something passes, because each formula tried raises the bar for later ones.
4. The engineer writes LEAN code, a lint runs (`engine/lint_strategy.py`), and the backtest runs on the local engine. The first run downloads the tickers' daily prices.
5. Open the backtest page: equity curve, statistics, orders, the rules table as archived with that run, and the robustness tab. The agent should check for `Invalid` orders and tell you which backtest is `main` and whether it passed validation.
6. Run the statistical validation. Only after the development-period conclusion is settled should the holdout period be run, once.
7. Optionally freeze the backtest as a paper-trading session, or copy the code to QuantConnect with the export dialog (strategies using `helm_data` cannot run there).

Permission cards appear when an agent wants to edit Helm's own code or run a command; deleting anything needs the "allow deletion" switch under the input box, valid for one message.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Startup says the port is in use ("Helm 可能已经在运行了") | Another Helm is on port 4377. Open http://localhost:4377, or start on another port: `PORT=4378 node server.mjs`. |
| Page shows grey placeholders and a toast that the page expired | The server restarted and the per-start page token changed. Refresh the page. |
| Health says `claude` missing | Install and log in (`npm install -g @anthropic-ai/claude-code`, then `claude`), confirm with `claude --version`. If it is not on PATH, add `CLAUDE_BIN=/absolute/path/to/claude` to `.env`. Restart Helm. |
| Health says `dotnet` missing | Run the dotnet-install command from step 2. If installed elsewhere, set `DOTNET_BIN=/absolute/path/dotnet` in `.env`. |
| Health says `lean` missing | Clone (if `engine/Lean` is absent) and run the `dotnet build` from step 2. |
| Health says `python` missing | Run the `uv venv` and `uv pip install` commands from step 2. |
| Health says `libpython` missing | The venv's Python lacks the dynamic library. Rename or delete `engine/.venv`, recreate it with `uv venv --python 3.11 engine/.venv`, and reinstall the packages. |
| `qlib` or `qlibData` marked missing | Optional. Run `engine/qlib_research/run.sh --which-python` to see what it lacks; set `QS_PYTHON` if needed; place data under `~/.qlib/qlib_data/us_data`. |
| Backtest cannot find a ticker | Prices are downloaded automatically for tickers appearing literally in the code. For dynamically built ticker lists, ask the agent to `fetch_data` them first. |
| Alpaca paper session did not trade today | By design: no orders when data download failed or is stale; the reason is logged and it retries after 3 hours. Also only `main` backtests that passed validation (or that you marked) can start Alpaca mode. |
| Paper sessions did not run while Helm was closed | They run only while Helm is open (checked every 10 minutes, after 17:15 US Eastern on trading days). The latest day is caught up at next start, without duplicate orders. |
| Agent edits to `lib/` or `server.mjs` have no effect | Those need a restart of `npm start`; the UI says so. |
| Ctrl+C and a backtest keeps running | Intended: backtests, research and sensitivity runs are detached and finish on their own. |
| Need to reset | `.env` and `data/` are never touched by `scripts/setup.sh`. To rebuild the engine only, remove `engine/.venv` or `engine/Lean` yourself and re-run setup. |

More questions: [FAQ](FAQ.md), [configuration reference](CONFIGURATION.md), [architecture](ARCHITECTURE.md).
