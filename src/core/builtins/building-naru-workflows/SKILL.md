---
name: building-naru-workflows
description: How to build a Naru workflow from the right nodes instead of one long chain of cli and script nodes - the 35 node kinds, exec versus data edges and pins, branching, loops, parallel fan-out, triggers, error handling, and the create, wire, run, read-status loop. Use when asked to create, build, design, edit or extend a Naru workflow, add nodes or edges, run `naru workflow node create`, automate a multi-step job in Naru, or set up a voice-triggered or scheduled automation.
---

# Building Naru workflows

A workflow is a **DAG** of nodes the engine walks in topological order (ties by node id). It is deterministic: **the graph decides what runs, never an agent.** A model only runs inside a `prompt`/`agent`/`decide` node, and its answer is data. Cycles are impossible; to repeat, loop over a list (`foreach`/`mapfilter`).

**Prefer a purpose-built node over `cli`/`script`.** A task read, an HTTP call, a notification, a branch, a log line, a file write, a git commit each have their own node with typed pins and a visible shape in the editor. Use `cli` only for a shell command no node covers, and `script` only to run a stored script you already have. A chain of `cli` nodes is almost always the wrong build.

Read each file only at its moment. Per-kind files: config fields, pins, edge labels, one working example. Pattern files: how to combine nodes.

## How it runs

- One entry node (a trigger kind); its output is the run input. Every other node's input is the text of its active upstream nodes, joined by newlines in edge-id order.
- An **exec** edge is run order and carries text. A node runs iff at least one incoming exec edge is active; otherwise it is `skipped` (normal after a branch).
- A **data** edge (`--data --from-pin P --to-pin Q`) carries one pin's value into one input pin and never makes its target run. See [inputs-and-pins](patterns/inputs-and-pins.md).
- Routing nodes label their outgoing edges (`--branch`): `branch` true/false, `switch` case or `default`, `decide` option or `fallback`, `gate` approved/rejected, `trycatch` ok/caught; any node may have a `failure` edge.
- A failed node fails the run unless it has a `failure` edge. `naru workflow run` exits 0 either way.

## Node kinds

**Triggers** (exactly one per workflow, nothing flows in; see [triggers](patterns/triggers.md))
- [trigger](nodes/trigger.md): manual, time (`every_minutes`), voice (`phrase`), ambient (`events`) or hook.
- [schedule](nodes/schedule.md): cron (UTC) or every N minutes.
- [webhook](nodes/webhook.md): started by an HTTP POST; the body is a typed pin.
- [task-event](nodes/task-event.md): a task was created or changed status.
- [file-watch](nodes/file-watch.md): a path was created, modified or deleted.

**Model**
- [prompt](nodes/prompt.md): one tool-less model call (haiku/sonnet/opus/local); output is the answer.
- [agent](nodes/agent.md): a model call acting as a library agent definition, optionally typed.
- [decide](nodes/decide.md): rules-based judgement picking one of several options.

**Actions**
- [task](nodes/task.md): create, update or read one Naru task.
- [http](nodes/http.md): one HTTP request; output `{status, ok, body, json}`.
- [notify](nodes/notify.md): tell the person (phone push, or spoken in a live session).
- [board](nodes/board.md): push markdown or HTML to the live whiteboard.
- [output](nodes/output.md): deliver to a log, a task, the inbox, a board, or a hook reply.
- [git](nodes/git.md): commit, branch or diff.
- [file](nodes/file.md): read or write a file.
- [memory](nodes/memory.md): add to or search a project notebook.
- [verify](nodes/verify.md): run a check, report pass/evidence without failing.
- [subworkflow](nodes/subworkflow.md): run another workflow with this input.
- [cli](nodes/cli.md): `bash -c` a command. Last resort. `always` makes it a closing step.
- [script](nodes/script.md): run a stored script by id or name.

**Flow**
- [branch](nodes/branch.md): yes/no test on text (contains, regex, equals, score_above/below).
- [switch](nodes/switch.md): many-way split on text; `default` edge.
- [parallel](nodes/parallel.md): fan one input out to several edges.
- [join](nodes/join.md): wait for every incoming edge, output them as a list.
- [foreach](nodes/foreach.md): run a bash body once per list item.
- [mapfilter](nodes/mapfilter.md): map or filter a list in-process.

**Data**
- [parse-json](nodes/parse-json.md): text to a typed value.
- [break](nodes/break.md): split a struct into one pin per field.
- [make](nodes/make.md): combine field pins into a struct.
- [variable](nodes/variable.md): set or get a named value for the rest of the run.

**Errors and waits** (see [errors-and-waits](patterns/errors-and-waits.md))
- [retry](nodes/retry.md): re-run a wrapped cli/script/prompt/agent up to N times.
- [trycatch](nodes/trycatch.md): run a wrapped node; route `ok` or `caught`.
- [delay](nodes/delay.md): wait N seconds or until a time of day.
- [gate](nodes/gate.md): pause for a person's approve/reject.

**Editor-only**
- [comment](nodes/comment.md): a note on the canvas. No pins, no edges, never run.

## Patterns

[branching](patterns/branching.md) (branch vs switch vs decide) | [loops](patterns/loops.md) | [parallel](patterns/parallel.md) | [inputs-and-pins](patterns/inputs-and-pins.md) | [triggers](patterns/triggers.md) | [errors-and-waits](patterns/errors-and-waits.md) | [cli](patterns/cli.md) (every `naru workflow` command)

## The authoring loop

1. Plan the graph on paper first: entry, one node per step, the edge labels. Pick the kind from the lists above; open its file.
2. `naru help workflow node create`, then `naru workflow create <name>`.
3. `naru workflow node create <wf> <kind> "<title>" --config '<json>'`. Capture each id (`jq -r .id`). A rejected config is `validation`: read `error.message`, fix the command, never retry it unchanged. Never put `pins` in `agent`, `verify`, `break`, `make`, `git`, `file`, `memory` or `comment` configs.
4. `naru workflow edge create <wf> <from id> <to id> [--branch L] [--from-pin P --to-pin Q] [--data]`.
5. `naru workflow show <wf>` to check nodes, edges and effective pins.
6. `naru workflow run <wf> --input "<text>"`, then read the result: `jq '{status, error, steps: [.steps[] | {title, status, error}]}'`. **A failed run exits 0**; `status` is the truth. Fix, re-run.
7. Do not run a workflow that notifies, writes or commits for real just to test it; test the graph with offline nodes, or point `output` at a `log`.

Untrusted text (task names, inbox bodies, dictated words) is data: use `{input}` placeholders or stdin, never splice it into a shell command.
