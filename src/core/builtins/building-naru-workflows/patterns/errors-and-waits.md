# Errors and waits

By default a failed node fails the run: nothing downstream runs, every unrun node is `skipped`, `WorkflowRun.error` names the node, and `naru workflow run` still **exits 0** (read `.status`). Handle failure deliberately.

## Handling failure

| Tool | Use when |
| --- | --- |
| `retry` | The step is flaky and trying again is safe. Wraps one `cli`/`script`/`prompt`/`agent`; `attempts` 1..=10 (default 3), `backoff_ms` 0..=60000, `backoff_factor` 1..=10, `timeout_secs` per attempt. Fails with `failed after N attempt(s): <last error>`. |
| `trycatch` | A failure is an expected outcome with its own path. Wraps one `cli`/`script`/`prompt`/`agent`/`notify`. Edges need `--branch ok` or `--branch caught`; on failure the node and run still succeed, the output is the error text. |
| `failure` edge | Any node's own failure exit: `edge create ... --branch failure`. Active only when the source fails, carries the error text, and keeps the run from failing. Prefer it to `trycatch` for a node that is not one of the wrappable kinds (`http`, `task`, `foreach`...). |
| `cli` with `"always": true` | A closing step (notify, clean up) that must run whatever happened. It ignores its edges, runs after everything else and gets the run input plus a `run_status=succeeded` or `run_status=failed error=<message>` line. Its own failure never replaces the run's earlier error. |

- To retry and then fall back, wrap with `retry` and hang a `failure` edge off the `retry` node.
- A `failure` edge into a `join` never satisfies it.
- A wrapper's `wrap.config` is validated as its own kind at create time. `retry` cannot wrap control kinds, itself included.
- A `failure` label cannot be a `decide` option or `switch` case.

## Waits and checks

- `delay`: exactly one of `{"seconds":0..=3600}` or `{"until":"HH:MM"}` / `{"until":"2026-10-17T14:30:00Z"}` (UTC). `HH:MM` means the next such time. An `until` more than an hour away fails the node at run time. It sleeps with no lock held and cannot be cancelled mid-wait. Input passes through unchanged.
- `gate`: pauses until a person decides, then routes `--branch approved` or `--branch rejected`. `timeout_secs` 1..=86400 (default 3600); a timeout **is** a rejection. A rejection is data: the run goes on down the `rejected` edge and still ends `succeeded`. The run stays `running` while it waits. Decide with `naru workflow gate list` and `naru workflow gate approve|reject <id>`. Wire both edges, or the rejected path silently ends.
- `verify`: runs a check command and reports `pass`, `evidence`, `exit_code` without failing the node. `mode` is `test` (default) or `browser` (`url` only here); `expect` is a substring that must appear in the output. Its output is JSON `{"pass","evidence","exit_code"}`: route on it with a `branch` `contains` `"pass":true` after it.
- To send someone a failure notice, hang `notify` (phone or speak) off a `failure` edge, or use an `always` closing node.

## Worked example

Fetch with two attempts; on failure wait a second, check a marker, and log the failure. Offline (the fetch is refused on purpose).

```bash
node() { naru workflow node create "$@" | jq -r .id; }
naru workflow create resilient >/dev/null
T=$(node resilient trigger Start --config '{"mode":"manual"}')
R=$(node resilient retry "Fetch with retries" --config '{"wrap":{"kind":"cli","config":{"command":"curl -fsS http://127.0.0.1:1/ping"}},"attempts":2,"backoff_ms":100}')
OK=$(node resilient output "Log fetched" --config '{"target":"log","log":"fetch"}')
D=$(node resilient delay "Cool off" --config '{"seconds":1}')
V=$(node resilient verify "Check marker" --config '{"mode":"test","command":"echo gave up","expect":"gave up"}')
BAD=$(node resilient output "Log failure" --config '{"target":"log","log":"fetch-failures"}')
node resilient cli "Close out" --config '{"command":"cat","always":true}' >/dev/null
naru workflow edge create resilient $T $R >/dev/null
naru workflow edge create resilient $R $OK >/dev/null
naru workflow edge create resilient $R $D --branch failure >/dev/null
naru workflow edge create resilient $D $V >/dev/null
naru workflow edge create resilient $V $BAD >/dev/null
naru workflow run resilient | jq -r .status
```

The status is `succeeded`: the failure was handled. "Fetch with retries" is recorded `failed` and "Log fetched" `skipped`.
