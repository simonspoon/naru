import { describe, expect, it } from 'vitest'
import {
  AMBIENT_SAY_GRACE_MS,
  ambientControl,
  ambientHostPresent,
  ambientRequestStep,
  detectNativeHost,
  enrollStatus,
  onEnrollStatus,
  installNativeHost,
  needsHostRefresh,
  reportedAmbient,
  reportedAmbientStep,
  stateMessage,
  type NativeOut,
} from './nativeHost'
import { setupHostCallbacks } from './gestureSetupHost'

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
      { type: 'ambient', on: true },
    ]
    msgs.forEach((m) => host.post(m))
    expect(posted).toEqual(msgs)
  })

  it('installs the window API, announces ready, and uninstalls', () => {
    const { win, posted } = stubWindow()
    const off = installNativeHost(win, detectNativeHost(win)!)
    expect(posted).toEqual([{ type: 'ready' }])
    // The gesture-setup callbacks and enrollStatus: no mic bridge (naru task 2181).
    expect(Object.keys(win.naruNativeHost as object).sort()).toEqual(
      [...Object.keys(setupHostCallbacks), 'enrollStatus'].sort(),
    )
    off()
    expect(win.naruNativeHost).toBeUndefined()
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

describe('ambientHostPresent', () => {
  it('counts the native shell or any fresh host report', () => {
    expect(ambientHostPresent(true, null)).toBe(true)
    expect(ambientHostPresent(false, false)).toBe(true)
    expect(ambientHostPresent(false, true)).toBe(true)
    expect(ambientHostPresent(false, null)).toBe(false)
    expect(ambientHostPresent(false, undefined)).toBe(false)
  })
})

describe('reportedAmbientStep', () => {
  it('enters when the listener is on and the page is not ambient', () => {
    expect(reportedAmbientStep(false, true, false)).toBe(true)
    expect(reportedAmbientStep(undefined, true, false)).toBe(true)
    expect(reportedAmbientStep(true, true, false)).toBe(true)
    expect(reportedAmbientStep(false, true, true)).toBeNull()
  })
  it('leaves only once the listener was seen on', () => {
    expect(reportedAmbientStep(true, false, true)).toBe(false)
    expect(reportedAmbientStep(true, null, true)).toBe(false)
    // The host vanished before it ever obeyed the press.
    expect(reportedAmbientStep(false, null, true)).toBe(false)
    // The page pressed Ambient and the host has not obeyed yet.
    expect(reportedAmbientStep(false, false, true)).toBeNull()
    expect(reportedAmbientStep(true, false, false)).toBeNull()
    expect(reportedAmbientStep(null, null, false)).toBeNull()
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

describe('enrollStatus', () => {
  it('delivers the host payload to subscribers and replays the last one', () => {
    enrollStatus({ enrolling: true, enrolled: false, note: 'speak for 12 s', seconds: 12, person: 4 })
    enrollStatus({ bogus: 1 })
    const got: unknown[] = []
    const off = onEnrollStatus((s) => got.push(s))
    enrollStatus({ enrolling: false, enrolled: true, note: null, seconds: 12 })
    off()
    expect(got).toEqual([
      { enrolling: true, enrolled: false, note: 'speak for 12 s', seconds: 12, person: 4 },
      { enrolling: false, enrolled: true, note: null, seconds: 12, person: null },
    ])
  })
})

describe('enrollStatus person', () => {
  it('carries the person id, and null for a missing, null or non-integer one', () => {
    const got: Array<number | null> = []
    const off = onEnrollStatus((s) => got.push(s.person))
    got.length = 0
    const base = { enrolling: false, enrolled: false, note: null, seconds: 12 }
    enrollStatus({ ...base, person: 7 })
    enrollStatus({ ...base, person: null })
    enrollStatus({ ...base })
    enrollStatus({ ...base, person: 1.5 })
    enrollStatus({ ...base, person: '7' })
    off()
    expect(got).toEqual([7, null, null, null, null])
  })
})
