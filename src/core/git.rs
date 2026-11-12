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
    DiffStat, GitBranch, GitBranchKind, GitCommit, GitCommitDetail, GitCommitFile, GitCommitInfo,
    GitFile, GitHeadCommit, GitRef, GitRefKind, GitRepo, GitRepoView, GitStash, GitStatus,
    GitWorktree, GitWorktreeDetail,
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
    use std::hash::Hasher;
    let mut files = Vec::new();
    let mut headers = Vec::new();
    // The staged set (naru task 2801): X, HEAD and index mode and blob, and
    // the path(s) of every entry with a staged change. Nothing of the
    // working-tree side goes in, so an unstaged edit does not move it.
    let mut staged = std::hash::DefaultHasher::new();
    let mut staged_n = 0usize;
    let mut add_staged = |f: &[&str], path: &str, orig: Option<&str>| {
        let Some(x) = f[0].get(..1).filter(|x| *x != ".") else {
            return;
        };
        staged_n += 1;
        for part in [x, f[2], f[3], f[5], f[6], path, orig.unwrap_or("")] {
            staged.write(part.as_bytes());
            staged.write(&[0]);
        }
    };
    let mut it = porcelain.split('\0');
    while let Some(rec) = it.next() {
        // '1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>'
        if let Some(rest) = rec.strip_prefix("1 ") {
            let f: Vec<&str> = rest.splitn(8, ' ').collect();
            if f.len() == 8 {
                add_staged(&f, f[7], None);
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
                add_staged(&f, f[8], orig.as_deref());
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
        staged_digest: format!("{staged_n:x}-{:016x}", staged.finish()),
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
    run_diff_bytes(dir, args, ok_codes, literal).map(|b| capped(&b))
}

/// [`run_diff_with`] before the lossy, capped text: git's stdout bytes as is,
/// for a patch that must be built from bytes.
fn run_diff_bytes(dir: &str, args: &[&str], ok_codes: &[i32], literal: bool) -> Option<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.args(["-C", dir]).args(args).stdin(Stdio::null());
    if literal {
        cmd.env("GIT_LITERAL_PATHSPECS", "1");
    }
    let out = cmd.output().ok()?;
    if !ok_codes.contains(&out.status.code()?) {
        return None;
    }
    Some(out.stdout)
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
///
/// The last two (naru task 2739) are read in a canonical form, whatever the
/// user's config: no external diff, no textconv, no colour, `a/` and `b/`
/// prefixes, three context lines. That text is what a hunk patch is built
/// from; the context is pinned because `git apply` anchors a hunk that has
/// none to the end (or start) of the file, wherever the lines match.
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
    diff_bytes_of_file(dir, file, staged).map(|b| capped(&b))
}

/// The canonical side diff of a tracked, non-conflicted file as raw bytes
/// (see [`diff_of_file`]): the input of [`hunk_digest`] and
/// [`build_partial_patch`].
pub fn diff_bytes_of_file(dir: &str, file: &GitFile, staged: bool) -> Option<Vec<u8>> {
    const CANON: [&str; 7] = [
        "diff",
        "--unified=3",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ];
    let path = file.path.as_str();
    let mut args = CANON.to_vec();
    if !staged {
        args.extend(["--", path]);
    } else if let Some(orig) = file.orig_path.as_deref() {
        args.extend(["--cached", "-M", "--", orig, path]);
    } else {
        args.extend(["--cached", "--", path]);
    }
    run_diff_bytes(dir, &args, &[0], true)
}

/// Whether a listed file can offer hunk and line operations at all: tracked,
/// not conflicted, not a submodule, not a rename. The diff text itself must
/// still pass [`hunk_digest`].
pub fn hunk_eligible_file(f: &GitFile) -> bool {
    !is_conflicted(f) && f.status != "??" && !f.submodule && f.orig_path.is_none()
}

/// [`diff_of_file`] plus the file's [`hunk_digest`] (naru task 2739): `Some`
/// only for a picked side (`staged` set) of a [`hunk_eligible_file`] whose raw
/// diff is eligible; the digest is of the raw bytes, not the capped text.
pub fn diff_and_digest(
    dir: &str,
    file: &GitFile,
    wanted: &str,
    staged: Option<bool>,
) -> Option<(String, Option<String>)> {
    match staged {
        Some(side) if hunk_eligible_file(file) => {
            let raw = diff_bytes_of_file(dir, file, side)?;
            Some((capped(&raw), hunk_digest(&raw)))
        }
        _ => diff_of_file(dir, file, wanted, staged).map(|d| (d, None)),
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

// --- Hunk and line patches (naru task 2739) ----------------------------
//
// Pure, byte-exact: a single-file diff (the canonical side diff of
// `diff_bytes_of_file`) is parsed into its header and hunks, and a patch of
// only the picked hunks or lines is written back for `git apply`. Line bytes
// (CR, invalid UTF-8) are never touched.

/// One picked hunk: its 0-based ordinal in the diff, and either the whole
/// hunk (`lines: None`) or the 0-based body-line indices inside it (context
/// and `\ No newline` lines count only as described on [`build_partial_patch`]).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct HunkPick {
    pub index: usize,
    #[serde(default)]
    pub lines: Option<Vec<usize>>,
}

/// One hunk body line: its kind byte (` `, `+`, `-`), its bytes including the
/// kind byte and the line ending, and the `\ No newline at end of file` line
/// that followed it, if any.
struct DiffLine {
    kind: u8,
    bytes: Vec<u8>,
    marker: Option<Vec<u8>>,
}

struct DiffHunk {
    old_start: i64,
    old_len: i64,
    new_start: i64,
    new_len: i64,
    /// Everything after the second `@@` (section text and the line ending).
    tail: Vec<u8>,
    lines: Vec<DiffLine>,
}

struct ParsedDiff {
    /// The `diff --git`, `---` and `+++` lines, verbatim.
    header: Vec<u8>,
    hunks: Vec<DiffHunk>,
}

/// `@@ -a[,b] +c[,d] @@tail`; a missing count is 1.
fn parse_hunk_header(line: &[u8]) -> Option<DiffHunk> {
    let rest = line.strip_prefix(b"@@ ")?;
    let at = rest.windows(3).position(|w| w == b" @@")?;
    let spec = std::str::from_utf8(&rest[..at]).ok()?;
    let (old, new) = spec.split_once(' ')?;
    let range = |s: &str, sign: char| -> Option<(i64, i64)> {
        let s = s.strip_prefix(sign)?;
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    };
    let (old_start, old_len) = range(old, '-')?;
    let (new_start, new_len) = range(new, '+')?;
    Some(DiffHunk {
        old_start,
        old_len,
        new_start,
        new_len,
        tail: rest[at + 3..].to_vec(),
        lines: Vec::new(),
    })
}

/// Header lines that make a file ineligible for hunk operations: it is
/// created, deleted, renamed, copied or binary.
const INELIGIBLE_HEADERS: [&[u8]; 6] = [
    b"new file mode",
    b"deleted file mode",
    b"rename from",
    b"copy from",
    b"Binary files",
    b"GIT binary patch",
];

fn parse_diff(diff: &[u8]) -> Result<ParsedDiff, String> {
    let bad = |why: &str| format!("this diff cannot be staged by hunk: {why}");
    let lines: Vec<&[u8]> = diff.split_inclusive(|b| *b == b'\n').collect();
    if lines.last().is_some_and(|l| !l.ends_with(b"\n")) {
        return Err(bad("it is cut short"));
    }
    if !lines.first().is_some_and(|l| l.starts_with(b"diff --git ")) {
        return Err(bad("it is not a single-file diff"));
    }
    let mut header = lines[0].to_vec();
    let (mut have_old, mut have_new) = (false, false);
    let mut hunks: Vec<DiffHunk> = Vec::new();
    for line in &lines[1..] {
        if let Some(h) = hunks.last_mut() {
            if line.starts_with(b"@@ ") {
                hunks.push(parse_hunk_header(line).ok_or_else(|| bad("a hunk header"))?);
                continue;
            }
            match line[0] {
                b' ' | b'+' | b'-' => h.lines.push(DiffLine {
                    kind: line[0],
                    bytes: line.to_vec(),
                    marker: None,
                }),
                b'\\' => match h.lines.last_mut() {
                    Some(l) if l.marker.is_none() => l.marker = Some(line.to_vec()),
                    _ => return Err(bad("a stray \"No newline\" line")),
                },
                _ => return Err(bad("an unexpected line")),
            }
            continue;
        }
        if line.starts_with(b"@@ ") {
            hunks.push(parse_hunk_header(line).ok_or_else(|| bad("a hunk header"))?);
        } else if line.starts_with(b"diff --git ") {
            return Err(bad("it holds more than one file"));
        } else if INELIGIBLE_HEADERS.iter().any(|p| line.starts_with(p)) {
            return Err(bad("the file is new, deleted, renamed, copied or binary"));
        } else if line.starts_with(b"--- ") && !have_old {
            have_old = true;
            header.extend_from_slice(line);
        } else if line.starts_with(b"+++ ") && !have_new {
            have_new = true;
            header.extend_from_slice(line);
        }
    }
    if !(have_old && have_new) || hunks.is_empty() {
        return Err(bad("it has no hunks"));
    }
    for h in &hunks {
        let count = |k: u8| h.lines.iter().filter(|l| l.kind == k).count() as i64;
        let (ctx, minus, plus) = (count(b' '), count(b'-'), count(b'+'));
        if h.old_len != ctx + minus || h.new_len != ctx + plus {
            return Err(bad("a hunk's line counts do not match its header"));
        }
    }
    Ok(ParsedDiff { header, hunks })
}

/// A staleness token for a diff: its byte length and a `DefaultHasher` hash
/// (fixed keys, so it is the same in every process of one build). It only
/// tells the client's diff from the current one; it is not a security
/// boundary. `None` when the diff is not eligible for hunk operations: longer
/// than [`DIFF_CAP`], more than one file, no hunks, a new, deleted, renamed,
/// copied or binary file, or a line the parser does not know.
pub fn hunk_digest(diff: &[u8]) -> Option<String> {
    use std::hash::Hasher;
    if diff.len() > DIFF_CAP {
        return None;
    }
    parse_diff(diff).ok()?;
    let mut h = std::hash::DefaultHasher::new();
    h.write(diff);
    Some(format!("{:x}-{:016x}", diff.len(), h.finish()))
}

/// The shape rules of a pick list, needing no diff: not empty, each hunk at
/// most once, a `lines` list not empty and without a repeat.
pub fn check_picks_shape(picks: &[HunkPick]) -> Result<(), String> {
    if picks.is_empty() {
        return Err("hunks must not be empty".into());
    }
    let mut seen = HashSet::new();
    for p in picks {
        if !seen.insert(p.index) {
            return Err(format!("hunk {} is listed twice", p.index));
        }
        if let Some(lines) = &p.lines {
            if lines.is_empty() {
                return Err(format!("hunk {}: lines must not be empty", p.index));
            }
            let mut seen_lines = HashSet::new();
            if let Some(dup) = lines.iter().find(|l| !seen_lines.insert(**l)) {
                return Err(format!("hunk {}: line {dup} is listed twice", p.index));
            }
        }
    }
    Ok(())
}

/// A patch of only the picked hunks (or only their picked lines) of one
/// file's diff, for `git apply`. A body line is a diff line starting with
/// ` `, `+` or `-`; `\ No newline` lines are not counted. `reverse` is for
/// `git apply --reverse` (unstage, discard); otherwise the patch is applied
/// forward (stage).
///
/// - Forward: an unselected `-` stays in the file, so it becomes context; an
///   unselected `+` is dropped.
/// - Reverse: the mirror: an unselected `+` becomes context, an unselected
///   `-` is dropped.
///
/// The header is the `diff --git`, `---` and `+++` lines only, so a mode
/// change is never part of it. Every `@@` line is recomputed: the counts from
/// the lines kept, and the start of the side that changes from the other
/// side's start plus the running line-count change of the hunks emitted
/// before it. Hunks come out in diff order. A line without a trailing newline
/// has to stay the last line of its side of the hunk, so half of a
/// removed/added pair around it is refused.
pub fn build_partial_patch(
    diff: &[u8],
    picks: &[HunkPick],
    reverse: bool,
) -> Result<Vec<u8>, String> {
    check_picks_shape(picks)?;
    let parsed = parse_diff(diff)?;
    let mut ordered: Vec<&HunkPick> = picks.iter().collect();
    ordered.sort_by_key(|p| p.index);
    let mut out = parsed.header.clone();
    let mut running: i64 = 0;
    for pick in ordered {
        let hunk = parsed.hunks.get(pick.index).ok_or_else(|| {
            format!(
                "hunk {} does not exist; the diff has {} hunks",
                pick.index,
                parsed.hunks.len()
            )
        })?;
        let mut selected = vec![pick.lines.is_none(); hunk.lines.len()];
        for &i in pick.lines.iter().flatten() {
            match hunk.lines.get(i) {
                None => {
                    return Err(format!(
                        "hunk {}: line {i} does not exist; the hunk has {} lines",
                        pick.index,
                        hunk.lines.len()
                    ));
                }
                Some(l) if l.kind == b' ' => {
                    return Err(format!(
                        "hunk {}: line {i} is context, not a change",
                        pick.index
                    ));
                }
                Some(_) => selected[i] = true,
            }
        }
        // The lines that stay, with the kind they now have.
        let mut kept: Vec<(u8, &DiffLine)> = Vec::new();
        for (l, sel) in hunk.lines.iter().zip(selected) {
            let kind = match (l.kind, sel, reverse) {
                (b' ', ..) | (b'-', false, false) | (b'+', false, true) => Some(b' '),
                (k, true, _) => Some(k),
                (b'-', false, true) | (b'+', false, false) => None,
                _ => None,
            };
            if let Some(k) = kind {
                kept.push((k, l));
            }
        }
        let count = |k: u8| kept.iter().filter(|(kk, _)| *kk == k).count() as i64;
        let (ctx, minus, plus) = (count(b' '), count(b'-'), count(b'+'));
        if minus + plus == 0 {
            return Err(format!("hunk {}: nothing is selected", pick.index));
        }
        for sides in [*b" -", *b" +"] {
            let side: Vec<&(u8, &DiffLine)> =
                kept.iter().filter(|(k, _)| sides.contains(k)).collect();
            let last = side.len().saturating_sub(1);
            if side
                .iter()
                .enumerate()
                .any(|(i, (_, l))| l.marker.is_some() && i != last)
            {
                return Err("the last line has no trailing newline: select its removed and added lines together".into());
            }
        }
        let (old_len, new_len) = (ctx + minus, ctx + plus);
        // Where the first line of each side sits (a side with no lines is
        // printed as the line before, so its position is start + 1).
        let old_pos = if hunk.old_len == 0 {
            hunk.old_start + 1
        } else {
            hunk.old_start
        };
        let new_pos = if hunk.new_len == 0 {
            hunk.new_start + 1
        } else {
            hunk.new_start
        };
        let (old_pos, new_pos) = if reverse {
            (new_pos - running, new_pos)
        } else {
            (old_pos, old_pos + running)
        };
        let start = |pos: i64, len: i64| if len == 0 { pos - 1 } else { pos };
        out.extend_from_slice(
            format!(
                "@@ -{},{} +{},{} @@",
                start(old_pos, old_len),
                old_len,
                start(new_pos, new_len),
                new_len
            )
            .as_bytes(),
        );
        out.extend_from_slice(&hunk.tail);
        for (k, l) in kept {
            out.push(k);
            out.extend_from_slice(&l.bytes[1..]);
            if let Some(m) = &l.marker {
                out.extend_from_slice(m);
            }
        }
        running += new_len - old_len;
    }
    Ok(out)
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

/// Applies a patch from [`build_partial_patch`] with one `git apply` on stdin
/// (naru task 2739): stage `--cached`, unstage `--cached --reverse`, discard
/// `--reverse` on the working tree. `Err` is git's own stderr; never retried,
/// and `index.lock` is never touched.
pub fn apply_hunks(dir: &str, op: WriteOp, patch: Vec<u8>) -> Result<(), String> {
    let args: &[&str] = match op {
        WriteOp::Stage => &["apply", "--cached", "--whitespace=nowarn", "-"],
        WriteOp::Unstage => &["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
        WriteOp::Discard => &["apply", "--reverse", "--whitespace=nowarn", "-"],
    };
    run_write(dir, args, Some(patch))
}

// ---- Commit and amend (naru task 2740) ------------------------------------
//
// `git commit` runs the repo's hooks and may call gpg, so it is not a
// `run_write`: stdout AND stderr are captured, it has a timeout, and it is the
// one write that must NOT set `GIT_LITERAL_PATHSPECS` (a hook's own git
// pathspecs inherit the environment). The message goes in on stdin, never argv.

/// Cap on the output a failed commit carries (a hook can be chatty).
const COMMIT_ERR_CAP: usize = 64 * 1024;

/// How long a commit may run (hooks, gpg) before its process group is stopped.
const COMMIT_TIMEOUT: Duration = Duration::from_secs(120);

/// How long a TERMed commit gets to clean up (git removes its own lock
/// files) before git itself is killed, and how long the pipe readers get to
/// finish once the child is gone.
const COMMIT_GRACE: Duration = Duration::from_secs(2);

/// The text `git commit -F -` is fed, or `None` when nothing is left:
/// `\r\n` becomes `\n`, leading blank lines go, trailing whitespace of the
/// whole text goes, and exactly one `\n` ends it. Nothing else changes: a `#`
/// line is ordinary text (the commit runs with `--cleanup=verbatim`), inner
/// whitespace, unicode and a leading `-` survive.
pub fn normalize_commit_message(raw: &str) -> Option<String> {
    let text = raw.replace("\r\n", "\n");
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        if !line.trim().is_empty() {
            break;
        }
        start += line.len();
    }
    let body = text[start..].trim_end();
    if body.is_empty() {
        return None;
    }
    Some(format!("{body}\n"))
}

/// True when some file has a staged change (what a non-amend commit records).
pub fn any_staged(files: &[GitFile]) -> bool {
    files.iter().any(has_staged)
}

/// `git commit` of the index with `message` (already normalised); `amend`
/// replaces HEAD. See [`commit_within`].
pub fn commit(dir: &str, message: &str, amend: bool) -> Result<(), String> {
    commit_within(dir, message, amend, COMMIT_TIMEOUT)
}

/// `git -C <dir> commit --cleanup=verbatim -F - [--amend]`, message on stdin.
/// Hooks run normally (no `--no-verify`), nothing is allowed empty, no
/// pathspec. Runs through [`run_bounded`], whose doc has the timeout, output
/// and process-group rules.
fn commit_within(dir: &str, message: &str, amend: bool, timeout: Duration) -> Result<(), String> {
    let mut args = vec!["commit", "--cleanup=verbatim", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    run_bounded(
        dir,
        &args,
        Some(message.as_bytes()),
        &[],
        timeout,
        "git commit",
    )
}

/// The one bounded, output-capturing git write (commit and the branch/stash
/// writes of naru task 2741): `git -C <dir> <args>`, optional `stdin` fed from
/// a thread, `GIT_TERMINAL_PROMPT=0` plus `env`, and NOT
/// `GIT_LITERAL_PATHSPECS` (hooks inherit the environment). The child leads
/// its own process group: past `timeout` the group is sent TERM (git removes
/// its lock files); if git is still running after [`COMMIT_GRACE`] the group is
/// KILLed; if git exited in time nothing more is signalled, so a hook child
/// that ignores TERM may linger. `Err` is git's stderr then stdout (hooks and
/// `stash pop` print to either), lossy UTF-8, trimmed, the last
/// [`COMMIT_ERR_CAP`] bytes kept. `label` names the command in the timeout and
/// empty-output messages. Never retried; `index.lock` is never touched.
fn run_bounded(
    dir: &str,
    args: &[&str],
    stdin: Option<&[u8]>,
    env: &[(&str, &str)],
    timeout: Duration,
    label: &str,
) -> Result<(), String> {
    use std::io::Write;
    use std::sync::{Arc, Mutex, mpsc};
    let mut cmd = Command::new("git");
    cmd.args(["-C", dir]).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    crate::core::proc::isolate(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not run git: {e}"))?;
    if let (Some(mut pipe), Some(data)) = (child.stdin.take(), stdin) {
        let data = data.to_vec();
        // A thread, so a git that fills a pipe first cannot deadlock us; a
        // git that exits early just closes the pipe.
        std::thread::spawn(move || {
            let _ = pipe.write_all(&data);
        });
    }
    // Each pipe is drained on a thread into a shared buffer that keeps the
    // LAST COMMIT_ERR_CAP bytes (a hook's real failure line is at the end)
    // and flags that it dropped some; it signals when the pipe is done.
    let drain = |mut pipe: Box<dyn Read + Send>| {
        let buf = Arc::new(Mutex::new((Vec::<u8>::new(), false)));
        let (tx, rx) = mpsc::channel::<()>();
        let shared = buf.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut b = shared.lock().unwrap();
                b.0.extend_from_slice(&chunk[..n]);
                if b.0.len() > COMMIT_ERR_CAP {
                    let excess = b.0.len() - COMMIT_ERR_CAP;
                    b.0.drain(..excess);
                    b.1 = true;
                }
            }
            let _ = tx.send(());
        });
        (buf, rx)
    };
    let (err_buf, err_done) = drain(Box::new(child.stderr.take().unwrap()));
    let (out_buf, out_done) = drain(Box::new(child.stdout.take().unwrap()));
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                let pgid = i64::from(child.id());
                crate::core::proc::signal_group(pgid, "TERM");
                let grace = Instant::now() + COMMIT_GRACE;
                let exited = loop {
                    match child.try_wait() {
                        Ok(Some(s)) => break Some(s),
                        Ok(None) if Instant::now() < grace => {
                            std::thread::sleep(Duration::from_millis(20))
                        }
                        _ => break None,
                    }
                };
                if exited.is_none() {
                    // The leader is not yet reaped, so its pid (the group id)
                    // cannot have been reused: the group KILL is safe here,
                    // and only here.
                    crate::core::proc::signal_group(pgid, "KILL");
                    let _ = child.kill();
                    let _ = child.wait();
                }
                break exited;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    // A descendant that left the group can hold a pipe open: wait a bounded
    // time and keep whatever was read.
    let _ = err_done.recv_timeout(COMMIT_GRACE);
    let _ = out_done.recv_timeout(COMMIT_GRACE);
    if !timed_out && status.is_some_and(|s| s.success()) {
        return Ok(());
    }
    let mut truncated = false;
    let mut text = |b: &Arc<Mutex<(Vec<u8>, bool)>>| {
        let b = b.lock().unwrap();
        let t = String::from_utf8_lossy(&b.0).to_string();
        if b.1 {
            truncated = true;
            // The cut may have split a character at the front.
            return t.trim_start_matches('\u{FFFD}').to_string();
        }
        t
    };
    let (e, o) = (text(&err_buf), text(&out_buf));
    let mut out = [e, o]
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if out.len() > COMMIT_ERR_CAP {
        let cut = (out.len() - COMMIT_ERR_CAP..=out.len()).find(|i| out.is_char_boundary(*i));
        out = out[cut.unwrap_or(out.len())..].to_string();
        truncated = true;
    }
    if truncated {
        out = format!("[output truncated]\n{out}");
    }
    if timed_out {
        let head = format!(
            "{label} did not finish within {} s and was stopped. Nothing was retried.",
            timeout.as_secs()
        );
        return Err(if out.is_empty() {
            head
        } else {
            format!("{head}\n{out}")
        });
    }
    if out.is_empty() {
        return Err(match status {
            Some(s) => format!("{label} failed ({s})"),
            None => format!("{label} failed"),
        });
    }
    Err(out)
}

// ---- Branch and stash writes (naru task 2741) -----------------------------
//
// Eight writes: create, switch, rename and delete a branch; push, apply, pop
// and drop a stash. Every existing branch name is a byte-equal member of a
// FRESH `branches_of`, never a client string, and an existing name beginning
// with `-` is refused, so nothing handed to git can be read as a flag. A write
// acts only in the directory it is given (a worktree). Never a push, pull,
// fetch, merge, rebase, reset, forced checkout or forced switch; never a retry;
// `index.lock` is never touched.

/// Why a branch or stash write did not run, or did not succeed. The API maps
/// `Validation` to 422, `NotFound` to 404 and `Conflict` to 409; the first two
/// mean no git write was attempted.
#[derive(Debug, Clone, PartialEq)]
pub enum RefErr {
    Validation(String),
    NotFound(String),
    Conflict(String),
}

fn rv(message: impl Into<String>) -> RefErr {
    RefErr::Validation(message.into())
}

/// Environment for these writes on top of `GIT_TERMINAL_PROMPT=0`: `LC_ALL=C`
/// pins git's wording (the "not fully merged" refusal is matched by text).
/// `GIT_LITERAL_PATHSPECS` is deliberately NOT set: `switch` runs post-checkout
/// hooks, which inherit the environment.
const REF_WRITE_ENV: &[(&str, &str)] = &[("LC_ALL", "C")];

/// The one place a branch or stash write spawns git: [`run_bounded`] (stdout
/// and stderr both captured, 120 s timeout over the whole process group), so a
/// `stash pop` conflict printed on stdout reaches the error text and a hung
/// hook cannot hang the request. `Err` is git's stderr then stdout, trimmed.
pub fn run_ref_write(dir: &str, args: &[&str]) -> Result<(), String> {
    run_ref_write_within(dir, args, COMMIT_TIMEOUT)
}

fn run_ref_write_within(dir: &str, args: &[&str], timeout: Duration) -> Result<(), String> {
    let label = format!("git {}", args.first().copied().unwrap_or(""));
    run_bounded(dir, args, None, REF_WRITE_ENV, timeout, &label)
}

fn fresh_branches(dir: &str) -> Result<Vec<GitBranch>, RefErr> {
    branches_of(dir).ok_or_else(|| RefErr::NotFound(format!("not a git repo: {dir}")))
}

/// The local branch row named `name`, byte-equal; 404 when absent, 422 when its
/// name begins with `-`.
fn local_row<'a>(rows: &'a [GitBranch], name: &str) -> Result<&'a GitBranch, RefErr> {
    let row = rows
        .iter()
        .find(|b| b.kind == GitBranchKind::Local && b.name == name)
        .ok_or_else(|| RefErr::NotFound(format!("branch not found: {name}")))?;
    if name.starts_with('-') {
        return Err(rv(format!(
            "{name} begins with '-'; rename it in the terminal"
        )));
    }
    Ok(row)
}

/// Where another worktree has the row checked out (`is_head` is this one).
fn held_elsewhere(b: &GitBranch) -> Option<&str> {
    b.worktree.as_deref().filter(|_| !b.is_head)
}

/// 422 while a merge, rebase, cherry-pick or revert is in progress in `dir`.
fn refuse_in_operation(dir: &str, action: &str) -> Result<(), RefErr> {
    let view = view_of(dir).ok_or_else(|| RefErr::NotFound(format!("not a git repo: {dir}")))?;
    match view.operation {
        Some(op) => Err(rv(format!(
            "A {op} is in progress in this worktree; {action} is not available. Finish or abort it in the terminal."
        ))),
        None => Ok(()),
    }
}

/// A name `git branch` could create: not empty, at most 255 bytes, no leading
/// `-`, no control character, `git check-ref-format --branch` exits 0 AND
/// prints the input back unchanged (it expands `@{-1}` and friends; an
/// expansion is a refusal), and neither a local branch nor a tag of that name
/// exists. Unicode and `/` are fine.
pub fn valid_new_branch_name(dir: &str, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("branch name is empty".into());
    }
    if name.len() > 255 {
        return Err("branch name is longer than 255 bytes".into());
    }
    if name.starts_with('-') {
        return Err(format!(
            "{name} is not a valid branch name: it begins with '-'"
        ));
    }
    if name == "@" || name.chars().any(char::is_control) {
        return Err(format!("{name:?} is not a valid branch name"));
    }
    match probe(dir, &["check-ref-format", "--branch", name]) {
        Some((0, out)) if out == name => {}
        _ => return Err(format!("{name} is not a valid branch name")),
    }
    let rows = branches_of(dir).ok_or_else(|| format!("not a git repo: {dir}"))?;
    if rows
        .iter()
        .any(|b| b.kind == GitBranchKind::Local && b.name == name)
    {
        return Err(format!("a branch named {name} already exists"));
    }
    let tag = format!("refs/tags/{name}");
    if probe(dir, &["show-ref", "--verify", "-q", &tag]).is_some_and(|(c, _)| c == 0) {
        return Err(format!("a tag named {name} already exists"));
    }
    Ok(())
}

/// `refs/stash`'s tip and the number of stash entries (shared by every
/// worktree of the repo).
fn stash_state(dir: &str) -> (Option<String>, usize) {
    (
        read_git_line(dir, &["rev-parse", "--verify", "-q", "refs/stash"]),
        stashes_of(dir).map_or(0, |s| s.len()),
    )
}

/// True when the stash list moved since `before` AND the newest entry is ours:
/// its first parent is this worktree's HEAD and, with `marker`, its message
/// carries it. A sibling worktree stashing at the same moment is not mistaken
/// for us unless it sits on the very same HEAD commit (and, for a push without
/// a marker, that residual window remains).
fn own_stash_made(dir: &str, before: &(Option<String>, usize), marker: Option<&str>) -> bool {
    let after = stash_state(dir);
    if after == *before {
        return false;
    }
    let Some(newest) = stashes_of(dir).and_then(|l| l.into_iter().next()) else {
        return false;
    };
    let parent = read_git_line(
        dir,
        &["rev-parse", "--verify", "-q", &format!("{}^1", newest.hash)],
    );
    let head = head_of(dir).map(|h| h.0);
    parent.is_some() && parent == head && marker.is_none_or(|m| newest.message.contains(m))
}

/// A failed `git stash push` can still have saved its entry (its cleanup step
/// failed after the commit was made): say so, so the work is never invisible.
fn saved_note(err: String, saved: bool) -> String {
    if saved {
        format!("{err}\nA stash entry was saved (stash@{{0}}); your changes are in it.")
    } else {
        err
    }
}

/// `git branch <name> [<start>]`, or with `switch` one `git switch -c <name>
/// [<start>]` (one call, so a refused switch creates nothing). The start is the
/// worktree's HEAD, `from_commit` (a hash that must resolve to a commit; git
/// gets the FULL hash), or `from_remote` (byte-equal to a remote-tracking row of
/// a fresh listing; git gets `refs/remotes/<name>`). Neither `--track` nor
/// `--no-track` is passed, so git's own defaults apply (tracking config only).
pub fn create_branch(
    dir: &str,
    name: &str,
    from_commit: Option<&str>,
    from_remote: Option<&str>,
    switch: bool,
) -> Result<Option<String>, RefErr> {
    if from_commit.is_some() && from_remote.is_some() {
        return Err(rv("give at most one of from_commit and from_remote"));
    }
    if let Some(c) = from_commit
        && !is_full_hash(c)
    {
        return Err(rv("from_commit must be a full lowercase commit hash"));
    }
    valid_new_branch_name(dir, name).map_err(rv)?;
    let start = if let Some(c) = from_commit {
        let spec = format!("{c}^{{commit}}");
        let full = read_git_line(dir, &["rev-parse", "--verify", "-q", &spec])
            .ok_or_else(|| RefErr::NotFound(format!("commit not found: {c}")))?;
        Some(full)
    } else if let Some(r) = from_remote {
        let rows = fresh_branches(dir)?;
        if !rows
            .iter()
            .any(|b| b.kind == GitBranchKind::Remote && b.name == r)
        {
            return Err(RefErr::NotFound(format!("remote branch not found: {r}")));
        }
        Some(format!("refs/remotes/{r}"))
    } else {
        None
    };
    if switch {
        refuse_in_operation(dir, "switching branches")?;
    }
    let mut args = if switch {
        vec!["switch", "-c", name]
    } else {
        vec!["branch", name]
    };
    if let Some(s) = start.as_deref() {
        args.push(s);
    }
    run_ref_write(dir, &args).map_err(RefErr::Conflict)?;
    Ok(None)
}

/// `git switch --no-guess <name>` in `dir`, never forced. With `stash`, first
/// `git stash push --include-untracked -m "naru: before switching to <name>"`;
/// when that really made an entry and the switch then fails, the error says so
/// and that nothing was restored.
pub fn switch_branch(dir: &str, name: &str, stash: bool) -> Result<Option<String>, RefErr> {
    let rows = fresh_branches(dir)?;
    let row = local_row(&rows, name)?;
    if row.is_head {
        return Err(rv(format!("already on {name}")));
    }
    if let Some(path) = held_elsewhere(row) {
        return Err(rv(format!("{name} is checked out in {path}")));
    }
    refuse_in_operation(dir, "switching branches")?;
    let mut stashed = false;
    if stash {
        let before = stash_state(dir);
        let message = format!("naru: before switching to {name}");
        let pushed = run_ref_write(
            dir,
            &["stash", "push", "--include-untracked", "-m", &message, "--"],
        );
        stashed = own_stash_made(dir, &before, Some(&message));
        if let Err(e) = pushed {
            return Err(RefErr::Conflict(saved_note(e, stashed)));
        }
    }
    match run_ref_write(dir, &["switch", "--no-guess", name]) {
        Ok(()) => Ok(stashed.then(|| "Stashed your changes as stash@{0} before switching.".into())),
        Err(e) if stashed => Err(RefErr::Conflict(format!(
            "Your changes were stashed (stash@{{0}}) and were NOT restored; the switch failed: {e}"
        ))),
        Err(e) => Err(RefErr::Conflict(e)),
    }
}

/// `git branch -m <name> <new_name>`; refused while another worktree has
/// `name` checked out. This worktree's own current branch may be renamed.
pub fn rename_branch(dir: &str, name: &str, new_name: &str) -> Result<Option<String>, RefErr> {
    let rows = fresh_branches(dir)?;
    let row = local_row(&rows, name)?;
    if let Some(path) = held_elsewhere(row) {
        return Err(rv(format!("{name} is checked out in {path}")));
    }
    valid_new_branch_name(dir, new_name).map_err(rv)?;
    run_ref_write(dir, &["branch", "-m", name, new_name]).map_err(RefErr::Conflict)?;
    Ok(None)
}

/// What [`delete_branch`] found; the API adds the fresh view.
#[derive(Debug, Clone, PartialEq)]
pub struct DeleteOutcome {
    pub deleted: bool,
    pub refusal: Option<String>,
    pub hash: String,
    pub unmerged: Vec<GitCommit>,
    pub unmerged_more: bool,
}

/// At most this many unmerged commits are listed on a refusal.
const UNMERGED_CAP: usize = 50;

/// True for exactly 40 or 64 lowercase hex digits.
pub fn is_full_hash(h: &str) -> bool {
    matches!(h.len(), 40 | 64) && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Commits reachable from `refs/heads/<name>` and from no other ref (nor any
/// worktree's HEAD): `git log <branch> --not --exclude=<branch> --all`.
fn unmerged_of(dir: &str, name: &str) -> (Vec<GitCommit>, bool) {
    let full = format!("refs/heads/{name}");
    let extra = [
        full.clone(),
        "--not".to_string(),
        format!("--exclude={full}"),
        "--all".to_string(),
    ];
    let mut commits = run_log(dir, None, &extra, UNMERGED_CAP + 1, true);
    let more = commits.len() > UNMERGED_CAP;
    commits.truncate(UNMERGED_CAP);
    (commits, more)
}

/// Deletes the local branch `name`. Without `force`: `git branch -d`; when git
/// refuses as "not fully merged" that is NOT an error: the outcome carries its
/// text, the tip hash and the commits only this branch holds. With `force`:
/// `expected_hash` (a full hash) must equal the branch's current tip, else
/// 409 and nothing is deleted; then `git branch -D`. A branch checked out in
/// any worktree is refused.
pub fn delete_branch(
    dir: &str,
    name: &str,
    force: bool,
    expected_hash: Option<&str>,
) -> Result<DeleteOutcome, RefErr> {
    if force && !expected_hash.is_some_and(is_full_hash) {
        return Err(rv("expected_hash must be a full lowercase commit hash"));
    }
    let rows = fresh_branches(dir)?;
    let row = local_row(&rows, name)?;
    if row.is_head {
        return Err(rv(format!("{name} is the current branch of this worktree")));
    }
    if let Some(path) = held_elsewhere(row) {
        return Err(rv(format!("{name} is checked out in {path}")));
    }
    let tip = read_git_line(
        dir,
        &["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")],
    )
    .unwrap_or_else(|| row.hash.clone());
    let deleted = |hash: String| DeleteOutcome {
        deleted: true,
        refusal: None,
        hash,
        unmerged: Vec::new(),
        unmerged_more: false,
    };
    if force {
        if expected_hash != Some(tip.as_str()) {
            return Err(RefErr::Conflict(format!(
                "{name} moved since the delete was confirmed. It was reloaded; nothing was deleted."
            )));
        }
        run_ref_write(dir, &["branch", "-D", name]).map_err(RefErr::Conflict)?;
        return Ok(deleted(tip));
    }
    match run_ref_write(dir, &["branch", "-d", name]) {
        Ok(()) => Ok(deleted(tip)),
        Err(e) if e.contains("not fully merged") => {
            let (unmerged, unmerged_more) = unmerged_of(dir, name);
            Ok(DeleteOutcome {
                deleted: false,
                refusal: Some(e),
                hash: tip,
                unmerged,
                unmerged_more,
            })
        }
        Err(e) => Err(RefErr::Conflict(e)),
    }
}

/// A stash message the UI may send: trimmed, blank = none, one line of at most
/// 200 bytes without control characters.
pub fn check_stash_message(raw: &str) -> Result<Option<String>, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.chars().any(char::is_control) {
        return Err("stash message must be one line without control characters".into());
    }
    if t.len() > 200 {
        return Err("stash message is longer than 200 bytes".into());
    }
    Ok(Some(t.to_string()))
}

/// `git stash push [--include-untracked] [-m <message>] --`. `Some(notice)`
/// when git had nothing to stash (no new entry). `message` came through
/// [`check_stash_message`].
pub fn stash_push(
    dir: &str,
    message: Option<&str>,
    include_untracked: bool,
) -> Result<Option<String>, RefErr> {
    refuse_in_operation(dir, "stashing")?;
    let before = stash_state(dir);
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if let Some(m) = message {
        args.extend(["-m", m]);
    }
    args.push("--");
    if let Err(e) = run_ref_write(dir, &args) {
        let saved = own_stash_made(dir, &before, None);
        return Err(RefErr::Conflict(saved_note(e, saved)));
    }
    Ok((!own_stash_made(dir, &before, None)).then(|| "No local changes to stash.".into()))
}

/// Which stash command [`stash_entry_op`] runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StashOp {
    Apply,
    Pop,
    Drop,
}

/// Current `stash@{N}` name of the entry whose commit is `hash`, re-listed now.
fn stash_name_of(dir: &str, hash: &str) -> Option<String> {
    stashes_of(dir)?
        .into_iter()
        .find(|s| s.hash == hash)
        .map(|s| s.name)
}

/// `git stash apply|pop|drop` of the entry shown as `index` with `hash`. A
/// fresh list must hold that entry (404) with that hash (else 409, nothing
/// run). Git is then handed the stash COMMIT hash, never a position, because
/// the list is shared by every worktree and a sibling's push shifts indexes:
/// apply is `git stash apply <hash>`; pop is that apply and, only on success,
/// a re-list and a drop of the entry now carrying that hash (gone = Ok with a
/// notice, nothing else dropped; a failing drop is a notice too, the apply
/// stands); drop re-lists right before the spawn and maps the hash to its
/// current index (gone = 409 "nothing was dropped"). Between that last re-list
/// and the spawn there remains a window of one process start. Apply and pop act
/// on `dir`'s worktree, without `--index`, and are refused while an operation
/// is in progress; drop is allowed. A conflicting apply/pop is the 409 carrying
/// git's text (it prints on stdout); the stash is kept.
pub fn stash_entry_op(
    dir: &str,
    op: StashOp,
    index: u32,
    hash: &str,
) -> Result<Option<String>, RefErr> {
    let (done, action) = match op {
        StashOp::Apply => ("applied", "applying a stash"),
        StashOp::Pop => ("applied", "popping a stash"),
        StashOp::Drop => ("dropped", ""),
    };
    if op != StashOp::Drop {
        refuse_in_operation(dir, action)?;
    }
    let stashes =
        stashes_of(dir).ok_or_else(|| RefErr::NotFound(format!("not a git repo: {dir}")))?;
    let entry = stashes
        .iter()
        .find(|s| s.index == index)
        .ok_or_else(|| RefErr::NotFound(format!("stash not found: stash@{{{index}}}")))?;
    if entry.hash != hash {
        return Err(RefErr::Conflict(format!(
            "The stash list changed since it was shown. It was reloaded; nothing was {done}."
        )));
    }
    let drop_by_hash = |dir: &str| -> Option<Result<(), String>> {
        let name = stash_name_of(dir, hash)?;
        Some(run_ref_write(dir, &["stash", "drop", &name]))
    };
    match op {
        StashOp::Apply => run_ref_write(dir, &["stash", "apply", hash])
            .map(|()| None)
            .map_err(RefErr::Conflict),
        StashOp::Pop => {
            run_ref_write(dir, &["stash", "apply", hash]).map_err(RefErr::Conflict)?;
            Ok(match drop_by_hash(dir) {
                Some(Ok(())) => None,
                Some(Err(e)) => Some(format!(
                    "The stash was applied but could not be dropped, so it was kept: {e}"
                )),
                None => Some(
                    "The stash was applied. It was no longer in the list, so nothing was dropped."
                        .into(),
                ),
            })
        }
        StashOp::Drop => match drop_by_hash(dir) {
            Some(r) => r.map(|()| None).map_err(RefErr::Conflict),
            None => Err(RefErr::Conflict(
                "The stash list changed since it was shown. It was reloaded; nothing was dropped."
                    .into(),
            )),
        },
    }
}

/// `git <args>` read-only in `dir`: exit code and raw stdout. Optional locks
/// off (a read never takes the index lock), stdin null, stderr dropped.
fn read_git(dir: &str, args: &[&str]) -> Option<(i32, Vec<u8>)> {
    let out = Command::new("git")
        .args(["-C", dir])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Some((out.status.code()?, out.stdout))
}

/// [`read_git`] that answers only on exit 0, trimmed, non-empty.
fn read_git_line(dir: &str, args: &[&str]) -> Option<String> {
    let (code, out) = read_git(dir, args)?;
    let s = String::from_utf8_lossy(&out).trim().to_string();
    (code == 0 && !s.is_empty()).then_some(s)
}

/// HEAD's full and short hash, `None` on an unborn or unreadable HEAD.
pub fn head_of(dir: &str) -> Option<(String, String)> {
    let full = read_git_line(dir, &["rev-parse", "--verify", "-q", "HEAD^{commit}"])?;
    let short = read_git_line(dir, &["rev-parse", "--short", &full])?;
    Some((full, short))
}

/// What the commit box needs from `dir`'s worktree; `None` when it is not a
/// repo. Every read is best-effort and never panics: an unreadable HEAD is
/// "not unborn" with no `head`; a failed upstream, identity or MERGE_MSG read
/// is `None`. Nothing is cached and nothing is written.
pub fn commit_info_of(dir: &str) -> Option<GitCommitInfo> {
    let git_dir = read_git_line(dir, &["rev-parse", "--absolute-git-dir"])?;
    let branch = read_git_line(dir, &["symbolic-ref", "-q", "--short", "HEAD"]);
    let unborn = head_is_unborn(dir).unwrap_or(false);
    let head = if unborn {
        None
    } else {
        // `-z`: the record ends in NUL, so `%B` is exactly the message.
        read_git(
            dir,
            &[
                "log",
                "-z",
                "-n",
                "1",
                "--no-show-signature",
                "--format=%H%x00%h%x00%P%x00%B",
                "HEAD",
            ],
        )
        .filter(|(c, _)| *c == 0)
        .and_then(|(_, raw)| {
            let text = String::from_utf8_lossy(&raw).into_owned();
            let text = text.strip_suffix('\0').unwrap_or(&text);
            let mut it = text.splitn(4, '\0');
            let (hash, short, parents, message) = (it.next()?, it.next()?, it.next()?, it.next()?);
            Some(GitHeadCommit {
                hash: hash.to_string(),
                short_hash: short.to_string(),
                message: message.to_string(),
                is_merge: parents.split_whitespace().count() > 1,
            })
        })
    };
    let upstream = read_git_line(
        dir,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    let on_upstream = head.is_some()
        && read_git_line(dir, &["rev-parse", "--symbolic-full-name", "@{upstream}"])
            .and_then(|full| read_git(dir, &["merge-base", "--is-ancestor", "HEAD", &full]))
            .is_some_and(|(c, _)| c == 0);
    // Pushed without tracking (naru task 2801): on a branch, HEAD is also
    // published when any remote-tracking branch contains it.
    let published_on = if on_upstream {
        upstream.clone()
    } else if head.is_some() && branch.is_some() {
        read_git_line(
            dir,
            &[
                "for-each-ref",
                "--contains",
                "HEAD",
                "--format=%(refname)",
                "refs/remotes",
            ],
        )
        .and_then(|refs| {
            refs.lines()
                .filter(|r| !r.ends_with("/HEAD"))
                .find_map(|r| r.strip_prefix("refs/remotes/"))
                .map(str::to_string)
        })
    } else {
        None
    };
    let config = |key: &str| read_git_line(dir, &["config", "--get", key]);
    let operation = operation_in(std::path::Path::new(&git_dir));
    let prepared_message = operation
        .as_deref()
        .filter(|o| matches!(*o, "merge" | "cherry-pick" | "revert"))
        .and_then(|_| std::fs::read(std::path::Path::new(&git_dir).join("MERGE_MSG")).ok())
        .and_then(|raw| {
            let text = String::from_utf8_lossy(&raw);
            let mut kept = text
                .lines()
                .filter(|l| !l.starts_with('#'))
                .collect::<Vec<_>>()
                .join("\n")
                .trim_end()
                .to_string();
            if kept.len() > BODY_CAP {
                let cut = (0..=BODY_CAP).rev().find(|i| kept.is_char_boundary(*i));
                kept.truncate(cut.unwrap_or(0));
            }
            (!kept.is_empty()).then_some(kept)
        });
    Some(GitCommitInfo {
        detached: branch.is_none(),
        branch,
        unborn,
        head,
        upstream,
        head_published: published_on.is_some(),
        published_on,
        author_name: config("user.name"),
        author_email: config("user.email"),
        operation,
        prepared_message,
    })
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
pub fn is_valid_commit_id(sha: &str) -> bool {
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
    fn parse_view_staged_digest_follows_only_the_staged_side() {
        let d = |body: &str| parse_view(&format!("# branch.head main\0{body}")).staged_digest;
        let empty = d("");
        assert!(empty.starts_with("0-"), "{empty}");
        // Unstaged, untracked and conflicted entries are not the staged set.
        assert_eq!(
            d(
                "1 .M N... 100644 100644 100644 aaa aaa a.txt\0? new\0u UU N... 100644 100644 100644 100644 a b c x.txt\0"
            ),
            empty
        );
        let one = d("1 M. N... 100644 100644 100644 aaa bbb a.txt\0");
        assert!(one.starts_with("1-"), "{one}");
        assert_eq!(one, d("1 M. N... 100644 100644 100644 aaa bbb a.txt\0"));
        // The working-tree side (Y, mW) and other unstaged files do not move it.
        assert_eq!(
            one,
            d(
                "1 MM N... 100644 100644 100755 aaa bbb a.txt\x001 .M N... 100644 100644 100644 ccc ccc b.txt\0"
            )
        );
        // The index blob, the index mode, the path and a second file do.
        for other in [
            "1 M. N... 100644 100644 100644 aaa ccc a.txt\0",
            "1 M. N... 100644 100755 100644 aaa bbb a.txt\0",
            "1 M. N... 100644 100644 100644 aaa bbb b.txt\0",
            "1 M. N... 100644 100644 100644 aaa bbb a.txt\x001 A. N... 000000 100644 100644 000 ddd n.txt\0",
            "2 R. N... 100644 100644 100644 aaa bbb R100 a.txt\0old.txt\0",
        ] {
            assert_ne!(one, d(other), "{other}");
        }
        assert_ne!(
            d("2 R. N... 100644 100644 100644 aaa bbb R100 a.txt\0old.txt\0"),
            d("2 R. N... 100644 100644 100644 aaa bbb R100 a.txt\0other.txt\0")
        );
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

    // --- Hunk and line patches (naru task 2739) --------------------------

    fn pk(index: usize, lines: Option<&[usize]>) -> HunkPick {
        HunkPick {
            index,
            lines: lines.map(<[usize]>::to_vec),
        }
    }

    fn patch(diff: &str, picks: &[HunkPick], reverse: bool) -> String {
        String::from_utf8(build_partial_patch(diff.as_bytes(), picks, reverse).unwrap()).unwrap()
    }

    fn patch_err(diff: &[u8], picks: &[HunkPick], reverse: bool) -> String {
        build_partial_patch(diff, picks, reverse).unwrap_err()
    }

    const H: &str = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n";
    const H3: &str = "diff --git a/f b/f\n--- a/f\n+++ b/f\n";

    /// One hunk: body lines 0 ` a`, 1 `-b`, 2 `-c`, 3 `+B`, 4 `+C`, 5 ` d`, 6 ` e`.
    fn one_hunk() -> String {
        format!("{H}@@ -1,5 +1,5 @@ fn\n a\n-b\n-c\n+B\n+C\n d\n e\n")
    }

    /// Three hunks: a line added, a line changed, a line added at the end.
    fn three_hunks() -> String {
        format!(
            "{H3}@@ -1,3 +1,4 @@\n a\n+x\n b\n c\n@@ -10,3 +11,3 @@\n j\n-k\n+K\n l\n@@ -20,3 +21,4 @@\n t\n u\n+v\n w\n"
        )
    }

    #[test]
    fn patch_forward_keeps_unselected_removals_as_context_and_drops_additions() {
        let h = one_hunk();
        // b becomes B: the header keeps only diff/---/+++, counts follow.
        assert_eq!(
            patch(&h, &[pk(0, Some(&[1, 3]))], false),
            format!("{H3}@@ -1,5 +1,5 @@ fn\n a\n-b\n c\n+B\n d\n e\n")
        );
        // Only the removal of c: the new side is a line shorter.
        assert_eq!(
            patch(&h, &[pk(0, Some(&[2]))], false),
            format!("{H3}@@ -1,5 +1,4 @@ fn\n a\n b\n-c\n d\n e\n")
        );
        // Only additions: nothing removed, nothing of the old lines lost.
        assert_eq!(
            patch(&h, &[pk(0, Some(&[3, 4]))], false),
            format!("{H3}@@ -1,5 +1,7 @@ fn\n a\n b\n c\n+B\n+C\n d\n e\n")
        );
        // The whole hunk, by `None` or by listing every change.
        assert_eq!(
            patch(&h, &[pk(0, None)], false),
            patch(&h, &[pk(0, Some(&[1, 2, 3, 4]))], false)
        );
        assert_eq!(
            patch(&h, &[pk(0, None)], false),
            format!("{H3}@@ -1,5 +1,5 @@ fn\n a\n-b\n-c\n+B\n+C\n d\n e\n")
        );
    }

    #[test]
    fn patch_reverse_keeps_unselected_additions_as_context_and_drops_removals() {
        let h = one_hunk();
        assert_eq!(
            patch(&h, &[pk(0, Some(&[3]))], true),
            format!("{H3}@@ -1,4 +1,5 @@ fn\n a\n+B\n C\n d\n e\n")
        );
        assert_eq!(
            patch(&h, &[pk(0, Some(&[1, 3]))], true),
            format!("{H3}@@ -1,5 +1,5 @@ fn\n a\n-b\n+B\n C\n d\n e\n")
        );
        // Only a removal: the added lines stay as context.
        assert_eq!(
            patch(&h, &[pk(0, Some(&[2]))], true),
            format!("{H3}@@ -1,6 +1,5 @@ fn\n a\n-c\n B\n C\n d\n e\n")
        );
    }

    #[test]
    fn patch_running_offset_forward_and_reverse() {
        let t = three_hunks();
        // Forward: hunk 1 and 3 of 3; the new start moves by hunk 1's +1.
        assert_eq!(
            patch(&t, &[pk(0, None), pk(2, None)], false),
            format!("{H3}@@ -1,3 +1,4 @@\n a\n+x\n b\n c\n@@ -20,3 +21,4 @@\n t\n u\n+v\n w\n")
        );
        // Without hunk 1 nothing shifts.
        assert_eq!(
            patch(&t, &[pk(1, None), pk(2, None)], false),
            format!("{H3}@@ -10,3 +10,3 @@\n j\n-k\n+K\n l\n@@ -20,3 +20,4 @@\n t\n u\n+v\n w\n")
        );
        // Lines of hunk 2 (one removal, so -1), then the whole of hunk 3.
        assert_eq!(
            patch(&t, &[pk(1, Some(&[1])), pk(2, None)], false),
            format!("{H3}@@ -10,3 +10,2 @@\n j\n-k\n l\n@@ -20,3 +19,4 @@\n t\n u\n+v\n w\n")
        );
        // Lines of hunk 1 (the addition), then all of hunk 2.
        assert_eq!(
            patch(&t, &[pk(0, Some(&[1])), pk(1, None)], false),
            format!("{H3}@@ -1,3 +1,4 @@\n a\n+x\n b\n c\n@@ -10,3 +11,3 @@\n j\n-k\n+K\n l\n")
        );
        // Reverse keeps the new start and moves the old one.
        assert_eq!(
            patch(&t, &[pk(1, None), pk(2, None)], true),
            format!("{H3}@@ -11,3 +11,3 @@\n j\n-k\n+K\n l\n@@ -21,3 +21,4 @@\n t\n u\n+v\n w\n")
        );
        assert_eq!(
            patch(&t, &[pk(0, None), pk(2, None)], true),
            format!("{H3}@@ -1,3 +1,4 @@\n a\n+x\n b\n c\n@@ -20,3 +21,4 @@\n t\n u\n+v\n w\n")
        );
        // Picks come out in diff order whatever order they were given.
        assert_eq!(
            patch(&t, &[pk(2, None), pk(0, None)], false),
            patch(&t, &[pk(0, None), pk(2, None)], false)
        );
    }

    #[test]
    fn patch_hunks_at_the_start_and_end_of_a_file() {
        // An insertion into an empty old side prints the line before: 0.
        let start = format!("{H}@@ -0,0 +1,2 @@\n+A\n+B\n");
        assert_eq!(
            patch(&start, &[pk(0, Some(&[0]))], false),
            format!("{H3}@@ -0,0 +1,1 @@\n+A\n")
        );
        assert_eq!(
            patch(&start, &[pk(0, Some(&[0]))], true),
            format!("{H3}@@ -1,1 +1,2 @@\n+A\n B\n")
        );
        // A deletion that empties the new side.
        let gone = format!("{H}@@ -1,2 +0,0 @@\n-A\n-B\n");
        assert_eq!(
            patch(&gone, &[pk(0, Some(&[1]))], false),
            format!("{H3}@@ -1,2 +1,1 @@\n A\n-B\n")
        );
        // The last lines of a file, no trailing context.
        let end = format!("{H}@@ -8,2 +8,2 @@\n h\n-i\n+I\n");
        assert_eq!(
            patch(&end, &[pk(0, Some(&[2]))], false),
            format!("{H3}@@ -8,2 +8,3 @@\n h\n i\n+I\n")
        );
    }

    #[test]
    fn patch_without_a_trailing_newline() {
        let d = format!(
            "{H}@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n"
        );
        // The removed and added pair together is fine, both ways.
        let pair = format!(
            "{H3}@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n"
        );
        assert_eq!(patch(&d, &[pk(0, Some(&[1, 2]))], false), pair);
        assert_eq!(patch(&d, &[pk(0, None)], true), pair);
        // Only the removal: b is the last line of the old side.
        assert_eq!(
            patch(&d, &[pk(0, Some(&[1]))], false),
            format!("{H3}@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n")
        );
        // Only the addition would leave b, no newline, before B.
        let e = patch_err(d.as_bytes(), &[pk(0, Some(&[2]))], false);
        assert!(e.contains("no trailing newline"), "{e}");
        let e = patch_err(d.as_bytes(), &[pk(0, Some(&[1]))], true);
        assert!(
            e.contains("select its removed and added lines together"),
            "{e}"
        );
    }

    #[test]
    fn patch_keeps_crlf_and_non_utf8_bytes() {
        let mut d = Vec::new();
        d.extend_from_slice(H.as_bytes());
        d.extend_from_slice(b"@@ -1,3 +1,3 @@\n a\r\n-b\xff\r\n+B\xfe\r\n c\r\n");
        let out = build_partial_patch(&d, &[pk(0, Some(&[1, 2]))], false).unwrap();
        let mut want = Vec::new();
        want.extend_from_slice(H3.as_bytes());
        want.extend_from_slice(b"@@ -1,3 +1,3 @@\n a\r\n-b\xff\r\n+B\xfe\r\n c\r\n");
        assert_eq!(out, want);
        // The digest reads the bytes too.
        assert!(hunk_digest(&d).is_some());
    }

    #[test]
    fn patch_validation_errors() {
        let h = one_hunk();
        let b = h.as_bytes();
        let e = |picks: &[HunkPick]| patch_err(b, picks, false);
        assert!(e(&[]).contains("must not be empty"));
        assert!(e(&[pk(0, Some(&[]))]).contains("lines must not be empty"));
        assert!(e(&[pk(0, None), pk(0, None)]).contains("listed twice"));
        assert!(e(&[pk(0, Some(&[1, 1]))]).contains("listed twice"));
        assert!(e(&[pk(1, None)]).contains("does not exist"));
        assert!(e(&[pk(0, Some(&[7]))]).contains("does not exist"));
        assert!(e(&[pk(0, Some(&[0]))]).contains("context"));
        assert!(e(&[pk(0, Some(&[1, 5]))]).contains("context"));
        // A picked hunk with no change lines at all.
        let ctx_only = format!("{H}@@ -1,2 +1,2 @@\n a\n b\n");
        assert!(patch_err(ctx_only.as_bytes(), &[pk(0, None)], false).contains("nothing"));
        // A diff the builder cannot read.
        assert!(patch_err(b"not a diff", &[pk(0, None)], false).contains("cannot be staged"));
    }

    #[test]
    fn hunk_digest_is_none_for_every_ineligible_shape() {
        let ok = one_hunk();
        let d1 = hunk_digest(ok.as_bytes()).unwrap();
        assert_eq!(d1, hunk_digest(ok.as_bytes()).unwrap());
        assert_ne!(d1, hunk_digest(three_hunks().as_bytes()).unwrap());
        let none = |s: String| assert_eq!(hunk_digest(s.as_bytes()), None, "{s}");
        none(String::from(
            "diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+a\n",
        ));
        none(String::from(
            "diff --git a/f b/f\ndeleted file mode 100644\n--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n",
        ));
        none("diff --git a/f b/g\nsimilarity index 90%\nrename from f\nrename to g\n--- a/f\n+++ b/g\n@@ -1 +1 @@\n-a\n+b\n".into());
        none(
            "diff --git a/f b/g\ncopy from f\ncopy to g\n--- a/f\n+++ b/g\n@@ -1 +1 @@\n-a\n+b\n"
                .into(),
        );
        none("diff --git a/f b/f\nBinary files a/f and b/f differ\n".into());
        none("diff --git a/f b/f\nGIT binary patch\nliteral 1\n".into());
        none("diff --git a/f b/f\nold mode 100644\nnew mode 100755\n".into());
        none(format!(
            "{ok}diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-a\n+b\n"
        ));
        none(format!("{H}@@ -1,2 +1,2 @@\n a\n-b\n+B\nstray\n"));
        none(format!("{H}@@ -1,3 +1,3 @@\n a\n-b\n+B\n"));
        none(format!("{H}@@ -1 +1 @@\n-a\n+b"));
        none(String::new());
        // Over the cap.
        let big = format!("{H}@@ -1 +1 @@\n-a\n+{}\n", "x".repeat(DIFF_CAP));
        none(big);
        // A mode line next to hunks is fine: the builder drops it.
        let moded = String::from(
            "diff --git a/f b/f\nold mode 100644\nnew mode 100755\nindex 1..2\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n",
        );
        assert!(hunk_digest(moded.as_bytes()).is_some());
    }

    // The real repo: what `git diff --cached` and `git diff` print after a
    // hunk operation, minus the `index` lines (blob ids).

    fn gout(d: &tempfile::TempDir, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(d.path())
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .split_inclusive('\n')
            .filter(|l| !l.starts_with("index "))
            .map(
                |l| match l.strip_prefix("@@ ").and_then(|r| r.find(" @@")) {
                    // Drop git's section text after the second `@@`.
                    Some(at) => format!("{} @@\n", &l[..3 + at]),
                    None => l.to_string(),
                },
            )
            .collect()
    }

    fn cached(d: &tempfile::TempDir) -> String {
        gout(d, &["diff", "--cached"])
    }

    fn unstaged(d: &tempfile::TempDir) -> String {
        gout(d, &["diff"])
    }

    /// Builds the patch for `name`'s picked side as the route does, applies it.
    fn hunk_op(
        d: &tempfile::TempDir,
        name: &str,
        op: WriteOp,
        picks: &[HunkPick],
    ) -> Result<(), String> {
        let f = pick(d, &[name]).remove(0);
        let raw = diff_bytes_of_file(dstr(d), &f, op == WriteOp::Unstage).unwrap();
        apply_hunks(
            dstr(d),
            op,
            build_partial_patch(&raw, picks, op != WriteOp::Stage)?,
        )
    }

    /// `f.txt` committed as a, b, c, d, e (LF) and edited to a, B, C, d, e.
    fn abcde(eol: &str) -> tempfile::TempDir {
        let d = wrepo(true);
        let lines = |l: [&str; 5]| l.iter().map(|s| format!("{s}{eol}")).collect::<String>();
        put(&d, "f.txt", &lines(["a", "b", "c", "d", "e"]));
        wgit(d.path(), &["add", "f.txt"]);
        wgit(d.path(), &["commit", "-q", "-m", "f"]);
        put(&d, "f.txt", &lines(["a", "B", "C", "d", "e"]));
        d
    }

    const HDR: &str = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n";

    #[test]
    fn stage_hunk_and_stage_lines_in_a_real_repo() {
        let d = abcde("\n");
        hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(0, Some(&[1, 3]))]).unwrap();
        // The added B goes after the kept c: it follows the removed block.
        assert_eq!(
            cached(&d),
            format!("{HDR}@@ -1,5 +1,5 @@\n a\n-b\n c\n+B\n d\n e\n")
        );
        assert_eq!(
            unstaged(&d),
            format!("{HDR}@@ -1,5 +1,5 @@\n a\n-c\n B\n+C\n d\n e\n")
        );
        // The rest of the file, as a whole hunk of the new unstaged diff.
        hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(0, None)]).unwrap();
        assert_eq!(
            cached(&d),
            format!("{HDR}@@ -1,5 +1,5 @@\n a\n-b\n-c\n+B\n+C\n d\n e\n")
        );
        assert_eq!(unstaged(&d), "");
    }

    #[test]
    fn unstage_hunk_and_unstage_lines_in_a_real_repo() {
        let d = abcde("\n");
        wgit(d.path(), &["add", "f.txt"]);
        hunk_op(&d, "f.txt", WriteOp::Unstage, &[pk(0, Some(&[1, 3]))]).unwrap();
        assert_eq!(
            cached(&d),
            format!("{HDR}@@ -1,5 +1,5 @@\n a\n b\n-c\n+C\n d\n e\n")
        );
        assert_eq!(
            unstaged(&d),
            format!("{HDR}@@ -1,5 +1,5 @@\n a\n-b\n+B\n C\n d\n e\n")
        );
        hunk_op(&d, "f.txt", WriteOp::Unstage, &[pk(0, None)]).unwrap();
        assert_eq!(cached(&d), "");
        assert_eq!(
            unstaged(&d),
            format!("{HDR}@@ -1,5 +1,5 @@\n a\n-b\n-c\n+B\n+C\n d\n e\n")
        );
    }

    #[test]
    fn discard_hunk_and_discard_lines_in_a_real_repo() {
        let d = abcde("\n");
        hunk_op(&d, "f.txt", WriteOp::Discard, &[pk(0, Some(&[1, 3]))]).unwrap();
        assert_eq!(cached(&d), "");
        assert_eq!(
            unstaged(&d),
            format!("{HDR}@@ -1,5 +1,5 @@\n a\n b\n-c\n+C\n d\n e\n")
        );
        assert_eq!(
            std::fs::read_to_string(d.path().join("f.txt")).unwrap(),
            "a\nb\nC\nd\ne\n"
        );
        hunk_op(&d, "f.txt", WriteOp::Discard, &[pk(0, None)]).unwrap();
        assert_eq!(unstaged(&d), "");
        assert_eq!(
            std::fs::read_to_string(d.path().join("f.txt")).unwrap(),
            "a\nb\nc\nd\ne\n"
        );
    }

    #[test]
    fn stage_lines_keeps_crlf() {
        let d = abcde("\r\n");
        hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(0, Some(&[1, 3]))]).unwrap();
        assert_eq!(
            cached(&d),
            format!("{HDR}@@ -1,5 +1,5 @@\n a\r\n-b\r\n c\r\n+B\r\n d\r\n e\r\n")
        );
        assert_eq!(
            unstaged(&d),
            format!("{HDR}@@ -1,5 +1,5 @@\n a\r\n-c\r\n B\r\n+C\r\n d\r\n e\r\n")
        );
    }

    #[test]
    fn stage_hunk_of_a_file_without_a_trailing_newline() {
        let d = wrepo(true);
        put(&d, "f.txt", "a\nb\nc");
        wgit(d.path(), &["add", "f.txt"]);
        wgit(d.path(), &["commit", "-q", "-m", "f"]);
        put(&d, "f.txt", "a\nb\nC");
        // Half of the c/C pair is refused and changes nothing.
        let e = hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(0, Some(&[3]))]).unwrap_err();
        assert!(e.contains("no trailing newline"), "{e}");
        assert_eq!(cached(&d), "");
        let nl = "\\ No newline at end of file\n";
        hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(0, None)]).unwrap();
        assert_eq!(
            cached(&d),
            format!("{HDR}@@ -1,3 +1,3 @@\n a\n b\n-c\n{nl}+C\n{nl}")
        );
        assert_eq!(unstaged(&d), "");
    }

    #[test]
    fn stage_a_hunk_at_the_start_then_one_at_the_end_of_a_file() {
        let d = wrepo(true);
        let nums = |first: &str, last: &str| {
            let mut s = String::new();
            for i in 1..=10 {
                s += &match i {
                    1 => first.to_string(),
                    10 => last.to_string(),
                    _ => format!("l{i}"),
                };
                s.push('\n');
            }
            s
        };
        put(&d, "f.txt", &nums("l1", "l10"));
        wgit(d.path(), &["add", "f.txt"]);
        wgit(d.path(), &["commit", "-q", "-m", "f"]);
        put(&d, "f.txt", &nums("L1", "L10"));
        let first = "@@ -1,4 +1,4 @@\n-l1\n+L1\n l2\n l3\n l4\n";
        let last = "@@ -7,4 +7,4 @@\n l7\n l8\n l9\n-l10\n+L10\n";
        hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(0, None)]).unwrap();
        assert_eq!(cached(&d), format!("{HDR}{first}"));
        assert_eq!(unstaged(&d), format!("{HDR}{last}"));
        wgit(d.path(), &["reset", "-q"]);
        hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(1, None)]).unwrap();
        assert_eq!(cached(&d), format!("{HDR}{last}"));
        assert_eq!(unstaged(&d), format!("{HDR}{first}"));
    }

    #[test]
    fn stage_only_the_second_of_two_adjacent_hunks() {
        let d = wrepo(true);
        let body = |ins: bool, nine: &str| {
            let mut s = String::new();
            for i in 1..=12 {
                s += &if i == 9 {
                    nine.to_string()
                } else {
                    format!("l{i}")
                };
                s.push('\n');
                if i == 1 && ins {
                    s += "x\n";
                }
            }
            s
        };
        put(&d, "f.txt", &body(false, "l9"));
        wgit(d.path(), &["add", "f.txt"]);
        wgit(d.path(), &["commit", "-q", "-m", "f"]);
        put(&d, "f.txt", &body(true, "L9"));
        hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(1, None)]).unwrap();
        assert_eq!(
            cached(&d),
            format!("{HDR}@@ -6,7 +6,7 @@\n l6\n l7\n l8\n-l9\n+L9\n l10\n l11\n l12\n")
        );
        assert_eq!(
            unstaged(&d),
            format!("{HDR}@@ -1,4 +1,5 @@\n l1\n+x\n l2\n l3\n l4\n")
        );
    }

    /// With `diff.context=0` a hunk has no context and `git apply` would
    /// anchor it to the end of the file, staging the LAST `foo` here instead
    /// of the one on line 3. The canonical diff pins three context lines.
    #[test]
    fn a_zero_context_config_cannot_stage_a_different_identical_line() {
        let d = wrepo(true);
        wgit(d.path(), &["config", "diff.context", "0"]);
        put(&d, "f.txt", "a\nb\nfoo\nc\nd\ne\nf\nfoo\n");
        wgit(d.path(), &["add", "f.txt"]);
        wgit(d.path(), &["commit", "-q", "-m", "f"]);
        put(&d, "f.txt", "a\nb\nc\nd\ne\nf\nfoo\n");
        hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(0, None)]).unwrap();
        let index = Command::new("git")
            .args(["-C", d.path().to_str().unwrap(), "show", ":f.txt"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&index.stdout),
            "a\nb\nc\nd\ne\nf\nfoo\n"
        );
        wgit(d.path(), &["config", "--unset", "diff.context"]);
        assert_eq!(unstaged(&d), "");
    }

    #[test]
    fn a_held_index_lock_fails_with_gits_message_and_changes_nothing() {
        let d = abcde("\n");
        let before = unstaged(&d);
        let lock = d.path().join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let e = hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(0, None)]).unwrap_err();
        assert!(e.contains("index.lock"), "{e}");
        assert!(lock.exists(), "the lock is never removed");
        assert_eq!(cached(&d), "");
        assert_eq!(unstaged(&d), before);
    }

    #[test]
    fn staging_a_hunk_does_not_stage_a_mode_change() {
        use std::os::unix::fs::PermissionsExt;
        let d = abcde("\n");
        std::fs::set_permissions(
            d.path().join("f.txt"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        hunk_op(&d, "f.txt", WriteOp::Stage, &[pk(0, None)]).unwrap();
        let c = cached(&d);
        assert!(c.contains("-b\n-c\n+B\n+C\n"), "{c}");
        assert!(!c.contains("mode"), "{c}");
        let u = unstaged(&d);
        assert!(u.contains("old mode 100644\nnew mode 100755\n"), "{u}");
        assert!(!u.contains("@@"), "{u}");
    }
}

/// Commit and amend (naru task 2740): real temp repos. Each fixture sets its
/// own identity, `commit.gpgsign false` and a local `core.hooksPath`, so the
/// developer's global config and hooks never reach a test.
#[cfg(test)]
mod commit_tests {
    use super::*;
    use std::path::Path;

    fn gb(dir: &Path, args: &[&str]) -> Vec<u8> {
        let out = Command::new("git")
            .args(["-C", dir.to_str().unwrap()])
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    }

    fn g(dir: &Path, args: &[&str]) -> String {
        String::from_utf8(gb(dir, args)).unwrap().trim().to_string()
    }

    /// An empty repo on `main` with identity, no signing and its own hooks dir.
    fn bare_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        g(d, &["init", "-q", "-b", "main"]);
        g(d, &["config", "user.name", "Tester"]);
        g(d, &["config", "user.email", "t@example.com"]);
        g(d, &["config", "commit.gpgsign", "false"]);
        let hooks = d.join(".git/hooks");
        g(d, &["config", "core.hooksPath", hooks.to_str().unwrap()]);
        tmp
    }

    /// `bare_repo` plus one commit ("base") holding `a.txt` and `b.txt`.
    fn repo() -> tempfile::TempDir {
        let tmp = bare_repo();
        let d = tmp.path();
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        std::fs::write(d.join("b.txt"), "b\n").unwrap();
        g(d, &["add", "a.txt", "b.txt"]);
        g(d, &["commit", "-q", "-m", "base"]);
        tmp
    }

    fn s(d: &Path) -> &str {
        d.to_str().unwrap()
    }

    fn head(d: &Path) -> String {
        g(d, &["rev-parse", "HEAD"])
    }

    fn count(d: &Path) -> usize {
        g(d, &["rev-list", "--count", "HEAD"]).parse().unwrap()
    }

    /// The raw message of HEAD: the bytes after the first blank line of the
    /// commit object.
    fn raw_message(d: &Path) -> Vec<u8> {
        let obj = gb(d, &["cat-file", "commit", "HEAD"]);
        let at = obj.windows(2).position(|w| w == b"\n\n").unwrap();
        obj[at + 2..].to_vec()
    }

    fn hook(d: &Path, name: &str, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let dir = d.join(".git/hooks");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn normalize_commit_message_table() {
        let cases: &[(&str, Option<&str>)] = &[
            ("fix it", Some("fix it\n")),
            ("a\r\nb\r\n", Some("a\nb\n")),
            ("\n\n  \nsubject\n\nbody", Some("subject\n\nbody\n")),
            ("subject  \n\n\n  \t\n", Some("subject\n")),
            ("  indented first\n", Some("  indented first\n")),
            ("", None),
            (" \r\n\t\n  ", None),
            ("# only a comment", Some("# only a comment\n")),
            ("--amend -m x", Some("--amend -m x\n")),
            ("a\n\n\n\nb\n", Some("a\n\n\n\nb\n")),
            ("café 🎉 日本語\n", Some("café 🎉 日本語\n")),
        ];
        for (raw, want) in cases {
            assert_eq!(normalize_commit_message(raw).as_deref(), *want, "{raw:?}");
        }
    }

    #[test]
    fn commit_creates_one_commit_with_the_staged_tree_and_the_exact_message() {
        let tmp = repo();
        let d = tmp.path();
        let big = format!("subject\n\n{}", "x".repeat(100 * 1024));
        let messages = [
            "subject\n\nbody line one\nbody line two\n\n  indented\n".to_string(),
            "emoji 🎉 ünïcode 日本語\n\nтело сообщения\n".to_string(),
            "--amend -m x\n".to_string(),
            "# not a comment\n\nbody\n".to_string(),
            normalize_commit_message(&big).unwrap(),
        ];
        // An unstaged change and an untracked file that must stay untouched.
        std::fs::write(d.join("b.txt"), "b changed, unstaged\n").unwrap();
        std::fs::write(d.join("new.txt"), "untracked\n").unwrap();
        for (i, m) in messages.iter().enumerate() {
            std::fs::write(d.join("a.txt"), format!("a{i}\n")).unwrap();
            g(d, &["add", "a.txt"]);
            let tree = g(d, &["write-tree"]);
            let (old, n) = (head(d), count(d));
            commit(s(d), m, false).unwrap();
            assert_eq!(count(d), n + 1);
            assert_eq!(g(d, &["rev-parse", "HEAD^"]), old);
            assert_eq!(g(d, &["rev-parse", "HEAD^{tree}"]), tree);
            assert_eq!(raw_message(d), m.as_bytes(), "message {i}");
            let info = commit_info_of(s(d)).unwrap();
            assert_eq!(
                normalize_commit_message(&info.head.unwrap().message).as_deref(),
                Some(m.as_str())
            );
            assert_eq!(
                g(d, &["status", "--porcelain"]),
                "M b.txt\n?? new.txt",
                "unstaged and untracked left alone"
            );
        }
    }

    #[test]
    fn commit_on_an_unborn_head_creates_the_root_commit() {
        let tmp = bare_repo();
        let d = tmp.path();
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        g(d, &["add", "a.txt"]);
        let tree = g(d, &["write-tree"]);
        commit(s(d), "first\n", false).unwrap();
        assert_eq!(count(d), 1);
        assert_eq!(g(d, &["rev-parse", "HEAD^{tree}"]), tree);
        assert!(
            g(d, &["rev-list", "--parents", "-n", "1", "HEAD"])
                .split(' ')
                .count()
                == 1
        );
    }

    #[test]
    fn amend_replaces_head_keeps_its_author_and_takes_the_index() {
        let tmp = repo();
        let d = tmp.path();
        std::fs::write(d.join("a.txt"), "second\n").unwrap();
        g(d, &["add", "a.txt"]);
        g(
            d,
            &[
                "commit",
                "-q",
                "--author",
                "Old Author <old@example.com>",
                "--date",
                "2020-01-02T03:04:05",
                "-m",
                "second",
            ],
        );
        let who = g(d, &["log", "-1", "--format=%an|%ae|%aI"]);
        let parent = g(d, &["rev-parse", "HEAD^"]);
        let n = count(d);
        // Message only: the tree stays.
        let tree = g(d, &["rev-parse", "HEAD^{tree}"]);
        commit(s(d), "reworded\n\nwith a body\n", true).unwrap();
        assert_eq!(count(d), n);
        assert_eq!(g(d, &["rev-parse", "HEAD^"]), parent);
        assert_eq!(raw_message(d), b"reworded\n\nwith a body\n");
        assert_eq!(g(d, &["rev-parse", "HEAD^{tree}"]), tree);
        assert_eq!(g(d, &["log", "-1", "--format=%an|%ae|%aI"]), who);
        // With a staged change: the tree is the index.
        std::fs::write(d.join("b.txt"), "b amended\n").unwrap();
        g(d, &["add", "b.txt"]);
        let tree = g(d, &["write-tree"]);
        commit(s(d), "--final -x\n", true).unwrap();
        assert_eq!(count(d), n);
        assert_eq!(g(d, &["rev-parse", "HEAD^"]), parent);
        assert_eq!(g(d, &["rev-parse", "HEAD^{tree}"]), tree);
        assert_eq!(raw_message(d), b"--final -x\n");
        assert_eq!(g(d, &["log", "-1", "--format=%an|%ae|%aI"]), who);
    }

    #[test]
    fn failing_hooks_return_both_outputs_and_change_nothing() {
        for name in ["pre-commit", "commit-msg"] {
            let tmp = repo();
            let d = tmp.path();
            hook(
                d,
                name,
                "echo out-from-hook\necho err-from-hook >&2\nexit 1",
            );
            std::fs::write(d.join("a.txt"), "changed\n").unwrap();
            g(d, &["add", "a.txt"]);
            let (old, tree) = (head(d), g(d, &["write-tree"]));
            let e = commit(s(d), "msg\n", false).unwrap_err();
            assert!(e.contains("out-from-hook"), "{name}: {e}");
            assert!(e.contains("err-from-hook"), "{name}: {e}");
            assert_eq!(head(d), old);
            assert_eq!(g(d, &["write-tree"]), tree);
            assert_eq!(count(d), 1);
        }
    }

    #[test]
    fn a_chatty_failing_hook_keeps_the_tail_of_its_output() {
        let tmp = repo();
        let d = tmp.path();
        hook(
            d,
            "pre-commit",
            "i=0\nwhile [ $i -lt 4000 ]; do echo \"noise line number $i padding padding\"; i=$((i+1)); done\necho THE-REAL-FAILURE >&2\nexit 1",
        );
        std::fs::write(d.join("a.txt"), "changed\n").unwrap();
        g(d, &["add", "a.txt"]);
        let e = commit(s(d), "msg\n", false).unwrap_err();
        assert!(e.starts_with("[output truncated]\n"), "{}", &e[..60]);
        assert!(e.contains("THE-REAL-FAILURE"), "the tail was lost");
        assert!(e.contains("noise line number 3999"));
        assert!(!e.contains("noise line number 0 "));
        assert!(e.len() <= COMMIT_ERR_CAP * 2 + 64);
        assert_eq!(count(d), 1);
    }

    #[test]
    fn a_passing_hook_still_commits() {
        let tmp = repo();
        let d = tmp.path();
        hook(d, "pre-commit", "echo checking\nexit 0");
        hook(d, "commit-msg", "exit 0");
        std::fs::write(d.join("a.txt"), "changed\n").unwrap();
        g(d, &["add", "a.txt"]);
        commit(s(d), "ok\n", false).unwrap();
        assert_eq!(count(d), 2);
        assert_eq!(raw_message(d), b"ok\n");
    }

    #[test]
    fn a_held_index_lock_fails_and_stays() {
        let tmp = repo();
        let d = tmp.path();
        std::fs::write(d.join("a.txt"), "changed\n").unwrap();
        g(d, &["add", "a.txt"]);
        let lock = d.join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let old = head(d);
        let e = commit(s(d), "msg\n", false).unwrap_err();
        assert!(e.contains("index.lock"), "{e}");
        assert_eq!(head(d), old);
        assert!(lock.exists(), "the lock is never removed");
    }

    #[test]
    fn a_hung_hook_is_stopped_at_the_timeout_and_leaves_no_lock() {
        let tmp = repo();
        let d = tmp.path();
        hook(d, "pre-commit", "echo started\nsleep 30");
        std::fs::write(d.join("a.txt"), "changed\n").unwrap();
        g(d, &["add", "a.txt"]);
        let old = head(d);
        let t = Instant::now();
        let e = commit_within(s(d), "msg\n", false, Duration::from_secs(1)).unwrap_err();
        assert!(t.elapsed() < Duration::from_secs(15), "{:?}", t.elapsed());
        assert!(
            e.starts_with(
                "git commit did not finish within 1 s and was stopped. Nothing was retried."
            ),
            "{e}"
        );
        assert!(e.contains("started"), "{e}");
        assert_eq!(head(d), old);
        assert!(!d.join(".git/index.lock").exists());
    }

    #[test]
    fn a_failing_signer_returns_git_text_promptly() {
        let tmp = repo();
        let d = tmp.path();
        let prog = tmp.path().join(".git/fake-gpg");
        std::fs::write(&prog, "#!/bin/sh\necho signer-says-no >&2\nexit 1\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&prog, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        g(d, &["config", "gpg.format", "openpgp"]);
        g(d, &["config", "commit.gpgsign", "true"]);
        g(d, &["config", "gpg.program", prog.to_str().unwrap()]);
        std::fs::write(d.join("a.txt"), "changed\n").unwrap();
        g(d, &["add", "a.txt"]);
        let old = head(d);
        let t = Instant::now();
        let e = commit(s(d), "msg\n", false).unwrap_err();
        assert!(t.elapsed() < Duration::from_secs(15));
        assert!(e.contains("gpg") || e.contains("sign"), "{e}");
        assert_eq!(head(d), old);
    }

    #[test]
    fn commit_info_reads_born_unborn_and_detached() {
        let tmp = bare_repo();
        let d = tmp.path();
        let i = commit_info_of(s(d)).unwrap();
        assert!(i.unborn && i.head.is_none() && !i.detached);
        assert_eq!(i.branch.as_deref(), Some("main"));
        assert!(!i.head_published && i.upstream.is_none());
        assert_eq!(i.author_name.as_deref(), Some("Tester"));
        assert_eq!(i.author_email.as_deref(), Some("t@example.com"));

        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        g(d, &["add", "a.txt"]);
        g(d, &["commit", "-q", "-m", "one\n\nbody"]);
        let h = commit_info_of(s(d)).unwrap().head.unwrap();
        assert_eq!(h.hash, head(d));
        assert_eq!(h.short_hash, g(d, &["rev-parse", "--short", "HEAD"]));
        assert!(h.message.starts_with("one\n\nbody"));
        assert!(!h.is_merge);

        g(d, &["checkout", "-q", "--detach"]);
        let i = commit_info_of(s(d)).unwrap();
        assert!(i.detached && !i.unborn && i.branch.is_none());
        assert_eq!(i.head.unwrap().hash, head(d));
        assert!(commit_info_of(tempfile::tempdir().unwrap().path().to_str().unwrap()).is_none());
    }

    #[test]
    fn commit_info_identity_is_none_when_blank() {
        let tmp = repo();
        let d = tmp.path();
        g(d, &["config", "user.name", " "]);
        g(d, &["config", "user.email", ""]);
        let i = commit_info_of(s(d)).unwrap();
        assert!(i.author_name.is_none() && i.author_email.is_none());
    }

    #[test]
    fn commit_info_knows_whether_head_is_published() {
        let tmp = repo();
        let d = tmp.path();
        let remote = tempfile::tempdir().unwrap();
        g(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
        g(
            d,
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        assert!(!commit_info_of(s(d)).unwrap().head_published);
        g(d, &["push", "-q", "-u", "origin", "main"]);
        let i = commit_info_of(s(d)).unwrap();
        assert_eq!(i.upstream.as_deref(), Some("origin/main"));
        assert!(i.head_published);
        assert_eq!(i.published_on.as_deref(), Some("origin/main"));
        std::fs::write(d.join("a.txt"), "more\n").unwrap();
        g(d, &["commit", "-q", "-a", "-m", "local only"]);
        let i = commit_info_of(s(d)).unwrap();
        assert_eq!(i.upstream.as_deref(), Some("origin/main"));
        assert!(!i.head_published);
    }

    #[test]
    fn commit_info_sees_a_head_pushed_without_an_upstream() {
        let tmp = repo();
        let d = tmp.path();
        let remote = tempfile::tempdir().unwrap();
        g(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
        g(
            d,
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        // Pushed with no `-u`: no upstream, but origin/main holds HEAD.
        g(d, &["push", "-q", "origin", "main"]);
        let i = commit_info_of(s(d)).unwrap();
        assert!(i.upstream.is_none());
        assert!(i.head_published);
        assert_eq!(i.published_on.as_deref(), Some("origin/main"));
        // `origin/HEAD` is never the name shown.
        g(d, &["remote", "set-head", "origin", "main"]);
        assert_eq!(
            commit_info_of(s(d)).unwrap().published_on.as_deref(),
            Some("origin/main")
        );
        // A detached HEAD is on no branch: amending rewrites nothing published.
        g(d, &["checkout", "-q", "--detach"]);
        let i = commit_info_of(s(d)).unwrap();
        assert!(!i.head_published && i.published_on.is_none());
        g(d, &["checkout", "-q", "main"]);
        // A new local commit is on no remote branch.
        std::fs::write(d.join("a.txt"), "more\n").unwrap();
        g(d, &["commit", "-q", "-a", "-m", "local only"]);
        let i = commit_info_of(s(d)).unwrap();
        assert!(!i.head_published && i.published_on.is_none());
        // With an upstream that does not hold HEAD, another remote branch that does counts.
        g(d, &["branch", "-q", "--set-upstream-to=origin/main"]);
        g(d, &["push", "-q", "origin", "main:refs/heads/copy"]);
        let i = commit_info_of(s(d)).unwrap();
        assert_eq!(i.upstream.as_deref(), Some("origin/main"));
        assert!(i.head_published);
        assert_eq!(i.published_on.as_deref(), Some("origin/copy"));
    }

    #[test]
    fn view_of_staged_digest_changes_with_the_index_only() {
        let tmp = repo();
        let d = tmp.path();
        let digest = || view_of(s(d)).unwrap().staged_digest;
        let clean = digest();
        std::fs::write(d.join("a.txt"), "one\n").unwrap();
        assert_eq!(digest(), clean, "an unstaged edit");
        g(d, &["add", "a.txt"]);
        let one = digest();
        assert_ne!(one, clean);
        std::fs::write(d.join("b.txt"), "unstaged\n").unwrap();
        std::fs::write(d.join("new.txt"), "n\n").unwrap();
        assert_eq!(digest(), one, "unstaged and untracked files");
        // The same path staged again with other content.
        std::fs::write(d.join("a.txt"), "two\n").unwrap();
        assert_eq!(digest(), one);
        g(d, &["add", "a.txt"]);
        let two = digest();
        assert_ne!(two, one);
        g(d, &["add", "new.txt"]);
        assert_ne!(digest(), two);
        g(d, &["reset", "-q"]);
        assert_eq!(digest(), clean);
    }

    #[test]
    fn commit_info_prepared_message_drops_comment_lines() {
        let tmp = repo();
        let d = tmp.path();
        g(d, &["checkout", "-q", "-b", "other"]);
        std::fs::write(d.join("a.txt"), "other\n").unwrap();
        g(d, &["commit", "-q", "-a", "-m", "other side"]);
        g(d, &["checkout", "-q", "main"]);
        std::fs::write(d.join("a.txt"), "main\n").unwrap();
        g(d, &["commit", "-q", "-a", "-m", "main side"]);
        let merge = Command::new("git")
            .args(["-C", s(d), "merge", "other"])
            .output()
            .unwrap();
        assert!(!merge.status.success(), "the merge must conflict");
        let on_disk = std::fs::read_to_string(d.join(".git/MERGE_MSG")).unwrap();
        assert!(on_disk.lines().any(|l| l.starts_with('#')), "{on_disk}");
        let i = commit_info_of(s(d)).unwrap();
        assert_eq!(i.operation.as_deref(), Some("merge"));
        let m = i.prepared_message.unwrap();
        assert!(m.starts_with("Merge branch 'other'"), "{m}");
        assert!(m.lines().all(|l| !l.starts_with('#')), "{m}");
        assert_eq!(m, m.trim_end());
        // No operation, no prepared message.
        g(d, &["merge", "--abort"]);
        assert!(commit_info_of(s(d)).unwrap().prepared_message.is_none());
    }

    #[test]
    fn commit_info_of_a_linked_worktree_reports_its_own_branch_and_head() {
        let tmp = repo();
        let d = tmp.path();
        let linked = tempfile::tempdir().unwrap();
        let l = linked.path().join("wt");
        g(
            d,
            &["worktree", "add", "-q", "-b", "feat", l.to_str().unwrap()],
        );
        std::fs::write(l.join("c.txt"), "c\n").unwrap();
        g(&l, &["add", "c.txt"]);
        commit(s(&l), "on feat\n", false).unwrap();
        let main = commit_info_of(s(d)).unwrap();
        let feat = commit_info_of(s(&l)).unwrap();
        assert_eq!(main.branch.as_deref(), Some("main"));
        assert_eq!(feat.branch.as_deref(), Some("feat"));
        assert_eq!(
            feat.head.as_ref().unwrap().hash,
            g(&l, &["rev-parse", "HEAD"])
        );
        assert_ne!(main.head.unwrap().hash, feat.head.unwrap().hash);
    }
}

#[cfg(test)]
mod ref_tests {
    use super::*;
    use std::path::Path;

    fn gb(dir: &Path, args: &[&str]) -> Vec<u8> {
        let out = Command::new("git")
            .args(["-C", dir.to_str().unwrap()])
            .args(args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        out.stdout
    }

    fn g(dir: &Path, args: &[&str]) -> String {
        String::from_utf8(gb(dir, args)).unwrap().trim().to_string()
    }

    fn s(d: &Path) -> &str {
        d.to_str().unwrap()
    }

    /// A repo on `main` with identity, no signing, its own hooks dir and one
    /// commit holding `a.txt`.
    fn repo() -> tempfile::TempDir {
        let tmp = bare();
        let d = tmp.path();
        std::fs::write(d.join("a.txt"), "a\n").unwrap();
        g(d, &["add", "a.txt"]);
        g(d, &["commit", "-q", "-m", "base"]);
        tmp
    }

    fn bare() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        g(d, &["init", "-q", "-b", "main"]);
        g(d, &["config", "user.name", "Tester"]);
        g(d, &["config", "user.email", "t@example.com"]);
        g(d, &["config", "commit.gpgsign", "false"]);
        let hooks = d.join(".git/hooks");
        g(d, &["config", "core.hooksPath", hooks.to_str().unwrap()]);
        tmp
    }

    /// `repo()` plus a linked worktree on a new branch `other`.
    fn with_linked() -> (tempfile::TempDir, tempfile::TempDir) {
        let main = repo();
        let linked = tempfile::tempdir().unwrap();
        let path = linked.path().join("wt");
        g(
            main.path(),
            &["worktree", "add", "-q", "-b", "other", s(&path)],
        );
        (main, linked)
    }

    fn lp(l: &tempfile::TempDir) -> std::path::PathBuf {
        l.path().join("wt")
    }

    fn commit(d: &Path, file: &str, text: &str, msg: &str) -> String {
        std::fs::write(d.join(file), text).unwrap();
        g(d, &["add", file]);
        g(d, &["commit", "-q", "-m", msg]);
        g(d, &["rev-parse", "HEAD"])
    }

    fn branch_names(d: &Path) -> Vec<String> {
        branches_of(s(d))
            .unwrap()
            .into_iter()
            .filter(|b| b.kind == GitBranchKind::Local)
            .map(|b| b.name)
            .collect()
    }

    fn current(d: &Path) -> String {
        g(d, &["symbolic-ref", "--short", "HEAD"])
    }

    fn stash_count(d: &Path) -> usize {
        stashes_of(s(d)).unwrap().len()
    }

    fn msg_of(e: RefErr) -> String {
        match e {
            RefErr::Validation(m) | RefErr::NotFound(m) | RefErr::Conflict(m) => m,
        }
    }

    fn validation(r: Result<impl std::fmt::Debug, RefErr>) -> String {
        match r {
            Err(RefErr::Validation(m)) => m,
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    fn conflict(r: Result<impl std::fmt::Debug, RefErr>) -> String {
        match r {
            Err(RefErr::Conflict(m)) => m,
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    fn hook(d: &Path, name: &str, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let dir = d.join(".git/hooks");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn new_branch_names_are_validated_before_git_creates_anything() {
        let (main, _linked) = with_linked();
        let d = main.path();
        g(d, &["tag", "v1"]);
        let bad: &[(&str, &str)] = &[
            ("", "empty"),
            ("-x", "begins with '-'"),
            ("--force", "begins with '-'"),
            ("@{-1}", "not a valid branch name"),
            ("a..b", "not a valid branch name"),
            ("x.lock", "not a valid branch name"),
            ("a b", "not a valid branch name"),
            ("HEAD", "not a valid branch name"),
            ("@", "not a valid branch name"),
            ("a\nb", "not a valid branch name"),
            ("main", "a branch named main already exists"),
            ("other", "a branch named other already exists"),
            ("v1", "a tag named v1 already exists"),
        ];
        for (name, want) in bad {
            let e = valid_new_branch_name(s(d), name).unwrap_err();
            assert!(e.contains(want), "{name:?}: {e}");
        }
        assert!(
            valid_new_branch_name(s(d), &"x".repeat(256))
                .unwrap_err()
                .contains("255")
        );
        for ok in ["feat/x", "héllo-日本", "a-b_c.d", "release/1.0"] {
            valid_new_branch_name(s(d), ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
        // `@{-1}` expands once there is a previous branch: still a refusal.
        g(d, &["switch", "-q", "-c", "prev"]);
        g(d, &["switch", "-q", "main"]);
        assert_eq!(g(d, &["check-ref-format", "--branch", "@{-1}"]), "prev");
        assert!(valid_new_branch_name(s(d), "@{-1}").is_err());
        assert!(valid_new_branch_name(s(d), "tmp").is_ok());
        assert!(!branch_names(d).contains(&"tmp".to_string()));
    }

    #[test]
    fn create_branch_from_head_commit_remote_and_with_switch() {
        let (main, linked) = with_linked();
        let d = main.path();
        let w = lp(&linked);
        let first = g(d, &["rev-parse", "HEAD"]);
        let second = commit(d, "b.txt", "b\n", "second");
        // From HEAD of the worktree it is asked in, not of the main checkout.
        assert_eq!(create_branch(s(&w), "from-wt", None, None, false), Ok(None));
        assert_eq!(g(d, &["rev-parse", "from-wt"]), first);
        assert_eq!(current(&w), "other");
        assert_eq!(
            create_branch(s(d), "from-head", None, None, false),
            Ok(None)
        );
        assert_eq!(g(d, &["rev-parse", "from-head"]), second);
        // From a commit: the full hash resolves, an abbreviation is expanded.
        assert_eq!(
            create_branch(s(d), "from-commit", Some(&first), None, false),
            Ok(None)
        );
        assert_eq!(g(d, &["rev-parse", "from-commit"]), first);
        // Only a FULL hash: an abbreviation could be shadowed by a ref name.
        assert!(
            validation(create_branch(s(d), "abbr", Some(&first[..10]), None, false))
                .contains("full lowercase commit hash")
        );
        g(d, &["tag", &first[..7]]);
        validation(create_branch(s(d), "abbr", Some(&first[..7]), None, false));
        assert!(matches!(
            create_branch(s(d), "nope", Some(&"0".repeat(40)), None, false),
            Err(RefErr::NotFound(_))
        ));
        validation(create_branch(s(d), "bad", Some("--oops"), None, false));
        validation(create_branch(s(d), "bad2", Some(&first), Some("x"), false));
        // From a remote-tracking branch.
        g(d, &["update-ref", "refs/remotes/origin/feat", &first]);
        g(
            d,
            &["remote", "add", "origin", "https://example.invalid/r.git"],
        );
        assert_eq!(
            create_branch(s(d), "from-remote", None, Some("origin/feat"), false),
            Ok(None)
        );
        assert_eq!(g(d, &["rev-parse", "from-remote"]), first);
        assert!(matches!(
            create_branch(s(d), "r2", None, Some("origin/missing"), false),
            Err(RefErr::NotFound(_))
        ));
        // A LOCAL branch name is not a remote row.
        assert!(matches!(
            create_branch(s(d), "r3", None, Some("main"), false),
            Err(RefErr::NotFound(_))
        ));
        // With switch: one call, the worktree moves, the main checkout does not.
        assert_eq!(
            create_branch(s(&w), "sw", Some(&second), None, true),
            Ok(None)
        );
        assert_eq!(current(&w), "sw");
        assert_eq!(current(d), "main");
        assert_eq!(g(&w, &["rev-parse", "HEAD"]), second);
        // A refused switch (dirty conflicting tree) creates nothing.
        std::fs::write(w.join("b.txt"), "dirty\n").unwrap();
        conflict(create_branch(s(&w), "refused", Some(&first), None, true));
        assert!(!branch_names(d).contains(&"refused".to_string()));
        assert_eq!(current(&w), "sw");
        // An existing name is a validation error, not a git failure.
        assert!(
            validation(create_branch(s(d), "main", None, None, false)).contains("already exists")
        );
    }

    #[test]
    fn create_branch_on_a_detached_head_and_an_unborn_one() {
        let main = repo();
        let d = main.path();
        let head = g(d, &["rev-parse", "HEAD"]);
        g(d, &["checkout", "-q", "--detach"]);
        assert_eq!(create_branch(s(d), "here", None, None, false), Ok(None));
        assert_eq!(g(d, &["rev-parse", "here"]), head);
        assert_eq!(create_branch(s(d), "here2", None, None, true), Ok(None));
        assert_eq!(current(d), "here2");
        let empty = bare();
        let e = conflict(create_branch(s(empty.path()), "x", None, None, false));
        assert!(!e.is_empty());
        assert!(branch_names(empty.path()).is_empty());
    }

    #[test]
    fn switch_clean_dirty_refused_stash_and_held_by_another_worktree() {
        let (main, linked) = with_linked();
        let d = main.path();
        let w = lp(&linked);
        g(d, &["branch", "feat"]);
        g(d, &["branch", "side"]);
        // Clean switch moves only this worktree.
        assert_eq!(switch_branch(s(d), "feat", false), Ok(None));
        assert_eq!(current(d), "feat");
        assert_eq!(current(&w), "other");
        assert!(validation(switch_branch(s(d), "feat", false)).contains("already on feat"));
        assert!(validation(switch_branch(s(d), "other", false)).contains("is checked out in"));
        assert!(matches!(
            switch_branch(s(d), "ghost", false),
            Err(RefErr::NotFound(_))
        ));
        // A remote row never matches (no DWIM guess).
        g(d, &["update-ref", "refs/remotes/origin/guess", "HEAD"]);
        assert!(matches!(
            switch_branch(s(d), "guess", false),
            Err(RefErr::NotFound(_))
        ));
        assert!(matches!(
            switch_branch(s(d), "origin/guess", false),
            Err(RefErr::NotFound(_))
        ));
        // Diverge `side` so a dirty a.txt conflicts.
        g(d, &["switch", "-q", "side"]);
        commit(d, "a.txt", "side\n", "side change");
        g(d, &["switch", "-q", "feat"]);
        std::fs::write(d.join("a.txt"), "dirty\n").unwrap();
        std::fs::write(d.join("new.txt"), "untracked\n").unwrap();
        let e = conflict(switch_branch(s(d), "side", false));
        assert!(e.contains("would be overwritten"), "{e}");
        assert_eq!(current(d), "feat");
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "dirty\n");
        assert_eq!(
            std::fs::read_to_string(d.join("new.txt")).unwrap(),
            "untracked\n"
        );
        assert_eq!(stash_count(d), 0);
        // Stash-and-switch: the work goes to stash@{0}, the notice says so.
        let notice = switch_branch(s(d), "side", true).unwrap();
        assert_eq!(
            notice.as_deref(),
            Some("Stashed your changes as stash@{0} before switching.")
        );
        assert_eq!(current(d), "side");
        assert_eq!(stash_count(d), 1);
        let st = &stashes_of(s(d)).unwrap()[0];
        assert!(
            st.message.contains("naru: before switching to side"),
            "{}",
            st.message
        );
        assert!(!d.join("new.txt").exists());
        // Nothing to stash = a plain switch, no notice, no new entry.
        assert_eq!(switch_branch(s(d), "feat", true), Ok(None));
        assert_eq!(stash_count(d), 1);
        // A stash that was made and then a switch that fails: says so.
        g(d, &["switch", "-q", "side"]);
        std::fs::write(d.join("a.txt"), "dirty again\n").unwrap();
        // A failing post-checkout hook makes `git switch` exit non-zero.
        hook(d, "post-checkout", "echo hook-said-no >&2\nexit 1");
        let e = conflict(switch_branch(s(d), "feat", true));
        assert!(
            e.starts_with(
                "Your changes were stashed (stash@{0}) and were NOT restored; the switch failed:"
            ),
            "{e}"
        );
        assert!(e.contains("hook-said-no"), "{e}");
        assert_eq!(stash_count(d), 2);
    }

    #[test]
    fn switch_refuses_an_existing_dash_name_and_an_operation_in_progress() {
        let main = repo();
        let d = main.path();
        g(d, &["update-ref", "refs/heads/-x", "HEAD"]);
        let e = validation(switch_branch(s(d), "-x", false));
        assert!(e.contains("rename it in the terminal"), "{e}");
        validation(rename_branch(s(d), "-x", "y"));
        validation(delete_branch(s(d), "-x", false, None));
        assert!(branch_names(d).contains(&"-x".to_string()));
        // A merge conflict is an operation in progress.
        g(d, &["branch", "side"]);
        g(d, &["switch", "-q", "side"]);
        commit(d, "a.txt", "side\n", "side");
        g(d, &["switch", "-q", "main"]);
        commit(d, "a.txt", "main\n", "main");
        let _ = Command::new("git")
            .args(["-C", s(d), "merge", "side"])
            .output()
            .unwrap();
        assert_eq!(view_of(s(d)).unwrap().operation.as_deref(), Some("merge"));
        let e = validation(switch_branch(s(d), "side", false));
        assert!(
            e.starts_with(
                "A merge is in progress in this worktree; switching branches is not available."
            ),
            "{e}"
        );
        validation(create_branch(s(d), "n", None, None, true));
        validation(stash_push(s(d), None, false));
        // Creating without a switch, and a drop, are still allowed.
        assert_eq!(create_branch(s(d), "n2", None, None, false), Ok(None));
    }

    #[test]
    fn rename_branch_cases() {
        let (main, linked) = with_linked();
        let d = main.path();
        g(d, &["branch", "old"]);
        assert_eq!(rename_branch(s(d), "old", "new/name"), Ok(None));
        assert!(branch_names(d).contains(&"new/name".to_string()));
        assert!(!branch_names(d).contains(&"old".to_string()));
        // The selected worktree's own current branch may be renamed.
        assert_eq!(rename_branch(s(d), "main", "trunk"), Ok(None));
        assert_eq!(current(d), "trunk");
        // Another worktree's branch may not.
        assert!(validation(rename_branch(s(d), "other", "x")).contains("is checked out in"));
        assert_eq!(current(&lp(&linked)), "other");
        assert!(validation(rename_branch(s(d), "trunk", "new/name")).contains("already exists"));
        validation(rename_branch(s(d), "trunk", "-y"));
        validation(rename_branch(s(d), "trunk", "a..b"));
        assert!(matches!(
            rename_branch(s(d), "ghost", "z"),
            Err(RefErr::NotFound(_))
        ));
        assert_eq!(current(d), "trunk");
    }

    #[test]
    fn delete_merged_unmerged_force_and_checked_out_branches() {
        let (main, linked) = with_linked();
        let d = main.path();
        g(d, &["branch", "merged"]);
        let out = delete_branch(s(d), "merged", false, None).unwrap();
        assert!(out.deleted && out.refusal.is_none() && out.unmerged.is_empty());
        assert_eq!(out.hash, g(d, &["rev-parse", "main"]));
        assert!(!branch_names(d).contains(&"merged".to_string()));
        // Checked out here / elsewhere.
        assert!(
            validation(delete_branch(s(d), "main", false, None))
                .contains("main is the current branch of this worktree")
        );
        assert!(
            validation(delete_branch(s(d), "other", true, Some(&"0".repeat(40))))
                .contains("is checked out in")
        );
        assert!(matches!(
            delete_branch(s(d), "ghost", false, None),
            Err(RefErr::NotFound(_))
        ));
        // Unmerged: refused with the text, tip and commits; nothing deleted.
        g(d, &["switch", "-q", "-c", "work"]);
        let c1 = commit(d, "w1.txt", "1\n", "work one");
        let c2 = commit(d, "w2.txt", "2\n", "work two");
        g(d, &["switch", "-q", "main"]);
        let out = delete_branch(s(d), "work", false, None).unwrap();
        assert!(!out.deleted);
        assert!(out.refusal.as_deref().unwrap().contains("not fully merged"));
        assert_eq!(out.hash, c2);
        let hashes: Vec<&str> = out.unmerged.iter().map(|c| c.hash.as_str()).collect();
        assert_eq!(hashes, [c2.as_str(), c1.as_str()]);
        assert!(!out.unmerged_more);
        assert!(branch_names(d).contains(&"work".to_string()));
        // Force needs the shown tip; a moved branch is a 409 that deletes nothing.
        validation(delete_branch(s(d), "work", true, None));
        validation(delete_branch(s(d), "work", true, Some("ABC")));
        let moved = conflict(delete_branch(s(d), "work", true, Some(&c1)));
        assert!(
            moved.contains(
                "moved since the delete was confirmed. It was reloaded; nothing was deleted."
            ),
            "{moved}"
        );
        assert!(branch_names(d).contains(&"work".to_string()));
        let out = delete_branch(s(d), "work", true, Some(&c2)).unwrap();
        assert!(out.deleted && out.refusal.is_none() && out.unmerged.is_empty());
        assert_eq!(out.hash, c2);
        assert!(!branch_names(d).contains(&"work".to_string()));
        drop(linked);
    }

    #[test]
    fn unmerged_commits_are_those_on_no_other_ref() {
        let (main, linked) = with_linked();
        let d = main.path();
        let w = lp(&linked);
        g(d, &["switch", "-q", "-c", "topic"]);
        let only = commit(d, "only.txt", "1\n", "only on topic");
        let on_branch = commit(d, "ob.txt", "1\n", "also on a branch");
        g(d, &["branch", "keeper", "HEAD"]);
        let on_tag = commit(d, "ot.txt", "1\n", "also on a tag");
        g(d, &["tag", "t-keep", "HEAD"]);
        let detached = commit(d, "od.txt", "1\n", "also another worktree's HEAD");
        g(&w, &["checkout", "-q", "--detach", &detached]);
        let top = commit(d, "top.txt", "1\n", "only on topic too");
        g(d, &["switch", "-q", "main"]);
        let out = delete_branch(s(d), "topic", false, None).unwrap();
        assert!(!out.deleted);
        let got: Vec<&str> = out.unmerged.iter().map(|c| c.hash.as_str()).collect();
        // `top` is only on topic; `detached` is held by the linked worktree's
        // detached HEAD (so `top` is the one commit past it), `on_tag` by the
        // tag, `on_branch` by `keeper`, and `only` is below `on_branch`.
        assert_eq!(
            got,
            [top.as_str()],
            "{got:?} only={only} ob={on_branch} ot={on_tag}"
        );
        // Free the detached commit: it and the tag-only commits drop out/in.
        g(&w, &["checkout", "-q", "other"]);
        g(d, &["tag", "-d", "t-keep"]);
        let out = delete_branch(s(d), "topic", false, None).unwrap();
        let got: Vec<&str> = out.unmerged.iter().map(|c| c.hash.as_str()).collect();
        assert_eq!(got, [top.as_str(), detached.as_str(), on_tag.as_str()]);
    }

    #[test]
    fn unmerged_list_is_capped_at_fifty_with_more() {
        let main = repo();
        let d = main.path();
        g(d, &["switch", "-q", "-c", "big"]);
        for i in 0..52 {
            g(
                d,
                &["commit", "-q", "--allow-empty", "-m", &format!("c{i}")],
            );
        }
        g(d, &["switch", "-q", "main"]);
        let out = delete_branch(s(d), "big", false, None).unwrap();
        assert!(!out.deleted);
        assert_eq!(out.unmerged.len(), 50);
        assert!(out.unmerged_more);
    }

    #[test]
    fn stash_push_with_and_without_untracked_message_and_nothing_to_stash() {
        let main = repo();
        let d = main.path();
        assert_eq!(
            stash_push(s(d), None, false).unwrap().as_deref(),
            Some("No local changes to stash.")
        );
        assert_eq!(stash_count(d), 0);
        std::fs::write(d.join("a.txt"), "changed\n").unwrap();
        std::fs::write(d.join("u.txt"), "untracked\n").unwrap();
        assert_eq!(stash_push(s(d), Some("-my msg"), false), Ok(None));
        assert_eq!(stash_count(d), 1);
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "a\n");
        assert!(d.join("u.txt").exists(), "untracked stays without -u");
        let st = &stashes_of(s(d)).unwrap()[0];
        assert_eq!(st.message, "-my msg");
        // Only an untracked file: nothing to stash without -u, an entry with it.
        assert_eq!(
            stash_push(s(d), None, false).unwrap().as_deref(),
            Some("No local changes to stash.")
        );
        assert_eq!(stash_push(s(d), None, true), Ok(None));
        assert_eq!(stash_count(d), 2);
        assert!(!d.join("u.txt").exists());
        // The message rules.
        assert_eq!(check_stash_message("  hi  \n"), Ok(Some("hi".into())));
        assert_eq!(check_stash_message(" \n\t"), Ok(None));
        assert!(check_stash_message("a\nb").is_err());
        assert!(check_stash_message("a\u{7}b").is_err());
        assert!(check_stash_message(&"x".repeat(201)).is_err());
        assert!(check_stash_message(&"x".repeat(200)).is_ok());
        // Unborn HEAD: git refuses, nothing recorded.
        let empty = bare();
        std::fs::write(empty.path().join("f"), "x").unwrap();
        conflict(stash_push(s(empty.path()), None, true));
    }

    #[test]
    fn stash_apply_pop_and_drop_check_the_entry_and_act_in_this_worktree() {
        let (main, linked) = with_linked();
        let d = main.path();
        let w = lp(&linked);
        std::fs::write(d.join("a.txt"), "one\n").unwrap();
        stash_push(s(d), Some("first"), false).unwrap();
        std::fs::write(d.join("a.txt"), "two\n").unwrap();
        stash_push(s(d), Some("second"), false).unwrap();
        let list = stashes_of(s(d)).unwrap();
        assert_eq!(list.len(), 2);
        // The list is shared; apply acts on the worktree it is given.
        assert_eq!(
            stashes_of(s(&w))
                .unwrap()
                .iter()
                .map(|x| &x.hash)
                .collect::<Vec<_>>(),
            list.iter().map(|x| &x.hash).collect::<Vec<_>>()
        );
        assert_eq!(
            stash_entry_op(s(&w), StashOp::Apply, 1, &list[1].hash),
            Ok(None)
        );
        assert_eq!(std::fs::read_to_string(w.join("a.txt")).unwrap(), "one\n");
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "a\n");
        assert_eq!(stash_count(d), 2, "apply keeps the entry");
        // A stale hash or a missing index runs nothing.
        let e = conflict(stash_entry_op(s(d), StashOp::Drop, 0, &list[1].hash));
        assert_eq!(
            e,
            "The stash list changed since it was shown. It was reloaded; nothing was dropped."
        );
        let e = conflict(stash_entry_op(
            s(d),
            StashOp::Pop,
            0,
            "0".repeat(40).as_str(),
        ));
        assert!(e.ends_with("nothing was applied."), "{e}");
        assert!(matches!(
            stash_entry_op(s(d), StashOp::Drop, 5, &list[0].hash),
            Err(RefErr::NotFound(_))
        ));
        assert_eq!(stash_count(d), 2);
        // Pop applies and removes; drop removes.
        g(&w, &["checkout", "-q", "--", "a.txt"]);
        assert_eq!(
            stash_entry_op(s(d), StashOp::Pop, 0, &list[0].hash),
            Ok(None)
        );
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "two\n");
        assert_eq!(stash_count(d), 1);
        assert_eq!(
            stash_entry_op(s(d), StashOp::Drop, 0, &list[1].hash),
            Ok(None)
        );
        assert_eq!(stash_count(d), 0);
        // Without --index: a staged change comes back unstaged.
        std::fs::write(d.join("a.txt"), "staged\n").unwrap();
        g(d, &["add", "a.txt"]);
        stash_push(s(d), None, false).unwrap();
        let h = stashes_of(s(d)).unwrap()[0].hash.clone();
        assert_eq!(stash_entry_op(s(d), StashOp::Pop, 0, &h), Ok(None));
        assert_eq!(g(d, &["diff", "--cached", "--name-only"]), "");
        assert_eq!(g(d, &["diff", "--name-only"]), "a.txt");
    }

    #[test]
    fn a_conflicting_pop_keeps_the_stash_and_reports_gits_text() {
        let main = repo();
        let d = main.path();
        std::fs::write(d.join("a.txt"), "stashed\n").unwrap();
        stash_push(s(d), None, false).unwrap();
        commit(d, "a.txt", "committed\n", "diverge");
        let h = stashes_of(s(d)).unwrap()[0].hash.clone();
        let e = conflict(stash_entry_op(s(d), StashOp::Pop, 0, &h));
        // git prints the conflict on STDOUT; it must be in the error.
        assert!(e.contains("CONFLICT"), "{e}");
        assert!(e.contains("a.txt"), "{e}");
        assert_eq!(stash_count(d), 1, "the stash is kept");
        let view = view_of(s(d)).unwrap();
        let f = view.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert!(is_conflicted(f), "{f:?}");
        // The same through apply.
        g(d, &["checkout", "-q", "HEAD", "--", "a.txt"]);
        let e = conflict(stash_entry_op(s(d), StashOp::Apply, 0, &h));
        assert!(e.contains("CONFLICT"), "{e}");
        assert_eq!(stash_count(d), 1);
    }

    #[test]
    fn apply_and_pop_are_refused_during_an_operation_but_drop_is_not() {
        let main = repo();
        let d = main.path();
        std::fs::write(d.join("a.txt"), "stashed\n").unwrap();
        stash_push(s(d), None, false).unwrap();
        let h = stashes_of(s(d)).unwrap()[0].hash.clone();
        g(d, &["branch", "side"]);
        g(d, &["switch", "-q", "side"]);
        commit(d, "a.txt", "side\n", "side");
        g(d, &["switch", "-q", "main"]);
        commit(d, "a.txt", "main\n", "main");
        let _ = Command::new("git")
            .args(["-C", s(d), "merge", "side"])
            .output()
            .unwrap();
        let e = validation(stash_entry_op(s(d), StashOp::Apply, 0, &h));
        assert!(e.contains("A merge is in progress in this worktree; applying a stash is not available. Finish or abort it in the terminal."), "{e}");
        validation(stash_entry_op(s(d), StashOp::Pop, 0, &h));
        assert_eq!(stash_count(d), 1);
        assert_eq!(stash_entry_op(s(d), StashOp::Drop, 0, &h), Ok(None));
        assert_eq!(stash_count(d), 0);
    }

    #[test]
    fn a_held_index_lock_stays_and_the_write_fails() {
        let main = repo();
        let d = main.path();
        g(d, &["branch", "feat"]);
        std::fs::write(d.join("a.txt"), "dirty\n").unwrap();
        let lock = d.join(".git/index.lock");
        std::fs::write(&lock, "held").unwrap();
        let e = conflict(stash_push(s(d), None, false));
        assert!(e.contains("index.lock"), "{e}");
        conflict(switch_branch(s(d), "feat", false));
        assert!(lock.exists(), "the lock is never removed");
        assert_eq!(std::fs::read_to_string(&lock).unwrap(), "held");
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "dirty\n");
    }

    #[test]
    fn saved_note_is_appended_only_when_an_entry_was_saved() {
        assert_eq!(saved_note("boom".into(), false), "boom");
        assert_eq!(
            saved_note("boom".into(), true),
            "boom\nA stash entry was saved (stash@{0}); your changes are in it."
        );
    }

    #[test]
    fn a_siblings_stash_is_not_mistaken_for_ours() {
        let (main, linked) = with_linked();
        let d = main.path();
        let w = lp(&linked);
        // Our push finds nothing to stash while the sibling (another HEAD)
        // stashed in between: simulate by stashing there first, then ours.
        commit(&w, "w.txt", "w\n", "linked moves");
        std::fs::write(w.join("w.txt"), "dirty\n").unwrap();
        let before = stash_state(s(d));
        g(&w, &["stash", "push", "-q"]);
        assert!(
            !own_stash_made(s(d), &before, None),
            "sibling's entry on another HEAD"
        );
        // A real push of ours is recognised, and the marker is honoured.
        let before = stash_state(s(d));
        std::fs::write(d.join("a.txt"), "mine\n").unwrap();
        g(
            d,
            &["stash", "push", "-q", "-m", "naru: before switching to x"],
        );
        assert!(own_stash_made(s(d), &before, None));
        assert!(own_stash_made(s(d), &before, Some("before switching to x")));
        assert!(!own_stash_made(s(d), &before, Some("something else")));
    }

    #[test]
    fn stash_ops_address_the_entry_by_hash_not_by_position() {
        let (main, linked) = with_linked();
        let d = main.path();
        let w = lp(&linked);
        std::fs::write(d.join("a.txt"), "first\n").unwrap();
        stash_push(s(d), Some("first"), false).unwrap();
        let shown = stashes_of(s(d)).unwrap()[0].clone();
        assert_eq!(shown.index, 0);
        // A sibling worktree stashes: indexes shift under the shown list.
        commit(&w, "w.txt", "w\n", "linked moves");
        std::fs::write(w.join("w.txt"), "sibling\n").unwrap();
        g(&w, &["stash", "push", "-q", "-m", "sibling"]);
        let now = stashes_of(s(d)).unwrap();
        assert_eq!(
            (now[0].message.as_str(), now[1].hash.as_str()),
            ("sibling", shown.hash.as_str())
        );
        // The stale index with the right hash is refused; nothing runs.
        for op in [StashOp::Apply, StashOp::Pop, StashOp::Drop] {
            conflict(stash_entry_op(s(d), op, 0, &shown.hash));
        }
        assert_eq!(stash_count(d), 2);
        assert_eq!(g(d, &["status", "--porcelain"]), "");
        // With the current index the by-hash apply applies OUR content.
        assert_eq!(
            stash_entry_op(s(d), StashOp::Apply, 1, &shown.hash),
            Ok(None)
        );
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "first\n");
        g(d, &["checkout", "-q", "--", "a.txt"]);
        // Pop drops exactly the popped entry, leaving the sibling's.
        assert_eq!(stash_entry_op(s(d), StashOp::Pop, 1, &shown.hash), Ok(None));
        let left = stashes_of(s(d)).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].message, "sibling");
        // Drop of an entry that is gone is a 409; the sibling's stays.
        let gone = conflict(stash_entry_op(s(d), StashOp::Drop, 0, &shown.hash));
        assert!(gone.ends_with("nothing was dropped."), "{gone}");
        assert_eq!(stash_count(d), 1);
    }

    #[test]
    fn a_hung_post_checkout_hook_is_stopped_at_the_timeout() {
        let main = repo();
        let d = main.path();
        g(d, &["branch", "feat"]);
        hook(d, "post-checkout", "echo hook-output >&2\nsleep 30");
        let start = Instant::now();
        let e = run_ref_write_within(
            s(d),
            &["switch", "--no-guess", "feat"],
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(start.elapsed() < Duration::from_secs(15));
        assert!(
            e.starts_with(
                "git switch did not finish within 1 s and was stopped. Nothing was retried."
            ),
            "{e}"
        );
        assert!(e.contains("hook-output"), "{e}");
    }

    #[test]
    fn run_ref_write_returns_stderr_then_stdout_and_never_prompts() {
        let main = repo();
        let d = main.path();
        let e = run_ref_write(s(d), &["switch", "--no-guess", "nosuch"]).unwrap_err();
        assert!(e.contains("nosuch"), "{e}");
        // LC_ALL=C: git's wording is the English one the matcher expects.
        g(d, &["switch", "-q", "-c", "u"]);
        commit(d, "u.txt", "u\n", "u");
        g(d, &["switch", "-q", "main"]);
        let e = run_ref_write(s(d), &["branch", "-d", "u"]).unwrap_err();
        assert!(e.contains("not fully merged"), "{e}");
        let _ = msg_of(RefErr::Conflict(e));
    }

    #[test]
    fn no_git_argv_in_production_code_pushes_pulls_fetches_or_rewrites() {
        let verb =
            regex::Regex::new(r#"\[\s*(?:"-C",\s*[A-Za-z_.&]+,\s*)?"([a-z][a-z-]*)""#).unwrap();
        let sources = [
            ("src/core/git.rs", include_str!("git.rs")),
            ("src/api.rs", include_str!("../api.rs")),
        ];
        let forbidden = [
            "push",
            "pull",
            "fetch",
            "merge",
            "rebase",
            "reset",
            "clone",
            "checkout",
            "cherry-pick",
            "revert",
            "am",
            "gc",
            "prune",
            "restore-all",
        ];
        let mut seen: Vec<String> = Vec::new();
        let mut remote_touching_git_commands = 0;
        for (name, text) in sources {
            // Production code only: everything before the first test module.
            let prod = text.split("#[cfg(test)]").next().unwrap();
            for cap in verb.captures_iter(prod) {
                let v = cap[1].to_string();
                assert!(
                    !forbidden.contains(&v.as_str()),
                    "{name} builds a git argv starting with {v:?}"
                );
                if v == "remote" {
                    remote_touching_git_commands += 1;
                }
                seen.push(v);
            }
            for flag in [
                "\"--discard-changes\"",
                "\"--force\"",
                "\"--force-with-lease\"",
            ] {
                assert!(!prod.contains(flag), "{name} passes {flag}");
            }
            // `-f` is only ever clean's / rm's own flag, never switch's or checkout's.
            for line in prod.lines().filter(|l| l.contains("\"-f\"")) {
                assert!(
                    line.contains("\"clean\"") || line.contains("\"rm\""),
                    "{name}: {line}"
                );
            }
        }
        // Honest, not vacuous: the scan saw the verbs we know are there.
        for known in [
            "stash",
            "switch",
            "branch",
            "status",
            "for-each-ref",
            "commit",
            "log",
        ] {
            assert!(seen.iter().any(|v| v == known), "scan never saw {known:?}");
        }
        // The one `git remote` is the read-only listing in `remotes_of`; the
        // remote-writing forms (`remote add|remove|set-url`) need more argv.
        assert_eq!(remote_touching_git_commands, 1);
        let prod = include_str!("git.rs").split("#[cfg(test)]").next().unwrap();
        assert!(prod.contains(".args([\"-C\", dir, \"remote\"])"));
    }
}
