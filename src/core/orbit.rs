//! The agent watcher's whole-machine feed (naru task 2540,
//! `docs/agent-watcher.md`): Naru's live voice, every running job — a task
//! being worked or a running workflow run — with its sub-agents, and
//! everything queued, each tagged with its project's colour.
//!
//! [`build`] is **pure**: the API handler reads the store, the Claude Code
//! session list and the watcher rows, and hands them over as [`Inputs`].
//! Nothing here is stored; every value is derived on each read.

use std::collections::{HashMap, HashSet};

use crate::core::Result;
use crate::core::cc;
use crate::core::store::Store;
use crate::core::types::{
    AgentOrbit, AgentSession, AgentWatchKind, AgentWatchRow, LiveRole, LiveSession, LiveTurn,
    OrbitAgent, OrbitJob, OrbitNaru, OrbitProject, OrbitQueued, Project, Status, Task, Workflow,
    WorkflowRun, WorkflowStepStatus,
};

/// One colour per project, chosen by `project id % len` — so a project keeps
/// its colour however the list is ordered or filtered. Naru's own purple
/// (`#a371f7`, the centre) is deliberately not in it.
pub const PROJECT_COLORS: [&str; 8] = [
    "#3fb950", "#58a6ff", "#d29922", "#f778ba", "#f0883e", "#39c5cf", "#ff7b72", "#8ddb8c",
];
/// The colour of a workflow that belongs to no project.
pub const GLOBAL_COLOR: &str = "#8b949e";
/// An unfinished sub-agent silent this long reads `waiting`, not `working`
/// (the agent watcher's `QUIET_GAP_S`).
pub const QUIET_SECS: i64 = 60;
/// An unplayed Naru turn younger than this means the voice is `speaking`;
/// an older one was never played (no browser held the conversation).
pub const SPEAKING_SECS: i64 = 30;

/// The project's colour (see [`PROJECT_COLORS`]).
pub fn project_color(project_id: i64) -> &'static str {
    PROJECT_COLORS[project_id.rem_euclid(PROJECT_COLORS.len() as i64) as usize]
}

/// Everything [`build`] reads.
pub struct Inputs {
    pub now: i64,
    /// Visible projects, in list order.
    pub projects: Vec<Project>,
    /// Every task of a visible project.
    pub tasks: Vec<Task>,
    /// Visible workflows.
    pub workflows: Vec<Workflow>,
    /// `running` workflow runs, each with its workflow's runnable node count
    /// (every node but `comment`).
    pub runs: Vec<(WorkflowRun, i64)>,
    /// Run ids with a pending gate.
    pub gated_runs: HashSet<i64>,
    /// The live session and its newest few turns.
    pub live: Option<(LiveSession, Vec<LiveTurn>)>,
    /// The Claude Code session list, or `None` when it could not be read.
    pub sessions: Option<Vec<AgentSession>>,
    /// The agent watcher's rows for those sessions (only subagent rows are
    /// read).
    pub watch_rows: Vec<AgentWatchRow>,
}

/// How many of the live session's newest turns [`from_store`] reads to find
/// the newest Naru turn.
const LIVE_TURNS_READ: i64 = 8;

/// Reads the store half of [`Inputs`] and builds the feed. `sessions` and
/// `watch_rows` come from the agents surface (the API's 2 s-cached panel
/// list); `None` sessions = the list could not be read.
pub fn from_store(
    store: &Store,
    now: i64,
    sessions: Option<Vec<AgentSession>>,
    watch_rows: Vec<AgentWatchRow>,
) -> Result<AgentOrbit> {
    let live = match store.current_live_session()? {
        Some(s) => {
            let turns = store.last_live_turns(s.id, LIVE_TURNS_READ)?;
            Some((s, turns))
        }
        None => None,
    };
    Ok(build(Inputs {
        now,
        projects: store.list_projects()?,
        tasks: store.list_tasks(None)?,
        workflows: store.list_workflows(None)?,
        runs: store.running_workflow_runs()?,
        gated_runs: store
            .list_workflow_gates(None, false)?
            .into_iter()
            .map(|g| g.run_id)
            .collect(),
        live,
        sessions,
        watch_rows,
    }))
}

pub fn build(i: Inputs) -> AgentOrbit {
    let names: HashMap<i64, &str> = i.projects.iter().map(|p| (p.id, p.name.as_str())).collect();
    let mut used: HashSet<i64> = HashSet::new();
    let sessions = i.sessions.as_deref().unwrap_or(&[]);

    let mut jobs = Vec::new();
    for t in &i.tasks {
        if t.status != Status::InProgress || !names.contains_key(&t.project_id) {
            continue;
        }
        let children: Vec<&Task> = i
            .tasks
            .iter()
            .filter(|c| c.parent_id == Some(t.id) && c.status != Status::Cancelled)
            .collect();
        let project_name = names[&t.project_id];
        let matched: Vec<(&AgentSession, Option<String>)> = sessions
            .iter()
            .filter_map(|s| session_for(s, t, project_name))
            .collect();
        // An umbrella (a parent with subtasks) nobody works directly is shown
        // through its children, the queue-watcher's leaf rule.
        if !children.is_empty() && matched.is_empty() {
            continue;
        }
        used.insert(t.project_id);
        jobs.push(task_job(
            t,
            project_name,
            &children,
            &matched,
            &i.watch_rows,
            i.now,
        ));
    }

    let workflows: HashMap<i64, &Workflow> = i.workflows.iter().map(|w| (w.id, w)).collect();
    for (run, nodes) in &i.runs {
        let Some(wf) = workflows.get(&run.workflow_id) else {
            continue;
        };
        if let Some(p) = wf.project_id {
            used.insert(p);
        }
        jobs.push(workflow_job(
            run,
            *nodes,
            wf,
            &names,
            i.gated_runs.contains(&run.id),
        ));
    }

    let mut queue = Vec::new();
    for t in &i.tasks {
        if t.status != Status::Todo || !names.contains_key(&t.project_id) {
            continue;
        }
        used.insert(t.project_id);
        queue.push(OrbitQueued {
            kind: "task".into(),
            id: t.id,
            title: t.name.clone(),
            project_id: Some(t.project_id),
            project_name: Some(names[&t.project_id].to_string()),
            color: project_color(t.project_id).into(),
            blocked: t.blocked,
            next_run_at: None,
        });
    }
    let running: HashSet<i64> = i.runs.iter().map(|(r, _)| r.workflow_id).collect();
    for w in &i.workflows {
        // A timed workflow is the one kind with a "next run"; one running
        // now is a job, not queued.
        if !w.enabled || w.trigger != Some(crate::core::types::WorkflowTrigger::Time) {
            continue;
        }
        if running.contains(&w.id) {
            continue;
        }
        if let Some(p) = w.project_id {
            used.insert(p);
        }
        queue.push(OrbitQueued {
            kind: "workflow".into(),
            id: w.id,
            title: w.name.clone(),
            project_id: w.project_id,
            project_name: w
                .project_id
                .and_then(|p| names.get(&p))
                .map(|n| n.to_string()),
            color: w.project_id.map_or(GLOBAL_COLOR, project_color).into(),
            blocked: false,
            next_run_at: w.next_run_at.clone(),
        });
    }

    AgentOrbit {
        now: i.now,
        naru: naru_state(i.live.as_ref(), i.now),
        agents_available: i.sessions.is_some(),
        jobs,
        queue,
        projects: i
            .projects
            .iter()
            .filter(|p| used.contains(&p.id))
            .map(|p| OrbitProject {
                id: p.id,
                name: p.name.clone(),
                color: project_color(p.id).into(),
            })
            .collect(),
    }
}

/// Whether `s` works task `t`, and the stage its name declares. A session is
/// matched by the task's `owner` (`AgentSession::task_id`), by a stage
/// driver's `task <id> · <stage> (<agent>)` name, or by the queue-watcher's
/// `<project>: <task name>` name (before the agent has claimed it).
fn session_for<'a>(
    s: &'a AgentSession,
    t: &Task,
    project: &str,
) -> Option<(&'a AgentSession, Option<String>)> {
    let name = s.name.as_deref().unwrap_or("");
    if let Some((id, stage)) = parse_stage_name(name)
        && id == t.id
    {
        return Some((s, Some(stage)));
    }
    // The name fallback only for a session nothing has claimed yet: a name
    // is not unique (two tasks can share a first line), an owner is.
    let named = s.task_id.is_none() && !name.is_empty() && name == format!("{project}: {}", t.name);
    if s.task_id == Some(t.id) || named {
        return Some((s, None));
    }
    None
}

/// `task <id> · <stage> (<agent>)` (`core::stage`) as `(id, stage)`.
fn parse_stage_name(name: &str) -> Option<(i64, String)> {
    let rest = name.strip_prefix("task ")?;
    let (id, rest) = rest.split_once(" · ")?;
    let id = id.parse().ok()?;
    let stage = rest.rsplit_once(" (").map_or(rest, |(s, _)| s).trim();
    (!stage.is_empty()).then(|| (id, stage.to_lowercase()))
}

/// A subagent's role from its `agentType`.
pub fn role_of(agent_type: &str) -> &'static str {
    let a = agent_type.to_lowercase();
    match a.as_str() {
        "recon" | "explore" => "recon",
        "planner" | "plan" | "ux-designer" => "plan",
        "implementer" | "swift-implementer" => "build",
        "diff-reviewer" | "reviewer" | "code-reviewer" => "review",
        "verifier" => "test",
        "ui-verifier" => "check",
        _ if a.contains("review") => "review",
        _ if a.contains("ui-verif") || a.contains("check") => "check",
        _ if a.contains("verif") || a.contains("test") => "test",
        _ if a.contains("implement") || a.contains("build") => "build",
        _ if a.contains("plan") || a.contains("design") => "plan",
        _ if a.contains("recon") || a.contains("explore") || a.contains("search") => "recon",
        _ => "agent",
    }
}

/// The job stage a role (or a stage driver's stage name) stands for.
fn stage_of(role: &str) -> &'static str {
    match role_of(role) {
        "recon" => "recon",
        "plan" => "plan",
        "build" => "build",
        "review" => "review",
        "test" | "check" => "verify",
        _ => "working",
    }
}

/// How far through the usual plan → build → review → verify loop a stage
/// is, for the estimated progress ring. `working` says nothing.
fn stage_weight(stage: &str) -> f64 {
    match stage {
        "recon" => 0.15,
        "plan" => 0.25,
        "build" => 0.5,
        "review" => 0.7,
        "verify" => 0.85,
        _ => 0.0,
    }
}

/// The progress a just-started job shows before any stage is seen.
const STARTED: f64 = 0.05;

fn task_job(
    t: &Task,
    project: &str,
    children: &[&Task],
    matched: &[(&AgentSession, Option<String>)],
    rows: &[AgentWatchRow],
    now: i64,
) -> OrbitJob {
    let mut agents: Vec<OrbitAgent> = Vec::new();
    for (s, _) in matched {
        for r in rows
            .iter()
            .filter(|r| r.kind == AgentWatchKind::Subagent && r.session_id == s.session_id)
        {
            agents.push(OrbitAgent {
                key: r.key.clone(),
                role: role_of(&r.label).into(),
                label: r.label.clone(),
                detail: r.detail.clone(),
                state: if r.finished {
                    "done"
                } else if r.last_event_at.is_some_and(|at| now - at <= QUIET_SECS) {
                    "working"
                } else {
                    "waiting"
                }
                .into(),
                started_at: r.started_at,
                last_event_at: r.last_event_at,
            });
        }
    }
    agents.sort_by_key(|a| (a.started_at.unwrap_or(i64::MAX), a.key.clone()));

    // The newest stage-driver session's stage: an earlier stage's session
    // can still be listed after the next one starts.
    let declared = matched
        .iter()
        .filter(|(_, stage)| stage.is_some())
        .max_by_key(|(s, _)| s.started_at)
        .and_then(|(_, stage)| stage.clone());
    let stage = match &declared {
        Some(s) => stage_of(s).to_string(),
        None => agents
            .iter()
            .rev()
            .find(|a| a.state != "done")
            .map_or("working", |a| stage_of(&a.role))
            .to_string(),
    };

    let (progress, estimated) = if children.is_empty() {
        let seen = agents
            .iter()
            .map(|a| stage_weight(stage_of(&a.role)))
            .chain([stage_weight(&stage), STARTED])
            .fold(0.0, f64::max);
        (seen, true)
    } else {
        let done = children.iter().filter(|c| c.status == Status::Done).count();
        (done as f64 / children.len() as f64, false)
    };

    let session_state = |s: &AgentSession| {
        if s.stalled {
            "stalled"
        } else if s.state.as_deref() == Some("blocked") || s.waiting_for.is_some() {
            "waiting"
        } else if s.pid.is_none()
            || matches!(s.state.as_deref(), Some("done" | "failed" | "stopped"))
                && s.live_shells == 0
                && s.live_subagents == 0
        {
            "idle"
        } else {
            "working"
        }
    };
    // The most urgent state of any matched session wins.
    let state = ["waiting", "stalled", "working"]
        .into_iter()
        .find(|st| matched.iter().any(|(s, _)| session_state(s) == *st))
        .unwrap_or("idle");

    let first = matched.iter().map(|(s, _)| *s).min_by_key(|s| s.started_at);
    OrbitJob {
        kind: "task".into(),
        id: t.id,
        workflow_id: None,
        title: t.name.clone(),
        project_id: Some(t.project_id),
        project_name: Some(project.to_string()),
        color: project_color(t.project_id).into(),
        stage,
        progress,
        progress_estimated: estimated,
        state: state.into(),
        session_id: first.map(|s| s.session_id.clone()),
        started_at: first
            .map(|s| s.started_at / 1000)
            .or_else(|| t.claimed_at.as_deref().and_then(cc::parse_ts)),
        agents,
    }
}

fn workflow_job(
    run: &WorkflowRun,
    nodes: i64,
    wf: &Workflow,
    names: &HashMap<i64, &str>,
    gated: bool,
) -> OrbitJob {
    let finished = run
        .steps
        .iter()
        .filter(|s| s.status != WorkflowStepStatus::Running)
        .count();
    let running = run
        .steps
        .iter()
        .find(|s| s.status == WorkflowStepStatus::Running);
    let total = (nodes as usize).max(run.steps.len()).max(1);
    OrbitJob {
        kind: "workflow".into(),
        id: run.id,
        workflow_id: Some(wf.id),
        title: wf.name.clone(),
        project_id: wf.project_id,
        project_name: wf
            .project_id
            .and_then(|p| names.get(&p))
            .map(|n| n.to_string()),
        color: wf.project_id.map_or(GLOBAL_COLOR, project_color).into(),
        stage: running.map_or_else(|| "working".to_string(), |s| s.title.clone()),
        progress: (finished as f64 / total as f64).min(1.0),
        progress_estimated: false,
        state: if gated { "waiting" } else { "working" }.into(),
        session_id: None,
        started_at: cc::parse_ts(&run.started_at),
        agents: run
            .steps
            .iter()
            .filter(|s| s.status != WorkflowStepStatus::Skipped)
            .map(|s| OrbitAgent {
                key: format!("run{}/node{}", run.id, s.node_id),
                role: s.kind.as_str().into(),
                label: s.title.clone(),
                detail: s.error.clone().and_then(|e| cc::sanitize_capped(&e)),
                state: if s.status == WorkflowStepStatus::Running {
                    "working"
                } else {
                    "done"
                }
                .into(),
                started_at: s.started_at,
                last_event_at: None,
            })
            .collect(),
    }
}

fn naru_state(live: Option<&(LiveSession, Vec<LiveTurn>)>, now: i64) -> OrbitNaru {
    let Some((s, turns)) = live else {
        return OrbitNaru {
            active: false,
            state: "off".into(),
            session_id: None,
            project_id: None,
        };
    };
    let speaking = turns
        .iter()
        .rev()
        .find(|t| t.role == LiveRole::Naru)
        .is_some_and(|t| {
            t.played_at.is_none()
                && cc::parse_ts(&t.created_at).is_some_and(|at| now - at <= SPEAKING_SECS)
        });
    let state = if speaking {
        "speaking"
    } else if s.resting_since.is_some() {
        "resting"
    } else if s.working_since.is_some() {
        "working"
    } else {
        "listening"
    };
    OrbitNaru {
        active: true,
        state: state.into(),
        session_id: Some(s.id),
        project_id: s.project_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::core::types::{Priority, WorkflowNodeKind, WorkflowStep, WorkflowTrigger};

    fn session(v: serde_json::Value) -> AgentSession {
        let mut base = serde_json::json!({
            "cwd": "/tmp", "kind": "background", "startedAt": 1_000_000,
            "sessionId": "s1", "pid": 42, "status": "busy", "state": "working"
        });
        base.as_object_mut()
            .unwrap()
            .extend(v.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    fn sub_row(session: &str, id: &str, label: &str, finished: bool, last: i64) -> AgentWatchRow {
        serde_json::from_value(serde_json::json!({
            "key": format!("{session}/{id}"), "kind": "subagent", "sessionId": session,
            "parent": session, "label": label, "startedAt": last - 10, "runs": [],
            "lastEventAt": last, "finished": finished, "tools": []
        }))
        .unwrap()
    }

    /// One scenario through the store: a claimed leaf with a build subagent
    /// working and a recon one done, an umbrella nobody works (hidden) whose
    /// child is queued, a blocked queued task, a running workflow run, a
    /// timed workflow, an archived project's work left out, and a live
    /// session that is speaking.
    #[test]
    fn from_store_builds_jobs_queue_colours_and_naru() {
        let dir = tempfile::tempdir().unwrap();
        let mut st = Store::open(&dir.path().join("t.db")).unwrap();
        let p = st
            .create_project("orbit-p", None, None, None, None)
            .unwrap();
        let gone = st
            .create_project("orbit-gone", None, None, None, None)
            .unwrap();
        st.archive_project(gone.id).unwrap();
        let mk = |st: &mut Store, project: i64, d: &str, parent: Option<i64>, status: Status| {
            st.create_task(
                project,
                d,
                Priority::Medium,
                &[],
                parent,
                None,
                None,
                Some(status),
            )
            .unwrap()
        };
        let leaf = mk(&mut st, p.id, "Leaf job", None, Status::Todo);
        st.claim_task(leaf.id, "s1", false).unwrap();
        let umbrella = mk(&mut st, p.id, "Umbrella", None, Status::InProgress);
        let child = mk(
            &mut st,
            p.id,
            "Child queued",
            Some(umbrella.id),
            Status::Todo,
        );
        let blocked = mk(&mut st, p.id, "Blocked queued", None, Status::Todo);
        st.add_dependency(blocked.id, child.id).unwrap();
        mk(&mut st, gone.id, "Archived work", None, Status::InProgress);

        let wf = st.create_workflow(Some(p.id), "Flow", None).unwrap();
        let run = st
            .create_workflow_run(wf.id, WorkflowTrigger::Manual, "")
            .unwrap();
        let step = |title: &str, status| WorkflowStep {
            node_id: 1,
            title: title.into(),
            kind: WorkflowNodeKind::Cli,
            status,
            output: String::new(),
            error: None,
            duration_ms: 0,
            started_at: Some(100),
            log: None,
        };
        st.update_workflow_run_steps(
            run.id,
            &[
                step("first", WorkflowStepStatus::Ok),
                step("second", WorkflowStepStatus::Running),
            ],
        )
        .unwrap();

        let live = st.start_live_session(None).unwrap();
        st.add_live_turn(live.id, LiveRole::Naru, "hello", None, None)
            .unwrap();

        let now = cc::parse_ts(&st.get_task(leaf.id).unwrap().updated_at).unwrap() + 5;
        let sessions = vec![session(serde_json::json!({"taskId": leaf.id}))];
        let rows = vec![
            sub_row("s1", "a", "recon", true, now - 300),
            sub_row("s1", "b", "implementer", false, now - 5),
            sub_row("other", "c", "verifier", false, now - 5),
        ];
        let o = from_store(&st, now, Some(sessions), rows).unwrap();

        assert!(o.agents_available);
        assert_eq!(o.naru.state, "speaking");
        assert!(o.naru.active);
        let ids: Vec<(String, i64)> = o.jobs.iter().map(|j| (j.kind.clone(), j.id)).collect();
        assert_eq!(
            ids,
            vec![("task".into(), leaf.id), ("workflow".into(), run.id)]
        );
        let j = &o.jobs[0];
        assert_eq!((j.stage.as_str(), j.state.as_str()), ("build", "working"));
        assert!(j.progress_estimated && (j.progress - 0.5).abs() < 1e-9);
        assert_eq!(j.color, project_color(p.id));
        let agents: Vec<(&str, &str)> = j
            .agents
            .iter()
            .map(|a| (a.role.as_str(), a.state.as_str()))
            .collect();
        assert_eq!(agents, vec![("recon", "done"), ("build", "working")]);
        let w = &o.jobs[1];
        assert_eq!((w.stage.as_str(), w.progress), ("second", 0.5));
        assert_eq!(w.agents.len(), 2);

        let queued: Vec<(i64, bool)> = o.queue.iter().map(|q| (q.id, q.blocked)).collect();
        assert_eq!(queued, vec![(child.id, false), (blocked.id, true)]);
        assert_eq!(o.projects.len(), 1);
        assert_eq!(o.projects[0].color, project_color(p.id));

        // No session list: the job is still there, idle, with no agents.
        let o = from_store(&st, now, None, Vec::new()).unwrap();
        assert!(!o.agents_available);
        assert_eq!(
            (o.jobs[0].state.as_str(), o.jobs[0].agents.len()),
            ("idle", 0)
        );
    }

    /// The `<project>: <task name>` fallback never re-binds a session that
    /// already owns a task, and a stage-driver name wins with its stage.
    #[test]
    fn session_matching_rules() {
        let dir = tempfile::tempdir().unwrap();
        let mut st = Store::open(&dir.path().join("t.db")).unwrap();
        let p = st.create_project("pm", None, None, None, None).unwrap();
        let t = st
            .create_task(
                p.id,
                "Same name",
                Priority::Medium,
                &[],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        let named = session(serde_json::json!({"name": "pm: Same name"}));
        assert!(session_for(&named, &t, "pm").is_some());
        let owned = session(serde_json::json!({"name": "pm: Same name", "taskId": t.id + 1}));
        assert!(session_for(&owned, &t, "pm").is_none());
        let staged =
            session(serde_json::json!({"name": format!("task {} · verify (verifier)", t.id)}));
        assert_eq!(
            session_for(&staged, &t, "pm").unwrap().1.as_deref(),
            Some("verify")
        );
    }

    #[test]
    fn naru_states() {
        assert_eq!(naru_state(None, 0).state, "off");
    }

    #[test]
    fn colors_are_stable_per_project_id() {
        assert_eq!(
            project_color(2),
            project_color(2 + PROJECT_COLORS.len() as i64)
        );
        assert_ne!(project_color(1), project_color(2));
        assert!(!PROJECT_COLORS.contains(&"#a371f7"));
    }

    #[test]
    fn stage_names_parse() {
        assert_eq!(
            parse_stage_name("task 12 · build (implementer)"),
            Some((12, "build".into()))
        );
        assert_eq!(
            parse_stage_name("task 7 · Review"),
            Some((7, "review".into()))
        );
        assert_eq!(parse_stage_name("naru: task 7 · x"), None);
        assert_eq!(parse_stage_name("task x · build (a)"), None);
    }

    #[test]
    fn roles_map_known_agent_types() {
        for (t, r) in [
            ("recon", "recon"),
            ("Explore", "recon"),
            ("planner", "plan"),
            ("implementer", "build"),
            ("swift-implementer", "build"),
            ("diff-reviewer", "review"),
            ("verifier", "test"),
            ("ui-verifier", "check"),
            ("general-purpose", "agent"),
        ] {
            assert_eq!(role_of(t), r, "{t}");
        }
        assert_eq!(stage_of("check"), "verify");
        assert_eq!(stage_of("implement"), "build");
    }
}
