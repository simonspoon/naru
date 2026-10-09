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
