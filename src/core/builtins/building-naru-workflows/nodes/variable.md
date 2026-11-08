# `variable`
Run-scoped named storage. `set` stores its input under a name; `get` reads it back later in the same run, even from another branch, with no wire between them.

## Config
- `op` (string, required): `set` | `get`.
- `name` (string, required): identifier; letters, digits, `_` and `-`, starting with a letter or `_`, up to 64 chars.
- `type` (string, optional, default `any`): a type name. On `set` the input is parsed as JSON of that type (like `parse-json`) before storing; `get` declares the type of its output pin.
- `pins` ignored (fixed by the kind).

## Pins and output
- `set`: in `value`, out `value`. Output is the stored (parsed, canonical) value, so a `set` can sit inline in a chain. Input must be valid JSON of the type; a bare unquoted word with type `any` is invalid JSON.
- `get`: in `trigger` (`any`; its text is ignored, it only activates the node), out `value`. Fails with `variable "x" is not set` if no `set` ran earlier in this run.
- Scope is one run only: nothing persists across runs. Order is by the graph's topological order, so make the `get` downstream of the `set` (an exec path from set to get).
- No branch routing.

## Use when / not when
- Use to reuse an early value (the run input, a parsed record) at the end of a long flow without threading it through every node, or to reach a value across a branch/join.
- Not for state that must survive between runs: use `memory` or `file`. Not for a value that is next door: just draw the edge.

## Example
```bash
naru workflow node create my-flow variable "Remember" --config '{"op":"set","name":"last-review","type":"Review"}'
naru workflow node create my-flow variable "Recall" --config '{"op":"get","name":"last-review","type":"Review"}'
```
