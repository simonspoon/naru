# `output`
The sink: delivers the node's input text somewhere, in-process (no `cli naru ...` call needed). The `target` selects where; each target accepts only its own keys (others are `validation`).

## Config
- `target` (required): `log` | `task` | `inbox` | `board` | `reply`.
- `log`: `log` (string, default `default`): the workflow log name. Read with `naru workflow log <name>`.
- `task`: `project` (required, id or name) creates a task whose description is the input; `status` (`backlog` | `todo`, default backlog).
- `inbox`: `task_id` (integer >= 1, required: the task the item concerns); `kind` (`task-summary` default | `change-request`). Files an inbox item with the input as its body.
- `board`: `title` (optional, default the node title). Pushes the input as a markdown board to the current live conversation; fails if none is running.
- `reply`: `decision` (required): `block` | `allow` | `context`; `message` (optional; `{input}` is replaced by the input, default the input). Writes nothing; it only records the answer for a run started with `naru workflow run --hook` (Claude Code hooks: `block` denies, `context` adds context, `allow` passes).
- `pins` optional.

## Pins and output
- In: `result`. Output text is a receipt (`logged to default (line 3)`, `created task 12`, `filed inbox item 4`, `pushed board 2`), or for `reply` JSON `{"reply","message"}`.
- Empty input (non-reply targets) is not a failure: output `nothing to deliver`, nothing written.
- No routing; a terminal node.

## Use when / not when
- Use at the end of a flow to log, file a task, file an inbox item, show on the board, or answer a hook.
- Not to notify the person (use `notify`), call an API (`http`), or write a file (`file`).

## Example
```bash
naru workflow node create my-flow output "Save" --config '{"target":"log","log":"results"}'
naru workflow node create my-flow output "Reply" --config '{"target":"reply","decision":"block","message":"Blocked: {input}"}'
```
