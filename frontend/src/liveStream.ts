/**
 * Streaming dictation over `GET /api/live/listen` (mesa task 1395) — the
 * pure half of the page's streaming capture, used only when the server runs
 * `audio.engine = "naru-audio"`. The route is a WebSocket Naru proxies
 * verbatim to the daemon's `/v1/audio/transcriptions/stream` (naru-audio
 * design §2.4, `docs/listen.md` "Streaming"): the page sends one `start`
 * message, then raw 16 kHz s16le PCM in binary frames, and the daemon — whose
 * VAD is authoritative — answers `speech` edges and one `final` per segment
 * it heard words in.
 *
 * Everything here is side-effect-free so it can be pinned in vitest; the
 * socket, the microphone and the held recording stay in `LiveHub`.
 */
import { downsample, TARGET_SAMPLE_RATE, toPcm16 } from './liveAudio'

/**
 * The listen route on the page's own origin, `ws:`/`wss:` following the
 * page's scheme — `PtyTerminal`'s rule for its own socket.
 */
export function listenUrl(location: { protocol: string; host: string }): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/api/live/listen`
}

/**
 * The first frame (§2.4 "Handshake"). `model` is the configured
 * `listen.model` — the same name the one-shot route sends the daemon
 * (`config::listen_model()`) — and is left out when the config names none,
 * so the daemon's default applies. No partials: nothing on the page shows
 * one.
 */
export function startMessage(model?: string | null): string {
  const named = model?.trim() ? { model: model.trim() } : {}
  return JSON.stringify({
    type: 'start',
    format: 's16le',
    sample_rate: TARGET_SAMPLE_RATE,
    partials: false,
    ...named,
  })
}

/** Flushes, delivers every final, answers `done` and closes 1000. */
export const STOP_MESSAGE = JSON.stringify({ type: 'stop' })

/**
 * How long a stopped stream may take to deliver its last finals and `done`
 * before the page closes it itself — the bound on a listen-switch drain, so a
 * daemon that hangs mid-decode cannot hold the recording for ever. Generous:
 * §2.4's backlog is at most 30 s of audio, a couple of seconds to decode.
 */
export const STOP_WAIT_MS = 10000

/** How much audio one binary frame carries — inside §2.4's 20–100 ms. */
export const FRAME_MS = 50

/** Signed 16-bit samples as little-endian bytes, whatever the host's order. */
export function pcmBytes(pcm: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(pcm.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(i * 2, pcm[i], true)
  }
  return buffer
}

/**
 * Turns the worklet's small blocks (128 samples at the context's rate) into
 * binary frames of about `FRAME_MS` of 16 kHz s16le. The batch is gathered
 * at the **capture** rate and resampled whole, so the rounding in
 * `downsample` happens once per frame rather than once per 128-sample block,
 * which would stretch the audio by up to a sample per block.
 */
export class FrameBatcher {
  private blocks: Float32Array[] = []
  private held = 0
  private readonly fromRate: number
  private readonly batch: number

  constructor(fromRate: number, frameMs: number = FRAME_MS) {
    this.fromRate = fromRate
    this.batch = Math.max(1, Math.round((fromRate * frameMs) / 1000))
  }

  /** Every frame this block completes — none, usually one. */
  push(samples: Float32Array): ArrayBuffer[] {
    if (samples.length === 0) return []
    this.blocks.push(samples)
    this.held += samples.length
    const out: ArrayBuffer[] = []
    while (this.held >= this.batch) {
      out.push(this.encode(this.take(this.batch)))
    }
    return out
  }

  /** Whatever is left, as one short frame, or `null` when nothing is. */
  drain(): ArrayBuffer | null {
    if (this.held === 0) return null
    return this.encode(this.take(this.held))
  }

  private take(n: number): Float32Array {
    const out = new Float32Array(n)
    let offset = 0
    while (offset < n) {
      const block = this.blocks[0]
      const wanted = n - offset
      if (block.length <= wanted) {
        out.set(block, offset)
        offset += block.length
        this.blocks.shift()
      } else {
        out.set(block.subarray(0, wanted), offset)
        this.blocks[0] = block.subarray(wanted)
        offset += wanted
      }
    }
    this.held -= n
    return out
  }

  private encode(samples: Float32Array): ArrayBuffer {
    return pcmBytes(toPcm16(downsample(samples, this.fromRate, TARGET_SAMPLE_RATE)))
  }
}

/** What the daemon says, as far as the page reads it (§2.4 "Server events"). */
export type StreamEvent =
  | { type: 'loading' }
  | { type: 'ready' }
  | { type: 'speech'; active: boolean; at: number }
  | { type: 'final'; segment: number; start: number; end: number; text: string }
  | { type: 'warning'; code: string; message: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' }

/**
 * One text frame, or `null` for anything the page does not act on — a
 * binary frame, malformed JSON, an unknown `type` (a `partial` included,
 * since the page asks for none) or a known one missing a field it needs.
 */
export function parseStreamEvent(data: unknown): StreamEvent | null {
  if (typeof data !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const str = (key: string) => (typeof v[key] === 'string' ? (v[key] as string) : '')
  switch (v.type) {
    case 'loading':
    case 'ready':
    case 'done':
      return { type: v.type }
    case 'speech':
      if (typeof v.active !== 'boolean' || typeof v.at !== 'number') return null
      return { type: 'speech', active: v.active, at: v.at }
    case 'final':
      if (
        typeof v.text !== 'string' ||
        typeof v.end !== 'number' ||
        typeof v.start !== 'number' ||
        typeof v.segment !== 'number'
      ) {
        return null
      }
      return { type: 'final', segment: v.segment, start: v.start, end: v.end, text: v.text }
    case 'warning':
    case 'error':
      return { type: v.type, code: str('code'), message: str('message') }
    default:
      return null
  }
}

/**
 * Whether a closed socket was the stream ending as meant, or a sign the
 * daemon went away — in which case the page asks `GET /api/live/transcribe`
 * again, so a daemon that died paints the unavailable banner. Normal is a
 * `1000` close, a `done` already received, or a socket the page closed
 * itself (a close before the handshake finishes reports `1006` however it
 * was asked for). Everything else — the proxy's `1011` after `daemon_down`,
 * a `1013` backlog, a `1006` from a 503 handshake — asks again.
 */
export function closeVerdict(input: {
  code: number
  sawDone: boolean
  closedByUs: boolean
}): 'normal' | 'reprobe' {
  if (input.code === 1000 || input.sawDone || input.closedByUs) return 'normal'
  return 'reprobe'
}

/**
 * How long a finished segment waits for its `final` before it is counted as
 * settled anyway. The daemon sends **no** final for a segment its gates
 * dropped (§2.4: "a gated segment is simply dropped"), so without a bound
 * one cough would hold "transcribing…" and the silence send for ever. The
 * same bound as `STOP_WAIT_MS`, because a real final can be that late: the
 * daemon lets a shared decode FIFO back up to 30 s of audio, and a wait that
 * expired first would let the silence send go without the final and the
 * late final start a second turn. A gated segment is still released sooner
 * in practice, by the next final behind it.
 */
export const FINAL_WAIT_MS = STOP_WAIT_MS

/**
 * The segments the daemon has closed (`speech` `active: false`) and not yet
 * answered. Each is a promise the page chains onto `liveDrain.ts`'s
 * `SegmentChain`, so the chain's count — `hearing` — and its drain on the
 * listen switch cover them exactly as they cover a posted segment.
 *
 * A `final` settles every wait whose segment ended at or before the final's
 * `end`: the two are the same number when the daemon's VAD closed the span,
 * and finals arrive in segment order, so a wait still open behind a later
 * final belonged to a segment that was gated. A `max_segment` cut sends a
 * final mid-span, before any `active: false`, and so settles nothing still
 * to come. The last gated segment has no later final: `timeoutMs` bounds it.
 */
interface FinalWait {
  at: number
  resolve: () => void
  timer: ReturnType<typeof setTimeout>
}

export class FinalWaits {
  private waits: FinalWait[] = []
  private readonly timeoutMs: number

  constructor(timeoutMs: number = FINAL_WAIT_MS) {
    this.timeoutMs = timeoutMs
  }

  get count(): number {
    return this.waits.length
  }

  /** A segment ended at `at` (stream seconds); resolves once it is answered. */
  expect(at: number): Promise<void> {
    return new Promise((resolve) => {
      const wait: FinalWait = {
        at,
        resolve,
        timer: setTimeout(() => this.settle((w) => w === wait), this.timeoutMs),
      }
      this.waits.push(wait)
    })
  }

  /** A final ending at `end` (stream seconds) arrived. */
  final(end: number): void {
    this.settle((w) => w.at <= end + 1e-6)
  }

  /** The socket is gone: nothing more will be answered. */
  settleAll(): void {
    this.settle(() => true)
  }

  private settle(which: (w: FinalWait) => boolean): void {
    const done = this.waits.filter(which)
    this.waits = this.waits.filter((w) => !which(w))
    for (const w of done) {
      clearTimeout(w.timer)
      w.resolve()
    }
  }
}
