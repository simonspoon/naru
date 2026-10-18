//! The few process-control primitives the spawn sites share, so each of them
//! stays one line and the platform split lives in one place.
//!
//! Unix: a child is put in a process group of its own (`process_group(0)`) and
//! a group is signalled with `kill -<sig> -- -<pgid>`. Windows: a child gets
//! `CREATE_NEW_PROCESS_GROUP` and a tree is ended with `taskkill /F /T`. A
//! job object would contain descendants more strictly, but needs `windows-sys`
//! and `unsafe`; `taskkill /T` walks the parent links, so a descendant that has
//! been re-parented escapes it.

use std::process::{Command, Stdio};

/// Puts the child `cmd` will spawn in a process group of its own.
pub fn isolate(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP)
    }
}

/// A `bash` command. Unix: plain `bash`, found on `PATH`. Windows: `bash` on
/// `PATH` is usually WSL's `C:\Windows\System32\bash.exe`, which runs inside
/// a Linux VM, so Git for Windows' bash is resolved explicitly, once:
/// `NARU_BASH` (or `MESA_BASH`), the bash beside `git.exe` on `PATH`, a
/// standard Git for Windows install, and last plain `bash`.
pub fn bash() -> Command {
    #[cfg(unix)]
    {
        // Every shell step gets the toolchain dirs, even when the server was
        // started without them (launchd, a bare shell).
        let mut c = Command::new("bash");
        augment_path(&mut c);
        c
    }
    #[cfg(windows)]
    {
        static BASH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
        Command::new(BASH.get_or_init(windows_bash))
    }
}

/// `inherited` with the toolchain bin dirs that exist (cargo, homebrew,
/// `~/.local/bin`, pnpm) put in front, each once. The inherited entries are
/// all kept, so nothing the caller had on `PATH` is lost.
fn toolchain_path(
    home: Option<&std::path::Path>,
    pnpm_home: Option<std::path::PathBuf>,
    inherited: Option<std::ffi::OsString>,
) -> Option<std::ffi::OsString> {
    use std::path::PathBuf;
    let mut wanted: Vec<PathBuf> = Vec::new();
    if let Some(h) = home {
        wanted.push(h.join(".cargo/bin"));
    }
    wanted.push("/opt/homebrew/bin".into());
    wanted.push("/opt/homebrew/sbin".into());
    wanted.push("/usr/local/bin".into());
    if let Some(h) = home {
        wanted.push(h.join(".local/bin"));
    }
    if let Some(p) = pnpm_home.or_else(|| home.map(|h| h.join("Library/pnpm"))) {
        wanted.push(p);
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for d in wanted {
        if d.is_dir() && !out.contains(&d) {
            out.push(d);
        }
    }
    if let Some(p) = &inherited {
        for d in std::env::split_paths(p) {
            if !out.contains(&d) {
                out.push(d);
            }
        }
    }
    std::env::join_paths(out).ok()
}

/// Gives the child `cmd` will spawn the toolchain dirs on its `PATH`, so an
/// agent run by a server that was started without `~/.cargo/bin` (launchd, a
/// bare shell) can still run `cargo`.
pub fn augment_path(cmd: &mut Command) -> &mut Command {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let pnpm = std::env::var_os("PNPM_HOME").map(std::path::PathBuf::from);
    if let Some(p) = toolchain_path(home.as_deref(), pnpm, std::env::var_os("PATH")) {
        cmd.env("PATH", p);
    }
    cmd
}

#[cfg(windows)]
fn windows_bash() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Some(p) = crate::core::env::var("BASH").filter(|v| !v.is_empty()) {
        return PathBuf::from(p);
    }
    let from_git = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("git.exe"))
            .filter(|git| git.is_file())
            .find_map(|git| git_bash_for(&git))
    });
    if let Some(p) = from_git {
        return p;
    }
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Programs"));
    [program_files, local]
        .into_iter()
        .flatten()
        .map(|base| base.join("Git").join("bin").join("bash.exe"))
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("bash"))
}

/// Git for Windows' `<root>\bin\bash.exe` for a `git.exe` at `<root>\cmd`,
/// `<root>\bin` or `<root>\mingw64\bin`, when it exists.
#[cfg(windows)]
fn git_bash_for(git: &std::path::Path) -> Option<std::path::PathBuf> {
    let name = |p: &std::path::Path| p.file_name()?.to_str().map(str::to_ascii_lowercase);
    let mut root = git.parent()?;
    if name(root)? == "bin" && name(root.parent()?).as_deref() == Some("mingw64") {
        root = root.parent()?;
    }
    if !matches!(name(root)?.as_str(), "cmd" | "bin" | "mingw64") {
        return None;
    }
    let bash = root.parent()?.join("bin").join("bash.exe");
    bash.is_file().then_some(bash)
}

/// Signals the whole group `pgid` leads (`sig` is a `kill` signal name such as
/// `KILL` or `TERM`). On Windows there is no signal choice: the tree is ended.
pub fn signal_group(pgid: i64, sig: &str) {
    #[cfg(unix)]
    let mut cmd = {
        let mut c = Command::new("kill");
        c.args([&format!("-{sig}"), "--", &format!("-{pgid}")]);
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        let _ = sig;
        let mut c = Command::new("taskkill");
        c.args(["/F", "/T", "/PID", &pgid.to_string()]);
        c
    };
    let _ = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// The command line of `pid`, `None` when it cannot be read.
#[cfg(windows)]
pub fn pid_command(pid: i64) -> Option<String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let pid = Pid::from_u32(u32::try_from(pid).ok()?);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let cmd = sys
        .process(pid)?
        .cmd()
        .iter()
        .map(|a| a.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    (!cmd.is_empty()).then_some(cmd)
}

/// Whether `pid` names a live process; a failure to ask reads as alive.
#[cfg(windows)]
pub fn pid_alive(pid: i64) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let Ok(pid) = u32::try_from(pid) else {
        return true;
    };
    let pid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    sys.process(pid).is_some()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn git_bash_is_found_from_each_git_exe_location() {
        let root = std::env::temp_dir().join(format!("naru-gitroot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["bin", "cmd", "mingw64/bin"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let bash = root.join("bin").join("bash.exe");
        for d in ["cmd", "bin", "mingw64/bin"] {
            assert_eq!(git_bash_for(&root.join(d).join("git.exe")), None);
        }
        std::fs::write(&bash, b"").unwrap();
        for d in ["cmd", "bin", "mingw64/bin"] {
            assert_eq!(
                git_bash_for(&root.join(d).join("git.exe")),
                Some(bash.clone())
            );
        }
        assert_eq!(git_bash_for(&root.join("other").join("git.exe")), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(all(test, unix))]
mod path_tests {
    use super::*;
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn toolchain_dirs_that_exist_lead_the_inherited_path() {
        let home = std::env::temp_dir().join(format!("naru-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".cargo/bin")).unwrap();
        let got = toolchain_path(Some(&home), None, Some(OsString::from("/a:/b"))).unwrap();
        let parts: Vec<PathBuf> = std::env::split_paths(&got).collect();
        assert_eq!(parts[0], home.join(".cargo/bin"));
        // missing dirs are skipped, inherited entries all kept in order
        assert!(!parts.contains(&home.join(".local/bin")));
        assert_eq!(
            &parts[parts.len() - 2..],
            [PathBuf::from("/a"), "/b".into()]
        );
        // an inherited entry already added in front is not repeated
        let again = toolchain_path(
            Some(&home),
            None,
            Some(std::env::join_paths([home.join(".cargo/bin"), "/a".into()]).unwrap()),
        )
        .unwrap();
        let n = std::env::split_paths(&again)
            .filter(|p| *p == home.join(".cargo/bin"))
            .count();
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn bash_command_gets_toolchain_path() {
        let mut expected = Command::new("bash");
        augment_path(&mut expected);
        let path_of = |c: &Command| {
            c.get_envs()
                .find(|(k, _)| *k == "PATH")
                .and_then(|(_, v)| v.map(|v| v.to_os_string()))
        };
        let got = path_of(&bash());
        assert!(got.is_some(), "bash() must set PATH explicitly");
        assert_eq!(got, path_of(&expected));
    }
}
