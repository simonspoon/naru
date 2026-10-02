//! The workflow `prompt` node's model call (mesa task 1607) — **never print
//! mode (`-p`), and no API key anywhere**. The prompt goes in as one user message, no
//! tool is ever offered, and the model's text comes back. Two backends, picked
//! by the node's `model`:
//!
//! * `haiku` | `sonnet` | `opus` — a **background agent**, spawned through the
//!   same chokepoint every other agent is (`agents::spawn_workflow_prompt`:
//!   the `workflow-prompt` config template, `claude --bg …`, `--tools ""
//!   --strict-mcp-config`), waited on, read back, and stopped.
//! * `local:<name>` — the Ollama HTTP API (`POST {OLLAMA_HOST or
//!   http://127.0.0.1:11434}/api/chat`, `stream: false`, `think` mirroring the
//!   node's thinking flag). Plain HTTP over `curl` — the request travels as a
//!   curl config on stdin (`-K -`), so the prompt is never on argv or parsed
//!   by a shell.
//!
//! **How the answer comes back from a background agent.** Deterministically,
//! with no agent deciding anything: [`wait_for_answer`] polls
//! `claude agents --json --all` ([`agents::job_state`]) every half second
//! until the job's `state` is `done` — a job that has answered its one prompt
//! goes `done` by itself (checked against the real CLI) — then reads that
//! row's `sessionId`'s transcript with `cc::session_chat`, the reader the
//! Agents chat pane uses, and takes the assistant prose after the last prompt.
//! The alternative — telling the agent to deliver its answer with a
//! `naru workflow …` command — was rejected: it needs the Bash tool this
//! node must not have (its input is untrusted upstream text), and it makes the
//! engine's progress depend on a model obeying an instruction. The transcript
//! is Claude Code's own record of what the session said, whatever it was told.
//!
//! The job is **stopped on every outcome** — answer, failure or timeout — so a
//! run never leaves an idle background session behind, and nothing here holds
//! the store lock (the engine passes in what it read before calling).

use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::core::types::{CcChatTurn, CcChatTurnKind};
use crate::core::{agents, cc, config};

/// How often a running agent's state is asked for.
const POLL: Duration = Duration::from_millis(500);
/// How long a just-spawned job may be missing from `claude agents` before the
/// node gives up on it (it registers a moment after the receipt prints).
const REGISTER_GRACE: Duration = Duration::from_secs(30);
/// How long after `done` the transcript may take to hold the answer.
const FLUSH_WINDOW: Duration = Duration::from_secs(5);
/// The gap between the two reads that must agree.
const STABLE_GAP: Duration = Duration::from_millis(250);
/// Consecutive failed `claude agents` probes tolerated before the node fails.
const PROBE_ERRORS_TOLERATED: u32 = 3;
/// The most prompt text an agent-backed node sends. The prompt is one argument
/// of the spawn script, single-quoted — each `'` becomes `'\''`, so it can grow
/// fourfold — and Linux caps one argument at 128 KiB: 24 KiB x 4 plus the
/// template stays under it.
pub const AGENT_PROMPT_MAX: usize = 24 * 1024;
/// The answer is read whole; cap it so a runaway cannot balloon memory.
const ANSWER_CAP: usize = 4 * 1024 * 1024;

/// One model call: `prompt` as the one user message, answered with the
/// model's text. `name` is the session name an agent run carries, `cwd` where
/// it starts (a folder Claude Code trusts), `prompts` the library table the
/// spawn template resolves against. `Err` is a message fit for a node's
/// `error`.
pub fn complete(
    model: &str,
    thinking: bool,
    name: &str,
    prompt: &str,
    prompts: &config::Prompts,
    cwd: &str,
    timeout: Duration,
) -> Result<String, String> {
    if let Some(local) = model.strip_prefix("local:") {
        return ollama(local, thinking, prompt, timeout);
    }
    if !["haiku", "sonnet", "opus"].contains(&model) {
        return Err(format!("unknown model {model:?}"));
    }
    if prompt.len() > AGENT_PROMPT_MAX {
        return Err(format!(
            "the prompt and its input are {} bytes, over the {AGENT_PROMPT_MAX}-byte limit for a \
             prompt node on an Anthropic model (it travels as one argument to the spawn, and \
             quoting can grow it fourfold against the OS's single-argument limit); shorten \
             the input upstream",
            prompt.len()
        ));
    }
    let started = Instant::now();
    let job = agents::spawn_workflow_prompt(cwd, name, model, thinking, prompt, prompts)?
        .ok_or_else(|| {
            "the workflow-prompt command printed no `backgrounded · <id>` receipt, so there is \
             no job to wait on or stop"
                .to_string()
        })?;
    // On every outcome — answer, failure, timeout, even a panic below — the
    // job is stopped, exactly once: an idle background session left behind per
    // node would pile up. A stop that fails changes nothing about the answer.
    let _stop = OnDrop(Some(|| {
        if let Err(e) = agents::stop(&job) {
            eprintln!("workflow: could not stop agent {job}: {e}");
        }
    }));
    wait_for_answer(
        &job,
        started,
        timeout,
        agents::job_state,
        |session| {
            cc::session_chat(session, 500)
                .ok()
                .and_then(|chat| answer_of(&chat.turns))
        },
        &Timing::REAL,
    )
}

/// Runs its closure once when dropped — on a normal return and on unwind alike.
struct OnDrop<F: FnMut()>(Option<F>);

impl<F: FnMut()> Drop for OnDrop<F> {
    fn drop(&mut self) {
        if let Some(mut f) = self.0.take() {
            f();
        }
    }
}

/// The waits [`wait_for_answer`] makes, a value so a test can run them in
/// milliseconds.
struct Timing {
    /// Between two probes of a running job.
    poll: Duration,
    /// How long a just-spawned job may be missing from `claude agents`.
    register_grace: Duration,
    /// How long, **from the moment the job is first seen `done`**, the
    /// transcript may take to hold a settled answer.
    flush_window: Duration,
    /// The gap between the two reads that must agree before an answer counts.
    stable_gap: Duration,
}

impl Timing {
    const REAL: Timing = Timing {
        poll: POLL,
        register_grace: REGISTER_GRACE,
        flush_window: FLUSH_WINDOW,
        stable_gap: STABLE_GAP,
    };
}

type JobProbe = Result<Option<(String, Option<String>)>, String>;

/// Polls `job` until it is `done`, then reads its answer off the transcript.
/// `Err` on a `failed`/`stopped` job, a job that never registers, more than
/// [`PROBE_ERRORS_TOLERATED`] probe errors in a row, an answer that never
/// settles, or `timeout` (counted from `started`).
///
/// Two traps this avoids: the transcript can lag the `done` row, so its retry
/// window starts when `done` is **first seen** (not at the spawn — a slow job
/// would otherwise arrive with the window already spent); and a read can land
/// mid-flush, so an answer counts only when **two reads a short gap apart
/// agree**.
fn wait_for_answer(
    job: &str,
    started: Instant,
    timeout: Duration,
    mut probe: impl FnMut(&str) -> JobProbe,
    mut read: impl FnMut(&str) -> Option<String>,
    timing: &Timing,
) -> Result<String, String> {
    let timed_out = || {
        format!(
            "timed out after {}s waiting for the agent",
            timeout.as_secs()
        )
    };
    let mut probe_errors = 0;
    let session = loop {
        if started.elapsed() >= timeout {
            return Err(timed_out());
        }
        match probe(job) {
            Err(e) => {
                probe_errors += 1;
                if probe_errors > PROBE_ERRORS_TOLERATED {
                    return Err(format!(
                        "could not ask `claude agents` about {job} ({probe_errors} failures in a \
                         row): {e}"
                    ));
                }
                std::thread::sleep(timing.poll);
            }
            Ok(None) if started.elapsed() > timing.register_grace => {
                return Err(format!("the agent {job} never appeared in `claude agents`"));
            }
            Ok(Some((state, session))) if state == "done" => {
                break session.ok_or_else(|| format!("the agent {job} reported no session id"))?;
            }
            Ok(Some((state, _))) if state == "failed" || state == "stopped" => {
                return Err(format!("the agent {job} ended `{state}` without answering"));
            }
            Ok(_) => {
                probe_errors = 0;
                std::thread::sleep(timing.poll);
            }
        }
    };
    let flush_deadline = Instant::now() + timing.flush_window;
    let mut previous: Option<String> = None;
    loop {
        let current = read(&session);
        if let Some(answer) = current.as_ref().filter(|a| previous.as_ref() == Some(*a)) {
            return Ok(answer.clone());
        }
        std::thread::sleep(if current.is_some() {
            timing.stable_gap
        } else {
            timing.poll
        });
        previous = current;
        if started.elapsed() >= timeout {
            return Err(timed_out());
        }
        if Instant::now() >= flush_deadline {
            return Err(format!(
                "the agent {job} finished but its transcript holds no settled answer"
            ));
        }
    }
}

/// The assistant prose after the last prompt, joined — what the session said in
/// reply to the one prompt it was given. Tool turns are skipped (there are none
/// to see with `--tools ""`); `None` when nothing was said.
fn answer_of(turns: &[CcChatTurn]) -> Option<String> {
    let after = turns
        .iter()
        .rposition(|t| t.kind == CcChatTurnKind::Prompt)
        .map_or(0, |i| i + 1);
    let said: Vec<&str> = turns[after..]
        .iter()
        .filter(|t| t.kind == CcChatTurnKind::Response)
        .map(|t| t.text.as_str())
        .collect();
    let answer = said.join("\n");
    (!answer.trim().is_empty()).then_some(answer)
}

fn ollama(name: &str, thinking: bool, prompt: &str, timeout: Duration) -> Result<String, String> {
    let base = ollama_base(std::env::var("OLLAMA_HOST").ok().as_deref());
    let url = format!("{base}/api/chat");
    let body = json!({
        "model": name,
        "messages": [{"role": "user", "content": prompt}],
        "stream": false,
        "think": thinking,
    });
    let (status, text) = post_json(&url, &body, timeout).map_err(|e| {
        format!("could not reach Ollama at {base} (is it running? `ollama serve`): {e}")
    })?;
    parse_ollama(status, &text)
}

fn parse_ollama(status: u16, body: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if status != 200 {
        let message = parsed["error"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| truncate(body));
        return Err(format!("Ollama answered HTTP {status}: {message}"));
    }
    parsed["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "Ollama answered with no message content: {}",
                truncate(body)
            )
        })
}

/// `OLLAMA_HOST` as Ollama itself reads it: absent is `127.0.0.1:11434`; a
/// bare `host` or `host:port` gets `http://` (and the default port when it
/// names none); a value with a scheme is used as given, minus a trailing `/`.
fn ollama_base(host: Option<&str>) -> String {
    let host = host.map(str::trim).filter(|h| !h.is_empty());
    let Some(host) = host else {
        return "http://127.0.0.1:11434".to_string();
    };
    if host.contains("://") {
        return host.trim_end_matches('/').to_string();
    }
    let host = host.trim_end_matches('/');
    // `[::1]` or `name` with no port after the last colon outside brackets.
    let has_port = host.rsplit_once(':').is_some_and(|(head, port)| {
        !head.is_empty()
            && port.chars().all(|c| c.is_ascii_digit())
            && !port.is_empty()
            && !head.ends_with(':')
            || host.starts_with('[') && host.contains("]:")
    });
    if has_port {
        format!("http://{host}")
    } else {
        format!("http://{host}:11434")
    }
}

fn truncate(s: &str) -> String {
    let s = s.trim();
    match s.char_indices().nth(300) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// One curl config string value: `\`, `"` and the control characters curl's
/// config parser reads escapes for.
fn curl_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The curl config that makes the request: nothing here is ever on argv.
fn curl_config(url: &str, body: &str, timeout: Duration) -> String {
    let mut cfg = String::new();
    cfg.push_str(&format!("url = {}\n", curl_quote(url)));
    cfg.push_str("request = \"POST\"\n");
    cfg.push_str("header = \"content-type: application/json\"\n");
    cfg.push_str(&format!("data-raw = {}\n", curl_quote(body)));
    cfg.push_str(&format!("max-time = {}\n", timeout.as_secs().max(1)));
    cfg.push_str("write-out = \"\\n%{http_code}\"\n");
    cfg
}

/// POSTs `body` as JSON and answers `(status, response body)`. A transport
/// failure (curl missing, connection refused, timeout) is `Err`; any HTTP
/// status is data for the caller.
fn post_json(url: &str, body: &Value, timeout: Duration) -> Result<(u16, String), String> {
    let cfg = curl_config(url, &body.to_string(), timeout);
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "-K", "-"]);
    let out = crate::core::agents::capture(
        cmd,
        Some(cfg.into_bytes()),
        timeout + Duration::from_secs(5),
    )
    .map_err(|e| format!("could not run curl: {e}"))?;
    if out.code != 0 {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(match out.code {
            28 => format!("timed out after {}s", timeout.as_secs()),
            _ => format!("curl failed ({}): {}", out.code, stderr.trim()),
        });
    }
    let mut text =
        String::from_utf8_lossy(&out.stdout[..out.stdout.len().min(ANSWER_CAP)]).into_owned();
    let nl = text
        .rfind('\n')
        .ok_or_else(|| "curl printed no status".to_string())?;
    let status: u16 = text[nl + 1..]
        .trim()
        .parse()
        .map_err(|_| "curl printed no status".to_string())?;
    text.truncate(nl);
    Ok((status, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(kind: CcChatTurnKind, text: &str) -> CcChatTurn {
        CcChatTurn {
            id: "x".into(),
            kind,
            ts: None,
            model: None,
            name: None,
            text: text.into(),
        }
    }

    #[test]
    fn the_answer_is_the_prose_after_the_last_prompt() {
        use CcChatTurnKind::*;
        let turns = [
            turn(Prompt, "first"),
            turn(Response, "old"),
            turn(Prompt, "the prompt"),
            turn(Tool, "ls"),
            turn(Response, "idea:"),
            turn(Response, "buy milk"),
        ];
        assert_eq!(answer_of(&turns).as_deref(), Some("idea:\nbuy milk"));
        assert_eq!(answer_of(&turns[..3]), None, "a prompt nobody answered");
        assert_eq!(answer_of(&[turn(Response, "  ")]), None);
    }

    #[test]
    fn ollama_answers_parse() {
        assert_eq!(
            parse_ollama(200, r#"{"message":{"content":"yo","thinking":"t"}}"#).unwrap(),
            "yo"
        );
        assert!(
            parse_ollama(404, r#"{"error":"model not found"}"#)
                .unwrap_err()
                .contains("model not found")
        );
    }

    #[test]
    fn ollama_host_is_read_with_or_without_a_scheme() {
        assert_eq!(ollama_base(None), "http://127.0.0.1:11434");
        assert_eq!(ollama_base(Some("  ")), "http://127.0.0.1:11434");
        assert_eq!(ollama_base(Some("gpu-box")), "http://gpu-box:11434");
        assert_eq!(ollama_base(Some("gpu-box:9000")), "http://gpu-box:9000");
        assert_eq!(
            ollama_base(Some("http://10.0.0.5:1234/")),
            "http://10.0.0.5:1234"
        );
        assert_eq!(
            ollama_base(Some("https://ollama.example")),
            "https://ollama.example"
        );
        assert_eq!(ollama_base(Some("[::1]:11434")), "http://[::1]:11434");
    }

    #[test]
    fn the_curl_config_quotes_what_a_prompt_can_hold() {
        let cfg = curl_config(
            "http://h/api",
            "a \"q\" \\ $(x) `y`\nline\t",
            Duration::from_secs(9),
        );
        assert!(
            cfg.contains(r#"data-raw = "a \"q\" \\ $(x) `y`\nline\t""#),
            "{cfg}"
        );
        assert!(cfg.contains("max-time = 9\n"));
    }

    fn fast() -> Timing {
        Timing {
            poll: Duration::from_millis(5),
            register_grace: Duration::from_millis(40),
            flush_window: Duration::from_millis(300),
            stable_gap: Duration::from_millis(10),
        }
    }

    fn done() -> JobProbe {
        Ok(Some(("done".into(), Some("sess".into()))))
    }

    /// A job slower than the register grace still gets its whole flush
    /// window once `done` shows up (the window is not measured from the
    /// spawn), and the answer arriving late is found.
    #[test]
    fn a_slow_job_still_gets_a_fresh_flush_window() {
        let t0 = Instant::now();
        let mut reads = 0;
        let out = wait_for_answer(
            "j",
            t0,
            Duration::from_secs(5),
            |_| {
                if t0.elapsed() < Duration::from_millis(80) {
                    Ok(Some(("working".into(), None)))
                } else {
                    done()
                }
            },
            |_| {
                reads += 1;
                (reads > 6).then(|| "late answer".to_string())
            },
            &fast(),
        );
        assert_eq!(out.unwrap(), "late answer");
    }

    /// A reply caught mid-flush is not returned: two reads must agree.
    #[test]
    fn a_partial_reply_is_not_the_answer() {
        let mut seen = vec!["par", "partial reply", "partial reply"].into_iter();
        let out = wait_for_answer(
            "j",
            Instant::now(),
            Duration::from_secs(5),
            |_| done(),
            |_| seen.next().map(str::to_string),
            &fast(),
        );
        assert_eq!(out.unwrap(), "partial reply");
        // One that never settles fails clearly instead of returning a fragment.
        let mut n = 0;
        let err = wait_for_answer(
            "j",
            Instant::now(),
            Duration::from_secs(5),
            |_| done(),
            |_| {
                n += 1;
                Some("x".repeat(n))
            },
            &fast(),
        )
        .unwrap_err();
        assert!(err.contains("no settled answer"), "{err}");
    }

    #[test]
    fn a_few_failed_probes_are_tolerated_but_not_many() {
        let mut calls = 0;
        let out = wait_for_answer(
            "j",
            Instant::now(),
            Duration::from_secs(5),
            |_| {
                calls += 1;
                if calls <= PROBE_ERRORS_TOLERATED {
                    Err("claude agents failed".into())
                } else {
                    done()
                }
            },
            |_| Some("ok".into()),
            &fast(),
        );
        assert_eq!(out.unwrap(), "ok");
        let err = wait_for_answer(
            "j",
            Instant::now(),
            Duration::from_secs(5),
            |_| Err("down".into()),
            |_| None,
            &fast(),
        )
        .unwrap_err();
        assert!(
            err.contains("failures in a row") && err.contains("down"),
            "{err}"
        );
    }

    /// The stop guard runs once on a normal drop and once on a panic's unwind.
    #[test]
    fn the_stop_guard_runs_exactly_once_even_on_a_panic() {
        use std::cell::Cell;
        let stops = Cell::new(0);
        {
            let _g = OnDrop(Some(|| stops.set(stops.get() + 1)));
        }
        assert_eq!(stops.get(), 1);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = OnDrop(Some(|| stops.set(stops.get() + 1)));
            panic!("boom");
        }));
        assert!(caught.is_err());
        assert_eq!(stops.get(), 2);
    }

    /// An oversized prompt fails before anything is spawned: a model that
    /// would spawn through a missing `claude` would say so instead.
    #[test]
    fn an_oversized_prompt_is_refused_before_any_spawn() {
        let big = "x".repeat(AGENT_PROMPT_MAX + 1);
        let err = complete(
            "haiku",
            false,
            "n",
            &big,
            &config::Prompts::default(),
            ".",
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(
            err.contains("byte limit") && err.contains("shorten"),
            "{err}"
        );
    }

    #[test]
    fn an_unknown_model_is_refused_before_anything_runs() {
        let err = complete(
            "gpt",
            false,
            "n",
            "p",
            &config::Prompts::default(),
            ".",
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(err.contains("unknown model"), "{err}");
    }
}
