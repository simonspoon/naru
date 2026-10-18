//! The detached agent runner (naru task 1686, `docs/runner.md`).
//!
//! A *run* is one `claude -p` session held open on stream-json stdin by a small
//! detached process of this same binary (`naru run __runner <job-dir>`), so the
//! agent keeps working when the Naru server (or the CLI that started it) dies.
//! Everything a run is lives in a job directory, `<naru home>/runs/<job-id>/`,
//! and the files are the source of truth — there is no db table, so the surface
//! works with no server running and a restarted server reattaches simply by
//! reading them:
//!
//! - `job.json` — the [`Job`] record. **Written by the runner alone** once it
//!   is up (before that by `start`, after it by `stop`/`reconcile` only when
//!   no runner is alive), atomically.
//! - `events.jsonl` — every stdout line of claude, verbatim, plus the runner's
//!   own `{"type":"naru_runner",…}` lines.
//! - `inbox/` — pending user messages, one `.json` file each, written by
//!   temp+rename and moved to `inbox/delivered/` *before* they are written to
//!   claude, so a resume never delivers one twice (at-most-once: a crash in the
//!   microseconds between the two loses that message rather than repeating it).
//! - `stop` — a marker file asking the runner to wind down.
//! - `runner.pid`, `claude.log`, `runner.log`.
//!
//! The claude command line is the `runner` config template
//! ([`config::RUNNER`]) resolved through `agents::runner_script`; this module
//! never names `claude`.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::store::{Error, Result};
use super::{agents, config, library, script_runs};

/// How long an urgent message waits for the cut turn's result.
const INTERRUPT_HOLD: Duration = Duration::from_secs(10);

/// How often the runner looks at its inbox, the stop marker and the clock.
const POLL: Duration = Duration::from_millis(200);
/// Default idle timeout: this long since the last result with nothing in
/// flight and the runner winds the session down (`finished`).
pub const DEFAULT_IDLE_SECS: u64 = 3600;
/// After a stop request: how long claude gets to finish before its group is
/// killed.
const STOP_GRACE: Duration = Duration::from_secs(5);
/// After the idle timeout closes stdin: how long claude gets to exit.
const IDLE_GRACE: Duration = Duration::from_secs(30);
/// A runner younger than this with no pid file yet is "just spawned", not dead.
const SPAWN_GRACE_SECS: i64 = 5;
/// Longest message accepted, bytes.
pub const MESSAGE_MAX: usize = 256 * 1024;
/// What the resumed session is told when its last turn never produced a result.
pub const CONTINUE_MESSAGE: &str =
    "The process running you was restarted mid-turn. Continue where you left off.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Idle,
    Finished,
    Failed,
    Stopped,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RunStatus::Finished | RunStatus::Failed | RunStatus::Stopped
        )
    }
}

/// `job.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub job_id: String,
    pub session_id: String,
    pub cwd: String,
    pub model: String,
    /// The agent definition (`--agent`), if one was asked for; read again on
    /// every resume so the same agent carries on.
    #[serde(default)]
    pub agent: Option<String>,
    /// The label (`--name`), or the job id when none was given.
    pub name: String,
    pub status: RunStatus,
    pub runner_pid: Option<i64>,
    pub claude_pid: Option<i64>,
    /// True once claude has been launched at least once — what makes the next
    /// launch a `--resume`.
    #[serde(default)]
    pub claude_started: bool,
    /// Unix seconds.
    pub started_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
    pub last_result: Option<String>,
    pub last_subtype: Option<String>,
    pub last_is_error: Option<bool>,
    #[serde(default)]
    pub resumes: u32,
    #[serde(default = "default_idle")]
    pub idle_timeout_secs: u64,
    /// The config action whose template launches claude for this run; absent
    /// (every job written before naru task 1885) means [`config::RUNNER`].
    /// Set only by the crate-internal [`start_in_with`], never by a caller of
    /// `naru run start` / `POST /api/runs`, and kept by every resume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

impl Job {
    /// The template action this run launches claude through.
    pub fn action(&self) -> &str {
        self.template.as_deref().unwrap_or(config::RUNNER)
    }
}

fn default_idle() -> u64 {
    DEFAULT_IDLE_SECS
}

/// What `naru run start` / `POST /api/runs` take.
#[derive(Debug, Clone, Deserialize)]
pub struct StartOpts {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub idle_timeout_secs: Option<u64>,
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---- pure parts ---------------------------------------------------------

/// One stream-json user message line, as `claude -p --input-format
/// stream-json` reads it.
pub fn encode_user_message(text: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})
        .to_string()
}

/// One stream-json control request asking claude to interrupt its current turn.
pub fn encode_interrupt(request_id: &str) -> String {
    json!({"type": "control_request", "request_id": request_id, "request": {"subtype": "interrupt"}})
        .to_string()
}

/// A v4 UUID string from 16 random bytes.
pub fn uuid_from_bytes(mut b: [u8; 16]) -> String {
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf)
}

/// A job id is 8 lowercase hex digits — also what makes it a safe path part.
pub fn is_valid_job_id(id: &str) -> bool {
    id.len() == 8 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// What one stdout line of claude means to the runner.
#[derive(Debug, PartialEq)]
pub enum Event {
    /// `{"type":"result",…}`: a turn finished.
    Result {
        text: Option<String>,
        subtype: Option<String>,
        is_error: bool,
    },
    /// `{"type":"system","subtype":"init"}`: claude opened a turn (possibly
    /// on its own, e.g. a background subagent's notification waking it).
    TurnStarted,
    /// `{"type":"system","subtype":"background_tasks_changed","tasks":[…]}`:
    /// the number of background subagents/shells now running.
    BackgroundTasks(usize),
    Other,
}

pub fn parse_event(line: &str) -> Event {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Event::Other;
    };
    if v.get("type").and_then(Value::as_str) == Some("system") {
        return match v.get("subtype").and_then(Value::as_str) {
            Some("init") => Event::TurnStarted,
            Some("background_tasks_changed") => match v.get("tasks").and_then(Value::as_array) {
                Some(t) => Event::BackgroundTasks(t.len()),
                None => Event::Other,
            },
            _ => Event::Other,
        };
    }
    if v.get("type").and_then(Value::as_str) != Some("result") {
        return Event::Other;
    }
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Event::Result {
        text: s("result"),
        subtype: s("subtype"),
        is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false)
            || s("subtype").is_some_and(|t| t.starts_with("error")),
    }
}

/// The inbox files still waiting, oldest first (names sort by time).
pub fn pending_inbox(inbox: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(inbox)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension().is_some_and(|x| x == "json")
                && !p
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with('.'))
        })
        .collect();
    files.sort();
    files
}

/// Writes `body` to `path` through a sibling temp file and a rename.
fn atomic_write(path: &Path, body: &[u8]) -> Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        name.unwrap_or_default(),
        std::process::id()
    ));
    fs::write(&tmp, body)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// Queues `text` in `inbox/` as the next message.
pub fn enqueue(inbox: &Path, text: &str, interrupt: bool) -> Result<String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let rnd = random_bytes::<2>()?;
    let name = format!("{nanos:020}-{:02x}{:02x}.json", rnd[0], rnd[1]);
    fs::create_dir_all(inbox)?;
    // Only an urgent message carries the key, so a plain one is unchanged.
    let body = if interrupt {
        json!({"text": text, "interrupt": true})
    } else {
        json!({"text": text})
    };
    atomic_write(&inbox.join(&name), body.to_string().as_bytes())?;
    Ok(name)
}

/// Queues `text` in `inbox/` under a caller-chosen `name` unless that name is
/// already queued or already delivered (naru task 2051): the idempotent
/// enqueue the live push loop uses, so a retry after a crash never sends one
/// turn twice. `true` when it wrote the file.
pub fn enqueue_named(inbox: &Path, name: &str, text: &str) -> Result<bool> {
    let name = format!("{name}.json");
    if inbox.join(&name).exists() || inbox.join("delivered").join(&name).exists() {
        return Ok(false);
    }
    fs::create_dir_all(inbox)?;
    atomic_write(
        &inbox.join(&name),
        json!({"text": text}).to_string().as_bytes(),
    )?;
    Ok(true)
}

/// Removes a still-queued named message (best effort) — for a push whose turn
/// a `listen` claimed in the meantime.
pub fn dequeue_named(inbox: &Path, name: &str) {
    let _ = fs::remove_file(inbox.join(format!("{name}.json")));
}

/// Where a run's inbox is, if the run exists and has not ended.
pub fn live_inbox_in(runs: &Path, id: &str) -> Option<PathBuf> {
    let dir = job_dir_of(runs, id).ok()?;
    let job = load(&dir).ok()?;
    (!job.status.is_terminal()).then(|| dir.join("inbox"))
}

// ---- job files ----------------------------------------------------------

/// `<naru home>/runs`.
pub fn runs_dir() -> PathBuf {
    let home = directories::BaseDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .unwrap_or_default();
    config::dot_dir_in(&home).join("runs")
}

fn job_dir_of(runs: &Path, id: &str) -> Result<PathBuf> {
    if !is_valid_job_id(id) {
        return Err(Error::Validation(format!(
            "{id:?} is not a run id (8 lowercase hex digits)"
        )));
    }
    let dir = runs.join(id);
    if dir.join("job.json").is_file() {
        Ok(dir)
    } else {
        Err(Error::NotFound(format!("no run {id}")))
    }
}

pub fn load(dir: &Path) -> Result<Job> {
    let body = fs::read(dir.join("job.json"))?;
    serde_json::from_slice(&body)
        .map_err(|e| Error::Validation(format!("{} is not a job: {e}", dir.display())))
}

fn save(dir: &Path, job: &mut Job) -> Result<()> {
    job.updated_at = now_secs();
    let body = serde_json::to_vec_pretty(job).map_err(|e| Error::Validation(e.to_string()))?;
    atomic_write(&dir.join("job.json"), &body)
}

fn read_pid(dir: &Path) -> Option<i64> {
    fs::read_to_string(dir.join("runner.pid"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Whether the job's runner process exists (a just-spawned runner whose pid
/// file is not there yet counts as alive).
fn runner_alive(dir: &Path, job: &Job) -> bool {
    match read_pid(dir) {
        // A recycled pid names some other program; only a `__runner` counts.
        Some(pid) => {
            script_runs::pid_is_live(pid)
                && pid_command(pid).is_some_and(|c| c.contains("__runner"))
        }
        None => now_secs() - job.updated_at <= SPAWN_GRACE_SECS,
    }
}

/// The command line of `pid` (`ps -o command=`), `None` when it cannot be read
/// -- which callers treat as "not ours".
pub(crate) fn pid_command(pid: i64) -> Option<String> {
    #[cfg(windows)]
    return crate::core::proc::pid_command(pid);
    #[cfg(not(windows))]
    pid_command_ps(pid)
}

#[cfg(not(windows))]
fn pid_command_ps(pid: i64) -> Option<String> {
    let out = Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let cmd = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !cmd.is_empty()).then_some(cmd)
}

/// Kills claude's process group only if `pid` still is that claude: its
/// command line carries the run's session id. A recycled pid is left alone.
fn kill_claude(pid: i64, session_id: &str, sig: &str) {
    if pid_command(pid).is_some_and(|c| c.contains(session_id)) {
        signal_group(pid, sig);
    }
}

/// `append_event` — one line, flushed.
fn append_event(dir: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("events.jsonl"))
    {
        let _ = writeln!(f, "{}", line.trim_end_matches(['\n', '\r']));
    }
}

fn runner_event(dir: &Path, event: &str, extra: Value) {
    let mut v = json!({"type": "naru_runner", "event": event, "at": now_secs()});
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    append_event(dir, &v.to_string());
}

/// The job plus what is derived on every read.
fn view(dir: &Path, job: &Job) -> Value {
    let mut v = serde_json::to_value(job).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.insert(
            "runner_alive".into(),
            json!(!job.status.is_terminal() && runner_alive(dir, job)),
        );
        o.insert(
            "pending_messages".into(),
            json!(pending_inbox(&dir.join("inbox")).len()),
        );
    }
    v
}

/// A line of a subagent: it carries a string `parent_tool_use_id`, or is a
/// system line with `owned_by_subagent: true`. A null id is the main thread.
fn is_subagent_line(v: &Value) -> bool {
    v.get("parent_tool_use_id").is_some_and(Value::is_string)
        || v.get("owned_by_subagent").and_then(Value::as_bool) == Some(true)
}

/// Whether a raw stdout line is a subagent's (unparseable counts as main).
fn line_is_subagent(line: &str) -> bool {
    serde_json::from_str::<Value>(line).is_ok_and(|v| is_subagent_line(&v))
}

/// `<job dir>/message-pending`: a message was delivered while a turn was in
/// flight, so claude has it on stdin but reads it only once its current tool
/// call returns. A tool call inside the session (`NARU_RUN_DIR`) can watch it.
fn pending_marker(dir: &Path) -> PathBuf {
    dir.join("message-pending")
}

/// Drops the marker once claude is acting again: a main-thread assistant line
/// (a subagent's lines say nothing about the main thread) or the turn's result.
fn clear_pending_on(dir: &Path, line: &str, event: &Event) {
    let main_assistant = serde_json::from_str::<Value>(line).is_ok_and(|v| {
        v.get("type").and_then(Value::as_str) == Some("assistant") && !is_subagent_line(&v)
    });
    if main_assistant || matches!(event, Event::Result { .. }) {
        let _ = fs::remove_file(pending_marker(dir));
    }
}

/// The run's events; `main_only` drops subagent lines (the log itself stays
/// verbatim) and `tail` counts after that filter.
fn events_of(dir: &Path, tail: Option<usize>, main_only: bool) -> Vec<Value> {
    let Ok(body) = fs::read(dir.join("events.jsonl")) else {
        return vec![];
    };
    let text = String::from_utf8_lossy(&body);
    let mut events: Vec<Value> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|_| Value::String(l.to_string())))
        .filter(|v| !(main_only && is_subagent_line(v)))
        .collect();
    if let Some(n) = tail {
        events.drain(..events.len().saturating_sub(n));
    }
    events
}

// ---- the surface --------------------------------------------------------

/// Creates the job dir and its first inbox message; spawns nothing.
pub fn create_job(runs: &Path, opts: &StartOpts) -> Result<Job> {
    create_job_with(runs, opts, None)
}

/// [`create_job`] with a per-job template action (`None` = the `runner`
/// template). Crate-internal: no CLI flag or API body reaches it.
pub(crate) fn create_job_with(
    runs: &Path,
    opts: &StartOpts,
    template: Option<&str>,
) -> Result<Job> {
    if opts.model.trim().is_empty() {
        return Err(Error::Validation("model must not be empty".into()));
    }
    if opts.prompt.trim().is_empty() {
        return Err(Error::Validation("prompt must not be empty".into()));
    }
    // Both land in claude's argv as a word; one starting with `-` would be
    // read as a flag.
    for (what, v) in [
        ("model", Some(&opts.model)),
        ("name", opts.name.as_ref()),
        ("agent", opts.agent.as_ref()),
    ] {
        if v.is_some_and(|v| v.trim().starts_with('-')) {
            return Err(Error::Validation(format!("{what} must not start with '-'")));
        }
    }
    if opts.prompt.len() > MESSAGE_MAX {
        return Err(Error::Validation(format!(
            "prompt is over {MESSAGE_MAX} bytes"
        )));
    }
    let cwd = match &opts.cwd {
        Some(c) => PathBuf::from(c),
        None => std::env::current_dir()?,
    };
    let cwd = fs::canonicalize(&cwd)
        .map_err(|e| Error::Validation(format!("cwd {} unusable: {e}", cwd.display())))?;
    if !cwd.is_dir() {
        return Err(Error::Validation(format!(
            "cwd {} is not a directory",
            cwd.display()
        )));
    }
    fs::create_dir_all(runs)?;
    let (job_id, dir) = loop {
        let b = random_bytes::<4>()?;
        let id: String = b.iter().map(|x| format!("{x:02x}")).collect();
        let dir = runs.join(&id);
        match fs::create_dir(&dir) {
            Ok(()) => break (id, dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    };
    let now = now_secs();
    let mut job = Job {
        name: opts
            .name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| job_id.clone()),
        job_id,
        session_id: uuid_from_bytes(random_bytes::<16>()?),
        cwd: cwd.to_string_lossy().into_owned(),
        model: opts.model.trim().to_string(),
        agent: opts
            .agent
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(str::to_string),
        status: RunStatus::Running,
        runner_pid: None,
        claude_pid: None,
        claude_started: false,
        started_at: now,
        updated_at: now,
        finished_at: None,
        last_result: None,
        last_subtype: None,
        last_is_error: None,
        resumes: 0,
        idle_timeout_secs: opts.idle_timeout_secs.unwrap_or(DEFAULT_IDLE_SECS).max(1),
        template: template.map(str::to_string),
    };
    fs::create_dir_all(dir.join("inbox").join("delivered"))?;
    enqueue(&dir.join("inbox"), &opts.prompt, false)?;
    save(&dir, &mut job)?;
    Ok(job)
}

/// Starts the runner for `dir` fully detached: its own process group, no
/// stdio tied to us, never waited on by anything that matters (the reaping
/// thread only stops a long-lived server from keeping a zombie, which
/// `kill -0` would read as alive).
pub fn spawn_runner(dir: &Path) -> Result<()> {
    let exe = crate::core::memory_job::self_exe()?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("runner.log"))?;
    let mut cmd = Command::new(exe);
    cmd.args(["run", "__runner"])
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    crate::core::proc::isolate(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| Error::Unavailable(format!("cannot start the runner: {e}")))?;
    atomic_write(&dir.join("runner.pid"), child.id().to_string().as_bytes())?;
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
}

/// `naru run start`.
pub fn start(opts: &StartOpts) -> Result<Value> {
    start_in(&runs_dir(), opts)
}

pub fn start_in(runs: &Path, opts: &StartOpts) -> Result<Value> {
    start_in_with(runs, opts, None)
}

/// [`start_in`] launching claude through the config template `action`
/// (`config::LIVE_AGENT` for the live conversation; `None` = `runner`).
/// Crate-internal on purpose: [`StartOpts`] carries no template, so a caller
/// of the CLI or API cannot choose one.
pub(crate) fn start_in_with(runs: &Path, opts: &StartOpts, action: Option<&str>) -> Result<Value> {
    start_in_spawning(runs, opts, action, spawn_runner)
}

/// [`start_in_with`] with the runner launch injected. A launch that fails
/// leaves the job `Failed` (terminal): a job left `Running` with no runner is
/// exactly what [`reconcile_in`] resumes, so a start that reported an error
/// would come back as a zombie run the caller believes never existed.
fn start_in_spawning(
    runs: &Path,
    opts: &StartOpts,
    action: Option<&str>,
    spawn: impl FnOnce(&Path) -> Result<()>,
) -> Result<Value> {
    let mut job = create_job_with(runs, opts, action)?;
    let dir = runs.join(&job.job_id);
    if let Err(e) = spawn(&dir) {
        job.status = RunStatus::Failed;
        job.finished_at = Some(now_secs());
        job.last_result = Some(e.to_string());
        let _ = save(&dir, &mut job);
        runner_event(&dir, "failed", json!({"error": e.to_string()}));
        return Err(e);
    }
    Ok(view(&dir, &job))
}

/// The job `id` in `runs`, for callers that need its fields (the live
/// receipt helpers).
pub(crate) fn job_in(runs: &Path, id: &str) -> Result<Job> {
    load(&job_dir_of(runs, id)?)
}

/// Why run `id` can no longer answer, or `None` while it can (naru task 1894):
/// its terminal status (`finished` | `failed` | `stopped`), or `died` for a
/// non-terminal run whose runner process is gone (a `kill -9` leaves the
/// status at `running`/`idle` for ever; a serve start-up reconcile resumes it,
/// and it reads `None` again). An unreadable `job.json` -- the window right
/// after a spawn -- is `None`, never ended.
pub fn ended_in(runs: &Path, id: &str) -> Option<String> {
    let dir = job_dir_of(runs, id).ok()?;
    let job = load(&dir).ok()?;
    match job.status {
        RunStatus::Finished => Some("finished".into()),
        RunStatus::Failed => Some("failed".into()),
        RunStatus::Stopped => Some("stopped".into()),
        RunStatus::Running | RunStatus::Idle => {
            (!runner_alive(&dir, &job)).then(|| "died".to_string())
        }
    }
}

pub fn send(id: &str, text: &str, interrupt: bool) -> Result<Value> {
    send_in(&runs_dir(), id, text, interrupt)
}

/// Queues a message. With `interrupt`, a runner with a turn in flight cuts
/// that turn first and delivers this message as a fresh one.
pub fn send_in(runs: &Path, id: &str, text: &str, interrupt: bool) -> Result<Value> {
    if text.trim().is_empty() {
        return Err(Error::Validation("message must not be empty".into()));
    }
    if text.len() > MESSAGE_MAX {
        return Err(Error::Validation(format!(
            "message is over {MESSAGE_MAX} bytes"
        )));
    }
    let dir = job_dir_of(runs, id)?;
    let job = load(&dir)?;
    if job.status.is_terminal() {
        return Err(Error::Conflict(format!(
            "run {id} is {:?}; start a new run",
            job.status
        )));
    }
    enqueue(&dir.join("inbox"), text, interrupt)?;
    Ok(view(&dir, &job))
}

pub fn show(id: &str, events: Option<usize>, main_only: bool) -> Result<Value> {
    show_in(&runs_dir(), id, events, main_only)
}

/// The job, plus its last `events` events when asked for (`main_only` leaves
/// out the subagents' lines).
pub fn show_in(runs: &Path, id: &str, events: Option<usize>, main_only: bool) -> Result<Value> {
    let dir = job_dir_of(runs, id)?;
    let job = load(&dir)?;
    let v = view(&dir, &job);
    Ok(match events {
        None => v,
        Some(n) => json!({"job": v, "events": events_of(&dir, Some(n), main_only)}),
    })
}

pub fn list() -> Result<Vec<Value>> {
    list_in(&runs_dir())
}

/// Every run, newest first. An unreadable job directory is skipped.
pub fn list_in(runs: &Path) -> Result<Vec<Value>> {
    let mut jobs = vec![];
    for entry in fs::read_dir(runs).into_iter().flatten().flatten() {
        let dir = entry.path();
        if let Ok(job) = load(&dir) {
            jobs.push((job.started_at, job.job_id.clone(), view(&dir, &job)));
        }
    }
    jobs.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    Ok(jobs.into_iter().map(|j| j.2).collect())
}

/// How long a finished, failed or stopped run stays in the Agents panel.
pub const RUN_LINGER_SECS: i64 = 3600;

/// The runs the Agents panel lists (naru task 1829): every non-terminal run,
/// plus terminal ones that finished within [`RUN_LINGER_SECS`], each with
/// whether its runner process is still alive. Newest first.
pub fn panel_jobs() -> Vec<(Job, bool)> {
    panel_jobs_in(&runs_dir())
}

pub fn panel_jobs_in(runs: &Path) -> Vec<(Job, bool)> {
    let now = now_secs();
    let mut jobs: Vec<(Job, bool)> = vec![];
    for entry in fs::read_dir(runs).into_iter().flatten().flatten() {
        let dir = entry.path();
        let Ok(job) = load(&dir) else { continue };
        if job.status.is_terminal()
            && now - job.finished_at.unwrap_or(job.updated_at) > RUN_LINGER_SECS
        {
            continue;
        }
        let alive = !job.status.is_terminal() && runner_alive(&dir, &job);
        jobs.push((job, alive));
    }
    jobs.sort_by(|a, b| {
        b.0.started_at
            .cmp(&a.0.started_at)
            .then_with(|| b.0.job_id.cmp(&a.0.job_id))
    });
    jobs
}

pub fn stop(id: &str) -> Result<Value> {
    stop_in(&runs_dir(), id)
}

/// Asks the runner to wind down. A run whose runner is already gone is closed
/// here (and its claude group killed), since no one else will.
pub fn stop_in(runs: &Path, id: &str) -> Result<Value> {
    let dir = job_dir_of(runs, id)?;
    let mut job = load(&dir)?;
    if job.status.is_terminal() {
        return Ok(view(&dir, &job));
    }
    atomic_write(&dir.join("stop"), b"stop\n")?;
    if !runner_alive(&dir, &job) {
        if let Some(pid) = job.claude_pid {
            kill_claude(pid, &job.session_id, "KILL");
        }
        job.status = RunStatus::Stopped;
        job.finished_at = Some(now_secs());
        save(&dir, &mut job)?;
        runner_event(&dir, "stopped", json!({"by": "stop, runner already gone"}));
    }
    Ok(view(&dir, &job))
}

pub fn interrupt(id: &str) -> Result<Value> {
    interrupt_in(&runs_dir(), id)
}

/// Asks the runner to interrupt the turn in flight. The runner is the only
/// writer to claude's stdin, so this only drops a marker; the turn still ends
/// on claude's own `result` line. A run that is not mid-turn is a no-op.
pub fn interrupt_in(runs: &Path, id: &str) -> Result<Value> {
    let dir = job_dir_of(runs, id)?;
    let job = load(&dir)?;
    if job.status.is_terminal() {
        return Err(Error::Conflict(format!(
            "run {id} is {:?}; nothing to interrupt",
            job.status
        )));
    }
    if job.status == RunStatus::Running {
        atomic_write(&dir.join("interrupt"), b"interrupt\n")?;
    }
    Ok(view(&dir, &job))
}

/// How long `run wait` blocks, and how it looks (naru task 1956).
#[derive(Debug, Clone)]
pub struct WaitOpts {
    /// Give up after this long (`deadline`, exit 11).
    pub deadline: Duration,
    /// Give up when `events.jsonl` has grown by no line for this long
    /// (`silent`, exit 10); `None` = no silence limit.
    pub silence: Option<Duration>,
    /// How often the job directory is looked at.
    pub poll: Duration,
}

/// Default `--deadline` of `run wait`, seconds.
pub const WAIT_DEADLINE_SECS: u64 = 600;
/// How many main-thread events `run wait` prints with the job.
const WAIT_TAIL: usize = 20;

/// What `run wait` ended on: the `reason`, the process exit code it maps to,
/// and the `{reason, job}` document printed.
#[derive(Debug, Clone)]
pub struct WaitOutcome {
    pub reason: &'static str,
    pub exit: i32,
    pub value: Value,
}

pub fn wait(id: &str, opts: &WaitOpts) -> Result<WaitOutcome> {
    wait_in(&runs_dir(), id, opts)
}

/// Blocks until the run's turn is done or it ends, reading `job.json`,
/// `events.jsonl`, `inbox/` and `message-pending` only: it never stops,
/// messages or touches the run. Reasons, in the order they are judged:
/// `idle` (status idle with no message queued or pending, so the turn is
/// done; seen at the first look it counts too; exit 0), `finished` (0),
/// `failed` / `stopped` (12), `silent` (10) and `deadline` (11). An idle run
/// with an undelivered inbox file or a `message-pending` marker is about to
/// run a turn, so it keeps waiting.
pub fn wait_in(runs: &Path, id: &str, opts: &WaitOpts) -> Result<WaitOutcome> {
    let dir = job_dir_of(runs, id)?;
    let started = Instant::now();
    let events_len = |d: &Path| fs::metadata(d.join("events.jsonl")).map_or(0, |m| m.len());
    let mut seen = events_len(&dir);
    let mut last_line = Instant::now();
    loop {
        let job = load(&dir)?;
        let n = events_len(&dir);
        if n != seen {
            seen = n;
            last_line = Instant::now();
        }
        let queued = !pending_inbox(&dir.join("inbox")).is_empty() || pending_marker(&dir).exists();
        let (reason, exit) = match job.status {
            RunStatus::Idle if !queued => ("idle", 0),
            RunStatus::Finished => ("finished", 0),
            RunStatus::Failed => ("failed", 12),
            RunStatus::Stopped => ("stopped", 12),
            _ if opts.silence.is_some_and(|s| last_line.elapsed() >= s) => ("silent", 10),
            _ if started.elapsed() >= opts.deadline => ("deadline", 11),
            _ => {
                std::thread::sleep(opts.poll);
                continue;
            }
        };
        let mut v = view(&dir, &job);
        if let Some(o) = v.as_object_mut() {
            o.insert(
                "events".into(),
                json!(events_of(&dir, Some(WAIT_TAIL), true)),
            );
        }
        return Ok(WaitOutcome {
            reason,
            exit,
            value: json!({"reason": reason, "job": v}),
        });
    }
}

/// Resumes every non-terminal run whose runner is dead; returns their ids.
pub fn reconcile() -> Result<Vec<String>> {
    reconcile_in(&runs_dir())
}

pub fn reconcile_in(runs: &Path) -> Result<Vec<String>> {
    let mut resumed = vec![];
    for entry in fs::read_dir(runs).into_iter().flatten().flatten() {
        let dir = entry.path();
        let Ok(job) = load(&dir) else { continue };
        if job.status.is_terminal() || runner_alive(&dir, &job) {
            continue;
        }
        match spawn_runner(&dir) {
            Ok(()) => resumed.push(job.job_id),
            Err(e) => eprintln!("naru: could not resume run {}: {e}", job.job_id),
        }
    }
    resumed.sort();
    Ok(resumed)
}

/// Whether claude ever finished a turn on this run.
fn events_have_result(dir: &Path) -> bool {
    events_of(dir, None, false)
        .iter()
        .any(|e| e.get("type").and_then(Value::as_str) == Some("result"))
}

/// Moves every delivered message back into the inbox, oldest first.
fn requeue_delivered(dir: &Path) -> Result<()> {
    let delivered = dir.join("inbox").join("delivered");
    for file in pending_inbox(&delivered) {
        if let Some(name) = file.file_name() {
            fs::rename(&file, dir.join("inbox").join(name))?;
        }
    }
    Ok(())
}

// ---- the runner ---------------------------------------------------------

fn signal_group(pgid: i64, sig: &str) {
    crate::core::proc::signal_group(pgid, sig);
}

enum Msg {
    Line(String),
    Eof,
}

#[derive(Clone, Copy, PartialEq)]
enum Closing {
    Stopped,
    Finished,
}

/// `naru run __runner <dir>`: holds one claude session open until it is
/// stopped, goes idle for too long, or dies.
pub fn run_runner(dir: &Path) -> Result<()> {
    // One runner per job for as long as it lives: a second (a racing
    // reconcile, two serves) finds the lock taken and leaves quietly. The OS
    // drops the lock when this process dies, however it dies.
    let lock = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("runner.lock"))?;
    if lock.try_lock().is_err() {
        return Ok(());
    }
    let result = run_runner_locked(dir);
    // A finished, stopped or dying run must not leave a stale marker behind.
    let _ = fs::remove_file(pending_marker(dir));
    drop(lock);
    result
}

fn run_runner_locked(dir: &Path) -> Result<()> {
    let mut job = load(dir)?;
    atomic_write(
        &dir.join("runner.pid"),
        std::process::id().to_string().as_bytes(),
    )?;
    // A leftover request must not interrupt the CONTINUE message of a resume.
    let _ = fs::remove_file(dir.join("interrupt"));
    // Nor may a resume inherit the dead runner's pending-message marker.
    let _ = fs::remove_file(pending_marker(dir));
    let resume = job.claude_started;
    let interrupted = resume && job.status == RunStatus::Running;
    if resume {
        // A claude from the dead runner may still be finishing its turn; two
        // processes on one session would race, so it goes first.
        if let Some(pid) = job.claude_pid {
            kill_claude(pid, &job.session_id, "TERM");
            std::thread::sleep(Duration::from_millis(300));
            kill_claude(pid, &job.session_id, "KILL");
        }
        job.resumes += 1;
        runner_event(
            dir,
            "resumed",
            json!({"resumes": job.resumes, "interrupted_turn": interrupted}),
        );
    }
    job.runner_pid = Some(std::process::id() as i64);
    job.status = if !resume || interrupted {
        RunStatus::Running
    } else {
        RunStatus::Idle
    };
    save(dir, &mut job)?;

    let prompts = super::Store::open_default()
        .ok()
        .and_then(|s| library::prompts(&s).ok())
        .unwrap_or_default();
    let script = agents::runner_script(
        job.action(),
        &job.model,
        &job.name,
        &job.session_id,
        resume,
        job.agent.as_deref(),
        &prompts,
    )
    .map_err(Error::Unavailable);
    let spawned = script.and_then(|script| {
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("claude.log"))?;
        let mut cmd = crate::core::proc::bash();
        cmd.arg("-c")
            .arg(script)
            .current_dir(&job.cwd)
            .env("NARU_RUN_DIR", dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log);
        crate::core::proc::augment_path(&mut cmd);
        crate::core::proc::isolate(&mut cmd);
        cmd.spawn()
            .map_err(|e| Error::Unavailable(format!("cannot start claude: {e}")))
    });
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            job.status = RunStatus::Failed;
            job.finished_at = Some(now_secs());
            job.last_result = Some(e.to_string());
            save(dir, &mut job)?;
            runner_event(dir, "failed", json!({"error": e.to_string()}));
            return Err(e);
        }
    };
    let pgid = child.id() as i64;
    job.claude_pid = Some(pgid);
    job.claude_started = true;
    save(dir, &mut job)?;
    runner_event(
        dir,
        "claude_started",
        json!({"pid": pgid, "resume": resume}),
    );

    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("stdout was piped");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let _ = tx.send(Msg::Line(String::from_utf8_lossy(&buf).into_owned()));
                }
            }
        }
        let _ = tx.send(Msg::Eof);
    });

    // claude folds messages that arrive mid-turn into the running turn, so N
    // deliveries can yield one result: track an open turn, not a count.
    let mut in_flight = false;
    let mut last_activity = Instant::now();
    // The latest `background_tasks_changed` count: a run waiting on them is
    // waiting legitimately, so the idle end holds off.
    let mut background_tasks = 0usize;
    // An urgent message cut the turn in flight: it and everything after it
    // wait for that turn's result, at most `INTERRUPT_HOLD`.
    let mut interrupt_hold: Option<Instant> = None;
    let mut interrupted_file: Option<std::ffi::OsString> = None;
    let mut closing: Option<(Closing, Instant)> = None;
    let mut exited: Option<(Instant, Option<i32>)> = None;
    let mut eof = false;
    let mut saw_output = false;

    // Writes one message to claude; the caller has already made it undeliverable
    // a second time.
    let deliver = |stdin: &mut Option<std::process::ChildStdin>, text: &str| -> bool {
        let Some(w) = stdin.as_mut() else {
            return false;
        };
        writeln!(w, "{}", encode_user_message(text))
            .and_then(|()| w.flush())
            .is_ok()
    };

    if interrupted && deliver(&mut stdin, CONTINUE_MESSAGE) {
        in_flight = true;
        runner_event(dir, "message_delivered", json!({"source": "resume"}));
    }

    loop {
        match rx.recv_timeout(POLL) {
            Ok(Msg::Line(line)) => {
                let line = line.trim_end_matches(['\n', '\r']);
                if line.trim().is_empty() {
                    continue;
                }
                saw_output = true;
                last_activity = Instant::now();
                append_event(dir, line);
                let event = parse_event(line);
                clear_pending_on(dir, line, &event);
                match &event {
                    // A subagent's `system/init` is not the main thread's turn.
                    Event::TurnStarted if !in_flight && !line_is_subagent(line) => {
                        in_flight = true;
                        job.status = RunStatus::Running;
                        save(dir, &mut job)?;
                    }
                    Event::BackgroundTasks(n) => background_tasks = *n,
                    _ => {}
                }
                if let Event::Result {
                    text,
                    subtype,
                    is_error,
                } = event
                {
                    in_flight = false;
                    job.last_result = text;
                    job.last_subtype = subtype;
                    job.last_is_error = Some(is_error);
                    job.status = RunStatus::Idle;
                    save(dir, &mut job)?;
                }
                // Drain whatever else is ready before polling the files.
                continue;
            }
            Ok(Msg::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => eof = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if exited.is_none()
            && let Ok(Some(status)) = child.try_wait()
        {
            exited = Some((Instant::now(), status.code()));
        }
        if let Some((at, _)) = exited {
            if eof || at.elapsed() > Duration::from_secs(2) {
                break;
            }
            continue;
        }

        if closing.is_none() && dir.join("stop").exists() {
            closing = Some((Closing::Stopped, Instant::now()));
            stdin = None;
            runner_event(dir, "stop_requested", json!({}));
        }
        if closing.is_none() && dir.join("interrupt").exists() {
            let _ = fs::remove_file(dir.join("interrupt"));
            if in_flight {
                let request_id = uuid_from_bytes(random_bytes::<16>().unwrap_or([7; 16]));
                if let Some(w) = stdin.as_mut()
                    && writeln!(w, "{}", encode_interrupt(&request_id))
                        .and_then(|()| w.flush())
                        .is_ok()
                {
                    runner_event(
                        dir,
                        "interrupt_requested",
                        json!({"request_id": request_id}),
                    );
                }
            }
        }
        if closing.is_none() {
            for file in pending_inbox(&dir.join("inbox")) {
                if let Some(since) = interrupt_hold {
                    if !in_flight || since.elapsed() >= INTERRUPT_HOLD {
                        interrupt_hold = None;
                    } else {
                        break;
                    }
                }
                let Some((text, urgent)) = fs::read_to_string(&file)
                    .ok()
                    .and_then(|b| serde_json::from_str::<Value>(&b).ok())
                    .and_then(|v| {
                        let text = v.get("text").and_then(Value::as_str)?.to_string();
                        let urgent = v.get("interrupt").and_then(Value::as_bool) == Some(true);
                        Some((text, urgent))
                    })
                else {
                    // Unreadable: move it aside rather than retry it forever.
                    let _ = fs::rename(&file, file.with_extension("bad"));
                    continue;
                };
                if urgent && in_flight && interrupted_file.as_deref() != file.file_name() {
                    let request_id = uuid_from_bytes(random_bytes::<16>().unwrap_or([7; 16]));
                    if let Some(w) = stdin.as_mut()
                        && writeln!(w, "{}", encode_interrupt(&request_id))
                            .and_then(|()| w.flush())
                            .is_ok()
                    {
                        runner_event(
                            dir,
                            "interrupt_requested",
                            json!({"request_id": request_id, "source": "message"}),
                        );
                        interrupt_hold = Some(Instant::now());
                        interrupted_file = file.file_name().map(|n| n.to_owned());
                        break;
                    }
                }
                // Out of the inbox first: a crash after this loses the message
                // rather than delivering it twice.
                let delivered = dir.join("inbox").join("delivered");
                let _ = fs::create_dir_all(&delivered);
                let name = file.file_name().unwrap_or_default().to_owned();
                if fs::rename(&file, delivered.join(&name)).is_err() {
                    continue;
                }
                if !deliver(&mut stdin, &text) {
                    // claude is not reading: hand the message back rather than
                    // lose it, and let the exit path below take over.
                    let _ = fs::rename(delivered.join(&name), &file);
                    break;
                }
                {
                    if in_flight {
                        let _ = fs::write(pending_marker(dir), b"");
                    }
                    in_flight = true;
                    job.status = RunStatus::Running;
                    save(dir, &mut job)?;
                    runner_event(
                        dir,
                        "message_delivered",
                        json!({"file": name.to_string_lossy()}),
                    );
                }
            }
        }
        if closing.is_none()
            && !in_flight
            && background_tasks == 0
            && last_activity.elapsed().as_secs() >= job.idle_timeout_secs
        {
            closing = Some((Closing::Finished, Instant::now()));
            stdin = None;
            runner_event(dir, "idle_timeout", json!({"secs": job.idle_timeout_secs}));
        }
        if let Some((kind, since)) = closing {
            let grace = if kind == Closing::Stopped {
                STOP_GRACE
            } else {
                IDLE_GRACE
            };
            if since.elapsed() > grace {
                signal_group(pgid, "KILL");
            }
        }
    }

    let _ = child.wait();
    // Anything claude's descendants left behind goes with the group.
    signal_group(pgid, "KILL");
    let code = exited.and_then(|(_, c)| c);
    // A resume that died without a word, for a session that never completed a
    // turn, means claude never persisted it (the old runner died first):
    // start the same uuid fresh and hand the delivered prompts back.
    if resume && closing.is_none() && !saw_output && !events_have_result(dir) {
        requeue_delivered(dir)?;
        job.claude_started = false;
        job.status = RunStatus::Running;
        save(dir, &mut job)?;
        runner_event(
            dir,
            "resume_fallback",
            json!({"reason": "session was never saved", "exit_code": code}),
        );
        return run_runner_locked(dir);
    }
    job.finished_at = Some(now_secs());
    job.status = match closing {
        Some((Closing::Stopped, _)) => RunStatus::Stopped,
        Some((Closing::Finished, _)) => RunStatus::Finished,
        None => RunStatus::Failed,
    };
    if closing.is_none() {
        job.last_subtype
            .get_or_insert_with(|| "claude_exited".to_string());
    }
    save(dir, &mut job)?;
    runner_event(
        dir,
        "exited",
        json!({"status": job.status, "exit_code": code}),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_is_one_stream_json_line() {
        let line = encode_user_message("hi \"there\"\nsecond");
        assert!(!line.contains('\n'));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"][0]["type"], "text");
        assert_eq!(v["message"]["content"][0]["text"], "hi \"there\"\nsecond");
    }

    #[test]
    fn a_start_whose_runner_cannot_spawn_leaves_a_failed_job_reconcile_skips() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let err = start_in_spawning(runs.path(), &opts("a", cwd.path()), None, |_| {
            Err(Error::Unavailable("no runner".into()))
        })
        .unwrap_err();
        assert!(matches!(err, Error::Unavailable(_)));
        let jobs = list_in(runs.path()).unwrap();
        assert_eq!(jobs.len(), 1);
        let dir = runs.path().join(jobs[0]["job_id"].as_str().unwrap());
        let job = load(&dir).unwrap();
        assert_eq!(job.status, RunStatus::Failed);
        assert!(job.finished_at.is_some());
        assert!(reconcile_in(runs.path()).unwrap().is_empty());
    }

    #[test]
    fn ended_in_reads_terminal_status_and_a_dead_runner() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let job = create_job(runs.path(), &opts("a", cwd.path())).unwrap();
        let dir = runs.path().join(&job.job_id);
        // Just spawned, no pid file yet: alive by grace, never ended.
        assert_eq!(ended_in(runs.path(), &job.job_id), None);
        // A runner pid that is not a live `__runner` (kill -9 left the status).
        fs::write(dir.join("runner.pid"), "2147483646").unwrap();
        assert_eq!(ended_in(runs.path(), &job.job_id).as_deref(), Some("died"));
        for (status, want) in [
            (RunStatus::Finished, "finished"),
            (RunStatus::Failed, "failed"),
            (RunStatus::Stopped, "stopped"),
        ] {
            let mut j = load(&dir).unwrap();
            j.status = status;
            save(&dir, &mut j).unwrap();
            assert_eq!(ended_in(runs.path(), &job.job_id).as_deref(), Some(want));
        }
        // Unknown or unreadable: not ended.
        assert_eq!(ended_in(runs.path(), "nosuchjob"), None);
    }

    #[test]
    fn panel_jobs_skip_a_terminal_run_older_than_the_linger() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let live = create_job(runs.path(), &opts("a", cwd.path())).unwrap();
        let fresh = create_job(runs.path(), &opts("b", cwd.path())).unwrap();
        let old = create_job(runs.path(), &opts("c", cwd.path())).unwrap();
        let now = now_secs();
        for (job, finished) in [(&fresh, now - 60), (&old, now - RUN_LINGER_SECS - 60)] {
            let dir = runs.path().join(&job.job_id);
            let mut j = load(&dir).unwrap();
            j.status = RunStatus::Finished;
            j.finished_at = Some(finished);
            save(&dir, &mut j).unwrap();
        }
        let ids: Vec<String> = panel_jobs_in(runs.path())
            .into_iter()
            .map(|(j, _)| j.job_id)
            .collect();
        assert!(ids.contains(&live.job_id));
        assert!(ids.contains(&fresh.job_id));
        assert!(!ids.contains(&old.job_id));
    }

    fn wait_opts(deadline_ms: u64, silence_ms: Option<u64>) -> WaitOpts {
        WaitOpts {
            deadline: Duration::from_millis(deadline_ms),
            silence: silence_ms.map(Duration::from_millis),
            poll: Duration::from_millis(10),
        }
    }

    fn wait_job(status: RunStatus) -> (tempfile::TempDir, tempfile::TempDir, Job, PathBuf) {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let job = create_job(runs.path(), &opts("a", cwd.path())).unwrap();
        let dir = runs.path().join(&job.job_id);
        // The first message is delivered by now, as a live runner would have.
        for f in pending_inbox(&dir.join("inbox")) {
            fs::remove_file(f).unwrap();
        }
        let mut j = load(&dir).unwrap();
        j.status = status;
        j.last_result = Some("done it".into());
        save(&dir, &mut j).unwrap();
        (runs, cwd, job, dir)
    }

    #[test]
    fn wait_returns_at_once_for_an_idle_or_ended_run_with_its_exit_code() {
        for (status, reason, exit) in [
            (RunStatus::Idle, "idle", 0),
            (RunStatus::Finished, "finished", 0),
            (RunStatus::Failed, "failed", 12),
            (RunStatus::Stopped, "stopped", 12),
        ] {
            let (runs, _cwd, job, _dir) = wait_job(status);
            let out = wait_in(runs.path(), &job.job_id, &wait_opts(5000, None)).unwrap();
            assert_eq!((out.reason, out.exit), (reason, exit));
            assert_eq!(out.value["reason"], reason);
            assert_eq!(out.value["job"]["last_result"], "done it");
            assert!(out.value["job"]["events"].is_array());
        }
    }

    #[test]
    fn wait_times_out_on_a_deadline_and_on_silence() {
        let (runs, _cwd, job, _dir) = wait_job(RunStatus::Running);
        let out = wait_in(runs.path(), &job.job_id, &wait_opts(150, None)).unwrap();
        assert_eq!((out.reason, out.exit), ("deadline", 11));
        let out = wait_in(runs.path(), &job.job_id, &wait_opts(5000, Some(150))).unwrap();
        assert_eq!((out.reason, out.exit), ("silent", 10));
    }

    #[test]
    fn wait_silence_clock_restarts_on_each_new_event_line() {
        let (runs, _cwd, job, dir) = wait_job(RunStatus::Running);
        let writer = std::thread::spawn(move || {
            for _ in 0..6 {
                std::thread::sleep(Duration::from_millis(60));
                append_event(&dir, r#"{"type":"assistant"}"#);
            }
        });
        let t = Instant::now();
        let out = wait_in(runs.path(), &job.job_id, &wait_opts(5000, Some(250))).unwrap();
        writer.join().unwrap();
        assert_eq!(out.reason, "silent");
        // 6 lines 60 ms apart then 250 ms of quiet: well past the silence limit alone.
        assert!(t.elapsed() >= Duration::from_millis(500));
    }

    #[test]
    fn wait_does_not_call_an_idle_run_done_while_a_message_is_pending() {
        let (runs, _cwd, job, dir) = wait_job(RunStatus::Idle);
        fs::write(dir.join("message-pending"), "").unwrap();
        let out = wait_in(runs.path(), &job.job_id, &wait_opts(150, None)).unwrap();
        assert_eq!(out.reason, "deadline");
        fs::remove_file(dir.join("message-pending")).unwrap();
        enqueue(&dir.join("inbox"), "next", false).unwrap();
        let out = wait_in(runs.path(), &job.job_id, &wait_opts(150, None)).unwrap();
        assert_eq!(out.reason, "deadline");
    }

    #[test]
    fn wait_sees_a_status_change_made_while_it_blocks_and_never_modifies_the_run() {
        let (runs, _cwd, job, dir) = wait_job(RunStatus::Running);
        let before = fs::read(dir.join("job.json")).unwrap();
        let d2 = dir.clone();
        let flipper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let mut j = load(&d2).unwrap();
            j.status = RunStatus::Idle;
            save(&d2, &mut j).unwrap();
        });
        let out = wait_in(runs.path(), &job.job_id, &wait_opts(5000, None)).unwrap();
        flipper.join().unwrap();
        assert_eq!(out.reason, "idle");
        assert_ne!(fs::read(dir.join("job.json")).unwrap(), before);
        assert!(!dir.join("interrupt").exists() && !dir.join("stop").exists());
    }

    #[test]
    fn wait_on_an_unknown_job_is_not_found() {
        let runs = tempfile::tempdir().unwrap();
        assert!(matches!(
            wait_in(runs.path(), "deadbeef", &wait_opts(100, None)),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn interrupt_request_is_one_stream_json_control_line() {
        let line = encode_interrupt("req-1");
        assert!(!line.contains('\n'));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "control_request");
        assert_eq!(v["request_id"], "req-1");
        assert_eq!(v["request"]["subtype"], "interrupt");
    }

    #[test]
    fn interrupt_marks_a_running_run_and_refuses_a_terminal_one() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let job = create_job(runs.path(), &opts("do it", cwd.path())).unwrap();
        let dir = runs.path().join(&job.job_id);
        interrupt_in(runs.path(), &job.job_id).unwrap();
        assert!(dir.join("interrupt").exists());
        let _ = fs::remove_file(dir.join("interrupt"));
        let mut idle = load(&dir).unwrap();
        idle.status = RunStatus::Idle;
        save(&dir, &mut idle).unwrap();
        interrupt_in(runs.path(), &job.job_id).unwrap();
        assert!(!dir.join("interrupt").exists());
        idle.status = RunStatus::Stopped;
        save(&dir, &mut idle).unwrap();
        assert!(matches!(
            interrupt_in(runs.path(), &job.job_id),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn uuid_is_v4_shaped() {
        let u = uuid_from_bytes([0xff; 16]);
        assert_eq!(u.len(), 36);
        let parts: Vec<&str> = u.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            [8, 4, 4, 4, 12]
        );
        assert!(parts[2].starts_with('4'));
        assert!(matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b'));
        let r = uuid_from_bytes(random_bytes::<16>().unwrap());
        assert_ne!(r, uuid_from_bytes(random_bytes::<16>().unwrap()));
    }

    #[test]
    fn job_ids_are_safe_path_parts() {
        assert!(is_valid_job_id("0a1b2c3d"));
        for bad in [
            "",
            "0A1B2C3D",
            "../etc/p",
            "0a1b2c3",
            "0a1b2c3dd",
            "0a1b2c3g",
        ] {
            assert!(!is_valid_job_id(bad), "{bad}");
        }
    }

    #[test]
    fn result_lines_are_recognised() {
        assert_eq!(
            parse_event(
                r#"{"type":"result","subtype":"success","is_error":false,"result":"pong"}"#
            ),
            Event::Result {
                text: Some("pong".into()),
                subtype: Some("success".into()),
                is_error: false
            }
        );
        match parse_event(r#"{"type":"result","subtype":"error_during_execution"}"#) {
            Event::Result { is_error, .. } => assert!(is_error),
            e => panic!("{e:?}"),
        }
        assert_eq!(parse_event(r#"{"type":"assistant"}"#), Event::Other);
        assert_eq!(parse_event("not json"), Event::Other);
    }

    #[test]
    fn turn_and_background_lines_are_classified() {
        assert_eq!(
            parse_event(r#"{"type":"system","subtype":"init","session_id":"s"}"#),
            Event::TurnStarted
        );
        assert_eq!(
            parse_event(
                r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a"},{"task_id":"b"}]}"#
            ),
            Event::BackgroundTasks(2)
        );
        assert_eq!(
            parse_event(r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#),
            Event::BackgroundTasks(0)
        );
        assert_eq!(
            parse_event(r#"{"type":"system","subtype":"background_tasks_changed"}"#),
            Event::Other
        );
        assert_eq!(
            parse_event(r#"{"type":"system","subtype":"task_progress"}"#),
            Event::Other
        );
        assert_eq!(parse_event(r#"{"subtype":"init"}"#), Event::Other);
    }

    /// naru task 1868: the marker is left by in-flight delivery only and
    /// cleared by the next main-thread assistant line or a result, not by a
    /// subagent's line.
    #[test]
    fn pending_marker_clears_on_main_thread_activity_only() {
        let dir = tempfile::tempdir().unwrap();
        let marker = pending_marker(dir.path());
        let clear = |line: &str| clear_pending_on(dir.path(), line, &parse_event(line));
        fs::write(&marker, b"").unwrap();
        clear(r#"{"type":"system","subtype":"task_progress","owned_by_subagent":true}"#);
        clear(r#"{"type":"assistant","parent_tool_use_id":"toolu_sub","message":{}}"#);
        assert!(marker.exists(), "subagent lines must keep the marker");
        clear(r#"{"type":"assistant","parent_tool_use_id":null,"message":{}}"#);
        assert!(!marker.exists(), "a main-thread assistant line clears it");
        fs::write(&marker, b"").unwrap();
        clear(r#"{"type":"result","subtype":"success","result":"x"}"#);
        assert!(!marker.exists(), "a result clears it");
    }

    #[test]
    fn subagent_init_is_not_a_main_turn() {
        let sub = r#"{"type":"system","subtype":"init","parent_tool_use_id":"toolu_sub"}"#;
        let sub2 = r#"{"type":"system","subtype":"init","owned_by_subagent":true}"#;
        let main = r#"{"type":"system","subtype":"init","parent_tool_use_id":null}"#;
        for l in [sub, sub2, main] {
            assert!(matches!(parse_event(l), Event::TurnStarted));
        }
        assert!(line_is_subagent(sub) && line_is_subagent(sub2));
        assert!(!line_is_subagent(main));
    }

    #[test]
    fn interrupt_flag_rides_in_the_inbox_file_and_plain_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("inbox");
        let plain = enqueue(&inbox, "hi", false).unwrap();
        let urgent = enqueue(&inbox, "now", true).unwrap();
        assert_eq!(
            fs::read_to_string(inbox.join(plain)).unwrap(),
            r#"{"text":"hi"}"#
        );
        assert_eq!(
            fs::read_to_string(inbox.join(urgent)).unwrap(),
            r#"{"interrupt":true,"text":"now"}"#
        );
    }

    #[test]
    fn enqueue_named_is_idempotent_across_inbox_and_delivered() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("inbox");
        assert!(enqueue_named(&inbox, "live-2-turn-1", "a").unwrap());
        assert!(!enqueue_named(&inbox, "live-2-turn-1", "a").unwrap());
        fs::create_dir_all(inbox.join("delivered")).unwrap();
        fs::rename(
            inbox.join("live-2-turn-1.json"),
            inbox.join("delivered").join("live-2-turn-1.json"),
        )
        .unwrap();
        assert!(!enqueue_named(&inbox, "live-2-turn-1", "a").unwrap());
        assert!(pending_inbox(&inbox).is_empty());
    }

    #[test]
    fn inbox_is_ordered_and_skips_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("inbox");
        let a = enqueue(&inbox, "first", false).unwrap();
        let b = enqueue(&inbox, "second", false).unwrap();
        let c = enqueue(&inbox, "third", false).unwrap();
        fs::write(inbox.join(".half.json.tmp"), "{").unwrap();
        fs::create_dir_all(inbox.join("delivered")).unwrap();
        let names: Vec<String> = pending_inbox(&inbox)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [a.clone(), b, c]);
        // A delivered file (moved out) is never listed again.
        fs::rename(inbox.join(&a), inbox.join("delivered").join(&a)).unwrap();
        assert_eq!(pending_inbox(&inbox).len(), 2);
    }

    fn opts(prompt: &str, cwd: &Path) -> StartOpts {
        StartOpts {
            model: "haiku".into(),
            prompt: prompt.into(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            name: None,
            agent: None,
            idle_timeout_secs: None,
        }
    }

    #[test]
    fn create_job_writes_the_files_and_validates() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let job = create_job(runs.path(), &opts("do it", cwd.path())).unwrap();
        assert!(is_valid_job_id(&job.job_id));
        assert_eq!(job.status, RunStatus::Running);
        assert_eq!(job.name, job.job_id);
        let dir = runs.path().join(&job.job_id);
        assert_eq!(load(&dir).unwrap().session_id, job.session_id);
        assert_eq!(pending_inbox(&dir.join("inbox")).len(), 1);
        for bad in [
            opts("  ", cwd.path()),
            StartOpts {
                model: " ".into(),
                ..opts("x", cwd.path())
            },
            opts("x", Path::new("/nonexistent-naru-dir")),
        ] {
            assert!(matches!(
                create_job(runs.path(), &bad),
                Err(Error::Validation(_))
            ));
        }
    }

    #[test]
    fn model_and_name_cannot_look_like_flags() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let bad_model = StartOpts {
            model: "--dangerously-skip-permissions".into(),
            ..opts("x", cwd.path())
        };
        let bad_name = StartOpts {
            name: Some(" -x".into()),
            ..opts("x", cwd.path())
        };
        let bad_agent = StartOpts {
            agent: Some("-x".into()),
            ..opts("x", cwd.path())
        };
        for bad in [bad_model, bad_name, bad_agent] {
            assert!(matches!(
                create_job(runs.path(), &bad),
                Err(Error::Validation(_))
            ));
        }
    }

    /// naru task 1861: the agent reaches claude's argv, is absent without one,
    /// and a resume (which reads it back from job.json) keeps it.
    #[test]
    fn agent_reaches_the_script_and_survives_a_resume() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let with = StartOpts {
            agent: Some("supervisor".into()),
            ..opts("x", cwd.path())
        };
        let job = create_job(runs.path(), &with).unwrap();
        let job = load(&runs.path().join(&job.job_id)).unwrap();
        assert_eq!(job.agent.as_deref(), Some("supervisor"));
        let p = crate::core::config::Prompts::default();
        for resume in [false, true] {
            let script = agents::runner_script(
                job.action(),
                &job.model,
                &job.name,
                &job.session_id,
                resume,
                job.agent.as_deref(),
                &p,
            )
            .unwrap();
            assert!(script.starts_with("run_agent='supervisor'\n"), "{script}");
        }
        let plain = create_job(runs.path(), &opts("x", cwd.path())).unwrap();
        assert_eq!(plain.agent, None);
        let script = agents::runner_script(
            plain.action(),
            &plain.model,
            &plain.name,
            &plain.session_id,
            false,
            None,
            &p,
        )
        .unwrap();
        assert!(script.starts_with("run_agent=''\n"), "{script}");
    }

    #[test]
    fn a_job_without_a_template_key_launches_the_runner_template() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let job = create_job(runs.path(), &opts("x", cwd.path())).unwrap();
        let dir = runs.path().join(&job.job_id);
        let raw = fs::read_to_string(dir.join("job.json")).unwrap();
        assert!(!raw.contains("template"), "{raw}");
        assert_eq!(load(&dir).unwrap().template, None);
        assert_eq!(load(&dir).unwrap().action(), config::RUNNER);
        // An old job.json (no key at all) reads the same way.
        let mut v: Value = serde_json::from_str(&raw).unwrap();
        v.as_object_mut().unwrap().remove("template");
        let old: Job = serde_json::from_value(v).unwrap();
        assert_eq!(old.action(), config::RUNNER);
    }

    #[test]
    fn a_template_in_job_json_selects_that_action_and_start_opts_cannot_carry_one() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let job = create_job_with(
            runs.path(),
            &opts("x", cwd.path()),
            Some(config::LIVE_AGENT),
        )
        .unwrap();
        let dir = runs.path().join(&job.job_id);
        assert_eq!(load(&dir).unwrap().action(), config::LIVE_AGENT);
        // The API/CLI body type ignores a template key.
        let body = json!({"model":"haiku","prompt":"x","template":"live-agent"});
        let parsed: StartOpts = serde_json::from_value(body).unwrap();
        let made = create_job(runs.path(), &parsed);
        assert!(made.is_ok_and(|j| j.template.is_none()));
    }

    #[test]
    fn runner_script_for_live_agent_uses_the_live_agent_template() {
        let p = crate::core::config::Prompts::default();
        let live =
            agents::runner_script(config::LIVE_AGENT, "default", "nm", "sid", false, None, &p)
                .unwrap();
        assert!(live.contains("--agent naru-live"), "{live}");
        assert!(live.contains("'nm'"), "{live}");
        let run =
            agents::runner_script(config::RUNNER, "default", "nm", "sid", false, None, &p).unwrap();
        assert!(run.contains("'--session-id' 'sid'"), "{run}");
    }

    #[test]
    fn send_queues_in_order_and_refuses_a_finished_run() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let job = create_job(runs.path(), &opts("one", cwd.path())).unwrap();
        send_in(runs.path(), &job.job_id, "two", false).unwrap();
        let inbox = runs.path().join(&job.job_id).join("inbox");
        let texts: Vec<String> = pending_inbox(&inbox)
            .iter()
            .map(|p| {
                let v: Value = serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap();
                v["text"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(texts, ["one", "two"]);
        assert!(matches!(
            send_in(runs.path(), &job.job_id, " ", false),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            send_in(runs.path(), "ffffffff", "x", false),
            Err(Error::NotFound(_))
        ));
        let dir = runs.path().join(&job.job_id);
        let mut j = load(&dir).unwrap();
        j.status = RunStatus::Finished;
        save(&dir, &mut j).unwrap();
        assert!(matches!(
            send_in(runs.path(), &job.job_id, "late", false),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn events_tail_and_show() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let job = create_job(runs.path(), &opts("p", cwd.path())).unwrap();
        let dir = runs.path().join(&job.job_id);
        append_event(&dir, r#"{"type":"a"}"#);
        append_event(&dir, "plain text");
        append_event(&dir, r#"{"type":"c"}"#);
        let v = show_in(runs.path(), &job.job_id, Some(2), false).unwrap();
        assert_eq!(v["events"].as_array().unwrap().len(), 2);
        assert_eq!(v["events"][0], "plain text");
        assert_eq!(v["job"]["job_id"], job.job_id);
        assert!(show_in(runs.path(), &job.job_id, None, false).unwrap()["events"].is_null());
        assert_eq!(list_in(runs.path()).unwrap().len(), 1);
    }

    #[test]
    fn events_main_scope_drops_subagent_lines() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let job = create_job(runs.path(), &opts("p", cwd.path())).unwrap();
        let dir = runs.path().join(&job.job_id);
        append_event(&dir, r#"{"type":"assistant","parent_tool_use_id":null}"#);
        append_event(
            &dir,
            r#"{"type":"assistant","parent_tool_use_id":"toolu_1"}"#,
        );
        append_event(&dir, r#"{"type":"system","owned_by_subagent":true}"#);
        append_event(&dir, r#"{"type":"naru_runner"}"#);
        append_event(&dir, "garbage");
        let id = &job.job_id;
        let main = show_in(runs.path(), id, Some(100), true).unwrap();
        assert_eq!(main["events"].as_array().unwrap().len(), 3);
        let all = show_in(runs.path(), id, Some(100), false).unwrap();
        assert_eq!(all["events"].as_array().unwrap().len(), 5);
        let last = show_in(runs.path(), id, Some(1), true).unwrap();
        assert_eq!(last["events"][0], "garbage");
        let two = show_in(runs.path(), id, Some(2), true).unwrap();
        assert_eq!(two["events"][0]["type"], "naru_runner");
    }
}
