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
    let Some(base) = directories::BaseDirs::new() else {
        return crate::core::env::var("HOME").is_some_and(|d| !d.is_empty());
    };
    sandboxed_dir(crate::core::env::var("HOME"), base.home_dir())
}

/// [`sandboxed_home`] for an already-read `NARU_HOME` value and account home
/// directory, so a test can decide without touching the process environment.
fn sandboxed_dir(home_var: Option<String>, account_home: &std::path::Path) -> bool {
    let Some(dir) = home_var.filter(|d| !d.is_empty()) else {
        return false;
    };
    let canon = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let dir = canon(std::path::Path::new(&dir));
    let home = canon(account_home);
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

/// Whether `ip` is in Tailscale's CGNAT range, 100.64.0.0/10.
fn is_tailscale_v4(ip: IpAddr) -> bool {
    matches!(ip, IpAddr::V4(v4) if v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
}

/// This machine's own Tailscale IPv4, asked of the `tailscale` CLI at send
/// time (`tailscale ip -4`), or `None` when Tailscale is absent, down or
/// answers anything outside its 100.64.0.0/10 range (including on Windows
/// without the CLI on PATH). `MESA_TAILSCALE_BIN` / `NARU_TAILSCALE_BIN`
/// override the binary, the same seam as `vox_bin`.
fn tailscale_ip() -> Option<IpAddr> {
    let var = |n: &str| std::env::var(n).ok().filter(|v| !v.is_empty());
    let bins = match var("NARU_TAILSCALE_BIN").or_else(|| var("MESA_TAILSCALE_BIN")) {
        Some(bin) => vec![bin],
        None => vec![
            "tailscale".to_string(),
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale".to_string(),
        ],
    };
    bins.iter().find_map(|bin| {
        let mut child = Command::new(bin)
            .args(["ip", "-4"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        // A wedged daemon must not stall a notification: give it 2 s.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match child.try_wait().ok()? {
                Some(status) if status.success() => break,
                Some(_) => return None,
                None if std::time::Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                None => std::thread::sleep(std::time::Duration::from_millis(20)),
            }
        }
        let out = child.wait_with_output().ok()?;
        let ip: IpAddr = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()?
            .trim()
            .parse()
            .ok()?;
        is_tailscale_v4(ip).then_some(ip)
    })
}

/// The base URL for the button: `flag`, else the `notify.base-url` config
/// key, else `http://<Tailscale IPv4>:<serve.port>` when Tailscale is up
/// here, else `http://<LAN IPv4>:<serve.port>` (7770 when the config sets none).
pub(crate) fn resolve_base(flag: Option<&str>) -> Result<String> {
    resolve_base_with(flag, tailscale_ip, lan_ip)
}

fn resolve_base_with(
    flag: Option<&str>,
    tailscale: impl FnOnce() -> Option<IpAddr>,
    lan: impl FnOnce() -> Option<IpAddr>,
) -> Result<String> {
    if let Some(flag) = flag {
        return validate_base_url(flag);
    }
    match super::config::notify_base_url() {
        Ok(Some(configured)) => return validate_base_url(&configured),
        Ok(None) => {}
        Err(message) => return Err(Error::Unavailable(message)),
    }
    let port = serve_port(super::config::serve_settings())?;
    match tailscale().or_else(lan) {
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

/// The vox to call, or `None` where the phone must not be reached: a
/// sandboxed home (naru task 2696) or `cargo test`, unless `VOX_BIN` names
/// one explicitly.
fn allowed_vox(sandboxed: bool, vox_override: Option<String>) -> Option<String> {
    if vox_override.is_none() && (cfg!(test) || sandboxed) {
        return None;
    }
    Some(vox_override.unwrap_or_else(vox_bin))
}

/// Whether `bin` is a vox with the `events` subcommand (and so `notify
/// --choice`, both from vox task 2698). An older or missing vox is `false`.
/// `--help` touches neither the network nor vox's config.
pub fn events_supported(bin: &str) -> bool {
    Command::new(bin)
        .args(["events", "--help"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Whether a notification sent now can carry choice buttons: this is an
/// environment whose `serve` runs the reader ([`reader_bin`]) and vox is new
/// enough to deliver the taps (naru task 2699).
pub fn phone_answers() -> bool {
    reader_bin().is_some_and(|bin| events_supported(&bin))
}

/// Whether `NARU_DB` / `MESA_DB` (`db_var`) names a db other than the
/// account's own (`own`): a throwaway db. Unset or empty is the own db.
fn foreign_db(db_var: Option<String>, own: &[std::path::PathBuf]) -> bool {
    let Some(db) = db_var.filter(|d| !d.is_empty()) else {
        return false;
    };
    let canon = |p: &std::path::Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let db = canon(std::path::Path::new(&db));
    !own.iter().any(|p| canon(p) == db)
}

/// The vox whose `events` the one reader inside `serve` runs, or `None` when
/// it must not start: wherever [`send`] would skip vox, and also when
/// `NARU_DB` / `MESA_DB` names a throwaway db (a test serve on the real home
/// would otherwise consume the real bot's updates; the launchd plist sets
/// `NARU_DB` to the real db, which is not one). `VOX_BIN` opts back in.
pub fn reader_bin() -> Option<String> {
    let own: Vec<_> = ["naru", "mesa"]
        .iter()
        .filter_map(|app| {
            let dirs = directories::ProjectDirs::from("", "", app)?;
            Some(dirs.data_dir().join(format!("{app}.db")))
        })
        .collect();
    let throwaway = sandboxed_home() || foreign_db(crate::core::env::var("DB"), &own);
    allowed_vox(throwaway, crate::core::env::var("VOX_BIN"))
}

/// Runs vox for its side effect only; a failure is `unavailable`. A no-op
/// where the phone must not be reached.
fn vox_quiet(args: &[&str]) -> Result<()> {
    let Some(bin) = allowed_vox(sandboxed_home(), crate::core::env::var("VOX_BIN")) else {
        return Ok(());
    };
    let out = Command::new(&bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Error::Unavailable(format!("could not run `{bin}`: {e}")))?;
    if !out.status.success() {
        return Err(Error::Unavailable(format!(
            "vox failed ({}): {}",
            out.status,
            excerpt(&out.stderr)
        )));
    }
    Ok(())
}

/// Replaces the text of a message Naru sent, which also removes its buttons
/// (`vox progress`).
pub fn edit_message(message_id: i64, text: &str) -> Result<()> {
    vox_quiet(&["progress", &message_id.to_string(), "--", text])
}

/// Sends `text` as a reply to Telegram message `reply_to`.
pub fn reply_to(reply_to: i64, text: &str) -> Result<()> {
    vox_quiet(&["notify", &format!("--reply-to={reply_to}"), "--", text])
}

/// Send `message` through vox. Returns the JSON the CLI prints.
pub fn send(
    message: &str,
    title: Option<&str>,
    open: Option<&str>,
    base_url: Option<&str>,
) -> Result<Value> {
    send_choices(message, title, open, base_url, &[])
}

/// [`send`] with choice buttons, each a `(label, data)` pair: a tap comes
/// back through `vox events` as `data` (see `core::phone`). Call it with
/// choices only when [`phone_answers`] holds.
pub fn send_choices(
    message: &str,
    title: Option<&str>,
    open: Option<&str>,
    base_url: Option<&str>,
    choices: &[(&str, String)],
) -> Result<Value> {
    send_with(
        message,
        title,
        open,
        base_url,
        choices,
        sandboxed_home(),
        crate::core::env::var("VOX_BIN"),
    )
}

/// [`send`] with the sandbox decision and the vox override passed in rather
/// than read from the environment.
fn send_with(
    message: &str,
    title: Option<&str>,
    open: Option<&str>,
    base_url: Option<&str>,
    choices: &[(&str, String)],
    sandboxed: bool,
    vox_override: Option<String>,
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
    if sandboxed && vox_override.is_none() {
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
    if vox_override.is_none() {
        return Ok(json!({
            "sent": false,
            "stubbed": true,
            "message_id": Value::Null,
            "chat_id": Value::Null,
            "open_url": open_url,
        }));
    }

    let bin = vox_override.unwrap_or_else(vox_bin);
    let mut cmd = Command::new(&bin);
    cmd.arg("notify").arg("--json");
    if let Some(title) = title {
        cmd.arg(format!("--title={title}"));
    }
    for (label, data) in choices {
        cmd.arg("--choice").arg(format!("{label}={data}"));
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

/// What a bounded vox call got back: success, stdout, and a stderr excerpt.
struct Bounded {
    success: bool,
    stdout: Vec<u8>,
    stderr: String,
}

/// Runs `bin args` and kills it when it has not exited within `limit`, so a
/// hung vox cannot hold the caller (naru task 2700). Both pipes are drained on
/// their own threads so a chatty child never blocks on a full pipe.
fn run_bounded(bin: &str, args: &[String], limit: std::time::Duration) -> Result<Bounded> {
    use std::io::Read;
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Unavailable(format!("could not run `{bin}`: {e}")))?;
    // Each drain reports over a channel, so a pipe a grandchild still holds
    // open after the child exits cannot hold the caller either.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            let _ = tx.send(buf);
        });
        rx
    };
    let collect = |rx: std::sync::mpsc::Receiver<Vec<u8>>| {
        rx.recv_timeout(std::time::Duration::from_secs(1))
            .unwrap_or_default()
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as _));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(e) => {
                return Err(Error::Unavailable(format!(
                    "could not wait for `{bin}`: {e}"
                )));
            }
        }
    };
    let Some(status) = status else {
        return Err(Error::Unavailable(format!(
            "`{bin}` did not answer within {}s",
            limit.as_secs()
        )));
    };
    Ok(Bounded {
        success: status.success(),
        stdout: collect(out),
        stderr: excerpt(&collect(err)),
    })
}

/// [`events_supported`], giving up (`false`) after `limit`.
pub fn events_supported_within(bin: &str, limit: std::time::Duration) -> bool {
    run_bounded(bin, &["events".into(), "--help".into()], limit).is_ok_and(|b| b.success)
}

/// Sends `message` with choice buttons through `bin`, bounded by `limit`, and
/// returns the Telegram message id. Unlike [`send_choices`] this does not
/// decide whether the phone may be reached: the caller passes the vox it got
/// from [`reader_bin`].
pub fn send_bounded(
    bin: &str,
    message: &str,
    title: &str,
    choices: &[(String, String)],
    limit: std::time::Duration,
) -> Result<i64> {
    let mut args: Vec<String> = vec!["notify".into(), "--json".into(), format!("--title={title}")];
    for (label, data) in choices {
        args.push("--choice".into());
        args.push(format!("{label}={data}"));
    }
    args.push("--".into());
    args.push(message.to_string());
    let out = run_bounded(bin, &args, limit)?;
    if !out.success {
        return Err(Error::Unavailable(format!("vox failed: {}", out.stderr)));
    }
    let reply: Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| Error::Unavailable(format!("vox printed output that is not JSON ({e})")))?;
    reply
        .get("message_id")
        .and_then(Value::as_i64)
        .ok_or_else(|| Error::Unavailable("vox returned no message id".into()))
}

/// [`edit_message`] through `bin`, bounded by `limit`.
pub fn edit_bounded(
    bin: &str,
    message_id: i64,
    text: &str,
    limit: std::time::Duration,
) -> Result<()> {
    let args = [
        "progress".to_string(),
        message_id.to_string(),
        "--".into(),
        text.into(),
    ];
    let out = run_bounded(bin, &args, limit)?;
    if out.success {
        Ok(())
    } else {
        Err(Error::Unavailable(format!("vox failed: {}", out.stderr)))
    }
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

    #[cfg(unix)]
    #[test]
    fn a_hung_vox_is_killed_at_the_deadline() {
        let started = std::time::Instant::now();
        let err = run_bounded(
            "sleep",
            &["30".into()],
            std::time::Duration::from_millis(200),
        );
        assert!(matches!(err, Err(Error::Unavailable(m)) if m.contains("did not answer")));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        let ok = run_bounded("echo", &["hi".into()], std::time::Duration::from_secs(5)).unwrap();
        assert!(ok.success && ok.stdout == b"hi\n");
        assert!(!events_supported_within(
            "false",
            std::time::Duration::from_secs(5)
        ));
    }

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
    fn resolve_base_order() {
        use crate::core::attachments::ENV_LOCK;
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("naru-notify-2703-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.json");
        let prev = std::env::var("MESA_CONFIG_FILE");
        // SAFETY: ENV_LOCK gives this test exclusive access to the env vars.
        unsafe { std::env::set_var("MESA_CONFIG_FILE", &cfg) };
        let ts: Option<IpAddr> = Some("100.64.1.2".parse().unwrap());
        let lan: Option<IpAddr> = Some("192.168.1.5".parse().unwrap());
        std::fs::write(&cfg, r#"{"serve":{"port":7777}}"#).unwrap();
        let both = resolve_base_with(None, || ts, || lan);
        let lan_only = resolve_base_with(None, || None, || lan);
        let neither = resolve_base_with(None, || None, || None);
        let flagged = resolve_base_with(Some("http://1.2.3.4:9"), || ts, || lan);
        std::fs::write(
            &cfg,
            r#"{"serve":{"port":7777},"notify":{"base-url":"https://n.example"}}"#,
        )
        .unwrap();
        let configured = resolve_base_with(None, || ts, || lan);
        unsafe {
            match prev {
                Ok(v) => std::env::set_var("MESA_CONFIG_FILE", v),
                Err(_) => std::env::remove_var("MESA_CONFIG_FILE"),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(both.unwrap(), "http://100.64.1.2:7777");
        assert_eq!(lan_only.unwrap(), "http://192.168.1.5:7777");
        assert!(matches!(neither, Err(Error::Unavailable(_))));
        assert_eq!(flagged.unwrap(), "http://1.2.3.4:9");
        assert_eq!(configured.unwrap(), "https://n.example");
    }

    #[test]
    fn tailscale_range() {
        assert!(is_tailscale_v4("100.64.0.1".parse().unwrap()));
        assert!(is_tailscale_v4("100.127.255.255".parse().unwrap()));
        assert!(!is_tailscale_v4("100.128.0.1".parse().unwrap()));
        assert!(!is_tailscale_v4("192.168.1.5".parse().unwrap()));
        assert!(!is_tailscale_v4(
            "fd7a:115c:a1e0::bc35:de79".parse().unwrap()
        ));
    }

    #[test]
    fn send_is_stubbed_under_test_without_a_vox_override() {
        let v = send_with("x", None, None, None, &[], false, None).unwrap();
        assert_eq!(v["sent"], false);
        assert_eq!(v["stubbed"], true);
    }

    #[test]
    fn sandboxed_home_skips_vox_but_an_override_sends() {
        use std::os::unix::fs::PermissionsExt;
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
        // A fixed account home: `BaseDirs` reads `$HOME`, which other tests change.
        let account = std::path::Path::new("/nonexistent-naru-test-home");
        let real = account.join(".naru");
        // Sandbox home: skipped, the stub is never invoked.
        assert!(sandboxed_dir(Some(dir.display().to_string()), account));
        let v = send_with("hello", None, None, None, &[], true, None).unwrap();
        assert_eq!(v["skipped"], true);
        assert_eq!(v["sent"], false);
        assert!(!log.exists());
        // Explicit opt-in: the stub is called.
        let stub_path = stub.display().to_string();
        let v = send_with("hello", None, None, None, &[], true, Some(stub_path)).unwrap();
        assert_eq!(v["sent"], true);
        assert!(log.exists());
        // The real home is not a sandbox.
        assert!(!sandboxed_dir(Some(real.display().to_string()), account));
        assert!(!sandboxed_dir(Some(String::new()), account));
        assert!(!sandboxed_dir(None, account));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_a_db_other_than_the_accounts_own_is_foreign() {
        let own = [
            std::path::PathBuf::from("/nonexistent-naru-test/naru/naru.db"),
            std::path::PathBuf::from("/nonexistent-naru-test/mesa/mesa.db"),
        ];
        assert!(!foreign_db(None, &own));
        assert!(!foreign_db(Some(String::new()), &own));
        for mine in &own {
            assert!(!foreign_db(Some(mine.display().to_string()), &own));
        }
        assert!(foreign_db(Some("/tmp/t.db".into()), &own));
    }

    #[test]
    fn vox_is_allowed_only_outside_tests_and_sandboxes_unless_named() {
        // Under `cargo test` nothing reaches vox without an explicit binary.
        assert_eq!(allowed_vox(false, None), None);
        assert_eq!(allowed_vox(true, None), None);
        assert_eq!(allowed_vox(true, Some("stub".into())), Some("stub".into()));
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
