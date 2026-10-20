import { describe, expect, it } from 'vitest'
import {
  AMBIENT_SAY_GRACE_MS,
  ambientControl,
  ambientRequestStep,
  detectNativeHost,
  hostVoiced,
  installNativeHost,
  needsHostRefresh,
  reportedAmbient,
  stateMessage,
  type NativeOut,
} from './nativeHost'

describe('stateMessage', () => {
  it('carries the page Pause to the host', () => {
    const base = { session: 7, live: true, joined: true, speechMuted: false }
    expect(stateMessage({ ...base, paused: true })).toEqual({ type: 'state', ...base, paused: true })
    expect(stateMessage({ ...base, paused: false })).toEqual({ type: 'state', ...base, paused: false })
  })

  it('carries the page speaker mute to the host', () => {
    const base = { session: 7, live: true, joined: true, paused: false }
    expect(stateMessage({ ...base, speechMuted: true })).toEqual({ type: 'state', ...base, speechMuted: true })
    expect(stateMessage({ ...base, speechMuted: false })).toEqual({ type: 'state', ...base, speechMuted: false })
  })
})

function stubWindow() {
  const posted: unknown[] = []
  const win: Record<string, unknown> = {
    webkit: { messageHandlers: { naruLive: { postMessage: (m: unknown) => posted.push(m) } } },
  }
  return { win, posted }
}

describe('nativeHost', () => {
  it('is absent in a plain browser', () => {
    expect(detectNativeHost({})).toBeNull()
    expect(detectNativeHost({ webkit: { messageHandlers: {} } })).toBeNull()
    expect(detectNativeHost({ webkit: { messageHandlers: { naruLive: {} } } })).toBeNull()
  })

  it('posts page to host messages through the handler', () => {
    const { win, posted } = stubWindow()
    const host = detectNativeHost(win)!
    const msgs: NativeOut[] = [
      { type: 'state', session: 3, live: true, joined: true, paused: false, speechMuted: false },
      { type: 'mic', muted: true },
    ]
    msgs.forEach((m) => host.post(m))
    expect(posted).toEqual(msgs)
  })

  it('installs the window API, announces ready, and delivers host state', () => {
    const { win, posted } = stubWindow()
    const got: unknown[] = []
    const off = installNativeHost(win, detectNativeHost(win)!, (s) => got.push(s))
    expect(posted).toEqual([{ type: 'ready' }])
    const api = win.naruNativeHost as { setMicState: (s: unknown) => void }
    api.setMicState({ muted: false })
    api.setMicState({ muted: 'no' })
    api.setMicState(null)
    api.setMicState({})
    expect(got).toEqual([{ muted: false }])
    off()
    expect(win.naruNativeHost).toBeUndefined()
  })

  it('delivers level and hearing, clamping and ignoring bad values', () => {
    const { win } = stubWindow()
    const got: unknown[] = []
    installNativeHost(win, detectNativeHost(win)!, (s) => got.push(s))
    const api = win.naruNativeHost as { setMicState: (s: unknown) => void }
    api.setMicState({ muted: false, level: 0.2, hearing: true })
    api.setMicState({ level: 5 })
    api.setMicState({ level: -1 })
    api.setMicState({ level: NaN, hearing: 'yes' })
    expect(got).toEqual([{ muted: false, level: 0.2, hearing: true }, { level: 1 }, { level: 0 }])
  })

  it('delivers setHostInfo only for micOwner naru-audio', () => {
    const { win } = stubWindow()
    const info: unknown[] = []
    const states: unknown[] = []
    installNativeHost(win, detectNativeHost(win)!, (s) => states.push(s), (i) => info.push(i))
    const api = win.naruNativeHost as { setHostInfo: (i: unknown) => void }
    api.setHostInfo(null)
    api.setHostInfo({})
    api.setHostInfo({ micOwner: 'page' })
    api.setHostInfo({ micOwner: 'naru-audio', extra: 1 })
    expect(info).toEqual([{ micOwner: 'naru-audio' }])
    expect(states).toEqual([])
  })

  it('judges voiced from the host verdict or the onset level', () => {
    expect(hostVoiced({ muted: false }, 0.02)).toBe(false)
    expect(hostVoiced({ level: 0.01 }, 0.02)).toBe(false)
    expect(hostVoiced({ level: 0.02 }, 0.02)).toBe(true)
    expect(hostVoiced({ hearing: true }, 0.02)).toBe(true)
    expect(hostVoiced({ hearing: false, level: 0 }, 0.02)).toBe(false)
  })

  it('delivers ambient, ignoring a wrong type', () => {
    const { win } = stubWindow()
    const got: unknown[] = []
    installNativeHost(win, detectNativeHost(win)!, (s) => got.push(s))
    const api = win.naruNativeHost as { setMicState: (s: unknown) => void }
    api.setMicState({ ambient: true })
    api.setMicState({ ambient: false, muted: true })
    api.setMicState({ ambient: 'yes' })
    expect(got).toEqual([{ ambient: true }, { muted: true, ambient: false }])
  })

  it('offers the ambient switch only with a host in a joined live session', () => {
    expect(ambientControl(false, true, true, false)).toBeNull()
    expect(ambientControl(true, false, true, false)).toBeNull()
    expect(ambientControl(true, true, false, false)).toBeNull()
    expect(ambientControl(true, true, true, false)).toEqual({
      label: 'Ambient',
      next: true,
      icon: 'ambient',
    })
    expect(ambientControl(true, true, true, true)).toEqual({
      label: 'Live',
      next: false,
      icon: 'live',
    })
  })
})

describe('reportedAmbient', () => {
  it('reports the verdict only where the switch is offered', () => {
    expect(reportedAmbient(true, true, true, true)).toBe(true)
    expect(reportedAmbient(true, true, true, false)).toBe(false)
    expect(reportedAmbient(false, true, true, false)).toBeUndefined()
    expect(reportedAmbient(true, false, true, true)).toBeUndefined()
    expect(reportedAmbient(true, true, false, true)).toBeUndefined()
  })
})

describe('needsHostRefresh', () => {
  it('refreshes a reporting page after the interval only', () => {
    expect(needsHostRefresh(true, 1000, 4999)).toBe(false)
    expect(needsHostRefresh(true, 1000, 5000)).toBe(true)
    expect(needsHostRefresh(false, 0, 100000)).toBe(false)
  })
})

describe('ambientRequestStep', () => {
  const base = {
    hostPresent: true,
    live: true,
    joined: true,
    ambient: false,
    request: true as boolean | null,
    seq: 3,
    actedSeq: 2 as number | null,
    runIdle: true,
    firstSeenAt: 1000 as number | null,
    now: 1000,
  }

  it('does nothing in a plain browser or outside a joined live session', () => {
    expect(ambientRequestStep({ ...base, hostPresent: false })).toBeNull()
    expect(ambientRequestStep({ ...base, live: false })).toBeNull()
    expect(ambientRequestStep({ ...base, joined: false })).toBeNull()
  })

  it('does nothing without a request, for an acted seq, or already in mode', () => {
    expect(ambientRequestStep({ ...base, request: null })).toBeNull()
    expect(ambientRequestStep({ ...base, actedSeq: 3 })).toBeNull()
    expect(ambientRequestStep({ ...base, request: true, ambient: true })).toBeNull()
    expect(ambientRequestStep({ ...base, request: false, ambient: false })).toBeNull()
  })

  it('posts an on request at once when the run is idle', () => {
    expect(ambientRequestStep(base)).toEqual({ post: true, on: true })
    expect(ambientRequestStep({ ...base, actedSeq: null })).toEqual({ post: true, on: true })
  })

  it('makes an on request wait while busy, then fire after the grace', () => {
    const busy = { ...base, runIdle: false }
    expect(ambientRequestStep(busy)).toBeNull()
    expect(ambientRequestStep({ ...busy, now: 1000 + AMBIENT_SAY_GRACE_MS - 1 })).toBeNull()
    expect(ambientRequestStep({ ...busy, now: 1000 + AMBIENT_SAY_GRACE_MS })).toEqual({ post: true, on: true })
    expect(ambientRequestStep({ ...busy, firstSeenAt: null, now: 10 ** 9 })).toBeNull()
  })

  it('posts an off request at once, even while ambient and busy', () => {
    expect(ambientRequestStep({ ...base, request: false, ambient: true, runIdle: false })).toEqual({
      post: true,
      on: false,
    })
  })
})
