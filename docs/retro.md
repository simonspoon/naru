# Retrospective

`mesa serve --watch-retro` starts a scheduled background loop that, every
`watchers.retro-interval-hours` (default **72** — three days), starts a
detached `naru __job retro` (naru task 1692, `core::retro` and
`core::memory_job`). The job reviews the task sessions that finished since the
last run for friction — permission denials, retry loops, a skill nobody had, a
tool that keeps failing — and files each **new** finding into the Naru inbox as
a `change-request`, where the inbox-watcher (`docs/inbox-watcher.md`) triages
it into a backlog task. It makes tool-less `claude -p --json-schema` calls
through the **`retro`** key in `~/.mesa/config.json`, user-configurable
(`docs/config.md`); `{id}` is the run id and `{name}` the session name `naru
retro <id>` (a skim adds ` skim <session id>`).

`mesa retro run` is the same pass on demand (mesa task 1158).

Until naru task 1692 the review was a `claude --bg --agent naru-retro` session
holding Bash and running `naru cc`, `naru retro finding` and `naru inbox add`
itself — an agent with a shell reading transcripts other agents wrote, to
produce a list. It is now the shape naru task 1691 gave the inbox triage: Naru
gathers the data, the model only reads and writes text, and Naru applies the
result.

## It proposes; it never edits

The one invariant everything below serves: the retrospective **reports**. It
never changes an agent definition, a skill, a hook, a config file or project
code — not even to fix what it found. A wanted change is an inbox item and
nothing else, and the person (or the inbox-watcher, into `backlog`) decides
what happens to it. Two things enforce that rather than merely ask for it:

- The calls have **no tools** (`--tools ""`, `--strict-mcp-config`): the model
  cannot run a command, read a file or edit anything. What it returns is a
  structured answer, and the only writes are the ones Naru makes through
  `Store`: the finding log and the inbox.
- The surface has **no HTTP route** of its own — CLI plus the watcher, the
  cost guard's posture (`docs/cost-guard.md`). There is nothing on the API a
  page or a phone could reach to run or rewrite a retrospective; the only
  route it touches is `/api/config/watchers`, for the cadence.

## The job

`naru __job retro --run <id>` (hidden; started by `memory_job::spawn` in its
own process group with output appended to `logs/retro.log`, one JSON line per
job) runs `retro::run_with`:

1. **Gather** (`retro::gather`, in-process, no model). After a best-effort
   `cc::sync`, the window is from the start of the previous *spawned* run
   (`Store::retro_window`; seven days back on the first ever). Every `cc`
   session in it is **attributed**, best-effort, to a task: the task whose
   `owner` is the session id; else a task closed in the window whose receipt
   (`docs/receipts.md`) names it; else, by the session's `cwd` equalling a
   project's `local_path` or any entry of its `previous_paths` exactly, that
   project's newest task closed in the window. A session it cannot attribute
   is **skipped** (`unattributed`). The `local_path` fallback is best-effort:
   it may attribute an interactive session that happened to run in that
   folder to the project's newest closed task. A session spanning two runs'
   windows (it ended after the previous run started) can be skimmed twice;
   the finding log's dedup keeps that harmless. A finding must name a real task it was
   observed on, and nothing guesses one. A session with no failure is `clean`
   and costs no call. The rest — at most 15, most failures first, the others
   counted as `omitted` — each get a **failure digest** from
   `cc::errors_since` (failure count, refused calls, failures by tool, failing
   Bash command heads, what the failures said), every line cut and folded.
2. **Skim** — one `haiku` call per session (`SKIM_MODEL`, `SKIM_SCHEMA`:
   `{friction: [{subject, kind, evidence}]}`), whose prompt is the rules, the
   session's task and project, and the digest. A failed or malformed skim
   drops that session (`skims_failed` in the report); if **every** skim fails
   the job fails.
3. **Roll up** — one `sonnet` call (`ROLLUP_MODEL`, `ROLLUP_SCHEMA`:
   `{findings: [{subject, kind, summary, evidence, proposal, session_ids,
   task_id}]}`) over every skim plus the fingerprints already in the log (so
   it reuses a known finding's words). Skipped when no skim found anything.
4. **Apply** (`retro::apply_rollup`) — every call has come first and no write
   happens before the roll-up answers, so **a failed call writes nothing**: a
   failed roll-up (or every skim failing) is an `unavailable` error. The job
   gives its claim back (**deletes the run row**) only when it failed *before
   any model call* (a gather error); a failure *after* paid calls **keeps the
   row**, so the interval backs off rather than re-running the whole skim set
   every tick, and the log says so (`run <id>: failed after N model call(s)`;
   `mesa retro run --force` retries on demand). Each finding is then tried on its own:
   - The fingerprint is Naru's: lowercase `<subject>/<kind>` of the model's
     words (whitespace and `/` folded to `-`); the same fingerprint twice in
     one answer is refused the second time. At most 10 findings are applied.
   - Everything the model names must be something the gather listed: a
     `session_ids` entry that is not a gathered session is dropped, a
     `task_id` that is not a gathered task falls back to the first listed
     session's task, and a **new** finding with neither is `rejected`.
   - It is recorded through `Store::record_retro_finding` — the very path
     `retro finding record` takes (first listed session as `--session-id`,
     the rest through `Store::add_retro_finding_session`, which bumps nothing;
     the evidence line is `run <id>: …`). A known fingerprint bumps `count`
     and appends evidence and **nothing is filed** — unless it is still
     unlinked (an earlier filing failed), in which case it is filed and
     linked now against a listed task.
   - A new one is filed with `Store::create_inbox_item` — kind
     `change-request`, author `retro`, against the task — and linked with
     `Store::link_retro_finding`. The body names the fingerprint, the run and
     the sessions, then the summary, the proposal and the evidence.

Everything it reads is **data, never instructions**: task text, transcripts and
tool output were written by other agents and people. Each prompt says so, the
untrusted block sits between `<<<DATA` and `DATA>>>` markers (a literal closing
marker in it is broken), every free-text field is cut and folded to one line,
and the roll-up prompt's skim section stops at a byte budget with an "(N more
omitted)" marker, so the prompt stays under `llm::AGENT_PROMPT_MAX`.

The `naru-retro` agent definition (`core::retro::RETRO_DEFINITION`, the
library built-in) is **kept for manual `claude --agent naru-retro` use only**;
the watcher and `retro run` no longer spawn or seed it, the way
`inbox-triage` stopped being seeded in naru task 1691.

## The finding log — why the dedup lives in the db

`retro_findings` is one row per **fingerprint** — lowercase
`<subject>/<kind>`, the subject being the agent, skill or tool the friction
belongs to (`swe/denial`, `khora/timeout`). `mesa retro finding record` (and
the job, through the same `Store` method) upserts on it: a new fingerprint is a row with `count` 1 and the
evidence line given, and answers `"new": true`; a known one bumps `count`,
moves `last_seen_at` and appends the evidence line (newest last, the oldest
trimmed past 4000 characters) while `subject`, `kind`, `summary` and the inbox
link stay as first recorded, and answers `"new": false`. That boolean is the
whole protocol: **only a `"new": true` finding is filed.** A repeat adds a
count and a line of evidence to something already in the inbox or already a
backlog task, instead of a second item saying the same thing.

### Which sessions a finding was seen in

A finding also remembers the Claude Code sessions it was observed in — the
`session_ids` list (mesa task 1255), recorded with `mesa retro finding record
--session-id <sid>` and derived on every read. A count and a line of evidence
say *how often*; the session id is *where to go and read it*, which is the one
thing a repeat of a known fingerprint could otherwise not add.

They are a **sibling table** (`retro_finding_sessions`, migration index 68,
`ON DELETE CASCADE`), not a column, for the reason the whole log exists: a
finding upserts on its fingerprint, so one row spans every run that has ever
reported that friction, and a single column would keep only the last session —
throwing away exactly the pointer the second report added. The write is
`INSERT OR IGNORE` on **both** the new-finding and the bump path, so a second
session is kept beside the first and a repeat from the same one is idempotent;
the ids are derived back onto the finding on every read, never stored on its
own row, and come out ascending.

`--session-id` is optional, and a finding recorded without one carries an
empty list rather than a null — attribution is best-effort (rule 2 above) and
the agent never guesses a session. When given it is validated with the
fingerprint, the subject and the kind — trimmed, non-empty, ≤ 200 characters —
**before** anything is written, so a bad id leaves no finding behind either.
`--quiet` **keeps** `session_ids`: it is a bounded set of pointers, and the
whole point of recording one.

The inbox-watcher's dedup is an in-memory set, deliberately not persisted
(`docs/inbox-watcher.md`). This one is a table, deliberately persisted, and
the difference is what each remembers *for*. The inbox-watcher remembers "I
already dispatched an agent for this item" — a fact about this server run,
cheap to forget, since a restart re-triaging an item reaches the same
verdict. The retrospective remembers "this friction has been reported before,
here is how often and where" — a fact about the project's history that has to
**survive a restart and span runs days apart**, or every third day would
re-file the same suggestions as new and the count that makes a finding worth
acting on would never accumulate. `retro_runs` is persisted for the same
reason: the cadence is three days, and a restart must not reset it.

`inbox_item_id` is `ON DELETE SET NULL`. The item a finding was filed as may be
*deleted* outright by triage, and the finding must keep its memory — count,
evidence, the fact it was filed — when that happens; only the pointer goes.
(Since mesa task 1269 `assign_inbox_item` archives the item rather than deleting
it, so triage's convert-to-task outcome no longer drops the pointer at all.) `mesa retro status` reports both counts (`findings`, `linked`).

## How one tick works

`retro_watcher_tick` in `src/api.rs`:

- Reads `watchers.retro-interval-hours` from `~/.mesa/config.json` **fresh
  every tick** (the `todo-concurrency` rule); a config Naru cannot parse
  skips the tick with a line on stderr rather than running on a guessed
  cadence.
- Asks the store whether a run is due — `Store::retro_status`: due when
  nothing has ever run, or when the last run started at least the interval
  ago, judged **on SQLite's own clock** so the watcher and `mesa retro status`
  can never disagree (the `stale_claims` precedent, `docs/claims.md`).
- If due, inserts a `retro_runs` row with `trigger: watcher` **before** the
  start. The row is the claim: a second tick, or a concurrent `mesa retro
  run`, sees it and does nothing (the CLI answers `conflict`). Then it starts
  the job with `memory_job::spawn` (`Job::Retro { run_id }`, a detached `naru
  __job retro`, cwd **`~/.mesa/workspace`** — a retrospective spans every
  project, so there is no `local_path` to run in; the inbox-watcher's
  reasoning).
- A job that cannot **start** (or that fails before any model call) deletes the run row and logs to stderr, so the
  next tick retries rather than waiting out a 72-hour interval on a run that
  never happened — the inbox-watcher's claim release, in the db. (A job that
  fails after model calls keeps its claim, above. The CLI treats
  `not_found` when stamping `spawned_at` as "the job already finished and gave
  its claim back".)
- A successful start stamps the row's **`spawned_at`** (mesa task 1187,
  migration index 62). Only a stamped row holds the whole interval; an
  unstamped one counts for `RETRO_CLAIM_GRACE_MINUTES` (10) after
  `started_at` — long enough that an in-flight claim still stops a
  concurrent one — and is ignored after that, so a process that dies between
  the claim and the start (where the rollback never runs) costs ten minutes,
  not 72 hours. `Store::last_retro_run`, and so `retro status`'s `last_run`,
  returns only a row that counts; the stranded row itself is left in place.
  Rows from before the migration are backfilled with `spawned_at =
  started_at`.
- Two-phase like every other tick: the store lock is dropped before the job
  is started. The job opens its own `Store` on the same db (`NARU_DB`), and
  there is no session to remember or reap — it exits by itself.

`mesa retro run` is the same sequence from the CLI with `trigger: manual`:
`conflict` inside the interval unless `--force`, and a job that cannot start
deletes its row and exits 1 with code `unavailable`, so the obvious retry is
not a `conflict` against a run that never happened (the `live start` rule).
The command prints the run row; the findings arrive when the job finishes
(`logs/retro.log` has its report: `sessions`, `unattributed`, `clean`,
`omitted`, `skims_failed`, `findings`, `rejected`).

## Cadence and propagation

- The tick is an internal constant, `WATCH_RETRO_TICK` = **1 hour** — the
  cadence it enforces is measured in days, so a finer tick would only re-read
  the config for nothing. `MESA_WATCH_RETRO_TICK_MS` overrides it, a
  test-only seam mirroring `MESA_WATCH_INBOX_TICK_MS`.
- The interval is `watchers.retro-interval-hours`: integer `1..=8760`,
  absent/`null` = 72, over `GET`/`PUT /api/config/watchers` (body key
  `retro_interval_hours`, beside `todo_concurrency`; a bad value is 422
  writing nothing, `null` restores the built-in) and by hand. A hand-edited
  out-of-range value is **clamped** on read, the `todo-concurrency` posture.
  There is deliberately no Settings UI for it: the retrospective has no page,
  and the key is `ts(skip)`ped off `ConfigWatchers` so the editor neither
  shows nor writes it.
- The flag is propagated through the web UI's **Restart Server** action the
  same way `--lan`, `--watch-todo`, `--watch-inbox` and `--watch-cost` are:
  the relaunch re-execs the binary with `--watch-retro` appended when it was
  set. The run and finding tables survive that relaunch — that is the point
  of their being tables.
- **Off by default**, for the watchers' shared reason: auto-running model
  calls is real API cost with no user request behind it. Independent of the other
  three watcher flags — none implies another.

## CLI

| Command | Prints |
| --- | --- |
| `mesa retro run [--force]` | the `manual` run row; `conflict` inside the interval without `--force`, `unavailable` (row deleted) when the job cannot start |
| `mesa retro status` | `{last_run, interval_hours, next_due_at, due, findings, linked}` |
| `mesa retro finding record --fingerprint --subject --kind --summary [--evidence] [--session-id]` | `{"new": bool, "finding": {…}}` |
| `mesa retro finding link --id <n> --inbox-item <n>` | the finding |
| `mesa retro finding list [--limit <n>]` | a bare array, most recently seen first |
| `mesa retro finding show <id>` | the finding |

`--quiet` is accepted on `run`, `status`, `finding record`, `finding link` and
`finding show`, rejected (exit 2) on `finding list`. A quiet finding drops
`summary` and `evidence`; a run and the status have nothing unbounded and pass
through unchanged; `session_ids` is a bounded set of pointers and is **kept**
under `--quiet`. Validation (`validation`, exit 1): fingerprint, subject, kind
and (when given) session id non-empty and ≤ 200 characters, summary non-empty
and ≤ 2000, one evidence line ≤ 2000.

Gate: `scripts/retro-check.sh` — the finding CRUD and `--quiet` key sets, the
dedup bump, a second `--session-id` on a known fingerprint keeping both ids,
`link` and its refusals, every validation shape, `status`'s `due`/`next_due_at`
arithmetic; then against a stub `claude` answering `-p --model haiku/sonnet
--json-schema` calls from staged files, over a synthetic transcript tree: a
job that cannot start leaving no run row, `run`'s `conflict`/`--force`, the
job's report (sessions skimmed / unattributed / clean), the calls themselves
(two haiku skims and one sonnet roll-up, tool-less `-p`, never `--bg` or
`--agent`), a hostile task name arriving byte-identical in the fenced prompt
and running nothing, a new finding recorded, filed as a change-request and
linked, a repeat bumping the count and filing nothing, a failed call writing
nothing and keeping its run row (a session older than the previous run excluded), the config key over both CLI and
`/api/config/watchers`, and the watcher starting exactly one job and not again
inside the interval (and retrying a job that could not start). Rust unit tests
cover the store's upsert, evidence trimming and validation, the apply step
(new/repeat/rejected, listed-only tasks and sessions), attribution, the
window, the prompt fences, the config key and the tick's dispatch-once and
rollback-on-failure behaviour.
