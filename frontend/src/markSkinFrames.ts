import type { MarkMode } from './liveMark'

/**
 * The face and blob mark skins' per-frame arithmetic (naru task 2121), kept
 * out of the `.tsx` painters so it can be tested without a DOM — the
 * `liveMark.ts::markFrame` split. Every function here is pure: a mode, a clock
 * and a 0..1 level in, the numbers to draw out. `reduced` halves the clock
 * (blinks included) and changes nothing else — half speed, never frozen.
 */

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

// --- Blinks ---------------------------------------------------------------

/** One blink's length, seconds (on the skin's own, possibly halved, clock). */
export const BLINK_SECONDS = 0.12

/** The gaps between blinks, 2.5..6 s, repeating; a fixed irregular cycle so a
 *  frame is a pure function of time and the face never blinks like a metronome. */
const BLINK_GAPS = [3.1, 4.6, 2.6, 5.4, 3.8, 2.9, 5.9, 4.1]
const BLINK_CYCLE = BLINK_GAPS.reduce((a, b) => a + b, 0)

/** How shut a blink has the eyes at clock `t`: 0 open .. 1 closed. */
export function blinkLid(t: number): number {
  let u = ((t % BLINK_CYCLE) + BLINK_CYCLE) % BLINK_CYCLE
  for (const gap of BLINK_GAPS) {
    if (u < gap) {
      const into = u - (gap - BLINK_SECONDS)
      return into > 0 ? Math.sin((Math.PI * into) / BLINK_SECONDS) : 0
    }
    u -= gap
  }
  return 0
}

// --- Face -----------------------------------------------------------------

/** What the face draws this frame, in the 64x64 viewBox. */
export interface FaceFrame {
  /** Whole-mark scale and opacity, glow strength 0..1 (the host-svg trio). */
  scale: number
  opacity: number
  glow: number
  /** Head tilt, degrees, about the centre. */
  tilt: number
  /** Pupils' offset from rest, viewBox units. */
  gazeX: number
  gazeY: number
  /** Eye height factor: 1 open, 0 shut (blinks folded in). */
  eyeOpen: number
  /** Eye size factor (wider when attentive). */
  eyeSize: number
  /** Brows: lift (negative is up) and the thinking tilt, degrees — the left
   *  brow raised and slanted by it, the right a little the other way. */
  browLift: number
  browTilt: number
  /** Mouth: how open 0..1, how much it smiles -1..1, width factor. */
  mouthOpen: number
  smile: number
  mouthWidth: number
}

export function faceFrame(mode: MarkMode, time: number, lv: number, reduced: boolean): FaceFrame {
  const t = reduced ? time * 0.5 : time
  const level = clamp01(lv)
  const blink = blinkLid(t)
  const breathe = Math.sin(t * 1.6)
  const base: FaceFrame = {
    scale: 0.92 + 0.03 * breathe,
    opacity: 1,
    glow: 0,
    tilt: 1.5 * Math.sin(t * 0.5),
    gazeX: 0.8 * Math.sin(t * 0.37),
    gazeY: 0.4 * Math.sin(t * 0.29),
    eyeOpen: 1 - blink,
    eyeSize: 1,
    browLift: 0,
    browTilt: 0,
    mouthOpen: 0,
    smile: 0.45,
    mouthWidth: 1,
  }
  if (mode === 'paused') {
    // Still, dimmed, eyes half shut: no blink, no breath, no drift.
    return { ...base, scale: 0.9, opacity: 0.5, tilt: 0, gazeX: 0, gazeY: 1, eyeOpen: 0.4, smile: 0.1 }
  }
  if (mode === 'hear') {
    // Attentive: wider eyes, brows up, leaning in, nodding faintly with the voice.
    return {
      ...base,
      scale: 0.95 + 0.12 * level,
      glow: level,
      tilt: -6 + 2 * level * Math.sin(t * 5),
      gazeX: -1.2,
      gazeY: -0.3,
      eyeOpen: 1 - blink,
      eyeSize: 1.18,
      browLift: -3 - 1.5 * level,
      smile: 0.3,
      mouthWidth: 0.8,
    }
  }
  if (mode === 'speak') {
    // The mouth follows the voice; the syllable wobble keeps a steady level alive.
    const open = clamp01(0.12 + 0.88 * level * (0.75 + 0.25 * Math.sin(t * 13)))
    return {
      ...base,
      scale: 0.93 + 0.1 * level,
      glow: level,
      tilt: 2 * Math.sin(t * 2.2),
      eyeSize: 1.05,
      browLift: -1.5 * level,
      mouthOpen: open,
      smile: 0.35,
      mouthWidth: 1 - 0.15 * open,
    }
  }
  if (mode === 'think') {
    // Looking up and aside, drifting; one brow raised; a small pursed mouth.
    return {
      ...base,
      scale: 0.95 + 0.03 * Math.sin(t * 3),
      glow: 0.45 + 0.25 * Math.sin(t * 3),
      tilt: 4 + 2 * Math.sin(t * 0.7),
      gazeX: 2.6 + 0.9 * Math.sin(t * 0.9),
      gazeY: -2.6 + 0.6 * Math.sin(t * 1.3),
      browLift: -1.5,
      browTilt: 12,
      smile: -0.1,
      mouthWidth: 0.55,
    }
  }
  if (mode === 'offer') {
    const pulse = Math.sin(t * 4)
    return { ...base, scale: 1 + 0.06 * pulse, glow: 0.7 + 0.3 * pulse, browLift: -2, eyeSize: 1.1, smile: 0.9, mouthWidth: 1.1 }
  }
  return base
}

// --- Blob -----------------------------------------------------------------

/** How many radii the blob's outline is drawn through. */
export const BLOB_POINTS = 8
/** The blob's resting radius, viewBox units. */
export const BLOB_RADIUS = 22

/** What the blob draws this frame. */
export interface BlobFrame {
  scale: number
  opacity: number
  glow: number
  /** How fast the outline turns, degrees a second (already halved under
   *  reduced motion); the painter integrates it, so a mode change never spins
   *  the blob round to catch up with a clock. */
  spin: number
  /** Each point's radius factor (1 = `BLOB_RADIUS`). */
  radii: number[]
}

const radiiOf = (f: (i: number) => number): number[] => Array.from({ length: BLOB_POINTS }, (_, i) => f(i))

export function blobFrame(mode: MarkMode, time: number, lv: number, reduced: boolean): BlobFrame {
  const speed = reduced ? 0.5 : 1
  const t = time * speed
  const level = clamp01(lv)
  if (mode === 'paused') {
    // Held still and dimmed, a little slumped: no motion at all.
    return { scale: 0.9, opacity: 0.5, glow: 0, spin: 0, radii: radiiOf((i) => 1 - 0.04 * Math.cos((i * 2 * Math.PI) / BLOB_POINTS)) }
  }
  if (mode === 'hear' || mode === 'speak') {
    // Wobbles and pulses with the level; a floor keeps it alive between words.
    const fast = mode === 'hear' ? 1 : 0.8
    const amp = 0.04 + 0.16 * level
    return {
      scale: 0.9 + 0.2 * level,
      opacity: 1,
      glow: level,
      spin: 8 * speed,
      radii: radiiOf(
        (i) => 1 + amp * (0.6 * Math.sin(t * 7 * fast + i * 1.9) + 0.4 * Math.sin(t * 11.3 * fast - i * 2.7)),
      ),
    }
  }
  if (mode === 'think') {
    // Turning slowly with a soft two-lobed ripple.
    return {
      scale: 0.95 + 0.03 * Math.sin(t * 3),
      opacity: 1,
      glow: 0.45 + 0.25 * Math.sin(t * 3),
      spin: 24 * speed,
      radii: radiiOf((i) => 1 + 0.07 * Math.sin(t * 2 + (i * 4 * Math.PI) / BLOB_POINTS)),
    }
  }
  if (mode === 'offer') {
    const pulse = Math.sin(t * 4)
    return {
      scale: 1 + 0.07 * pulse,
      opacity: 1,
      glow: 0.7 + 0.3 * pulse,
      spin: 6 * speed,
      radii: radiiOf((i) => 1 + 0.05 * Math.sin(t * 4 - i * 0.8)),
    }
  }
  // Idle: a slow breath with a gentle drifting ripple.
  return {
    scale: 0.9 + 0.05 * Math.sin(t * 1.6),
    opacity: 1,
    glow: 0,
    spin: 4 * speed,
    radii: radiiOf((i) => 1 + 0.035 * Math.sin(t * 1.1 + i * 2.3) + 0.02 * Math.sin(t * 0.7 - i * 1.3)),
  }
}

/**
 * A closed smooth outline through `radii` (factors of `r`) spread evenly
 * round (`cx`, `cy`), starting at `rotate` degrees: a Catmull-Rom spline
 * through the points, written as cubic Béziers.
 */
export function blobPath(radii: readonly number[], cx: number, cy: number, r: number, rotate = 0): string {
  const n = radii.length
  const a0 = (rotate * Math.PI) / 180
  const pts = radii.map((k, i) => {
    const a = a0 + (i * 2 * Math.PI) / n
    return [cx + r * k * Math.cos(a), cy + r * k * Math.sin(a)]
  })
  const f = (v: number): string => v.toFixed(2)
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`
  }
  return `${d}Z`
}

// --- Previews ---------------------------------------------------------------

/** The states the Settings previews cycle through, `null` being idle. */
export const PREVIEW_STATES = [null, 'hearing', 'speaking', 'working', 'paused'] as const
/** Seconds each preview state is shown. */
export const PREVIEW_SECONDS = 2

/** The preview's state at clock `t` seconds. */
export function previewState(t: number): (typeof PREVIEW_STATES)[number] {
  const i = Math.floor(Math.max(0, t) / PREVIEW_SECONDS) % PREVIEW_STATES.length
  return PREVIEW_STATES[i]
}

/** A made-up microphone RMS for the hearing preview (raw, as the mic reports
 *  it: 0.01..0.12, which `levelFromRms` maps to roughly 0.2..0.7). */
export function previewMicRms(t: number): number {
  return 0.01 + 0.11 * (0.5 + 0.5 * Math.sin(t * 6.3) * Math.sin(t * 1.7 + 0.6))
}
