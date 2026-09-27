//! The client side of the `naru-audio` daemon (mesa task 1388): how Naru
//! finds it, asks whether it is ready, and says so loudly when it is not.
//!
//! `naru-audio` is a local HTTP service launchd starts — never Naru. Naru
//! only ever **asks**: `GET {url}/health` with a 500 ms timeout
//! ([`probe`]), classified into one of five [`AudioState`]s, each with the
//! sentence the page shows the person. The answer is cached with a **TTL**
//! rather than for the life of the process: 10 s while `ready`, 2 s for
//! anything else, so a daemon that goes down is noticed within one ready TTL
//! and one that comes back within two seconds, with no restart. There is no
//! `OnceLock` anywhere on this path; [`TtlCache`] is also what
//! `listen::models()` and `speech::voices()` cache their subprocess answers
//! in.
//!
//! Every **change** of state — not every probe — is logged to stderr in the
//! `warn audio state ready -> daemon_down url=…` shape, so a background
//! service's log shows the moment speech broke.
//!
//! When Live opens on this engine Naru also asks the daemon to **load** its
//! speech-to-text model ([`load_stt`], mesa task 1392), so the first
//! utterance does not pay the cold load. A load that fails is news about the
//! daemon, so it is written into the probe cache ([`Prober::record`]) rather
//! than waiting out a ten-second-old `ready`; a load that succeeds writes
//! nothing.
//!
//! The HTTP client is `ureq` with no default features: plain HTTP to a
//! loopback daemon, no TLS, no proxy, no redirects. It is blocking, so every
//! caller on an async worker goes through `spawn_blocking`.

use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where the daemon listens when neither the config nor `NARU_AUDIO_URL`
/// says otherwise (`naru-audio serve`'s own default bind).
pub const DEFAULT_URL: &str = "http://127.0.0.1:7870";

/// How long `GET /health` may take before the daemon counts as down. It
/// answers from an in-memory snapshot within milliseconds even mid-decode,
/// so anything slower is a daemon that is not really there.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// How long `POST /api/load` may take. The daemon answers only once the
/// model is resident — about 4 s cold for the default model — so this is
/// sized for a slow disk and a large model, not for a health check. Nothing
/// waits on it but a detached warm-up (or a short-lived `naru live start`).
const LOAD_TIMEOUT: Duration = Duration::from_secs(60);

/// `POST /api/load`'s body: the daemon's default speech-to-text model.
const LOAD_BODY: &str = r#"{"model":"default","kind":"stt"}"#;

/// How long a `ready` answer is trusted before the daemon is asked again.
pub const READY_TTL: Duration = Duration::from_secs(10);

/// How long any other answer (a failure, an empty list) is trusted — short,
/// so a daemon that comes back is noticed quickly.
pub const FAILURE_TTL: Duration = Duration::from_secs(2);

/// The most of `/health`'s body Naru reads. The real answer is a few hundred
/// bytes; this bounds what a wrong service on the port can make Naru hold.
const HEALTH_BODY_CAP: u64 = 64 * 1024;

/// The one API version this Naru speaks.
const API_VERSION: i64 = 1;

/// Which engine Naru's **server** runs speech through (`audio.engine`,
/// `docs/config.md`). `legacy` is the external `auris`/`kokoro-rs` binaries;
/// `naru-audio` is the daemon. Neither is ever a fallback for the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioEngine {
    Legacy,
    NaruAudio,
}

impl AudioEngine {
    pub fn parse(value: &str) -> Option<AudioEngine> {
        match value {
            "legacy" => Some(AudioEngine::Legacy),
            "naru-audio" => Some(AudioEngine::NaruAudio),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AudioEngine::Legacy => "legacy",
            AudioEngine::NaruAudio => "naru-audio",
        }
    }
}

/// What the probe found (design §4.4). Serialized snake_case — the exact
/// strings `GET /api/live/transcribe` answers with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../frontend/src/types/")]
pub enum AudioState {
    /// Health ok, API 1, and the speech-to-text model loadable.
    Ready,
    /// Connection refused or timed out: nothing is listening at the URL.
    DaemonDown,
    /// The daemon is up but its default model has not been pulled.
    ModelMissing,
    /// The daemon speaks an API version this Naru does not.
    Incompatible,
    /// Anything else the daemon (or whatever answered) reported.
    Error,
}

impl AudioState {
    pub fn as_str(self) -> &'static str {
        match self {
            AudioState::Ready => "ready",
            AudioState::DaemonDown => "daemon_down",
            AudioState::ModelMissing => "model_missing",
            AudioState::Incompatible => "incompatible",
            AudioState::Error => "error",
        }
    }
}

/// One probe's answer: the state, the sentence to show the person (`None`
/// when ready), the URL asked, and when (RFC 3339 UTC).
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub state: AudioState,
    pub message: Option<String>,
    pub url: String,
    pub checked_at: String,
}

/// A single cached value with a TTL decided by the value itself, keyed so a
/// changed key (a different URL, a different binary) is a miss rather than a
/// stale hit. The lock is held across the fetch, so a burst of callers makes
/// one request, not one each.
pub struct TtlCache<T> {
    slot: Mutex<Option<Slot<T>>>,
}

struct Slot<T> {
    key: String,
    value: T,
    at: Instant,
    taken_at: SystemTime,
    ttl: Duration,
}

impl<T: Clone> TtlCache<T> {
    pub const fn new() -> Self {
        TtlCache {
            slot: Mutex::new(None),
        }
    }

    /// The cached value for `key` if it is younger than its TTL at `now`,
    /// else a fresh `fetch()` stored with `ttl(&value)`. Returns the value and
    /// the wall-clock time it was taken.
    pub fn get(
        &self,
        key: &str,
        now: Instant,
        ttl: impl FnOnce(&T) -> Duration,
        fetch: impl FnOnce() -> T,
    ) -> (T, SystemTime) {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = slot.as_ref()
            && s.key == key
            && now.saturating_duration_since(s.at) < s.ttl
        {
            return (s.value.clone(), s.taken_at);
        }
        let value = fetch();
        let taken_at = SystemTime::now();
        *slot = Some(Slot {
            key: key.to_string(),
            ttl: ttl(&value),
            value: value.clone(),
            at: now,
            taken_at,
        });
        (value, taken_at)
    }

    /// Stores `value` for `key` as if [`TtlCache::get`] had just fetched it
    /// at `now` — for news that arrived by another request.
    pub fn put(&self, key: &str, value: T, now: Instant, ttl: Duration) {
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(Slot {
            key: key.to_string(),
            value,
            at: now,
            taken_at: SystemTime::now(),
            ttl,
        });
    }

    /// Forgets the cached value, so the next [`TtlCache::get`] fetches.
    pub fn invalidate(&self) {
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

impl<T: Clone> Default for TtlCache<T> {
    fn default() -> Self {
        TtlCache::new()
    }
}

/// The TTL for a list answer (`listen::models()`, `speech::voices()`): an
/// empty list is a failure to ask, retried soon.
pub fn list_ttl<T>(list: &[T]) -> Duration {
    if list.is_empty() {
        FAILURE_TTL
    } else {
        READY_TTL
    }
}

/// The probe cache plus the last state seen, which is what turns "every
/// probe" into "every change" for the log.
struct Prober {
    cache: TtlCache<Probe>,
    last: Mutex<Option<AudioState>>,
}

impl Prober {
    const fn new() -> Self {
        Prober {
            cache: TtlCache::new(),
            last: Mutex::new(None),
        }
    }

    /// The probe for `url` at `now`, plus the log line to write when the
    /// state differs from the last one this prober saw.
    fn probe_at(&self, url: &str, now: Instant) -> (Probe, Option<String>) {
        let (probe, _) = self.cache.get(
            url,
            now,
            |p| {
                if p.state == AudioState::Ready {
                    READY_TTL
                } else {
                    FAILURE_TTL
                }
            },
            || fetch_health(url),
        );
        let line = self.saw(&probe);
        (probe, line)
    }

    /// Stores a failure some other request found as the probe for its URL,
    /// for [`FAILURE_TTL`], so the next probe reports it rather than a cached
    /// `ready`. Returns the log line, as [`Prober::probe_at`] does.
    fn record(&self, probe: &Probe, now: Instant) -> Option<String> {
        self.cache.put(&probe.url, probe.clone(), now, FAILURE_TTL);
        self.saw(probe)
    }

    /// The state-change line for `probe`, if its state differs from the last
    /// one seen, and remembers it.
    fn saw(&self, probe: &Probe) -> Option<String> {
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        let line =
            (*last != Some(probe.state)).then(|| state_change_line(*last, probe.state, &probe.url));
        *last = Some(probe.state);
        line
    }

    /// `POST {url}/api/load` for the default speech-to-text model. `None`
    /// when it loaded; else the failure, already recorded, and its log line.
    /// `now` is read **after** the request returns, so a load that took
    /// longer than [`FAILURE_TTL`] to fail is not recorded already expired.
    fn load_at(&self, url: &str, now: impl FnOnce() -> Instant) -> Option<(Probe, Option<String>)> {
        let (state, message) = match request_load(url) {
            Ok((status, _)) if (200..300).contains(&status) => return None,
            Ok((status, body)) => classify_load(status, &body),
            Err(e) => classify_load_transport(url, &e),
        };
        let now = now();
        let probe = Probe {
            state,
            message,
            url: url.to_string(),
            checked_at: crate::core::cc::fmt_ts(unix_now()),
        };
        let line = self.record(&probe, now);
        Some((probe, line))
    }
}

static PROBER: Prober = Prober::new();

/// Whether the daemon at `url` can transcribe, from the cache when it is
/// fresh ([`READY_TTL`] / [`FAILURE_TTL`]). Blocking — at most
/// [`PROBE_TIMEOUT`] on a miss. A change of state is logged to stderr.
pub fn probe(url: &str) -> Probe {
    let (probe, line) = PROBER.probe_at(url, Instant::now());
    if let Some(line) = line {
        eprintln!("{line}");
    }
    probe
}

/// Drops the cached probe, so the next [`probe`] asks the daemon again. For
/// a real request that failed (task 17): the failure is fresher news than a
/// ten-second-old `ready`.
pub fn invalidate() {
    PROBER.cache.invalidate();
}

/// The daemon URL to warm when Live opens: `Some` only when `audio.engine`
/// is `naru-audio`. Any config read error is `None` — the warm-up is
/// best-effort and never fails a start.
pub fn warm_url() -> Option<String> {
    daemon_url()
}

/// The daemon's URL when `audio.engine` is `naru-audio`, else `None` — the
/// switch `listen::models()` and `speech::voices()` read (mesa task 1389).
/// Any config read error is `None`, the legacy engine: those lists are
/// advisory and cannot report an error.
pub fn daemon_url() -> Option<String> {
    match crate::core::config::audio_engine() {
        Ok(AudioEngine::NaruAudio) => crate::core::config::audio_url().ok(),
        _ => None,
    }
}

/// Asks the daemon at `url` to load its default speech-to-text model and
/// waits for it (up to [`LOAD_TIMEOUT`]). Blocking. A failure is recorded
/// as the probe's state (logged if it changed) and returned.
pub fn load_stt(url: &str) -> Result<(), Probe> {
    match PROBER.load_at(url, Instant::now) {
        None => Ok(()),
        Some((probe, line)) => {
            if let Some(line) = line {
                eprintln!("{line}");
            }
            Err(probe)
        }
    }
}

/// `warn audio state ready -> daemon_down url=…` — `info` when the new state
/// is `ready`, `warn` otherwise; `unknown` for the first probe of a process.
fn state_change_line(from: Option<AudioState>, to: AudioState, url: &str) -> String {
    let level = if to == AudioState::Ready {
        "info"
    } else {
        "warn"
    };
    let from = from.map_or("unknown", AudioState::as_str);
    format!("{level} audio state {from} -> {} url={url}", to.as_str())
}

#[derive(Deserialize)]
struct Health {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    api: Option<i64>,
    #[serde(default)]
    stt: Option<Engine>,
}

#[derive(Deserialize)]
struct Engine {
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    ready: bool,
    #[serde(default)]
    problem: Option<Problem>,
}

#[derive(Deserialize)]
struct Problem {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// `GET {url}/health`, classified. Never fails: every way of not getting a
/// ready daemon is a state with a sentence.
fn fetch_health(url: &str) -> Probe {
    let (state, message) = match request_health(url) {
        Ok((status, body)) => classify(status, &body),
        Err(e) => classify_transport(url, &e),
    };
    Probe {
        state,
        message,
        url: url.to_string(),
        checked_at: crate::core::cc::fmt_ts(unix_now()),
    }
}

fn request_health(url: &str) -> Result<(u16, String), ureq::Error> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(PROBE_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .build()
        .into();
    let mut response = agent
        .get(format!("{}/health", url.trim_end_matches('/')))
        .call()?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(HEALTH_BODY_CAP)
        .read_to_string()?;
    Ok((status, body))
}

fn request_load(url: &str) -> Result<(u16, String), ureq::Error> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(LOAD_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .build()
        .into();
    let mut response = agent
        .post(format!("{}/api/load", url.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .send(LOAD_BODY)?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(HEALTH_BODY_CAP)
        .read_to_string()?;
    Ok((status, body))
}

/// A load that got no HTTP answer: [`classify_transport`], except that a
/// timeout is a daemon that is there but slow, not one that is down.
fn classify_load_transport(url: &str, e: &ureq::Error) -> (AudioState, Option<String>) {
    match e {
        ureq::Error::Timeout(_) => (
            AudioState::Error,
            Some(error_message(&format!(
                "loading the speech-to-text model timed out after {} s",
                LOAD_TIMEOUT.as_secs()
            ))),
        ),
        other => classify_transport(url, other),
    }
}

/// A non-2xx `/api/load` answer, read from the daemon's error envelope
/// (design §2.6): a model that is not pulled or not known is
/// `model_missing`, anything else an `error`, each quoting the daemon.
fn classify_load(status: u16, body: &str) -> (AudioState, Option<String>) {
    let error = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .map(|mut v| v["error"].take());
    let code = error.as_ref().and_then(|e| e["code"].as_str());
    let reported = error
        .as_ref()
        .and_then(|e| e["message"].as_str())
        .map_or_else(
            || format!("POST /api/load answered HTTP {status}"),
            str::to_string,
        );
    let state = match code {
        Some("model_not_pulled" | "model_not_found") => AudioState::ModelMissing,
        _ => AudioState::Error,
    };
    (state, Some(error_message(&reported)))
}

pub(crate) fn down_message(url: &str) -> String {
    Side::Listen.down(url)
}

fn error_message(reported: &str) -> String {
    Side::Listen.reported(reported)
}

/// A request that never got an HTTP answer. Refused, timed out, or with no
/// route to the host is `daemon_down` — nothing is listening; anything else
/// (a garbled reply, a bad URL) is an `error` naming it.
fn classify_transport(url: &str, e: &ureq::Error) -> (AudioState, Option<String>) {
    match e {
        ureq::Error::Io(_)
        | ureq::Error::Timeout(_)
        | ureq::Error::ConnectionFailed
        | ureq::Error::HostNotFound => (AudioState::DaemonDown, Some(down_message(url))),
        other => (AudioState::Error, Some(error_message(&other.to_string()))),
    }
}

/// The daemon's streaming speech-to-text route (design §2.4).
const STREAM_PATH: &str = "/v1/audio/transcriptions/stream";

/// How long opening [`STREAM_PATH`] may take before the daemon counts as
/// down. A refused port fails at once; this bounds one that accepts and
/// never answers the handshake.
const STREAM_OPEN_TIMEOUT: Duration = Duration::from_secs(5);

/// An open stream to the daemon.
pub(crate) type DaemonStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Opens the daemon's streaming route at `url` for `GET /api/live/listen`
/// (mesa task 1394). The request is built from the URL alone, so it carries
/// the handshake headers and nothing else — no `Origin`, which the daemon
/// refuses (design §2.1), and nothing of the browser's. A failure drops the
/// cached probe (§4.4: a failed WS open is fresher news) and comes back as
/// the state and sentence the page shows: nothing answering is
/// `daemon_down`, an HTTP refusal or anything else is `error`.
pub(crate) async fn open_stream(url: &str) -> Result<DaemonStream, (AudioState, String)> {
    let authority = url.strip_prefix("http://").unwrap_or(url);
    let target = format!("ws://{}{STREAM_PATH}", authority.trim_end_matches('/'));
    let opened = tokio::time::timeout(
        STREAM_OPEN_TIMEOUT,
        tokio_tungstenite::connect_async(target),
    )
    .await;
    let failure = match opened {
        Ok(Ok((stream, _))) => return Ok(stream),
        Ok(Err(tokio_tungstenite::tungstenite::Error::Io(_))) | Err(_) => {
            (AudioState::DaemonDown, down_message(url))
        }
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => (
            AudioState::Error,
            error_message(&format!(
                "opening {STREAM_PATH} answered HTTP {}",
                response.status().as_u16()
            )),
        ),
        Ok(Err(other)) => (AudioState::Error, error_message(&other.to_string())),
    };
    invalidate();
    Err(failure)
}

/// The sentence for a stream the daemon dropped without a close frame.
pub(crate) fn stream_dropped_message() -> String {
    error_message("the stream ended without a close frame")
}

// ---------------------------------------------------------------------------
// Transcription, speech and the two lists (mesa task 1389)
// ---------------------------------------------------------------------------
//
// What `listen::transcribe`, `speech::start`, `listen::models` and
// `speech::voices` call instead of `auris`/`kokoro-rs` when `audio.engine`
// is `naru-audio` (design §6.2). Each failed transcribe or speak request
// drops the cached probe (§4.4: a failed real request is fresher news), and
// its sentence is §4.4's — "Speech isn't available: …" for the recognizer,
// "Naru's voice isn't available: …" for the synthesiser.

/// How long one transcription may take, connect to answer. The daemon holds
/// the answer until a cold model load (~4 s) and the whole decode are done,
/// and it accepts up to ten minutes of audio (§2.2), so this is generous;
/// `auris` had no limit at all.
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(300);

/// How long `POST /v1/audio/speech` may take to send its headers. The
/// daemon sends them once the first sentence is synthesised (§2.3), after a
/// cold load at worst — the [`LOAD_TIMEOUT`] budget. The body that follows
/// has no limit: a long render streams for as long as it takes, as
/// `kokoro-rs`'s did.
const SPEAK_START_TIMEOUT: Duration = LOAD_TIMEOUT;

/// How long connecting to the daemon for speech may take. A refused port
/// fails at once; this bounds one that never answers the SYN.
const SPEAK_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long `GET /v1/models` or `GET /v1/audio/voices` may take. Both are
/// registry reads that never load a model (§2.5).
const LIST_TIMEOUT: Duration = Duration::from_secs(2);

/// The most of a transcript, an error envelope or a list Naru reads. A
/// transcript of ten minutes of speech is tens of kilobytes.
const ANSWER_CAP: u64 = 1024 * 1024;

/// The daemon's routes this section speaks to (design §2.2, §2.3, §2.5).
const TRANSCRIPTIONS_PATH: &str = "/v1/audio/transcriptions";
const SPEECH_PATH: &str = "/v1/audio/speech";
const MODELS_PATH: &str = "/v1/models";
const VOICES_PATH: &str = "/v1/audio/voices";

/// Which half of speech a failure belongs to: §4.4's sentences open with
/// "Speech isn't available" for the recognizer and "Naru's voice isn't
/// available" for the synthesiser, and are otherwise the same.
#[derive(Clone, Copy)]
enum Side {
    Listen,
    Speak,
}

impl Side {
    fn prefix(self) -> &'static str {
        match self {
            Side::Listen => "Speech isn't available",
            Side::Speak => "Naru's voice isn't available",
        }
    }

    fn down(self, url: &str) -> String {
        format!(
            "{}: naru-audio isn't running at {url}. \
             Start it with `brew services start naru-audio`.",
            self.prefix()
        )
    }

    fn missing(self, model: &str) -> String {
        format!(
            "{}: the model {model} isn't downloaded. Run `naru-audio pull {model}`.",
            self.prefix()
        )
    }

    fn reported(self, reported: &str) -> String {
        format!("{}: naru-audio reported: {reported}", self.prefix())
    }
}

/// A request that did not succeed: no HTTP answer at all, or a non-2xx one
/// with its (capped) body.
enum Failure {
    Transport(ureq::Error),
    Status(u16, String),
}

/// The §4.4 sentence for `failure`, and the cached probe dropped. `model` is
/// the name that was sent, used when the daemon's message quotes none.
///
/// No HTTP answer is `daemon_down` — except a timeout, which is a daemon
/// that is there but slow, as for [`classify_load_transport`]. A 409
/// `model_not_pulled` is `model_missing`, naming the model the daemon quotes
/// (it resolves `default` to a real name). Anything else — a 404
/// `model_not_found` included, since no `pull` can fetch a model the catalog
/// does not know — quotes the daemon's own message (§2.6).
fn failed(side: Side, url: &str, path: &str, model: &str, failure: Failure) -> String {
    invalidate();
    match failure {
        Failure::Transport(ureq::Error::Timeout(_)) => side.reported(&format!("{path} timed out")),
        Failure::Transport(
            ureq::Error::Io(_) | ureq::Error::ConnectionFailed | ureq::Error::HostNotFound,
        ) => side.down(url),
        Failure::Transport(other) => side.reported(&other.to_string()),
        Failure::Status(status, body) => {
            let error = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .map(|mut v| v["error"].take());
            let code = error.as_ref().and_then(|e| e["code"].as_str());
            let message = error.as_ref().and_then(|e| e["message"].as_str());
            match code {
                Some("model_not_pulled") => side.missing(message.and_then(quoted).unwrap_or(model)),
                _ => side.reported(
                    &message
                        .map_or_else(|| format!("{path} answered HTTP {status}"), str::to_string),
                ),
            }
        }
    }
}

/// The first `"…"`-quoted run in `message` — the model name every daemon
/// registry error quotes (`the model "x" is not pulled; …`).
fn quoted(message: &str) -> Option<&str> {
    let (_, rest) = message.split_once('"')?;
    let (name, _) = rest.split_once('"')?;
    (!name.is_empty()).then_some(name)
}

/// A `multipart/form-data` body for `POST /v1/audio/transcriptions`: the
/// recording as `file`, then `model` and `response_format=json` (§2.2).
fn multipart(wav: &[u8], model: &str) -> (String, Vec<u8>) {
    form_data(
        ("audio.wav", "audio/wav", wav),
        &[("model", model), ("response_format", "json")],
    )
}

/// A `multipart/form-data` body: `file` as the part named `file` (its
/// filename, content type and bytes), then each of `fields` as a text part.
/// Built by hand — Naru's `ureq` has no multipart feature, and a few fields
/// do not need one. The boundary is lengthened until neither the file nor
/// any field value contains it.
fn form_data(file: (&str, &str, &[u8]), fields: &[(&str, &str)]) -> (String, Vec<u8>) {
    let (filename, content_type, bytes) = file;
    let mut boundary = format!("naru-audio-{:x}", unix_nanos());
    let contains = |haystack: &[u8], boundary: &str| {
        haystack
            .windows(boundary.len())
            .any(|w| w == boundary.as_bytes())
    };
    while contains(bytes, &boundary)
        || fields
            .iter()
            .any(|(_, v)| contains(v.as_bytes(), &boundary))
    {
        boundary.push('x');
    }
    let mut body = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; \
             filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    for (name, value) in fields {
        body.extend_from_slice(
            format!(
                "\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// Transcribes `wav` with the daemon at `url`, in `model` (a registry name,
/// or `default`). Nothing transcribed — silence — is the daemon's 200
/// `{"text":""}` (§2.2), so `Ok("")`: an empty transcript is a success. Every
/// failure is `Err` with the §4.4 sentence, and drops the cached probe.
/// Blocking.
pub fn transcribe(url: &str, wav: &[u8], model: &str) -> Result<String, String> {
    let fail = |failure| failed(Side::Listen, url, TRANSCRIPTIONS_PATH, model, failure);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TRANSCRIBE_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .build()
        .into();
    let (content_type, body) = multipart(wav, model);
    let answer = agent
        .post(format!(
            "{}{TRANSCRIPTIONS_PATH}",
            url.trim_end_matches('/')
        ))
        .header("Content-Type", content_type)
        .send(&body[..])
        .and_then(|mut response| {
            let status = response.status().as_u16();
            let body = response
                .body_mut()
                .with_config()
                .limit(ANSWER_CAP)
                .read_to_string()?;
            Ok((status, body))
        });
    let (status, body) = answer.map_err(|e| fail(Failure::Transport(e)))?;
    if !(200..300).contains(&status) {
        return Err(fail(Failure::Status(status, body)));
    }
    #[derive(Deserialize)]
    struct Transcript {
        text: String,
    }
    serde_json::from_str::<Transcript>(&body)
        .map(|t| t.text)
        .map_err(|_| {
            invalidate();
            Side::Listen.reported(&format!(
                "{TRANSCRIPTIONS_PATH} answered HTTP {status} with a body that is not its JSON"
            ))
        })
}

/// Starts speaking `text` with the daemon at `url`, in `voice` (omitted when
/// `None`, so the daemon's default voice speaks) and `model` (`default` when
/// `None`, the daemon's own text-to-speech model, mesa task 1425) as a
/// streamed WAV (§2.3).
/// Returns once the headers are in — the daemon sends them after the first
/// sentence is synthesised, so this is the last moment a failure can still
/// be a status code — with the body still arriving. A failure before then
/// is `Err` with the §4.4 sentence, and drops the cached probe. An error
/// after it reaches the reader as a read error: the daemon aborts the
/// chunked body without its terminating chunk, which `ureq` reports as
/// `UnexpectedEof` rather than a clean end. Blocking.
pub fn speak(
    url: &str,
    text: &str,
    voice: Option<&str>,
    model: Option<&str>,
) -> Result<ureq::BodyReader<'static>, String> {
    let model = model.unwrap_or("default");
    let fail = |failure| failed(Side::Speak, url, SPEECH_PATH, model, failure);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(SPEAK_CONNECT_TIMEOUT))
        .timeout_recv_response(Some(SPEAK_START_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .build()
        .into();
    let mut request = serde_json::json!({
        "model": model,
        "input": text,
        "response_format": "wav",
    });
    if let Some(voice) = voice {
        request["voice"] = serde_json::Value::String(voice.to_string());
    }
    let mut response = agent
        .post(format!("{}{SPEECH_PATH}", url.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .send(request.to_string())
        .map_err(|e| fail(Failure::Transport(e)))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response
            .body_mut()
            .with_config()
            .limit(ANSWER_CAP)
            .read_to_string()
            .unwrap_or_default();
        return Err(fail(Failure::Status(status, body)));
    }
    Ok(response.into_body().into_reader())
}

/// How long a buffered voice-design synthesis may take, connect to answer
/// (mesa task 1426). The daemon answers only once the whole clip is rendered
/// (`stream: false`, §2.3), after a cold load of a 1.7B model at worst.
const DESIGN_TIMEOUT: Duration = Duration::from_secs(180);

/// The most of a designed clip Naru reads. A reference script is seconds of
/// 24 kHz mono audio — well under a megabyte — so this only bounds a wrong
/// service on the port.
const DESIGN_AUDIO_CAP: u64 = 16 * 1024 * 1024;

/// Speaks `text` with the daemon at `url` in `model`, the voice made up
/// from `instructions` — a voice-design model's description of the voice
/// (mesa task 1426, §2.3) — and answers the whole WAV at once: the request
/// carries `"stream": false`, so the daemon buffers the render and writes
/// exact sizes. [`speak`] is untouched by this and never sends
/// `instructions`. A failure is §4.4's "Naru's voice" sentence and drops
/// the cached probe, as for [`speak`]. Blocking.
pub fn design(url: &str, model: &str, text: &str, instructions: &str) -> Result<Vec<u8>, String> {
    let fail = |failure| failed(Side::Speak, url, SPEECH_PATH, model, failure);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(SPEAK_CONNECT_TIMEOUT))
        .timeout_global(Some(DESIGN_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .build()
        .into();
    let request = serde_json::json!({
        "model": model,
        "input": text,
        "instructions": instructions,
        "response_format": "wav",
        "stream": false,
    });
    let mut response = agent
        .post(format!("{}{SPEECH_PATH}", url.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .send(request.to_string())
        .map_err(|e| fail(Failure::Transport(e)))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response
            .body_mut()
            .with_config()
            .limit(ANSWER_CAP)
            .read_to_string()
            .unwrap_or_default();
        return Err(fail(Failure::Status(status, body)));
    }
    response
        .body_mut()
        .with_config()
        .limit(DESIGN_AUDIO_CAP)
        .read_to_vec()
        .map_err(|e| fail(Failure::Transport(e)))
}

/// The ids of every speech-to-text model the daemon at `url` lists
/// (`GET /v1/models`, `x_kind == "stt"`) — pulled or not, since a model
/// that is known but not pulled is a choice the transcribe path answers with
/// the `naru-audio pull` command, not one to hide. Empty on any failure:
/// "Naru could not ask". Cached by the caller. Blocking.
pub fn stt_models(url: &str) -> Vec<String> {
    models_of_kind(url, MODELS_PATH, "stt")
}

/// The ids of every text-to-speech model the daemon at `url` lists
/// (`GET /v1/models`, `x_kind == "tts"`, mesa task 1425) — pulled or not,
/// for the reason [`stt_models`] gives. Empty on any failure. Cached by the
/// caller. Blocking.
pub fn tts_models(url: &str) -> Vec<String> {
    models_of_kind(url, MODELS_PATH, "tts")
}

/// The ids of the text-to-speech models the daemon at `url` has **pulled**
/// (`GET /v1/models?pulled=true`, mesa task 1426) — whether the voice-design
/// model can actually speak. Empty on any failure. Blocking.
pub fn pulled_tts_models(url: &str) -> Vec<String> {
    models_of_kind(url, &format!("{MODELS_PATH}?pulled=true"), "tts")
}

/// `GET {path}`' ids whose `x_kind` is `kind` — `path` being
/// `/v1/models`, with or without a query.
fn models_of_kind(url: &str, path: &str, kind: &str) -> Vec<String> {
    #[derive(Deserialize)]
    struct List {
        data: Vec<Model>,
    }
    #[derive(Deserialize)]
    struct Model {
        id: String,
        #[serde(default)]
        x_kind: Option<String>,
    }
    list(url, path)
        .and_then(|body| serde_json::from_str::<List>(&body).ok())
        .map(|l| {
            l.data
                .into_iter()
                .filter(|m| m.x_kind.as_deref() == Some(kind))
                .map(|m| m.id)
                .collect()
        })
        .unwrap_or_default()
}

/// One text-to-speech model's advertised capabilities (`GET /v1/models`,
/// mesa task 1455): whether it clones a reference recording
/// (`x_clone`), whether that clone needs a transcript alongside it
/// (`x_clone_requires_transcript`), whether it can design a voice from a
/// description (`x_instruct`), and whether it is the daemon's own default
/// text-to-speech model (`x_default`). Absent on an older daemon reads as
/// `false` for every flag, the same posture `x_kind` already takes.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TtsCaps {
    pub id: String,
    #[serde(default)]
    pub default: bool,
    #[serde(default)]
    pub clone: bool,
    #[serde(default)]
    pub clone_requires_transcript: bool,
    #[serde(default)]
    pub design: bool,
}

/// The text-to-speech models the daemon at `url` lists, with their
/// capabilities (`GET /v1/models`, `x_kind == "tts"`, mesa task 1455) — pulled
/// or not, for the reason [`stt_models`] gives. Empty on any failure. Cached
/// by the caller. Blocking.
pub fn tts_model_caps(url: &str) -> Vec<TtsCaps> {
    #[derive(Deserialize)]
    struct List {
        data: Vec<Model>,
    }
    #[derive(Deserialize)]
    struct Model {
        id: String,
        #[serde(default)]
        x_kind: Option<String>,
        #[serde(default)]
        x_default: bool,
        #[serde(default)]
        x_clone: bool,
        #[serde(default)]
        x_clone_requires_transcript: bool,
        #[serde(default)]
        x_instruct: bool,
    }
    list(url, MODELS_PATH)
        .and_then(|body| serde_json::from_str::<List>(&body).ok())
        .map(|l| {
            l.data
                .into_iter()
                .filter(|m| m.x_kind.as_deref() == Some("tts"))
                .map(|m| TtsCaps {
                    id: m.id,
                    default: m.x_default,
                    clone: m.x_clone,
                    clone_requires_transcript: m.x_clone_requires_transcript,
                    design: m.x_instruct,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The voice ids of the daemon's text-to-speech `model` — its default one
/// when `None` — (`GET /v1/audio/voices[?model=]`, read from the model's
/// manifest without loading it, §2.5; the query mesa task 1425). `model` is
/// a checked model name ([`crate::core::listen::is_model_name`]), so it
/// needs no escaping. Empty on any failure: "Naru could not ask". Cached by
/// the caller. Blocking.
pub fn voices(url: &str, model: Option<&str>) -> Vec<DaemonVoice> {
    #[derive(Deserialize)]
    struct List {
        voices: Vec<DaemonVoice>,
    }
    let path = match model {
        Some(model) => format!("{VOICES_PATH}?model={model}"),
        None => VOICES_PATH.to_string(),
    };
    list(url, &path)
        .and_then(|body| serde_json::from_str::<List>(&body).ok())
        .map(|l| l.voices)
        .unwrap_or_default()
}

/// One entry of `GET /v1/audio/voices`: the voice's id, and whether it is a
/// cloned voice — one the daemon can export (mesa task 1430). `cloned` is
/// additive in the daemon's listing, so an older daemon that does not send
/// it reads as `false`: nothing offered for export, never a failed list.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DaemonVoice {
    pub id: String,
    #[serde(default)]
    pub cloned: bool,
}

/// The most of an exported voice Naru reads. `ref.wav` is at most 30 s of
/// 24 kHz mono 16-bit audio (§5.3) — about 1.4 MB, under 2 MB as base64 —
/// so this leaves room for a daemon that keeps a longer clip.
const EXPORT_CAP: u64 = 16 * 1024 * 1024;

/// A cloned voice as the daemon exports it (`GET /v1/audio/voices/{name}`,
/// §2.5): its name, what the clip says, the model it was cloned for (mesa
/// task 1455) and `ref.wav` byte for byte as standard base64. `model`
/// defaults to the empty string on a daemon too old to send it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ExportedVoice {
    pub name: String,
    pub text: String,
    #[serde(default)]
    pub model: String,
    pub wav_base64: String,
}

/// Why the daemon did not export a voice (mesa task 1430), each with the
/// sentence to show — on a refusal, the daemon's own `error.message`.
#[derive(Debug, PartialEq)]
pub enum ExportVoiceError {
    /// 404 `voice_not_found`: no cloned voice of that name (a built-in voice
    /// is not one).
    NotFound(String),
    /// 400: a name the daemon will not take.
    Rejected(String),
    /// No answer, a timeout, a 5xx, or an answer that is not the daemon's.
    Unavailable(String),
}

/// Exports the cloned voice `name` from the daemon at `url`
/// (`GET /v1/audio/voices/{name}`, design §2.5). `name` is a checked voice
/// name ([`crate::core::speech::is_voice_name`]: letters, digits, `_`, `-`),
/// so it needs no path escaping. Blocking.
pub fn export_voice(url: &str, name: &str) -> Result<ExportedVoice, ExportVoiceError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(LIST_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .build()
        .into();
    let path = format!("{VOICES_PATH}/{name}");
    let answer = agent
        .get(format!("{}{path}", url.trim_end_matches('/')))
        .call()
        .and_then(|mut response| {
            let status = response.status().as_u16();
            let body = response
                .body_mut()
                .with_config()
                .limit(EXPORT_CAP)
                .read_to_string()?;
            Ok((status, body))
        });
    let (status, body) = answer.map_err(|e| {
        ExportVoiceError::Unavailable(match e {
            ureq::Error::Timeout(_) => format!(
                "naru-audio did not answer {path} within {} s",
                LIST_TIMEOUT.as_secs()
            ),
            ureq::Error::Io(_) | ureq::Error::ConnectionFailed | ureq::Error::HostNotFound => {
                invalidate();
                format!(
                    "naru-audio isn't running at {url}. \
                     Start it with `brew services start naru-audio`."
                )
            }
            other => format!("naru-audio could not export the voice: {other}"),
        })
    })?;
    if (200..300).contains(&status) {
        return serde_json::from_str::<ExportedVoice>(&body).map_err(|_| {
            ExportVoiceError::Unavailable(format!(
                "{path} answered HTTP {status} with a body that is not its JSON"
            ))
        });
    }
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{path} answered HTTP {status}"));
    Err(match status {
        404 => ExportVoiceError::NotFound(format!("naru-audio has no such voice: {message}")),
        400 => ExportVoiceError::Rejected(format!("naru-audio refused the voice: {message}")),
        _ => ExportVoiceError::Unavailable(format!(
            "naru-audio could not export the voice: {message}"
        )),
    })
}

/// How long `POST /v1/audio/voices` may take, connect to answer. The daemon
/// writes the upload, converts it with `afconvert` and checks its length
/// before it answers (§2.5) — seconds for a clip of at most 30 s.
const ADD_VOICE_TIMEOUT: Duration = Duration::from_secs(60);

/// Why the daemon did not add a cloned voice (mesa task 1418), each with the
/// sentence to show — on a refusal, the daemon's own `error.message`.
#[derive(Debug, PartialEq)]
pub enum AddVoiceError {
    /// 409 `voice_exists`: the name is taken, and nothing was replaced.
    Exists(String),
    /// 400, 413 or 415: a name, clip or transcript the daemon will not take.
    Rejected(String),
    /// No answer, a timeout, a 5xx, or an answer that is not the daemon's.
    Unavailable(String),
}

/// Adds the cloned voice `name` to the daemon at `url` from `clip` (audio
/// `afconvert` reads — WAV, MP3 — of 3–30 s), `text`, what the clip says, and
/// `model` — which text-to-speech model it is cloned for (mesa task 1455;
/// `None` lets the daemon fall back to its own `CLONE_MODEL`, the behavior
/// before this parameter existed) (`POST /v1/audio/voices`, multipart, design
/// §2.5). `Ok` is the clip's length in seconds when the daemon reports it.
/// Blocking.
pub fn add_voice(
    url: &str,
    name: &str,
    text: &str,
    clip: &[u8],
    model: Option<&str>,
) -> Result<Option<f64>, AddVoiceError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(ADD_VOICE_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .build()
        .into();
    let mut fields = vec![("name", name), ("text", text)];
    if let Some(model) = model {
        fields.push(("model", model));
    }
    let (content_type, body) = form_data(("clip", "application/octet-stream", clip), &fields);
    let answer = agent
        .post(format!("{}{VOICES_PATH}", url.trim_end_matches('/')))
        .header("Content-Type", content_type)
        .send(&body[..])
        .and_then(|mut response| {
            let status = response.status().as_u16();
            let body = response
                .body_mut()
                .with_config()
                .limit(ANSWER_CAP)
                .read_to_string()?;
            Ok((status, body))
        });
    let (status, body) = answer.map_err(|e| {
        AddVoiceError::Unavailable(match e {
            ureq::Error::Timeout(_) => format!(
                "naru-audio did not answer {VOICES_PATH} within {} s",
                ADD_VOICE_TIMEOUT.as_secs()
            ),
            ureq::Error::Io(_) | ureq::Error::ConnectionFailed | ureq::Error::HostNotFound => {
                invalidate();
                format!(
                    "naru-audio isn't running at {url}. \
                     Start it with `brew services start naru-audio`."
                )
            }
            other => format!("naru-audio could not add the voice: {other}"),
        })
    })?;
    if (200..300).contains(&status) {
        #[derive(Deserialize)]
        struct Added {
            #[serde(rename = "id")]
            _id: String,
            #[serde(default)]
            duration: Option<f64>,
        }
        return serde_json::from_str::<Added>(&body)
            .map(|a| a.duration)
            .map_err(|_| {
                AddVoiceError::Unavailable(format!(
                    "{VOICES_PATH} answered HTTP {status} with a body that is not its JSON"
                ))
            });
    }
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{VOICES_PATH} answered HTTP {status}"));
    Err(match status {
        409 => AddVoiceError::Exists(format!("naru-audio refused the voice: {message}")),
        400 | 413 | 415 => {
            AddVoiceError::Rejected(format!("naru-audio refused the voice: {message}"))
        }
        _ => AddVoiceError::Unavailable(format!("naru-audio could not add the voice: {message}")),
    })
}

/// `GET {url}{path}`'s body when it answered 2xx within [`LIST_TIMEOUT`].
fn list(url: &str, path: &str) -> Option<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(LIST_TIMEOUT))
        .http_status_as_error(false)
        .proxy(None)
        .max_redirects(0)
        .build()
        .into();
    let mut response = agent
        .get(format!("{}{path}", url.trim_end_matches('/')))
        .call()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response
        .body_mut()
        .with_config()
        .limit(ANSWER_CAP)
        .read_to_string()
        .ok()
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// A `/health` answer, read against design §4.4's table.
fn classify(status: u16, body: &str) -> (AudioState, Option<String>) {
    let Ok(health) = serde_json::from_str::<Health>(body) else {
        return (
            AudioState::Error,
            Some(error_message(&format!(
                "GET /health answered HTTP {status} with a body that is not its JSON"
            ))),
        );
    };
    if health.api != Some(API_VERSION) {
        let v = health.version.as_deref().unwrap_or("(unknown version)");
        let n = health
            .api
            .map_or_else(|| "(none)".to_string(), |n| n.to_string());
        return (
            AudioState::Incompatible,
            Some(format!(
                "Speech isn't available: naru-audio {v} speaks API {n}; this Naru \
                 needs API {API_VERSION}. Upgrade with `brew upgrade naru-audio`."
            )),
        );
    }
    if !(200..300).contains(&status) || health.status.as_deref() != Some("ok") {
        let s = health.status.as_deref().unwrap_or("(none)");
        return (
            AudioState::Error,
            Some(error_message(&format!(
                "GET /health answered HTTP {status} with status {s}"
            ))),
        );
    }
    let Some(stt) = health.stt else {
        return (
            AudioState::Error,
            Some(error_message(
                "no speech-to-text engine (/health has no stt block)",
            )),
        );
    };
    if stt.ready {
        return (AudioState::Ready, None);
    }
    match stt.problem {
        Some(Problem {
            code: Some(code), ..
        }) if code == "model_not_pulled" => {
            let m = stt.default.as_deref().unwrap_or("(default)");
            (
                AudioState::ModelMissing,
                Some(format!(
                    "Speech isn't available: the model {m} isn't downloaded. \
                     Run `naru-audio pull {m}`."
                )),
            )
        }
        Some(Problem {
            message: Some(message),
            ..
        }) => (AudioState::Error, Some(error_message(&message))),
        _ => (
            AudioState::Error,
            Some(error_message("speech-to-text is not ready")),
        ),
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A stand-in `naru-audio` daemon for tests here and in `api.rs`.
#[cfg(test)]
pub(crate) mod stub {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    /// `POST /api/load`'s success answer.
    pub(crate) const LOADED: &str = r#"{"model":"parakeet-tdt-0.6b-v2-int8","loaded":true}"#;

    /// What the stub answers one request with.
    pub(crate) enum Reply {
        /// A whole JSON body with this status.
        Json(u16, String),
        /// A 200 `audio/wav` chunked body that sends these bytes as one chunk
        /// and then closes the connection **without** the terminating
        /// zero-length chunk — how the daemon aborts a speech stream that
        /// failed after its first byte (design §2.3).
        Aborted(Vec<u8>),
    }

    /// An HTTP stub: `POST /api/load` gets `load` (status, body), every other
    /// request `body` with a 200 — or, from [`Stub::serve`], whatever its
    /// function answers for the method and path. Each request is recorded as
    /// `"<METHOD> <path> <body>"`. Stopped by dropping it, which closes the
    /// listening socket.
    pub(crate) struct Stub {
        pub(crate) port: u16,
        pub(crate) requests: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Stub {
        pub(crate) fn start(port: u16, body: &'static str) -> Stub {
            Stub::with_load(port, body, (200, LOADED))
        }

        pub(crate) fn with_load(port: u16, body: &'static str, load: (u16, &'static str)) -> Stub {
            Stub::serve(port, move |method, path| {
                let (status, answer) = if method == "POST" && path == "/api/load" {
                    load
                } else {
                    (200, body)
                };
                Reply::Json(status, answer.to_string())
            })
        }

        /// A stub answering each request with `route(method, path)`.
        pub(crate) fn serve(
            port: u16,
            route: impl Fn(&str, &str) -> Reply + Send + 'static,
        ) -> Stub {
            let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind stub");
            let port = listener.local_addr().unwrap().port();
            let stop = Arc::new(AtomicBool::new(false));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let (flag, log) = (stop.clone(), requests.clone());
            let thread = std::thread::spawn(move || {
                for conn in listener.incoming() {
                    if flag.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(mut conn) = conn else { continue };
                    let mut buf = [0u8; 4096];
                    let mut got = Vec::new();
                    let head_end = loop {
                        if let Some(i) = got.windows(4).position(|w| w == b"\r\n\r\n") {
                            break Some(i + 4);
                        }
                        match conn.read(&mut buf) {
                            Ok(0) | Err(_) => break None,
                            Ok(n) => got.extend_from_slice(&buf[..n]),
                        }
                    };
                    let Some(head_end) = head_end else { continue };
                    let head = String::from_utf8_lossy(&got[..head_end]).to_string();
                    let length = head
                        .lines()
                        .filter_map(|l| l.split_once(':'))
                        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    while got.len() < head_end + length {
                        match conn.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => got.extend_from_slice(&buf[..n]),
                        }
                    }
                    let line = head.lines().next().unwrap_or_default();
                    let mut words = line.split(' ');
                    let (method, path) = (words.next().unwrap_or(""), words.next().unwrap_or(""));
                    let sent = String::from_utf8_lossy(&got[head_end..]).to_string();
                    log.lock().unwrap().push(format!("{method} {path} {sent}"));
                    match route(method, path) {
                        Reply::Json(status, answer) => {
                            let _ = write!(
                                conn,
                                "HTTP/1.1 {status} Stub\r\nContent-Type: application/json\r\n\
                                 Content-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                                answer.len()
                            );
                        }
                        Reply::Aborted(bytes) => {
                            let _ = write!(
                                conn,
                                "HTTP/1.1 200 Stub\r\nContent-Type: audio/wav\r\n\
                                 Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
                                bytes.len()
                            );
                            let _ = conn.write_all(&bytes);
                            let _ = conn.write_all(b"\r\n");
                            // No `0\r\n\r\n`: the connection closes here.
                        }
                    }
                }
            });
            Stub {
                port,
                requests,
                stop,
                thread: Some(thread),
            }
        }

        pub(crate) fn url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }

        /// The recorded requests starting `prefix`, e.g. `"POST /api/load"`.
        pub(crate) fn count(&self, prefix: &str) -> usize {
            let requests = self.requests.lock().unwrap();
            requests.iter().filter(|r| r.starts_with(prefix)).count()
        }
    }

    impl Drop for Stub {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            // Wake the blocking accept so the thread sees the flag and drops
            // the listener.
            let _ = TcpStream::connect(("127.0.0.1", self.port));
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::stub::Stub;
    use super::*;
    use std::net::TcpListener;

    const READY: &str = r#"{"status":"ok","version":"0.1.0","api":1,"pid":1,"uptime_s":4,
        "stt":{"default":"parakeet-tdt-0.6b-v2-int8","ready":true,"problem":null}}"#;

    fn state_of(body: &str) -> (AudioState, Option<String>) {
        classify(200, body)
    }

    /// The acceptance run: ready → the daemon stops → `daemon_down` once
    /// the ready TTL lapses → it comes back on the same port → `ready` once
    /// the failure TTL lapses, all on one prober with no restart. The clock
    /// is injected, so the TTLs are exercised without sleeping through them.
    #[test]
    fn probe_follows_a_daemon_that_goes_down_and_comes_back_within_the_ttls() {
        let prober = Prober::new();
        let stub = Stub::start(0, READY);
        let port = stub.port;
        let url = stub.url();
        let t0 = Instant::now();

        let (p, line) = prober.probe_at(&url, t0);
        assert_eq!(p.state, AudioState::Ready);
        assert_eq!(p.message, None);
        assert_eq!(p.url, url);
        assert_eq!(p.checked_at.len(), 20, "{}", p.checked_at);
        assert!(p.checked_at.ends_with('Z'), "{}", p.checked_at);
        assert_eq!(
            line.as_deref(),
            Some(format!("info audio state unknown -> ready url={url}").as_str())
        );

        drop(stub);

        // Inside the ready TTL the cached answer stands, and nothing is logged.
        let (p, line) = prober.probe_at(&url, t0 + Duration::from_secs(9));
        assert_eq!(p.state, AudioState::Ready);
        assert_eq!(line, None);

        // Past it, the daemon is asked again and is gone.
        let t1 = t0 + READY_TTL + Duration::from_millis(1);
        let (p, line) = prober.probe_at(&url, t1);
        assert_eq!(p.state, AudioState::DaemonDown);
        assert_eq!(
            p.message.as_deref(),
            Some(
                format!(
                    "Speech isn't available: naru-audio isn't running at {url}. \
                     Start it with `brew services start naru-audio`."
                )
                .as_str()
            )
        );
        assert_eq!(
            line.as_deref(),
            Some(format!("warn audio state ready -> daemon_down url={url}").as_str())
        );

        // It comes back on the same port.
        let stub = Stub::start(port, READY);
        // Within the failure TTL the down answer still stands, unlogged…
        let (p, line) = prober.probe_at(&url, t1 + Duration::from_secs(1));
        assert_eq!(p.state, AudioState::DaemonDown);
        assert_eq!(line, None);
        // …and once it lapses, ready again.
        let (p, line) = prober.probe_at(&url, t1 + FAILURE_TTL + Duration::from_millis(1));
        assert_eq!(p.state, AudioState::Ready);
        assert_eq!(
            line.as_deref(),
            Some(format!("info audio state daemon_down -> ready url={url}").as_str())
        );
        drop(stub);
    }

    /// `invalidate` is the other way past a fresh ready answer: the next
    /// probe asks, whatever the clock says.
    #[test]
    fn invalidate_makes_the_next_probe_ask_again() {
        let prober = Prober::new();
        let stub = Stub::start(0, READY);
        let url = stub.url();
        let t0 = Instant::now();
        assert_eq!(prober.probe_at(&url, t0).0.state, AudioState::Ready);
        drop(stub);
        assert_eq!(prober.probe_at(&url, t0).0.state, AudioState::Ready);
        prober.cache.invalidate();
        assert_eq!(prober.probe_at(&url, t0).0.state, AudioState::DaemonDown);
    }

    /// A different URL (a config edit) is a miss, never the old URL's answer.
    #[test]
    fn a_changed_url_is_asked_rather_than_served_from_cache() {
        let prober = Prober::new();
        let stub = Stub::start(0, READY);
        let t0 = Instant::now();
        assert_eq!(prober.probe_at(&stub.url(), t0).0.state, AudioState::Ready);
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let dead = format!("http://127.0.0.1:{}", other.local_addr().unwrap().port());
        drop(other);
        let (p, _) = prober.probe_at(&dead, t0);
        assert_eq!(p.state, AudioState::DaemonDown);
        assert_eq!(p.url, dead);
    }

    #[test]
    fn model_missing_names_the_default_model_and_the_pull_command() {
        let stub = Stub::start(
            0,
            r#"{"status":"ok","version":"0.1.0","api":1,
                "stt":{"default":"parakeet-tdt-0.6b-v2-int8","ready":false,
                       "problem":{"code":"model_not_pulled",
                                  "message":"run `naru-audio pull parakeet-tdt-0.6b-v2-int8`"}}}"#,
        );
        let (p, line) = Prober::new().probe_at(&stub.url(), Instant::now());
        assert_eq!(p.state, AudioState::ModelMissing);
        assert_eq!(
            p.message.as_deref(),
            Some(
                "Speech isn't available: the model parakeet-tdt-0.6b-v2-int8 isn't \
                 downloaded. Run `naru-audio pull parakeet-tdt-0.6b-v2-int8`."
            )
        );
        assert!(
            line.unwrap()
                .starts_with("warn audio state unknown -> model_missing")
        );
    }

    #[test]
    fn another_api_version_is_incompatible() {
        let stub = Stub::start(
            0,
            r#"{"status":"ok","version":"2.3.0","api":2,
                "stt":{"default":"m","ready":true,"problem":null}}"#,
        );
        let (p, _) = Prober::new().probe_at(&stub.url(), Instant::now());
        assert_eq!(p.state, AudioState::Incompatible);
        assert_eq!(
            p.message.as_deref(),
            Some(
                "Speech isn't available: naru-audio 2.3.0 speaks API 2; this Naru \
                 needs API 1. Upgrade with `brew upgrade naru-audio`."
            )
        );
    }

    #[test]
    fn a_health_with_no_stt_block_is_an_error() {
        // The scaffold daemon's /health (design task 1) answers exactly this.
        let stub = Stub::start(0, r#"{"status":"ok","version":"0.1.0","api":1,"pid":7}"#);
        let (p, _) = Prober::new().probe_at(&stub.url(), Instant::now());
        assert_eq!(p.state, AudioState::Error);
        assert_eq!(
            p.message.as_deref(),
            Some(
                "Speech isn't available: naru-audio reported: no speech-to-text engine \
                 (/health has no stt block)"
            )
        );
    }

    #[test]
    fn other_problems_are_errors_quoting_the_daemon() {
        let (state, message) = state_of(
            r#"{"status":"ok","version":"0.1.0","api":1,
                "stt":{"default":"m","ready":false,
                       "problem":{"code":"backend_unavailable","message":"mlx requires Apple Silicon"}}}"#,
        );
        assert_eq!(state, AudioState::Error);
        assert_eq!(
            message.as_deref(),
            Some("Speech isn't available: naru-audio reported: mlx requires Apple Silicon")
        );
        // Not JSON at all — some other service on the port.
        assert_eq!(state_of("<html>hi</html>").0, AudioState::Error);
        // Not ready, no problem named.
        assert_eq!(
            state_of(r#"{"status":"ok","api":1,"stt":{"ready":false}}"#).0,
            AudioState::Error
        );
        // Ready by its own account but answering non-2xx.
        assert_eq!(
            classify(500, READY).0,
            AudioState::Error,
            "a 500 is not ready"
        );
    }

    #[test]
    fn states_serialize_to_the_wire_strings() {
        for s in [
            AudioState::Ready,
            AudioState::DaemonDown,
            AudioState::ModelMissing,
            AudioState::Incompatible,
            AudioState::Error,
        ] {
            assert_eq!(
                serde_json::to_value(s).unwrap(),
                serde_json::json!(s.as_str())
            );
        }
    }

    #[test]
    fn ttl_cache_keeps_an_empty_list_briefly_and_a_full_one_longer() {
        let cache: TtlCache<Vec<String>> = TtlCache::new();
        let t0 = Instant::now();
        let mut calls = 0;
        let mut get = |at: Instant, answer: Vec<String>| {
            cache
                .get(
                    "bin",
                    at,
                    |v| list_ttl(v),
                    || {
                        calls += 1;
                        answer
                    },
                )
                .0
        };
        assert!(get(t0, vec![]).is_empty());
        assert!(get(t0 + Duration::from_secs(1), vec!["a".into()]).is_empty());
        assert_eq!(get(t0 + FAILURE_TTL, vec!["a".into()]), vec!["a"]);
        assert_eq!(
            get(t0 + FAILURE_TTL + Duration::from_secs(9), vec![]),
            vec!["a"]
        );
        assert!(get(t0 + FAILURE_TTL + READY_TTL, vec![]).is_empty());
        assert_eq!(calls, 3);
    }

    /// A load sends the design's exact body once, and a success writes
    /// nothing into the probe state.
    #[test]
    fn load_posts_the_default_stt_body_and_a_success_records_nothing() {
        let prober = Prober::new();
        let stub = Stub::start(0, READY);
        let url = stub.url();
        assert!(prober.load_at(&url, Instant::now).is_none());
        assert_eq!(
            *stub.requests.lock().unwrap(),
            vec![format!("POST /api/load {LOAD_BODY}")]
        );
        assert_eq!(LOAD_BODY, r#"{"model":"default","kind":"stt"}"#);
        assert_eq!(*prober.last.lock().unwrap(), None, "nothing recorded");
    }

    /// A load the daemon refuses replaces a cached `ready` with its failure
    /// for the failure TTL, quoting the daemon — then the probe asks again.
    #[test]
    fn a_failed_load_replaces_a_cached_ready_with_its_failure() {
        let prober = Prober::new();
        let stub = Stub::with_load(
            0,
            READY,
            (
                503,
                r#"{"error":{"message":"backend exploded","type":"server_error",
                    "code":"model_load_failed","param":null}}"#,
            ),
        );
        let url = stub.url();
        let t0 = Instant::now();
        assert_eq!(prober.probe_at(&url, t0).0.state, AudioState::Ready);

        let (p, line) = prober.load_at(&url, || t0).expect("the load failed");
        assert_eq!(p.state, AudioState::Error);
        assert_eq!(
            line.as_deref(),
            Some(format!("warn audio state ready -> error url={url}").as_str())
        );
        let (p, line) = prober.probe_at(&url, t0 + Duration::from_secs(1));
        assert_eq!(p.state, AudioState::Error, "not the cached ready");
        assert_eq!(
            p.message.as_deref(),
            Some("Speech isn't available: naru-audio reported: backend exploded")
        );
        assert_eq!(line, None, "the change was logged once, by the load");
        assert_eq!(stub.count("GET /health"), 1);

        let (p, _) = prober.probe_at(&url, t0 + FAILURE_TTL + Duration::from_millis(1));
        assert_eq!(p.state, AudioState::Ready);
        assert_eq!(stub.count("GET /health"), 2);
    }

    /// A load that cannot connect is `daemon_down`, seen by the next probe
    /// even inside the ready TTL.
    #[test]
    fn a_refused_load_is_daemon_down_for_the_next_probe() {
        let prober = Prober::new();
        let stub = Stub::start(0, READY);
        let url = stub.url();
        let t0 = Instant::now();
        assert_eq!(prober.probe_at(&url, t0).0.state, AudioState::Ready);
        drop(stub);
        let (p, _) = prober.load_at(&url, || t0).expect("nothing is listening");
        assert_eq!(p.state, AudioState::DaemonDown);
        let (p, _) = prober.probe_at(&url, t0 + Duration::from_secs(1));
        assert_eq!(p.state, AudioState::DaemonDown);
        assert_eq!(p.message, Some(down_message(&url)));
    }

    /// A load that takes longer than the failure TTL to fail (a real 503
    /// arrives after a ~4 s load) is stamped when it returns, so the next
    /// probe still sees it rather than an expired entry and a fresh `ready`.
    #[test]
    fn a_slow_failed_load_is_still_seen_by_the_next_probe() {
        let prober = Prober::new();
        let stub = Stub::with_load(
            0,
            READY,
            (503, r#"{"error":{"message":"backend exploded"}}"#),
        );
        let url = stub.url();
        let t0 = Instant::now();
        assert_eq!(prober.probe_at(&url, t0).0.state, AudioState::Ready);
        // The load returns FAILURE_TTL + 2 s after it started.
        let done = t0 + FAILURE_TTL + Duration::from_secs(2);
        let (p, _) = prober.load_at(&url, || done).expect("the load failed");
        assert_eq!(p.state, AudioState::Error);
        let (p, _) = prober.probe_at(&url, done + Duration::from_secs(1));
        assert_eq!(p.state, AudioState::Error, "not an expired entry");
        assert_eq!(stub.count("GET /health"), 1);
    }

    /// A load timeout is a slow daemon, not a stopped one.
    #[test]
    fn a_load_timeout_is_an_error_not_daemon_down() {
        let url = "http://127.0.0.1:7870";
        let (state, message) =
            classify_load_transport(url, &ureq::Error::Timeout(ureq::Timeout::Global));
        assert_eq!(state, AudioState::Error);
        assert_eq!(
            message.as_deref(),
            Some(
                "Speech isn't available: naru-audio reported: loading the speech-to-text \
                 model timed out after 60 s"
            )
        );
        assert_eq!(
            classify_load_transport(url, &ureq::Error::ConnectionFailed).0,
            AudioState::DaemonDown
        );
    }

    #[test]
    fn a_model_the_daemon_cannot_load_is_model_missing() {
        for code in ["model_not_pulled", "model_not_found"] {
            let body = format!(r#"{{"error":{{"message":"no {code}","code":"{code}"}}}}"#);
            let (state, message) = classify_load(409, &body);
            assert_eq!(state, AudioState::ModelMissing, "{code}");
            assert_eq!(
                message.as_deref(),
                Some(format!("Speech isn't available: naru-audio reported: no {code}").as_str())
            );
        }
        assert_eq!(
            classify_load(502, "<html>").1.as_deref(),
            Some("Speech isn't available: naru-audio reported: POST /api/load answered HTTP 502")
        );
    }

    #[test]
    fn engine_words_round_trip() {
        for e in [AudioEngine::Legacy, AudioEngine::NaruAudio] {
            assert_eq!(AudioEngine::parse(e.as_str()), Some(e));
        }
        assert_eq!(AudioEngine::parse("auris"), None);
    }

    /// A stub daemon answering `POST /v1/audio/transcriptions` with `status`
    /// and `body`.
    fn transcriber(status: u16, body: &'static str) -> Stub {
        Stub::serve(0, move |_, path| {
            assert_eq!(path, TRANSCRIPTIONS_PATH);
            stub::Reply::Json(status, body.to_string())
        })
    }

    /// The design's transcribe contract (§2.2), mesa task 1389: a multipart
    /// body carrying the recording byte-identical as `file`, the model and
    /// `response_format=json`, and the daemon's `text` back.
    #[test]
    fn transcribe_posts_the_recording_as_multipart_and_returns_the_text() {
        let _prober = prober_lock();
        let stub = transcriber(200, r#"{"text":"Add a task to the naru board."}"#);
        let wav = b"RIFF\x00\x01binary\r\n--not-a-boundary";
        let text = transcribe(&stub.url(), wav, "parakeet-tdt-0.6b-v2-int8");
        assert_eq!(text, Ok("Add a task to the naru board.".to_string()));
        let requests = stub.requests.lock().unwrap();
        let sent = &requests[0];
        assert!(
            sent.starts_with("POST /v1/audio/transcriptions --naru-audio-"),
            "{sent}"
        );
        for part in [
            "name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n\
             RIFF\u{0}\u{1}binary\r\n--not-a-boundary\r\n--naru-audio-",
            "name=\"model\"\r\n\r\nparakeet-tdt-0.6b-v2-int8\r\n",
            "name=\"response_format\"\r\n\r\njson\r\n",
        ] {
            assert!(sent.contains(part), "{part:?} missing from {sent:?}");
        }
    }

    /// The boundary never occurs in the recording it frames.
    #[test]
    fn the_multipart_boundary_is_lengthened_past_the_recording() {
        let (_, probe) = multipart(b"", "default");
        let head = String::from_utf8(probe).unwrap();
        let boundary = head[2..head.find('\r').unwrap()].to_string();
        let wav = format!("xx{boundary}xx{boundary}x");
        let (content_type, body) = multipart(wav.as_bytes(), "default");
        let used = content_type
            .strip_prefix("multipart/form-data; boundary=")
            .unwrap();
        assert!(!wav.contains(used), "{used} is inside the recording");
        assert!(body.starts_with(format!("--{used}\r\n").as_bytes()));
    }

    /// Adding a cloned voice (mesa task 1418, design §2.5): one multipart
    /// body carrying the clip byte-identical as `file` beside `name` and
    /// `text`, and the daemon's 201 read back as the clip's length.
    #[test]
    fn add_voice_posts_name_clip_and_text_as_multipart() {
        let stub = Stub::serve(0, |method, path| {
            assert_eq!((method, path), ("POST", VOICES_PATH));
            stub::Reply::Json(
                201,
                r#"{"id":"amy","accent":null,"gender":null,"default":false,"duration":6.2}"#
                    .to_string(),
            )
        });
        let clip = b"ID3\x04\x00mp3-bytes\r\n--not-a-boundary";
        assert_eq!(
            add_voice(
                &stub.url(),
                "amy",
                "Hello there, this is Amy.",
                clip,
                Some("breeze-tts-2-mlx"),
            ),
            Ok(Some(6.2))
        );
        let requests = stub.requests.lock().unwrap();
        let sent = &requests[0];
        assert!(
            sent.starts_with("POST /v1/audio/voices --naru-audio-"),
            "{sent}"
        );
        for part in [
            "name=\"file\"; filename=\"clip\"\r\nContent-Type: application/octet-stream\r\n\r\n\
             ID3\u{4}\u{0}mp3-bytes\r\n--not-a-boundary\r\n--naru-audio-",
            "name=\"name\"\r\n\r\namy\r\n",
            "name=\"text\"\r\n\r\nHello there, this is Amy.\r\n",
            "name=\"model\"\r\n\r\nbreeze-tts-2-mlx\r\n",
        ] {
            assert!(sent.contains(part), "{part:?} missing from {sent:?}");
        }
    }

    /// A caller that names no model (mesa task 1455) sends none — the daemon
    /// falls back to its own `CLONE_MODEL`, the behavior before this
    /// parameter existed.
    #[test]
    fn add_voice_sends_no_model_part_when_none_is_named() {
        let stub = Stub::serve(0, |method, path| {
            assert_eq!((method, path), ("POST", VOICES_PATH));
            stub::Reply::Json(
                201,
                r#"{"id":"amy","accent":null,"gender":null,"default":false,"duration":6.2}"#
                    .to_string(),
            )
        });
        assert_eq!(
            add_voice(&stub.url(), "amy", "hi", b"RIFF", None),
            Ok(Some(6.2))
        );
        let requests = stub.requests.lock().unwrap();
        assert!(!requests[0].contains("name=\"model\""), "{}", requests[0]);
    }

    /// The daemon's refusals keep its own message: a taken name is
    /// `Exists`, a clip it cannot read `Rejected`, a 5xx `Unavailable`.
    #[test]
    fn add_voice_passes_the_daemons_refusals_through() {
        for (status, code, message, want) in [
            (
                409,
                "voice_exists",
                "the voice \\\"amy\\\" already exists",
                0,
            ),
            (
                415,
                "unsupported_media_type",
                "the clip is not audio afconvert can read",
                1,
            ),
            (
                400,
                "invalid_request",
                "the clip is 1.2 s long; it must be 3-30 s",
                1,
            ),
            (500, "internal", "disk full", 2),
        ] {
            let body = format!(
                r#"{{"error":{{"message":"{message}","type":"x","code":"{code}","param":null}}}}"#
            );
            let stub = Stub::serve(0, move |_, _| stub::Reply::Json(status, body.clone()));
            let got = add_voice(&stub.url(), "amy", "hi", b"RIFF", None);
            let shown = message.replace("\\\"", "\"");
            let expected = match want {
                0 => AddVoiceError::Exists(format!("naru-audio refused the voice: {shown}")),
                1 => AddVoiceError::Rejected(format!("naru-audio refused the voice: {shown}")),
                _ => AddVoiceError::Unavailable(format!(
                    "naru-audio could not add the voice: {shown}"
                )),
            };
            assert_eq!(got, Err(expected), "HTTP {status}");
        }
    }

    /// Exporting a cloned voice (mesa task 1430, design §2.5): one GET of
    /// `/v1/audio/voices/{name}`, the daemon's `{name, text, model,
    /// wav_base64}` read back untouched — `model` defaults to the empty
    /// string on a daemon too old to send it (mesa task 1455).
    #[test]
    fn export_voice_reads_the_daemons_export() {
        let stub = Stub::serve(0, |method, path| {
            assert_eq!((method, path), ("GET", "/v1/audio/voices/amy"));
            stub::Reply::Json(
                200,
                r#"{"name":"amy","text":"Hello there.","model":"breeze-tts-2-mlx","wav_base64":"UklGRgABAgM="}"#.to_string(),
            )
        });
        assert_eq!(
            export_voice(&stub.url(), "amy"),
            Ok(ExportedVoice {
                name: "amy".to_string(),
                text: "Hello there.".to_string(),
                model: "breeze-tts-2-mlx".to_string(),
                wav_base64: "UklGRgABAgM=".to_string(),
            })
        );
    }

    /// A daemon that predates per-model voices sends no `model` at all —
    /// [`ExportedVoice::model`] reads as the empty string, not an error
    /// (mesa task 1455).
    #[test]
    fn export_voice_defaults_a_missing_model_to_empty() {
        let stub = Stub::serve(0, |_, _| {
            stub::Reply::Json(
                200,
                r#"{"name":"amy","text":"Hello there.","wav_base64":"UklGRgABAgM="}"#.to_string(),
            )
        });
        assert_eq!(
            export_voice(&stub.url(), "amy").unwrap().model,
            String::new()
        );
    }

    /// The daemon's refusals map to their own variants, carrying its message;
    /// a daemon that is not there is `Unavailable`.
    #[test]
    fn export_voice_passes_the_daemons_refusals_through() {
        let cases = [
            (404, "voice_not_found", "no cloned voice \\\"af_heart\\\""),
            (400, "invalid_request", "bad name"),
            (500, "internal", "boom"),
        ];
        for (status, code, message) in cases {
            let body = format!(r#"{{"error":{{"message":"{message}","code":"{code}"}}}}"#);
            let stub = Stub::serve(0, move |_, _| stub::Reply::Json(status, body.clone()));
            let shown = message.replace("\\\"", "\"");
            let want = match status {
                404 => ExportVoiceError::NotFound(format!("naru-audio has no such voice: {shown}")),
                400 => ExportVoiceError::Rejected(format!("naru-audio refused the voice: {shown}")),
                _ => ExportVoiceError::Unavailable(format!(
                    "naru-audio could not export the voice: {shown}"
                )),
            };
            assert_eq!(export_voice(&stub.url(), "af_heart"), Err(want), "{status}");
        }
        let gone = Stub::start(0, "{}");
        let url = gone.url();
        drop(gone);
        assert!(matches!(
            export_voice(&url, "amy"),
            Err(ExportVoiceError::Unavailable(m)) if m.contains("isn't running")
        ));
    }

    /// Designing a voice (mesa task 1426): one JSON request carrying the
    /// description as `instructions` and `"stream": false`, the buffered WAV
    /// answered back byte-identical, and a refusal the "Naru's voice"
    /// sentence naming the pull command.
    #[test]
    fn design_sends_instructions_unstreamed_and_returns_the_whole_wav() {
        let _prober = prober_lock();
        let stub = Stub::serve(0, |method, path| {
            assert_eq!((method, path), ("POST", SPEECH_PATH));
            stub::Reply::Json(200, "RIFF-designed".to_string())
        });
        let got = design(&stub.url(), "vd", "Hello.", "A warm, low voice.");
        assert_eq!(got.as_deref(), Ok(&b"RIFF-designed"[..]));
        assert_eq!(
            stub.requests.lock().unwrap()[0],
            r#"POST /v1/audio/speech {"input":"Hello.","instructions":"A warm, low voice.","model":"vd","response_format":"wav","stream":false}"#
        );

        let missing = Stub::serve(0, |_, _| {
            stub::Reply::Json(
                409,
                r#"{"error":{"message":"the model \"vd\" is not pulled","type":"x","code":"model_not_pulled","param":"model"}}"#
                    .to_string(),
            )
        });
        assert_eq!(
            design(&missing.url(), "vd", "Hello.", "A warm, low voice."),
            Err(
                "Naru's voice isn't available: the model vd isn't downloaded. \
                 Run `naru-audio pull vd`."
                    .to_string()
            )
        );
    }

    /// Only a **pulled** text-to-speech model is reported by
    /// `pulled_tts_models`, asked with `?pulled=true`.
    #[test]
    fn pulled_tts_models_asks_for_pulled_models_only() {
        let stub = Stub::serve(0, |_, path| {
            assert_eq!(path, "/v1/models?pulled=true");
            stub::Reply::Json(
                200,
                r#"{"data":[{"id":"vd","x_kind":"tts"},{"id":"ears","x_kind":"stt"}]}"#.to_string(),
            )
        });
        assert_eq!(pulled_tts_models(&stub.url()), vec!["vd"]);
    }

    /// Silence is the daemon's 200 `{"text":""}`, and a success.
    #[test]
    fn a_silent_recording_is_an_empty_transcript() {
        let _prober = prober_lock();
        let stub = transcriber(200, r#"{"text":"","segments":[]}"#);
        assert_eq!(
            transcribe(&stub.url(), b"RIFF", "default"),
            Ok(String::new())
        );
    }

    #[test]
    fn a_stopped_daemon_is_daemon_down() {
        let _prober = prober_lock();
        let other = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", other.local_addr().unwrap().port());
        drop(other);
        assert_eq!(
            transcribe(&url, b"RIFF", "default"),
            Err(down_message(&url))
        );
        assert_eq!(
            speak(&url, "hi", None, None).err(),
            Some(format!(
                "Naru's voice isn't available: naru-audio isn't running at {url}. \
                 Start it with `brew services start naru-audio`."
            ))
        );
    }

    /// A 409 `model_not_pulled` is §4.4's `model_missing` sentence, naming
    /// the model the daemon quotes — the real name `default` resolved to. A
    /// 404 `model_not_found` is not: no `pull` fetches a model the catalog
    /// does not know, so it quotes the daemon's own catalog message.
    #[test]
    fn a_model_the_daemon_lacks_is_the_model_missing_sentence() {
        let _prober = prober_lock();
        let stub = transcriber(
            409,
            r#"{"error":{"message":"the model \"parakeet-tdt-0.6b-v2-int8\" is not pulled; run `naru-audio pull parakeet-tdt-0.6b-v2-int8`",
                "type":"invalid_request_error","code":"model_not_pulled","param":"model"}}"#,
        );
        assert_eq!(
            transcribe(&stub.url(), b"RIFF", "default"),
            Err(
                "Speech isn't available: the model parakeet-tdt-0.6b-v2-int8 isn't \
                 downloaded. Run `naru-audio pull parakeet-tdt-0.6b-v2-int8`."
                    .to_string()
            )
        );
        let stub = transcriber(
            404,
            r#"{"error":{"message":"the model \"zz-nobody\" is not in the catalog; see GET /v1/models","code":"model_not_found"}}"#,
        );
        assert_eq!(
            transcribe(&stub.url(), b"RIFF", "zz-nobody"),
            Err(
                "Speech isn't available: naru-audio reported: the model \"zz-nobody\" \
                 is not in the catalog; see GET /v1/models"
                    .to_string()
            )
        );
    }

    /// Anything else quotes the daemon, or names the status when there is no
    /// envelope to quote.
    #[test]
    fn other_failures_quote_the_daemon() {
        let _prober = prober_lock();
        let stub = transcriber(
            415,
            r#"{"error":{"message":"the audio is not WAV","code":"unsupported_media_type"}}"#,
        );
        assert_eq!(
            transcribe(&stub.url(), b"OggS", "default"),
            Err("Speech isn't available: naru-audio reported: the audio is not WAV".to_string())
        );
        let stub = transcriber(502, "<html>bad gateway</html>");
        assert_eq!(
            transcribe(&stub.url(), b"RIFF", "default"),
            Err("Speech isn't available: naru-audio reported: \
                 /v1/audio/transcriptions answered HTTP 502"
                .to_string())
        );
        let stub = Stub::serve(0, |_, _| {
            stub::Reply::Json(
                413,
                r#"{"error":{"message":"input is 16385 characters; the cap is 16384","code":"payload_too_large"}}"#
                    .to_string(),
            )
        });
        assert_eq!(
            speak(&stub.url(), "long", None, None).err().as_deref(),
            Some(
                "Naru's voice isn't available: naru-audio reported: input is 16385 \
                 characters; the cap is 16384"
            )
        );
    }

    /// Serializes the tests that touch the process-wide [`PROBER`] — every
    /// failed `transcribe`/`speak` drops it — with each other and with the
    /// `listen`/`api` tests that probe through it, so
    /// [`a_failed_request_drops_the_cached_probe`] cannot pass on someone
    /// else's invalidation.
    fn prober_lock() -> std::sync::MutexGuard<'static, ()> {
        crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// A failed request drops a cached `ready`, so the next probe asks.
    #[test]
    fn a_failed_request_drops_the_cached_probe() {
        let _prober = prober_lock();
        let stub = transcriber(500, "{}");
        let cached = |fresh: AudioState| {
            PROBER
                .cache
                .get(
                    &stub.url(),
                    Instant::now(),
                    |_| READY_TTL,
                    || Probe {
                        state: fresh,
                        message: None,
                        url: stub.url(),
                        checked_at: String::new(),
                    },
                )
                .0
                .state
        };
        assert_eq!(cached(AudioState::Ready), AudioState::Ready);
        // Control: inside its TTL the entry stands, nothing refetched.
        assert_eq!(cached(AudioState::Error), AudioState::Ready);
        let _ = transcribe(&stub.url(), b"RIFF", "default");
        assert_eq!(
            cached(AudioState::Error),
            AudioState::Error,
            "the cached ready was dropped, so this get fetched"
        );
    }

    /// The model list is the daemon's speech-to-text entries; a daemon that
    /// is down, or answers something else, is an empty list.
    #[test]
    fn the_lists_are_the_daemons_and_empty_when_it_cannot_be_asked() {
        let stub = Stub::serve(0, |_, path| {
            stub::Reply::Json(
                200,
                match path {
                    MODELS_PATH => {
                        r#"{"object":"list","data":[
                        {"id":"parakeet-tdt-0.6b-v2-int8","x_kind":"stt","x_pulled":true},
                        {"id":"whisper-small","x_kind":"stt","x_pulled":false},
                        {"id":"kokoro-v1.0","x_kind":"tts"}]}"#
                    }
                    VOICES_PATH => {
                        r#"{"model":"kokoro-v1.0","voices":[{"id":"af_heart"},{"id":"bm_george"}]}"#
                    }
                    "/v1/audio/voices?model=pocket-tts-int8" => {
                        r#"{"model":"pocket-tts-int8","voices":[{"id":"alba","cloned":false},{"id":"amy","cloned":true}]}"#
                    }
                    _ => "{}",
                }
                .to_string(),
            )
        });
        assert_eq!(
            stt_models(&stub.url()),
            vec!["parakeet-tdt-0.6b-v2-int8", "whisper-small"]
        );
        assert_eq!(tts_models(&stub.url()), vec!["kokoro-v1.0"]);
        let voice = |id: &str, cloned| DaemonVoice {
            id: id.to_string(),
            cloned,
        };
        assert_eq!(
            voices(&stub.url(), None),
            vec![voice("af_heart", false), voice("bm_george", false)],
            "an older daemon's entries, with no `cloned`, read as not cloned"
        );
        assert_eq!(
            voices(&stub.url(), Some("pocket-tts-int8")),
            vec![voice("alba", false), voice("amy", true)]
        );
        let junk = Stub::start(0, "<html>");
        assert!(stt_models(&junk.url()).is_empty());
        assert!(tts_models(&junk.url()).is_empty());
        assert!(voices(&junk.url(), None).is_empty());
    }
}
