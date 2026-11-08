# `cli`
Runs `bash -c <command>` verbatim in the run's folder (the project's `local_path`, else the workspace). The input goes to **stdin** and, when it is 64 KiB or less, to `$NARU_INPUT`. The output is stdout; a nonzero exit fails the node with the stderr and skips what follows. Naru does not parse `command` or substitute `{input}` into it, so read the input from stdin or `$NARU_INPUT`, never splice it into the text.

## Config
- `command` (string, required, non-empty).
- `timeout_secs` (int 1..=86400, default 600): killed by process group past it.
- `always` (bool, optional): `true` makes a **closing node**. It ignores its edges, runs after every other node whatever happened (a failed run included), and receives the run input plus a final line `run_status=succeeded` or `run_status=failed error=<message>`. Its own failure never replaces the run's earlier error. Use it for cleanup or a closing notice. Non-bool is `validation`.
Unknown keys are `validation`.

## Pins and output
Input pin `stdin`. Output pins `stdout`, `stderr` (strings) and `exit_code` (number, always 0 on an `ok` node). The text on an exec edge is stdout. Wire `stderr` onward with a data edge (`--data --from-pin stderr --to-pin <pin>`).

## Use when / not when
Use only for a one-off shell command that no purpose-built node covers. Prefer: `git` (commit/branch/diff), `file` (read/write), `http` (requests), `notify`, `board`, `task`, `memory`, `verify` (a check with pass/fail), `parse-json`/`mapfilter`/`branch` for data handling, `delay` for waiting. A long chain of `cli` nodes is a smell. For a reusable stored script use `script`.

## Example
```bash
naru workflow node create my-flow cli Cleanup --config '{"command":"rm -rf /tmp/x-work","always":true,"timeout_secs":60}'
```
