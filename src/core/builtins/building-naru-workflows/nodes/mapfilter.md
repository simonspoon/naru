# `mapfilter`
Maps or filters a list in-process: no shell, no model. Input is a JSON array, or plain text which is split into its non-empty lines. Output is a compact JSON array.

## Config
- `mode` (string, required): `map` | `filter`.
- `expr` (string, required). For `map`: a template; `{item}` is replaced by each item's text (replacement is one pass, so item text is never re-read). For `filter`: a predicate that keeps matching items: `contains:X`, `not-contains:X`, `eq:X`, `regex:RE` (Rust regex), or `nonempty`. An unknown predicate, empty argument or bad regex is `validation`.
- `pins` ignored (fixed).

## Pins and output
- In pin: `list` (`any`). Out pin: `list` (`any`).
- Output text: JSON array. `map` yields an array of strings; `filter` keeps the original items. JSON that is not an array (an object, a number) fails the node (`mapfilter input must be a list`).
- No branch routing. Empty list out is not a failure.
- The graph is a DAG with no cycles, so a loop is expressed with these list nodes (and `foreach`), not by an edge back.

## Use when / not when
- Use to reshape or prune a list: keep failing lines, drop blanks, prefix each item, build a bullet list.
- Not to run a command per item: use `foreach`. Not to test the whole text: `branch`. Not for arbitrary logic: use a `cli`.

## Example
```bash
naru workflow node create my-flow mapfilter "Keep failures" --config '{"mode":"filter","expr":"contains:FAIL"}'
naru workflow node create my-flow mapfilter "Bullets" --config '{"mode":"map","expr":"- {item}"}'
```
