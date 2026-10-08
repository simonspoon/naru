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
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::store::{Error, Result};
use super::{agents, config, library, script_runs};

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
    Other,
}

pub fn parse_event(line: &str) -> Event {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Event::Other;
    };
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
pub fn enqueue(inbox: &Path, text: &str) -> Result<String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let rnd = random_bytes::<2>()?;
    let name = format!("{nanos:020}-{:02x}{:02x}.json", rnd[0], rnd[1]);
    fs::create_dir_all(inbox)?;
    atomic_write(
        &inbox.join(&name),
        json!({"text": text}).to_string().as_bytes(),
    )?;
    Ok(name)
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
        Some(pid) => script_runs::pid_is_live(pid),
        None => now_secs() - job.updated_at <= SPAWN_GRACE_SECS,
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

fn events_of(dir: &Path, tail: Option<usize>) -> Vec<Value> {
    let Ok(body) = fs::read(dir.join("events.jsonl")) else {
        return vec![];
    };
    let text = String::from_utf8_lossy(&body);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let from = tail.map_or(0, |n| lines.len().saturating_sub(n));
    lines[from..]
        .iter()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|_| Value::String((*l).to_string())))
        .collect()
}

// ---- the surface --------------------------------------------------------

/// Creates the job dir and its first inbox message; spawns nothing.
pub fn create_job(runs: &Path, opts: &StartOpts) -> Result<Job> {
    if opts.model.trim().is_empty() {
        return Err(Error::Validation("model must not be empty".into()));
    }
    if opts.prompt.trim().is_empty() {
        return Err(Error::Validation("prompt must not be empty".into()));
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
    };
    fs::create_dir_all(dir.join("inbox").join("delivered"))?;
    enqueue(&dir.join("inbox"), &opts.prompt)?;
    save(&dir, &mut job)?;
    Ok(job)
}

/// Starts the runner for `dir` fully detached: its own process group, no
/// stdio tied to us, never waited on by anything that matters (the reaping
/// thread only stops a long-lived server from keeping a zombie, which
/// `kill -0` would read as alive).
pub fn spawn_runner(dir: &Path) -> Result<()> {
    let exe = std::env::current_exe()?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("runner.log"))?;
    let child = Command::new(exe)
        .args(["run", "__runner"])
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
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
    let job = create_job(runs, opts)?;
    let dir = runs.join(&job.job_id);
    spawn_runner(&dir)?;
    Ok(view(&dir, &job))
}

pub fn send(id: &str, text: &str) -> Result<Value> {
    send_in(&runs_dir(), id, text)
}

pub fn send_in(runs: &Path, id: &str, text: &str) -> Result<Value> {
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
    enqueue(&dir.join("inbox"), text)?;
    Ok(view(&dir, &job))
}

pub fn show(id: &str, events: Option<usize>) -> Result<Value> {
    show_in(&runs_dir(), id, events)
}

/// The job, plus its last `events` events when asked for.
pub fn show_in(runs: &Path, id: &str, events: Option<usize>) -> Result<Value> {
    let dir = job_dir_of(runs, id)?;
    let job = load(&dir)?;
    let v = view(&dir, &job);
    Ok(match events {
        None => v,
        Some(n) => json!({"job": v, "events": events_of(&dir, Some(n))}),
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
            signal_group(pid, "KILL");
        }
        job.status = RunStatus::Stopped;
        job.finished_at = Some(now_secs());
        save(&dir, &mut job)?;
        runner_event(&dir, "stopped", json!({"by": "stop, runner already gone"}));
    }
    Ok(view(&dir, &job))
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
    events_of(dir, None)
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
    let _ = Command::new("kill")
        .args([&format!("-{sig}"), "--", &format!("-{pgid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
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
    let mut job = load(dir)?;
    atomic_write(
        &dir.join("runner.pid"),
        std::process::id().to_string().as_bytes(),
    )?;
    let resume = job.claude_started;
    let interrupted = resume && job.status == RunStatus::Running;
    if resume {
        // A claude from the dead runner may still be finishing its turn; two
        // processes on one session would race, so it goes first.
        if let Some(pid) = job.claude_pid {
            signal_group(pid, "TERM");
            std::thread::sleep(Duration::from_millis(300));
            signal_group(pid, "KILL");
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
    let script = agents::runner_script(&job.model, &job.name, &job.session_id, resume, &prompts)
        .map_err(Error::Unavailable);
    let spawned = script.and_then(|script| {
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("claude.log"))?;
        Command::new("bash")
            .arg("-c")
            .arg(script)
            .current_dir(&job.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .process_group(0)
            .spawn()
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

    let mut in_flight: u32 = 0;
    let mut last_activity = Instant::now();
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
        in_flight += 1;
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
                append_event(dir, line);
                if let Event::Result {
                    text,
                    subtype,
                    is_error,
                } = parse_event(line)
                {
                    in_flight = in_flight.saturating_sub(1);
                    last_activity = Instant::now();
                    job.last_result = text;
                    job.last_subtype = subtype;
                    job.last_is_error = Some(is_error);
                    if in_flight == 0 {
                        job.status = RunStatus::Idle;
                    }
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
        if closing.is_none() {
            for file in pending_inbox(&dir.join("inbox")) {
                let Some(text) = fs::read_to_string(&file)
                    .ok()
                    .and_then(|b| serde_json::from_str::<Value>(&b).ok())
                    .and_then(|v| v.get("text").and_then(Value::as_str).map(str::to_string))
                else {
                    // Unreadable: move it aside rather than retry it forever.
                    let _ = fs::rename(&file, file.with_extension("bad"));
                    continue;
                };
                // Out of the inbox first: a crash after this loses the message
                // rather than delivering it twice.
                let delivered = dir.join("inbox").join("delivered");
                let _ = fs::create_dir_all(&delivered);
                let name = file.file_name().unwrap_or_default().to_owned();
                if fs::rename(&file, delivered.join(&name)).is_err() {
                    continue;
                }
                if deliver(&mut stdin, &text) {
                    in_flight += 1;
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
            && in_flight == 0
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
        return run_runner(dir);
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
    fn inbox_is_ordered_and_skips_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("inbox");
        let a = enqueue(&inbox, "first").unwrap();
        let b = enqueue(&inbox, "second").unwrap();
        let c = enqueue(&inbox, "third").unwrap();
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
    fn send_queues_in_order_and_refuses_a_finished_run() {
        let runs = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let job = create_job(runs.path(), &opts("one", cwd.path())).unwrap();
        send_in(runs.path(), &job.job_id, "two").unwrap();
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
            send_in(runs.path(), &job.job_id, " "),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            send_in(runs.path(), "ffffffff", "x"),
            Err(Error::NotFound(_))
        ));
        let dir = runs.path().join(&job.job_id);
        let mut j = load(&dir).unwrap();
        j.status = RunStatus::Finished;
        save(&dir, &mut j).unwrap();
        assert!(matches!(
            send_in(runs.path(), &job.job_id, "late"),
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
        let v = show_in(runs.path(), &job.job_id, Some(2)).unwrap();
        assert_eq!(v["events"].as_array().unwrap().len(), 2);
        assert_eq!(v["events"][0], "plain text");
        assert_eq!(v["job"]["job_id"], job.job_id);
        assert!(show_in(runs.path(), &job.job_id, None).unwrap()["events"].is_null());
        assert_eq!(list_in(runs.path()).unwrap().len(), 1);
    }
}
