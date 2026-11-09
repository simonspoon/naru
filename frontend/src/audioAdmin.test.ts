import { describe, expect, it } from 'vitest'
import { audioAdminUrl, audioAdminView } from './audioAdmin'
import type { AudioTestResult } from './types/AudioTestResult'

const probe = (over: Partial<AudioTestResult>): AudioTestResult => ({
  url: 'http://127.0.0.1:7870',
  state: 'ready',
  message: null,
  version_warning: null,
  ...over,
})

describe('audioAdminUrl', () => {
  it('appends /admin, dropping trailing slashes', () => {
    expect(audioAdminUrl('http://127.0.0.1:7870')).toBe('http://127.0.0.1:7870/admin')
    expect(audioAdminUrl('http://10.0.0.5:7870//')).toBe('http://10.0.0.5:7870/admin')
  })
})

describe('audioAdminView', () => {
  it('frames a running local daemon from a local page', () => {
    expect(audioAdminView(probe({}), '127.0.0.1')).toEqual({ kind: 'frame', src: 'http://127.0.0.1:7870/admin' })
    expect(audioAdminView(probe({}), 'localhost').kind).toBe('frame')
  })

  it('frames a daemon whose model is missing or that is too old: its admin page still loads', () => {
    expect(audioAdminView(probe({ state: 'model_missing', message: 'x' }), '127.0.0.1').kind).toBe('frame')
    expect(audioAdminView(probe({ state: 'incompatible', message: 'x' }), '127.0.0.1').kind).toBe('frame')
  })

  it('is down, with the probe sentence, when the daemon is not running', () => {
    expect(audioAdminView(probe({ state: 'daemon_down', message: 'not running' }), '127.0.0.1')).toEqual({
      kind: 'down',
      message: 'not running',
    })
    expect(audioAdminView(probe({ state: 'error', message: null }), '127.0.0.1')).toEqual({
      kind: 'down',
      message: 'naru-audio is not running at http://127.0.0.1:7870.',
    })
  })

  it('refuses a loopback daemon from a remote page', () => {
    const v = audioAdminView(probe({}), '192.168.1.20')
    expect(v.kind).toBe('down')
  })

  it('treats an any-address daemon as loopback', () => {
    expect(audioAdminView(probe({ url: 'http://0.0.0.0:7870' }), '192.168.1.20').kind).toBe('down')
  })

  it('frames a remote daemon from any page', () => {
    expect(audioAdminView(probe({ url: 'http://10.0.0.5:7870' }), '192.168.1.20')).toEqual({
      kind: 'frame',
      src: 'http://10.0.0.5:7870/admin',
    })
  })

  it('treats [::1] as loopback', () => {
    expect(audioAdminView(probe({ url: 'http://[::1]:7870' }), '[::1]').kind).toBe('frame')
  })
})
