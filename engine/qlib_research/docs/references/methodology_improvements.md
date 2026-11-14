# Audit of the SOX project and of the first skill draft (review of 2026-10-19)

Status legend: **Verified** = reproduced by running code or reading it line by line in this
review. **Claim** = stated in `methodology_report.md` and not re-run here.

## Problems in the SOX research code (`Quant Strategy/*.py`)

| # | Finding | Evidence | Status |
|---|---|---|---|
| 1 | Same-close look-ahead in the custom simulator: on a rebalance day the newly chosen stocks are credited that day's close-to-close return, although the signal uses that day's close. | `hedged_backtest.py` `simulate_portfolio`; synthetic test: a stock that jumps +50% at the signal close adds +49.9% NAV (should be 0). `ensemble_backtest.py` has a copy of the same function. | Verified |
| 2 | Label `Ref($close,-21)/Ref($close,-1)-1` (entry at close t+1) does not match the simulator (entry effectively at close t-1). | same files | Verified |
| 3 | "Weight drift" absent: fixed weights are re-applied daily (implicit daily rebalancing) and that trading is not charged. | `simulate_portfolio` | Verified |
| 4 | Report says TopkDropout n_drop=1; the custom simulator replaces the full top-K each rebalance. Costs ignore exposure changes from vol-scaling. | `simulate_portfolio` | Verified |
| 5 | Vol-scaling "realised vol" is the equal-weight universe's vol, not the portfolio's (report says portfolio). Parameters were swept on the 2016-2024 test years. | `make_vol_exposure`, `vol_sweep.py` | Verified |
| 6 | The 33 factors were chosen from IC on 2010-2020, overlapping test years 2016-2020 (report admits). | report §3, §6 | Verified (report + code constants) |
| 7 | No purge: training ends 12-31 with 20-day labels reaching into the validation year; validation labels reach into the test year (epoch selection sees them). | `hedged_backtest.py` segments | Verified |
| 8 | Features are **not** cross-sectionally z-scored anywhere (Alpha158 default `infer_processors=[]`), contrary to the report. | Qlib `Alpha158.__init__`; no normalisation in training or inference code | Verified |
| 9 | Live IMIN/IMAX use `argmin/len`; Qlib `IdxMin` is `argmin+1` (1-based), so live = Qlib − 1/d on raw (un-normalised) inputs. The report's and the old skill's "correct formula" is still off by a constant. | `qlib/data/ops.py IdxMax/IdxMin`, `paper_trading.py:143-153` | Verified |
| 10 | Live training orders columns by family (`TOP_FACTORS` rebuilt from `FACTOR_SPEC`); backtests use Qlib column order. Consistent inside paper trading, but the deployed model is not the backtested model. | `paper_trading.py:82-85, 429` | Verified |
| 11 | `models/tra_meta.json` reports best validation IC 0.1326 at epoch 1; `SETUP.md` says -0.0614. One of them is stale. | files | Verified (discrepancy only) |
| 12 | `SETUP.md` says "No automatic trading schedule has been installed", but LaunchAgent `com.<user>.sox-paper-trading` is loaded (`launchctl list`) and runs `run_daily.sh` → `paper_trading.py run` Mon–Fri 10:00 local. Left untouched. | `launchctl list`, plist | Verified |
| 13 | Headline numbers (TRA+vol Sharpe 1.02, +23.6%/yr, MaxDD -27%) | report | Claim — produced by code with items 1-7; not trustworthy as stated |
| 14 | GRU details in the report (2 layers, self-attention, KL λ=0.1, 2-phase training) differ from code (1 layer, additive attention, entropy 0.01, single phase, τ annealed). | `hedged_backtest.py:85-200` | Verified (the previous agent also found this) |

## Problems in the first skill draft (Opus 4.6)

| Finding | Effect | Fix |
|---|---|---|
| Skill was a 665-line prose spec plus three helpers; no pipeline code. `simulate_portfolio` was referenced but did not exist in the skill. | Every run re-improvised code; nothing tested; not reproducible. | `scripts/qs_pipeline.py` + `qs_core.py`, unit tests. |
| `env_audit.py` checked only the interpreter it ran under. With default `python3` (3.14 here) it reported NOT READY, and `--install-missing` would pip-install qlib/torch/pandas into a second interpreter. | Violated "reuse existing installations". | `run.sh` finds and caches the Python that already has Qlib. |
| Run folder `quant_runs/<TARGET>_<YYYYMMDD>`. | A resume on another day started a new run. | Stable `quant_runs/<NAME>`; `--run-id` for deliberate new runs. |
| `phase_status.py` names (`phase_1_env_audit`) differ from SKILL.md (`phase_1`); nothing called it; `--skip-to` marked phases "skipped" and dropped their outputs. | Resume did not work in practice. | Engine-managed status, per-fold/per-permutation checkpoints, frozen-config check. |
| Taught `IMIN = argmin/len` as "Qlib's exact formula". | Wrong by 1/d. | Corrected. |
| Holdout = last 2 years, but the split diagram put the test year inside it; purge only at train end; no rule for valid→test; label timing undefined. | Leakage and timing undefined. | `qs_core.design_splits` + `check_no_overlap` (tested); next-open label. |
| Horizon picked by count of \|ICIR\|>0.10 on overlapping daily labels. | Long horizons win mechanically. | Count of \|t\|>2 on non-overlapping dates. |
| Overlay grid on a single validation year; ensemble/TRA guidance copied SOX conclusions. | Overfitting; SOX parameters copied. | Overlay judged on all development years with a breadth rule; horizon, K and n_drop come from the target's own data. |

## Second pass (2026-10-19, later the same day)

| Finding | Evidence | Status / fix |
|---|---|---|
| The shared Qlib store `~/.qlib/qlib_data/us_data` is **dated one trading day early for every series that was re-dumped to extend it past 2020-11** (bar "d" holds real day d+1); Qlib's original series (ending 2020-11-10) are correctly dated. Calendars are identical, so the cause is the earlier extension dump, not the calendar file. | Return correlation with Yahoo: 101/101 extended series match at a +1 shift (lag-0 corr ≈ 0); 70/70 original series match at 0. Spot check: shared AAPL "2024-12-27" = 252.20 = AAPL's actual 2024-12-30 close. | Verified. Runs that use only re-dumped series (the SOX project, the first-round QQQ runs) are internally consistent — features, labels and fills shift together, so no look-ahead — but every date is one day off. Mixing re-dumped series with correctly dated data (Yahoo, original series, yfinance live data) would leak one day. The engine now measures and corrects the offset per ticker. The shared store itself was not modified. |
| The first-round QQQ universe (`qqq.txt`, a later snapshot) was applied to all history. Example: MRNA was held through the 2024-10..2026-10 holdout although it left the Nasdaq-100 on 2024-12-20; SPLK/ANSS/EA were members whose later prices were missing. | Nasdaq endpoint membership | Fixed: point-in-time membership (Nasdaq endpoint), eligibility masks, delisting liquidation, coverage disclosure. |
| Pre-IPO rows had zero-filled features and could receive scores; they were "selected" and left as cash because they had no open price. | code read | Fixed: only eligible (member + priced) rows are scored. |
| The QQQ holdout 2024-10-16..2026-10-16 was examined in the first round. | holdout registry | Any later run over that window is labelled "previously examined"; TRA vs LightGBM selection uses development folds only. |
