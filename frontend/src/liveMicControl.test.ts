import { describe, expect, it } from 'vitest'
import {
  acceptState,
  controlStart,
  controlUrl,
  conversationKey,
  intentFor,
  mutedFromMode,
  parseControlEvent,
  reconnectDelay,
  takesThinPath,
} from './liveMicControl'

describe('liveMicControl', () => {
  it('dials serve on the same origin', () => {
    expect(controlUrl({ protocol: 'http:', host: '127.0.0.1:7771' })).toBe(
      'ws://127.0.0.1:7771/v1/audio/live',
    )
    expect(controlUrl({ protocol: 'https:', host: 'naru.local' })).toBe('wss://naru.local/v1/audio/live')
  })

  it('keys the conversation by the session id as a decimal string', () => {
    expect(conversationKey(42)).toBe('42')
  })

  it('starts as a control socket carrying a mode', () => {
    expect(JSON.parse(controlStart('42', 'live'))).toEqual({
      type: 'start',
      role: 'control',
      conversation: '42',
      mode: 'live',
    })
    expect(JSON.parse(controlStart('7', 'muted')).mode).toBe('muted')
  })

  it('sends exactly one mode intent per press', () => {
    expect(JSON.parse(intentFor(true))).toEqual({ type: 'mode', mode: 'muted' })
    expect(JSON.parse(intentFor(false))).toEqual({ type: 'mode', mode: 'live' })
  })

  it('parses ready and state, ignoring everything else', () => {
    expect(parseControlEvent('{"type":"ready","role":"control"}')).toEqual({ kind: 'ready' })
    expect(parseControlEvent('{"type":"state","mode":"muted","seq":3}')).toEqual({
      kind: 'state',
      mode: 'muted',
      seq: 3,
    })
    expect(parseControlEvent('{"type":"state","mode":"muted"}')).toBeNull()
    expect(parseControlEvent('{"type":"state","seq":3}')).toBeNull()
    expect(parseControlEvent('{"type":"error","fatal":true}')).toBeNull()
    expect(parseControlEvent('not json')).toBeNull()
    expect(parseControlEvent('null')).toBeNull()
    expect(parseControlEvent(new ArrayBuffer(2))).toBeNull()
  })

  it('accepts only a rising seq, and a reset after ready starts again', () => {
    let last = 0
    const seen: number[] = []
    const feed = (seq: number) => {
      if (acceptState(last, seq)) {
        last = seq
        seen.push(seq)
      }
    }
    feed(1)
    feed(2)
    feed(2)
    feed(1)
    feed(5)
    expect(seen).toEqual([1, 2, 5])
    // A reconnect to a forgotten conversation: `ready` resets, seq 1 again.
    last = 0
    feed(1)
    expect(seen).toEqual([1, 2, 5, 1])
  })

  it('reads only live as listening', () => {
    expect(mutedFromMode('live')).toBe(false)
    expect(mutedFromMode('muted')).toBe(true)
    expect(mutedFromMode('idle')).toBe(true)
    expect(mutedFromMode('ambient')).toBe(true)
  })

  it('takes the thin path with no host or a thin host only', () => {
    expect(takesThinPath(false, false)).toBe(true)
    expect(takesThinPath(true, true)).toBe(true)
    expect(takesThinPath(true, false)).toBe(false)
  })

  it('backs off reconnects up to 5s', () => {
    expect(reconnectDelay(0)).toBe(500)
    expect(reconnectDelay(1)).toBe(1000)
    expect(reconnectDelay(10)).toBe(5000)
  })
})
