//! The speaker-enrollment recording (naru task 1744, `docs/voice-enrollment.md`).
//!
//! The browser records the person's voice; the server only **keeps the WAV**
//! beside the Naru Mac app's `ambient-enrollment.json`. The Mac app builds that
//! file from the WAV with its own FluidAudio code, so nothing here computes an
//! embedding, loads a model or holds a key.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use super::store::{Error, Result};
use super::types::{VoiceEnrollSample, VoiceEnrollment};

/// The recording's file name, beside the enrollment.
pub const SAMPLE_FILE: &str = "voice-sample.wav";
/// The Mac app's enrollment — a JSON `[Float]`. Read here for its mtime only.
pub const ENROLLMENT_FILE: &str = "ambient-enrollment.json";
/// Shortest and longest accepted recording, in seconds.
pub const MIN_SECONDS: f64 = 20.0;
pub const MAX_SECONDS: f64 = 300.0;
const SAMPLE_RATE: u32 = 16_000;
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// `NARU_VOICE_ENROLL_DIR` (the test seam), else the platform data dir +
/// `Naru` — `~/Library/Application Support/Naru` on a Mac, where the app
/// keeps `ambient-enrollment.json`.
pub fn enroll_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("NARU_VOICE_ENROLL_DIR").filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    directories::BaseDirs::new()
        .map(|d| d.data_dir().join("Naru"))
        .ok_or_else(|| Error::Unavailable("could not find this machine's data directory".into()))
}

/// Checks a WAV is 16 kHz mono 16-bit PCM of 20..=300 s and returns its
/// length in seconds.
pub fn validate_wav(wav: &[u8]) -> Result<f64> {
    let seconds = parse_wav(wav)?;
    if seconds < MIN_SECONDS {
        return Err(Error::Validation(format!(
            "the recording is {seconds:.1} s; at least {MIN_SECONDS:.0} s is needed"
        )));
    }
    if seconds > MAX_SECONDS {
        return Err(Error::Validation(format!(
            "the recording is {seconds:.1} s; at most {MAX_SECONDS:.0} s is allowed"
        )));
    }
    Ok(seconds)
}

/// Format check and length of a 16 kHz mono 16-bit PCM WAV, any duration.
fn parse_wav(wav: &[u8]) -> Result<f64> {
    let bad = |m: &str| Error::Validation(format!("the recording is not usable: {m}"));
    if wav.len() < 12 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err(bad("not a RIFF/WAVE file"));
    }
    let (mut fmt_ok, mut data_len) = (false, None);
    let mut pos = 12usize;
    while pos + 8 <= wav.len() {
        let id = &wav[pos..pos + 4];
        let size =
            u32::from_le_bytes([wav[pos + 4], wav[pos + 5], wav[pos + 6], wav[pos + 7]]) as usize;
        let body = pos + 8;
        if id == b"fmt " {
            if size < 16 || body + 16 > wav.len() {
                return Err(bad("truncated fmt chunk"));
            }
            let u16le = |o: usize| u16::from_le_bytes([wav[body + o], wav[body + o + 1]]);
            let rate =
                u32::from_le_bytes([wav[body + 4], wav[body + 5], wav[body + 6], wav[body + 7]]);
            if u16le(0) != 1 {
                return Err(bad("not PCM"));
            }
            if u16le(2) != 1 {
                return Err(bad("not mono"));
            }
            if rate != SAMPLE_RATE {
                return Err(bad("not 16000 Hz"));
            }
            if u16le(14) != 16 {
                return Err(bad("not 16-bit"));
            }
            fmt_ok = true;
        } else if id == b"data" {
            // A streamed header may claim more than arrived; trust the bytes.
            data_len = Some(size.min(wav.len() - body));
            break;
        }
        pos = body + size + (size & 1);
    }
    if !fmt_ok {
        return Err(bad("no fmt chunk"));
    }
    let data_len = data_len.ok_or_else(|| bad("no data chunk"))?;
    Ok(data_len as f64 / 2.0 / f64::from(SAMPLE_RATE))
}

/// Validates and saves the recording (temp file + rename, so a reader never
/// sees half a WAV), then answers the new status.
pub fn save(wav: &[u8]) -> Result<VoiceEnrollment> {
    save_in(&enroll_dir()?, wav)
}

fn save_in(dir: &Path, wav: &[u8]) -> Result<VoiceEnrollment> {
    validate_wav(wav)?;
    std::fs::create_dir_all(dir)?;
    // A name per call, so two concurrent saves never interleave in one file.
    let tmp = dir.join(format!(
        "{SAMPLE_FILE}.{}.{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(wav)?;
        f.sync_all()?;
        std::fs::rename(&tmp, dir.join(SAMPLE_FILE))
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    status_in(dir)
}

/// What is on disk now.
pub fn status() -> Result<VoiceEnrollment> {
    status_in(&enroll_dir()?)
}

fn status_in(dir: &Path) -> Result<VoiceEnrollment> {
    let sample_meta = std::fs::metadata(dir.join(SAMPLE_FILE)).ok();
    let sample_time = sample_meta.as_ref().and_then(|m| m.modified().ok());
    let enroll_time = std::fs::metadata(dir.join(ENROLLMENT_FILE))
        .and_then(|m| m.modified())
        .ok();
    // Length from the file's own data chunk; a file that no longer parses
    // (edited by hand) reports no sample rather than a guess.
    let sample = sample_meta.zip(sample_time).and_then(|(m, at)| {
        let seconds = std::fs::read(dir.join(SAMPLE_FILE))
            .ok()
            .and_then(|b| parse_wav(&b).ok())?;
        Some(VoiceEnrollSample {
            bytes: m.len(),
            seconds,
            recorded_at: iso(at),
        })
    });
    let current = matches!((sample_time, enroll_time), (Some(s), Some(e)) if e >= s);
    Ok(VoiceEnrollment {
        sample,
        enrolled_at: enroll_time.map(iso),
        current,
    })
}

/// Removes the recording and the enrollment (a missing file is fine) —
/// deleting the enrollment turns the voice guard off, which is the intent.
pub fn delete() -> Result<VoiceEnrollment> {
    delete_in(&enroll_dir()?)
}

fn delete_in(dir: &Path) -> Result<VoiceEnrollment> {
    for name in [SAMPLE_FILE, ENROLLMENT_FILE] {
        match std::fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    status_in(dir)
}

/// `YYYY-MM-DDTHH:MM:SSZ` (UTC) of a file time.
fn iso(t: SystemTime) -> String {
    let secs = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn wav(seconds: f64, rate: u32, channels: u16) -> Vec<u8> {
        let n = (seconds * f64::from(rate)) as usize * usize::from(channels);
        let data = (n * 2) as u32;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 2 * u32::from(channels)).to_le_bytes());
        b.extend_from_slice(&(2 * channels).to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data.to_le_bytes());
        b.resize(b.len() + n * 2, 0);
        b
    }

    #[test]
    fn valid_save_shows_a_sample_that_is_not_current() {
        let dir = tempfile::tempdir().unwrap();
        let s = save_in(dir.path(), &wav(30.0, 16_000, 1)).unwrap();
        let sample = s.sample.unwrap();
        assert!((sample.seconds - 30.0).abs() < 0.01);
        assert!(s.enrolled_at.is_none() && !s.current);
        assert!(
            std::fs::read_dir(dir.path()).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp"))
        );
    }

    #[test]
    fn a_newer_enrollment_makes_it_current_and_an_older_one_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let enrollment = dir.path().join(ENROLLMENT_FILE);
        std::fs::write(&enrollment, "[0.1]").unwrap();
        let old = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&enrollment)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let s = save_in(dir.path(), &wav(25.0, 16_000, 1)).unwrap();
        assert!(s.enrolled_at.is_some() && !s.current);
        std::fs::write(&enrollment, "[0.2]").unwrap();
        let s = status_in(dir.path()).unwrap();
        assert!(s.current);
    }

    #[test]
    fn bad_recordings_are_validation() {
        let dir = tempfile::tempdir().unwrap();
        for bad in [
            b"not a wav at all".to_vec(),
            wav(10.0, 16_000, 1),
            wav(400.0, 16_000, 1),
            wav(30.0, 44_100, 1),
            wav(25.0, 16_000, 2),
        ] {
            assert!(matches!(
                save_in(dir.path(), &bad),
                Err(Error::Validation(_))
            ));
        }
        assert!(!dir.path().join(SAMPLE_FILE).exists());
    }

    #[test]
    fn delete_clears_both_and_tolerates_missing() {
        let dir = tempfile::tempdir().unwrap();
        save_in(dir.path(), &wav(30.0, 16_000, 1)).unwrap();
        std::fs::write(dir.path().join(ENROLLMENT_FILE), "[0.1]").unwrap();
        let s = delete_in(dir.path()).unwrap();
        assert!(s.sample.is_none() && s.enrolled_at.is_none() && !s.current);
        assert!(!dir.path().join(SAMPLE_FILE).exists());
        assert!(!dir.path().join(ENROLLMENT_FILE).exists());
        delete_in(dir.path()).unwrap();
    }

    #[test]
    fn iso_formats_utc() {
        assert_eq!(iso(SystemTime::UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            iso(SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000)),
            "2023-11-14T22:13:20Z"
        );
    }
}
