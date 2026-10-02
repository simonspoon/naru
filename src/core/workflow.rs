//! The workflow engine (mesa task 1607, `docs/workflows.md`): walks a
//! workflow's graph in a fixed order and runs each node, recording one
//! [`WorkflowStep`] per node. **The graph decides what runs, never an
//! agent** — order is a topological sort with ties broken by node id, a
//! `branch` node's verdict picks which of its edges are active, and the only
//! model call anywhere is a `prompt` node's one `llm::complete` (a direct
//! HTTP request to a model API — never a Claude Code process).
//!
//! Storage lives in `Store`; this module is execution, so it follows
//! `scripts.rs` and `hooks.rs`: it owns processes, `Store` owns rows. The
//! property that shapes the API is that **the store lock is never held while
//! a node's process runs**: every engine function takes a [`StoreAccess`] and
//! asks it for the store only for the brief reads and writes around a node.
//! The CLI wraps the `Store` it owns in a `Mutex`; the server hands over the
//! `Arc<Mutex<Store>>` it already has — one engine for both.
//!
//! Node semantics, data flow and failure rules are in the doc; the short
//! version: the trigger's output is the run input, every other node's input is
//! its active upstream outputs joined by `\n` in edge-id order, a node with
//! incoming edges none of which is active is `skipped`, and a failed node
//! fails the run and skips everything not yet run.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::core::store::{Error, Result, Store};
use crate::core::types::{
    InboxKind, LiveBoardKind, Priority, WorkflowBranch, WorkflowEdge, WorkflowNode,
    WorkflowNodeKind, WorkflowRun, WorkflowRunStatus, WorkflowStep, WorkflowStepStatus,
    WorkflowTrigger, WorkflowView,
};
use crate::core::{agents, config, llm, scripts};

/// A step's `output` (and a `cli` node's captured stdout) is capped at 64 KiB,
/// the scripts' own cap.
const OUTPUT_CAP: usize = 64 * 1024;
/// A `cli` node's default timeout, in seconds.
pub const DEFAULT_CLI_TIMEOUT_SECS: u64 = 600;
/// A `prompt` node's default timeout, in seconds.
pub const DEFAULT_PROMPT_TIMEOUT_SECS: u64 = 600;
/// `NARU_INPUT` is exported only up to this size: a process environment has
/// a hard limit, and stdin always carries the whole input anyway.
const ENV_INPUT_MAX: usize = 64 * 1024;
/// The most text a `script` node may pass as **argv or environment**: the sum
/// of its values (each rides as `$n` and two `*_ARG_*` variables). Over it
/// the node fails with a message naming the limit, rather than the OS
/// refusing the exec with `Argument list too long`. A `cli` node has no such
/// limit (its input rides on stdin), nor has a `prompt` node (its request
/// body rides on curl's stdin).
const ARG_INPUT_MAX: usize = 64 * 1024;

/// How the engine reaches the store: lock, run `f`, unlock. Implemented for
/// `Mutex<Store>`, which is all both callers need — and a trait rather than a
/// type so the engine says, in its signature, that it only ever borrows the
/// store for the length of a closure.
pub trait StoreAccess {
    fn with<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R;
}

impl StoreAccess for Mutex<Store> {
    fn with<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R {
        let mut store = match self.lock() {
            Ok(s) => s,
            Err(e) => e.into_inner(),
        };
        f(&mut store)
    }
}

// ---- config validation ---------------------------------------------------

const PROMPT_MODELS: [&str; 3] = ["haiku", "sonnet", "opus"];
const BRANCH_OPS: [&str; 5] = ["contains", "regex", "score_above", "score_below", "equals"];
const OUTPUT_TARGETS: [&str; 4] = ["log", "task", "inbox", "board"];

fn object<'a>(
    kind: &str,
    config: &'a Value,
) -> std::result::Result<&'a Map<String, Value>, String> {
    config
        .as_object()
        .ok_or_else(|| format!("a {kind} node's config must be a JSON object"))
}

fn only_keys(
    kind: &str,
    obj: &Map<String, Value>,
    allowed: &[&str],
) -> std::result::Result<(), String> {
    for key in obj.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!(
                "unknown key {key:?} in a {kind} node's config; it takes {}",
                allowed.join(", ")
            ));
        }
    }
    Ok(())
}

fn required_str<'a>(
    kind: &str,
    obj: &'a Map<String, Value>,
    key: &str,
) -> std::result::Result<&'a str, String> {
    match obj.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s),
        Some(_) => Err(format!("{kind} config: {key:?} must be a non-empty string")),
        None => Err(format!("{kind} config: {key:?} is required")),
    }
}

fn optional_str<'a>(
    kind: &str,
    obj: &'a Map<String, Value>,
    key: &str,
) -> std::result::Result<Option<&'a str>, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(Some(s)),
        Some(_) => Err(format!("{kind} config: {key:?} must be a non-empty string")),
    }
}

fn optional_int(
    kind: &str,
    obj: &Map<String, Value>,
    key: &str,
    range: std::ops::RangeInclusive<i64>,
) -> std::result::Result<Option<i64>, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_i64() {
            Some(n) if range.contains(&n) => Ok(Some(n)),
            _ => Err(format!(
                "{kind} config: {key:?} must be a whole number {} to {}",
                range.start(),
                range.end()
            )),
        },
    }
}

/// Checks one node's `config` against its kind and answers it normalized —
/// the form `Store` writes. Unknown keys and bad values are errors (the
/// store's `validation`); nothing about the *environment* is checked (a
/// script that does not exist yet, a binary that is not installed), only the
/// shape, so a graph can be authored before everything it names is in place.
pub fn validate_config(
    kind: WorkflowNodeKind,
    config: &Value,
) -> std::result::Result<Value, String> {
    let name = kind.as_str();
    let obj = object(name, config)?;
    let mut out = Map::new();
    match kind {
        WorkflowNodeKind::Trigger => {
            only_keys(name, obj, &["mode", "every_minutes", "phrase"])?;
            let mode = required_str(name, obj, "mode")?;
            if !["manual", "time", "voice"].contains(&mode) {
                return Err(format!(
                    "trigger config: \"mode\" must be manual, time or voice, got {mode:?}"
                ));
            }
            out.insert("mode".into(), json!(mode));
            let every = optional_int(name, obj, "every_minutes", 1..=10080)?;
            match (mode, every) {
                ("time", None) => {
                    return Err(
                        "trigger config: a time trigger needs \"every_minutes\" (1 to 10080)"
                            .into(),
                    );
                }
                ("time", Some(n)) => {
                    out.insert("every_minutes".into(), json!(n));
                }
                (_, Some(_)) => {
                    return Err(
                        "trigger config: \"every_minutes\" belongs to a time trigger only".into(),
                    );
                }
                _ => {}
            }
            if let Some(p) = optional_str(name, obj, "phrase")? {
                out.insert("phrase".into(), json!(p.trim()));
            }
        }
        WorkflowNodeKind::Prompt => {
            only_keys(name, obj, &["model", "thinking", "prompt", "timeout_secs"])?;
            let model = required_str(name, obj, "model")?;
            let local = model.strip_prefix("local:").is_some_and(|n| {
                !n.is_empty()
                    && !n.starts_with('-')
                    && n.chars().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/')
                    })
            });
            if !PROMPT_MODELS.contains(&model) && !local {
                return Err(format!(
                    "prompt config: \"model\" must be haiku, sonnet, opus or local:<name>, got {model:?}"
                ));
            }
            out.insert("model".into(), json!(model));
            let thinking = match obj.get("thinking") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(b)) => *b,
                Some(_) => return Err("prompt config: \"thinking\" must be true or false".into()),
            };
            out.insert("thinking".into(), json!(thinking));
            out.insert("prompt".into(), json!(required_str(name, obj, "prompt")?));
            if let Some(n) = optional_int(name, obj, "timeout_secs", 1..=3600)? {
                out.insert("timeout_secs".into(), json!(n));
            }
        }
        WorkflowNodeKind::Cli => {
            only_keys(name, obj, &["command", "timeout_secs"])?;
            out.insert("command".into(), json!(required_str(name, obj, "command")?));
            if let Some(n) = optional_int(name, obj, "timeout_secs", 1..=86400)? {
                out.insert("timeout_secs".into(), json!(n));
            }
        }
        WorkflowNodeKind::Script => {
            only_keys(name, obj, &["script", "values", "timeout_secs"])?;
            match obj.get("script") {
                Some(Value::String(s)) if !s.trim().is_empty() => {
                    out.insert("script".into(), json!(s.trim()));
                }
                Some(Value::Number(n)) if n.as_i64().is_some_and(|n| n > 0) => {
                    out.insert("script".into(), json!(n.as_i64().unwrap().to_string()));
                }
                Some(_) => {
                    return Err("script config: \"script\" must be a script id or name".into());
                }
                None => return Err("script config: \"script\" is required".into()),
            }
            let mut values = Map::new();
            match obj.get("values") {
                None | Some(Value::Null) => {}
                Some(Value::Object(m)) => {
                    for (k, v) in m {
                        let Value::String(_) = v else {
                            return Err(format!("script config: value {k:?} must be a string"));
                        };
                        values.insert(k.clone(), v.clone());
                    }
                }
                Some(_) => {
                    return Err("script config: \"values\" must be an object of strings".into());
                }
            }
            out.insert("values".into(), Value::Object(values));
            if let Some(n) = optional_int(name, obj, "timeout_secs", 1..=86400)? {
                out.insert("timeout_secs".into(), json!(n));
            }
        }
        WorkflowNodeKind::Branch => {
            only_keys(name, obj, &["op", "value"])?;
            let op = required_str(name, obj, "op")?;
            if !BRANCH_OPS.contains(&op) {
                return Err(format!(
                    "branch config: \"op\" must be one of {}, got {op:?}",
                    BRANCH_OPS.join(", ")
                ));
            }
            out.insert("op".into(), json!(op));
            if op.starts_with("score_") {
                let n = match obj.get("value") {
                    Some(Value::Number(n)) => n.as_f64(),
                    Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
                    _ => None,
                };
                match n.filter(|n| n.is_finite()) {
                    Some(n) => out.insert("value".into(), json!(n)),
                    None => return Err(format!("branch config: {op} needs a numeric \"value\"")),
                };
            } else {
                let value = required_str(name, obj, "value")?;
                if op == "regex" {
                    regex_check(value)?;
                }
                out.insert("value".into(), json!(value));
            }
        }
        WorkflowNodeKind::Output => {
            only_keys(
                name,
                obj,
                &["target", "log", "project", "task_id", "kind", "title"],
            )?;
            let target = required_str(name, obj, "target")?;
            if !OUTPUT_TARGETS.contains(&target) {
                return Err(format!(
                    "output config: \"target\" must be one of {}, got {target:?}",
                    OUTPUT_TARGETS.join(", ")
                ));
            }
            out.insert("target".into(), json!(target));
            let allowed: &[&str] = match target {
                "log" => &["log"],
                "task" => &["project"],
                "inbox" => &["task_id", "kind"],
                _ => &["title"],
            };
            for key in obj.keys() {
                if key != "target" && !allowed.contains(&key.as_str()) {
                    return Err(format!(
                        "output config: {key:?} does not apply to target {target:?}; it takes {}",
                        allowed.join(", ")
                    ));
                }
            }
            match target {
                "log" => {
                    let log = optional_str(name, obj, "log")?.unwrap_or("default");
                    out.insert("log".into(), json!(log.trim()));
                }
                "task" => match obj.get("project") {
                    Some(Value::String(s)) if !s.trim().is_empty() => {
                        out.insert("project".into(), json!(s.trim()));
                    }
                    Some(Value::Number(n)) if n.as_i64().is_some_and(|n| n > 0) => {
                        out.insert("project".into(), json!(n.as_i64().unwrap().to_string()));
                    }
                    _ => {
                        return Err(
                            "output config: a task target needs \"project\" (id or name)".into(),
                        );
                    }
                },
                "inbox" => {
                    match optional_int(name, obj, "task_id", 1..=i64::MAX)? {
                        Some(n) => out.insert("task_id".into(), json!(n)),
                        None => {
                            return Err("output config: an inbox target needs \"task_id\" \
                                        (an inbox item names the task it came from)"
                                .into());
                        }
                    };
                    let kind = optional_str(name, obj, "kind")?.unwrap_or("task-summary");
                    if InboxKind::parse(kind).is_none() {
                        return Err(format!(
                            "output config: \"kind\" must be task-summary or change-request, got {kind:?}"
                        ));
                    }
                    out.insert("kind".into(), json!(kind));
                }
                _ => {
                    if let Some(t) = optional_str(name, obj, "title")? {
                        out.insert("title".into(), json!(t));
                    }
                }
            }
        }
    }
    Ok(Value::Object(out))
}

/// Whether `pattern` is a valid POSIX extended regular expression, asked of
/// `grep -E` itself: the branch node's `regex` op *is* `grep -E`, so the
/// validator and the evaluator can never disagree about the dialect. grep
/// exits 2 on a bad pattern, 0/1 on a good one.
fn regex_check(pattern: &str) -> std::result::Result<(), String> {
    match grep(pattern, "") {
        Ok(_) => Ok(()),
        Err(e) => Err(format!(
            "branch config: not a valid regular expression ({e})"
        )),
    }
}

fn grep(pattern: &str, input: &str) -> std::result::Result<bool, String> {
    let mut cmd = Command::new("grep");
    cmd.args(["-E", "-q", "-e", pattern]);
    let out = agents::capture(
        cmd,
        Some(input.as_bytes().to_vec()),
        Duration::from_secs(10),
    )?;
    match out.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

// ---- running -------------------------------------------------------------

/// Checks that `view` can run — exactly one trigger node — and answers its
/// id. The one gate both [`claim_run`] and [`execute_run`] use.
pub fn trigger_of(view: &WorkflowView) -> Result<i64> {
    let triggers: Vec<i64> = view
        .nodes
        .iter()
        .filter(|n| n.kind == WorkflowNodeKind::Trigger)
        .map(|n| n.id)
        .collect();
    match triggers.as_slice() {
        [one] => Ok(*one),
        [] => Err(Error::Validation(format!(
            "workflow {:?} has no trigger node; add one with `naru workflow node create` \
             (kind trigger)",
            view.workflow.name
        ))),
        _ => Err(Error::Validation(format!(
            "workflow {:?} has {} trigger nodes; a run needs exactly one",
            view.workflow.name,
            triggers.len()
        ))),
    }
}

/// Validates `workflow_id` is runnable and writes its `running` row — the
/// claim, made before anything executes (the retro watcher's pattern). The
/// time watcher calls this under its lock and then [`execute_run`] off it;
/// [`run_workflow`] is the two together.
pub fn claim_run(
    store: &mut Store,
    workflow_id: i64,
    trigger: WorkflowTrigger,
    input: &str,
) -> Result<(WorkflowView, WorkflowRun)> {
    let view = store.get_workflow_view(workflow_id)?;
    trigger_of(&view)?;
    let run = store.create_workflow_run(workflow_id, trigger, input)?;
    Ok((view, run))
}

/// The time watcher's claim: [`Store::claim_time_workflow_run`] (the due
/// check and the `running` row are one statement under `BEGIN IMMEDIATE`)
/// plus the view the run needs. `None` when the workflow is not due — most
/// often because another claimer got the interval first.
pub fn claim_time_run(
    store: &mut Store,
    workflow_id: i64,
) -> Result<Option<(WorkflowView, WorkflowRun)>> {
    let view = store.get_workflow_view(workflow_id)?;
    trigger_of(&view)?;
    Ok(store
        .claim_time_workflow_run(workflow_id)?
        .map(|run| (view, run)))
}

/// Runs a workflow to completion and answers its finished run record. A run
/// that *failed* is still `Ok` — the record says `failed` and carries the
/// steps; `Err` is only "could not run at all" (unknown workflow, no or two
/// triggers, input too large, a store failure).
pub fn run_workflow<A: StoreAccess>(
    access: &A,
    workflow_id: i64,
    trigger: WorkflowTrigger,
    input: &str,
) -> Result<WorkflowRun> {
    let (view, run) = access.with(|s| claim_run(s, workflow_id, trigger, input))?;
    execute_run(access, &view, run)
}

/// What a node left behind, for the nodes downstream of it.
struct Done {
    status: WorkflowStepStatus,
    output: String,
    /// A branch node's verdict.
    verdict: Option<bool>,
}

/// Node ids in execution order: Kahn's algorithm over every node, the ready
/// set a `BTreeSet` so ties break by node id.
fn topological_order(view: &WorkflowView) -> Vec<i64> {
    let mut indegree: BTreeMap<i64, usize> = view.nodes.iter().map(|n| (n.id, 0)).collect();
    for e in &view.edges {
        *indegree.entry(e.to_node).or_default() += 1;
    }
    let mut ready: BTreeSet<i64> = indegree
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut order = Vec::with_capacity(view.nodes.len());
    while let Some(id) = ready.pop_first() {
        order.push(id);
        for e in view.edges.iter().filter(|e| e.from_node == id) {
            let d = indegree.get_mut(&e.to_node).expect("edge to a known node");
            *d -= 1;
            if *d == 0 {
                ready.insert(e.to_node);
            }
        }
    }
    order
}

/// Executes a claimed run and finishes its row. See the module doc for the
/// rules; the lock discipline is that `access` is touched only for reads and
/// writes around a node, never while its process runs.
pub fn execute_run<A: StoreAccess>(
    access: &A,
    view: &WorkflowView,
    run: WorkflowRun,
) -> Result<WorkflowRun> {
    let finish = |status, steps: &[WorkflowStep], error: Option<&str>| {
        access.with(|s| s.finish_workflow_run(run.id, status, steps, error))
    };
    let trigger_id = match trigger_of(view) {
        Ok(id) => id,
        Err(e) => return finish(WorkflowRunStatus::Failed, &[], Some(&e.to_string())),
    };
    let order = topological_order(view);
    if order.len() != view.nodes.len() {
        // `Store` refuses every cycle, so this is a hand-edited database; a
        // run over it would silently skip the nodes the sort dropped.
        return finish(
            WorkflowRunStatus::Failed,
            &[],
            Some("the graph is not a DAG (a cycle in the database); refusing to run it"),
        );
    }
    let nodes: HashMap<i64, &WorkflowNode> = view.nodes.iter().map(|n| (n.id, n)).collect();
    let project_dir = view.workflow.project_id.and_then(|id| {
        access
            .with(|s| s.get_project(id))
            .ok()
            .and_then(|p| p.local_path)
            .filter(|p| Path::new(p).is_dir())
    });
    let cwd = project_dir
        .clone()
        .unwrap_or_else(|| config::workspace_dir().to_string_lossy().into_owned());

    let mut done: HashMap<i64, Done> = HashMap::new();
    let mut steps: Vec<WorkflowStep> = Vec::new();
    let mut failure: Option<String> = None;
    for id in order {
        let node = nodes[&id];
        let skipped = |node: &WorkflowNode| WorkflowStep {
            node_id: node.id,
            title: node.title.clone(),
            kind: node.kind,
            status: WorkflowStepStatus::Skipped,
            output: String::new(),
            error: None,
            duration_ms: 0,
        };
        let input = if id == trigger_id {
            Some(run.input.clone())
        } else {
            active_input(view, &done, id)
        };
        let (Some(input), None) = (input, &failure) else {
            steps.push(skipped(node));
            done.insert(
                id,
                Done {
                    status: WorkflowStepStatus::Skipped,
                    output: String::new(),
                    verdict: None,
                },
            );
            continue;
        };
        let started = Instant::now();
        let result = run_node(access, view, node, &input, &cwd, run.id, id == trigger_id);
        let duration_ms = started.elapsed().as_millis() as i64;
        let (status, output, error, verdict) = match result {
            Ok((output, verdict)) => (WorkflowStepStatus::Ok, output, None, verdict),
            Err(message) => {
                failure = Some(format!(
                    "node {} ({}) failed: {message}",
                    node.id, node.title
                ));
                (
                    WorkflowStepStatus::Failed,
                    String::new(),
                    Some(message),
                    None,
                )
            }
        };
        let output = cap(output);
        steps.push(WorkflowStep {
            node_id: node.id,
            title: node.title.clone(),
            kind: node.kind,
            status,
            output: output.clone(),
            error,
            duration_ms,
        });
        done.insert(
            id,
            Done {
                status,
                output,
                verdict,
            },
        );
    }
    match failure {
        Some(message) => finish(WorkflowRunStatus::Failed, &steps, Some(&message)),
        None => finish(WorkflowRunStatus::Succeeded, &steps, None),
    }
}

/// The joined outputs of `node_id`'s active upstream nodes, or `None` when it
/// has no active incoming edge (so it is skipped). An edge is active when its
/// source ran `ok` and — for a branch source — its `branch` matches the
/// source's verdict. A node with no incoming edges that is not the trigger
/// is unreachable and is skipped too.
fn active_input(view: &WorkflowView, done: &HashMap<i64, Done>, node_id: i64) -> Option<String> {
    let mut incoming: Vec<&WorkflowEdge> =
        view.edges.iter().filter(|e| e.to_node == node_id).collect();
    incoming.sort_by_key(|e| e.id);
    let outputs: Vec<&str> = incoming
        .into_iter()
        .filter(|e| {
            let Some(up) = done.get(&e.from_node) else {
                return false;
            };
            up.status == WorkflowStepStatus::Ok
                && match up.verdict {
                    Some(v) => {
                        e.branch
                            == Some(if v {
                                WorkflowBranch::True
                            } else {
                                WorkflowBranch::False
                            })
                    }
                    None => true,
                }
        })
        .map(|e| done[&e.from_node].output.as_str())
        .collect();
    if outputs.is_empty() {
        None
    } else {
        Some(outputs.join("\n"))
    }
}

fn cap(mut s: String) -> String {
    if s.len() > OUTPUT_CAP {
        let cut = (0..=OUTPUT_CAP).rev().find(|i| s.is_char_boundary(*i));
        s.truncate(cut.unwrap_or(0));
        s.push_str("\n[truncated]");
    }
    s
}

/// One node's execution: `Ok((output, verdict))` or the failure message.
fn run_node<A: StoreAccess>(
    access: &A,
    view: &WorkflowView,
    node: &WorkflowNode,
    input: &str,
    cwd: &str,
    run_id: i64,
    is_trigger: bool,
) -> std::result::Result<(String, Option<bool>), String> {
    if is_trigger {
        return Ok((input.to_string(), None));
    }
    let cfg = &node.config;
    let str_of = |key: &str| cfg.get(key).and_then(Value::as_str).unwrap_or_default();
    match node.kind {
        WorkflowNodeKind::Trigger => Ok((input.to_string(), None)),
        WorkflowNodeKind::Prompt => {
            let prompt = str_of("prompt");
            let full = if input.is_empty() {
                prompt.to_string()
            } else {
                format!("{prompt}\n\n{input}")
            };
            let timeout = cfg
                .get("timeout_secs")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_PROMPT_TIMEOUT_SECS);
            let out = llm::complete(
                str_of("model"),
                cfg.get("thinking").and_then(Value::as_bool) == Some(true),
                &full,
                Duration::from_secs(timeout),
            )?;
            Ok((out.trim().to_string(), None))
        }
        WorkflowNodeKind::Cli => {
            let timeout = cfg
                .get("timeout_secs")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_CLI_TIMEOUT_SECS);
            let mut cmd = Command::new("bash");
            cmd.arg("-c").arg(str_of("command")).current_dir(cwd);
            if input.len() <= ENV_INPUT_MAX {
                cmd.env("NARU_INPUT", input);
            }
            let out = agents::capture(
                cmd,
                Some(input.as_bytes().to_vec()),
                Duration::from_secs(timeout),
            )?;
            if out.code != 0 {
                return Err(format!(
                    "exited {}: {}",
                    out.code,
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            Ok((String::from_utf8_lossy(&out.stdout).into_owned(), None))
        }
        WorkflowNodeKind::Script => {
            let which = str_of("script");
            let script = access
                .with(|s| match which.parse::<i64>() {
                    Ok(id) => s.get_script(id),
                    Err(_) => s.find_script_by_name(which),
                })
                .map_err(|e| e.to_string())?;
            let dir = script_cwd(access, &script)?;
            // Every value may carry the literal `{input}`; the substituted
            // text is a value handed to the script as an argument, never a
            // fragment of a shell command line.
            let values: BTreeMap<String, String> = cfg
                .get("values")
                .and_then(Value::as_object)
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| {
                            (
                                k.clone(),
                                v.as_str().unwrap_or_default().replace("{input}", input),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let total: usize = values.values().map(String::len).sum();
            if total > ARG_INPUT_MAX {
                return Err(format!(
                    "the script's values total {total} bytes, over the {ARG_INPUT_MAX}-byte limit \
                     for a script node (they travel as arguments and environment); \
                     shorten the input upstream"
                ));
            }
            let timeout = cfg
                .get("timeout_secs")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_CLI_TIMEOUT_SECS);
            let run = scripts::run_with_timeout(
                &script,
                &values,
                Some(&dir),
                Duration::from_secs(timeout),
            )?;
            if run.exit_code != 0 {
                return Err(format!("exited {}: {}", run.exit_code, run.stderr.trim()));
            }
            Ok((run.stdout, None))
        }
        WorkflowNodeKind::Branch => {
            let verdict = branch_verdict(str_of("op"), cfg.get("value"), input)?;
            Ok((input.to_string(), Some(verdict)))
        }
        WorkflowNodeKind::Output => {
            // A silent run (an empty transcript, a filter that let nothing
            // through) has nothing to deliver, and that is not a failure: the
            // node succeeds, says so, and writes no record.
            if input.trim().is_empty() {
                return Ok(("nothing to deliver".to_string(), None));
            }
            let receipt = match str_of("target") {
                "log" => {
                    let entry = access
                        .with(|s| {
                            s.append_workflow_log(
                                str_of("log"),
                                input,
                                Some(view.workflow.id),
                                Some(run_id),
                            )
                        })
                        .map_err(|e| e.to_string())?;
                    format!("logged to {} (line {})", entry.log, entry.id)
                }
                "task" => {
                    let project = str_of("project");
                    let task = access
                        .with(|s| {
                            let id = match project.parse::<i64>() {
                                Ok(id) => id,
                                Err(_) => s.find_project_by_name(project)?.id,
                            };
                            s.create_task(id, input, Priority::Medium, &[], None, None, None, None)
                        })
                        .map_err(|e| e.to_string())?;
                    format!("created task {}", task.id)
                }
                "inbox" => {
                    let kind = InboxKind::parse(str_of("kind")).unwrap_or(InboxKind::TaskSummary);
                    let task_id = cfg.get("task_id").and_then(Value::as_i64).unwrap_or(0);
                    let item = access
                        .with(|s| s.create_inbox_item(Some("workflow"), input, kind, task_id))
                        .map_err(|e| e.to_string())?;
                    format!("filed inbox item {}", item.id)
                }
                _ => {
                    let title = cfg
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or(&node.title);
                    let board = access
                        .with(|s| {
                            let session = s.current_live_session()?.ok_or_else(|| {
                                Error::NotFound(
                                    "no live session to show the board in; start one with \
                                     `naru live start`"
                                        .into(),
                                )
                            })?;
                            s.add_live_board(
                                session.id,
                                LiveBoardKind::Markdown,
                                Some(title),
                                input,
                                None,
                            )
                        })
                        .map_err(|e| e.to_string())?;
                    format!("pushed board {}", board.id)
                }
            };
            Ok((receipt, None))
        }
    }
}

/// A script node's working directory: its project's `local_path` (which must
/// still be a directory), or `~/.naru/workspace` for a global script — the
/// ladder `script run` walks.
fn script_cwd<A: StoreAccess>(
    access: &A,
    script: &crate::core::types::Script,
) -> std::result::Result<String, String> {
    let Some(id) = script.project_id else {
        return Ok(config::workspace_dir().to_string_lossy().into_owned());
    };
    let path = access
        .with(|s| s.get_project(id))
        .map_err(|e| e.to_string())?
        .local_path
        .ok_or_else(|| {
            format!(
                "project {id} has no local_path to run script {:?} in",
                script.name
            )
        })?;
    if !Path::new(&path).is_dir() {
        return Err(format!(
            "project {id} local_path {path:?} is not a directory on this machine"
        ));
    }
    Ok(path)
}

/// A branch node's verdict over `input`. `contains` and `regex` (POSIX ERE,
/// through `grep -E`) test the text; `equals` compares both sides trimmed
/// (stdout ends in a newline, the config rarely does); `score_above` and
/// `score_below` compare the first decimal number found in the input, and no
/// number at all is `false`.
pub fn branch_verdict(
    op: &str,
    value: Option<&Value>,
    input: &str,
) -> std::result::Result<bool, String> {
    let text = value.and_then(Value::as_str).unwrap_or_default();
    match op {
        "contains" => Ok(input.contains(text)),
        "equals" => Ok(input.trim() == text.trim()),
        "regex" => grep(text, input),
        "score_above" | "score_below" => {
            let bound = value
                .and_then(Value::as_f64)
                .ok_or_else(|| format!("{op} needs a numeric value"))?;
            Ok(match first_number(input) {
                None => false,
                Some(n) if op == "score_above" => n > bound,
                Some(n) => n < bound,
            })
        }
        other => Err(format!("unknown branch op {other:?}")),
    }
}

/// The first decimal number in `s`: optional `-`, digits, optional `.digits`.
pub fn first_number(s: &str) -> Option<f64> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let neg = bytes[i] == b'-' && bytes.get(i + 1).is_some_and(u8::is_ascii_digit);
        if bytes[i].is_ascii_digit() || neg {
            let start = i;
            i += usize::from(neg);
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if bytes.get(i) == Some(&b'.') && bytes.get(i + 1).is_some_and(u8::is_ascii_digit) {
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
            }
            return s[start..i].parse().ok();
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::store::{WorkflowNodeNew, WorkflowPatch};
    use std::sync::Arc;

    fn store() -> (Mutex<Store>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("t.db")).unwrap();
        (Mutex::new(s), dir)
    }

    fn node(s: &mut Store, wf: i64, kind: WorkflowNodeKind, title: &str, cfg: Value) -> i64 {
        s.create_workflow_node(
            wf,
            &WorkflowNodeNew {
                kind,
                title: title.into(),
                config: Some(cfg),
                x: None,
                y: None,
            },
        )
        .unwrap()
        .id
    }

    fn cli(command: &str) -> Value {
        json!({"command": command})
    }

    #[test]
    fn first_number_finds_the_first_decimal() {
        assert_eq!(first_number("score: 0.85 of 1"), Some(0.85));
        assert_eq!(first_number("-3 and 4"), Some(-3.0));
        assert_eq!(first_number("a-b 7."), Some(7.0));
        assert_eq!(first_number("no digits"), None);
        assert_eq!(first_number("1.2.3"), Some(1.2));
    }

    #[test]
    fn branch_ops() {
        fn v(x: Value) -> Option<&'static Value> {
            Some(Box::leak(Box::new(x)))
        }
        assert!(branch_verdict("contains", v(json!("idea")), "an idea!").unwrap());
        assert!(!branch_verdict("contains", v(json!("Idea")), "an idea!").unwrap());
        assert!(branch_verdict("equals", v(json!("yes")), "yes\n").unwrap());
        assert!(branch_verdict("regex", v(json!("^a[0-9]+$")), "a42").unwrap());
        assert!(!branch_verdict("regex", v(json!("^a[0-9]+$")), "b42").unwrap());
        assert!(branch_verdict("regex", v(json!("(")), "x").is_err());
        assert!(branch_verdict("score_above", v(json!(0.8)), "0.9").unwrap());
        assert!(!branch_verdict("score_above", v(json!(0.8)), "0.8").unwrap());
        assert!(branch_verdict("score_below", v(json!(0.8)), "score 0.2").unwrap());
        assert!(!branch_verdict("score_below", v(json!(0.8)), "none").unwrap());
        assert!(!branch_verdict("score_above", v(json!(0.8)), "none").unwrap());
    }

    #[test]
    fn config_validation_per_kind() {
        use WorkflowNodeKind as K;
        let ok = |k, c: Value| validate_config(k, &c).unwrap();
        let bad = |k, c: Value| validate_config(k, &c).unwrap_err();
        assert_eq!(
            ok(K::Trigger, json!({"mode": "time", "every_minutes": 5})),
            json!({"mode": "time", "every_minutes": 5})
        );
        assert!(bad(K::Trigger, json!({"mode": "time"})).contains("every_minutes"));
        assert!(
            bad(K::Trigger, json!({"mode": "manual", "every_minutes": 5})).contains("time trigger")
        );
        assert!(
            bad(K::Trigger, json!({"mode": "time", "every_minutes": 0})).contains("1 to 10080")
        );
        assert!(bad(K::Trigger, json!({"mode": "weekly"})).contains("manual, time or voice"));
        assert!(bad(K::Trigger, json!({"mode": "manual", "extra": 1})).contains("unknown key"));
        assert_eq!(
            ok(
                K::Prompt,
                json!({"model": "local:llama3.2:3b", "prompt": "hi"})
            )["thinking"],
            json!(false)
        );
        assert!(bad(K::Prompt, json!({"model": "gpt", "prompt": "hi"})).contains("model"));
        assert!(bad(K::Prompt, json!({"model": "haiku", "prompt": " "})).contains("prompt"));
        assert!(bad(K::Cli, json!({})).contains("command"));
        assert_eq!(ok(K::Script, json!({"script": 7}))["script"], json!("7"));
        assert!(bad(K::Script, json!({"script": "x", "values": {"a": 1}})).contains("string"));
        assert_eq!(
            ok(K::Branch, json!({"op": "score_above", "value": "0.8"}))["value"],
            json!(0.8)
        );
        assert!(bad(K::Branch, json!({"op": "score_above", "value": "high"})).contains("numeric"));
        assert!(
            bad(K::Branch, json!({"op": "regex", "value": "("})).contains("regular expression")
        );
        assert!(bad(K::Branch, json!({"op": "nope", "value": "x"})).contains("op"));
        assert_eq!(
            ok(K::Output, json!({"target": "log"}))["log"],
            json!("default")
        );
        assert!(bad(K::Output, json!({"target": "task"})).contains("project"));
        assert!(bad(K::Output, json!({"target": "inbox"})).contains("task_id"));
        assert!(
            bad(K::Output, json!({"target": "log", "project": "p"})).contains("does not apply")
        );
        assert!(bad(K::Output, json!({"target": "pager"})).contains("target"));
        assert!(bad(K::Cli, json!("echo")).contains("object"));
    }

    #[test]
    fn graph_rules_are_enforced_by_the_store() {
        let (st, _d) = store();
        let mut s = st.lock().unwrap();
        let wf = s.create_workflow(None, "Flow", None).unwrap().id;
        let t = node(
            &mut s,
            wf,
            WorkflowNodeKind::Trigger,
            "T",
            json!({"mode": "manual"}),
        );
        let a = node(&mut s, wf, WorkflowNodeKind::Cli, "A", cli("true"));
        let b = node(&mut s, wf, WorkflowNodeKind::Cli, "B", cli("true"));
        let br = node(
            &mut s,
            wf,
            WorkflowNodeKind::Branch,
            "Br",
            json!({"op": "contains", "value": "x"}),
        );
        // A second trigger.
        let err = s
            .create_workflow_node(
                wf,
                &WorkflowNodeNew {
                    kind: WorkflowNodeKind::Trigger,
                    title: "T2".into(),
                    config: None,
                    x: None,
                    y: None,
                },
            )
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        s.create_workflow_edge(wf, t, a, None).unwrap();
        s.create_workflow_edge(wf, a, b, None).unwrap();
        assert!(matches!(
            s.create_workflow_edge(wf, a, b, None),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            s.create_workflow_edge(wf, b, b, None),
            Err(Error::Cycle(_))
        ));
        assert!(matches!(
            s.create_workflow_edge(wf, b, a, None),
            Err(Error::Cycle(_))
        ));
        assert!(matches!(
            s.create_workflow_edge(wf, b, t, None),
            Err(Error::Validation(_))
        ));
        // Branch rules.
        assert!(matches!(
            s.create_workflow_edge(wf, br, a, None),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            s.create_workflow_edge(wf, a, br, Some(WorkflowBranch::True)),
            Err(Error::Validation(_))
        ));
        s.create_workflow_edge(wf, a, br, None).unwrap();
        s.create_workflow_edge(wf, br, b, Some(WorkflowBranch::True))
            .unwrap();
        // Another workflow's node.
        let wf2 = s.create_workflow(None, "Other", None).unwrap().id;
        let o = node(&mut s, wf2, WorkflowNodeKind::Cli, "O", cli("true"));
        assert!(matches!(
            s.create_workflow_edge(wf, a, o, None),
            Err(Error::Validation(_))
        ));
        // Names: unique case-insensitively, never a number.
        assert!(matches!(
            s.create_workflow(None, "flow", None),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            s.create_workflow(None, "42", None),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            s.update_workflow(
                wf2,
                WorkflowPatch {
                    name: Some("FLOW".into()),
                    ..Default::default()
                }
            ),
            Err(Error::Conflict(_))
        ));
        assert_eq!(s.find_workflow_by_name("FLOW").unwrap().id, wf);
        // Derived trigger.
        assert_eq!(
            s.get_workflow(wf).unwrap().trigger,
            Some(WorkflowTrigger::Manual)
        );
        assert_eq!(s.get_workflow(wf2).unwrap().trigger, None);
    }

    #[test]
    fn a_run_takes_the_true_path_and_skips_the_false_one() {
        let (st, _d) = store();
        let wf = st.with(|s| {
            let wf = s.create_workflow(None, "Gate", None).unwrap().id;
            let t = node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "manual"}),
            );
            let c = node(
                s,
                wf,
                WorkflowNodeKind::Cli,
                "Echo",
                cli("cat; printf ' seen'"),
            );
            let b = node(
                s,
                wf,
                WorkflowNodeKind::Branch,
                "Gate",
                json!({"op": "contains", "value": "idea"}),
            );
            let yes = node(
                s,
                wf,
                WorkflowNodeKind::Output,
                "Yes",
                json!({"target": "log", "log": "yes"}),
            );
            let no = node(
                s,
                wf,
                WorkflowNodeKind::Output,
                "No",
                json!({"target": "log", "log": "no"}),
            );
            s.create_workflow_edge(wf, t, c, None).unwrap();
            s.create_workflow_edge(wf, c, b, None).unwrap();
            s.create_workflow_edge(wf, b, yes, Some(WorkflowBranch::True))
                .unwrap();
            s.create_workflow_edge(wf, b, no, Some(WorkflowBranch::False))
                .unwrap();
            wf
        });
        let run = run_workflow(&st, wf, WorkflowTrigger::Manual, "an idea").unwrap();
        assert_eq!(run.status, WorkflowRunStatus::Succeeded, "{run:?}");
        let status: Vec<_> = run
            .steps
            .iter()
            .map(|s| (s.title.as_str(), s.status))
            .collect();
        assert_eq!(
            status,
            vec![
                ("T", WorkflowStepStatus::Ok),
                ("Echo", WorkflowStepStatus::Ok),
                ("Gate", WorkflowStepStatus::Ok),
                ("Yes", WorkflowStepStatus::Ok),
                ("No", WorkflowStepStatus::Skipped),
            ]
        );
        assert_eq!(run.steps[1].output, "an idea seen");
        let lines = st.with(|s| s.list_workflow_log(Some("yes"), 10)).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "an idea seen");
        assert!(
            st.with(|s| s.list_workflow_log(Some("no"), 10))
                .unwrap()
                .is_empty()
        );
        // The other way round: no "idea" in the input, so the false edge is
        // the active one and the true one is skipped.
        let run = run_workflow(&st, wf, WorkflowTrigger::Voice, "").unwrap();
        assert_eq!(run.status, WorkflowRunStatus::Succeeded, "{run:?}");
        assert_eq!(run.steps[3].status, WorkflowStepStatus::Skipped);
        assert_eq!(run.steps[4].status, WorkflowStepStatus::Ok, "{run:?}");
    }

    #[test]
    fn a_failing_node_fails_the_run_and_skips_the_rest() {
        let (st, _d) = store();
        let wf = st.with(|s| {
            let wf = s.create_workflow(None, "Fail", None).unwrap().id;
            let t = node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "manual"}),
            );
            let bad = node(
                s,
                wf,
                WorkflowNodeKind::Cli,
                "Bad",
                cli("echo boom >&2; exit 3"),
            );
            let out = node(
                s,
                wf,
                WorkflowNodeKind::Output,
                "Out",
                json!({"target": "log"}),
            );
            s.create_workflow_edge(wf, t, bad, None).unwrap();
            s.create_workflow_edge(wf, bad, out, None).unwrap();
            wf
        });
        let run = run_workflow(&st, wf, WorkflowTrigger::Manual, "x").unwrap();
        assert_eq!(run.status, WorkflowRunStatus::Failed);
        assert_eq!(run.steps[1].status, WorkflowStepStatus::Failed);
        assert!(run.steps[1].error.as_deref().unwrap().contains("boom"));
        assert_eq!(run.steps[2].status, WorkflowStepStatus::Skipped);
        assert!(run.error.as_deref().unwrap().contains("Bad"));
    }

    #[test]
    fn a_cli_node_times_out_and_gets_its_input_twice() {
        let (st, _d) = store();
        let wf = st.with(|s| {
            let wf = s.create_workflow(None, "Slow", None).unwrap().id;
            let t = node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "manual"}),
            );
            let a = node(
                s,
                wf,
                WorkflowNodeKind::Cli,
                "Both",
                cli("printf '%s|' \"$NARU_INPUT\"; cat"),
            );
            let b = node(
                s,
                wf,
                WorkflowNodeKind::Cli,
                "Slow",
                json!({"command": "sleep 30", "timeout_secs": 1}),
            );
            s.create_workflow_edge(wf, t, a, None).unwrap();
            s.create_workflow_edge(wf, a, b, None).unwrap();
            wf
        });
        let started = Instant::now();
        let run = run_workflow(&st, wf, WorkflowTrigger::Manual, "$(id) `x` 'q'").unwrap();
        assert!(started.elapsed() < Duration::from_secs(20));
        assert_eq!(run.steps[1].output, "$(id) `x` 'q'|$(id) `x` 'q'");
        assert_eq!(run.steps[2].status, WorkflowStepStatus::Failed);
        assert!(run.steps[2].error.as_deref().unwrap().contains("timed out"));
    }

    #[test]
    fn two_upstreams_join_in_edge_order_and_an_orphan_is_skipped() {
        let (st, _d) = store();
        let wf = st.with(|s| {
            let wf = s.create_workflow(None, "Join", None).unwrap().id;
            let t = node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "manual"}),
            );
            let a = node(s, wf, WorkflowNodeKind::Cli, "A", cli("echo a"));
            let b = node(s, wf, WorkflowNodeKind::Cli, "B", cli("echo b"));
            let j = node(s, wf, WorkflowNodeKind::Cli, "J", cli("cat"));
            let _orphan = node(s, wf, WorkflowNodeKind::Cli, "Orphan", cli("echo never"));
            // Edge ids decide the join order: b's edge is created first.
            s.create_workflow_edge(wf, t, a, None).unwrap();
            s.create_workflow_edge(wf, t, b, None).unwrap();
            s.create_workflow_edge(wf, b, j, None).unwrap();
            s.create_workflow_edge(wf, a, j, None).unwrap();
            wf
        });
        let run = run_workflow(&st, wf, WorkflowTrigger::Manual, "").unwrap();
        assert_eq!(run.steps[3].title, "J");
        assert_eq!(run.steps[3].output, "b\n\na\n");
        assert_eq!(run.steps[4].title, "Orphan");
        assert_eq!(run.steps[4].status, WorkflowStepStatus::Skipped);
        let shared: Arc<Mutex<Store>> = Arc::new(st);
        // The API's shape works too.
        assert!(run_workflow(&*shared, wf, WorkflowTrigger::Manual, "").is_ok());
    }

    #[test]
    fn runs_need_exactly_one_trigger_and_are_pruned() {
        let (st, _d) = store();
        let wf = st.with(|s| s.create_workflow(None, "NoTrigger", None).unwrap().id);
        assert!(matches!(
            run_workflow(&st, wf, WorkflowTrigger::Manual, ""),
            Err(Error::Validation(_))
        ));
        st.with(|s| {
            node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "manual"}),
            )
        });
        for _ in 0..(crate::core::store::WORKFLOW_RUN_KEEP + 3) {
            run_workflow(&st, wf, WorkflowTrigger::Manual, "").unwrap();
        }
        let runs = st.with(|s| s.list_workflow_runs(wf)).unwrap();
        // Pruned on insert, before the newest run is finished: the 50 kept
        // finished runs plus the one just written.
        assert_eq!(runs.len() as i64, crate::core::store::WORKFLOW_RUN_KEEP + 1);
        assert!(runs[0].id > runs[1].id);
    }

    #[test]
    fn task_inbox_and_board_outputs() {
        let (st, _d) = store();
        let (wf, task) = st.with(|s| {
            let p = s.create_project("proj", None, None, None, None).unwrap();
            let task = s
                .create_task(
                    p.id,
                    "origin",
                    Priority::Medium,
                    &[],
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap();
            let wf = s.create_workflow(Some(p.id), "Outs", None).unwrap().id;
            let t = node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "manual"}),
            );
            let mk = node(
                s,
                wf,
                WorkflowNodeKind::Output,
                "Task",
                json!({"target": "task", "project": "PROJ"}),
            );
            let ib = node(
                s,
                wf,
                WorkflowNodeKind::Output,
                "Inbox",
                json!({"target": "inbox", "task_id": task.id, "kind": "change-request"}),
            );
            let bd = node(
                s,
                wf,
                WorkflowNodeKind::Output,
                "Board",
                json!({"target": "board"}),
            );
            for n in [mk, ib, bd] {
                s.create_workflow_edge(wf, t, n, None).unwrap();
            }
            (wf, task.id)
        });
        let run = run_workflow(&st, wf, WorkflowTrigger::Manual, "do the thing").unwrap();
        assert_eq!(run.steps[1].status, WorkflowStepStatus::Ok, "{run:?}");
        assert!(run.steps[1].output.starts_with("created task"));
        assert_eq!(run.steps[2].status, WorkflowStepStatus::Ok, "{run:?}");
        // No live session: the board node fails with a clear message.
        assert_eq!(run.steps[3].status, WorkflowStepStatus::Failed);
        assert!(
            run.steps[3]
                .error
                .as_deref()
                .unwrap()
                .contains("no live session")
        );
        let items = st.with(|s| s.list_inbox_items(None)).unwrap();
        assert_eq!(items[0].body, "do the thing");
        assert_eq!(items[0].task_id, Some(task));
    }

    #[test]
    fn due_time_workflows_follow_the_store_clock() {
        let (st, _d) = store();
        let wf = st.with(|s| {
            let wf = s.create_workflow(None, "Tick", None).unwrap().id;
            node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "time", "every_minutes": 5}),
            );
            wf
        });
        assert_eq!(st.with(|s| s.due_time_workflows()).unwrap(), vec![wf]);
        run_workflow(&st, wf, WorkflowTrigger::Time, "").unwrap();
        assert!(st.with(|s| s.due_time_workflows()).unwrap().is_empty());
        // A manual run does not count as the time run.
        let other = st.with(|s| {
            let w = s.create_workflow(None, "Tick2", None).unwrap().id;
            node(
                s,
                w,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "time", "every_minutes": 5}),
            );
            w
        });
        run_workflow(&st, other, WorkflowTrigger::Manual, "").unwrap();
        assert_eq!(st.with(|s| s.due_time_workflows()).unwrap(), vec![other]);
    }
    #[test]
    fn local_model_names_cannot_start_with_a_dash_and_script_takes_a_timeout() {
        let bad = |c: Value| validate_config(WorkflowNodeKind::Prompt, &c).unwrap_err();
        assert!(bad(json!({"model": "local:-h", "prompt": "x"})).contains("model"));
        assert!(
            validate_config(
                WorkflowNodeKind::Prompt,
                &json!({"model": "local:hf.co/a/b:Q4", "prompt": "x"})
            )
            .is_ok()
        );
        let ok = validate_config(
            WorkflowNodeKind::Script,
            &json!({"script": "s", "timeout_secs": 5}),
        )
        .unwrap();
        assert_eq!(ok["timeout_secs"], json!(5));
        assert!(
            validate_config(
                WorkflowNodeKind::Script,
                &json!({"script": "s", "timeout_secs": 0})
            )
            .is_err()
        );
    }

    #[test]
    fn a_script_node_times_out_and_refuses_oversized_values() {
        let (st, _d) = store();
        let wf = st.with(|s| {
            s.create_script(
                None,
                "slow",
                None,
                "case \"$1\" in slow) sleep 30;; *) printf '%s' \"$1\";; esac",
                &[crate::core::types::ScriptArg {
                    name: "t".into(),
                    label: None,
                    kind: crate::core::types::ScriptArgKind::Text,
                    required: true,
                    default: None,
                    choices: None,
                }],
            )
            .unwrap();
            let wf = s.create_workflow(None, "Scr", None).unwrap().id;
            let t = node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "manual"}),
            );
            let n = node(
                s,
                wf,
                WorkflowNodeKind::Script,
                "S",
                json!({"script": "slow", "values": {"t": "{input}"}, "timeout_secs": 1}),
            );
            s.create_workflow_edge(wf, t, n, None).unwrap();
            wf
        });
        let started = Instant::now();
        let run = run_workflow(&st, wf, WorkflowTrigger::Manual, "slow").unwrap();
        assert!(started.elapsed() < Duration::from_secs(15));
        assert_eq!(run.steps[1].status, WorkflowStepStatus::Failed);
        assert!(run.steps[1].error.as_deref().unwrap().contains("timed out"));
        let big = "x".repeat(ARG_INPUT_MAX + 1);
        let run = run_workflow(&st, wf, WorkflowTrigger::Manual, &big).unwrap();
        assert!(run.steps[1].error.as_deref().unwrap().contains("limit"));
    }

    #[test]
    fn empty_input_to_an_output_node_is_nothing_to_deliver_not_a_failure() {
        let (st, _d) = store();
        let wf = st.with(|s| {
            let wf = s.create_workflow(None, "Quiet", None).unwrap().id;
            let t = node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "manual"}),
            );
            let l = node(
                s,
                wf,
                WorkflowNodeKind::Output,
                "L",
                json!({"target": "log"}),
            );
            s.create_workflow_edge(wf, t, l, None).unwrap();
            wf
        });
        let run = run_workflow(&st, wf, WorkflowTrigger::Manual, "  \n").unwrap();
        assert_eq!(run.status, WorkflowRunStatus::Succeeded, "{run:?}");
        assert_eq!(run.steps[1].output, "nothing to deliver");
        assert!(
            st.with(|s| s.list_workflow_log(None, 10))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_cycle_in_the_database_refuses_to_run() {
        let (st, _d) = store();
        let (wf, a, b) = st.with(|s| {
            let wf = s.create_workflow(None, "Loop", None).unwrap().id;
            let t = node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "manual"}),
            );
            let a = node(s, wf, WorkflowNodeKind::Cli, "A", cli("true"));
            let b = node(s, wf, WorkflowNodeKind::Cli, "B", cli("true"));
            s.create_workflow_edge(wf, t, a, None).unwrap();
            s.create_workflow_edge(wf, a, b, None).unwrap();
            (wf, a, b)
        });
        // Smuggle in the back-edge the store would refuse.
        st.with(|s| s.force_workflow_edge_for_test(wf, b, a));
        let run = run_workflow(&st, wf, WorkflowTrigger::Manual, "").unwrap();
        assert_eq!(run.status, WorkflowRunStatus::Failed);
        assert!(run.error.as_deref().unwrap().contains("not a DAG"));
    }

    /// A backgrounded grandchild holds the pipes open after bash exits;
    /// `capture` must kill the group and return, not wait it out.
    #[test]
    fn capture_returns_promptly_past_a_backgrounded_grandchild() {
        let mut cmd = Command::new("bash");
        cmd.arg("-c").arg("sleep 1000 & echo done");
        let started = Instant::now();
        let out = agents::capture(cmd, None, Duration::from_secs(60)).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(String::from_utf8_lossy(&out.stdout), "done\n");
        assert_eq!(out.code, 0);
    }

    #[test]
    fn a_time_claim_is_atomic_across_connections() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let wf = {
            let mut s = Store::open(&path).unwrap();
            let wf = s.create_workflow(None, "Tick", None).unwrap().id;
            node(
                &mut s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "time", "every_minutes": 5}),
            );
            wf
        };
        let wins: usize = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let mut s = Store::open(&path).unwrap();
                    s.claim_time_workflow_run(wf).unwrap().is_some() as usize
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .sum();
        assert_eq!(wins, 1, "exactly one claimer fires an interval");
        let mut s = Store::open(&path).unwrap();
        assert!(s.claim_time_workflow_run(wf).unwrap().is_none());
    }

    #[test]
    fn pruning_never_deletes_a_running_run_and_reconcile_closes_only_dead_owners() {
        let (st, _d) = store();
        st.with(|s| {
            let wf = s.create_workflow(None, "Keep", None).unwrap().id;
            node(
                s,
                wf,
                WorkflowNodeKind::Trigger,
                "T",
                json!({"mode": "manual"}),
            );
            let running = s
                .create_workflow_run(wf, WorkflowTrigger::Time, "")
                .unwrap();
            for _ in 0..(crate::core::store::WORKFLOW_RUN_KEEP + 5) {
                let r = s
                    .create_workflow_run(wf, WorkflowTrigger::Manual, "")
                    .unwrap();
                s.finish_workflow_run(r.id, WorkflowRunStatus::Succeeded, &[], None)
                    .unwrap();
            }
            let all = s.list_workflow_runs(wf).unwrap();
            assert!(
                all.iter().any(|r| r.id == running.id),
                "the running claim survives pruning"
            );
            assert_eq!(
                all.iter()
                    .filter(|r| r.status != WorkflowRunStatus::Running)
                    .count() as i64,
                crate::core::store::WORKFLOW_RUN_KEEP + 1
            );
            // Reconcile: ours (pid 1 here) and dead owners close; a live foreign one stays.
            s.force_run_owner_for_test(running.id, 424242);
            assert!(s.reconcile_workflow_runs(1, |_| true).unwrap().is_empty());
            let closed = s.reconcile_workflow_runs(1, |_| false).unwrap();
            assert_eq!(closed, vec![running.id]);
            let r = s.get_workflow_run(running.id).unwrap();
            assert_eq!(r.status, WorkflowRunStatus::Failed);
            assert!(r.error.unwrap().contains("server restarted"));
        });
    }

    #[test]
    fn log_limit_out_of_range_is_validation() {
        let (st, _d) = store();
        for bad in [0, -1, 1001] {
            assert!(matches!(
                st.with(|s| s.list_workflow_log(None, bad)),
                Err(Error::Validation(_))
            ));
        }
        assert!(st.with(|s| s.list_workflow_log(None, 1000)).is_ok());
    }
}
