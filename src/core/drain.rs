//! The drain flag `naru self-deploy` raises (naru task 2035).
//!
//! A marker file `<naru home>/drain` holding a unix-seconds expiry. While it
//! is in the future the todo-watcher claims no new task; an expired or
//! unreadable marker reads as "not draining", so a crashed deploy releases
//! the watcher by itself. File, not db: it must be settable with no server
//! running and survive the restart it brackets. See `docs/self-deploy.md`.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::config;
use super::store::{Error, Result};

/// Longest a drain may be raised for, seconds.
pub const MAX_TTL_SECS: u64 = 6 * 3600;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn marker() -> PathBuf {
    let home = directories::BaseDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .unwrap_or_default();
    config::dot_dir_in(&home).join("drain")
}

/// Raise the flag for `ttl_secs` (1..=[`MAX_TTL_SECS`]); returns the expiry.
pub fn set(ttl_secs: u64) -> Result<u64> {
    if ttl_secs == 0 || ttl_secs > MAX_TTL_SECS {
        return Err(Error::Validation(format!(
            "drain ttl must be 1..={MAX_TTL_SECS} seconds"
        )));
    }
    let expiry = now() + ttl_secs;
    let path = marker();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Error::Validation(e.to_string()))?;
    }
    std::fs::write(&path, expiry.to_string()).map_err(|e| Error::Validation(e.to_string()))?;
    Ok(expiry)
}

/// Lower the flag; a missing marker is fine.
pub fn clear() {
    let _ = std::fs::remove_file(marker());
}

/// Seconds of drain left, `None` when not draining.
pub fn remaining() -> Option<u64> {
    let expiry: u64 = std::fs::read_to_string(marker())
        .ok()?
        .trim()
        .parse()
        .ok()?;
    expiry.checked_sub(now()).filter(|s| *s > 0)
}

/// Whether the watcher must withhold new claims.
pub fn active() -> bool {
    remaining().is_some()
}

/// The pause marker `naru queue pause` writes (naru task 2038): unlike the
/// drain it has no expiry, so it holds across restarts until `queue resume`.
fn pause_marker() -> PathBuf {
    marker().with_file_name("queue-paused")
}

/// Pause (`true`) or resume (`false`) the todo-watcher's dispatch; idempotent.
pub fn set_paused(paused: bool) -> Result<()> {
    let path = pause_marker();
    if paused {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::Validation(e.to_string()))?;
        }
        std::fs::write(&path, b"").map_err(|e| Error::Validation(e.to_string()))
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::Validation(e.to_string())),
        }
    }
}

/// Whether `naru queue pause` is in force.
pub fn paused() -> bool {
    pause_marker().exists()
}
