# `break`
Splits a struct value into its fields. Input is one JSON object of a workflow-defined struct; each field becomes its own output pin, so downstream nodes can take a single field without any `jq`/`cli` step.

## Config
- `struct` (string, required): the name of a struct type defined on the workflow (`naru workflow type add <WF> <NAME> --field name:type ...`; field types: `string`, `number`, `bool`, `any`, `list<T>`, another struct). `list<...>` is refused here. Define the type first.
- No `pins` key: it is `validation` on break/make. Pins come from the struct.

## Pins and output
- In pin: `value` (type = the struct). Out pins: one per struct field, named after the field and typed by it.
- Output text: the struct, validated and re-rendered as canonical JSON (fields in declared order). A malformed shape, a missing field or a wrong-typed field fails the node.
- An edge leaving a field pin carries only that field (a `string` field raw, anything else compact JSON): `naru workflow edge create my-flow <BREAK> <TO> --from-pin score`. Wire a field with the same type as the target pin (`any` matches all). Use `--data --from-pin F --to-pin P` to feed a field into a node that is already activated by an exec edge.
- No branch routing.

## Use when / not when
- Use after `parse-json` (typed to the struct), a prompt that emits JSON, or any struct-typed source, to pick fields out.
- Not for an unstructured/ad hoc JSON blob with no type: use `parse-json` with `type` `any` and a `cli`/`mapfilter` only if truly needed. The inverse is `make`.

## Example
```bash
naru workflow type add my-flow Review --field score:number --field note:string
naru workflow node create my-flow break "Split" --config '{"struct":"Review"}'
naru workflow edge create my-flow <PARSE_ID> <SPLIT_ID> --to-pin value
naru workflow edge create my-flow <SPLIT_ID> <NOTE_CONSUMER_ID> --from-pin note
```
