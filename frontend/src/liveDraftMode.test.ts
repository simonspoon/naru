import { beforeEach, describe, expect, it } from 'vitest'
import { appendHeard, draftTurn, readAutoSend, stripSendIt, writeAutoSend } from './liveDraftMode'

describe('auto-send switch', () => {
  beforeEach(() => localStorage.clear())

  it('is on until turned off, and remembers both ways', () => {
    expect(readAutoSend()).toBe(true)
    writeAutoSend(false)
    expect(readAutoSend()).toBe(false)
    writeAutoSend(true)
    expect(readAutoSend()).toBe(true)
    expect(localStorage.length).toBe(0)
  })
})

describe('stripSendIt', () => {
  it('strips a closing "send it" whatever the case and punctuation', () => {
    expect(stripSendIt('fix the build send it')).toBe('fix the build')
    expect(stripSendIt('Fix the build. Send it.')).toBe('Fix the build.')
    expect(stripSendIt('fix the build, send it!')).toBe('fix the build')
    expect(stripSendIt('fix the build — SEND IT')).toBe('fix the build')
    expect(stripSendIt('Send, it.')).toBe('')
    expect(stripSendIt('send it')).toBe('')
  })

  it('leaves the phrase alone mid-sentence or inside a word', () => {
    expect(stripSendIt('send it to Bob tomorrow')).toBeNull()
    expect(stripSendIt('please resend it')).toBeNull()
    expect(stripSendIt('send item')).toBeNull()
    expect(stripSendIt('yes')).toBeNull()
  })
})

describe('appendHeard', () => {
  it('joins with one space and starts an empty box cleanly', () => {
    expect(appendHeard('', ' yes ')).toBe('yes')
    expect(appendHeard('one', 'two')).toBe('one two')
    expect(appendHeard('one\n', 'two')).toBe('one\ntwo')
    expect(appendHeard('one', '  ')).toBe('one')
  })
})

describe('draftTurn', () => {
  it('appends a turn, short ones included, without sending', () => {
    expect(draftTurn('', 'no')).toEqual({ draft: 'no', send: false })
    expect(draftTurn('first', '3')).toEqual({ draft: 'first 3', send: false })
  })

  it('sends the whole draft on a closing "send it", without the words', () => {
    expect(draftTurn('first part', 'and the rest. Send it.')).toEqual({
      draft: 'first part and the rest.',
      send: true,
    })
    expect(draftTurn('edited draft', 'send it')).toEqual({ draft: 'edited draft', send: true })
  })
})
