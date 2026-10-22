# Voice guard enrollment

Settings > Voice has a **Voice guard enrollment** section (naru task 1744). The
browser records about 10 seconds of the person's voice (auto-stopping at 12 s) and the server saves
it as a WAV. Inside the Naru Mac app the page instead asks the app to record 12 s from its own mic and
build the speaker enrollment (see "The Mac app's half"); nothing builds one from the saved WAV.

## Files

Both live in the enrollment directory: the platform data dir plus `Naru`
(`~/Library/Application Support/Naru`), overridable with
`NARU_VOICE_ENROLL_DIR` (the test seam).

| File | Written by | Notes |
| --- | --- | --- |
| `voice-sample.wav` | the server (`core::voice_enroll`) | 16 kHz mono 16-bit PCM, 8..=300 s, written temp + rename |
| `ambient-enrollment.json` | the Naru Mac app | a JSON `[Float]`; the server only reads its mtime, and deletes it on `DELETE` |

## Routes

`GET`, `PUT`, `DELETE /api/config/voice-enrollment`; the body of `PUT` is
`{"audio_base64"}` (base64 in JSON, so it stays inside the Content-Type gate).

- `GET` and `DELETE` carry `require_agent_access`; `PUT` adds
  `require_same_site_fetch`, exactly `add_speech_voice`'s pair.
- Invalid or empty base64 is 422, a body over `LIVE_AUDIO_MAX` is 413, a WAV
  that is not RIFF/WAVE 16 kHz mono 16-bit PCM of 8..=300 s is 422.
- All three answer `VoiceEnrollment`: `sample` (`bytes`, `seconds`,
  `recorded_at`) or `null`, `enrolled_at` or `null`, and `current` = the
  enrollment exists and is not older than the sample.
- `DELETE` removes both files (a missing one is fine). Deleting the enrollment
  turns the voice guard and ambient tagging off, which is the intent.

## The Mac app's half

naru-audio's voice guard reads only its own `speaker/enrollment.json`, which only
the Mac app's native enrollment writes, recording 12 s from the mic. So inside the
app (`detectNativeHost`) the page opens **no** `getUserMedia` and saves no WAV
(naru task 2259, host half naru-mac 964d225):

- Page to host: the record button posts `{type: 'enroll', op: 'start'}` on the
  `naruLive` bridge (`NativeOut`); a bare `{type: 'enroll'}` is ignored by the host.
  The page shows the read-aloud text and a 12 s countdown while the host records.
- Host to page: the host calls `window.naruNativeHost.enrollStatus({enrolling,
  enrolled, note, seconds})` on page ready and on every enrollment state change
  (`note` e.g. "speak for 12 s", "voice enrolled", "enrollment failed: ...",
  "leave live first"). `nativeHost.ts` keeps the latest payload so a section
  mounted after the push still sees it.
- Inside the app the section's status line is the host's `note`, else
  recording / Enrolled / Not enrolled; the server's sample/enrollment status is
  not shown.

A plain browser keeps the flow below unchanged but posts nothing to a host: it
records, saves the WAV, and polls the status every 3 s. Nothing in the server
builds an enrollment from that WAV.

## Why the server computes nothing

An embedding needs the speaker model, and the Mac app already has it. A second
enrollment on the server would be a second model, a second file format and a
way for the two to disagree, so the server only keeps the audio.

## The page

`frontend/src/voiceEnroll.ts` holds the logic (a two-sentence read-aloud text,
peak dBFS, the near-silent test at -40 dBFS, the 8 s minimum / 12 s target,
the status line); `VoiceEnrollSection.tsx` wires it
to `getUserMedia` (echo cancellation, noise suppression and auto gain all off)
and `liveAudio.ts`'s `mesa-pcm` worklet and `encodeWav`.
