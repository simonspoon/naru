# `git`
Runs one git operation with argv only (no shell, no prompts, signing off). Uses the user's own git identity.

## Config
- `op` (required): `commit`, `branch` or `diff`.
- `cwd` (string, optional): the repo folder. Defaults to the run's working folder (the project's `local_path` for a bound workflow).
- `timeout_secs` (int 1..=3600, optional).
- `op: commit`: `message` (required; `{input}` replaced; empty fails the node), `paths` (list of non-empty strings, optional; default stages everything with `git add -A .`).
- `op: branch`: `name` (required; `{input}` allowed; no leading `-`, no whitespace). Switches to the branch if it exists, else creates it.
- `op: diff`: `base` (optional ref; `{input}` allowed), `stat` (bool, optional; `--stat` output).

A key that doesn't belong to the op is `validation`. `pins` can't be set: they are fixed.

## Pins and output
In `input: any`. Three out pins: `result` (string), `ok` (bool), `status` (string). An edge leaves from the pin it names (`--from-pin`); with none it carries `result`.
- commit: result = new sha, status `committed`; with nothing to commit, `ok` false, status `nothing to commit` (data, not a failure).
- branch: result = branch name, status `created` or `switched`.
- diff: result = diff text (capped), status `changes` or `no changes`.
A real git error (not a repo, bad ref) fails the node.

## Use when / not when
Use for commits, branch setup and diffs in a flow (for example commit after an `agent` edit, or feed `diff` to a `prompt` review). Don't use `cli` for `git commit/switch/diff`. For push, merge or anything else, `cli` is still needed.

## Example
```
naru workflow node create my-flow git "Commit work" --config '{"op":"commit","message":"Apply fixes: {input}","paths":["src"]}'
```
