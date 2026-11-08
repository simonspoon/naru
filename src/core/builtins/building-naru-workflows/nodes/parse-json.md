# `parse-json`
Parses its input text as JSON and checks it against a type, giving a typed value pin. Use it to turn a `prompt`/`cli`/`http` answer into a struct or number.

## Config
- `type` (string, optional, default `any`): a type name: `string`, `number`, `bool`, `any`, `list<T>`, or a struct defined on the workflow. A malformed type name is `validation`.
- `pins` is ignored: the pins are fixed by the kind.

## Pins and output
- In pin: `text` (`string`). Out pin: `value` (the configured type).
- Output text: the parsed value rendered canonically (a JSON string is emitted raw; anything else compact JSON). Invalid JSON, or JSON that does not match the type (wrong field, wrong kind), fails the node with the reason, so give the producer a strict "reply with JSON only" instruction and wrap in `trycatch`/a `failure` edge if it may be wrong.
- No branch routing.

## Use when / not when
- Use after a node that emits JSON, before `break`, `variable set`, `mapfilter` or a typed wire.
- Not for plain text (no parsing needed), and not to pick a field from JSON by path: type it to a struct and use `break`.

## Example
```bash
naru workflow node create my-flow parse-json "Parse" --config '{"type":"Review"}'
```
(`Review` must exist: `naru workflow type add my-flow Review --field score:number --field note:string`.)
