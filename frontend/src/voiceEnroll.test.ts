import { describe, expect, it } from 'vitest'
import {
  awaitingMacApp,
  canStop,
  clock,
  meterFraction,
  meterStep,
  nearSilent,
  peakDb,
  promptAt,
  PROMPT_SECONDS,
  READ_ALOUD,
  REPLY_PROMPTS,
  SCRIPT_SECONDS,
  shouldAutoStop,
  STOP_SECONDS,
  statusLine,
  TARGET_SECONDS,
} from './voiceEnroll'
import type { VoiceEnrollment } from './types/VoiceEnrollment'

const sample = { bytes: 100, seconds: 90, recorded_at: '2026-10-09T10:00:00Z' }

describe('the schedule', () => {
  it('fills the target time', () => {
    expect(SCRIPT_SECONDS + REPLY_PROMPTS.length * PROMPT_SECONDS).toBe(TARGET_SECONDS)
    const words = READ_ALOUD.split(/\s+/).length
    // ~150 wpm or slower over the script window
    expect(words / (SCRIPT_SECONDS / 60)).toBeLessThanOrEqual(160)
    expect(words / (SCRIPT_SECONDS / 60)).toBeGreaterThan(120)
  })

  it('shows the paragraph, then each reply in turn, then done', () => {
    expect(promptAt(0)).toEqual({ kind: 'script', text: READ_ALOUD })
    expect(promptAt(SCRIPT_SECONDS - 0.1).kind).toBe('script')
    expect(promptAt(SCRIPT_SECONDS)).toEqual({ kind: 'reply', text: REPLY_PROMPTS[0], index: 0 })
    expect(promptAt(SCRIPT_SECONDS + PROMPT_SECONDS).text).toBe(REPLY_PROMPTS[1])
    expect(promptAt(TARGET_SECONDS - 0.1).text).toBe(REPLY_PROMPTS[REPLY_PROMPTS.length - 1])
    expect(promptAt(TARGET_SECONDS + 5).text).toBe(REPLY_PROMPTS[REPLY_PROMPTS.length - 1])
  })

  it('allows stop from 22 s (margin over the 20 s minimum) and stops itself at 90 s', () => {
    expect(STOP_SECONDS).toBeGreaterThan(20)
    expect(canStop(STOP_SECONDS - 0.1)).toBe(false)
    expect(canStop(STOP_SECONDS)).toBe(true)
    expect(shouldAutoStop(89.9)).toBe(false)
    expect(shouldAutoStop(90)).toBe(true)
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

describe('statusLine', () => {
  const base: VoiceEnrollment = { sample: null, enrolled_at: null, current: false }
  it('reads each state', () => {
    expect(statusLine(null)).toBe('Checking…')
    expect(statusLine(base)).toBe('Not enrolled')
    expect(statusLine({ ...base, sample })).toBe(
      'Sample saved — waiting for the Naru Mac app to build the enrollment',
    )
    expect(
      statusLine({ sample, enrolled_at: '2026-10-09T10:05:00Z', current: true }),
    ).toBe('Enrolled 2026-10-09')
    // An enrollment older than the sample is not this voice yet.
    expect(
      statusLine({ sample, enrolled_at: '2026-01-01T00:00:00Z', current: false }),
    ).toContain('waiting')
  })

  it('polls only while a saved sample has no current enrollment', () => {
    expect(awaitingMacApp(null)).toBe(false)
    expect(awaitingMacApp({ sample: null, enrolled_at: null, current: false })).toBe(false)
    expect(awaitingMacApp({ sample, enrolled_at: null, current: false })).toBe(true)
    expect(awaitingMacApp({ sample, enrolled_at: 'x', current: true })).toBe(false)
  })
})
