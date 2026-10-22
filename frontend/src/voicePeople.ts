// The people voice library (naru task 2262, docs/voice-enrollment.md): the pure
// logic behind Settings > Voice's "People" section. The library lives in
// naru-audio; Naru's /api/voice/* routes relay it. Shapes are the daemon's.

import type { EnrollStatus } from './nativeHost'
import { nativeStatusLine } from './voiceEnroll'

export interface VoiceClip {
  id: number
  /** Unix time in seconds, as naru-audio reports it; 0 or absent for a migrated clip. */
  created_at?: number
  seconds: number
  /** False for a migrated clip: its embedding is kept, its audio is not. */
  has_audio: boolean
}

export interface VoicePerson {
  id: number
  name: string
  /** At most one person is "me". */
  owner: boolean
  clips: VoiceClip[]
}

export interface VoicePeople {
  model: string
  live_guard: boolean
  people: VoicePerson[]
}

/** The owner first, then by name, case-insensitively. */
export function sortPeople(people: VoicePerson[]): VoicePerson[] {
  return [...people].sort(
    (a, b) =>
      Number(b.owner) - Number(a.owner) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.id - b.id,
  )
}

/** The name to send, or null when it is blank. */
export function cleanName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  return trimmed === '' ? null : trimmed
}

/** `no clips`, `1 clip`, `3 clips`. */
export function clipCount(person: Pick<VoicePerson, 'clips'>): string {
  const n = person.clips.length
  return n === 0 ? 'no clips' : n === 1 ? '1 clip' : `${n} clips`
}

/** Whether the clip has audio to play. */
export function canPlay(clip: VoiceClip): boolean {
  return clip.has_audio
}

/** `12.4 s`, or `n/a` for a migrated clip that has no length. */
export function clipLength(clip: VoiceClip): string {
  return clip.seconds > 0 ? `${clip.seconds.toFixed(1)} s` : 'n/a'
}

/** One clip's line: its day, its length and, when it has none, why it will not play. */
export function clipLine(clip: VoiceClip): string {
  const day =
    typeof clip.created_at === 'number' && clip.created_at > 0
      ? new Date(clip.created_at * 1000).toISOString().slice(0, 10)
      : 'migrated'
  return canPlay(clip)
    ? `${day} · ${clipLength(clip)}`
    : `${day} · ${clipLength(clip)} · no audio kept`
}

/** The route for a clip's audio. */
export function clipAudioUrl(personId: number, clipId: number): string {
  return `/api/voice/people/${personId}/clips/${clipId}/audio`
}

/** The note under the live guard switch. */
export const GUARD_NOTE =
  'When on, a live conversation drops speech that is not the person marked “me” — only ' +
  'segments of 2 s or longer, and only once “me” has a clip. Ambient listening tags who spoke ' +
  'from the voiceprints either way, whatever this switch says.'

/** Whether a host status ends a recording, so the list should be read again. */
export function enrollFinished(
  prev: Pick<EnrollStatus, 'enrolling'> | null,
  next: Pick<EnrollStatus, 'enrolling'>,
): boolean {
  return !next.enrolling && (prev === null || prev.enrolling)
}

/** Whether the Mac app is recording for this person right now. */
export function nativeRecording(s: EnrollStatus | null, personId: number): boolean {
  return !!s && s.enrolling && s.person === personId
}

/** A row's request to the Mac app, and the host's answer to it once one arrives. */
export type NativeAsk = { personId: number; answer: EnrollStatus | null }

export function askNative(personId: number): NativeAsk {
  return { personId, answer: null }
}

/**
 * Folds a status pushed by the host into the pending ask. The host refuses
 * ("leave live first") before it updates its person, so the first status
 * after the ask that is not enrolling and carries a note is the answer,
 * whatever its `person`. An `enrolling` status never answers. `fresh` is
 * false for the replay of the last status on subscribe, which is stale.
 */
export function observeAsk(ask: NativeAsk | null, next: EnrollStatus, fresh: boolean): NativeAsk | null {
  if (!ask || ask.answer || !fresh) return ask
  if (next.enrolling || !next.note) return ask
  return { ...ask, answer: next }
}

/**
 * What the row that asked the Mac app to record says: the answer when there
 * is one (the host's note, else "Clip added." — `enrolled` stays false for a
 * non-owner so it is never read), the recording line while the host records
 * for this person, else "Starting…".
 */
export function nativeRowLine(ask: NativeAsk, s: EnrollStatus | null): string {
  if (ask.answer) return ask.answer.note ?? 'Clip added.'
  if (s && s.enrolling && s.person === ask.personId) return nativeStatusLine(s)
  return 'Starting…'
}
