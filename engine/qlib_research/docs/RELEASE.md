# quant-strategy — research version 1.2.0 (2026-10-21)

Changes since 1.1.0, aimed at covering the steps of the original SOX research without its
selection leaks (map: `references/sox_workflow_map.md`):

- **TRA is tried in the SOX situation.** `--advanced auto` now runs the Qlib TRA comparison
  unless LightGBM is already significant and stable. Before, a LightGBM null skipped TRA, so the
  model that carried the SOX research was never tried on a SOX-like target.
- **The verdict judges the traded model.** If TRA is selected it gets its own permutation control
  (`--n-perm-tra`, default 20, resumable) and the development gates use TRA's IC t-stat and
  permutation p. Before, a selected TRA was judged on LightGBM's statistics.
- **Overlays:** drawdown control and a trend filter join vol targeting; each family is judged on
  development years with its own gain-and-breadth rule, and at most one is kept.
- **Ensemble check:** a LightGBM+TRA rank-average blend is reported (information only).
- 4 new tests (51 total): selected-model gates, label shuffle, overlays use only past data,
  overlay family rule.

# quant-strategy — research version 1.0.0 (2026-10-19)

Resumable, Qlib-based research skill: given a target index/ETF/sector or ticker list, it builds a
point-in-time (or explicitly labelled snapshot) universe, researches Alpha158 factors, fits
LightGBM (optionally compares Qlib TRA on development folds), backtests with share/cash
accounting against equal-weight, momentum, random and ETF baselines, and writes a report whose
wording is generated from run metadata. "No reliable strategy found" is a valid result.

## Usage

```bash
/quant-strategy QQQ                     # in Claude Code: the skill drives the engine end to end
~/.claude/skills/quant-strategy/scripts/run.sh run --target QQQ --workdir "<project dir>"   # direct
~/.claude/skills/quant-strategy/scripts/run.sh status --target QQQ --workdir "<project dir>"
~/.claude/skills/quant-strategy/scripts/run.sh --test   # 23 regression/unit tests
```

- Re-running the same command resumes at the first incomplete phase.
- Targets without a built-in list stop with "No constituent list": re-run the same command with
  `--tickers "A,B,..."` (snapshot) or `--membership-file` (historical), plus `--benchmark <ETF>`.
- `--advanced tra` forces the Qlib TRA comparison (development folds only); default `auto`
  runs it only when robustness flags it.
- Results: `<workdir>/quant_runs/<NAME>/report.md`, `plots/`, `*.json` audits.

## Supported scope

- US equities, daily bars, long-only top-K portfolios, 5/10/20/40-day horizons.
- Membership: Nasdaq-100 historical (official Nasdaq endpoint, day-exact); S&P 500 historical to
  2020-11 (Qlib file), frozen afterwards; anything else is a labelled snapshot unless the user
  supplies a historical membership file.
- Data: Yahoo (cached) plus the local shared Qlib store for names Yahoo no longer serves, with
  per-ticker date-alignment measurement; Qlib Alpha158 features via a per-target Qlib provider.
- Python with qlib 0.9.x, lightgbm, pandas, numpy, matplotlib (torch for TRA); macOS tested.

## Test evidence (see `evidence/` in the release folder)

- `run.sh --test`: 23 tests pass — simulator timing/costs/cash, purged splits, verdict gates,
  membership, delisting, **date alignment, symbol reuse, renames (verified/curated/contradicted),
  missing member prices, report wording/contradiction check**. A mutation check shows the new
  tests fail when each behaviour is broken (6/6 mutants killed).
- Fresh-session acceptance on the final code: `/quant-strategy XLE` (new session, no context)
  resolved constituents itself, ran all 13 phases (~6.5 min) unattended, labelled the holdout as
  previously examined, verdict NO RELIABLE STRATEGY FOUND.
- QQQ (historical membership, TRA comparison): data phase re-run with the v1.0.0 data code gave
  byte-identical model inputs, so the LightGBM/permutation/TRA/holdout results stand without
  retraining. Verdict NO RELIABLE STRATEGY FOUND (dev IC +0.0050, t 0.23, permutation p 0.195; TRA
  not selected; holdout previously examined).
- Interruption/resume (SIGKILL mid-permutations → identical outputs), look-ahead audit (0.0 diff),
  frozen-config and holdout-lock guards: verified earlier the same day.

## Known limitations

- Historical membership only for Nasdaq-100 (full) and S&P 500 (to 2020-11); other targets are
  snapshots with survivorship bias (disclosed in every report).
- Members without prices in either source are excluded (QQQ: 88.2% member-day coverage; 44 of 275
  members unpriced); delisting returns are approximated by the last close.
- 46 data corrections in the QQQ run are flagged as not price-verified (7 curated renames, 2
  coverage-only source choices, 37 shared series whose date alignment was inferred from their
  group, where 70/70 measured peers agreed).
- The shared Qlib store on this machine has re-dumped series dated one day early; the engine
  corrects this when reading but does not repair the store.
- TRA is slow on CPU (~75 min for QQQ) and runs with a bounded epoch budget.
- No forward-test command: once a holdout has been examined, a clean test needs data after the
  run's end date (optional next feature).
- Not investment advice; no execution component (paper/live trading is out of scope).

## Changes since the first draft (Opus 4.6 prose-only skill)

Tested engine; point-in-time membership; shared-store date-alignment fix; symbol-reuse/rename
handling with provenance; Qlib TRA comparison; holdout registry; metadata-driven report wording
with contradiction check; options changeable until the design is frozen.
