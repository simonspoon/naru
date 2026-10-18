// The Gestures setup wizard's calls over the real native transport (naru task
// 1975): permissions and calibration ride the `naruLive` handler the Mac app
// already answers (`{type:"permissions"|"calibration"}`, replies through
// `naruNativeHost.permissionsReply` / `permissionsChanged` / `calibrationSample`).
// The safety defaults and the "setup done" flag are kept in the page's own
// localStorage, which the Mac app's web view keeps across restarts.

import type { NativeHost } from './nativeHost'
import type { CalibrationSample, GestureSetupBridge, Permissions, SetupState } from './gestureWizard'

type Reply = Partial<Permissions> & { id?: unknown; ok?: unknown; error?: unknown }

const pending = new Map<number, { ok: (p: Permissions) => void; fail: (e: Error) => void }>()
const changed = new Set<(p: Permissions) => void>()
const samples = new Set<(s: CalibrationSample) => void>()
let nextId = 1

const STATES = ['granted', 'denied', 'notDetermined']
function asPerms(r: Reply): Permissions | null {
  return typeof r.camera === 'string' && typeof r.accessibility === 'string' &&
    STATES.includes(r.camera) && STATES.includes(r.accessibility)
    ? { camera: r.camera, accessibility: r.accessibility }
    : null
}

/** The host-to-page callbacks `installNativeHost` puts on `window.naruNativeHost`. */
export const setupHostCallbacks = {
  permissionsReply(r: unknown) {
    if (typeof r !== 'object' || r === null) return
    const reply = r as Reply
    const waiter = typeof reply.id === 'number' ? pending.get(reply.id) : undefined
    if (!waiter) return
    pending.delete(reply.id as number)
    const p = asPerms(reply)
    if (reply.ok === true && p) waiter.ok(p)
    else waiter.fail(new Error(typeof reply.error === 'string' ? reply.error : 'permissions request failed'))
  },
  permissionsChanged(r: unknown) {
    const p = typeof r === 'object' && r !== null ? asPerms(r as Reply) : null
    if (p) changed.forEach((cb) => cb(p))
  },
  calibrationSample(r: unknown) {
    if (typeof r !== 'object' || r === null) return
    const s = r as Partial<CalibrationSample>
    if (typeof s.handDetected !== 'boolean' || typeof s.fps !== 'number') return
    const out: CalibrationSample = {
      handDetected: s.handDetected,
      lighting: s.lighting === 'ok' || s.lighting === 'dark' || s.lighting === 'bright' ? s.lighting : 'unknown',
      distance: s.distance === 'ok' || s.distance === 'tooClose' || s.distance === 'tooFar' ? s.distance : 'none',
      fps: s.fps,
      fpsOk: s.fpsOk === true,
    }
    samples.forEach((cb) => cb(out))
  },
}

export const SETUP_KEY = 'naru-gesture-setup'

export function hostSetupBridge(host: NativeHost, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): GestureSetupBridge {
  function ask(msg: { op: string; pane?: string }): Promise<Permissions> {
    const id = nextId++
    return new Promise((ok, fail) => {
      pending.set(id, { ok, fail })
      host.post({ type: 'permissions', id, ...msg })
    })
  }
  return {
    loadSetup: () => {
      try {
        const v = JSON.parse(storage.getItem(SETUP_KEY) ?? 'null') as SetupState | null
        return Promise.resolve(v && typeof v.done === 'boolean' ? { done: v.done, safety: v.safety ?? null } : { done: false, safety: null })
      } catch {
        return Promise.resolve({ done: false, safety: null })
      }
    },
    saveSetup: (s) => {
      try {
        storage.setItem(SETUP_KEY, JSON.stringify(s))
        return Promise.resolve()
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)))
      }
    },
    permissions: () => ask({ op: 'status' }),
    requestCamera: () => ask({ op: 'requestCamera' }),
    requestAccessibility: () => ask({ op: 'requestAccessibility' }),
    openSettings: (pane) => {
      void ask({ op: 'openSettings', pane }).catch(() => undefined)
    },
    onPermissionsChanged: (cb) => {
      changed.add(cb)
      return () => changed.delete(cb)
    },
    calibrate: (cb) => {
      samples.add(cb)
      host.post({ type: 'calibration', op: 'start' })
      return () => {
        samples.delete(cb)
        if (samples.size === 0) host.post({ type: 'calibration', op: 'stop' })
      }
    },
  }
}
