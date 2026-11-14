# Community strategy ideas

A place to share strategy *ideas* between Helm users, one Markdown file per idea, with the validation numbers attached. The point is the record, not the pitch: an idea that was tested and rejected is as welcome as one that passed.

Helm is a research tool. Nothing here is investment advice, and nothing here is a performance claim unless it carries the validation numbers described below.

## How it works

- Copy [strategies/TEMPLATE.md](strategies/TEMPLATE.md) to `strategies/<short-name>.md` and fill it in. The folder is described in [strategies/README.md](strategies/README.md).
- One idea per file. Keep the rules precise enough that someone else could reproduce them in Helm.
- Do not paste whole projects, API keys, `.env` contents, anything from `data/secrets`, or proprietary data. Share rules and numbers, not private files.
- Submit through a pull request. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the general process. The maintainer reviews each submission for completeness (rules, data, results, including failed checks) and may ask for changes before merging.

## Submission rules

1. **Report the number of trials.** State how many backtests, formulas or variants you tried on the same history for this idea (Helm's `validate_backtest` shows the trial count; failed and deleted attempts count). A result without its trial count is not accepted.
2. **Report the holdout outcome.** Say whether the holdout period was run, how many times (Helm logs each run), and what happened. If you did not run it, say so and use the status `idea` or `tested-rejected`, not `tested-passed-holdout`.
3. **Rejected ideas are welcome.** Negative results stop other people repeating the same work. Use the status `tested-rejected` and explain what failed.
4. **No performance claims without the validation numbers.** Return, Sharpe or drawdown figures must come with the validation output (Sharpe confidence interval, benchmark comparison, deflated Sharpe, trial count, holdout result), taken from tool output rather than recalled from memory.
5. **No investment advice.** Do not tell readers to buy, sell or hold anything, and do not describe results as expected future returns.
6. **State the data limits.** Helm's local data is free adjusted daily prices; mention survivorship bias, data gaps and assumed costs and slippage where they apply.
7. **Be honest about the process.** If you changed the rules after seeing results, or looked at the holdout more than once, say so. A paper-trading status needs the freeze date and the number of trading days observed.

## Status values

| Status | Meaning |
|---|---|
| `idea` | Written down, not yet tested in Helm |
| `tested-rejected` | Tested and failed an idea test, validation or holdout |
| `tested-passed-holdout` | Passed validation on the development period and then the holdout, with the numbers reported |
| `paper` | Running or has run as a paper-trading session; forward results are reported with the observed number of trading days |

## What this folder is not

It is not a leaderboard, a signal service, or a place for live-trading advice. Helm cannot place live orders and this folder does not change that.
