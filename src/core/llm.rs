//! The workflow `prompt` node's model call (mesa task 1607): one blocking
//! HTTP request to a model API, **never a Claude Code process** — no agent is
//! spawned, no config template is involved, and no tool is ever offered. The
//! prompt goes in as a single user message and the model's text comes back.
//!
//! Two backends, picked by the node's `model`:
//!
//! * `haiku` | `sonnet` | `opus` — the Anthropic Messages API
//!   (`POST {base}/v1/messages`, `x-api-key` + `anthropic-version`). The key
//!   is read from `ANTHROPIC_API_KEY` and its absence is a failure naming the
//!   variable. The base is `https://api.anthropic.com` unless
//!   `NARU_ANTHROPIC_URL` (or `MESA_ANTHROPIC_URL`) says otherwise — also the
//!   test seam. Thinking on sends `thinking: {type: enabled, budget_tokens}`;
//!   off sends no `thinking` key. The answer is the concatenated `text`
//!   blocks, never the thinking blocks.
//! * `local:<name>` — the Ollama HTTP API (`POST {OLLAMA_HOST or
//!   http://127.0.0.1:11434}/api/chat`, `stream: false`), thinking as its
//!   `think` bool.
//!
//! **Transport is `curl`**, the posture `usage.rs` already takes for its
//! Anthropic call: Naru's `ureq` is built without a TLS stack, so it cannot
//! speak `https://api.anthropic.com`. The request is never put on argv — the
//! URL, the key header and the body travel as a curl config on **stdin**
//! (`-K -`), so neither the key nor the (untrusted) prompt is visible in `ps`
//! or parsed by a shell.

use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

/// Model alias → Anthropic model id. One table, so a new generation is one
/// edit. These are the ids Claude's current model list gives (Haiku 4.5,
/// Sonnet 5.5, Opus 5.5); they were not checked against `GET /v1/models`
/// from this environment (no key was available) — a wrong id is a clear
/// `not_found_error` from the API, surfaced as the node's failure.
pub const ANTHROPIC_MODELS: [(&str, &str); 3] = [
    ("haiku", "claude-haiku-4-5-20251001"),
    ("sonnet", "claude-sonnet-5-5"),
    ("opus", "claude-opus-5-5"),
];

const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_DEFAULT_URL: &str = "https://api.anthropic.com";
/// `max_tokens` when thinking is off, and when it is on (which must exceed
/// the thinking budget).
const MAX_TOKENS: u32 = 4096;
const MAX_TOKENS_THINKING: u32 = 8192;
const THINKING_BUDGET: u32 = 2048;
/// The answer is read whole; cap it so a runaway cannot balloon memory.
const ANSWER_CAP: usize = 4 * 1024 * 1024;

/// One model call: `prompt` as the one user message, answered with the
/// model's text. `Err` is a message fit for a node's `error`.
pub fn complete(
    model: &str,
    thinking: bool,
    prompt: &str,
    timeout: Duration,
) -> Result<String, String> {
    if let Some(name) = model.strip_prefix("local:") {
        return ollama(name, thinking, prompt, timeout);
    }
    let id = ANTHROPIC_MODELS
        .iter()
        .find(|(alias, _)| *alias == model)
        .map(|(_, id)| *id)
        .ok_or_else(|| format!("unknown model {model:?}"))?;
    anthropic(id, thinking, prompt, timeout)
}

fn anthropic(id: &str, thinking: bool, prompt: &str, timeout: Duration) -> Result<String, String> {
    let key = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| {
            "ANTHROPIC_API_KEY is not set; a prompt node on haiku, sonnet or opus calls the \
             Anthropic API directly and needs it in the environment of the process running \
             the workflow"
                .to_string()
        })?;
    let base = crate::core::env::var("ANTHROPIC_URL")
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| ANTHROPIC_DEFAULT_URL.to_string());
    let url = format!("{}/v1/messages", base.trim_end_matches('/'));
    let body = anthropic_body(id, thinking, prompt);
    let (status, text) = post_json(
        &url,
        &[
            ("x-api-key", key.trim()),
            ("anthropic-version", ANTHROPIC_VERSION),
        ],
        &body,
        timeout,
    )?;
    parse_anthropic(status, &text)
}

fn anthropic_body(id: &str, thinking: bool, prompt: &str) -> Value {
    let mut body = json!({
        "model": id,
        "max_tokens": if thinking { MAX_TOKENS_THINKING } else { MAX_TOKENS },
        "messages": [{"role": "user", "content": prompt}],
    });
    if thinking {
        body["thinking"] = json!({"type": "enabled", "budget_tokens": THINKING_BUDGET});
    }
    body
}

/// The concatenated `text` blocks of a Messages answer; thinking blocks are
/// dropped. A non-200 is the API's own `error.message`.
fn parse_anthropic(status: u16, body: &str) -> Result<String, String> {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if status != 200 {
        let message = parsed["error"]["message"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| truncate(body));
        return Err(format!(
            "the Anthropic API answered HTTP {status}: {message}"
        ));
    }
    let blocks = parsed["content"].as_array().ok_or_else(|| {
        format!(
            "the Anthropic API answered with no content: {}",
            truncate(body)
        )
    })?;
    Ok(blocks
        .iter()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<String>())
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
    let (status, text) = post_json(&url, &[], &body, timeout).map_err(|e| {
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
fn curl_config(url: &str, headers: &[(&str, &str)], body: &str, timeout: Duration) -> String {
    let mut cfg = String::new();
    cfg.push_str(&format!("url = {}\n", curl_quote(url)));
    cfg.push_str("request = \"POST\"\n");
    cfg.push_str("header = \"content-type: application/json\"\n");
    for (name, value) in headers {
        cfg.push_str(&format!(
            "header = {}\n",
            curl_quote(&format!("{name}: {value}"))
        ));
    }
    cfg.push_str(&format!("data-raw = {}\n", curl_quote(body)));
    cfg.push_str(&format!("max-time = {}\n", timeout.as_secs().max(1)));
    cfg.push_str("write-out = \"\\n%{http_code}\"\n");
    cfg
}

/// POSTs `body` as JSON and answers `(status, response body)`. A transport
/// failure (curl missing, connection refused, timeout) is `Err`; any HTTP
/// status is data for the caller.
fn post_json(
    url: &str,
    headers: &[(&str, &str)],
    body: &Value,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let cfg = curl_config(url, headers, &body.to_string(), timeout);
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
    fn the_request_body_carries_thinking_only_when_asked() {
        let off = anthropic_body("claude-haiku-4-5-20251001", false, "hi");
        assert!(off.get("thinking").is_none());
        assert_eq!(off["messages"][0]["role"], "user");
        assert_eq!(off["messages"][0]["content"], "hi");
        let on = anthropic_body("m", true, "hi");
        assert_eq!(on["thinking"]["type"], "enabled");
        assert!(on["max_tokens"].as_u64() > on["thinking"]["budget_tokens"].as_u64());
        assert!(off.get("tools").is_none() && on.get("tools").is_none());
    }

    #[test]
    fn the_answer_is_the_text_blocks_not_the_thinking_ones() {
        let body = r#"{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"a"},{"type":"text","text":"b"}]}"#;
        assert_eq!(parse_anthropic(200, body).unwrap(), "ab");
        let err = parse_anthropic(401, r#"{"error":{"message":"invalid x-api-key"}}"#).unwrap_err();
        assert!(err.contains("401") && err.contains("invalid x-api-key"));
        assert!(parse_anthropic(200, "{}").is_err());
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
            "http://h/v1",
            &[("x-api-key", "k")],
            "a \"q\" \\ $(x) `y`\nline\t",
            Duration::from_secs(9),
        );
        assert!(cfg.contains("header = \"x-api-key: k\"\n"));
        assert!(
            cfg.contains(r#"data-raw = "a \"q\" \\ $(x) `y`\nline\t""#),
            "{cfg}"
        );
        assert!(cfg.contains("max-time = 9\n"));
    }

    #[test]
    fn a_missing_key_names_the_variable() {
        // The env var is process-wide; only assert when it is genuinely unset.
        if std::env::var("ANTHROPIC_API_KEY").is_err() {
            let err = complete("haiku", false, "x", Duration::from_secs(1)).unwrap_err();
            assert!(err.contains("ANTHROPIC_API_KEY"), "{err}");
        }
        assert!(
            complete("gpt", false, "x", Duration::from_secs(1))
                .unwrap_err()
                .contains("unknown model")
        );
    }
}
