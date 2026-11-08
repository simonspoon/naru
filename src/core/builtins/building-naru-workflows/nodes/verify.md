# `verify`
Runs a check and reports pass/fail with evidence: no model call. The command runs under `bash -c` in the run's folder, like `cli`; the input is on stdin and in `$NARU_INPUT`. A failing check is **data**: the node still succeeds with `pass: false`. Only a spawn failure or the timeout fails the node.

## Config
- `command` (string, required, non-empty).
- `mode` (`test` default | `browser`).
- `url` (string, browser mode only; `{input}` allowed): reaches the command as `$NARU_VERIFY_URL`, never spliced into its text. A browser-mode command is typically a `khora` script. `url` in test mode is `validation`.
- `expect` (string, optional): text that must appear in the combined stdout+stderr.
- `timeout_secs` (int 1..=3600, default 300).
Unknown keys are `validation`. **Pass** = exit 0 and, when `expect` is set, that text found.

## Pins and output
Input pin `input`. Output pins `pass` (bool), `evidence` (string: stdout then stderr, trimmed, capped at 64 KiB) and `exit_code` (number). The text output is JSON `{pass, evidence, exit_code}`. Route on it with `branch` (`equals`/`contains` on the JSON) or a data edge from `pass`.

## Use when / not when
Use for build/test/health checks that gate a delivery: run the tests, hit an endpoint, check a page, and branch on the result. Prefer it over a bare `cli` because a failure does not abort the run and you get the evidence on a pin. Use `cli` only when a nonzero exit should stop the run.

## Example
```bash
naru workflow node create my-flow verify Check --config '{"command":"cargo test","expect":"test result: ok","timeout_secs":900}'
```
Browser: `{"mode":"browser","command":"./check-page.sh","url":"http://127.0.0.1:7771/{input}"}`.
