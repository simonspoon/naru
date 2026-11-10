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
  command still exits 0 (and see "The phone" below).
- Rows have a `kind` (naru task 2065): `question` (default) or `notice`, from
  `naru ask --notice …` — a completion report that needs no answer (the task
  loop's last node, the stale-claim sweep). A notice raises **no** notice turn
  and cannot be answered (`conflict`). `read_at` is when the live agent first
  saw it; existing rows are unread questions.
- `naru ask list [--status open|answered|expired] [--kind question|notice] [--unread]
  [--mark-read]` / `ask show <id>` read the queue. `--status open` with no
  `--kind` lists open **questions** only — a notice is never answered, so it
  would stay open forever; add `--kind notice` to see those (naru task 2651,
  whose migration also reclassified the pre-`--notice` loop reports stored as
  questions and marked every notice over a day old read). `--mark-read` stamps the
  listed rows, so rule 16's `ask list --kind notice --unread --mark-read` is a
  one-call batch the live agent summarises in a line.
- `naru ask answer <id> <text…>` answers once (`conflict` the second time).
  The asker reads it with `ask show <id>`; nothing is pushed to the asker.
- Closing a task (`done` or `cancelled`, in `Store::update_task`) expires its
  open questions (naru task 2661): `status` becomes `expired`, `answered_at`
  is stamped and `answer` holds the reason (`expired: task N closed (done)`),
  so `ask list --status open` stops listing them and `ask show` says why (not under `--quiet`, which drops `answer`).
  Answering one is `conflict`; reopening the task does not revive it, and
  notices are left alone. Its migration expired the questions already
  stranded on closed tasks.
- Nothing times out or re-raises an open question in code (naru task 2679);
  the `execute-naru-task` skill and the `supervisor` built-in carry the rule
  instead. An agent whose question goes unanswered parks its task in `backlog`
  with a note starting `FIRST: get an answer to ask <id>: <question>`. The
  next agent on that task checks `ask list` for the task's rows before any
  other work: it acts on an `answered` one first, and puts an `open` one to
  the person again with `naru notify`, never a second `ask`.
- `naru ask --choice <label> [--choice …] <text…>` (naru task 2700, flags
  before the text) offers 2 to 8 options: each non-blank (stored trimmed), at
  most 100 characters, never on a `--notice`; anything else is `validation` and
  nothing is stored or sent. They are stored as a JSON array in
  `agent_questions.choices` (migration 111, NULL = none) and appear in every
  read as `choices` (always an array). They are a convenience for the phone: the
  answer is still free text, and the web UI and `ask answer` ignore them.
- `--quiet` drops `body` (and `answer` on show/answer); `choices` stays (bounded).
- Body and answer are non-blank, at most 8 KiB. CLI only, no HTTP route, no
  frontend; `AgentQuestion` is not ts-exported.

## The phone (naru task 2700)

A question goes to the person's Telegram (through `vox`, see
`docs/notify.md` "Answering from Telegram") only when a person is really
needed, never merely because it was asked:

- **A live conversation is active**: `naru ask` raises the `question` notice
  turn and sends **nothing** to vox. The live agent settles what it can, puts
  the rest to the person by voice, and runs `naru ask escalate <id>` only when
  the person is needed and not there to answer (rule 16 of the `naru-live`
  prompt).
- **No live conversation**: `naru ask` itself sends the question, best-effort
  (a failure or a missing vox is only logged to stderr; stdout and the exit code
  are unchanged).
- `naru ask escalate <id> [--quiet]` sends an open question once. An unknown id
  is `not_found`; a notice, a question that is not `open`, or one already sent
  to the phone is `conflict`, and nothing is sent. Unlike the automatic send, a
  failure here is reported (`unavailable`, exit 1), including "the phone is not
  reachable from this environment". It prints the question.
- `--notice` never sends, in every case.
- Only where the phone may be reached (`notify::reader_bin`: not a sandboxed
  `NARU_HOME`, not a throwaway `NARU_DB`, unless `NARU_VOX_BIN` is set) and never
  under `cargo test`; elsewhere the automatic send is a silent no-op. Every vox
  call on this path is bounded (2 s to probe `events`, 8 s to send or edit), so a
  hung vox cannot hold the agent.
- The message is the question (cut to 900 characters, plus ` (task N)`), a
  line saying how to answer, and a button per choice labelled `A: <label>`,
  `B: …` with data `q:<question id>:<index>`. With a vox older than `events` it is
  plain text only. A tap or a reply (`core::phone`) answers it; the first answer
  wins across Telegram, `ask answer`, the web UI and voice. After `ask answer`
  the message is edited to `… - Answered: <answer>` (no phone prompt, no vox
  call).

The `naru-live` prompt (rule 16) tells the live agent to run
`ask list --status open` on a `question` notice and at natural pauses; the
`implementer` and `supervisor` built-ins (and the `execute-naru-task` skill) tell agents to use `naru ask`, with `--choice` once per option when the answer is one of a few.
Gate: `scripts/ask-check.sh`. Part of the persistent live agent design (task 2010).

The `question` notice turn is pushed into the live agent like any user turn (`docs/live.md` "Push delivery"); `listen` stays the fallback.
