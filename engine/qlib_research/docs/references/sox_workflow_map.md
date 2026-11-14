# How the original SOX research maps onto the engine (v1.2.0)

The SOX strategy was built in 15 phases (`Quant Strategy/methodology_report.md`). This table shows
where each one lives in the engine, and why some steps are deliberately not reproduced. Several
SOX steps were tuned on the same years they were tested on (see `methodology_improvements.md`),
so the engine keeps each step's idea but runs it under development-only selection rules.

| SOX phase | Engine | Notes |
|---|---|---|
| 1. Environment, S&P 500 1-day baseline | `env` | 1-day horizon dropped: no signal in SOX, and 5/10/20/40 days cover the useful range. |
| 2. Multi-horizon factor IC (1/5/20d) → 20-day horizon | `factors` | Horizons 5/10/20/40. Picked on the first fold's training window only, by non-overlapping t-stats (overlapping daily ICIR favours long horizons mechanically). |
| 3–4. LightGBM 20d, tuning, 33 chosen factors, n_drop | `model`, `portfolio` | Fixed regularised LightGBM close to SOX "tuned v3" (depth 3, 8 leaves, λ 0.05). Factors are re-screened inside every fold (15–60 by ICIR) instead of one list chosen on test years. n_drop and K come from a small grid on development years. |
| 5. Extend data past 2020 | `data` | Yahoo cache + shared Qlib store, with the one-day date shift of re-dumped series measured and corrected. |
| 6. Cross-index generalisation | not a phase | Run the skill once per target (`/quant-strategy QQQ`, `SPY`, `DIA`, …). Each run has its own universe, horizon and holdout; compare the reports. |
| 7. Rolling (expanding) retrain | `design`, `model` | The default: yearly walk-forward folds with purged validation. |
| 8. Overfitting diagnosis | `robustness`, `holdout`, verdict | Permutation control (full refit per shuffle), IC by year and regime, seed spread, untouched holdout with bootstrap CI, fixed verdict gates. |
| 9. DDG-DA sample reweighting | not included | It did not help TRA in SOX and adds a meta-model with its own selection freedom. |
| 9. TRA | `advanced` | Qlib's `TRAModel` (3 states, router), plus its 1-state RNN backbone as a control. **v1.2:** runs automatically whenever LightGBM is not already significant and stable, which covers the SOX situation (LightGBM IC ≈ 0). Adopted only by a pre-set rule; if adopted, it gets its own permutation control and the verdict judges TRA, not LightGBM. The SOX MultiExpertGRU is not reproduced line by line. |
| 10. DDG-DA + TRA | not included | See DDG-DA. |
| 11. Full portfolio backtest | `portfolio`, `holdout` | Qlib backtest, next-open fills, share/cash accounting, costs on every traded dollar, turnover-matched momentum and random baselines, equal-weight and ETF baselines. |
| 12. Hedging overlays (regime, vol, drawdown, combined) | `overlay` | **v1.2:** vol targeting, drawdown control and a trend filter, each judged on development years with its own breadth rule; at most one is kept. The SOX "regime" overlay used the model's mean prediction, which the SOX report found unreliable; the trend filter uses the equal-weight universe instead. Combinations are not tried (more selection freedom). |
| 13. Vol-scaling sweep | `overlay` | 10-point grid per family, judged on all development years; vol is the strategy's own trailing vol (SOX used the universe's). |
| 14. Ensembles | `advanced` (information only) | **v1.2:** a LightGBM+TRA rank-average blend is reported but never selected; in SOX every blend diluted the better model. |
| 15. Paper trading | not included | Only on explicit user request, as a separate step. |

Not tuned by design: LightGBM hyperparameters (a nested search per fold would also have to be
repeated inside every permutation refit to keep the control valid) and rebalance frequency
(always the label horizon, which the SOX sweep found best).
