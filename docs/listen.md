# Naru listen — speech-to-text through naru-audio

This is the mechanism doc for person → Naru's audio path: everything between
a page deciding it can hear someone and `POST /api/live/transcribe` handing
back text. `docs/live.md` keeps the conversation-shaped story — why listening
exists, what a turn is, the loop the agent runs — and links here for the
parts of it that are really about the wire rather than the conversation.
`docs/config.md`'s "Listen" section owns model listing/selection
(`GET`/`PUT /api/config/listen`); this doc does not repeat it.

The only speech engine is the **naru-audio** daemon (default
`http://127.0.0.1:7870`; `audio.url` / `NARU_AUDIO_URL`, `docs/config.md`
"Audio"). Naru task 1386 retired the external `auris` and `kokoro-rs`
binaries and their child-process path; they are deprecated in favour of
naru-audio.

## Which way in a page has (`listenPath`)

A page decides once per conversation which way it has in, and names it
rather than leaving the person to guess from transcript quality
(`listenPath`, `frontend/src/liveRecognition.ts`, mesa task 957). Its inputs
are the probe below (`available` and `engine`), the config's `listen.engine`
(`GET /api/config/listen`) and what this browser can do; either request
failing reads as "the probe never answered" / `server`. The ladder (mesa task
1390):

1. `listen.engine = "browser"` — the person's deliberate opt-in: `'browser'`
   where this browser has a recognizer, else `'none'`. The server is not
   consulted.
2. The probe answered (`engine: "naru-audio"`) — the server path (named
   `'auris'` in the frontend code, shown to the person as naru-audio) when the
   probe is `ready` and this browser can capture audio (`capturesAudio`,
   `liveAudio.ts`); `'none'` for a ready daemon this browser cannot capture
   audio for; else **`'unavailable'`**. The browser recognizer is **never** a
   fallback here.
3. The probe never answered (the request failed) — the server path if the
   probe said ready and the browser can capture, else **`'browser'`** where
   this browser has its own recognizer
   (`SpeechRecognition`/`webkitSpeechRecognition`, task 873), else
   **`'none'`**: the conversation panel's plain `<textarea>` is the way in,
   the person's own system dictation or their fingers.

The server path hears Naru's own vocabulary correctly and punctuates like a
person, where a browser's `SpeechRecognition` does neither (the correction
pass mesa task 922 built against exactly that recognizer's mishearings is
documented in `docs/live.md`, and runs identically whichever path produced
the text). Firefox has no recognizer of its own at all, so naru-audio is also
the only way a Firefox user gets a microphone here — `getUserMedia` is
everywhere `SpeechRecognition` is not.

**`'unavailable'`** keeps the microphone shut as `'none'` does (no capture,
no recognizer, no listen switch) and the typed box is the way in, but the
panel says why loudly: a `.live-unavailable` banner under its head shows the
probe's `message` (a fallback sentence if it is `null`), the command in it —
the last `` `…` `` span, e.g. `brew services start naru-audio` — in a
`<code>` with a **Copy** button, and a **Retry** button that asks the probe
again and switches to the server path once it answers `ready`. Retry sends
`GET /api/live/transcribe?fresh=1`, which drops the cached probe first
(`audio::invalidate`, mesa task 1408), so a daemon started within the 2 s
failure TTL is seen on the first press; every other `GET` keeps the cache.
The composer's hint gives it its own line ("Neither naru-audio nor this
browser can listen here" when nothing is available, "Listening through
naru-audio" on the server path), never "Listening through this browser"
(`unavailableBanner`, `captureHint`).

## The availability probe: `GET /api/live/transcribe`

The page's one ask, at the moment it joins a conversation, of whether the
server path is worth trying at all (mesa task 957, `transcribe_available` in
`src/api.rs`, `listen::status`). Since mesa task 1388 it answers:

```json
{"available":false,"state":"daemon_down","engine":"naru-audio",
 "url":"http://127.0.0.1:7870",
 "message":"Speech isn't available: naru-audio isn't running at http://127.0.0.1:7870. Start it with `brew services start naru-audio`.",
 "checked_at":"2026-09-24T12:00:03Z","version_warning":null}
```

`engine` is always `naru-audio` and `url` always set. `available` means
"`POST /api/live/transcribe` can decode" — `state == "ready"`. `state` is
`ready | daemon_down | model_missing | incompatible | error`; `message` is
the sentence to show (`null` when ready); `checked_at` is when the cached
answer was taken (RFC 3339 UTC). A config file that cannot be read is **502
`unavailable`**.

The state is `core::audio::probe()` — `GET {audio.url}/health` with a 500 ms
timeout, cached 10 s when `ready` and 2 s otherwise, so a daemon that stops
is reported `daemon_down` within ten seconds and one that comes back `ready`
within two, no restart. Saving the `audio` config section drops the cached
probe (mesa task 1391), so a URL change is asked about on the next GET.
`ready` needs health `ok`, `api: 1` and `stt.ready`; `stt.problem.code ==
"model_not_pulled"` is `model_missing`, any other `api` is `incompatible`,
and anything else — a `/health` with no `stt` block included — is `error`
quoting what the daemon reported. Every **change** of state is logged to the
server's stderr, e.g. `warn audio state ready -> daemon_down
url=http://127.0.0.1:7870` (`info` when the new state is `ready`).

### The minimum naru-audio version (naru task 2282)

`core::audio::MIN_NARU_AUDIO_VERSION` (`0.13.0`, the first release with the
person-aware enroll and guard endpoints) is the oldest daemon this Naru is
built against. Whenever `/health` answered with its JSON, the probe compares
its `version` against it **as semver** (`0.9.0 < 0.13.0`, a pre-release
before its release, build metadata ignored; `audio::version_warning`) and,
when it is older, missing or not semver, carries `version_warning`: "Naru
Audio 0.12.0 is older than the 0.13.0 this Naru needs; upgrade naru-audio."
It is a **warning only** — `available` and `state` are untouched and audio
keeps working. A daemon that is down (or a port answering with something
that is not its JSON) gets no warning (`null`). It rides on this GET and on
`POST /api/config/audio/test`, is shown amber in the live panel and under
Settings → Audio, and is logged to the server's stderr as `warn audio
version … url=…` right after each state-change line. Raise the constant
when Naru starts depending on a newer daemon.

Opening a Live session also sends `POST {audio.url}/api/load
{"model":"default","kind":"stt"}` (mesa task 1392) so the first utterance
does not pay the cold load. `POST /api/live` fires it detached, never
holding its answer; a load that fails there is stored as the server's probe
state for 2 s **counted from when the load returned**
(`model_not_found`/`model_not_pulled` → `model_missing`, a refused connection
→ `daemon_down`, a load still unfinished after 60 s → `error` saying it timed
out, anything else `error` quoting the daemon), so the next GET reports it
rather than a cached `ready`. A success writes nothing. The probe cache lives
in the `serve` process, so `naru live start` (its own short-lived process)
cannot feed it: there the load runs synchronously **after** the command's
output — the command waits for it, up to 60 s — and a failure is only a
stderr line, never the exit code. `naru live handoff` keeps its session and
loads nothing.

The GET is registered on the **same** route entry as the POST below — both
folded into the main route chain in `router()`, with no route-specific
helper of their own — so a LAN page reading this probe gets the same real
`{"available": ...}` answer a default-mode page gets, not the SPA fallback's
`index.html` standing in for "not JSON." Gated by `require_agent_access`
alone (a read, not a mutation, so no `require_same_site_fetch`).

## The route: gated, not absent, under `--lan`

`POST /api/live/transcribe` is registered in **both** serve modes, behind
the same `require_agent_access` gate every other agent route carries —
which **relaxes** rather than refuses under `--lan`, swapping the strict
loopback+Host+Origin check for `require_lan_page_access`, which any device
already on the network passes by design. This route used to refuse
structurally instead, on the reasoning that handing an unauthenticated LAN
peer a way to make Naru's own machine decode whatever audio it recorded is
a capability worth withholding. That reasoning did not survive contact with
what `--lan` already is: the flag hands every device on the network full
read/write on all data plus the Agents and Terminal tabs — arbitrary code
execution on this machine — against which decoding a posted recording is
strictly less power, not more. Refusing it structurally bought no real safety
and cost a real feature: a phone on the network fell back to the browser's
own `SpeechRecognition` — Chrome-only, no vocabulary correction — the gap the
daemon exists to close. `mesa live look` keeps its structural refusal
unchanged: screenshotting the machine's owner's physical screen is a
genuinely different capability, not merely a stronger one.

## The request: bounded audio, not text

The body is JSON, `{"audio_base64": "<whole recording, base64>"}` — not
multipart, not a raw `audio/wav` body — which keeps this route inside the
existing Content-Type gate with no carve-out (the same reasoning
`create_attachment` states for attachments). Invalid or empty base64 is 422
`validation`; a decoded body over `LIVE_AUDIO_MAX` (25 MB) is **413**, not
422 — 422 says "I read your input and it is invalid," fitting a body Naru
actually parsed and measured, where 413 names a body too large to accept,
refused at the boundary before it is read. Valid base64 that decodes to
something that isn't actually a WAV is not Naru's to reject: it reaches the
daemon unexamined, which answers for it.

Body size is layered twice. `TRANSCRIBE_BODY_LIMIT` (`src/api.rs`, ~34 MiB)
is an axum `DefaultBodyLimit` on the wire — base64 costs 33% plus JSON
framing over the raw 25 MB, and axum's own 2 MiB default would otherwise
reject an at-cap recording with a bare non-JSON 413 that names no limit,
before Naru's own `LIVE_AUDIO_MAX` check ever runs. The handler's own check
is what produces the named, JSON-shaped 413 a caller can act on.

Gated by the exact pair `speak_inbox`/`speak_live_turn` carry:
`require_agent_access` (decoding a recording as the machine's owner is
code-execution-adjacent the same way starting a synthesis is) plus
`require_same_site_fetch`. Both gate calls run before Naru decodes base64 or
contacts the daemon in program order, but axum runs every extractor to
completion before the handler body executes at all — so by the time either
gate runs, the whole request body is already buffered (up to
`TRANSCRIBE_BODY_LIMIT`) and parsed as JSON. That is not new or
route-specific (`update_project_files_content` and `run_script` gate after a
`Json<T>` parameter the same way); a caller must transmit ~34 MB to make the
server hold ~34 MB before either gate gets a chance to refuse it, which is
the same cost every other agent-gated route with a request body already
accepts.

## What the daemon receives and returns

`listen::transcribe` (`src/core/listen.rs`) calls `core::audio::transcribe`,
which posts the recording to `{audio.url}/v1/audio/transcriptions` as
`multipart/form-data` (built by hand): `file` = the WAV byte-identical,
`model` = `config::listen_model()` or `default`, `response_format=json`, and
— only when `listen.vocabulary` is configured and valid (naru task 1754) —
`hotwords` = that text verbatim. It waits up to 300 s and returns the
daemon's `text`. Nothing is a shell string or an argument; there is no child
process on this path.

**Silence is a success** (the naru-audio design's silence contract, §2.2):
the daemon's 200 `{"text":""}` is `Ok("")`, so `transcribe_live` answers 200
`{"text":""}` and the page drops the empty text.

Every failure is 503 `unavailable` carrying §4.4's sentence: no answer at all
is the `daemon_down` sentence for that URL; a 409 `model_not_pulled` is
"Speech isn't available: the model {m} isn't downloaded. Run `naru-audio pull
{m}`." (`{m}` the name the daemon quotes, so `default` reads as the real
model); anything else — a 404 `model_not_found` included, since no `pull`
fetches a model the catalog does not know — is "Speech isn't available:
naru-audio reported: {message}", quoting the daemon. Each failed request
drops the cached probe, so the page's next `GET` asks the daemon afresh.
`listen::models()` is the daemon's speech-to-text models (`GET /v1/models`,
`x_kind == "stt"`, pulled or not) — the list the Settings page offers and a
saved model is checked against; empty means "Naru could not ask".

### The vocabulary (`listen.vocabulary`, naru task 1754)

The Settings vocabulary is naru-audio's `hotwords` (grammar and limits in
`docs/config.md`). It is read per request like the model and sent as the
multipart `hotwords` part of every one-shot transcription, and as `hotwords`
added to a `start` message on the `/api/live/listen` streaming route (the
proxy rewrites that one frame; every other frame, and every frame when no
vocabulary is set, passes through untouched). On the live socket the page
names it in its own `start` (naru task 2385, "The live socket" below). It is sent whenever configured,
whatever the model — the daemon ignores it on a model whose backend cannot
decode hotwords (`x_hotwords: false` in `GET /v1/models`, which the Settings
page reads to say so). A stored value that no longer validates is logged once
and not sent, so a hand-edited file never breaks transcription.

## Ordering: segments are transcribed in order

`LiveHub.tsx`'s capture effect chains every segment's post onto a
`Promise<void>` queue rather than firing them directly (`let queue =
Promise.resolve(); queue = queue.then(() => send(wav))`): two overlapping
requests to `POST /api/live/transcribe` could otherwise land the halves of
one thought the wrong way round. In-flight count is almost always 0 or 1
for exactly that reason.

## Retention

Nothing is kept, in either direction. In `transcribe_live` the decoded bytes
live only in a local `bytes` buffer and are handed to `listen::transcribe` —
never written to `live_turns` (which has no column for audio), never to
disk, and never logged. The resulting text is not retained by this route
either: it is returned to the caller, which is the existing held-recording
path (`docs/live.md`, "Person → Naru"), the same "transcribed and dropped"
shape the speak routes already have on the way out, with the arrow reversed.

## Streaming: `GET /api/live/listen` (WebSocket)

Mesa task 1394, naru-audio design §2.4 / §6.2: a WebSocket the page opens
on Naru, proxied to the daemon's `/v1/audio/transcriptions/stream`
(`live_listen` + `proxy_listen` in `src/api.rs`, `audio::open_stream` in
`src/core/audio.rs`). The page's main dictation capture used it (mesa task
1395) until naru task 2385 moved that capture to the live socket below, which
carries the speaker guard; the route stays, unused by the page. What it did: a
`start` of 16 kHz `s16le` with no partials, naming `listen.model` as `model`
when the config names one (the name the one-shot route sends the daemon,
`config::listen_model()`; absent otherwise, so the daemon's default applies),
~50 ms binary frames, `stop` on the listen switch and every teardown, each
`final` held like a posted segment's transcript, and a re-probe of
`GET /api/live/transcribe` on any close that is not `1000`/`done` or the
page's own — which also stops the microphone, since a daemon that is still
ready (a `1013` backlog, a `1011` decode error) re-runs nothing; turning
listening off and on reconnects. The barge-in capture still posts to the
one-shot route.

- **Gates, before the upgrade**: the transcribe pair,
  `require_agent_access` + `require_same_site_fetch`, in both serve modes.
  A foreign page is 403 and no daemon is contacted.
- `listen.engine` is **not** consulted: it picks what the *page* listens
  with, and this route only ever reaches the server's daemon — a page on
  `browser` simply never opens it.
- **No `Origin` reaches the daemon.** The daemon refuses any `Origin` (§2.1)
  and keeps no gates of its own for Naru to borrow, so the upstream request
  is built from `audio.url` alone (`http://` → `ws://`): the handshake
  headers and nothing else, none of the browser's forwarded.
- **Frames pass through untouched**: text and binary verbatim in both
  directions, and a close frame with its code and reason — the daemon's
  `1000 "done"`, `1008`, `1011`, `1013` reach the page as sent, and a page's
  close reaches the daemon. Pings are answered by each side's own library,
  never forwarded. A side that vanishes without a close closes the other:
  the daemon with a close, the page with an `error` event and `1011`
  (§2.4: an error always precedes a non-1000 close). The session is one
  future — nothing is spawned, so nothing outlives it.
- **A failed open** (nothing listening, or no handshake within 5 s) sends
  the page `{"type":"error","code":"daemon_down","message":…}` with §4.4's
  daemon_down sentence for that URL, then closes `1011`; a handshake the
  daemon refuses with an HTTP status is `"code":"error"` with the §4.4
  `error` sentence naming the status. Either failure, and a mid-session
  drop, drops the cached probe (`audio::invalidate`), so the page's next
  `GET /api/live/transcribe` asks the daemon afresh.

## The live socket: `GET /v1/audio/live` (WebSocket, naru task 2176)

The native Mac client dials its live conversation socket at the **serve**
URL (`<serve>/v1/audio/live`), and only the daemon serves that route, so
Naru passes it through to the daemon's own `/v1/audio/live` (`audio_live`
in `src/api.rs`, the same `proxy_listen` pump and `audio::open_stream` with
`audio::LIVE_PATH`). Everything above holds unchanged — the transcribe gates
before the upgrade, no `Origin` upstream, text/binary/close frames verbatim,
a failed open as an `error` event then `1011` — with one difference: no
`hotwords` are ever added, and every frame reaches the daemon byte-identical
except a `speak` frame (naru task 2221): one naming no `voice` or `model` gets
Settings' `speech.voice` / `speech.model` (`with_speech`, config read per frame,
unset or unreadable = left out, a client's own value kept), so the Mac app
speaks in the person's voice rather than the daemon's default. A resume rides inside the client's own `start`, so the URL carries no query.

The page uses it twice (`docs/live.md`): a `role: "control"` socket for the
mic mute (naru task 2179), and, on the streaming path, a `role: "audio"`
socket in the same `conversation` (the live session id) carrying its
microphone (naru task 2385, `frontend/src/liveStream.ts`), so the daemon's
mode and its opt-in speaker guard (`live_guard`) govern a plain browser's
capture as they do the native apps'. Its `start` is `mode: "live"`, 16 kHz
`s16le`, no partials, `listen.model` (also filled in by the passthrough) and
`listen.vocabulary` as `hotwords` — named by the page, since this route adds
none, and left out when it fails the Settings validator (`listenDraft.ts`'s
mirror of `validate_vocabulary`), as serve drops it; it reads each `utterance` as a final and a clearing `partial` (a dropped
segment) or an `ambient_flag` as that segment answered, and keeps the stop/`done`/re-probe rules of
the dictation stream above.

## Gate

The Rust tests in `src/core/audio.rs` (a stub daemon over a local socket)
cover the transcription contract: the multipart body, silence as `Ok("")`,
and each §4.4 failure sentence. There is no dedicated listen script
any more; the old one went with the retired binary.
