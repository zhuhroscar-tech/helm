# Agent harnesses

Each of the five agents runs inside its own harness: a definition of which tools it gets, how long its loop may run, which rules are checked before a tool call, and what it must deliver before the run counts as finished. The rules are enforced in code; the prompt only tells the agent what the code will do.

Helm still runs every agent on the Claude Code CLI (`claude -p`). The harness wraps that process from three sides:

| Layer | Where | What it does |
|---|---|---|
| Tool scope | `buildArgs` in `server.mjs` | Tools outside the harness are passed to `--disallowedTools`, so the model never sees them |
| Tool guard | `mcp/qc-mcp.mjs` → `POST /api/harness/guard` and `/record` | Every qc tool call is checked before it runs and recorded after |
| Outer loop | `finish` / `relaunch` in `server.mjs` | When the CLI exits, the delivery check runs; if something is missing the same session is resumed with a list of what to finish |

Definitions live in `lib/harness/`: one file per agent, shared logic in `core.mjs`, shared rules in `rules.mjs`, the research-direction ledger in `directions.mjs`. All of it is pure functions; `server.mjs` owns the per-run state.

## The five harnesses

| Agent | Tools removed | Loop limits per run | Rules before a tool call | Delivery check |
|---|---|---|---|---|
| `mia` (orchestrator) | Execution tools, as before (`agents.json`) | 100 tool calls, 240 min, 14 handoffs, 3 new projects | none added | A project handed to the engineer has a `spec.md` |
| `engineer` | Idea tests, qlib research, timing-signal tests | 150 calls, 120 min, 8 backtests, 1 tuning run | Read the spec before writing code; dev run before holdout after a code change; validate before marking main | Every submitted backtest was waited for; a delegated task names its backtestId |
| `researcher` | Backtests, tuning, robustness; writes `.md` only | 120 calls, 180 min, 3 idea tests, 2 research jobs | none added | Idea tests were read; the verdict is one of signal / weak / no signal |
| `analyst` | New projects, backtests, research, tuning, datasets; writes `.md` only | 90 calls, 60 min, 10 validations | Validate before marking main | No "can continue" without a validation; numbers come from tool reads |
| `risk` | Same as analyst, plus relabelling backtests | 60 calls, 45 min | none added | Numbers come from tool reads |

Limits that apply to every harness:

- The same call failing three times in a row is refused on the fourth try.
- The same successful call five times in a row is refused (polling tools are exempt).
- Past the time limit only read-only tools are allowed, so the agent can still write its summary.
- A hard stop ends the process at three times the tool-call limit, counting tools that do not pass through the MCP server (Read, Grep, web).
- At most two continuations per run. If the delivery check still fails, the run ends and the gap is stored on the message as `harness.missing`.

Inside an autopilot run the budgets in `lib/autopilot.mjs` govern. The harness keeps only its tool scope, rules and repeat detection there; the autopilot guard is checked first.

## Subagents

`mcp__qc__subagent` starts one to three child agents in parallel and returns all their answers in one result. Use it for independent questions; staged work with dependencies still goes through `handoff`.

| Caller | Per run | At once | May call |
|---|---|---|---|
| `mia` | 6 | 3 | researcher, engineer, analyst, risk as workers |
| `researcher` | 3 | 3 | researcher, analyst, engineer as scouts |
| `engineer` | 2 | 2 | engineer, analyst, researcher as scouts |
| `analyst` | 2 | 2 | risk, analyst, engineer as scouts |
| `risk` | 2 | 2 | analyst, risk as scouts |

- A **scout** keeps only read-only tools and web search. It cannot edit files, run commands, ask the user, hand off or change anything in a project. Limits: 40 tool calls, 15 minutes.
- A **worker** has the target agent's full harness.
- Neither kind can start subagents of its own. The existing depth limit (3) and the cap on concurrent runs (8) still apply.
- Child conversations are visible on the site like handoffs, and stopping the parent stops them.

## Research direction

`mcp__qc__research_direction` lets the orchestrator and the researcher choose what to study when the user gave no specific idea. One ledger per research line (a root conversation and everything it hands off or spawns), stored in `data/directions/<root thread id>.json`.

| Action | Who | Effect |
|---|---|---|
| `read` | everyone | The ledger, other agents' suggestions, what was already tested, and which data is available |
| `set` | mia, researcher | Registers a direction: name, economic thesis, 1–3 hypotheses each with a failure condition |
| `conclude` | mia, researcher | Closes the active direction with an outcome and evidence |
| `suggest` | engineer, analyst, risk | Records a suggestion for the deciders |

Enforced bounds:

- One active direction at a time, at most three per research line.
- From the second direction on, `whyNew` is required, and names and hypotheses may not repeat earlier ones.
- Idea tests under a direction are capped at the number of hypotheses plus one.
- A direction cannot be closed as signal, weak or no signal unless a test actually ran under it; otherwise it is `abandoned` with a reason, and still counts.

Registering a direction is optional when the user supplied the idea. Autopilot keeps using `autopilot_plan`; `set` and `conclude` are refused there.

## Changing a harness

Edit the agent's file in `lib/harness/` and restart Helm. `HELM_HARNESS=0` turns off the MCP-side guard only; tool scope still applies. `GET /api/harness` returns the definitions, and `GET /api/agents/<id>` includes the agent's harness.

Each assistant message stores a `harness` summary: tool-call counts, refusals, continuations, children.

## Tests

`node test/harness.test.mjs` covers the pure functions and three end-to-end runs with the scripted fake Claude: guard refusals plus a continuation, parallel scouts, and a direction ledger. These prove the mechanism. They do not show how the real model behaves under the new limits; run `npm run eval` for that before relying on the numbers above.
