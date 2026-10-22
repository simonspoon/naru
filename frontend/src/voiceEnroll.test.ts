import { describe, expect, it } from 'vitest'
import {
  canStop,
  clock,
  enrollPath,
  nativeStatusLine,
  startNativeEnroll,
  meterFraction,
  meterStep,
  MIN_SECONDS,
  nearSilent,
  peakDb,
  READ_ALOUD,
  shouldAutoStop,
  STOP_SECONDS,
  TARGET_SECONDS,
} from './voiceEnroll'

describe('the schedule', () => {
  it('has a read-aloud text that fits the target time', () => {
    const words = READ_ALOUD.split(/\s+/).length
    // a 150 wpm reading finishes with at least 1.5 s to spare before the auto-stop
    const readingSeconds = (words / 150) * 60
    expect(readingSeconds).toBeLessThanOrEqual(TARGET_SECONDS - 1.5)
    expect(readingSeconds).toBeGreaterThanOrEqual(9)
  })

  it('allows stop from 9 s (margin over the 8 s minimum) and stops itself at 12 s', () => {
    expect(STOP_SECONDS).toBeGreaterThan(MIN_SECONDS)
    expect(canStop(STOP_SECONDS - 0.1)).toBe(false)
    expect(canStop(STOP_SECONDS)).toBe(true)
    expect(shouldAutoStop(11.9)).toBe(false)
    expect(shouldAutoStop(12)).toBe(true)
  })
})

describe('levels', () => {
  it('measures the peak in dBFS', () => {
    expect(peakDb(new Float32Array([0, 0.5, -1, 0.1]))).toBeCloseTo(0, 5)
    expect(peakDb(new Float32Array([0.1, -0.05]))).toBeCloseTo(-20, 5)
    expect(peakDb(new Float32Array(10))).toBe(-120)
    expect(peakDb(new Float32Array(0))).toBe(-120)
  })

  it('calls a take under -40 dBFS near-silent', () => {
    expect(nearSilent(-40.1)).toBe(true)
    expect(nearSilent(-40)).toBe(false)
    expect(nearSilent(-120)).toBe(true)
    expect(nearSilent(-6)).toBe(false)
  })

  it('maps rms onto a 0..1 meter', () => {
    expect(meterFraction(0)).toBe(0)
    expect(meterFraction(1)).toBe(1)
    expect(meterFraction(0.001)).toBeCloseTo(0, 5)
    expect(meterFraction(0.0316)).toBeCloseTo(0.5, 1)
  })

  it('gives a visible width for quiet speech through a loud beep', () => {
    expect(meterFraction(0.05)).toBeGreaterThan(0.5)
    expect(meterFraction(0.01)).toBeGreaterThan(0.3)
    expect(meterFraction(0.7)).toBeGreaterThan(0.9)
  })

  it('holds a pulse across ticks and falls back gradually', () => {
    let level = meterStep(0, meterFraction(0.3))
    expect(level).toBeGreaterThan(0.5)
    const peak = level
    // Silent ticks after a beep: still visible, then decaying toward 0.
    level = meterStep(level, 0)
    expect(level).toBeCloseTo(peak * 0.8, 5)
    for (let i = 0; i < 40; i++) level = meterStep(level, 0)
    expect(level).toBeLessThan(0.01)
    // A louder window jumps straight up.
    expect(meterStep(0.2, 0.9)).toBe(0.9)
  })

  it('formats the clock', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65.9)).toBe('1:05')
  })
})


describe('native enrollment (naru task 2259)', () => {
  it('takes the native path only with a host, and starts it with one op:start message, no getUserMedia', () => {
    const posted: unknown[] = []
    const host = { post: (m: unknown) => posted.push(m) }
    let micAsked = 0
    const orig = (globalThis as { navigator?: unknown }).navigator
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => { micAsked++; return Promise.reject(new Error('no')) } } },
    })
    try {
      expect(enrollPath(host as never)).toBe('native')
      expect(enrollPath(null)).toBe('browser')
      startNativeEnroll(host as never, 7)
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: orig })
    }
    expect(posted).toEqual([{ type: 'enroll', op: 'start', person: 7 }])
    expect(micAsked).toBe(0)
  })

  it('maps an enrollStatus payload to the status text', () => {
    const base = { enrolling: false, enrolled: false, note: null, seconds: 12, person: null }
    expect(nativeStatusLine(null)).toBe('Waiting for the Naru Mac app…')
    expect(nativeStatusLine(base)).toBe('Not enrolled')
    expect(nativeStatusLine({ ...base, enrolled: true })).toBe('Enrolled')
    expect(nativeStatusLine({ ...base, enrolling: true })).toBe('Recording — speak for 12 s')
    expect(nativeStatusLine({ ...base, enrolling: true, note: 'speak for 12 s' })).toBe('speak for 12 s')
    expect(nativeStatusLine({ ...base, note: 'enrollment failed: x' })).toBe('enrollment failed: x')
  })
})
