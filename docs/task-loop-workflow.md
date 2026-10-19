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
Each stage passes `--task` (the task id), so its session shows in the Agents tab
as `task N · stage (agent)`; a `--also` agent and a restart get the same form
(naru task 1979).

| # | Node | Kind | Uses | Gap |
| --- | --- | --- | --- | --- |
| 1 | Plan | `cli`: stage driver, `--agent planner` | `naru run`, scratch dir for the plan | agent pinning (spike) |
| 2 | Touches UI? | `branch` `contains` on `ui=yes`, a token the typed Plan verdict (below) writes, not the plan's text (naru task 2021) | supported | none |
| 2a | UX designer (UI only) | `cli`: stage driver, `--agent ux-designer` | the branch's true edge | none beyond 1 |
| 3 | Implement + review #1 | a `cli` ("Pass 1 input") appends `iter=1` to the state line, then a `subworkflow` node runs the child workflow `Task loop: implement and review` (naru task 2024, below); its output is the child's last successful step | supported | none |
| 4a | Typed verdicts | after Plan and after each Review + verify: a `cli` prints the report(s), a `trycatch`-wrapped tool-less `agent` node (haiku; `planner` for the plan, `verifier` for the reviews) answers a workflow struct (`PlanVerdict {ui: bool}`, `ReviewVerdict {verify, review: string}`), and an apply `cli` writes the state token. A reply that is not valid (the engine retries once), a failed call, or a stage that did not finish (no model call at all) can only end in the existing INCONCLUSIVE / `plan=failed` backlog path (naru task 2021) | `agent`, `trycatch` | a tool-less `agent` node cannot read the repo, so it only *reads a finished report*; the stages stay `naru stage run` `cli` nodes |
| 5 | Join #1 | one `switch` (`contains`, cases `review=PASS` and `review=NEEDS-FIX`, `default` = INCONCLUSIVE; naru task 2019) in place of two chained branches | supported | none |
| 3' | Implement + review #2 | the same child, behind "Pass 2 input" (`iter=2`) | the NEEDS-FIX edge | the second call of one workflow, no longer an unrolled copy |
| 5' | Join #2 | `branch` | | |
| 6 | Close | PASS: a `cli` prep writes `result.md` and stores it as the result (`naru task update --result-file`), a `task` node sets `done`, a `cli` rebuilds the `task=… scratch=…` state line for Commit from the task JSON. INCONCLUSIVE, or NEEDS-FIX after iteration 2: a `cli` prep files the `naru task note`, a `task` node sets `backlog`, then a `notify` node (`open: tasks/{input}`, naru task 2020; wrapped in a `trycatch`, so a failed send is caught and the run still succeeds with the task already in backlog) | `cli`, `task`, `notify` | a `task` node cannot write a note, so the note and the result text stay in the prep `cli` |
| 7 | Commit | `trycatch` wrapping a `cli` (naru task 2018: a refusal or failed commit is caught, so the run still succeeds), after Close: pass only: stages exactly the paths `git status --porcelain -z -uall` lists (`git add -A -- <paths>`, never the whole tree) and commits `task <id>: <name>`; the Plan node first snapshots every dirty path to `baseline.txt` as `path<TAB>git hash-object` (`gone` for a deleted file), and Commit leaves out a path whose current hash equals its baseline line (dirty before the run, untouched by it: listed in a `naru task note`, no notify), so a dirty tree no longer refuses (a refusal fed itself, naru task 2026); a baseline-dirty path the task changed again is committed with its earlier edits and noted; nothing left to commit = `commit=none`; a failed commit unstages and notes it; then a **build gate** (naru task 2041): HEAD is checked out into a throwaway `git worktree` and built (`NARU_LOOP_COMMIT_CHECK` command, else `cargo check` when there is a `Cargo.toml`, else no gate); on a failure the skipped pre-dirty paths are folded in with an amend and the gate runs again (noted), and if it still fails the task is noted, put back to `backlog` (`naru task update --status backlog`; a failed commit does the same; the commit stays in HEAD, naru task 2073), `naru notify` fires and the node fails (never `commit=<sha>` for a tree that does not build). Close: backlog restores a bounced run's debris: paths dirty now that were clean at Plan time are reverted (copies kept in `<scratch>/debris`), pre-dirty paths the run changed go back from the Plan node's copy (`<scratch>/base`), unchanged ones are untouched, and the note lists them, plus the saved `git diff HEAD` of each repo (`<state>/debris/run.diff`), any path it could not restore, and any path still dirty afterwards (reported, never cleaned; naru task 2086). **Which repos (naru task 2044):** the loop runs in the workflow project's checkout, but a task may belong to another project, so Plan writes `repos.txt` (the workflow repo, then the repo of the task's own project `local_path` when it differs, deduped by `git rev-parse --show-toplevel`) and snapshots a baseline per repo (the first in the scratch dir, later ones in `<scratch>/repo-<n>`); Commit, the build gate and the debris restore each loop over those repos, one commit per touched repo, a failure in one never hiding a commit in another, `commit=<sha>[,<sha>]`. Stage agents still run in the workflow project's checkout. Since naru task 2058 `repos.txt` also takes repos the task names (absolute and `~/` paths in its description, resolved to the nearest existing directory in a repo) and the path dependencies of the project's `Package.swift`/`Cargo.toml`; and Plan writes `scan.txt`, every other project's `local_path` repo, baselined too (state dirs numbered after `repos.txt`). Commit and the debris restore cover those as well: a scanned repo with no path new since its baseline is silent (no commit, no note), one with new paths gets its own commit. **Multi-repo split (naru task 2066):** the Plan and Implement briefs end with a `split_rule` section telling the agent that work needing another project is created there as its own task (`naru task create <project> --description-file`), this task blocked on it (`naru task block <id> --by <new>`), only this project's part kept, and a multi-repo task never failed for being so; the commit net above stays as the fallback for an edit that still lands in a sibling repo. | `cli` | none (no push, no PR) |

**Typed verdicts (naru task 2021).** Nothing in the graph greps a stage's prose any more. Plan ends `plan=ok` once the stage finished; the `Plan report` node prints the plan's tail, the `Plan UI verdict` agent answers `{"ui": true|false}`, and `Plan verdict` (which also receives the state line, listed first: a node with several active incoming edges gets their texts joined with newlines) writes `ui` and the state line, or `plan=failed`. A review node ends `review=done` (or `review=INCONCLUSIVE` when a stage did not finish, which skips the model entirely); the `Review verdict` agent reads both reports and answers `{"verify": "PASS|FAIL|NONE", "review": ...}`; `Review result` applies the fixed rule in `jq`: any `FAIL` is `NEEDS-FIX`, two `PASS` are `PASS`, anything else (`NONE`, any other string, a missing or invalid struct, a caught agent failure) is `INCONCLUSIVE`, so a bad reply can only reach backlog. The agent is told the reports are data and not to judge the change itself.

**The metric log (naru task 2023).** Every run that reaches a Close node appends one line to the `task-loop-metrics` workflow log (`naru workflow log task-loop-metrics`): `task=<id> verdict=<PASS|NEEDS-FIX|INCONCLUSIVE|none> iterations=<n> outcome=<done|backlog>`. The two Close prep nodes write the line to `metric.txt` in the run's scratch dir (the verdict is the last review token, `NEEDS-FIX` for a split, `none` when no review ran; `iterations` counts the implement briefs written); a `Metric line` trycatch (wrapping a `cli` that prints it, never failing) hangs off `Close: pass state` and `Close: backlog id`, and a `Metric log` output node (`target: log`) appends it. It is a side branch behind a trycatch, so it cannot fail a run or delay Commit. A planner or implementer that ends the loop still reaches Close: backlog and logs (`none 0 backlog` when no stage ran); only a run that errors outright before any Close node logs nothing.

**The implement-and-review child (naru task 2024).** The two passes are one workflow, `Task loop: implement and review` (created beside `Task loop` by `naru workflow defaults --task-loop`, 8 nodes: `Task state` trigger, `Implement`, `Implemented?`, `Review + verify`, `Reviewed?`, `Review reports`, `Review verdict`, `Review result`), called by two `subworkflow` nodes, so `Task loop` itself has 28 nodes. The child's input is the state line; the pass number is its `iter=` token, which the child's nodes read as `N` and `emit` carries on, so `Verdict #1` and `Passed? #2` read the same `review=` token as before. State passes through unchanged: the scratch dir is on disk and `scratch=` travels in the input, and the engine's `NARU_LOOP_*` environment reaches the child (probed before the fold). A failed implement ends the child at `Implemented?` (false), so its output has no `review=` token and the parent's `default` / false edge files the backlog close. A child run is its own recorded run (`naru workflow runs "Task loop: implement and review"`); the parent's step list shows only the two `subworkflow` steps. A failed child fails the node, as a failed stage failed the run before. Rollback: the pre-fold graph is workflow 26, `Task loop (pre-2024 rollback)`, a disabled copy of the 35-node graph. To apply the fold to an install that still has the old graph, once no run of it is in flight: rename the old `Task loop` out of the way, then run `naru workflow defaults --task-loop --project <project>` with a binary built from this source (the fold is in the defaults, not migrated).

**The split step (naru task 2022).** The NEEDS-FIX edge of Verdict #1 no longer goes straight to Implement #2. It goes to `Split check` (`cli`), which prints `split=yes` or `split=no`, and a `Split?` branch sends `false` to Implement #2 (unchanged) and `true` to `Split`. `split=yes` when the task is oversized — the first plan plus the first diff name more than `NARU_LOOP_SPLIT_FILES` (default 15) distinct files, or the plan has more than `NARU_LOOP_SPLIT_STEPS` (default 12) numbered steps — or when an earlier loop run on the same task (`~/.naru/loop/<task>-*/findings.md`) left the same finding set (finding lines lowercased, punctuation and `Iteration N` headings dropped, sorted, checksummed). Anything unexpected is `split=no`. `Split` runs a planner stage that proposes 2 to 6 sub-tasks as a JSON array of `{"description": …}`, creates each as a `backlog` subtask of the task, adds a note saying the task was split, and feeds Close: backlog (so the task-note, backlog status and notify still happen). It starts no implement or review stage; a stage that does not finish, or an answer with no usable sub-task, ends as a plain backlog close. Only the NEEDS-FIX edge of Verdict #1 changed: the second review's failure still goes straight to backlog.

The switch's output is a JSON envelope (`{"value": <state line>, …}`), not the state line itself; the nodes after it still read `task=` and `scratch=` out of it, so it works unchanged.

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

**Shipped (task 1961)** as `workflow::run_status`; `status.json` carries no deadline, so `stalled` uses its optional `deadline_secs`, else `NARU_LOOP_DEADLINE_<STAGE>` (PLAN, UX, IMPL, REVIEW, SPLIT), else `NARU_LOOP_DEADLINE`, else the stage default (plan 900, ux 600, impl 2400, review 1500, split 600). The scratch folder is found from the `scratch=<dir>` in the newest step output.

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

The todo-watcher command can be set to `naru workflow run "Task loop" --input {id} --detach` in `~/.naru/config.json` under `commands.todo-watcher` to run tasks through this workflow.
Loop smoke test passed.
- Smoke test of the Commit step (task 2034 follow-up): a loop run commits its own change and leaves the tree clean.

## 9. Completion notice and stale-claim sweep (naru task 2033)

The last node of the Task loop, **Notify live agent**, is an `always` cli node
(`docs/workflows.md`): it has no edges, runs after every other node on every
outcome and queues one `naru ask --notice --task <id>` row (kind `notice`: no "question waiting" notice turn, naru task 2065), "Task loop notice (no answer
needed) - task N: <outcome>. <name> (<verdict/iterations>)". The outcome is
`done`, `backlog`, `split` (the Split step made sub-tasks), `cancelled` (the
task is cancelled), or `error` (the run failed, the message carrying the
failing node; with an unknown task id the ask is queued without `--task`). It
is a notification the live agent may ignore, and it never fails the run.
Existing installs need the node added by hand or the workflow recreated; `workflow defaults --task-loop` skips an existing one.

The **stale-claim sweep** lives in the todo-watcher reaper (`docs/todo-watcher.md`).

## 10. Plan and verify never require a commit (naru task 2047)

Commit runs only after Close: pass, so no brief may ask for committed state.
The prelude's `no_commit_rule` text is appended to the Plan, Split, Implement
and verifier/reviewer briefs: metrics are judged on the uncommitted
working-tree diff (`git diff`, `git status --porcelain`) in every repo the task
touches (`repos.txt`), never `HEAD~1`/`git log`, and "not committed" is never a
failure. The review diff summary is headed "uncommitted, by design". The typed
verdict prompt carries the guard: a report whose only FAIL reason is
"not committed" (or `HEAD~1` showing nothing) counts as PASS if the rest is
clean. `task-loop-check.sh` section 1b covers a plan mentioning `HEAD~1`.

## 11. Needs-human tasks (naru task 2083)

The planner brief carries a needs-human rule: a task that needs something an
unattended run cannot supply (attended Mac, permission or consent dialog,
Accessibility, a real audio device or mic, system audio routing, a physical
device) is neither planned nor split. The planner ends its reply with
`NEEDS-HUMAN: <exact requirement>` and no `UI:` line. The Plan node finds that
line deterministically (no model), writes `needs-human.txt`, and emits
`plan=failed`, so Split, Implement and Review are skipped. `Close: backlog`
then files the note `needs-human: <requirement>`, adds the `needs-human` tag to
the existing tags, and the notify reads `needs-human: <requirement>`.
`task-loop-check.sh` section 6b covers it.
