# Frequently Asked Questions

Answers are taken from the README. For setup detail, follow the README's 「安装」 section.

## Does Helm cost anything?

The README describes Helm as free. It lists no paid service. The agents run through the `claude` command on your Mac, so you need Claude Code installed and logged in. Creating an Alpaca paper account is only needed for the Alpaca mode of paper trading.

## What data does it have?

- Daily, adjusted prices for US stocks and ETFs, from Yahoo Finance, from each listing date to the previous trading day.
- No minute data, options, futures, forex or crypto.
- qlib research data: historical S&P 500 and Nasdaq 100 membership, and SEC fundamentals. These are used in research and reach LEAN strategies only through exported scores.
- FRED macro series, downloaded with `fetch_macro`.
- Custom datasets that an agent builds from public web sources. Each row carries an `available_date`, and the backtest page shows a reminder that the data is web-sourced.

## Does the web page need internet access?

No. The README says the page loads no CDN or web fonts and works offline. Downloads need internet: prices, macro data, SEC data, and the code a backtest uses (cached for 20 hours).

## Can Helm trade with real money?

No. Paper trading uses an Alpaca paper account only. The README says the Alpaca client's address is fixed to the paper endpoint and cannot reach a live account. The internal simulation needs no account at all.

## Which computers and systems does it support?

The README describes a setup on a Mac: a .NET install in `~/.dotnet`, a Python framework install, and macOS `sandbox-exec` for running strategy code. It does not document other systems. If the sandbox is unavailable, the README says agent commands and code changes switch to asking you for approval.

## What can the agents do, and what can they not do?

They can:

- Write strategy code into project files, compile it, and run backtests.
- Run the statistical checks, qlib research and idea tests.
- Change Helm's own code, subject to the approval rules. Protected files always ask first.
- Ask you questions before they start work.

They cannot:

- Read secrets. The README lists the blocked paths, which include `~/.ssh`, `~/Library`, `.env` files and `data/secrets`.
- Start or stop paper trading, or connect Alpaca. Those are done only on the web page.
- Delete files or backtests unless you allow deletion for that message.
- Reach the network or your home directory from strategy code. It runs in the sandbox.

## Where are results stored?

- Each project is in `projects/<id>/`. Every backtest saves a code snapshot, its results and its logs.
- Paper-trading daily records are in `projects/<id>/paper/<session>/log.jsonl`.
- Conversations are in `data/threads/`.
- Custom datasets are in `helm/custom/`, the README's path, with a `.meta.json` file beside each CSV.
- Alpaca keys are in `data/secrets/alpaca.json`, file mode 0600. The web page never returns them.
- qlib data and caches are outside the repository, under `~/.qlib/`.

## Can I run a strategy on QuantConnect?

Yes. `main.py` can be pasted into the QuantConnect web IDE. The backtest page has a dialog that copies it and lists any other files to add. Strategies that use `HelmSignals`, `HelmUniverse` or `HelmMacro` read local files, so they will not run on QuantConnect as they are. QuantConnect's cloud data is unadjusted, so results will differ somewhat from Helm's.

## Why did my strategy fail the statistical check?

The check includes a trial count. Every tested formula and every tuning candidate is logged, and the more you have tried on the same universe, the higher the bar. A failed result is not deleted from the count. Use the output from the tool to see which test failed.

## Can I change how the agents behave?

Yes. `agents.json` holds the five agents' roles and prompts, and the README says you can edit them directly. `workspace/CLAUDE.md` holds the rules every agent shares.

## What does the validation period mean?

The validation period (验证期) is out-of-sample data for checking a finished strategy. Each run on it is logged. Parameter sensitivity is not allowed on it, because re-running variants there means looking at it more than once.

## Does a paper-trading result prove that a strategy works?

No. The README says the forward-test check only tests whether live results match the backtest. It does not prove the strategy works. With a few dozen trading days, returns mostly reflect chance.
