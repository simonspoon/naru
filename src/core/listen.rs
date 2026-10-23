//! Transcribing recorded audio through the naru-audio daemon. This is the
//! mirror of `speech.rs` — `speech.rs` turns Naru text into audio for a
//! browser to play; this turns audio a browser recorded into text Naru can
//! use. [`transcribe`] posts the recording to the daemon's
//! `/v1/audio/transcriptions` and [`models`] reads its list.
//!
//! Unlike `speech::start`, this does **not** stream a channel back to the
//! caller: a transcript is one short string, produced only once the whole
//! recording has been decoded, so there is nothing earlier to hand back.
//!
//! **Nothing here is retained** (`docs/listen.md`, mesa task 930): the audio
//! is transcribed and dropped. It is never written to `live_turns` (which has
//! no column for it), never written to disk, and never logged.

use std::time::Instant;

use serde::Serialize;
use ts_rs::TS;

use crate::core::audio::{self, AudioState, TtlCache};
use crate::core::config;

/// The most models [`models`] will report — a bound so a wrong service on the
/// daemon's port cannot fill a dropdown, or the JSON a caller reads, with its
/// output. Small on purpose: Naru has no reason to expect more than a handful
/// of local models.
const MAX_MODELS: usize = 50;

/// The speech-to-text model names the naru-audio daemon offers
/// ([`audio::stt_models`]), filtered by [`is_model_name`] and bounded.
///
/// Empty when the daemon cannot be asked: an empty list means "Naru could not
/// ask", never "there are none". Callers must treat it as advisory.
///
/// Cached with a TTL ([`audio::TtlCache`]): 10 s for a non-empty answer, 2 s
/// for an empty one, keyed on the daemon's URL, so a daemon started while
/// `serve` runs is noticed without a restart.
pub fn models() -> Vec<String> {
    static MODELS: TtlCache<Vec<String>> = TtlCache::new();
    let Some(url) = audio::daemon_url() else {
        return Vec::new();
    };
    MODELS
        .get(
            &url,
            Instant::now(),
            |v| audio::list_ttl(v),
            || {
                audio::stt_models(&url)
                    .into_iter()
                    .filter(|m| is_model_name(m))
                    .take(MAX_MODELS)
                    .collect()
            },
        )
        .0
}

/// What the Settings page needs to say whether the vocabulary is used (naru
/// task 1754): the daemon's speech-to-text models whose backend decodes
/// hotwords, and its default speech-to-text model. Empty/`None` when the
/// daemon cannot be asked. Cached like [`models`].
pub fn hotword_support() -> (Vec<String>, Option<String>) {
    static CAPS: TtlCache<Vec<audio::SttCaps>> = TtlCache::new();
    let Some(url) = audio::daemon_url() else {
        return (Vec::new(), None);
    };
    let (caps, _) = CAPS.get(
        &url,
        Instant::now(),
        |v| audio::list_ttl(v),
        || audio::stt_model_caps(&url),
    );
    let default = caps.iter().find(|c| c.default).map(|c| c.id.clone());
    let hot = caps
        .into_iter()
        .filter(|c| c.hotwords)
        .map(|c| c.id)
        .collect();
    (hot, default)
}

/// Who offers the names [`models`] lists, for a sentence naming it.
pub fn models_offered_by() -> String {
    "naru-audio".to_string()
}

/// What `GET /api/live/transcribe` answers (mesa task 1388): whether the
/// server's speech-to-text engine is ready, and if not, the sentence the
/// page shows the person. `available` is `state == "ready"` — whether the
/// POST can decode — kept for clients that only read it.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../frontend/src/types/")]
pub struct TranscribeStatus {
    pub available: bool,
    pub state: AudioState,
    /// Always `"naru-audio"`.
    pub engine: &'static str,
    /// The daemon's URL.
    pub url: Option<String>,
    /// `null` when ready.
    pub message: Option<String>,
    /// When the (cached) answer was taken, RFC 3339 UTC.
    pub checked_at: String,
    /// The daemon is older than `audio::MIN_NARU_AUDIO_VERSION` or reports
    /// no version (naru task 2282): the sentence to show. A warning only —
    /// `available` and `state` are unaffected. `null` when new enough or
    /// when nothing answered.
    pub version_warning: Option<String>,
}

/// Asks the naru-audio daemon whether it can transcribe ([`audio::probe`]);
/// `available` is its `ready`, since the POST goes to the daemon. `fresh`
/// (the live banner's Retry, mesa task 1408) drops the cached probe first, so
/// a daemon started within [`audio::FAILURE_TTL`] of a down answer is seen at
/// once. Blocking. `Err` only for a config file that cannot be read.
pub fn status(fresh: bool) -> Result<TranscribeStatus, String> {
    if fresh {
        audio::invalidate();
    }
    let probe = audio::probe(&config::audio_url()?);
    Ok(TranscribeStatus {
        available: probe.state == AudioState::Ready,
        state: probe.state,
        engine: "naru-audio",
        url: Some(probe.url),
        message: probe.message,
        checked_at: probe.checked_at,
        version_warning: probe.version_warning,
    })
}

/// Whether `name` is shaped like a model name: a bounded identifier that
/// cannot be mistaken for an option. Mirrors `speech::is_voice_name`, with
/// one deliberate difference — `.` is accepted as an interior character.
/// the default model is named `parakeet-tdt-0.6b-v2-int8`, which
/// contains a `.`; `is_voice_name`'s rule would filter it straight out
/// . Every other property is unchanged: non-empty, <= 64 chars, must
/// start with an ASCII alphanumeric (so it can never be read as an option),
/// otherwise only ASCII alphanumerics, `_`, `-`, `.`.
pub fn is_model_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Transcribes `audio` (a whole WAV recording) through the naru-audio daemon
/// ([`audio::transcribe`], mesa task 1389) with `model` or `default`.
///
/// **Silence is a success** (design §2.2): nothing transcribed is the
/// daemon's 200 `{"text":""}`, `Ok("")`, so the route answers 200
/// `{"text":""}` rather than a 503. Every other failure is `Err`, which the
/// caller maps to 503 `unavailable`.
///
/// Blocking: call it from `spawn_blocking`, not an async worker.
pub fn transcribe(
    audio: &[u8],
    model: Option<&str>,
    hotwords: Option<&str>,
) -> Result<String, String> {
    let Some(url) = audio::daemon_url() else {
        return Err(
            "the naru-audio daemon's address could not be read from the config".to_string(),
        );
    };
    audio::transcribe(&url, audio, model.unwrap_or("default"), hotwords)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// `MESA_CONFIG_FILE` and the audio URL env vars are process-global and
    /// cargo runs tests in parallel, so every test that sets them must not
    /// race another. Poisoning must not wedge the others — `unwrap_or_else`
    /// recovers the guard.
    static ENV: Mutex<()> = Mutex::new(());

    /// The locks every test pointing Naru at a stub daemon holds. The config
    /// pin is removed again when dropped.
    struct Pinned {
        _config: std::sync::MutexGuard<'static, ()>,
        _env: std::sync::MutexGuard<'static, ()>,
    }

    impl Drop for Pinned {
        fn drop(&mut self) {
            // SAFETY: both locks are still held; fields drop after this.
            unsafe { std::env::remove_var("MESA_CONFIG_FILE") };
        }
    }

    fn pinned() -> Pinned {
        let config = crate::core::attachments::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let env = ENV.lock().unwrap_or_else(|e| e.into_inner());
        Pinned {
            _config: config,
            _env: env,
        }
    }

    /// The shape rule is what keeps a stored model name from ever being read
    /// as an option, and what filters a daemon model list that isn't names. Mirrors `speech::tests::voice_names_are_bounded_identifiers`.
    #[test]
    fn model_names_are_bounded_identifiers() {
        assert!(is_model_name("parakeet-tdt-0.6b-v2-int8"));
        for bad in ["", "-o", &"a".repeat(65), "a b", "a/b", "a;rm -rf /"] {
            assert!(!is_model_name(bad), "{bad:?} is not a model name");
        }
    }

    /// `available` follows the daemon's probe (mesa task 1389: the POST goes
    /// to the daemon).
    #[test]
    fn status_available_follows_the_probe() {
        let _guard = pinned();
        let dir = tempfile::tempdir().expect("tempdir");
        let daemon = audio::stub::Stub::serve(0, |_, path| {
            audio::stub::Reply::Json(
                200,
                match path {
                    "/health" => {
                        r#"{"status":"ok","version":"0.1.0","api":1,
                        "stt":{"default":"parakeet-tdt-0.6b-v2-int8","ready":true}}"#
                    }
                    "/v1/models" => {
                        r#"{"object":"list","data":[
                        {"id":"parakeet-tdt-0.6b-v2-int8","x_kind":"stt"},
                        {"id":"kokoro-v1.0","x_kind":"tts"},
                        {"id":"silero-vad","x_kind":"vad"}]}"#
                    }
                    _ => r#"{"text":"from the daemon"}"#,
                }
                .to_string(),
            )
        });
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let down = format!("http://127.0.0.1:{}", dead.local_addr().unwrap().port());
        drop(dead);
        let config = dir.path().join("config.json");
        let engine = |url: &str| {
            std::fs::write(
                &config,
                format!(r#"{{"audio": {{"engine": "naru-audio", "url": "{url}"}}}}"#),
            )
            .unwrap();
            audio::invalidate();
        };
        // SAFETY: `pinned()` holds both locks serializing these vars.
        unsafe {
            std::env::remove_var("NARU_AUDIO_URL");
            std::env::remove_var("MESA_AUDIO_URL");
            std::env::set_var("MESA_CONFIG_FILE", &config);
        }
        engine(&down);
        let stopped = status(false).unwrap();
        engine(&daemon.url());
        let ready = status(false).unwrap();
        let listed = models();
        let heard = transcribe(b"RIFF", None, None);

        assert_eq!(stopped.state, AudioState::DaemonDown);
        assert!(!stopped.available, "a stopped daemon cannot decode");
        assert_eq!(stopped.url.as_deref(), Some(down.as_str()));
        assert!(stopped.message.is_some());
        assert_eq!(ready.state, AudioState::Ready);
        assert!(ready.available);
        assert_eq!(ready.engine, "naru-audio");
        assert_eq!(listed, vec!["parakeet-tdt-0.6b-v2-int8"], "stt models only");
        assert_eq!(heard, Ok("from the daemon".to_string()));
    }

    /// The live banner's Retry (mesa task 1408): an ordinary `status` serves
    /// a `daemon_down` answer from the cache for [`audio::FAILURE_TTL`] even
    /// though the daemon has since started, while `status(true)` asks it
    /// again and sees `ready`.
    #[test]
    fn a_fresh_status_re_probes_a_daemon_the_cache_still_calls_down() {
        let _guard = pinned();
        let dir = tempfile::tempdir().expect("tempdir");
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = dead.local_addr().unwrap().port();
        drop(dead);
        let url = format!("http://127.0.0.1:{port}");
        let config = dir.path().join("config.json");
        std::fs::write(
            &config,
            format!(r#"{{"audio": {{"engine": "naru-audio", "url": "{url}"}}}}"#),
        )
        .unwrap();
        // SAFETY: `pinned()` holds both locks serializing these vars.
        unsafe {
            std::env::remove_var("NARU_AUDIO_URL");
            std::env::remove_var("MESA_AUDIO_URL");
            std::env::set_var("MESA_CONFIG_FILE", &config);
        }
        audio::invalidate();
        assert_eq!(status(false).unwrap().state, AudioState::DaemonDown);

        let daemon = audio::stub::Stub::start(
            port,
            r#"{"status":"ok","version":"0.1.0","api":1,
            "stt":{"default":"parakeet-tdt-0.6b-v2-int8","ready":true}}"#,
        );
        let cached = status(false).unwrap();
        let fresh = status(true).unwrap();
        drop(daemon);

        assert_eq!(cached.state, AudioState::DaemonDown, "served from cache");
        assert_eq!(fresh.state, AudioState::Ready, "asked the daemon again");
        assert!(fresh.available);
    }
}
