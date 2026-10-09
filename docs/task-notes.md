# Task notes

Append-only notes on a task (naru task 1724). `naru task update --description`
replaces the whole body, and an agent that rewrote it lost content. A note adds
context beside the description and can never overwrite anything.

## CLI

```bash
naru task note 3 the failing test is flaky, see run 12
naru task note 3 --file notes.md        # `-` reads stdin
naru task note 3 --quiet "short ack"    # flags go BEFORE the text
```

Prints the created note: `{id, task_id, body, session, created_at}`. `session`
is `--session`, else `CLAUDE_CODE_SESSION_ID`, else `null`. `--quiet` drops
`body` (the one unbounded field; key-parity test in `cli.rs`).

`naru task show <id>` adds a `notes` array (oldest first) to the full output.
Notes appear only in plain (non-`--quiet`) `show` output, and in full.
`task show --quiet`, `task list` and every other command are unchanged: `notes`
is not a `Task` field. The help for `task note` and for `task update
--description` tells agents to prefer a note over rewriting the description.

`task delete` removes a task's notes with it (the FK cascade) and its echo does
not carry them: the echo is the destroyed tasks only, which is also true of
attachments and receipts, whose rows are cascaded away without being echoed.

## Storage

Sibling table `task_notes` (migration index 85): `id`, `task_id` (`ON DELETE
CASCADE`), `body`, `session` (nullable), `created_at`. Written only through
`Store::add_task_note` (body non-blank, at most `Store::TASK_NOTE_MAX` = 8192
bytes, and a `session` at most 200 characters, else `validation`; unknown task
`not_found`) and read through
`Store::list_task_notes`. There is deliberately no update or delete.

## API and web

`GET /api/tasks/{id}/notes` returns the array; `POST` takes `{"body": "..."}`
(session is null from the web) and answers 201 with the note. No per-route gate,
like the receipt routes and plain task CRUD. The task panel shows each note
(age, session if any, body) with an add form; its pure logic is
`frontend/src/taskNotes.ts`.
