# Architecture, contracts and validation invariants

The full text behind CLAUDE.md's short summaries, moved out of CLAUDE.md (naru task 2410). The code is the source of truth; these are the rules it must not break.

## Architecture

The code is the source of truth. These are the invariants you must not break:

- **One crate, three modules** — `core` (domain + storage), `cli`, `api`. Not a
  workspace; deliberate for a single-user tool.
- **`blocked` is derived, never stored.** Computed in SQL on every read
  (`TASK_COLUMNS` in `src/core/store.rs`): true iff any dependency is not
  `done`/`cancelled`. Never add a `blocked` column or status.
- **A task has no `title`; its `name` is derived, never stored** (task 660).
  `description` is required, non-empty, and *is* the task's identity; `name` is
  its first non-empty line cut to 50 chars (`…` marks the cut), computed on
  every read by `types::task_name` — the one implementation, shared by the
  board card, `task list`, the not-found hint and every agent session name.
  Never re-derive it in TypeScript, never store it, never add a `title` back. (The CLI's task JSON does carry a `title` key equal to `name` — an output-only alias added in `cli.rs` (`TaskOut`, `compact()`) for agents that guess it, mesa task 1513; it is not on the `Task` type, the API or ts-rs, and is never stored or an input.)
- **All DB writes go through `Store` methods** (`src/core/store.rs`) — the single
  insertion point. Do not open a second write path.
- **All agent spawns go through `agents::spawn_bg`** (or, for the two `naru run` sessions, `core::runner`), whose argv comes from a
  `~/.mesa/config.json` command template (`src/core/config.rs`,
  `docs/config.md`) — one chokepoint for all nine spawn sites (the first of them to change shape, `inbox-watcher`, is since naru task 1691 a structured `-p` site too, in `naru __job inbox-triage`, and the sixth, `retro`, since naru task 1692 is one in `naru __job retro`; the eighth, `runner`, is the detached `claude -p` of `naru run`, held by `core::runner`, and since naru task 1886 the third, `live-agent`, is no `--bg` agent either but a `naru run` job through the same `core::runner` (`core::live::spawn_agent`, offering `{name}`, `{session_flag}`, `{session_id}` and no `{prompt}`; a saved `--bg` override is ignored on read and refused on save); the seventh, `workflow-prompt`, is a workflow `prompt` node's one synchronous `claude -p --output-format json` call, built through `agents::workflow_prompt_script`; and since naru task 1690 the fourth and fifth, `live-summary` and `live-dream`, are no `--bg` agents but one synchronous tool-less `claude -p --output-format json --json-schema {schema}` call each, built through `agents::structured_script` and run by `llm::complete_structured` inside a detached hidden `naru __job` self-process (`core::memory_job`) whose answer Naru applies itself through the guarded `Store` methods — a saved `--bg` override of either, or of `inbox-watcher` or `retro`, is ignored on read and refused on save). Do not
  hardcode a `claude` invocation anywhere else. Every template is a `bash -c`
  script, one line or many, and that is the *only* shell on this path: the
  only Naru data that ever enters its text is a `{placeholder}` value,
  shell-quoted for its context by `config::substitute_script`, and nothing
  else may put Naru data in front of a shell.
- **CLI and API share `core` and never diverge.** The CLI talks to SQLite
  directly (each command opens its own `Store::open_default()`), NOT through the
  HTTP server — so agents can drive Naru with no server running. Handlers in
  `src/api.rs` are a thin layer with no business logic.
- **Migrations are a `user_version`-indexed array of SQL strings** (`MIGRATIONS`
  in `src/core/store.rs`), run on `Store` open. Add one by appending a string;
  never edit a shipped migration in place.
- **TS types are generated from Rust via ts-rs**, not hand-written
  (`#[ts(export, export_to = "../frontend/src/types/")]` in `src/core/types.rs`).
  `cargo test` performs the export; `build.sh` fails if the result is dirty.
  Edit the Rust type, re-run, commit the regenerated `.ts`.
- **The frontend is embedded at compile time** via rust-embed (`frontend/dist`,
  `Assets` in `src/api.rs`), served at `/` with SPA fallback. Release builds need
  `frontend/dist` to exist before the Rust compile (build.sh orders this); debug
  builds read the folder from disk at runtime.
- **Frontend unit tests cover the pure logic modules, not components.** vitest
  (jsdom) over `frontend/src/*.test.ts` — no React testing library, no component
  rendering. The subject is the side-effect-free modules the components import
  (`agentAlarm`, `ambientLog`, `agentCard`, `agentChat`, `agentChild`, `agentProject`, `agentRow`, `agentSidebarWidth`, `agentWatch`, `artifactDraft`, `audioDraft`, `boardTheme`, `boardView`, `ccOrigin`, `ccScorecard`, `ccTab`, `clipboardFiles`, `doneToast`, `dockLayout`,
  `editorInput`, `editorStatus`, `fileCsv`, `fileDirty`, `fileFind`, `fileHtml`, `fileImage`, `fileMedia`,
  `fileSearch`, `fileTabs`, `filesWatch`, `gitRepos`, `filesTreeWidth`, `inboxArchive`, `inboxFilter`, `inboxKind`, `inboxOrigin`, `inboxQueue`, `inboxRead`,
  `keyboardScope`, `keymap`, `keymapDraft`,
  `lastView`, `layout`, `libraryBuiltinUpdate`, `libraryBundle`, `libraryDraft`, `libraryHistory`, `libraryImport`, `libraryModel`, `libraryOverride`, `librarySkillFiles`, `librarySync`, `listenDraft`, `liveAudio`, `liveBand`, `liveBoard`, `liveBoardImages`, `liveBoardKeys`, `liveBoardWidth`, `liveBoardZoom`, `liveCancel`, `liveCaption`, `liveCapture`, `liveComposerReveal`, `liveContext`, `liveDevices`, `liveDrain`, `liveGlow`, `liveHead`, `liveInk`, `liveIndicator`, `liveInterrupt`, `liveLayout`, `liveMark`, `liveMicControl`, `liveOrb`, `livePastedImage`, `livePausePhrase`, `livePromptDraft`,
  `liveRecognition`, `liveReplay`,
  `liveScroll`, `liveSession`, `liveSidebarWidth`, `liveSpeaker`, `liveStream`,
  `liveThinkingCue`, `liveTurns`,
  `liveVad`, `liveView`,
  `liveWatchdog`,
  `liveWindow`,
  `mainCollapse`, `markdownAssets`, `markSkin`, `markSkinCustom`, `markSkinFrames`, `memoryDraft`, `modalDrag`, `nativeHost`, `navCollapse`, `navOrder`,
  `navWidth`, `newFile`, `openFiles`, `panelDrag`, `pricingDraft`, `projectPanes`,
  `projectTree`, `promptPlaceholders`, `ptyResize`, `runEvents`, `scriptDraft`, `scriptRun`, `sessionDetail`,
  `sessionGraph`,
  `sessionTimeline`, `settingsDraft`, `serveDraft`, `settingsTab`, `speechDraft`,
  `speechPlayback`, `speechSpeed`,
  `syntaxHighlighter`, `systemMeter`,
  `theme`, `time`, `timeStretch`, `usageMeter`, `voiceClone`, `voiceDesign`, `voiceEnroll`, `voiceExport`, `watchersDraft`, `wavStream`, `wordWrap`, `workflowConfig`, `workflowCreate`, `workflowHistory`, `workflowOverview`, `workflowRun`) —
  predicates that historically shipped wrong.
  **Logic worth testing therefore belongs in one of those modules, not inline
  in a `.tsx`** (why `isRunningAgent` lives outside `AgentSidebar`).
  Anything needing a rendered tree, real focus routing, or a trusted event
  stays with khora.

## Contracts that agents/clients depend on

- **CLI output is JSON only** (no human/table mode). **By default** mutations and
  `show` print the full object; `list` prints a bare array of compact objects (no
  `description`); `delete` echoes the full destroyed record(s); `get` is an alias
  for every `show`. Errors are `{"error": {"code", "message"}}` on stderr.
- **`--quiet` prints the compact projection instead of the full object.** Opt-in,
  long form only (no `-q`, no env var, no config key, never default-on), accepted
  on every mutation and `show`/`get`/`status` across `task`, `project`,
  `workflow` (+ `node`, `edge`), `inbox`, `live`, `memory`, `theme` and `mark` — and on
  nothing else; on every other command (`list`, `turns`, `deps`,
  `events`, `types`, `next`, `resolve`, `execute`, `attachment`, `cc`, `alarm`,
  `backup`, `serve`, `memory`'s `list`/`search`/`context`/`dream`/`import`…) it is
  **accepted and ignored** (mesa task 1513, `cli.rs::parse_args`: clap's
  unknown-argument rejection of `--quiet` is retried without it), so an agent's
  habitual flag never costs a turn — output identical to without it. A
  trailing-var-args command (`live say`, `inbox add`) still takes `--quiet`
  after the text as message text. The quiet shape is the record minus
  its unbounded free-text field(s), derived by removing named keys from the
  serialized record — never a hand-written second projection (`quiet()` in
  `src/cli.rs`, with a key-parity `#[test]` per record type so a new field on a
  record forces a decision). A task's quiet shape is the **existing
  `cli.rs::compact()`**, the same bounded object `task list` emits — do not add a
  second task projection. It drops `description`, `result` and `created_at`,
  **keeps the derived `name`** — the bounded 50-char first line of the dropped
  `description`, which is what makes a compact row identifiable at all — and
  **keeps `artifact`**: artifact is a bounded pointer (SHA/PR URL/path), and it
  is the field an agent writes at close-out, so echoing `null` for the value
  just stored read as "the write failed" (spec 651). `compact()` is a
  hand-written keep-list, so a new bounded field is omitted by default — the
  key-parity `#[test]` against `TaskSummary` is what forces the decision.
  Composites (`project delete`, `task delete`/`import`,
  `workflow show`/`delete`, `workflow node delete`, `inbox assign`) keep their key
  structure and compact only their members. Any quiet payload that actually
  drops a key is rebuilt as a `serde_json::Value`, so its keys come out
  **alphabetical** rather than in struct-declaration order — single records as
  much as composites. (An `edge` and a live **session** have nothing to drop,
  so both pass through in declaration order; a live **turn** drops `text`.) The key set and the values are unchanged; compare quiet
  output with `jq`, never byte-for-byte. The flag changes **stdout only**:
  exit codes, `print_error` stderr payloads and store side effects are identical
  with and without it, and default output stays byte-identical. `--quiet` sits
  **outside** every required `ArgGroup`, so `mesa task update <id> --quiet` with
  no field flag is still a usage error, exit 2, empty stdout.
- **`--quiet` on a `delete` waives the recovery-transcript safety floor.** The
  full-record delete echo is what substitutes for the confirmation prompt Naru
  deliberately does not have. `--quiet` opts out of it for that one call —
  allowed because the caller asked, and it must never become a default.
- **Exit codes are load-bearing:** 0 success, 1 domain/runtime error, 2 usage
  error. Codes: `not_found | validation | cycle | conflict | usage`, plus
  `unavailable`, scoped to surfaces depending on something outside Naru — the
  live `cc usage` endpoint, the agents endpoints, `cc text` (the transcript
  file a node's body lives in may have been deleted), the inbox/live speak
  routes (the naru-audio daemon may be down or refuse), `live transcribe`
  (likewise) and `live look` (the
  `loki` binary may be missing, this may not be a Mac, or the window the
  conversation's browser reported may have moved or closed) and `notify` (the `vox` binary may be missing or not set up with `vox init`).
- **Every CLI project argument takes an id or a name** (task/workflow
  create+list, task next, inbox list/assign, `project update` and its
  `--parent`): a non-numeric value resolves via
  `Store::find_project_by_name` — case-insensitive exact match; unknown name is
  `not_found` with a hint, duplicated name is `conflict` listing candidate ids.
- **Create subcommands take required args positionally or as flags** —
  `task create <PROJECT> <DESCRIPTION>`, `workflow create <NAME>`,
  `workflow node create <WORKFLOW> <KIND> <TITLE>`, `workflow edge create
  <WORKFLOW> <FROM> <TO>`, `project create <NAME>`. Each positional has an
  equivalent `--flag`; clap enforces exactly one of the pair (both or neither is
  `usage`, exit 2). A task's description is the one three-way case — positional,
  `--description` or `--description-file`, exactly one — so a multi-line body
  can still arrive from a heredoc. Node/edge are nested under `workflow` — there is no
  top-level `mesa node`/`mesa edge`. The optional project filter on `task list`,
  `task next` and `workflow list` takes the same shape: positional `[PROJECT]`
  or `--project`; neither means unscoped.
- **API security boundary is mode-dependent** (`serve` default vs `--lan`),
  enforced by middleware in `src/api.rs`, **not** by the bind address. Two
  checks:
  - **Host-header allowlist** (DNS-rebinding defense) — rejects a `Host` that is
    not `localhost:<port>`/`127.0.0.1:<port>`. Enforced in default mode (bind
    127.0.0.1); **skipped** under `--lan` (bind 0.0.0.0), an opt-in, no-auth
    "trust every device on the LAN" choice. The flag flips bind + Host policy
    together (`AppState.lan`) — two halves of one posture. The *agent* routes
    keep their own, stricter Host check under `--lan`
    (`require_lan_agent_host`: `localhost`/an IP literal on the serve port),
    and `--allow-host <name>` (repeatable, `--lan` only) adds exactly the
    hostnames the person trusts to it — an allowlist rather than an off
    switch, because a rebound page can only send its own DNS name, matched
    case-insensitively and in full on our port, so `naru.local` admits
    neither `evil-naru.local` nor `naru.local.evil.com`.
  - **Content-Type gate** (cross-site form posts) — requires
    `Content-Type: application/json` on mutating methods, in **both** modes.

  No auth in either mode. Removing the Content-Type check, or letting `--lan`
  leak into default mode, removes the boundary. `api-check.sh` asserts both
  halves in both modes, including that `--lan` skips Host while Content-Type
  still fires — the exact pairing that must not drift apart.
- **Concurrency safety** = WAL + `busy_timeout = 5000` (`src/core/store.rs`):
  concurrent CLI + server writes queue instead of `SQLITE_BUSY`. The web UI does
  not live-sync — it refetches on window focus.
- **Deletes cascade with no confirmation and no `--force`** (agents run
  non-interactively). The safety floor is the delete echo (recoverable
  transcript) + `mesa backup <path>` (`VACUUM INTO`, safe under WAL). Do not add
  a confirmation prompt. `--quiet` is the one explicit, per-call way to waive the
  echo half of that floor.

## Validation invariants (enforced in `Store`, not the schema)

- A task's project is immutable after creation.
- A task's `description` is required and may never be empty — it is the task's
  identity, so unlike the other free-text bodies it has no clear: `mesa task
  update --description ""` and `PATCH {"description": null}` are both
  `validation` (exit 1 / 422), not an erasure.
- A subtask shares its parent's project.
- Dependency self-edges and cycles are rejected (`cycle`).
- A task may carry a **claim** (`owner` + `claimed_at`) — `docs/claims.md`. The
  load-bearing asymmetry: `updated_at` moves on any write, `claimed_at` moves
  **only** on claim/renew. Never restamp `claimed_at` from an ordinary update.
  That asymmetry is what lets Naru *derive* an age on read (task 1017) without
  storing one: `task list --stale-claim-minutes N` / `GET
  /api/tasks?stale_claim_minutes=N` keeps only tasks whose claim is at least
  that old (unclaimed never matches, cutoff computed once per call off SQLite's
  own clock, absent = byte-identical output), and `task next`'s
  no-actionable-task payload carries a `stale_claims` count against a fixed
  60-minute const — the wedge signal on the queue-watcher's own path. Naru still
  enforces no TTL and releases nothing: a read never releases.
- A project may bind a **`root_commit`** — the repo's root commit hash, the
  stable identity of "this source code" across clones/worktrees/moves. Binds to
  **at most one project** (DB-unique; a second bind is `conflict`).
  `mesa project resolve [path]` computes it
  (`git rev-list --max-parents=0 --reverse HEAD`) and returns the bound project
  — how an agent maps its cwd to the right project instead of spawning a
  duplicate (`GET /api/projects/resolve?commit=<sha>`). `project create`
  auto-binds the cwd repo (or `--path <dir>`) unless `--no-git`/`--root-commit`;
  `project update --root-commit ""` clears it. Opaque unique string to
  `Store`/API.
- A project may record a **`local_path`** — its last-known working folder.
  Convenience, not identity: machine-local, not unique, no `Store` validation.
  Auto-learned on `project create` (unless `--no-git`/`--root-commit`/`--path`),
  cleared with `project update --path ""`. `project resolve` self-heals it
  **only when unset or stale** (stored folder gone) — a still-present checkout is
  never overwritten, so worktrees sharing one `root_commit` don't thrash the
  anchor. A project also keeps its **previous** local_paths (task 1262) —
  `previous_paths`, derived on every read from the `project_paths` table,
  appended automatically whenever `update_project` moves `local_path` away from
  a folder and edited by hand with `mesa project path add|remove` (CLI only) —
  because the CC dashboard matches a session's `cwd` against the current path
  *and* those by exact equality, so a moved folder keeps its history and `mesa
  cc reset` cannot undo it. Anchors the Agents surface; the UI sidebar decorates each project with
  its git status (`GET /api/git-status`, 5s cache, omits projects with no live
  repo).
- A project may name another project as its **`parent_id`** (task 668) — a
  pure *grouping* relation, arbitrary depth, `NULL` = top level. Nothing rolls
  up: a child keeps its own tasks, workflows, `root_commit` and `local_path`,
  and nothing of its appears on the parent's board. `Store` rejects
  self-parenting and any cycle (`cycle`) and an unknown parent (`validation`),
  mirroring a task's parent. `list_projects` still returns **one flat array**
  in `sort_order` — the tree is assembled client-side (`projectTree.ts`), so
  order stays server-side. A nav drag writes this field too (task 669): where
  in the hovered row the drop lands is the intent signal — the top/bottom
  **quarter** means *sibling* of that row (so an edge drop onto a top-level
  row is how a child is pulled back out), the middle **half** means *child*
  of it, appended last. Either way it is **one** `PATCH /api/projects/{id}`
  carrying `parent_id` and `sort_order` together, no other row renumbered;
  the decision is one pure function (`navOrder.ts::dropIntentFor`) that
  answers `null` — no request — for a drop onto itself, onto its own
  descendant, or back where it already is.
  The FK is `ON DELETE CASCADE`: deleting a project destroys its whole subtree,
  and the delete echo grows a `subprojects` key so the recovery transcript
  still carries every destroyed row.
- A project may be **`archived`** — `docs/archiving.md`. Two rules: a project
  is hidden from **unscoped** reads iff it is archived **or any ancestor is**
  (derived on every read by one shared recursive-CTE predicate, never stored on
  the descendants' rows — archiving a parent writes only the parent); and every
  read scoped to an explicit project id/name is byte-identical to before,
  including a live child of an archived parent.
- A project carries a **`sort_order`** (REAL, NOT NULL) — the project-level
  twin of `Task::sort_order`, and the single source of list order:
  `Store::list_projects` is `ORDER BY sort_order, id`, so `mesa project list`,
  `GET /api/projects` and the left nav can never disagree. Backfilled from
  `id`, so an un-dragged install is in creation order; `create_project` seeds
  `MAX + 1`, so a new project sorts last. Written by an ordinary update
  (`project update --sort-order`, `PATCH {"sort_order": n}`) — the sidebar's
  drag writes the **midpoint** between the drop's neighbours, so one drag is
  one PATCH of one row and nothing else is renumbered
  (`frontend/src/navOrder.ts`). Order is server-side, never client-local.
