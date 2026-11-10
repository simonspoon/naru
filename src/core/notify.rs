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

/// Longest a route may be, matching the live conversation's route bound.
pub const ROUTE_MAX: usize = 200;

/// How much of vox's stderr rides back in an error message.
const STDERR_EXCERPT: usize = 400;

/// The notifier binary. `MESA_VOX_BIN` / `NARU_VOX_BIN` override it — the
/// same test seam as `look::loki_bin`.
fn vox_bin() -> String {
    crate::core::env::var("VOX_BIN").unwrap_or_else(|| "vox".to_string())
}

/// Whether `NARU_HOME` (or `MESA_HOME`) is set to somewhere other than the
/// account's real naru home (`~/.naru`, `~/.mesa`): a dev environment, a
/// sandbox or a temp home. Unset means the real install.
fn sandboxed_home() -> bool {
    let Some(dir) = crate::core::env::var("HOME").filter(|d| !d.is_empty()) else {
        return false;
    };
    let Some(base) = directories::BaseDirs::new() else {
        return true;
    };
    let canon = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let dir = canon(std::path::Path::new(&dir));
    let home = canon(base.home_dir());
    dir != home.join(".naru") && dir != home.join(".mesa")
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
/// key, else `http://<LAN IPv4>:<serve.port>` (7770 when the config sets none).
pub(crate) fn resolve_base(flag: Option<&str>) -> Result<String> {
    if let Some(flag) = flag {
        return validate_base_url(flag);
    }
    match super::config::notify_base_url() {
        Ok(Some(configured)) => return validate_base_url(&configured),
        Ok(None) => {}
        Err(message) => return Err(Error::Unavailable(message)),
    }
    let port = serve_port(super::config::serve_settings())?;
    match lan_ip() {
        Some(ip) => Ok(format!("http://{ip}:{port}")),
        None => Err(Error::Unavailable(
            "could not find this machine's LAN address for the button; pass --base-url \
             <url> or set notify.base-url in ~/.mesa/config.json"
                .into(),
        )),
    }
}

/// The port the auto-detected base names: the config's `serve.port`, else
/// `serve`'s default. A config read error is `unavailable`, as for
/// `notify.base-url`.
fn serve_port(settings: std::result::Result<super::config::ServeSettings, String>) -> Result<u16> {
    match settings {
        Ok(s) => Ok(s.port.unwrap_or(super::config::DEFAULT_SERVE_PORT)),
        Err(message) => Err(Error::Unavailable(message)),
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

    // A dev environment, sandbox or temp home must never reach the person's
    // phone either (naru task 2696); an explicit `VOX_BIN` opts back in.
    if sandboxed_home() && crate::core::env::var("VOX_BIN").is_none() {
        eprintln!(
            "naru: notification skipped (NARU_HOME is not the real home; set NARU_VOX_BIN to send): {message}"
        );
        return Ok(json!({
            "sent": false,
            "skipped": true,
            "message_id": Value::Null,
            "chat_id": Value::Null,
            "open_url": open_url,
        }));
    }

    // Unit tests must never reach the person's phone: without an explicit
    // vox override (a stub), `cargo test` sends nothing (naru task 2097).
    #[cfg(test)]
    if crate::core::env::var("VOX_BIN").is_none() {
        return Ok(json!({
            "sent": false,
            "stubbed": true,
            "message_id": Value::Null,
            "chat_id": Value::Null,
            "open_url": open_url,
        }));
    }

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
    fn serve_port_follows_config_else_default() {
        use crate::core::config::ServeSettings;
        let with = |port| {
            Ok(ServeSettings {
                port,
                ..Default::default()
            })
        };
        assert_eq!(serve_port(with(Some(7777))).unwrap(), 7777);
        assert_eq!(serve_port(with(None)).unwrap(), 7770);
        assert!(matches!(
            serve_port(Err("bad".into())),
            Err(Error::Unavailable(_))
        ));
    }

    #[test]
    fn resolve_base_uses_config_serve_port() {
        use crate::core::attachments::ENV_LOCK;
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("naru-notify-2697-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.json");
        let prev = std::env::var("MESA_CONFIG_FILE");
        // SAFETY: ENV_LOCK gives this test exclusive access to the env vars.
        unsafe { std::env::set_var("MESA_CONFIG_FILE", &cfg) };
        let ip = lan_ip();
        std::fs::write(&cfg, r#"{"serve":{"port":7777}}"#).unwrap();
        let got = resolve_base(None);
        std::fs::write(
            &cfg,
            r#"{"serve":{"port":7777},"notify":{"base-url":"https://n.example"}}"#,
        )
        .unwrap();
        let configured = resolve_base(None).unwrap();
        let flagged = resolve_base(Some("http://1.2.3.4:9")).unwrap();
        unsafe {
            match prev {
                Ok(v) => std::env::set_var("MESA_CONFIG_FILE", v),
                Err(_) => std::env::remove_var("MESA_CONFIG_FILE"),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        if let Some(ip) = ip {
            assert_eq!(got.unwrap(), format!("http://{ip}:7777"));
        }
        assert_eq!(configured, "https://n.example");
        assert_eq!(flagged, "http://1.2.3.4:9");
    }

    #[test]
    fn send_is_stubbed_under_test_without_a_vox_override() {
        let _lock = crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if crate::core::env::var("VOX_BIN").is_some() {
            return;
        }
        let home = (std::env::var("NARU_HOME"), std::env::var("MESA_HOME"));
        // SAFETY: ENV_LOCK gives this test exclusive access to the env vars.
        unsafe {
            std::env::remove_var("NARU_HOME");
            std::env::remove_var("MESA_HOME");
        }
        let v = send("x", None, None, None).unwrap();
        assert_eq!(v["sent"], false);
        assert_eq!(v["stubbed"], true);
        unsafe {
            if let Ok(h) = home.0 {
                std::env::set_var("NARU_HOME", h);
            }
            if let Ok(h) = home.1 {
                std::env::set_var("MESA_HOME", h);
            }
        }
    }

    #[test]
    fn sandboxed_home_skips_vox_but_an_override_sends() {
        use crate::core::attachments::ENV_LOCK;
        use std::os::unix::fs::PermissionsExt;
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("naru-notify-2696-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("calls.log");
        let stub = dir.join("vox");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\necho call >> {}\necho '{{\"message_id\":1,\"chat_id\":2}}'\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let old_path = std::env::var("PATH").unwrap_or_default();
        let real = directories::BaseDirs::new()
            .unwrap()
            .home_dir()
            .join(".naru");
        // SAFETY: ENV_LOCK gives this test exclusive access to the env vars.
        unsafe {
            std::env::set_var("PATH", format!("{}:{old_path}", dir.display()));
            std::env::remove_var("NARU_VOX_BIN");
            std::env::remove_var("MESA_VOX_BIN");
            std::env::remove_var("MESA_HOME");
            std::env::set_var("NARU_HOME", &dir);
        }
        // Sandbox home: skipped, the stub on PATH is never invoked.
        let v = send("hello", None, None, None).unwrap();
        assert_eq!(v["skipped"], true);
        assert_eq!(v["sent"], false);
        assert!(!log.exists());
        // Explicit opt-in: the stub is called.
        unsafe { std::env::set_var("NARU_VOX_BIN", &stub) };
        let v = send("hello", None, None, None).unwrap();
        assert_eq!(v["sent"], true);
        assert!(log.exists());
        // The real home is not a sandbox.
        unsafe {
            std::env::remove_var("NARU_VOX_BIN");
            std::env::set_var("NARU_HOME", &real);
        }
        assert!(!sandboxed_home());
        unsafe { std::env::set_var("NARU_HOME", "") };
        assert!(!sandboxed_home());
        unsafe { std::env::remove_var("NARU_HOME") };
        assert!(!sandboxed_home());
        unsafe { std::env::set_var("PATH", old_path) };
        std::fs::remove_dir_all(&dir).ok();
    }

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
