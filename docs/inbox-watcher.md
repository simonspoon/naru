# Inbox watcher

`mesa serve --watch-inbox` starts a periodic background loop that auto-triages
the global inbox: for every pending **change request** it starts a detached
`naru __job inbox-triage` process that decides the item with two tool-less
`claude -p --json-schema` calls and **applies the answer itself** through
`Store` (naru task 1691), so items stop accumulating until a human gets to
them. The calls' command is the default of the **`inbox-watcher`** key in
`~/.mesa/config.json` and is user-configurable (`docs/config.md`): `{id}` is
the item id, `{name}` the session name derived below, `{model}` the pass's
model, `{prompt}` the context Naru gathered and `{schema}` the verdict schema.
A saved `--bg` template is ignored on read and refused on save — the job reads
result JSON, which a `--bg` receipt is not.

## The triage — two passes, Naru applies

Triage used to be a `claude --bg --agent inbox-triage` session with Bash and
`naru` commands (mesa task 1168), plus a reaper to stop the session afterwards
(mesa task 1192). An agent holding a shell and an attacker-writable request
body was the wrong shape for "pick one of five verdicts", so since naru task
1691 the model has **no tools** and Naru does every read and every write
(`core::inbox_triage`). The `inbox-triage` library built-in
(`INBOX_TRIAGE_DEFINITION`, `docs/library.md`) is kept for manual
`claude --agent inbox-triage` use; the watcher no longer spawns or seeds it.

- **Pass 1** (`haiku`) is handed the rules, the item (its body framed as
  untrusted data, cut at 6 KiB), every non-archived project (`#id name —
  description line — repo path / no repo`) and, for up to three **candidate**
  projects — the item's origin project, plus up to two whose name appears as a
  whole word in the body — their open tasks (≤40, newest first), tasks done in
  the last 30 days (≤15, with their artifact) and the commits in their repo
  since the item was filed (≤25). The prompt is one argv word, so it is bounded
  by `llm::AGENT_PROMPT_MAX` (24 KiB): sections are added in that priority order
  and each list is cut with an "(N more omitted)" marker. It answers one
  verdict: `sharpen {project_id, reason}`, `duplicate {task_id, reason}`,
  `shipped {evidence, reason}`, `not-actionable {reason}` or `hold {reason}`.
- Naru **validates the verdict against what it gathered** (`validate_verdict`):
  a `project_id` not in the listed projects, a `duplicate` task that is not one
  of the listed open tasks, `shipped` evidence that is neither a >=7-char hex
  prefix of a gathered commit nor `task <N>` naming a listed done task, or a
  blank reason, becomes a `hold`. The model can only choose among things Naru
  showed it. Reasons are cut to 1000 chars.
- **Pass 2** (`sonnet`), only for `sharpen`, restates the request as a task
  (`title`, `body`, `acceptance`, `priority`) from the chosen project's own
  context: its open task names, last 20 commits and the top of `git ls-files`.
  It runs **before any write**, so a failed pass 2 leaves the item pending and
  nothing changed.
- **Apply** (`apply`, `apply_sharpen`): `duplicate` appends
  `From inbox item <id> (<author>, <created_at>):` plus the item's text to the
  task's `result` and archives the item `duplicate of task <id>: <reason>`
  (outcome `duplicate`); `shipped` archives `shipped in <evidence>: <reason>`;
  `not-actionable` archives with the reason (outcome `not-actionable`);
  `sharpen` runs `assign_inbox_item` (a **backlog** task, the item archived
  `converted-to-task`) and fills the task in, the description being
  `<title>\n\n<body>\n\nFrom inbox item <id> (<author>, <created_at>),
  originating task <task_id>.`; `hold` marks the item read and writes nothing
  else. The item is re-read before the calls and again before the write, so
  one archived, assigned or deleted meanwhile is skipped untouched.

Never guess a project, never delete an item whose request is not captured
somewhere first, never edit project code: the job has no way to. The sibling of
the todo watcher (`docs/todo-watcher.md`), over a different queue. **Off by
default**, for the same reason: it spends model calls with no user request
behind it, so it must not fire just because someone ran `mesa serve`.

The two watcher flags (`--watch-todo` and `--watch-inbox`) are **independent**
— neither implies the other, and each drives its own interval loop with its own
tick constant. `--watch-inbox` alone never claims a task or dispatches
`/execute-mesa-task`.

## How one tick works

`inbox_watcher_tick` in `src/api.rs`:

- Lists the whole inbox (`Store::list_inbox_items(None)`), keeps the items
  that are **pending** — `api::inbox_item_pending` (`inbox_triage::is_pending`),
  the one definition: the `kind` is `change-request` (mesa task 846 — a
  `task-summary` is an agent reporting to a person, so there is nothing to
  triage; the kind never changes, so the skip is permanent rather than a wait,
  and a skipped item is not even claimed in the dedup set) **and** the item is
  not archived (mesa task 1192 — archiving with a reason is the triage's own
  verdict on a duplicate, shipped or non-actionable request, and the listing
  still carries the row; an un-archived item is pending again and is picked
  up) — then dispatches **every** one of those this process has not already
  dispatched, all in the same tick. Unlike the todo watcher, which is
  naturally capped at one agent per project, the inbox is one **global** queue
  with no per-project structure to pace it. A server started against a large
  backlog therefore starts that many jobs at once; that is the chosen
  behavior, not an oversight (mesa task 544).
- A dispatch is `memory_job::spawn(Job::InboxTriage { item_id, name })`: the
  server's own binary re-run as `naru __job inbox-triage --item <id> --name
  <name> --dir <workspace>`, in its own process group, with `NARU_DB` pointing
  at the db the server holds and stdout/stderr appended to
  **`logs/inbox-triage.log`** in Naru's home directory (the memory jobs keep
  `logs/memory-jobs.log`). Each job leaves **one JSON line** there — the report
  (`kind: inbox-triage`, `item_id`, `outcome`, ...) or an `error` object. The job
  exits by itself, so there is no session to remember or reap.
- cwd is **`~/.mesa/workspace`**, not a project folder — the same
  `config::workspace_dir()` the global Terminal page uses, created on demand.
  An inbox item belongs to no project (`project_id` is null for its whole life,
  see `docs/inbox.md`), so there is no `local_path` to run in; the job derives
  the project itself from the context it gathers.
- The session name is `inbox <id>: <first non-empty body line>`, truncated to
  60 **chars** (not bytes — bodies are free text and may be non-ASCII). It
  reaches `claude` as `--name`, so each call is identifiable in `/resume` and
  the transcript list.
- The store lock is dropped before the spawn (`db_path` is read under it): the
  job is a separate process and opens its own `Store`.

## The dedup set — why it exists

An inbox item has **no status column** to claim with (an item *is* the record;
`docs/inbox.md`), so there is no equivalent of the todo watcher's flip to
`in_progress`. The stand-in is `AppState::inbox_dispatched`, an in-memory set
of dispatched item ids.

It is load-bearing, not an optimization. Three of the triage's outcomes leave
the live inbox — a real request is converted into a backlog task, a duplicate,
shipped or non-actionable one is archived — but the others, a **hold** (no
confident answer, or a verdict Naru rejected) and a **failed call**, leave the
item pending. Without the set, that item would start a job every tick, forever.

- Ids are claimed **before** the spawn, closing the window in which a second
  tick fires while the job is still starting up.
- A spawn failure (the job process could not be started) **releases** the id,
  so a transient failure retries on the next tick instead of silently dropping
  the item — the inbox equivalent of the todo watcher's revert-to-`todo`. A job
  that started and then failed does **not** release it.
- The set is pruned each tick to the ids still present in the inbox, so it
  cannot grow unboundedly on a long-lived server. (SQLite may reuse a deleted
  row's id; pruning is what makes that safe — a reused id is a genuinely new
  item and should be triaged.)
- It is deliberately **not persisted**. A restart re-triages whatever is still
  sitting in the inbox. That is the recoverable direction: a duplicate triage
  of an item is cheap, whereas a permanently skipped item is invisible.
  Persisting it would need a schema migration to store state about an entity
  whose whole design is "an item *is* the record".

## Other invariants

- The watcher **never mutates an inbox item itself**: the job does, through the
  guarded `Store` methods (`assign_inbox_item`, `set_inbox_item_archived`,
  `mark_inbox_item_read`, `update_task`), and only after validating the verdict.
  There is no watcher-side delete.
- Inbox bodies are **untrusted data**. The body reaches `claude` only inside the
  prompt, framed as data, as a shell-quoted `{prompt}` word and in the
  `--name` (`config::substitute_script`), and nothing in Naru interprets it. The
  model has no tools, and its verdict is checked before it is applied.
- The tick cadence is a fixed internal constant (`WATCH_INBOX_TICK`, 60s), not
  user-configurable. `MESA_WATCH_INBOX_TICK_MS` overrides it, a test-only seam
  mirroring `MESA_WATCH_TODO_TICK_MS`; `NARU_SELF_BIN` names the program a job
  re-runs (the other test seam).
- The flag is propagated through the web UI's **Restart Server** action the
  same way `--lan` and `--watch-todo` are: `serve`'s post-shutdown relaunch
  re-execs the binary with `--watch-inbox` appended when it was set. (The
  in-memory dedup set does not survive that relaunch — see above.)
- No CLI or web surface of its own beyond the `serve` flag (and the hidden
  `__job` self-command), matching the todo watcher and the agents surface's
  "no `mesa agent` CLI" precedent.
- Gate: `scripts/inbox-watcher-check.sh` against a stub `claude` that answers
  `-p` calls from staged `<model>-<item id>.json` files (and logs `--bg`/
  `agents`/`stop`, which the gate asserts are never called), with `HOME` pointed
  at a throwaway dir so the `~/.naru/workspace` cwd assertion is hermetic: flag
  on/off, the `-p --model haiku --tools "" --strict-mcp-config --output-format
  json --json-schema` argv and no `--bg`, no agent definition seeded, the prompt
  carrying the body byte-identical and the project list (a `$()` body running
  nothing), one JSON line per job in `logs/inbox-triage.log`, one check per
  outcome (not-actionable, duplicate, shipped with a real and a made-up sha,
  sharpen through sonnet into a backlog task, hold, a failed call), no
  re-dispatch of a held or failed item, a task-summary never dispatched, a new
  item picked up, the whole queue in one tick, independence from `--watch-todo`,
  a restart re-dispatching the pending items but never the settled ones, and an
  unstartable job dispatching nothing without crashing the server. Rust unit
  tests cover `inbox_session_name`, the dispatch-once/pick-up-new behaviour,
  claim release on a job that cannot start, the archived-after-restart rule,
  and in `core::inbox_triage` the schemas, the bounded prompts, each verdict's
  application, hallucinated ids, the skip of a non-pending item and a failed
  pass 2 writing nothing.
