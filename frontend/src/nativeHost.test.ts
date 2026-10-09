import { describe, expect, it } from 'vitest'
import { ambientControl, detectNativeHost, hostVoiced, installNativeHost, type NativeOut } from './nativeHost'

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
      { type: 'state', session: 3, live: true, joined: true },
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
    expect(ambientControl(true, true, true, false)).toEqual({ label: 'Ambient', next: true })
    expect(ambientControl(true, true, true, true)).toEqual({ label: 'Live', next: false })
  })
})
