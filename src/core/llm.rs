//! The workflow `prompt` node's model call (mesa task 1607, reworked by naru
//! task 1687) — **no API key anywhere**. The prompt goes in as one user
//! message, no tool is ever offered, and the model's text comes back. Two
//! backends, picked by the node's `model`:
//!
//! * `haiku` | `sonnet` | `opus` — **one synchronous `claude -p
//!   --output-format json` call**, built through the same chokepoint every
//!   agent spawn is (`agents::workflow_prompt_script`: the `workflow-prompt`
//!   config template, `--tools "" --strict-mcp-config`), run to completion
//!   under the node's timeout, its stdout parsed as the result JSON. The
//!   answer is that JSON's `result`.
//! * `local:<name>` — the Ollama HTTP API (`POST {OLLAMA_HOST or
//!   http://127.0.0.1:11434}/api/chat`, `stream: false`, `think` mirroring the
//!   node's thinking flag). Plain HTTP over `curl` — the request travels as a
//!   curl config on stdin (`-K -`), so the prompt is never on argv or parsed
//!   by a shell.
//!
//! There is nothing to poll, stop or read back: the process exits with the
//! answer on stdout, and a timeout kills its whole process group. Nothing here
//! holds the store lock (the engine passes in what it read before calling).

use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

use crate::core::{agents, config};

/// The most prompt text an Anthropic-backed node sends. The prompt is one
/// argument of the spawn script, single-quoted — each `'` becomes `'\''`, so it
/// can grow fourfold — and Linux caps one argument at 128 KiB: 24 KiB x 4 plus
/// the template stays under it.
pub const AGENT_PROMPT_MAX: usize = 24 * 1024;
/// The answer is read whole; cap it so a runaway cannot balloon memory.
const ANSWER_CAP: usize = 4 * 1024 * 1024;

/// One model call: `prompt` as the one user message, answered with the
/// model's text. `name` is the session name the call carries, `cwd` where it
/// runs (a folder Claude Code trusts), `prompts` the library table the spawn
/// template resolves against. `Err` is a message fit for a node's `error`.
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
    let script = agents::workflow_prompt_script(name, model, thinking, prompt, prompts)?;
    run_claude(&script, cwd, timeout)
}

/// One structured-output call (naru task 1690): `action`'s template
/// (`live-summary` or `live-dream`) resolved with `schema` as `--json-schema`,
/// run to completion under `timeout`, answered with the result JSON's
/// `structured_output` object. As a fallback — a hand-written template
/// without `--json-schema` — a `result` text that is itself a JSON object is
/// accepted. The model has no tools: Naru applies what comes back.
#[allow(clippy::too_many_arguments)]
pub fn complete_structured(
    action: &str,
    id: Option<i64>,
    name: &str,
    prompt: &str,
    schema: &str,
    prompts: &config::Prompts,
    cwd: &str,
    timeout: Duration,
) -> Result<Value, String> {
    if prompt.len() > AGENT_PROMPT_MAX {
        return Err(format!(
            "the prompt is {} bytes, over the {AGENT_PROMPT_MAX}-byte limit (it travels as one \
             argument to the spawn)",
            prompt.len()
        ));
    }
    let script = agents::structured_script(action, id, name, prompt, schema, prompts)?;
    let mut cmd = Command::new("bash");
    cmd.arg("-c").arg(&script).current_dir(cwd);
    let out = agents::capture(cmd, None, timeout)?;
    if out.stdout.len() > ANSWER_CAP {
        return Err(format!(
            "claude's output is {} bytes, over the {ANSWER_CAP}-byte cap",
            out.stdout.len()
        ));
    }
    parse_structured(
        out.code,
        &String::from_utf8_lossy(&out.stdout),
        &String::from_utf8_lossy(&out.stderr),
    )
}

/// [`parse_envelope`] then the `structured_output` object (or, failing that,
/// a `result` that parses as a JSON object).
fn parse_structured(code: i32, stdout: &str, stderr: &str) -> Result<Value, String> {
    let parsed = parse_envelope(code, stdout, stderr)?;
    if parsed["structured_output"].is_object() {
        return Ok(parsed["structured_output"].clone());
    }
    if let Some(v) = parsed["result"]
        .as_str()
        .and_then(|r| serde_json::from_str::<Value>(r.trim()).ok())
        .filter(Value::is_object)
    {
        return Ok(v);
    }
    Err(format!(
        "claude's result JSON holds no structured_output object: {}",
        truncate(stdout)
    ))
}

/// Runs the resolved `workflow-prompt` script to completion and reads the
/// answer off its stdout.
fn run_claude(script: &str, cwd: &str, timeout: Duration) -> Result<String, String> {
    let mut cmd = Command::new("bash");
    cmd.arg("-c").arg(script).current_dir(cwd);
    let out = agents::capture(cmd, None, timeout)?;
    if out.stdout.len() > ANSWER_CAP {
        return Err(format!(
            "claude's output is {} bytes, over the {ANSWER_CAP}-byte cap",
            out.stdout.len()
        ));
    }
    parse_result(
        out.code,
        &String::from_utf8_lossy(&out.stdout),
        &String::from_utf8_lossy(&out.stderr),
    )
}

/// `claude -p --output-format json`'s result object: `{"type":"result",
/// "subtype":"success","is_error":false,"result":"<text>",…}` (checked against
/// the real CLI). Anything else — a nonzero exit, output that is not that
/// object, `is_error`, a non-`success` subtype, no `result` text — is an error
/// naming what went wrong, with the stderr tail where there is one.
fn parse_result(code: i32, stdout: &str, stderr: &str) -> Result<String, String> {
    let parsed = parse_envelope(code, stdout, stderr)?;
    parsed["result"]
        .as_str()
        .map(str::to_string)
        .filter(|a| !a.trim().is_empty())
        .ok_or_else(|| format!("claude's result JSON holds no answer: {}", truncate(stdout)))
}

/// The checks every result object owes before its payload is read: a zero
/// exit, a JSON object, no `is_error`, subtype `success` (so
/// `error_max_turns` and `error_max_structured_output_retries` are named).
fn parse_envelope(code: i32, stdout: &str, stderr: &str) -> Result<Value, String> {
    let tail = |s: &str| {
        let s = s.trim();
        let start = s.len().saturating_sub(300);
        let start = (start..=s.len())
            .find(|i| s.is_char_boundary(*i))
            .unwrap_or(s.len());
        s[start..].to_string()
    };
    let parsed: Value = serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
    if code != 0 {
        let why = parsed["result"].as_str().map_or_else(|| tail(stderr), tail);
        return Err(format!("claude exited {code}: {why}"));
    }
    if !parsed.is_object() {
        return Err(format!(
            "claude printed no result JSON: {}{}",
            truncate(stdout),
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(" (stderr: {})", tail(stderr))
            }
        ));
    }
    let subtype = parsed["subtype"].as_str().unwrap_or("unknown");
    if parsed["is_error"].as_bool() == Some(true) || subtype != "success" {
        let detail = parsed["result"].as_str().unwrap_or_default();
        return Err(format!(
            "claude reported an error (subtype {subtype}): {}{}",
            truncate(detail),
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(" (stderr: {})", tail(stderr))
            }
        ));
    }
    Ok(parsed)
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

    const OK: &str = r#"{"type":"result","subtype":"success","is_error":false,"result":"ok"}"#;

    #[test]
    fn a_success_result_is_the_answer() {
        assert_eq!(parse_result(0, OK, "").unwrap(), "ok");
        assert_eq!(parse_result(0, &format!("{OK}\n"), "warn").unwrap(), "ok");
    }

    #[test]
    fn an_error_result_is_named() {
        let err = parse_result(
            0,
            r#"{"type":"result","subtype":"success","is_error":true,"result":"rate limited"}"#,
            "",
        )
        .unwrap_err();
        assert!(
            err.contains("rate limited") && err.contains("error"),
            "{err}"
        );
        let err = parse_result(
            0,
            r#"{"type":"result","subtype":"error_max_turns","is_error":false}"#,
            "oops",
        )
        .unwrap_err();
        assert!(
            err.contains("error_max_turns") && err.contains("oops"),
            "{err}"
        );
        let err = parse_result(0, r#"{"subtype":"success","result":" "}"#, "").unwrap_err();
        assert!(err.contains("no answer"), "{err}");
    }

    #[test]
    fn a_structured_result_is_the_object() {
        let ok = r#"{"type":"result","subtype":"success","is_error":false,"result":"{\"a\":\"hi\"}","structured_output":{"a":"hi"}}"#;
        assert_eq!(parse_structured(0, ok, "").unwrap()["a"], "hi");
        // No structured_output: a `result` that is itself an object is taken.
        let text = r#"{"type":"result","subtype":"success","is_error":false,"result":"{\"b\":1}"}"#;
        assert_eq!(parse_structured(0, text, "").unwrap()["b"], 1);
        // Neither: an error naming the missing object.
        let err = parse_structured(0, OK, "").unwrap_err();
        assert!(err.contains("no structured_output"), "{err}");
        let err = parse_structured(
            0,
            r#"{"type":"result","subtype":"error_max_structured_output_retries","is_error":true}"#,
            "",
        )
        .unwrap_err();
        assert!(err.contains("error_max_structured_output_retries"), "{err}");
    }

    #[test]
    fn garbage_and_nonzero_exits_fail_with_the_stderr_tail() {
        let err = parse_result(0, "not json at all", "").unwrap_err();
        assert!(
            err.contains("no result JSON") && err.contains("not json"),
            "{err}"
        );
        let err = parse_result(1, "", "claude: not logged in").unwrap_err();
        assert!(
            err.contains("exited 1") && err.contains("not logged in"),
            "{err}"
        );
        // Even a well-formed success body does not rescue a nonzero exit.
        assert!(parse_result(2, OK, "").is_err());
    }

    /// The real run path against stub scripts: stdout parsed, a nonzero exit
    /// and garbage failed, a hang killed at the timeout.
    #[test]
    fn run_claude_runs_the_script_and_enforces_the_timeout() {
        let secs = Duration::from_secs(10);
        let ok = format!("printf '%s' '{OK}'");
        assert_eq!(run_claude(&ok, ".", secs).unwrap(), "ok");
        let err = run_claude("echo boom >&2; exit 3", ".", secs).unwrap_err();
        assert!(err.contains("exited 3") && err.contains("boom"), "{err}");
        let err = run_claude("echo garbage", ".", secs).unwrap_err();
        assert!(err.contains("no result JSON"), "{err}");
        let err = run_claude("sleep 30", ".", Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
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
