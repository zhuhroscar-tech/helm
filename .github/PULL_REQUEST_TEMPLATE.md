## What and why

<!-- What changed, and the reason. Link the issue if there is one. -->

## Research impact

- [ ] No change to thresholds, statistics, trial counting, validation-period handling, PBO or parameter selection.
- [ ] If there is a change, the before and after numbers are below, and the reason is stated.

## Safety impact

- [ ] No change to the approval policy, the sandbox, secret handling, server auth, or the paper-only Alpaca endpoint.
- [ ] If there is a change, it is described below and a reviewer has been asked to look at it.

## Checks

- [ ] `npm test -- --fast` passes.
- [ ] Python tests pass (`engine/qlib_research`), if engine code changed.
- [ ] Full `npm test` with LEAN was run, for backtest, paper-trading or sandbox changes. Otherwise say why not.
- [ ] `CHANGELOG.md` has an entry under the newest dated heading, including what was not verified.
- [ ] New server routes validate their input and check auth.
- [ ] No `.env`, `data/`, `projects/` or `engine/Lean/` files are in this PR.

## Notes for the reviewer

<!-- Anything you were unsure about, and what you want checked. -->
