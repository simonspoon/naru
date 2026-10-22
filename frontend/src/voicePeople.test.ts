import { describe, expect, it } from 'vitest'
import {
  canPlay,
  cleanName,
  clipAudioUrl,
  clipCount,
  clipLine,
  enrollFinished,
  nativeRecording,
  askNative,
  observeAsk,
  type VoicePeople,
  nativeRowLine,
  sortPeople,
  type VoiceClip,
  type VoicePerson,
} from './voicePeople'

const clip = (over: Partial<VoiceClip> = {}): VoiceClip => ({
  id: 1,
  created_at: 1792689320,
  seconds: 12.34,
  has_audio: true,
  ...over,
})
const person = (over: Partial<VoicePerson> = {}): VoicePerson => ({
  id: 1,
  name: 'Me',
  owner: false,
  clips: [],
  ...over,
})

describe('people', () => {
  it('lists the owner first, then by name', () => {
    const sorted = sortPeople([
      person({ id: 1, name: 'zoe' }),
      person({ id: 2, name: 'Alex' }),
      person({ id: 3, name: 'Sam', owner: true }),
    ])
    expect(sorted.map((p) => p.id)).toEqual([3, 2, 1])
  })

  it('does not reorder the input', () => {
    const input = [person({ id: 1, name: 'b' }), person({ id: 2, name: 'a' })]
    sortPeople(input)
    expect(input.map((p) => p.id)).toEqual([1, 2])
  })

  it('trims and collapses a name and refuses a blank one', () => {
    expect(cleanName('  Ada   Lovelace ')).toBe('Ada Lovelace')
    expect(cleanName('   ')).toBeNull()
  })

  it('counts clips', () => {
    expect(clipCount(person())).toBe('no clips')
    expect(clipCount(person({ clips: [clip()] }))).toBe('1 clip')
    expect(clipCount(person({ clips: [clip(), clip({ id: 2 })] }))).toBe('2 clips')
  })
})

describe('clips', () => {
  it('plays only a clip that kept its audio', () => {
    expect(canPlay(clip())).toBe(true)
    expect(canPlay(clip({ has_audio: false }))).toBe(false)
  })

  it('describes a clip and says when it has no audio', () => {
    expect(clipLine(clip())).toBe('2026-10-22 · 12.3 s')
    expect(clipLine(clip({ created_at: 0, seconds: 0, has_audio: false }))).toBe(
      'migrated · n/a · no audio kept',
    )
  })

  it('addresses a clip audio route', () => {
    expect(clipAudioUrl(3, 9)).toBe('/api/voice/people/3/clips/9/audio')
  })
})

describe('the Mac app recording status', () => {
  it('refreshes the list when a recording ends, not while it runs', () => {
    const on = { enrolling: true }
    const off = { enrolling: false }
    expect(enrollFinished(null, on)).toBe(false)
    expect(enrollFinished(on, on)).toBe(false)
    expect(enrollFinished(on, off)).toBe(true)
    expect(enrollFinished(off, off)).toBe(false)
  })
})

describe('which row the Mac app status belongs to', () => {
  const base = { enrolling: true, enrolled: false, note: null, seconds: 12, person: 2 }
  const ask = askNative(2)

  it('recording shows only on the person being recorded', () => {
    expect(nativeRecording(base, 2)).toBe(true)
    expect(nativeRecording(base, 3)).toBe(false)
    expect(nativeRecording({ ...base, enrolling: false }, 2)).toBe(false)
    expect(nativeRecording(null, 2)).toBe(false)
  })

  it('reads as starting until the host records for this person', () => {
    expect(nativeRowLine(ask, null)).toBe('Starting…')
    expect(nativeRowLine(ask, { ...base, person: 3 })).toBe('Starting…')
    expect(nativeRowLine(ask, base)).toBe('Recording — speak for 12 s')
  })

  it('an enrolling status never answers an ask', () => {
    expect(observeAsk(ask, base, true)).toBe(ask)
    expect(observeAsk(ask, { ...base, person: 3 }, true)).toBe(ask)
  })

  it('shows a refusal whatever person it carries', () => {
    const refusal = { ...base, enrolling: false, note: 'leave live first', person: null }
    const answered = observeAsk(ask, refusal, true)
    expect(nativeRowLine(answered!, refusal)).toBe('leave live first')
    const previous = { ...refusal, person: 9 }
    expect(nativeRowLine(observeAsk(ask, previous, true)!, previous)).toBe('leave live first')
  })

  it('ignores a replayed status and one without a note', () => {
    const refusal = { ...base, enrolling: false, note: 'leave live first' }
    expect(observeAsk(ask, refusal, false)).toBe(ask)
    expect(observeAsk(ask, { ...refusal, note: null }, true)).toBe(ask)
    expect(observeAsk(null, refusal, true)).toBeNull()
  })

  it('keeps the first answer and says the clip was added when the host has no note', () => {
    const done = { ...base, enrolling: false, note: 'voice enrolled' }
    const answered = observeAsk(ask, done, true)!
    expect(observeAsk(answered, { ...done, note: 'later' }, true)).toBe(answered)
    expect(nativeRowLine({ ...ask, answer: { ...done, note: null } }, null)).toBe('Clip added.')
  })
})

describe('a real naru-audio payload', () => {
  // GET /v1/audio/speaker/people on the dev daemon (the migrated clip).
  const real: VoicePeople = JSON.parse(
    '{"live_guard":false,"model":"wespeaker-sv-en","people":[{"clips":[{"created_at":1792689320,"has_audio":false,"id":1,"seconds":0.0}],"id":1,"name":"Me","owner":true}]}',
  )
  it('formats a unix-seconds created_at and a zero-length clip', () => {
    const clip = real.people[0].clips[0]
    expect(clipLine(clip)).toBe('2026-10-22 · n/a · no audio kept')
    expect(clipCount(real.people[0])).toBe('1 clip')
    expect(canPlay(clip)).toBe(false)
  })
  it('treats a zero or missing created_at as migrated', () => {
    expect(clipLine({ id: 1, created_at: 0, seconds: 3, has_audio: true })).toBe('migrated · 3.0 s')
    expect(clipLine({ id: 1, seconds: 3, has_audio: true })).toBe('migrated · 3.0 s')
  })
})
