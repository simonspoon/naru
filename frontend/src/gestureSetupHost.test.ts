import { describe, expect, it } from 'vitest'
import { hostSetupBridge, setupHostCallbacks } from './gestureSetupHost'
import type { NativeOut } from './nativeHost'

function fixture() {
  const sent: NativeOut[] = []
  const mem = new Map<string, string>()
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  return { sent, bridge: hostSetupBridge({ post: (m) => sent.push(m) }, storage) }
}

describe('hostSetupBridge', () => {
  it('answers a permissions request from the host reply', async () => {
    const { sent, bridge } = fixture()
    const p = bridge.permissions()
    const msg = sent[0] as { id: number; op: string }
    expect(msg.op).toBe('status')
    setupHostCallbacks.permissionsReply({ id: msg.id, ok: true, camera: 'denied', accessibility: 'granted' })
    expect(await p).toEqual({ camera: 'denied', accessibility: 'granted' })
  })

  it('rejects on a failed reply', async () => {
    const { sent, bridge } = fixture()
    const p = bridge.requestCamera()
    setupHostCallbacks.permissionsReply({ id: (sent[0] as { id: number }).id, ok: false, error: 'nope' })
    await expect(p).rejects.toThrow('nope')
  })

  it('streams calibration and stops the camera with the last listener', () => {
    const { sent, bridge } = fixture()
    const got: unknown[] = []
    const stop = bridge.calibrate((s) => got.push(s))
    setupHostCallbacks.calibrationSample({ handDetected: true, lighting: 'dark', distance: 'ok', fps: 30, fpsOk: true })
    stop()
    expect(sent).toEqual([{ type: 'calibration', op: 'start' }, { type: 'calibration', op: 'stop' }])
    expect(got).toEqual([{ handDetected: true, lighting: 'dark', distance: 'ok', fps: 30, fpsOk: true }])
  })

  it('keeps the setup across loads', async () => {
    const { bridge } = fixture()
    expect(await bridge.loadSetup()).toEqual({ done: false, safety: null })
    await bridge.saveSetup({ done: true, safety: null })
    expect((await bridge.loadSetup()).done).toBe(true)
  })
})
