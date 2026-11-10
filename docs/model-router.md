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
  schema is `{reason: string, model: haiku|sonnet|opus|fable}`, both required, `reason` first so the model states its reasoning before it commits (measured: with `model` first Haiku named a fable signal in its reason and still answered opus).
- The task text is untrusted. It rides in the prompt between `<<<TASK` and
  `TASK>>>`, capped at 6000 characters, and the prompt says it is data, not
  instructions.

## The rubric

Derived from Anthropic's "Which Claude model should you build with?" (Opus at
medium effort is the default for most coding work; a clear spec alone does not
justify a smaller model). This table is in the router prompt verbatim:

| Signals in the task text | Model |
|---|---|
| Read-only or mechanical: summarize/read logs/search/list/tag/classify/extract, rename, format, docs-only or comment-only edit, no code logic change, easy to verify at a glance | haiku |
| Well-scoped change with a clear spec and a named check: single-file or few-file bug fix, small feature iteration, add a test, config/doc tweak with code, follows an existing pattern | sonnet |
| DEFAULT and anything uncertain: multi-file feature, debugging with unknown cause, cross-module change, UI change needing live QA, anything touching concurrency, persistence/migrations of data, security, the spawn/queue machinery itself | opus |
| Hardest work: large refactor or migration, architecture/design work, deep research or analysis, orchestrating many subagents, long unattended run, task text says it is large or high risk | fable |

Rules, also in the prompt: when signals conflict or are missing, choose the
**higher** model (never down-route on doubt); never `haiku` for a task that
edits code logic; a task text too short or vague to show its scope (no named
file, no named check, a sentence or two) counts as **missing** signals and goes
to `opus`, and `haiku` needs the text itself to make explicit that the work is
read-only or mechanical and changes no code logic; the `reason` is one sentence
quoting the signal used. A task text that itself says the work is large, big,
risky or high risk, or restructures a whole subsystem, is a `fable` signal that
outranks the `opus` default for the spawn/queue machinery; when one part of the
text is small and another is a `fable` signal, the `fable` signal decides.

Effort is untouched (medium everywhere). Out of scope for this slice: subagent
model override, author size hints, retrying one level up, effort routing,
mid-session switching.

## naru-live is never routed

The live voice agent always runs what `~/.claude/agents/naru-live.md` says. The
exception is explicit, the **first check** of `route`: an `action` of
`live-agent`, or an `agent` of `naru-live`, returns `Refused` with no model call
and no log line. Any action other than `queue-watcher` is refused too. A unit
test asserts both, and another that neither `live.rs` nor `runner.rs` (the live
spawn path) names `model_router`, and that `model_router::route(` appears
exactly once in `api.rs`, inside `dispatch_task_session`.

## Order of checks and fallback

After the refusal, in order:

1. Switch off (`watchers.model-router: "off"`) -> `opus`, source `disabled`.
2. The resolved `queue-watcher` template (configured or default) has no
   `{model}` -> `opus`, source `disabled`, reason says so. A saved template
   without `{model}` keeps working unchanged and is never routed (no wasted
   call).
3. The log already holds a `source: haiku` decision for this task id -> reuse
   it (source `reused`, no call). A re-dispatch or a cost-guard relay does not
   re-route.
4. Otherwise the Haiku call. The answer must be an object whose `model` is one
   of the four and whose `reason` is non-empty.

**Any failure is `opus`, source `fallback`**, with the error (bounded) as the
reason, and never fails or blocks the spawn: `claude` missing, timeout,
non-JSON or no `structured_output`, a disallowed model, an empty reason, an
unreadable config. With the default template and `opus` the spawn argv is what
it was before the router.

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
{"kind":"decision","time":"2026-11-10 09:41:02","task_id":2683,"project_id":2,"input":"<first 400 chars>","hint":null,"model":"opus","reason":"...","source":"haiku","latency_ms":2104}
{"kind":"outcome","time":"2026-11-10 10:12:40","task_id":2683,"outcome":"done","status":"done","detail":"session 1a2b3c4d ended"}
```

- `source`: `haiku` | `fallback` | `disabled` | `reused`. A `reused` decision is
  logged too. `hint` is always `null` (reserved for the author size hint, a
  later slice). `"costly":true` is added when the model is `fable`.
- An **outcome** is logged by `forget_dispatch` (the one place a dispatched
  session leaves `todo_dispatched`), from the task's status at that moment:
  `done` -> `done`; `todo` or `backlog` -> `bounced`; cancelled, deleted, or
  still `in_progress` -> `failed`. A session that **died** with its task
  `in_progress` is `failed` even though the reaper then re-queues (`todo`) or
  parks (`backlog`) the task: the reaper logs that outcome just before
  `forget_dispatch`, whose own line is then a no-op. Only a task moved by hand
  (`Abandoned::Moved`) is read from its status. A session that was *superseded* (re-dispatch,
  cost-guard relay) logs no outcome, the task goes on. A failed spawn in
  `queue_watcher_tick` logs `failed` (`detail: spawn failed`). An outcome is
  appended only when the log holds a decision for that task id with no outcome
  after it: one per decision, and a task that was never routed logs nothing.
- An outcome line needs the spawn to print a job receipt: a template that
  prints none is never tracked in `todo_dispatched`, so it logs a decision and
  no outcome.
- A refusal (naru-live) logs nothing.

## Fable cost

`fable` is the most expensive model (about 2x Opus per token). It is **allowed**
and flagged `costly` in the log, so the log shows how often it is chosen and
whether it was warranted. Open question for the owner: keep it automatic, or cap
at `opus` until the log shows it pays off.

## Fixtures and the live test

`src/testdata/model_router_fixtures.json`: 25 task texts `{text, expected,
ambiguous}`, five per model row plus five ambiguous (conflicting or missing
signals; expected is the higher model). `cargo test model_router` checks the
file's shape and every pure path (parse and validate, switch off, fallback,
reuse, outcome pairing, the refusal) with an injected call and a temp log.

The live acceptance test runs every fixture through the real Haiku call (no log,
no reuse) and prints a confusion table, each miss, and latency min/median/p95:

```bash
cargo test model_router_live_fixtures -- --ignored --nocapture
```

It asserts at least 23/25 as expected, every ambiguous fixture on the higher
model, and p95 under 10 s. It uses the person's Claude subscription through
`claude -p`.

## Known limits

- A reused decision never escalates: a task that bounced after a `sonnet` pick
  runs on `sonnet` again (retry one level up is a later slice).
- Routing is serial inside the queue-watcher's claim loop: each task's Haiku call
  takes up to 15 s (typically 2-5 s) before the next task is dispatched.
