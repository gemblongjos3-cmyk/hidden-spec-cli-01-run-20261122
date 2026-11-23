[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gemblongjos3-cmyk/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gemblongjos3-cmyk/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files, in any of the four formats models actually
emit: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as
JSON. The format is detected automatically, or named with `--format`. Old lines are matched in three tiers — exact,
then ignoring trailing spaces and tabs, then ignoring leading and trailing whitespace with the replacement lines
re-indented to the file's own indentation — and `--strict` holds it to the exact tier alone. Writes are
all-or-nothing: every edit is checked against the tree as the earlier ones left it, every failure is reported, and
when any edit fails nothing on disk changes.

## Running it

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]`, with the working directory as the root of the tree.
`PATCH` is a patch file, or `-`/absent to read standard input. `--format` takes `auto` (the default), `unified`,
`search-replace`, `v4a` or `json`. `--check` does everything but write. Output is one line per changed path (`A`, `M`,
`D`, or `R old -> new`), then `ok: <n> files`; failures are one `error: <code> <path>` line each, then
`failed: <k> of <n> edits`, with exit code 1. Usage and parse errors print a single `error:` line and exit 2.

## The practice checks

The kit's 100 public practice checks live in `program/generator/practice.json` of the competition kit. Run them
against this implementation with:

    node check.ts /path/to/kit/program/generator/practice.json

`check.ts` runs `main.ts` on each check in a fresh directory and compares the exit code, standard output and every
file afterwards; it prints each mismatch and then the score. This implementation passes all 100.

Node 22 or newer, standard library only.
