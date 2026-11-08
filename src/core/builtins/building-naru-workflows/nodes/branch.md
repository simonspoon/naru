# `branch`
A two-way test on its input text. It passes the input through unchanged and routes down the `true` or the `false` edge. Evaluated in-process (the `regex` op shells out to `grep -E`); no model, no shell script of yours.

## Config
- `op` (string, required): `contains` | `regex` | `score_above` | `score_below` | `equals`.
- `value` (required): text for `contains`/`regex`/`equals`; a number (or numeric string) for `score_above`/`score_below`. A bad regex (POSIX ERE) is `validation`.
- `pins` accepted but optional (declared types only).

Semantics: `contains` is substring on the raw input; `equals` compares both sides trimmed; `regex` is `grep -E`; `score_*` take the first decimal number found in the input (`-` allowed), and no number at all is `false`.

## Pins and output
- In: `input`. Output text: the input, unchanged. No data out pin.
- Routing: give each outgoing exec edge a label: `--branch true` or `--branch false`. An edge whose label does not equal the verdict is inactive, so its target is skipped (unless another incoming edge is active).
- Any node may also have a `failure` edge; it fires only if the branch itself errors.

## Use when / not when
- Use for a yes/no test on text: error present, score over a threshold, exact match.
- Not for 3+ outcomes: use `switch` (known strings) or `decide` (a question with options). Not for a filter over a list: use `mapfilter`. Do not build this from a `cli` running `grep` plus an exit code.

## Example
```bash
naru workflow node create my-flow branch "Has error" --config '{"op":"contains","value":"error"}'
naru workflow edge create my-flow <BRANCH_ID> <ON_ERROR_ID> --branch true
naru workflow edge create my-flow <BRANCH_ID> <OK_ID> --branch false
```
