//! Git status of a project's `local_path`: branch, dirty count, ahead/behind.
//! Shells out to `git` (like the CLI's root-commit calls — no libgit2
//! dependency) and reads EXTERNAL state only; nothing here touches the mesa
//! store. Decorative data for the sidebar: any failure (no repo, no git,
//! detached folder) is `None`, never an error surfaced to the client.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::core::types::{
    DiffStat, GitBranch, GitBranchKind, GitCommit, GitCommitDetail, GitCommitFile, GitFile, GitRef,
    GitRefKind, GitRepo, GitRepoView, GitStash, GitStatus, GitWorktree, GitWorktreeDetail,
};

/// Diff text is capped so one huge file can't balloon the JSON response
/// (hooks' 64 KiB output cap precedent, scaled for diffs).
const DIFF_CAP: usize = 256 * 1024;

/// Page size of the log readers — 100 keeps each `git log` call and response
/// bounded (same order-of-magnitude judgement as DIFF_CAP); the History view
/// pages with `commit_log_page`'s `skip`.
const LOG_CAP: usize = 100;

/// Cap on a commit message body in `commit_detail_of`.
const BODY_CAP: usize = 64 * 1024;

/// The root (first) commit of the git repo at `path` (default: cwd), or `None`
/// if it is not a git repo or git is unavailable. Uses `--reverse` and takes the
/// first line so a repo with several root commits resolves deterministically to
/// its oldest one. This hash is the project's stable identity across checkouts
/// — what `project create` binds, `project resolve` and `mesa migrate` look up,
/// and the first thing the project-memory resolver asks (mesa task 1333).
pub fn root_commit(path: Option<&std::path::Path>) -> Option<String> {
    let mut cmd = Command::new("git");
    if let Some(p) = path {
        cmd.arg("-C").arg(p);
    }
    cmd.args(["rev-list", "--max-parents=0", "--reverse", "HEAD"]);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout)
        .ok()?
        .lines()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Directory names `discover_repos` never descends into: dependency and
/// build output, where a checked-out repo is vendored noise, not the
/// project's own.
const DISCOVER_SKIP: &[&str] = &[
    "node_modules",
    "target",
    ".build",
    "dist",
    "venv",
    ".venv",
    ".git",
];

/// How many directory levels below the root `discover_repos` looks
/// (root = 0), and the most repos it will report.
const DISCOVER_DEPTH: usize = 4;
const DISCOVER_CAP: usize = 50;
/// Most directories the walk will visit before stopping early.
const DISCOVER_VISIT_CAP: usize = 5000;

/// Every git repo at or under `root`: the root itself if it has a `.git`,
/// then descendants down to `DISCOVER_DEPTH` levels whose directory holds a
/// `.git` (a directory, or a file — linked worktrees and submodules). A
/// found repo is still descended into, since a nested repo is typically
/// gitignored by its parent. Symlinks are never followed and `DISCOVER_SKIP`
/// names are never entered. Root (`"."`) first, then by relative path.
pub fn discover_repos(root: &str) -> Vec<GitRepo> {
    let root = std::path::Path::new(root);
    let mut found: Vec<String> = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    let mut visited = 0usize;
    while let Some((dir, rel, depth)) = stack.pop() {
        visited += 1;
        if visited > DISCOVER_VISIT_CAP {
            break;
        }
        if std::fs::symlink_metadata(dir.join(".git")).is_ok() {
            found.push(if rel.is_empty() {
                ".".into()
            } else {
                rel.clone()
            });
        }
        if depth >= DISCOVER_DEPTH {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if DISCOVER_SKIP.contains(&name) {
                continue;
            }
            let child = if rel.is_empty() {
                name.to_string()
            } else {
                format!("{rel}/{name}")
            };
            stack.push((entry.path(), child, depth + 1));
        }
    }
    found.sort_by(|a, b| (a != ".", a).cmp(&(b != ".", b)));
    found.truncate(DISCOVER_CAP);
    found
        .into_iter()
        .map(|path| {
            let dir = if path == "." {
                root.to_path_buf()
            } else {
                root.join(&path)
            };
            let branch = branch_of(&dir);
            GitRepo { path, branch }
        })
        .collect()
}

/// Current branch of the repo at `dir`, the short sha when detached, `None`
/// on an unborn HEAD or a failed call.
fn branch_of(dir: &std::path::Path) -> Option<String> {
    let run = |args: &[&str]| -> Option<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    run(&["symbolic-ref", "--short", "-q", "HEAD"])
        .or_else(|| run(&["rev-parse", "--short", "HEAD"]))
}

/// Reads the working-tree status of the repo at `dir`, or `None` when `dir`
/// is not a git repo / git is unavailable.
pub fn status_of(dir: &str) -> Option<GitStatus> {
    let out = Command::new("git")
        .args(["-C", dir, "status", "--porcelain=v2", "--branch"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_status(&String::from_utf8_lossy(&out.stdout)))
}

/// Kept pure (text in, status out) so the porcelain contract is unit-testable
/// without spawning git, like agents.rs's `parse_sessions`.
fn parse_status(porcelain: &str) -> GitStatus {
    let mut branch = String::new();
    let mut oid = String::new();
    let mut ahead = 0;
    let mut behind = 0;
    let mut dirty = 0;
    for line in porcelain.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.oid ") {
            oid = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // "+<ahead> -<behind>"; only present when an upstream is set.
            for part in rest.split_whitespace() {
                if let Some(n) = part.strip_prefix('+') {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    behind = n.parse().unwrap_or(0);
                }
            }
        } else if !line.starts_with('#') && !line.is_empty() {
            // Every non-header line is one changed/untracked/conflicted path.
            dirty += 1;
        }
    }
    if branch == "(detached)" {
        // No branch name to show; the short commit id is the position.
        branch = oid.chars().take(8).collect();
    }
    GitStatus {
        branch,
        dirty,
        ahead,
        behind,
    }
}

/// Full working-tree view of the repo at `dir` (branch summary + per-file
/// change list + any operation in progress), or `None` when `dir` is not a
/// git repo / git is unavailable. One `git status --porcelain=v2 --branch -z`
/// call: `-z` keeps every path verbatim (never C-quoted), so a space, quote,
/// tab, unicode or leading-`-` name round-trips byte-exact (a non-UTF-8 name
/// is lossy). Untracked mode stays git's default (`normal`).
pub fn view_of(dir: &str) -> Option<GitRepoView> {
    let out = Command::new("git")
        .args(["-C", dir, "status", "--porcelain=v2", "--branch", "-z"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut view = parse_view(&String::from_utf8_lossy(&out.stdout));
    view.operation = operation_of(dir);
    Some(view)
}

/// The operation in progress in `dir`'s worktree, read from its own git dir
/// (a linked worktree has one of its own), or `None`.
fn operation_of(dir: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["-C", dir, "rev-parse", "--absolute-git-dir"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    operation_in(std::path::Path::new(
        String::from_utf8_lossy(&out.stdout).trim(),
    ))
}

/// Pure on a git dir: `rebase-merge/` or `rebase-apply/rebasing` is a rebase
/// (`rebase-apply/` alone is a `git am` session, which is not reported; a rebase
/// wins, since a rebase can sit on a `MERGE_HEAD` or `CHERRY_PICK_HEAD` of
/// its own), then `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`,
/// `BISECT_LOG`.
fn operation_in(git_dir: &std::path::Path) -> Option<String> {
    let has = |n: &str| git_dir.join(n).exists();
    let op = if has("rebase-merge") || has("rebase-apply/rebasing") {
        "rebase"
    } else if has("MERGE_HEAD") {
        "merge"
    } else if has("CHERRY_PICK_HEAD") {
        "cherry-pick"
    } else if has("REVERT_HEAD") {
        "revert"
    } else if has("BISECT_LOG") {
        "bisect"
    } else {
        return None;
    };
    Some(op.to_string())
}

/// Kept pure (text in, view out) so the porcelain contract is unit-testable
/// without spawning git, like `parse_status`. Input is `-z` output: every
/// record is NUL-terminated, and a rename (`2 …`) record is followed by one
/// more NUL-terminated field, the original path. `operation` is filled by
/// `view_of`, which alone can see the git dir.
fn parse_view(porcelain: &str) -> GitRepoView {
    let mut files = Vec::new();
    let mut headers = Vec::new();
    let mut it = porcelain.split('\0');
    while let Some(rec) = it.next() {
        // '1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>'
        if let Some(rest) = rec.strip_prefix("1 ") {
            let f: Vec<&str> = rest.splitn(8, ' ').collect();
            if f.len() == 8 {
                files.push(GitFile {
                    status: f[0].to_string(),
                    path: f[7].to_string(),
                    orig_path: None,
                    submodule: f[1].starts_with('S'),
                });
            }
        // '2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>' NUL '<origPath>'
        } else if let Some(rest) = rec.strip_prefix("2 ") {
            let orig = it.next().map(str::to_string);
            let f: Vec<&str> = rest.splitn(9, ' ').collect();
            if f.len() == 9 {
                files.push(GitFile {
                    status: f[0].to_string(),
                    path: f[8].to_string(),
                    orig_path: orig,
                    submodule: f[1].starts_with('S'),
                });
            }
        // 'u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>'
        } else if let Some(rest) = rec.strip_prefix("u ") {
            let f: Vec<&str> = rest.splitn(10, ' ').collect();
            if f.len() == 10 {
                files.push(GitFile {
                    status: f[0].to_string(),
                    path: f[9].to_string(),
                    orig_path: None,
                    submodule: f[1].starts_with('S'),
                });
            }
        } else if let Some(path) = rec.strip_prefix("? ") {
            files.push(GitFile {
                status: "??".to_string(),
                path: path.to_string(),
                orig_path: None,
                submodule: false,
            });
        } else if rec.starts_with('#') {
            headers.push(rec);
        }
    }
    let mut status = parse_status(&headers.join("\n"));
    status.dirty = files.len() as i64;
    GitRepoView {
        status,
        files,
        operation: None,
    }
}

/// Every worktree of the repo at `dir` (the main checkout plus any linked
/// `git worktree add` folders), or `None` when `dir` is not a git repo / git
/// is unavailable. Runs from any worktree, `git worktree list` always
/// reports the full set for the repo — so the git tab's worktree selector
/// stays complete regardless of which worktree `dir` happens to be.
pub fn worktrees_of(dir: &str) -> Option<Vec<GitWorktree>> {
    let out = Command::new("git")
        .args(["-C", dir, "worktree", "list", "--porcelain"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_worktrees(&String::from_utf8_lossy(&out.stdout), dir))
}

/// Kept pure (text in, list out) so the porcelain contract is unit-testable
/// without spawning git, like `parse_status`/`parse_view`. Blocks are
/// separated by a blank line; `is_current` is decided by comparing each
/// worktree's path against `dir` (canonicalized on both sides so a
/// non-canonical `local_path` still matches — falls back to a raw string
/// compare if either side fails to canonicalize, e.g. a folder that no
/// longer exists).
fn parse_worktrees(porcelain: &str, dir: &str) -> Vec<GitWorktree> {
    let dir_canon = std::fs::canonicalize(dir).ok();
    let mut worktrees: Vec<GitWorktree> = Vec::new();
    let mut cur: Option<GitWorktree> = None;

    let mut flush = |cur: &mut Option<GitWorktree>| {
        if let Some(mut w) = cur.take() {
            w.is_current = match (&dir_canon, std::fs::canonicalize(&w.path).ok()) {
                (Some(a), Some(b)) => *a == b,
                _ => w.path == dir,
            };
            // The first block git lists is always the main checkout.
            w.is_main = worktrees.is_empty();
            worktrees.push(w);
        }
    };

    for line in porcelain.lines() {
        if line.is_empty() {
            flush(&mut cur);
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut cur);
            cur = Some(GitWorktree {
                path: rest.to_string(),
                branch: None,
                head: String::new(),
                is_current: false,
                is_main: false,
                detached: false,
                bare: false,
                locked: false,
                lock_reason: None,
                prunable: false,
                prunable_reason: None,
            });
            continue;
        }
        let Some(w) = cur.as_mut() else { continue };
        if let Some(rest) = line.strip_prefix("HEAD ") {
            w.head = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("branch ") {
            w.branch = Some(rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string());
        } else if line == "detached" {
            w.detached = true;
        } else if line == "bare" {
            w.bare = true;
        } else if line == "locked" || line.starts_with("locked ") {
            w.locked = true;
            w.lock_reason = line.strip_prefix("locked ").map(str::to_string);
        } else if line == "prunable" || line.starts_with("prunable ") {
            w.prunable = true;
            w.prunable_reason = line.strip_prefix("prunable ").map(str::to_string);
        }
    }
    flush(&mut cur);
    worktrees
}

/// Most workers the per-worktree detail pass runs at once (naru task 2737):
/// each does a `git status`, so this bounds the processes spawned together.
const DETAIL_WORKERS: usize = 8;

/// The slow, per-worktree half of the Worktrees view (naru task 2737), kept
/// off the list route so the list stays one cheap `git worktree list`.
/// Returns the main checkout's branch (`base_branch`, None when detached or
/// bare) and one [`GitWorktreeDetail`] per entry of `worktrees`, same order.
/// Bare, prunable and folder-missing entries get `changed: None`; everything
/// is `None` rather than an error when git fails. Every worktree's HEAD
/// subject and date come from ONE `git log --no-walk` call; ahead/behind is
/// against the commit the main checkout is on (shas only, so nothing is read
/// as a flag) and is as of the last fetch (Naru never fetches). The
/// `git status` calls run on up to [`DETAIL_WORKERS`] threads.
pub fn worktree_details_of(
    dir: &str,
    worktrees: &[GitWorktree],
) -> (Option<String>, Vec<GitWorktreeDetail>) {
    let main = worktrees.iter().find(|w| w.is_main);
    let base_branch = main.filter(|m| !m.bare).and_then(|m| m.branch.clone());
    let live_head = |w: &GitWorktree| -> Option<String> {
        let ok = !w.bare
            && !w.prunable
            && is_valid_commit_id(&w.head)
            && w.head.bytes().any(|b| b != b'0');
        ok.then(|| w.head.clone())
    };
    let main_sha = main.and_then(live_head);

    // One call for every HEAD's subject/date.
    let mut shas: Vec<String> = worktrees.iter().filter_map(live_head).collect();
    shas.sort();
    shas.dedup();
    let mut heads: HashMap<String, (String, String)> = HashMap::new();
    if !shas.is_empty() {
        let out = Command::new("git")
            .args([
                "-C",
                dir,
                "log",
                "--no-walk=unsorted",
                "--format=%H%x00%cI%x00%s",
            ])
            .args(&shas)
            .arg("--")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        if let Some(out) = out.ok().filter(|o| o.status.success()) {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let mut it = line.splitn(3, '\0');
                if let (Some(h), Some(d), Some(s)) = (it.next(), it.next(), it.next()) {
                    heads.insert(h.to_string(), (d.to_string(), s.to_string()));
                }
            }
        }
    }

    let next = std::sync::atomic::AtomicUsize::new(0);
    let slots: std::sync::Mutex<Vec<Option<GitWorktreeDetail>>> =
        std::sync::Mutex::new(vec![None; worktrees.len()]);
    std::thread::scope(|s| {
        for _ in 0..DETAIL_WORKERS.min(worktrees.len()) {
            s.spawn(|| {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(w) = worktrees.get(i) else { break };
                    let sha = live_head(w);
                    let runnable = !w.bare && !w.prunable && std::path::Path::new(&w.path).is_dir();
                    let changed = runnable.then(|| worktree_changed(&w.path)).flatten();
                    let (ahead, behind) = match (&main_sha, &sha) {
                        (Some(m), Some(t)) if !w.is_main && runnable => {
                            ahead_behind(&w.path, m, t).unzip()
                        }
                        _ => (None, None),
                    };
                    let head = sha.as_ref().and_then(|h| heads.get(h));
                    let detail = GitWorktreeDetail {
                        path: w.path.clone(),
                        changed,
                        ahead,
                        behind,
                        subject: head.map(|(_, s)| s.clone()),
                        date: head.map(|(d, _)| d.clone()),
                    };
                    slots.lock().unwrap()[i] = Some(detail);
                }
            });
        }
    });
    let slots = slots.into_inner().unwrap();
    let details = worktrees
        .iter()
        .zip(slots)
        .map(|(w, d)| {
            d.unwrap_or(GitWorktreeDetail {
                path: w.path.clone(),
                changed: None,
                ahead: None,
                behind: None,
                subject: None,
                date: None,
            })
        })
        .collect();
    (base_branch, details)
}

/// Changed-file count of the worktree at `path` (`git status --porcelain=v2`
/// entries); `None` when git fails.
fn worktree_changed(path: &str) -> Option<u32> {
    worktree_changed_within(path, DETAIL_STATUS_TIMEOUT)
}

/// How long one worktree's `git status` may run before it is killed and that
/// worktree's `changed` is `None` (a hung or locked one must not stall the
/// whole details call).
const DETAIL_STATUS_TIMEOUT: Duration = Duration::from_secs(5);

/// [`worktree_changed`] with an explicit timeout. `GIT_OPTIONAL_LOCKS=0` so
/// the status never takes `index.lock` to refresh the index behind the
/// user's back.
fn worktree_changed_within(path: &str, timeout: Duration) -> Option<u32> {
    let mut cmd = Command::new("git");
    cmd.args(["-C", path, "status", "--porcelain=v2"])
        .env("GIT_OPTIONAL_LOCKS", "0");
    let (stdout, ok, _timed_out) = output_within(cmd, Some(timeout))?;
    if !ok {
        return None;
    }
    Some(count_status_entries(&String::from_utf8_lossy(&stdout)))
}

/// Pure: entries in `git status --porcelain=v2` output (no `#` headers).
fn count_status_entries(porcelain: &str) -> u32 {
    porcelain
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .count() as u32
}

/// `(ahead, behind)` of commit `head` against `base` (both full shas), run in
/// `dir`; `None` when git fails.
fn ahead_behind(dir: &str, base: &str, head: &str) -> Option<(u32, u32)> {
    let out = Command::new("git")
        .args(["-C", dir, "rev-list", "--left-right", "--count"])
        .arg(format!("{base}...{head}"))
        .arg("--")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // "<only in base>\t<only in head>": head is behind by the first.
    let text = String::from_utf8_lossy(&out.stdout);
    let mut it = text.split_whitespace();
    let behind = it.next()?.parse().ok()?;
    let ahead = it.next()?.parse().ok()?;
    Some((ahead, behind))
}

/// Fields of the one `git for-each-ref` call behind the Branches view
/// (naru task 2737), NUL-separated. `%(ahead-behind:HEAD)` (git 2.41+) is the
/// last, optional one. Each record ends with `\0\x1e` and the newline for-each-ref itself
/// adds ([`BRANCH_END`]): the only free text field is the subject, which has
/// no newline, so that sequence cannot occur inside a record.
const BRANCH_FIELDS: &str = "%(refname)%00%(objectname)%00%(objectname:short)%00\
%(committerdate:iso-strict)%00%(contents:subject)%00%(upstream:short)%00%(upstream:track)%00\
%(HEAD)%00%(worktreepath)%00%(symref)";
const BRANCH_AHEAD_BEHIND: &str = "%00%(ahead-behind:HEAD)";
const BRANCH_END_FMT: &str = "%00%1e";
const BRANCH_END: &str = "\0\u{1e}\n";

/// Every local and remote-tracking branch of the repo at `dir`, from exactly
/// ONE `git for-each-ref` (plus one `git remote` to tell a remote's name from
/// a `/` in a branch name): zero git calls per row. `merged` needs the
/// `ahead-behind:HEAD` atom; when that call fails (old git, unborn HEAD) it is
/// retried once without and `merged` is `None`. `None` when `dir` is not a
/// repo / git fails both times. `HEAD`-relative fields follow `dir`'s HEAD.
pub fn branches_of(dir: &str) -> Option<Vec<GitBranch>> {
    branches_with("git", dir)
}

/// [`branches_of`] with the git program injectable, so a test can count the
/// invocations through a wrapper without touching the process-wide PATH.
fn branches_with(program: &str, dir: &str) -> Option<Vec<GitBranch>> {
    let run = |with_ab: bool| -> Option<String> {
        let mut fmt = format!(
            "{BRANCH_FIELDS}{}",
            if with_ab { BRANCH_AHEAD_BEHIND } else { "" }
        );
        fmt.push_str(BRANCH_END_FMT);
        let out = Command::new(program)
            .args(["-C", dir, "for-each-ref"])
            .arg(format!("--format={fmt}"))
            .args(["refs/heads", "refs/remotes"])
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let text = run(true).or_else(|| run(false))?;
    let remotes = remotes_of(program, dir);
    Some(parse_branches(&text, &remotes))
}

/// `git remote` names; empty when there are none or git fails.
fn remotes_of(program: &str, dir: &str) -> Vec<String> {
    Command::new(program)
        .args(["-C", dir, "remote"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Pure parser of [`branches_of`]'s one call. Symbolic refs
/// (`refs/remotes/origin/HEAD`) are skipped. A remote branch's `remote` is the
/// longest entry of `remotes` that prefixes its name + `/` (a remote may
/// itself contain `/`), else its first path segment.
fn parse_branches(text: &str, remotes: &[String]) -> Vec<GitBranch> {
    let mut rows = Vec::new();
    for rec in text.split(BRANCH_END) {
        if rec.is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.splitn(11, '\0').collect();
        if f.len() < 10 {
            continue;
        }
        let (refname, symref) = (f[0], f[9]);
        if !symref.is_empty() {
            continue;
        }
        let (kind, name) = if let Some(n) = refname.strip_prefix("refs/heads/") {
            (GitBranchKind::Local, n)
        } else if let Some(n) = refname.strip_prefix("refs/remotes/") {
            (GitBranchKind::Remote, n)
        } else {
            continue;
        };
        let remote = (kind == GitBranchKind::Remote).then(|| {
            remotes
                .iter()
                .filter(|r| {
                    name.strip_prefix(r.as_str())
                        .is_some_and(|t| t.starts_with('/'))
                })
                .max_by_key(|r| r.len())
                .cloned()
                .unwrap_or_else(|| name.split('/').next().unwrap_or(name).to_string())
        });
        let (ahead, behind, gone) = parse_track(f[6]);
        let upstream = Some(f[5]).filter(|u| !u.is_empty()).map(str::to_string);
        let has_up = upstream.is_some() && !gone;
        let merged = f.get(10).and_then(|ab| {
            let n: u32 = ab.split_whitespace().next()?.parse().ok()?;
            Some(n == 0)
        });
        rows.push(GitBranch {
            name: name.to_string(),
            kind,
            remote,
            hash: f[1].to_string(),
            short_hash: f[2].to_string(),
            date: f[3].to_string(),
            subject: f[4].to_string(),
            upstream,
            upstream_gone: gone,
            // `upstream:track` is empty when in sync, so a tracked branch
            // with no ahead/behind text is 0/0.
            ahead: has_up.then_some(ahead),
            behind: has_up.then_some(behind),
            is_head: f[7] == "*",
            worktree: Some(f[8]).filter(|w| !w.is_empty()).map(str::to_string),
            merged,
        });
    }
    rows
}

/// `%(upstream:track)`: `[ahead N, behind M]`, `[ahead N]`, `[behind M]`,
/// `[gone]` or empty -> `(ahead, behind, gone)`.
fn parse_track(track: &str) -> (u32, u32, bool) {
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    if inner == "gone" {
        return (0, 0, true);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

/// The full refname `git log` is given for a branch row: it starts with
/// `refs/`, so a branch named `-x` can never be read as a flag.
pub fn branch_refname(b: &GitBranch) -> String {
    match b.kind {
        GitBranchKind::Local => format!("refs/heads/{}", b.name),
        GitBranchKind::Remote => format!("refs/remotes/{}", b.name),
    }
}

/// Every stash of the repo at `dir`, newest first (`git stash list`); `None`
/// when git fails (not a repo). No stashes (or an unborn HEAD) is `Some([])`.
/// A stash is a commit, so its `hash` works with the commit routes; files
/// stashed with `-u` live in the stash's third parent and are not listed.
pub fn stashes_of(dir: &str) -> Option<Vec<GitStash>> {
    let out = Command::new("git")
        .args([
            "-C",
            dir,
            "stash",
            "list",
            "--format=%H%x00%gd%x00%gs%x00%cI",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(parse_stashes(&String::from_utf8_lossy(&out.stdout)))
}

/// Pure parser of [`stashes_of`]. The reflog subject is `WIP on <branch>:
/// <sha> <subject>` or `On <branch>: <message>`; branch names cannot hold
/// `:`, so the first `: ` ends the branch. `branch` is None for `(no branch)`
/// or any other subject, whose `message` is then the whole subject; for a WIP
/// subject the leading short sha is dropped from `message`.
fn parse_stashes(text: &str) -> Vec<GitStash> {
    let mut stashes = Vec::new();
    for line in text.lines() {
        let mut it = line.splitn(4, '\0');
        let (Some(hash), Some(name), Some(subject), Some(date)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let Some(index) = name
            .strip_prefix("stash@{")
            .and_then(|r| r.strip_suffix('}'))
            .and_then(|n| n.parse().ok())
        else {
            continue;
        };
        let (branch, message) = parse_stash_subject(subject);
        stashes.push(GitStash {
            index,
            name: name.to_string(),
            hash: hash.to_string(),
            message,
            branch,
            date: date.to_string(),
        });
    }
    stashes
}

fn parse_stash_subject(subject: &str) -> (Option<String>, String) {
    let (rest, wip) = match (subject.strip_prefix("WIP on "), subject.strip_prefix("On ")) {
        (Some(r), _) => (r, true),
        (None, Some(r)) => (r, false),
        _ => return (None, subject.to_string()),
    };
    let Some((branch, msg)) = rest.split_once(": ") else {
        return (None, subject.to_string());
    };
    let message = if wip {
        msg.split_once(' ').map_or(msg, |(_, s)| s).to_string()
    } else {
        msg.to_string()
    };
    let branch = (branch != "(no branch)").then(|| branch.to_string());
    (branch, message)
}

/// Unified diff for one path from the status list — staged + unstaged as one
/// diff vs HEAD; untracked rendered all-added via `--no-index /dev/null`.
/// `None` on any git failure; binary files carry git's own
/// "Binary files ... differ" line as the diff text.
pub fn diff_of(dir: &str, path: &str, untracked: bool) -> Option<String> {
    if untracked {
        // `--no-index` exits 1 when the files differ — that IS the diff.
        return run_diff(
            dir,
            &["diff", "--no-index", "--", "/dev/null", path],
            &[0, 1],
        );
    }
    // Unborn HEAD (no commits yet) makes `diff HEAD` fail; fall back to the
    // index-only then worktree-only reads before giving up.
    run_diff(dir, &["diff", "HEAD", "--", path], &[0])
        .or_else(|| run_diff(dir, &["diff", "--cached", "--", path], &[0]))
        .or_else(|| run_diff(dir, &["diff", "--", path], &[0]))
}

/// Runs one read-only `git -C <dir> <args…>`, accepting the listed exit
/// codes; lossy UTF-8 stdout, capped at [`DIFF_CAP`] on a char boundary.
fn run_diff(dir: &str, args: &[&str], ok_codes: &[i32]) -> Option<String> {
    run_diff_with(dir, args, ok_codes, false)
}

/// [`run_diff`] with `GIT_LITERAL_PATHSPECS=1` when `literal`, so `*` and
/// `:(magic)` in a file name are plain characters.
fn run_diff_with(dir: &str, args: &[&str], ok_codes: &[i32], literal: bool) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["-C", dir]).args(args).stdin(Stdio::null());
    if literal {
        cmd.env("GIT_LITERAL_PATHSPECS", "1");
    }
    let out = cmd.output().ok()?;
    if !ok_codes.contains(&out.status.code()?) {
        return None;
    }
    Some(capped(&out.stdout))
}

/// The diff for one listed file when the caller picks a side (naru task
/// 2738). `staged: None` is [`diff_of`] unchanged. Otherwise, every path
/// after `--` and literal:
/// - conflicted: `git diff HEAD`, whatever `staged` says. Against HEAD git
///   prints a plain `diff --git` of the working file with its conflict
///   markers (bare `git diff` would print a `diff --cc` combined diff the
///   client's parser cannot render). Where HEAD offers nothing (a file
///   deleted by us) the diff is empty, never an error.
/// - untracked: the `--no-index` all-added diff, whatever `staged` says.
/// - `staged: true`: `git diff --cached` (works on an unborn HEAD); a staged
///   rename passes both paths with `-M` so it renders as a rename.
/// - `staged: false`: `git diff`, index against working tree.
pub fn diff_of_file(
    dir: &str,
    file: &GitFile,
    wanted: &str,
    staged: Option<bool>,
) -> Option<String> {
    let Some(staged) = staged else {
        return diff_of(dir, wanted, file.status == "??");
    };
    let path = file.path.as_str();
    if is_conflicted(file) {
        return run_diff_with(dir, &["diff", "HEAD", "--", path], &[0], true);
    }
    if file.status == "??" {
        return run_diff_with(
            dir,
            &["diff", "--no-index", "--", "/dev/null", path],
            &[0, 1],
            true,
        );
    }
    if !staged {
        return run_diff_with(dir, &["diff", "--", path], &[0], true);
    }
    match file.orig_path.as_deref() {
        Some(orig) => run_diff_with(
            dir,
            &["diff", "--cached", "-M", "--", orig, path],
            &[0],
            true,
        ),
        None => run_diff_with(dir, &["diff", "--cached", "--", path], &[0], true),
    }
}

/// Lossy UTF-8, truncated to [`DIFF_CAP`] on a char boundary (the hooks
/// `capped` shape).
fn capped(bytes: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(bytes).into_owned();
    if s.len() > DIFF_CAP {
        let cut = (0..=DIFF_CAP).rev().find(|i| s.is_char_boundary(*i));
        s.truncate(cut.unwrap_or(0));
        s.push_str("\n[diff truncated]");
    }
    s
}

// --- Writes (naru task 2738) -------------------------------------------
//
// The first places Naru changes a repo. Every write is `git -C <dir>` as an
// argv (never a shell) with `GIT_LITERAL_PATHSPECS=1` and
// `GIT_TERMINAL_PROMPT=0`; paths go in NUL-separated on stdin
// (`--pathspec-from-file=- --pathspec-file-nul`) so any number of them is ONE
// git call and a leading `-` can never be a flag. Never retried, never
// removes `index.lock`. Callers (the API) have already checked each path
// against a fresh status; Git 6/8 and 7/8 reuse `run_write`.

/// Cap on the git error text a failed write carries.
const WRITE_ERR_CAP: usize = 4 * 1024;

/// Most argv bytes one `git clean` call carries (it has no
/// `--pathspec-from-file`); more paths are cleaned in further calls.
const CLEAN_ARGV_CAP: usize = 100 * 1024;

/// What a write route does to the chosen paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOp {
    Stage,
    Unstage,
    Discard,
}

/// A conflicted (`u` record) entry: an unmerged XY pair. `U` appears in no
/// other record kind, and `AA`/`DD` are only ever unmerged.
pub fn is_conflicted(f: &GitFile) -> bool {
    f.status.contains('U') || f.status == "AA" || f.status == "DD"
}

/// The `X` (staged) and `Y` (unstaged) columns of a file's status.
fn xy(f: &GitFile) -> (char, char) {
    let mut c = f.status.chars();
    (c.next().unwrap_or('.'), c.next().unwrap_or('.'))
}

/// Something `git restore --staged` / `git rm --cached` can act on: a staged
/// change (not an untracked `?`).
fn has_staged(f: &GitFile) -> bool {
    !matches!(xy(f).0, '.' | '?')
}

/// A tracked file whose working copy differs from the index.
fn has_unstaged_tracked(f: &GitFile) -> bool {
    // `A` in the unstaged column is intent-to-add: `restore --worktree` is a
    // silent no-op there, so it counts as nothing to discard.
    f.status != "??" && !matches!(xy(f).1, '.' | 'A')
}

/// The status entry a write acts on for `path`. One path can be listed twice
/// (`D. keep.txt` plus `?? keep.txt` after `git rm --cached` and a re-create):
/// stage and discard prefer the untracked copy (so it can be staged or
/// deleted), unstage the entry that has something staged. `None` when the
/// path is not listed at all.
pub fn pick_entry<'a>(op: WriteOp, files: &'a [GitFile], path: &str) -> Option<&'a GitFile> {
    let same: Vec<&GitFile> = files.iter().filter(|f| f.path == path).collect();
    let want: fn(&GitFile) -> bool = match op {
        WriteOp::Stage | WriteOp::Discard => |f| f.status == "??",
        WriteOp::Unstage => has_staged,
    };
    same.iter()
        .copied()
        .find(|f| want(f))
        .or(same.first().copied())
}

/// The files `all: true` stands for, computed from a fresh status: stage-all
/// is every non-conflict file with an unstaged change or untracked;
/// unstage-all every non-conflict file with a staged change. Never discard.
/// An explicit list (never `git add -A` / a bare `git reset`) so a conflict
/// is never marked resolved and a merge in progress is never aborted.
pub fn eligible_for_all(op: WriteOp, files: &[GitFile]) -> Vec<GitFile> {
    files
        .iter()
        .filter(|f| !is_conflicted(f))
        .filter(|f| match op {
            WriteOp::Stage => xy(f).1 != '.',
            WriteOp::Unstage => has_staged(f),
            WriteOp::Discard => false,
        })
        .cloned()
        .collect()
}

/// The per-file rules, checked before any write; `Err` is a validation
/// message (nothing was spawned). A conflicted file is refused for all three
/// ops; discard also refuses a submodule and a tracked file with nothing
/// unstaged (discard never touches the index).
pub fn check_write(op: WriteOp, files: &[GitFile]) -> Result<(), String> {
    for f in files {
        if is_conflicted(f) {
            return Err(format!(
                "{} has conflicts; resolve it in the terminal",
                f.path
            ));
        }
        if op == WriteOp::Discard {
            if f.submodule {
                return Err(format!("{} is a submodule; it cannot be discarded", f.path));
            }
            if f.status != "??" && !has_unstaged_tracked(f) {
                return Err(format!("{}: nothing to discard", f.path));
            }
        }
    }
    Ok(())
}

/// Runs `op` on `files` (already allowlisted and checked). `Err` is git's own
/// stderr, trimmed and capped.
pub fn apply_write(dir: &str, op: WriteOp, files: &[GitFile]) -> Result<(), String> {
    match op {
        WriteOp::Stage => stage(dir, files),
        WriteOp::Unstage => unstage(dir, files),
        WriteOp::Discard => discard(dir, files),
    }
}

/// `git add` of the paths: modifications, deletions and untracked files or
/// folders; a rename whose unstaged column is `R` adds its source too. A
/// submodule entry stages only its gitlink (a plain add of the entry).
pub fn stage(dir: &str, files: &[GitFile]) -> Result<(), String> {
    let mut paths = Vec::new();
    for f in files {
        paths.push(f.path.as_str());
        if xy(f).1 == 'R' {
            paths.extend(f.orig_path.as_deref());
        }
    }
    run_pathspec_write(dir, &["add"], &paths)
}

/// Takes the paths out of the index, leaving the working files alone:
/// `git restore --staged`, or on an unborn HEAD (where `restore` has no
/// source) `git rm --cached -f -q`. A rename whose staged column is `R`
/// unstages both sides. Files with nothing staged are skipped.
pub fn unstage(dir: &str, files: &[GitFile]) -> Result<(), String> {
    let mut paths = Vec::new();
    for f in files.iter().filter(|f| has_staged(f)) {
        paths.push(f.path.as_str());
        if xy(f).0 == 'R' {
            paths.extend(f.orig_path.as_deref());
        }
    }
    let born = !head_is_unborn(dir)?;
    if born {
        run_pathspec_write(dir, &["restore", "--staged"], &paths)
    } else {
        run_pathspec_write(dir, &["rm", "--cached", "-f", "-q"], &paths)
    }
}

/// Exit code and trimmed stdout of one read-only `git -C <dir> <args>`.
fn probe(dir: &str, args: &[&str]) -> Option<(i32, String)> {
    let out = Command::new("git")
        .args(["-C", dir])
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Some((
        out.status.code()?,
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
    ))
}

/// True only for a genuinely unborn branch: HEAD is a symbolic ref whose
/// target ref does not exist. A HEAD that resolves is born; anything else
/// (a ref whose commit is missing, an unreadable HEAD) is an `Err`, because
/// `git rm --cached` on a born repo would stage deletions.
fn head_is_unborn(dir: &str) -> Result<bool, String> {
    if probe(dir, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]).is_some_and(|(c, _)| c == 0) {
        return Ok(false);
    }
    let unreadable = || "cannot tell whether HEAD is unborn; nothing was changed".to_string();
    let (code, target) = probe(dir, &["symbolic-ref", "-q", "HEAD"]).ok_or_else(unreadable)?;
    if code != 0 || target.is_empty() {
        return Err(unreadable());
    }
    match probe(dir, &["rev-parse", "--verify", "-q", &target]) {
        Some((1, _)) => Ok(true),
        Some((0, _)) => Err(format!(
            "{target} points at a missing commit; nothing was changed"
        )),
        _ => Err(unreadable()),
    }
}

/// Throws working-tree changes away, never touching the index: tracked paths
/// go back to their INDEX version (`git restore --worktree`, staged changes
/// kept); untracked paths are removed with `git clean -f -d -q -- <paths>`,
/// limited to exactly those (an untracked folder entry `dir/` removes that
/// folder; git itself refuses a nested repo). Never `-x`, never pathless.
pub fn discard(dir: &str, files: &[GitFile]) -> Result<(), String> {
    let tracked: Vec<&str> = files
        .iter()
        .filter(|f| has_unstaged_tracked(f))
        .map(|f| f.path.as_str())
        .collect();
    run_pathspec_write(dir, &["restore", "--worktree"], &tracked)?;
    let untracked: Vec<&str> = files
        .iter()
        .filter(|f| f.status == "??")
        .map(|f| f.path.as_str())
        .collect();
    let mut chunk: Vec<&str> = Vec::new();
    let mut size = 0;
    for p in untracked {
        if !chunk.is_empty() && size + p.len() > CLEAN_ARGV_CAP {
            run_clean(dir, &chunk)?;
            chunk.clear();
            size = 0;
        }
        size += p.len() + 1;
        chunk.push(p);
    }
    if chunk.is_empty() {
        Ok(())
    } else {
        run_clean(dir, &chunk)
    }
}

fn run_clean(dir: &str, paths: &[&str]) -> Result<(), String> {
    let mut args = vec!["clean", "-f", "-d", "-q", "--"];
    args.extend_from_slice(paths);
    run_write(dir, &args, None)
}

/// One `git <args> --pathspec-from-file=- --pathspec-file-nul` call with the
/// distinct `paths` on stdin; no paths, no call.
fn run_pathspec_write(dir: &str, args: &[&str], paths: &[&str]) -> Result<(), String> {
    let mut seen = HashSet::new();
    let mut stdin = Vec::new();
    for p in paths.iter().filter(|p| seen.insert(**p)) {
        stdin.extend_from_slice(p.as_bytes());
        stdin.push(0);
    }
    if stdin.is_empty() {
        return Ok(());
    }
    let mut full = args.to_vec();
    full.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    run_write(dir, &full, Some(stdin))
}

/// The one place a write spawns git (`-C <dir>`, literal pathspecs, no
/// prompt). `Err` carries git's stderr, lossy UTF-8, trimmed, capped at
/// [`WRITE_ERR_CAP`]; the caller reports it and never retries.
pub fn run_write(dir: &str, args: &[&str], stdin: Option<Vec<u8>>) -> Result<(), String> {
    use std::io::Write;
    let mut cmd = Command::new("git");
    cmd.args(["-C", dir])
        .args(args)
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = cmd.spawn().map_err(|e| format!("could not run git: {e}"))?;
    // Feed stdin from a thread so a git that fills its stderr pipe first
    // cannot deadlock against a big path list.
    let feeder = stdin.and_then(|data| {
        let mut pipe = child.stdin.take()?;
        Some(std::thread::spawn(move || {
            let _ = pipe.write_all(&data);
        }))
    });
    let out = child
        .wait_with_output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if let Some(t) = feeder {
        let _ = t.join();
    }
    if out.status.success() {
        return Ok(());
    }
    let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if msg.is_empty() {
        msg = format!(
            "git {} failed ({})",
            args.first().unwrap_or(&""),
            out.status
        );
    }
    if msg.len() > WRITE_ERR_CAP {
        let cut = (0..=WRITE_ERR_CAP).rev().find(|i| msg.is_char_boundary(*i));
        msg.truncate(cut.unwrap_or(0));
    }
    Err(msg)
}

/// Recent commit log (`git -C <dir> log -n LOG_CAP --date=iso-strict
/// --pretty=format:%H%x00%h%x00%an%x00%aI%x00%s`), newest first (git log's
/// default order). Empty vec on ANY failure — not a repo, or a real repo
/// with an unborn HEAD (no commits yet) are indistinguishable at this level
/// on purpose; the caller has already established repo validity via
/// `project_git_view`, so here "git log failed" only ever means "no commits
/// yet" in practice, and either way an empty list is the correct quiet
/// result (M9).
pub fn commit_log_of(dir: &str) -> Vec<GitCommit> {
    run_log(dir, None, &[], LOG_CAP, false)
}

/// History search filters (naru task 2736). Every field narrows the log on
/// the server, over the whole history, not just a loaded page. Text and
/// author are **fixed strings, case-insensitive** (`-F -i`), so regex and
/// shell characters are literal; each value is one argv entry after its flag,
/// so one starting with `-` is never read as an option. `path` is a literal
/// pathspec (`GIT_LITERAL_PATHSPECS=1`, so `*` and `:(magic)` are plain
/// characters) after `--`; renames are not followed (no `--follow`, see
/// `file_log_of`). `since`/`until` are `YYYY-MM-DD` days, inclusive, in the
/// server's local time, matched against the **committer** date (git's own
/// `--since`/`--until`). Build one with the `valid_*` checks below; an empty
/// filter is the plain log.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct LogFilter {
    pub text: Option<String>,
    pub author: Option<String>,
    pub path: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
}

impl LogFilter {
    pub fn is_empty(&self) -> bool {
        self.text.is_none()
            && self.author.is_none()
            && self.path.is_none()
            && self.since.is_none()
            && self.until.is_none()
    }

    fn args(&self) -> Vec<String> {
        let mut a = Vec::new();
        if self.text.is_some() || self.author.is_some() {
            a.push("--fixed-strings".to_string());
            a.push("--regexp-ignore-case".to_string());
        }
        if let Some(t) = &self.text {
            a.push("--grep".to_string());
            a.push(t.clone());
        }
        if let Some(t) = &self.author {
            a.push("--author".to_string());
            a.push(t.clone());
        }
        // A bare date makes git take the CURRENT time of day; pin the edges.
        if let Some(d) = &self.since {
            a.push("--since".to_string());
            a.push(format!("{d} 00:00:00"));
        }
        if let Some(d) = &self.until {
            a.push("--until".to_string());
            a.push(format!("{d} 23:59:59"));
        }
        a
    }
}

/// A `YYYY-MM-DD` day (what `<input type="date">` sends), month 1-12 and day
/// 1-31. Anything else is refused before git runs.
pub fn valid_log_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !b
        .iter()
        .enumerate()
        .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    let month: u32 = s[5..7].parse().unwrap_or(0);
    let day: u32 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// The path filter as a repo-relative pathspec: a leading `./` and trailing
/// `/` are dropped; `Ok(None)` for empty or `.` (no filter). Refused (`Err`,
/// with the message for the client):
/// an absolute path, a `..` component, a backslash or a control character —
/// the path names something inside the repo's history, and need not exist on
/// disk now (a deleted file still has history).
pub fn valid_log_path(raw: &str) -> Result<Option<String>, &'static str> {
    const REFUSED: &str = "path must be relative to the repo, without '..'";
    let mut p = raw;
    while let Some(rest) = p.strip_prefix("./") {
        p = rest;
    }
    let p = p.trim_end_matches('/');
    if p.is_empty() || p == "." {
        return Ok(None);
    }
    if p.starts_with('/') || p.contains('\\') || p.chars().any(char::is_control) {
        return Err(REFUSED);
    }
    if p.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return Err(REFUSED);
    }
    Ok(Some(p.to_string()))
}

/// How long one History log request may run before git is killed (a search
/// with no match walks the whole history). What was found by then is kept.
pub const LOG_TIMEOUT: Duration = Duration::from_secs(10);

/// One page of the History log: the commits, whether git has more past the
/// page, and whether [`LOG_TIMEOUT`] cut the walk short (then `has_more` is
/// false: there is no offset to resume from that git would agree with).
pub struct LogPage {
    pub commits: Vec<GitCommit>,
    pub has_more: bool,
    pub timed_out: bool,
}

/// One page of the History view's log: up to [`LOG_CAP`] commits starting
/// `skip` commits in, with each commit's `refs` filled, plus whether git has
/// more past the page. `all` walks every ref (`git log --all`) instead of
/// `dir`'s HEAD; `filter` narrows it (see [`LogFilter`]). Asks git for one
/// extra commit to learn `has_more`. Git's DEFAULT order (reverse
/// chronological) on purpose: `--topo-order`, `--date-order` and `--graph`
/// force a walk of the whole history when the repo has no commit-graph file,
/// and a page must stay bounded on a huge repo. A filter that matches little
/// can still walk everything, so the run is bounded by [`LOG_TIMEOUT`]. Same
/// empty-on-any-failure contract as [`commit_log_of`] (unborn HEAD
/// included).
pub fn commit_log_page(dir: &str, all: bool, skip: usize, filter: &LogFilter) -> LogPage {
    commit_log_page_for(dir, all, skip, filter, None)
}

/// [`commit_log_page`] reading `rev` (a FULL refname from [`branch_refname`],
/// naru task 2737) instead of `dir`'s HEAD. The caller has already checked it
/// against the branch list; it starts with `refs/`, so it is never a flag.
/// Meaningless together with `all`.
pub fn commit_log_page_for(
    dir: &str,
    all: bool,
    skip: usize,
    filter: &LogFilter,
    rev: Option<&str>,
) -> LogPage {
    // Only a search is bounded: an unfiltered page reads at most 101 commits
    // past `skip`, as before task 2736.
    let timeout = (!filter.is_empty()).then_some(LOG_TIMEOUT);
    commit_log_page_within(dir, all, skip, filter, rev, timeout)
}

fn commit_log_page_within(
    dir: &str,
    all: bool,
    skip: usize,
    filter: &LogFilter,
    rev: Option<&str>,
    timeout: Option<Duration>,
) -> LogPage {
    let mut extra = Vec::new();
    if all {
        extra.push("--all".to_string());
    }
    if skip > 0 {
        extra.push(format!("--skip={skip}"));
    }
    extra.extend(filter.args());
    if let Some(r) = rev {
        extra.push(r.to_string());
    }
    let mut cmd = log_command(dir, filter.path.as_deref(), &extra, LOG_CAP + 1, true);
    cmd.env("GIT_LITERAL_PATHSPECS", "1");
    let Some((stdout, ok, timed_out)) = output_within(cmd, timeout) else {
        return LogPage {
            commits: Vec::new(),
            has_more: false,
            timed_out: false,
        };
    };
    if !ok && !timed_out {
        return LogPage {
            commits: Vec::new(),
            has_more: false,
            timed_out: false,
        };
    }
    let mut commits = parse_log(&String::from_utf8_lossy(&stdout));
    if timed_out {
        // A killed git may have stopped mid-record, and with
        // `--pretty=format:` a whole last record looks the same: drop it.
        commits.pop();
        commits.truncate(LOG_CAP);
        return LogPage {
            commits,
            has_more: false,
            timed_out: true,
        };
    }
    let (commits, has_more) = page(commits);
    LogPage {
        commits,
        has_more,
        timed_out: false,
    }
}

/// Runs `cmd` with stdout captured, killing it after `timeout` (`None` = no
/// limit). Returns the stdout read so far, whether it exited successfully,
/// and whether it was killed; `None` when it could not be spawned.
fn output_within(mut cmd: Command, timeout: Option<Duration>) -> Option<(Vec<u8>, bool, bool)> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    // Drain on a thread so a full pipe never stalls the child.
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        buf
    });
    let deadline = timeout.map(|t| Instant::now() + t);
    let (ok, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.success(), false),
            Ok(None) if deadline.is_some_and(|d| Instant::now() >= d) => {
                let _ = child.kill();
                let _ = child.wait();
                break (false, true);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break (false, false);
            }
        }
    };
    let buf = reader.join().unwrap_or_default();
    Some((buf, ok, timed_out))
}

/// Splits git's `LOG_CAP + 1` answer into the page and its `has_more`.
fn page(mut commits: Vec<GitCommit>) -> (Vec<GitCommit>, bool) {
    let more = commits.len() > LOG_CAP;
    commits.truncate(LOG_CAP);
    (commits, more)
}

/// Commits that touched ONE path, newest first — `commit_log_of` with a
/// pathspec (`git log … -- <rel>`), same cap, same parse, same empty-vec-on-
/// failure contract, so a file's history and the repo's can never drift in
/// shape. `rel` is a path relative to `dir` and is placed after `--`, so git
/// can never read it as a flag; the caller is expected to have already
/// resolved it through `files::safe_path` (the Files tab's own traversal
/// chokepoint) — this function does not itself vouch for the path.
///
/// Deliberately NOT `--follow`: rename-following would list commits in which
/// the file lived under a DIFFERENT path, and those commits' own
/// changed-file lists (which allowlist the per-commit diff route) don't
/// contain the path the caller asked about — every pre-rename row would be
/// a 404 when clicked. Plain pathspec history keeps every listed commit
/// diffable. An empty vec is a legitimate answer: a file that exists on
/// disk but was never committed simply has no history.
pub fn file_log_of(dir: &str, rel: &str) -> Vec<GitCommit> {
    file_log_page(dir, rel).0
}

/// [`file_log_of`] plus whether the file has more commits past the first
/// [`LOG_CAP`]. Refs stay empty (the Files tab has no use for them).
pub fn file_log_page(dir: &str, rel: &str) -> (Vec<GitCommit>, bool) {
    page(run_log(dir, Some(rel), &[], LOG_CAP + 1, false))
}

/// Commits made in `dir` between `since` and `until` (task 920, spec D4) —
/// the log a receipt is built from: a task's claim window, not a browsing
/// window, so unlike `commit_log_of`/`file_log_of` there is no pathspec, only
/// a time range. `since`/`until` are `Store`'s own `datetime('now')` text
/// ("YYYY-MM-DD HH:MM:SS"), which SQLite always writes in UTC; `git
/// --since`/`--until` parse a bare timestamp in the LOCAL timezone, so each
/// is given to git with a trailing " UTC" to pin the same interpretation git
/// itself would give `claimed_at`/`closed_at` if it had written them. Get
/// this wrong and every receipt is silently mis-windowed by the reader's UTC
/// offset — not a crash, just quietly wrong commits, which is why the
/// suffix is load-bearing rather than cosmetic. Same cap, same
/// empty-vec-on-ANY-failure contract as `run_log` — an unreadable repo or an
/// empty window are indistinguishable here, and either way "no commits" is
/// the correct quiet result.
pub fn log_between(dir: &str, since: &str, until: &str) -> Vec<GitCommit> {
    run_log(
        dir,
        None,
        &[
            format!("--since={since} UTC"),
            format!("--until={until} UTC"),
        ],
        LOG_CAP,
        false,
    )
}

/// Commits made in `dir` since `since` (naru task 1691) — [`log_between`]
/// with no upper bound, `since` being `Store`'s UTC text and pinned the same
/// way (` UTC`). Same cap, same empty-vec-on-failure contract.
pub fn log_since(dir: &str, since: &str) -> Vec<GitCommit> {
    run_log(dir, None, &[format!("--since={since} UTC")], LOG_CAP, false)
}

/// The newest commit on any ref in `dir` since `since` (`Store`'s UTC text)
/// whose message cites `task <id>` (naru task 2401) — its abbreviated sha,
/// or `None` when there is none or git fails. `--all` so a commit still on
/// a worktree branch counts; the trailing non-digit keeps `task 24` from
/// matching `task 240`, the leading non-letter from matching `subtask 24`.
pub fn commit_citing_task(dir: &str, since: &str, task_id: i64) -> Option<String> {
    commit_citing_task_on(dir, "--all", since, task_id)
}

/// [`commit_citing_task`] limited to `dir`'s checked-out `HEAD` (naru task
/// 2647): a commit still on a worktree branch is not yet the code `dir`
/// serves.
pub fn commit_citing_task_in_head(dir: &str, since: &str, task_id: i64) -> Option<String> {
    commit_citing_task_on(dir, "HEAD", since, task_id)
}

fn commit_citing_task_on(dir: &str, revs: &str, since: &str, task_id: i64) -> Option<String> {
    let out = Command::new("git")
        .args(["-C", dir, "log", revs, "-n", "1", "-i", "-E", "--format=%h"])
        .arg(format!("--since={since} UTC"))
        .arg(format!("--grep=(^|[^a-z])task #?{task_id}([^0-9]|$)"))
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !sha.is_empty()).then_some(sha)
}

/// The first `max` paths `git ls-files` lists in `dir` (naru task 1691), empty
/// on any failure — not a repo and an empty repo read the same.
pub fn tracked_files(dir: &str, max: usize) -> Vec<String> {
    let out = Command::new("git")
        .args(["-C", dir, "ls-files"])
        .stdin(Stdio::null())
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .take(max)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// Shared body of the log readers. `extra` holds additional `git log` flags
/// (`--since`/`--until`, `--all`, `--skip=N`) passed as separate
/// `Command::arg`s — never string-built — so an untrusted value can never be
/// read as a second flag; `pathspec` is passed after `--` when present.
/// `limit` is the `-n` count. `with_refs` adds `%D` under `--decorate=full`;
/// receipts and triage pass false so a frozen log never captures branch
/// positions. Empty vec on ANY failure — not a repo, or a real repo with an
/// unborn HEAD (no commits yet) are indistinguishable at this level on
/// purpose; the caller has already established repo validity via
/// `project_git_view`, so here "git log failed" only ever means "no commits
/// yet" in practice, and either way an empty list is the correct quiet
/// result (M9).
fn run_log(
    dir: &str,
    pathspec: Option<&str>,
    extra: &[String],
    limit: usize,
    with_refs: bool,
) -> Vec<GitCommit> {
    let out = log_command(dir, pathspec, extra, limit, with_refs)
        .stdin(Stdio::null())
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    parse_log(&String::from_utf8_lossy(&out.stdout))
}

/// The `git log` command [`run_log`] and [`commit_log_page`] run: `extra`
/// after the format, `pathspec` alone after `--`.
fn log_command(
    dir: &str,
    pathspec: Option<&str>,
    extra: &[String],
    limit: usize,
    with_refs: bool,
) -> Command {
    let format = if with_refs {
        "--pretty=format:%H%x00%h%x00%an%x00%aI%x00%P%x00%D%x00%s"
    } else {
        "--pretty=format:%H%x00%h%x00%an%x00%aI%x00%P%x00%x00%s"
    };
    let mut cmd = Command::new("git");
    cmd.args(["-C", dir])
        .args(["log", "-n", &limit.to_string(), "--date=iso-strict"]);
    if with_refs {
        cmd.arg("--decorate=full");
    }
    cmd.arg(format);
    cmd.args(extra);
    if let Some(rel) = pathspec {
        cmd.arg("--").arg(rel);
    }
    cmd
}

/// Kept pure like parse_status/parse_view: splits `%x00`-joined fields per
/// line. NUL, because git cannot store one in a name or subject, whereas a
/// name may hold any other control byte (0x1f included) and would shift the
/// fields. The subject is last and takes the rest of the line.
fn parse_log(text: &str) -> Vec<GitCommit> {
    let mut commits = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let mut it = line.splitn(7, '\0');
        let (hash, short_hash, author, date, parents, decor, subject) = (
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
            it.next().unwrap_or(""),
        );
        commits.push(GitCommit {
            hash: hash.to_string(),
            short_hash: short_hash.to_string(),
            author: author.to_string(),
            date: date.to_string(),
            subject: subject.to_string(),
            parents: parents
                .split(' ')
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect(),
            refs: parse_refs(decor),
        });
    }
    commits
}

/// Parses `%D` under `--decorate=full` (entries joined by ", "): `HEAD ->
/// refs/heads/main`, a bare `HEAD` (detached), `refs/heads/x`,
/// `refs/remotes/origin/x`, `tag: refs/tags/v1`, anything else (`refs/stash`).
fn parse_refs(decor: &str) -> Vec<GitRef> {
    decor
        .split(", ")
        .filter(|e| !e.is_empty())
        .map(|e| {
            if e == "HEAD" {
                GitRef {
                    kind: GitRefKind::Head,
                    name: "HEAD".into(),
                    is_head: true,
                }
            } else if let Some(rest) = e.strip_prefix("HEAD -> ") {
                GitRef {
                    is_head: true,
                    ..classify_ref(rest)
                }
            } else {
                classify_ref(e.strip_prefix("tag: ").unwrap_or(e))
            }
        })
        .collect()
}

fn classify_ref(full: &str) -> GitRef {
    let (kind, name) = if let Some(n) = full.strip_prefix("refs/heads/") {
        (GitRefKind::Branch, n)
    } else if let Some(n) = full.strip_prefix("refs/remotes/") {
        (GitRefKind::Remote, n)
    } else if let Some(n) = full.strip_prefix("refs/tags/") {
        (GitRefKind::Tag, n)
    } else {
        (GitRefKind::Other, full)
    };
    GitRef {
        kind,
        name: name.to_string(),
        is_head: false,
    }
}

/// Defense-in-depth (M8): rejects anything that isn't plausibly a git hash
/// BEFORE it reaches a `git` subprocess, so a commit id can never be read as
/// a flag (leading `-`) or a path. 7..=64 hex chars — covers any sha1
/// abbreviation up to a full sha1 (40) and full sha256 (64) without
/// hardcoding one hash algorithm; our own `commit_log_of` always hands back
/// full 40-char hashes, so in practice callers built against this contract
/// never send anything shorter.
fn is_valid_commit_id(sha: &str) -> bool {
    let len = sha.len();
    (7..=64).contains(&len) && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Files changed in one commit: `git -C <dir> show --no-color
/// --diff-merges=first-parent --name-status -z --format= <sha>` merged with the
/// same call's `--numstat -z` by path for the line counts. `--format=`
/// suppresses the commit header; the root commit diffs against the empty
/// tree (all files `A`). A merge commit is diffed against its FIRST parent
/// (`--diff-merges=first-parent`, the same flag `commit_file_diff_of` uses),
/// so the list is "what this merge brought onto its branch" and every listed
/// file has a non-empty diff — git's default combined diff would list almost
/// nothing and render as unreadable `diff --cc` text. `-z` keeps paths
/// unquoted. `sha` is validated by `is_valid_commit_id` (M8) BEFORE the
/// Command is built; an invalid shape short-circuits to `None` without
/// spawning git. `None` on invalid shape or git failure (unknown sha, not a
/// repo) — the caller maps this to `not_found`. `Some(vec![])` is a
/// legitimate answer (an empty commit). A failed numstat leaves the counts
/// `None` rather than failing the list.
pub fn commit_files_of(dir: &str, sha: &str) -> Option<Vec<GitCommitFile>> {
    if !is_valid_commit_id(sha) {
        return None;
    }
    let show = |fmt: &str| {
        Command::new("git")
            .args(["-C", dir])
            .args([
                "show",
                "--no-color",
                "--diff-merges=first-parent",
                fmt,
                "-z",
                "--format=",
                sha,
            ])
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
    };
    let names = show("--name-status")?;
    let mut files = parse_commit_files(&String::from_utf8_lossy(&names.stdout));
    if let Some(nums) = show("--numstat") {
        let counts = parse_numstat_z(&String::from_utf8_lossy(&nums.stdout));
        for f in &mut files {
            if let Some((a, d)) = counts.get(&f.path) {
                f.added = *a;
                f.deleted = *d;
            }
        }
    }
    Some(files)
}

/// Kept pure: parses `git show --name-status -z` — NUL-separated tokens,
/// `STATUS\0path\0` (add/modify/delete/etc.) or `STATUS\0old\0new\0` for a
/// rename/copy (STATUS carries a similarity score e.g. "R100"). Counts are
/// left `None` for the caller to fill.
fn parse_commit_files(text: &str) -> Vec<GitCommitFile> {
    let mut files = Vec::new();
    let mut toks = text.split('\0').filter(|t| !t.is_empty());
    while let Some(status) = toks.next() {
        let (path, orig_path) = if status.starts_with('R') || status.starts_with('C') {
            let (Some(old), Some(new)) = (toks.next(), toks.next()) else {
                break;
            };
            (new.to_string(), Some(old.to_string()))
        } else {
            let Some(p) = toks.next() else {
                break;
            };
            (p.to_string(), None)
        };
        files.push(GitCommitFile {
            status: status.to_string(),
            path,
            orig_path,
            added: None,
            deleted: None,
        });
    }
    files
}

/// Kept pure: parses `git show --numstat -z` into `path -> (added, deleted)`,
/// `None` counts for a binary file (`-`/`-`). Entries are `added\tdeleted\t
/// path\0`; a rename is `added\tdeleted\t\0old\0new\0` and is keyed by the
/// NEW path (what `GitCommitFile.path` holds).
fn parse_numstat_z(text: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let mut out = HashMap::new();
    let mut toks = text.split('\0').filter(|t| !t.is_empty());
    while let Some(tok) = toks.next() {
        let mut parts = tok.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            let (Some(_old), Some(new)) = (toks.next(), toks.next()) else {
                break;
            };
            new
        } else {
            path
        };
        out.insert(path.to_string(), (a.parse().ok(), d.parse().ok()));
    }
    out
}

/// One commit's header and message (`git log -n 1 --format=…`, fields split
/// on `%x00` with the body last so it may hold anything). `None` on an
/// invalid sha shape (checked before any spawn), an unknown sha or a non-
/// commit object. The body is capped at [`BODY_CAP`] on a char boundary.
pub fn commit_detail_of(dir: &str, sha: &str) -> Option<GitCommitDetail> {
    if !is_valid_commit_id(sha) {
        return None;
    }
    let out = Command::new("git")
        .args(["-C", dir])
        .args([
            "log",
            "-n",
            "1",
            "--no-color",
            "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b",
            sha,
            "--",
        ])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_commit_detail(&String::from_utf8_lossy(&out.stdout))
}

fn parse_commit_detail(text: &str) -> Option<GitCommitDetail> {
    let mut it = text.splitn(11, '\0');
    let mut next = || it.next();
    let hash = next()?;
    let short_hash = next()?;
    let parents = next()?;
    let author = next()?;
    let author_email = next()?;
    let author_date = next()?;
    let committer = next()?;
    let committer_email = next()?;
    let committer_date = next()?;
    let subject = next()?;
    let body = next()?.trim_end();
    if hash.is_empty() {
        return None;
    }
    let mut body = body.to_string();
    if body.len() > BODY_CAP {
        let cut = (0..=BODY_CAP).rev().find(|i| body.is_char_boundary(*i));
        body.truncate(cut.unwrap_or(0));
        body.push_str("\n[message truncated]");
    }
    Some(GitCommitDetail {
        hash: hash.to_string(),
        short_hash: short_hash.to_string(),
        parents: parents
            .split(' ')
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect(),
        author: author.to_string(),
        author_email: author_email.to_string(),
        author_date: author_date.to_string(),
        committer: committer.to_string(),
        committer_email: committer_email.to_string(),
        committer_date: committer_date.to_string(),
        subject: subject.to_string(),
        body,
    })
}

/// One file's diff as introduced by one commit: `git -C <dir> show
/// --no-color --diff-merges=first-parent <sha> -- <path>` via the existing
/// `run_diff` helper (same DIFF_CAP truncation as working-tree diffs, S4).
/// Root commit renders fully-added (M4) because `git show` on the first
/// commit diffs against the empty tree, same as commit_files_of; a merge is
/// diffed against its first parent, matching `commit_files_of`'s list (the
/// flag changes nothing for a non-merge commit). `sha` validated the same way
/// (M8); `None` on invalid shape or git failure.
pub fn commit_file_diff_of(dir: &str, sha: &str, path: &str) -> Option<String> {
    if !is_valid_commit_id(sha) {
        return None;
    }
    run_diff(
        dir,
        &[
            "show",
            "--no-color",
            "--diff-merges=first-parent",
            sha,
            "--",
            path,
        ],
        &[0],
    )
}

/// Summed diff stat over `shas` (task 920, spec D4/schema) — the numbers a
/// receipt shows beside its commit list. One `git -C <dir> show --numstat
/// --format= <sha>` per sha (`--format=` suppresses the commit header,
/// leaving only numstat lines, same trick `commit_files_of` uses for
/// `--name-status`); `insertions`/`deletions` are summed across every
/// commit, but `files_changed` counts DISTINCT paths across the whole set,
/// not one count per commit — the same file touched by two commits in the
/// window is one changed file, not two. Each sha is checked with
/// `is_valid_commit_id` BEFORE it reaches a `git` subprocess (M8, same
/// defense-in-depth as `commit_files_of`/`commit_file_diff_of`); an invalid
/// sha is skipped rather than aborting the whole sum, since `shas` here is
/// always mesa's own `log_between` output and an invalid entry can only mean
/// a caller bug, not an attack surface worth failing loudly over.
///
/// Documented limitation: `--format=` renders no diff at all for a merge
/// commit (git's own default for `show` on a merge, same as
/// `commit_files_of`'s note), so a merge inside the window silently
/// contributes nothing to the stat. Accepted, not fixed: a combined diff
/// against a synthetic merge base is not "what changed" in any single sense
/// a receipt could summarize without editorializing.
pub fn diff_stat(dir: &str, shas: &[String]) -> DiffStat {
    let mut files: HashSet<String> = HashSet::new();
    let mut insertions = 0u32;
    let mut deletions = 0u32;
    for sha in shas {
        if !is_valid_commit_id(sha) {
            continue;
        }
        let out = Command::new("git")
            .args(["-C", dir])
            .args(["show", "--numstat", "--format=", sha])
            .stdin(Stdio::null())
            .output();
        let Ok(out) = out else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let (add, del, paths) = parse_numstat(&String::from_utf8_lossy(&out.stdout));
        insertions += add;
        deletions += del;
        files.extend(paths);
    }
    DiffStat {
        files_changed: files.len() as u32,
        insertions,
        deletions,
    }
}

/// Kept pure like `parse_log`/`parse_commit_files`: parses `git show
/// --numstat` lines, tab-separated `<added>\t<deleted>\t<path>`. A binary
/// file reports `-`/`-` for its counts (git's own convention, no line count
/// available) and is still returned as a changed path with 0 lines — a
/// binary asset that changed must still show up in `files_changed`, it just
/// can't contribute a line count. Returns `(insertions, deletions, paths)`
/// rather than a `DiffStat` so the caller can fold `paths` into a set across
/// several commits before counting distinct files.
fn parse_numstat(text: &str) -> (u32, u32, Vec<String>) {
    let mut insertions = 0u32;
    let mut deletions = 0u32;
    let mut paths = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let added = parts.next().unwrap_or("");
        let deleted = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("");
        if path.is_empty() {
            continue;
        }
        // "-" marks a binary file (git's own convention) — no line count,
        // parsed as 0 rather than propagating a sentinel through DiffStat.
        insertions += added.parse::<u32>().unwrap_or(0);
        deletions += deleted.parse::<u32>().unwrap_or(0);
        paths.push(path.to_string());
    }
    (insertions, deletions, paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An unfiltered History page as `(commits, has_more)`.
    fn plain_page(dir: &str, all: bool, skip: usize) -> (Vec<GitCommit>, bool) {
        let p = commit_log_page(dir, all, skip, &LogFilter::default());
        assert!(!p.timed_out);
        (p.commits, p.has_more)
    }

    #[test]
    fn parses_branch_with_upstream_and_changes() {
        let s = parse_status(
            "# branch.oid 1111111111111111111111111111111111111111\n\
             # branch.head main\n\
             # branch.upstream origin/main\n\
             # branch.ab +2 -1\n\
             1 .M N... 100644 100644 100644 aaa bbb src/lib.rs\n\
             2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\told.rs\n\
             ? untracked.txt\n",
        );
        assert_eq!(s.branch, "main");
        assert_eq!(s.dirty, 3);
        assert_eq!(s.ahead, 2);
        assert_eq!(s.behind, 1);
    }

    #[test]
    fn parses_clean_branch_without_upstream() {
        let s = parse_status(
            "# branch.oid 2222222222222222222222222222222222222222\n\
             # branch.head feature/x\n",
        );
        assert_eq!(s.branch, "feature/x");
        assert_eq!(s.dirty, 0);
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
    }

    #[test]
    fn detached_head_shows_short_oid() {
        let s = parse_status(
            "# branch.oid deadbeefcafe0000000000000000000000000000\n\
             # branch.head (detached)\n",
        );
        assert_eq!(s.branch, "deadbeef");
    }

    #[test]
    fn parse_view_reads_headers_and_all_file_line_kinds() {
        let v = parse_view(
            "# branch.oid 1111111111111111111111111111111111111111\0\
             # branch.head main\0\
             # branch.upstream origin/main\0\
             # branch.ab +2 -1\0\
             1 .M N... 100644 100644 100644 aaa bbb src/lib.rs\0\
             1 MM N... 100644 100644 100644 aaa bbb with space.txt\0\
             2 R. N... 100644 100644 100644 aaa bbb R100 new.rs\0old.rs\0\
             u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.rs\0\
             ? untracked.txt\0",
        );
        assert_eq!(v.status.branch, "main");
        assert_eq!(v.status.ahead, 2);
        assert_eq!(v.status.behind, 1);
        assert_eq!(v.status.dirty, 5);
        assert_eq!(v.files.len(), 5);
        assert_eq!(v.operation, None);
        assert_eq!(v.files[0].status, ".M");
        assert_eq!(v.files[0].path, "src/lib.rs");
        assert_eq!(v.files[0].orig_path, None);
        assert!(!v.files[0].submodule);
        assert_eq!(v.files[1].status, "MM");
        assert_eq!(v.files[1].path, "with space.txt");
        assert_eq!(v.files[2].status, "R.");
        assert_eq!(v.files[2].path, "new.rs");
        assert_eq!(v.files[2].orig_path.as_deref(), Some("old.rs"));
        assert_eq!(v.files[3].status, "UU");
        assert_eq!(v.files[3].path, "conflict.rs");
        assert_eq!(v.files[4].status, "??");
        assert_eq!(v.files[4].path, "untracked.txt");
        assert_eq!(v.files[4].orig_path, None);
    }

    #[test]
    fn parse_view_keeps_odd_paths_and_flags_submodules() {
        // `-z` paths are verbatim: quote, tab, newline, unicode, leading `-`,
        // and a rename's original path is the NEXT NUL field.
        let v = parse_view(
            "# branch.head main\0\
             1 .M S.M. 160000 160000 160000 aaa bbb sub\0\
             1 .M N... 100644 100644 100644 aaa bbb a\"q\"\tb\nc é.txt\0\
             2 R. N... 100644 100644 100644 aaa bbb R100 -new file\0-old file\0\
             ? -dash\0",
        );
        assert_eq!(v.files.len(), 4);
        assert!(v.files[0].submodule);
        assert_eq!(v.files[0].path, "sub");
        assert!(!v.files[1].submodule);
        assert_eq!(v.files[1].path, "a\"q\"\tb\nc é.txt");
        assert_eq!(v.files[2].path, "-new file");
        assert_eq!(v.files[2].orig_path.as_deref(), Some("-old file"));
        assert_eq!(v.files[3].path, "-dash");
        assert_eq!(v.status.dirty, 4);
    }

    #[test]
    fn parse_view_of_clean_repo_is_empty() {
        let v = parse_view(
            "# branch.oid 2222222222222222222222222222222222222222\0\
             # branch.head feature/x\0",
        );
        assert_eq!(v.status.branch, "feature/x");
        assert!(v.files.is_empty());
    }

    #[test]
    fn operation_in_names_each_state_and_rebase_wins() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(operation_in(d.path()), None);
        for (marker, want) in [
            ("BISECT_LOG", "bisect"),
            ("REVERT_HEAD", "revert"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("MERGE_HEAD", "merge"),
        ] {
            std::fs::write(d.path().join(marker), "x").unwrap();
            assert_eq!(operation_in(d.path()).as_deref(), Some(want));
        }
        std::fs::create_dir_all(d.path().join("rebase-apply")).unwrap();
        std::fs::write(d.path().join("rebase-apply/rebasing"), "").unwrap();
        assert_eq!(operation_in(d.path()).as_deref(), Some("rebase"));
    }

    #[test]
    fn parse_worktrees_reads_branch_detached_and_bare_blocks() {
        let wts = parse_worktrees(
            "worktree /repo/main\n\
             HEAD 1111111111111111111111111111111111111111\n\
             branch refs/heads/main\n\
             \n\
             worktree /repo/linked\n\
             HEAD 2222222222222222222222222222222222222222\n\
             branch refs/heads/feature\n\
             \n\
             worktree /repo/detached\n\
             HEAD 3333333333333333333333333333333333333333\n\
             detached\n",
            "/repo/linked",
        );
        assert_eq!(wts.len(), 3);
        assert_eq!(wts[0].path, "/repo/main");
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert!(!wts[0].is_current);
        assert_eq!(wts[1].path, "/repo/linked");
        assert_eq!(wts[1].branch.as_deref(), Some("feature"));
        // Neither side canonicalizes (folders don't exist) — falls back to
        // the raw string compare, which matches the `dir` passed in.
        assert!(wts[1].is_current);
        assert_eq!(wts[2].path, "/repo/detached");
        assert_eq!(wts[2].branch, None);
        assert_eq!(wts[2].head, "3333333333333333333333333333333333333333");
    }

    #[test]
    fn worktrees_of_real_repo_lists_linked_worktree_and_marks_current() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert_eq!(worktrees_of(path), None);
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(["-C", path, "-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-b", "trunk"]);
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        git(&["add", "f.txt"]);
        git(&["commit", "-m", "seed"]);

        let linked_dir = tempfile::tempdir().unwrap();
        let linked_path = linked_dir.path().join("linked");
        git(&[
            "worktree",
            "add",
            "-b",
            "feature",
            linked_path.to_str().unwrap(),
        ]);

        let from_main = worktrees_of(path).unwrap();
        assert_eq!(from_main.len(), 2);
        let main_entry = from_main
            .iter()
            .find(|w| w.branch.as_deref() == Some("trunk"))
            .unwrap();
        assert!(main_entry.is_current);
        let linked_entry = from_main
            .iter()
            .find(|w| w.branch.as_deref() == Some("feature"))
            .unwrap();
        assert!(!linked_entry.is_current);

        // Same full list, but querying from the linked worktree flips which
        // entry is "current".
        let from_linked = worktrees_of(linked_path.to_str().unwrap()).unwrap();
        assert_eq!(from_linked.len(), 2);
        assert!(
            !from_linked
                .iter()
                .find(|w| w.branch.as_deref() == Some("trunk"))
                .unwrap()
                .is_current
        );
        assert!(
            from_linked
                .iter()
                .find(|w| w.branch.as_deref() == Some("feature"))
                .unwrap()
                .is_current
        );
    }

    #[test]
    fn capped_truncates_on_char_boundary_with_notice() {
        assert_eq!(capped(b"short"), "short");
        // 4-byte chars straddling the cap: truncation lands on a boundary.
        let s = "🦀".repeat(DIFF_CAP / 4 + 8);
        let out = capped(s.as_bytes());
        assert!(out.ends_with("\n[diff truncated]"));
        assert!(out.len() <= DIFF_CAP + "\n[diff truncated]".len());
    }

    #[test]
    fn status_of_rejects_non_repo_and_reads_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert_eq!(status_of(path), None);
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(["-C", path])
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-b", "trunk"]);
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let s = status_of(path).unwrap();
        assert_eq!(s.branch, "trunk");
        assert_eq!(s.dirty, 1);
    }

    #[test]
    fn view_of_and_diff_of_read_a_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert_eq!(view_of(path), None);
        assert_eq!(diff_of(path, "f.txt", false), None);
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(["-C", path, "-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-b", "trunk"]);
        std::fs::write(dir.path().join("tracked.txt"), "old line\n").unwrap();
        git(&["add", "tracked.txt"]);
        git(&["commit", "-m", "seed"]);
        // Staged + unstaged edits on the tracked file, plus an untracked one.
        std::fs::write(dir.path().join("tracked.txt"), "staged line\n").unwrap();
        git(&["add", "tracked.txt"]);
        std::fs::write(
            dir.path().join("tracked.txt"),
            "staged line\nworktree line\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("new.txt"), "brand new\n").unwrap();

        let v = view_of(path).unwrap();
        assert_eq!(v.status.branch, "trunk");
        assert_eq!(v.status.dirty, 2);
        let tracked = v.files.iter().find(|f| f.path == "tracked.txt").unwrap();
        assert_eq!(tracked.status, "MM");
        let untracked = v.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(untracked.status, "??");

        // One diff vs HEAD covers staged AND unstaged edits together.
        let d = diff_of(path, "tracked.txt", false).unwrap();
        assert!(d.contains("-old line"), "diff was: {d}");
        assert!(d.contains("+staged line"), "diff was: {d}");
        assert!(d.contains("+worktree line"), "diff was: {d}");

        // Untracked renders all-added via --no-index /dev/null (exit code 1).
        let d = diff_of(path, "new.txt", true).unwrap();
        assert!(d.contains("+brand new"), "diff was: {d}");
        assert!(d.contains("/dev/null"), "diff was: {d}");

        // A clean/unknown path is an empty diff, not an error.
        assert_eq!(diff_of(path, "absent.txt", false).unwrap(), "");
    }

    #[test]
    fn diff_of_falls_back_on_unborn_head() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let ok = Command::new("git")
            .args(["-C", path, "init", "-b", "trunk"])
            .stdout(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok);
        std::fs::write(dir.path().join("s.txt"), "staged\n").unwrap();
        let ok = Command::new("git")
            .args(["-C", path, "add", "s.txt"])
            .status()
            .unwrap()
            .success();
        assert!(ok);
        // No commits: `diff HEAD` fails, the --cached fallback still shows it.
        let d = diff_of(path, "s.txt", false).unwrap();
        assert!(d.contains("+staged"), "diff was: {d}");
    }

    /// A synthetic repo with a root commit (`a.txt` + `b.txt`) and a
    /// follow-on commit that modifies `a.txt` and renames `b.txt` ->
    /// `c.txt`. Returns `(tempdir, root_sha, second_sha)`.
    fn synthetic_history_repo() -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let git = |args: &[&str]| {
            let ok = Command::new("git")
                .args(["-C", path, "-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-b", "trunk"]);
        std::fs::write(dir.path().join("a.txt"), "line one\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "b content\n").unwrap();
        git(&["add", "a.txt", "b.txt"]);
        git(&["commit", "-m", "root commit"]);
        let root_sha = String::from_utf8(
            Command::new("git")
                .args(["-C", path, "rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        std::fs::write(dir.path().join("a.txt"), "line one\nline two\n").unwrap();
        std::fs::remove_file(dir.path().join("b.txt")).unwrap();
        std::fs::write(dir.path().join("c.txt"), "b content\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-m", "modify a, rename b to c"]);
        let second_sha = String::from_utf8(
            Command::new("git")
                .args(["-C", path, "rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        (dir, root_sha, second_sha)
    }

    #[test]
    fn commit_log_of_lists_newest_first_and_is_capped() {
        let (dir, root_sha, second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let log = commit_log_of(path);
        assert_eq!(log.len(), 2);
        // Newest first.
        assert_eq!(log[0].hash, second_sha);
        assert_eq!(log[0].subject, "modify a, rename b to c");
        assert_eq!(log[0].author, "t");
        assert!(!log[0].date.is_empty());
        assert!(second_sha.starts_with(&log[0].short_hash));
        assert_eq!(log[1].hash, root_sha);
        assert_eq!(log[1].subject, "root commit");
        assert!(log.len() <= LOG_CAP);
    }

    /// The bug behind mesa task 805: a linked worktree has its OWN HEAD, so
    /// its log is not the main checkout's — which is why the `/git/log` route
    /// honours the tab's `?worktree=` selection instead of always reading
    /// `local_path`.
    #[test]
    fn commit_log_of_reads_the_selected_worktrees_own_head() {
        let (dir, _root_sha, second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let git = |cwd: &str, args: &[&str]| {
            let ok = Command::new("git")
                .args(["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        let linked_dir = tempfile::tempdir().unwrap();
        let linked = linked_dir.path().join("linked");
        git(
            path,
            &["worktree", "add", "-b", "feature", linked.to_str().unwrap()],
        );
        let linked_path = linked.to_str().unwrap();
        std::fs::write(linked.join("w.txt"), "worktree only\n").unwrap();
        git(linked_path, &["add", "w.txt"]);
        git(linked_path, &["commit", "-m", "worktree commit"]);
        let wt_sha = String::from_utf8(
            Command::new("git")
                .args(["-C", linked_path, "rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        // The main checkout never saw that commit...
        let main_log = commit_log_of(path);
        assert_eq!(main_log.len(), 2);
        assert_eq!(main_log[0].hash, second_sha);
        // ...but the worktree's own log leads with it.
        let linked_log = commit_log_of(linked_path);
        assert_eq!(linked_log.len(), 3);
        assert_eq!(linked_log[0].hash, wt_sha);
        assert_eq!(linked_log[0].subject, "worktree commit");
        assert_eq!(linked_log[1].hash, second_sha);
    }

    /// Why the per-commit routes need no worktree selector: commits live in
    /// the repo's shared object store, so a sha only reachable from a linked
    /// worktree's branch still resolves — files and diff — from the main
    /// checkout the project's `local_path` points at.
    #[test]
    fn commit_files_of_resolves_a_commit_made_in_a_linked_worktree() {
        let (dir, _root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let git = |cwd: &str, args: &[&str]| {
            let ok = Command::new("git")
                .args(["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t"])
                .args(args)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "git {args:?} failed");
        };
        let linked_dir = tempfile::tempdir().unwrap();
        let linked = linked_dir.path().join("linked");
        git(
            path,
            &["worktree", "add", "-b", "feature", linked.to_str().unwrap()],
        );
        let linked_path = linked.to_str().unwrap();
        std::fs::write(linked.join("w.txt"), "worktree only\n").unwrap();
        git(linked_path, &["add", "w.txt"]);
        git(linked_path, &["commit", "-m", "worktree commit"]);
        let wt_sha = String::from_utf8(
            Command::new("git")
                .args(["-C", linked_path, "rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        let files = commit_files_of(path, &wt_sha).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "w.txt");
        assert_eq!(files[0].status, "A");
        let d = commit_file_diff_of(path, &wt_sha, "w.txt").unwrap();
        assert!(d.contains("+worktree only"), "diff was: {d}");
    }

    #[test]
    fn file_log_of_lists_only_commits_touching_that_path() {
        let (dir, root_sha, second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        // a.txt was added by the root commit and modified by the second.
        let a = file_log_of(path, "a.txt");
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].hash, second_sha);
        assert_eq!(a[1].hash, root_sha);
        // c.txt only came into existence in the second commit.
        let c = file_log_of(path, "c.txt");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].hash, second_sha);
        assert_eq!(c[0].subject, "modify a, rename b to c");
    }

    #[test]
    fn file_log_of_empty_for_untracked_path_and_non_repo() {
        let (dir, _root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        // Exists in no commit — a real answer ("no history"), not an error.
        assert_eq!(file_log_of(path, "never-committed.txt"), Vec::new());
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(
            file_log_of(plain.path().to_str().unwrap(), "a.txt"),
            Vec::new()
        );
    }

    /// The contract the UI leans on: every commit `file_log_of` lists is one
    /// the per-commit diff route will accept for that same path — i.e. the
    /// path appears in that commit's own changed-file list, as `path` or (on
    /// a rename) `orig_path`. This is why `file_log_of` doesn't use
    /// `--follow`.
    #[test]
    fn every_file_log_commit_is_diffable_for_that_path() {
        let (dir, _root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        for target in ["a.txt", "b.txt", "c.txt"] {
            for commit in file_log_of(path, target) {
                let files = commit_files_of(path, &commit.hash).unwrap();
                assert!(
                    files
                        .iter()
                        .any(|f| f.path == target || f.orig_path.as_deref() == Some(target)),
                    "{target} not listed in commit {}",
                    commit.hash
                );
                assert!(commit_file_diff_of(path, &commit.hash, target).is_some());
            }
        }
    }

    #[test]
    fn commit_log_of_empty_on_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(commit_log_of(dir.path().to_str().unwrap()), Vec::new());
    }

    #[test]
    fn commit_files_of_root_commit_returns_all_files_added() {
        let (dir, root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let mut files = commit_files_of(path, &root_sha).unwrap();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].status, "A");
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].orig_path, None);
        assert_eq!(files[1].status, "A");
        assert_eq!(files[1].path, "b.txt");
    }

    #[test]
    fn commit_files_of_rename_commit_reports_rename_with_orig_path() {
        let (dir, _root_sha, second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let files = commit_files_of(path, &second_sha).unwrap();
        let modified = files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(modified.status, "M");
        assert_eq!(modified.orig_path, None);
        let renamed = files.iter().find(|f| f.path == "c.txt").unwrap();
        assert!(
            renamed.status.starts_with('R'),
            "status: {}",
            renamed.status
        );
        assert_eq!(renamed.orig_path.as_deref(), Some("b.txt"));
    }

    #[test]
    fn commit_file_diff_of_root_commit_renders_fully_added() {
        let (dir, root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let d = commit_file_diff_of(path, &root_sha, "a.txt").unwrap();
        assert!(d.contains("+line one"), "diff was: {d}");
        assert!(
            d.contains("new file mode") || d.contains("+++ b/a.txt"),
            "diff was: {d}"
        );
    }

    #[test]
    fn commit_files_of_and_diff_of_reject_invalid_sha_before_spawning_git() {
        let (dir, _root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        for bad in ["; rm -rf /", "short", "not-hex-zzzz", "-flag"] {
            assert!(!is_valid_commit_id(bad), "should reject: {bad}");
            assert_eq!(commit_files_of(path, bad), None);
            assert_eq!(commit_file_diff_of(path, bad, "a.txt"), None);
        }
    }

    #[test]
    fn commit_files_of_unknown_but_well_shaped_sha_is_none() {
        let (dir, _root_sha, _second_sha) = synthetic_history_repo();
        let path = dir.path().to_str().unwrap();
        let unknown = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        assert!(is_valid_commit_id(unknown));
        assert_eq!(commit_files_of(path, unknown), None);
    }

    #[test]
    fn is_valid_commit_id_accepts_only_plausible_hex_hashes() {
        assert!(is_valid_commit_id("1234567"));
        assert!(is_valid_commit_id(&"a".repeat(40)));
        assert!(is_valid_commit_id(&"f".repeat(64)));
        assert!(!is_valid_commit_id("123456")); // too short (6 chars)
        assert!(!is_valid_commit_id(&"a".repeat(65))); // too long
        assert!(!is_valid_commit_id("abcdefg")); // non-hex char
        assert!(!is_valid_commit_id("-rf"));
    }

    // ---- task 920: log_between / diff_stat ----

    #[test]
    fn parse_numstat_sums_lines_and_counts_a_binary_file_as_zero_lines() {
        let (ins, del, paths) = parse_numstat("3\t1\ta.txt\n0\t0\tb.txt\n-\t-\timg.png\n");
        assert_eq!(ins, 3);
        assert_eq!(del, 1);
        assert_eq!(paths, vec!["a.txt", "b.txt", "img.png"]);
    }

    #[test]
    fn parse_numstat_skips_blank_lines() {
        let (ins, del, paths) = parse_numstat("\n1\t2\tx.txt\n\n");
        assert_eq!(ins, 1);
        assert_eq!(del, 2);
        assert_eq!(paths, vec!["x.txt"]);
    }

    /// A repo with commits at controlled dates (`GIT_AUTHOR_DATE`/
    /// `GIT_COMMITTER_DATE`) so `log_between`'s window can be tested exactly,
    /// plus one binary file so `diff_stat`'s "-"/"-" handling has something
    /// real to read rather than only `parse_numstat`'s synthetic input.
    /// Returns `(dir, sha_2024, sha_2025)`.
    fn dated_history_repo() -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let commit_at = |date: &str, msg: &str| {
            let ok = Command::new("git")
                .args(["-C", path, "-c", "user.email=t@t", "-c", "user.name=t"])
                .args(["commit", "-m", msg])
                .env("GIT_AUTHOR_DATE", date)
                .env("GIT_COMMITTER_DATE", date)
                .stdout(Stdio::null())
                .status()
                .unwrap()
                .success();
            assert!(ok, "commit at {date} failed");
        };
        let add_all = || {
            Command::new("git")
                .args(["-C", path, "add", "-A"])
                .status()
                .unwrap();
        };
        Command::new("git")
            .args(["-C", path, "init", "-b", "trunk"])
            .stdout(Stdio::null())
            .status()
            .unwrap();
        std::fs::write(dir.path().join("a.txt"), "line one\n").unwrap();
        // A NUL byte is how git's own diff machinery decides a file is
        // binary — no extension sniffing involved.
        std::fs::write(dir.path().join("img.bin"), [0u8, 1, 2, 3]).unwrap();
        add_all();
        commit_at("2024-01-01T00:00:00", "in window");
        let sha_2024 = String::from_utf8(
            Command::new("git")
                .args(["-C", path, "rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        std::fs::write(dir.path().join("img.bin"), [0u8, 1, 2, 3, 4]).unwrap();
        add_all();
        commit_at("2025-01-01T00:00:00", "outside window");
        let sha_2025 = String::from_utf8(
            Command::new("git")
                .args(["-C", path, "rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        (dir, sha_2024, sha_2025)
    }

    #[test]
    fn log_between_windows_to_the_since_until_range() {
        let (dir, sha_2024, _sha_2025) = dated_history_repo();
        let path = dir.path().to_str().unwrap();
        let log = log_between(path, "2023-12-31 00:00:00", "2024-06-01 00:00:00");
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].hash, sha_2024);
    }

    #[test]
    fn log_between_is_empty_when_the_window_misses_every_commit() {
        let (dir, _sha_2024, _sha_2025) = dated_history_repo();
        let path = dir.path().to_str().unwrap();
        let log = log_between(path, "2020-01-01 00:00:00", "2020-06-01 00:00:00");
        assert!(log.is_empty());
    }

    #[test]
    fn log_between_on_a_bad_path_is_empty_not_an_error() {
        let log = log_between(
            "/no/such/repo",
            "2024-01-01 00:00:00",
            "2024-06-01 00:00:00",
        );
        assert!(log.is_empty());
    }

    /// The `" UTC"` suffix `log_between` appends to its bounds is
    /// load-bearing, and nothing else in this module can catch it: the
    /// window tests above put their commits a YEAR apart, where a few hours
    /// of timezone skew changes nothing. A real claim window is minutes
    /// long, so if the suffix were dropped git would read mesa's UTC
    /// timestamps as LOCAL time and silently return no commits — a receipt
    /// that looks like "this task changed nothing" rather than like a bug.
    ///
    /// `TZ` is set for the duration because the bounds only become
    /// ambiguous on a machine that is not already on UTC; without pinning
    /// it, this test would pass vacuously on a UTC CI box, which is exactly
    /// where the regression would then ship from. Same process-global env
    /// caveat (and same remedy: set, assert, restore in one test) as
    /// `empty_mesa_db_env_counts_as_unset` in `core::store`. Every other
    /// git test here either passes explicit offsets or goes through
    /// `log_between`'s own suffixing, so none of them reads `TZ`.
    #[test]
    fn log_between_reads_its_bounds_as_utc_not_local_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        Command::new("git")
            .args(["-C", path, "init", "-b", "trunk"])
            .stdout(Stdio::null())
            .status()
            .unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        Command::new("git")
            .args(["-C", path, "add", "-A"])
            .status()
            .unwrap();
        // Noon UTC, stated with an explicit offset so the commit's instant
        // does not itself depend on the ambient zone.
        Command::new("git")
            .args(["-C", path, "-c", "user.email=t@t", "-c", "user.name=t"])
            .args(["commit", "-m", "noon utc"])
            .env("GIT_AUTHOR_DATE", "2026-01-01T12:00:00+0000")
            .env("GIT_COMMITTER_DATE", "2026-01-01T12:00:00+0000")
            .stdout(Stdio::null())
            .status()
            .unwrap();

        let prior = std::env::var("TZ").ok();
        // UTC-5 in January: the half-hour window below straddles noon UTC,
        // but read as New York local time it becomes 16:30-17:30 UTC and
        // misses the commit entirely.
        unsafe { std::env::set_var("TZ", "America/New_York") };
        let log = log_between(path, "2026-01-01 11:30:00", "2026-01-01 12:30:00");
        match prior {
            Some(tz) => unsafe { std::env::set_var("TZ", tz) },
            None => unsafe { std::env::remove_var("TZ") },
        }

        assert_eq!(
            log.len(),
            1,
            "a UTC window around the commit must find it on a non-UTC box; \
             an empty result means the \" UTC\" suffix was dropped and git \
             read the bounds as local time",
        );
    }

    #[test]
    fn diff_stat_sums_across_commits_and_counts_distinct_files() {
        let (dir, sha_2024, sha_2025) = dated_history_repo();
        let path = dir.path().to_str().unwrap();
        // Same file (img.bin) touched by both commits must count once, not
        // twice — files_changed is distinct paths across the whole set.
        let stat = diff_stat(path, &[sha_2024.clone(), sha_2025.clone()]);
        assert_eq!(stat.files_changed, 2); // a.txt + img.bin
        assert_eq!(stat.insertions, 1); // a.txt's one added line
        assert_eq!(stat.deletions, 0);

        let one = diff_stat(path, &[sha_2024]);
        assert_eq!(one.files_changed, 2);
        assert_eq!(one.insertions, 1);
    }

    #[test]
    fn diff_stat_skips_an_invalid_sha_without_spawning_git() {
        let (dir, sha_2024, _sha_2025) = dated_history_repo();
        let path = dir.path().to_str().unwrap();
        let stat = diff_stat(path, &["; rm -rf /".to_string(), sha_2024]);
        // The bad entry contributes nothing; the valid one still counts.
        assert_eq!(stat.files_changed, 2);
    }

    #[test]
    fn diff_stat_of_no_commits_is_zero() {
        let (dir, _sha_2024, _sha_2025) = dated_history_repo();
        let path = dir.path().to_str().unwrap();
        let stat = diff_stat(path, &[]);
        assert_eq!(stat.files_changed, 0);
        assert_eq!(stat.insertions, 0);
        assert_eq!(stat.deletions, 0);
    }

    // ---- naru task 2735: paged graph log, refs, commit detail ----

    /// Runs `git -C <dir> <args>` with a fixed identity, asserts success and
    /// returns trimmed stdout.
    fn g(dir: &str, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit_file(dir: &str, name: &str, content: &str, msg: &str) -> String {
        std::fs::write(std::path::Path::new(dir).join(name), content).unwrap();
        g(dir, &["add", name]);
        g(dir, &["commit", "-m", msg]);
        g(dir, &["rev-parse", "HEAD"])
    }

    fn find<'a>(log: &'a [GitCommit], hash: &str) -> &'a GitCommit {
        log.iter().find(|c| c.hash == hash).unwrap()
    }

    /// Naru task 2736: a repo with authors, dates, paths and messages that
    /// look like flags and regexes, for the History search filters.
    fn search_repo() -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().to_str().unwrap().to_string();
        g(&p, &["init", "-q", "-b", "main"]);
        std::fs::create_dir_all(tmp.path().join("src/ui")).unwrap();
        let commit = |name: &str, msg: &str, author: &str, date: &str| {
            std::fs::write(tmp.path().join(name), msg).unwrap();
            g(&p, &["add", name]);
            let out = Command::new("git")
                .args(["-C", &p, "-c", "user.email=t@t", "-c", "user.name=t"])
                .args(["commit", "-q", "-m", msg, "--author", author])
                .env("GIT_AUTHOR_DATE", date)
                .env("GIT_COMMITTER_DATE", date)
                .output()
                .unwrap();
            assert!(out.status.success());
        };
        commit(
            "a.txt",
            "Add login page",
            "Alice Smith <a@x>",
            "2024-01-10T12:00:00",
        );
        commit(
            "src/ui/b.ts",
            "fix -x flag parsing",
            "Bob Jones <b@x>",
            "2024-02-15T12:00:00",
        );
        commit(
            "src/c.rs",
            "match .* literally",
            "Alice Smith <a@x>",
            "2024-03-20T12:00:00",
        );
        commit(
            "a.txt",
            "LOGIN redirect",
            "Carol <c@x>",
            "2024-04-25T12:00:00",
        );
        commit("x*y.txt", "star file", "Carol <c@x>", "2024-05-30T12:00:00");
        (tmp, p)
    }

    fn subjects_for(p: &str, f: LogFilter) -> Vec<String> {
        let page = commit_log_page(p, false, 0, &f);
        assert!(!page.timed_out);
        page.commits.into_iter().map(|c| c.subject).collect()
    }

    #[test]
    fn log_filter_by_message_is_fixed_string_and_case_insensitive() {
        let (_t, p) = search_repo();
        let f = |t: &str| LogFilter {
            text: Some(t.into()),
            ..Default::default()
        };
        assert_eq!(
            subjects_for(&p, f("login")),
            ["LOGIN redirect", "Add login page"]
        );
        // A value that looks like a flag is the text searched for.
        assert_eq!(subjects_for(&p, f("-x")), ["fix -x flag parsing"]);
        // Regex characters are literal: `.*` matches only the commit holding them.
        assert_eq!(subjects_for(&p, f(".*")), ["match .* literally"]);
        assert!(subjects_for(&p, f("no such words")).is_empty());
        assert_eq!(subjects_for(&p, LogFilter::default()).len(), 5);
    }

    #[test]
    fn log_filter_by_author_and_combined_with_message() {
        let (_t, p) = search_repo();
        let by = |a: &str, t: Option<&str>| LogFilter {
            author: Some(a.into()),
            text: t.map(String::from),
            ..Default::default()
        };
        assert_eq!(
            subjects_for(&p, by("alice", None)),
            ["match .* literally", "Add login page"]
        );
        // Author and message must both match.
        assert_eq!(
            subjects_for(&p, by("ALICE", Some("login"))),
            ["Add login page"]
        );
        assert!(subjects_for(&p, by("bob", Some("login"))).is_empty());
        assert!(subjects_for(&p, by(".*", None)).is_empty());
    }

    #[test]
    fn log_filter_by_path_takes_files_and_folders_literally() {
        let (_t, p) = search_repo();
        let at = |path: &str| LogFilter {
            path: Some(path.into()),
            ..Default::default()
        };
        assert_eq!(
            subjects_for(&p, at("a.txt")),
            ["LOGIN redirect", "Add login page"]
        );
        assert_eq!(
            subjects_for(&p, at("src")),
            ["match .* literally", "fix -x flag parsing"]
        );
        assert_eq!(subjects_for(&p, at("src/ui")), ["fix -x flag parsing"]);
        // `*` is a literal character, not a glob.
        assert_eq!(subjects_for(&p, at("x*y.txt")), ["star file"]);
        assert!(subjects_for(&p, at("*.txt")).is_empty());
        assert!(subjects_for(&p, at("gone/never.txt")).is_empty());
    }

    #[test]
    fn log_filter_by_date_range_is_inclusive_days() {
        let (_t, p) = search_repo();
        let range = |since: Option<&str>, until: Option<&str>| LogFilter {
            since: since.map(String::from),
            until: until.map(String::from),
            ..Default::default()
        };
        assert_eq!(
            subjects_for(&p, range(Some("2024-02-15"), Some("2024-03-20"))),
            ["match .* literally", "fix -x flag parsing"]
        );
        assert_eq!(subjects_for(&p, range(Some("2024-04-01"), None)).len(), 2);
        assert_eq!(
            subjects_for(&p, range(None, Some("2024-01-10"))),
            ["Add login page"]
        );
        assert!(subjects_for(&p, range(Some("2025-01-01"), None)).is_empty());
    }

    #[test]
    fn log_filter_pages_and_validators() {
        let (_t, p) = search_repo();
        // Paging still applies under a filter.
        let f = LogFilter {
            author: Some("carol".into()),
            ..Default::default()
        };
        let page = commit_log_page(&p, false, 1, &f);
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].subject, "LOGIN redirect");
        assert!(!page.has_more);

        assert!(valid_log_date("2024-02-29"));
        for bad in [
            "2024-2-1",
            "2024-13-01",
            "2024-01-32",
            "-2024-01-0",
            "2024/01/01",
            "yesterday",
        ] {
            assert!(!valid_log_date(bad), "{bad}");
        }
        assert_eq!(valid_log_path("./src/ui/"), Ok(Some("src/ui".into())));
        assert_eq!(valid_log_path("."), Ok(None));
        assert_eq!(valid_log_path(""), Ok(None));
        assert_eq!(valid_log_path("-x"), Ok(Some("-x".into())));
        for bad in ["/etc", "../x", "a/../b", "a//b", "a\\b", "a\nb"] {
            assert!(valid_log_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn output_within_kills_a_slow_child_and_keeps_what_it_printed() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo first; exec sleep 5"]);
        let start = Instant::now();
        let (out, ok, timed_out) = output_within(cmd, Some(Duration::from_millis(300))).unwrap();
        assert!(timed_out && !ok);
        assert!(start.elapsed() < Duration::from_secs(3));
        assert_eq!(String::from_utf8_lossy(&out), "first\n");
        let mut fast = Command::new("sh");
        fast.args(["-c", "echo done"]);
        let (out, ok, timed_out) = output_within(fast, None).unwrap();
        assert!(ok && !timed_out);
        assert_eq!(out, b"done\n");
    }

    #[test]
    fn parse_refs_reads_every_decoration_kind() {
        let r = parse_refs(
            "HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, \
             refs/heads/feat/x, refs/stash",
        );
        let got: Vec<(GitRefKind, &str, bool)> = r
            .iter()
            .map(|x| (x.kind, x.name.as_str(), x.is_head))
            .collect();
        assert_eq!(
            got,
            vec![
                (GitRefKind::Branch, "main", true),
                (GitRefKind::Tag, "v1", false),
                (GitRefKind::Remote, "origin/main", false),
                (GitRefKind::Branch, "feat/x", false),
                (GitRefKind::Other, "refs/stash", false),
            ]
        );
        let detached = parse_refs("HEAD, refs/heads/main");
        assert_eq!(detached[0].kind, GitRefKind::Head);
        assert_eq!(detached[0].name, "HEAD");
        assert!(detached[0].is_head);
        assert!(!detached[1].is_head);
        assert!(parse_refs("").is_empty());
    }

    #[test]
    fn git_commit_json_without_parents_or_refs_still_deserializes() {
        let old = r#"{"hash":"aaaaaaaa","short_hash":"aaaaaaa","author":"t","date":"2024-01-01T12:00:00Z","subject":"s"}"#;
        let c: GitCommit = serde_json::from_str(old).unwrap();
        assert!(c.parents.is_empty());
        assert!(c.refs.is_empty());
    }

    /// main: root(v1) -> m1 ; side: root -> s1 ; merge `merge` (2 parents) ;
    /// octopus `octo` (3 parents) ; plus a remote ref, a stash-like ref and a
    /// commit only reachable from branch `other`.
    struct GraphRepo {
        dir: tempfile::TempDir,
        root: String,
        merge: String,
        octo: String,
        only_other: String,
    }

    fn graph_repo() -> GraphRepo {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap().to_string();
        let p = p.as_str();
        g(p, &["init", "-b", "main"]);
        let root = commit_file(p, "base.txt", "base\n", "root");
        g(p, &["tag", "v1"]);
        g(p, &["checkout", "-b", "side"]);
        commit_file(p, "side.txt", "side\n", "side work");
        g(p, &["checkout", "main"]);
        commit_file(p, "m.txt", "m\n", "main work");
        g(p, &["merge", "--no-ff", "side", "-m", "merge side"]);
        let merge = g(p, &["rev-parse", "HEAD"]);
        for b in ["o1", "o2"] {
            g(p, &["checkout", "-b", b, "main"]);
            commit_file(p, &format!("{b}.txt"), "x\n", &format!("{b} work"));
            g(p, &["checkout", "main"]);
        }
        commit_file(p, "m2.txt", "m2\n", "main moves on");
        g(p, &["merge", "-m", "octopus", "o1", "o2"]);
        let octo = g(p, &["rev-parse", "HEAD"]);
        g(p, &["checkout", "-b", "other", "main"]);
        let only_other = commit_file(p, "other.txt", "o\n", "only on other");
        g(p, &["checkout", "main"]);
        g(p, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        g(p, &["update-ref", "refs/stash", &root]);
        GraphRepo {
            dir,
            root,
            merge,
            octo,
            only_other,
        }
    }

    #[test]
    fn log_page_carries_parents_and_every_ref_kind() {
        let r = graph_repo();
        let p = r.dir.path().to_str().unwrap();
        let (log, more) = plain_page(p, false, 0);
        assert!(!more);
        // Root has no parents; merge has two; octopus has three.
        assert!(find(&log, &r.root).parents.is_empty());
        assert_eq!(find(&log, &r.merge).parents.len(), 2);
        assert_eq!(find(&log, &r.octo).parents.len(), 3);
        // Tip: HEAD -> main plus the remote ref, both on the octopus commit.
        let tip = find(&log, &r.octo);
        assert!(tip.refs.contains(&GitRef {
            kind: GitRefKind::Branch,
            name: "main".into(),
            is_head: true
        }));
        assert!(tip.refs.contains(&GitRef {
            kind: GitRefKind::Remote,
            name: "origin/main".into(),
            is_head: false
        }));
        // Tag + other on the root commit (stash ref points at it).
        let root = find(&log, &r.root);
        assert!(root.refs.contains(&GitRef {
            kind: GitRefKind::Tag,
            name: "v1".into(),
            is_head: false
        }));
        assert!(root.refs.contains(&GitRef {
            kind: GitRefKind::Other,
            name: "refs/stash".into(),
            is_head: false
        }));
        // Receipt readers never carry refs.
        let (lines, _) = (commit_log_of(p), ());
        assert!(lines.iter().all(|c| c.refs.is_empty()));
        assert_eq!(find(&lines, &r.octo).parents.len(), 3);
    }

    #[test]
    fn log_page_all_shows_commits_only_on_another_branch() {
        let r = graph_repo();
        let p = r.dir.path().to_str().unwrap();
        let (head_only, _) = plain_page(p, false, 0);
        assert!(head_only.iter().all(|c| c.hash != r.only_other));
        let (all, _) = plain_page(p, true, 0);
        assert!(all.iter().any(|c| c.hash == r.only_other));
    }

    #[test]
    fn log_page_detached_head_and_linked_worktree_head() {
        let r = graph_repo();
        let p = r.dir.path().to_str().unwrap();
        let wt_dir = tempfile::tempdir().unwrap();
        let wt = wt_dir.path().join("wt");
        let wt = wt.to_str().unwrap();
        g(p, &["worktree", "add", "-b", "wtb", wt, &r.root]);
        // The linked worktree's own HEAD is its branch, at the root commit.
        let (log, _) = plain_page(wt, false, 0);
        assert_eq!(log.len(), 1);
        assert!(log[0].refs.contains(&GitRef {
            kind: GitRefKind::Branch,
            name: "wtb".into(),
            is_head: true
        }));
        g(wt, &["checkout", "--detach"]);
        let (log, _) = plain_page(wt, false, 0);
        assert!(log[0].refs.contains(&GitRef {
            kind: GitRefKind::Head,
            name: "HEAD".into(),
            is_head: true
        }));
    }

    #[test]
    fn log_page_unborn_head_is_empty_for_both_modes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        g(p, &["init", "-b", "main"]);
        assert_eq!(plain_page(p, false, 0), (Vec::new(), false));
        assert_eq!(plain_page(p, true, 0), (Vec::new(), false));
    }

    #[test]
    fn log_page_handles_empty_and_odd_subjects() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        g(p, &["init", "-b", "main"]);
        g(
            p,
            &["commit", "--allow-empty", "--allow-empty-message", "-m", ""],
        );
        let odd = "tab\there, \"quotes\" 'single' <b>&amp;</b> \u{1f600} ->  HEAD, tag: x";
        g(p, &["commit", "--allow-empty", "-m", odd]);
        let (log, _) = plain_page(p, false, 0);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, odd);
        assert_eq!(log[1].subject, "");
        assert!(log[1].parents.is_empty());
        assert_eq!(log[0].parents, vec![log[1].hash.clone()]);
    }

    #[test]
    fn log_pages_concatenate_to_the_full_history() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        g(p, &["init", "-b", "main"]);
        // 230 commits in one fast-import, linear.
        let mut stream = String::new();
        for i in 0..230 {
            stream.push_str(&format!(
                "commit refs/heads/main\nmark :{m}\ncommitter t <t@t> {t} +0000\ndata 2\nc{i}\n",
                m = i + 1,
                t = 1_700_000_000 + i,
                i = i % 10
            ));
            if i > 0 {
                stream.push_str(&format!("from :{i}\n"));
            }
            stream.push('\n');
        }
        let mut child = Command::new("git")
            .args(["-C", p, "fast-import", "--quiet"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(child.stdin.as_mut().unwrap(), stream.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        let full: Vec<String> = g(p, &["rev-list", "main"])
            .lines()
            .map(String::from)
            .collect();
        assert_eq!(full.len(), 230);

        let mut got = Vec::new();
        let mut skip = 0;
        let mut pages = 0;
        loop {
            let (page, more) = plain_page(p, false, skip);
            pages += 1;
            assert!(page.len() <= LOG_CAP);
            skip += page.len();
            got.extend(page.into_iter().map(|c| c.hash));
            if !more {
                break;
            }
            assert_eq!(skip % LOG_CAP, 0, "a page with more behind it is full");
        }
        assert_eq!(pages, 3);
        assert_eq!(got, full);
        // Exactly one full page: has_more must be false, not a phantom page.
        let (page, more) = plain_page(p, false, 130);
        assert_eq!((page.len(), more), (100, false));
        let (page, more) = plain_page(p, false, 0);
        assert_eq!((page.len(), more), (100, true));
        // Skipping past the end is an empty page.
        assert_eq!(plain_page(p, false, 500), (Vec::new(), false));
    }

    #[test]
    fn merge_commit_files_are_the_first_parent_diff_and_all_diffable() {
        let r = graph_repo();
        let p = r.dir.path().to_str().unwrap();
        let files = commit_files_of(p, &r.merge).unwrap();
        // main was at main work; the merge brought side.txt onto it.
        assert_eq!(files.len(), 1, "{files:?}");
        assert_eq!(files[0].path, "side.txt");
        assert_eq!(files[0].status, "A");
        assert_eq!((files[0].added, files[0].deleted), (Some(1), Some(0)));
        for f in &files {
            let d = commit_file_diff_of(p, &r.merge, &f.path).unwrap();
            assert!(d.contains("+side"), "diff was: {d}");
            assert!(!d.contains("diff --cc"));
        }
        let octo_files = commit_files_of(p, &r.octo).unwrap();
        for f in &octo_files {
            assert!(!commit_file_diff_of(p, &r.octo, &f.path).unwrap().is_empty());
        }
    }

    #[test]
    fn commit_files_carry_numstat_for_rename_and_binary() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        g(p, &["init", "-b", "main"]);
        let body: String = (0..20).map(|i| format!("line {i}\n")).collect();
        commit_file(p, "old name.txt", &body, "add");
        std::fs::write(dir.path().join("bin.dat"), [0u8, 1, 2, 0, 255, 0]).unwrap();
        g(p, &["add", "bin.dat"]);
        g(p, &["commit", "-m", "bin"]);
        g(p, &["mv", "old name.txt", "new name.txt"]);
        std::fs::write(
            dir.path().join("new name.txt"),
            format!("{body}extra\nmore\n"),
        )
        .unwrap();
        g(p, &["add", "-A"]);
        g(p, &["commit", "-m", "rename and edit"]);
        let sha = g(p, &["rev-parse", "HEAD"]);
        let files = commit_files_of(p, &sha).unwrap();
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].status.starts_with('R'));
        assert_eq!(files[0].path, "new name.txt");
        assert_eq!(files[0].orig_path.as_deref(), Some("old name.txt"));
        assert_eq!((files[0].added, files[0].deleted), (Some(2), Some(0)));
        let bin_sha = g(p, &["rev-parse", "HEAD~1"]);
        let files = commit_files_of(p, &bin_sha).unwrap();
        assert_eq!(files[0].path, "bin.dat");
        assert_eq!((files[0].added, files[0].deleted), (None, None));
    }

    #[test]
    fn parse_numstat_z_reads_rename_and_binary_entries() {
        let m = parse_numstat_z("3\t1\ta.txt\0-\t-\timg.png\u{0}2\t0\t\0old\0new\0");
        assert_eq!(m["a.txt"], (Some(3), Some(1)));
        assert_eq!(m["img.png"], (None, None));
        assert_eq!(m["new"], (Some(2), Some(0)));
        let f = parse_commit_files("M\0a.txt\0R100\0old\0new\0A\0z\0");
        assert_eq!(f.len(), 3);
        assert_eq!(f[1].orig_path.as_deref(), Some("old"));
        assert_eq!(f[1].path, "new");
    }

    #[test]
    fn commit_detail_has_multiline_body_and_handles_an_empty_message() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        g(p, &["init", "-b", "main"]);
        g(
            p,
            &[
                "commit",
                "--allow-empty",
                "-m",
                "subject line",
                "-m",
                "para one\nline two",
                "-m",
                "para two",
            ],
        );
        let sha = g(p, &["rev-parse", "HEAD"]);
        let d = commit_detail_of(p, &sha).unwrap();
        assert_eq!(d.hash, sha);
        assert!(sha.starts_with(&d.short_hash));
        assert!(d.parents.is_empty());
        assert_eq!(d.subject, "subject line");
        assert_eq!(d.body, "para one\nline two\n\npara two");
        assert_eq!((d.author.as_str(), d.author_email.as_str()), ("t", "t@t"));
        assert_eq!(d.committer_email, "t@t");
        assert!(d.author_date.contains('T'), "{}", d.author_date);
        assert!(d.committer_date.contains('T'));

        g(
            p,
            &["commit", "--allow-empty", "--allow-empty-message", "-m", ""],
        );
        let sha2 = g(p, &["rev-parse", "HEAD"]);
        let d2 = commit_detail_of(p, &sha2).unwrap();
        assert_eq!((d2.subject.as_str(), d2.body.as_str()), ("", ""));
        assert_eq!(d2.parents, vec![sha]);
    }

    #[test]
    fn commit_detail_rejects_bad_unknown_and_caps_the_body() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        g(p, &["init", "-b", "main"]);
        let big = "é".repeat(BODY_CAP);
        g(p, &["commit", "--allow-empty", "-m", "s", "-m", &big]);
        let sha = g(p, &["rev-parse", "HEAD"]);
        let d = commit_detail_of(p, &sha).unwrap();
        assert!(d.body.len() <= BODY_CAP + "\n[message truncated]".len());
        assert!(d.body.ends_with("[message truncated]"));
        assert_eq!(commit_detail_of(p, "-flag"), None);
        assert_eq!(commit_detail_of(p, "short"), None);
        assert_eq!(
            commit_detail_of(p, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
            None
        );
    }

    #[test]
    fn file_log_page_reports_has_more_truthfully() {
        let (dir, _a, _b) = synthetic_history_repo();
        let (log, more) = file_log_page(dir.path().to_str().unwrap(), "a.txt");
        assert_eq!(log.len(), 2);
        assert!(!more);
    }

    #[test]
    fn a_control_byte_in_an_author_name_does_not_shift_log_or_detail_fields() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        g(p, &["init", "-b", "main"]);
        g(p, &["commit", "--allow-empty", "-m", "first"]);
        let name = "a\u{1f}b\u{1f}c";
        let out = Command::new("git")
            .args(["-C", p, "-c", "user.email=t@t"])
            .args(["-c", &format!("user.name={name}")])
            .args([
                "commit",
                "--allow-empty",
                "-m",
                "sub\u{1f}ject",
                "-m",
                "body",
            ])
            .output()
            .unwrap();
        assert!(out.status.success());
        let first = g(p, &["rev-parse", "HEAD~1"]);
        let (log, _) = plain_page(p, false, 0);
        assert_eq!(log[0].subject, "sub\u{1f}ject");
        assert_eq!(log[0].author, name);
        assert_eq!(log[0].parents, vec![first.clone()]);
        assert!(log[0].refs.iter().any(|r| r.name == "main" && r.is_head));
        let d = commit_detail_of(p, &log[0].hash).unwrap();
        assert_eq!(d.author, name);
        assert_eq!(d.subject, "sub\u{1f}ject");
        assert_eq!(d.parents, vec![first]);
        assert_eq!(d.body, "body");
    }

    // ---- naru task 2737: branches, worktrees, stashes ----

    fn rec(f: &[&str]) -> String {
        format!("{}{BRANCH_END}", f.join("\0"))
    }

    #[test]
    fn parse_worktrees_reads_main_bare_locked_prunable_and_detached() {
        let wts = parse_worktrees(
            "worktree /r/bare.git\nbare\n\n\
             worktree /r/a\nHEAD 1111111111111111111111111111111111111111\ndetached\nlocked\n\n\
             worktree /r/b\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/b\n\
             locked on a usb stick\n\n\
             worktree /r/c\nHEAD 3333333333333333333333333333333333333333\nbranch refs/heads/c\n\
             prunable gitdir file points to non-existent location\n",
            "/r/a",
        );
        assert_eq!(wts.len(), 4);
        assert!(wts[0].is_main && wts[0].bare && wts[0].head.is_empty());
        assert!(!wts[1].is_main && wts[1].detached && wts[1].locked);
        assert_eq!(wts[1].lock_reason, None);
        assert_eq!(wts[2].lock_reason.as_deref(), Some("on a usb stick"));
        assert!(wts[3].prunable && !wts[3].locked);
        assert_eq!(
            wts[3].prunable_reason.as_deref(),
            Some("gitdir file points to non-existent location")
        );
    }

    #[test]
    fn parse_track_reads_every_form() {
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("[ahead 2, behind 3]"), (2, 3, false));
        assert_eq!(parse_track("[ahead 2]"), (2, 0, false));
        assert_eq!(parse_track("[behind 5]"), (0, 5, false));
        assert_eq!(parse_track("[gone]"), (0, 0, true));
    }

    #[test]
    fn parse_branches_fills_every_row_from_one_calls_output() {
        let h = "a".repeat(40);
        let text = [
            rec(&[
                "refs/heads/main",
                &h,
                "aaaaaaa",
                "2024-01-01T00:00:00+00:00",
                "s1",
                "origin/main",
                "[ahead 1, behind 2]",
                "*",
                "/w/main",
                "",
                "0 4",
            ]),
            rec(&[
                "refs/heads/feat/\u{e9}x",
                &h,
                "aaaaaaa",
                "2024-01-01T00:00:00+00:00",
                "s2",
                "origin/gone",
                "[gone]",
                " ",
                "",
                "",
                "3 0",
            ]),
            rec(&[
                "refs/heads/plain",
                &h,
                "aaaaaaa",
                "2024-01-01T00:00:00+00:00",
                "",
                "",
                "",
                " ",
                "",
                "",
                "0 0",
            ]),
            rec(&[
                "refs/remotes/origin/HEAD",
                &h,
                "aaaaaaa",
                "2024-01-01T00:00:00+00:00",
                "s",
                "",
                "",
                " ",
                "",
                "refs/remotes/origin/main",
                "0 0",
            ]),
            rec(&[
                "refs/remotes/up/stream/topic",
                &h,
                "aaaaaaa",
                "2024-01-01T00:00:00+00:00",
                "s3",
                "",
                "",
                " ",
                "",
                "",
                "1 0",
            ]),
        ]
        .concat();
        let rows = parse_branches(&text, &["up".into(), "up/stream".into(), "origin".into()]);
        assert_eq!(rows.len(), 4, "the origin/HEAD symref is skipped");
        for r in &rows {
            assert_eq!(r.hash.len(), 40);
            assert_eq!(r.short_hash, "aaaaaaa");
            assert!(!r.date.is_empty());
            assert!(r.merged.is_some());
        }
        assert_eq!(rows[0].ahead, Some(1));
        assert_eq!(rows[0].behind, Some(2));
        assert!(rows[0].is_head && rows[0].worktree.as_deref() == Some("/w/main"));
        assert_eq!(rows[0].merged, Some(true));
        assert!(rows[1].upstream_gone && rows[1].ahead.is_none());
        assert_eq!(rows[1].name, "feat/\u{e9}x");
        assert_eq!(rows[1].merged, Some(false));
        assert!(
            rows[2].upstream.is_none() && rows[2].ahead.is_none() && rows[2].subject.is_empty()
        );
        assert_eq!(rows[3].kind, GitBranchKind::Remote);
        assert_eq!(rows[3].name, "up/stream/topic");
        assert_eq!(rows[3].remote.as_deref(), Some("up/stream"));
        // Without the atom (old git) merged is None.
        let old = rec(&["refs/heads/m", "h", "h", "d", "s", "", "", "*", "", ""]);
        assert_eq!(parse_branches(&old, &[])[0].merged, None);
    }

    #[test]
    fn parse_stashes_reads_wip_on_named_detached_and_odd_subjects() {
        let t = "h1\0stash@{0}\0On main: keep this: ok\0d1\n\
                 h2\0stash@{1}\0WIP on feat/x: abc1234 the subject\0d2\n\
                 h3\0stash@{2}\0WIP on (no branch): abc1234 s\0d3\n\
                 h4\0stash@{3}\0custom\0d4\n";
        let s = parse_stashes(t);
        assert_eq!(s.len(), 4);
        assert_eq!((s[0].index, s[0].branch.as_deref()), (0, Some("main")));
        assert_eq!(s[0].message, "keep this: ok");
        assert_eq!(s[1].branch.as_deref(), Some("feat/x"));
        assert_eq!(s[1].message, "the subject");
        assert_eq!(s[2].branch, None);
        assert_eq!(
            (s[3].branch.clone(), s[3].message.as_str()),
            (None, "custom")
        );
    }

    fn seeded(branch: &str) -> (tempfile::TempDir, String) {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("repo");
        std::fs::create_dir_all(&p).unwrap();
        let p = p.to_str().unwrap().to_string();
        g(&p, &["init", "-q", "-b", branch]);
        g(&p, &["config", "commit.gpgsign", "false"]);
        commit_file(&p, "f.txt", "1", "seed");
        (tmp, p)
    }

    #[test]
    fn worktree_details_cover_detached_locked_prunable_and_missing_folders() {
        let (tmp, p) = seeded("main");
        let w = |n: &str| tmp.path().join(n).to_str().unwrap().to_string();
        g(&p, &["worktree", "add", "-q", &w("det"), "--detach"]);
        g(&p, &["worktree", "add", "-q", "-b", "lk", &w("lk")]);
        g(&p, &["worktree", "lock", "--reason", "on usb", &w("lk")]);
        g(&p, &["worktree", "add", "-q", "-b", "gone", &w("gone")]);
        commit_file(&w("lk"), "g.txt", "x", "on lk");
        std::fs::write(std::path::Path::new(&w("det")).join("u.txt"), "u").unwrap();
        std::fs::remove_dir_all(w("gone")).unwrap();

        let wts = worktrees_of(&p).unwrap();
        assert_eq!(wts.len(), 4);
        assert!(wts[0].is_main);
        let by = |suffix: &str| wts.iter().find(|x| x.path.ends_with(suffix)).unwrap();
        assert!(by("/det").detached && by("/det").branch.is_none());
        assert!(by("/lk").locked && by("/lk").lock_reason.as_deref() == Some("on usb"));
        assert!(by("/gone").prunable);

        let (base, details) = worktree_details_of(&p, &wts);
        assert_eq!(base.as_deref(), Some("main"));
        assert_eq!(details.len(), 4);
        let d = |suffix: &str| details.iter().find(|x| x.path.ends_with(suffix)).unwrap();
        assert_eq!(details[0].ahead, None);
        assert_eq!(details[0].subject.as_deref(), Some("seed"));
        assert_eq!(d("/det").changed, Some(1));
        assert_eq!((d("/det").ahead, d("/det").behind), (Some(0), Some(0)));
        assert_eq!((d("/lk").ahead, d("/lk").behind), (Some(1), Some(0)));
        assert_eq!(d("/lk").subject.as_deref(), Some("on lk"));
        assert!(d("/lk").date.is_some());
        // Prunable: folder gone, nothing run, no error.
        assert_eq!(d("/gone").changed, None);
        assert_eq!(d("/gone").ahead, None);
        assert_eq!(d("/gone").subject, None);
    }

    #[test]
    fn worktrees_of_a_bare_main_with_a_linked_worktree_and_an_unborn_repo() {
        let (tmp, p) = seeded("main");
        let bare = tmp.path().join("b.git").to_str().unwrap().to_string();
        g(&p, &["clone", "-q", "--bare", &p, &bare]);
        let wt = tmp.path().join("wt").to_str().unwrap().to_string();
        g(&bare, &["worktree", "add", "-q", &wt, "main"]);
        let wts = worktrees_of(&bare).unwrap();
        assert_eq!(wts.len(), 2);
        assert!(wts[0].is_main && wts[0].bare && wts[0].head.is_empty());
        let (base, details) = worktree_details_of(&bare, &wts);
        assert_eq!(base, None);
        assert_eq!(details[0].changed, None);
        assert_eq!(details[0].subject, None);
        assert_eq!(details[1].changed, Some(0));
        assert_eq!(details[1].ahead, None, "no main HEAD to compare with");
        assert_eq!(details[1].subject.as_deref(), Some("seed"));
        let br = branches_of(&bare).unwrap();
        assert!(br.iter().any(|b| b.name == "main"));

        // Unborn HEAD: nothing to list, nothing errors.
        let e = tempfile::tempdir().unwrap();
        let ep = e.path().to_str().unwrap();
        g(ep, &["init", "-q", "-b", "main"]);
        assert_eq!(branches_of(ep), Some(vec![]));
        assert_eq!(stashes_of(ep), Some(vec![]));
        let ewt = worktrees_of(ep).unwrap();
        let (b, d) = worktree_details_of(ep, &ewt);
        assert_eq!(b.as_deref(), Some("main"));
        assert_eq!(d[0].changed, Some(0));
        assert_eq!((d[0].subject.clone(), d[0].date.clone()), (None, None));
        let none = tempfile::tempdir().unwrap();
        assert_eq!(branches_of(none.path().to_str().unwrap()), None);
        assert_eq!(stashes_of(none.path().to_str().unwrap()), None);
    }

    #[test]
    fn branches_of_reads_upstreams_gone_upstreams_odd_names_and_merged() {
        let (tmp, p) = seeded("main");
        // No remotes, no upstream yet.
        let rows = branches_of(&p).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (
                rows[0].upstream.clone(),
                rows[0].ahead,
                rows[0].remote.clone()
            ),
            (None, None, None)
        );
        assert!(rows[0].is_head && rows[0].merged == Some(true));

        let remote = tmp.path().join("remote.git").to_str().unwrap().to_string();
        g(&p, &["init", "-q", "--bare", &remote]);
        g(&p, &["remote", "add", "origin", &remote]);
        g(&p, &["push", "-q", "-u", "origin", "main"]);
        g(&p, &["push", "-q", "origin", "main:gone-soon"]);
        g(
            &p,
            &["branch", "-q", "--track", "gone-soon", "origin/gone-soon"],
        );
        g(&p, &["branch", "feat/\u{e9}t\u{e9}"]);
        g(&p, &["update-ref", "refs/heads/-weird", "HEAD"]);
        commit_file(&p, "f.txt", "2", "ahead of origin");
        g(&p, &["update-ref", "-d", "refs/remotes/origin/gone-soon"]);
        let rows = branches_of(&p).unwrap();
        let get = |n: &str| rows.iter().find(|b| b.name == n).unwrap();
        assert_eq!((get("main").ahead, get("main").behind), (Some(1), Some(0)));
        assert_eq!(get("main").upstream.as_deref(), Some("origin/main"));
        assert!(get("gone-soon").upstream_gone);
        assert_eq!(get("gone-soon").ahead, None);
        assert!(get("-weird").upstream.is_none());
        assert_eq!(get("feat/\u{e9}t\u{e9}").kind, GitBranchKind::Local);
        let remote_row = get("origin/main");
        assert_eq!(remote_row.kind, GitBranchKind::Remote);
        assert_eq!(remote_row.remote.as_deref(), Some("origin"));
        assert!(
            rows.iter()
                .all(|b| b.name != "origin/HEAD" && b.name != "origin")
        );
        // origin/main is behind HEAD, so it is merged; main itself too.
        assert_eq!(remote_row.merged, Some(true));

        // `-weird` is listed, and logs by its full refname without being
        // read as a flag.
        let weird = branches_of(&p)
            .unwrap()
            .into_iter()
            .find(|b| b.name == "-weird")
            .unwrap();
        let full = branch_refname(&weird);
        assert_eq!(full, "refs/heads/-weird");
        let page = commit_log_page_for(&p, false, 0, &LogFilter::default(), Some(&full));
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].subject, "seed");
        // The filters keep working with a branch.
        let f = LogFilter {
            text: Some("nomatch".into()),
            ..Default::default()
        };
        assert!(
            commit_log_page_for(&p, false, 0, &f, Some(&full))
                .commits
                .is_empty()
        );
    }

    #[test]
    fn many_branches_come_from_one_call() {
        let (_tmp, p) = seeded("main");
        for i in 0..300 {
            g(&p, &["update-ref", &format!("refs/heads/b/{i}"), "HEAD"]);
        }
        assert_eq!(branches_of(&p).unwrap().len(), 301);
    }

    #[test]
    fn stashes_list_two_and_their_commits_are_diffable() {
        let (_tmp, p) = seeded("main");
        assert_eq!(stashes_of(&p), Some(vec![]));
        std::fs::write(std::path::Path::new(&p).join("f.txt"), "named").unwrap();
        g(&p, &["stash", "push", "-q", "-m", "msg"]);
        std::fs::write(std::path::Path::new(&p).join("f.txt"), "plain").unwrap();
        g(&p, &["stash", "push", "-q"]);
        let s = stashes_of(&p).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].index, s[0].name.as_str()), (0, "stash@{0}"));
        assert_eq!(s[0].branch.as_deref(), Some("main"));
        assert_eq!(s[0].message, "seed", "a plain WIP stash drops the sha");
        assert_eq!(s[1].message, "msg");
        assert_eq!(s[1].branch.as_deref(), Some("main"));
        assert!(!s[1].date.is_empty());
        for st in &s {
            let files = commit_files_of(&p, &st.hash).unwrap();
            assert_eq!(files.len(), 1);
            assert_eq!(files[0].path, "f.txt");
            let diff = commit_file_diff_of(&p, &st.hash, "f.txt").unwrap();
            assert!(diff.contains("+named") || diff.contains("+plain"), "{diff}");
        }
    }

    /// Benchmark-style: details for 50 linked worktrees (5 dirty). Run with
    /// `cargo test --lib worktree_details_of_50 -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn worktree_details_of_50_worktrees_wall_time() {
        let (tmp, p) = seeded("main");
        for i in 0..50 {
            let w = tmp
                .path()
                .join(format!("w{i}"))
                .to_str()
                .unwrap()
                .to_string();
            g(&p, &["worktree", "add", "-q", "-b", &format!("wb{i}"), &w]);
            if i % 10 == 0 {
                std::fs::write(std::path::Path::new(&w).join("dirty.txt"), "d").unwrap();
            }
        }
        let wts = worktrees_of(&p).unwrap();
        assert_eq!(wts.len(), 51);
        let t = Instant::now();
        let (_, details) = worktree_details_of(&p, &wts);
        println!("worktree_details_of 50 linked worktrees: {:?}", t.elapsed());
        assert_eq!(details.iter().filter(|d| d.changed == Some(1)).count(), 5);
        assert!(details.iter().all(|d| d.subject.is_some()));
    }

    #[test]
    fn a_status_that_times_out_is_none_and_does_not_fail_the_details() {
        let (_tmp, p) = seeded("main");
        assert_eq!(
            worktree_changed_within(&p, Duration::from_secs(30)),
            Some(0)
        );
        // Killed before git can answer: None, never a panic or an error.
        assert_eq!(worktree_changed_within(&p, Duration::ZERO), None);
        let wts = worktrees_of(&p).unwrap();
        let (_, details) = worktree_details_of(&p, &wts);
        assert_eq!(details.len(), 1);
        assert_eq!(details[0].subject.as_deref(), Some("seed"));
    }

    /// Counts `git` invocations through a wrapper script (the program is
    /// injected, PATH untouched): the branch listing is ONE `for-each-ref`
    /// (+ one `git remote`) whether there are 5 branches or 300.
    #[test]
    fn branch_listing_is_one_for_each_ref_regardless_of_branch_count() {
        let count = |n: usize| -> (usize, usize) {
            let (tmp, p) = seeded("main");
            for i in 0..n {
                g(&p, &["update-ref", &format!("refs/heads/b/{i}"), "HEAD"]);
            }
            let log = tmp.path().join("calls.log");
            let wrapper = tmp.path().join("counting-git");
            std::fs::write(
                &wrapper,
                format!(
                    "#!/bin/sh\necho \"$@\" >> '{}'\nexec git \"$@\"\n",
                    log.display()
                ),
            )
            .unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
            let rows = branches_with(wrapper.to_str().unwrap(), &p).unwrap();
            assert_eq!(rows.len(), n + 1);
            let calls = std::fs::read_to_string(&log).unwrap();
            let total = calls.lines().count();
            let fer = calls
                .lines()
                .filter(|l| l.contains(" for-each-ref "))
                .count();
            (fer, total)
        };
        let (fer5, total5) = count(5);
        let (fer300, total300) = count(300);
        assert_eq!((fer5, fer300), (1, 1));
        assert_eq!(total5, total300, "git calls must not grow with branches");
        assert_eq!(total5, 2, "one for-each-ref plus one `git remote`");
    }

    // --- Writes (naru task 2738), on real throwaway repos ----------------

    fn wgit(dir: &std::path::Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A repo on `trunk`; with `commit`, one commit holding `base.txt`.
    fn wrepo(commit: bool) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        wgit(d.path(), &["init", "-q", "-b", "trunk"]);
        if commit {
            std::fs::write(d.path().join("base.txt"), "base\n").unwrap();
            wgit(d.path(), &["add", "base.txt"]);
            wgit(d.path(), &["commit", "-q", "-m", "base"]);
        }
        d
    }

    fn dstr(d: &tempfile::TempDir) -> &str {
        d.path().to_str().unwrap()
    }

    /// The status as `"XY path"` lines, from `view_of`.
    fn sts(d: &tempfile::TempDir) -> Vec<String> {
        view_of(dstr(d))
            .unwrap()
            .files
            .iter()
            .map(|f| format!("{} {}", f.status, f.path))
            .collect()
    }

    /// The listed files with these exact paths, as the route would pick them.
    fn pick(d: &tempfile::TempDir, names: &[&str]) -> Vec<GitFile> {
        let all = view_of(dstr(d)).unwrap().files;
        names
            .iter()
            .map(|n| {
                all.iter()
                    .find(|f| f.path == *n)
                    .unwrap_or_else(|| panic!("{n} not in {all:?}"))
                    .clone()
            })
            .collect()
    }

    fn put(d: &tempfile::TempDir, rel: &str, text: &str) {
        let p = d.path().join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn stage_covers_modified_deleted_untracked_file_and_folder() {
        let d = wrepo(true);
        put(&d, "gone.txt", "g\n");
        wgit(d.path(), &["add", "gone.txt"]);
        wgit(d.path(), &["commit", "-q", "-m", "g"]);
        put(&d, "base.txt", "changed\n");
        std::fs::remove_file(d.path().join("gone.txt")).unwrap();
        put(&d, "new.txt", "n\n");
        put(&d, "dir/a.txt", "a\n");
        assert_eq!(
            sts(&d),
            [".M base.txt", ".D gone.txt", "?? dir/", "?? new.txt"]
        );
        let f = pick(&d, &["base.txt", "gone.txt", "dir/", "new.txt"]);
        stage(dstr(&d), &f).unwrap();
        assert_eq!(
            sts(&d),
            ["M. base.txt", "A. dir/a.txt", "D. gone.txt", "A. new.txt"]
        );
    }

    #[test]
    fn unstage_keeps_the_working_file_born_and_unborn() {
        let d = wrepo(true);
        put(&d, "base.txt", "changed\n");
        put(&d, "new.txt", "n\n");
        wgit(d.path(), &["add", "base.txt", "new.txt"]);
        let f = pick(&d, &["base.txt", "new.txt"]);
        unstage(dstr(&d), &f).unwrap();
        assert_eq!(sts(&d), [".M base.txt", "?? new.txt"]);
        assert_eq!(
            std::fs::read_to_string(d.path().join("new.txt")).unwrap(),
            "n\n"
        );

        // Unborn HEAD: `restore --staged` has no source, `rm --cached` does it.
        let u = wrepo(false);
        put(&u, "a.txt", "a\n");
        wgit(u.path(), &["add", "a.txt"]);
        assert_eq!(sts(&u), ["A. a.txt"]);
        unstage(dstr(&u), &pick(&u, &["a.txt"])).unwrap();
        assert_eq!(sts(&u), ["?? a.txt"]);
        assert_eq!(
            std::fs::read_to_string(u.path().join("a.txt")).unwrap(),
            "a\n"
        );
    }

    #[test]
    fn stage_all_and_unstage_all_use_explicit_lists_born_and_unborn() {
        for commit in [true, false] {
            let d = wrepo(commit);
            put(&d, "x.txt", "x\n");
            put(&d, "y/z.txt", "z\n");
            if commit {
                put(&d, "base.txt", "changed\n");
            }
            let files = view_of(dstr(&d)).unwrap().files;
            let eligible = eligible_for_all(WriteOp::Stage, &files);
            assert_eq!(eligible.len(), files.len());
            assert!(eligible_for_all(WriteOp::Unstage, &files).is_empty());
            stage(dstr(&d), &eligible).unwrap();
            assert!(
                sts(&d).iter().all(|l| l.starts_with(['A', 'M'])),
                "{:?}",
                sts(&d)
            );
            let files = view_of(dstr(&d)).unwrap().files;
            assert!(eligible_for_all(WriteOp::Stage, &files).is_empty());
            let staged = eligible_for_all(WriteOp::Unstage, &files);
            unstage(dstr(&d), &staged).unwrap();
            if commit {
                assert_eq!(sts(&d), [".M base.txt", "?? x.txt", "?? y/"]);
            } else {
                assert_eq!(sts(&d), ["?? x.txt", "?? y/"]);
            }
            assert!(d.path().join("x.txt").exists());
        }
    }

    #[test]
    fn discard_tracked_keeps_the_index_and_untracked_goes() {
        let d = wrepo(true);
        put(&d, "base.txt", "staged\n");
        wgit(d.path(), &["add", "base.txt"]);
        put(&d, "base.txt", "staged\nworktree\n");
        put(&d, "u.txt", "u\n");
        put(&d, "udir/inner/f.txt", "f\n");
        put(&d, "keep.txt", "k\n");
        assert_eq!(
            sts(&d),
            ["MM base.txt", "?? keep.txt", "?? u.txt", "?? udir/"]
        );
        let f = pick(&d, &["base.txt", "u.txt", "udir/"]);
        check_write(WriteOp::Discard, &f).unwrap();
        discard(dstr(&d), &f).unwrap();
        // Working tree back to the index version; the staged change survives.
        assert_eq!(sts(&d), ["M. base.txt", "?? keep.txt"]);
        assert_eq!(
            std::fs::read_to_string(d.path().join("base.txt")).unwrap(),
            "staged\n"
        );
        assert!(!d.path().join("udir").exists());
    }

    #[test]
    fn discard_restores_a_deleted_file_and_works_on_unborn_untracked() {
        let d = wrepo(true);
        std::fs::remove_file(d.path().join("base.txt")).unwrap();
        discard(dstr(&d), &pick(&d, &["base.txt"])).unwrap();
        assert!(sts(&d).is_empty());
        let u = wrepo(false);
        put(&u, "a.txt", "a\n");
        discard(dstr(&u), &pick(&u, &["a.txt"])).unwrap();
        assert!(!u.path().join("a.txt").exists());
    }

    #[test]
    fn check_write_refuses_conflicts_submodules_and_nothing_to_discard() {
        let f = |status: &str, sub: bool| GitFile {
            status: status.into(),
            path: "p".into(),
            orig_path: None,
            submodule: sub,
        };
        for op in [WriteOp::Stage, WriteOp::Unstage, WriteOp::Discard] {
            let e = check_write(op, &[f("UU", false)]).unwrap_err();
            assert!(
                e.contains("has conflicts; resolve it in the terminal"),
                "{e}"
            );
            assert!(check_write(op, &[f("AA", false)]).is_err());
            assert!(check_write(op, &[f("DU", false)]).is_err());
        }
        assert!(check_write(WriteOp::Discard, &[f(".M", true)]).is_err());
        assert!(check_write(WriteOp::Stage, &[f(".M", true)]).is_ok());
        let e = check_write(WriteOp::Discard, &[f("M.", false)]).unwrap_err();
        assert!(e.contains("nothing to discard"), "{e}");
        assert!(check_write(WriteOp::Discard, &[f("??", false)]).is_ok());
        assert!(check_write(WriteOp::Discard, &[f("MM", false)]).is_ok());
    }

    #[test]
    fn a_staged_rename_unstages_and_stages_both_sides() {
        let d = wrepo(true);
        wgit(d.path(), &["mv", "base.txt", "moved.txt"]);
        assert_eq!(sts(&d), ["R. moved.txt"]);
        let f = pick(&d, &["moved.txt"]);
        assert_eq!(f[0].orig_path.as_deref(), Some("base.txt"));
        unstage(dstr(&d), &f).unwrap();
        assert_eq!(sts(&d), [".D base.txt", "?? moved.txt"]);
        assert!(d.path().join("moved.txt").exists());
        // Stage both sides again: base.txt's deletion plus the new file.
        let both = pick(&d, &["base.txt", "moved.txt"]);
        stage(dstr(&d), &both).unwrap();
        assert_eq!(sts(&d), ["R. moved.txt"]);
        // A rename carrying an unstaged `R` (intent-to-add plus a deleted
        // source) stages its source too.
        unstage(dstr(&d), &pick(&d, &["moved.txt"])).unwrap();
        wgit(d.path(), &["add", "-N", "moved.txt"]);
        let r = pick(&d, &["moved.txt"]);
        assert_eq!(r[0].status, ".R", "{:?}", sts(&d));
        stage(dstr(&d), &r).unwrap();
        assert_eq!(sts(&d), ["R. moved.txt"]);
    }

    #[test]
    fn awkward_names_round_trip_and_globs_stay_literal() {
        let d = wrepo(true);
        let names = [
            "with space.txt",
            "dq\"uote.txt",
            "ünï-çødé.txt",
            "-leading.txt",
            "tab\tname.txt",
            "star*.txt",
        ];
        for n in names {
            put(&d, n, "x\n");
        }
        // The sibling `star*` must not match.
        put(&d, "starfish.txt", "y\n");
        for n in names {
            assert!(
                sts(&d).contains(&format!("?? {n}")),
                "{n} lost in {:?}",
                sts(&d)
            );
        }
        stage(dstr(&d), &pick(&d, &names)).unwrap();
        let st = sts(&d);
        for n in names {
            assert!(st.contains(&format!("A. {n}")), "{n} not staged: {st:?}");
        }
        assert!(st.contains(&"?? starfish.txt".to_string()), "{st:?}");
        // Unstage only the star file; the rest stay staged.
        unstage(dstr(&d), &pick(&d, &["star*.txt"])).unwrap();
        let st = sts(&d);
        assert!(st.contains(&"?? star*.txt".to_string()), "{st:?}");
        assert!(st.contains(&"A. -leading.txt".to_string()), "{st:?}");
        // Discard an untracked name with a glob; its sibling survives.
        discard(dstr(&d), &pick(&d, &["star*.txt"])).unwrap();
        assert!(!d.path().join("star*.txt").exists());
        assert!(d.path().join("starfish.txt").exists());
    }

    /// A merge of `feature` into `trunk` that conflicts on `base.txt`.
    fn conflicted() -> tempfile::TempDir {
        let d = wrepo(true);
        wgit(d.path(), &["checkout", "-q", "-b", "feature"]);
        put(&d, "base.txt", "feature\n");
        wgit(d.path(), &["commit", "-q", "-am", "f"]);
        wgit(d.path(), &["checkout", "-q", "trunk"]);
        put(&d, "base.txt", "trunk\n");
        wgit(d.path(), &["commit", "-q", "-am", "t"]);
        let out = Command::new("git")
            .args(["-C", dstr(&d), "merge", "feature"])
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(!out.status.success());
        d
    }

    #[test]
    fn a_merge_conflict_reports_its_operation_and_diffs_with_markers() {
        let d = conflicted();
        let v = view_of(dstr(&d)).unwrap();
        assert_eq!(v.operation.as_deref(), Some("merge"));
        let f = pick(&d, &["base.txt"]);
        assert_eq!(f[0].status, "UU");
        assert!(is_conflicted(&f[0]));
        for staged in [None, Some(true), Some(false)] {
            let diff = diff_of_file(dstr(&d), &f[0], "base.txt", staged).unwrap();
            assert!(diff.contains("<<<<<<<"), "{staged:?}: {diff}");
            assert!(diff.starts_with("diff --git"), "{staged:?}: {diff}");
            assert!(!diff.contains("diff --cc"), "{staged:?}: {diff}");
        }
        // stage-all must leave the conflict alone and the merge standing.
        put(&d, "other.txt", "o\n");
        let files = view_of(dstr(&d)).unwrap().files;
        let all = eligible_for_all(WriteOp::Stage, &files);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].path, "other.txt");
        stage(dstr(&d), &all).unwrap();
        assert_eq!(sts(&d), ["A. other.txt", "UU base.txt"]);
        assert!(eligible_for_all(WriteOp::Unstage, &view_of(dstr(&d)).unwrap().files).len() == 1);
        assert_eq!(
            view_of(dstr(&d)).unwrap().operation.as_deref(),
            Some("merge")
        );
    }

    #[test]
    fn a_delete_modify_conflict_still_yields_a_plain_diff_or_empty() {
        let d = wrepo(true);
        wgit(d.path(), &["checkout", "-q", "-b", "feature"]);
        wgit(d.path(), &["rm", "-q", "base.txt"]);
        wgit(d.path(), &["commit", "-q", "-m", "rm"]);
        wgit(d.path(), &["checkout", "-q", "trunk"]);
        put(&d, "base.txt", "edited\n");
        wgit(d.path(), &["commit", "-q", "-am", "edit"]);
        let _ = Command::new("git")
            .args(["-C", dstr(&d), "merge", "feature"])
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        let f = pick(&d, &["base.txt"]);
        assert_eq!(f[0].status, "UD");
        let diff = diff_of_file(dstr(&d), &f[0], "base.txt", Some(true)).unwrap();
        assert!(!diff.contains("diff --cc"), "{diff}");
    }

    #[test]
    fn diff_of_file_picks_the_side_and_is_literal() {
        let d = wrepo(true);
        put(&d, "base.txt", "staged\n");
        wgit(d.path(), &["add", "base.txt"]);
        put(&d, "base.txt", "staged\nworktree\n");
        put(&d, "new*.txt", "brand new\n");
        let f = pick(&d, &["base.txt", "new*.txt"]);
        let staged = diff_of_file(dstr(&d), &f[0], "base.txt", Some(true)).unwrap();
        assert!(
            staged.contains("+staged") && !staged.contains("+worktree"),
            "{staged}"
        );
        let unstaged = diff_of_file(dstr(&d), &f[0], "base.txt", Some(false)).unwrap();
        assert!(
            unstaged.contains("+worktree") && !unstaged.contains("-base"),
            "{unstaged}"
        );
        // Absent: staged and unstaged together, as before.
        let both = diff_of_file(dstr(&d), &f[0], "base.txt", None).unwrap();
        assert!(
            both.contains("-base") && both.contains("+worktree"),
            "{both}"
        );
        // Untracked: the all-added diff whatever `staged` says.
        for s in [None, Some(true), Some(false)] {
            let u = diff_of_file(dstr(&d), &f[1], "new*.txt", s).unwrap();
            assert!(u.contains("+brand new"), "{s:?}: {u}");
        }
        // A staged rename renders as a rename.
        let r = wrepo(true);
        wgit(r.path(), &["mv", "base.txt", "moved.txt"]);
        let f = pick(&r, &["moved.txt"]);
        let diff = diff_of_file(dstr(&r), &f[0], "moved.txt", Some(true)).unwrap();
        assert!(diff.contains("rename from base.txt"), "{diff}");
        // Unborn HEAD: the staged diff still works.
        let u = wrepo(false);
        put(&u, "a.txt", "a\n");
        wgit(u.path(), &["add", "a.txt"]);
        let f = pick(&u, &["a.txt"]);
        assert!(
            diff_of_file(dstr(&u), &f[0], "a.txt", Some(true))
                .unwrap()
                .contains("+a")
        );
    }

    #[test]
    fn a_held_index_lock_fails_with_gits_message_and_stays() {
        let d = wrepo(true);
        put(&d, "new.txt", "n\n");
        let lock = d.path().join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let e = stage(dstr(&d), &pick(&d, &["new.txt"])).unwrap_err();
        assert!(e.contains("index.lock"), "{e}");
        assert!(e.len() <= WRITE_ERR_CAP);
        assert!(lock.exists(), "the lock must never be removed");
    }

    #[test]
    fn five_thousand_files_stage_and_unstage_in_one_call_each() {
        let d = wrepo(true);
        for i in 0..5000 {
            put(&d, &format!("bulk/f{i:04}.txt"), "x\n");
        }
        let listed: Vec<GitFile> = (0..5000)
            .map(|i| GitFile {
                status: "??".into(),
                path: format!("bulk/f{i:04}.txt"),
                orig_path: None,
                submodule: false,
            })
            .collect();
        let t = Instant::now();
        stage(dstr(&d), &listed).unwrap();
        let files = view_of(dstr(&d)).unwrap().files;
        assert_eq!(files.len(), 5000);
        assert!(files.iter().all(|f| f.status == "A."));
        unstage(dstr(&d), &files).unwrap();
        assert_eq!(sts(&d), ["?? bulk/"]);
        assert!(t.elapsed() < Duration::from_secs(60), "{:?}", t.elapsed());
    }

    #[test]
    fn unstage_refuses_a_born_repo_whose_head_commit_is_missing() {
        let d = wrepo(true);
        put(&d, "base.txt", "changed\n");
        wgit(d.path(), &["add", "base.txt"]);
        let sha = String::from_utf8(
            Command::new("git")
                .args(["-C", dstr(&d), "rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let sha = sha.trim();
        let obj = d
            .path()
            .join(".git/objects")
            .join(&sha[..2])
            .join(&sha[2..]);
        std::fs::remove_file(&obj).unwrap();
        assert!(
            head_is_unborn(dstr(&d))
                .unwrap_err()
                .contains("missing commit")
        );
        let f = GitFile {
            status: "M.".into(),
            path: "base.txt".into(),
            orig_path: None,
            submodule: false,
        };
        assert!(unstage(dstr(&d), &[f]).is_err());
        // The index still holds the staged change: nothing was written.
        let st = Command::new("git")
            .args(["-C", dstr(&d), "ls-files", "-s", "base.txt"])
            .output()
            .unwrap();
        assert!(!st.stdout.is_empty());
        assert!(head_is_unborn(dstr(&wrepo(false))).unwrap());
        assert!(!head_is_unborn(dstr(&wrepo(true))).unwrap());
    }

    #[test]
    fn intent_to_add_has_nothing_to_discard_and_a_doubled_path_picks_by_op() {
        let d = wrepo(true);
        put(&d, "ita.txt", "i\n");
        wgit(d.path(), &["add", "-N", "ita.txt"]);
        let f = pick(&d, &["ita.txt"]);
        assert_eq!(f[0].status, ".A");
        assert!(
            check_write(WriteOp::Discard, &f)
                .unwrap_err()
                .contains("nothing to discard")
        );

        // `D. base.txt` (index delete) plus `?? base.txt` (re-created).
        let r = wrepo(true);
        wgit(r.path(), &["rm", "--cached", "-q", "base.txt"]);
        put(&r, "base.txt", "again\n");
        let files = view_of(dstr(&r)).unwrap().files;
        assert_eq!(files.len(), 2, "{files:?}");
        let status = |op| pick_entry(op, &files, "base.txt").unwrap().status.clone();
        assert_eq!(status(WriteOp::Discard), "??");
        assert_eq!(status(WriteOp::Stage), "??");
        assert_eq!(status(WriteOp::Unstage), "D.");
        assert!(pick_entry(WriteOp::Stage, &files, "nope").is_none());
        // Discard deletes the untracked copy and leaves the index delete.
        let d1 = pick_entry(WriteOp::Discard, &files, "base.txt")
            .unwrap()
            .clone();
        check_write(WriteOp::Discard, std::slice::from_ref(&d1)).unwrap();
        discard(dstr(&r), &[d1]).unwrap();
        assert_eq!(sts(&r), ["D. base.txt"]);
        // Unstage acts on the tracked entry: the file comes back to the index.
        put(&r, "base.txt", "again\n");
        let files = view_of(dstr(&r)).unwrap().files;
        let u = pick_entry(WriteOp::Unstage, &files, "base.txt")
            .unwrap()
            .clone();
        unstage(dstr(&r), &[u]).unwrap();
        assert_eq!(sts(&r), [".M base.txt"]);
        // Stage of the untracked copy stages the path.
        let r2 = wrepo(true);
        wgit(r2.path(), &["rm", "--cached", "-q", "base.txt"]);
        put(&r2, "base.txt", "again\n");
        let files = view_of(dstr(&r2)).unwrap().files;
        let s1 = pick_entry(WriteOp::Stage, &files, "base.txt")
            .unwrap()
            .clone();
        stage(dstr(&r2), &[s1]).unwrap();
        assert_eq!(sts(&r2), ["M. base.txt"]);
    }

    #[test]
    fn git_am_is_not_a_rebase() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("rebase-apply")).unwrap();
        assert_eq!(operation_in(d.path()), None);
        std::fs::write(d.path().join("rebase-apply/rebasing"), "").unwrap();
        assert_eq!(operation_in(d.path()).as_deref(), Some("rebase"));
        let m = tempfile::tempdir().unwrap();
        std::fs::create_dir(m.path().join("rebase-merge")).unwrap();
        assert_eq!(operation_in(m.path()).as_deref(), Some("rebase"));
    }
}
