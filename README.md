# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ari-exp/mend-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ari-exp/mend-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads all of them: a unified diff
(often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format,
and text-editor tool calls as JSON. It finds the lines each edit names at the
first of three matching tiers (exact, trailing whitespace, indentation), and
writes every change or none.

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format". `SPEC.md` is the whole
contract; `main.ts` is the implementation.

## Run

Node 22 and its standard library alone, no install step:

```
node main.ts [options] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory.
  When absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 lists what changed (`A`/`D`/`M`/`R` lines, then `ok: <n> files`).
Exit 1 lists each failed edit, then `failed: <k> of <n> edits`, and no file
is written. Exit 2 is a usage, missing-patch, format or parse error.

## Check

The kit's practice set (100 checks) runs locally with:

```
node check.ts <path to practice.json>
```

## License

MIT — see `LICENSE`.
