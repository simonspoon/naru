import { describe, expect, it } from 'vitest'
import { detectNativeHost, installNativeHost, type NativeOut } from './nativeHost'

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
})
