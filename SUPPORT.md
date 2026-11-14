# Getting Help

## Where to ask

- **Setup problems, bugs, and how something works:** open an issue using one of the templates. Blank issues are disabled, so the templates list what to include.
- **Strategy ideas to discuss:** use the "Strategy idea" template.
- **Security problems:** do not use issues. Follow `SECURITY.md`.
- **Other questions:** open an issue with the "Bug report" or "Feature request" template, or use GitHub Discussions if it is enabled on the repository.

Before asking, read the README and `docs/FAQ.md`.

## What to include

- The output of `curl -s http://127.0.0.1:4377/api/health`. Add `?refresh=1` if the page may show an old result. Read it before pasting: it lists local paths and tool versions.
- Your macOS version (`sw_vers -productVersion`) and chip (`uname -m`: `arm64` or `x86_64`).
- Your Node version (`node -v`). Helm needs 20 or newer.
- The Helm commit (`git rev-parse --short HEAD`).
- What you ran, what you expected, and what happened, with the exact error text from the page or from the terminal running `npm start`.

Remove API keys, Alpaca credentials and personal data before pasting anything. Do not attach the contents of `data/` or `projects/`.

## Disclaimer

Helm is a research tool. It is not financial advice, and nothing in this project recommends buying, selling or holding any security. Its backtests describe past data: free, dividend-adjusted US daily prices with simplified cost and slippage assumptions, and no minute data. Its paper-trading module connects only to the Alpaca paper environment and cannot place live orders. Paper results are not evidence that a strategy will work with real money. You are responsible for your own decisions.
