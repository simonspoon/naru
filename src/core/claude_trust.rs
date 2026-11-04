//! Marks a project folder trusted in Claude Code's own config (naru task
//! 2570), so a queue-watcher spawn in a new or moved project folder is not
//! refused with "Workspace not trusted". The flag is
//! `projects[<abs path>].hasTrustDialogAccepted` in `.claude.json`.
//!
//! The file is Claude Code's, large, and written by it concurrently, so the
//! edit touches only that one flag: every other key and value is carried over
//! as its original text, in its original order.

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::value::RawValue;
use std::path::{Path, PathBuf};

/// Claude Code's config file: `$CLAUDE_CONFIG_DIR/.claude.json` when that is
/// set, else `$HOME/.claude.json` — whichever the spawned `claude`, which
/// inherits this process's environment, will read.
pub fn config_path() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d).join(".claude.json"));
    }
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(|h| PathBuf::from(h).join(".claude.json"))
}

/// Whether `err` (a spawn's error text) is Claude Code's folder-trust refusal.
pub fn is_untrusted_error(err: &str) -> bool {
    err.to_ascii_lowercase().contains("workspace not trusted")
}

/// Marks `dir` trusted in [`config_path`]. `Ok(Some(key))` names the path
/// key it wrote, `Ok(None)` means it was already trusted (nothing written).
pub fn ensure_trusted(dir: &str) -> Result<Option<String>, String> {
    let file = config_path().ok_or("no HOME to find .claude.json under")?;
    ensure_trusted_in(&file, dir)
}

/// [`ensure_trusted`] against an explicit config `file`. The key is the
/// canonical path (what `claude`'s cwd reads as), and `/`, `$HOME` and any
/// folder above `$HOME` are refused: trust there would cover every folder
/// below them.
pub fn ensure_trusted_in(file: &Path, dir: &str) -> Result<Option<String>, String> {
    let canon = std::fs::canonicalize(dir).map_err(|e| format!("cannot resolve {dir}: {e}"))?;
    let home = std::env::var_os("HOME").and_then(|h| std::fs::canonicalize(h).ok());
    if canon.parent().is_none() || home.is_some_and(|h| h.starts_with(&canon)) {
        return Err(format!("refusing to trust {}", canon.display()));
    }
    let key = canon
        .to_str()
        .ok_or_else(|| format!("{} is not UTF-8", canon.display()))?
        .to_string();
    // A symlinked config (a dotfiles checkout) is edited where it points, so
    // the rename never replaces the link itself.
    let file = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    // Claude Code may rewrite the file at any moment: the new text goes to a
    // temp file, the original is re-read right before the rename, and a
    // change in between starts the edit over.
    for _ in 0..5 {
        let before = read(&file)?;
        let Some(after) = with_trust(before.as_deref().unwrap_or("{}"), &key)? else {
            return Ok(None);
        };
        let tmp = file.with_extension(format!("json.naru-{}.tmp", std::process::id()));
        let replaced = write_temp(&file, &tmp, &after).and_then(|()| {
            if read(&file)? != before {
                return Ok(false);
            }
            std::fs::rename(&tmp, &file)
                .map(|()| true)
                .map_err(|e| format!("cannot replace {}: {e}", file.display()))
        });
        match replaced {
            Ok(true) => return Ok(Some(key)),
            Ok(false) => {
                let _ = std::fs::remove_file(&tmp);
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
    Err(format!("{} kept changing; not edited", file.display()))
}

/// Writes `text` to `tmp`, created with `file`'s permissions (0600 when there
/// is no `file` yet) so the copy is never more readable than the original.
fn write_temp(file: &Path, tmp: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    let perms = std::fs::metadata(file).ok().map(|m| m.permissions());
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        open.mode(perms.as_ref().map_or(0o600, |p| p.mode() & 0o777));
    }
    let err = |e: std::io::Error| format!("cannot write {}: {e}", tmp.display());
    let mut f = open.open(tmp).map_err(err)?;
    f.write_all(text.as_bytes()).map_err(err)?;
    if let Some(p) = perms {
        std::fs::set_permissions(tmp, p).map_err(err)?;
    }
    Ok(())
}

/// The file's text, `None` when it does not exist.
fn read(file: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(file) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", file.display())),
    }
}

/// A JSON object's members in file order, each value kept as its raw text.
struct Members(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for Members {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Members;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Members, A::Error> {
                let mut out = Vec::new();
                while let Some(entry) = map.next_entry::<String, Box<RawValue>>()? {
                    out.push(entry);
                }
                Ok(Members(out))
            }
        }
        d.deserialize_map(V)
    }
}

fn members(text: &str, what: &str) -> Result<Members, String> {
    serde_json::from_str(text).map_err(|e| format!("{what} is not a JSON object: {e}"))
}

/// Sets `key` to the raw `value` (replacing in place, or appending).
fn set(m: &mut Members, key: &str, value: String) -> Result<(), String> {
    let raw = RawValue::from_string(value).map_err(|e| e.to_string())?;
    match m.0.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = raw,
        None => m.0.push((key.to_string(), raw)),
    }
    Ok(())
}

/// `m` as Claude Code writes it (`JSON.stringify(_, null, 2)`) at nesting
/// `depth`; the raw member values keep their own text.
fn emit(m: &Members, depth: usize) -> String {
    if m.0.is_empty() {
        return "{}".to_string();
    }
    let pad = "  ".repeat(depth + 1);
    let body: Vec<String> =
        m.0.iter()
            .map(|(k, v)| format!("{pad}{}: {}", serde_json::to_string(k).unwrap(), v.get()))
            .collect();
    format!("{{\n{}\n{}}}", body.join(",\n"), "  ".repeat(depth))
}

/// `text` with `projects[key].hasTrustDialogAccepted = true`, or `None` when
/// it is already set. Errors on anything that is not an object where one is
/// expected, so a file it cannot read cleanly is never rewritten.
fn with_trust(text: &str, key: &str) -> Result<Option<String>, String> {
    let mut top = members(text, ".claude.json")?;
    let find = |m: &Members, k: &str| {
        m.0.iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.get().to_string())
    };
    let mut projects = match find(&top, "projects") {
        Some(raw) => members(&raw, "projects")?,
        None => Members(Vec::new()),
    };
    let mut entry = match find(&projects, key) {
        Some(raw) => members(&raw, "the project entry")?,
        None => Members(Vec::new()),
    };
    if find(&entry, "hasTrustDialogAccepted").as_deref() == Some("true") {
        return Ok(None);
    }
    set(&mut entry, "hasTrustDialogAccepted", "true".to_string())?;
    set(&mut projects, key, emit(&entry, 2))?;
    set(&mut top, "projects", emit(&projects, 1))?;
    let trailing = if text.ends_with('\n') { "\n" } else { "" };
    Ok(Some(format!("{}{trailing}", emit(&top, 0))))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "/p/new";

    #[test]
    fn adds_the_flag_and_keeps_every_other_byte() {
        let text = "{\n  \"zeta\": 1,\n  \"alpha\": {\n    \"b\": [\n      1.50,\n      \"é\"\n    ],\n    \"a\": null\n  },\n  \"projects\": {\n    \"/p/old\": {\n      \"allowedTools\": [],\n      \"hasTrustDialogAccepted\": false\n    },\n    \"/p/new\": {\n      \"lastCost\": 0.1\n    }\n  },\n  \"unknownLast\": true\n}";
        let out = with_trust(text, KEY).unwrap().unwrap();
        let expected = text.replace(
            "\"lastCost\": 0.1\n",
            "\"lastCost\": 0.1,\n      \"hasTrustDialogAccepted\": true\n",
        );
        assert_eq!(out, expected);
        // Idempotent: a second pass writes nothing.
        assert_eq!(with_trust(&out, KEY).unwrap(), None);
    }

    #[test]
    fn replaces_a_false_flag_in_place() {
        let text = "{\n  \"projects\": {\n    \"/p/new\": {\n      \"hasTrustDialogAccepted\": false,\n      \"x\": 1\n    }\n  }\n}\n";
        let out = with_trust(text, KEY).unwrap().unwrap();
        assert_eq!(out, text.replace("false", "true"));
    }

    #[test]
    fn creates_projects_and_the_entry_when_missing() {
        let out = with_trust("{\n  \"numStartups\": 3\n}", KEY)
            .unwrap()
            .unwrap();
        assert_eq!(
            out,
            "{\n  \"numStartups\": 3,\n  \"projects\": {\n    \"/p/new\": {\n      \"hasTrustDialogAccepted\": true\n    }\n  }\n}"
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["projects"][KEY]["hasTrustDialogAccepted"], true);
    }

    #[test]
    fn refuses_a_file_it_cannot_parse() {
        assert!(with_trust("not json", KEY).is_err());
        assert!(with_trust("[1]", KEY).is_err());
        assert!(with_trust("{\"projects\": 3}", KEY).is_err());
    }

    #[test]
    fn writes_the_file_atomically_and_handles_it_missing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".claude.json");
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let key = std::fs::canonicalize(&project)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        // Missing file: created with just the entry.
        let wrote = ensure_trusted_in(&file, project.to_str().unwrap()).unwrap();
        assert_eq!(wrote.as_deref(), Some(key.as_str()));
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(v["projects"][&key]["hasTrustDialogAccepted"], true);

        // Already trusted: untouched, and no temp file left behind.
        let before = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            ensure_trusted_in(&file, project.to_str().unwrap()).unwrap(),
            None
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 2, "only .claude.json and proj: {names:?}");

        // A malformed file is left exactly as it was.
        std::fs::write(&file, "{oops").unwrap();
        assert!(ensure_trusted_in(&file, project.to_str().unwrap()).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{oops");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_file_mode_and_edits_through_a_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("dotfiles.json");
        std::fs::write(&real, "{}").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join(".claude.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();

        assert!(
            ensure_trusted_in(&link, project.to_str().unwrap())
                .unwrap()
                .is_some()
        );
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(
            std::fs::read_to_string(&real)
                .unwrap()
                .contains("hasTrustDialogAccepted")
        );
        let mode = std::fs::metadata(&real).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn refuses_root_and_home() {
        // Under the HOME lock, so no other test swaps HOME mid-check.
        crate::core::library::test_home::with_home_dir(|home| {
            let file = home.join(".claude.json");
            assert!(ensure_trusted_in(&file, "/").is_err());
            assert!(ensure_trusted_in(&file, home.to_str().unwrap()).is_err());
            let above = home.parent().unwrap().to_str().unwrap();
            assert!(ensure_trusted_in(&file, above).is_err());
            assert!(!file.exists());
        });
    }

    #[test]
    fn spots_the_trust_refusal() {
        assert!(is_untrusted_error(
            "bash failed: Workspace not trusted. Run `claude` in /x once"
        ));
        assert!(!is_untrusted_error("bash failed: command not found"));
    }
}
