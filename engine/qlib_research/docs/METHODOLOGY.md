---
name: quant-strategy
description: "End-to-end, resumable quantitative equity strategy research with Microsoft Qlib. Given a target index/ETF/sector or ticker list (e.g. QQQ, SOX, SPY, DIA, 'AAPL,MSFT,...'), it reuses the existing Python/Qlib install and cached data, downloads only what is missing, uses point-in-time index membership where a source exists (and discloses when it does not), freezes purged walk-forward splits and a holdout, researches Alpha158 price/volume factors and/or point-in-time SEC XBRL fundamentals (value, quality, growth, earnings surprise) and horizons on training data only, optionally sector-neutral (labels, IC and sector-balanced portfolios by SIC sector), fits Qlib's LGBModel, backtests every strategy and baseline in Qlib's own backtest engine with Qlib risk_analysis metrics (independent simulator as cross-check), runs permutation/seed/regime/cost checks, optionally compares Qlib TRA on development folds, compares against buy-and-hold, equal-weight, momentum and random baselines, and writes a report with NAV-per-unit, drawdown and annual-return charts. 'No reliable strategy found' is a valid outcome. Use when the user invokes /quant-strategy or asks for systematic quant research/backtesting on a universe."
---

# quant-strategy (research version 1.2.0)

Research, backtest and document a cross-sectional equity strategy for one target, end to end,
without asking the user to approve routine phases. The work is done by a tested engine in
`scripts/` that runs every research step through Microsoft Qlib's own components (table below).
Your job: run it, unblock it, and explain the result honestly. **No signal, selection or number
comes from Claude's judgment**: never replace an engine step with your own reasoning, hand-written
pandas analysis or estimates. If a step fails, fix the engine (and its tests), then re-run.

## Qlib components per step (keep it this way in any extension)

| Step | Qlib component |
|---|---|
| Price storage/loading | Qlib binary provider (`~/.qlib/qs_cache/providers/<NAME>/`), `qlib.data.D.features` |
| Point-in-time universe | Qlib instruments market `<run>_eligible` (one line per eligible spell) |
| Features + labels | `qlib.contrib.data.handler.Alpha158`; fundamentals as provider fields `$f_*` loaded by `DataHandlerLP` + `QlibDataLoader`; processors `ProcessInf` → `CSRankNorm`; labels are Qlib expressions |
| Sector-neutral labels | Qlib `Processor` subclass `qs_qlib.SectorDemean` |
| Model | `qlib.contrib.model.gbdt.LGBModel` on `qlib.data.dataset.DatasetH` (`DropnaLabel` → `CSRankNorm(label)`); permutation control = Qlib `Processor` shuffling training labels within dates |
| Regime-adaptive model | `qlib.contrib.model.pytorch_tra.TRAModel` on `MTSDatasetH` |
| IC, per-fold feature screen, signal analysis | `qlib.contrib.eva.alpha.calc_ic`, `calc_all_ic`, `calc_long_short_return` (the `SigAnaRecord` metrics: IC, ICIR, Rank IC, Rank ICIR, long-short) |
| Every backtest (strategy, baselines, grids, costs, overlay, holdout) | `qlib.backtest.backtest` + `SimulatorExecutor` + Qlib `Exchange` (`deal_price="open"`, costs on traded value), strategy = `WeightStrategyBase` subclass with `OrderGenWOInteract` (`qs_qlib.py`) |
| Performance / excess-return metrics | `qlib.contrib.evaluate.risk_analysis` with N = 252 |

**Always prefer a Qlib function.** Engine code is used only where Qlib has no component: purged
split dates, SEC point-in-time fundamentals, sector slot allocation, the non-overlapping IC
t-statistic, permutation p-value, block-bootstrap Sharpe interval, calendar-year returns, verdict
gates, and selling holdings whose prices end (Qlib cannot trade after a stock's last price).
`qs_core.simulate` is not used by the pipeline; it stays in the test suite as an independent check
that Qlib's backtest is set up correctly (same NAV within tolerance).

## How to run (do this, in order)

1. **Start or resume the engine** from the user's project folder (the working directory):
   ```bash
   ~/.claude/skills/quant-strategy/scripts/run.sh run --target <TARGET> --workdir "<project dir>" [options]
   ```
   Always use `run_in_background: true` and wait for the completion notification (check
   progress with `run.sh status ...` or the log). Typical wall time on this Mac: 30 names
   ~5–10 min; ~100 names (275 historical Nasdaq-100 members) ~25 min; add ~30–90 min when
   the TRA comparison runs. Re-running the identical command **resumes** at the first
   incomplete phase (the model, permutation and TRA steps checkpoint per fold/permutation).
   Do not ask the user to say "continue" or to approve phases.
2. **Universe.** The engine resolves membership itself (see "Membership"). If it stops with
   "No constituent list", find the target's constituents (prefer a historical membership
   list; otherwise the current holdings from the ETF/index provider) and re-run with
   `--membership-file <file>` (lines `TICKER<TAB>start<TAB>end`) or `--tickers "A,B,..."`
   plus `--benchmark <ETF>` if the target is not itself a tradable ETF, using the **same command
   otherwise** (options may change freely until the design phase freezes the splits). Say which
   source and as-of date you used.
3. **If a phase fails**, read `quant_runs/<NAME>/phase_status.json` (`error`, `trace`), fix the
   cause (environment, data, or an engine bug — then run `run.sh --test`), and re-run the same
   command. Never hand-edit result files. After the design phase, changing a frozen option on
   resume is refused: use `--run-id <new>` for a new run.
4. **When it finishes**, read `quant_runs/<NAME>/report.md` and give the user: the verdict line,
   the membership kind and price coverage, the headline table, NAV/drawdown and annual-return
   charts (`plots/*.png`), costs, the TRA comparison if it ran, and the limitations. Quote
   numbers from the files. A negative verdict is a complete, successful run.
5. **Holdout honesty.** Never present a holdout as untouched if the report says "previously
   examined" (the engine keeps a registry of evaluated windows per target in
   `~/.qlib/qs_cache/holdout_registry.json`). Never pick models, parameters or experiments by
   looking at a holdout; extra experiments go on development folds only. After a holdout has
   been seen, the only clean test is data after the run's end date.
6. **Paper/live trading:** only on explicit user request, as a separate step. Never place
   orders, load LaunchAgents/cron jobs, or touch existing trading folders, models, `.env`
   files or account state as part of this skill.

## Options

| Option | Default | Meaning |
|---|---|---|
| `--target` | required | `QQQ`/`NDX`/`nasdaq100`, `SPY`/`sp500`, `SOX`/`semiconductors`, `DIA`, … or `custom` with `--tickers` |
| `--membership-file` | – | historical membership intervals (point-in-time universe) |
| `--tickers` | – | comma list (treated as a snapshot: survivorship bias disclosed) |
| `--benchmark` | target ETF (SOX→SOXX, sp500→SPY) | buy-and-hold comparison ETF; `''` for none |
| `--data-source` | `auto` | `auto`: shared Qlib data if ≤45 days stale, else Yahoo (cached) with shared Qlib as fallback for names Yahoo no longer serves; `qlib`: offline; `yahoo`: force |
| `--features` | `alpha158` | `alpha158` (Qlib price/volume), `fundamental` (SEC XBRL point-in-time factors), `both` |
| `--neutralize` | `none` | `sector`: labels and IC relative to the same-day SIC-sector average; sector-balanced top-K for the strategy, momentum and random baselines |
| `--advanced` | `auto` | `auto`: run the Qlib TRA comparison unless LightGBM is already significant **and** stable (so a LightGBM null is never final without trying TRA); `tra`: always; `off` |
| `--n-perm-tra` | 20 | TRA permutation refits, run only if TRA is selected (≥ 20 for p < 0.05 to be reachable; `0` skips it and the permutation gate then fails) |
| `--start` | 2008-01-01 | first date loaded (60-day feature warm-up added) |
| `--holdout-years` | 2 | final holdout length |
| `--cost-bps` | 10 | one-way cost per traded dollar (report adds 0/5/25/50) |
| `--n-perm` / `--n-random` / `--n-seeds` | 40 / 100 / 3 | label permutations (≥19 needed for p<0.05), random portfolios, seeds (LightGBM and TRA) |
| `--min-train-years` | 5 | training years before the first walk-forward test year |
| `--run-id` | – | separate run folder |
| `--stop-after <phase>` | – | stop cleanly after a phase |
| `--force-holdout` | off | re-evaluate a completed holdout (report then says it is not untouched) |
| `--null-signal` | off | **test only**: shuffles features; must end in "NO RELIABLE STRATEGY FOUND" |

Outputs: `<workdir>/quant_runs/<NAME>[_<run-id>]/` (stable name, so resume works on any day).

## Membership (phase 2) — prefer point-in-time

1. `--membership-file` → point-in-time (user-supplied, not independently verified).
2. Nasdaq-100 (QQQ/NDX): Nasdaq's index-weighting endpoint (the source Qlib's collector uses),
   monthly samples, every change located to the exact day; cached in `~/.qlib/qs_cache/membership/`.
3. A Qlib instrument file with real intervals (e.g. `sp500.txt`, `nasdaq100.txt` from Qlib's US
   data) → point-in-time up to the file's as-of date, frozen afterwards ("partial").
4. Otherwise a snapshot (e.g. `sox.txt`, `dia.txt`, `--tickers`) → labelled SNAPSHOT; survivorship
   bias is not removed and the report says so.

A name is **eligible** on a day only if it was a member and has prices. Labels, training rows,
predictions, and every baseline use eligible names only. Members without prices are listed in
the report with a yearly coverage table. Held names whose prices end (delisting/acquisition) are
sold at their last close; true delisting returns are unknown.

## Data (phase 3)

- Yahoo adjusted bars are cached in `~/.qlib/qs_cache/yahoo/` (only missing/stale tickers are
  downloaded); names Yahoo no longer serves come from the shared Qlib store
  `~/.qlib/qlib_data/us_data` (read-only, never modified). A per-target Qlib provider is written
  to `~/.qlib/qs_cache/providers/<NAME>/` and all features come from Qlib.
- **Date alignment of the shared store is measured, not assumed**: on this machine series that
  were re-dumped to extend them past Qlib's original 2020-11 end are dated one trading day early,
  original series are correct. The engine measures the offset per ticker against Yahoo, applies
  the group consensus elsewhere, and records it (`data_audit.json`).
- Each member's price source is the one covering more of its membership days (Yahoo's "FB" is
  now an unrelated 2025 instrument; the shared store has Facebook 2012–2020). Yahoo symbols whose
  returns contradict the shared series are rejected (symbol reuse).
- Renames: detected when the old symbol's prices stop, the new symbol joins the index next, and
  prices match inside the old membership period (FB→META); plus a short curated list of pure
  ticker changes whose old symbol has no data anywhere (PCLN→BKNG, KFT→MDLZ, RIMM→BB, SYMC→GEN,
  HANS→MNST, CTRP→TCOM, ERTS→EA), marked "not price-verified" in the audit.
- **Every correction without direct price evidence is flagged**, never presented as verified:
  inferred/unmeasured date alignment, coverage-only source choices, curated renames
  (`data_audit.json` → `uncertain_corrections`; listed in the report).

## Fundamentals and sector neutrality (v1.1, `qs_fundamentals.py`)

- Source: SEC EDGAR's free XBRL company-facts API (`data.sec.gov`), cached in
  `~/.qlib/qs_cache/sec/`. SEC requires a contact in the User-Agent: the engine reads one line
  (e.g. `my-research name@example.com`) from `~/.config/quant-strategy/sec_user_agent` or
  `$QS_SEC_USER_AGENT`, and stops with instructions if it is missing. Ask the user which contact
  to use; never invent one and never write it into reports or the project folder.
- **Point-in-time:** a value is usable from the first trading day after its `filed` date, and
  only the earliest filing of each period counts (restatements never leak backwards). Flows are
  trailing twelve months (annual facts, else four quarters; Q4 and cash-flow quarters derived from
  year-to-date values). Whenever several facts could supply a value, the earliest-filed one wins;
  facts dated after their own filing are dropped. A look-ahead audit rebuilds **every** mapped
  company from the filings available at two past dates and requires identical values.
- **Market value** = cover-page public float rolled forward with the adjusted close (split-proof;
  excludes insiders; includes dividends). Features: E/P, B/M, S/P, CF/P, size, ROE, ROA, GP/A,
  OP/A, accruals, leverage, revenue growth, earnings change, asset growth, SUE (`F_*`).
- **Ticker → CIK:** SEC's current ticker list, the run's renames, then full-text search for
  "symbol TICKER" in 10-K/10-Q filings during the membership period; each candidate must have
  filed during the priced membership (searched ones also a public float ≥ $1B). Searched mappings
  are flagged uncertain in the report.
- With fundamentals, a name-day is eligible only if core fundamentals are known; the strategy and
  every baseline use that same reduced universe, and the research start moves to when coverage
  exists (XBRL began 2009–2011). The report shows coverage by year and per feature.
- Sectors are the **current** SEC SIC code grouped into 11 GICS-like sectors.
- A long-short diagnostic (top-K minus bottom-K, costs on both legs, no borrow) is reported for
  every run; it is not a gate.

## Report wording

All statements about membership (historical vs snapshot), holdout status (untouched vs
previously examined) and renames (price-verified vs curated) are generated from run metadata by
`scripts/qs_describe.py`. The report phase refuses to write a report that contradicts the metadata.
Quote these statements as written.

## Phases (engine: `scripts/qs_pipeline.py`)

| # | Phase | What it does | Key output |
|---|---|---|---|
| 1 | env | interpreter, versions, shared-store coverage | `env.json` |
| 2 | universe | membership (above) | `universe.json`, `data/membership.csv` |
| 3 | data | prices, alignment, eligibility, coverage | `data_audit.json`, `data/prices.pkl`, `data/eligible.pkl` |
| 4 | design | **freezes** yearly walk-forward folds + holdout; purge = longest horizon + 1 days | `splits.json`, `config.json` |
| 5 | features | Qlib `Alpha158`, per-date `CSRankNorm`; labels 5/10/20/40d; look-ahead audit | `data/features.pkl`, `features.json` |
| 6 | factors | factor IC by horizon on the first fold's training window only; horizon by non-overlapping t-stats | `factors.json` |
| 7 | model | Qlib `LGBModel` per fold, feature selection inside each fold, seed-averaged | `model.json`, `results/pred_dev.pkl` |
| 8 | robustness | label-permutation p-value, per-year/regime IC, seed spread | `robustness.json` |
| 9 | advanced | Qlib TRA (3 states, router, horizon-masked loss memory) and its 1-state RNN backbone on the same development folds and features; TRA replaces LightGBM only if a pre-set rule passes, and then gets its own permutation control; a LightGBM+TRA rank-average blend is reported for information only | `advanced.json` |
| 10 | portfolio | top-K / n_drop grid on development years; baselines; costs; break-even | `portfolio.json` |
| 11 | overlay | three overlay families, 10 grid points each: vol targeting, drawdown control, trend filter (equal-weight universe vs its moving average); a family is kept only if its best point gains ≥ 0.10 Sharpe **and** ≥ 60% of its own grid improves; at most one family is used | `overlay.json` |
| 12 | holdout | retrain selected model on pre-holdout data, evaluate once, bootstrap CI, registry check, verdict | `holdout_results.json` |
| 13 | report | report, charts, CSVs, leave-one-out concentration, code archive | `report.md`, `plots/`, `code/` |

## Rules the engine enforces (keep them in any extension)

- **Timing:** features at close *t* → fill at the **open of t+1** → label `open(t+1+h)/open(t+1) − 1`.
- **No overlap:** each train/valid segment ends `max_h+1` trading days before the next one;
  development statistics use only labels realised before the holdout; TRA's loss memory is
  masked by `h+1` days.
- **Selection on development data only:** horizon (first fold's train window), features (per
  fold), TRA vs LightGBM (rule: mean IC gain > 0.005, paired non-overlapping t > 2, every seed
  better, TRA IC t > 2), portfolio K/n_drop and overlay (development years).
- **Accounting:** Qlib's account (shares and cash), weight drift between rebalances, idle cash 0%,
  costs on every traded dollar, no shorting/borrowing; baselines (equal-weight eligible members,
  momentum top-K, random top-K, benchmark ETF) run through the same Qlib backtest, dates and costs.
- **The verdict judges the model that is traded:** if TRA is selected, the development IC t-stat
  and permutation gates use TRA's walk-forward IC and TRA's own permutation control (not
  LightGBM's). A selected model whose permutation control did not run fails that gate.
- **Verdict gates** (`qs_core.verdict`): development IC t-stat > 2, permutation p < 0.05, dev
  Sharpe > equal-weight, > random 95th percentile, > momentum; holdout IC > 0, excess vs
  equal-weight > 0, bootstrap Sharpe CI lower bound > 0, Sharpe > random 95th percentile. All
  pass → candidate; dev passes but holdout fails → inconclusive; otherwise **NO RELIABLE
  STRATEGY FOUND**. A previously examined holdout is labelled as such in the verdict.

## Environment notes

- `run.sh` finds the interpreter that already imports `qlib, lightgbm, pandas, numpy,
  matplotlib` (Framework/Homebrew/pyenv/conda), caches it in `~/.cache/quant-strategy/python`,
  and never installs a second copy (`QS_PYTHON=/path` overrides). TRA needs `torch` in it.
- The engine runs from `/tmp` and strips the CWD from `sys.path` (a cloned `qlib/` folder can't
  shadow the package); Qlib uses `kernels=1` (multi-process loading hung on macOS).
- `run.sh --test` runs four test suites (51 tests): `test_qs_core.py` (simulator, splits,
  membership, verdict incl. selected-model gates, label shuffle, overlay exposures use only past
  data, overlay family rule), `test_qs_data.py` (date alignment, symbol reuse, renames, missing member
  prices, report wording), `test_qs_fund.py` (filing-date timing, restatements, TTM, split-proof
  market value, truncation audit, SEC filer mapping incl. reorganised companies, SIC sectors,
  sector-balanced targets) and `test_qs_qlib.py` (Qlib backtest vs own simulator, signal-close →
  next-open fill, delisted holdings, risk_analysis vs own metrics, calc_ic, LGBModel learns a real
  signal and not a shuffled one, provider fields and point-in-time market).

## Known limitations (state them when relevant)

- Point-in-time membership exists only for Nasdaq-100 (full), S&P 500 (up to the as-of date of the
  local Qlib `sp500.txt`) or a user file; other targets are snapshots.
- Fundamentals are US SEC filers only (XBRL from 2009–2011); some delisted members cannot be
  mapped to a filer; SIC sectors are current, not historical.
- Members Yahoo no longer serves and the shared store lacks (often delisted names) are missing;
  the coverage table shows how much.
- No forward-test command yet: after a holdout is seen, a clean test needs data after the run's end.
- See `references/methodology_improvements.md` for the audit of the original SOX project and
  `references/sox_workflow_map.md` for how each step of that research maps onto this engine.
- Wall time: when TRA is selected, its permutation control adds about 20 × the TRA development
  time (hours, resumable). Use `--n-perm-tra 0` only for exploration; the verdict then cannot pass.
