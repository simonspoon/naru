# Voice library: people and the live voice guard

Settings > Voice has a **People** section and a **Live voice guard** switch
(naru task 2262, replacing the single "Voice guard enrollment" of task 1744).
The voice library is **naru-audio's** (`$NARU_AUDIO_HOME/speaker/people.json`,
`naru-audio/docs/live-mode-spec.md` "Speaker guard"): people, each with clips
whose embeddings the daemon computes and whose WAVs it keeps. Naru stores
nothing and computes nothing; it relays.

## Routes

Proxies for the daemon's `/v1/audio/speaker/*`, at the configured audio url.
Every one carries `require_agent_access` (a recording of someone's voice),
reads included; each mutating one adds `require_same_site_fetch`, exactly
`add_speech_voice`'s pair.

| Route | Daemon route | Notes |
| --- | --- | --- |
| `GET /api/voice/people` | `GET .../people` | `{model, live_guard, people:[{id, name, owner, clips:[{id, created_at, seconds, has_audio}]}]}` |
| `POST /api/voice/people` | `POST .../people` | `{name, owner?}` |
| `PATCH /api/voice/people/{id}` | `PATCH .../people/{id}` | `{name?, owner?}`; `owner: true` clears it on the others |
| `DELETE /api/voice/people/{id}` | `DELETE .../people/{id}` | removes the clips' WAVs |
| `POST /api/voice/people/{id}/clips` | `POST .../clips` | body `{audio_base64}` (a WAV, inside the JSON Content-Type gate), sent on as multipart `file`; invalid/empty base64 422, over `LIVE_AUDIO_MAX` 413 |
| `GET /api/voice/people/{id}/clips/{clip}/audio` | same | answers `audio/wav` (+ `nosniff`) |
| `DELETE /api/voice/people/{id}/clips/{clip}` | same | |
| `GET`/`PUT /api/voice/guard` | `GET`/`PUT .../guard` | `{live: bool}` |

Ids are integers. Errors: a daemon that does not answer is 503 `unavailable`
(with the "isn't running" sentence); its 400 (a clip under 1 s) and 413/415
are 422 `validation`, its 404 is 404 `not_found`, its 409 (model not pulled)
503 `unavailable`, anything else 502, each with the daemon's own message.

The old `GET/PUT/DELETE /api/config/voice-enrollment`, `core::voice_enroll` and
`voice-sample.wav` are gone; nothing but the old section used them.

## The live voice guard

A separate switch, **default off**. On, a live conversation drops a segment of
2 s or more that is not the person marked **me** (and only once "me" has a
clip). Ambient tagging uses the voiceprints either way (the owner is `Him`,
another named person `Other` with their name). The daemon reloads the library
when it changes, so edits and the switch apply to a running session.

## Adding a clip

- **Inside the Naru Mac app** (naru task 2259, host half naru-mac 964d225): the
  page opens no `getUserMedia` and saves no WAV. The row's "add clip" posts
  `{type: 'enroll', op: 'start', person: <id>}` on the `naruLive` bridge
  (`NativeOut`, `startNativeEnroll`); a bare `{type: 'enroll'}` is ignored. The
  app records ~12 s from its own mic and adds it, with its audio, to that
  person's clips through the daemon (live protocol `enroll` `begin` with
  `person`, then `finish`). It reports through
  `window.naruNativeHost.enrollStatus({enrolling, enrolled, note, seconds, person})`
  on page ready and on every change (`note` e.g. "speak for 12 s", "voice
  enrolled", "enrollment failed: ...", "leave live first"); `nativeHost.ts`
  keeps the latest payload so a section mounted after the push still sees it.
  `person` is the library person being recorded (`null` when none). Only the
  row that asked, and only while `person` is its id, shows the recording line
  and the read-aloud text; a finished clip says the host's `note`, else "Clip
  added." (`enrolled` stays false for a non-owner, so it is never read). The
  line clears when another row asks, and the list is read again when the
  recording ends. "Add clip" is disabled on every row while any recording, in
  the app or in a browser, runs.
- **In a plain browser**: `getUserMedia` (echo cancellation, noise suppression
  and auto gain off) through `liveAudio.ts`'s `mesa-pcm` worklet and
  `encodeWav`; the 16 kHz mono WAV goes up through the clips route. The page
  asks for at least 8 s (the daemon accepts 1 s) and stops itself at 12 s.

A clip with `has_audio: false` (the one migrated from the old single
enrollment) is listed as "no audio kept" and has no play button.

## The page

`frontend/src/voicePeople.ts` is the pure logic (sorting, names, clip lines,
the Mac app's status); `voiceEnroll.ts` keeps the recording schedule, meter and the
native start/status helpers; `components/VoicePeopleSection.tsx` wires them. A first person added to
an empty library is made "me".
