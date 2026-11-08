# `agent`
Acts as a **defined agent** from the library (`naru library`; the project's scope first, then global/built-in). Two modes:
- **Plain** (no stage keys): one tool-less model call carrying the agent definition's body plus your task. The agent contributes instructions, not tools.
- **Stage** (any of `deadline`, `ceiling`, `silence`, `grace`, `max_restarts`, `cwd`, `also`): runs a real long-lived agent through the stage driver, optionally two at once, then (with `result_type`) extracts a typed result from the reports.
An unknown agent name fails the node (`unknown agent ...`); the name is not checked when you save.

## Config
- `agent` (string, required): library agent name (case-insensitive).
- `prompt` (string, required): `{input}` is replaced by the input; with no `{input}` the input follows after a blank line. With `input_type` (a struct), `{field}` is also replaced from the JSON input.
- `model` (haiku | sonnet | opus): default the definition's `model:`, else sonnet.
- `timeout_secs` (1..=3600, default 600; plain mode only, stage mode derives its own).
- `result_type` (string): `text` or absent = plain text; else a type name (builtin or the workflow's Types card), and the reply must be valid JSON of that type (retried once with the reason).
- `retry` (bool, default true): retry once on an invalid typed reply.
- `input_type` (string): type of the input pin.
- Stage mode: `deadline` (secs 1..=86400, **required** once any stage key is set), `ceiling` (>= deadline), `silence`, `grace` (secs 1..=86400), `max_restarts` (0..=5), `cwd` (non-empty), `also` (`{"agent","prompt"}`, a second agent), `result_prompt` (replaces the sentence introducing the reports).
**Never put `pins` in `--config`**: an agent's pins are fixed and `pins` is `validation`.

## Pins and output
Input pin `input`. Output pins `result` (the text, or canonical JSON when typed) and `status` (`ok`). Edges leave by `result` when none is named.

## Use when / not when
Use for a named persona (reviewer, planner, implementer) or when you need a typed `result_type`. Use a plain `prompt` for an anonymous one-off call. Use stage mode for long work that needs tools; use `cli` only for a deterministic command.

## Example
```bash
naru workflow node create my-flow agent Review --config '{"agent":"reviewer","prompt":"Review this: {input}","model":"sonnet"}'
```
Stage: `{"agent":"implementer","prompt":"Do {input}","deadline":1800,"ceiling":3600,"cwd":"/tmp/x"}`.
