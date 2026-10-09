<img src="docs/naru-icon.svg" width="72" height="72" alt="Naru logo" />

# Naru

**A local-first workspace where you and your Claude Code agents plan the work, run it, and talk it through.**

Naru is one binary and one SQLite file. You use it through a web UI (or just
talk to it); your agents drive the same store through a JSON-only CLI.
Projects, tasks and dependencies, workflows, an inbox, memory and your whole
Claude Code setup live in one place. Naru can hand work to background
agents, watch what they spend, and review how it went. It has no cloud service and no account,
and Naru itself collects no telemetry. The Claude Code agents it starts talk
to Anthropic as they always do.

> Naru was formerly called **mesa**. The binary is `naru`, and `mesa` is
> still installed beside it as the same program when you build from source.
> Every `NARU_*` environment variable is also read under its old `MESA_*`
> name. An existing install keeps its `mesa` data paths, and nothing is moved.

## Quick start

### 1. Install

With Homebrew (macOS and Linux, from the
[`simonspoon/tap`](https://github.com/simonspoon/homebrew-tap) tap):

```bash
brew tap simonspoon/tap
brew install naru
```

The formula installs the `naru` binary only (no `mesa` alias).

Or build from source. You need Rust (edition 2024), Node.js and npm:

```bash
git clone https://github.com/simonspoon/naru.git
cd naru
scripts/install.sh        # tests, frontend build, compile, then copy onto your PATH
```

`scripts/install.sh` installs `naru` to `~/.local/bin` (override with
`PREFIX=/usr/local`) and adds `mesa` as a symlink to it. To build without
installing, run `scripts/build.sh`, which produces `target/release/naru`.

### 2. Open the web UI

```bash
naru serve
```

Then open <http://127.0.0.1:7770>. The server binds to your machine only by
default; `--port <PORT>` changes the port.

With the Homebrew install, you can run the server in the background instead:
`brew services start naru`, then open <http://127.0.0.1:7770>.

```bash
naru serve --lan                           # also reachable from other devices on your network
naru serve --lan --allow-host naru.local   # ...and by that hostname
```

**`--lan` has no authentication.** It gives every device on your network full
access to your data and a shell on your machine; use it only on networks you
trust (see [Security](#web-ui-http-api-and-security)).

To run Naru as a service, put the same options in the `serve` section of
`~/.naru/config.json` (`port`, `lan`, `allow-host`, `watch-todo`, ...) so a
bare `naru serve` is enough; a flag you pass wins over the config. The same
switches are on **Settings -> System**. See [`docs/config.md`](docs/config.md).

### 3. Create something

Create a project and a task from the UI, or from a terminal:

```bash
naru project create "Website redesign" --description "Q3 marketing site"
naru task create "Website redesign" "Draft homepage copy" --tags writing,web
naru task list "Website redesign" --status todo --unblocked
```

`project create` binds the git repo of the current directory unless you pass
`--no-git`.

## The web UI

Everything below is a page or panel of the UI you opened with `naru serve`.
Pages are addressed by `#/...` hashes, so each one is bookmarkable and
survives a reload. `Cmd/Ctrl+Shift+P` opens the command palette; the other
global shortcuts can be rebound in Settings. Move around with `hjkl` or the
arrow keys, and press `a` to create a task
([`docs/keyboard.md`](docs/keyboard.md)). The layout adapts to phone widths
([`docs/mobile.md`](docs/mobile.md)). The UI does not live-sync; it refetches
when the window regains focus.

### Layout

- **Left nav**: the CC Dashboard (the landing page), the global pages below,
  and your projects as a tree. Drag a project to reorder or nest it.
- **Dock**: on desktop widths every panel (main page, conversation,
  whiteboard, agents, terminal) is a dockable tab group you can drag into
  splits. Talk/Review/Build presets and your own saved layouts are in the
  header `...` menu ([`docs/dock.md`](docs/dock.md)).
- **Header**: the live conversation, and chips showing how much of your Claude
  plan's 5-hour and 7-day limits you have used.

### Per project

Open a project to get its **Board** (a kanban of tasks) and these tabs:

- **Board / tasks**: statuses `backlog | todo | in_progress | done |
  cancelled`, priorities, tags, subtasks, dependencies (a task is *blocked*
  while anything it depends on is unfinished), a definition of done, a final
  result, append-only notes, attachments and a work receipt when a claimed
  task closes. Press `a` on a board to create a task
  ([`docs/receipts.md`](docs/receipts.md),
  [`docs/task-notes.md`](docs/task-notes.md),
  [`docs/attachments.md`](docs/attachments.md)).
- **Dashboard**: Claude Code usage for this project (tokens, estimated cost,
  sessions).
- **Files**: a file browser, editor and project-wide search
  ([`docs/files-tab.md`](docs/files-tab.md)).
- **Git**: the working tree, diffs and history, read-only
  ([`docs/git-tab.md`](docs/git-tab.md)).
- **Terminal**: a real shell in the project folder
  ([`docs/terminal.md`](docs/terminal.md)).
- **Workflows**: this project's workflows, with a graph builder.
- **Artifacts**: HTML mockups, SVGs and markdown reports written by agents,
  rendered in a sandbox ([`docs/artifacts.md`](docs/artifacts.md)).
- **Custom**: your own split-pane layout of the other tabs
  ([`docs/project-panes.md`](docs/project-panes.md)).
- **Settings**: the project's folder, parent and archive switch
  ([`docs/archiving.md`](docs/archiving.md)).

The project name also shows the app version read from its manifest
([`docs/project-version.md`](docs/project-version.md)).

### Global pages

- **CC Dashboard** (`#/`): analytics over Claude Code's own transcripts:
  tokens, estimated cost, models, skills, agents, tools and errors, your live
  plan-limit usage, a per-session detail page with the full call tree, and a
  timeline. History is kept in Naru's database, so it outlives Claude Code's
  own cleanup ([`docs/cc-dashboard.md`](docs/cc-dashboard.md)).
- **Inbox** (`#/inbox`): the queue of things that need a decision: change
  requests and alerts addressed to you. Tabs for New, Read and Archived. Turn
  an item into a task, archive it with a reason, or have it read aloud
  ([`docs/inbox.md`](docs/inbox.md)).
- **Workflows** (`#/workflows`): every workflow across all projects. A
  workflow is a saved graph of typed steps (trigger, model prompt, shell
  command, branch, output...) that Naru runs in a fixed order; the graph
  decides what runs, never an agent. Run one by hand, on a schedule, or by
  asking the live agent for it by name
  ([`docs/workflows.md`](docs/workflows.md)).
- **Library** (`#/library`): three tabs. *Claude Code* holds agent
  definitions, skills, hooks, prompts and `CLAUDE.md` files as versioned
  records, synced file by file with `.claude/` (you pick the winner of any
  conflict; nothing is merged behind your back) and exportable as a bundle
  ([`docs/library.md`](docs/library.md)). *Scripts* are your own shell
  snippets with declared, typed arguments: the form is generated from the
  arguments, a run can be detached and replayed, and values are never spliced
  into the script text ([`docs/scripts.md`](docs/scripts.md)). *Workflows* is
  a read-only list of every project's workflows.
- **Terminal** (`#/terminal`): a shell in Naru's workspace folder.
- **Settings** (`#/settings`): tabs for Hooks (the command templates Naru
  uses to start agents, [`docs/config.md`](docs/config.md)), Keyboard, Voice,
  Memory (the live notebook), Pricing and System (the host monitor and the
  `serve` options; [`docs/system.md`](docs/system.md)).

### Agents sidebar

A right-hand panel listing every live Claude Code session across your
projects. Open one to chat with it or attach a terminal, see its subagents and
shell calls as cards, and start a new background agent in any project
([`docs/agents.md`](docs/agents.md)).

### Live voice conversation

Naru live is a spoken conversation with a dedicated Claude Code agent. It
lives in the header: press **Go live**, then speak or type. The agent works
with the ordinary Naru CLI and answers out loud. It can move your browser to
the page it is talking about and put a **whiteboard** in front of you
(markdown, HTML, an image, or a snapshot of a workflow); you can draw on the
whiteboard and your drawing reaches the agent. Long jobs go to delegate
agents so it keeps listening, and a long call can be handed to a fresh agent
mid-conversation. On macOS, `naru live look` lets the agent see your browser
window (needs the external `loki` tool). Conversations leave a summary and a
notebook of what you said outright ([`docs/live.md`](docs/live.md)).

It needs:

- the `claude` CLI on your PATH, because the conversation is a Claude Code
  agent;
- a speech engine, all running locally after a one-time model download:
  - **naru-audio** (a separate daemon, speech-to-text and text-to-speech):
    `brew install naru-audio`, then `naru-audio pull default` (downloads the
    models) and `brew services start naru-audio`, and select the `naru-audio`
    engine in the Audio section of Settings -> Voice. Voices can be picked,
    cloned from a short recording, or designed from a description; a cloned
    voice exports to a single `<name>.naru-voice.json` file you can import on
    another machine; or
  - the older **`auris`** (speech-to-text) and **`kokoro-rs`**
    (text-to-speech) binaries, also in the tap;
- with neither, the browser's own speech recognition or the typed box still
  works ([`docs/listen.md`](docs/listen.md)).

You can also start it from a terminal with `naru live start` and end it with
`naru live stop`.

### Also in the UI

- **Project notebooks**: each project keeps its own memory (build quirks,
  conventions, reasons behind decisions), printed into every new Claude Code
  session in it ([`docs/project-memory.md`](docs/project-memory.md)).
- **Settings -> System**: RAM, CPU, disk, GPU and uptime for the host.
- A native iPhone companion, **naru-ios**, connects to a `naru serve --lan`
  server (task board, inbox, live conversations, files, git, artifacts,
  memory).

---

# For agents and the command line

Everything above is also available from the CLI, which is what your agents
use. It talks to SQLite directly and never needs the server to be running.
Run `naru --help` and `naru <command> --help` for the full reference; each
command documents itself, with examples.

## What agents can do

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
- **Task notes.** `naru task note <id> <text>` appends context to a task
  without rewriting its description; notes are append-only and `task show`
  lists them ([`docs/task-notes.md`](docs/task-notes.md)).
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

### Move to a new machine

`naru migrate` packs the database, the config and your hand-built `~/.claude`
into one archive. On the new machine it restores them and rewrites absolute
paths for a new username or a new repo location
([`docs/migrate.md`](docs/migrate.md)).

## CLI quick tour

```bash
# A project and a task in it (a project is named by id or by name)
naru project create "Website redesign" --description "Q3 marketing site"
naru task create "Website redesign" "Draft homepage copy" --tags writing,web

# Open, unblocked tasks
naru task list "Website redesign" --status todo --unblocked

# Find tasks by words in their description (all words, case-insensitive,
# literal substrings); same compact array as `task list`
naru task search homepage copy --status todo --project "Website redesign"

# Task 2 is blocked by task 1, and "why is it blocked?"
naru task block 2 --by 1
naru task deps 2

# The next actionable task (todo + unblocked, in a fixed order)
naru task next "Website redesign"

# Claim it before working it. --owner is opaque; an agent passes its session id.
naru task claim 1 --owner 5b043350
naru task release 1

# Append context to a task without rewriting it (put flags before the text)
naru task note 1 Waiting on the copy review.

# Leave a note for the next agent that works in this project
naru memory add --project "Website redesign" Run the linter before pushing.

# Snapshot the database (safe while the server runs)
naru backup /tmp/naru-snap.db
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
