//! The memory jobs (naru task 1690): the live conversation's **summary**, the
//! live notebook's **dream** and a project notebook's **dream**, each one
//! synchronous `claude -p --output-format json --json-schema` call with no
//! tools, whose structured answer **Naru applies itself** through the guarded
//! `Store` methods. They used to be `claude --bg` agents driving `naru live …`
//! / `naru memory …` commands; an agent with Bash and a transcript of dictated
//! speech was the wrong shape for "write one paragraph and tidy a list".
//!
//! A job runs inside a **detached hidden self-process** — `naru __job <kind>`,
//! started by [`spawn`] in its own process group with stdout and stderr
//! appended to `logs/memory-jobs.log` — so `naru live stop`, `handoff`,
//! `DELETE /api/live` and a task close still return at once, as `--bg` let
//! them. The server starts the same child (a thread inside it would have no pid
//! of its own to probe and would die with it). The receipt is the marker
//! `pid:<n>`, stored in the columns that held a `--bg` job id
//! (`live_sessions.dream_agent_id`, `project_dreams.agent_id`); [`is_running`]
//! answers it, and still answers an old `--bg` receipt through `claude agents`.
//!
//! Every edit is applied on its own, so one refused edit (an unknown id, the
//! removal guard) never blocks the rest; the one-line JSON report of what was
//! applied and what failed goes to stdout, i.e. the log.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::core::{
    Error, Priority, Result, Status, Store, agents, config, inbox_triage, library, live, llm,
    project_memory, retro, runner, script_runs,
};

/// How long one job's `claude` call may run before it is killed.
const JOB_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// A summary adds at most this many notebook bullets (the prompt says two).
const NOTEBOOK_ADD_MAX: usize = 2;

/// One memory job.
#[derive(Debug, Clone, PartialEq)]
pub enum Job {
    /// Summarise an ended live session; `name` is the claude session name.
    Summary { session_id: i64, name: String },
    /// Dream over the live notebook; `session_id` is the newest conversation
    /// (its project is where a contradiction task lands), `None` on an
    /// install that never held one.
    Dream { session_id: Option<i64> },
    /// Dream over one project's notebook.
    ProjectDream { project_id: i64 },
    /// Triage one inbox change request (naru task 1691): two `-p` calls,
    /// applied by `core::inbox_triage`; `name` is the claude session name.
    InboxTriage { item_id: i64, name: String },
    /// Run one session retrospective (naru task 1692): a `haiku` skim per
    /// session and one `sonnet` roll-up, applied by `core::retro`; `run_id`
    /// is the `retro_runs` claim; the claude session names are derived from it.
    Retro { run_id: i64 },
}

impl Job {
    /// The `naru __job` argv for this job in `dir`.
    fn args(&self, dir: &str) -> Vec<String> {
        let mut a = vec!["__job".to_string()];
        match self {
            Job::Summary { session_id, name } => {
                a.extend(["summary".into(), "--session".into(), session_id.to_string()]);
                a.extend(["--name".into(), name.clone()]);
            }
            Job::Dream { session_id } => {
                a.push("dream".into());
                if let Some(id) = session_id {
                    a.extend(["--session".into(), id.to_string()]);
                }
            }
            Job::ProjectDream { project_id } => {
                a.extend([
                    "project-dream".into(),
                    "--project".into(),
                    project_id.to_string(),
                ]);
            }
            Job::InboxTriage { item_id, name } => {
                a.extend(["inbox-triage".into(), "--item".into(), item_id.to_string()]);
                a.extend(["--name".into(), name.clone()]);
            }
            Job::Retro { run_id } => {
                a.extend(["retro".into(), "--run".into(), run_id.to_string()]);
            }
        }
        a.extend(["--dir".into(), dir.to_string()]);
        a
    }

    /// The log this job's stdout and stderr are appended to.
    fn log_name(&self) -> &'static str {
        match self {
            Job::InboxTriage { .. } => "inbox-triage.log",
            Job::Retro { .. } => "retro.log",
            _ => "memory-jobs.log",
        }
    }
}

/// `logs/<name>` in Naru's home directory, beside the reaper's.
fn log_path(name: &str) -> PathBuf {
    let home = directories::BaseDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    config::dot_dir_in(&home).join("logs").join(name)
}

/// The program a job re-runs: `NARU_SELF_BIN` (the test seam — inside `cargo
/// test` the current exe is the harness) or this executable.
fn self_exe() -> std::io::Result<PathBuf> {
    match crate::core::env::var("SELF_BIN").filter(|v| !v.is_empty()) {
        Some(bin) => Ok(PathBuf::from(bin)),
        None => std::env::current_exe(),
    }
}

/// Starts `job` as a detached `naru __job` in `dir` and answers the
/// `pid:<n>` marker. `db` is the store the caller holds, handed to the child
/// as `NARU_DB` so it works the same db. Never waits for the job: its own
/// process group, no stdin, output appended to the log, and a reaping thread
/// so a long-lived server keeps no zombie (which `kill -0` would read as
/// alive).
pub fn spawn(job: &Job, dir: &str, db: Option<&Path>) -> std::result::Result<String, String> {
    let log = log_path(job.log_name());
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map_err(|e| format!("cannot open {}: {e}", log.display()))?;
    let exe = self_exe().map_err(|e| format!("cannot find the naru executable: {e}"))?;
    let mut cmd = Command::new(exe);
    cmd.args(job.args(dir))
        .stdin(Stdio::null())
        .stdout(out.try_clone().map_err(|e| e.to_string())?)
        .stderr(out);
    crate::core::proc::isolate(&mut cmd);
    if let Some(db) = db {
        cmd.env("NARU_DB", db);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("cannot start the memory job: {e}"))?;
    let marker = format!("pid:{}", child.id());
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(marker)
}

/// Whether the job a stored receipt names is still running. `pid:<n>` is
/// alive iff the pid exists **and** its command line is a `__job` (a recycled
/// pid names some other program); anything else is a `claude --bg` job id
/// from before naru task 1690, still answered through `claude agents`. Every
/// failure is `false`, so a probe that cannot answer never keeps a
/// conversation waiting.
pub fn is_running(marker: &str) -> bool {
    match marker
        .strip_prefix("pid:")
        .and_then(|n| n.parse::<i64>().ok())
    {
        Some(pid) => {
            script_runs::pid_is_live(pid)
                && runner::pid_command(pid).is_some_and(|c| c.contains("__job"))
        }
        None => agents::job_running(marker),
    }
}

/// `naru __job`: runs `job` to completion in this process and prints the
/// one-line JSON report. Called in the detached child.
pub fn run(job: &Job, dir: &str) -> Result<()> {
    let mut store = Store::open_default()?;
    let report = run_with(&mut store, job, dir, JOB_TIMEOUT)?;
    println!("{report}");
    let _ = std::io::stdout().flush();
    Ok(())
}

/// [`run`] against an open store and a chosen timeout: builds the prompt from
/// fresh store state, makes the one call, applies the answer.
pub fn run_with(store: &mut Store, job: &Job, dir: &str, timeout: Duration) -> Result<Value> {
    let prompts = library::prompts(store)?;
    let unavailable = |e: String| Error::Unavailable(e);
    match job {
        Job::Summary { session_id, name } => {
            let prompt = live::summary_prompt(store, *session_id);
            let out = llm::complete_structured(
                config::LIVE_SUMMARY,
                Some(*session_id),
                name,
                &prompt,
                live::SUMMARY_SCHEMA,
                None,
                &prompts,
                dir,
                timeout,
            )
            .map_err(unavailable)?;
            let mut report = apply_summary(store, *session_id, &out)?;
            report["kind"] = json!("summary");
            report["session_id"] = json!(session_id);
            Ok(report)
        }
        Job::Dream { session_id } => {
            let project = match session_id {
                Some(id) => store.get_live_session(*id)?.project_id,
                None => None,
            };
            let prompt = live::dream_prompt(store, project);
            let out = llm::complete_structured(
                config::LIVE_DREAM,
                *session_id,
                "live memory dream",
                &prompt,
                live::LIVE_DREAM_SCHEMA,
                None,
                &prompts,
                dir,
                timeout,
            )
            .map_err(unavailable)?;
            let mut report = apply_dream(store, None, project, &out);
            report["kind"] = json!("dream");
            report["session_id"] = json!(session_id);
            Ok(report)
        }
        Job::ProjectDream { project_id } => {
            let entries = store.list_notebook_in(Some(*project_id), false)?;
            let prompt = project_memory::dream_prompt(*project_id, &entries);
            let out = llm::complete_structured(
                config::LIVE_DREAM,
                None,
                "project memory dream",
                &prompt,
                live::PROJECT_DREAM_SCHEMA,
                None,
                &prompts,
                dir,
                timeout,
            )
            .map_err(unavailable)?;
            let mut report = apply_dream(store, Some(*project_id), Some(*project_id), &out);
            report["kind"] = json!("project-dream");
            report["project_id"] = json!(project_id);
            Ok(report)
        }
        Job::InboxTriage { item_id, name } => {
            inbox_triage::run_with(store, *item_id, &mut |model, prompt, schema| {
                llm::complete_structured(
                    config::INBOX_WATCHER,
                    Some(*item_id),
                    name,
                    prompt,
                    schema,
                    Some(model),
                    &prompts,
                    dir,
                    timeout,
                )
            })
        }
        Job::Retro { run_id } => {
            let calls = std::cell::Cell::new(0u32);
            let report =
                retro::run_with(store, *run_id, &mut |model, call_name, prompt, schema| {
                    calls.set(calls.get() + 1);
                    llm::complete_structured(
                        config::RETRO,
                        Some(*run_id),
                        call_name,
                        prompt,
                        schema,
                        Some(model),
                        &prompts,
                        dir,
                        timeout,
                    )
                });
            // A failure before any model call (a gather error) gives the claim
            // back so the next tick retries. One after calls were paid for
            // keeps the row, so the interval backs off instead of re-running
            // the whole skim set every tick; the error is logged.
            if let Err(e) = &report {
                if calls.get() == 0 {
                    let _ = store.delete_retro_run(*run_id);
                } else {
                    eprintln!(
                        "retro run {run_id}: failed after {} model call(s); the run row is kept, so the next run waits out the interval: {e}",
                        calls.get()
                    );
                }
            }
            report
        }
    }
}

/// Saves the summary and the (at most [`NOTEBOOK_ADD_MAX`]) notebook bullets.
/// A missing or empty `summary` is an error; a refused bullet is a `failed`
/// entry beside the others.
pub fn apply_summary(store: &mut Store, session_id: i64, out: &Value) -> Result<Value> {
    let summary = out["summary"].as_str().unwrap_or_default();
    if summary.trim().is_empty() {
        return Err(Error::Validation(
            "the model's answer holds no summary".into(),
        ));
    }
    store.set_live_summary(session_id, summary)?;
    let mut applied = vec![json!({"op": "summary"})];
    let mut failed = Vec::new();
    let mut dropped = 0;
    let bullets: Vec<&str> = out["notebook_add"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for (i, body) in bullets.iter().enumerate() {
        if i >= NOTEBOOK_ADD_MAX {
            dropped += 1;
            continue;
        }
        match store.add_notebook_entry(body) {
            Ok(e) => applied.push(json!({"op": "add", "entry_id": e.id})),
            Err(e) => {
                failed.push(json!({"edit": {"op": "add", "body": body}, "error": e.to_string()}))
            }
        }
    }
    Ok(json!({"applied": applied, "failed": failed, "dropped": dropped}))
}

/// One dream edit, as the schemas shape it.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum DreamEdit {
    Merge { ids: Vec<i64>, body: String },
    Delete { id: i64 },
    Keep { id: i64 },
    Replace { id: i64, body: String },
}

/// Applies a dream answer to the notebook at `scope` (`None` = the live
/// notebook, `Some(project)` = that project's). Every edit is tried through
/// its own guarded `Store` call whatever happened to the one before; a
/// failure is recorded, never fatal. Each contradiction becomes a **backlog**
/// task in `task_project` when one is known, and is otherwise only named in
/// the report's `contradictions_unfiled`.
pub fn apply_dream(
    store: &mut Store,
    scope: Option<i64>,
    task_project: Option<i64>,
    out: &Value,
) -> Value {
    let mut applied = Vec::new();
    let mut failed = Vec::new();
    for raw in out["edits"].as_array().cloned().unwrap_or_default() {
        let edit = match serde_json::from_value::<DreamEdit>(raw.clone()) {
            Ok(e) => e,
            Err(e) => {
                failed.push(json!({"edit": raw, "error": format!("not a valid edit: {e}")}));
                continue;
            }
        };
        let result = match &edit {
            DreamEdit::Merge { ids, body } => store
                .merge_notebook_entries_in(scope, ids, body)
                .map(|e| json!({"op": "merge", "ids": ids, "entry_id": e.id})),
            DreamEdit::Delete { id } => store
                .delete_notebook_entry_in(scope, *id)
                .map(|e| json!({"op": "delete", "entry_id": e.id})),
            DreamEdit::Replace { id, body } => store
                .replace_notebook_entry_in(scope, *id, body)
                .map(|e| json!({"op": "replace", "entry_id": e.id})),
            DreamEdit::Keep { id } if scope.is_none() => store
                .keep_notebook_entry(*id)
                .map(|e| json!({"op": "keep", "entry_id": e.id})),
            DreamEdit::Keep { .. } => Err(Error::Validation(
                "a project notebook has no kept entries".into(),
            )),
        };
        match result {
            Ok(done) => applied.push(done),
            Err(e) => failed.push(json!({"edit": raw, "error": e.to_string()})),
        }
    }
    let mut tasks = Vec::new();
    let mut unfiled = Vec::new();
    for c in out["contradictions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        let description = c["description"].as_str().unwrap_or_default().trim();
        if description.is_empty() {
            continue;
        }
        // Sorted, so the same pair in either order is the same marker.
        let mut nums: Vec<i64> = c["ids"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default();
        nums.sort_unstable();
        nums.dedup();
        let ids = nums
            .iter()
            .map(|i| format!("#{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let Some(project) = task_project else {
            unfiled.push(c);
            continue;
        };
        let marker = format!("(entries {ids})");
        // Each dream would otherwise re-file the same contradiction: skip it
        // while an open task in the project already carries the marker.
        let already = !nums.is_empty()
            && store.list_tasks(Some(project)).is_ok_and(|ts| {
                ts.iter().any(|t| {
                    !matches!(t.status, Status::Done | Status::Cancelled)
                        && t.description.contains(&marker)
                })
            });
        if already {
            continue;
        }
        let text = format!("Notebook contradiction: {description} {marker}");
        match store.create_task(
            project,
            &text,
            Priority::Medium,
            &[],
            None,
            None,
            None,
            Some(Status::Backlog),
        ) {
            Ok(t) => tasks.push(t.id),
            Err(e) => failed.push(json!({"edit": {"contradiction": c}, "error": e.to_string()})),
        }
    }
    json!({
        "report": out["report"].as_str().unwrap_or_default(),
        "applied": applied,
        "failed": failed,
        "tasks": tasks,
        "contradictions_unfiled": unfiled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        (dir, store)
    }

    #[test]
    fn the_schemas_are_json_objects_and_the_project_one_has_no_keep() {
        for s in [
            live::SUMMARY_SCHEMA,
            live::LIVE_DREAM_SCHEMA,
            live::PROJECT_DREAM_SCHEMA,
        ] {
            let v: Value = serde_json::from_str(s).unwrap();
            assert_eq!(v["type"], "object", "{s}");
        }
        let any = |s: &str| -> Vec<String> {
            let v: Value = serde_json::from_str(s).unwrap();
            v["properties"]["edits"]["items"]["anyOf"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b["properties"]["op"]["const"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            any(live::LIVE_DREAM_SCHEMA),
            ["merge", "delete", "keep", "replace"]
        );
        assert_eq!(
            any(live::PROJECT_DREAM_SCHEMA),
            ["merge", "delete", "replace"]
        );
    }

    #[test]
    fn job_args_name_the_kind_and_the_folder() {
        let job = Job::Summary {
            session_id: 4,
            name: "n summary".into(),
        };
        assert_eq!(
            job.args("/w"),
            [
                "__job",
                "summary",
                "--session",
                "4",
                "--name",
                "n summary",
                "--dir",
                "/w"
            ]
        );
        assert_eq!(
            Job::Dream { session_id: None }.args("/w"),
            ["__job", "dream", "--dir", "/w"]
        );
        assert_eq!(
            Job::ProjectDream { project_id: 9 }.args("/w"),
            ["__job", "project-dream", "--project", "9", "--dir", "/w"]
        );
        let triage = Job::InboxTriage {
            item_id: 5,
            name: "inbox 5".into(),
        };
        assert_eq!(
            triage.args("/w"),
            [
                "__job",
                "inbox-triage",
                "--item",
                "5",
                "--name",
                "inbox 5",
                "--dir",
                "/w"
            ]
        );
        assert_eq!(triage.log_name(), "inbox-triage.log");
        let retro = Job::Retro { run_id: 3 };
        assert_eq!(
            retro.args("/w"),
            ["__job", "retro", "--run", "3", "--dir", "/w"]
        );
        assert_eq!(retro.log_name(), "retro.log");
        assert_eq!(
            Job::Dream { session_id: None }.log_name(),
            "memory-jobs.log"
        );
    }

    #[test]
    fn a_summary_is_saved_and_only_two_bullets_are_added() {
        let (_d, mut store) = store();
        let s = store.start_live_session(None).unwrap();
        let out = json!({"summary": "We talked.", "notebook_add": ["one", "two", "three"]});
        let report = apply_summary(&mut store, s.id, &out).unwrap();
        assert_eq!(report["dropped"], 1);
        assert_eq!(report["applied"].as_array().unwrap().len(), 3);
        assert_eq!(store.list_notebook(false).unwrap().len(), 2);
        assert_eq!(store.list_live_summaries(1).unwrap()[0].body, "We talked.");
        // No summary text is an error, not an empty save.
        assert!(
            apply_summary(
                &mut store,
                s.id,
                &json!({"summary": " ", "notebook_add": []})
            )
            .is_err()
        );
    }

    #[test]
    fn one_refused_edit_does_not_block_the_others() {
        let (_d, mut store) = store();
        let a = store.add_notebook_entry("prefers short replies").unwrap();
        let b = store.add_notebook_entry("prefers brief replies").unwrap();
        let c = store.add_notebook_entry("task 42 is the roadmap").unwrap();
        let out = json!({
            "edits": [
                {"op": "delete", "id": 9999},
                {"op": "merge", "ids": [a.id, b.id], "body": "prefers short replies"},
                {"op": "bogus"},
                {"op": "keep", "id": c.id},
            ],
            "contradictions": [],
            "report": "tidied"
        });
        let report = apply_dream(&mut store, None, None, &out);
        assert_eq!(report["applied"].as_array().unwrap().len(), 2, "{report}");
        assert_eq!(report["failed"].as_array().unwrap().len(), 2, "{report}");
        assert_eq!(store.list_notebook(false).unwrap().len(), 2);
        assert!(store.get_notebook_entry(c.id).unwrap().kept_at.is_some());
    }

    #[test]
    fn a_contradiction_is_a_backlog_task_only_where_a_project_is_known() {
        let (_d, mut store) = store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let out = json!({
            "edits": [],
            "contradictions": [{"ids": [1, 2], "description": "tabs vs spaces"}],
            "report": "x"
        });
        let none = apply_dream(&mut store, None, None, &out);
        assert_eq!(none["tasks"].as_array().unwrap().len(), 0);
        assert_eq!(none["contradictions_unfiled"].as_array().unwrap().len(), 1);
        let some = apply_dream(&mut store, None, Some(p.id), &out);
        let id = some["tasks"][0].as_i64().unwrap();
        let task = store.get_task(id).unwrap();
        assert_eq!(task.status, Status::Backlog);
        assert!(task.description.contains("tabs vs spaces") && task.description.contains("#1, #2"));
    }

    #[test]
    fn a_contradiction_already_filed_and_open_is_not_filed_again() {
        let (_d, mut store) = store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let mk = |ids: Value| {
            json!({"edits": [], "report": "",
                   "contradictions": [{"ids": ids, "description": "tabs vs spaces"}]})
        };
        let first = apply_dream(&mut store, None, Some(p.id), &mk(json!([2, 1])));
        let id = first["tasks"][0].as_i64().unwrap();
        // The same pair, either order: nothing new while the task is open.
        for ids in [json!([1, 2]), json!([2, 1])] {
            let again = apply_dream(&mut store, None, Some(p.id), &mk(ids));
            assert_eq!(again["tasks"].as_array().unwrap().len(), 0, "{again}");
        }
        // A different pair is a different contradiction.
        let other = apply_dream(&mut store, None, Some(p.id), &mk(json!([1, 3])));
        assert_eq!(other["tasks"].as_array().unwrap().len(), 1);
        // Once the task is done, a recurrence is filed again.
        store
            .update_task(
                id,
                &crate::core::TaskPatch {
                    status: Some(Status::Done),
                    ..Default::default()
                },
            )
            .unwrap();
        let after = apply_dream(&mut store, None, Some(p.id), &mk(json!([1, 2])));
        assert_eq!(after["tasks"].as_array().unwrap().len(), 1, "{after}");
    }

    #[test]
    fn a_project_dream_refuses_keep_and_edits_its_own_notebook() {
        let (_d, mut store) = store();
        let p = store.create_project("p", None, None, None, None).unwrap();
        let e = store.add_notebook_entry_in(Some(p.id), "a b").unwrap();
        let out = json!({"edits": [{"op": "keep", "id": e.id}, {"op": "replace", "id": e.id, "body": "c"}],
                         "contradictions": [], "report": ""});
        let report = apply_dream(&mut store, Some(p.id), Some(p.id), &out);
        assert_eq!(report["failed"].as_array().unwrap().len(), 1, "{report}");
        assert_eq!(report["applied"].as_array().unwrap().len(), 1, "{report}");
    }

    #[test]
    fn is_running_needs_a_live_job_process() {
        // Not a pid at all, and a pid that is alive but is the test harness.
        assert!(!is_running("pid:2147483000"));
        assert!(!is_running(&format!("pid:{}", std::process::id())));
    }
}
