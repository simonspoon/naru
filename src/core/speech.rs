//! Speaking a piece of Naru text through the naru-audio daemon. This is the
//! **output** half of Naru's speech; `core::listen` is its mirror, taking a
//! browser's recording in and handing text back.
//!
//! Audio comes back as bytes rather than being played on the host: the browser
//! that asked is the thing that should make noise, and under `serve --lan` the
//! host is a different machine entirely. [`start`] streams the daemon's
//! `/v1/audio/speech` WAV and [`voices`] reads its list; a refusal or a daemon
//! that is down is an `Err` the API answers `unavailable` with.
//!
//! The audio is **streamed, not collected**: the daemon synthesises sentence
//! by sentence, so a minute-long item starts playing after the first few
//! seconds. [`start`] blocks only until the audio has started and hands back a
//! channel the rest arrives on.

use std::io::Read;
use std::time::Instant;

use tokio::sync::mpsc;

use crate::core::audio::{self, TtlCache};
use crate::core::types::{AddedVoice, VoiceDesign, VoiceExport};

/// Bytes read from the daemon per chunk. Chunks are the unit the response
/// body is written in, so this trades syscalls against how promptly the first
/// audio reaches the browser.
const CHUNK: usize = 16 * 1024;

/// How many chunks may sit in the channel before the reader thread blocks.
/// Small on purpose: the backlog is memory, and a client that stopped
/// listening should stall the pipe rather than buffer a whole render.
const BACKLOG: usize = 8;

/// The most voices [`voices`] will report — a bound so a wrong service on the
/// daemon's port cannot fill a dropdown, and the JSON every Settings load
/// carries, with its output.
const MAX_VOICES: usize = 500;

/// The voice names the naru-audio daemon offers ([`audio::voices`], read from
/// the model's manifest) for `model` (the daemon's default text-to-speech
/// model when `None`), filtered by [`is_voice_name`] and bounded.
///
/// Empty when the daemon cannot be asked: an empty list means "Naru cannot
/// offer a choice here", never "there are no voices". Callers must treat it as
/// advisory — [`start`] passes whatever voice it is given.
///
/// Cached with a TTL ([`audio::TtlCache`]): 10 s for a non-empty answer, 2 s
/// for an empty one, keyed on the daemon's URL and model.
pub fn voices(model: Option<&str>) -> Vec<String> {
    voice_list(model).into_iter().map(|v| v.id).collect()
}

/// [`voices`]' list with each voice's `cloned` flag (mesa task 1430) —
/// whether naru-audio can export it — cached as described there. A daemon too
/// old to say reports none as cloned.
pub fn voice_list(model: Option<&str>) -> Vec<audio::DaemonVoice> {
    let Some(url) = audio::daemon_url() else {
        return Vec::new();
    };
    let key = format!("{url} {}", model.unwrap_or_default());
    VOICES
        .get(
            &key,
            Instant::now(),
            |v| audio::list_ttl(v),
            || {
                audio::voices(&url, model)
                    .into_iter()
                    .filter(|v| is_voice_name(&v.id))
                    .take(MAX_VOICES)
                    .collect()
            },
        )
        .0
}

/// [`voices`]' cache, module-level so [`add_voice`] can drop it.
static VOICES: TtlCache<Vec<audio::DaemonVoice>> = TtlCache::new();

/// Why a cloned voice was not added (mesa task 1418), each with the sentence
/// to show.
#[derive(Debug, PartialEq)]
pub enum AddVoiceError {
    /// The engine is not naru-audio, or the name is taken.
    Conflict(String),
    /// A name, model, clip or transcript Naru or the daemon will not take.
    Validation(String),
    /// The daemon did not answer usably.
    Unavailable(String),
}

/// Adds the cloned voice `name` to the naru-audio daemon from `clip` and its
/// transcript `text`, for `model` (mesa task 1418, [`audio::add_voice`];
/// `model` mesa task 1455 — `None` lets the daemon fall back to its own
/// default, `CLONE_MODEL`). `name` must pass [`is_voice_name`] —
/// the daemon would take more, but [`voices`] filters on that rule, so a
/// looser name would be added and never offered; `model`, when given, must
/// pass [`crate::core::listen::is_model_name`]. `text` is required only when
/// `model`'s manifest actually needs a transcript
/// ([`crate::core::config::model_caps`]'s `clone_requires_transcript`, mesa
/// task 1455) — a model with no `model` named is checked against
/// naru-audio's default, since that is what the daemon will use. On success
/// the voice cache is dropped, so the next list asks the daemon, and the
/// answer names the text-to-speech models that now list the voice — only a
/// cloning model does, so the page can say which to pick. Blocking.
pub fn add_voice(
    name: &str,
    text: &str,
    clip: &[u8],
    model: Option<&str>,
) -> Result<AddedVoice, AddVoiceError> {
    let Some(url) = audio::daemon_url() else {
        return Err(AddVoiceError::Conflict(
            "adding a cloned voice needs the naru-audio daemon's address, \
             and the config could not be read"
                .to_string(),
        ));
    };
    if !is_voice_name(name) {
        return Err(AddVoiceError::Validation(format!(
            "voice name {name:?} must be 1-64 letters, digits, '_' or '-', starting with a letter or digit"
        )));
    }
    if let Some(model) = model
        && !crate::core::listen::is_model_name(model)
    {
        return Err(AddVoiceError::Validation(format!(
            "model {model:?} is not a model name: up to 64 letters, digits, \
             underscores, dashes and dots, starting with a letter or digit"
        )));
    }
    let requires_transcript = caps_at(&url)
        .iter()
        .find(|m| Some(m.model.as_str()) == model || (model.is_none() && m.default))
        .is_none_or(|m| m.clone_requires_transcript);
    if requires_transcript && text.trim().is_empty() {
        return Err(AddVoiceError::Validation(
            "the transcript must not be empty".to_string(),
        ));
    }
    let duration = audio::add_voice(&url, name, text.trim(), clip, model).map_err(|e| match e {
        audio::AddVoiceError::Exists(m) => AddVoiceError::Conflict(m),
        audio::AddVoiceError::Rejected(m) => AddVoiceError::Validation(m),
        audio::AddVoiceError::Unavailable(m) => AddVoiceError::Unavailable(m),
    })?;
    VOICES.invalidate();
    let models = audio::tts_models(&url)
        .into_iter()
        .filter(|m| crate::core::listen::is_model_name(m))
        .take(MAX_MODELS)
        .filter(|m| audio::voices(&url, Some(m)).iter().any(|v| v.id == name))
        .collect();
    Ok(AddedVoice {
        voice: name.to_string(),
        duration,
        models,
    })
}

/// The file format a cloned voice is exported in (mesa task 1430,
/// `docs/config.md`): the `format` tag and the `version` this Naru writes
/// and reads.
pub const VOICE_EXPORT_FORMAT: &str = "naru-voice";
pub const VOICE_EXPORT_VERSION: u32 = 1;

/// Why a cloned voice was not exported (mesa task 1430), each with the
/// sentence to show.
#[derive(Debug, PartialEq)]
pub enum ExportVoiceError {
    /// The engine is not naru-audio.
    Conflict(String),
    /// A name that is not a voice name.
    Validation(String),
    /// No cloned voice of that name.
    NotFound(String),
    /// The daemon did not answer usably.
    Unavailable(String),
}

/// Exports the cloned voice `name` from the naru-audio daemon as a
/// [`VoiceExport`] file (mesa task 1430, [`audio::export_voice`]): the clip
/// byte for byte as base64 and its transcript, tagged with
/// [`VOICE_EXPORT_FORMAT`] and [`VOICE_EXPORT_VERSION`] so another Naru —
/// perhaps another version — can tell what it holds. Importing it is the
/// ordinary [`add_voice`]. Only on `audio.engine = "naru-audio"`; `name`
/// must pass [`is_voice_name`], which is also what keeps it a single path
/// segment in the daemon's URL. Blocking.
pub fn export_voice(name: &str) -> Result<VoiceExport, ExportVoiceError> {
    let Some(url) = audio::daemon_url() else {
        return Err(ExportVoiceError::Conflict(
            "exporting a cloned voice needs the naru-audio daemon's address, \
             and the config could not be read"
                .to_string(),
        ));
    };
    if !is_voice_name(name) {
        return Err(ExportVoiceError::Validation(format!(
            "voice name {name:?} must be 1-64 letters, digits, '_' or '-', starting with a letter or digit"
        )));
    }
    let voice = audio::export_voice(&url, name).map_err(|e| match e {
        audio::ExportVoiceError::NotFound(m) => ExportVoiceError::NotFound(m),
        audio::ExportVoiceError::Rejected(m) => ExportVoiceError::Validation(m),
        audio::ExportVoiceError::Unavailable(m) => ExportVoiceError::Unavailable(m),
    })?;
    Ok(VoiceExport {
        format: VOICE_EXPORT_FORMAT.to_string(),
        version: VOICE_EXPORT_VERSION,
        name: voice.name,
        text: voice.text,
        wav_base64: voice.wav_base64,
        model: (!voice.model.is_empty()).then_some(voice.model),
    })
}

/// The short line a described voice is auditioned on — the same sentence
/// [`SAMPLE`] previews a saved voice with, for the same reason: the design
/// route takes no caller text, so this is Naru's own words too, and one
/// preview line is one less sentence to keep in sync.
pub const DESIGN_SAMPLE: &str = SAMPLE;

/// The script a kept design reads for the clone's reference clip — saved,
/// with the clip, as its exact transcript. Why it reads what it does is in
/// `docs/config.md`, "Designing a voice": a conversational read of about
/// 9–11 s, kept that short because the voice-design model drifts in pitch
/// over a longer read (mesa task 1429), and no digits or tags, so the
/// transcript is exactly what is spoken.
pub const DESIGN_REFERENCE: &str = "Good morning! I checked the schedule, and your first meeting \
     starts at nine, right after coffee. Would you like me to move the budget review to \
     Thursday instead?";

/// The longest voice description the design route takes, in characters.
pub const DESIGN_INSTRUCTIONS_MAX: usize = 500;

/// What the Settings page needs to offer voice design for `model` (mesa
/// task 1426; `model` mesa task 1455, replacing the hard-coded
/// `DESIGN_MODEL` — the editor now runs design on whichever model is
/// drafted, since only a model with both `design` and `clone` capabilities
/// is offered one): whether naru-audio has it pulled — always `false` when
/// Naru could not ask, or when `model` is blank — and
/// the two texts it reads. `model` is echoed back verbatim (blank if none
/// was named), for the `naru-audio pull` hint. Blocking.
pub fn design_info(model: &str) -> VoiceDesign {
    let available = !model.is_empty()
        && audio::daemon_url()
            .is_some_and(|url| audio::pulled_tts_models(&url).iter().any(|m| m == model));
    VoiceDesign {
        available,
        model: model.to_string(),
        sample: DESIGN_SAMPLE.to_string(),
        reference: DESIGN_REFERENCE.to_string(),
    }
}

/// Reads one of Naru's two design texts — `script` is `"sample"`
/// ([`DESIGN_SAMPLE`]) or `"reference"` ([`DESIGN_REFERENCE`]), never the
/// text itself — in a voice `model` makes up from `instructions`, and
/// answers the whole WAV (mesa task 1426, [`audio::design`]; `model` mesa
/// task 1455). The errors are [`add_voice`]'s: an unreadable config is
/// `Conflict`, a blank or over-long description, an unknown script or a
/// `model` that isn't a model name is `Validation`, and a daemon that
/// refuses or does not answer `Unavailable`. Blocking.
pub fn design(instructions: &str, script: &str, model: &str) -> Result<Vec<u8>, AddVoiceError> {
    let Some(url) = audio::daemon_url() else {
        return Err(AddVoiceError::Conflict(
            "designing a voice needs the naru-audio daemon's address, \
             and the config could not be read"
                .to_string(),
        ));
    };
    if !crate::core::listen::is_model_name(model) {
        return Err(AddVoiceError::Validation(format!(
            "model {model:?} is not a model name: up to 64 letters, digits, \
             underscores, dashes and dots, starting with a letter or digit"
        )));
    }
    let text = match script {
        "sample" => DESIGN_SAMPLE,
        "reference" => DESIGN_REFERENCE,
        other => {
            return Err(AddVoiceError::Validation(format!(
                "script {other:?} must be \"sample\" or \"reference\""
            )));
        }
    };
    let instructions = instructions.trim();
    if instructions.is_empty() {
        return Err(AddVoiceError::Validation(
            "the voice description must not be empty".to_string(),
        ));
    }
    let chars = instructions.chars().count();
    if chars > DESIGN_INSTRUCTIONS_MAX {
        return Err(AddVoiceError::Validation(format!(
            "the voice description must be at most {DESIGN_INSTRUCTIONS_MAX} characters, got {chars}"
        )));
    }
    audio::design(&url, model, text, instructions).map_err(AddVoiceError::Unavailable)
}

/// The most text-to-speech models [`models`] will report — the bound
/// `listen::MAX_MODELS` sets for the recognizer, for the same reason.
const MAX_MODELS: usize = 50;

/// The text-to-speech models the naru-audio daemon offers (`GET /v1/models`,
/// `x_kind == "tts"`, mesa task 1425), so the Settings page can pick one
/// beside the voice. Empty means "Naru could
/// not ask", as for [`voices`]; cached the same way, keyed on the daemon URL.
pub fn models() -> Vec<String> {
    static MODELS: TtlCache<Vec<String>> = TtlCache::new();
    let Some(url) = audio::daemon_url() else {
        return Vec::new();
    };
    MODELS
        .get(
            &url,
            Instant::now(),
            |m| audio::list_ttl(m),
            || {
                audio::tts_models(&url)
                    .into_iter()
                    .filter(|m| crate::core::listen::is_model_name(m))
                    .take(MAX_MODELS)
                    .collect()
            },
        )
        .0
}

/// [`models`]' capabilities (mesa task 1455) — which of the voice dropdown,
/// the clone form and the design panel each of [`models`]' models supports,
/// plus which one is naru-audio's own default (`x_default`), so the editor
/// can resolve a blank drafted model to a concrete one. Empty wherever
/// [`models`] is. Cached the same way, keyed on the daemon URL.
pub fn model_caps() -> Vec<crate::core::types::SpeechModelCaps> {
    match audio::daemon_url() {
        Some(url) => caps_at(&url),
        None => Vec::new(),
    }
}

fn caps_at(url: &str) -> Vec<crate::core::types::SpeechModelCaps> {
    static CAPS: TtlCache<Vec<crate::core::types::SpeechModelCaps>> = TtlCache::new();
    CAPS.get(
        url,
        Instant::now(),
        |m| audio::list_ttl(m),
        || {
            audio::tts_model_caps(url)
                .into_iter()
                .filter(|m| crate::core::listen::is_model_name(&m.id))
                .take(MAX_MODELS)
                .map(|m| crate::core::types::SpeechModelCaps {
                    model: m.id,
                    default: m.default,
                    clone: m.clone,
                    clone_requires_transcript: m.clone_requires_transcript,
                    design: m.design,
                })
                .collect()
        },
    )
    .0
}

/// Who offers the names [`voices`] lists, for a sentence naming it.
pub fn voices_offered_by() -> String {
    "naru-audio".to_string()
}

/// Whether `name` is shaped like a voice: a bounded identifier that cannot be
/// mistaken for an option. The one spelling of the rule, shared by the
/// `--list-voices` filter above and the config editor's save-time check
/// (`core::config::validate_voice`), so mesa can never store a name it would
/// then refuse to recognise.
pub fn is_voice_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The sentence the Settings page's voice **test** button speaks (mesa task
/// 824), so a voice can be heard before it is saved. Mesa's own words, not
/// anything a user or agent wrote: this is the one text on this path that is
/// not a mesa record, and keeping it a constant is what makes the preview route
/// carry no caller-supplied body at all. Short on purpose — it is a sample, and
/// every sentence is seconds of synthesis.
pub const SAMPLE: &str =
    "I found the bug, fixed the test, and — would you believe it — the coffee is still warm.";

/// A synthesis in flight: WAV bytes in the order they must be written, the
/// first chunk being the (size-patched) header. An `Err` item is a read that
/// failed mid-render, which ends the response body abnormally rather than
/// passing truncated audio off as complete.
pub struct Speech {
    pub chunks: mpsc::Receiver<Result<Vec<u8>, std::io::Error>>,
}

/// Starts synthesising `text` in `voice` (and `model`; `None` is the daemon's
/// default) through the naru-audio daemon ([`audio::speak`]). Blocks only
/// until the audio has started, and streams it from there. `Err` is a
/// synthesiser that produced no usable audio — the one failure the caller can
/// still turn into a status code.
///
/// The daemon writes the streamed-WAV sizes itself (`0x7fff0000`, design
/// §2.3), so its bytes are relayed untouched; a stream it aborts after the
/// first byte arrives here as a read error, which ends the channel with an
/// `Err`.
///
/// Blocking: call it from `spawn_blocking`, not an async worker.
pub fn start(text: &str, voice: Option<&str>, model: Option<&str>) -> Result<Speech, String> {
    let Some(url) = audio::daemon_url() else {
        return Err(
            "the naru-audio daemon's address could not be read from the config".to_string(),
        );
    };
    let body = audio::speak(&url, text, voice, model)?;
    Ok(Speech {
        chunks: relay(body),
    })
}

/// Relays the daemon's streamed WAV into a channel, chunk by chunk. A read
/// error — the daemon aborting the body (design §2.3) — is sent as the last
/// item, so the response ends abnormally instead of passing a truncated WAV
/// off as complete, and drops the cached probe (design §4.4). A listener
/// that goes away ends the relay: dropping the body closes the connection,
/// which is how the daemon learns to stop synthesising (no pipe here can
/// fill and wedge a child, unlike [`stream`]).
fn relay(mut body: impl Read + Send + 'static) -> mpsc::Receiver<Result<Vec<u8>, std::io::Error>> {
    let (tx, rx) = mpsc::channel(BACKLOG);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match body.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    audio::invalidate();
                    let _ = tx.blocking_send(Err(e));
                    break;
                }
            }
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// `MESA_CONFIG_FILE` and the audio URL env vars are process-global and
    /// cargo runs tests in parallel, so every test that sets them must not
    /// race another.
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

    /// A streaming WAV header (placeholder sizes) plus `n` bytes of audio.
    fn streaming_wav(n: usize) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&[0xff; 4]);
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&[1, 0, 1, 0]); // PCM, mono
        v.extend_from_slice(&24000u32.to_le_bytes());
        v.extend_from_slice(&48000u32.to_le_bytes());
        v.extend_from_slice(&[2, 0, 16, 0]);
        v.extend_from_slice(b"data");
        v.extend_from_slice(&[0xff; 4]);
        v.extend(std::iter::repeat_n(0u8, n));
        v
    }

    /// The shape rule is what keeps a stored voice from ever being read as an
    /// option, and what filters a daemon voice list that isn't names.
    #[test]
    fn voice_names_are_bounded_identifiers() {
        for good in ["af_heart", "bm_george", "zf_xiaoni", "v2", "a"] {
            assert!(is_voice_name(good), "{good} is a voice name");
        }
        for bad in [
            "",
            "-o",
            "_leading",
            "af heart",
            "af/heart",
            "af_heart;rm -rf /",
            &"a".repeat(65),
        ] {
            assert!(!is_voice_name(bad), "{bad:?} is not a voice name");
        }
    }

    /// `start` speaks through the daemon: the request carries the text, `default` and
    /// `wav` and no voice when none is configured; audio the daemon sends
    /// before aborting its chunked body arrives first, byte-identical, and
    /// the abort ends the channel with an `Err` rather than a clean end; a
    /// refusal before the first byte is §4.4's "Naru's voice" sentence; and
    /// `voices` is the daemon's list.
    #[test]
    fn naru_audio_streams_the_daemon_and_an_abort_ends_in_an_error() {
        let _guard = pinned();
        let dir = tempfile::tempdir().expect("tempdir");
        let audio_bytes = streaming_wav(64);
        let sent = audio_bytes.clone();
        let daemon = audio::stub::Stub::serve(0, move |_, path| match path {
            "/v1/audio/voices" => audio::stub::Reply::Json(
                200,
                r#"{"model":"kokoro-v1.0","voices":[{"id":"af_heart","default":true},
                    {"id":"bm_george"},{"id":"-not-a-name"}]}"#
                    .to_string(),
            ),
            "/v1/audio/voices?model=pocket-tts-int8" => audio::stub::Reply::Json(
                200,
                r#"{"model":"pocket-tts-int8","voices":[{"id":"alba"}]}"#.to_string(),
            ),
            "/v1/models" => audio::stub::Reply::Json(
                200,
                r#"{"object":"list","data":[{"id":"kokoro-v1.0","x_kind":"tts"},
                    {"id":"parakeet-tdt-0.6b-v2-int8","x_kind":"stt"},
                    {"id":"pocket-tts-int8","x_kind":"tts"}]}"#
                    .to_string(),
            ),
            _ => audio::stub::Reply::Aborted(sent.clone()),
        });
        let refusing = audio::stub::Stub::serve(0, |_, _| {
            audio::stub::Reply::Json(
                409,
                r#"{"error":{"message":"the model \"kokoro-v1.0\" is not pulled; run `naru-audio pull kokoro-v1.0`",
                    "type":"invalid_request_error","code":"model_not_pulled","param":"model"}}"#
                    .to_string(),
            )
        });
        let config = dir.path().join("config.json");
        let engine = |url: &str| {
            std::fs::write(
                &config,
                format!(r#"{{"audio": {{"engine": "naru-audio", "url": "{url}"}}}}"#),
            )
            .unwrap();
        };
        // SAFETY: `pinned()` holds both locks serializing these vars.
        unsafe {
            std::env::remove_var("NARU_AUDIO_URL");
            std::env::remove_var("MESA_AUDIO_URL");
            std::env::set_var("MESA_CONFIG_FILE", &config);
        }
        engine(&daemon.url());
        let mut speech = start("hello there", None, None).expect("the daemon answered 200");
        let mut got = Vec::new();
        let ending = loop {
            match speech.chunks.blocking_recv() {
                Some(Ok(chunk)) => got.extend_from_slice(&chunk),
                other => break other,
            }
        };
        let offered = voices(None);
        let offered_for_model = voices(Some("pocket-tts-int8"));
        let tts = models();
        // A chosen model rides on the request (mesa task 1425); the stub
        // aborts it, which is all this needs.
        let modelled = start("hello there", Some("alba"), Some("pocket-tts-int8")).map(|_| ());
        engine(&refusing.url());
        let refused = start("hello there", Some("af_heart"), None).err();

        assert_eq!(got, audio_bytes, "the audio before the abort, untouched");
        let err = ending.expect("an error item, not a clean end").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof, "{err}");
        assert_eq!(
            daemon.requests.lock().unwrap()[0],
            r#"POST /v1/audio/speech {"input":"hello there","model":"default","response_format":"wav"}"#
        );
        assert_eq!(offered, vec!["af_heart", "bm_george"]);
        assert_eq!(
            offered_for_model,
            vec!["alba"],
            "the voices follow the model"
        );
        assert_eq!(
            tts,
            vec!["kokoro-v1.0", "pocket-tts-int8"],
            "tts models only"
        );
        modelled.expect("the daemon answered 200");
        assert!(
            daemon
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|r| r.starts_with("POST /v1/audio/speech")
                    && r.contains(r#""model":"pocket-tts-int8""#)
                    && r.contains(r#""voice":"alba""#)),
            "a chosen model is sent"
        );
        assert_eq!(
            refused.as_deref(),
            Some(
                "Naru's voice isn't available: the model kokoro-v1.0 isn't downloaded. \
                 Run `naru-audio pull kokoro-v1.0`."
            )
        );
        assert!(
            refusing.requests.lock().unwrap()[0].contains(r#""voice":"af_heart""#),
            "a configured voice is sent"
        );
    }
}
