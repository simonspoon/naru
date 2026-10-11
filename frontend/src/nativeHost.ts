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
 * Host to page: `window.naruNativeHost.setMicState({ muted?, level?, hearing?, ambient? })`.
 * `level` (RMS 0..1) and `hearing` (host's own speech verdict) carry the voice
 * the page would otherwise meter itself, so the orb and glow follow it too.
 */

import { SPEAKER_REFRESH_MS } from './liveSpeaker'

export const NATIVE_HANDLER = 'naruLive'

/** What the page posts to the host. */
export type NativeOut =
  /** The page subscribed: the host should answer with `setMicState`. */
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
  /** The person pressed the listen switch (button or chord). */
  | { type: 'mic'; muted: boolean }
  /** The person asked to switch the host between ambient (live session open,
   *  page paused) and live. The host's `setMicState.ambient` answers. */
  | { type: 'ambient'; on: boolean }
  /** A speaker-enrollment recording was saved (naru task 1744): the host builds the enrollment from it. */
  | { type: 'enroll' }
  /** The custom wake words were saved (naru task 1769): no payload, the host refetches them from the server. */
  | { type: 'wakeWords' }

/** What the host hands the page. Absent keys leave the page's state alone. */
export type NativeMicState = {
  muted?: boolean
  level?: number
  hearing?: boolean
  /** The host's verdict on ambient vs live; authoritative. */
  ambient?: boolean
}

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
      const { muted, level, hearing, ambient } = state as {
        ambient?: unknown
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
      if (typeof ambient === 'boolean') out.ambient = ambient
      if (Object.keys(out).length > 0) onState(out)
    },
  }
  win.naruNativeHost = api
  host.post({ type: 'ready' })
  return () => {
    if (win.naruNativeHost === api) delete win.naruNativeHost
  }
}
