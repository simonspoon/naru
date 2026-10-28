import { describe, expect, it } from 'vitest'
import { ambientLines, speakerLabel } from './ambientLog'

describe('speakerLabel', () => {
  it('names a matched person, else owner / stranger / unknown', () => {
    expect(speakerLabel({ person: 'Ada', reason: 'scored', is_him: false })).toBe('Ada')
    expect(speakerLabel({ person: null, reason: 'scored', is_him: true })).toBe('You')
    expect(speakerLabel({ reason: 'scored', is_him: false })).toBe('Someone else')
    expect(speakerLabel({ reason: 'too_short', is_him: false })).toBe('Unknown')
    expect(speakerLabel(undefined)).toBe('Unknown')
  })
})

describe('ambientLines', () => {
  it('keeps order and maps each event kind', () => {
    const lines = ambientLines({
      events: [
        { type: 'ambient_flag', id: 0, text: ' first ', speaker: { reason: 'scored', is_him: true } },
        { type: 'wake', text: 'naru', at_ms: 5 },
        { type: 'ambient_verdict', kind: 'idea', text: 'build a shed' },
        { type: 'ambient_verdict', kind: 'can_help', text: 'weather?' },
        { type: 'utterance', id: 1, text: 'last' },
      ],
    })
    expect(lines.map((l) => [l.kind, l.speaker, l.text])).toEqual([
      ['heard', 'You', 'first'],
      ['wake', 'Wake word', 'naru'],
      ['idea', 'Idea flagged', 'build a shed'],
      ['can_help', 'Naru can help', 'weather?'],
      ['heard', 'Unknown', 'last'],
    ])
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length)
  })

  it('keys a line by its event, not its place, so a dropped head keeps them', () => {
    const a = { type: 'ambient_flag', id: 1, text: 'one' }
    const b = { type: 'ambient_flag', id: 2, text: 'two' }
    const before = ambientLines({ events: [a, b] }).map((l) => l.key)
    const after = ambientLines({ events: [b] }).map((l) => l.key)
    expect(after[0]).toBe(before[1])
    const twice = ambientLines({ events: [a, a] }).map((l) => l.key)
    expect(new Set(twice).size).toBe(2)
  })

  it('skips empty text, unknown types and garbage', () => {
    expect(ambientLines({ events: [{ type: 'ambient_flag', text: '  ' }, { type: 'level' }, 3, null] })).toEqual([])
    expect(ambientLines(null)).toEqual([])
    expect(ambientLines({ events: 'x' })).toEqual([])
  })
})
