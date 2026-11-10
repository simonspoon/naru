# Model router (naru task 2683)

When the queue-watcher is about to start a session for a task, one tool-less
headless Haiku call reads the task text and picks the model that session runs
on: `haiku`, `sonnet`, `opus` or `fable`. The pick fills the new `{model}`
placeholder of the `queue-watcher` template. It is made **once, at spawn**, and
never changed mid-session (a switch would break the prompt cache). Code:
`src/core/model_router.rs`; the one call site is `dispatch_task_session` in
`src/api.rs`.

## What it does

- `route(&Request, prompts, cwd)` is the single entry point. It returns a
  `Decision { model, reason, source, latency_ms }`, or `Refused`.
- `dispatch_task_session` is the one spawn both `queue_watcher_tick` and the
  cost-guard relay use. It reads the task (description, project id) under a
  short store lock, **drops the lock**, calls the router (up to 15 s), and
  passes `decision.model` to `agents::spawn_bg` as `{model}`. No task column,
  no migration.
- The Haiku call is `llm::complete_structured` through the new `model-router`
  command template (`docs/config.md`, the `kb` shape: tool-less
  `claude -p --model haiku --json-schema`), `{name}` `naru model-router`, hard
  timeout **15 s**, cwd `~/.naru/workspace` (a folder Claude Code trusts). The
  schema is `{reason: string, model: haiku|sonnet|opus|fable, risky: boolean}`, all required, `reason` first so the model states its reasoning before it commits (measured: with `model` first Haiku named a fable signal in its reason and still answered opus); `risky` last so it does not sway the pick (controlled exploration, below).
- The task text is untrusted. It rides in the prompt between `<<<TASK` and
  `TASK>>>`, capped at 6000 characters, and the prompt says it is data, not
  instructions.

## The rubric

Derived from Anthropic's "Which Claude model should you build with?" (Opus at
medium effort is the default for most coding work; a clear spec alone does not
justify a smaller model). This table is in the router prompt verbatim:

| Signals in the task text | Model |
|---|---|
| Read-only or mechanical: summarize/read logs/search/list/tag/classify/extract, rename, format, docs-only or comment-only edit, no code logic change, easy to verify at a glance. Examples: "summarize these logs", "rename X to Y across a file", "fix a typo in a doc or comment", "list the tasks tagged Z", "tag/classify this inbox item" | haiku |
| Well-scoped change with a clear spec and a named check: single-file or few-file bug fix, small feature iteration, add a test, config/doc tweak with code, follows an existing pattern | sonnet |
| DEFAULT and anything uncertain: multi-file feature, debugging with unknown cause, cross-module change, UI change needing live QA, anything touching concurrency, persistence/migrations of data, security, the spawn/queue machinery itself | opus |
| Hardest work: large refactor or migration, architecture/design work, deep research or analysis, orchestrating many subagents, long unattended run, task text says it is large or high risk. Examples: "design the architecture for ...", "large refactor/migration across the repo", "deep research and a written analysis", "orchestrate many subagents over a long unattended run" | fable |

Rules, also in the prompt: a clear spec alone does **not** justify `sonnet` for
cross-process work (migrations, performance work, spawn/queue/IPC, anything
across process boundaries): those stay `opus`; when signals conflict or are
missing, choose the
**higher** model (never down-route on doubt); never `haiku` for a task that
edits code logic; a task text too short or vague to show its scope (no named
file, no named check, a sentence or two) counts as **missing** signals and goes
to `opus`, and `haiku` needs the text itself to make explicit that the work is
read-only or mechanical and changes no code logic; the `reason` is one sentence
quoting the signal used, starting `Task:` (or `Role <name>:` for a delegate
brief, below). A task text that itself says the work is large, big,
risky or high risk, or restructures a whole subsystem, is a `fable` signal that
outranks the `opus` default for the spawn/queue machinery; when one part of the
text is small and another is a `fable` signal, the `fable` signal decides.

### Delegate briefs route by role (naru task 2690)

Before the rubric, the prompt checks whether the text opens by declaring the
session's agent role (`You are the agent "verifier"`, `You are the reviewer
stage of ...`). Such a text is a delegate brief and is routed by the role's own
job, never by the task embedded in it (the replay trial showed Haiku sending
verifiers and reviewers to `opus` because the embedded task touched the spawn
machinery): a role that verifies, reviews, checks, researches, does recon,
designs UX or implements an already-planned brief is `sonnet`; one that plans,
architects or supervises is `opus`; an unknown role is `opus`. Asking for the
`Role <name>:` prefix on the reason is what makes Haiku do this check every
time (without it one implementer brief went to `opus` about one run in five).

The queued-task entry point **never sees a delegate brief**: its one call
site passes a queued task's description. The subagent entry point (naru task
2684, "Subagent spawns" below) applies the rule as a fixed table for the named
agent types, and through this same prompt for a general-purpose spawn whose
brief declares a role.

Effort is untouched (medium everywhere). Out of scope: author size hints,
effort routing, mid-session switching.
Retrying one level up is naru task 2686 (below).

## naru-live is never routed

The live voice agent always runs what `~/.claude/agents/naru-live.md` says. The
exception is explicit, the **first check** of `route`: an `action` of
`live-agent`, or an `agent` of `naru-live`, returns `Refused` with no model call
and no log line. Any action other than `queue-watcher` is refused too. A unit
test asserts both, and another that neither `live.rs` nor `runner.rs` (the live
spawn path) names `model_router`, and that `model_router::route(` appears
exactly once in `api.rs`, inside `dispatch_task_session`. The subagent entry
point refuses it too, first: a spawn of `naru-live`, and any spawn the live
session itself makes (payload `agent_type` `naru-live`), get no model call
and no log line (`naru_live_a_fork_and_an_explicit_model_are_never_routed`).

## Order of checks and fallback

After the refusal, in order:

1. Switch off (`watchers.model-router: "off"`) -> `opus`, source `disabled`.
2. The resolved `queue-watcher` template (configured or default) has no
   `{model}` -> `opus`, source `disabled`, reason says so. A saved template
   without `{model}` keeps working unchanged and is never routed (no wasted
   call).
3. The log already holds a routed (`haiku`, `reused` or `escalation`)
   decision for this task id -> no call; the next model comes from that
   history (retry one level up, below). A re-dispatch or a cost-guard relay
   never re-routes.
4. Otherwise the Haiku call. The answer must be an object whose `model` is one
   of the four and whose `reason` is non-empty; a missing `risky` reads as
   `true`.
5. On that fresh Haiku pick only, the exploration coin (below).

**Any failure is `opus`, source `fallback`**, with the error (bounded) as the
reason, and never fails or blocks the spawn: `claude` missing, timeout,
non-JSON or no `structured_output`, a disallowed model, an empty reason, an
unreadable config. With the default template and `opus` the spawn argv is what
it was before the router.

## Retry one level up (naru task 2686)

The escape hatch for a wrong pick. When a task that already had a routed
session comes back through the queue-watcher, the next session runs **one
level up** the ladder `haiku -> sonnet -> opus -> fable`; `fable` retries on
`fable`. The model is still chosen once per session start. Everything is read
from the log (`after` in `model_router.rs`); no task column, no migration.

What the latest routed decision's history says, in order:

- **A cost-guard relay** (`Request.relay`, the relay's own
  `dispatch_task_session` call) -> the same model, the same attempt, source
  `reused`. The relay carries one attempt on in a fresh session.
- **The latest decision is `fallback` or `disabled`** -> the last routed
  model, `reused`: that session was not router-chosen, so it does not
  escalate.
- **Its outcome is `failed` with detail `spawn failed`**
  (`model_router::SPAWN_FAILED`, logged by `queue_watcher_tick`) -> the same
  model, the same attempt, `reused`. A process that never started is not a
  model problem.
- **Otherwise it is a retry**: outcome `bounced` (back to `todo`/`backlog`),
  `failed` (the session died, the reaper re-queued or parked it), `done`
  (a reviewer or a person reopened the finished task), or no outcome at all
  (the task came back to the queue while its session was still tracked) ->
  source `escalation`, `attempt` + 1, reason
  `escalation: the sonnet session bounced; one level up to opus`.
- **The cap**: at most `MAX_ESCALATIONS` (2) escalations since the task's
  latest `haiku` pick or park. The retry after that is source `parked`:
  `dispatch_task_session` moves the task to `backlog`, adds a task note
  (`Model router: parked in backlog instead of starting attempt N ...`),
  starts nothing, and only then logs the `parked` line (`log_parked`), so a
  park whose store write failed is retried as a park. A person re-queuing it gets the same model, `attempt` + 1,
  source `reused`, and a fresh budget of two escalations.

So a task picked `haiku` runs at most haiku, sonnet, opus, then parks; one
picked `fable` runs fable three times, then parks.

## Controlled exploration (naru task 2688)

To learn whether a cheaper model would have done the job, a share of routed
sessions runs **one level below** the rubric's pick (`fable -> opus -> sonnet
-> haiku`) on purpose, flagged as an experiment, and the outcome telemetry
(`naru cc router`, the Router review) splits results by arm.

- **The rate** is `watchers.model-router-explore` (`docs/config.md`):
  `0.0..=1.0`, default `0.1`, `0` disables. One plain Bernoulli coin per
  task (`explores` in `model_router.rs`), one global rate.
- **Who can be demoted:** only a fresh `haiku`-source pick of `sonnet` or
  `opus` whose answer says `risky: false`. Never a risky task, never a
  `fable` pick (the rubric's own risk signal), never a `haiku` pick (nothing
  below it), never a `fallback`/`disabled` decision, never naru-live (refused
  before anything). The coin is not even drawn for those. `risky` is the
  Haiku answer's own flag: true for security, persistence or migration of
  data (schemas, files or config users keep), concurrency, the
  spawn/queue/watcher machinery itself, or a `fable` pick.
- **The log line** carries `experiment` (`true|false`), `rubric_model` (what
  the rubric picked; `null` on `fallback`/`disabled`) and `model` (what runs),
  plus `risky` on a `haiku` line. An experiment line's `rubric_model` is one
  level above its `model`.
- **No second flip.** A re-dispatch reads the log (check 3) and never calls
  Haiku or the coin: a relay or a failed spawn reuses the experiment model
  with `experiment: true` (same attempt). Every later attempt has `experiment:
  false` and keeps the task's `rubric_model`.
- **Safety net.** A bounced or failed experiment session is an ordinary retry
  one level up (naru task 2686), which is exactly the rubric's pick: a failed
  experiment costs one retry, and it counts against the two-escalation cap.
- **Randomness** is std's randomly keyed hasher in production (no `rand`
  dependency); the unit tests inject a seeded splitmix64 coin (`Deps.coin`).

Sample size (open question 1). At 10% the opus -> sonnet arm fills slowly and
the sonnet -> haiku arm barely at all: in the replay trial 44 of 50 tasks were
`opus` and 6 `sonnet`; if about half the tasks are risky (17 of the 33
fixtures are; real tasks are not measured yet), 50 tasks a week give ~2 opus
experiments and ~0.3 sonnet ones. The Router
review's `min_n` (6 finished first attempts per arm) then takes about three
weeks for the opus row and many months for the sonnet row. A per-row floor
(explore a row at a higher rate until its arm reaches `min_n`) would fix
that; it is not built (one global rate, open question 2's default). Haiku's
`risky` was checked against the fixtures' `risky` labels with the live test
(open question 3): on 2026-11-10 all 33 matched (0 risky fixtures answered
`false`, 0 of 16 safe ones answered `true`), and the picks stayed 33/33,
median 3.2 s, p95 4.3 s.

## The switch

`watchers.model-router` in `~/.naru/config.json`: `"on"` (default when absent)
or `"off"`. Read on every dispatch, like `stall-minutes`. `PUT
/api/config/watchers {"model_router": "on"|"off"|null}` writes it (anything
else is `422 validation`); no Settings UI.

## The log

`<naru home>/logs/model-router.log` (`~/.naru/logs`, or under `NARU_HOME`, so the
dev env writes `~/.naru-dev/logs`), one JSON object per line, best effort (a
write failure is one stderr line). Two kinds:

```json
{"kind":"decision","time":"2026-11-10 09:41:02","task_id":2683,"project_id":2,"input":"<first 400 chars>","hint":null,"model":"sonnet","reason":"...","source":"haiku","latency_ms":2104,"attempt":1,"experiment":true,"rubric_model":"opus","risky":false}
{"kind":"outcome","time":"2026-11-10 10:12:40","task_id":2683,"outcome":"done","status":"done","detail":"session 1a2b3c4d ended"}
{"kind":"parked","time":"2026-11-10 11:02:13","task_id":2683,"project_id":2,"model":"fable","attempt":3,"reason":"the fable session bounced; 2 retries one level up are spent, parked"}
```

- `source`: `haiku` | `fallback` | `disabled` | `reused` | `escalation`. A
  `reused` decision is logged too. `attempt` (naru task 2686) is 1 for the
  first routed session and one more per retry; a line without it reads as 1.
  A `parked` line stands in for the decision of a retry that was not started. `hint` is always `null` (reserved for the author size hint, a
  later slice). `"costly":true` is added when the model is `fable`.
- An **outcome** is logged by `forget_dispatch` (the one place a dispatched
  session leaves `todo_dispatched`), from the task's status at that moment:
  `done` -> `done`; `todo` or `backlog` -> `bounced`; cancelled, deleted, or
  still `in_progress` -> `failed`. A session that **died** with its task
  `in_progress` is `failed` even though the reaper then re-queues (`todo`) or
  parks (`backlog`) the task: the reaper logs that outcome just before
  `forget_dispatch`, whose own line is then a no-op. Only a task moved by hand
  (`Abandoned::Moved`) is read from its status. A session that was *superseded* (re-dispatch,
  cost-guard relay) logs no outcome, the task goes on. A spawn that did not
  start (`agents::spawn_bg` failed, in `dispatch_task_session`) logs `failed`
  (`detail: spawn failed`); a failure before the router ran (seeding) logs
  nothing. An outcome is appended only when the task's latest decision has no
  outcome after it **and** is the attempt the session was started for (each
  `todo_dispatched` entry carries its `attempt`, naru task 2686): one per
  decision, a task that was never routed logs nothing, and a session that
  ends after its task was dispatched again (the reaper and the queue-watcher
  run concurrently) never closes the newer attempt's decision.
- An outcome line needs the spawn to print a job receipt: a template that
  prints none is never tracked in `todo_dispatched`, so it logs a decision and
  no outcome.
- A refusal (naru-live) logs nothing.
- A third kind, `subagent`, is a subagent spawn's decision ("Subagent
  spawns" below). Every task-side reader keys on `kind: "decision"`, so these
  lines never reach the retry history, outcome pairing, `naru cc router` or
  the Router review.

## Subagent spawns (naru task 2684)

The second entry point: a subagent or delegate a session starts (the `Agent`
tool, older `Task`) gets its model from the router, chosen **once, at spawn**,
and it **overrides** the agent definition's frontmatter model (the person's
decision: the frontmatter is not a floor). `route_subagent` in
`model_router.rs`, reached only through `naru model-router subagent`, which
the `agent-route.sh` hook calls (`docs/agent-route.md`). The hook sets
`tool_input.model` in its `updatedInput`; measured on Claude Code 2.1.322, an
`updatedInput.model` beats the frontmatter (a `model: haiku` agent ran
`claude-sonnet-5-5` with the hook, `claude-haiku-5-5` without).

`naru model-router subagent` reads the `PreToolUse` payload on stdin and
prints `{model, source, reason, latency_ms}`; `model: null` leaves the spawn
untouched. In order:

1. **Refused**, no call and no log line (`source: "refused"`): the spawning
   session is naru-live (the payload's `agent_type`, set for a session started
   with `--agent`), the target is `naru-live`, the target is `fork` (a fork
   always runs its parent's model), or the spawn already names a `model` (the
   spawning agent chose it; only the frontmatter default is overridden).
2. **The switch** (`watchers.model-router`, the same one): off -> `disabled`,
   model null; unreadable config -> `fallback`, model null.
3. **The role table** (`ROLE_MODELS`), no model call, source `rule`: recon,
   Explore, researcher, claude-code-guide, verifier, ui-verifier,
   diff-reviewer, naru-retro, inbox-triage, ux-designer, implementer,
   swift-implementer -> `sonnet`; planner, Plan, supervisor -> `opus`. This
   is the delegate-brief role rule as a table (naru task 2690): the role
   decides, never the task the brief embeds.
4. **Haiku**, source `haiku`: any other spawn (untyped, `general-purpose`,
   `claude`, an unknown named type) goes through the same prompt, schema and
   allowed set as a queued task, with the brief (the prompt, else the
   description) as the text. An unknown named type is prefixed `You are the
   agent "<type>".`, so the role rule applies; a general-purpose brief that
   declares its own role is routed by that role by the prompt itself. The
   call's timeout is **8 s** (`SUBAGENT_TIMEOUT`), shorter than a task's 15 s,
   because the spawning tool call waits on it.
5. **Any failure** (timeout, non-JSON, a model outside the set, an empty
   reason) -> `fallback`, model null: the spawn runs its frontmatter model.
   This is the opposite of a queued task's fallback (`opus`): a subagent
   already has a sane default.

Not applied to subagents: controlled exploration (naru task 2688), retry one
level up (naru task 2686) and parking. Each spawn is decided on its own.

Each decision but a refusal is one line:

```json
{"kind":"subagent","time":"2026-11-10 19:40:02","session_id":"…","session_agent":"supervisor","subagent_type":"verifier","description":"<first 120 chars>","input":"<first 400 chars of the prompt>","model":"sonnet","reason":"Role verifier: the role table","source":"rule","latency_ms":0}
```

`costly: true` is added on `fable`. No `task_id`: the hook does not know the
task.

Cost per spawn: a rule-routed spawn adds ~25 ms of hook time (gate, debug
build, including the swap step); a Haiku-routed one adds the call (see the
live test below). Fixtures: `src/testdata/model_router_subagent_fixtures.json`,
18 `{subagent_type, prompt, expected}` briefs, eight named types and ten
general-purpose/untyped ones, four of those declaring a role. The live test

```bash
cargo test model_router_live_subagent_fixtures -- --ignored --nocapture
```

asserts all but two as expected, the Haiku-routed p95 under 5 s and every
rule-routed one under 0.5 s. `scripts/agent-route-check.sh` is the hook's
gate.

## Fable cost

`fable` is the most expensive model (about 2x Opus per token). It is **allowed**
and flagged `costly` in the log, so the log shows how often it is chosen and
whether it was warranted. Open question for the owner: keep it automatic, or cap
at `opus` until the log shows it pays off.

## Fixtures and the live test

`src/testdata/model_router_fixtures.json`: 33 task texts `{text, expected,
ambiguous, risky}` (`risky` labelled for controlled exploration: 17, every
`fable` one among them), nine each for `haiku` and `fable` (the last four of each mirror
the row's examples, naru task 2690), five each for `sonnet` and `opus`, plus
five ambiguous (conflicting or missing signals; expected is the higher model). `cargo test model_router` checks the
file's shape and every pure path (parse and validate, switch off, fallback,
reuse, outcome pairing, the refusal) with an injected call and a temp log.

The live acceptance test runs every fixture through the real Haiku call (no log,
no reuse) and prints a confusion table, each miss, and latency min/median/p95:

```bash
cargo test model_router_live_fixtures -- --ignored --nocapture
```

It asserts all but at most two as expected, every ambiguous fixture on the higher
model, no fixture labelled risky answered `risky: false` unless it went to
`fable` (a demotion leak), and p95 under 10 s. It uses the person's Claude subscription through
`claude -p`.

### Replay of real session starts (naru task 2690)

```bash
NARU_ROUTER_REPLAY=/path/samples.json cargo test model_router_live_replay -- --ignored
```

reads a JSON array of `{"prompt": ...}` and writes the picks, in order, to
`<file>.out.json` as `{model, reason, latency_ms}`. It asserts nothing about
the picks: the models past sessions ran on are not ground truth, so the rubric
is never tuned to reproduce them.

## Telemetry (naru task 2687)

`naru cc router [--since D] [--until D]` prints one row per decision line in
the log, joined to the session it started and to how its task went, so
quality, cost and time per model can be watched over time. Derived on every
read from the log and the cc tables (`core::cc::router`), nothing stored, no
migration, no route (CLI only). Output `{rows, decisions, joined, escalations,
parked, since, until}`; `joined / decisions` is the join coverage,
`escalations` counts rows with source `escalation` and `parked` the log's
`parked` lines (retries spent, no session) in the window (naru task 2692).
`since`/`until` bound the **decision** time and parse exactly as `cc
scorecard`'s.

- **The join.** A decision line carries no session id: it is logged before
  the spawn, and Claude Code does not store the `--name`. So a decision for
  task T at time t joins the earliest session whose first prompt links to T
  (`Store::cc_task_links`, the scorecard's link) that starts in
  `[t - 5 s, t + 10 min)` and before T's next decision, each session used
  once. The log format is unchanged. A session started by hand on a routed
  task outside that span is not a routed session and has no row; a decision
  whose spawn failed or whose transcript is not ingested yet is a row with
  every session field `null`.
- **From the log:** `task_id`, `project_id`, `decided_at`, `model`, `reason`,
  `source`, `router_latency_ms`, `costly`, and `outcome` / `outcome_status` /
  `outcome_detail` (the task's first outcome line between this decision and
  its next; `null` while the session runs). `attempt` is the line's logged
  `attempt` (naru task 2692): a cost-guard relay or a failed-spawn reuse logs
  its own `reused` decision with the same attempt, so each session has its own
  row and several rows can share one attempt and one Haiku pick. The Router
  review leaves a `spawn failed` row (no session) out of finished and
  first-try counts, so its reuse is the attempt's one counted row. A line from before attempts were
  logged counts in log order (1, 2, ...).
- **From the session** (`core::cc::session_detail`, so exactly what `naru cc
  session <id>` prints): `session_id`, `start`, `end`, `duration_minutes`,
  `tokens`, `total_tokens`, `est_cost_usd`, `models_used`, `agent_runs`.
- **From the task:** `task_done` and `task_requeued` are the scorecard's own
  two facts for that session (`CcTaskLink`), so they match `cc scorecard`;
  `requeues` counts `in_progress` -> `todo`/`backlog` moves at or after the
  session start and before the task's next decision (this attempt's own); `landed_first_try` = `attempt` 1, done, no requeue;
  `reopened` = moved out of `done` (to `todo`, `in_progress` or `backlog`)
  after the session ended; `follow_up_tasks` = later tasks in the same
  project, created at or after the session start, whose description says
  `follow-up to|of|from|on`, `regression from|in|of|by`, `broken by` or
  `fix for|to|of` `[the] [naru|mesa] task [#]N`. Measured on the real db
  (2026-11-10): a bare `task N` citation with a fix word matched 342 pairs and
  about three in four were not fixes; the phrase rule matched 20, none a false
  follow-up, but only about a quarter are fixes, the rest extensions. It is a
  follow-up list, not a fix count. A retry one level up (task 2686) will show
  as a higher `attempt` with its own `model`.
- **Always `null`:** `review_rounds` and `verifier_verdict`. No structured
  verdict is stored anywhere: subagent replies are a 200-char prose preview,
  no task note uses a `verifier: PASS|FAIL` line, and `result` mentions PASS
  only in free prose. A final-note convention would make it derivable; that is
  a separate task.
- **Escalations are not picks** (naru task 2692). `escalated` is true on an
  `escalation` row and on a `reused` row carrying one on (a relay, a
  failed-spawn reuse, a re-queued park): that session's model came from the
  retry ladder, not the rubric, so pick accuracy leaves it out.
  `after_experiment` is true on an escalated row whose escalation retried an
  `experiment: true` attempt (its own line logs `experiment: false`).
- **Control group.** `fallback` and `disabled` decisions are rows too, flagged
  by `source`.
- **Exploration arm.** `experiment` and `rubric_model` are the decision line's
  own fields (controlled exploration, naru task 2688), passed through as
  logged, `null` on a line without them (naru task 2689).

## Router review (naru task 2689)

A workflow, **"Router review"** (voice phrase "review the router", bound to
the naru project), reads `naru cc router` and files a review a person acts on.
**"Router review (weekly)"** runs it every Monday 08:00 UTC (a `schedule` entry
and a `subworkflow` node: one workflow cannot have two entry nodes). Both are
built by `scripts/router-review-workflow.sh [--project P] [--task N]
[--replace]` in the db the environment points at. It **never edits** the
rubric, this doc or the router prompt; it only proposes.

The graph: trigger -> `cli` "Score router telemetry" (one jq pass over `naru
cc router --since`) -> `branch` "Any flags?" (`Flags raised: [1-9]`).
No flag: `output` inbox "File report". Flags: `file` reads this doc,
`prompt` (opus, tool-less `claude -p` through the `workflow-prompt` template)
drafts the before/after wording, `output` inbox "File report + proposals",
then a `gate` (one day): approved files a **backlog** task in the project
holding the report and proposals; rejected (or timed out) logs it to the
`router-review` workflow log. Inbox items are `task-summary` (they wait for a
person; the inbox watcher only triages change requests), filed against task
2689.

The report has four sections: (1) per model, experiments and escalated rows
excluded (shown as their own count, with the parked count): sessions,
finished, first-try landing (of finished first attempts), bounced, failed,
retried up (a finished non-done session whose task's next attempt ran a
higher model), median cost and wall-clock; (2) exploration: per
`rubric_model`, the experiment arm vs the control (rows on that model from a
`haiku`/`reused` pick), each counted in attempts so a relay is not a second
one; (3) flags with their numbers; (4) proposals.

Flags, each only at **n >= min_n** (else listed under "Not enough data"):
a model's bounce rate over `max_bounce` (with the commonest words of the
bounced reasons); an exploration arm landing within 10 points of its control;
a model never picked in >= 3*min_n Haiku picks; a delegate brief (`Role
<name>:` reason) for a sonnet role routed elsewhere; fallback share over
`max_fallback`; Haiku-call latency p95 over `latency_budget_ms`; the newer
half's median cost over 1.25x the older half's (min_n per half). Input words
tune it: `min_n=6 days=28 since=YYYY-MM-DD max_bounce=0.30 max_fallback=0.10
latency_budget_ms=10000` (the defaults).

A `cli` node's `PATH` puts `~/.local/bin` first (`proc::bash`), so in a dev
env the workflow scores with the **installed** `naru`, not a fresh build;
an installed binary older than this task prints no `experiment` field, so
experiment sessions count as ordinary picks and section 2 says there are none.

## Known limits

- A queued task's text that itself opens with a role declaration is read as a
  delegate brief and routed by that role: it can reach `sonnet` (or `opus`)
  that way, never `haiku` or `fable`. The text is untrusted, so this is a way
  to down-route a hard task to `sonnet`, nothing more.

- Any return of a routed task to the queue is a retry, including a person
  re-queuing or reopening it for unrelated reasons; the cap bounds the cost.
- Routing is serial inside the queue-watcher's claim loop: each task's Haiku call
  takes up to 15 s (typically 2-5 s) before the next task is dispatched.
