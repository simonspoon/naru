//! The self-disarming handoff alarm (mesa task 1512).
//!
//! A supervisor that hands work to a subagent arms `naru alarm arm` in the
//! background: it blocks until either a `SubagentStop` hook has written a
//! marker for this session (`naru alarm disarm`, run by the `alarm-disarm`
//! library hook) or the timeout passes. The signal is the marker file's
//! mtime, so a marker older than the arm never counts. Session-scoped, not
//! agent-scoped: any subagent of the session stopping disarms. See
//! `docs/alarm.md`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::store::{Error, Result};

/// The library built-in holding [`ALARM_HOOK`]; the row's name carries its
/// extension (mesa task 1114), the id stays the bare word.
pub const ALARM_HOOK_BUILTIN: &str = "alarm-disarm";

/// The built-in's name — the filename it is seeded under in `.claude/hooks/`.
pub const ALARM_HOOK_NAME: &str = "alarm-disarm.sh";

/// The hook script: pipes the `SubagentStop` payload to `naru alarm disarm`
/// and **never wedges a session** — output discarded, always exit 0, a
/// missing `naru` is fine. `scripts/alarm-check.sh` is its gate.
pub const ALARM_HOOK: &str = r##"#!/usr/bin/env bash
# alarm-disarm.sh — a Claude Code SubagentStop hook (mesa task 1512).
# Installed with:
#   naru library hook enable alarm-disarm --event SubagentStop
#
# Hands the payload on stdin to `naru alarm disarm`, which stamps the marker
# a blocked `naru alarm arm` for this session is waiting on. It never wedges
# a session: output is discarded and it always exits 0.
naru alarm disarm >/dev/null 2>&1 || true
exit 0
"##;

/// Longest a session id may be.
const SESSION_MAX: usize = 128;

/// The file whose mtime is the signal; its content is the agent id.
const MARKER: &str = "last-stop";

/// How often `arm` looks at the marker.
const POLL: Duration = Duration::from_millis(500);

/// How an `arm` ended.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// A stop was recorded after the arm began.
    Disarmed {
        agent_id: Option<String>,
        waited: Duration,
    },
    /// The timeout passed with no stop.
    Fired,
}

/// `session_id` as a safe single path component (`[A-Za-z0-9_-]`, 1..=128);
/// it is untrusted hook input.
pub fn validate_session(session_id: &str) -> Result<&str> {
    let ok = !session_id.is_empty()
        && session_id.len() <= SESSION_MAX
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(session_id)
    } else {
        Err(Error::Validation(format!(
            "session id must be 1..={SESSION_MAX} characters of [A-Za-z0-9_-]"
        )))
    }
}

/// `<n>s|m|h` or bare integer seconds, 1s..=24h.
pub fn parse_after(s: &str) -> Result<Duration> {
    let bad = || {
        Error::Validation(format!(
            "invalid duration {s:?}: use <n>s, <n>m, <n>h or bare seconds, 1s to 24h"
        ))
    };
    let s = s.trim();
    let (digits, mult) = match s.chars().last() {
        Some('s') => (&s[..s.len() - 1], 1),
        Some('m') => (&s[..s.len() - 1], 60),
        Some('h') => (&s[..s.len() - 1], 3600),
        _ => (s, 1),
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return Err(bad());
    }
    let n: u64 = digits.parse().map_err(|_| bad())?;
    let secs = n.checked_mul(mult).ok_or_else(bad)?;
    if !(1..=86_400).contains(&secs) {
        return Err(bad());
    }
    Ok(Duration::from_secs(secs))
}

fn alarms_dir() -> PathBuf {
    match directories::BaseDirs::new() {
        Some(dirs) => alarms_in(dirs.home_dir()),
        None => PathBuf::from("."),
    }
}

fn alarms_in(home: &Path) -> PathBuf {
    super::config::dot_dir_in(home).join("alarms")
}

/// Record that a subagent of `session_id` stopped.
pub fn disarm(session_id: &str, agent_id: Option<&str>) -> Result<()> {
    disarm_in(&alarms_dir(), session_id, agent_id)
}

fn disarm_in(base: &Path, session_id: &str, agent_id: Option<&str>) -> Result<()> {
    let dir = base.join(validate_session(session_id)?);
    std::fs::create_dir_all(&dir)?;
    // Write-then-rename, so a waiting arm never reads a half-written marker.
    let tmp = dir.join(format!(".{MARKER}.{}", std::process::id()));
    std::fs::write(&tmp, agent_id.unwrap_or(""))?;
    std::fs::rename(&tmp, dir.join(MARKER))?;
    Ok(())
}

/// Block until a stop is recorded for `session_id` or `after` passes.
pub fn arm(session_id: &str, after: Duration) -> Result<Outcome> {
    arm_in(&alarms_dir(), session_id, after)
}

fn arm_in(base: &Path, session_id: &str, after: Duration) -> Result<Outcome> {
    let marker = base.join(validate_session(session_id)?).join(MARKER);
    let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    // A stop is a marker whose mtime differs from what it was when the arm
    // began (or that appeared since) — never a comparison with the wall
    // clock, which a coarse filesystem or a clock step would skew.
    let baseline = mtime(&marker);
    let started = SystemTime::now();
    let since = |t: SystemTime| t.elapsed().unwrap_or_default();
    loop {
        if let Some(m) = mtime(&marker)
            && Some(m) != baseline
        {
            let agent = std::fs::read_to_string(&marker)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            return Ok(Outcome::Disarmed {
                agent_id: agent,
                waited: since(started),
            });
        }
        let elapsed = since(started);
        if elapsed >= after {
            return Ok(Outcome::Fired);
        }
        std::thread::sleep(POLL.min(after - elapsed));
    }
}

/// A duration as the largest whole unit: `20m`, `2h`, `90s`.
pub fn format_duration(d: Duration) -> String {
    let s = d.as_secs();
    if s != 0 && s.is_multiple_of(3600) {
        format!("{}h", s / 3600)
    } else if s != 0 && s.is_multiple_of(60) {
        format!("{}m", s / 60)
    } else {
        format!("{s}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_durations() {
        assert_eq!(parse_after("20m").unwrap(), Duration::from_secs(1200));
        assert_eq!(parse_after("90").unwrap(), Duration::from_secs(90));
        assert_eq!(parse_after("2s").unwrap(), Duration::from_secs(2));
        assert_eq!(parse_after("24h").unwrap(), Duration::from_secs(86_400));
        for bad in [
            "",
            "0",
            "0s",
            "25h",
            "m",
            "-5m",
            "1.5m",
            "5x",
            "1 m",
            "99999999999999999999h",
        ] {
            assert!(parse_after(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn formats_durations() {
        assert_eq!(format_duration(Duration::from_secs(1200)), "20m");
        assert_eq!(format_duration(Duration::from_secs(90)), "90s");
        assert_eq!(format_duration(Duration::from_secs(7200)), "2h");
    }

    #[test]
    fn session_ids_are_single_components() {
        assert!(validate_session("abc-123_X").is_ok());
        for bad in ["", "../x", "a/b", "a b", ".", &"a".repeat(129)] {
            assert!(validate_session(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn disarm_after_arm_returns_disarmed() {
        let home = tempfile::tempdir().unwrap();
        let base = home.path().to_path_buf();
        let b2 = base.clone();
        let t = std::thread::spawn(move || arm_in(&b2, "s1", Duration::from_secs(30)));
        std::thread::sleep(Duration::from_millis(300));
        disarm_in(&base, "s1", Some("agent-9")).unwrap();
        match t.join().unwrap().unwrap() {
            Outcome::Disarmed { agent_id, waited } => {
                assert_eq!(agent_id.as_deref(), Some("agent-9"));
                assert!(waited < Duration::from_secs(5));
            }
            Outcome::Fired => panic!("should have disarmed"),
        }
    }

    #[test]
    fn older_marker_and_other_session_do_not_disarm() {
        let home = tempfile::tempdir().unwrap();
        disarm_in(home.path(), "s1", None).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            arm_in(home.path(), "s1", Duration::from_millis(600)).unwrap(),
            Outcome::Fired
        );
        let base = home.path().to_path_buf();
        let b2 = base.clone();
        let t = std::thread::spawn(move || arm_in(&b2, "s2", Duration::from_millis(800)));
        std::thread::sleep(Duration::from_millis(100));
        disarm_in(&base, "other", None).unwrap();
        assert_eq!(t.join().unwrap().unwrap(), Outcome::Fired);
    }
}
