# `switch`
Multi-way branch on the input text. Tries `cases` in order and routes down the edge labelled with the first matching case's label, else `default`.

## Config
- `op` (string, default `equals`): `equals` | `contains` | `regex` (same matching as `branch`: equals is trimmed, regex is `grep -E`).
- `cases` (array, required, 2 or more): objects `{"match": "<text>", "label": "<edge label>"}`. `match` is required and non-empty (a bad regex is `validation` under `regex`); `label` is optional and defaults to `match`. Labels must be non-empty, unique, and not `default` or `failure`. No other keys.
- `pins` optional.

## Pins and output
- In: `input`. Output text is JSON: `{"value": <trimmed input>, "matched": bool, "label": <label or null>}`; the original input is not passed through (use the `value` field, or a data edge, downstream).
- Routing: one exec edge per case, `--branch <label>`, plus `--branch default` for no match. With no `default` edge and no match, everything downstream is skipped (not a failure). First match wins, so put specific cases before general ones.

## Use when / not when
- Use for 3+ outcomes on known strings (status words, severity levels, a prompt's one-word answer).
- Not for 2 outcomes: use `branch`. Not for fuzzy intent: use `decide`. Do not chain `branch` nodes to emulate this.

## Example
```bash
naru workflow node create my-flow switch "By severity" --config '{"op":"equals","cases":[{"match":"high"},{"match":"low","label":"minor"}]}'
naru workflow edge create my-flow <SWITCH_ID> <PAGE_ID> --branch high
naru workflow edge create my-flow <SWITCH_ID> <LOG_ID> --branch minor
naru workflow edge create my-flow <SWITCH_ID> <IGNORE_ID> --branch default
```
