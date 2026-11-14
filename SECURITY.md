# Security Policy

Helm runs on your own Mac. It drives Claude Code agents that can write and run code. Its safety rests on several boundaries: a web server bound to `127.0.0.1` with Host, Origin and token checks; an approval policy for agent file edits and commands; a macOS sandbox for strategy and verification code; and paper-trading-only broker access. Breaking one of these is a vulnerability.

## What counts as a vulnerability

Report these privately:

- **Agent escapes.** An agent runs a command, writes a protected file, or approves its own request without your approval. For example, an agent-written script that reads `data/secrets/` or rewrites `lib/change-policy.mjs`.
- **Secret exposure.** Anything that lets the agent, a strategy, a web page or another local site read Alpaca keys in `data/secrets/`, `ALPACA_*` or `APCA_*` environment variables, or the page token `X-Helm-UI-Token`.
- **Live trading.** Any path that places an order at a live broker, sends orders anywhere other than the Alpaca paper endpoint, or lets an agent place or cancel orders.
- **Future-data leakage.** Any way for a backtest, strategy or the qlib engine to see information dated after the day it is evaluated. We treat this as a security-grade integrity bug, because it makes results untrustworthy.
- **Request forgery and auth bypass.** A page or local site making a state-changing request without the token, or getting past the Host, Origin or `Sec-Fetch-Site` checks.
- **Injection.** Script injection in the page, command injection through project IDs or other input, or path traversal out of `projects/` or `data/`.
- **Unrequested deletion.** Deleting a file, backtest or record without the explicit per-message delete permission.

Not security issues, so open a normal issue: statistical errors that do not leak future data, crashes that return an error page, UI bugs and slowness. The README notes that a program running as your own user can read the page token by fetching the page. That is a documented limit of the defense, not a new finding.

## How to report

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a vulnerability.

Include:

- The commit (`git rev-parse HEAD`), your macOS version and your Node version.
- Steps to reproduce, with the smallest example that shows the problem.
- What you expected and what happened.
- For agent issues, the prompt and the approval card text that was shown.

## What not to include

Never send real API keys, Alpaca credentials, the contents of `data/secrets/`, `.env`, conversation files under `data/threads/`, or account numbers. Redact them, or use a fake value that has the same shape. If a secret has already been exposed, revoke it: regenerate the paper key at app.alpaca.markets, then reconnect in Helm.

## Supported versions

Only the latest commit on the default branch receives security fixes. Older commits are not patched.

The maintainer aims to acknowledge a report within 7 days. This is a personal project, so there is no guaranteed response time.
