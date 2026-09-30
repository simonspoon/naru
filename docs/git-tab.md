# Git tab (read-only working-tree + history view per project)

The **Git** tab on a project page (web UI) shows the working tree of the
project's `local_path`: branch/ahead-behind + changed-file list, with a
per-file unified-diff pane, plus a **worktree selector** (below) and a
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
  `local_path` (`GitWorktree { path, branch, head, is_current }`,
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
- `GET /api/projects/{id}/git/log[?worktree=<path>]` → `ProjectGitLog` via
  `git::commit_log_of`
  (`git log`, newest first, capped at `LOG_CAP` = 100 — browsing, not a full
  walk, no pagination). Same three-rung empty-state ladder one level deeper:
  no `local_path` → `{path: null, commits: null}`; dead folder/non-repo →
  `{path, commits: null}`; real repo → `{path, commits: Some(vec)}` (`[]` on
  an unborn HEAD). `?worktree=` reads the log from that worktree's directory
  instead of `local_path`'s, validated by the same `worktrees` allowlist as
  the view/diff routes (`resolve_git_dir`) — an unlisted value is 404
  `not_found`, the one error this route can return. `path` in the response is
  always the project's own `local_path`, unaffected by `?worktree=`, like the
  view route's. Cached 5s per folder — the folder actually read
  (`AppState.git_log_cache`).
- `GET /api/projects/{id}/git/file-log?path=<rel>` → `ProjectGitLog` (the same
  type and empty-state ladder as `/git/log`) via `git::file_log_of` — the
  whole-repo log narrowed by a pathspec (`git log … -- <rel>`), same `LOG_CAP`
  and parse. Added for the Files tab's per-file History pane (mesa task 542,
  `docs/files-tab.md`); it lives here because it is a git read with this
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
  `git::commit_files_of` (`git show --name-status`). `GitCommitFile` is a
  distinct type from `GitFile`: its `status` is a single name-status token
  (`A`/`M`/`D`/`R100`/…), not the two-column staged/unstaged porcelain pair a
  working-tree file has — a commit has no staged/unstaged distinction. Root
  commits diff against the empty tree (all files `A`), so this and the diff
  route below work unmodified for a repo's first commit. 404 `not_found` on
  a malformed/unknown `sha` or no repo. Cached 5s per `(local_path, sha)`
  (`AppState.git_commit_files_cache`) — also backs the diff route's
  allowlist below, so selecting then diffing a commit's file doesn't re-run
  `git show --name-status` twice.
- `GET /api/projects/{id}/git/commits/{sha}/diff?path=<file>` → `GitFileDiff`
  via `git::commit_file_diff_of` (`git show <sha> -- <path>`, same
  `DIFF_CAP` truncation as the working-tree diff). `?path=` is allowlisted by
  byte-equal membership in **that commit's own** `commit_files_of` result
  (not the working-tree status list the sibling `/git/diff` route uses) —
  an unlisted path, or a bad/unknown `sha`, is 404 `not_found`. Diff text
  itself is not cached (matches `/git/diff`'s precedent).
- Every `sha` accepted from a request path is validated by
  `git::is_valid_commit_id` (7–64 hex chars) **before** any `git` subprocess
  is spawned, so it can never be read as a flag or a path.
