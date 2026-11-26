# Roadmap

Derived only from an internal code review of 2026-11-14 (not published; its P0/P1/P2 list and week-by-week sequencing) and the "not verified" and "known" notes in `CHANGELOG.md`. Nothing here is a new feature. Item numbers (#n) refer to the review.

## Done

Confirmed in `CHANGELOG.md` (2026-11-14) and the review's status updates.

- P0 #1 agent bypass of the self-fix approval: exec sandbox added (`lib/exec-sandbox.mjs`). See Now for the verification gap.
- P0 #2 bootstrap edge bias: circular blocks in `lib/stats.mjs`.
- P0 #3 future data readable by strategies: underscore attributes in `helm_data.py`, lint rule `private-attr`.
- P0 #4 holdout log lost entries: `withFileLock` in `lib/engine.mjs`.
- P1 #10 case-sensitive policy matching and `git diff --output`: paths compared by real path, case-insensitive.
- P1 #11 no fsync, torn `.jsonl` lines, corrupt files treated as missing: `lib/fs-atomic.mjs`.
- P1 #12 more than one main version under concurrency: `patchMeta` and a project-level lock.
- P1 #13 stop-session race: `setSession` and `stopSession` share a file lock.
- P1 #14 no limit on concurrent agent runs: `HELM_MAX_RUNS`, returns 429.
- P1 #16 trading days filtered by benchmark price: market calendar in `public/calendar.js`.
- P2 #19 repeated parsing: result, zip and thread caches.
- P2 #20 hand-maintained test list and no timeout: `test/all.mjs` discovers files and applies a timeout.
- P2 #21 README security section out of date: README now describes approval and the sandbox.
- P2 #22 full `process.env` passed to the qlib process: keys removed.
- Review section 2.5: `regimeLabels` made incremental. Python exports vectorised (`lean_lines`, `lean_rows`).
- Monday-start backtests dropping their first day, and wrong excess annualisation when the benchmark covers only part of the period.

- Flaky `test/tune.test.mjs` "recommended parameter is near the true optimum": the test was already seeded, but the cause was in the product. Recommending the top plateau point picked a range edge in about 1 in 8 samples. Helm now recommends the candidate nearest the centre of the best plateau (`recommendFromPlateau` in `lib/tune.mjs`). With random task ids the check now fails about 1 in 40 instead of 1 in 6.
- Stopping the orchestrator now also stops the agent it is waiting on (`handoff` with `wait=true`): explicitly via `/api/chat/stop`, and also when the caller's process disappears. `wait=false` handoffs keep running. Covered in `test/handoff-flow.test.mjs`.

- #6 PSR and DSR assumed i.i.d. returns: the variance term now carries a Newey-West long-run factor, floored at 1 (`neweyWestFactor` in `lib/stats.mjs`). Measured false-pass rate with AR(1) phi = 0.2: 8.5–9.2% before, 5.6–6.0% after, against 5% nominal. Trials already store Helm's own daily Sharpe.
- #8 Paper-trading drift verdict was re-checked daily: it is now set only at fixed checkpoints (trading day 20, 60, 120, 250, then every 250) at 1.25% per side (`lib/drift.mjs`). Measured false-alarm rate over 250 days for paths that match the backtest: 42% or more before, 7.5% after.
- Both rates are re-measured on every test run by `test/stats-calibration.test.mjs`.

Owner decision, not a plan:

- P0 #5 (a paper session still trading from a backtest that was later demoted). The existing session was kept running by choice. A manual "set as main" button was added instead.

## Now

Checks that are missing or known to be broken. Status as of 2026-11-25.

Still to run, on a Mac with LEAN installed (`npm test`, full mode, covers all three):

- Run full `npm test` (with LEAN). Only the fast run has been recorded, most recently on 2026-11-25 (56 files, on Linux).
- Run the `--parameters` path to LEAN for parameter sensitivity. Only the full-mode `sensitivity.test.mjs` covers it, and no project has a sensitivity run on record.
- Run `test/sandbox.test.mjs` on a real Mac to confirm the sandbox rules block what they should. That the rules load and allow normal work is confirmed by use: 27 backtests completed inside the sandbox on a Mac after 2026-11-15.

Confirmed on 2026-11-25:

- Every page under the CSP: 13 pages in headless Chromium, in Chinese and English, with real project data. No CSP violations, script errors or failed requests. Not checked in the Mac app's WebKit view.
- The 2026-11-12 paper-trading changes against real LEAN, by use, not by a test run: one session's log shows a recorded failure (2026-11-20), two catch-up runs (2026-11-21) and normal daily runs after that.
- The handoff flow with the real `claude` command, by use, not by a test run: 15 real conversations with handoffs since 2026-11-14, and the 2026-11-24 agent eval (54/54) used real `claude`.

## Next

Statistics and integrity work from review sequencing weeks 2-3.

- #7 Sharpe confidence interval undercovers at one year (92.6% at n = 252). Choose the block length from the data, and add the coverage check to `test/stats-calibration.test.mjs`.
- Drift (review 2.3, second part): centre the expected range on a deflated Sharpe. The source backtest is the best of N tries, so its own distribution is optimistic.
- #9 Lint bypasses: module aliases, non-literal `getattr`, and missing readers in the deny list. Each bypass should become a failing `lint.test` case.
- #15 Weekly FRED series all use the same 7-day release lag. Add a per-series lag table with a test.
- #17 Storage retention: purge `.trash` after 30 days, keep qlib caches only for the latest two runs per project, and drop large order and log files from runs older than 90 days. Target: `projects/` under 200 MB.
- DailySeries type (review 2.4): one daily-series builder shared by validate, robust, drift and journal, built from the market calendar.
- Review section 4, items not yet confirmed in the changelog: 5 (replace the read-only git shell list with a validated MCP tool), 6 (count skipped checks as not verified), 7 (per-file leases across concurrent runs).

## Later

Structure work from weeks 4+, and open decisions.

- #18 Server split (review 5.1): a route table with auth and schema beside each route, and `server.mjs` under 120 lines. Currently 59 route branches sit in one `if` chain.
- #18 Front-end split (review 5.2): `public/app.js` (about 4,500 lines) into ES modules with `mount` and `unmount` per view. No build step.
- Test runner (review 5.3): move to `node:test` with coverage. Target at least 70% line coverage of `lib/`.
- Storage backend (review 3.2): SQLite for backtests, holdout, trials and paper sessions. Not started. The file-based `fs-atomic` route is in place, so this is a decision, not a task.
- Long-term future-data safety (review 4.9): deliver signals as LEAN custom data so LEAN's clock prevents reading ahead. Considered, not decided.
- Agent edits in a git worktree, applied after approval and tests (review 4.2). Considered, not decided.

## Known limitations (documented, not scheduled)

- FRED values are revised figures, not first-release values. Stated in the README.
- The market calendar has fixed holidays and the known one-off closures only. New one-off closures must be added by hand to `public/calendar.js` (`SPECIAL`).
- The contract test skips 10 routes that have side effects.
- CSS has eleven repeated selectors, each with different declarations. Left unchanged on purpose.
