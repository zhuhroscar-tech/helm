# Contributing to Helm

Helm is a local quant research console. A web page on `localhost` drives Claude Code agents that write QuantConnect LEAN strategies, backtest them on your Mac, and check the results statistically. Read the README first for what the system does. This file is for people changing its code.

## Setup

- **Node.js 20 or newer** (see `engines` in `package.json`). There is no install step: the project has no npm dependencies and no build step.
- Start with `npm start`, then open http://localhost:4377. `GET /api/health` lists what is missing on your machine.
- Agents need the `claude` command installed and logged in.
- Full backtests need the LEAN build, .NET 10 and the Python venv described under 「安装」 in the README. You do not need them for the fast test suite or for most edits.
- **Python is only needed for the engine.** That means `engine/fetch_data.py`, `engine/helm_data.py`, `engine/lint_strategy.py`, `engine/qlib_bridge.py` and `engine/qlib_research/`. The qlib research engine needs an interpreter that has `qlib` and `lightgbm`; `engine/qlib_research/run.sh --which-python` shows which one it picks. The Python tests below need only numpy and pandas.

## Running tests

Node (`test/all.mjs` runs every `*.test.mjs` file and `smoke.mjs`, each in its own process; any failure fails the run):

- `npm test -- --fast` skips anything that launches LEAN. Use this for normal changes. CI runs it on Node 20 and 22.
- `npm test` (full mode) also runs real LEAN backtests, the paper-trading run, and `sandbox.test.mjs`. Run it when you change backtest, paper-trading, LEAN or sandbox code.
- A single file runs on its own, for example `node test/alpaca.test.mjs`. `npm run test:smoke` runs only `smoke.mjs`.
- New `*.test.mjs` files are picked up automatically. Each file has a 10-minute limit, set with `HELM_TEST_TIMEOUT_MS`.
- Tests use temporary directories. They must not read or write `projects/` or `data/`.

Python (`engine/qlib_research`):

- These are plain scripts, not pytest: `python3 engine/qlib_research/test_qs_core.py`. Each exits non-zero on failure.
- `engine/qlib_research/run.sh --test` runs all five files with the qlib interpreter, including `test_qs_qlib.py`, which imports qlib.
- CI runs four of the five. `test_qs_qlib.py` is excluded because it needs qlib; see `.github/workflows/ci.yml`.

## Layout

The table in the README under 「结构」 is the map. In short: `server.mjs` (HTTP and agent streaming), `mcp/qc-mcp.mjs` (the tools agents call), `lib/` (engine, statistics, paper trading, policy), `public/` (the page), `engine/` (Python and LEAN glue), `engine/qlib_research/` (research engine), `workspace/CLAUDE.md` and `agents.json` (agent rules and prompts), `test/`, `docs/`.

## Code conventions (as the code is written today)

- **ES modules everywhere on the Node side**: `"type": "module"`, `.mjs` files, Node built-ins only. Spawn processes with argument arrays (`spawn`, `spawnSync`), never shell strings.
- **No dependencies.** Do not add an npm package without agreeing it first. Python code uses numpy and pandas, plus the pins in the README's venv step.
- **Front end is plain JavaScript in `public/`**: no framework, no build, no CDN. The page's Content-Security-Policy allows only same-origin scripts. Do not add inline `<script>` blocks or `on*=` attributes; `test/server-auth.test.mjs` checks this.
- **Persist records through `lib/fs-atomic.mjs`** (fsync before rename, safe `.jsonl` appends, file locks). Do not write research records with a bare `writeFile`.
- Comments and UI text are in Chinese; identifiers are English. Chinese or English are both fine for issues and pull requests.

## Research integrity rules (do not weaken these)

1. **Point-in-time data only.** `HelmSignals`, `HelmUniverse`, `HelmMacro` and `HelmDataset` return only what was public on the evaluation date. Their full history lives in underscore attributes in `engine/helm_data.py`, and `engine/lint_strategy.py` (`private-attr`) rejects strategy code that reads them. Do not add a public attribute that exposes full history.
2. **The validation period (验证期) is looked at once.** Every run on it is logged. Do not add a path that re-runs variants on it, and do not let parameter sensitivity run there (the README forbids it).
3. **Trial counting is append-only.** Every non-benchmark backtest and every tuning candidate is recorded in `data/trials.jsonl`, and the deflated Sharpe uses that count. Do not add code that deletes, edits or re-labels those records, and do not make deleting a backtest reduce the count.
4. **Statistics and tuning rules need an explicit owner decision.** This covers the thresholds in `lib/stats.mjs`, the registry, PBO and parameter selection (`lib/tune.mjs`, `qs_core.py`), and the validation gate. In a pull request, state the before and after numbers for anything that moves.
5. **Sandbox and approval policy.** Strategy code runs under macOS `sandbox-exec` with no network and no home-directory access. Agent edits and commands are gated by `lib/change-policy.mjs` and `lib/agent-perms.mjs`. A change that moves a protected file into the free list, runs agent or LEAN code outside the sandbox, or passes `ALPACA_*` or other secrets to a child process needs owner review.
6. **Paper trading only.** `lib/alpaca.mjs` is pinned to the paper endpoint. Orders come only from a paper session that the user starts in the web page. Agents cannot place or cancel orders. Do not add any other broker or live-trading path.
7. **No secrets in the repo.** Keys stay in `data/secrets/`, which is never committed. Tests and fixtures use fake values.

## Commit messages

Recent history uses short Chinese summaries that lead with the change, for example `研究有效性与稳定性一轮：稳健性/参数敏感性、模拟实盘预期检验…`. English works too. Put the reason and any effect on existing numbers in the body.

## Pull request checklist

The template is in `.github/PULL_REQUEST_TEMPLATE.md`. Before opening one:

- `npm test -- --fast` passes.
- If you touched `engine/qlib_research/`, run the Python tests.
- If you touched backtest, paper, LEAN or sandbox code, run full `npm test` on a Mac with LEAN, or say in the PR that you did not and why.
- `CHANGELOG.md` has an entry under the newest dated heading. List what you verified and, in the 「没有验证」 style used there, what you did not.
- The PR contains no `.env`, `data/`, `projects/` or `engine/Lean/` files.

## Changelog

`CHANGELOG.md` is the project's record. Add entries at the top under a dated heading. Say what changed, why, and what was not verified (for example "没有用真实 LEAN 跑过"). Keep the 「已知遗留」 section current.

License: to be decided by the maintainer.
