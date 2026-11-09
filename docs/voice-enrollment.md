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
| `GET /api/voice/people` | `GET .../people` | `{model, live_guard, people:[{id, name, owner, instance, clips:[{id, created_at, seconds, has_audio}]}]}`, minus other instances' people |
| `POST /api/voice/people` | `POST .../people` | `{name, owner?}`; sent with this instance's `instance` |
| `PATCH /api/voice/people/{id}` | `PATCH .../people/{id}` | `{name?, owner?}`; `owner: true` clears it on the others |
| `DELETE /api/voice/people/{id}` | `DELETE .../people/{id}` | removes the clips' WAVs |
| `POST /api/voice/people/{id}/clips` | `POST .../clips` | body `{audio_base64}` (a WAV, inside the JSON Content-Type gate), sent on as multipart `file`; invalid/empty base64 422, over `LIVE_AUDIO_MAX` 413 |
| `GET /api/voice/people/{id}/clips/{clip}/audio` | same | answers `audio/wav` (+ `nosniff`) |
| `DELETE /api/voice/people/{id}/clips/{clip}` | same | |
| `GET`/`PUT /api/voice/guard` | none: Naru's own setting | `{live, instance}`; PUT takes `{live: bool}` |

| `POST /api/voice/people/{id}/copy` | `GET .../people`, `POST .../people`, then per clip `GET .../audio` + `POST .../clips` | copies a person from before instances onto this instance (below); answers `{person, copied, skipped}` |

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
when it changes, so clip edits apply to a running session; the switch reaches
the next session.

## Instances (naru task 2666)

Several Naru instances (this Mac's, another machine's) can share one
naru-audio. Each Naru has a stable **instance id**, a v4 UUID made the first
time it is needed and kept in `instance-id` beside the config file
(`~/.naru/instance-id`; a dev instance's `NARU_CONFIG_FILE` gives it its own),
shown under the switch as "This Naru: …". The **switch is Naru's**, not
naru-audio's: `live.voice-guard` in the config (`docs/config.md`); the daemon's
library-wide `PUT /v1/audio/speaker/guard` is no longer called.

- `GET /v1/audio/live` (the native app's live socket and the page's) fills
  `instance` and `guard` into the client's `start` frame, unless the client
  sent its own, so the daemon judges the session against this instance's "me"
  and enrollment frames on it land on this instance's owner. No client
  changes.
- A new person is made with this instance's `instance`; the list leaves out
  people of other instances.
- People from before instances (`instance: null`) are shown in their own group,
  "From before each Naru had its own voices": the daemon treats them as just
  other people for an instance, so the guard does not count them as "me".
  **copy to this Naru** makes a person of the same name on this instance —
  "me" only when the original was and this instance has no "me" yet — and
  uploads every clip that kept its audio (`skipped` counts those that did
  not); the original stays for the other instances. A copy that fails part way
  deletes the new person again.
- An older naru-audio (no `instance` on its people) ignores both fields: its
  own library-wide switch applies, which Naru no longer turns on, so the guard
  stays off. Its people are all listed as this instance's, copy is a 422, and
  the switch says it has no effect there.
- An unreadable id or switch is left out of the `start` frame (the daemon's
  legacy owner, its own switch) rather than failing the session.
- A small **voice guard** chip shows while a conversation is on and the switch
  is on: in the live panel's head, or in the page header beside the mark when
  the panel is docked (`OrbHeaderControls`). It polls the switch every 15 s.

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
