//! `naru stage run` (naru task 1959, docs/stage.md): the stage driver of the
//! task-loop workflow. It starts one agent run (or two, concurrently), watches
//! it with the `run wait` semantics, nudges a silent one once, restarts it
//! once from the same brief, cuts an overrun at the deadline, and prints one
//! JSON verdict. An agent that fails is data (`INCONCLUSIVE`), never an error:
//! only a bad argument or a driver bug is an `Err`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};

use super::runner::{self, StartOpts, WaitOpts};
use super::store::{Error, Result};

/// Longest report text one printed document carries, bytes (all agents
/// together): the whole document stays under 64 KiB.
pub const OUTPUT_CAP: usize = 60 * 1024;
/// Default grace after a nudge, seconds.
pub const GRACE_SECS: f64 = 180.0;
const SILENCE_NUDGE: &str = "Status check: report what you have so far, briefly.";
const DEADLINE_NUDGE: &str = "Deadline reached, report partial results now.";
const TAIL_CHARS: usize = 500;

pub struct AgentSpec {
    pub agent: String,
    pub brief: String,
}

pub struct StageOpts {
    pub stage: String,
    pub cwd: String,
    pub model: String,
    pub deadline: Duration,
    pub silence: Option<Duration>,
    pub grace: Duration,
    pub max_restarts: u32,
    pub scratch: PathBuf,
    pub poll: Duration,
}

/// One agent's entry in `status.json`.
#[derive(Debug, Clone, Serialize)]
struct AgentStatus {
    agent: String,
    job_id: Option<String>,
    job_ids: Vec<String>,
    /// `starting` | `running` | `complete` | `inconclusive`
    state: &'static str,
    started_at: i64,
    last_event_at: i64,
    output_tail: String,
    nudges: u32,
    restarts: u32,
}

/// Cuts `s` to at most `cap` bytes on a char boundary, with a marker.
pub fn cap_text(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let marker = format!("\n[truncated: {} bytes omitted]", s.len());
    let mut end = cap.saturating_sub(marker.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{marker}", &s[..end])
}

fn tail_of(s: &str) -> String {
    let n = s.chars().count();
    s.chars().skip(n.saturating_sub(TAIL_CHARS)).collect()
}

/// Lines of `events.jsonl` the agent wrote, i.e. not the runner's own.
fn agent_lines(runs: &Path, id: &str) -> usize {
    fs::read_to_string(runs.join(id).join("events.jsonl")).map_or(0, |t| {
        t.lines()
            .filter(|l| !l.trim().is_empty() && !l.contains("\"type\":\"naru_runner\""))
            .count()
    })
}

/// The newest assistant or result text in a run view's event tail.
fn last_text(events: &Value) -> Option<String> {
    events
        .as_array()?
        .iter()
        .rev()
        .find_map(|e| match e.get("type")?.as_str()? {
            "result" => e.get("result")?.as_str().map(str::to_string),
            "assistant" => {
                let t: Vec<&str> = e
                    .pointer("/message/content")?
                    .as_array()?
                    .iter()
                    .filter_map(|c| c.get("text").and_then(Value::as_str))
                    .collect();
                (!t.is_empty()).then(|| t.join("\n"))
            }
            _ => None,
        })
}

fn write_status(scratch: &Path, stage: &str, agents: &[AgentStatus]) {
    let body = json!({"stage": stage, "updated_at": runner::now_secs(), "agents": agents});
    let tmp = scratch.join("status.json.tmp");
    if fs::write(&tmp, body.to_string()).is_ok() {
        let _ = fs::rename(&tmp, scratch.join("status.json"));
    }
}

struct Shared<'a> {
    opts: &'a StageOpts,
    runs: &'a Path,
    status: Mutex<Vec<AgentStatus>>,
}

impl Shared<'_> {
    fn update(&self, idx: usize, f: impl FnOnce(&mut AgentStatus)) {
        let mut g = self.status.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut g[idx]);
        write_status(&self.opts.scratch, &self.opts.stage, &g);
    }
}

fn start_job(sh: &Shared, spec: &AgentSpec) -> Result<String> {
    let v = runner::start_in(
        sh.runs,
        &StartOpts {
            model: sh.opts.model.clone(),
            prompt: spec.brief.clone(),
            cwd: Some(sh.opts.cwd.clone()),
            name: None,
            agent: Some(spec.agent.clone()),
            idle_timeout_secs: None,
        },
    )?;
    v.get("job_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Error::Validation("run start returned no job_id".into()))
}

/// Drives one agent to a verdict document.
fn drive(sh: &Shared, idx: usize, spec: &AgentSpec) -> Value {
    let o = sh.opts;
    let t0 = Instant::now();
    let mut nudges = 0u32;
    let mut restarts = 0u32;
    let mut job_ids: Vec<String> = vec![];
    let mut text = String::new();

    let finish = |verdict: &'static str,
                  reason: Option<String>,
                  body: String,
                  job_ids: &[String],
                  nudges: u32,
                  restarts: u32,
                  tail: String|
     -> Value {
        sh.update(idx, |s| {
            s.state = if verdict == "COMPLETE" {
                "complete"
            } else {
                "inconclusive"
            };
            s.output_tail = tail;
            s.nudges = nudges;
            s.restarts = restarts;
        });
        let complete = verdict == "COMPLETE";
        json!({
            "verdict": verdict,
            "agent": spec.agent,
            "job_id": job_ids.last(),
            "job_ids": job_ids,
            "reason": reason,
            "report": complete.then(|| body.clone()),
            "partial": (!complete).then_some(body),
            "nudges": nudges,
            "restarts": restarts,
        })
    };

    let mut job_id = match start_job(sh, spec) {
        Ok(id) => id,
        Err(e) => {
            return finish(
                "INCONCLUSIVE",
                Some(format!("start failed: {e}")),
                String::new(),
                &job_ids,
                0,
                0,
                String::new(),
            );
        }
    };
    job_ids.push(job_id.clone());
    sh.update(idx, |s| {
        s.job_id = Some(job_id.clone());
        s.job_ids = job_ids.clone();
        s.state = "running";
    });
    let mut count = agent_lines(sh.runs, &job_id);
    let mut last_change = Instant::now();
    let mut nudge_at: Option<Instant> = None;
    let mut deadline_nudge_at: Option<Instant> = None;

    loop {
        let out = runner::wait_in(
            sh.runs,
            &job_id,
            &WaitOpts {
                deadline: o.poll,
                silence: None,
                poll: o.poll,
            },
        );
        let out = match out {
            Ok(v) => v,
            Err(e) => {
                return finish(
                    "INCONCLUSIVE",
                    Some(format!("run lost: {e}")),
                    text.clone(),
                    &job_ids,
                    nudges,
                    restarts,
                    tail_of(&text),
                );
            }
        };
        let job = &out.value["job"];
        if let Some(t) = last_text(&job["events"]) {
            text = t;
        }
        let n = agent_lines(sh.runs, &job_id);
        if n != count {
            count = n;
            last_change = Instant::now();
            sh.update(idx, |s| s.last_event_at = runner::now_secs());
        }
        sh.update(idx, |s| {
            s.output_tail = tail_of(&text);
            s.nudges = nudges;
            s.restarts = restarts;
        });

        match out.reason {
            "idle" | "finished" => {
                let result = job["last_result"].as_str().unwrap_or("").to_string();
                let _ = runner::stop_in(sh.runs, &job_id);
                let tail = tail_of(&result);
                if deadline_nudge_at.is_some() {
                    let partial = if result.is_empty() {
                        text.clone()
                    } else {
                        result
                    };
                    return finish(
                        "INCONCLUSIVE",
                        Some("deadline reached; partial report".into()),
                        partial,
                        &job_ids,
                        nudges,
                        restarts,
                        tail,
                    );
                }
                if result.trim().is_empty() {
                    return finish(
                        "INCONCLUSIVE",
                        Some("run ended without a final report".into()),
                        text.clone(),
                        &job_ids,
                        nudges,
                        restarts,
                        tail_of(&text),
                    );
                }
                return finish("COMPLETE", None, result, &job_ids, nudges, restarts, tail);
            }
            "failed" | "stopped" => {
                return finish(
                    "INCONCLUSIVE",
                    Some(format!("run {}", out.reason)),
                    text.clone(),
                    &job_ids,
                    nudges,
                    restarts,
                    tail_of(&text),
                );
            }
            _ => {}
        }

        // Still going: the deadline first, then the silence ladder.
        if t0.elapsed() >= o.deadline {
            match deadline_nudge_at {
                None => {
                    let _ = runner::send_in(sh.runs, &job_id, DEADLINE_NUDGE, false);
                    nudges += 1;
                    deadline_nudge_at = Some(Instant::now());
                }
                Some(t) if t.elapsed() >= o.grace => {
                    let _ = runner::stop_in(sh.runs, &job_id);
                    return finish(
                        "INCONCLUSIVE",
                        Some("deadline reached; no report".into()),
                        text.clone(),
                        &job_ids,
                        nudges,
                        restarts,
                        tail_of(&text),
                    );
                }
                Some(_) => {}
            }
        } else if let Some(silence) = o.silence {
            match nudge_at {
                None if last_change.elapsed() >= silence => {
                    let _ = runner::send_in(sh.runs, &job_id, SILENCE_NUDGE, false);
                    nudges += 1;
                    nudge_at = Some(Instant::now());
                }
                Some(t) if last_change > t => nudge_at = None,
                Some(t) if t.elapsed() >= o.grace => {
                    let _ = runner::stop_in(sh.runs, &job_id);
                    if restarts >= o.max_restarts {
                        return finish(
                            "INCONCLUSIVE",
                            Some("silent after nudge, restart budget spent".into()),
                            text.clone(),
                            &job_ids,
                            nudges,
                            restarts,
                            tail_of(&text),
                        );
                    }
                    restarts += 1;
                    match start_job(sh, spec) {
                        Ok(id) => {
                            job_id = id;
                            job_ids.push(job_id.clone());
                            count = agent_lines(sh.runs, &job_id);
                            last_change = Instant::now();
                            nudge_at = None;
                            text.clear();
                            sh.update(idx, |s| {
                                s.job_id = Some(job_id.clone());
                                s.job_ids = job_ids.clone();
                                s.restarts = restarts;
                                s.last_event_at = runner::now_secs();
                                s.output_tail = String::new();
                            });
                        }
                        Err(e) => {
                            return finish(
                                "INCONCLUSIVE",
                                Some(format!("restart failed: {e}")),
                                text.clone(),
                                &job_ids,
                                nudges,
                                restarts,
                                tail_of(&text),
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

/// Runs the stage; returns the document to print. One agent prints its own
/// verdict document; two print `{verdict, results: [..]}`.
pub fn run(runs: &Path, opts: &StageOpts, agents: &[AgentSpec]) -> Result<Value> {
    fs::create_dir_all(&opts.scratch)
        .map_err(|e| Error::Validation(format!("scratch dir {}: {e}", opts.scratch.display())))?;
    let now = runner::now_secs();
    let sh = Shared {
        opts,
        runs,
        status: Mutex::new(
            agents
                .iter()
                .map(|a| AgentStatus {
                    agent: a.agent.clone(),
                    job_id: None,
                    job_ids: vec![],
                    state: "starting",
                    started_at: now,
                    last_event_at: now,
                    output_tail: String::new(),
                    nudges: 0,
                    restarts: 0,
                })
                .collect(),
        ),
    };
    sh.update(0, |_| {});
    let mut results: Vec<Value> = std::thread::scope(|s| {
        let hs: Vec<_> = agents
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let sh = &sh;
                s.spawn(move || drive(sh, i, a))
            })
            .collect();
        hs.into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| json!({"verdict": "INCONCLUSIVE", "reason": "driver bug"}))
            })
            .collect()
    });
    let per = OUTPUT_CAP / agents.len().max(1);
    for r in &mut results {
        for k in ["report", "partial"] {
            if let Some(t) = r[k].as_str() {
                r[k] = json!(cap_text(t, per));
            }
        }
        r["scratch"] = json!(opts.scratch);
    }
    if results.len() == 1 {
        return Ok(results.remove(0));
    }
    let all = results.iter().all(|r| r["verdict"] == "COMPLETE");
    Ok(json!({
        "verdict": if all { "COMPLETE" } else { "INCONCLUSIVE" },
        "results": results,
        "scratch": opts.scratch,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_text_truncates_on_a_char_boundary_with_a_marker() {
        assert_eq!(cap_text("short", 100), "short");
        let long = "é".repeat(500);
        let c = cap_text(&long, 200);
        assert!(c.len() <= 200);
        assert!(c.contains("[truncated: 1000 bytes omitted]"));
    }

    #[test]
    fn last_text_prefers_the_newest_assistant_or_result() {
        let ev = json!([
            {"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}},
            {"type":"naru_runner","event":"x"},
            {"type":"result","result":"r"},
        ]);
        assert_eq!(last_text(&ev).as_deref(), Some("r"));
        assert_eq!(last_text(&json!([])), None);
    }
}
