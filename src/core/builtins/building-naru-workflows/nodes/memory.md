# `memory`
Adds to or searches a project's notebook (its saved notes), through the guarded store path.

## Config
- `op` (required): `add` or `search`.
- `text` (string, `add` only): `{input}` replaced. Defaults to the node's input. Using `query` or `limit` with add is `validation`.
- `query` (string, `search` only): `{input}` replaced; defaults to the node's input. Using `text` with search is `validation`.
- `limit` (int 1..=50, `search`; default 10).
- `project` (string, optional): project id or name, `{input}` allowed. Defaults to the workflow's own project; with neither, the node fails.

`pins` can't be set: they are fixed. An empty text or query fails the node.

## Pins and output
In `input: any`. Two out pins: `result` (string) and `id` (string). An edge leaves from the pin it names (`--from-pin`); with none it carries `result`.
- add: result = the saved text, id = the new entry's id.
- search: result = one JSON line per hit, `{"id": ..., "snippet": ...}`; id is empty.

## Use when / not when
Use to remember a finding across runs, or to pull relevant notes into a `prompt` or `agent`. Don't use it for task state (`task`) or file output (`file`).

## Example
```
naru workflow node create my-flow memory "Remember" --config '{"op":"add","text":"Learned: {input}"}'
```
