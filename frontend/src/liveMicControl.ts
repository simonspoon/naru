import { maySpeak } from './liveSpeaker'

/**
 * The page as a control client of naru-audio's mic state (naru task 2179,
 * `docs/live.md` "The mic control client").
 *
 * naru-audio owns the live conversation's mode (naru-audio task 2178): every
 * socket of one `conversation` shares one mode and one `seq`. The page joins
 * it through serve's `/v1/audio/live` proxy as a `role: "control"` socket,
 * sends only the person's intent on a mic press, and renders the mute only
 * from the server's `state` — never an optimistic value of its own.
 */

/** The control socket's address: same origin, through serve's proxy. */
export function controlUrl(location: { protocol: string; host: string }): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/v1/audio/live`
}

/** The conversation key: the live session id as a plain decimal string, the
 *  same value the page posts the host as `stateMessage.session`. */
export function conversationKey(sessionId: number): string {
  return String(sessionId)
}

/** The first frame. `mode` begins the conversation when this socket is its
 *  first; a later joiner takes the server's mode whatever this says. */
export function controlStart(conversation: string, mode: 'live' | 'muted'): string {
  return JSON.stringify({ type: 'start', role: 'control', conversation, mode })
}

/** The one message a mic press sends. */
export function intentFor(nextMuted: boolean): string {
  return JSON.stringify({ type: 'mode', mode: nextMuted ? 'muted' : 'live' })
}

/** The server events the page reads; anything else is `null` (ignored). */
export type ControlEvent = { kind: 'ready' } | { kind: 'state'; mode: string; seq: number } | null

export function parseControlEvent(data: unknown): ControlEvent {
  if (typeof data !== 'string') return null
  let msg: unknown
  try {
    msg = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof msg !== 'object' || msg === null) return null
  const { type, mode, seq } = msg as { type?: unknown; mode?: unknown; seq?: unknown }
  if (type === 'ready') return { kind: 'ready' }
  if (type === 'state' && typeof mode === 'string' && typeof seq === 'number' && Number.isFinite(seq)) {
    return { kind: 'state', mode, seq }
  }
  return null
}

/** Whether a `state` is news: its `seq` rises past the last one seen. The
 *  caller resets `lastSeq` to 0 on every `ready`, since a forgotten
 *  conversation begins again at seq 1. */
export function acceptState(lastSeq: number, seq: number): boolean {
  return seq > lastSeq
}

/** Only `live` is listening; `muted`, `idle` and `ambient` all shut the mic. */
export function mutedFromMode(mode: string): boolean {
  return mode !== 'live'
}

/** Whether the page takes the control-client path: a plain browser (no host),
 *  or a host that said it is a thin client (`setHostInfo`). An older host
 *  keeps the `{type:mic}` / `setMicState` bridge. */
export function takesThinPath(hostPresent: boolean, hostThin: boolean): boolean {
  return !hostPresent || hostThin
}

/** Reconnect backoff: 500 ms doubling, capped at 5 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(5000, 500 * 2 ** Math.max(0, attempt))
}

/**
 * The mic switch (naru task 2201). Only the client holding the speaker claim
 * captures (naru task 2095), so with the claim on another client the switch
 * is `elsewhere`: off, and a press takes the claim back. A native host that
 * hands the mic to naru-audio (`hostOwnsMic`: a host present and thin) holds
 * the claim under its own client id, not the page's — there the claim is the
 * page's own and the switch follows naru-audio's mute alone. A plain browser
 * is on the thin path too but captures itself, so it keeps the claim rule.
 */
export function micSwitch(o: {
  unlocked: boolean
  speaker: string | null
  client: string
  hostOwnsMic: boolean
  thin: boolean
  micReady: boolean
  muted: boolean
}): { capturing: boolean; elsewhere: boolean; waiting: boolean; on: boolean; offLabel: string } {
  const capturing = o.unlocked && (o.hostOwnsMic || maySpeak(o.speaker, o.client))
  const elsewhere = o.unlocked && !capturing
  // The switch waits for naru-audio's first `state` on the thin path.
  const waiting = o.thin && !o.micReady
  const on = !waiting && !o.muted && !elsewhere
  const offLabel = waiting
    ? 'Connecting to naru-audio…'
    : elsewhere
      ? 'Listen on this browser instead'
      : 'Listen through this browser'
  return { capturing, elsewhere, waiting, on, offLabel }
}

/**
 * The speaker id a turn is posted with (naru task 2203). The server refuses a
 * turn whose `client` is not the claim holder (naru task 2095), and a native
 * host that owns the mic holds the claim under its own id — so there the page
 * posts with no `client`, the check the server skips, exactly as `micSwitch`
 * counts that claim as the page's own. Everywhere else it posts its own id.
 */
export function utteranceClient(client: string, hostOwnsMic: boolean): string | undefined {
  return hostOwnsMic ? undefined : client
}

/** The last mode the page was told, per session (naru task 2204). */
export type MicFor = { id: number; muted: boolean }

/** Where `MicFor` survives a reload: `sessionStorage`, one tab's own. */
export const MIC_FOR_KEY = 'naru-live-mic'

/** The mode a `start` asks for: `muted` only when the last word for this
 *  same session was a mute — a new session (another id) begins live. */
export function seedMode(prior: MicFor | null, id: number): 'live' | 'muted' {
  return prior !== null && prior.id === id && prior.muted ? 'muted' : 'live'
}

/** A stored `MicFor` read back; anything malformed is `null`. */
export function readMicFor(raw: string | null): MicFor | null {
  if (raw === null) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const { id, muted } = v as { id?: unknown; muted?: unknown }
  if (typeof id !== 'number' || !Number.isFinite(id) || typeof muted !== 'boolean') return null
  return { id, muted }
}
