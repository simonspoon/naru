# `trycatch`
Runs one wrapped node once and turns a failure into data. The node itself always succeeds (if the wrapped node ran), so the run keeps going.

## Config
- `wrap` (object, required): `{"kind": "cli|script|prompt|agent|notify", "config": {...}}`. Only `kind` and `config` are allowed. `config` is validated as that kind's own config.
- `timeout_secs` (int 1..=3600, optional): overrides the wrapped config's `timeout_secs`.

## Pins and output
In `input: any`, out `output: any`. Routes by edge label:
- `ok`: the wrapped node succeeded; output is its output.
- `caught`: the wrapped node failed; the output is the error text.

Every edge leaving it needs `--branch ok` or `--branch caught`. If the branch taken has no edge, everything behind it is skipped. The run ends `succeeded` either way.

## Use when / not when
Use for a step that may fail where the workflow has a sensible fallback or cleanup (notify on failure, skip an optional step). Don't use to just try again (`retry`). It can't wrap `retry`, `http`, `task`, `git`, `file` or other kinds; their failure fails the run. For a command that fails as data (`git commit` with nothing to commit gives `ok:false`, a `verify` gives `pass:false`), use the node's own pins plus `branch`.

## Example
```
naru workflow node create my-flow trycatch "Try build" --config '{"wrap":{"kind":"cli","config":{"command":"make build"}},"timeout_secs":300}'
```
