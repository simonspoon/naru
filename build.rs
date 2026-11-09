//! rust-embed's derive requires `frontend/dist` to exist at compile time,
//! even in debug builds (which read the folder from disk at runtime). The
//! folder is untracked frontend build output, so a fresh clone/worktree
//! doesn't have it — create it here so `cargo build`/`cargo test` work
//! without a manual `mkdir`.
//!
//! It also stamps the build (naru task 2655): `NARU_GIT_COMMIT` is the short
//! commit, with `-dirty` when tracked files differ from it, or `unknown` with
//! no git (a release tarball); `NARU_BUILT_AT` is the UTC build time
//! (RFC 3339). `GET /api/version` and `naru --version` report both.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let dist = root.join("frontend/dist");
    fs::create_dir_all(&dist).expect("failed to create frontend/dist for rust-embed");
    // Re-run when the folder changes or goes missing: a deleted dist is
    // recreated, and a rebuilt frontend re-embeds in release builds.
    println!("cargo:rerun-if-changed=frontend/dist");
    // Re-stamp on a source edit (the dirty flag) and on a commit, amend or
    // checkout (`logs/HEAD` gains a line for each). Not the index: any tool's
    // `git status` can rewrite it, which would recompile the crate.
    println!("cargo:rerun-if-changed=src");
    for p in ["HEAD", "logs/HEAD", "packed-refs"] {
        watch_git_path(&root, p);
    }
    if let Some(r) = git(&root, &["symbolic-ref", "-q", "HEAD"]) {
        watch_git_path(&root, &r);
    }

    let commit = match git(&root, &["rev-parse", "--short", "HEAD"]) {
        Some(sha) => {
            let dirty = git(&root, &["status", "--porcelain", "--untracked-files=no"])
                .is_some_and(|s| !s.is_empty());
            if dirty { format!("{sha}-dirty") } else { sha }
        }
        None => "unknown".to_string(),
    };
    println!("cargo:rustc-env=NARU_GIT_COMMIT={commit}");
    println!("cargo:rustc-env=NARU_BUILT_AT={}", built_at());
}

/// A git command's trimmed stdout, or `None` when git is missing or fails.
fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        // `git status` would otherwise refresh the watched index, re-running this script.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Watch a file inside the git dir (worktree-aware), only if it exists: a
/// missing rerun path would re-run this script on every build.
fn watch_git_path(root: &Path, name: &str) {
    if let Some(p) = git(root, &["rev-parse", "--git-path", name]) {
        let p = root.join(p);
        if p.exists() {
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }
}

/// Now in UTC as `YYYY-MM-DDTHH:MM:SSZ`, without a date crate.
fn built_at() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}
