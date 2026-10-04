/**
 * The audible half of the violet "working" state (mesa task 1620): when the
 * page posts a `user` turn it plays one soft two-note chime, then a slow quiet
 * pulse until Naru's speech starts. Pure decisions and envelope numbers live
 * here; `LiveHub` owns the one `AudioContext` and calls `playChime` /
 * `startPulse` on it.
 *
 * Quiet on purpose. The capture stream is open while the pulse plays (the
 * microphone only shuts while Naru *speaks*), so the cue must not be heard as
 * speech: peak gains are 0.03-0.05, a pure sine, and the cue goes straight to
 * `ctx.destination` — never through the speech tap, so it cannot move the
 * mark's level either.
 */
import type { LiveTurn } from './types/LiveTurn'
import { isNaruRole } from './liveTurns'

export interface Note {
  freq: number
  /** Seconds after the chime starts. */
  start: number
  /** Seconds the note rings (exponential decay to silence). */
  dur: number
  peak: number
}

/** A5 then E6, the second starting 0.12 s after the first. */
export const CHIME: readonly Note[] = [
  { freq: 880, start: 0, dur: 0.22, peak: 0.05 },
  { freq: 1318.5, start: 0.12, dur: 0.22, peak: 0.05 },
]

export const PULSE_HZ = 330
export const PULSE_PEAK = 0.03
export const PULSE_SWELL_S = 0.6
export const PULSE_FADE_S = 0.8
export const PULSE_PERIOD_S = 2
/** The pulse begins once the chime has rung out. */
export const PULSE_DELAY_S = 0.5
/** Safety cap: a cue still armed this long is a session nothing is answering. */
export const MAX_ARMED_MS = 3 * 60 * 1000
/** The ramp that silences the pulse the moment speech plays. */
export const STOP_RAMP_S = 0.03

/** Gain breakpoints of one pulse beat: [seconds after beat start, gain]. */
export function pulseBeat(): [number, number][] {
  return [
    [0, 0],
    [PULSE_SWELL_S, PULSE_PEAK],
    [PULSE_SWELL_S + PULSE_FADE_S, 0],
  ]
}

export interface ThinkingState {
  armed: boolean
  /** The agent has been seen working since the cue was armed. */
  sawWorking: boolean
  /** Newest turn id when armed: a Naru turn past it is the reply. */
  afterId: number
}

export const IDLE: ThinkingState = { armed: false, sawWorking: false, afterId: 0 }
/** A `user` turn was just posted; `turns` is what the page holds now. */
export function armedState(turns: readonly LiveTurn[]): ThinkingState {
  return { armed: true, sawWorking: false, afterId: turns.reduce((m, t) => Math.max(m, t.id), 0) }
}

/**
 * The Naru turns after the person's last, with words still to be said by
 * *this* page (`ownsVoice`: not another browser's to speak, not read-only).
 */
export function pendingSpeech(
  turns: readonly LiveTurn[],
  ownsVoice: (turn: LiveTurn) => boolean,
): boolean {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (!isNaruRole(turn.role)) return false
    if (turn.played_at === null && turn.text.trim() !== '' && ownsVoice(turn)) return true
  }
  return false
}

/**
 * Where the cue goes next. It is switched off by speech playing, the
 * conversation ending, a pause or the page leaving it, and once the reply has
 * come with nothing left for this page to say: a Naru turn newer than the one
 * held at arming (so a fast action-only reply, or a reply this page is not
 * the speaker for, ends it even if `working_since` was never caught on the 2s
 * poll), or the agent having been seen working and no longer. Until one of
 * those the cue holds.
 */
export function nextThinking(
  prev: ThinkingState,
  input: {
    live: boolean
    joined: boolean
    paused: boolean
    speaking: boolean
    working: boolean
    turns: readonly LiveTurn[]
    ownsVoice: (turn: LiveTurn) => boolean
  },
): ThinkingState {
  if (!input.live || !input.joined || input.paused || input.speaking) return IDLE
  if (!prev.armed) return prev
  const sawWorking = prev.sawWorking || input.working
  const replied = input.turns.some((t) => isNaruRole(t.role) && t.id > prev.afterId)
  if ((replied || (sawWorking && !input.working)) && !pendingSpeech(input.turns, input.ownsVoice)) {
    return IDLE
  }
  return sawWorking === prev.sawWorking ? prev : { ...prev, sawWorking }
}

export interface ThinkingCue {
  /** The two-note chime, once. */
  chime(): void
  /** Begin the slow pulse after the chime's delay; a no-op while running. */
  startPulse(): void
  /** Ramp the pulse to silence in `STOP_RAMP_S` and stop its oscillator. */
  stop(): void
}

/** The cue on `ctx`, wired straight to its destination (never the speech tap). */
export function createThinkingCue(ctx: AudioContext): ThinkingCue {
  let pulse: { osc: OscillatorNode; gain: GainNode; timer: number } | null = null
  return {
    chime() {
      const t0 = ctx.currentTime
      for (const n of CHIME) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = n.freq
        gain.gain.setValueAtTime(0.0001, t0 + n.start)
        gain.gain.exponentialRampToValueAtTime(n.peak, t0 + n.start + 0.01)
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.start + n.dur)
        osc.connect(gain).connect(ctx.destination)
        osc.start(t0 + n.start)
        osc.stop(t0 + n.start + n.dur + 0.05)
      }
    },
    startPulse() {
      if (pulse !== null) return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = PULSE_HZ
      gain.gain.value = 0
      osc.connect(gain).connect(ctx.destination)
      osc.start()
      const beat = (at: number) => {
        gain.gain.setValueAtTime(0, at)
        for (const [dt, g] of pulseBeat().slice(1)) gain.gain.linearRampToValueAtTime(g, at + dt)
      }
      let next = ctx.currentTime + PULSE_DELAY_S
      beat(next)
      // Two beats are always scheduled ahead, so a timer that fires late never
      // leaves a gap.
      next += PULSE_PERIOD_S
      beat(next)
      const timer = window.setInterval(() => {
        next += PULSE_PERIOD_S
        beat(next)
      }, PULSE_PERIOD_S * 1000)
      pulse = { osc, gain, timer }
    },
    stop() {
      if (pulse === null) return
      const { osc, gain, timer } = pulse
      pulse = null
      window.clearInterval(timer)
      const now = ctx.currentTime
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(gain.gain.value, now)
      gain.gain.linearRampToValueAtTime(0, now + STOP_RAMP_S)
      osc.stop(now + STOP_RAMP_S + 0.01)
      osc.onended = () => gain.disconnect()
    },
  }
}
