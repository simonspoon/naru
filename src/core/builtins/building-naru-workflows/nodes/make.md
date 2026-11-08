# `make`
Builds a struct value from separate inputs: one input pin per field, one output pin `value` carrying the assembled JSON object. The inverse of `break`.

## Config
- `struct` (string, required): the name of a struct defined on the workflow (`naru workflow type add ...`). `list<...>` is refused.
- No `pins` key (`validation`); pins come from the struct.

## Pins and output
- In pins: one per field, named and typed by the field. Out pin: `value` (the struct).
- Output text: JSON object, fields in declared order, validated against the type. Every field must receive an input or the node fails (`field "x" of Review has no input`); a non-string field's text must be valid JSON of its type.
- Feeding fields: use data edges, `naru workflow edge create my-flow <SRC> <MAKE> --data --from-pin <OUT> --to-pin <FIELD>`. A data edge never activates its target, so ALSO add one plain exec edge into the make node from something that runs (it activates the node; an exec edge's JSON object text can supply fields too). A Break to Make round trip is byte-identical.
- No branch routing.

## Use when / not when
- Use to assemble a typed record from several upstream values before `variable set`, `output`, or passing to a typed pin.
- Not to template free text: use `mapfilter` map (`{item}`) or the `{input}` of a `prompt`/`cli`.

## Example
```bash
naru workflow type add my-flow Review --field score:number --field note:string
naru workflow node create my-flow make "Build" --config '{"struct":"Review"}'
naru workflow edge create my-flow <SCORE_ID> <BUILD_ID> --data --from-pin stdout --to-pin score
naru workflow edge create my-flow <NOTE_ID> <BUILD_ID> --data --from-pin result --to-pin note
naru workflow edge create my-flow <NOTE_ID> <BUILD_ID>
```
