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
    format!(
        "Speech isn't available: naru-audio isn't running at {url}. \
         Start it with `brew services start naru-audio`."
    )
}

fn error_message(reported: &str) -> String {
    format!("Speech isn't available: naru-audio reported: {reported}")
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

    /// An HTTP stub: `POST /api/load` gets `load` (status, body), every other
    /// request `body` with a 200. Each request is recorded as
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
                    let (status, answer) = if method == "POST" && path == "/api/load" {
                        load
                    } else {
                        (200, body)
                    };
                    let _ = write!(
                        conn,
                        "HTTP/1.1 {status} Stub\r\nContent-Type: application/json\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                        answer.len()
                    );
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
}
