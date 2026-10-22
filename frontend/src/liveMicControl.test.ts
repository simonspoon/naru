import { describe, expect, it } from 'vitest'
import {
  acceptState,
  ambientEdge,
  controlStart,
  controlUrl,
  conversationKey,
  intentFor,
  levelVoiced,
  micSwitch,
  mutedFromMode,
  parseControlEvent,
  readMicFor,
  reconnectDelay,
  seedMode,
  utteranceClient,
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

  it('backs off reconnects up to 5s', () => {
    expect(reconnectDelay(0)).toBe(500)
    expect(reconnectDelay(1)).toBe(1000)
    expect(reconnectDelay(10)).toBe(5000)
  })
})

describe('micSwitch (naru task 2201)', () => {
  const base = {
    unlocked: true,
    speaker: 'mac-123' as string | null,
    client: 'page-1',
    hostOwnsMic: true,
    micReady: true,
    muted: false,
  }
  const INSTEAD = 'Listen on this browser instead'

  it('hosted: the host-held claim counts as this page’s, the switch follows naru-audio', () => {
    const live = micSwitch(base)
    expect(live.elsewhere).toBe(false)
    expect(live.capturing).toBe(true)
    expect(live.on).toBe(true)
    const muted = micSwitch({ ...base, muted: true })
    expect(muted.elsewhere).toBe(false)
    expect(muted.on).toBe(false)
    expect(muted.offLabel).toBe('Listen through this browser')
    expect(live.offLabel).not.toBe(INSTEAD)
  })

  it('a plain browser keeps the claim guard (naru task 2095)', () => {
    const s = micSwitch({ ...base, hostOwnsMic: false })
    expect(s.elsewhere).toBe(true)
    expect(s.on).toBe(false)
    expect(s.offLabel).toBe(INSTEAD)
  })

  it('a plain browser holding the claim, or an unclaimed one, is not elsewhere', () => {
    for (const speaker of ['page-1', null]) {
      const here = micSwitch({ ...base, hostOwnsMic: false, speaker })
      expect(here.elsewhere).toBe(false)
      expect(here.on).toBe(true)
    }
  })

  it('not unlocked is never elsewhere', () => {
    const s = micSwitch({ ...base, hostOwnsMic: false, unlocked: false })
    expect(s.elsewhere).toBe(false)
    expect(s.capturing).toBe(false)
  })

  it('waits for naru-audio’s first state', () => {
    const s = micSwitch({ ...base, micReady: false })
    expect(s.waiting).toBe(true)
    expect(s.on).toBe(false)
    expect(s.offLabel).toBe('Connecting to naru-audio…')
  })
})

describe('utteranceClient (naru task 2203)', () => {
  it('posts without a client when a native host owns the mic, so the send goes through', () => {
    expect(utteranceClient('page-1', true)).toBeUndefined()
  })
  it('keeps the claim guard in a plain tab', () => {
    expect(utteranceClient('page-1', false)).toBe('page-1')
  })

  it('seeds a reloaded start with the mute of the same session only', () => {
    expect(seedMode({ id: 7, muted: true }, 7)).toBe('muted')
    expect(seedMode({ id: 7, muted: false }, 7)).toBe('live')
    expect(seedMode({ id: 7, muted: true }, 8)).toBe('live')
    expect(seedMode(null, 7)).toBe('live')
  })

  it('reads a stored mic mode back, refusing anything malformed', () => {
    expect(readMicFor(JSON.stringify({ id: 7, muted: true }))).toEqual({ id: 7, muted: true })
    expect(readMicFor(null)).toBeNull()
    expect(readMicFor('null')).toBeNull()
    expect(readMicFor('{not json')).toBeNull()
    expect(readMicFor('{"id":"7","muted":true}')).toBeNull()
    expect(readMicFor('{"id":7,"muted":"yes"}')).toBeNull()
    expect(readMicFor('[7,true]')).toBeNull()
  })
})

describe('level and ambient from naru-audio (naru task 2210)', () => {
  it('parses a level event, clamping rms to 0..1', () => {
    expect(parseControlEvent('{"type":"level","rms":0.2,"gate":true}')).toEqual({
      kind: 'level',
      rms: 0.2,
      gate: true,
    })
    expect(parseControlEvent('{"type":"level","rms":3,"gate":false}')).toEqual({
      kind: 'level',
      rms: 1,
      gate: false,
    })
    expect(parseControlEvent('{"type":"level","rms":-0.5,"gate":true}')).toEqual({
      kind: 'level',
      rms: 0,
      gate: true,
    })
  })

  it('reads a missing or non-boolean gate as closed', () => {
    expect(parseControlEvent('{"type":"level","rms":0.3}')).toEqual({ kind: 'level', rms: 0.3, gate: false })
    expect(parseControlEvent('{"type":"level","rms":0.3,"gate":"yes"}')).toEqual({
      kind: 'level',
      rms: 0.3,
      gate: false,
    })
  })

  it('ignores a level with no usable rms', () => {
    expect(parseControlEvent('{"type":"level","gate":true}')).toBeNull()
    expect(parseControlEvent('{"type":"level","rms":"0.2","gate":true}')).toBeNull()
    expect(parseControlEvent('{"type":"level","rms":null,"gate":true}')).toBeNull()
  })

  it('counts a level as voiced only with the gate open and rms at the onset', () => {
    expect(levelVoiced(0.02, true, 0.02)).toBe(true)
    expect(levelVoiced(0.0199, true, 0.02)).toBe(false)
    expect(levelVoiced(0.9, false, 0.02)).toBe(false)
    expect(levelVoiced(0, false, 0.02)).toBe(false)
  })

  it('enters ambient on mode ambient, from any previous mode', () => {
    for (const prev of [null, 'live', 'muted', 'idle', 'ambient']) {
      expect(ambientEdge(prev, 'ambient')).toBe(true)
    }
  })

  it('leaves ambient only when the mode moves off ambient', () => {
    for (const mode of ['live', 'muted', 'idle']) {
      expect(ambientEdge('ambient', mode)).toBe(false)
      expect(ambientEdge(null, mode)).toBeNull()
      expect(ambientEdge('live', mode)).toBeNull()
      expect(ambientEdge('muted', mode)).toBeNull()
    }
  })
})
