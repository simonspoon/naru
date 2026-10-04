import { describe, expect, it } from 'vitest'
import {
  armedState,
  CHIME,
  IDLE,
  PULSE_PEAK,
  nextThinking,
  pendingSpeech,
  pulseBeat,
} from './liveThinkingCue'
import type { LiveTurn } from './types/LiveTurn'

describe('envelope', () => {
  it('chime is two quiet sine notes, 880 then 1318.5, second 0.12s later', () => {
    expect(CHIME.map((n) => n.freq)).toEqual([880, 1318.5])
    expect(CHIME[1].start - CHIME[0].start).toBeCloseTo(0.12)
    for (const n of CHIME) {
      expect(n.peak).toBeLessThanOrEqual(0.06)
      expect(n.dur).toBeGreaterThanOrEqual(0.15)
      expect(n.dur).toBeLessThanOrEqual(0.25)
    }
  })
  it('pulse swells over 0.6s and fades over 0.8s from and to silence', () => {
    expect(pulseBeat()).toEqual([
      [0, 0],
      [0.6, PULSE_PEAK],
      [0.6 + 0.8, 0],
    ])
  })
})

const T = (id: number, role: string, text = '', played: string | null = null) =>
  ({ id, role, text, played_at: played }) as unknown as LiveTurn
const mine = () => true
const theirs = () => false
const user = T(1, 'user', 'hi')
const ARMED = armedState([user])
const base = {
  live: true,
  joined: true,
  paused: false,
  speaking: false,
  working: false,
  turns: [user],
  ownsVoice: mine,
}

describe('nextThinking', () => {
  it('holds while armed and nothing has happened', () => {
    expect(nextThinking(ARMED, base)).toBe(ARMED)
  })
  it('stays idle when not armed', () => {
    expect(nextThinking(IDLE, { ...base, working: true })).toBe(IDLE)
  })
  it.each([{ live: false }, { joined: false }, { paused: true }, { speaking: true }])(
    'stops on %o',
    (over) => {
      expect(nextThinking(ARMED, { ...base, ...over })).toBe(IDLE)
    },
  )
  it('does not read not-working-yet as done, but stops after working ends', () => {
    const seen = nextThinking(ARMED, { ...base, working: true })
    expect(seen.sawWorking).toBe(true)
    expect(nextThinking(seen, base)).toBe(IDLE)
  })
  it('keeps pulsing when work ended but speech is pending for this page', () => {
    const seen = { ...ARMED, sawWorking: true }
    const turns = [user, T(2, 'naru', 'hello')]
    expect(nextThinking(seen, { ...base, turns })).toBe(seen)
  })
  it('stops on an action-only reply even if working was never seen', () => {
    const turns = [user, T(2, 'naru', '')]
    expect(nextThinking(ARMED, { ...base, turns })).toBe(IDLE)
  })
  it('stops on a legacy mesa-role reply', () => {
    expect(nextThinking(ARMED, { ...base, turns: [user, T(2, 'mesa', '')] })).toBe(IDLE)
  })
  it('a non-speaker page stops once the reply arrives', () => {
    const turns = [user, T(2, 'naru', 'hello')]
    expect(nextThinking(ARMED, { ...base, turns, ownsVoice: theirs })).toBe(IDLE)
    expect(nextThinking(ARMED, { ...base, turns })).toBe(ARMED)
  })
  it('an older Naru turn is not the reply', () => {
    const old = T(0, 'naru', '', null)
    const st = armedState([old, user])
    expect(nextThinking(st, { ...base, turns: [old, user] })).toBe(st)
  })
})

describe('pendingSpeech', () => {
  it('is true for an unplayed Naru turn after the last user turn', () => {
    expect(pendingSpeech([user, T(2, 'naru', 'hello')], mine)).toBe(true)
  })
  it('is false for a played, empty, earlier or not-ours turn', () => {
    expect(pendingSpeech([T(0, 'naru', 'a'), user], mine)).toBe(false)
    expect(pendingSpeech([user, T(2, 'naru', 'a', 'x')], mine)).toBe(false)
    expect(pendingSpeech([user, T(2, 'naru', '')], mine)).toBe(false)
    expect(pendingSpeech([user, T(2, 'naru', 'a')], theirs)).toBe(false)
  })
})
