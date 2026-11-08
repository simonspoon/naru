# Triggers

A workflow has **one entry node**: exactly one of `trigger`, `schedule`, `webhook`, `task-event`, `file-watch` (a run with none or two is `validation`). Nothing may connect into it. Its output is the run input. Pick the source by what starts the run.

| Starts the run | Entry node | Config |
| --- | --- | --- |
| A person, a script (`naru workflow run`) | `trigger` | `{"mode":"manual"}` (the default) |
| Every N minutes | `trigger` | `{"mode":"time","every_minutes":1..=10080}` |
| A cron timetable (UTC) | `schedule` | `{"cron":"0 9 * * 1-5"}` or `{"every_minutes":N}`, exactly one |
| The person says a phrase to naru live | `trigger` | `{"mode":"voice","phrase":"morning brief"}` |
| An ambient live event | `trigger` | `{"mode":"ambient","events":["idea","can-help","wake"]}` (non-empty, no duplicates) |
| A Claude Code hook | `trigger` | `{"mode":"hook"}` |
| An HTTP POST | `webhook` | `{"type":"any"}` (the body's pin type) |
| A task is created or changes status | `task-event` | `{"event":"created"\|"status"\|"any","status":"done","project":"Demo"}` |
| A path changes | `file-watch` | `{"path":"/tmp/inbox","event":"any"\|"created"\|"modified"\|"deleted"}` |

## Notes per source

- **Timed runs** (`trigger` mode `time`, `schedule`) are fired by the time watcher of `naru serve` (on by default, ticks every 60 s). A workflow is "on" exactly when it has such an entry node. The run row is the claim, so one interval never fires twice. `cron` is 5 fields, **UTC**: `*`, `n`, `a-b`, `*/s`, `a-b/s`, comma lists. A manual run of a schedule workflow works too.
- **Voice**: say the phrase to the live agent, which runs `naru workflow run "<name>" --trigger voice`. `naru workflow list` shows each workflow's `trigger` and, for voice, its `trigger_phrase` so the agent can match a spoken request. Only `trigger`-kind entries are reported there: a `schedule`, `webhook`, `task-event` or `file-watch` workflow lists `trigger: null`. Without a `phrase` the workflow is called by name only.
- **Ambient** workflows run on `naru workflow emit <event> --speaker S --text T` (the live engine does this); the run input is the event JSON `{event, speaker, text}`.
- **Hook**: `naru workflow run "<name>" --hook` reads the hook JSON on stdin; the answer comes from `output` nodes with `target: reply` (`decision` `block|allow|context`). Test by hand before wiring it into settings: a clap usage error exits 2, which Claude Code reads as a block.
- **Webhook**: `POST /api/workflows/{id}/webhook` with `Content-Type: application/json`; the body goes through the `parse-json` rule into the typed output pin `body`. Answers the finished run.
- **task-event**: fires on task creation or status change from the CLI/API (not from a workflow `task` node, and not from a `cli` node inside such a run). `status` requires `event` `status` or `any`. The run input is the JSON `{"event","task_id","project_id","status","old_status","name"}`.
- **file-watch**: polled once per watcher tick (about 60 s); no globs; the first sight of a path never fires; a create-and-delete between ticks is missed. The run input is `{"path","event","mtime","size"}`.
- **Want two sources** (say, a voice phrase and a schedule)? One workflow cannot. Put the logic in the voice workflow and make a second workflow whose entry is the `schedule` and whose only node is a `subworkflow` calling the first.

## Worked example

A voice workflow holds the logic; a weekday-09:00 schedule workflow calls it. Offline (a manual run of both).

```bash
node() { naru workflow node create "$@" | jq -r .id; }
naru workflow create morning-brief >/dev/null
T=$(node morning-brief trigger "Voice start" --config '{"mode":"voice","phrase":"morning brief"}')
M=$(node morning-brief mapfilter "Label" --config '{"mode":"map","expr":"brief: {item}"}')
O=$(node morning-brief output "Log brief" --config '{"target":"log","log":"briefs"}')
naru workflow edge create morning-brief $T $M >/dev/null
naru workflow edge create morning-brief $M $O >/dev/null
naru workflow create morning-brief-schedule >/dev/null
S=$(node morning-brief-schedule schedule "Weekdays 09:00" --config '{"cron":"0 9 * * 1-5"}')
C=$(node morning-brief-schedule subworkflow "Run brief" --config '{"workflow":"morning-brief"}')
naru workflow edge create morning-brief-schedule $S $C >/dev/null
naru workflow run morning-brief --trigger voice --input "todo one" | jq -r .status
naru workflow run morning-brief-schedule --input "from the schedule" | jq -r .status
naru workflow list | jq -c '.[] | {name, trigger, trigger_phrase}'
```
