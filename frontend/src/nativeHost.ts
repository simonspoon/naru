/**
 * The native-host bridge (mesa task 1628, `docs/live.md` "Native host bridge").
 *
 * A native app that embeds the page in a WKWebView (naru-mac) can own the live
 * microphone itself. It announces itself by registering one script message
 * handler, `naruLive`; the page then opens no `getUserMedia` of its own and
 * mirrors the mic state the host reports. A plain browser has no such handler,
 * so `detectNativeHost` answers `null` and nothing here is ever installed.
 *
 * Page to host: `window.webkit.messageHandlers.naruLive.postMessage(msg)`.
 * Host to page: `window.naruNativeHost.setMicState({ muted?, level?, hearing? })`.
 * `level` (RMS 0..1) and `hearing` (host's own speech verdict) carry the voice
 * the page would otherwise meter itself, so the orb and glow follow it too.
 */

export const NATIVE_HANDLER = 'naruLive'

/** What the page posts to the host. */
export type NativeOut =
  /** The page subscribed: the host should answer with `setMicState`. */
  | { type: 'ready' }
  /** The conversation the host captures for. `joined` = this browser took part. */
  | { type: 'state'; session: number | null; live: boolean; joined: boolean }
  /** The person pressed the listen switch (button or chord). */
  | { type: 'mic'; muted: boolean }
  /** A speaker-enrollment recording was saved (naru task 1744): the host builds the enrollment from it. */
  | { type: 'enroll' }

/** What the host hands the page. Absent keys leave the page's state alone. */
export type NativeMicState = { muted?: boolean; level?: number; hearing?: boolean }

/** Whether a host push means the person is audibly talking: the host says so,
 *  or its level reaches the page's own capture onset. */
export function hostVoiced(state: NativeMicState, onsetRms: number): boolean {
  return state.hearing === true || (state.level !== undefined && state.level >= onsetRms)
}

export type NativeHost = { post: (msg: NativeOut) => void }

type Bridge = Record<string, unknown>

/** The host, when the page runs inside one. Takes the window as an argument so
 *  the module stays pure. */
export function detectNativeHost(win: Bridge): NativeHost | null {
  const webkit = win.webkit as { messageHandlers?: Record<string, unknown> } | undefined
  const handler = webkit?.messageHandlers?.[NATIVE_HANDLER] as
    | { postMessage?: (msg: unknown) => void }
    | undefined
  if (typeof handler?.postMessage !== 'function') return null
  return { post: (msg) => handler.postMessage!(msg) }
}

/** Installs `window.naruNativeHost`, delivering each valid state to
 *  `onState`, and tells the host the page is ready. Returns the uninstall. */
export function installNativeHost(
  win: Bridge,
  host: NativeHost,
  onState: (state: NativeMicState) => void,
): () => void {
  const api = {
    setMicState(state: unknown) {
      if (typeof state !== 'object' || state === null) return
      const { muted, level, hearing } = state as {
        muted?: unknown
        level?: unknown
        hearing?: unknown
      }
      const out: NativeMicState = {}
      if (typeof muted === 'boolean') out.muted = muted
      if (typeof level === 'number' && Number.isFinite(level)) {
        out.level = Math.min(1, Math.max(0, level))
      }
      if (typeof hearing === 'boolean') out.hearing = hearing
      if (Object.keys(out).length > 0) onState(out)
    },
  }
  win.naruNativeHost = api
  host.post({ type: 'ready' })
  return () => {
    if (win.naruNativeHost === api) delete win.naruNativeHost
  }
}
