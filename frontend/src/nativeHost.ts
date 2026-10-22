/**
 * The native-host bridge (mesa task 1628, `docs/live.md` "Native host bridge").
 *
 * A native app that embeds the page in a WKWebView (naru-mac) can own the live
 * microphone through naru-audio. It announces itself by registering one script
 * message handler, `naruLive`; the page then opens no `getUserMedia` of its
 * own and takes the mute, level and ambient mode from naru-audio's control
 * socket like any other page (naru tasks 2179, 2210, 2181). A plain browser
 * has no such handler, so `detectNativeHost` answers `null` and nothing here
 * is ever installed.
 *
 * Page to host: `window.webkit.messageHandlers.naruLive.postMessage(msg)`.
 * Host to page: the gesture-setup callbacks and `enrollStatus` (naru task 2259)
 * on `window.naruNativeHost`.
 */

import { SPEAKER_REFRESH_MS } from './liveSpeaker'
import { setupHostCallbacks } from './gestureSetupHost'

export const NATIVE_HANDLER = 'naruLive'

/** What the page posts to the host. */
export type NativeOut =
  /** The page installed `window.naruNativeHost`. */
  | { type: 'ready' }
  /** The conversation the host captures for. `joined` = this browser took part. */
  | {
      type: 'state'
      session: number | null
      live: boolean
      joined: boolean
      /** The page's Pause: the host must capture nothing, submit no utterance
       *  and speak no reply until this reads false again. */
      paused: boolean
      /** The page's speaker mute: the host must speak no reply until this
       *  reads false again. */
      speechMuted: boolean
    }
  /** The person asked to switch the host between ambient (live session open,
   *  page paused) and live. naru-audio's `state` mode answers. */
  | { type: 'ambient'; on: boolean }
  /** Start the native voice-guard enrollment (naru task 2259): the host records ~12 s from the mic itself and
   *  answers through `enrollStatus`. A bare `{type: 'enroll'}` is ignored by the host. */
  | { type: 'enroll'; op: 'start' }
  /** The custom wake words were saved (naru task 1769): no payload, the host refetches them from the server. */
  | { type: 'wakeWords' }
  /** The Gestures setup wizard's permission calls (naru task 1975); answered by `permissionsReply`. */
  | { type: 'permissions'; id: number; op: string; pane?: string }
  /** Start or stop the wizard's calibration stream, which holds the camera. */
  | { type: 'calibration'; op: 'start' | 'stop' }

/** The `state` message the page posts whenever the conversation or Pause changes. */
export function stateMessage(s: {
  session: number | null
  live: boolean
  joined: boolean
  paused: boolean
  speechMuted: boolean
}): NativeOut {
  return {
    type: 'state',
    session: s.session,
    live: s.live,
    joined: s.joined,
    paused: s.paused,
    speechMuted: s.speechMuted,
  }
}

/** The ambient/live switch button: only with a host, in a live session this
 *  browser joined. `next` is the mode a press asks for. */
export function ambientControl(
  hostPresent: boolean,
  live: boolean,
  joined: boolean,
  ambient: boolean,
): { label: 'Ambient' | 'Live'; next: boolean; icon: 'ambient' | 'live' } | null {
  if (!hostPresent || !live || !joined) return null
  return ambient
    ? { label: 'Live', next: false, icon: 'live' }
    : { label: 'Ambient', next: true, icon: 'ambient' }
}

/** The value for the route report's `ambient` key: the host's verdict exactly
 *  when the switch would be offered (host + live + joined), else `undefined`
 *  (omit the key; a plain browser never sends `null`). */
export function reportedAmbient(
  hostPresent: boolean,
  live: boolean,
  joined: boolean,
  ambient: boolean,
): boolean | undefined {
  return ambientControl(hostPresent, live, joined, ambient) === null ? undefined : ambient
}

/** Whether a page that reports `ambient` is due to report again, to stay inside
 *  the server's freshness window (`needsSpeakerRefresh`'s reasoning). */
export function needsHostRefresh(reporting: boolean, lastReportedAt: number, now: number): boolean {
  return reporting && now - lastReportedAt >= SPEAKER_REFRESH_MS
}

/** How long an `on` request waits for the run to finish speaking before the
 *  page acts anyway (a muted or non-speaking page must not wedge it). */
export const AMBIENT_SAY_GRACE_MS = 15000

/** What to do about the session's pending ambient request: `null` = nothing
 *  (or wait), else the `ambient` message to post. `firstSeenAt` is when this
 *  page first saw `seq`. */
export function ambientRequestStep(input: {
  hostPresent: boolean
  live: boolean
  joined: boolean
  ambient: boolean
  request: boolean | null
  seq: number
  actedSeq: number | null
  runIdle: boolean
  firstSeenAt: number | null
  now: number
}): { post: boolean; on: boolean } | null {
  const { hostPresent, live, joined, ambient, request, seq, actedSeq, runIdle, firstSeenAt, now } = input
  if (!hostPresent || !live || !joined || request === null) return null
  if (seq === actedSeq || request === ambient) return null
  if (!request) return { post: true, on: false }
  if (runIdle || (firstSeenAt !== null && now - firstSeenAt >= AMBIENT_SAY_GRACE_MS)) {
    return { post: true, on: true }
  }
  return null
}

/** The host's enrollment state, pushed through `naruNativeHost.enrollStatus` (naru task 2258). */
export type EnrollStatus = { enrolling: boolean; enrolled: boolean; note: string | null; seconds: number }

let enrollLast: EnrollStatus | null = null
const enrollListeners = new Set<(s: EnrollStatus) => void>()

/** The host-to-page enrollment callback. A malformed payload is dropped. */
export function enrollStatus(r: unknown) {
  if (typeof r !== 'object' || r === null) return
  const o = r as Record<string, unknown>
  if (typeof o.enrolling !== 'boolean' || typeof o.enrolled !== 'boolean') return
  enrollLast = {
    enrolling: o.enrolling,
    enrolled: o.enrolled,
    note: typeof o.note === 'string' ? o.note : null,
    seconds: typeof o.seconds === 'number' && o.seconds > 0 ? o.seconds : 12,
  }
  enrollListeners.forEach((cb) => cb(enrollLast!))
}

/** Subscribes to enrollment pushes; the newest one so far (the host pushes on ready, before the page
 *  section mounts) is replayed at once. Returns the unsubscribe. */
export function onEnrollStatus(cb: (s: EnrollStatus) => void): () => void {
  enrollListeners.add(cb)
  if (enrollLast) cb(enrollLast)
  return () => enrollListeners.delete(cb)
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

/** Installs `window.naruNativeHost` (the gesture-setup and enrollment callbacks) and tells
 *  the host the page is ready. Returns the uninstall. */
export function installNativeHost(win: Bridge, host: NativeHost): () => void {
  const api = { ...setupHostCallbacks, enrollStatus }
  win.naruNativeHost = api
  host.post({ type: 'ready' })
  return () => {
    if (win.naruNativeHost === api) delete win.naruNativeHost
  }
}
