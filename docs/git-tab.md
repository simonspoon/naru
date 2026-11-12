# Git tab (read-only working-tree + history view per project)

The **Git** tab on a project page (web UI) shows the working tree of the
project's `local_path`: branch/ahead-behind + changed-file list, with a
per-file diff pane ("Diff view" below), plus a **Refs side panel** (worktrees, branches, stashes; "Side panel" below) and a
**History** sub-view (toggle, default Working tree) that browses commit
history. Like `/api/git-status` it reads **external** state via read-only
`git` shell-outs (`view_of`/`diff_of`/`worktrees_of`/`commit_log_of`/
`commit_files_of`/`commit_file_diff_of` in `src/core/git.rs`) and touches the
store only to read `local_path`. No CLI (an agent in a terminal uses `git`
directly). Standard middleware guard only — no agent-style gate, it executes
nothing.

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
push, checkout, merge or stash push anywhere in the tab).

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
  | `[` `]` | Previous / next changed file of the open list, opening it; focus stays where it is |
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

The worktree chip row is gone; a read-only **Refs** panel replaces it (the
`.git-repo-list` repo picker is separate and unchanged). Component
`frontend/src/components/GitSidePanel.tsx`; every rule (ordering, grouping,
filtering, caps, texts, tooltips) is pure in `frontend/src/gitPanel.ts`
(`gitPanel.test.ts`); open/drawer state is `useGitSide.ts`. It reads the three
routes above and never changes the repo (no checkout, fetch or stash apply).

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
  an empty `.git-side-actions` is reserved for task 8/8). Rows are
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
    History to the branch (below); it never checks out.
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
  drawer; with the `?` list open it closes that first); `[` `]` are ignored there. The `?` list shows them.
- All repo text (names, subjects, paths, messages) is rendered as plain text
  nodes; colours are theme tokens only.
