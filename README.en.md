# Helm: a personal quant research console

> Language: English | [中文 (source of truth)](README.md)
>
> **The web UI is currently Chinese-only.** This README, `docs/GETTING-STARTED.md` and `docs/ARCHITECTURE.md` are in English; the agents' prompts, the UI text and the code comments are in Chinese. If the Chinese README and this one disagree, the Chinese one wins.

Helm is a local web console for researching trading strategies. You type an idea into a web page; Claude Code agents running on your own machine (`claude -p`) turn it into a QuantConnect LEAN strategy, backtest it on a locally built LEAN engine, run statistical validation, robustness checks and paper trading, and explain the results. It runs entirely on your Mac and has no npm dependencies. It exists to make strategy research slower and more honest: every idea is counted, the holdout period is logged, and a strategy has to pass a statistical gate before it can be promoted.

```
browser (localhost:4377) --> server.mjs --> local `claude -p` --> mcp/qc-mcp.mjs --> lib/engine.mjs --> local LEAN (.NET + Python)
        ^                                                                                  |
        +------------- live steps, equity curves, statistics, orders and conclusions ------+
```

## Disclaimer

**Helm is a research tool. Nothing it produces is financial or investment advice.** Backtests use free adjusted daily prices and say nothing reliable about future results.

**Helm cannot place live orders.** The only broker integration is Alpaca *paper* trading: the trading endpoint is hard-wired to `https://paper-api.alpaca.markets` in `lib/alpaca.mjs` (`PAPER_BASE`), no parameter or environment variable can change it, and every request re-checks the URL origin before it is sent. Starting or stopping a paper session is only possible from the web page; agents can only read sessions.

## Features, by workflow stage

Project pages show the flow **idea test -> backtest -> statistical validation -> paper trading**.

1. **Idea test** (for stock-selection ideas). The researcher agent writes your one-line idea as 1-3 qlib factor formulas with a pre-declared direction. `test_idea` evaluates them on the **development period only**, on point-in-time index members: IC and Newey-West t-values by holding period, five-quantile returns after costs, year-by-year stability, and correlation with known factors (momentum, reversal, volatility, size, E/P). Verdict: signal / weak signal / no signal. 
   - Every formula tried is logged in a registry, so the significance bar rises with the number of formulas tried on the same universe.
   - "No signal" ends the idea; trying variants until one passes is what the registry penalises.
   - Without a specific idea, a full research mode scans Alpha158 and fundamental factors and trains LightGBM, with a single holdout check.
2. **Strategy.** The orchestrator writes a rules table (`spec.md`: universe, entries/exits, sizing, rebalancing, costs, benchmark, dev/holdout dates) *before* any code. The engineer then writes LEAN Python that must match it. 
   - Strategies using idea signals read them through `HelmSignals`; point-in-time index members through `HelmUniverse`.
   - A few ETF timing ideas skip qlib and are written straight in LEAN.
3. **Backtest.** Runs on the local LEAN engine in a detached process (closing the page does not stop it). 
   - Each run stores a code snapshot, results, logs and a data-and-code fingerprint.
   - Compare 2-4 backtests side by side; every run carries a role (`main`, `candidate`, `control`, `ablation`, `benchmark`, `debug`) and a period (`dev`, `holdout`, `full`).
4. **Validation and holdout.** `validate_backtest` first checks that the reported metrics are self-consistent, then requires:
   - Sharpe 95% confidence-interval lower bound above 0;
   - at least 90% confidence of beating the benchmark;
   - a deflated Sharpe (adjusted for the number of trials) of at least 95%;
   - at least one year of data.

   Only a backtest that passes everything can be labelled `main` by an agent. Holdout runs are logged, and the tool warns from the second holdout run on that the holdout is no longer clean. Timing strategies can use a risk-adjusted mode, which only you can set, before looking at the holdout.
5. **Robustness and tuning.** 
   - Segment stability, cost stress (5/10/25/50 bp) and market-regime breakdowns use only saved results; no rerun.
   - Parameter sensitivity reruns each declared parameter at x0.8 and x1.2 as a diagnostic (not counted as trials, never promotable, not allowed on holdout runs).
   - Hyper-parameter search (`tune_backtest`, or `start_research` with `tune`) uses Latin-hypercube search, picks a parameter plateau instead of the single best point, and estimates the probability of backtest overfitting (PBO). Every candidate counts as a trial. Dev period only.
6. **Paper trading.** Freeze a finished backtest and Helm re-runs it after each US trading day's close, so returns after the freeze date are genuinely out-of-sample. 
   - Two modes: Helm's internal simulation (no account needed) and an Alpaca paper account.
   - Alpaca mode trades only positions that session itself opened, and only from a validated `main` backtest or one you explicitly marked `main`. On a day with failed or stale data it submits nothing and retries after 3 hours.
   - A "within expectations" panel compares forward returns with a block bootstrap of the source backtest; below 20 trading days it says "too early to tell".
   - Sessions run only while Helm is open and catch up at the next start.
7. **Export to QuantConnect.** The backtest page has a dialog that copies `main.py` and the other `.py` files. 
   - Strategies that use `helm_data` (`HelmSignals` / `HelmUniverse` / `HelmMacro` / `HelmDataset`) read local files and cannot run on QuantConnect as-is.
   - QC cloud uses unadjusted prices, so results will differ somewhat.

Also: an idea journal (`#/journal`) that lines up idea tests, backtests, holdouts and paper runs on one timeline; a research pipeline board (`#/pipeline`); an Agents page where prompts and tool permissions can be edited; and agents that may extend Helm's own code under an approval policy (see Safety).

## What Helm deliberately does not do

These are design choices (listed in `workspace/CLAUDE.md`), not missing features:

- Agents never place or cancel orders. Only the paper-trading scheduler you start from the web page does.
- A paper session never touches positions it did not open itself.
- A backtest that fails validation cannot be labelled `main` or start an Alpaca session; "almost passed" is not a pass.
- No orders on a day with failed or stale data.
- Recorded results, trial counts, holdout logs and paper logs are append-only; evidence is not edited to make a test pass.
- Rankings of strategy versions come with the number of versions tried.
- No claim that a factor or strategy works without engine output to back it.

## Repository layout

| Path | What it is |
|---|---|
| `server.mjs`, `public/` | Local server and the (offline, no-CDN) web page |
| `mcp/qc-mcp.mjs` | MCP server through which agents create projects, backtest and read results |
| `lib/` | Engine, statistics, robustness, tuning, paper trading, Alpaca client, security policy |
| `engine/` | Data download, strategy-side data readers, lint, qlib bridge and research engine; `Lean/` and `.venv/` are created by setup |
| `agents.json`, `workspace/CLAUDE.md` | The five agents and their shared rules |
| `projects/` | Your strategy projects (git-ignored); each backtest keeps its code snapshot and results |
| `data/` | Conversations, trial ledger, secrets, change snapshots (git-ignored) |
| `scripts/setup.sh` | Idempotent macOS installer |
| `community/` | Format for sharing strategy ideas |

## Requirements

- macOS (Helm's sandboxing uses `sandbox-exec`; `scripts/setup.sh` refuses other systems unless `--force`)
- Node 20+
- A logged-in `claude` command-line tool (Claude Code)
- .NET 10 SDK in `~/.dotnet`
- `uv`, to create the Python 3.11 environment
- Git (to fetch LEAN)
- Optional: a Python with qlib and LightGBM plus qlib US data in `~/.qlib/qlib_data/us_data` (the Chinese README quotes 2.8 GB for the `~/.qlib` folder) for idea tests, factor research and index universes
- Optional: an Alpaca paper account for broker-side paper trading

## Quick start

```
git clone https://github.com/zhuhroscar-tech/helm.git helm && cd helm
scripts/setup.sh --check     # report what is missing, change nothing
scripts/setup.sh             # install what is missing (no sudo)
npm start                    # then open http://localhost:4377
```

The page shows an environment check (`/api/health`) and says what to fix. Full walkthrough, including optional pieces and troubleshooting: [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md). Configuration: [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Questions: [docs/FAQ.md](docs/FAQ.md).

## Data coverage and limits

- **Prices:** Yahoo Finance adjusted daily bars for US stocks and ETFs, from listing to the previous trading day. Downloaded automatically on first use and refreshed after 20 hours. Adjusted prices are not the prices that actually traded: rules based on absolute price levels or dollar liquidity are unreliable locally.
- **Not available:** minute or tick data, options, futures, FX, crypto. LEAN's built-in universe selection does not work; use qlib universes.
- **Universes (qlib):** S&P 500 and Nasdaq 100 are point-in-time. `dia`, `sox`, `spy100`, `iwm80` are today's lists only and carry survivorship bias. The S&P 500 list after 2020-10 is rebuilt from Wikipedia's change table without checking dates against prices. After 2020-11, many delisted or acquired members have no free prices (roughly 1-9% of member-days per year, worst in 2021), so later results may be optimistic.
- **Fundamentals:** SEC filings, used in idea tests and factor research; reach LEAN strategies only through exported scores.
- **Macro:** FRED series via `fetch_macro` / `HelmMacro`, released-value lags applied, but FRED holds revised values, not first releases.
- **Custom datasets:** when an idea needs data Helm lacks (event lists, company attributes), agents may research public web sources and save a table with an `available_date` and source per row. Such data can be incomplete or wrong; the backtest page says so. Sensitive personal attributes are refused.
- **Costs:** LEAN's default slippage is zero, which is optimistic; strategies should state a slippage assumption.

## Safety model, in brief

- The server listens on 127.0.0.1 only and checks `Host`. State-changing requests need a per-start page token, a same-site Origin and `Sec-Fetch-Site: same-origin`; restart means refresh the page. This is defence in depth, not isolation from malicious local processes.
- Strategy code runs in a macOS `sandbox-exec` sandbox: no network, no home directory, repo or other projects, no secrets or `HELM_*` environment variables. A static lint (`engine/lint_strategy.py`) runs first, but the sandbox is the real boundary.
- Agents' file reads have a deny-list (SSH, cloud credentials, `.env`, `data/secrets`, `data/threads` and more). It is a deny-list, not an allow-list.
- Agents that edit Helm's own code or run commands go through an approval policy. Research-rule code (statistical thresholds, trial counting, holdout log) needs your approval; changes are snapshotted and auto-reverted if tests fail. Deleting needs explicit permission per message.
- Results, trial counts, holdout logs and paper logs are append-only. Deleting a backtest or starting a new project does not loosen the deflated-Sharpe threshold.
- Alpaca keys live in `data/secrets/alpaca.json` (mode 0600), entered only on the web page, never returned by any API and never passed to agents or LEAN.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [SECURITY.md](SECURITY.md).

## The agent team

Five agents, defined in `agents.json` (editable), sharing the rules in `workspace/CLAUDE.md`:

| Agent | Role |
|---|---|
| Orchestrator (`mia`) | Dispatches work: writes the rules table, creates the project, hands each stage to a specialist. Cannot run backtests or edit code itself. |
| Researcher (`researcher`) | Turns ideas into factor formulas and tests them with qlib; factor and model research. |
| Strategy engineer (`engineer`) | Writes LEAN code, fixes compile errors, runs backtests. |
| Backtest analyst (`analyst`) | Reads statistics, orders and logs; judges whether a result is trustworthy. |
| Risk officer (`risk`) | Reviews drawdown, exposure, leverage and behaviour in extreme markets. |

Agents ask you before starting (`ask_user`) rather than at the end of a reply, and "no reliable strategy found" is treated as a valid result.

## Language (Chinese / English)

The UI has a language switch in the sidebar footer, under Appearance: Auto / 中文 / English. Auto picks Chinese when the browser language starts with `zh`, otherwise English. The choice is stored in `localStorage` (`helm.lang`), the page re-renders without a reload, `<html lang>` is updated, and numbers and dates are formatted for the language.

- All UI text goes through `t(key, vars)`. `public/i18n-dict.js` holds both languages (Chinese is the source; keys must match one to one), `public/i18n.js` does lookup and switching. `node test/i18n.test.mjs` checks key and placeholder parity and that no hard-coded Chinese is left in the page.
- Chat and idea requests carry `lang` (`zh` | `en`, validated by the server). In English the server appends an instruction to reply in English to the agent's system prompt. Agent prompts (`agents.json`, `workspace/CLAUDE.md`) and internal hand-off text stay in Chinese on purpose.
- User-facing server and MCP messages (validation errors, environment check, paper-trading skip reasons, statistical gate text, and so on) are returned in English when the request has `X-Helm-Lang: en`. The table is in `lib/i18n.mjs`; a message without an English entry falls back to Chinese. Each health component carries `en` and `hintEn`.
- Known limits: research text produced by the Python engine (`engine/qlib_research/`: conclusions, factor descriptions, reports) is Chinese and not translated; messages already in a conversation keep the language the agent used; project names, ideas and code you wrote are shown as they are.

## Testing

```
npm test               # full run, includes real LEAN backtests (slow)
npm test -- --fast     # no LEAN; statistics, safety rules, contract tests, etc.
node test/alpaca.test.mjs   # any single test file
```

Tests use temporary directories and do not touch real projects.

## Contributing and more

[CONTRIBUTING.md](CONTRIBUTING.md) | [docs/ROADMAP.md](docs/ROADMAP.md) | [community/README.md](community/README.md) (sharing strategy ideas, including rejected ones) | [CHANGELOG.md](CHANGELOG.md) (Chinese)

License: [MIT](LICENSE)
