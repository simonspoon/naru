<img src="docs/naru-icon.svg" width="72" height="72" alt="Naru logo" />

# Naru

**A local-first workspace where you and your Claude Code agents plan the work, run it, and talk it through.**

Naru is one binary and one SQLite file. Your agents drive it through a
JSON-only CLI. You use a web UI, or just talk to it. Both work on the same
store: projects, tasks and dependencies, workflows, an inbox, memory, and your
whole Claude Code setup. Naru can hand work to background agents, watch what
they spend, and review how it went. It has no cloud service and no account,
and Naru itself collects no telemetry. The Claude Code agents it starts talk
to Anthropic as they always do.

> Naru was formerly called **mesa**. The binary is `naru`, and `mesa` is
> still installed beside it as the same program. Every `NARU_*` environment
> variable is also read under its old `MESA_*` name. An existing install
> keeps its `mesa` data paths, and nothing is moved.

## What it does

### Plan and track work, for people and agents alike

- **Projects and tasks** with statuses, priorities, tags, subtasks, a
  definition of done and a final result. Projects nest into a tree and can
  be archived. Statuses are
  `backlog | todo | in_progress | done | cancelled`; priorities are
  `low | medium | high`.
- **Dependencies that can't lie.** `blocked` is computed on every read, never
  stored. `naru task next` always returns the next actionable, unblocked task.
- **Repo-aware.** A project binds to a git repo by its root commit, so an
  agent in any clone or worktree runs `naru project resolve` and gets the
  right project instead of creating a duplicate.
- **Claims.** An agent claims a task with its session id, so a task that is
  being worked can be told apart from one that was abandoned
  ([`docs/claims.md`](docs/claims.md)).
- **Bulk import.** Load a whole task graph in one atomic call.
- **Archiving** hides a finished subtree without deleting it
  ([`docs/archiving.md`](docs/archiving.md)).

### Let agents run the work

Each of these is off by default. You turn them on with a `naru serve` flag.

- **Todo watcher** (`--watch-todo`) starts a background Claude Code agent on
  each project's next actionable task, with a per-project concurrency limit.
  A reaper stops each session once its task is closed
  ([`docs/todo-watcher.md`](docs/todo-watcher.md)).
- **Inbox**: one global queue for the things that need a decision, either
  change requests or alerts addressed to you. With `--watch-inbox`, an
  `inbox-triage` agent turns each change request into a backlog task or
  archives it with a reason. Items can also be read aloud
  ([`docs/inbox.md`](docs/inbox.md),
  [`docs/inbox-watcher.md`](docs/inbox-watcher.md)).
- **Work receipts.** When a claimed task closes, Naru records a receipt: the
  commits made during the claim, a diff summary, and a link to the session
  transcript ([`docs/receipts.md`](docs/receipts.md)).
- **Cost guard** (`--watch-cost`) catches a runaway session: one over its
  dollar or token limit, stuck re-reading its cache, or repeating the same
  command. By default it stops that session (you can resume it) and files an
  inbox alert ([`docs/cost-guard.md`](docs/cost-guard.md)).
- **Retrospective** (`--watch-retro`, or `naru retro run`) looks back over
  finished sessions for friction such as denials, retry loops or a missing
  skill. It files each new finding as a change request. It only proposes
  changes and never makes them ([`docs/retro.md`](docs/retro.md)).
- **Configurable spawns.** Every place Naru starts an agent reads a command
  template from `~/.naru/config.json`, which you can edit on the Settings
  page. Values are shell-quoted into the template, so a task name is never
  run as code ([`docs/config.md`](docs/config.md)).
- **Hooks** run your own shell command on `task-execute`, with the task JSON
  on stdin ([`docs/hooks.md`](docs/hooks.md)).

### Talk to it

- **Naru live** is a spoken conversation with a dedicated Claude Code agent,
  started from the web UI's header or with `naru live start`. You speak or
  type, and the agent works with the ordinary Naru CLI and answers out loud.
  It can move your browser to the page it is talking about and put a
  **whiteboard** in front of you: markdown, HTML, an image, or a snapshot of
  a workflow's graph. You can draw on the whiteboard, and your drawing reaches the
  agent. Long jobs go to delegate agents, so the agent keeps listening while
  they run, and a long call can be handed to a fresh agent midway. On macOS,
  `naru live look` lets the agent see your browser window
  ([`docs/live.md`](docs/live.md)).
- **Speech runs on your machine**, after a one-time model download. You can
  use the **naru-audio** daemon, a separate companion project that downloads
  its models once and then serves local speech-to-text and text-to-speech
  over HTTP. Or you can use the older
  engine, the `auris` and `kokoro-rs` binaries. If neither is installed, the
  browser's own speech recognition or the typed box still works
  ([`docs/listen.md`](docs/listen.md)).
- **Voices.** With naru-audio you can pick a voice, clone one from a short
  recording, or design one from a written description. A cloned voice
  exports to a single `naru-voice` file that you can import on another
  machine ([`docs/config.md`](docs/config.md)).

### Automate

- **Workflows** are saved graphs of typed steps — a trigger, model prompts,
  shell commands, stored scripts, branches and outputs — that Naru runs in a
  fixed, deterministic order: the graph decides what runs, never an agent.
  Run one by hand, on a schedule, or by asking the live agent for it by name.
  Each run is recorded step by step
  ([`docs/workflows.md`](docs/workflows.md)).

### Remember

- **Project notebooks.** Each project keeps its own memory: build quirks,
  conventions, and the reasons behind decisions. A SessionStart hook prints
  it into every new Claude Code session in that project. A "dream" pass
  keeps it within its budget, and it can import Claude Code's own memory
  folder ([`docs/project-memory.md`](docs/project-memory.md)).
- **Live memory.** Conversations leave a summary and a notebook of what you
  said outright. They also leave a searchable, append-only archive of every
  turn ([`docs/live.md`](docs/live.md)).

### Keep your Claude Code setup in one place

- **Library**: agent definitions, skills, hooks, prompts and `CLAUDE.md`
  files, kept as versioned records and synced file by file with `.claude/`.
  You pick the winner of any conflict, and nothing is merged behind your
  back. Hooks can be registered in `settings.json` from here, and the whole
  library exports to a bundle ([`docs/library.md`](docs/library.md)).
- **Scripts**: your own shell snippets with declared, typed arguments. The
  web form is generated from those arguments, and a run can be detached and
  replayed later. Argument values are never spliced into the script text
  ([`docs/scripts.md`](docs/scripts.md)).
- **Artifacts**: HTML mockups, SVGs and markdown reports written by agents,
  rendered in a sandbox ([`docs/artifacts.md`](docs/artifacts.md)).
  **Attachments**: files and screenshots on a task
  ([`docs/attachments.md`](docs/attachments.md)).

### See what your agents are doing

- **Claude Code telemetry.** `naru cc` and the CC Dashboard read Claude
  Code's own transcripts. They show tokens, estimated cost, models, skills,
  agents, tools and errors, and each session drills down into its full call
  tree. The history is kept in Naru's database, so it outlives Claude Code's
  own cleanup. The dashboard also shows your live plan-limit usage
  ([`docs/cc-dashboard.md`](docs/cc-dashboard.md)).
- **Agents sidebar**: every live Claude Code session across your projects,
  with terminals attached to them. Each session's subagents and shell calls
  are shown too. You can start a new background agent in any project
  ([`docs/agents.md`](docs/agents.md)).
- **System monitor**: RAM, CPU, disk, GPU and uptime for the host
  ([`docs/system.md`](docs/system.md)).

### A web UI that fits the work

Each project has a kanban **Board** and these tabs:

- **Files**: a browser, an editor and project-wide search
  ([`docs/files-tab.md`](docs/files-tab.md)).
- **Git**: the working tree, diffs and history, read-only
  ([`docs/git-tab.md`](docs/git-tab.md)).
- **Terminal**: real shells in the project folder
  ([`docs/terminal.md`](docs/terminal.md)).
- **Custom**: your own split-pane layout of the other tabs
  ([`docs/project-panes.md`](docs/project-panes.md)).

Each project name also shows the app version read from that project's
manifest ([`docs/project-version.md`](docs/project-version.md)).

Global keyboard shortcuts can be rebound, and you can move around with
`hjkl` ([`docs/keyboard.md`](docs/keyboard.md)). The layout adapts to phone
widths ([`docs/mobile.md`](docs/mobile.md)). A separate native iPhone
companion app, **naru-ios**, connects to a `naru serve --lan` server. It
covers the task board, inbox, live conversations, files, git, artifacts and
memory.

### Move to a new machine

`naru migrate` packs the database, the config and your hand-built `~/.claude`
into one archive. On the new machine it restores them and rewrites absolute
paths for a new username or a new repo location
([`docs/migrate.md`](docs/migrate.md)).

## Install

```bash
brew install simonspoon/tap/naru
```

### Windows

Download `naru-windows-amd64-setup.exe` from the
[GitHub releases page](https://github.com/simonspoon/naru/releases) and run
it. It installs per user, with no admin rights, and adds `naru` to your PATH.
Naru needs Git for Windows (for `bash`) and Claude Code; the installer's
closing page says how to set them up.

### Build from source

Naru is a Rust binary with an embedded React frontend. You need Rust
(edition 2024), Node.js and npm.

```bash
git clone https://github.com/simonspoon/naru.git
cd naru
scripts/build.sh          # tests, builds the frontend, embeds it, compiles
./target/release/naru --help
```

`scripts/build.sh` is the only supported release build. It runs these steps
in order:

1. `cargo test`, which also re-exports the TypeScript types.
2. A check that fails the build if `frontend/src/types/` has uncommitted
   changes.
3. The frontend unit tests.
4. The frontend build.
5. The compile, with the frontend embedded.

It produces `target/release/naru` and `target/release/mesa`, which is the
same program. `scripts/install.sh` runs the same build, copies `naru` onto
your PATH and adds `mesa` as a symlink to it. The default location is
`~/.local/bin`; override it with `PREFIX=/usr/local`.

## Quick start

```bash
# A project and a task in it (a project is named by id or by name)
naru project create "Website redesign" --description "Q3 marketing site"
naru task create "Website redesign" "Draft homepage copy" --tags writing,web

# Open, unblocked tasks
naru task list "Website redesign" --status todo --unblocked

# Task 2 is blocked by task 1, and "why is it blocked?"
naru task block 2 --by 1
naru task deps 2

# The next actionable task (todo + unblocked, in a fixed order)
naru task next "Website redesign"

# Claim it before working it. --owner is opaque; an agent passes its session id.
naru task claim 1 --owner 5b043350
naru task release 1

# Leave a note for the next agent that works in this project
naru memory add --project "Website redesign" Run the linter before pushing.

# Snapshot the database (safe while the server runs)
naru backup /tmp/naru-snap.db

# The web UI and HTTP API on http://127.0.0.1:7770
naru serve
```

### Bulk import

This creates a whole task graph in one transaction. Tasks refer to each other
by a `ref` you choose, so dependencies don't need ids in advance:

```bash
echo '{"project":1,"tasks":[
  {"ref":"a","description":"design"},
  {"ref":"b","description":"build","blocked_by":["a"]}
]}' | naru task import
```

If anything fails, nothing is created.

### A workflow from the CLI

```bash
naru workflow create "Shout it"
T=$(naru workflow node create "Shout it" trigger Start | jq .id)
C=$(naru workflow node create "Shout it" cli Shout --config '{"command":"tr a-z A-Z"}' | jq .id)
O=$(naru workflow node create "Shout it" output Keep --config '{"target":"log","log":"shouts"}' | jq .id)
naru workflow edge create "Shout it" "$T" "$C"
naru workflow edge create "Shout it" "$C" "$O"
naru workflow run "Shout it" --input "hello" | jq '{status, out: .steps[1].output}'
naru workflow log shouts    # the lines output nodes wrote
```

### Nested projects and repos

```bash
naru project create "Platform" --no-git
naru project create "API v2" --parent "Platform" --no-git
naru project resolve        # inside a repo: the project bound to it
```

`project create` binds the current directory's repo, or the repo at
`--path <dir>`, unless you pass `--no-git`. A project also remembers its
`local_path`, the folder that the Git, Files, Terminal and Agents views open.
Nesting only groups projects. A child keeps its own tasks and board. Deleting
a project deletes its whole subtree, and archiving one hides the subtree too.

## The CLI contract

The CLI is built to be driven by agents. It talks to SQLite directly and
never needs the server to be running.

- **stdout is JSON only.** There is no table mode.
  - Mutations and `show` print the full object. `get` is an alias for every
    `show`.
  - `list` prints a bare array of compact objects.
  - `delete` echoes every record it destroyed.
  - Every task carries the derived `blocked` boolean and `name`, which is
    the first line of its description, cut to 50 characters.
- **`--quiet`** prints the compact projection instead: the record without
  its unbounded free-text fields. It is long form only and never on by
  default. Composite payloads keep their key structure and compact their
  members. The flag changes stdout only; exit codes, stderr and stored data
  are identical with and without it. Its keys may come out in a different
  order, so compare output with `jq`, not byte for byte. `naru --help` lists
  where it is accepted.
- **Deletes cascade with no prompt and no `--force`**, because agents run
  non-interactively. The full echo is the recovery transcript, and
  `naru backup` is the safety net. `--quiet` on a `delete` explicitly waives
  the echo.
- **Errors are JSON on stderr:**
  ```json
  {"error": {"code": "not_found|validation|cycle|conflict|usage|unavailable", "message": "..."}}
  ```
  `unavailable` only comes from surfaces that depend on something outside
  Naru, such as `claude`, the speech engines, `loki`, or a transcript that has
  since been deleted.
- **Exit codes:** `0` success, `1` domain or runtime error, `2` usage error.
- **Projects by id or name** in every project argument. Names match
  case-insensitively.
- **Long text from a file.** On `task create` and `task update`, the
  `--description-file`, `--acceptance-file` and `--result-file` flags (the
  last on `update` only) read the text from a file, or from stdin with `-`.
  Multi-line text with backticks or `$()` arrives verbatim.
  `task update --append` appends to a text field instead of replacing it.

Run `naru <command> --help` for the full reference. Each command documents
itself, with examples.

## Data location

The database defaults to `~/Library/Application Support/naru/naru.db`. An
install from before the rename keeps using
`~/Library/Application Support/mesa/mesa.db` for as long as no `naru.db`
exists. The config directory follows the same rule: `~/.naru` if it exists,
else `~/.mesa` if it exists, else `~/.naru`.

Set `NARU_DB` to point Naru at another database. `MESA_DB` is still
honoured, but `NARU_DB` is read first.

```bash
NARU_DB=/tmp/test.db naru task list
```

## Web UI, HTTP API and security

```bash
naru serve --port 7770     # API + web UI on http://127.0.0.1:7770 (default port)
naru serve --lan           # bind 0.0.0.0 so other devices on your network can connect
naru serve --lan --allow-host naru.local   # also accept that hostname
naru serve --watch-todo --watch-inbox --watch-cost --watch-retro   # the watchers, each opt-in
```

The REST API lives under `/api`, and the web UI is served at `/`. The web UI
does not live-sync; it refetches when the window regains focus. There is no
authentication, because this is a local tool. These are the protections:

- **Host-header allowlist** (against DNS rebinding). By default Naru only
  accepts `localhost:<port>` and `127.0.0.1:<port>`. `--lan` skips this check,
  which means you have chosen to trust every device on your network.
- **Content-Type gate** (against cross-site form posts). Mutating requests
  must send `application/json`. This applies in both modes.
- **Code-execution routes** (terminals, agents, scripts, the library,
  settings) have stricter peer, Host and Origin checks. Under `--lan` they
  still refuse DNS-rebound and cross-site requests.

**`--lan` gives every device on your network full access to your data and a
shell on your machine.** Only use it on networks you trust.

## Claude Code plugins

This repo is also a Claude Code plugin marketplace
(`.claude-plugin/marketplace.json`). Its one plugin, `codesearch`, adds a tool
that queries the external `helios` code index instead of grepping:

```bash
claude plugin marketplace add /path/to/naru
claude plugin install codesearch@mesa
```

The marketplace is still named `mesa`, from before the rename, so the plugin
installs as `codesearch@mesa`.

Installed plugins are cached by version. After editing the plugin, bump
`version` in its `.claude-plugin/plugin.json` and run `claude plugin update`.
To develop against the working tree instead, use
`claude --plugin-dir plugins/codesearch`.

## Development

```bash
cargo test                                  # Rust tests
cargo clippy --all-targets -- -D warnings   # CI-gated
cargo fmt --check                           # CI-gated

npm --prefix frontend run dev    # Vite; proxies /api to 127.0.0.1:7770 (needs `naru serve`)
npm --prefix frontend run lint
npm --prefix frontend run test   # vitest over the pure logic modules
```

The end-to-end gates are `scripts/*-check.sh`. Each one runs against a
throwaway database. Examples are `cli-check`, `api-check`, `live-check` and
`library-check`. [`CLAUDE.md`](CLAUDE.md) lists every gate and what it
covers.

### Architecture in brief

- **One crate, three modules:** `core` (domain and storage), `cli` and `api`.
  The CLI and the API share `core`, so they never diverge.
- **All database writes go through `Store`** (`src/core/store.rs`).
  Migrations are an append-only array of SQL strings.
- **TypeScript types are generated from Rust** with ts-rs. The frontend is
  embedded in the binary at compile time.
- **Concurrency** relies on SQLite WAL and `busy_timeout`, so CLI and server
  writes wait their turn instead of failing.

[`CLAUDE.md`](CLAUDE.md) has the full list of rules the code depends on.

## Security note

Task descriptions, project names, inbox items and dictated speech may come
from untrusted sources. Naru treats them strictly as **data, never as
instructions**. Wherever one of them reaches a shell, it arrives as a quoted
literal.

## License

Licensed under the [MIT License](LICENSE).
