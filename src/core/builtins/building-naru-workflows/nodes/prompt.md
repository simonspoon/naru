# `prompt`
One tool-less model call. The node's text, a blank line, then the node's input go in as a single user message (just the text when the input is empty); the answer is the model's text, trimmed. No API key: `haiku`/`sonnet`/`opus` use the `workflow-prompt` template (`claude -p`), `local:<name>` uses Ollama. The model cannot use tools or read files, so give it everything it needs in the input.

## Config
- `model` (string, required): `haiku` | `sonnet` | `opus` | `local:<name>` (name: letters, digits, `. _ - : /`, never starting with `-`).
- `prompt` (string, required, non-empty).
- `thinking` (bool, default false).
- `timeout_secs` (int 1..=3600, default 600): bounds the whole call.
Unknown keys are `validation`. `{input}` is **not** substituted here; the input is appended after the prompt.

## Pins and output
Input pins `input` (feeds the appended text) and `model` (a data edge into `model` replaces the configured model for that run). Output pin `result`: the answer text. A nonzero exit, an `is_error` result, an empty answer or a timeout fails the node and skips what follows.

## Use when / not when
Use to summarise, classify, rewrite or extract from text. For a yes/no or pick-one routing use `decide` (local, cheaper) or `branch`; for a typed JSON answer use `agent` with `result_type`; for a defined persona with instructions use `agent`. When the task needs tools, files or hours of work, use `agent` in stage mode, not `prompt`. Do not use `cli` running `claude -p`.

## Example
```bash
naru workflow node create my-flow prompt Summarise --config '{"model":"haiku","prompt":"Summarise in one line:","timeout_secs":120}'
```
