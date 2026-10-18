// Pure logic behind Settings > Gestures > Library and the pose recording
// wizard (naru task 1973): the gesture model, duplicate/delete rules, draft
// validation, take consistency, try matching and lookalike warnings.

import { actionText, type GestureBinding } from './gestureBindings'

export type Hand = 'either' | 'left' | 'right'

export type Gesture = {
  id: string
  name: string
  pose: string // 'open-palm' | 'fist' | 'custom' …
  motion: string // 'still' | 'right' | …
  holdS: number
  hand: Hand
  builtin: boolean
  /** Feature vectors of a recorded pose's takes; absent for built-ins. */
  takes?: number[][]
  /** Resampled path vectors of a recorded motion's takes (naru task 1974). */
  motionTakes?: number[][]
  /** Match strictness (%) chosen when the pose was recorded. */
  threshold?: number
}

export const POSES: [string, string][] = [
  ['open-palm', 'Open palm'],
  ['fist', 'Fist'],
  ['pinch', 'Pinch'],
  ['point', 'Point'],
  ['custom', 'Custom pose'],
]
export const MOTIONS: [string, string][] = [
  ['still', 'Still'],
  ['right', 'Move right'],
  ['left', 'Move left'],
  ['up', 'Move up'],
  ['down', 'Move down'],
  ['custom', 'Custom path'],
]
export const HOLD_MIN_S = 0
export const HOLD_MAX_S = 5
export const TAKES = 3
/** Overlap (%) at which another gesture counts as a lookalike. */
export const LOOKALIKE_MIN = 50
export const TRIES_KEPT = 5
export const DEFAULT_THRESHOLD = 70

export const BUILTIN_GESTURES: Gesture[] = [
  { id: 'palm-hold', name: 'Palm hold', pose: 'open-palm', motion: 'still', holdS: 1, hand: 'either', builtin: true },
  { id: 'palm-tap', name: 'Palm tap', pose: 'open-palm', motion: 'still', holdS: 0.2, hand: 'either', builtin: true },
  { id: 'fist-hold', name: 'Fist hold', pose: 'fist', motion: 'still', holdS: 1, hand: 'either', builtin: true },
  { id: 'swipe-right', name: 'Swipe right', pose: 'open-palm', motion: 'right', holdS: 0, hand: 'either', builtin: true },
  { id: 'swipe-left', name: 'Swipe left', pose: 'open-palm', motion: 'left', holdS: 0, hand: 'either', builtin: true },
]

const labelOf = (list: [string, string][], id: string) => list.find((x) => x[0] === id)?.[1] ?? id

/** "open palm · still" */
export function poseMotionText(g: Pick<Gesture, 'pose' | 'motion'>): string {
  return `${labelOf(POSES, g.pose).toLowerCase()} · ${labelOf(MOTIONS, g.motion).toLowerCase()}`
}

export const holdText = (s: number): string => `${s.toFixed(1)}s`

/** The actions bound to a gesture, or null when nothing uses it. */
export function usedBy(g: Gesture, bindings: GestureBinding[]): string | null {
  const names = bindings.filter((b) => b.gesture === g.id).map((b) => actionText(b))
  return names.length ? names.join(', ') : null
}

export const canDelete = (g: Gesture): boolean => !g.builtin

/** "X copy", "X copy 2" … unique among names (case-insensitive). */
export function duplicateName(name: string, all: Gesture[]): string {
  const taken = new Set(all.map((g) => g.name.toLowerCase()))
  let cand = `${name} copy`
  for (let i = 2; taken.has(cand.toLowerCase()); i++) cand = `${name} copy ${i}`
  return cand
}

/** A recorded copy of a gesture; a duplicate is never a built-in. */
export function duplicateOf(g: Gesture, all: Gesture[]): Gesture {
  return { ...g, id: `rec-${Date.now()}-${all.length}`, name: duplicateName(g.name, all), builtin: false }
}

/** Why a gesture cannot be saved, or null. */
export function gestureError(g: Gesture, all: Gesture[]): string | null {
  const name = g.name.trim()
  if (!name) return 'Name the gesture'
  if (all.some((x) => x.id !== g.id && x.name.trim().toLowerCase() === name.toLowerCase())) return 'That name is already used'
  if (!Number.isFinite(g.holdS) || g.holdS < HOLD_MIN_S || g.holdS > HOLD_MAX_S)
    return `Hold time must be ${HOLD_MIN_S}–${HOLD_MAX_S} seconds`
  return null
}

/** Similarity 0–100 of two feature vectors (cosine, negatives clamp to 0). */
export function similarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return Math.round(Math.max(0, dot / Math.sqrt(na * nb)) * 100)
}

/** Mean pairwise similarity across takes; null until two exist. */
export function consistency(takes: (number[] | null)[]): number | null {
  const got = takes.filter((t): t is number[] => !!t)
  if (got.length < 2) return null
  let sum = 0
  let n = 0
  for (let i = 0; i < got.length; i++)
    for (let j = i + 1; j < got.length; j++) {
      sum += similarity(got[i], got[j])
      n++
    }
  return Math.round(sum / n)
}

export function consistencyWord(pct: number | null): string {
  if (pct === null) return ''
  return pct >= 90 ? 'great' : pct >= 75 ? 'ok' : 'low'
}

export type TakeStatus = 'captured' | 'holding' | 'recording' | 'waiting'

/** Take i's status: captured if it has a sample, holding if it is the active
 *  take, else waiting. */
export function takeStatus(
  i: number,
  takes: (number[] | null)[],
  active: number | null,
  busy: TakeStatus = 'holding',
): TakeStatus {
  if (takes[i]) return 'captured'
  return active === i ? busy : 'waiting'
}

/** Index of the first take with no sample, or null when all are captured. */
export function nextTake(takes: (number[] | null)[]): number | null {
  const i = takes.findIndex((t) => !t)
  return i < 0 ? null : i
}

export const allCaptured = (takes: (number[] | null)[]): boolean => takes.length === TAKES && takes.every(Boolean)

/** The mean of the captured takes, the vector a recorded pose is matched by. */
export function averageTake(takes: number[][]): number[] {
  const len = Math.min(...takes.map((t) => t.length))
  return Array.from({ length: len }, (_, i) => takes.reduce((s, t) => s + t[i], 0) / takes.length)
}

export type Try = { score: number; ok: boolean }

/** Newest first, capped at TRIES_KEPT. */
export function addTry(tries: Try[], score: number, threshold: number): Try[] {
  return [{ score, ok: score >= threshold }, ...tries].slice(0, TRIES_KEPT)
}

export function tryText(name: string, score: number, threshold: number): string {
  return score >= threshold ? `✓ Recognized: ${name} (match ${score}%)` : `Not recognized (${score}%)`
}

export type Lookalike = { name: string; overlap: number }

/** The nearest other gesture at or above LOOKALIKE_MIN, or null. */
export function lookalike(overlaps: Lookalike[]): Lookalike | null {
  const top = overlaps.reduce<Lookalike | null>((m, o) => (!m || o.overlap > m.overlap ? o : m), null)
  return top && top.overlap >= LOOKALIKE_MIN ? top : null
}

export const lookalikeText = (l: Lookalike): string =>
  `Close to ${l.name}, ${l.overlap}% overlap. Raise strictness or re-record.`

/** Overlaps of a recorded pose against the other gestures that carry takes. */
export function overlapsWith(sample: number[], others: Gesture[]): Lookalike[] {
  return others
    .filter((g) => g.takes && g.takes.length)
    .map((g) => ({ name: g.name, overlap: similarity(sample, averageTake(g.takes!)) }))
}

/** Overlaps of a recorded path against the other gestures that carry motion takes. */
export function motionOverlaps(sample: number[], others: Gesture[]): Lookalike[] {
  return others
    .filter((g) => g.motionTakes && g.motionTakes.length)
    .map((g) => ({ name: g.name, overlap: similarity(sample, averageTake(g.motionTakes!)) }))
}

/** Why a gesture made of these parts cannot be saved: at least one is needed
 *  and each must have been recorded. */
export function partsError(pose: boolean, motion: boolean, hasPose: boolean, hasMotion: boolean): string | null {
  if (!pose && !motion) return 'Choose Pose, Motion or both'
  if (pose && !hasPose) return 'Pose was not recorded'
  if (motion && !hasMotion) return 'Motion was not recorded'
  return null
}

/** The match shown for the checked parts: the weakest of them, since a
 *  gesture only fires when every part matches. */
export function combinedScore(pose: number | null, motion: number | null): number | null {
  const got = [pose, motion].filter((x): x is number => x !== null)
  return got.length ? Math.min(...got) : null
}
