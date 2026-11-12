# Git tab (working-tree view with stage/unstage/discard, plus history, per project)

The **Git** tab on a project page (web UI) shows the working tree of the
project's `local_path`: branch/ahead-behind + changed-file list, with a
per-file diff pane ("Diff view" below), plus a **Refs side panel** (worktrees, branches, stashes; "Side panel" below) and a
**History** sub-view (toggle, default Working tree) that browses commit
history. Like `/api/git-status` it reads **external** state via read-only
`git` shell-outs (`view_of`/`diff_of`/`worktrees_of`/`commit_log_of`/
`commit_files_of`/`commit_file_diff_of` in `src/core/git.rs`) and touches the
store only to read `local_path`. No CLI (an agent in a terminal uses `git`
directly). **Reads** (every GET) sit behind the standard middleware guard only
— they execute nothing. Since naru task 2738 the tab also **writes**: the
three POST routes `git/stage`, `git/unstage` and `git/discard` ("Write
operations" below), and since naru task 2739 the three `git/stage-hunks`,
`git/unstage-hunks` and `git/discard-hunks` ("Hunk and line staging" below),
since naru task 2740 `git/commit` ("Commit and amend" below), and since naru
task 2741 the eight `git/branch-create`, `branch-switch`, `branch-rename`,
`branch-delete`, `stash-push`, `stash-apply`, `stash-pop` and `stash-drop`
("Branch and stash writes" below), change the repo, so they carry the
agent-grade `require_agent_access` gate on top of the standard guard. No other
route here writes.

- **Several repos under one folder** (mesa task 1509).
  `GET /api/projects/{id}/git/repos` → `ProjectGitRepos { path, repos:
  [GitRepo { path, branch }] }` via `git::discover_repos`: `local_path`
  itself (`"."`) if it holds a `.git`, then every descendant directory
  holding a `.git` — a directory *or* a file, so linked worktrees and
  submodules count — down to 4 levels, at most 50. A found repo is still
  descended into, so a nested repo its parent gitignores is listed too.
  Never entered: `node_modules`, `target`, `.build`, `dist`, `venv`, `.venv`,
  `.git`; symlinks are not followed. Order: `"."` first, then by path. The walk visits at most 5000 directories and
  then stops early. Git runs inside every discovered nested repo, with the
  same trust as the user having cloned it there.
  `branch` is the branch, the short sha when detached, `null` on an unborn
  HEAD. Empty `repos` = no folder, dead folder or none found. Cached 5s per
  `local_path` (`AppState.git_repos_cache`).
  The routes `/git`, `/git/diff`, `/git/log`, `/git/commits/{sha}/files` and
  `/git/commits/{sha}/diff` take an optional **`?repo=<path>`** naming one of
  those `path`s; the route then reads that repo instead of `local_path`
  (its worktrees, status, log, commits), everything else unchanged. Absent,
  empty or `.` = today's behaviour byte-identical. `repo` is a security
  boundary (`resolve_repo_dir`): it must be byte-equal to a discovered
  `path` (so `..`, absolute paths and skipped directories are never members)
  *and* pass `files::safe_path` (a symlink cannot escape `local_path`);
  anything else is 404 `not_found`. `file-log` takes none (Files tab).
  The page (`GitView` + `frontend/src/gitRepos.ts`) shows a repo picker above
  the tab only when more than one repo was found; the default is the root
  repo, else the first found (a lone repo is selected silently, none is the
  usual empty state). The pick rides in the route as
  `#/projects/7/git?repo=<path>` and survives a reload; a stale value falls
  back to the default.
- `GET /api/projects/{id}/git[?worktree=<path>]` → `ProjectGitView` via
  `git::view_of`/`git::worktrees_of` (porcelain-v2 parse). Empty-state ladder
  like the agents endpoint: no `local_path` → `{path: null, repo: null,
  worktrees: null}`; dead folder or non-repo → `{path, repo: null, worktrees:
  null}`; never an error. `worktrees` lists every worktree of the repo behind
  `local_path` (`GitWorktree { path, branch, head, is_current, is_main, detached, bare,
  locked, lock_reason, prunable, prunable_reason }` — the extra flags are
  parsed from the same `worktree list --porcelain` call, task 2737;
  `is_current` = the worktree AT `local_path` — the one Naru is anchored to,
  regardless of `?worktree=`), always computed from `local_path` even when
  `?worktree=` selects a different one (`git worktree list` reports the same
  full set from any worktree). `?worktree=` re-points `repo` at that
  worktree's directory instead of `local_path`'s; it must be byte-equal to
  one of `worktrees`' own `path` entries — that list is the allowlist, same
  membership defense as `?path=` below — else 404 `not_found`. `path` itself
  is always the project's own `local_path`, unaffected by `?worktree=`.
  Cached 5s per directory (`AppState.git_view_cache`); the worktree list is
  cached 5s per `local_path` (`AppState.git_worktrees_cache`).
- `GET /api/projects/{id}/git/diff?path=<file>[&worktree=<path>]` →
  `GitFileDiff` via `git::diff_of`. `?path=` is allowlisted by **byte-equal
  membership in git's own status output** (path or rename orig_path) for the
  selected directory (`local_path`, or `?worktree=`'s target once validated
  the same way as the view route above) — traversal/absolute/unlisted paths
  are 404 `not_found`. Untracked files (status `??`) diff via the
  `--no-index` route.
- Of the History routes below, only `log` takes a `?worktree=`. A worktree has
  its **own HEAD**, so `git log` run there walks that worktree's branch — only
  the *object store* is shared, not the history (mesa task 805). The per-commit
  routes (`commits/{sha}/files`, `commits/{sha}/diff`) therefore need no
  selector: a sha reachable only from a linked worktree's branch still resolves
  from `local_path`, since it's content in that shared store. `file-log` takes
  none either — its caller is the Files tab, browsing `local_path`'s own tree.
- `GET /api/projects/{id}/git/log[?worktree=<path>][&all=true][&skip=N]` →
  `ProjectGitLog { path, commits, has_more }` via `git::commit_log_page`
  (`git log`, newest first). **Paged**: a page is `LOG_CAP` = 100 commits;
  `skip` (unsigned integer, default 0 → `--skip=N`) is the offset, so the next
  page is `skip + commits.length` while `has_more`. Git is asked for 101 and
  the extra only sets `has_more` (so a history of exactly 100 has no phantom
  next page). `all=true` walks every ref (`git log --all`); the default is the
  selected worktree's HEAD. **Ordering is git's default** — the route never
  adds `--topo-order`, `--date-order` or `--graph`: without a commit-graph file
  those force a walk of the whole history, and a page must stay bounded on a
  100k-commit repo (the client draws the graph from `parents`). A non-numeric
  or negative `skip`, or a non-boolean `all`, is rejected by the typed `Query`
  extractor with 400 (plain-text body, not the `{"error"}` envelope) before any
  handler code or git runs; values reach git only as separate argv entries,
  never through a shell. Same three-rung empty-state ladder one level deeper:
  no `local_path` → `{path: null, commits: null, has_more: false}`; dead
  folder/non-repo → `{path, commits: null, has_more: false}`; real repo →
  `{path, commits: Some(vec), has_more}` (`[]` on an unborn HEAD, in both
  modes). `?worktree=` reads the log from that worktree's directory instead of
  `local_path`'s, validated by the same `worktrees` allowlist as the view/diff
  routes (`resolve_git_dir`) — an unlisted value is 404 `not_found`. `path` in
  the response is always the project's own `local_path`. Cached 5s per
  `(folder actually read, all, skip, filters, branch)` (`AppState.git_log_cache`).
  - **`?branch=<name>`** (naru task 2737) logs that branch instead of the
    worktree's HEAD, read-only. The value must be byte-equal to the `name` of
    a local or remote row of `/git/branches` for the directory read (else 404
    `not_found`; the cached branch list is the allowlist) and is handed to
    git as the row's FULL refname (`refs/heads/<name>` /
    `refs/remotes/<name>`) as its own argv entry, so a branch named `-x`
    can never be read as a flag. `branch` with `all=true` is 422 `validation`
    (a branch log is not an all-refs log). Filters and `skip` keep working;
    `refs[].is_head` stays relative to the directory's HEAD. A blank `branch`
    is absent. `?branch_kind=local|remote` picks the row when a local and a
    remote branch share a short name (a local branch literally named
    `origin/main`): absent = the first match (local rows sort first), present
    = name AND kind must match (else 404), anything else 422 `validation`.
  - **Search filters** (naru task 2736): `?q=` (commit message), `?author=`
    (name or email), `?path=` (a file or folder), `?since=` / `?until=`
    (`YYYY-MM-DD`, inclusive days) narrow the log **on the server, over the
    whole history**, and page with `skip` like the plain log
    (`git::LogFilter`). Message and author are `--fixed-strings
    --regexp-ignore-case`, so `.*`, `-x` or shell characters are literal
    text; each value is its own argv entry after its flag (`--grep <q>`,
    `--author <a>`), never interpolated, so a value starting with `-` is the
    text searched for. Message and author together must both match. The path
    goes after `--` with `GIT_LITERAL_PATHSPECS=1` (`*` and `:(…)` magic are
    plain characters); it is checked by `git::valid_log_path` — relative, no
    `..` segment, no backslash or control character, `./` and a trailing `/`
    dropped — but need not exist on disk (a deleted file has history).
    **Renames are not followed** (no `--follow`, see `file-log` below): a
    renamed file's older commits are found under its old path. Dates are
    checked by `git::valid_log_date` and sent as `<day> 00:00:00` /
    `<day> 23:59:59` (a bare date makes git use the current time of day),
    in the server's local time, against the **committer** date (git's own
    `--since`/`--until`). A blank value is no filter; a bad date or path is
    422 `validation` before git runs. No match is `commits: []`, not an
    error.
  - **Bounded.** A page is still 100 commits (the result cap), and a
    filtered log run is killed after **10 s** (`git::LOG_TIMEOUT`; an
    unfiltered page reads at most 101 commits past `skip` and has no limit) — a search with no match on
    a 100k-commit repo walks everything. The response then carries
    `timed_out: true` with the commits found by then (the last record is
    dropped: it may be torn) and `has_more: false`. `ProjectGitLog.timed_out` is always false
    for `file-log`.
  - **`GitCommit`** = `{hash, short_hash, author, date, subject, parents,
    refs}`. `parents` are full shas (`%P`; empty for a root, 2 for a merge,
    3+ for an octopus). `refs: GitRef[]` come from `%D` under
    `--decorate=full`, so every name is unambiguous: `GitRef { kind, name,
    is_head }`, `kind` = `head | branch | remote | tag | other` (lowercase).
    `HEAD -> refs/heads/main` → `{branch, "main", is_head: true}`; a bare
    `HEAD` (detached) → `{head, "HEAD", true}`; `refs/heads/x` → branch `x`;
    `refs/remotes/origin/x` → remote `"origin/x"`; `tag: refs/tags/v1` → tag
    `"v1"`; anything else (`refs/stash`, notes) → `other` with the full ref
    name. `is_head` is the ref the log's own worktree has checked out (a linked
    worktree has its own HEAD). Both new fields are `#[serde(default)]`
    because `Store` persists `Vec<GitCommit>` as JSON in receipts and an old
    row has neither. Only this route fills `refs`: `log_between`/`log_since`
    (receipts, inbox triage) and `file-log` leave it empty, so a frozen
    receipt never captures where a branch pointed.
- `GET /api/projects/{id}/git/commits/{sha}[?repo=<path>]` → `GitCommitDetail
  { hash, short_hash, parents, author, author_email, author_date, committer,
  committer_email, committer_date, subject, body }` via
  `git::commit_detail_of` (`git log -n 1 --format=…`, fields split on `%x00`
  (NUL, which git cannot store in a name or subject) with the body last, so newlines in a message are safe). Dates are ISO 8601
  strict. `body` is `%b`: empty or multi-line, trailing newline trimmed, capped
  at 64 KiB on a char boundary (`[message truncated]` appended). The sha is
  checked by `is_valid_commit_id` before git runs; a bad/unknown sha, a
  non-commit object or no repo is 404 `not_found`. Cached 5s per `(dir, sha)`
  (`AppState.git_commit_detail_cache`).
- `GET /api/projects/{id}/git/file-log?path=<rel>` → `ProjectGitLog` (the same
  type and empty-state ladder as `/git/log`) via `git::file_log_page` — the
  whole-repo log narrowed by a pathspec (`git log … -- <rel>`), same `LOG_CAP`
  and parse. Always the first page only (no `skip`/`all`), with `has_more`
  true when the file has more than 100 commits; `refs` empty. Added for the
  Files tab's per-file History pane (mesa task 542, `docs/files-tab.md`); it lives here because it is a git read with this
  tab's posture, not the Files tab's. Missing `?path=` is 422 `validation`.
  `?path=` is resolved by **`files::safe_path`** against `local_path` — the
  Files tab's own chokepoint, not a git-output allowlist like the two diff
  routes — so traversal, absolute paths, symlink escapes and nonexistent
  paths are 404 `not_found`. That's the coherent gate for this route: its
  caller is browsing the filesystem tree, and a file not being in git *yet*
  is a legitimate answer (`commits: Some([])`), not a 404. Cached 5s per
  `(local_path, rel)` (`AppState.git_file_log_cache`).
  **Deliberately not `--follow`:** rename-following would list commits in
  which the file lived under a different path, and those commits' own
  changed-file lists — which allowlist the per-commit diff route below —
  don't contain the path that was asked about, so every pre-rename row would
  404 when clicked. The invariant "every commit `file_log_of` returns is
  diffable for that same path" is what the UI leans on, and is covered by a
  test in `git.rs` (`every_file_log_commit_is_diffable_for_that_path`).
- `GET /api/projects/{id}/git/commits/{sha}/files` → `Vec<GitCommitFile>` via
  `git::commit_files_of` (`git show --name-status -z`, merged by path with the
  same call's `--numstat -z`). `GitCommitFile` is a distinct type from
  `GitFile`: its `status` is a single name-status token (`A`/`M`/`D`/`R100`/…),
  not the two-column staged/unstaged porcelain pair a working-tree file has —
  a commit has no staged/unstaged distinction. It also carries `added` and
  `deleted` line counts (`number | null`; `null` = binary, no line count). A
  rename is keyed by its new path when the counts are merged; `-z` also means
  paths are never git-quoted.
  **Merge commits are diffed against their first parent**: the list, the
  numstat and the diff route all pass `--diff-merges=first-parent`, so a merge
  shows what it brought onto its branch, and every listed file has a non-empty
  diff (git's default combined diff lists almost nothing and renders as
  `diff --cc` text the UI cannot show). A non-merge commit is unaffected by the
  flag. `diff_stat` (receipts) is left alone. Root
  commits diff against the empty tree (all files `A`), so this and the diff
  route below work unmodified for a repo's first commit. 404 `not_found` on
  a malformed/unknown `sha` or no repo. Cached 5s per `(local_path, sha)`
  (`AppState.git_commit_files_cache`) — also backs the diff route's
  allowlist below, so selecting then diffing a commit's file doesn't re-run
  `git show --name-status` twice.
- `GET /api/projects/{id}/git/commits/{sha}/diff?path=<file>` → `GitFileDiff`
  via `git::commit_file_diff_of` (`git show --diff-merges=first-parent <sha> -- <path>`, same
  `DIFF_CAP` truncation as the working-tree diff). `?path=` is allowlisted by
  byte-equal membership in **that commit's own** `commit_files_of` result
  (not the working-tree status list the sibling `/git/diff` route uses) —
  an unlisted path, or a bad/unknown `sha`, is 404 `not_found`. Diff text
  itself is not cached (matches `/git/diff`'s precedent).
- Every `sha` accepted from a request path is validated by
  `git::is_valid_commit_id` (7–64 hex chars) **before** any `git` subprocess
  is spawned, so it can never be read as a flag or a path.

## Branches, worktrees and stashes (naru task 2737)

Three more read-only GET routes, every one behind the same empty-state ladder
(no `local_path` -> `path: null` and a null payload; dead folder / non-repo ->
`path` and a null payload; never an error) and the `?repo=` selector (an
unlisted one is 404). Each is cached 5 s (`AppState.git_wt_details_cache`,
`git_branches_cache`, `git_stashes_cache`; same eviction cap as the others).
**Ahead/behind is as of the last fetch: Naru never fetches** (no fetch, pull,
push, merge, rebase or reset anywhere in the tab; the only writes to branches
and stashes are the eight routes of "Branch and stash writes" below, each
started by the person).

- `GET /api/projects/{id}/git/worktrees[?repo=]` -> `ProjectGitWorktreeDetails
  { path, base_branch, details: [GitWorktreeDetail { path, changed, ahead,
  behind, subject, date }] }` via `git::worktree_details_of`: the slow
  per-worktree facts the cheap list on `/git` leaves out, one entry per
  worktree in list order, keyed by `path`. `base_branch` is the branch the
  main checkout (first entry git lists) is on, null when detached or bare.
  `changed` = entries of `git status --porcelain=v2` in that worktree; `ahead`
  / `behind` = `git rev-list --left-right --count <main HEAD sha>...<its HEAD
  sha>` (shas only, so nothing reads as a flag), null for the main entry
  itself. Every field is null when it does not apply: a bare, prunable or
  folder-missing worktree runs nothing (so a deleted worktree folder never
  errors), an unborn HEAD has no subject/date, a failed call is null. All
  HEAD subjects and committer dates (ISO strict) come from ONE `git log
  --no-walk=unsorted` (shared, so one unreadable worktree HEAD blanks every
  subject/date); the status calls run on up to 8 threads, each killed after 5 s (that
  worktree's `changed` is then null), and every git call added for these routes
  runs with `GIT_OPTIONAL_LOCKS=0` so none takes `index.lock`. Concurrent
  requests for one directory share a single computation (single-flight). **Measured:
  50 linked worktrees (5 dirty) take ~0.6 s** (`cargo test --lib
  worktree_details_of_50 -- --ignored --nocapture`, one run on the dev box,
  603 ms). Takes no `?worktree=`: it covers all of them.
- `GET /api/projects/{id}/git/branches[?repo=][&worktree=]` ->
  `ProjectGitBranches { path, branches: [GitBranch { name, kind, remote, hash,
  short_hash, date, subject, upstream, upstream_gone, ahead, behind, is_head,
  worktree, merged }] }` via `git::branches_of`: **one `git
  for-each-ref` over `refs/heads refs/remotes`** on the normal path (a second,
  retried without the `ahead-behind` atom, only on an unborn HEAD or git <
  2.41), plus one `git remote` per request — never a per-branch call, asserted
  by a test that counts invocations through a wrapper for 5 vs 300 branches; `git::parse_branches` is pure and
  tested against one call's output. Fields are NUL-separated and each record
  ends `\0\x1e` + the newline for-each-ref prints (the only free-text field,
  the subject, has no newline, so the sequence cannot occur inside a record).
  `name` is the short name (`feat/x`, `origin/feat/x`), `kind` is `local` |
  `remote`; symbolic refs (`origin/HEAD`) are skipped. `remote` is the longest
  `git remote` name that prefixes the name + `/` (a remote or a branch may
  contain `/`), else the first segment. `upstream` / `upstream_gone` /
  `ahead` / `behind` come from `%(upstream:short)` and `%(upstream:track)`
  (`[ahead N, behind M]`, `[gone]`); ahead/behind are null with no upstream or
  a gone one. `worktree` is `%(worktreepath)`: where it is checked out.
  `is_head` and `merged` (`%(ahead-behind:HEAD)` ahead = 0, git 2.41+) are
  relative to the directory read, so `?worktree=` (same allowlist as the view
  route) selects whose HEAD. If the call with that atom fails (old git,
  unborn HEAD) it is retried once without it and `merged` is null, still
  zero per-row calls. An unborn HEAD lists whatever refs exist; detached
  HEAD has no `is_head` row. Order is git's refname order.
- `GET /api/projects/{id}/git/stashes[?repo=]` -> `ProjectGitStashes { path,
  stashes: [GitStash { index, name, hash, message, branch, date }] }` via
  `git stash list`. `name` is `stash@{N}`; `branch` and `message` come from
  the reflog subject: `WIP on <branch>: <sha> <subject>` gives the subject
  (sha dropped), `On <branch>: <message>` the message; `(no branch)` or any
  other subject gives `branch: null` and the whole subject. No stashes (or an
  unborn HEAD) is `[]`. A stash is a commit: its `hash` works with
  `/git/commits/{sha}`, `/files` and `/diff` (first-parent diff = the stashed
  tracked changes). **Untracked files stashed with `-u` live in the stash's
  third parent and are not shown.**

## Write operations (naru task 2738)

The first routes that change a repo. Git 6/8 and 7/8 reuse the helpers named
below (`git::run_write`, `git::WriteOp`, `drop_git_caches`).

**Status read.** `view_of` runs `git status --porcelain=v2 --branch -z`, so a
path is never C-quoted: a space, quote, tab, newline, unicode or leading-`-`
name round-trips byte-exact (a name that is not valid UTF-8 is lossy). With
`-z` every record ends in NUL and a rename (`2 …`) record is followed by one
more NUL-terminated field, the original path; `parse_view` is pure and
unit-tested. `status_of`/`parse_status` (the sidebar) are unchanged. Untracked
mode stays git's default (`normal`): an untracked folder is one `dir/` entry.

**Types.** `GitFile.submodule` (`#[serde(default)]`): the porcelain `<sub>`
field starts with `S`. `GitRepoView.operation` (`#[serde(default)]`): the
operation in progress in that worktree, `"merge"`, `"rebase"`, `"cherry-pick"`,
`"revert"`, `"bisect"` or `null`, read from the worktree's own git dir
(`git rev-parse --absolute-git-dir`; a linked worktree has its own):
`rebase-merge/` or `rebase-apply/rebasing` (rebase wins), `MERGE_HEAD`,
`CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`. A rebase is `rebase-merge/` or
`rebase-apply/rebasing`; a bare `rebase-apply/` is a `git am` session and
reports `null`.

**Diff side.** `GET .../git/diff` gains `staged` (typed `Option<bool>`, so a
non-boolean is a 400 from the extractor). Absent is today's staged-plus-unstaged
diff against HEAD, byte-identical. For the allowlisted file
(`git::diff_of_file`, every path after `--` with `GIT_LITERAL_PATHSPECS=1`):

| file | `staged=true` | `staged=false` |
| --- | --- | --- |
| conflicted (`u` record) | `git diff HEAD -- path` | same |
| untracked | the `--no-index` all-added diff | same |
| other | `git diff --cached -- path` (works on an unborn HEAD); a staged rename passes `orig_path` and `path` with `-M` so it renders as a rename | `git diff -- path` (index against working tree) |

A conflict is diffed against HEAD because that is what yields a plain
`diff --git` of the working file with its `<<<<<<<` markers (bare `git diff`
prints a `diff --cc` combined diff the client's parser cannot render; a test
pins both). Where HEAD has nothing to show (a file deleted by us), the diff is
empty, never an error.

**Routes.** `POST /api/projects/{id}/git/stage`, `.../unstage`, `.../discard`.
JSON body:

```
{ "worktree": "<path>",         // REQUIRED, non-empty; byte-equal to a path in the worktree list
  "repo":     "<path>" | absent, // same selector as the GETs (resolve_repo_dir)
  "paths":    ["a", "b"] | absent,
  "all":      true | absent,     // stage/unstage only
  "confirm":  true | absent }    // discard only, REQUIRED there (below)
```

- **Guard.** `require_agent_access` is the first thing in each handler: a
  loopback peer, a local Host and a local Origin by default, the LAN page gate
  under `--lan`; plus the global Host allowlist and the `Content-Type:
  application/json` gate (415 without it). It was chosen because it is the
  strictest existing posture that still lets the local page and the `--lan`
  page work, and a repo write is exactly what a DNS-rebound or cross-site page
  must never reach. Never reachable by GET (405).
- **Shape (422 `validation`).** `worktree` missing or empty (a write never
  defaults to `local_path`); stage/unstage need exactly one of a non-empty
  `paths` or `all: true`; discard takes non-empty `paths` only, `all` is
  refused (there is no discard-all).
- **Allowlist (404 `not_found`).** A project with no folder, a dead folder, an
  unlisted `repo` or `worktree`, a non-repo, and any requested path that is not
  byte-equal to a `GitFile.path` of a **fresh** `git::view_of` (never the 5 s
  cache); the message names the path. Nothing is spawned.
- **Per-file rules (422), checked before any write.** A conflicted file in
  `paths` for any of the three ops ("… has conflicts; resolve it in the
  terminal"); discard of a submodule entry; discard of a tracked file whose
  unstaged column (Y) is `.` or `A` (intent-to-add, where `restore --worktree`
  is a silent no-op) ("nothing to discard"). `unstage` with `all: true` while
  `operation` is non-null is refused ("A merge is in progress in this
  worktree; unstage files one at a time, or finish or abort it in the
  terminal."), since bulk-unstaging cleanly merged files would drop them from
  the merge result; explicit `paths` stay allowed.
- **A path listed twice** (`D. keep.txt` plus `?? keep.txt` after `git rm
  --cached` and a re-create): stage and discard act on the untracked entry,
  unstage on the entry with something staged (`git::pick_entry`).
- **What runs** (`git -C <dir>` as argv, never a shell; `GIT_LITERAL_PATHSPECS=1`,
  `GIT_TERMINAL_PROMPT=0`; paths NUL-separated on stdin with
  `--pathspec-from-file=- --pathspec-file-nul`, so 5,000 paths are one git call
  and a leading `-` is never a flag):
  - **stage**: `git add` (modifications, deletions, untracked files and
    folders; a record whose Y is `R` also adds `orig_path`). A submodule entry
    stages only its gitlink, never its contents.
  - **unstage**: `git restore --staged`; on an unborn HEAD (`git rev-parse
    --verify -q HEAD` fails, and HEAD's branch ref does not exist)
    `git rm --cached -f -q` instead, index only, the working file survives. Any
    other HEAD failure (a ref whose commit is missing) is a 409 with nothing
    written, since `rm --cached` on a born repo would stage deletions. A record whose X is `R` also unstages `orig_path`,
    so both sides of a rename go. Files with nothing staged are skipped.
  - **`all: true`** is an explicit path list computed from the fresh status,
    then the same single call: stage-all = every non-conflict file with an
    unstaged change or untracked, unstage-all = every non-conflict file with a
    staged change. Nothing eligible is a success that spawns nothing.
  - **discard**: tracked paths in one `git restore --worktree` (back to the
    INDEX version, staged changes kept); untracked paths in `git clean -f -d -q
    -- <paths>`, limited to exactly those (an untracked folder entry `dir/`
    removes that folder; a nested repo refuses the discard, below), chunked if
    the argv would pass ~100 KiB.
- **Confirm (409 `conflict`, naru task 2802).** `discard` without `confirm:
  true` is refused after the allowlist and the per-file rules, before git runs:
  `Discarding throws these changes away and cannot be undone; confirm to
  proceed.` Nothing is changed and no cache is dropped. The UI puts the flag in
  the body only after its confirm dialog answered yes; `discard-hunks` has the
  same flag and refusal. This is the same server-side pattern as
  `allow_published` / `allow_merge` on an amend and `force` + `expected_hash`
  on a branch delete: a local caller past the agent gate cannot destroy work
  by leaving the dialog out.
- **Nested repositories (409, naru task 2802).** `git clean` silently skips a
  nested git repository, so before anything runs `git::discard` checks each
  untracked entry for a `.git` of its own and reads a dry run (`git clean -n -d
  -- <paths>`, `LC_ALL=C`, lines `Would skip repository <path>`). When any
  would be skipped the whole discard is refused: `git does not delete a nested
  git repository: <paths>. Nothing was discarded; remove it in the terminal.`
  A dry run that cannot be read refuses too.
- **Never.** `git add -A` / `git add .` (would mark a conflict resolved); a
  bare `git reset` (would abort a merge in progress); `git clean -x` or a
  `clean` without paths; touching the index in a discard; deleting
  `index.lock`; retrying a failed write.
- **Failure.** Git exiting non-zero (a held `index.lock`, say) is 409
  `conflict` whose `message` is git's own stderr, lossy UTF-8, trimmed, capped
  at 4 KiB. The standard `{"error":{"code","message"}}` envelope.
- **Caches.** After every attempt, success or failure, `drop_git_caches` clears
  `git_view_cache`, `git_cache`, `git_wt_details_cache`, `git_branches_cache`
  and `git_log_cache`, whole rather than by key (the write runs in the
  worktree path git lists while a GET may have cached the same folder as
  `local_path` spelled another way), so the next GET is fresh. It also bumps
  `AppState.git_epoch`; every cache fill reads the epoch before spawning git
  and skips its insert if it moved, so a GET that began before the write
  cannot put its pre-write answer back.
- **Success.** 200 with the fresh `GitRepoView` of that worktree, recomputed
  after the write.

Tests: `src/core/git.rs` (real temp repos: every op born and unborn, rename,
awkward names, merge conflict, `index.lock`, 5,000 files) and `src/api.rs`
(`git_write_*`, `git_diff_staged_*`); `scripts/api-check.sh` asserts the gate
and validation halves of the three routes.

## Hunk and line staging (naru task 2739)

Stage, unstage or discard part of one file's diff: a hunk, or single lines
inside it. The routes sit beside the whole-file ones and reuse their helpers
(`git::run_write`, `drop_git_caches`, `git::pick_entry`, `git::check_write`).

**Routes.** `POST /api/projects/{id}/git/stage-hunks`, `.../unstage-hunks`,
`.../discard-hunks`. Same gate as the whole-file writes (`require_agent_access`
first, JSON Content-Type, never a GET). JSON body:

```
{ "worktree": "<path>",            // REQUIRED, non-empty, as for git/stage
  "repo":     "<path>" | absent,
  "path":     "<file>",            // REQUIRED; byte-equal to a path of a FRESH view_of
  "digest":   "<string>",          // REQUIRED; GitFileDiff.digest the client rendered from
  "hunks": [ { "index": 0, "lines": [3, 4] | absent } ],   // REQUIRED, non-empty
  "confirm":  true | absent }      // discard-hunks only, REQUIRED there
```

`discard-hunks` without `confirm: true` is a 409 (the text of the whole-file
discard's refusal), checked after every other check and before `git apply`;
nothing is applied.

`index` is the 0-based ordinal of the `@@` hunk, each at most once. `lines`
absent is the whole hunk; present it is a non-empty list of 0-based body-line
indices inside that hunk. Body lines are the lines after the `@@` header that
start with ` `, `+` or `-`; `\ No newline at end of file` lines are not
counted. Every listed line must be a `+` or `-` line. Stage and discard pick
from the unstaged diff (`GET git/diff?staged=false`), unstage from the staged
one (`staged=true`).

**Digest and eligibility.** `GitFileDiff.digest` (`#[serde(default)]`,
`string | null`) is set only when the diff was read with `staged=true|false`
and the file can take hunk operations: tracked, not conflicted, not a
submodule, not a rename (`orig_path` null), and its raw diff is within
`DIFF_CAP`, is one file, has at least one hunk, whose header holds none of
`new file mode`, `deleted file mode`, `rename from`, `copy from`,
`Binary files`, `GIT binary patch`, and whose lines all parse with counts that
match their `@@` headers (`git::hunk_digest`). Everywhere else, including the
commit diff, it is null. The client shows hunk and line controls iff it is not
null. The digest is the raw diff's byte length and a `DefaultHasher` hash
(`"{len:x}-{hash:016x}"`; no hashing crate is a dependency). It is a staleness
check, not a security boundary.

**Canonical diff.** The `staged=true|false` diff of a tracked file is read with
`--unified=3 --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/`, so
the text is exactly what a patch can be built from whatever the user's config
says. Textconv and external-diff output is therefore no longer shown on those
two sides, and a user's `diff.context` does not apply there: the context is
pinned at three lines, because `git apply` anchors a hunk with no context to
the end (or start) of the file wherever its lines match, which with
`diff.context=0` could stage a different, identical line. The conflicted,
untracked and `staged`-absent diffs are unchanged.

**Order of checks.** Body shape (422) -> project, repo, worktree (404) -> a
FRESH `view_of`, the path in it (404; unstage uses the entry with something
staged) -> per-file rules (422: conflicted "... has conflicts; resolve it in
the terminal", untracked, submodule, rename, "nothing staged" / "nothing
unstaged" / "nothing to discard") -> the raw diff of that side is eligible
(422) -> the digest (409) -> the patch (422) -> `git apply` (409) -> 200.

**The patch** (`git::build_partial_patch`, pure, built from bytes: CR and
non-UTF-8 survive). Its header is only the `diff --git`, `---` and `+++`
lines, so a mode change is never staged by a hunk operation. Forward (stage): a
selected `+`/`-` stays, an unselected `-` becomes context, an unselected `+` is
dropped. Reverse (unstage, discard): an unselected `+` becomes context, an
unselected `-` is dropped. Because the added lines of a changed block follow
its removed lines in the diff, staging only `-b` and `+B` of `-b -c +B +C`
leaves `a, c, B` in the index (git's own `add -p` does the same). Every `@@`
count is recomputed from the lines kept and the changing side's start is
shifted by the lines the earlier emitted hunks added or removed. A line without
a trailing newline must stay the last line of its side, so half of a removed
and added pair around it is refused ("select its removed and added lines
together"); the pair together is fine. A picked hunk left with no change line
is refused.

**What runs.** One `git apply` with the patch on stdin through
`git::run_write` (`git::apply_hunks`): stage `apply --cached --whitespace=nowarn
-`, unstage `apply --cached --reverse --whitespace=nowarn -`, discard `apply
--reverse --whitespace=nowarn -` (working tree). Argv only, never a shell;
never retried; `index.lock` is never touched.

**Failure and stale.** A digest that is not the current diff's is 409
`conflict` with exactly `The diff changed since it was shown. It was reloaded;
nothing was applied.`; the caches are dropped, nothing that writes is spawned.
`git apply` failing (a held `index.lock`, a patch git refuses) is 409 with
git's own stderr. `drop_git_caches` runs after
every attempt; success is 200 with the fresh `GitRepoView`.

**Not offered.** Untracked, new, deleted, renamed, copied, binary, submodule,
conflicted and truncated (over-cap) files have no hunk operations: whole-file
stage, unstage and discard remain.

Tests: `src/core/git.rs` (pure builder on literal diffs; real temp repos
asserting the exact `git diff --cached` and `git diff` after each operation)
and `src/api.rs` (`git_hunk_*`, `git_diff_digest_*`); `scripts/api-check.sh`
asserts the gate and validation halves of the three routes.

### Client

Hunk and line staging lives in the working-tree diff pane only (`GitWorkingTree`'s `DiffPane` -> `DiffView` with the opt-in `staging` prop); the History commit diff and the Files tab render exactly as before. Every rule is pure in `frontend/src/gitHunks.ts` (covered by `gitHunks.test.ts`); the components only lay it out.

- **When controls exist**: the diff's `digest` is non-null AND the worktree path is known AND the file is not untracked or conflicted. Otherwise there are no hunk or line controls and whole-file staging in the list is unchanged. For a tracked file whose `digest` is null but whose diff has hunks (new, deleted, renamed, binary-with-text, truncated, submodule) the sticky header carries one muted note (`[data-hunk-note]`): "Hunk and line staging is not available for this file; stage the whole file from the list."
- **Hunk buttons** on each hunk header row (`[data-hunk-index="N"]`, N the contract's 0-based index): on the Changes (unstaged) diff "Stage hunk" and "Discard hunk" (danger); on the Staged diff "Unstage hunk" (`[data-hunk-action="stage|unstage|discard"]`). On a narrow pane they wrap under the hunk header text. Every control's title and aria-label names the worktree ("Stage hunk 2 of src/a.ts in …/folder (branch)", "Stage 3 selected lines of src/a.ts in …/folder (branch)"), and every one is disabled while a write is in flight and while the shown diff is being reloaded.
- **Line selection**: only changed lines ('+' and '-') are selectable, through their line-number gutter cell (`[data-line-pick="<hunk>:<idx>"]`, `role="button"`, `aria-pressed`, `aria-label` "Select added line 42" / "Select removed line 17", `tabIndex=-1`; Space or Enter toggles one that has focus). Click toggles one line; Shift-click adds the range from the last clicked line (diff order, across hunks, changed lines only); press and drag down or up the gutter selects (or, when the pressed line was already selected, deselects) the range dragged over. In Split mode a changed row's left number selects its removed line and its right number its added line, independently; in Inline mode the number on the line's own side does. A selected line tints its gutter cell (an accent bar) and its text cell, from theme tokens only. The selection belongs to one file, side and diff text: it resets when any of them changes. One set of handlers sits on the grid (event delegation on `data-line-pick`), not one per cell.
- **Selection bar**: while lines can be picked the sticky header always shows `[data-lines-bar]` (with `data-lines-count`; a bar that appeared on the first pick would shift the lines under a drag): "Click or drag line numbers to select lines" with its buttons disabled at 0, else "N lines selected", "Stage selected lines" (Changes side) or "Unstage selected lines" (Staged side) (`[data-lines-action="stage|unstage"]`) and "Clear" (`[data-lines-action="clear"]`). Esc inside the diff clears a line selection first; the next Esc is the tab's existing back-to-the-row (`GitWorkingTree`'s `backRef` asks the diff to clear before it does anything else). Listed in the "?" keys.
- **Phone / touch**: the hunk buttons wrap under the header text and are 44px high; a tap on a line number toggles that line. There is no drag-select on touch (the pane scrolls under a finger) and no Shift-range; the bar's Stage / Unstage / Clear are the same 44px buttons. Drag-select is mouse (and pen) only.
- **Discard hunk** goes through the same gate as a file discard (`createGitActions.discardHunks`): it awaits `confirm(plan)` and calls the route only on true. The dialog shows "Discard this hunk?", the worktree's full path and branch, the lines to be lost (each '+' / '-' line of the hunk as text, monospace, scrollable, up to 200 then "and N more"), "The added lines are removed from the working file and the removed lines are restored. Staged changes are kept.", "This cannot be undone." and the danger button "Discard hunk". Stage and unstage never ask. Line-level discard does not exist. `gitActions.test.ts` pins that `discardProjectGitHunks` appears only in `api.ts` and `gitActions.ts`, and the `/git/discard-hunks` string only in `api.ts`.
- **After a write** (success or error) the pane reuses the file list's `run()`: the view is re-read, git's own message is shown verbatim in the alert (`Could not stage hunk 2 of src/a.ts in <worktree>:` ...), and a 409 stale reply shows its own sentence ("The diff changed since it was shown. It was reloaded; nothing was applied."). The diff is re-read in place: `DiffPane` keeps showing the previous diff of the same file, side and worktree while the new one loads, so `DiffView` stays mounted and the pane's scroll position survives; a different file still shows "Loading…". If the file leaves its section (everything staged) the existing selection-follow applies.
- **Untrusted text**: diff text, paths and git's messages reach the page as text nodes only; classes come from the model.
- **Test hooks**: `[data-hunk-index]`, `[data-hunk-action]`, `[data-line-pick]` (+ `aria-pressed`), `[data-lines-bar]`, `[data-lines-action]`, `[data-hunk-note]`; the confirm dialog keeps its `data-git-confirm` hooks.

## Commit and amend (naru task 2740)

`POST /api/projects/{id}/git/commit` makes one commit of the **index** (never
the working tree) or amends HEAD; `GET .../git/commit-info` is what the
commit box reads first. The control is for the person: it is **not wired into
any agent flow** (an agent commits with `git` in its terminal).

**`GET .../git/commit-info[?worktree=][&repo=]`** → `ProjectGitCommitInfo
{ path, info }`. Standard guard only, **not cached**, the usual empty-state
ladder (`path` null = no `local_path`; `info` null = dead folder or not a
repo), the same `?repo=`/`?worktree=` allowlists (unlisted → 404).
`git::commit_info_of` (every read `GIT_OPTIONAL_LOCKS=0`, stdin null, argv
only; a read that fails is `None`/`false`, never a panic):

- `branch`/`detached` from `symbolic-ref -q --short HEAD`; `unborn` from
  `head_is_unborn` (an unreadable HEAD reads as *not* unborn, with no `head`).
- `head` (None when unborn): hash, short hash, `message` = git's `%B` of HEAD
  read with `log -z`, so it is the whole raw message, uncapped, with nothing
  added; `is_merge` = more than one parent.
- `upstream` = `rev-parse --abbrev-ref --symbolic-full-name @{upstream}`;
  `published_on` = the ref that already holds HEAD: the upstream when
  `merge-base --is-ancestor HEAD <full upstream ref>` exits 0; else, on a
  branch, the first remote-tracking branch that contains HEAD (`for-each-ref
  --contains HEAD refs/remotes`, `<remote>/HEAD` skipped), which is how a
  branch pushed without tracking is seen (naru task 2801); else None.
  `head_published` = `published_on` is set, OR that `for-each-ref` lookup
  failed, could not be run or passed its 5 s timeout (`git::pushed_on`, naru
  task 2802): it fails closed, `head_published: true` with `published_on:
  null`, so the amend still needs `allow_published`. Always None / false on an unborn
  or a detached HEAD (amending there moves no branch). It reads the local
  remote-tracking refs as of the last fetch or push; nothing is fetched.
- `author_name`/`author_email` = `git -C <dir> config --get user.name|email`
  (so the worktree's or repo's own config applies); None when unset or blank.
  Only config is read: an identity supplied by `GIT_AUTHOR_*` in the server's
  environment is not seen, and the commit is refused for lack of one.
- `operation` as in `GitRepoView.operation`; `prepared_message` while it is a
  `merge`, `cherry-pick` or `revert` and `<git dir>/MERGE_MSG` exists: that
  text without its `#` lines, trailing whitespace trimmed, capped at the 64 KiB
  body cap; None when empty.

**`POST .../git/commit`.** Body `{ worktree, repo?, message, staged_digest,
amend?, expected_head?, allow_published?, allow_merge? }`. `require_agent_access` first, never a GET
(405), JSON Content-Type. Success `200` → `GitCommitResult { hash,
short_hash, amended, view }` (`view` = a fresh `view_of`). Order, nothing that
writes runs before every check passes:

1. Shape, `422 validation`: `worktree` missing or empty; `message` missing;
   `message` empty after normalisation (`commit message is empty`); amend
   without `expected_head` or with one that is not a FULL lowercase hash
   (exactly 40 or 64 hex digits), so a short or uppercase one is never a
   misleading 409; `staged_digest` missing (`staged_digest is required`).
2. Project folder, repo, worktree: `404`, exactly as `git_write`.
3. A **fresh** `view_of` (404 when not a repo) and a fresh `commit_info_of`.
4. `422`: a conflicted file (`<path> has conflicts; resolve it in the
   terminal, then stage it`); no identity (`No author identity is set. Run: git
   config user.name "Your Name" and git config user.email you@example.com`);
   amend on an unborn HEAD (`there is no commit to amend`); amend while an
   operation is in progress (`A <op> is in progress in this worktree; amend is
   not available`); no amend and nothing staged (`nothing is staged`) unless the
   operation is `merge` (concluding a merge may stage nothing).
5. `409 conflict`, in this order: amend and `expected_head` is not
   HEAD's full sha (`HEAD
   moved since the last commit was loaded. It was reloaded; nothing was
   committed.`, caches dropped); `staged_digest` is not the fresh view's
   (`The staged changes changed since they were shown. They were reloaded;
   nothing was committed.`, caches dropped); amend and `head_published` without
   `allow_published: true` (`The last commit is already on <published_on>. Amending
   rewrites published history; confirm to proceed.`, or when the pushed lookup
   failed, `It could not be checked whether the last commit was pushed.
   Amending a pushed commit rewrites published history; confirm to proceed.`);
   amend of a merge commit
   (`head.is_merge`) without `allow_merge: true` (`The last commit is a merge
   commit. Amending replaces it with a new merge commit; confirm to proceed.`).
6. `git::commit` (below). Git or a hook failing is `409 conflict` carrying the
   text.
7. After **every** attempt past step 5, success or failure,
   `drop_git_caches` runs and `git_file_log_cache` is cleared; on success the
   new HEAD is resolved (`git::head_of`) and returned.

**What runs.** `git -C <dir> commit --cleanup=verbatim -F -` (+ `--amend`),
message on **stdin**, never argv or a temp file. Env: `GIT_TERMINAL_PROMPT=0`
only; `GIT_LITERAL_PATHSPECS` is deliberately **not** set, because hooks
inherit the environment and their own git pathspecs must keep working. Never
`--no-verify`, `--allow-empty`, a pathspec or `-m`; never a push, a retry, or a
removal of `index.lock` (a held lock is git's own error, and the file stays).
Hooks run normally and inherit the server's environment, so a hook that needs a
tool missing from a launchd `PATH` fails with its own message. Both pins are
check-then-act: an amend's HEAD is compared to `expected_head`, and the staged
set to `staged_digest`, in the handler and again
just before git runs (same 409s), but the window is one git spawn, not atomic
(an atomic `commit-tree` + `update-ref` would skip the hooks).

**Staged digest (naru task 2801).** A commit records whatever is in the index
when git runs, so the client sends back the `GitRepoView.staged_digest`
(`#[serde(default)]`) of the view its staged list was drawn from, and a file
staged meanwhile by an agent or another process is a 409 instead of part of the
commit. `git::parse_view` computes it from the same `git status` read as the
file list, over every entry with a staged change (X is not `.`): X, the HEAD
and index modes, the HEAD and index blob ids, the path and a rename's original
path. `"{entries:x}-{DefaultHasher:016x}"`, like the hunk digest: a staleness
check, not a security boundary. Nothing of the working-tree side goes in, so an
unstaged edit, an untracked file or a conflicted entry does not move it; the
same path staged again with other content does. It is required on a plain
commit, an amend and a merge conclusion alike (the digest of an empty staged
set is a value too).

**Message.** `normalize_commit_message`: `\r\n` to `\n`, leading blank lines
dropped, trailing whitespace of the whole text trimmed, exactly one `\n` last;
nothing left is `None`. Nothing else is touched: with `--cleanup=verbatim` a
`#` line is ordinary text (default cleanup would delete it), and inner
whitespace, unicode and a leading `-` survive. The commit's raw message
(`git cat-file commit HEAD`, after the first blank line) is byte-equal to the
normalised text, and `normalize_commit_message(head.message)` reads back the
same value.

**Output and timeout.** stdout and stderr are both captured (a hook may print
to either) on their own threads, so a chatty hook cannot deadlock the pipes,
and a failure returns stderr then stdout, lossy UTF-8, trimmed, capped at 64 KiB
(`COMMIT_ERR_CAP`) keeping the **tail** (a hook's real failure line is last);
when anything was dropped `[output truncated]\n` is prepended. `COMMIT_TIMEOUT` is 120 s:
the child leads its own process group (`proc::isolate`); past the deadline the
**group** gets TERM (git removes its own lock files); if git has not exited
2 s later the group gets KILL. If git did exit in that time, nothing more is
signalled (its pid may be reused once reaped), so a hook child that ignores
TERM and outlives git may linger. The error is `git commit did not finish within 120 s
and was stopped. Nothing was retried.` plus whatever was captured.
`commit_within` takes the timeout so a test can use 1 s. A descendant that
left the group and holds a pipe is waited on for at most 2 s.

**Signing.** `commit.gpgsign` and `gpg.program` apply as configured; a signer
that fails or hangs is git's error text, or the timeout. Naru never prompts
(`GIT_TERMINAL_PROMPT=0`), so a signer needing a pinentry fails or times out.

**Tests.** `src/core/git.rs` `commit_tests` (real temp repos, own identity,
`commit.gpgsign false`, own `core.hooksPath`): exactly one new commit whose
tree equals the pre-commit `write-tree` and whose message bytes equal the input
(multi-line, unicode, a leading `-`, a leading `#`, 100 KiB), unstaged and
untracked files untouched, root commit, amend (parent, count, message, tree,
author preserved), failing `pre-commit`/`commit-msg` (both outputs, HEAD and
index unchanged), a passing hook, a held `index.lock` (stays), a hung hook
stopped at an injected 1 s timeout with no lock left, a failing gpg program,
`normalize_commit_message`, `commit_info_of` (born/unborn/detached, identity,
published, pushed without an upstream, prepared message, linked worktree), the
staged digest (pure on porcelain text, and on a real index). `src/api.rs` `git_commit_*`:
happy path with fresh follow-up reads, the 422 table, unborn amend, conflict
and merge, stale `expected_head`, published amend with and without
`allow_published` (with an upstream, and pushed without one), a stale
`staged_digest` (409, no commit, index untouched; an unstaged edit is not
stale), a merge-commit amend with and without `allow_merge`, a failing hook,
404s, the agent gate, a linked worktree
moving only its own branch, the commit-info ladder. `scripts/api-check.sh`
asserts the gate halves and that `commit-info` answers 200.

## Branch and stash writes (naru task 2741)

Eight POST routes: create, switch, rename and delete a branch; push, apply, pop
and drop a stash. Like `commit` they are for the person: **not wired into any
agent flow**. Logic lives in `src/core/git.rs` (`create_branch`,
`switch_branch`, `rename_branch`, `delete_branch`, `stash_push`,
`stash_entry_op`, `valid_new_branch_name`, errors as `git::RefErr`), the routes
in `src/api.rs` are a thin layer mapping `RefErr` to 422 `validation`, 404
`not_found` and 409 `conflict`. All eight: POST only (405 on a GET),
`require_agent_access` first, JSON Content-Type, `worktree` **required and
non-empty** (422 `validation` otherwise), optional `repo`; project/repo/worktree
resolution and 404s exactly as `git_write` (no folder, unlisted `repo`,
unlisted `worktree`). A write acts **only in the resolved worktree dir**.
Success is `200` with `GitRefResult { view, notice }` (`view` = a fresh
`view_of` of that worktree; `notice` a one-line string or null), except delete.

**Order of checks** (nothing that writes runs before all of them pass): body
shape 422 -> project/repo/worktree 404 -> a FRESH `git::branches_of` (or
`stashes_of`) as the allowlist -> per-state rules 422 -> the git call (409 on
failure). Every existing branch name must be **byte-equal to a `kind: local`
row of that fresh listing** and is handed to git only after that; an existing
name beginning with `-` is refused 422 ("rename it in the terminal"), so no
value reaches git as a flag. New names go through `valid_new_branch_name`.
`is_head` in the listing (read from the selected worktree) is "the current
branch of this worktree"; a row with a `worktree` and `is_head` false is held by
ANOTHER worktree.

**Operation in progress** = a fresh `view_of(dir).operation` is non-null. Then
switching (including create with `switch`) and stash push/apply/pop are 422
`A <op> is in progress in this worktree; <action> is not available. Finish or
abort it in the terminal.` (`switching branches`, `stashing`, `applying a
stash`, `popping a stash`). Create without a switch, rename, delete and stash
drop are allowed.

**Routes**

1. `POST .../git/branch-create` `{worktree, repo?, name, from_commit?,
   from_remote?, switch?}`. Both `from_commit` and `from_remote` = 422.
   `from_commit` must be a FULL lowercase hash, 40 or 64 hex digits (`is_full_hash`,
   422: an abbreviation could be shadowed by a tag or branch of that name; the UI
   sends `commit.hash`) and resolve with
   `rev-parse --verify -q <sha>^{commit}` (404); git gets the resolved FULL
   hash. `from_remote` must be byte-equal to a `kind: remote` row (404) and is
   handed to git as `refs/remotes/<name>`. Neither = the worktree's HEAD
   (detached works; an unborn HEAD is git's own 409). Runs `git branch <name>
   [<start>]`, or with `switch: true` ONE `git switch -c <name> [<start>]`, so
   a refused switch creates nothing. Neither `--track` nor `--no-track` is
   passed: git's default tracking applies, and it only writes local config.
2. `POST .../git/branch-switch` `{worktree, repo?, name, stash?}`. `name` is a
   local row (404); 422 `already on <name>` when it is this worktree's branch;
   422 `<name> is checked out in <path>` when another worktree has it. Runs
   `git switch --no-guess <name>`: never `-f`/`--discard-changes`, never a
   remote DWIM guess (a remote-only name is a 404, it is not a local row). A
   dirty tree git refuses to carry is a 409 with git's text and the tree
   untouched. With `stash: true`: first `git stash push --include-untracked -m
   "naru: before switching to <name>"`; whether an entry was really made is
   decided by `refs/stash` and the entry count before and after AND the newest
   entry being ours: its first parent is this worktree's HEAD and its message
   carries the `naru: before switching to <name>` marker, so a sibling
   worktree's concurrent stash is not mistaken for ours. Nothing to stash = a
   plain switch. When one was made, `notice` is `Stashed your changes
   as stash@{0} before switching.`; if the switch then fails the 409 starts
   `Your changes were stashed (stash@{0}) and were NOT restored; the switch
   failed:` + git's text (the stash is never popped for you). Note a failing
   `post-checkout` hook makes git exit non-zero although HEAD did move: that is
   reported as the same 409.
3. `POST .../git/branch-rename` `{worktree, repo?, name, new_name}`. `name` a
   local row; 422 when another worktree has it checked out (an agent is on
   it); this worktree's own current branch may be renamed. Runs `git branch -m
   <name> <new_name>`.
4. `POST .../git/branch-delete` `{worktree, repo?, name, force?, expected_hash?}`.
   `name` a local row; 422 when checked out anywhere (`<name> is the current
   branch of this worktree` / `<name> is checked out in <path>`). Without
   `force`: `git branch -d`. If git refuses with "not fully merged" the answer
   is **200** `GitBranchDeleteResult { deleted: false, refusal, hash,
   unmerged, unmerged_more, view }`: `refusal` is git's text, `hash` the
   branch's full tip, `unmerged` up to 50 commits (`GitCommit`, newest first)
   reachable from the branch and from no other ref, `unmerged_more` true when
   more exist. `unmerged` is `git log refs/heads/<name> --not
   --exclude=refs/heads/<name> --all`; `--all` covers every ref (branches,
   tags, remotes, `refs/stash`) and the HEAD of EVERY worktree, so a commit
   another worktree's detached HEAD holds is not listed, and a commit kept alive
   only by a stash counts as still reachable. Any other git failure
   is 409. With `force: true`: `expected_hash` is REQUIRED, exactly 40 or 64
   lowercase hex digits (422), and must equal the branch's current tip, else
   409 `<name> moved since the delete was confirmed. It was reloaded; nothing
   was deleted.`; then `git update-ref -d refs/heads/<name> <expected_hash>`
   (`git::force_delete_ref`, naru task 2802), which git applies only while the
   ref still holds that hash: a branch that moves after the check is kept and
   answers the same 409. `update-ref` does not refuse a checked-out branch as
   `branch -D` did, so the branch list is re-read right before it (422 when a
   worktree now holds the branch; the window is one spawn). The branch's `branch.<name>` config section is then
   removed, as `git branch -D` would. A deletion answers `{ deleted:
   true, refusal: null, hash, unmerged: [], unmerged_more: false, view }`.
5. `POST .../git/stash-push` `{worktree, repo?, message?, include_untracked?}`.
   `message` is trimmed; blank = none; a control character (so a newline) or
   over 200 bytes = 422. Runs `git stash push [--include-untracked] [-m
   <message>] --` (the `--` forbids a pathspec). No new entry of ours (the
   shared `refs/stash` tip and count unchanged, or the newest entry's first
   parent is not this worktree's HEAD) = 200 with `notice: "No local changes to
   stash."`. Residual window: a sibling worktree on the very same HEAD commit
   that stashes at the same instant is indistinguishable. If
   git fails after saving its entry (its cleanup step failed) the 409 adds `A
   stash entry was saved (stash@{0}); your changes are in it.`
6. `POST .../git/stash-apply`, `.../stash-pop`, `.../stash-drop` `{worktree,
   repo?, index, hash, confirm?}`. A FRESH `stashes_of`: no entry at `index` = 404; its
   `hash` not equal to the body's = 409 `The stash list changed since it was
   shown. It was reloaded; nothing was applied.` (`...dropped.` for drop).
   Then the confirm (naru task 2802), a 409 that runs nothing: a drop without
   `confirm: true` (`Dropping stash@{N} removes it for every worktree and
   cannot be undone here; confirm to proceed.`), and an apply or pop without it
   when a fresh `view_of` lists any file, untracked included, or cannot be read
   (`This worktree has uncommitted changes and stash@{N} would be applied on
   top of them; confirm to proceed.`). A clean tree needs no flag. Git
   is then handed the stash COMMIT hash, never a position (the list is shared
   by every worktree, and a sibling's `stash push` shifts indexes): apply =
   `git stash apply <hash>`; pop = that apply and, only on success, a re-list
   and `git stash drop` of the entry now carrying that hash (hash gone = 200
   with a `notice` and nothing dropped; a failing drop = 200 with a `notice`,
   the apply stands); drop = a re-list right before the spawn mapped to the
   current index (gone = 409 `...nothing was dropped.`). Never `--index` (staged
   changes come back unstaged; deliberately plain). Remaining window: one
   process start between the last re-list and `git stash drop stash@{N}`. A
   conflicting apply/pop is a 409 carrying git's text (it prints conflicts on
   STDOUT, so the error is stderr then stdout), the stash is **kept** and the
   conflict shows in the fresh status. Drop is allowed during an operation.
   **The stash list is shared by every worktree of the repo; apply and pop act
   on the selected worktree.**

**New branch names** (`valid_new_branch_name`, 422 on any): not empty, at most
255 bytes, no leading `-`, no control character, not `@`; `git
check-ref-format --branch <name>` must exit 0 AND print the input back
unchanged (it expands `@{-1}` and friends, an expansion is a refusal); no local
branch of that name (`a branch named X already exists`) and no tag
(`refs/tags/<name>` exists: `a tag named X already exists`). Unicode and `/`
are fine.

**What runs.** Every write goes through `git::run_ref_write`, which is
`run_bounded`, the machinery `commit` also uses (extracted from
`commit_within`; commit behaviour unchanged): `git -C <dir> <args>`, stdout AND
stderr captured on their own threads, a 120 s timeout over the whole process
group (TERM, then KILL after 2 s), failure text = stderr then stdout, lossy
UTF-8, trimmed, the last 64 KiB kept. Env: `GIT_TERMINAL_PROMPT=0` and
`LC_ALL=C` (so "not fully merged" can be matched; hooks inherit it). **Not**
`GIT_LITERAL_PATHSPECS`: `switch` runs `post-checkout` hooks, which inherit the
environment (same reasoning as commit). **Never** a push, pull, fetch, remote
write, merge, rebase, reset, `checkout -f`, `switch -f`/`--discard-changes`, a
retry, or a removal of `index.lock` (a held lock is git's own 409 and the file
stays).

**Caches.** After every attempt that got past validation (success, a 409, a
panic) `drop_git_caches` runs; a 422 or 404 never reached git and drops
nothing. `drop_git_caches` now also clears `git_stashes_cache`,
`git_worktrees_cache` (branch names per worktree), `git_repos_cache` (the
`branch` of each repo) and `git_file_log_cache`, which it did not before. Their
fills were NOT epoch-guarded either (`git_stashes_cache` was, through
`git_cached`); `git_worktrees_at`, `git_repos_at` and the file-log fill now
read `git_epoch` first and skip the insert when a write dropped caches
meanwhile, like the view and log fills do.

**Tests.** `src/core/git.rs` `ref_tests` (real temp repos with a linked
worktree, own identity, `commit.gpgsign false`, own `core.hooksPath`): the
invalid-name table, create from HEAD/commit/remote/with switch, detached and
unborn HEAD, switch (clean, dirty refused with the tree untouched,
stash-and-switch, stash then failing switch, held by another worktree, a
dash-named branch, an operation in progress), rename, delete (merged, unmerged
refusal then force, moved, checked out here/elsewhere, the 50 cap), the
unmerged set against a branch-only commit, one also on a branch, on a tag and
on another worktree's detached HEAD, stash push/apply/pop/drop (by hash, with a sibling worktree's stash shifting
the indexes in between), a sibling's stash not mistaken for ours, a conflicting
pop and apply (error text, stash kept, conflict in `view_of`), a held
`index.lock`, a hung `post-checkout` hook stopped at an injected 1 s, and a
source scan (`remote_touching_git_commands = 0`) asserting no production git
argv begins with push, pull, fetch, merge, rebase, reset, clone, checkout and
so on, that no `--force`/`--discard-changes` appears, and that the one `git
remote` is the read-only listing in `remotes_of`. `src/api.rs` `git_ref_*`:
every route's happy path with fresh follow-up GETs (branches, stashes,
worktree list, repo list), the 422/404/409 tables, the agent gate on all eight,
and a linked worktree whose writes do not touch the main checkout.
`scripts/api-check.sh` asserts the gate halves and the ladder for all eight.

### Client

Branch and stash actions live on the Git tab's **Refs** panel (`GitSidePanel`) and in the History commit detail. Every rule is pure: `frontend/src/gitRefs.ts` (which controls are off and why, labels, target lines, the name check; `gitRefs.test.ts`) and `frontend/src/gitActions.ts` (the confirm plans and `createGitRefActions`, the gate; `gitActions.test.ts`). `useGitRefOps.ts` owns the state, `GitRefDialogs` / `GitFormDialog` / `GitConfirmDialog` / `GitRefMessages` lay it out; the components never call the api. The ops hook lives in `GitRepoPane`, not in the panel: a drawer panel unmounts when it closes, and "Create branch here" in History has to work with it closed.

- **The gate** (`createGitRefActions({api, confirm})`; the api is bound only in `projectGitRefApi`). `deleteBranch` always awaits `confirm(deleteBranchPlan)` before the first call; a refusal as unmerged (a 200, `deleted: false`) awaits a SECOND, distinct `confirm(forceDeletePlan)` that lists `unmerged` as "abc1234 subject" (up to 50, then "and more" when `unmerged_more`) and states the count that becomes unreachable, even 0 ("0 commits become unreachable: ..."); only a yes sends `force: true, expected_hash: <that result's hash>`. The second confirm is skipped (cancelled) if the selected worktree changed during the first request, and a force reply with `deleted: false` is an error ("<name> was not deleted." + the refusal), not a success. `dropStash` always confirms; `popStash` and `applyStash` read the worktree fresh (`getProjectGit`, not the tab's cached view) and confirm unless it is known clean (`popPlan` / `applyPlan`), so a failed read asks. `confirm: true` goes in the body only after a yes (naru task 2802): always for a drop, for a pop or apply only when it asked (a known-clean tree sends no flag); if the tree turned dirty between that read and the server's, the server's 409 is shown and the next click asks. `switchBranch` confirms from the main checkout (it is the main checkout, N linked worktrees are based on it, agents' worktrees are made from it, Naru may be served from this folder) and from a detached HEAD (commits on no branch are reachable only through the reflog; create a branch first); so does a create with "Switch to it" in the main checkout (it moves the main checkout too). A plain switch never sends `stash`: `stash: true` is sent only by `stashAndSwitch`, from the explicit "Stash and switch" button of the failure alert, and it asks the same confirms (plus "stashed first"). A `false` answer sends nothing; no worktree path sends nothing; every body carries `worktree` (and `repo` when the tab has one), and the stash entry calls carry the row's `index` and `hash`. Every confirm names the branch or stash AND the worktree's full path and branch. `ConfirmPlan` is `DiscardPlan` with an optional `irreversible` and a `moreLabel`; `GitConfirmDialog` takes it. `gitActions.test.ts` pins that `deleteProjectGitBranch`, `dropProjectGitStash`, `popProjectGitStash` and `switchProjectGitBranch` appear only in `api.ts` and `gitActions.ts`, their route strings only in `api.ts`, that the force call is one site after the second confirm, that `body.stash = true` appears once, and that `projectGitRefApi` is used only by `gitActions.ts` and `useGitRefOps.ts`.
- **Rows.** A branch or stash row is `div.git-side-rowwrap[data-git-row]` (`data-nacts`) holding the untouched `button.git-side-row` (click scopes History, `data-git-item`) and a sibling `span.git-side-row-acts[data-side-acts]`, so nothing is nested. Local branch: Switch `->`, Rename, Delete; remote branch: only "Create local branch from this" (`+`; no push, pull, fetch, set-upstream, merge, rebase, reset or remote delete exists anywhere); stash: Apply, Pop, Drop. With a mouse (`hover: hover` and `pointer: fine`) they are compact glyphs at the right of the first line, hidden until hover, focus-within or the selected row (the `.git-wt-actions` pattern); the empty `.git-side-row-menu` spans reserve their width so the name ellipsises before them. On touch, and always at <= 600px, they sit in flow as a third line, always visible, glyph plus text, 44px high. Section headers carry `+` (New branch; Stash) in `.git-side-actions`, glyph only.
- **Labels and disabled.** Every control has the same `aria-label` and `title`, naming its target and, for Switch / Apply / Pop / New branch / Stash, the worktree's full path and branch ("Switch to feature/x in /abs/path (branch main)", "Apply stash@{0} to main in /abs/path", "Rename branch x", "Delete branch x", "Drop stash@{0}", "Create local branch from origin/x"). A control that is off is `aria-disabled="true"` (never `disabled`: that drops focus and the tooltip), its label ends with the reason, and the click is ignored. Reasons: busy / a dialog open ("Another git action is in progress."), no worktree path ("The worktree path is unknown."), a loading worktree; a branch held by another worktree (Switch, Rename, Delete: "Checked out in <path>"); the current branch (Switch "Already the current branch", Delete "Can't delete the checked-out branch"; Rename stays on and its form says "Renaming the branch checked out here."); an operation in progress (Switch, Stash, Apply, Pop: "Merge in progress in this worktree. Finish or abort it in the terminal."; New branch stays on but its "Switch to it" checkbox is off with that reason; Rename, Delete, Drop stay on); a name starting with `-` (all three: "Rename it in the terminal."); an unborn HEAD (New branch and Stash: "No commits yet."; detected as a non-detached worktree whose branch list has no `is_head` row, because the server leaves create and stash on an unborn HEAD to git's own 409). On touch a muted `p.git-side-why[data-side-why]` under the actions shows the row's reasons; with a mouse the reason is the tooltip.
- **Target lines.** `p.git-side-target[data-side-target="branches|stashes"]` first in each section body: "Switch and New branch act on <branch> * <full path>" and "Stashes are shared by all worktrees. Apply, Pop and Stash act on <branch> * <full path>" (one ellipsised line, full text in the tooltip). On a detached HEAD the Branches body also has `div.git-side-detached[data-side-detached]`: "HEAD is detached at abc1234" and a "Create branch here" button (`data-side-act="branch-here"`; its form switches by default and says the new branch keeps these commits).
- **Forms** (`GitFormDialog`, a sibling of the confirm dialog: same portal, `.create-task-backdrop.git-confirm-backdrop` so the global shortcuts stand down, and the focus trap / Esc / opener-restore shared through `components/useModal.ts`; the trap now includes inputs; the border is `--border`, not the red edge). Focus starts on the input, Enter submits, the scrim dismisses only while nothing has been typed, Esc and Cancel always do (not while the write runs). New branch (header, detached note, remote row, History detail): name input, "Switch to it" (default on from the header and a detached HEAD, off from a remote row and from a commit), titled "New branch from main", "New branch at abc1234" or "New local branch from origin/x"; the body sent is `from_commit` (the commit's full sha) or `from_remote` (the row's `name`), neither = HEAD. Rename: the name pre-filled and selected. Stash: optional message and "Include untracked files". The name check is a convenience (`branchNameProblem`: non-empty; no space, tab, newline or other control character (unicode spaces git accepts are allowed); no leading `-`; not `@`; no `..`, `~^:?*[\`, `@{`; no leading, trailing or doubled `/`; no trailing `.`; no part starting with `.` or ending `.lock`; "A branch named x already exists." against the local list read when the form opens; unicode and `/` fine; the name is trimmed); the submit is off until valid and the problem is `p.git-form-error` linked by `aria-describedby`. The server's refusal (a tag of that name, git's own check) shows inline in the open form as a plain-text `pre` and the form stays open.
- **In flight.** One busy flag for the whole tab: `GitRepoPane` owns it and hands it to `GitWorkingTree` (its list writes, the commit box and the hunk controls) and to the panel, so two writes never overlap and every write control of both is off while either runs. `aside#git-side[data-side-busy]` + `aria-busy`; the status line ("Switching to x...") and the pressed button's glyph (`...`) show it. A form or confirm that is open also turns every control off (a confirm over the form suspends the form's keys).
- **After every attempt** that reached the server, success or failure (never after a cancelled confirm): the tab view (`refetch`), the panel's branches, stashes and worktree details (the panel registers one refetch with the tab) and, through a bumped `writeRev`, the open diff, the commit box (so a switch shows the new branch at once) and the History log are re-read. Nothing retries. A History scope on a renamed or deleted branch is cleared before the re-read, so History does not reload against a gone ref. The drawer stays open so the alert is seen; if the acted-on row vanished, focus moves to its section header.
- **Messages.** `[data-side-msgs]` (status, alert, notice) is a non-scrolling `flex: none` block under the panel's own scroller (`.git-side-scroll`), `--panel` background, capped at 40vh and scrolling inside (a sticky block in the scroller had been flex-shrunk to a few pixels); with the panel closed (a drawer) the same block shows above the content. Alert `[data-side-alert]` (`role="alert"`, red tint): `<strong>` what was attempted in which worktree, then git's own message verbatim in a plain-text `pre`, dismissible, cleared by the next action. A switch refused because local changes or untracked files would be overwritten (a 409 whose text contains "would be overwritten", `offersStashSwitch`) adds "Stash and switch"; no other failure does (`data-side-act="stash-switch"`). Notice `[data-side-notice]` (`role="status"`, green tint, no timer): the server's `notice` ("Stashed your changes as stash@{0} before switching.", "No local changes to stash."). A conflicting pop or apply shows git's text, the stash stays listed and the conflict appears in the working-tree list after the refetch.
- **History detail.** `button[data-commit-branch]` "Create branch here" beside Copy in the commit's sha line, with the same off rules.
- **Untrusted text**: branch names, stash messages, commit subjects, paths and git's messages reach the page as text nodes only (a branch named `<b>x</b>` is literal everywhere, dialogs included); a test pins that none of the components uses `dangerouslySetInnerHTML`. Colours are theme tokens only; inputs are 16px and every touch target 44px at <= 600px, where the dialogs are a bottom sheet above the drawer.
- **Test hooks**: `[data-side-act="new-branch|stash|switch|rename|delete|branch-from-remote|branch-here|apply|pop|drop|stash-switch"]`, `[data-git-row]`, `[data-side-acts]`, `[data-side-why]`, `[data-side-target]`, `[data-side-detached]`, `[data-side-msgs]`, `[data-side-status]`, `[data-side-alert]`, `[data-side-notice]`, `[data-side-busy]`, `[data-commit-branch]`, `[data-git-form="dialog|backdrop|name|message|untracked|switch|error|fail|submit|cancel"]`, and the confirm's `[data-git-confirm="dialog|backdrop|cancel|confirm"]`.

## Diff view (naru task 2734)

Both diff panes — the working-tree file and the commit file — render the
route's unified diff through one component, `DiffView`
(`frontend/src/components/DiffView.tsx`). It adds no route and changes no
server format; everything below is client-side, from `GitFileDiff.diff` and
the selected path.

- **Parser.** `parseDiff` in `frontend/src/diffModel.ts` — the same parser the
  Files tab's `SideBySideDiff` renders from (it was that component's
  `parseSideBySide`; there is no second one). It pairs each run of `-` lines
  with the run of `+` lines after it, numbers both sides from the hunk
  headers, and reads the lines before the first hunk for what they say about
  the file (new, deleted, renamed, mode change, binary). All of the view's
  logic is pure functions in that module, covered by `diffModel.test.ts`.
- **Split | Inline.** Split is old | new in four columns (number, text,
  number, text); Inline is one text column behind an old and a new number
  column, removed lines of a run before its added lines, with a `-`/`+` gutter.
  The pick is remembered in `localStorage` (`naru-git-diff-mode`); with no
  pick, a phone-width screen (≤600px) opens Inline and everything wider opens
  Split.
- **Syntax colour** by file name or extension (`grammarForPath` in
  `syntaxHighlighter.ts`), using the Prism grammars already registered there
  and the same palette as the file viewer (`usePrismStyle`). Each hunk's old
  side and new side is highlighted as a block. An unknown extension renders
  plain. Only colour and font style are taken from the palette, so the
  add/delete tint always shows.
- **Word-level marks.** Inside a changed line pair, the spans that differ are
  tinted stronger than the line (`wordDiff`: a longest-common-subsequence over
  word tokens). A pair that shares no word, or less than a quarter of its
  text, is left unmarked — it is two unrelated lines, not an edit.
- **Header.** Sticky at the top of the pane: the path, badges for new /
  deleted / renamed / mode change / binary, `+added −removed` line counts,
  previous / next change (a change is a run of added or removed rows; the
  buttons scroll it to the middle of the pane), and the Split | Inline pick.
- **Hunk headers** are quiet full-width separators. Long lines wrap inside
  their column; the pane never scrolls sideways.
- **No hunks.** A diff without hunks gets a sentence instead of an empty pane:
  "Binary file, no text diff.", "Renamed without content changes.", "File mode
  changed from A to B, no content change.", "Empty file added." / "Empty file
  deleted."; a shape it does not know is shown verbatim.
- **Notes on a line.** "No newline at end of file" is shown after the line it
  belongs to, on the side it belongs to. A changed pair whose only line-ending
  difference is a carriage return gets a `CR` note on the side that has it
  (a CRLF file's other lines are shown without their `\r`).
- **Size limits.** Past **2,000 lines or 150,000 characters** of diff
  (`RICH_MAX_LINES`, `RICH_MAX_CHARS`) the view skips syntax colour and word
  marks and says so in the header; lines, numbers, both modes and navigation
  still work. A single line over 2,000 characters (`RICH_MAX_LINE_CHARS`, a
  minified file) is left plain the same way. The server's own cut at
  `DIFF_CAP` (256 KiB) arrives as a `[diff truncated]` line; the view shows a
  warning in the header and a notice at the cut.
- **Untrusted text.** Diff text and the path reach the page only as text
  nodes. Classes come from the parser; inline colours come from the Prism
  palette, keyed by token class, never from the text.

## History view

The History sub-view (`HistoryPane` in `GitView.tsx`, naru task 2735) is a
paged commit graph beside a detail panel. Logic lives in pure modules
(`gitGraph.ts` lane layout, `gitHistory.ts` page merge / ref order / stat
totals / SVG path data, each with a vitest file); `useCommitLog.ts` owns the
fetching; `components/CommitGraph.tsx` draws the list.

- **Scope switch.** "Current branch | All branches" above the list; **Current
  branch is the default**. Switching resets paging and the selection; the old
  rows stay on screen dimmed until the new first page arrives. The toolbar stays
  visible with no commits ("No commits yet on <branch>.") so All can be tried.
- **Rows.** Each commit is a `<button>`: lane SVG, up to two ref badges
  (HEAD/current branch first, then branches, remotes, tags; the rest fold into
  `+N` whose tooltip lists them), a one-line subject (ellipsis, full text in the
  tooltip; blank = muted "(no message)"), author (hidden in narrow containers),
  relative date (exact local time in the tooltip) and the short sha. Lane
  colours are `--lane-0..7` aliases (`index.css`) via `.lane-cN` classes, never
  inline colours; merge commits are ring nodes, the HEAD commit has an outer
  ring, folded lanes show a "…" marker. Lane cap is 8 (4 on phone).
- **Paging.** Pages are 100 commits. An IntersectionObserver sentinel (root =
  the scrolling list) loads the next page, with a "Load more" button as the
  fallback ("Retry" under the error after a failed page). `skip` counts raw
  rows received; pages are deduped by hash and appended without touching scroll
  or selection. The end reads "Start of history". Every response is checked
  against the scope/mode key and offset it was started for; a late one is
  dropped.
- **Window focus.** The first page is refreshed in place on focus **only while
  it is the only page loaded** (so nothing is thrown away); with pages 2+ loaded
  focus does nothing, and a failed refresh is ignored. Toggling the scope mode
  reloads.
- **Detail panel.** Subject, full body (pre-wrap), author (and committer when
  it differs) with dates, the full sha with Copy (clipboard API, execCommand
  fallback, "Copy failed" otherwise), parent buttons (select the parent,
  loading up to three more pages to find it, else disabled "Not loaded yet";
  root commits say "Root commit"), a "Merge commit: changes shown against first
  parent <sha>" note for merges, and the file list with per-file `+added −deleted`
  (`-` for binary) and a total line. Picking a file opens it in `CommitDiffPane`.
- **Layout.** Desktop: list left (30rem), detail over diff on the right.
  `.git-history` is a CSS size container: at 52rem and below (so a narrow Custom
  pane too) it drills down list -> detail -> diff with back buttons
  ("← Commits", "← <short sha>"); the selection is component state, never the
  route. No `dangerouslySetInnerHTML`: all repo text is a text node.

## Search and keys (naru task 2736)

Logic is in `frontend/src/gitSearch.ts` (pure, `gitSearch.test.ts`).

- **History filter bar** above the commit list: a message search box, and
  behind **Filters** the author, path, since/until dates and **Go to
  commit**. Typing applies 300 ms after the last key (Enter applies at once);
  removing a filter applies at once. Active filters show as removable chips
  (plus "Clear all"), and a count line says `N commits`, `100+ commits` while
  more pages match, or that the search stopped at the 10 s limit. No match
  is a quiet "No commits match these filters." with a Clear button. The
  filters are part of `useCommitLog`'s key, so a reply for an older search
  is dropped when a newer one was typed (the server's git run still finishes
  or times out; it is not cancelled). Filters survive the branch scope switch.
  A filtered list draws no lanes (each row a lone node in one column): most
  rows' parents are not in it, so a lane graph would open a lane per row.
- **Go to commit** takes a full or short sha (7–64 hex, checked before any
  request): a loaded row with that unique prefix is selected, otherwise
  `GET /git/commits/{sha}` resolves it from the whole repo and its detail
  opens even though the row is not in the list. Unknown: "No commit … in this
  repo."
- **File filters**: a box above the working-tree list and above a commit's
  file list (shown when there is more than one file) narrows by path or
  rename source, case-insensitive substring, client-side.
- A path filter the server would refuse (absolute, `..`, empty segment) is
  not sent; the bar says why (`validPathFilter`, mirroring
  `git::valid_log_path`).
- **Keyboard**, bound by `onKeyDown` on the tab's own root (`.git-view`), so
  it acts only while focus is inside the Git tab — a Custom-layout pane that
  does not hold focus never sees a key:

  | Key | Does |
  |---|---|
  | `↓` `↑` or `j` `k` | Move through the focused list (commits, files, working tree); in a focused diff, scroll it |
  | `Enter` | Open the focused commit or file (the row's own click); focus then moves to the commit's first file, or to the diff |
  | `Esc` or `←` | Back a level: diff → its file row, commit detail → its commit row; in the working tree, diff → its file. In a diff only `Esc` (`←` is left to the page) |
  | `/` | Focus the search box (History) or the file filter (Working tree) |
| click, `⌘`/`Ctrl`-click, `Shift`-click | Working tree: select one file, toggle one, extend a range over the visible rows of one section (naru task 2738) |
  | `[` `]` | Previous / next changed file of the open list, opening it (section and folder headers are skipped); focus stays where it is |
  | `⌘`/`Ctrl` + `Enter` | In the commit subject or body: commit, or amend while Amend is on (naru task 2740) |
  | `?` | Show / hide the key list (also the `?` button by the mode toggle) |

  A key the tab handles stops there (`preventDefault` + `stopPropagation`),
  so the global spatial nav (`h/j/k/l`, arrows, `docs/keyboard.md`) does not
  also move focus; one it does not handle — `←` on the commit list, an arrow
  with no list focused — goes on to the spatial nav. No modifier chord is
  taken. Keys are ignored while typing in a field; from a Git filter box
  `Esc` or `↓` hands focus to its list. `shouldIgnoreShortcut` is consulted
  (modals, workflow canvas). Rows are `<button>`s (Tab reaches them) and use
  the app's shared `:focus-visible` ring.

## Side panel (naru task 2737)

The worktree chip row is gone; a **Refs** panel replaces it (the
`.git-repo-list` repo picker is separate and unchanged). Component
`frontend/src/components/GitSidePanel.tsx`; every rule (ordering, grouping,
filtering, caps, texts, tooltips) is pure in `frontend/src/gitPanel.ts`
(`gitPanel.test.ts`); open/drawer state is `useGitSide.ts`. It reads the three
routes above. Selecting a row never changes the repo; the write controls on
branch and stash rows (switch, rename, delete, apply, pop, drop, new branch,
stash) are naru task 2741, "Branch and stash actions" below, and never fetch,
push or pull.

- **Layout.** `.git-shell` is a flex row: `.git-side` (19rem, `role="region"`
  `aria-label="Refs"`, `--surface`, one scroller, sticky section headers) on
  the left, `.git-content` (the Working tree / History UI) filling the rest.
  The shell's measured width (ResizeObserver, since a viewport query cannot
  see a Custom-layout pane) picks **inline** (>= 60rem) or **drawer**. It is
  not a CSS size container: layout containment would anchor the phone
  drawer's `position: fixed` to the shell.
- **Refs button** (first in `.git-mode-row`, `aria-expanded`,
  `aria-controls="git-side"`) shows/hides the panel. Inline: the flag is kept
  in `localStorage` `naru-git-side` (default open). Drawer: default closed,
  not persisted; it closes on a row pick, a scrim tap (`.git-side-scrim`) and
  Esc, and focus returns to the Refs button on every one of those routes (the
  focused row is unmounted, so focus would otherwise fall to the page); on
  open, focus moves to the first section header. Inline, the panel stays
  mounted when hidden (state and data kept, no refetch on toggle). In a narrow pane the drawer is
  `position: absolute` inside the shell; at <= 600px it is `position: fixed`
  above the tab bar on the mobile ladder (scrim 1150, drawer 1200,
  `docs/mobile.md`), `max-width: min(20rem, 88%)`, scrim `touch-action: none`.
- **Sections** (`button.git-side-head`, chevron, title, count,
  `aria-expanded`; open state in `naru-git-side-sections`, JSON by section id;
  `.git-side-actions` holds the section's `+` button, task 2741). Rows are
  `button.git-side-row` with two lines; `.selected` = `--surface-raised` and a
  2px cyan left edge.
  - **Worktrees** (`data-git-list="worktrees"`): main pinned first; branch or
    8-char sha, `detached` / `locked` / `prunable` / `bare` badges, changed
    count (`clean` at 0), `↑n ↓n` against `base_branch` (the main checkout's
    branch; hidden at 0/0, none for main); line two is the short folder, HEAD
    subject and relative time. Bare and prunable rows are disabled with a
    reason. Selected = the picked one, else `is_current`; a click selects it
    for the whole tab and clears the branch scope (re-clicking the selected one
  changes nothing). The panel and the shell stay mounted across a worktree
  switch (the tab keeps the previous view while the new one loads; only the
  content area shows Loading), so the filter text, group state, show-more
  counts and scroll survive; the branch list of the previous worktree stays
  on screen until the new one's arrives. In drawer mode the panel is opaque
  (`--panel`; `--surface` is a tint). The cheap list comes with
    `GET /git`; the slow cells with `/git/worktrees`: `.git-skel` bars (fixed
    width, stepped pulse, none under reduced motion) fill in without changing
    row height, a refetch keeps old values, a failure shows muted `—` cells
    and one "Details unavailable. Retry" button.
  - **Branches** (`data-git-list="branches"`): "Filter branches" box
    (case-insensitive substring over all names, "N of M", "No branches
    match." + Clear; matching groups auto-expand), plain names first, then one
    collapsible `.git-side-group` per first `/` segment, then one per remote
    (collapsed by default). Each group shows 50, "Show N more"
    (`button.git-side-more`) adds 100. Badges: `current`, `in worktree` (checked
    out in another worktree; tooltip = path), `merged`; line two is the
    upstream track (`↑a ↓b` or `gone`), upstream, subject, time. A click scopes
    History to the branch (below); the row's own click never checks out (the
    Switch button does, with its own confirms).
  - **Stashes** (`data-git-list="stashes"`): message (or `(no message)`) +
    `stash@{n}`, `on <branch>` + time. A click switches to History and opens the
    stash commit (files + diff) the way Go to commit opens a commit that is not
    in the list. The request is consumed on use (a later History remount does
    not replay it), a quicker second click wins over a late reply for the
    first, and an unknown commit says "No commit ... in this repo.".
  - A section that fails to load shows "Couldn't load. Retry" and leaves the
    rest alone. Refetch follows `useFetch`: mount, key change and window focus;
    branches refetch when the selected worktree changes. The footnote says
    ahead/behind is as of the last fetch.
- **Branch scope.** Picking a branch sets History's `branch` scope (a state,
  not the URL; with its `kind`, so `origin/main` is not a local `main`). A
  `branch: <name> ×` chip (`aria-label="Remove branch scope <name>"`) sits by the
  Current | All switch, and neither switch shows selected while it is set;
  either switch, or the chip, clears it. The scope is part of `useCommitLog`'s
  key and is sent as `branch` + `branch_kind`, never with `all`. It clears when
  the selected worktree (or repo) changes. The empty text names the branch.
- **Keys** (extend the tab's `onKeyDown`): the three lists use
  `data-git-list` / `data-git-item`, so `j` `k` `↑` `↓` move within one and
  `Enter` is the row's click (it does not hand focus to a diff). Group headers
  and "Show more" are items too; disabled worktree rows are skipped. `/` in the
  panel focuses the branch filter; `Esc` or `↓` in it moves to the branches
  list; `Esc` in the panel returns focus to the content (and closes the
  drawer; with the `?` list open it closes that first); `[` `]` are ignored there. The `?` list shows them. A branch or stash row is `div.git-side-rowwrap[data-git-row]`
  around its `button.git-side-row[data-git-item]` and the actions span, so with
  focus on an action button `j` / `k` step from that row to its neighbour (the
  handler resolves the row through `[data-git-row]`), and `Enter` on an action
  is its native click.
- All repo text (names, subjects, paths, messages) is rendered as plain text
  nodes; colours are theme tokens only.

## Working tree view (naru task 2738)

`components/GitWorkingTree.tsx` replaced the flat file list. Rules are pure in
`frontend/src/gitWorktree.ts` (sections, badges, tree, row cap, selection, bulk
buttons; `gitWorktree.test.ts`) and `frontend/src/gitActions.ts` (confirm text,
control labels, the write gate; `gitActions.test.ts`); the component and
`components/GitConfirmDialog.tsx` only lay them out. The write routes are the
server's ("Write operations" above); this section is the client.

- **Sections**, each a collapsible `button.git-side-head` (chevron, title,
  count, `aria-expanded`) in a sticky `.git-side-headbar`: Conflicts (only when
  there is one), Staged, Changes, Untracked. Open state is in `localStorage`
  `naru-git-wt-sections`. A porcelain `XY` pair puts a file in Staged by `X`
  and in Changes by `Y`, so `MM` is in both; a conflicted pair
  (`UU AA DD AU UA DU UD`) is only in Conflicts; `??` is Untracked (an untracked
  folder is one row whose path ends `/`). Empty sections are hidden; "Nothing
  staged" shows when there are changes but nothing staged; a clean tree keeps
  its sentence. The "Filter changed files" box filters every section (path or
  rename source) before the cap.
- **Row**: a coloured letter badge (M amber, A and untracked `U` green, D red,
  R / C cyan, T violet, conflict `!` red; theme tokens only), the file name with
  its folder muted (flat), the plain status word ("modified", "both modified",
  "deleted by them", …; a conflict reads "conflict · <type>"), a `submodule`
  badge, and `orig → path` for a rename. Paths and git text are text nodes only.
- **Flat | Tree** toggle, remembered in `naru-git-tree-mode`. Tree groups a
  section by folder (folders first), a chain of single-child folders is one row
  (`a/b/c`), folders collapse and show a file count.
- **Selection** is (section, path). A plain click selects one and opens its
  diff (`staged=true` from Staged, `false` from Changes and Untracked, omitted
  for Conflicts); `⌘`/`Ctrl`-click toggles; `Shift`-click extends from the
  anchor over the section's rendered order. It never spans sections. With more
  than one selected a bar reads "N selected" with the section's actions and
  Clear, and a row's own action acts on the whole selection when the row is in
  it. After a refetch paths that left the section drop out, and a lone selected
  file that moved to another section (staged, now only in Changes) is followed
  there. Esc in the diff clears the selection and focuses its row.
- **Actions**, whole files only: Staged -> Unstage; Changes -> Stage, Discard;
  Untracked -> Stage, Delete; Conflicts -> none ("Resolve in the terminal, then
  stage."). Row and folder buttons are compact glyphs (`+ − ↶ ✕`), shown on
  hover / focus / selected row with a mouse and always on touch; a folder button
  acts on everything under it. A section header has one bulk button, always ONE
  request: Staged "Unstage all" and Changes "Stage all" send `all: true`
  (Stage all includes untracked files); Untracked "Stage all" sends its paths.
  With a filter on, they read "... shown" and send exactly the shown paths; with
  a conflict in the repo they also send paths, never `all`. While `operation`
  is set the Staged bulk button is disabled (its tooltip says why): unstaging
  everything mid-merge would drop cleanly merged files from the result; rows
  and selections still unstage. There is no "discard
  all". While a write is in flight the write controls are disabled; when it
  settles (success or failure) the view is refetched.
- **Worktree**: the explicit path is `activeWorktreePath(view.worktrees,
  selectedWorktree)`; if it cannot be resolved the write controls are disabled
  and nothing is sent. Every write control's `title` / `aria-label` reads
  "Stage 3 files in …/folder (branch)", and a line above the list ("Acting on
  <branch> <full path>") names the target, also on a phone. The confirm dialog
  closes (answers no) if the worktree changes or the list unmounts.
- **Destructive confirm** (`destructive_ops_without_confirm = 0`). Discard and
  Delete always open `GitConfirmDialog` first: `role="alertdialog"`, title
  ("Discard changes to 3 files?" / "Delete untracked file?"), the worktree's full
  path and branch, up to 10 paths ("and N more"), the exact consequence (tracked:
  working tree copy reset to the staged version, staged changes kept, and for a
  file that is both staged and modified only the unstaged edits are lost;
  untracked file: deleted from disk; untracked folder: the folder and everything
  in it is deleted), "This cannot be undone." Focus starts on Cancel and is
  trapped; Esc, the scrim and Cancel all say no; the danger button names the
  action ("Discard 3 files", "Delete file"). No bypass and no "don't ask again".
  Enforced in one place: `createGitActions({ api, confirm })` in `gitActions.ts`
  — `discard()` awaits `confirm(plan)` and calls `api.discard` only on `true`,
  and the component gets its api only through `projectGitApi`. `gitActions.test.ts`
  proves it ("the confirm gate" cases: a `false` answer never reaches
  `api.discard` for tracked, untracked, a selection and a folder; `true` sends
  once with exactly the planned paths and the worktree; stage / unstage never
  ask; no worktree sends nothing) and, by reading the sources, that
  `discardProjectGit` appears only in `api.ts` and `gitActions.ts` and the
  `/git/discard` string only in `api.ts`.
- **Operation banner** ("Merge in progress in this worktree. Finish or abort it
  in the terminal.") when `operation` is set (merge, rebase, cherry-pick, revert,
  bisect). Detached and unborn HEAD need nothing more than the header's branch.
- **Errors**: one dismissible `role="alert"` above the list: what was attempted
  ("Could not stage 3 files in <worktree>:") then git's own message in a
  plain-text `<pre>`. A 404 (a path left the list) says so quietly instead. The
  list is refetched after any failure; nothing retries.
- **Large lists**: each section renders at most 500 rows (`ROW_CAP`), then
  "Show all N" (tree mode counts rendered file rows the same way; a collapsed
  folder's files are not rendered). "Stage all" stays one request.
- **Hooks for a browser test**: `[data-git-list="tree"]` (the scroller),
  `[data-wt-section="staged|changes|untracked|conflicts"]` on `<section>` and on
  each row button (with `data-path`, `aria-current` on the open one,
  `aria-pressed` on selected ones), `[data-wt-toggle="<section>"]` header
  buttons, `[data-wt-action="stage|unstage|discard|delete|stage-all|stage-shown|
  unstage-all|unstage-shown"]`, `[data-wt-mode="flat|tree"]`,
  `[data-wt-showall="<section>"]`, `[data-wt-selbar]`, `[data-wt-banner]`,
  `[data-wt-alert]`, `[data-wt-target]`, `[data-wt-nothing-staged]`, and the
  dialog `[data-git-confirm="dialog|cancel|confirm|backdrop"]`.
- Keys: section and folder headers are items for `j` `k` `↑` `↓` / `Enter`
  (Enter toggles them and does not hand focus to the diff); `[` `]` step through
  files only.
- **Container layout** (QA fix). The working tree sits in `.git-wt-root`, a CSS
  size container (`container-type: inline-size`) *inside* `.git-content` — not
  `.git-shell`, whose phone drawer is `position: fixed`. At `<= 52rem` of
  container width (a narrow Custom-layout pane or a phone, regardless of the
  viewport) the list stacks over the diff: the list scroller keeps 10rem to
  the larger of 24rem and 80vh (so the commit box under a short Staged list is not cut off), the diff is 30rem, and the pane scrolls. Above 52rem the pane hands its
  box to `.git-layout` (side by side, 16rem floor, so a banner plus an alert
  cannot squeeze the list to nothing). The banner (5rem) and the alert (7rem)
  are capped and scroll inside; the alert's title wraps anywhere.
- **One target line.** `[data-wt-target]` ("<branch> ↑n ↓n <full path>", one
  ellipsised line, full path in the tooltip) is the single statement of where
  the controls act; the tab's own `.git-repo-header` is hidden whenever the
  working-tree list is shown, a clean tree included (it still shows for History
  and loading). Section headers
  truncate the title and keep count and bulk button apart.

## Commit box (naru task 2740)

Client half; the server routes are in the commit section above.
`components/GitCommitBox.tsx` lays out; every rule is pure in
`frontend/src/gitCommit.ts` (`gitCommit.test.ts`), the gate in
`gitActions.ts` (`commit`, `CommitOutcome`). For the person only: no CLI,
agent or workflow reaches it.

- **Placement.** `GitWorkingTree` renders it directly under the Staged section
  (after the "Nothing staged" hint when Staged is empty), inside the list
  column. It is remounted per project + repo + worktree (`key`), so a draft
  never crosses worktrees.
- **Fields.** Target line `[data-commit-target]` (branch, or "detached at
  <sha>", and the worktree's full path, ellipsised, full in the tooltip), the
  author identity `Name <email>` as text (`[data-commit-identity]`), a subject
  `<input>` (`aria-label="Commit subject"`), a plain body `<textarea>`
  (monospace, vertical resize), "N files staged". The message is the subject,
  plus a blank line and the body when the body has text; the server normalises
  whitespace and `#` lines are ordinary text. Fields are read-only while a
  commit is in flight.
- **Subject guide.** `52/50` in code points: `ok` <= 50, `long` 51-72 (amber),
  `over` > 72 (red). A guide, never a block.
- **Button** `[data-commit-button]`: its text and `aria-label` name the target,
  `Commit 3 files to main in …/folder` / `Amend last commit abc1234 on main in
  …/folder`; in flight it reads "Committing…" / "Amending…" with `aria-busy`.
  Off with the first reason shown beside it (`[data-commit-reason]`, also the
  tooltip): "The worktree path is unknown." / "Another change is in
  progress." / "Loading commit details…" / "Resolve the conflicts first." /
  "No git author identity is set. Run git config user.name "Your Name" and git
  config user.email you@example.com (add --global to set it for every repo)." /
  "Enter a commit message." / "Nothing is staged." (not required when
  amending, nor during a merge). Warnings `[data-commit-warning]`: detached
  HEAD ("HEAD is detached: this commit will be on no branch."), a merge /
  cherry-pick / revert in progress ("this commit concludes it"), a published
  amend, an amend of a merge commit. The operation banner of the working tree
  is not repeated. Every commit sends the `staged_digest` of the view the
  staged list is drawn from; the server's 409 "The staged changes changed
  since they were shown…" is shown like any failure, the list is reloaded and
  the draft kept.
- **Cmd/Ctrl+Enter** in the subject or body commits. A synchronous latch
  (`createSubmitGuard`, held in a ref) lets only one of two clicks or keydowns
  in the same tick through; the button is disabled during the request.
- **Draft.** `localStorage` `naru-git-commit-draft:<project>:<repo>:<worktree
  path>` = `{ subject, body, amend?: { head, subject, body, on } }`; saved on
  every change, restored on mount / worktree switch / reload / tab switch,
  garbage reads as empty, an empty draft removes the key, a success clears it
  (an amend keeps the ordinary draft that was set aside).
- **Amend** `[data-commit-amend]`: a checkbox, not rendered on an unborn HEAD,
  disabled with its reason (`[data-commit-amend-reason]`) during an operation.
  On: the fields load HEAD's message (or the stored amend draft, only when its
  `head` is still HEAD); off: the ordinary draft returns untouched. Sends
  `amend: true, expected_head: head.hash`. When HEAD is already published
  (`head_published`: on its upstream, or on another remote branch it was
  pushed to) the click asks first through `GitConfirmDialog` ("Amend a published
  commit?": worktree, branch, `<sha> <subject>`, that it is already on
  `<published_on>`, that the branch and that ref diverge); only "Amend commit"
  sends, with `allow_published: true`. When HEAD is a merge commit it asks the
  same way ("Amend a merge commit?": that it is a merge commit, that the new
  one keeps the same parents and takes in anything staged) and sends
  `allow_merge: true`; a published merge commit is one dialog ("Amend a
  published merge commit?") with both sets of lines and both flags
  (`amendConfirmPlan`). A plain commit and an amend of an unpublished,
  non-merge commit never ask.
- **HEAD moved under an amend.** An amend draft is for one HEAD. If HEAD
  changes (a commit from elsewhere, or the server's 409 "HEAD moved") while the
  amend text is live or edited, the fields show the ordinary draft and
  `[data-commit-stale-amend]` says "The last commit changed since you started
  amending (your text was for <old sha>)." with "Use my text for the new
  commit" (`[data-commit-stale-use]`, re-aims the text at the current HEAD) and
  "Discard it" (`[data-commit-stale-drop]`). Until one is chosen the Amend
  checkbox is disabled ("Decide what to do with your earlier amend text
  first."), so `startAmend` never overwrites typed text.
- **Merge default.** While a merge, cherry-pick or revert is in progress the
  fields start from git's `prepared_message`, once per mount, only into an
  empty ordinary draft.
- **Success** `[data-commit-success]` (`role="status"`): "Committed abc1234" /
  "Amended abc1234"; the sha is a button (`[data-commit-open]`) that opens the
  commit in History (`onOpenCommit`, same mechanism as a stash).
- **Failure** `[data-commit-error]` (`role="alert"`): "Could not commit to
  <branch> in <full path>:" (or "Could not amend the last commit on …"), then
  git's message in a plain-text `<pre>` (pre-wrap, scrolls inside 40vh, so a
  long hook log is read in full), dismissible. The draft and the Amend switch
  stay as they were; nothing is retried.
- **Busy sharing.** The box's request runs through `GitWorkingTree`'s `busy`:
  while a stage / unstage / discard is in flight the commit button is off, and
  while a commit is in flight the list's write controls are off. After any
  attempt the view is re-read and `rev` is bumped, which re-reads the commit
  info (`GET …/git/commit-info`, never cached; also re-read on window focus).
- **Clean tree.** `GitRepoPane` now mounts `GitWorkingTree` whenever the view
  is fresh; on a clean tree it shows "Working tree clean — no changed files."
  with the commit box (so the success line survives committing everything and
  the last message can be amended) and no diff pane.
- **Phone.** Inside the `.git-wt-root` container the box is one column; at
  <= 600px the subject and body are 16px (no iOS zoom), the button fills the
  row, and the button, sha and amend row are >= 44px. Theme tokens only.
- **Hooks:** `[data-commit]`, `-target`, `-path`, `-identity`, `-subject`,
  `-body`, `-count` (value = ok|long|over), `-staged`, `-amend`,
  `-amend-reason`, `-warning`, `-button`, `-reason`, `-success`, `-open`,
  `-error`.
