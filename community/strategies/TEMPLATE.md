---
title: <Short descriptive title>
author: <your handle>
universe: <e.g. a ticker list, or a Helm universe such as sp500 (point-in-time) or dia (snapshot, survivorship bias)>
data_required: <e.g. Yahoo adjusted daily prices; FRED series IDs; qlib fundamentals; custom dataset name and version>
validation_mode: <standard | risk-adjusted>   # risk-adjusted = timing strategies, set by the user before looking at the holdout
status: <idea | tested-rejected | tested-passed-holdout | paper>
helm_version: <the commit hash or date of the Helm version you used>
date: <YYYY-MM-DD>
---

# <Title>

## Original idea
<The idea in your own words, as you would have typed it into Helm.>

## Differences from the original wording
<Where the precise rules differ from the idea, and why. Write "none" if there are none.>

## Hypothesis
<Why might this work? What would make it stop working? One short paragraph. A reason, not a promise.>

## Rules
Use the rows of Helm's rules table. Be exact about thresholds, comparison direction, windows and dates.

| Row | Rule |
|---|---|
| Universe | |
| Data (field, frequency) | |
| Entry / exit | |
| Indicators and parameters | |
| Warm-up | |
| Signal time -> fill time | |
| Position sizing | |
| Cash | |
| Rebalancing | |
| Costs and slippage | |
| Benchmark | |
| Periods and starting capital | development: ...; holdout: ... |

## Ambiguities and choices
<Where the idea could be read more than one way, which reading you chose and what the other was.>

## How it was validated
- Idea test (for stock-selection ideas): <formulas tried, development period only, verdict>
- Backtest roles and periods: <development / holdout, which run is the main version>
- Statistical validation: <which `validate_backtest` checks passed or failed>
- Robustness: <segment stability, cost stress, regimes, parameter sensitivity, tuning and PBO if used>
- Process notes: <rules changed after seeing results? holdout looked at more than once?>

## Results
Fill every row. Numbers must come from tool output.

| Item | Value |
|---|---|
| Number of trials (all backtests and formulas on this history, including failed and deleted) | |
| Development period | |
| Holdout period run? how many times? | |
| Holdout outcome | |
| Sharpe, 95% CI | |
| Beat benchmark with confidence | |
| Deflated Sharpe | |
| Max drawdown vs benchmark | |
| Paper trading (freeze date, trading days observed, within expectations?) | |

## Known weaknesses
<Data limits (adjusted prices, survivorship bias, data gaps), cost assumptions, sample length, regime dependence, anything the validation did not cover.>

## Disclaimer
Research notes only. Not investment advice. Past results do not predict future results.
