# Frequently Asked Questions

Answers are taken from the README. For setup, follow [GETTING-STARTED.md](GETTING-STARTED.md).

## Does Helm cost anything?

Helm itself is free and open source (MIT). The AI model is not: the agents run through Claude Code (`claude`) on your Mac, and that needs a Claude subscription (Pro / Max / Team), pay-as-you-go Anthropic API usage, or usage on a compatible provider such as DeepSeek or Kimi. Longer agent tasks use more. Content translation costs a few cents per few hundred passages, and a research deck about USD 0.50 with Sonnet.

Everything else is free: LEAN, the Yahoo Finance prices (personal use, under Yahoo's terms), FRED and SEC data. An Alpaca paper account is free and only needed for the Alpaca mode of paper trading.

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

macOS only. It is tested on Apple Silicon; Intel Macs are untested; Linux and Windows are not supported. Strategy code runs under macOS `sandbox-exec`, and without it backtests refuse to run unless you set `HELM_EXEC_SANDBOX=off` (see [CONFIGURATION.md](CONFIGURATION.md#sandbox-helm_exec_sandbox)). A first install needs about 2–3 GB of disk and 15–30 minutes, depending on your network.

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
- AI and Alpaca keys are in `~/Library/Application Support/Helm/secrets/` on new installs and `data/secrets/` on older ones, file mode 0600. The web page never returns them. See [CONFIGURATION.md](CONFIGURATION.md#where-keys-and-data-are-stored).
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
