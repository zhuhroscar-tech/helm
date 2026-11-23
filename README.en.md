# Helm: a personal quant research console

> Language: English | [中文 (source of truth)](README.md)
>
> The web UI is available in English and Chinese, and project content (names, specs, reports, chats) is translated into the UI language. New here? Start with [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md). Agent prompts and code comments are in Chinese. If the Chinese README and this one disagree, the Chinese one wins.

Helm is a local web console for researching trading strategies. You type an idea into a web page; Claude Code agents running on your own machine (`claude -p`) turn it into a QuantConnect LEAN strategy, backtest it on a locally built LEAN engine, run statistical validation, robustness checks and paper trading, and explain the results. It runs entirely on your Mac and has no npm dependencies. It exists to make strategy research slower and more honest: every idea is counted, the holdout period is logged, and a strategy has to pass a statistical gate before it can be promoted.

Helm itself is free and open source (MIT), but the agents need an AI model, and that costs money: a Claude subscription (Pro / Max / Team), pay-as-you-go Anthropic API usage, or usage on a compatible provider (see [Connecting an AI](#connecting-an-ai)). A research deck costs roughly USD 0.50 of model usage.

![Helm's home page](docs/img/home-en.png)

A demo video is attached to the GitHub Releases page.

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
6. **Paper trading.** Freeze a finished backtest and Helm re-runs it after each US trading day ends (after midnight Eastern, because LEAN only backtests up to yesterday), so returns after the freeze date are genuinely out-of-sample. 
   - Two modes: Helm's internal simulation (no account needed) and an Alpaca paper account.
   - Alpaca mode trades only positions that session itself opened, and only from a validated `main` backtest or one you explicitly marked `main`. On a day with failed or stale data it submits nothing and retries after 3 hours.
   - A "within expectations" panel compares forward returns with a block bootstrap of the source backtest; below 20 trading days it says "too early to tell".
   - Sessions run only while Helm is open and catch up at the next start.
7. **Export to QuantConnect.** The backtest page has a dialog that copies `main.py` and the other `.py` files. 
   - Strategies that use `helm_data` (`HelmSignals` / `HelmUniverse` / `HelmMacro` / `HelmDataset`) read local files and cannot run on QuantConnect as-is.
   - QC cloud uses unadjusted prices, so results will differ somewhat.

8. **Research decks.** "Make a deck" on a project turns its results into a presentation for your team or clients, as PowerPoint and PDF. Pick a template first: the built-in consulting style, your firm's .pptx/.potx (used as the master when 16:9) or a PDF example (its colours are used), plus firm name, logo and disclaimer. Then choose the audience (internal: candid; client: no jargon, holdout and number of trials always shown, disclaimer appended), language, length and model.
   - You approve an outline (governing thought and claim titles) first; then a writer, an engagement-manager-style critic (green / yellow / red, top three fixes) and a fixer run in the background.
   - The model never types numbers: it writes placeholders such as `{{b1.cagr}}` and Helm fills them from the backtest records. Numbers without a source, and internal run codes in client decks, go back to the fixer and are listed on the page if they remain.
   - Charts are native, editable PowerPoint charts; an appendix lists each run's period and code/data fingerprints. Files live in `projects/<id>/decks/`. PDF and previews need LibreOffice.

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
| `data/` | Conversations, trial ledger, change snapshots, and secrets on older installs (git-ignored) |
| `scripts/setup.sh` | Idempotent macOS installer |
| `community/` | Format for sharing strategy ideas |

## Requirements

- **macOS only.** Tested on Apple Silicon; Intel Macs are untested; Linux and Windows are not supported (Helm's sandboxing uses macOS `sandbox-exec`, and `scripts/setup.sh` refuses other systems unless `--force`).
- About 2–3 GB of disk; a first install takes 15–30 minutes, depending on your network.
- Node 20+
- Git (`xcode-select --install`)
- The `claude` command-line tool (Claude Code), plus one way to pay for the model: a Claude subscription (Pro / Max / Team), an Anthropic API key, or any Anthropic-compatible API such as DeepSeek, Kimi, GLM or OpenRouter. Pick it under **AI** in the top bar; see [Connecting an AI](#connecting-an-ai)
- Installed by `scripts/setup.sh`: the .NET 10 SDK in `~/.dotnet`, LEAN (a pinned commit) built in `engine/Lean`, and a Python 3.11 environment in `engine/.venv` with the packages in `engine/requirements.txt`. It needs `uv`, which it offers to install with Homebrew.
- Optional: a Python with qlib and LightGBM, plus qlib US data in `~/.qlib/qlib_data/us_data`, for idea tests, factor research and index universes (see [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md#optional-qlib-research-engine))
- Optional: an Alpaca paper account for broker-side paper trading

## Quick start

New here? [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) walks you from a fresh Mac to your first backtest. The short version:

1. Install Claude Code and log in once:
   ```
   curl -fsSL https://claude.ai/install.sh | bash
   claude
   ```
   `npm install -g @anthropic-ai/claude-code` also works, but often fails with `EACCES` when Node came from the nodejs.org installer; use the command above instead (not sudo).
2. Get the code and install the engine (no sudo; it asks before each step):
   ```
   git clone https://github.com/zhuhroscar-tech/helm.git
   cd helm
   scripts/setup.sh --check     # report what is missing, change nothing
   scripts/setup.sh             # install what is missing
   ```
   **Code → Download ZIP** on GitHub works too; the unzipped folder is called `helm-main`, so `cd helm-main` instead.
3. Start it and open http://localhost:4377:
   ```
   npm start
   ```
   There is no `npm install`; Helm has no npm dependencies.

The page shows an environment check (`/api/health`) and says what to fix; `npm run doctor` does the same from the terminal. Restart Helm after installing Claude Code or editing `.env`. Configuration: [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Questions: [docs/FAQ.md](docs/FAQ.md).

### Mac app

`macos/build.sh --install` builds a native Mac app (about 1 MB) from source on your own Mac and installs it in Applications. It starts the server, keeps running when the window is closed, and sends notifications when an agent needs you. There is no downloadable app: it is a shell around this folder, ad-hoc signed, and only meant for the Mac that built it. See [docs/MACOS-APP.md](docs/MACOS-APP.md).

## Data coverage and limits

- **Prices:** Yahoo Finance adjusted daily bars for US stocks and ETFs, from listing to the previous trading day. Downloaded automatically on first use and refreshed after 20 hours. Adjusted prices are not the prices that actually traded: rules based on absolute price levels or dollar liquidity are unreliable locally.
- **Not available:** minute or tick data, options, futures, FX, crypto. LEAN's built-in universe selection does not work; use qlib universes.
- **Universes (qlib):** S&P 500 and Nasdaq 100 are point-in-time. `dia`, `sox`, `spy100`, `iwm80` are today's lists only and carry survivorship bias. The S&P 500 list after 2020-10 is rebuilt from Wikipedia's change table without checking dates against prices. After 2020-11, many delisted or acquired members have no free prices (roughly 1-9% of member-days per year, worst in 2021), so later results may be optimistic.
- **Fundamentals:** SEC filings, used in idea tests and factor research; reach LEAN strategies only through exported scores.
- **Macro:** FRED series via `fetch_macro` / `HelmMacro`, released-value lags applied, but FRED holds revised values, not first releases.
- **Custom datasets:** when an idea needs data Helm lacks (event lists, company attributes), agents may research public web sources and save a table with an `available_date` and source per row. Such data can be incomplete or wrong; the backtest page says so. Sensitive personal attributes are refused.
- **Costs:** LEAN's default slippage is zero, which is optimistic; strategies should state a slippage assumption.

## Connecting an AI

Click **AI** in the top bar. Every option is tested before it is saved:

| Option | What you need | Notes |
|---|---|---|
| Automatic (default) | `claude` already signed in, or `ANTHROPIC_API_KEY` in your shell | Same as before this setting existed |
| Claude subscription | Run `claude` once in a terminal and sign in with your Pro / Max / Team account | Uses your plan's usage; any API key in the environment is ignored |
| Anthropic API key | A key from console.anthropic.com | Checked with a free `GET /v1/models` call |
| Other compatible API | Endpoint URL, key and model ID from the provider, e.g. `https://api.deepseek.com/anthropic` + `deepseek-chat` | The endpoint must speak the Anthropic Messages API (often a URL ending in `/anthropic`). Checked with a 1-token request. Agents use this model for everything |

Keys are stored only in a local `secrets/ai.json` (mode 0600; `~/Library/Application Support/Helm/secrets/` on new installs, `data/secrets/` on older ones, see [CONFIGURATION.md](docs/CONFIGURATION.md#where-keys-and-data-are-stored)) and handed to Claude Code through its `apiKeyHelper` setting, never through environment variables. The page only ever sees the last four characters, and agent-run commands can't read the file or the key. Helm relies heavily on tool calls, so weaker models may fail at multi-step work.

## Safety model, in brief

- The server listens on 127.0.0.1 only and checks `Host`. State-changing requests need a per-start page token, a same-site Origin and `Sec-Fetch-Site: same-origin`; restart means refresh the page. This is defence in depth, not isolation from malicious local processes.
- Strategy code runs in a macOS `sandbox-exec` sandbox: no network, no home directory, repo or other projects, no secrets or `HELM_*` environment variables. A static lint (`engine/lint_strategy.py`) runs first, but the sandbox is the real boundary. Without `sandbox-exec`, backtests refuse to run unless you set `HELM_EXEC_SANDBOX=off`, which runs strategy code unsandboxed.
- Agents' file reads have a deny-list (SSH, cloud credentials, `.env`, `data/secrets`, `data/threads` and more). It is a deny-list, not an allow-list.
- Agents that edit Helm's own code or run commands go through an approval policy. Research-rule code (statistical thresholds, trial counting, holdout log) needs your approval; changes are snapshotted and auto-reverted if tests fail. Deleting needs explicit permission per message.
- Results, trial counts, holdout logs and paper logs are append-only. Deleting a backtest or starting a new project does not loosen the deflated-Sharpe threshold.
- Alpaca keys live in `secrets/alpaca.json` (mode 0600, same folder as above), entered only on the web page, never returned by any API and never passed to agents or LEAN.
- AI keys live in `secrets/ai.json` (mode 0600) and reach Claude Code only through `apiKeyHelper`; sandboxed agent commands also run with `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` removed from their environment.

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
- Content translation: what you and the agents write (project names and descriptions, backtest names, specs, ideas, research conclusions and reports, chat messages, paper-trading notes, …) is shown in the UI language, so people who don't read Chinese can use Helm. It uses the model set up under "Connecting an AI" (haiku by default), translates in background batches, translates each text once and caches the result locally in `data/i18n/translations.json`. The first view shows the original; the page refreshes by itself when translations arrive. A few hundred texts cost a few cents. Source files are never changed; copying or downloading a spec gives the original. Code, tool-call arguments and results, and logs are not translated. Set `HELM_TRANSLATE=0` to turn it off. Implementation: `lib/translate.mjs`.
- Known limits: without a working AI connection content is shown untranslated; code comments are not translated.

## Testing

```
npm test               # full run, includes real LEAN backtests (slow)
npm test -- --fast     # no LEAN; statistics, safety rules, contract tests, etc.
node test/alpaca.test.mjs   # any single test file
```

Tests use temporary directories and do not touch real projects.

## Contributing and more

[CONTRIBUTING.md](CONTRIBUTING.md) | [docs/ROADMAP.md](docs/ROADMAP.md) | [community/README.md](community/README.md) (sharing strategy ideas, including rejected ones) | [CHANGELOG.md](CHANGELOG.md) (Chinese)

License: [MIT](LICENSE). LEAN (Apache-2.0, downloaded at install), yfinance (Apache-2.0) and qlib (MIT) are not part of this repository; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Yahoo Finance data is subject to Yahoo's terms (personal use).
