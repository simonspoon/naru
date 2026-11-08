# `board`
Pushes a markdown or html card onto the live whiteboard in the current live conversation, and passes the input through. It shows a result without a spoken message.

## Config
- `kind` (string, default `markdown`): `markdown` or `html`.
- `title` (string, optional, at most 200 characters).
- `body` (string, optional, at most 2 MiB): `{input}` is replaced. Defaults to the node's input. If both are empty the node fails.

## Pins and output
In `in: any`, out `out: any`. The output is the input, unchanged. Plain edges.
It fails with `unavailable` when no live conversation is running (`naru live start`), so it suits workflows triggered from live (`voice`/`ambient` triggers) or run while a conversation is open.

## Use when / not when
Use to show a summary, table or diagram to the person in a live session. For a phone push or spoken line, use `notify`. For a workflow's final record, use `output` (`target: board` / `log` / `task`).

## Example
```
naru workflow node create my-flow board "Show result" --config '{"kind":"markdown","title":"Result","body":"## Result\n\n{input}"}'
```
