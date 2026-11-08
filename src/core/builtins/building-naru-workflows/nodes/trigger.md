# `trigger`
The entry node of a workflow: its output **is** the run input. A workflow has exactly one entry node, so a `trigger` cannot share a workflow with a `schedule`, `webhook`, `task-event` or `file-watch`; nothing may connect into it. Without `--config` it is `{"mode":"manual"}`.

## Config
- `mode` (string, required): `manual` | `time` | `voice` | `ambient` | `hook`.
- `every_minutes` (int 1..=10080): required iff `mode` is `time`; refused on any other mode.
- `events` (array of `idea` | `can-help` | `wake`): required iff `mode` is `ambient` (non-empty, no duplicates); refused on any other mode.
- `phrase` (string, optional): the spoken phrase for a `voice` trigger.

| mode | starts when | run input |
| --- | --- | --- |
| `manual` | `naru workflow run <wf> --input TEXT` (or the Run button) | the `--input` text |
| `time` | the time watcher, every `every_minutes` (needs the time watcher, on by default in `serve`) | empty |
| `voice` | the person says the workflow's name or `phrase` to Naru live (`workflow run --trigger voice`) | the `--input` text |
| `ambient` | `naru workflow emit <event>` / the listening engine reports a listed event | JSON `{"event","speaker","text"}` |
| `hook` | a Claude Code hook runs `naru workflow run <wf> --hook` | the hook event JSON from stdin |

A `hook` workflow answers the hook with an `output` node `{"target":"reply",...}`; `--hook` refuses a workflow whose trigger is not `hook`.

## Pins and output
No input pin. One output pin `event` (the run input as text). Every downstream node that takes `{input}` (cli `$NARU_INPUT`/stdin, `task`, `http`, `notify`, `board`, `script` values, `agent` prompt) receives this text from the edge; a `prompt` appends it after its text instead. Use `parse-json` + `break` to pick fields out of a JSON input.

## Use when / not when
Use for a run started by hand, by voice, by a repeating interval, by the ambient engine, or by a Claude Code hook. Prefer `schedule` for a cron or weekday time (`trigger time` only repeats every N minutes), `webhook` for an HTTP call, `task-event` for a task create/status change, `file-watch` for a file change. Do not use `cli` polling loops to imitate these.

## Example
```bash
naru workflow node create my-flow trigger Start --config '{"mode":"ambient","events":["idea","can-help"]}'
```
Other shapes: `{"mode":"time","every_minutes":10}`, `{"mode":"voice","phrase":"capture a thought"}`, `{"mode":"hook"}`, `{"mode":"manual"}`.
