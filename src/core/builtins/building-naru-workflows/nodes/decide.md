# `decide`
Picks one of 2+ options for a question using `naru decide`: a local, in-process rules judgement (no model, no network, no API key). Routes to the edge named after the chosen option, or to `fallback` when it is unsure.

## Config
- `question` (string, required, non-empty): may contain `{input}`, replaced with the node's input text.
- `options` (array of strings, required): 2 or more, distinct, non-empty. None may be `fallback` or `failure` (reserved edge labels).
- `threshold` (number 0..=1, default `0.5`): minimum `confidence` for the choice to be taken.
- `pins` optional.

## Pins and output
- In: `input`. Output text is JSON: `{"choice","confidence","agreement","threshold","backend","rule","fallback"}`; it is NOT the original input, so a downstream node wanting the original text must use a data edge or reach it another way.
- Routing: one edge per option labelled `--branch <option>` (exact text), plus an optional `--branch fallback` edge. The `fallback` edge is taken when the choice is null (no rule matched, backend `off`) or `confidence < threshold`, and also when the decide errors (bad rules file) and a fallback edge exists (the output then carries `error`).
- No fallback edge and no decision: not a failure; everything downstream is skipped.

## Use when / not when
- Use to route on intent ("bug or feature?") with 2+ named outcomes, cheaply and offline. Always wire `fallback`.
- Not for a literal string match: use `switch`. Not for a yes/no on text: use `branch`. Need an LLM's judgement: use a `prompt` node then `switch`/`branch` on its answer. The rules are keyword rules from the decide ruleset (`naru decide --print-default-rules`), so test your options against it.

## Example
```bash
naru workflow node create my-flow decide "Route" --config '{"question":"Is this a bug or a feature request?","options":["bug","feature"],"threshold":0.6}'
naru workflow edge create my-flow <DECIDE_ID> <BUG_ID> --branch bug
naru workflow edge create my-flow <DECIDE_ID> <FEATURE_ID> --branch feature
naru workflow edge create my-flow <DECIDE_ID> <OTHER_ID> --branch fallback
```
