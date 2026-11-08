# `retry`
Wraps one `cli`, `script`, `prompt` or `agent` node and runs it up to `attempts` times. The first success is the retry's output. If every attempt fails, the node fails with `failed after N attempt(s): <last error>`. Sleeps `backoff_ms * backoff_factor^n` between tries (each sleep capped at 600000 ms).

## Config
- `wrap` (object, required): `{"kind": "cli|script|prompt|agent", "config": {...}}`. Only `kind` and `config` are allowed. `config` is validated as that kind's own config; it defaults to `{}`, which the wrapped kind may reject.
- `attempts` (int 1..=10, default 3).
- `backoff_ms` (int 0..=60000, default 0).
- `backoff_factor` (int 1..=10, default 1). 1 is a constant wait, 2 doubles it each time.
- `timeout_secs` (int 1..=3600, optional). Overrides the wrapped config's `timeout_secs` for every attempt.

## Pins and output
In `input: any`, out `output: any`. The output is the wrapped node's output, passed through. Plain edges, no branch label: a failure after the last attempt fails the node and the run. To route on failure instead, use `trycatch`.

## Use when / not when
Use for a flaky call you expect to succeed on a second try (network `cli`, an `agent` that sometimes stalls). Don't use to handle a failure you expect to keep happening: use `trycatch` (ok/caught edges). To retry an `http` call, check `ok` in its output with `branch`; `http` can't be wrapped. Don't hand-build a retry loop out of `cli` + `branch` nodes.

## Example
```
naru workflow node create my-flow retry "Flaky fetch" --config '{"wrap":{"kind":"cli","config":{"command":"curl -fsS http://localhost:8080/health"}},"attempts":4,"backoff_ms":500,"backoff_factor":2,"timeout_secs":30}'
```
