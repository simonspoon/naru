# Naru listen (the `auris` speech-to-text contract)

This is the mechanism doc for person → Naru's audio path: everything between
a page deciding it can hear someone and `POST /api/live/transcribe` handing
back text. `docs/live.md` keeps the conversation-shaped story — why listening
exists, what a turn is, the loop the agent runs — and links here for the
parts of it that are really about the wire and the subprocess rather than the
conversation. `docs/config.md`'s "Listen" section owns model
listing/selection (`GET`/`PUT /api/config/listen`); this doc does not repeat
it.

## Which engine a page has (`listenPath`)

A page decides once per conversation which way it has in, and names it
rather than leaving the person to guess from transcript quality
(`listenPath`, `frontend/src/liveRecognition.ts`, mesa task 957). Its inputs
are the probe below (`available` and `engine`), the config's `listen.engine`
(`GET /api/config/listen`) and what this browser can do; either request
failing reads as `legacy`/`server`. The ladder (mesa task 1390):

1. `listen.engine = "browser"` — the person's deliberate opt-in: `'browser'`
   where this browser has a recognizer, else `'none'`. The server is not
   consulted.
2. `audio.engine = "naru-audio"` — `'auris'` (the server path) when the probe
   is `ready` and this browser can capture audio, else **`'unavailable'`**.
   The browser recognizer is **never** a fallback here.
3. Otherwise (`legacy`, the default) — unchanged since mesa task 957:

- **`'auris'`** — this browser can capture audio (`capturesAudio`,
  `liveAudio.ts`) **and** the server answered the availability probe below
  with `true`.
- **`'browser'`** — no `auris`, but this browser has its own recognizer
  (`SpeechRecognition`/`webkitSpeechRecognition`, task 873).
- **`'none'`** — neither. The conversation panel's plain `<textarea>` is the
  way in: the person's own system dictation, or their fingers.

**`'unavailable'`** keeps the microphone shut as `'none'` does (no capture,
no recognizer, no listen switch) and the typed box is the way in, but the
panel says why loudly: a `.live-unavailable` banner under its head shows the
probe's `message` (a fallback sentence if it is `null`), the command in it —
the last `` `…` `` span, e.g. `brew services start naru-audio` — in a
`<code>` with a **Copy** button, and a **Retry** button that asks the probe
again and switches to the server path once it answers `ready`. Retry sends
`GET /api/live/transcribe?fresh=1`, which drops the cached probe first
(`audio::invalidate`, mesa task 1408), so a daemon started within the 2 s
failure TTL is seen on the first press; every other `GET` keeps the cache,
and on `legacy` the flag changes nothing. The
composer's hint gives it its own line, never "Listening through this
browser" (`unavailableBanner`, `captureHint`).

On `legacy`, `auris` wins whenever it can be reached, **even on a browser that also has a
recognizer of its own** — the ordering is the whole point of mesa task 957.
It hears Naru's own vocabulary correctly and punctuates like a person, where
a browser's `SpeechRecognition` does neither (the correction pass mesa task
922 built against exactly that recognizer's mishearings is documented in
`docs/live.md`, and runs identically on whichever engine produced the text).
Firefox has no recognizer of its own at all, so `auris` is also the only way
a Firefox user gets a microphone here — `getUserMedia` is everywhere
`SpeechRecognition` is not.

## The availability probe: `GET /api/live/transcribe`

The page's one ask, at the moment it joins a conversation, of whether
`auris` is worth trying at all (mesa task 957, `transcribe_available` in
`src/api.rs`, `listen::status`). Since mesa task 1388 it answers:

```json
{"available":false,"state":"daemon_down","engine":"naru-audio",
 "url":"http://127.0.0.1:7870",
 "message":"Speech isn't available: naru-audio isn't running at http://127.0.0.1:7870. Start it with `brew services start naru-audio`.",
 "checked_at":"2026-09-24T12:00:03Z"}
```

`available` keeps its meaning — "`POST /api/live/transcribe` can decode" —
which is `state == "ready"` on both engines: `!listen::models().is_empty()`
on `legacy`, the daemon's probe on `naru-audio`, since the POST goes to the
daemon there (mesa task 1389). The page reads it with `engine` and
`message` (mesa task 1390, `listenPath` above). `state` is `ready | daemon_down | model_missing | incompatible |
error`; `message` is the sentence to show (`null` when ready); `checked_at`
is when the cached answer was taken (RFC 3339 UTC). A config file that
cannot be read is **502 `unavailable`**.

- **`audio.engine = "legacy"`** (the default, `docs/config.md`): `ready` iff
  `listen::models()` is non-empty, else `error` with a message naming the
  binary; `url` is `null`. An empty model list is **"Naru could not ask"** —
  the binary missing, failing, or answering with something that isn't a list
  of names — never "auris says it has no models installed". `models()` is
  cached with a TTL (10 s for a list, 2 s for an empty answer), the same
  cache `GET /api/config/listen` reads, so installing `auris` is seen within
  seconds, no restart.
- **`audio.engine = "naru-audio"`**: `core::audio::probe()` — `GET
  {audio.url}/health` with a 500 ms timeout, cached 10 s when `ready` and 2 s
  otherwise, so a daemon that stops is reported `daemon_down` within ten
  seconds and one that comes back `ready` within two, no restart. Saving
  the `audio` config section drops the cached probe (mesa task 1391), so an
  engine or URL change is asked about on the next GET. `ready`
  needs health `ok`, `api: 1` and `stt.ready`; `stt.problem.code ==
  "model_not_pulled"` is `model_missing`, any other `api` is `incompatible`,
  and anything else — a `/health` with no `stt` block included — is `error`
  quoting what the daemon reported. Every **change** of state is logged to
  the server's stderr, e.g. `warn audio state ready -> daemon_down
  url=http://127.0.0.1:7870` (`info` when the new state is `ready`).
  Opening a Live session on this engine also sends `POST {audio.url}/api/load
  {"model":"default","kind":"stt"}` (mesa task 1392) so the first utterance
  does not pay the cold load. `POST /api/live` fires it detached, never
  holding its answer; a load that fails there is stored as the server's
  probe state for 2 s **counted from when the load returned** (`model_not_found`/`model_not_pulled`
  → `model_missing`, a refused connection → `daemon_down`, a load still
  unfinished after 60 s → `error` saying it timed out, anything else `error`
  quoting the daemon), so the next GET reports it rather than a cached
  `ready`. A success writes nothing. The probe cache lives in the `serve`
  process, so `naru live start` (its own short-lived process) cannot feed
  it: there the load runs synchronously **after** the command's output —
  the command waits for it, up to 60 s — and a failure is only a stderr
  line, never the exit code. `naru live handoff` keeps its session and
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
structurally instead, on the reasoning that posting text a person already
reviewed on their own screen is one thing and handing an unauthenticated LAN
peer a way to make Naru's own machine decode whatever audio it recorded is
another. That reasoning did not survive contact with what `--lan` already
is: the flag hands every device on the network full read/write on all data
plus the Agents and Terminal tabs — arbitrary code execution on this
machine — against which decoding a posted recording is strictly less
power, not more. Refusing it structurally bought no real safety and cost a
real feature: a phone on the network never saw `auris` was reachable, so the
Live page silently fell back to the browser's own `SpeechRecognition` —
Chrome-only, no vocabulary correction — the whole reason `auris` exists.
`mesa live look` keeps its structural refusal unchanged: screenshotting the
machine's owner's physical screen is a genuinely different capability, not
merely a stronger one, and nothing about that argument applies here.

## The request: bounded audio, not text

The body is JSON, `{"audio_base64": "<whole recording, base64>"}` — not
multipart, not a raw `audio/wav` body — which keeps this route inside the
existing Content-Type gate with no carve-out (the same reasoning
`create_attachment` states for attachments). Invalid or empty base64 is 422
`validation`; a decoded body over `LIVE_AUDIO_MAX` (25 MB) is **413**, not
422 — 422 says "I read your input and it is invalid," fitting a body Naru
actually parsed and measured, where 413 names a body too large to accept,
refused at the boundary before it is read. Valid base64 that decodes to
something that isn't actually a WAV is not Naru's to reject: it reaches
`auris` unexamined, the same way a bad file reaches any other decoder.

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
spawns `auris` in program order, but axum runs every extractor to completion
before the handler body executes at all — so by the time either gate runs,
the whole request body is already buffered (up to `TRANSCRIBE_BODY_LIMIT`)
and parsed as JSON. That is not new or route-specific (`update_project_files_content`
and `run_script` gate after a `Json<T>` parameter the same way); what is new
here is only the magnitude, and it now applies under `--lan` too, in exactly
the same shape: a caller must transmit ~34 MB to make the server hold ~34 MB
before either gate gets a chance to refuse it, which is the same cost every
other agent-gated route with a request body already accepts.

## What `auris` receives and returns

`listen::transcribe` (`src/core/listen.rs`) shells out to the `auris` binary
(`MESA_AURIS_BIN`, default `auris`) with argv exactly `-q --format json`,
plus `-m <name>` when `config::listen_model()` names one
(`docs/config.md` "Listen").

The audio is **never a shell string and never a `Command::arg`** — the same
load-bearing property `speech.rs` states for the text it hands `kokoro-rs`,
and for the same reason: it is written to the child's stdin, so a payload
that happens to start with a flag-shaped byte can never be parsed as one,
and there is no `ARG_MAX` ceiling to hit. There is no shell anywhere on this
path. Every pipe is drained for the child's whole life: stdin is written
from a dedicated thread (dropping it is what signals EOF to `auris`), stderr
is drained on its own thread, and stdout is read on the calling thread — an
audio body is megabytes, not bytes, so writing it inline while also waiting
on stdout would deadlock the first time either pipe's buffer filled.

`auris` streams JSON Lines as it decodes (`auris/README.md` "`--format
json`"): a `segment` line per completed utterance, and a final `transcript`
line carrying the whole corrected text. `last_transcript` reads to EOF and
keeps the text of the **last** `{"type": "transcript", ...}` line seen —
`auris`'s own contract guarantees `transcript` is always the last line on a
run that produced one, so the last match is the answer even though
`segment` lines may run ahead of it in volume. A line with an unrecognised
`type` — or any other field on a recognised one — is ignored rather than
treated as an error (`#[serde(other)]` plus `#[serde(default)]` on `text`),
since that is the whole of `auris`'s own extension mechanism. Reads stay
bounded against a misbehaving or hostile binary: `LINE_CAP` (1 MiB) caps any
single line before it is parsed, and `STDERR_EXCERPT` (400 chars) caps how
much of stderr rides back in an error message.

**Silence is a success** (mesa task 1389, the naru-audio design's silence
contract, §2.2): `auris` exiting **1** with no `transcript` line — its
"nothing transcribed" code — is `Ok("")`, so `transcribe_live` answers 200
`{"text":""}` and the page drops the empty text. `auris` also exits 1 for a
model missing under `--no-download` or an unreachable auris daemon; those now
read as silence too, since nothing matches on stderr text any more. Any
other nonzero exit (2 for a usage error, a signal) and an exit 0 with no
`transcript` line are **not** data here, unlike `scripts::run`: there is no
transcript to hand back, so the run is an `Err`, mapped by `transcribe_live`
to 503 `unavailable` — the same rule `speech::start`'s failure takes on the
way out.

## On `audio.engine = "naru-audio"`: the daemon instead of `auris`

With the daemon engine (mesa task 1389, `docs/config.md` "Audio"),
`listen::transcribe` never runs `auris` — `auris_bin()` is not even read.
`core::audio::transcribe` posts the recording to
`{audio.url}/v1/audio/transcriptions` as `multipart/form-data` (built by
hand: `file` = the WAV byte-identical, `model` = `config::listen_model()` or
`default`, `response_format=json`), waits up to 300 s, and returns the
daemon's `text`. Silence is the daemon's 200 `{"text":""}`, so the route's
answer is the same 200 `{"text":""}` as on `legacy`. Every failure is 503
`unavailable` carrying §4.4's sentence: no answer at all is the
`daemon_down` sentence for that URL; a 409 `model_not_pulled` is "Speech
isn't available: the model {m} isn't downloaded. Run `naru-audio pull {m}`."
(`{m}` the name the daemon quotes, so `default` reads as the real model);
anything else — a 404 `model_not_found` included, since no `pull` fetches a
model the catalog does not know — is "Speech isn't available: naru-audio
reported: {message}", quoting the daemon. Each failed request drops the
cached probe, so the page's next `GET` asks the daemon afresh.
`listen::models()` on this engine is the daemon's speech-to-text models
(`GET /v1/models`, `x_kind == "stt"`, pulled or not) — the list the
Settings page offers and a saved model is checked against.

## Ordering: segments are transcribed in order

`LiveHub.tsx`'s capture effect chains every segment's post onto a
`Promise<void>` queue rather than firing them directly (`let queue =
Promise.resolve(); queue = queue.then(() => send(wav))`): two overlapping
requests to `POST /api/live/transcribe` could otherwise land the halves of
one thought the wrong way round. In-flight count is almost always 0 or 1
for exactly that reason.

## Retention

Nothing is kept, in either direction. In `transcribe_live` the decoded bytes
live only in a local `bytes` buffer, are handed to `listen::transcribe`, and
are written to `listen::transcribe`'s child's stdin — never to `live_turns`
(which has no column for audio), never to disk, and never logged. The
resulting text is not retained by this route either: it is returned to the
caller, which is the existing held-recording path (`docs/live.md`, "Person →
Naru"), the same "transcribed and dropped" shape the speak routes already
have on the way out, with the arrow reversed.

## Streaming: `GET /api/live/listen` (WebSocket)

Mesa task 1394, naru-audio design §2.4 / §6.2: a WebSocket the page opens
on Naru, proxied to the daemon's `/v1/audio/transcriptions/stream`
(`live_listen` + `proxy_listen` in `src/api.rs`, `audio::open_stream` in
`src/core/audio.rs`). The page's main dictation capture uses it on
`naru-audio` (mesa task 1395, `frontend/src/liveStream.ts`,
`docs/live.md` "Person → Naru"): a `start` of 16 kHz `s16le` with no
partials, naming `listen.model` as `model` when the config names one (the
name the one-shot route sends the daemon, `config::listen_model()`; absent
otherwise, so the daemon's default applies), ~50 ms binary frames, `stop` on
the listen switch and every teardown, each `final` held like a posted
segment's transcript, and a re-probe of `GET /api/live/transcribe` on any
close that is not `1000`/`done` or the page's own — which also stops the
microphone, since a daemon that is still ready (a `1013` backlog, a `1011`
decode error) re-runs nothing; turning listening off and on reconnects. The barge-in capture still posts to the one-shot route.

- **Gates, before the upgrade**: the transcribe pair,
  `require_agent_access` + `require_same_site_fetch`, in both serve modes.
  A foreign page is 403 and no daemon is contacted.
- **Inert by default**: only `audio.engine = "naru-audio"` opens it. On
  `legacy` (the default) the handshake is refused **503 `unavailable`**
  before any upgrade and the daemon is never contacted, so a legacy install
  with no daemon changes nothing. `listen.engine` is **not** consulted: it
  picks what the *page* listens with, and this route only ever reaches the
  server's engine — a page on `browser` simply never opens it.
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

## Gate

`scripts/auris-check.sh` — the API-side counterpart to `scripts/api-check.sh`
(`kokoro-rs`'s speak routes) for the input direction, run against a stub
`auris` (`MESA_AURIS_BIN`), never a real recognizer. Covers, in order: a
missing binary (503 `unavailable`, naming the binary in the message); the
round-trip (the decoded recording reaches `auris` on stdin byte-identical to
what was sent, argv exactly `-q --format json`); the JSON Lines contract
(last `transcript` wins, an unrecognised `type` is ignored); injection-proof
handling (a transcript containing `$()`, backticks, quotes, a literal `\n`
escape and JSON-shaped text comes back byte-identical, never expanded,
executed, or re-parsed); stdout carrying only the transcript even when
stderr floods a pipe buffer; the silence contract (exit 1 is 200
`{"text":""}`) beside the "any other nonzero exit, or no transcript line,
means no transcript" rule; the body-size contract (413 naming the limit, 422 on
bad/empty/missing base64, an unreadable-but-valid-base64 body reaching
`auris` unexamined); the security boundary in default mode (415 on a bad
Content-Type, 403/200 on the agent gate); the route's presence and gating
under `--lan` for both the POST and the GET (a LAN POST reaches the stub
`auris` and comes back 200 with a transcript, the GET answers 200 with an
`available` key, and the Content-Type gate still fires); and the `GET`'s own
`available: true`/`false` split against a stub that does or doesn't answer
`--list-models`.
