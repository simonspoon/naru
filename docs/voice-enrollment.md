# Voice guard enrollment

Settings > Voice has a **Voice guard enrollment** section (naru task 1744). The
browser records about 90 seconds of the person's voice, the server saves it as
a WAV, and the Naru Mac app builds the speaker enrollment from that WAV.

## Files

Both live in the enrollment directory: the platform data dir plus `Naru`
(`~/Library/Application Support/Naru`), overridable with
`NARU_VOICE_ENROLL_DIR` (the test seam).

| File | Written by | Notes |
| --- | --- | --- |
| `voice-sample.wav` | the server (`core::voice_enroll`) | 16 kHz mono 16-bit PCM, 20..=300 s, written temp + rename |
| `ambient-enrollment.json` | the Naru Mac app | a JSON `[Float]`; the server only reads its mtime, and deletes it on `DELETE` |

## Routes

`GET`, `PUT`, `DELETE /api/config/voice-enrollment`; the body of `PUT` is
`{"audio_base64"}` (base64 in JSON, so it stays inside the Content-Type gate).

- `GET` and `DELETE` carry `require_agent_access`; `PUT` adds
  `require_same_site_fetch`, exactly `add_speech_voice`'s pair.
- Invalid or empty base64 is 422, a body over `LIVE_AUDIO_MAX` is 413, a WAV
  that is not RIFF/WAVE 16 kHz mono 16-bit PCM of 20..=300 s is 422.
- All three answer `VoiceEnrollment`: `sample` (`bytes`, `seconds`,
  `recorded_at`) or `null`, `enrolled_at` or `null`, and `current` = the
  enrollment exists and is not older than the sample.
- `DELETE` removes both files (a missing one is fine). Deleting the enrollment
  turns the voice guard and ambient tagging off, which is the intent.

## The Mac app's half

On a successful save, a page running inside the Mac app posts the native bridge
message `{type: 'enroll'}` (`NativeOut` in `nativeHost.ts`). The app then runs
its FluidAudio WeSpeaker `enroll(wavURLs:)` over `voice-sample.wav` and writes
`ambient-enrollment.json`. The page polls the status every 3 s while a sample
has no current enrollment, so "waiting for the Naru Mac app" flips to
"Enrolled" by itself. A browser outside the app saves the WAV and waits; the
app builds the enrollment the next time it runs that step.

## Why the server computes nothing

An embedding needs the speaker model, and the Mac app already has it. A second
enrollment on the server would be a second model, a second file format and a
way for the two to disagree, so the server only keeps the audio.

## The page

`frontend/src/voiceEnroll.ts` holds the logic (the read-aloud paragraph and
timed one-word prompts, peak dBFS, the near-silent test at -40 dBFS, the
20 s minimum / 90 s target, the status line); `VoiceEnrollSection.tsx` wires it
to `getUserMedia` (echo cancellation, noise suppression and auto gain all off)
and `liveAudio.ts`'s `mesa-pcm` worklet and `encodeWav`.
