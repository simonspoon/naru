import { describe, expect, it } from 'vitest'
import { createStretcher, deinterleave } from './timeStretch'

const RATE = 24000
const FREQ = 220

function sine(seconds: number): Float32Array {
  const n = Math.round(seconds * RATE)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = 0.8 * Math.sin((2 * Math.PI * FREQ * i) / RATE)
  return out
}

function cat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Stretches `input` fed in `sizes`-sized pieces (cycled). */
function stretch(input: Float32Array, speed: number, sizes: number[]): Float32Array {
  const st = createStretcher(speed, RATE, 1)
  const out: Float32Array[] = []
  let at = 0
  for (let i = 0; at < input.length; i++) {
    const size = sizes[i % sizes.length]
    out.push(st.push([input.subarray(at, at + size)])[0])
    at += size
  }
  out.push(st.flush()[0])
  return cat(out)
}

/** Frequency from the zero-crossing count of the settled middle. */
function frequency(x: Float32Array): number {
  const from = Math.floor(x.length * 0.1)
  const to = Math.floor(x.length * 0.9)
  let crossings = 0
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings++
  }
  return crossings / ((to - from) / RATE)
}

describe('createStretcher', () => {
  it('speed 1 is an exact, immediate passthrough', () => {
    const input = sine(0.5)
    const st = createStretcher(1, RATE, 1)
    const piece = input.subarray(0, 777)
    const out = st.push([piece])
    expect(out[0]).toBe(piece)
    expect(st.flush()[0].length).toBe(0)
    expect(cat(chunked(input, 1))).toEqual(input)
  })

  for (const speed of [0.75, 1.5]) {
    it(`stretches a 220 Hz sine at ${speed}x keeping length, pitch and continuity`, () => {
      const input = sine(2)
      const out = stretch(input, speed, [1000, 4096, 777])
      const expected = input.length / speed
      const lengthError = Math.abs(out.length - expected) / expected
      const freq = frequency(out)
      let maxStep = 0
      for (let i = 1; i < out.length; i++) {
        maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]))
      }
      const sineStep = 0.8 * 2 * Math.PI * (FREQ / RATE)
      expect(lengthError).toBeLessThan(0.02)
      expect(Math.abs(freq - FREQ) / FREQ).toBeLessThan(0.02)
      expect(maxStep).toBeLessThanOrEqual(sineStep * 1.5)
    })

    it(`gives the same samples chunked as in one shot at ${speed}x`, () => {
      const input = sine(2)
      const whole = stretch(input, speed, [input.length])
      const pieces = stretch(input, speed, [1000, 4096, 777])
      expect(pieces.length).toBe(whole.length)
      let worst = 0
      for (let i = 0; i < whole.length; i++) {
        worst = Math.max(worst, Math.abs(whole[i] - pieces[i]))
      }
      expect(worst).toBeLessThan(1e-6)
    })
  }

  it('stretches every channel of a stereo stream the same way', () => {
    const left = sine(1)
    const right = left.map((v) => -v)
    const st = createStretcher(1.25, RATE, 2)
    const a = st.push([left, right])
    const b = st.flush()
    const l = cat([a[0], b[0]])
    const r = cat([a[1], b[1]])
    expect(l.length).toBe(r.length)
    expect(l.length).toBeGreaterThan(0)
    for (let i = 0; i < l.length; i++) expect(r[i]).toBeCloseTo(-l[i], 6)
  })

  it('deinterleaves frames into planar channels', () => {
    const planar = deinterleave(new Float32Array([1, 2, 3, 4, 5, 6]), 2)
    expect(Array.from(planar[0])).toEqual([1, 3, 5])
    expect(Array.from(planar[1])).toEqual([2, 4, 6])
  })
})

function chunked(input: Float32Array, speed: number): Float32Array[] {
  const st = createStretcher(speed, RATE, 1)
  const out: Float32Array[] = []
  for (let at = 0; at < input.length; at += 777) {
    out.push(st.push([input.subarray(at, at + 777)])[0])
  }
  out.push(st.flush()[0])
  return out
}
