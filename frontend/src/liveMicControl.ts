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
