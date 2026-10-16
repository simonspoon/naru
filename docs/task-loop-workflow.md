# The task loop as a workflow (design, naru task 1954)

Status: design only, nothing here is built. Origin: naru task 1950, where a
supervisor agent launched a verifier with a 15-minute budget, the verifier
overran, and nothing acted until the live voice pinged the supervisor. The
loop's discipline lived in an agent's instructions, and an agent that is
waiting does not act.

The idea: run the bug-fix loop as a Naru workflow (`docs/workflows.md`), where
**the graph decides what runs and the engine owns the clock**, and agents only
do the stages. This doc answers what the engine can do today, lays the flow
over it, and picks a build path. Engine claims were re-checked against
`src/core/workflow.rs` and `docs/workflows.md`; line numbers are as of commit
`d11acd4`.

## 1. Open questions against the engine

| Question | Today | Verdict |
| --- | --- | --- |
| Pin a stage to a named agent | No node kind takes an agent. `prompt` is one tool-less `claude -p` call (`workflow-prompt` template). A `cli` node can run `naru run start --agent X` (the runner carries `run_agent`, `docs/runner.md`), then poll. Never exercised from a workflow | **Gap, workable** via `cli` + `naru run`; needs a spike (task 1955) |
| Per-node hard timeout | `timeout_secs` on `cli`/`script` (1..=86400) and `prompt` (1..=3600), default 600 (`workflow.rs:44-46`); the whole process group is SIGKILLed at the deadline. `decide`, `branch`, `output` have none (in-process, instant) | **Supported** |
| Nudge before kill | The timeout kills; it does not nudge. A `cli` node can contain its own watchdog loop (below) | **Gap, workable** inside a node |
| Parallel nodes | None: `for id in order` (`workflow.rs:814`) is a serial topological walk. Two branches run one after the other | **Gap**. Worked around by running the reviewer and verifier concurrently *inside one `cli` node* |
| Joins | Any-semantics: a node runs if at least one incoming edge is active, inputs joined by `\n` in edge-id order (`active_input`, `workflow.rs:899`). There is no wait-for-all, and a failed upstream aborts the run | **Partial**. Fine because the join is inside the parallel node; a failure must be encoded as output, not as a node failure |
| Conditionals | `branch` (`contains`, `regex`, `equals`, `score_above/below`) and `decide` (rules); an edge is active per verdict | **Supported** |
| Loops / retry / max iterations | DAG only; a cycle is refused. No retry, no loop node | **Gap**. Worked around by **unrolling** two iterations: the max of 2 becomes structural |
| Hand-off between nodes | Only the single `{input}` string (capped 64 KiB per step). No file or structured hand-off | **Gap, workable**: a per-run scratch dir, a pointer travels as input |
| Update an existing task / notify | `output task` only *creates* tasks; `output inbox` has a static `task_id`; no notify node | **Gap, workable**: `cli` nodes running `naru task update` and `naru notify` |
| Pass the task id in | Trigger takes free text only | **Supported** by convention: the input *is* the task id |
| Observe a run mid-flight | The run row is persisted `running` before and after each node (`workflow.rs` live steps, `Store::update_workflow_run_steps`, `store.rs:5730`); the current node is the step with status `running`. `WorkflowStep` has no `started_at` and a running node has no partial output; `cli` stdout is not readable until the node ends | **Partial**: current node yes, time on it only derivable, last output no |
| Survive the starter | A run is owned by its starting process (`owner_pid`); if that CLI or serve dies, reconcile marks it `failed` | Closed by `naru workflow run --detach` (task 1958): a detached job owns the run |

Nothing in the findings I was given was wrong. Two refinements: `cli` accepts
timeouts up to 86400 s while `prompt` caps at 3600; and the run row *does*
have `started_at`, so elapsed time on the current node is
`now - (run.started_at + sum(finished duration_ms))`, approximate but usable
until a per-step `started_at` exists (task 1957).

`naru run` (`docs/runner.md`) answers the "long-running, interruptible agent"
question: a run is a detached `claude -p` held open on stream-json stdin that
outlives the CLI and the server; `naru run send` delivers a message between
tool calls (and `--interrupt` cuts a turn), `naru run show --events --main
--tail N` reads the last output, `naru run stop` ends it, and `job.json` /
`events.jsonl` give status and last-activity time with no server. The missing
piece is only a **blocking wait with a deadline** (task 1956).

## 2. Target flow, node by node

Trigger input is the task id. Each agent stage is a `cli` node running the
stage driver (section 3), pinned with `--agent`, with `timeout_secs` set well
above the stage deadline so the driver, not SIGKILL, ends a stage.

| # | Node | Kind | Uses | Gap |
| --- | --- | --- | --- | --- |
| 1 | Plan | `cli`: stage driver, `--agent planner` | `naru run`, scratch dir for the plan | agent pinning (spike) |
| 2 | Touches UI? | `branch` `contains` on the plan's `UI: yes` line (or a `decide` with fallback) | supported | none |
| 2a | UX designer (UI only) | `cli`: stage driver, `--agent ux-designer` | the branch's true edge | none beyond 1 |
| 3 | Implement #1 | `cli`: stage driver, `--agent implementer`, write-capable | reads the plan (+ design brief) from scratch | the `runner` template has no permission flag; configure one (spike) |
| 4 | Review + Verify #1 | **one** `cli` node: stage driver with `--also`, `diff-reviewer` and `verifier`/`ui-verifier` concurrently | node-internal parallelism | engine has no parallel nodes; join is node-internal |
| 5 | Join #1 | `branch` on the combined verdict: `PASS` / `NEEDS-FIX` / `INCONCLUSIVE` (two chained branches) | supported | none |
| 3' | Implement #2 | stage driver, fed the findings | the NEEDS-FIX edge | unrolled copy |
| 4' | Review + Verify #2 | as 4 | | unrolled copy |
| 5' | Join #2 | `branch` | | |
| 6 | Close | `cli` nodes: PASS -> `naru task update <id> --status done --result ...`; INCONCLUSIVE, or NEEDS-FIX after iteration 2 -> `--status backlog`, `naru task note`, `naru notify` | `cli` | no engine task-update or notify node |
| 7 | Commit | `cli`, after Close: pass only: stages exactly the paths `git status --porcelain -z -uall` lists (`git add -A -- <paths>`, never the whole tree) and commits `task <id>: <name>`; the Plan node snapshots the status to `baseline.txt` first, and a non-empty baseline refuses (nothing staged, `naru task note`, `naru notify`, node fails; the task stays `done`); nothing changed = `commit=none`; a failed commit unstages and notes it | `cli` | none (no push, no PR) |

Both the pass edge of Join #1 and Join #2 reach the same Close-pass node (any
semantics make that a plain fan-in). A failed *agent* must not fail the node:
the stage driver exits 0 and prints a verdict, so the run keeps going to a
Close node that files the right outcome. Only a genuine bug (a crashed
driver) fails the run, and the run's `failed` status is itself the signal the
status watcher and the stall watchdog (section 5) surface.

## 3. Watchdog, nudge, restart, INCONCLUSIVE

The watchdog is **part of the workflow** because it lives in every stage
node: the stage driver (`naru stage run`, task 1959) is the only thing a
workflow agent node runs.

1. Start: `naru run start --agent A --cwd D <brief>`; note `deadline` and
   `silence` limits from the node's config.
2. Loop on `naru run wait` (task 1956), which returns on: turn finished,
   silence (no line in `events.jsonl` for `--silence`), deadline, or terminal.
3. **Silence**: one `naru run send` nudge ("status? report what you have").
   Still silent after a grace period: `naru run stop`, then start the same
   brief again once (`--max-restarts 1`). A second silence ends the stage.
   Use plain `send`, not `--interrupt`, because an interrupt kills the turn's
   background subagents (`docs/runner.md` warning); the interrupt is reserved
   for the final overrun cut.
4. **Overrun**: at the deadline send "deadline reached, report partial results
   now", wait a grace period (default ~3 minutes, the same shape task 1952
   put in the supervisor instructions), then `naru run stop`.
5. **INCONCLUSIVE**: a reviewer or verifier that ends without a final report
   after step 3 or 4 yields `{"verdict":"INCONCLUSIVE","reason":...,"partial":...}`,
   never a pass and never a node failure. Join routes it to Close, which sets
   the task to `backlog`, adds a note with the partial report and the run id,
   and pings the user through `naru notify --open` to the task. An
   *implementer* that ends silent twice is `NEEDS-FIX`-equivalent: the loop
   goes to Close-inconclusive rather than looping a broken stage.
6. The driver writes `status.json` (section 4) on every poll, so a
   half-hour stage is never a black box.

What the engine's own per-node timeout still gives: a last-resort bound. If
the driver itself hangs, SIGKILL of its group at `timeout_secs` fails the
node and the run, which the stall watchdog below flags. The detached agent
runs (their own process group) are *not* reached by that kill: the driver
stops them in its normal path, and a killed driver leaves a run that
`naru run list` shows and the cleanup in the spike (task 1955) must define.

## 4. Status view outside the flow

**Shipped (task 1961)** as `workflow::run_status`; `status.json` carries no deadline, so `stalled` uses its optional `deadline_secs`, else `NARU_LOOP_DEADLINE`, else the stage default (plan 900, ux 600, impl 2400, review 1500). The scratch folder is found from the `scratch=<dir>` in the newest step output.

A **watcher that only reads**, never a node. `naru workflow watch <run id>`
and `GET /api/workflow-runs/{id}/status` (task 1961) derive on every read:

- run status and the `running` step (title, kind, `started_at`, elapsed);
- steps done / total and the last finished step's output tail;
- from the stage driver's `status.json`: stage, agent, job ids, last event
  time, nudges sent, restarts, last output tail;
- `stalled` when the current node's silence exceeds its stage deadline.

It reads `run-show` (works mid-run because of the live step persistence) plus
the scratch status file. A read failure is null, not an error, so a broken
watcher cannot touch the loop. The live voice agent answers "how is the loop
going?" by running `naru workflow watch`, not by tailing anything itself.

## 5. Relation to tasks 1952 and 1953

Both are done and are **complements, not replaced**:

- **1952** (supervisor must act when a delegate overruns): text rules in
  `~/.claude/agents/supervisor.md`, `waiting.md` and `briefs.md` (outside this
  repo). It governs the agent-supervised path. The workflow moves the same
  rules (deadline, nudge, ~3 minute grace, stop, relaunch or report
  inconclusive) out of prose and into the stage driver, where they cannot be
  forgotten. Until the workflow ships, 1952 is the only guard for supervisor
  runs and stays in force afterwards for any ad-hoc supervision.
- **1953** (stall watchdog): shipped in `d11acd4`, in the todo-watcher reaper
  (`watchers.stall-minutes`, default 20): a silent `in_progress` dispatched
  session gets one nudge (naru-run sessions only), then one `naru notify` and
  one inbox alert, and a `stalled` badge. It watches *dispatched sessions*.
  A workflow run, and the `naru run` jobs its stage driver starts, are not
  sessions the todo-watcher dispatched, so 1953 does not see a hung workflow
  run. The status
  watcher's `stalled` flag (section 4) is the workflow-side twin and should
  reuse 1953's notify-and-alert path rather than duplicate it (a follow-up
  inside task 1961's scope if cheap, else a separate task).

## 6. Recommendation

Three options: (a) build the gaps into the engine (agent node, parallel
walk, wait-for-all join, loop/retry node, step output streaming); (b) keep
the supervisor agent; (c) **hybrid: the existing engine for the skeleton, a
small deterministic stage driver for everything that waits.**

Pick **(c)**. Justification:

- Every capability the loop needs exists in a form that needs no engine
  redesign: a DAG with branch is enough once two iterations are unrolled;
  the parallel pair fits inside one node; the hand-off is files; Close is
  `cli`. The genuinely missing engine pieces are small and independent: a
  per-step `started_at` (1957) and a detachable run (1958).
- The hard part, nudge/restart/INCONCLUSIVE, is *process supervision*, which
  belongs next to `naru run` (files are truth, no server) and is testable
  with the stub `claude` in a check script. Putting it in the engine would
  mean teaching the engine about agent sessions, which `docs/workflows.md`
  deliberately avoids ("the only model call anywhere is one `prompt`
  node's"). The stage driver is not an agent deciding anything: it is a
  script with a clock, which is what failed in task 1950.
- Engine loops, parallel walks and wait-for-all joins are real features with
  real blast radius (every existing workflow, `workflow-check.sh`). They buy
  nothing here that unrolling plus node-internal parallelism does not, and
  can be built later on their own merits if a second workflow wants them.
- Keeping the supervisor (b) leaves the failure that started this: control
  flow that depends on a model choosing to act.

Cost accepted: the graph is longer than the idealised diagram (the loop is
unrolled), and parallelism is invisible to the engine's step list (review and
verify are one step; their detail is in `status.json`).

## 7. Follow-up build tasks, in order

All created in `backlog` (the todo-watcher would dispatch `todo`), with the
blocks shown:

1. **1955** Spike: `naru run start --agent X` as a workflow agent stage
   (permission flag, last-output read, kill semantics). Findings appended
   here, go/no-go.
2. **1956** `naru run wait` (blocked by 1955).
3. **1957** Per-step `started_at` on `WorkflowStep` (independent).
4. **1958** `naru workflow run --detach` (independent).
5. **1959** Stage driver `naru stage run`: nudge, restart, INCONCLUSIVE,
   parallel pair, `status.json` (blocked by 1955, 1956).
6. **1960** Ship the `task-loop` workflow, `workflow defaults --task-loop`
   and `scripts/task-loop-check.sh` (blocked by 1957, 1958, 1959).
7. **1961** `naru workflow watch` / status route and the voice-agent line
   (blocked by 1957, 1959).

Not built, on purpose: engine loop/retry node, parallel walk, wait-for-all
join, a notify node, an update-task output. Revisit only if a second workflow
needs them.

## 8. Spike findings (task 1955)

Run with real `claude` (haiku, tiny briefs), installed `naru 2.15.0`, a
throwaway `NARU_DB`, a throwaway `NARU_CONFIG_FILE`, a scratch git repo for
`--cwd`. The runs directory has **no override** (`runner::runs_dir()` is
`~/.naru/runs` from the real home), so the spike's jobs landed there and were
deleted afterwards (by id). Stub-free throughout.

**GO**: `naru run start --agent X` is a sound agent-stage substrate. One
setting is mandatory (permission mode) and two behaviours need the stage
driver (below).

### 8.1 Launch from a `cli` node (works)

```
naru workflow create spike; naru workflow node create spike trigger Start
naru workflow node create spike cli Launch --config '{"command":"naru run start --model haiku --agent implementer --cwd /tmp/spike/repo \"Reply with the single word PONG, then wait.\"","timeout_secs":60}'
naru workflow edge create spike 1 2; naru workflow run spike
```

The step output is the job record: `{"job_id":"233407d2","agent":"implementer",
"status":"running","runner_alive":true,"pending_messages":1,"session_id":…}`.
The node returns at once (about 0 s); the run continues detached. The job id is
the `job_id` key of the step output (`jq -r .job_id`). Note `runner_pid` and
`claude_pid` are `null` in the start echo (runner not up yet); read them later
from `naru run show`.

### 8.2 Poll, send, stop (works)

- ~15 s later `naru run show 233407d2` says `status: idle`,
  `last_result: "PONG"`, `runner_pid 10495`, `claude_pid 10525`.
- `naru run send <job> "<text>"` to an idle run starts a new turn in the same
  session (asked for a file, got `DONE`; asked for a quote, got an answer).
  Echo is `{status:"idle",pending_messages:1}`, i.e. the pre-delivery view.
- `naru run stop <job>` echoes the *old* status (`idle`); about 8 s later the
  job reads `stopped`, `runner_alive:false`, and `ps` shows both pids gone.
  A stage driver must poll for the terminal status, not trust the echo.
- **Not exercised**: a nudge delivered while a turn was genuinely in flight
  (claude backgrounded its `sleep 90` and went idle, so the later send landed
  on an idle run; the same shape as `run send` in section 4's assumptions).
  `send --interrupt` was not run either; both are covered by `runner-check.sh`
  against the stub and by naru task 1868's real-claude measurement in
  `docs/runner.md`.

### 8.3 Agent definition is honoured (works)

The runner's claude command line carries `--agent implementer`
(`ps`: `claude -p … --agent implementer --model haiku --name 233407d2 …`) and
`job.json` records `agent`. The `system/init` event has **no** `agent` field
(`agent: null`), so init cannot prove it; the proof is behavioural: asked to
quote its first instruction, the run quoted `implementer.md`'s opening line.
`--model haiku` overrides the definition's `model: sonnet`. Caveat: that
opening line is also in the surrounding harness prompt in some setups, so a
stage check should rely on the argv/`job.json`, not the quote.

### 8.4 Permission flag (needed unless the user's claude default allows)

The default `runner` template passes **no** permission flag, so a run inherits
claude's own default. On this machine `~/.claude/settings.json` has
`defaultMode: bypassPermissions`, so the unmodified template wrote files
without any prompt (`init.permissionMode` was `bypassPermissions`). To prove
the failure mode, a throwaway config with `--permission-mode default`:

```
{"commands":{"runner":"run_agent={run_agent}\nclaude -p --input-format stream-json --output-format stream-json --verbose --permission-mode default ${run_agent:+--agent \"$run_agent\"} --model {model} --name {name} {session_flag} {session_id}"}}
```

The Write tool result was `is_error: true`, "Claude requested permissions to
write to …/out-default.txt, but you haven't granted it yet." The same template
with `--permission-mode acceptEdits` gave "File created successfully" and the
file existed. **Setting for a workflow agent stage**: put
`--permission-mode acceptEdits` (edits only) or `bypassPermissions` (also
Bash/git, needed for a gate-running implementer) into the `runner` template
(`config.json` `commands.runner`, same text as the default with the flag added
before `${run_agent:+…}`, **keeping the `run_agent={run_agent}` first line** or
`--agent` is silently dropped). The template is global, not per run, and
`naru run start` has no `--permission-mode` flag; a stage that needs a mode
other than the user's default cannot choose one per job. To-file below.

### 8.5 Last output (works)

`naru run show <job> --main --tail N` returns `{…job…, events:[…]}` with the
last N non-subagent events; the final `result` event's `result` field is the
answer and the job carries `last_result` / `last_subtype` / `last_is_error`
(`last_result` alone is enough for "what did it end on"). Tool results appear
as `type:"user"` events (`message.content[0].type == "tool_result"`).
Without `--events`/`--main` `run show` prints only the job object.

### 8.6 Kill semantics (runner survives, as designed)

A `cli` node `naru run start … > start.out; sleep 40` with `timeout_secs: 5`
ended `failed`, "timed out after 5s", at 5 s. The start had already completed
(job `7c8cc8b8` in `start.out`, `runner_pid` null at that moment). 8 s later:
runner pid 27122 (`ppid 1`, own pgid 27122) and claude pid 27193 (pgid 27193,
child of the runner) were alive and the job was `idle`, having done its work.
So the engine's kill of the node's process group does **not** reach the run:
the runner is its own group (`process_group(0)`) and re-parented to init.
It is cleaned up only by `naru run stop` (verified: both pids gone in about
8 s), by the idle timeout (default 3600 s, `--idle-timeout`) or by claude
exiting. A workflow timeout therefore leaves an orphan agent that keeps
spending until stopped: **the stage driver must record the job id and `stop`
it itself on timeout/cancel**, and should pass a short `--idle-timeout` as a
backstop. Observation: a briefed `sleep 90` was run by claude as a
background Bash call and the run went `idle` immediately; a stage that waits
on work must not treat `idle` as "done" without reading `last_result`.

### 8.7 To-file / bugs

1. No per-job permission mode: `naru run start` / `POST /api/runs` should take
   `--permission-mode` (or a `--template`-like choice) so a loop stage does not
   depend on the global `runner` template and the user's claude default.
2. `naru run stop` echoes the pre-stop status (`idle`); consider echoing
   `stop_requested` or documenting it. `run start` echo has null pids.
3. `run send` / `run stop` echo a stale `status`; `run wait` (1956) must poll
   `job.json`, not use the echo.
4. Runs dir has no override env var, so tests/spikes pollute `~/.naru/runs`.
5. Node timeout does not stop an agent it started (section 8.6); the stage
   driver (1959) owns that.
