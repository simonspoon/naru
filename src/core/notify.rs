//! Reaching the person's phone (mesa task 1482) through the external `vox`
//! CLI, which sends a Telegram message.
//!
//! `naru notify "<message>" [--open <route>]` shells out to
//! `vox notify --json [--title T] [--button "Open Naru=<base>/open/<route>"]
//! <message>`. Like every other shell-out in `core` (`look.rs`, `listen.rs`)
//! it is **argv, never a shell**, and `vox` is optional: a missing or
//! uninitialised binary is `unavailable`, not a crash.
//!
//! Telegram only accepts `http`/`https`/`tg` in a URL button, so the button
//! points at Naru's own `GET /open/<route>` page (`api.rs`), which bounces
//! into the iOS app's `naru://<route>` deep link. That page is reachable from
//! a phone only when `serve` runs `--lan`. See `docs/notify.md`.

use std::net::{IpAddr, UdpSocket};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

use super::store::{Error, Result};

/// The port the button's auto-detected base URL names: `serve`'s default.
const DEFAULT_PORT: u16 = 7770;

/// Longest a route may be, matching the live conversation's route bound.
pub const ROUTE_MAX: usize = 200;

/// How much of vox's stderr rides back in an error message.
const STDERR_EXCERPT: usize = 400;

/// The notifier binary. `MESA_VOX_BIN` / `NARU_VOX_BIN` override it — the
/// same test seam as `look::loki_bin`.
fn vox_bin() -> String {
    crate::core::env::var("VOX_BIN").unwrap_or_else(|| "vox".to_string())
}

/// The one route rule for `--open` and `GET /open/<route>`: non-empty, at
/// most [`ROUTE_MAX`] characters, and only `[A-Za-z0-9/_-]`, so a route can
/// neither inject HTML nor smuggle a different URL scheme.
pub fn validate_route(route: &str) -> Result<&str> {
    if route.is_empty() {
        return Err(Error::Validation("route must not be empty".into()));
    }
    if route.chars().count() > ROUTE_MAX {
        return Err(Error::Validation(format!(
            "route must be at most {ROUTE_MAX} characters"
        )));
    }
    if !route
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'-'))
    {
        return Err(Error::Validation(
            "route may contain only letters, digits, `/`, `_` and `-`".into(),
        ));
    }
    Ok(route)
}

/// A base URL must be `http://` or `https://` with something after it.
fn validate_base_url(base: &str) -> Result<String> {
    let base = base.trim();
    let rest = base
        .strip_prefix("http://")
        .or_else(|| base.strip_prefix("https://"));
    match rest {
        Some(r) if !r.trim_end_matches('/').is_empty() && !r.contains(char::is_whitespace) => {
            Ok(base.trim_end_matches('/').to_string())
        }
        _ => Err(Error::Validation(format!(
            "base URL must be an http:// or https:// URL (got {base:?})"
        ))),
    }
}

/// This machine's LAN IPv4, found by asking the OS which interface would
/// route to a public address. A UDP `connect` sends no packet.
fn lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

/// The base URL for the button: `flag`, else the `notify.base-url` config
/// key, else `http://<LAN IPv4>:7770`.
pub(crate) fn resolve_base(flag: Option<&str>) -> Result<String> {
    if let Some(flag) = flag {
        return validate_base_url(flag);
    }
    match super::config::notify_base_url() {
        Ok(Some(configured)) => return validate_base_url(&configured),
        Ok(None) => {}
        Err(message) => return Err(Error::Unavailable(message)),
    }
    match lan_ip() {
        Some(ip) => Ok(format!("http://{ip}:{DEFAULT_PORT}")),
        None => Err(Error::Unavailable(
            "could not find this machine's LAN address for the button; pass --base-url \
             <url> or set notify.base-url in ~/.mesa/config.json"
                .into(),
        )),
    }
}

/// Send `message` through vox. Returns the JSON the CLI prints.
pub fn send(
    message: &str,
    title: Option<&str>,
    open: Option<&str>,
    base_url: Option<&str>,
) -> Result<Value> {
    if message.trim().is_empty() {
        return Err(Error::Validation("message must not be empty".into()));
    }
    let open_url = match open {
        Some(route) => {
            let route = validate_route(route)?;
            Some(format!("{}/open/{route}", resolve_base(base_url)?))
        }
        None => {
            // A base URL nobody will use is still a typo worth naming.
            if let Some(base) = base_url {
                validate_base_url(base)?;
            }
            None
        }
    };

    let bin = vox_bin();
    let mut cmd = Command::new(&bin);
    cmd.arg("notify").arg("--json");
    if let Some(title) = title {
        cmd.arg(format!("--title={title}"));
    }
    if let Some(url) = &open_url {
        cmd.arg("--button").arg(format!("Open Naru={url}"));
    }
    // `--` so a message beginning with `-` is still the message.
    cmd.arg("--").arg(message);
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::Unavailable(format!(
                "`{bin}` is not installed; `naru notify` needs the vox CLI to reach \
                     the phone (then run `vox init`)"
            ))
        } else {
            Error::Unavailable(format!("could not run `{bin}`: {e}"))
        }
    })?;
    let stderr = excerpt(&out.stderr);
    if !out.status.success() {
        if stderr.contains("vox init") {
            return Err(Error::Unavailable(format!(
                "vox is not set up; run `vox init` first ({stderr})"
            )));
        }
        return Err(Error::Unavailable(format!(
            "vox failed ({}): {stderr}",
            out.status
        )));
    }
    let reply: Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| Error::Unavailable(format!("vox printed output that is not JSON ({e})")))?;
    Ok(json!({
        "sent": true,
        "message_id": reply.get("message_id").cloned().unwrap_or(Value::Null),
        "chat_id": reply.get("chat_id").cloned().unwrap_or(Value::Null),
        "open_url": open_url,
    }))
}

/// A trimmed, bounded piece of vox's stderr, for an error message.
fn excerpt(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    if text.chars().count() > STDERR_EXCERPT {
        let cut: String = text.chars().take(STDERR_EXCERPT).collect();
        format!("{cut}…")
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_rule() {
        assert!(validate_route("live").is_ok());
        assert!(validate_route("a/b_c-d9").is_ok());
        for bad in ["", "a b", "a\"b", "<x>", "a:b", "a.b", "a?b", "é"] {
            assert!(validate_route(bad).is_err(), "{bad:?}");
        }
        assert!(validate_route(&"a".repeat(ROUTE_MAX)).is_ok());
        assert!(validate_route(&"a".repeat(ROUTE_MAX + 1)).is_err());
    }

    #[test]
    fn base_url_rule() {
        assert_eq!(
            validate_base_url("http://h:1/").unwrap(),
            "http://h:1".to_string()
        );
        assert!(validate_base_url("https://naru.local").is_ok());
        for bad in ["", "ftp://h", "tg://x", "http://", "h:1", "http://a b"] {
            assert!(validate_base_url(bad).is_err(), "{bad:?}");
        }
    }
}
