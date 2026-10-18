# `naru ask` — a durable question queue (naru task 2014)

An agent or workflow that is blocked on a decision only a person can make
queues a question instead of guessing or stalling.

- `naru ask [--task N] [--session S] <text…>` stores an `open` question in the
  `agent_questions` table (migration; `task_id` is `ON DELETE SET NULL`, the
  session defaults to `CLAUDE_CODE_SESSION_ID`) and returns at once. It never
  waits for the answer.
- If a live conversation is running it also writes a `question` **notice turn**
  (`LiveNotice::Question`, deduped per working span like every notice) so the
  live agent looks. With no live session the queue alone is the record and the
  command still exits 0.
- Rows have a `kind` (naru task 2065): `question` (default) or `notice`, from
  `naru ask --notice …` — a completion report that needs no answer (the task
  loop's last node, the stale-claim sweep). A notice raises **no** notice turn
  and cannot be answered (`conflict`). `read_at` is when the live agent first
  saw it; existing rows are unread questions.
- `naru ask list [--status open|answered] [--kind question|notice] [--unread]
  [--mark-read]` / `ask show <id>` read the queue. `--mark-read` stamps the
  listed rows, so rule 16's `ask list --kind notice --unread --mark-read` is a
  one-call batch the live agent summarises in a line.
- `naru ask answer <id> <text…>` answers once (`conflict` the second time).
  The asker reads it with `ask show <id>`; nothing is pushed to the asker.
- `--quiet` drops `body` (and `answer` on show/answer).
- Body and answer are non-blank, at most 8 KiB. CLI only, no HTTP route, no
  frontend; `AgentQuestion` is not ts-exported.

The `naru-live` prompt (rule 16) tells the live agent to run
`ask list --status open` on a `question` notice and at natural pauses; the
`implementer` and `supervisor` built-ins tell agents to use `naru ask`.
Gate: `scripts/ask-check.sh`. Part of the persistent live agent design (task 2010).

The `question` notice turn is pushed into the live agent like any user turn (`docs/live.md` "Push delivery"); `listen` stays the fallback.
