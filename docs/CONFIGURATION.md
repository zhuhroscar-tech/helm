# Configuration

Helm works with no configuration. To change a setting, use either a config file or environment variables.

## How settings are resolved

Lowest to highest priority:

1. Built-in defaults.
2. `helm.config.json` in the repo root (optional). Another path can be given with `HELM_CONFIG`. Start from `helm.config.example.json` or run `helm config init`. The file is nested JSON: `server.port` is `{ "server": { "port": 4377 } }`. Relative paths are resolved against the file's directory; `~` is expanded.
3. Environment variables (see the table). An empty variable counts as unset.

Invalid values are errors (the server will not start via `helm start`); unknown keys are warnings with a "did you mean" hint. Keys starting with `_` and `$schema` are ignored, so you can leave notes.

Values from the file are copied into the matching environment variable only when it is not already set, so the rest of Helm keeps reading `process.env`. `server.mjs` also reads a `.env` file. Full precedence, highest first: real environment variables, `.env`, `helm.config.json`, built-in defaults. `npm start` and `helm start` behave the same.

Secret settings are redacted (`********`) in `helm config`.

## Reference

| Key | Env var | Type / range | Default | Description |
|---|---|---|---|---|
| `server.port` | `PORT` | int 1..65535 | `4377` | Port the console listens on (127.0.0.1 only).<br>网页服务监听的端口（只监听本机 127.0.0.1）。 |
| `claude.bin` | `CLAUDE_BIN` | string | `claude` | Claude Code command: name on PATH or absolute path.<br>Claude Code 命令：PATH 里的名字或绝对路径。 |
| `claude.model` | `CLAUDE_MODEL` | string | (empty) | Default model for agents (alias like "sonnet" or a full model id). Empty = Claude Code default.<br>agent 默认模型（别名如 sonnet，或完整模型 ID）。留空 = 用 Claude Code 自己的默认。 |
| `claude.effort` | `CLAUDE_EFFORT` | one of `low`, `medium`, `high`, `xhigh`, `max` or empty | (empty) | Default reasoning effort. Empty = Claude Code default.<br>默认推理强度。留空 = 用 Claude Code 自己的默认。 |
| `agents.maxRuns` | `HELM_MAX_RUNS` | int 1..64 | `8` | Maximum number of agent runs at the same time.<br>同时运行的 agent 数量上限。 |
| `agents.approvalWaitMs` | `HELM_APPROVAL_WAIT_MS` | int 1000..1140000 | `900000` | How long an agent waits for you to approve an action (ms). Keep below the 20 min MCP tool timeout.<br>agent 等你批准操作的最长时间（毫秒）。要比 MCP 工具的 20 分钟超时短。 |
| `agents.questionWaitMs` | `HELM_QUESTION_WAIT_MS` | int 1000..1140000 | `900000` | How long an agent waits for your answer to a question (ms).<br>agent 等你回答问题的最长时间（毫秒）。 |
| `security.execSandbox` | `HELM_EXEC_SANDBOX` | one of `on`, `off` | `on` | macOS sandbox for agent-run code. "off" makes such commands require your approval instead.<br>agent 运行代码时用的 macOS 沙盒。设为 off 后这类命令改为要你批准。 |
| `engine.dotnetBin` | `DOTNET_BIN` | path | (empty) | Path to the dotnet executable. Empty = ~/.dotnet/dotnet.<br>dotnet 可执行文件路径。留空 = ~/.dotnet/dotnet。 |
| `engine.leanData` | `HELM_LEAN_DATA` | path | (empty) | LEAN price data directory. Empty = engine/Lean/Data.<br>LEAN 行情数据目录。留空 = engine/Lean/Data。 |
| `storage.projectsDir` | `HELM_PROJECTS_DIR` | path | (empty) | Where strategy projects are stored. Empty = projects/.<br>策略项目存放目录。留空 = projects/。 |
| `storage.threadsDir` | `HELM_THREADS_DIR` | path | (empty) | Where chat threads are stored. Empty = data/threads/.<br>对话记录存放目录。留空 = data/threads/。 |
| `storage.trialsFile` | `HELM_TRIALS_FILE` | path | (empty) | Trial (multiple-testing) ledger file. Empty = data/trials.jsonl.<br>尝试次数（多重检验）登记文件。留空 = data/trials.jsonl。 |
| `paper.alpacaFile` | `HELM_ALPACA_FILE` | path | (empty) | Alpaca paper-trading credentials file. Empty = data/secrets/alpaca.json.<br>Alpaca 模拟盘密钥文件。留空 = data/secrets/alpaca.json。 |
| `paper.alpacaTimeoutMs` | `HELM_ALPACA_TIMEOUT_MS` | int 1000..120000 | `15000` | Timeout of one Alpaca API request (ms).<br>单次 Alpaca 接口请求的超时（毫秒）。 |
| `paper.alpacaBackoffMs` | `HELM_ALPACA_BACKOFF_MS` | int 0..30000 | `1000` | Base wait between Alpaca retries (ms).<br>Alpaca 请求重试之间的基础等待（毫秒）。 |
| `qlib.python` | `QS_PYTHON` | path | (empty) | Python with qlib installed, for research. Empty = auto-detect.<br>研究用的、装了 qlib 的 Python。留空 = 自动查找。 |
| `qlib.scriptsDir` | `QS_SCRIPTS` | path | (empty) | qlib research scripts directory. Empty = engine/qlib_research.<br>qlib 研究脚本目录。留空 = engine/qlib_research。 |
| `qlib.secUserAgent` (secret) | `QS_SEC_USER_AGENT` | string | (empty) | User-Agent (name + email) sent to SEC EDGAR for fundamentals downloads.<br>下载 SEC 财报基本面时发给 EDGAR 的 User-Agent（姓名 + 邮箱）。 |
| `qlib.ideaRegistry` | `QS_IDEA_REGISTRY` | path | (empty) | Idea registry file. Empty = ~/.qlib/qs_cache/idea_registry.jsonl.<br>想法登记文件。留空 = ~/.qlib/qs_cache/idea_registry.jsonl。 |
| `qlib.sp500PitFile` | `HELM_SP500_PIT` | path | (empty) | S&P 500 point-in-time membership file. Empty = ~/.qlib/qs_cache/membership/sp500_pit.txt.<br>S&P 500 历史成分股文件。留空 = ~/.qlib/qs_cache/membership/sp500_pit.txt。 |

## CLI

```
helm start           load config, then start the server
helm config          effective settings with their source (default / file / env); --json for JSON
helm config init     create helm.config.json from defaults (never overwrites)
helm doctor          pre-flight checks: Node >= 20, claude, dotnet, LEAN launcher, engine/.venv python, config
helm version
```

`helm config` and `helm doctor` exit non-zero on errors / failed required checks, so they can be used in scripts. Run the CLI as `node bin/helm.mjs <command>` or link it via the `bin` entry in package.json.

## Internal / test-only variables

Not part of the schema and not accepted in `helm.config.json`:

- `HELM_SANDBOX_ASSUME`: Tests: pretend the sandbox is available/unavailable.
- `HELM_AGENTS_FILE`: Tests: use another agents.json.
- `HELM_MCP_CONFIG`: Tests: use another MCP config file (default data/mcp.json).
- `HELM_CHANGE_ROOT`: Tests: root directory for the change-approval policy.
- `HELM_CHANGE_TESTS`: Tests: fake test runner for the change-approval flow.
- `HELM_TEST_TIMEOUT_MS`: Tests: per-file timeout of test/all.mjs.
- `HELM_PAPER_DRIFT`: Tests: =0 disables paper-trading drift calculation.
- `HELM_AGENT, HELM_THREAD_ID`: Set by the server for the MCP child process.
- `HELM_LANG`: Set by the server (`zh` or `en`, from the chat request's `lang`) for the MCP child process, so tool errors come back in the UI language. Not a setting: the language is chosen in the web UI (sidebar footer) and sent per request via `lang` / `X-Helm-Lang`.
- `HELM_URL, HELM_TOKEN`: Set by the server for the MCP child process (random per start).
- `HELM_WRITE_ONLY`: Set by the server: restricts which files an agent may write via MCP.
- `HELM_CONFIG`: Path of the config file itself (read by loadConfig, not a setting).
- `QS_TRA_BUDGET`: Tests: "epochs,steps" budget for fast TRA smoke tests.
