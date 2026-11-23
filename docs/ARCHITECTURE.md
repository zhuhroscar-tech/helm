# Architecture

How Helm is put together, where it keeps state, and which mechanisms keep research results honest. Sources: `README.md`, `workspace/CLAUDE.md`, and the headers and exports of the files named below. The code and its comments are Chinese.

## Components and data flow

```
 Browser  (public/: index.html, app.js, styles.css; offline, no CDN)
    |  HTTP + SSE on 127.0.0.1:4377; writes carry the page token
    v
 server.mjs ------------- spawns ---------> claude -p  (one process per agent run, workspace/CLAUDE.md as rules)
    |   |  ^                                    |  stdio MCP + permission prompt tool (approve)
    |   |  +---- /api/handoff, /api/ask, ---+   v
    |   |        /api/approval (agent token)  mcp/qc-mcp.mjs  (tools: projects, backtests, data, qlib, paper read, ask_user ...)
    |   |                                         |
    |   +-- lib/paper.mjs (scheduler, after ET midnight)   +--> lib/engine.mjs  -- detached --> lib/run-backtest.mjs
    |        '-> lib/alpaca.mjs (paper-api only)  |        |                                  |
    |                                              |        v                                  v
    |                                              |   engine/fetch_data.py            LEAN launcher (.NET) in sandbox-exec
    |                                              |   (Yahoo -> LEAN daily zips)       + engine/.venv Python, strategy main.py
    |                                              |                                     imports engine/helm_data.py
    |                                              +--> lib/qlib.mjs --> engine/qlib_research/run.sh (engine/.venv; qlib Python only for full research; sandboxed)
    |                                                        '-> engine/qlib_bridge.py: universes, signals -> LEAN format
    v
 read-only JSON endpoints: backtests, charts, orders, validation, robustness, journal, pipeline, health
```

- **Browser.** A single-page app. It only reads state and sends a small set of write actions (create project, compile, run backtest, label, sensitivity, qlib research, paper sessions). Changing code or deleting goes through an agent.
- **`server.mjs`.** Serves the page and APIs, starts `claude -p` runs (up to `HELM_MAX_RUNS`, default 8) and streams their events to the page, brokers hand-offs between agents, user questions and approvals, and runs the paper-trading scheduler.
- **Claude agents.** Five roles from `agents.json`; tools are filtered per agent (`lib/agents.mjs`). The orchestrator may only write `spec.md` and delegates everything else.
- **MCP server (`mcp/qc-mcp.mjs`).** The agents' only way to create projects, write code, run backtests, validate and read results. Tool names follow QuantConnect conventions.
- **Engine (`lib/engine.mjs`).** Project and file storage, compile/lint, launching LEAN, parsing results, trial and holdout ledgers, statistical validation. Backtests run in detached processes, so closing the page or the server does not stop them.
- **LEAN.** QuantConnect's open-source engine, built locally from `engine/Lean` (.NET), executing the strategy with Python 3.11 from `engine/.venv`, inside a macOS sandbox.
- **qlib research engine (`engine/qlib_research/`).** Idea tests, factor scans, LightGBM research, point-in-time universes and fundamentals. Idea tests, universe exports and signal exports run on `engine/.venv` (formulas are evaluated by `qs_expr.py`, a pandas re-implementation of qlib's operators checked against qlib's own output); only full research (LightGBM, qlib backtests) needs a separate Python with qlib. Universe exports, which write LEAN prices, run a clean copy of the committed engine code, not the working tree agents can edit. Helm reads the output files and converts universes and signals to LEAN format.
- **Paper trading (`lib/paper.mjs`).** Freezes a backtest's code on the first run day and re-runs it after each US close using fresh daily data; `sim` mode keeps books internally, `alpaca` mode submits orders to an Alpaca paper account through `lib/alpaca.mjs`.

## Module map

### `lib/` and `mcp/`

| File | Purpose |
|---|---|
| `server.mjs` | HTTP server, page and token handling, agent runs, SSE, approvals, questions, health, paper scheduler |
| `mcp/qc-mcp.mjs` | stdio MCP server exposing Helm's tools to agents |
| `lib/engine.mjs` | Local LEAN engine: projects, files, compile, backtests, results, ledgers, validation, tuning jobs |
| `lib/run-backtest.mjs` | Detached backtest process entry point |
| `lib/stats.mjs` | Statistical validation: circular block-bootstrap Sharpe CI, excess return, deflated Sharpe |
| `lib/robust.mjs` | Segment stability, cost stress, market regimes; sensitivity parameter discovery and verdicts (read-only) |
| `lib/tune.mjs` | Pure functions for hyper-parameter search: Latin hypercube, plateau selection, CSCV PBO |
| `lib/paper.mjs` | Paper trading sessions, freezing, daily runs, scheduler, Alpaca sync |
| `lib/alpaca.mjs` | Alpaca client; endpoint hard-wired to `https://paper-api.alpaca.markets`; credential storage |
| `lib/drift.mjs` | "Within expectations" check of forward returns against a block bootstrap of the source backtest |
| `lib/journal.mjs` | Idea journal: idea tests, backtests, holdouts, paper runs on one timeline (read-only) |
| `lib/pipeline.mjs` | Research pipeline board and agent task list (read-only) |
| `lib/fingerprint.mjs` | Code and data fingerprints per backtest; flags "same code, different data" |
| `lib/qlib.mjs` | Starts the qlib research engine, reads results, converts universes and signals |
| `lib/macro.mjs` | Downloads FRED series into LEAN's data folder |
| `lib/datasets.mjs` | Custom datasets: validation (availability date, source, sensitive-attribute check), save, list, read |
| `lib/market-calendar.mjs` | US market holidays; shares `public/calendar.js` with the page |
| `lib/agents.mjs` | Tool catalogue, per-agent permissions, `agents.json` validation and saving |
| `lib/agent-perms.mjs` | Deny-list of sensitive paths for agent Read/Glob/Grep |
| `lib/change-policy.mjs` | Which agent edits and commands run freely, need approval, or are refused; protected definitions |
| `lib/changes.mjs` | Change sets: snapshot before editing, verify with tests, auto-revert, manual undo |
| `lib/exec-sandbox.mjs` | macOS `sandbox-exec` profiles for agent-runnable code and research runs |
| `lib/fs-atomic.mjs` | Atomic JSON writes (fsync + rename), crash-safe `.jsonl` appends, visible corruption |

### `engine/`

| File | Purpose |
|---|---|
| `engine/fetch_data.py` | Converts Yahoo Finance daily data into LEAN's local format |
| `engine/helm_data.py` | Strategy-side readers: `HelmUniverse`, `HelmSignals`, `HelmMacro`, `HelmDataset` (only data available before the current day) |
| `engine/lint_strategy.py` | AST lint before each backtest; parses, never executes |
| `engine/qlib_bridge.py` | Bridge between Helm and the qlib engine (universe export, results, signal export) |
| `engine/sp500_pit.py` | Rebuilds the S&P 500 point-in-time membership file |
| `engine/qlib_research/qs_idea.py` | Idea test: factor evaluation, registry of tested formulas, verdict |
| `engine/qlib_research/qs_pipeline.py` | Resumable research pipeline: factors, LightGBM, tests, holdout |
| `engine/qlib_research/qs_core.py` | Pure building blocks: splits, tuning space, CSCV PBO |
| `engine/qlib_research/qs_data.py`, `qs_membership.py`, `qs_fundamentals.py` | Price-source corrections, index membership, SEC point-in-time fundamentals |
| `engine/qlib_research/qs_qlib.py`, `qs_tra.py`, `qs_describe.py` | qlib-native evaluation, TRA model, report wording and contradiction check |
| `engine/qlib_research/run.sh` | Launcher that finds a Python with qlib; `--which-python`, `--test` |

## Where state lives

| Location | Contents |
|---|---|
| `projects/<id>/` | `project.json`, `main.py` and other `.py` files, `spec.md`, `holdout_log.json`, `backtests/<bid>/` (code snapshot, `meta.json`, LEAN `out/`, `sensitivity/`), `paper/<sessionId>/log.jsonl`, `research/` |
| `data/` | `trials.jsonl` (trial ledger), `threads/` (conversations), `secrets/` (AI and Alpaca keys on older installs; new installs keep them in `~/Library/Application Support/Helm/secrets`, see CONFIGURATION.md), `changes/` (agent edit snapshots), `mcp.json` (a copy of the agents' MCP config for reference; agents get it inline), `qlib/`, `sandbox/`, `server.log`, `agents-backups/` |
| `engine/Lean/`, `engine/.venv/` | Local LEAN checkout and build, Python environment (git-ignored) |
| `engine/Lean/Data/` | LEAN data folder: equity daily zips, plus Helm-written `helm/macro/` and `helm/custom/` |
| `~/.qlib/` | qlib US data, constituents, SEC fundamentals cache (shared with the older Quant Strategy project) |
| `~/.cache/quant-strategy/`, `~/.config/quant-strategy/` | Research engine cache and SEC request settings |
| `~/.dotnet/` | .NET SDK |

`.env`, `data/`, `projects/`, `engine/Lean/` and `engine/.venv/` are git-ignored.

## Security boundaries

- **Local server.** Bound to 127.0.0.1, `Host` checked. POST/DELETE need the per-start page token (injected only into `index.html`), a same-site `Origin` and `Sec-Fetch-Site: same-origin`; otherwise 403. Agent-to-server calls use a different token passed only to the MCP process. Page headers include a CSP without inline scripts. Request bodies are validated; malformed input yields 400, not 500. This is defence in depth, not protection from a hostile local process.
- **Write token and web-only actions.** Starting or stopping paper sessions, connecting Alpaca, marking a backtest `main` by hand, and enabling deletion are web-only.
- **Approval flow.** Every agent file edit or command passes `mcp__qc__approve` -> `lib/change-policy.mjs`. Free: research engine code (excluding research rules), new tests, skills, quick tests, read-only git/ls. Ask you first: deletes, platform code (`lib/`, `mcp/`, top-level `engine/` scripts), existing tests, `server.mjs`, page, `agents.json`, permissions, `workspace/CLAUDE.md`, `package.json`, installs, other commands. Refused: anything outside the repo, `.env`, secrets, `data/`, `projects/`, `.git/`. A pending approval times out to "deny" after 15 minutes.
- **Sandbox.** Strategy code in LEAN and agent-runnable code (tests, auto-checks, qlib runs) execute under macOS `sandbox-exec`: no secrets, no access to the running Helm, limited write paths; strategies also get no network. If the sandbox is unavailable, free-to-edit actions tighten to "ask first", and backtests refuse to run unless you set `HELM_EXEC_SANDBOX=off`. The sandbox rules were only text-checked on Linux according to `CHANGELOG.md`.
- **Protected definitions.** `INTEGRITY` in `lib/change-policy.mjs` lists research-rule code (statistics, trial ledger, holdout log, validation, tuning, `helm_data.py`, the lint, the sandbox, parts of the qlib engine). Edits touching them need approval and show you the diff.
- **Lint.** `engine/lint_strategy.py` rejects forbidden imports, `open`/`eval`/`exec`, dunder access, non-daily resolutions, file reads, private-attribute access on `helm_data` objects and more, and does not count as a trial. It is the first gate; the sandbox is the real one.
- **Agent read deny-list.** `lib/agent-perms.mjs`: SSH, cloud and Claude credentials, `~/Library`, `.env*`, `*.pem`, `data/secrets`, `data/threads`, `data/server.log`. It is a deny-list, not an allow-list; `WebFetch` is unrestricted.

## Integrity mechanisms

- **Trial counting.** `data/trials.jsonl` records every non-benchmark backtest run on the same history across all projects; it only grows. Deleting a backtest, creating a new project or changing the period label does not reduce the count. The deflated Sharpe in `lib/stats.mjs` depends on it. Tuning candidates are counted; sensitivity variants are not.
- **Holdout log.** `projects/<id>/holdout_log.json` records every holdout run under a file lock. From the second run the tools warn that the holdout is no longer clean, and validation reports it.
- **Idea registry.** qlib idea tests log every formula tried per universe, raising the significance threshold.
- **Validation gate.** Self-consistency of metrics first, then Sharpe CI, benchmark outperformance, deflated Sharpe and length. Only a pass allows an agent to label `main`; a user-chosen `main` is recorded as `mainBy: "user"`.
- **Fingerprints.** Each backtest stores a hash of the code and of each ticker's daily data (decompressed CSV content, date range, rows). A warning appears when identical code ran on changed data.
- **Append-only records.** Results, trials, holdout and paper logs are never rewritten to pass a test; writes are atomic and crash-safe (`lib/fs-atomic.mjs`), and concurrent updates use file locks so there is exactly one `main` per period.
- **Forward test.** Paper trading freezes code on its first run day; only later returns count as out-of-sample.
- **Point-in-time reads.** `HelmUniverse`, `HelmSignals`, `HelmMacro` and `HelmDataset` only return what was known strictly before the current day.

See also [CONFIGURATION.md](CONFIGURATION.md) and [ROADMAP.md](ROADMAP.md).

## Safety model

- The server listens on 127.0.0.1 only and checks `Host`. State-changing requests need a per-start page token, a same-site Origin and `Sec-Fetch-Site: same-origin`; restart means refresh the page. This is defence in depth, not isolation from malicious local processes.
- Strategy code runs in a macOS `sandbox-exec` sandbox: no network, no home directory, repo or other projects, no secrets or `HELM_*` environment variables. A static lint (`engine/lint_strategy.py`) runs first, but the sandbox is the real boundary. Without `sandbox-exec`, backtests refuse to run unless you set `HELM_EXEC_SANDBOX=off`, which runs strategy code unsandboxed.
- Agents' file reads have a deny-list (SSH, cloud credentials, `.env`, `data/secrets`, `data/threads` and more). It is a deny-list, not an allow-list.
- Agents that edit Helm's own code or run commands go through an approval policy. Research-rule code (statistical thresholds, trial counting, holdout log) needs your approval; changes are snapshotted and auto-reverted if tests fail. Deleting needs explicit permission per message.
- Results, trial counts, holdout logs and paper logs are append-only. Deleting a backtest or starting a new project does not loosen the deflated-Sharpe threshold.
- Alpaca keys live in `secrets/alpaca.json` (mode 0600, same folder as above), entered only on the web page, never returned by any API and never passed to agents or LEAN.
- AI keys live in `secrets/ai.json` (mode 0600) and reach Claude Code only through `apiKeyHelper`; sandboxed agent commands also run with `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` removed from their environment.

See also [SECURITY.md](../SECURITY.md).

## Language (Chinese / English)

The UI language is set in Settings: Auto / 中文 / English. Auto picks Chinese when the browser language starts with `zh`, otherwise English. The choice is stored in `localStorage` (`helm.lang`), the page re-renders without a reload, `<html lang>` is updated, and numbers and dates are formatted for the language.

- All UI text goes through `t(key, vars)`. `public/i18n-dict.js` holds both languages (Chinese is the source; keys must match one to one), `public/i18n.js` does lookup and switching. `node test/i18n.test.mjs` checks key and placeholder parity and that no hard-coded Chinese is left in the page.
- Chat and idea requests carry `lang` (`zh` | `en`, validated by the server). In English the server appends an instruction to reply in English to the agent's system prompt. Agent prompts (`agents.json`, `workspace/CLAUDE.md`) and internal hand-off text stay in Chinese on purpose.
- User-facing server and MCP messages (validation errors, environment check, paper-trading skip reasons, statistical gate text, and so on) are returned in English when the request has `X-Helm-Lang: en`. The table is in `lib/i18n.mjs`; a message without an English entry falls back to Chinese. Each health component carries `en` and `hintEn`.
- Content translation: what you and the agents write (project names and descriptions, backtest names, specs, ideas, research conclusions and reports, chat messages, paper-trading notes, …) is shown in the UI language, so people who don't read Chinese can use Helm. It uses the model set up under "Connecting an AI" ([CONFIGURATION.md](CONFIGURATION.md#connecting-an-ai)) (haiku by default), translates in background batches, translates each text once and caches the result locally in `data/i18n/translations.json`. The first view shows the original; the page refreshes by itself when translations arrive. A few hundred texts cost a few cents. Source files are never changed; copying or downloading a spec gives the original. Code, tool-call arguments and results, and logs are not translated. Set `HELM_TRANSLATE=0` to turn it off. Implementation: `lib/translate.mjs`.
- Known limits: without a working AI connection content is shown untranslated; code comments are not translated.
