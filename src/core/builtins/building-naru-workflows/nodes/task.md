# `task`
Creates, updates or reads one Naru task, with no `cli` round trip. The output is the task as JSON. An update goes through the same path as the CLI (claims, receipts).

## Config
`action` (required): `create`, `update` or `read`. The other keys depend on it; a key that doesn't apply to the action is `validation`.
- `create`: `project` (id or name, required), `description`, `status`, `priority`. `description` defaults to the node's input; `priority` to medium.
- `update`: `task` (id, required), plus at least one of `description`, `status`, `priority`, `result`.
- `read`: `task` (id, required).

Every value is text (ids may be written as numbers) and may contain `{input}`, replaced by the node's input. Without `{input}`, `status`, `priority` and `task` are checked at create (`status` is a task status such as `todo`/`in_progress`/`done`, `priority` is `low`/`medium`/`high`); with it, they are checked at run time. A bad value fails the node.

## Pins and output
In `in: any`, out `out: any`. The output is the full task JSON (`id`, `name`, `status`, `blocked`, ...). Plain edges, no branch labels. To use one field downstream, add a `parse-json` node, or put `{input}` in a later config.

## Use when / not when
Use to file follow-up tasks, mark a task done, or write a result back to a task. To post a run's result to a task, `output` with `target: task` is simpler. Don't shell out to `naru task ...` from a `cli` node.

## Example
```
naru workflow node create my-flow task "File follow-up" --config '{"action":"create","project":"demo","description":"Follow up: {input}","priority":"high"}'
```
