//! Project run profiles (naru task 2647, `docs/run-profile.md`): when a
//! queued task lands with a commit, the queue watcher restarts the project's
//! long-running dev server and checks it is healthy, so the landed code is
//! the code being served.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::store::{Error, Result};
use super::types::{Project, RunProfile};

/// How long the health URL is polled for a 2xx after the restart starts.
pub const HEALTH_WAIT: Duration = Duration::from_secs(30);

/// [`HEALTH_WAIT`], or `MESA_RUN_HEALTH_WAIT_MS` / `NARU_…` — a test-only
/// seam like `MESA_WATCH_TODO_TICK_MS`, so a gate can watch a failing health
/// check without waiting the full half minute. Unit tests wait longer
/// (naru task 2701): a starved machine can take more than half a minute to
/// start the test's server, and only a healthy restart waits the whole time.
fn health_wait() -> Duration {
    let default = if cfg!(test) {
        HEALTH_WAIT * 4
    } else {
        HEALTH_WAIT
    };
    super::env::var("RUN_HEALTH_WAIT_MS")
        .and_then(|v| v.parse().ok())
        .map_or(default, Duration::from_millis)
}
/// Probes start once the command has exited 0. One still running after this
/// long is taken to be the server itself, and probes start anyway. The old
/// server it replaces must be gone by then, or it answers for the new one.
const HEALTH_WHILE_RUNNING: Duration = Duration::from_secs(5);
const HEALTH_EVERY: Duration = Duration::from_millis(500);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Text in a restart command or health URL that means the person's real
/// install (`docs/dev-env.md` "Never touch"): a run profile never restarts it.
const REAL_INSTALL: &[&str] = &[
    "com.naru.",
    "com.mesa.",
    "install.sh",
    "self-deploy",
    ".local/bin/naru",
    ".local/bin/mesa",
    "/Applications/Naru.app",
    ":7777",
    ":7870",
];

/// The real-install marker `text` contains, if any.
fn real_install_marker(text: &str) -> Option<&'static str> {
    REAL_INSTALL.iter().copied().find(|m| text.contains(m))
}

/// Applies a [`crate::core::ProjectPatch`]'s run-profile fields to `current`
/// — the one place they are validated.
pub fn patched(
    current: Option<RunProfile>,
    restart: &Option<Option<String>>,
    dir: &Option<Option<String>>,
    health: &Option<Option<String>>,
) -> Result<Option<RunProfile>> {
    let mut profile = match restart {
        Some(None) if dir.is_some() || health.is_some() => {
            return Err(Error::Validation(
                "--run-restart \"\" removes the whole run profile; pass it alone".into(),
            ));
        }
        Some(None) => return Ok(None),
        Some(Some(cmd)) => {
            if cmd.trim().is_empty() {
                return Err(Error::Validation(
                    "run restart command must not be empty".into(),
                ));
            }
            Some(RunProfile {
                restart: cmd.clone(),
                ..current.unwrap_or(RunProfile {
                    restart: String::new(),
                    dir: None,
                    health: None,
                })
            })
        }
        None => current,
    };
    if dir.is_some() || health.is_some() {
        let Some(p) = profile.as_mut() else {
            return Err(Error::Validation(
                "this project has no run profile: set --run-restart first".into(),
            ));
        };
        if let Some(d) = dir {
            p.dir = d.clone();
        }
        if let Some(h) = health {
            if let Some(url) = h
                && !(url.starts_with("http://") || url.starts_with("https://"))
            {
                return Err(Error::Validation(format!(
                    "run health URL must start with http:// or https://, got {url:?}"
                )));
            }
            p.health = h.clone();
        }
    }
    if let Some(p) = &profile {
        let text = format!("{} {}", p.restart, p.health.as_deref().unwrap_or(""));
        if let Some(m) = real_install_marker(&text) {
            return Err(Error::Validation(format!(
                "a run profile never touches the real Naru install ({m:?}); \
                 point it at a dev environment (docs/dev-env.md)"
            )));
        }
    }
    Ok(profile)
}

/// Where a project's restart output goes: `logs/run-<project id>.log` in
/// Naru's home directory.
pub fn log_path(project_id: i64) -> Option<PathBuf> {
    let dirs = directories::BaseDirs::new()?;
    Some(
        super::config::dot_dir_in(dirs.home_dir())
            .join("logs")
            .join(format!("run-{project_id}.log")),
    )
}

/// Runs `project`'s restart command detached (its own process group, stdin
/// null, output appended to `log`, normally [`log_path`]), then waits for the health URL to
/// answer 2xx for up to [`HEALTH_WAIT`]. Blocks for that long, so the caller
/// runs it off any lock. Returns one sentence for the landing result:
/// `restarted, healthy (…)`, or what failed.
pub fn restart(project: &Project, log: Option<PathBuf>) -> String {
    let Some(profile) = &project.run_profile else {
        return "no run profile".to_string();
    };
    let text = format!(
        "{} {}",
        profile.restart,
        profile.health.as_deref().unwrap_or("")
    );
    if let Some(m) = real_install_marker(&text) {
        return format!("not restarted: the run profile names the real install ({m:?})");
    }
    let Some(dir) = profile.dir.clone().or_else(|| project.local_path.clone()) else {
        return "not restarted: no run dir and no project folder".to_string();
    };
    let out = log.as_ref().and_then(|p| {
        std::fs::create_dir_all(p.parent()?).ok()?;
        let mut f = OpenOptions::new().create(true).append(true).open(p).ok()?;
        let _ = writeln!(
            f,
            "--- {} restart: {}",
            super::cc::fmt_store_ts(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0)
            ),
            profile.restart
        );
        Some(f)
    });
    let (stdout, stderr) = match out.and_then(|f| Some((f.try_clone().ok()?, f))) {
        Some((a, b)) => (Stdio::from(a), Stdio::from(b)),
        None => (Stdio::null(), Stdio::null()),
    };
    let mut cmd = Command::new("bash");
    cmd.arg("-c")
        .arg(&profile.restart)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    let mut child = match super::proc::isolate(&mut cmd).spawn() {
        Ok(c) => c,
        Err(e) => return format!("restart failed to start in {dir}: {e}"),
    };
    let start = Instant::now();
    let wait = health_wait();
    let mut exited_ok = false;
    let verdict = loop {
        // A command that has already failed is the answer, health or not.
        if !exited_ok && let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                break format!(
                    "restart command exited {}{}",
                    status
                        .code()
                        .map_or("by signal".to_string(), |c| c.to_string()),
                    log.as_ref()
                        .map(|p| format!(" (log: {})", p.display()))
                        .unwrap_or_default()
                );
            }
            exited_ok = true;
        }
        let Some(url) = &profile.health else {
            if exited_ok || start.elapsed() >= HEALTH_WHILE_RUNNING {
                break "restarted (no health URL to check)".to_string();
            }
            std::thread::sleep(HEALTH_EVERY);
            continue;
        };
        if exited_ok || start.elapsed() >= HEALTH_WHILE_RUNNING {
            match probe(url) {
                Ok(code) if (200..300).contains(&code) => {
                    break format!("restarted, healthy (HTTP {code} from {url})");
                }
                last if start.elapsed() >= wait => {
                    let why = match last {
                        Ok(code) => format!("HTTP {code}"),
                        Err(e) => e,
                    };
                    break format!(
                        "restarted, but {url} was not healthy after {:.1}s: {why}",
                        wait.as_secs_f64()
                    );
                }
                _ => {}
            }
        }
        std::thread::sleep(HEALTH_EVERY);
    };
    // Reap it whenever it ends (a restart command may be the server itself).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    verdict
}

fn probe(url: &str) -> std::result::Result<u16, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(PROBE_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .build()
        .into();
    agent
        .get(url)
        .call()
        .map(|r| r.status().as_u16())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some(s: &str) -> Option<Option<String>> {
        Some(Some(s.to_string()))
    }

    #[test]
    fn patched_sets_clears_and_validates() {
        let p = patched(
            None,
            &some("./serve.sh"),
            &None,
            &some("http://127.0.0.1:1/h"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(p.restart, "./serve.sh");
        assert_eq!(p.health.as_deref(), Some("http://127.0.0.1:1/h"));
        // Changing the command keeps the rest.
        let p2 = patched(Some(p.clone()), &some("./b.sh"), &None, &None)
            .unwrap()
            .unwrap();
        assert_eq!(p2.health, p.health);
        assert!(
            patched(Some(p.clone()), &Some(None), &None, &None)
                .unwrap()
                .is_none()
        );
        let cleared = patched(Some(p), &None, &None, &Some(None))
            .unwrap()
            .unwrap();
        assert_eq!(cleared.health, None);
        for bad in [
            patched(None, &None, &some("/tmp"), &None),
            patched(None, &Some(None), &some("/tmp"), &None),
            patched(None, &some(" "), &None, &None),
            patched(None, &some("x"), &None, &some("127.0.0.1:1")),
            patched(
                None,
                &some("launchctl kickstart gui/1/com.naru.serve"),
                &None,
                &None,
            ),
            patched(None, &some("x"), &None, &some("http://127.0.0.1:7777/")),
        ] {
            assert!(matches!(bad, Err(Error::Validation(_))), "{bad:?}");
        }
    }

    fn project(dir: &std::path::Path, restart: &str, health: Option<String>) -> Project {
        Project {
            id: 999_000,
            name: "p".into(),
            description: None,
            root_commit: None,
            local_path: Some(dir.to_string_lossy().into_owned()),
            archived: false,
            sort_order: 0.0,
            parent_id: None,
            shared_notebook: false,
            previous_paths: vec![],
            run_profile: Some(RunProfile {
                restart: restart.into(),
                dir: None,
                health,
            }),
        }
    }

    #[test]
    fn restart_reports_healthy_and_failures() {
        let dir = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let url = format!("http://127.0.0.1:{port}/");
        let log = Some(dir.path().join("logs/run.log"));
        // A detached server the command starts and leaves running.
        let cmd = format!(
            "python3 -m http.server {port} --bind 127.0.0.1 >/dev/null 2>&1 & echo $! > pid"
        );
        let got = restart(&project(dir.path(), &cmd, Some(url.clone())), log.clone());
        assert_eq!(got, format!("restarted, healthy (HTTP 200 from {url})"));
        let pid = std::fs::read_to_string(dir.path().join("pid")).unwrap();
        let _ = Command::new("kill").arg(pid.trim()).status();

        let got = restart(
            &project(dir.path(), "exit 3", Some(url.clone())),
            log.clone(),
        );
        assert!(got.starts_with("restart command exited 3"), "{got}");
        let got = restart(&project(dir.path(), "true", None), log.clone());
        assert_eq!(got, "restarted (no health URL to check)");
        let logged = std::fs::read_to_string(dir.path().join("logs/run.log")).unwrap();
        assert_eq!(logged.matches("restart: ").count(), 3, "{logged}");
    }
}
