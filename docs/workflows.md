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
| `workflows` | `id`, `project_id` (nullable, `ON DELETE CASCADE`), `name`, `description`, `enabled` (default 1, naru task 1633), timestamps | `name` is unique **case-insensitively across all workflows** (so the CLI and the voice agent can run one by name) and never a plain number (`<id\|name>` tries the integer first) |
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
  (`validation`, naming the options); an edge leaving a `switch` node needs one
  of its case labels or `default`; an edge leaving a `gate` node needs
  `approved` or `rejected`; an edge leaving any other node
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
| `agent` | `{"agent": "<name>", "prompt": "…", "model"?, "timeout_secs"?: 1..=3600, "result_type"?, "retry"?}` | one model call acting as a library agent definition; output is text or canonical typed JSON |
| `cli` | `{"command": "…" (non-empty), "timeout_secs": 1..=86400 (default 600), "always"?: bool}` | `bash -c <command>` **verbatim** (the author wrote it, as with scripts); output is stdout. `"always": true` (naru task 2033) makes it a closing node: it ignores its edges, runs after every other node whatever happened (a failed run included) and gets the run input plus a `run_status=succeeded` / `run_status=failed error=<message>` line; its own failure never replaces the run's earlier error |
| `script` | `{"script": "<id or name>", "values": {"name": "…"}, "timeout_secs": 1..=86400 (default 600)}` | runs a stored script (`docs/scripts.md`); output is stdout |
| `branch` | `{"op": "contains"\|"regex"\|"score_above"\|"score_below"\|"equals", "value": "…" (a number for `score_*`)}` | evaluates its input to a verdict; output is its input, unchanged |
| `decide` | `{"question": "…" (non-empty, may contain `{input}`), "options": ["a", "b", …] (2 or more, distinct, non-empty, none named `fallback`), "threshold": 0..=1 (default 0.5)}` | a local judgement (`core::decide`, `docs/decide.md`) that picks one option; routes like a `branch`, one edge per option plus an optional `fallback` edge |
| `switch` | `{"op": "equals"\|"contains"\|"regex" (default `equals`), "cases": [{"match": "…", "label": "…" (default: the match)}, …] (2 or more, non-empty matches, distinct labels, none named `default`)}` | a many-way branch on its input; routes to the first matching case's edge, else the `default` edge |
| `gate` | `{"message": "…" (optional), "timeout_secs": 1..=86400 (default 3600), "on_timeout": "reject" (the only value)}` | pauses the run until a person approves or rejects it; routes to the `approved` or `rejected` edge |
| `subworkflow` | `{"workflow": "<id or name>"}` | runs that workflow with this node's input as its trigger input (naru task 1994); output is the output of the child's last successful step. A failed child fails the node |
| `task` | `{"action": "create"\|"update"\|"read", "project": "<id or name>" (create), "task": N (update, read), "description", "status", "priority", "result"}` | creates, updates or reads one Naru task (naru task 1996). Create needs `project`; update and read need `task`; an update needs one of `description`/`status`/`priority`/`result`; a field the action does not take is `validation`. Any value may hold `{input}`, replaced by the node's input (so an upstream node can pick the task id); a create with no `description` uses the input. Output is the task as JSON; a missing task, unknown project or bad status fails the node. Updates go through the receipt chokepoint like `task update`. |
| `http` | `{"method": "GET"\|"POST"\|"PUT"\|"PATCH"\|"DELETE" (default GET), "url": "http://…", "headers": {"Name": "value"}, "body": "…" (POST, PUT, PATCH), "timeout_secs": 1..=600 (default 30)}` | one HTTP request (naru task 1997); `{input}` is replaced in `url` (percent-encoded, unless the url starts with `{input}`, which is then the whole url), header values and `body`. Output is JSON `{status, ok, body, json}` (`json` the body parsed, else `null`; the body is capped at 32 KiB and `truncated: true` is added when cut). A non-2xx status is data (`ok: false`); a refused connection or a timeout fails the node. Pins `any` in, `any` out. |
| `board` | `{"kind": "markdown"\|"html" (default markdown), "title": "…", "body": "…"}` | pushes a board to the live whiteboard (naru task 2001), the way `naru live board push` does. `body` has `{input}` replaced and defaults to the input; ≤ 2 MiB, `title` ≤ 200 characters. No live conversation fails the node (`naru live start` first). The input passes through unchanged. Pins `any` in, `any` out. |
| `notify` | `{"mode": "phone"\|"speak" (default phone), "message": "…", "title": "…", "open": "<route>"}` | tells a person (naru task 1998). `phone` sends through `vox` exactly as `naru notify` does (`title`, and an Open Naru button to `open`); `speak` appends a `naru` turn to the live conversation so the page speaks it (`unavailable` and a failed node when none is live). `message` has `{input}` replaced and defaults to the input; ≤ 4096 bytes. The input passes through unchanged; a failed send fails the node. Pins `any` in, `any` out. |
| `trycatch` | `{"wrap":{"kind":"cli\|script\|prompt\|agent","config":{...}},"timeout_secs":N}` | runs the wrapped node once (naru task 1995). Success routes `ok` with the wrapped output; a failure is caught: the node and the run still succeed, the output is the error text, and the `caught` edges run. Edges need `--branch ok\|caught`; an unwired branch skips everything behind it |
| `retry` | `{"wrap": {"kind": "cli"\|"script"\|"prompt"\|"agent", "config": {…the wrapped kind's config…}}, "attempts": 1..=10 (default 3), "backoff_ms": 0..=60000 (default 0), "backoff_factor": 1..=10 (default 1), "timeout_secs": 1..=3600}` | runs the wrapped node, retrying on failure (naru task 1991); output is the wrapped node's |
| `output` | `{"target": "log", "log": "<name>" (default `default`)}`, `{"target": "task", "project": "<id\|name>", "status": "backlog"\|"todo" (default todo)}`, `{"target": "inbox", "task_id": N, "kind": "task-summary"\|"change-request" (default task-summary)}`, `{"target": "board", "title": "…"}` | delivers its input; output is a short receipt. A key that does not apply to the target is refused |

**`agent`** (naru task 1982). A `prompt`-style call that acts as a **defined agent**:
config `{"agent": "<library agent name>", "prompt": "…" (`{input}` is replaced by the
node's input, else the input follows after a blank line), "model"?: haiku|sonnet|opus
(default: the definition's own `model:` when it is one of those, else sonnet),
"timeout_secs"?: 1..=3600 (default 600), "result_type"?: a type of the workflow's
Types card (absent or `text` = plain text), "retry"?: bool (default true)}`. At run
time the agent is looked up in the library (the effective rows: a fork or built-in,
project scope first-class) — an unknown name fails the node (`unknown agent …`). The
definition's body (frontmatter stripped) and the task go as **one tool-less
`workflow-prompt` call** (no new config template, no `--agent`, no tools: the agent
contributes its instructions, not its tools). With a `result_type` the prompt asks for one JSON
value of that type and the reply (a ``` fence tolerated) is validated by
`wftypes::render`; an invalid reply is retried once with the reason (unless `retry` is
false), then the node fails with `the agent's reply is not a valid <type>: <reason>`
and downstream is skipped. The output is the trimmed text, or the canonical JSON.
Its pins are fixed and written by the server on every save (`pins` in the config is
refused): `input` in; `result` (typed) and `status` (`ok`) out.

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

**`switch`** (naru task 1990). A many-way `branch`: the input (trimmed) is
tested against each case's `match` in order with the node's `op` (the `branch`
node's `equals`, `contains` and `regex`; a regex is POSIX ERE and is checked at
create/update), and the **first** matching case wins. Its edges carry the case
`label` (the `match` when no label is given); an edge with no `branch` or one
that is neither a case label nor `default` is `validation`, and changing the
config is refused while an edge leaves on a label the new cases lack (the
decide rule). The `default` edge takes the run when no case matches; with no
`default` edge a non-match skips everything downstream and the run still
succeeds. The output is `{"value": "<input>", "matched": bool, "label":
"<case label>"|null}`; like `decide`, the input is not passed on. The editor
draws one source handle per case label plus `default` last, in the switch group
colour (`--wf-switch`, derived from `good` and `warn`, `docs/themes.md`), with
an operator select and an editable cases list (at least two).

**`output`.** `log` appends a line to the named log (`workflow log <name>`);
`task` creates a task (the input is its description) in the named project;
`inbox` files an item of the given kind naming `task_id` (an inbox item always
names the task it came from); `board` pushes a markdown board onto the
**current live session** (none is a node failure naming `naru live start`).
An **empty input** (blank text) is **not a failure**: the node succeeds with
output `nothing to deliver` and writes no record, so a silent run — an empty
transcript, a filter that let nothing through — files nothing and still
succeeds.

**`parse-json`** (naru task 1985) turns text into a typed value. Config:
`type` (optional; `any` by default, else `string`, `number`, `bool`,
`list<T>` or a struct of the workflow's Types card; a malformed name is
`validation`). Pins: `text: string` → `value: <type>`, fixed by the kind
and written into `config.pins` by the validator (a supplied `pins` is
ignored). The editor draws it in the amber data group colour (`--amber`; the
board export uses `#ffb444`). The input is parsed as JSON and checked against
`type` by `wftypes::render`; the output is the compact JSON (a bare string is
output raw). Invalid JSON fails the node with `invalid JSON: …`, JSON of the
wrong shape with e.g. `expected number, got "x"`; the run is recorded as
`failed` with that reason on the step. The editor offers an output-type select.

**`variable`** (naru task 1986) gets or sets a named, typed value shared by
the nodes of **one run** (a map local to the run: never persisted, never
shared across runs). Config: `op` (`set` or `get`, required), `name`
(required; letters, digits, `_` and `-`, starting with a letter or `_`, up to
64) and `type` (optional, as for `parse-json`; `any` by default). Pins, fixed
by the kind and written into `config.pins` by the validator (a supplied
`pins` is ignored): `set` is `value: <type>` → `value: <type>`; `get` is
`trigger: any` → `value: <type>`. `set` parses its input as JSON, checks it
against `type` exactly as `parse-json` does, stores the compact value under
`name` and passes it on as its output; `get` outputs the stored value. A `set`
of invalid JSON or the wrong shape fails the node with the `parse-json`
reasons; a `get` before any `set` fails it with `variable "x" is not set`.
Order is the graph's: a `get` has no data link to its `set`, so wire an edge
from the `set` (directly or through other nodes) to the `get`; nodes with no
ordering edge run in topological order, ties by node id. A `get` with no
active incoming edge is skipped like any orphan. Drawn in the amber data
group colour (`--amber`; board export `#ffb444`); the editor offers an
operation select, a name field and a type select.

**`mapfilter`** (naru task 1987) maps or filters a list, in-process (no
shell, process or model). Config: `mode` (`map` or `filter`, required) and
`expr` (required). Pins, fixed by the kind and written into `config.pins` by
the validator: `list: any` → `list: any`. The input is a JSON array, or plain
text taken as its non-empty lines; any other JSON (an object, a number) fails
the node with `mapfilter input must be a list`. `map` replaces `{item}` in the
`expr` template with each item (one pass, so item text is never re-read); the
output is a JSON array of strings. `filter` keeps the items matching one
predicate: `contains:X`, `not-contains:X`, `eq:X`, `regex:RE` (Rust regex) or
`nonempty`; the output is the kept items, unchanged. An unknown predicate or
a bad regex is `validation` at create/update. Drawn in the amber data group
colour (`--amber`; board export `#ffb444`); the editor offers a mode select
and an expression field.

**`foreach`** (naru task 1988) runs a script once per item of a list. Config:
`body` (a bash script, required) and `timeout_secs` (1..=3600 per item,
default as for `cli`). Pins, fixed by the kind: `list: any` → `results:
list<string>`. The input is a JSON array, or plain text taken as its non-empty
lines; any other JSON fails the node with `foreach input must be a list`. The
body runs under `bash -c` once per item, in order, in the run's cwd; the item
arrives as `$1`, `$NARU_INPUT` and on stdin and is **never spliced into the
script text** (so a hostile item stays literal; `{input}` is not substituted).
The output is a JSON array of each run's trimmed stdout. A nonzero exit or a
timeout on any item fails the node with `item <index> exited <code>: …`. The
body is one inline step, not a downstream subgraph. Drawn in the amber data
group colour (`--amber`; board export `#ffb444`); the editor offers a body
textarea and a per-item timeout field.

**`parallel` and `join`** (naru task 1989) are the flow pair: a fan-out
marker and a gather. Neither takes config (any key is `validation`). `parallel`
passes its input through to every outgoing edge. `join` runs **only when every
incoming edge is active**; its output is a JSON array of the incoming outputs
in edge-id order (pins: `in: any` → `out: list<string>`). If any incoming
branch was skipped (a branch's other verdict, a skipped upstream) the join is
`skipped` and the run still succeeds; a failed upstream node fails the run as
usual. **The engine is sequential**: branches run one after another in
topological order, so `parallel` is a visual and structural fan-out, not
concurrency. Drawn in the flow group colour (`--wf-flow`; board export
`#fb923c`); neither node has a config form.

**`retry`** (naru task 1991) wraps one `cli`, `script`, `prompt` or `agent`
node held in its own `wrap` config (control kinds, including `retry`, are
`validation`; the wrapped config is validated as its own kind). The wrapped node
runs up to `attempts` times; between tries the engine waits
`backoff_ms * backoff_factor^n` (n = failures so far, capped at 10 minutes).
`timeout_secs`, when set, replaces the wrapped node's own timeout and bounds
**each attempt**. The first success is the node's output (pins: `input: any` →
`output: any`); if every attempt fails the node fails with
`failed after N attempt(s): <last error>`. Flow group colour (`--wf-flow`; board
export `#fb923c`). The editor takes the wrapped config as JSON.

**`delay`** (naru task 1992) waits, then passes its input through unchanged
(pins: `in: any` → `out: any`). Config is exactly one of `{"seconds": 0..=3600}`
or `{"until": "HH:MM" | "YYYY-MM-DDTHH:MM:SSZ"}` (both UTC; `HH:MM` is the next
such time of day). An `until` more than 3600 s ahead fails the node at run time
(an instant already past waits 0); anything else is `validation` at create. The
wait runs with no store lock held. There is no cancel flag in the engine yet, so
a run cannot be stopped mid-wait. Flow group colour (`--wf-flow`; board export
`#fb923c`); the editor offers a Duration / Until choice.

**`gate`** (naru task 1993) is a human approval. When it starts, the engine
writes a `pending` row in `workflow_gates` (CASCADE from the run), sends a
best-effort phone notification (`core::notify`, an "Open Naru" button to
`/open/workflows/<id>`; a missing `vox` is only logged), and polls the row once
a second **with no store lock held** until a person decides or `timeout_secs`
pass. The input passes through unchanged; the node's route is `approved` or
`rejected`, so its edges carry `--branch approved|rejected` (a `decide`-style
string branch: a missing or other label is `validation`). A rejection is data,
not a failure: the run goes on down the `rejected` edge and still ends
`succeeded`. A timeout **is** a rejection: the gate row records
`status: rejected, reason: "timed out"` (the step's output is the unchanged
input; read the reason from the gate row or `gate list --all`). Decide with
`naru workflow gate approve|reject <id>` (`--quiet` drops `message`), `naru
workflow gate list [--run N] [--all]` (pending gates of running runs, newest
first), or over the API: `GET /api/workflow-gates[?run=N&all=true]` and
`POST /api/workflow-gates/{id}/decide {"decision": "approved"|"rejected"}`,
both on `require_agent_access`, reads included; a gate already decided is
`conflict` (409), settled by a conditional `UPDATE ... WHERE status='pending'`.
The run stays `running` while it waits. A `serve` restart fails the orphaned
run (`reconcile`) and its pending gate stops being listed; there is no resume.
The editor draws the card in the flow colour (`--amber`; board export
`#fb923c`) with `in`, and two flow handles `approved` / `rejected`; on a shown
run a waiting gate's card carries an amber "waiting" badge, its message and
**Approve** / **Reject** buttons (44px tall at the phone tier), and a decided
one reads "approved" or "rejected — timed out".

**`trycatch`** (naru task 1995) handles a failure path without failing the run.
It wraps one `cli`, `script`, `prompt` or `agent` node (the same `wrap` shape
as `retry`, plus an optional `timeout_secs`, 1-3600) and runs it once. Its
edges carry `ok` or `caught` in `branch`: a passing wrap activates the `ok`
edges, a failing one activates the `caught` edges while the node itself is
`ok` and the run keeps its `succeeded` status. If the branch taken has no edge,
everything behind it is skipped, as for `branch` and `gate`. In the editor it
is drawn in the flow group colour with `ok` (green) and `caught` (amber)
handles.

**`subworkflow`** (naru task 1994) runs another workflow as a node. The child
is found by id or case-insensitive name; the node's input becomes the child's
`manual` run input, and the node's output is the last successful step of the
child's run. A child run that fails fails the node (the error names the child),
and the child's run is recorded as its own run. The store lock is not held
while the child runs. The node has one `in` and one `out` pin (both `any`) and
plain edges. **Recursion rules:** a workflow may not call itself, directly or
through other workflows, and a chain may be at most 8 workflows deep
(`SUBWORKFLOW_MAX_DEPTH`). `Store` refuses both, plus an unknown child, as
`validation` when the node is created or updated; the run checks again (a child
may have been edited since), failing the node with the same message. Flow group
colour (`--amber`; board export `#fb923c`); the editor offers a picker of the
other workflows. There is no per-node timeout: the child's own nodes carry theirs.

**`task`** (naru task 1996) is the one node that writes to the task store directly: `create`, `update` or `read` one task, with `{input}` allowed in every value. Its output is the task JSON, so a later `branch`, `parse-json` or `task read` can use it. Pins are `any` in, `any` out; the editor tints it with `--wf-task` (`docs/themes.md`). Point it at a scratch project when testing: a created `todo` task is dispatchable by the todo-watcher.

**`notify`** (naru task 1998) is the workflow's way to reach a person: `phone` mode shells out to `vox` like `naru notify`, so a machine without it fails the node with `unavailable` and a pointer to `vox init`. `speak` mode writes a `naru` live turn through `Store` (the page reads it aloud; the server has no speaker of its own), so it needs a live conversation. The editor tints it with `--wf-http` (the action group, `docs/themes.md`).

**`board`** (naru task 2001) calls `Store::add_live_board` on the live session (`current_live_session`), so it shows on the whiteboard panel like any pushed board; only `markdown` and `html` are offered (a `diagram` or `image` push stays with `naru live board push`). The editor tints it with `--wf-http` (the action group, `docs/themes.md`).

**`git`** (naru task 1999) runs `git` in a folder through argv, no shell: `commit` (`git add -A`, or only the config's `paths`, then `git commit -m <message>`), `branch` (`git switch -c <name>`, or `git switch` when the branch exists) and `diff` (`git diff [base]`, `--stat` with `stat: true`, capped at 64 KiB). The folder is `cwd`, else the project's `local_path`. `{input}` may appear in `message`, `name` and `base`; a name or base that starts with `-` or holds whitespace is `validation` (config) or a node failure (after substitution), and commit signing is switched off for the call. The identity is the user's own git config. The node outputs the JSON `{result, ok, status}` and the edges leave by the `result` (text: sha, branch name or diff), `ok` (bool) and `status` pins, `result` when none is named. A commit with nothing to commit is data (`ok` false, `status` `nothing to commit`); any other git failure fails the node. Pins are fixed, so a `pins` key is `validation`. The editor tints it with `--wf-http` (the action group, `docs/themes.md`).

**`file`** (naru task 2000) reads or writes one text file, no platform-specific code. Config: `op` (`read`|`write`), `path` (required; a relative path resolves against the run's folder, the project's `local_path`), and for `write` only `content` (may hold `{input}`; absent = write the incoming input) and `append` (default false = truncate). A write creates missing parent folders; a read is capped at 64 KiB with `[truncated]` marked. A missing or unreadable file fails the node; `content`/`append` on a read, an unknown `op`, a blank `path` or a `pins` key are `validation`. The node outputs the JSON `{result, path}` (the text read or written, and the resolved path); edges leave by the `result` or `path` pin, `result` when none is named. It can touch any path the server user can, the same power as a `script` node, and every workflow route is behind `require_agent_access`. The editor tints it with `--wf-http` (the action group, `docs/themes.md`).

**`memory`** (naru task 2002) adds to or searches a project's notebook (`naru memory`, `docs/project-memory.md`), no platform-specific code. Config: `op` (`add`|`search`), `text` (add only; may hold `{input}`; absent = add the incoming input), `query` (search only; same rule), `limit` (search only, 1..=50, default 10) and `project` (id or name, `{input}` allowed; absent = the workflow's own project, and a global workflow with none fails the node). `add` goes through the guarded `Store::add_notebook_entry_in`, so the entry bound applies; `search` is the notebook's full-text search and outputs one JSON line `{id, snippet}` per hit. Empty text or query, an unknown project, an unknown `op`, a key belonging to the other op or a `pins` key are `validation`/node failures. The node outputs the JSON `{result, id}` (the entry added / the hit lines, and the new entry id or empty); edges leave by the `result` or `id` pin, `result` when none is named. The editor tints it with `--wf-http` (the action group).

**`schedule`** (naru task 2004) is a trigger *source*: the workflow's entry node, started by the watcher on a timetable, with nothing flowing into it. Config: exactly one of `every_minutes` (1..=10080, the same interval rule as a `time` trigger) or `cron` (a 5-field `minute hour day-of-month month day-of-week` expression, **UTC**, no platform-specific code: `*`, `n`, `a-b`, `*/s`, `a-b/s` and comma lists; day-of-week 0-6 with 7 also Sunday; when both day fields are restricted a day matches on either, as in Vixie cron). Neither, both, a bad field, a 4- or 6-field expression or an unknown key are `validation`; the stored cron has its whitespace normalised. A workflow has **one** entry node, so a `schedule` and a `trigger` cannot share a workflow (and the `trigger` mode `time` stays as it was; `schedule` is the way to get a cron). The watcher treats it as another due source: an `every_minutes` schedule is due when no run with `trigger = time` started within the interval; a `cron` schedule when the current UTC minute (the store's clock) matches and no `time` run has started in that minute yet. The claim is still the run row (`Store::claim_time_workflow_run`). A manual run works too and its input is the node's output. Pins: no input; output `event`. The editor tints it `--wf-schedule` (the trigger group's red family) with a calendar icon; `next_run_at` in the list is only filled for a `trigger` of mode `time`.

**`webhook`** (naru task 2005) is a trigger *source*: the workflow's entry node, started by an HTTP call, with nothing flowing into it. Config: optional `type` (a pin type name, default `any`; unknown keys are `validation`). `POST /api/workflows/{id}/webhook` with a JSON body (`Content-Type: application/json`, the same gate as every mutating route; `require_agent_access`, reads and writes alike, so no extra secret) claims a run with trigger `webhook`, and the raw body becomes the node's typed output pin `body` through the `parse-json` rule: a body that is not JSON or does not fit `type` fails the webhook node and so the run. The route is synchronous like `/run` and answers the finished run record (a failed run is still 200 with `status: "failed"`); 404 is an unknown workflow and 422 a workflow with no webhook node, an over-limit body, or one without exactly one entry node. A workflow has **one** entry node, so a `webhook` cannot share a workflow with a `trigger` or `schedule`; nothing may connect into it. Platform-neutral (no platform-specific code). The editor tints it with the trigger group's `--red`, a plug-arrow icon, and the inspector shows the body type, the endpoint and a copyable `curl` line. Pins: no input; output `body` (typed from `type`).

**`task-event`** (naru task 2006) is a trigger *source* fired by a task write. Config: `event` (`created` default, `status` or `any`), optional `status` (a task status; only with `status`/`any`, else `validation`) and optional `project` (an id or a case-insensitive name; blank = every project); unknown keys are `validation`. It is an entry node like `schedule`/`webhook` (one per workflow, nothing flows in). A task **creation**, or a **change of status** (a write that leaves the status alone fires nothing), starts one run per matching enabled workflow, id order, with trigger `task-event`, in a detached `naru __job workflow-run` (the task write never waits for it). The firing sits in `core::receipt::{create_task, update_task}`, the one chokepoint both the CLI and the API already use; `Store` stays low-level, and a workflow `task` node writes through `Store`, so it never fires one. Firing is best-effort: a failure to start is a stderr warning, never a failed task write. **Recursion guard:** the detached job exports `NARU_TASK_EVENT_RUN=1`, so a `cli`/`script` node that shells out to `naru task ...` fires nothing. The run input and the node's output pin `task` (a string) is compact JSON `{"event","task_id","project_id","status","old_status","name"}` (`old_status` is `null` for a creation; `name` is the task's derived name, passed byte-identical). Platform-neutral (no platform-specific code). The editor tints it with the trigger group's `--red`, a check-box-and-bolt icon, an event radiogroup, a status select (hidden for `created`) and a project field. Pins: no input; output `task`.

**`file-watch`** (naru task 2007) is a trigger *source* fired when a path changes. Config: `path` (required, a file or folder, 1 to 4096 characters, no globs) and `event` (`any` default, `created`, `modified` or `deleted`); unknown keys and bad values are `validation`. It declares one `event` output pin (`string`, the change as JSON text) and, like the other sources, is an entry node: a workflow has at most one and nothing may connect into it. Detection is polling, with no platform-specific code: each `serve --watch-workflows` tick (`WATCH_WORKFLOWS_TICK_MS`, default 60 s) compares the path's mtime and size with the state it last saw, kept in memory only. The first sight of a path only records it, so a start-up or restart never fires; a later change starts one run (trigger `file-watch`) whose input is JSON `{"path","event","mtime","size"}` (`mtime` in epoch seconds; both are null for a deletion). A change that happens and reverts between two ticks (a create-and-delete) is missed. Editor: header in the trigger group colour (`--red`), a Path field and an Event select.

**`verify`** (naru task 2003) runs a check and reports pass/fail with evidence, no platform-specific code and no model call. Config: `mode` (`test` default | `browser`), `command` (required; run under `bash -c` in the run's folder like a `cli` node), `url` (browser mode only; may hold `{input}`; reaches the command as `$NARU_VERIFY_URL`, never spliced into its text, so a browser-mode command is typically a `khora` script), `expect` (text that must appear in the combined stdout+stderr) and `timeout_secs` (1..=3600, default 300). **Pass** = exit 0 and, when `expect` is set, that text found. A failing check is **data**: the node succeeds with `pass` false; only a spawn failure or the timeout fails the node. An unknown `mode`, an empty `command`, `url` in test mode, a bad timeout, an unknown key or a `pins` key are `validation`. The node outputs the JSON `{pass, evidence, exit_code}` (evidence is stdout then stderr, trimmed and capped at 64 KiB); its pins are `input`; `pass` (bool), `evidence` (string), `exit_code` (number), and edges leave by the pin they name. The editor tints it with `--wf-http` (the action group).

**`comment`** (naru task 2008) is an editor-only group box: a titled, translucent, coloured rectangle drawn behind the other nodes on the canvas to group and label them. It has **no runtime effect**: it has no pins, `Store` refuses any edge into or out of it (`validation`), and `execute_run` drops it from the run order, so a run never gives it a step (no `skipped` row either). Config: `text` (optional, shown under the title) and `color` (a theme token: `accent` default, `accent2`, `good`, `warn`, `bad` or `muted`; anything else, an unknown key or `pins` is `validation`). `naru workflow node create <wf> comment "Title" --config '{"text":"…","color":"warn"}'`. The editor draws it 320×200 with no handles, tinted by the colour's theme variable (`color-mix` at low alpha, so it follows every theme), with a swatch row in its panel; the palette chip uses `--wf-comment`. No platform-specific code.

**`http`** (naru task 1997) makes one request and hands the response on as JSON, so a later `parse-json`, `branch` or `output` can use `status`, `ok` or `json`. Only `http://` URLs are accepted: `ureq` is built without TLS here, so an `https://` URL is `validation` (reach a TLS service through a `cli` node running `curl`). The node can reach `localhost` and the LAN, which a `cli` node can already do. The editor tints it with `--wf-http` (`docs/themes.md`).

## Enabled and duplicate (naru task 1633)

`Workflow.enabled` is a stored switch (migration column `workflows.enabled`,
default on). **Off means it never fires by itself**: `due_time_workflows`
(the time watcher) and `ambient_workflows` (`workflow emit`,
`POST /api/workflows/events`) skip it. A manual run (`workflow run`, the Run
button, the run route) always works. Set with `workflow update --enabled
true|false` or `PATCH {"enabled": bool}`; the overview's "On" column and the
project list/builder show and toggle it.

`Store::duplicate_workflow` copies the workflow's project and description, every
node (kind, title, config, position) and every edge (remapped onto the new node
ids, branch labels kept) in one `BEGIN IMMEDIATE` transaction. The copy is
created **disabled**, so a duplicated time or ambient workflow never
double-fires until switched on. Run history and log lines are not copied. The
default name is `<name> (copy)`, then `(copy 2)`…, satisfying the
case-insensitive unique-name rule; an explicit taken `--name` is `conflict`.

## Export and import (naru task 2102)

A workflow moves between Naru instances (machines may run different
versions) as one JSON file: `naru workflow export <id|name> [--out FILE]`, the
workflow page's **export** button or `GET /api/workflows/{id}/export` writes
it; `naru workflow import FILE [--project P]`, the **import…** button on the
global and project Workflows pages or `POST /api/workflows/import` reads it.

```json
{"format": "naru-workflow", "version": 1, "exported_at": "…", "naru_version": "…",
 "workflow": {"name": "…", "description": "…", "types": [ … ]},
 "nodes": [{"ref": 12, "kind": "cli", "title": "…", "config": { … }, "x": 0, "y": 0}],
 "edges": [{"from": 12, "to": 13, "branch": null, "from_pin": null, "to_pin": null}]}
```

Nodes are keyed by a local `ref` (the exported node id) so edges stay valid
whatever ids the target assigns. No runs, logs or gate decisions travel.

Import (`Store::import_workflow`, one `BEGIN IMMEDIATE` transaction, an
`import` revision) rules:

- **Always disabled**, global unless `--project`/`project_id` is given.
- **Never overwrites**: a taken name (case-insensitively) becomes
  `<name> (imported)`, `(imported 2)`…; `renamed_from` carries the file's name.
- **Tolerant**: unknown fields are ignored; a `version` newer than this
  Naru's (1) imports with a `warnings` entry. Not JSON, a wrong `format`, a
  missing `version`, an unknown node kind, a dangling or self edge or a cycle
  is `validation`/`cycle` and writes nothing. Node configs are stored as
  exported (as `duplicate` does), not re-validated.
- **Missing references are reported, never dropped or remapped**: `missing`
  lists `{node_id, node_title, kind, what, reference}` for an `agent` node's
  agent (library), a `script` node's script (id or name), a `subworkflow`
  node's workflow and any node config's `project`, when this instance has
  none. The web UI shows them in a panel under the create row until dismissed.

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
   `{node_id, title, kind, status: ok|skipped|failed, output, error, duration_ms, started_at}`,
   output capped at 64 KiB. `started_at` (naru task 1957) is unix seconds when
   the node began running: stamped on the persisted `running` step, kept when
   it finishes, `null` for a skipped step and for rows written before the
   field existed — so a reader derives a running step's elapsed time as now
   minus `started_at`. The run row is written `running` first (the
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

**Detached runs** (naru task 1958). `naru workflow run <wf> --detach` (or
`POST /api/workflows/{id}/run` with `{"detach": true}`) writes the `running`
row, starts a hidden detached `naru __job workflow-run --run <id>`
(`core::memory_job`: own process group, stdio off, output to
`logs/workflow-run.log`) and answers at once — the CLI prints
`{"run_id","status":"running"}`, the route is 202 with the same body. The job
becomes the row's `owner_pid`, so the run outlives the CLI or server that
started it; read it with `workflow run-show <id>`. If the job dies, the row
stays `running` until the next `serve` start reconciles it to `failed` as
above. A job that cannot start fails the row and answers `unavailable`.
Without `--detach` nothing changes.

## Version history (naru task 2053)

Every workflow keeps its history, like a library item: each saved version is a
row in `workflow_revisions` (`workflow_id`, `rev` counting up per workflow,
`author`, `reason`, the whole definition as JSON, `created_at`; `ON DELETE
CASCADE`). A snapshot holds the name, description, `enabled`, `types`, every node
(id, kind, title, config, position) and every edge. **All writes stay in
`Store`:** every graph mutation (`touch_workflow`) and every workflow update
records a revision automatically.

- **Author and reason.** The author is the surface that wrote it: `cli` by
  default, `web` for the server (`Store::set_actor`). The reason is `edit` for
  an ordinary change, `seed` for a reseed, `restore of N`, `copy of <name>`,
  `baseline` (a workflow that predates history gets a revision 1 on the first
  open) or `collapsed from <name>`.
- **No noise.** A graph equal to the newest revision (name and `enabled` do not
  count) adds nothing; edits by one author within 30 seconds of that author's
  own `edit` revision fold into it, so a save that is many node and edge calls
  is one revision.
- **Restore** (`Store::restore_workflow_revision`) writes a revision's graph
  back onto the **same workflow** — id, name, project, `enabled` and runs kept —
  nodes keep their ids (a node deleted since comes back under its old id), and
  the result is recorded as a new `restore of N` revision. Nothing is ever
  deleted from the history; restoring what is already current is `validation`.
- **Reseed is a revision.** `naru workflow defaults --task-loop` builds the
  shipped definition under a scratch name; when it differs from the existing
  workflow, the existing one's graph is replaced **in place** (nodes matched by
  kind and title, so ids survive) as a `seed` revision, and the scratch copy is
  deleted. An unchanged definition writes nothing. `scripts/self-deploy.sh` no
  longer renames anything.
- **Collapse.** `naru workflow history collapse [--dry-run] [--backup PATH]`
  folds the old `Task loop`, `Task loop: implement and review` and their
  `(pre-… backup|rollback)`, `(copy[ N])` and `(old)` copies of the same project
  into revisions of the current one: it backs the db up first (refusing to go
  on if that fails; no backup when there is nothing to fold), stores each copy's
  graph as a `collapsed from <name>` revision, reads it back, moves the copy's
  runs to the current workflow and only then deletes the copy, and ends with a
  `current after collapse` revision so the newest revision is the live graph. A
  copy with no current workflow to fold into is left and reported. Idempotent.
- **CLI**: `workflow revisions <wf>` (a bare array, without the snapshot),
  `workflow revision show <wf> <rev>` (`--quiet` drops the snapshot),
  `workflow revision diff <wf> <from> <to>` (`{changed, lines}`, `- `/`+ `/`  `
  text lines, nodes and edges matched by kind and title, never id) and
  `workflow revision restore <wf> <rev>` (prints what `show` does).
- **API** (`require_agent_access`): `GET /api/workflows/{id}/revisions` (every
  revision with its snapshot, newest first — the page diffs any two itself) and
  `POST /api/workflows/{id}/revisions/{rev}/restore` (the restored
  `{workflow, nodes, edges}`).
- **Web**: a **History** button in the builder header swaps the graph for a
  revision list (`#rev`, reason, author, age, `+a −r` against the previous
  one) beside a diff (against the previous revision or any chosen in "compare
  with…") or the full snapshot as text, and a confirmed **restore**. The pure
  parts — `snapshotLines`, `diffRevisions`, `revisionEntries` — are
  `frontend/src/workflowHistory.ts`; `core::workflow::snapshot_lines` builds the
  same lines for the CLI, so keep the two in step.

## Typed pins (naru task 1981)

Pins carry types. A **type** is a string: `string`, `number`, `bool`, `any`,
`list<T>`, or the name of a **struct** the workflow defines. A workflow's
structs live in `workflows.types` (JSON, migration index 92) and travel with
it (`Workflow.types`, copied by `duplicate`); a struct is a name plus named,
typed fields. Names are unique case-insensitively, may not be `string`,
`number`, `bool`, `any` or `list`, and a struct cannot contain itself
(`validation`).

- **Declaring pins.** Any node but `break`/`make` may carry
  `config.pins = {"in":[{"name","ty"}], "out":[…]}`. No `pins` = untyped =
  `any`, so every workflow written before types keeps its behaviour. A pin
  type must be a primitive or a defined struct (`validation`).
- **Wires name pins.** An edge has optional `from_pin` / `to_pin` (NULL = the
  node's first pin of that side, or `any`). `Store` refuses a wire whose two
  types differ with `validation` naming both ("can't connect number to
  Review"); `any` matches everything; a pin the node does not have is
  `validation`.
- **`break` and `make`** (`config: {"struct": "Review"}`) are two node kinds.
  A `break` has one input pin `value` (the struct) and one output pin per
  field; a `make` the reverse. At run time a struct is **one JSON object** in
  the node's output text. `break` validates it against the struct and passes
  it on in canonical form (fields in declared order); an edge leaving a
  `break`'s field pin carries that field (a string raw, anything else compact
  JSON). `make` builds the object from its field-pin inputs, in declared
  order, so a Break→Make round trip is byte-identical. A malformed shape fails
  the node.
- **Removing or reshaping a type** that a pin, a break/make or a wire still
  uses is `conflict` (it names the first stranded edge or node); a node
  config change that would break its wires is `validation`.
- **CLI:** `naru workflow type add <WF> <NAME> --field score:number …`
  (replaces a same-named type), `naru workflow type remove <WF> <NAME>`,
  `naru workflow edge create … --from-pin P --to-pin Q`. **API:** `PATCH
  /api/workflows/{id}` takes `types` (the whole list); the edge-create body
  takes `from_pin` / `to_pin`. Same gates as the rest of the workflow routes.
- **Editor:** a node's inspector edits its pins (name + type picker); the
  canvas "types" button opens the *Type: Review* card (`+ type`, `+ field`;
  a type in use cannot be deleted). Typed pins are real handles, coloured by
  type through theme variables (`workflowTypes.ts::pinColorVar`; a list is a
  ring), with a type chip. Dragging a wire dims the pins it cannot land on; a
  mismatched drop is refused with the reason in the controls slot for four
  seconds. Right-click (or long-press, or Shift+F10 on a focused pin) a struct
  output → **Break into fields**, a struct input → **Make from fields**; both
  create the node beside it and wire it. The pure rules are in
  `frontend/src/workflowTypes.ts`, the server's in `core::wftypes`.

## CLI (`naru workflow`)

JSON only, positional-or-flag create shapes, `<id|name>` everywhere a workflow
is named.

| Command | Prints |
| --- | --- |
| `workflow create <NAME> [--project] [--description]` | the `Workflow` |
| `workflow list [PROJECT]` | a bare array of `Workflow` rows (each with `trigger`, `trigger_phrase`) |
| `workflow show\|get <id\|name>` | `{workflow, nodes, edges}` |
| `workflow update <id\|name> [--name] [--description ""] [--project ""] [--enabled true\|false]` | the `Workflow`; `""` clears/unbinds; no field is `usage` |
| `workflow duplicate <id\|name> [--name NEW]` | the copy's `{workflow, nodes, edges}` (see below); `--quiet` accepted |
| `workflow export <id\|name> [--out FILE]` | the portable export file (see "Export and import"), or with `--out` a `{path, name, version, nodes, edges}` receipt; `--quiet` ignored |
| `workflow import FILE [--project ID\|NAME]` | `{workflow, nodes, edges, renamed_from, missing, warnings}`; the workflow is created disabled; `--quiet` ignored |
| `workflow delete <id\|name>` | the destroyed `{workflow, nodes, edges}` |
| `workflow run <id\|name> [--input TEXT \| --input-file PATH\|-] [--trigger manual\|voice]` | the finished `WorkflowRun` |
| `workflow emit <idea\|can-help\|wake> --speaker S [--text TEXT \| --text-file PATH\|-]` | runs every matching `ambient` workflow synchronously, id order; a bare array of the finished `WorkflowRun`s (`[]` when none match, exit 0); `--quiet` accepted and ignored |
| `workflow defaults --project <id\|name>` | `{created: [{workflow, nodes, edges}], skipped: [name]}` — creates the two default ambient workflows (below), skipping any whose name exists; `--quiet` accepted and ignored |
| `workflow runs <id\|name>` | a bare array of runs, newest first, **without `steps` and `input`** |
| `workflow run-show <run id>` | one run in full |
| `workflow watch <run id> [--follow]` | a derived, read-only status snapshot (naru task 1961): the running step with elapsed seconds, steps done/total, the last finished step's output tail (2 KiB), and for a task-loop run the freshest stage-driver `status.json` under the `scratch=<dir>` its state line names (`stage` null when missing or unparseable, never an error), `deadline_secs` and `stalled` (the running step older than the deadline: `status.json`'s `deadline_secs` if present, else `NARU_LOOP_DEADLINE`, else the task-loop's per-stage default). `--follow` reprints every 3 s until the run ends; unknown run is `not_found`; `--quiet` ignored |
| `workflow log [<log>] [--workflow <id\|name>] [--limit N]` | the newest N lines (default 50), newest first; no name = every log; `--workflow` keeps only the lines that workflow wrote (unknown = `not_found`). A limit outside 1..=1000 is `validation` (the API's `?limit=` too), not clamped |
| `workflow node create <WORKFLOW> <KIND> <TITLE> [--config JSON] [--x] [--y]` | the `WorkflowNode`; omitted coordinates place it in a row beside the others |
| `workflow node update <id> [--title] [--config JSON] [--x] [--y]` | the node; `--config` **replaces** the whole config |
| `workflow node delete <id>` | `{node, edges}` |
| `workflow edge create <WORKFLOW> <FROM> <TO> [--branch true\|false\|<option>\|fallback]` | the `WorkflowEdge` |
| `workflow edge delete <id>` | the destroyed edge |

**Editing nodes: cheat-sheet** (naru task 2067; checked against the CLI).
Agents guessing at `workflow node` flags kept failing, so:

- **Before using it**, run `naru help workflow node` and `naru help workflow node <sub>`; the per-kind `--config` keys are listed there.
- **When a call fails**, read `error.message`, fix the command, then retry. Never repeat a failed call unchanged.
- The only subcommands are `create`, `update` and `delete`. There is no `node list` or `node show` (`usage` error); read nodes with `naru workflow show <wf>`.
- Create: `naru workflow node create <wf id|name> <kind> "<title>" [--config '<json object>']`, e.g. `naru workflow node create ambient cli Record --config '{"command":"…"}'`. Use the positional or the `--workflow/--kind/--title` flag for an argument, not both.
- Delete: `naru workflow node delete <node id>`. The id is numeric (a workflow name or title is `usage`). It also deletes the node's edges, with no confirmation.
- Update: `naru workflow node update <node id> [--title] [--config] [--x] [--y]`, at least one flag; `--config` replaces the whole config and the kind cannot change.
- **Pins are fixed for `agent` (and `comment`) nodes**: never put `pins` in `--config`, on create or update. It is `validation`: `an agent node's pins are fixed (input; result, status); "pins" does not apply`.

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
| `GET /api/workflows/{id}` / `PATCH` / `DELETE` | the view / update (`name`, `enabled`, `description`, `project_id` three-state: omit, `null` clears) / echo the destroyed view |
| `POST /api/workflows/{id}/duplicate` `{name?}` (201) | copy a workflow; the body may be empty or `{}`, but `Content-Type: application/json` is still required (the CSRF gate answers 415 without it); answers the copy's view; a taken `name` is 409 |
| `GET /api/workflows/{id}/export` | the export file as a `*.naru-workflow.json` download (`Content-Disposition: attachment`) |
| `POST /api/workflows/import` `{document, project_id?}` (201) | `document` is the export object (or its text as a string); answers the import result; unreadable file 422 |
| `POST /api/workflows/{id}/nodes` `{kind, title, config?, x?, y?}` (201) | add a node |
| `PATCH /api/workflow-nodes/{id}` `{title?, config?, x?, y?}` / `DELETE` | update / echo `{node, edges}` |
| `POST /api/workflows/{id}/edges` `{from_node, to_node, branch?}` (201) / `DELETE /api/workflow-edges/{id}` | add / delete |
| `POST /api/workflows/{id}/run` `{input?}` | run **synchronously** (on `spawn_blocking`) and answer the finished run |
| `POST /api/workflows/events` `{event, speaker, text?}` | an ambient-engine event: validated synchronously (422), then the matching workflows run in the background in id order; **202** `{"workflow_ids":[…]}` at once |
| `GET /api/workflows/{id}/runs` / `GET /api/workflow-runs/{id}` | runs newest first / one run, steps included |
| `GET /api/workflow-runs/{id}/status` | the `workflow watch` snapshot (`workflow::run_status`), `require_agent_access` like every route here |
| `GET /api/workflow-log?log=&workflow=&limit=` | log lines, newest first; `workflow` (an id) keeps one workflow's lines — the builder's log tab sends it unless "every workflow" is ticked |

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
`stale_claim_minutes` posture); a disabled workflow, or one of an archived project, is never due.
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

A `can-help` event also lights the live orb: see "The can-help offer" in
`docs/live.md` (in memory, newest wins, 10 minute TTL, cleared by any live start,
carried on `GET /api/live` as `offer`; the CLI's `workflow emit` cannot light it).

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

## The task-loop workflow (naru task 1960)

`naru workflow defaults --task-loop --project <id|name>` (CLI only; instead of
the ambient pair, same skip-if-the-name-exists idempotency) creates **Task
loop**: a `manual` workflow whose input is a task id, running plan -> (UX
designer if the plan says `UI: yes`) -> implement -> review + verify -> at most
one fix pass -> close. Design and rationale: `docs/task-loop-workflow.md`; the
stage driver every agent node runs: `docs/stage.md`. The loop is unrolled (the
engine is a DAG), so two iterations is structural. Agent stages are `cli` nodes
running `naru stage run` with `timeout_secs` above the stage deadline; hand-off
is the per-run scratch folder `~/.naru/loop/<task>-<time>-<pid>/` (task, plan,
design, diff summary, reports, `reasons.txt`) and only a state line
(`task=<id> scratch=<dir> ui=<yes|no> <stage>=<result>`) travels as node input.
Review and verify are one node (a `--also` pair); the reports must end in
`VERDICT: PASS` or `VERDICT: FAIL`, and anything unfinished or unmarked is
INCONCLUSIVE, never a pass. Close-pass runs `naru task update --status done
--result-file`; every other ending runs `naru task note`, `--status backlog`
and `naru notify` (a notify failure is tolerated). `NARU_LOOP_DEADLINE`,
`NARU_LOOP_SILENCE` and `NARU_LOOP_GRACE` override the stage clocks. Gate:
`scripts/task-loop-check.sh`.

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
log. Needs `sox` (recording), the naru-audio daemon (speech to text,
`docs/listen.md`: `POST /v1/audio/transcriptions` answers `{"text": …}`),
`curl` and `jq`, and Claude Code logged in (the labelling step is one
`claude -p` call).

```bash
naru workflow create ambient --description "Capture a spoken thought"

# 1. The trigger: run by hand or by voice ("capture a thought").
naru workflow node create ambient trigger Start \
  --config '{"mode":"manual","phrase":"capture a thought"}'

# 2. Record 10 s, transcribe, print the transcript (empty for silence).
CMD='f=$(mktemp -t naru-ambient); sox -d -q -t wav "$f" trim 0 10; curl -s -F "file=@$f" -F model=default -F response_format=json http://127.0.0.1:7870/v1/audio/transcriptions | jq -r ".text // \"\""; rm -f "$f"'
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
run `naru serve` (the watcher is on by default). `scripts/workflow-check.sh` builds
this graph's shape over stub recording and transcription commands and a stub model API.

## Web UI

`#/workflows` (left nav; mesa task 1632) is the global overview, also shown as the Library's Workflows tab at `#/library/workflows` (mesa task 1676):
one table of every workflow across all projects with project, on/off, last run,
last failure and next run, polled every 5s (the On column is the workflow's `enabled` switch). A row opens the workflow in its
owning project's view; a global (project-less) workflow's row links to
`#/workflows/<id>`, the global builder. An **Add workflow** button in the page
header (both the standalone page and the Library tab) opens an inline form (name,
Enter creates, Escape cancels, a server error such as a duplicate name shown
inline) that creates a project-less workflow and opens its builder; the pure
parts are `workflowCreate.ts`. The label logic is `workflowOverview.ts`.

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
