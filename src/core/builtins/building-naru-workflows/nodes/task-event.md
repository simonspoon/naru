# `task-event`
A trigger source fired by a task write: a task **creation**, or a **change of status** (a write that leaves the status alone fires nothing). One run per matching enabled workflow, started detached so the task write never waits. An entry node: one per workflow, nothing flows in. Firing is best-effort, and a `cli`/`script` node that shells out to `naru task ...` inside such a run fires nothing (recursion guard).

## Config
- `event` (string, default `created`): `created` | `status` | `any`.
- `status` (string, optional): a task status to match (`backlog`, `todo`, `in_progress`, `done`, ...). Only with `event` `status` or `any`; with `created` it is `validation`. An invalid status is `validation`.
- `project` (id or case-insensitive name, optional): restrict to one project; blank means every project.
Unknown keys are `validation`.

## Pins and output
No input pin. Output pin `task` (string): the run input, compact JSON `{"event","task_id","project_id","status","old_status","name"}` (`old_status` is null for a creation; `name` is the derived task name). Feed it to `parse-json`, then pick fields with a `break`/data edge, or hand `task_id` to a `task` node with `read`.

## Use when / not when
Use to react to tasks: notify when one reaches `done`, triage new ones, mirror status elsewhere. Prefer it over a `schedule` plus a `cli` running `naru task list` and diffing. Point test workflows at a scratch project: a created `todo` task can be dispatched by the queue watcher.

## Example
```bash
naru workflow node create my-flow task-event Done --config '{"event":"status","status":"done","project":"demo"}'
```
