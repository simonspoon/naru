/**
 * The real playback level for the Naru mark (mesa task 1544): an
 * `AnalyserNode` between whatever is sounding and the speakers, read as an
 * RMS once a frame. Both playback paths go through one — the Web Audio
 * decode fallback (`speechStream.ts`, handed `decodeOutput`) and the page's
 * single `<audio>` element (`tapElement`). Neither changes what is heard: the
 * analyser is a pass-through into `ctx.destination`.
 *
 * `speechRms()` is `null` when nothing is tapped, and the mark then falls back
 * to the simulated envelope (`liveBand.simEnvelope`) rather than reading a
 * silent analyser as a silent voice. That happens only if the element could
 * not be tapped (see `tapElement`).
 */
import { frameRms } from './liveAudio'

interface Tap {
  analyser: AnalyserNode
  buf: Float32Array<ArrayBuffer>
}

const taps = new WeakMap<AudioContext, Tap>()
/** `createMediaElementSource` may be called once per element, ever. */
const elements = new WeakMap<HTMLMediaElement, AudioContext>()
let current: Tap | null = null

function tapFor(ctx: AudioContext): Tap {
  let tap = taps.get(ctx)
  if (tap === undefined) {
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.connect(ctx.destination)
    tap = { analyser, buf: new Float32Array(analyser.fftSize) }
    taps.set(ctx, tap)
  }
  return tap
}

/** Where the decode path connects its sources instead of `ctx.destination`,
 *  and marks the decode path as the one being measured. */
export function decodeOutput(ctx: AudioContext): AudioNode {
  const tap = tapFor(ctx)
  current = tap
  return tap.analyser
}

/**
 * Routes the `<audio>` element through the analyser, once, and marks it as
 * the one being measured. Rerouting an element is irreversible and silences
 * it if its context never runs, so this refuses (returns false, element left
 * alone, mark falls back to the simulated envelope) unless `ctx` is running
 * now or the element already went through this very context.
 */
export function tapElement(ctx: AudioContext, el: HTMLMediaElement): boolean {
  const bound = elements.get(el)
  if (bound === undefined) {
    if (ctx.state !== 'running') {
      current = null
      return false
    }
    try {
      ctx.createMediaElementSource(el).connect(tapFor(ctx).analyser)
      elements.set(el, ctx)
      // Once the element is routed, its sound exists only while this context
      // runs: a browser that suspends or interrupts it (Safari does) would
      // mute the voice, so bring it back whenever it stops.
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') void ctx.resume()
      })
    } catch {
      current = null
      return false
    }
  } else if (bound !== ctx) {
    // Bound to another context: it cannot be moved. The hub never closes or
    // replaces its context while the element is bound, so this is unreachable there.
    current = null
    return false
  }
  current = tapFor(ctx)
  return true
}

/** Raw RMS of what is sounding now, or null when nothing is tapped. */
export function speechRms(): number | null {
  if (current === null) return null
  current.analyser.getFloatTimeDomainData(current.buf)
  return frameRms(current.buf)
}
