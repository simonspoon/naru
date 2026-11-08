# `webhook`
A trigger source started by an HTTP call: `POST /api/workflows/{id}/webhook` with a JSON body and `Content-Type: application/json`. The route is synchronous (it answers the finished run record; a failed run is still HTTP 200 with `status: "failed"`). Unknown workflow is 404; a workflow with no webhook node, an over-limit body, or not exactly one entry node is 422. An entry node: one per workflow, nothing may connect into it, so it cannot share a workflow with `trigger` or `schedule`.

## Config
- `type` (string, optional, default `any`): a pin type name (a builtin such as `string`/`number`/`bool`/`list<string>` or a struct from the workflow's Types card). The posted body must be JSON that fits it; otherwise the webhook node, and so the run, fails.
Unknown keys are `validation`.

## Pins and output
No input pin. One output pin `body`, typed by `type`. The raw body is parsed by the `parse-json` rule, so with a struct `type` an edge can leave by a field pin; the text output is the canonical JSON.

## Use when / not when
Use when an outside program (CI, a script, curl) should start the run and hand it data. Prefer `task-event` for a Naru task write and `file-watch` for a file change; they need no caller. Reach it from the same machine only unless the server runs with `--lan`; it sits behind the agent-access check.

## Example
```bash
naru workflow node create my-flow webhook Hook --config '{"type":"string"}'
```
Then: `curl -X POST -H 'Content-Type: application/json' -d '"hello"' http://127.0.0.1:7777/api/workflows/<id>/webhook`.
