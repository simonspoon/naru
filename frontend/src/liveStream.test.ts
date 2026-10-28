import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SegmentChain } from './liveDrain'
import {
  closeVerdict,
  FINAL_WAIT_MS,
  FinalWaits,
  FrameBatcher,
  parseStreamEvent,
  pcmBytes,
  startMessage,
  STOP_MESSAGE,
  STOP_WAIT_MS,
} from './liveStream'

describe('control messages', () => {
  const bare = {
    type: 'start',
    role: 'audio',
    conversation: '42',
    mode: 'live',
    format: 's16le',
    rate: 16000,
    partials: false,
  }

  it('starts an audio socket in the conversation, 16 kHz s16le, no partials, nothing unconfigured', () => {
    expect(JSON.parse(startMessage('42'))).toEqual(bare)
    expect(JSON.parse(startMessage('42', null, null))).toEqual(bare)
    expect(JSON.parse(startMessage('42', '  ', ' '))).toEqual(bare)
  })

  it('names the configured listen model and vocabulary', () => {
    expect(JSON.parse(startMessage('42', 'whisper-small', 'Naru, Kokoro'))).toEqual({
      ...bare,
      model: 'whisper-small',
      hotwords: 'Naru, Kokoro',
    })
  })

  it('trims the vocabulary and leaves out one serve would drop', () => {
    expect(JSON.parse(startMessage('42', null, '  Naru\nKokoro :2 \n')).hotwords).toBe('Naru\nKokoro :2')
    expect(JSON.parse(startMessage('42', null, 'x/y'))).toEqual(bare)
    expect(JSON.parse(startMessage('42', null, 'a'.repeat(65)))).toEqual(bare)
  })

  it('stops with a bare stop', () => {
    expect(JSON.parse(STOP_MESSAGE)).toEqual({ type: 'stop' })
  })
})

describe('pcmBytes', () => {
  it('writes little-endian samples', () => {
    const bytes = new Uint8Array(pcmBytes(Int16Array.of(1, -2, 0x7fff)))
    expect([...bytes]).toEqual([0x01, 0x00, 0xfe, 0xff, 0xff, 0x7f])
  })
})

describe('FrameBatcher', () => {
  it('emits one 50 ms frame (1600 bytes) per 800 samples at 16 kHz', () => {
    const b = new FrameBatcher(16000)
    const frames: ArrayBuffer[] = []
    for (let i = 0; i < 7; i++) frames.push(...b.push(new Float32Array(128)))
    // 896 samples in: one 800-sample frame out, 96 held.
    expect(frames.map((f) => f.byteLength)).toEqual([1600])
    expect(b.drain()?.byteLength).toBe(96 * 2)
    expect(b.drain()).toBeNull()
  })

  it('resamples a 48 kHz batch whole, so the frame is exactly 50 ms', () => {
    const b = new FrameBatcher(48000)
    const frames: ArrayBuffer[] = []
    // 19 blocks = 2432 samples: one 2400-sample batch.
    for (let i = 0; i < 19; i++) frames.push(...b.push(new Float32Array(128).fill(0.5)))
    expect(frames).toHaveLength(1)
    expect(frames[0].byteLength).toBe(800 * 2)
    const samples = new Int16Array(frames[0])
    expect(samples[0]).toBe(Math.trunc(0.5 * 0x7fff))
  })

  it('keeps sample order across a split block', () => {
    const b = new FrameBatcher(16000, 1) // 16 samples per frame
    const ramp = Float32Array.from({ length: 20 }, (_, i) => i / 100)
    const [frame] = b.push(ramp)
    const tail = b.drain()!
    const got = [...new Int16Array(frame), ...new Int16Array(tail)]
    expect(got).toEqual([...ramp].map((x) => Math.trunc(x * 0x7fff)))
  })

  it('ignores an empty block', () => {
    const b = new FrameBatcher(16000)
    expect(b.push(new Float32Array(0))).toEqual([])
    expect(b.drain()).toBeNull()
  })
})

describe('parseStreamEvent', () => {
  it('reads every event the page acts on', () => {
    expect(parseStreamEvent('{"type":"ready","session":"a1","model":"m","load_ms":0}')).toEqual({
      type: 'ready',
    })
    expect(parseStreamEvent('{"type":"loading"}')).toEqual({ type: 'loading' })
    expect(parseStreamEvent('{"type":"speech","active":true,"at":1.28}')).toEqual({
      type: 'speech',
      active: true,
      at: 1.28,
    })
    expect(
      parseStreamEvent(
        '{"type":"utterance","id":0,"segment":3,"start":12.4,"end":15.02,"text":"Add a task.","decode_ms":188,"speaker":{"score":0.8,"is_him":true}}',
      ),
    ).toEqual({ type: 'final', segment: 3, start: 12.4, end: 15.02, text: 'Add a task.' })
    expect(parseStreamEvent('{"type":"partial","segment":4,"text":""}')).toEqual({ type: 'dropped' })
    expect(parseStreamEvent('{"type":"ambient_flag","id":1,"segment":5,"text":"hm"}')).toEqual({
      type: 'dropped',
    })
    expect(parseStreamEvent('{"type":"error","code":"daemon_down","message":"gone"}')).toEqual({
      type: 'error',
      code: 'daemon_down',
      message: 'gone',
    })
    expect(parseStreamEvent('{"type":"warning","code":"x"}')).toEqual({
      type: 'warning',
      code: 'x',
      message: '',
    })
    expect(parseStreamEvent('{"type":"done"}')).toEqual({ type: 'done' })
  })

  it('ignores what the page does not act on', () => {
    expect(parseStreamEvent('{"type":"partial","segment":1,"start":0,"text":"hi"}')).toBeNull()
    expect(parseStreamEvent('{"type":"mystery"}')).toBeNull()
    expect(parseStreamEvent('{"type":"state","mode":"live","seq":2}')).toBeNull()
    expect(parseStreamEvent('{"type":"level","rms":0.1,"gate":true}')).toBeNull()
    expect(parseStreamEvent('{"type":"final","segment":0,"start":0,"end":1,"text":"x"}')).toBeNull()
    expect(parseStreamEvent('not json')).toBeNull()
    expect(parseStreamEvent('null')).toBeNull()
    expect(parseStreamEvent('"final"')).toBeNull()
    expect(parseStreamEvent(new ArrayBuffer(4))).toBeNull()
    expect(parseStreamEvent('{"type":"speech","active":"yes","at":1}')).toBeNull()
    expect(parseStreamEvent('{"type":"utterance","segment":0,"start":0,"end":1}')).toBeNull()
  })
})

describe('closeVerdict', () => {
  it('reads a normal end as normal', () => {
    expect(closeVerdict({ code: 1000, sawDone: false, closedByUs: false })).toBe('normal')
    expect(closeVerdict({ code: 1006, sawDone: true, closedByUs: false })).toBe('normal')
    expect(closeVerdict({ code: 1006, sawDone: false, closedByUs: true })).toBe('normal')
  })

  it('asks again after anything else', () => {
    for (const code of [1006, 1008, 1011, 1013]) {
      expect(closeVerdict({ code, sawDone: false, closedByUs: false })).toBe('reprobe')
    }
  })
})

describe('FinalWaits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles a segment on the final that ends where it ended', async () => {
    const waits = new FinalWaits()
    let settled = false
    void waits.expect(1.5).then(() => {
      settled = true
    })
    waits.final(1.2) // a max_segment cut inside a longer span
    await Promise.resolve()
    expect(settled).toBe(false)
    waits.final(1.5)
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(waits.count).toBe(0)
  })

  it('settles a gated segment behind a later final', async () => {
    const waits = new FinalWaits()
    const order: string[] = []
    void waits.expect(1).then(() => order.push('gated'))
    void waits.expect(3).then(() => order.push('spoken'))
    waits.final(3)
    await Promise.resolve()
    expect(order).toEqual(['gated', 'spoken'])
  })

  it('settles only the oldest segment on a drop', async () => {
    const waits = new FinalWaits()
    const order: string[] = []
    void waits.expect(1).then(() => order.push('other voice'))
    void waits.expect(3).then(() => order.push('his'))
    waits.dropped()
    await Promise.resolve()
    expect(order).toEqual(['other voice'])
    expect(waits.count).toBe(1)
    waits.dropped()
    waits.dropped() // nothing left: a no-op
    await Promise.resolve()
    expect(order).toEqual(['other voice', 'his'])
  })

  it('gives up on a final that never comes', async () => {
    const waits = new FinalWaits()
    let settled = false
    void waits.expect(2).then(() => {
      settled = true
    })
    vi.advanceTimersByTime(FINAL_WAIT_MS - 1)
    await Promise.resolve()
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('outwaits a final the daemon backlog delays past five seconds', async () => {
    // The bound is the stop drain's: a real final can be that late.
    expect(FINAL_WAIT_MS).toBe(STOP_WAIT_MS)
    const waits = new FinalWaits()
    let settled = false
    void waits.expect(2).then(() => {
      settled = true
    })
    vi.advanceTimersByTime(9000)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(waits.count).toBe(1)
    waits.final(2)
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('settles everything when the socket goes', async () => {
    const waits = new FinalWaits()
    void waits.expect(1)
    void waits.expect(2)
    waits.settleAll()
    expect(waits.count).toBe(0)
  })

  it('holds the listen switch flush behind the finals still owed', async () => {
    vi.useRealTimers()
    const waits = new FinalWaits()
    const sent: string[] = []
    let held = ''
    const chain = new SegmentChain({
      flush: () => {
        sent.push(held)
        held = ''
      },
    })
    const ended = waits.expect(2)
    chain.enqueue(() => ended)
    expect(chain.close()).toBe('draining')
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual([])
    held = 'what was said before the press'
    waits.final(2)
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual(['what was said before the press'])
  })
})
