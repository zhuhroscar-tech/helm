# Strategies folder

One file per idea, named `<short-name>.md` in lowercase with hyphens (for example `small-cap-macro-timing.md`). Start from [TEMPLATE.md](TEMPLATE.md).

Each file must have the front matter and sections from the template. The sections follow the `spec.md` rules-table format that Helm's agents write into every project (user's words, differences from the words, rules table, ambiguities and choices, validation discipline), so a Helm user can turn an entry into a project without reinterpreting it.

Before submitting, check:

- the front matter is complete and `status` is one of `idea`, `tested-rejected`, `tested-passed-holdout`, `paper`
- the results section states the number of trials and the holdout outcome
- no actual API keys, private files or personal data are included
- no statement reads as advice or as a promise of future returns

The rules for submissions are in [../README.md](../README.md).

This folder ships without example strategies. Entries are added by contributors.
