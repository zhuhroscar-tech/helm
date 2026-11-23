# Getting started

[中文](GETTING-STARTED.zh.md)

From a fresh clone to your first backtest.

- **macOS only.** Tested on Apple Silicon. Intel Macs are untested. Linux and Windows are not supported (Helm's sandbox needs macOS `sandbox-exec`).
- A first install needs about 2–3 GB of disk and 15–30 minutes, depending on your network. Most of it is waiting for downloads and one compile.
- Helm itself is free and open source, but the agents use an AI model you pay for: a Claude subscription, Anthropic API usage, or a compatible provider (step 4).

Helm runs entirely on your machine. The only thing that leaves it is the conversation with the AI model you connect in step 4.

## 1. What you need before starting

| | How to check | If it's missing |
|---|---|---|
| Node 20 or newer | `node -v` | `brew install node`, or the installer from nodejs.org |
| Git | `git --version` | `xcode-select --install` |
| Claude Code | `claude --version` | `curl -fsSL https://claude.ai/install.sh \| bash`, then run `claude` once to log in |
| uv (Python tool) | `uv --version` | `brew install uv` (the setup script offers to do this). No Homebrew: `curl -LsSf https://astral.sh/uv/install.sh \| sh` ([details](https://docs.astral.sh/uv/getting-started/installation/)) |

If you prefer npm: `npm install -g @anthropic-ai/claude-code`. With Node from the nodejs.org installer this often fails with `EACCES` (permission denied); use the install script above rather than `sudo`. After installing, open a new terminal so `claude` is on your PATH.

Claude Code is what actually runs the agents. You don't have to use it with a Claude subscription: an Anthropic API key or a compatible provider such as DeepSeek or Kimi also works, and you choose in step 4.

## 2. Get the code and install the engine

Shortcut: `curl -fsSL https://raw.githubusercontent.com/zhuhroscar-tech/helm/main/install.sh | bash` does steps 2 and 3 for you (and offers to install Claude Code and build the app). It asks before each change. The manual steps:

```
git clone https://github.com/zhuhroscar-tech/helm.git
cd helm
scripts/setup.sh --check
```

Downloading instead of cloning? **Code → Download ZIP** on GitHub works too. The unzipped folder is called `helm-main`, so use `cd helm-main` instead.

`--check` only reports what's missing and changes nothing. When you're happy with the list, run it for real:

```
scripts/setup.sh
```

It shows each step and asks before doing it (`--yes` skips the questions). Nothing needs `sudo`, and everything goes into your home folder or the repo:

- the .NET 10 SDK, into `~/.dotnet` (about 650 MB)
- the LEAN backtesting engine from QuantConnect, at a commit Helm is tested with, downloaded into `engine/Lean` and compiled (about 950 MB; the compile takes a few minutes)
- a Python 3.11 environment in `engine/.venv` with the packages in `engine/requirements.txt` (about 370 MB)

Messages follow your system language (Chinese if `LANG` starts with `zh`, English otherwise).

There is no `npm install`. Helm has no npm dependencies.

The script ends with `Required components are in place.` If it prints `Still missing: ...` instead, fix what it names and run `scripts/setup.sh --check` again.

## 3. Start Helm

```
npm start
```

When the terminal prints the address `http://localhost:4377`, open it in your browser. Leave the terminal open; Ctrl+C stops Helm. (Parts of the startup log may be in Chinese. You don't need to read it: the page itself tells you whether anything is missing.)

The first time you open it, a short setup guide walks you through the same checks as this page and then points out where everything is. You can reopen it any time: click **Settings** at the bottom left, then **Setup guide**.

The page opens in English if your browser is set to English. To switch language or light/dark mode, click **Settings** at the bottom left and use **Appearance and language**.

If something is still missing, the page shows an environment check with the exact command to run for each item. Fix it and click **Check again**. Two exceptions need a restart of Helm (Ctrl+C, then `npm start`): installing Claude Code, and editing `.env`.

### Prefer an app?

```
macos/build.sh --install
```

This builds a small native Mac app from source and puts it in Applications. It starts the server for you, keeps running in the background when you close the window, and sends a notification when an agent is waiting on you. There is no downloadable app: you build it yourself, and it is ad-hoc signed, only for the Mac that built it. Details: [MACOS-APP.md](MACOS-APP.md).

## 4. Connect an AI

Click **AI** in the top bar. There are four choices:

- **Auto**: use whatever `claude` is already logged in with. If you've run `claude` before and logged in, this just works.
- **Claude subscription** (Pro, Max, Team): run `claude` once in a terminal and log in with that account first.
- **Anthropic API key**: paste a key from console.anthropic.com. You pay per use.
- **Other compatible API**: an endpoint that speaks the Anthropic Messages format, for example `https://api.deepseek.com/anthropic` with model `deepseek-chat`.

Helm tests the connection before saving, so a wrong key fails immediately rather than halfway through a task. Keys are stored in `~/Library/Application Support/Helm/secrets/ai.json` (older installs: `data/secrets/ai.json`), readable only by you. The page and the agents never see them.

A word on cheaper models: agents call many tools in a row, and weaker models tend to lose the thread on longer tasks. If results look confused, try a stronger model before blaming the idea.

## 5. Your first strategy

Open the chat on the right, pick **Lead**, and type something like:

> Write a SPY 50/200 moving-average crossover strategy, create a project and backtest it.

This one is a good first test because it only needs SPY prices, which download automatically.

What happens next:

1. **Spec.** Before writing code, the Lead writes a short rules sheet: universe, entries and exits, position size, costs, benchmark and dates. It's saved as the project's **Spec** tab. Skim it; this is where misunderstandings are cheapest to fix.
2. **Questions.** If something in your idea could change the result, a question card appears in the chat. Answer it. If you don't, after 15 minutes the agent goes with the option it recommended and says so in its summary.
3. **Code and backtest.** The Strategy Engineer writes LEAN code, the code is checked for unsafe imports, and the backtest runs on your machine. The first run takes a little longer while prices download.
4. **Results.** The backtest page shows the equity curve, statistics, every order, and a robustness tab. The agent explains what it sees and whether the result held up.

Everything an agent does is visible as it happens. If an agent wants to change Helm's own code or run a command outside the usual set, it asks first with a card you approve or reject. Deleting anything also needs the **Allow delete** switch under the input box, and that only lasts for one message.

## 6. Which path an idea takes: LEAN and qlib

Helm has two engines, but they are not two parallel routes. **LEAN is the trunk every idea goes through.** **qlib is an extra gate that stock-picking ideas can pass before LEAN**: it checks whether the idea showed any signal in the past.

```
Your idea
 ├─ Timing: when to buy or sell (e.g. "go to cash when SPY drops below its 20-day average")
 │     └──────────────────────────────────────────────┐
 │                                                    ▼
 └─ Stock picking: which stocks to hold       LEAN: write the strategy → backtest → checks → main version → paper trading
       └→ qlib: is there a signal? ──signal──→ export daily scores; the strategy picks from them
                  └─ no signal → stop here
```

**LEAN** (QuantConnect's open-source backtesting engine) turns the rules into code, backtests them on your machine, runs the statistical checks, sets a main version once they pass, and finally runs paper trading. Whatever the idea, the verdict is reached here.

**qlib** (Microsoft's open-source quant research framework) is only for cross-sectional stock picking: ideas like "each month, pick a certain kind of stock from the S&P 500". It has two depths:

| | What it does | When |
|---|---|---|
| Idea check | The Researcher writes the idea as 1–3 factor formulas and checks, on the dev period, whether higher-scoring stocks really did better. The verdict is Signal, Weak signal or No signal | First step for any stock-picking idea |
| Full research | LightGBM and other models, with tests and a holdout, to see whether a model beats a single factor. Takes tens of minutes | After an idea check finds a signal, if you want to go further |

If there is a signal, Helm exports the daily scores and each day's actual index members in a format LEAN can read, and the strategy picks stocks from those two (these are the `HelmSignals` and `HelmUniverse` you may see in a project description). That way the backtest only uses stocks that were really in the index at the time, not just the companies that survived to today.

**No signal means stop.** That's a result, not a failure: forcing a no-signal idea into a strategy mostly fits noise. Don't keep trying new formulas either. Helm records every formula you try, and the more you try, the higher the bar for calling something a signal.

### Choosing on the page

Under the **Write down an idea** box on the home page there are three options. They pick the path:

| Option | Path | Time |
|---|---|---|
| **Auto** (default) | The Lead decides: stock picking goes through qlib first, timing goes straight to LEAN | Depends on the idea |
| **Fast** | LEAN only: code, backtest, checks | Minutes |
| **Deep** | Stock picking goes straight to full qlib research, then exports signals into LEAN | Tens of minutes |

If unsure, use **Auto**.

The progress bar at the top of a project has four steps: Idea check → Backtest → Checks → Paper trading. Timing projects don't go through qlib, so the first step shows "skipped". That's expected.

qlib is optional; see [Optional: qlib research engine](#optional-qlib-research-engine) below. ETF, single-stock and timing strategies don't need it.

## 7. Where to go from there

**Stock-picking ideas** start with an idea check (see the previous section). Many end at "no signal", which saves you from tuning a strategy that was never there.

**Dev period and holdout.** Helm keeps the most recent stretch of data aside. You develop on the earlier part; the holdout is run once at the end. Running it repeatedly until it looks good defeats the purpose, so Helm records every attempt.

**Paper trading.** On a finished backtest, **Start paper trading** freezes the code and re-runs it after each US market close to see how it does on days it has never seen. You can also send the orders to an Alpaca paper account. Helm only talks to Alpaca's paper endpoint, so it can't place real trades.

**Presenting to your team or clients.** **Make a deck** at the top right of a project: pick a template (you can upload your firm's PowerPoint template), approve the outline, and a few minutes later you have PowerPoint and PDF files whose numbers all come from the backtest records. PDF needs LibreOffice: `brew install --cask libreoffice`.

**Idea log** and **Research pipeline** in the sidebar show everything you've tried and where each idea stands.

**Language.** Names, specs, reports and chats are translated into the UI language in the background using your AI connection, so someone who doesn't read Chinese can follow work done in Chinese, and the reverse. Translations are cached; each piece of text is translated once.

## Optional: qlib research engine

Optional. Only needed for stock-picking research (idea tests, factor research) and the S&P 500 / Nasdaq 100 universes. ETF and single-ticker strategies don't need it, and you can add it later.

**1. A Python with qlib and LightGBM.** Use a separate environment, `engine/.qlib-venv` (not `engine/.venv`, whose versions are pinned for LEAN). From the Helm folder, with uv (already installed by the setup script):

```
brew install libomp                       # LightGBM needs it on macOS
uv venv --python 3.11 engine/.qlib-venv
uv pip install --python engine/.qlib-venv/bin/python pyqlib lightgbm matplotlib yfinance
```

qlib needs Python 3.8–3.12. Without Homebrew, skip `libomp`; if LightGBM then fails to import, install libomp another way. Helm finds `engine/.qlib-venv` by itself; `engine/qlib_research/run.sh --which-python` shows which Python it uses. To use a different Python, set `QS_PYTHON=/full/path/to/python` in `.env` (create it with `cp .env.example .env`) and restart Helm.

**2. Data.** Prices for research are downloaded from Yahoo Finance automatically and cached in `~/.qlib/qs_cache/`. A qlib US dataset in `~/.qlib/qlib_data/us_data` is optional extra: it supplies historical index membership and prices for stocks that have since been delisted. qlib's own downloader fetches a public community snapshot:

```
engine/.qlib-venv/bin/python -m qlib.run.get_data qlib_data --target_dir ~/.qlib/qlib_data/us_data --region us
```

Be aware that this snapshot is old (it ends around November 2020), is not maintained by Helm, and may be unavailable. Helm fills later prices from Yahoo, and results that depend on index membership after 2020 carry the caveats listed under "Data coverage and limits" in the README.

## When something goes wrong

| What you see | What to do |
|---|---|
| `端口 4377 已被占用` ("port in use") at startup | Another copy of Helm is probably running. Open http://localhost:4377, or start on another port with `PORT=4378 npm start`. |
| The page goes grey and says it expired | The server restarted. Refresh the page. |
| Environment check: `claude` missing | Install Claude Code (`curl -fsSL https://claude.ai/install.sh \| bash`), then restart Helm. If it's installed somewhere unusual, create `.env` from the example (`cp .env.example .env`), set `CLAUDE_BIN=/full/path/to/claude` in it (`which claude` shows the path), and restart Helm. |
| Environment check: `libpython` missing | The Python environment was built on a Python without its shared library. Delete `engine/.venv` and run `scripts/setup.sh` again. |
| Backtests refuse to run and mention the sandbox | Helm couldn't use macOS `sandbox-exec`. See [Sandbox](CONFIGURATION.md#sandbox-helm_exec_sandbox). |
| `npm install -g` fails with `EACCES` | Use the Claude Code install script instead: `curl -fsSL https://claude.ai/install.sh \| bash`. |
| The AI dialog says the key is invalid | Copy the key again with no spaces. For a compatible API, check the address ends in `/anthropic` (not `/v1/messages`) and the model name is exact. |
| The agent stops with a login or quota message | Open **AI** in the top bar and check the connection; **Test saved connection** tells you what's wrong. |
| Content still shows in the other language | Translation happens in the background and the page refreshes on its own. If it never changes, check the AI connection. |
| Paper trading didn't run while Helm was closed | It only runs while Helm is open. The missed day is caught up on next start, without duplicate orders. |
| Ctrl+C but a backtest keeps going | Intended. Backtests and research run as separate processes and finish on their own. |

Still stuck: [FAQ](FAQ.md) · [all settings](CONFIGURATION.md) · [how it fits together](ARCHITECTURE.md)
