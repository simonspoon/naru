//! The headless usage ledger (naru task 1774, `docs/cc-dashboard.md`).
//!
//! A `claude -p --no-session-persistence` call writes no transcript, so the CC
//! dashboard cannot see it. A caller pipes the call's `--output-format json`
//! result into `naru cc ledger add`, which appends one line per model to a
//! JSONL file; [`ingest`] (run by `cc::sync`) folds those lines into the
//! `cc_*` tables as sessions with `entrypoint = "headless"`.
//!
//! The ledger is a file, not a db insert, so `cc reset` (which purges `cc_*`)
//! recovers it exactly as it recovers transcripts. Ingest is idempotent on the
//! entry id, so a duplicate line or a reset never double counts. Claude's own
//! reported cost is stored and used as-is: naru's price-table estimate
//! overstates these calls.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::cc::{CcSyncReport, find_transcript, fmt_ts, now_unix, parse_ts};
use super::store::{
    CcFileBatch, CcFileCursor, CcMessageRow, CcSessionUpsert, Error, Result, Store,
};

/// `cc_sessions.entrypoint` of every ledger session.
pub const HEADLESS_ENTRYPOINT: &str = "headless";

/// One model's usage from one headless call — one ledger line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub v: i64,
    /// `<claude result uuid>:<model>` — the idempotency key.
    pub id: String,
    /// RFC 3339 UTC, whole seconds.
    pub at: String,
    pub source: String,
    pub session_id: Option<String>,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    /// Claude's reported cost; `None` = unknown, so the dashboard estimates.
    pub cost_usd: Option<f64>,
}

/// `NARU_CC_LEDGER` / `MESA_CC_LEDGER`, else `<dot dir>/usage/headless.jsonl`.
pub fn ledger_path() -> PathBuf {
    if let Some(p) = super::env::var("CC_LEDGER") {
        return PathBuf::from(p);
    }
    let home = directories::BaseDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .unwrap_or_default();
    super::config::dot_dir_in(&home)
        .join("usage")
        .join("headless.jsonl")
}

fn int(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// Turn one claude `-p --output-format json` result into ledger entries: one
/// per `modelUsage` entry (using its `costUSD`), or — with none — one from
/// `usage` + `model` + `total_cost_usd`.
pub fn entries_from_result(
    raw: &str,
    source: &str,
    at: &str,
    model: Option<&str>,
) -> Result<Vec<LedgerEntry>> {
    let bad = |m: &str| Error::Validation(format!("not a claude -p json result: {m}"));
    let v: Value = serde_json::from_str(raw.trim()).map_err(|e| bad(&e.to_string()))?;
    if !v.is_object() {
        return Err(bad("expected a JSON object"));
    }
    let uuid = v
        .get("uuid")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad("no `uuid`"))?;
    let session_id = v
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let entry = |model: &str, i, o, cr, cc, cost: Option<f64>| LedgerEntry {
        v: 1,
        id: format!("{uuid}:{model}"),
        at: at.to_string(),
        source: source.to_string(),
        session_id: session_id.clone(),
        model: model.to_string(),
        input_tokens: i,
        output_tokens: o,
        cache_read_tokens: cr,
        cache_creation_tokens: cc,
        cost_usd: cost,
    };
    if let Some(mu) = v
        .get("modelUsage")
        .and_then(Value::as_object)
        .filter(|m| !m.is_empty())
    {
        return Ok(mu
            .iter()
            .map(|(m, u)| {
                entry(
                    m,
                    int(u, "inputTokens"),
                    int(u, "outputTokens"),
                    int(u, "cacheReadInputTokens"),
                    int(u, "cacheCreationInputTokens"),
                    u.get("costUSD").and_then(Value::as_f64),
                )
            })
            .collect());
    }
    let model = model
        .filter(|m| !m.is_empty())
        .ok_or_else(|| Error::Validation("the result has no modelUsage; pass --model".into()))?;
    let u = v.get("usage").cloned().unwrap_or(Value::Null);
    Ok(vec![entry(
        model,
        int(&u, "input_tokens"),
        int(&u, "output_tokens"),
        int(&u, "cache_read_input_tokens"),
        int(&u, "cache_creation_input_tokens"),
        v.get("total_cost_usd").and_then(Value::as_f64),
    )])
}

/// `naru cc ledger add`: validate `raw`, refuse a call that already has a
/// transcript (it is counted from there), and append its entries to the
/// ledger in one write. Returns what was written.
pub fn add(
    raw: &str,
    source: &str,
    at: Option<&str>,
    model: Option<&str>,
) -> Result<Vec<LedgerEntry>> {
    if source.trim().is_empty() {
        return Err(Error::Validation("--source must not be empty".into()));
    }
    let at = match at {
        Some(a) => fmt_ts(
            parse_ts(a)
                .ok_or_else(|| Error::Validation(format!("--at {a:?} is not an RFC 3339 time")))?,
        ),
        None => fmt_ts(now_unix()),
    };
    let entries = entries_from_result(raw, source.trim(), &at, model)?;
    if let Some(sid) = entries[0].session_id.as_deref()
        && find_transcript(sid).is_some()
    {
        return Err(Error::Validation(format!(
            "session {sid} already has a transcript and is counted from it; \
             adding it to the ledger would count it twice"
        )));
    }
    let mut buf = String::new();
    for e in &entries {
        buf.push_str(&serde_json::to_string(e).map_err(|e| Error::Io(std::io::Error::other(e)))?);
        buf.push('\n');
    }
    let path = ledger_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    // One write call on an O_APPEND handle, so concurrent adders interleave
    // whole batches, never half lines.
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    f.write_all(buf.as_bytes())?;
    Ok(entries)
}

/// The session id a ledger entry is counted under.
/// With no `session_id` the bare result uuid keys it (the `id` minus its
/// `:<model>` suffix), so one multi-model call is one session.
fn session_of(e: &LedgerEntry) -> String {
    e.session_id.clone().unwrap_or_else(|| {
        let uuid = e.id.strip_suffix(&format!(":{}", e.model)).unwrap_or(&e.id);
        format!("headless:{uuid}")
    })
}

/// Fold the complete lines of `bytes` into a batch, skipping malformed ones.
/// Returns the batch and the bytes consumed (through the last newline).
fn parse_batch(bytes: &[u8]) -> (CcFileBatch, usize) {
    let end = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let mut batch = CcFileBatch::default();
    let mut sessions: BTreeMap<String, CcSessionUpsert> = BTreeMap::new();
    for line in String::from_utf8_lossy(&bytes[..end]).lines() {
        let Ok(e) = serde_json::from_str::<LedgerEntry>(line) else {
            continue;
        };
        let Some(ts) = parse_ts(&e.at) else { continue };
        if e.id.is_empty() || e.model.is_empty() {
            continue;
        }
        let sid = session_of(&e);
        let s = sessions.entry(sid.clone()).or_insert(CcSessionUpsert {
            session_id: sid.clone(),
            cwd: None,
            git_branch: Some(format!("headless:{}", e.source)),
            entrypoint: Some(HEADLESS_ENTRYPOINT.to_string()),
            used_subagent: false,
            start_ts: Some(ts),
            end_ts: Some(ts),
            main_agent: None,
        });
        s.start_ts = s.start_ts.map(|t| t.min(ts));
        s.end_ts = s.end_ts.map(|t| t.max(ts));
        batch.messages.push(CcMessageRow {
            uuid: format!("headless:{}", e.id),
            message_id: None,
            session_id: sid,
            agent_id: None,
            ts,
            model: e.model,
            input_tokens: e.input_tokens,
            output_tokens: e.output_tokens,
            cache_read_tokens: e.cache_read_tokens,
            cache_creation_tokens: e.cache_creation_tokens,
            skill: None,
            agent: None,
            preview: None,
            cost_micro_usd: e.cost_usd.map(|c| (c * 1e6).round() as i64),
        });
    }
    batch.sessions = sessions.into_values().collect();
    (batch, end)
}

/// Ingest the ledger against its `cc_files` cursor (the same mechanism as a
/// transcript). A missing ledger is not an error.
pub fn ingest(
    store: &mut Store,
    cursors: &HashMap<String, CcFileCursor>,
    report: &mut CcSyncReport,
    touched: &mut HashSet<String>,
) -> Result<()> {
    let path = ledger_path();
    let Ok(meta) = fs::metadata(&path) else {
        return Ok(());
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs() as i64);
    let size = meta.len() as i64;
    let key = path.to_string_lossy().to_string();
    report.files_scanned += 1;
    let start = match cursors.get(&key) {
        Some(c) if c.mtime == mtime && c.size == size => return Ok(()),
        Some(c) if size >= c.size => c.byte_offset.max(0) as usize,
        _ => 0,
    };
    let Ok(bytes) = fs::read(&path) else {
        return Ok(());
    };
    let start = start.min(bytes.len());
    let (mut batch, consumed) = parse_batch(&bytes[start..]);
    // Double-count guard: a session that already has a transcript is counted
    // from it, so its ledger entries are dropped.
    let mut skip: HashSet<String> = HashSet::new();
    for s in &batch.sessions {
        if store
            .cc_session_entrypoint(&s.session_id)?
            .is_some_and(|ep| ep.as_deref() != Some(HEADLESS_ENTRYPOINT))
        {
            skip.insert(s.session_id.clone());
        }
    }
    batch.sessions.retain(|s| !skip.contains(&s.session_id));
    batch.messages.retain(|m| !skip.contains(&m.session_id));
    for s in &batch.sessions {
        touched.insert(s.session_id.clone());
    }
    let cursor = CcFileCursor {
        mtime,
        size: bytes.len() as i64,
        byte_offset: (start + consumed) as i64,
    };
    let counts = store.cc_ingest_file(&key, &cursor, &batch)?;
    report.files_ingested += 1;
    report.messages_added += counts.messages_added;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::attachments::ENV_LOCK;

    const RESULT: &str = r#"{"type":"result","uuid":"u-1","session_id":"s-1","total_cost_usd":0.5,
        "usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40},
        "modelUsage":{"claude-haiku-4-5":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":3,"cacheCreationInputTokens":4,"costUSD":0.25},
                      "claude-sonnet-4-5":{"inputTokens":5,"outputTokens":6,"cacheReadInputTokens":7,"cacheCreationInputTokens":8,"costUSD":0.125}}}"#;

    #[test]
    fn one_entry_per_model_with_its_own_cost() {
        let es = entries_from_result(RESULT, "t", "2026-01-02T03:04:05Z", None).unwrap();
        assert_eq!(es.len(), 2);
        assert_eq!(es[0].id, "u-1:claude-haiku-4-5");
        assert_eq!(es[0].cache_creation_tokens, 4);
        assert!((es.iter().filter_map(|e| e.cost_usd).sum::<f64>() - 0.375).abs() < 1e-9);
    }

    #[test]
    fn falls_back_to_usage_and_needs_a_model() {
        let raw = r#"{"uuid":"u","total_cost_usd":0.5,"usage":{"input_tokens":10}}"#;
        assert!(matches!(
            entries_from_result(raw, "t", "x", None),
            Err(Error::Validation(_))
        ));
        let es = entries_from_result(raw, "t", "x", Some("m")).unwrap();
        assert_eq!((es[0].input_tokens, es[0].cost_usd), (10, Some(0.5)));
        assert_eq!(es[0].session_id, None);
    }

    #[test]
    fn unknown_cost_stays_none_and_uuid_keys_one_session() {
        let raw = r#"{"uuid":"u9","modelUsage":{"a":{"inputTokens":1},"b":{"inputTokens":2,"costUSD":0.5}}}"#;
        let es = entries_from_result(raw, "t", "2026-01-02T03:04:05Z", None).unwrap();
        assert_eq!(es[0].cost_usd, None);
        let line: String = es
            .iter()
            .map(|e| serde_json::to_string(e).unwrap() + "\n")
            .collect();
        let (batch, _) = parse_batch(line.as_bytes());
        assert_eq!(batch.sessions.len(), 1);
        assert_eq!(batch.sessions[0].session_id, "headless:u9");
        let costs: Vec<_> = batch.messages.iter().map(|m| m.cost_micro_usd).collect();
        assert_eq!(costs, vec![None, Some(500_000)]);
    }

    #[test]
    fn garbage_and_missing_uuid_are_validation() {
        for raw in ["", "nope", "[1]", r#"{"session_id":"s"}"#] {
            assert!(matches!(
                entries_from_result(raw, "t", "x", Some("m")),
                Err(Error::Validation(_))
            ));
        }
    }

    #[test]
    fn add_appends_refuses_a_transcribed_session_and_ingest_is_idempotent() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let ledger = dir.path().join("usage/headless.jsonl");
        let projects = dir.path().join("projects");
        fs::create_dir_all(projects.join("slug")).unwrap();
        // SAFETY: ENV_LOCK gives this test exclusive access to the env.
        unsafe {
            std::env::set_var("MESA_CC_LEDGER", &ledger);
            std::env::set_var("MESA_CC_PROJECTS_DIR", &projects);
        }
        let written = add(RESULT, "t", Some("2026-01-02T03:04:05Z"), None).unwrap();
        assert_eq!(written.len(), 2);
        add(RESULT, "t", Some("2026-01-02T03:04:05Z"), None).unwrap();
        assert_eq!(fs::read_to_string(&ledger).unwrap().lines().count(), 4);

        // Ledger entries for a session that already has an ingested
        // transcript are dropped at ingest.
        let mut store = Store::open(&dir.path().join("t.db")).unwrap();
        let batch = CcFileBatch {
            sessions: vec![CcSessionUpsert {
                session_id: "s-1".into(),
                cwd: None,
                git_branch: None,
                entrypoint: Some("cli".into()),
                used_subagent: false,
                start_ts: Some(1),
                end_ts: Some(1),
                main_agent: None,
            }],
            ..Default::default()
        };
        let cur = CcFileCursor {
            mtime: 1,
            size: 1,
            byte_offset: 1,
        };
        store.cc_ingest_file("/x.jsonl", &cur, &batch).unwrap();
        let mut report = CcSyncReport::default();
        ingest(
            &mut store,
            &HashMap::new(),
            &mut report,
            &mut HashSet::new(),
        )
        .unwrap();
        assert_eq!(report.messages_added, 0);
        drop(store);
        let _ = fs::remove_file(dir.path().join("t.db"));

        // A malformed line is skipped, not fatal.
        let mut f = fs::OpenOptions::new().append(true).open(&ledger).unwrap();
        f.write_all(b"{broken\n").unwrap();
        drop(f);
        let mut store = Store::open(&dir.path().join("t.db")).unwrap();
        let mut report = CcSyncReport::default();
        let mut touched = HashSet::new();
        ingest(&mut store, &HashMap::new(), &mut report, &mut touched).unwrap();
        // Four lines, two distinct ids: duplicates insert nothing.
        assert_eq!(report.messages_added, 2);
        assert_eq!(touched.len(), 1);

        fs::write(projects.join("slug/s-1.jsonl"), "").unwrap();
        assert!(matches!(
            add(RESULT, "t", None, None),
            Err(Error::Validation(_))
        ));
        unsafe {
            std::env::remove_var("MESA_CC_LEDGER");
            std::env::remove_var("MESA_CC_PROJECTS_DIR");
        }
    }
}
