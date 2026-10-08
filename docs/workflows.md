# Workflows (deterministic graphs of steps)

A **workflow** is a saved graph of typed steps that Naru runs in a fixed order.
It replaced diagrams (mesa task 1607): the diagram tables were dropped by
migration index 83 (`user_version` 84) and nothing was carried over, because
saved diagrams were stale and unused. A workflow is not a canvas of cards, it
is a DAG the **engine** walks — **the graph decides what runs, never an agent.**
The only model call anywhere is one `prompt` node's one synchronous call.

Source of truth: `src/core/workflow.rs` (validation and engine),
`src/core/store.rs` (rows and graph rules), `src/cli.rs` (`naru workflow`),
`src/api.rs` (routes and the watcher), `scripts/workflow-check.sh` (the gate).

## Model

| Table | Holds | Notes |
| --- | --- | --- |
| `workflows` | `id`, `project_id` (nullable, `ON DELETE CASCADE`), `name`, `description`, timestamps | `name` is unique **case-insensitively across all workflows** (so the CLI and the voice agent can run one by name) and never a plain number (`<id\|name>` tries the integer first) |
| `workflow_nodes` | `id`, `workflow_id` (cascade), `kind`, `title` (≤ 200), `config` (JSON), `x`, `y`, timestamps | `kind` is fixed at creation; `config` is validated per kind |
| `workflow_edges` | `id`, `workflow_id` (cascade), `from_node`, `to_node` (both cascade), `branch` | a DAG: no self-edge, no cycle |
| `workflow_runs` | `id`, `workflow_id` (cascade), `trigger`, `input`, `status`, `steps` (JSON), `error`, `started_at`, `finished_at`, plus a store-only `owner_pid` | the newest **50 finished** runs per workflow are kept (pruned on insert; a `running` row is never pruned — it is a live claim) |
| `workflow_log` | `id`, `log`, `text`, `workflow_id` and `run_id` (both `ON DELETE SET NULL`), `created_at` | append-only; written by an `output` node with `target: log` |

All writes go through `Store`. `Workflow` carries two **derived, never stored**
fields read off its trigger node on every read — `trigger` (`manual|time|voice|ambient`
or `null`), `trigger_phrase` and `trigger_events` (an ambient trigger's `events`, else `[]`) — so `naru workflow list` can say which workflow
a spoken request could mean without loading every graph. Four more are derived
from `workflow_runs` the same way (mesa task 1632), so `workflow list` and
`GET /api/workflows` carry list status: `last_run_at`/`last_run_status` (the
newest run, any trigger), `last_failure_at` (start of the newest `failed` run
still kept) and `next_run_at` (a `time` workflow only: the newest `trigger =
time` run's start plus `every_minutes`, the instant `due_time_workflows` stops
excluding it, so it may be past; `null` for any other trigger, or a time
workflow never run by its timer, which is due at once). There is no stored
enabled flag: a workflow is **on** exactly when its trigger is `time`.

Graph rules (`Store`):

- **At most one `trigger` node** per workflow, and a trigger has **no incoming
  edges** (`validation`). A *run* needs exactly one (`validation` otherwise).
- Both "at most one trigger" and "no cycle" are check-then-insert, so node and
  edge creation run inside `BEGIN IMMEDIATE` (the CLI and the server are
  separate processes). `execute_run` also refuses (`failed`, naming a
  cycle) a graph whose topological order is shorter than its node count — a
  hand-edited database.
- An edge's endpoints must both belong to the edge's workflow (`validation`).
- A **self-edge** or an edge that would close a **cycle** is `cycle`.
- An exact duplicate `(from, to, branch)` is `conflict`.
- An edge leaving a `branch` node **needs** `branch` (`true`/`false`); an edge
  leaving a `decide` node **needs** one of that node's `options` or `fallback`
  (`validation`, naming the options); an edge leaving any other node
  **refuses** one. `branch` is free text in the db (a decide option), so
  `WorkflowEdge.branch` is a string; changing a decide node's config
  is refused (`validation`, naming the edge id and label, nothing written) while
  an edge leaves it on a label that is neither `fallback` nor one of the new
  options. Options are stored trimmed, so one that is empty or a duplicate after
  trimming is `validation`.
- Deleting a node deletes its edges; the echo is `{node, edges}`. Deleting a
  workflow echoes the whole destroyed `{workflow, nodes, edges}` — the
  recovery transcript, there is no confirmation prompt — and keeps its log
  lines, unattributed. Unscoped `list` hides the workflows of an archived project
  (and of one under an archived ancestor) like every unscoped read; a global
  workflow is always visible.

## Node kinds and their config

Unknown keys and bad values are `validation`; only the *shape* is checked (a
script that does not exist yet, a binary that is not installed are runtime
failures, so a graph can be authored before everything it names is in place).
Stored config is the validated, normalized form.

| Kind | Config | What it does |
| --- | --- | --- |
| `trigger` | `{"mode": "manual"\|"time"\|"voice"\|"ambient", "every_minutes": 1..=10080 (required iff time), "events": ["idea"\|"can-help"\|"wake", …] (required iff ambient: non-empty, no duplicates, refused on any other mode), "phrase": "…" (optional, for voice)}` | the run's source; its output **is** the run input. Without `--config`, `{"mode":"manual"}` |
| `prompt` | `{"model": "haiku"\|"sonnet"\|"opus"\|"local:<name>" (a name never starts with `-`), "thinking": bool (default false), "prompt": "…" (non-empty), "timeout_secs": 1..=3600 (default 600)}` | one synchronous model call; the node's output is the model's text answer, trimmed |
| `cli` | `{"command": "…" (non-empty), "timeout_secs": 1..=86400 (default 600)}` | `bash -c <command>` **verbatim** (the author wrote it, as with scripts); output is stdout |
| `script` | `{"script": "<id or name>", "values": {"name": "…"}, "timeout_secs": 1..=86400 (default 600)}` | runs a stored script (`docs/scripts.md`); output is stdout |
| `branch` | `{"op": "contains"\|"regex"\|"score_above"\|"score_below"\|"equals", "value": "…" (a number for `score_*`)}` | evaluates its input to a verdict; output is its input, unchanged |
| `decide` | `{"question": "…" (non-empty, may contain `{input}`), "options": ["a", "b", …] (2 or more, distinct, non-empty, none named `fallback`), "threshold": 0..=1 (default 0.5)}` | a local judgement (`core::decide`, `docs/decide.md`) that picks one option; routes like a `branch`, one edge per option plus an optional `fallback` edge |
| `output` | `{"target": "log", "log": "<name>" (default `default`)}`, `{"target": "task", "project": "<id\|name>", "status": "backlog"\|"todo" (default todo)}`, `{"target": "inbox", "task_id": N, "kind": "task-summary"\|"change-request" (default task-summary)}`, `{"target": "board", "title": "…"}` | delivers its input; output is a short receipt. A key that does not apply to the target is refused |

**`prompt`.** One model call (`core::llm`) — **no API key anywhere**. The prompt (the node's text, a blank line, then the node's
input; just the text when the input is empty) goes in as **one user message**,
no tool is ever offered, and the answer is the model's text, trimmed.
`thinking` is **off by default**.

| `model` | Backend |
| --- | --- |
| `haiku`, `sonnet`, `opus` | **one synchronous print-mode call**: the `workflow-prompt` config template (`docs/config.md`) resolved by `agents::workflow_prompt_script` — the same template path every spawn uses — i.e. `claude -p --model <m> --name "workflow <workflow> · <node>" --tools "" --strict-mcp-config --output-format json --settings '{"alwaysThinkingEnabled":<thinking>}' -- <prompt>` |
| `local:<name>` (a name never starts with `-`) | Ollama's HTTP API: `POST {OLLAMA_HOST}/api/chat`, `{model, messages: [one user message], stream: false, think: <thinking>}`; the answer is `message.content`. `OLLAMA_HOST` defaults to `127.0.0.1:11434`, with or without a scheme (as Ollama reads it); Ollama not running is a node failure that says so. Plain HTTP over `curl` with the request on stdin, so the prompt is never on argv |

**How the answer comes back — deterministic, no agent deciding anything.**
The engine runs the script with `agents::capture` (its own process group,
killed whole on a timeout) and parses stdout as `claude -p`'s result object —
`{"type":"result","subtype":"success","is_error":false,"result":"<text>",…}`
(checked against the real CLI). The answer is `result`. A nonzero exit,
output that is not that object, `is_error: true`, a non-`success` subtype or an
empty `result` is a node failure naming it, with the stderr tail where there is
one; **`timeout_secs` (default 600) bounds the whole call** and a timeout
fails the node. There is nothing to poll, stop or read back from a
transcript, and no session is left behind to clean up. (Telling the model to
deliver its answer with a `naru workflow …` command was rejected: it needs the
Bash tool this node must not have — its input is untrusted upstream text — and
makes the engine's progress depend on a model obeying an instruction.)

The store lock is **never held** while the agent runs
(only a brief read of the library's prompt table before the call). The call
starts in the workflow's project `local_path` (else `~/.naru/workspace`, the
one folder whose Claude Code trust prompt is answered once).

**`cli`.** The input arrives on **stdin** *and* as `NARU_INPUT` (set only when
the input is ≤ 64 KiB — a process environment has a hard limit; stdin always
carries it all). Stdout is the output; a nonzero exit fails the node with the
stderr tail; past `timeout_secs` the whole process group is killed. The cwd is
the workflow's project `local_path` (when that folder exists), else
`~/.naru/workspace`.

**Size limits.** The sum of a `script` node's values is capped at **64 KiB**:
they travel as argv/environment, so over the cap the node fails with a message
naming the limit rather than the OS refusing the exec. A `cli` node has no such
cap (its input rides on stdin). A `prompt` node on an Anthropic model is capped
at **24 KiB** (`llm::AGENT_PROMPT_MAX`) — its prompt is one single-quoted
argument of the spawn script, which quoting can grow fourfold against Linux's
128 KiB single-argument limit — and fails before anything is spawned; a
`local:` node sends its body on curl's stdin and has no cap.

**Process groups.** Every `cli` and `script` process (and a local prompt's curl) runs in its own
group (`agents::capture`). Past the deadline the group is killed; and when the
node's own process exits, the group is killed **too**, so a backgrounded
grandchild (`sleep 1000 &`) can neither hold the node's pipes open nor outlive
it. A command that deliberately daemonizes must `setsid` out of the group.

**`script`.** Any value may contain the literal token `{input}`, replaced by
the node's input text. The script runs under `timeout_secs` (default 600),
killed by process group past it, via `scripts::run_with_timeout`. The substituted text is handed to the script as one
**argument value** (`$1`… and `NARU_ARG_<NAME>`), never a fragment of a shell
command line — so `$()`, backticks and quotes arrive byte-identical
(`scripts-check` and `workflow-check` pin it). Values are validated against the
script's declared args (`scripts::validate_values`); the script runs in its own
project's `local_path` (which must exist) or `~/.naru/workspace`. A nonzero
exit fails the node.

**`branch`.** `contains` is a case-sensitive substring test; `equals` compares
both sides trimmed (stdout ends in a newline, the config rarely does);
`regex` is a **POSIX extended regular expression** evaluated by `grep -E` (no
regex crate is linked; the dialect is whatever the machine's `grep -E`
speaks, and the same `grep` validates the pattern at node-create time);
`score_above`/`score_below` compare the **first decimal number** in the input
(`-?digits[.digits]`) against `value`, and no number at all is `false`. A
branch passes its input on **unchanged** — a gate like `score_above` over a
model's score therefore hands the *score*, not the text it scored, to the nodes
after it; gate on the thing you want to carry forward.

**`decide`.** Like a `branch`, but it *judges* rather than matches (mesa task
1655). The node calls `core::decide::decide` **in-process** — no process, no
network, no model, no key; the backend is the `decide` config section (rules
file or `off`, `docs/decide.md`) — with the `question` (every `{input}` replaced
by the node's input text) and the node's input as the context the rules may
read. Each option is its own outgoing edge, labelled with the **exact option
text** (`workflow edge create <wf> <from> <to> --branch <option>`), plus an
optional edge labelled `fallback`.

- A choice that is not null **and** whose `confidence` is at least `threshold`
  activates only its option's edges.
- Otherwise — a null choice, a confidence below the threshold, the backend
  `off` — the `fallback` edges are active. With **no** fallback edge nothing is
  active and everything downstream is `skipped`; the run still succeeds (a
  low-confidence verdict is an answer, not a failure).
- A decide **error** (an unreadable or invalid rules file, an unknown backend)
  takes the `fallback` edge too when the node has one, the message in the
  output's `error` key; with no fallback edge the node **fails**, and so the
  run, like any failing node (the `branch` regex error is the precedent).
- The output is a JSON object, so downstream nodes read the verdict:
  `{"choice": "<option>"|null, "confidence": n, "agreement": n, "threshold": n,
  "backend": "rules"|"off", "rule": "<id>"|null, "fallback": bool}` (plus
  `"error"` after a decide error). `choice` is the engine's pick even when the
  threshold sent the run down `fallback`; `fallback` says which way it went.
  Unlike a `branch`, the input is **not** passed on — a downstream node that
  needs the original text takes it from a second edge off an earlier node.

**`output`.** `log` appends a line to the named log (`workflow log <name>`);
`task` creates a task (the input is its description) in the named project;
`inbox` files an item of the given kind naming `task_id` (an inbox item always
names the task it came from); `board` pushes a markdown board onto the
**current live session** (none is a node failure naming `naru live start`).
An **empty input** (blank text) is **not a failure**: the node succeeds with
output `nothing to deliver` and writes no record, so a silent run — an empty
transcript, a filter that let nothing through — files nothing and still
succeeds.

## Engine semantics

1. **Order** is a topological sort (Kahn), the ready set a `BTreeSet`, so ties
   break by **node id**.
2. The trigger runs first; its output is the run `--input` text (possibly empty).
3. An **edge is active** when its source ran `ok` and — for an edge leaving a
   `branch` — its `branch` equals the source's verdict (`true`/`false`) — or
   `decide` — its `branch` equals the chosen option, or `fallback`.
4. A node with at least one incoming edge runs iff **at least one incoming
   edge is active**; its **input** is the outputs of its active upstream nodes
   joined by `"\n"` in **edge-id order**. A node whose incoming edges are all
   inactive is `skipped`. A node with no incoming edges that is not the trigger
   is unreachable, so it is `skipped` too.
5. A **failed node fails the run**: nothing downstream runs and every node not
   yet run is recorded `skipped`. `WorkflowRun.error` names the node.
6. Each node leaves one `WorkflowStep`:
   `{node_id, title, kind, status: ok|skipped|failed, output, error, duration_ms}`,
   output capped at 64 KiB. The run row is written `running` first (the
   claim) and finished exactly once; a run records even when it fails.
   **Live steps** (mesa task 1631): before a node's process starts the engine
   persists the steps so far plus one with status `running` for that node
   (`Store::update_workflow_run_steps`, only while the run is `running`), and
   persists again when it ends, so `run-show` / `GET /api/workflow-runs/{id}`
   on an in-progress run show where it is. `running` appears only on a
   `running` run; a persist failure never fails the run, the final finish is
   authoritative.

**Locking.** The engine takes the store only through a `StoreAccess` closure,
for the brief reads and writes around a node, and **never holds it while a
node's process runs**. The CLI wraps the `Store` it owns in a `Mutex`; the API
hands over its `Arc<Mutex<Store>>` on a `spawn_blocking` thread — one engine for
both, so a long run never stalls another request.

**Crashes.** A run row carries the pid of the process that owns it
(`owner_pid`, store-only, not on `WorkflowRun`). `serve` reconciles before it
binds (`Store::reconcile_workflow_runs`, `reconcile_script_runs`' rule): a
`running` run whose owner is dead — or is the starting server itself — becomes
`failed` with `server restarted: …`; a run owned by another **live** process (a
CLI run, a second `serve`) is never touched.

## CLI (`naru workflow`)

JSON only, positional-or-flag create shapes, `<id|name>` everywhere a workflow
is named.

| Command | Prints |
| --- | --- |
| `workflow create <NAME> [--project] [--description]` | the `Workflow` |
| `workflow list [PROJECT]` | a bare array of `Workflow` rows (each with `trigger`, `trigger_phrase`) |
| `workflow show\|get <id\|name>` | `{workflow, nodes, edges}` |
| `workflow update <id\|name> [--name] [--description ""] [--project ""]` | the `Workflow`; `""` clears/unbinds; no field is `usage` |
| `workflow delete <id\|name>` | the destroyed `{workflow, nodes, edges}` |
| `workflow run <id\|name> [--input TEXT \| --input-file PATH\|-] [--trigger manual\|voice]` | the finished `WorkflowRun` |
| `workflow emit <idea\|can-help\|wake> --speaker S [--text TEXT \| --text-file PATH\|-]` | runs every matching `ambient` workflow synchronously, id order; a bare array of the finished `WorkflowRun`s (`[]` when none match, exit 0); `--quiet` accepted and ignored |
| `workflow defaults --project <id\|name>` | `{created: [{workflow, nodes, edges}], skipped: [name]}` — creates the two default ambient workflows (below), skipping any whose name exists; `--quiet` accepted and ignored |
| `workflow runs <id\|name>` | a bare array of runs, newest first, **without `steps` and `input`** |
| `workflow run-show <run id>` | one run in full |
| `workflow log [<log>] [--limit N]` | the newest N lines (default 50), newest first; no name = every log. A limit outside 1..=1000 is `validation` (the API's `?limit=` too), not clamped |
| `workflow node create <WORKFLOW> <KIND> <TITLE> [--config JSON] [--x] [--y]` | the `WorkflowNode`; omitted coordinates place it in a row beside the others |
| `workflow node update <id> [--title] [--config JSON] [--x] [--y]` | the node; `--config` **replaces** the whole config |
| `workflow node delete <id>` | `{node, edges}` |
| `workflow edge create <WORKFLOW> <FROM> <TO> [--branch true\|false\|<option>\|fallback]` | the `WorkflowEdge` |
| `workflow edge delete <id>` | the destroyed edge |

**A failed run exits 0.** `workflow run` prints the recorded run
(`status: "failed"`, the steps, `error`) and exits **0**, exactly as `script
run` treats a script's nonzero exit: the status is data, and a caller reads it
with `jq -r .status`. Exit 1 is for "could not run at all" — an unknown
workflow, no (or two) trigger nodes, an input over 256 KiB. `--trigger time` is
refused (`usage`): it is the watcher's alone, since a hand-made run claiming it
would count against a schedule's interval.

`--quiet` is accepted on every mutation and on `show`/`get`/`run-show`, and
drops the unbounded free text: a workflow drops `description`; a node drops
`config`; a run drops `steps` and `input`; an edge has nothing to drop (quiet
== full). `show`/`delete` keep the `{workflow, nodes, edges}` key set and
compact their members. Quiet payloads that drop a key are alphabetical (`jq`,
never byte-compare). Key-parity tests in `cli.rs` force a decision when a
record gains a field.

`naru live board push --workflow <id|name>` snapshots a workflow's graph as an
SVG (kind `diagram`, `core::board::workflow_svg`) — see `docs/live.md`.

## API

Every route carries **`require_agent_access`, reads included** — a run
executes shell and model calls, and a node's `config` *is* that command, so
there is no coherent line between reading a workflow and writing one (the
scripts' and the library's posture; relaxing rather than refusing under
`--lan`, foreign Host/Origin refused in default mode). The Content-Type gate
applies as everywhere.

| Route | Does |
| --- | --- |
| `GET /api/workflows?project=<id>` / `POST /api/workflows` `{name, project_id?, description?}` | list / create (201) |
| `GET /api/workflows/{id}` / `PATCH` / `DELETE` | the view / update (`description`, `project_id` three-state: omit, `null` clears) / echo the destroyed view |
| `POST /api/workflows/{id}/nodes` `{kind, title, config?, x?, y?}` (201) | add a node |
| `PATCH /api/workflow-nodes/{id}` `{title?, config?, x?, y?}` / `DELETE` | update / echo `{node, edges}` |
| `POST /api/workflows/{id}/edges` `{from_node, to_node, branch?}` (201) / `DELETE /api/workflow-edges/{id}` | add / delete |
| `POST /api/workflows/{id}/run` `{input?}` | run **synchronously** (on `spawn_blocking`) and answer the finished run |
| `POST /api/workflows/events` `{event, speaker, text?}` | an ambient-engine event: validated synchronously (422), then the matching workflows run in the background in id order; **202** `{"workflow_ids":[…]}` at once |
| `GET /api/workflows/{id}/runs` / `GET /api/workflow-runs/{id}` | runs newest first / one run, steps included |
| `GET /api/workflow-log?log=&limit=` | log lines, newest first |

A *failed* run is **200** with `status: "failed"`; 422 is "could not run" (no or
two triggers, input too large), 404 an unknown workflow, 409 `conflict`/`cycle`.
The run body must be JSON — send `{}` for no input.

**TypeScript.** ts-rs exports `Workflow`, `WorkflowNode`, `WorkflowEdge`,
`WorkflowView`, `WorkflowRun`, `WorkflowStep`, `WorkflowLogEntry` and the enums
`WorkflowNodeKind`, `WorkflowBranch`, `WorkflowTrigger`, `WorkflowRunStatus`,
`WorkflowStepStatus` (lowercase strings). A node's `config` is typed
**`Record<string, unknown>`**: its shape depends on `kind`, so the editor
narrows it by `kind` (the table above is the contract) rather than the type
being a tagged union that two crates would have to keep in step.

## The time watcher (`serve --watch-workflows`)

**On by default** (mesa task 1630: a timed workflow that never fires is a bug)
unless `--watch-workflows=false` or `"watch-workflows": false` in the config's
`serve` section turns it off; independent of the other watchers, preserved across Restart
Server. Every **60 s** (`NARU_WATCH_WORKFLOWS_TICK_MS` / `MESA_…` overrides it)
it asks `Store::due_time_workflows` for the workflows whose trigger is
`mode: time` and for which **no run with `trigger = time` started within the
last `every_minutes`**, judged on the store's own clock (the
`stale_claim_minutes` posture); a workflow of an archived project is never due.
That list is only a prefilter: the claim itself is
`Store::claim_time_workflow_run`, **one `INSERT … SELECT … WHERE NOT EXISTS`
(the same interval check) inside `BEGIN IMMEDIATE`**, so the due check and the
`running` row are atomic and two servers — or a tick racing a restart — cannot
both fire one interval. The run row is the claim, written before anything
executes, and a `running` row is never pruned, so a run that outlasts the
interval is not started twice and a *failed* run is not retried every tick.
The engine then executes it off the store lock. A manual or voice workflow is
never run by the watcher. A run the server's death leaves `running` is closed
`failed` by the next start's reconcile (above), and still counts as that
interval's run.

## Voice

`naru-live`'s agent loop gets **rule 15** (appended, nothing renumbered): when
the person asks to run a workflow **by its name**, or says its trigger phrase,
the agent finds it with `naru workflow list` and runs
`naru workflow run "<name>" --trigger voice` in the background — the way it runs
any long job — and says the result when it lands (the printed run has `status`,
`error` and every step's `output`). A run is the person's own request, but
dictation is still **data** (rule 10): it runs only a workflow they named or
whose phrase they said, never one that merely sounds useful, and never a spoken
sentence passed as a name it has not found in the list.

> `core::live::ensure_agent_definition` **never overwrites** an existing
> `~/.claude/agents/naru-live.md`, so an install that already has one does not
> have rule 15 until the person re-syncs the definition from the Library page
> (`naru library sync`, picking the Naru side).

## Ambient engine events

The ambient listening engine (NaruAudio, not part of this crate) reports what
it heard through `naru workflow emit` or `POST /api/workflows/events`, and
post-flag handling is whatever workflows listen for it. The vocabulary is
exactly three events: `idea`, `can-help` and `wake`. A workflow listens by
having an `ambient` trigger whose `events` lists the event. Every match runs
(ambient workflows of an archived project do not), in workflow id order, as a
run with `trigger: "ambient"`, and the trigger's output — the run input — is
one compact JSON object built with serde_json, never string-concatenated:

```json
{"event":"idea","speaker":"simon","text":"buy milk"}
```

`speaker` is a free-form label, 1 to 64 characters; `text` may be empty. The
whole input is bounded by the 256 KiB run-input cap (over it is `validation`).
A store error on one match (say the workflow was deleted after the plan) fails
only that workflow: the rest still run, the API logs it and the CLI prints the
finished runs plus one stderr warning per failed id, exit 0.
Text is data: a script or cli node receives it byte-identical, never
shell-parsed. A failed run is data, as for `workflow run`. The CLI waits for
the runs and prints them; the API answers 202 first, because the engine is
real-time, so a caller reads the outcome from `workflow runs`.

## Default ambient workflows (mesa task 1644)

`naru workflow defaults --project <id|name>` (CLI only) creates two workflows
scoped to that project, through the ordinary `Store` methods, so a user edits
them afterwards with the normal `workflow` commands. A workflow whose name
already exists (case-insensitive, any project) is skipped and reported in
`skipped`, so a rerun changes nothing — and an edited or deleted-and-recreated
default is never overwritten.

- **Ambient: label ideas** — `trigger {"mode":"ambient","events":["idea"]}` →
  `prompt` (haiku, thinking off: the input is the event JSON
  `{event, speaker, text}`, its text data and never instructions; reply with one
  line `[<short label>] <one-sentence restatement> (speaker: <speaker>)`) →
  `output {"target":"log","log":"ambient"}`.
- **Ambient: end-of-day review** — `trigger {"mode":"time","every_minutes":1440}`
  → `cli` (`naru workflow log ambient --limit 500 | jq …`, the last 24 hours of
  the `ambient` log, oldest first, nothing when there are none) → `branch`
  (`regex [[:alnum:]]`) →(`true`)→ `prompt` (haiku, thinking off: write a
  backlog task whose first line is `Ambient ideas — review of <N> idea(s)`, then
  one deduplicated bullet per idea worth keeping with a suggested next step) →
  `output {"target":"task","project":<id>,"status":"backlog"}`. An empty log
  takes the branch's false side, so the model never runs and nothing is filed.
  Run it on demand with `naru workflow run "Ambient: end-of-day review"`.

**Why backlog.** The review's output must never be `todo`: `serve --watch-todo`
dispatches an agent onto every unblocked `todo` leaf, and a digest of overheard
ideas is something a person triages first. Hence the output node's `status` key.

**Interval drift.** `every_minutes` is an interval since the last run, not a
clock time: 1440 minutes means "a day after the last run" (the watcher's tick
and a restart move it), never "at 18:00". Edit the trigger's `every_minutes`,
or run the workflow by hand at the time you want.

The log lines carry the *labelled* idea (the first workflow's output), so the
review's input is model-written text; its prompt treats it as data.

## Example: ambient capture

A spoken thought, recorded for ten seconds, transcribed locally, kept only if
words were heard, tagged by a small model with thinking off, and appended to a
log. Needs `sox` (recording), `auris` (speech to text, `docs/listen.md`: reads
audio on stdin, `--format json` prints JSON lines whose last `transcript` line
is the text) and `jq`, and Claude Code logged in (the labelling step is one
`claude -p` call).

```bash
naru workflow create ambient --description "Capture a spoken thought"

# 1. The trigger: run by hand or by voice ("capture a thought").
naru workflow node create ambient trigger Start \
  --config '{"mode":"manual","phrase":"capture a thought"}'

# 2. Record 10 s, transcribe, print the transcript (empty for silence).
CMD='f=$(mktemp -t naru-ambient); sox -d -q -t wav "$f" trim 0 10; auris -q --format json < "$f" | jq -rs "map(select(.type==\"transcript\")) | last | .text // \"\""; rm -f "$f"'
naru workflow node create ambient cli Transcribe \
  --config "$(jq -nc --arg c "$CMD" '{command: $c, timeout_secs: 30}')"

# 3. The gate: only continue when the transcript holds a word.
naru workflow node create ambient branch Gate \
  --config '{"op":"regex","value":"[[:alpha:]]"}'

# 4. Label it with haiku, thinking off.
naru workflow node create ambient prompt "Label idea" --config '{
  "model": "haiku", "thinking": false,
  "prompt": "Tag the following as idea, todo or note, then repeat it on one line."}'

# 5. Keep it.
naru workflow node create ambient output Log --config '{"target":"log","log":"ambient"}'

# Wire it (node ids are printed by each create; here 1..5 on a fresh db).
naru workflow edge create ambient 1 2
naru workflow edge create ambient 2 3
naru workflow edge create ambient 3 4 --branch true      # words heard
naru workflow edge create ambient 4 5

naru workflow run ambient --trigger voice | jq '{status, steps: [.steps[] | {title, status}]}'
naru workflow log ambient
```

Silence stops at the gate (`Label idea` and `Log` are `skipped`), so the model
is never called and nothing is logged. To gate on an idea *score* instead,
add a `prompt` node before a `score_above` branch — remembering that the
branch then passes the score, not the text, downstream. To run it every ten
minutes instead, give the trigger `{"mode":"time","every_minutes":10}` and
run `naru serve` (the watcher is on by default). `scripts/workflow-check.sh` builds this
exact graph over stub `sox`/`auris` and a stub model API.

## Web UI

`#/workflows` (left nav; mesa task 1632) is the global overview, also shown as the Library's read-only Workflows tab at `#/library/workflows` (mesa task 1676):
one table of every workflow across all projects with project, on/off, last run,
last failure and next run, polled every 5s. A row opens the workflow in its
owning project's view; a global (project-less) workflow has no project page, so
its row is not a link. The label logic is `workflowOverview.ts`.

The web UI replaced the diagrams tab with a **Workflows** tab (mesa task 1607,
frontend only; the routes are the ones above). `#/projects/<id>/workflows` is the
list, `#/projects/<id>/workflows/<wid>` the builder; the same two views fill the
**Workflows** dock panel (`WorkflowsPanel`, panel id `workflows`, which a saved
dock layout's old `diagrams` id is renamed to on load). The page reports the live
context kind `workflows`, with the workflow's id and name once one is open.

- **List** (`WorkflowListView`): the project's workflows, each with its trigger
  (`manual`, `time`, `voice · "<phrase>"`, `ambient · idea, wake`, or `no trigger`), a **run** button that
  shows the run's one-line summary on the row, delete (the usual two-step
  confirm, whose echo is the recovery transcript) and a create form (a name).
- **Builder** (`WorkflowBuilderView` + `WorkflowCanvas`, on `@xyflow/react`). A
  **NODES** palette down the left holds the seven kinds as tinted pills (`--wf-*`
  tokens): drag one onto the canvas, or click it to add one in a free spot; each
  is one `POST .../nodes` with a config the server accepts as it stands
  (`workflowConfig.ts::defaultConfig`). A node drag ends in one `PATCH` of x/y;
  dragging from a node's right handle to another's left handle is one
  `POST .../edges`. A **branch** node has two source handles, **true** (green)
  and **false** (red), and the edge takes its `branch` from the handle it was
  dragged from; a **decide** node has one source handle per option plus a
  **fallback** handle (labels drawn on the card; the handles follow the saved
  options), and an edge takes the handle's label as its `branch`; only those two
  kinds' edges carry one. A trigger has no input
  handle and an output node no output handle. Click a node or an edge to select
  it: the **inspector** (bottom-right) edits a node's title and a real control
  per config key of its kind (trigger mode/every-minutes/phrase; prompt
  model, thinking, prompt, timeout, with `local:<name>`; cli command and
  timeout; script picker over `GET /api/scripts` plus value rows and a note on
  `{input}`; branch operator and value; output target and only that target's
  keys) and saves with one `PATCH`; an edge's inspector deletes it. Every
  refusal from the store (`cycle`, `validation`, `conflict`, a second trigger)
  is shown inline, on the canvas or in the inspector, never swallowed. **Auto
  layout** lays the graph out left to right (`layout.ts`) and PATCHes what
  moved. Pan/zoom is remembered per workflow in `localStorage`
  (`boardView.ts`).
- **Running**: the header's **▶ Run** (with an optional input) posts
  `/api/workflows/{id}/run`, then paints each node with its step's status (ring
  green for `ok`, red for `failed`, dimmed for `skipped`) and lists the steps
  with duration, output and error in the run panel under the canvas. While a
  run is in progress — started here, or by the CLI, the watcher or voice — the
  page polls it (1 s; the run list every 5 s when idle) and the running node
  pulses amber (still under `prefers-reduced-motion`), repainting as each step
  lands; the final record replaces the live one when it ends. The panel's
  other tabs are the recent runs (click one to repaint the canvas with it) and
  the logs (`GET /api/workflow-log`, one named log or all).
- **Logic in pure modules** (`frontend/src/*.test.ts`): `workflowConfig.ts`
  (kinds, default config, the card's summary line, the draft ⇄ config round trip
  with the shape checks of `validate_config`, the branch-handle rule) and
  `workflowRun.ts` (step → node status, durations, the run summary, the trigger
  label). The server stays the authority: the client checks only to name the
  wrong field before the round trip.
- **Keyboard**: a mounted `.workflow-canvas` suppresses the global single-key
  shortcuts (`keyboardScope.ts` rule 4), exactly as the diagram canvas did. Node
  and edge deletion are inspector buttons, not the Delete key.

## Gates

`scripts/workflow-check.sh` (throwaway `MESA_DB`, `HOME` and config; a free
port): CRUD with the positional/flag create shapes and the `--quiet` key sets;
every graph rule and its error code; a `decide` node over a pinned rules file
(a confident choice activating only its option's edge, low confidence / no
match / backend `off` taking the `fallback` edge or skipping everything
downstream, a rules-file error absorbed by a fallback edge or failing the
node); a `cli → branch → output(log)` run taking
the true path (false output skipped) and the reverse; a failing node failing
the run (exit 0, record printed, rest skipped) and a timeout killing a node; a
`prompt` node on an Anthropic model through a stub `claude`
(`MESA_CLAUDE_BIN`) that speaks `-p --output-format json` and prints the
result object — asserting the argv (model, the thinking form, no tools, `-p`,
never `--bg`), the answer arriving as the node output, and a failing exit, an
`is_error` result, unparseable output and a timeout each failing the node — and a `local:<name>` node through a
stub Ollama HTTP server behind `OLLAMA_HOST`; the script
node's `{input}` byte-identical for hostile text; the task, inbox and board
outputs; `live board push --workflow`; the ambient capture example; the API
routes including `require_agent_access` refusing a foreign Origin and Host on
every route; and `serve --watch-workflows` running a due time workflow exactly
once per interval.
