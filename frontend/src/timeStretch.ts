/**
 * Pitch-preserving time stretch for the decoded playback path (mesa task
 * 1560): WSOLA — waveform-similarity overlap-add.
 *
 * `speechStream.ts` schedules decoded PCM on the Web Audio clock; a source
 * node's `playbackRate` would shift the pitch with the speed, so the speech
 * speed setting stretches the samples instead. The element path gets the same
 * result from the browser (`preservesPitch`).
 *
 * Each output hop of `hop` samples is a Hann-windowed frame of `2 * hop`
 * input samples, overlap-added at 50 % (a periodic Hann at 50 % overlap sums to
 * one). Frame `k` is *nominally* read from `k * hop * speed` in the input, but
 * is shifted by up to `tolerance` samples to the offset whose start best
 * continues the previous frame's natural successor (normalised
 * cross-correlation), which keeps the waveform's phase continuous across the
 * join — no clicks, no flanging.
 *
 * The stretcher is **stateful across chunks**: it keeps the unconsumed input,
 * the overlap tail and the last chosen offset, and a frame is only built once
 * every sample it could look at has arrived — so the output is the same for
 * any way the input is chopped up. `flush` pads the end with silence and
 * emits what remains. Speed `1` is an exact passthrough: no copy, no latency.
 *
 * Pure: no DOM, no Web Audio — planar `Float32Array[]` in and out.
 */

/** Lowest and highest speed the setting allows (mirrors `core::config`). */
export const STRETCH_MIN = 0.75
export const STRETCH_MAX = 1.5

/** Output hop, seconds: a 30 ms window, long enough to span a pitch period. */
const HOP_SECONDS = 0.015
/** How far a frame may slide to find its match, seconds. */
const TOLERANCE_SECONDS = 0.01

export interface Stretcher {
  /** Feeds one chunk of planar audio; returns whatever output is now final. */
  push(chunk: Float32Array[]): Float32Array[]
  /** Ends the stream; returns the remaining output. */
  flush(): Float32Array[]
}

function empty(channels: number): Float32Array[] {
  return Array.from({ length: channels }, () => new Float32Array(0))
}

export function createStretcher(
  speed: number,
  sampleRate: number,
  channels: number,
): Stretcher {
  if (speed === 1) {
    return { push: (chunk) => chunk, flush: () => empty(channels) }
  }
  const s = Math.min(STRETCH_MAX, Math.max(STRETCH_MIN, speed))
  const hop = Math.max(16, Math.round(sampleRate * HOP_SECONDS))
  const frame = hop * 2
  const tol = Math.max(4, Math.round(sampleRate * TOLERANCE_SECONDS))
  const win = new Float32Array(frame)
  for (let i = 0; i < frame; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame)
  }

  // Unconsumed input: `buf[c][i]` is input sample `base + i`; `mix` is the
  // channel average the similarity search runs on.
  let buf: Float32Array[] = empty(channels)
  let mix = new Float32Array(0)
  let base = 0
  // The overlap tail of the previous frame, windowed, per channel.
  const tail: Float32Array[] = Array.from(
    { length: channels },
    () => new Float32Array(hop),
  )
  // What the previous frame's continuation looks like: the search target.
  const target = new Float32Array(hop)
  let k = 0 // next frame index
  let prev = 0 // absolute start the previous frame was read from

  function append(chunk: Float32Array[]) {
    const add = chunk[0].length
    if (add === 0) return
    buf = buf.map((b, c) => {
      const out = new Float32Array(b.length + add)
      out.set(b)
      out.set(chunk[c], b.length)
      return out
    })
    const nextMix = new Float32Array(mix.length + add)
    nextMix.set(mix)
    for (let i = 0; i < add; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += chunk[c][i]
      nextMix[mix.length + i] = sum / channels
    }
    mix = nextMix
  }

  function trim(from: number) {
    const drop = Math.min(Math.max(0, from - base), mix.length)
    if (drop === 0) return
    buf = buf.map((b) => b.slice(drop))
    mix = mix.slice(drop)
    base += drop
  }

  /** The mix at absolute index `i`, zero past either end. */
  const at = (i: number) => {
    const j = i - base
    return j >= 0 && j < mix.length ? mix[j] : 0
  }

  /** The offset in `[lo, hi]` whose next `hop` samples best match `target`. */
  function bestStart(lo: number, hi: number): number {
    let best = lo
    let bestScore = -Infinity
    for (let a = lo; a <= hi; a++) {
      let dot = 0
      let energy = 0
      for (let i = 0; i < hop; i++) {
        const x = at(a + i)
        dot += x * target[i]
        energy += x * x
      }
      const score = dot / Math.sqrt(energy + 1e-9)
      if (score > bestScore) {
        bestScore = score
        best = a
      }
    }
    return best
  }

  /** Builds frames while their input is all here (or `final`). */
  function run(final: boolean): Float32Array[] {
    const out: number[][] = Array.from({ length: channels }, () => [])
    for (;;) {
      const total = base + mix.length
      const nominal = Math.round(k * hop * s)
      if (final ? nominal >= total : total < nominal + tol + frame) break
      let start = 0
      if (k > 0) {
        trim(Math.min(nominal - tol, prev + hop))
        for (let i = 0; i < hop; i++) target[i] = at(prev + hop + i)
        start = bestStart(Math.max(0, nominal - tol), nominal + tol)
      }
      for (let c = 0; c < channels; c++) {
        const get = (i: number) => {
          const j = start + i - base
          return j >= 0 && j < buf[c].length ? buf[c][j] : 0
        }
        for (let i = 0; i < hop; i++) {
          // The very start has nothing to cross-fade from: it goes out as is
          // rather than fading the first words in.
          out[c].push(k === 0 ? get(i) : tail[c][i] + win[i] * get(i))
        }
        for (let i = 0; i < hop; i++) tail[c][i] = win[hop + i] * get(hop + i)
      }
      prev = start
      k++
    }
    return out.map((o) => Float32Array.from(o))
  }

  return {
    push(chunk) {
      append(chunk)
      return run(false)
    },
    flush() {
      return run(true)
    },
  }
}

/** `interleaved` samples as one planar array per channel. */
export function deinterleave(
  interleaved: Float32Array,
  channels: number,
): Float32Array[] {
  const frames = Math.floor(interleaved.length / channels)
  const planar = Array.from({ length: channels }, () => new Float32Array(frames))
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) planar[c][f] = interleaved[f * channels + c]
  }
  return planar
}
