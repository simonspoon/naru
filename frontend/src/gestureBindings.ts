// Pure logic behind Settings > Gestures (naru task 1972): the binding model,
// the action catalog, the "when" text, conflict rows and draft validation.
// The bridge types of tasks 1965/1966 are not in `nativeHost.ts` yet, so the
// page talks to the host through the thin `GestureBridge` below; swap it for
// those types when they land.

export type GesturePage = 'any' | 'live' | 'tasks' | string

export type GestureBinding = {
  id: string
  gesture: string // 'palm-hold'
  action: string // action id from ACTIONS
  behavior: ActionBehavior
  page: GesturePage
  micLive: boolean
  naruFocused: boolean
  cooldownS: number
  ask: boolean
  enabled: boolean
}

export type ActionBehavior = 'toggle' | 'on' | 'off'

export type GestureConflict = { binding: string; message: string }

/** What the host reports: the bindings, the master switch, engine conflicts. */
export type GestureState = {
  on: boolean
  bindings: GestureBinding[]
  conflicts: GestureConflict[]
}

/** A gesture the camera just saw. */
export type GestureSeen = { gesture: string; heldS: number; needS: number; action?: string; score?: number }

export type GestureBridge = {
  load: () => Promise<GestureState>
  save: (bindings: GestureBinding[]) => Promise<void>
  setOn: (on: boolean) => Promise<void>
  /** Starts listening for a test gesture; returns the stop function. */
  onSeen: (cb: (seen: GestureSeen | null) => void) => () => void
}

/** What a pose-recording take reports (host messages are not in
 *  `nativeHost.ts` yet; these are the shapes the page expects). */
export type RecordEvent =
  | { phase: 'holding'; progress: number } // 0..1 over about a second
  | { phase: 'captured'; sample: number[] }
  | { phase: 'lost' }

/** What a motion-recording take reports (naru task 1974): the fingertip trail
 *  as normalised 0..1 points, then the resampled path vector, or too short. */
export type PathEvent =
  | { phase: 'tracing'; points: [number, number][] }
  | { phase: 'captured'; sample: number[] }
  | { phase: 'short' }

/** One live match against a recorded pose, with overlaps against the others. */
export type MatchEvent = { score: number; overlaps?: { name: string; overlap: number }[] }

/** Optional library calls; a host without them leaves the library in memory. */
export type GestureLibraryBridge = {
  loadLibrary: () => Promise<import('./gestureLibrary').Gesture[]>
  saveLibrary: (gestures: import('./gestureLibrary').Gesture[]) => Promise<void>
  /** Records one take; returns the stop function. */
  recordTake: (cb: (e: RecordEvent) => void) => () => void
  /** Matches the camera against a pose vector; returns the stop function. */
  matchPose: (sample: number[], cb: (m: MatchEvent) => void) => () => void
  /** Records one path take until `endPath` is called; returns the stop function. */
  recordPath: (cb: (e: PathEvent) => void) => () => void
  /** Ends the path take in progress (the Stop take button). */
  endPath: () => void
  /** Matches the camera's path against a path vector; returns the stop function. */
  matchMotion: (sample: number[], cb: (m: MatchEvent) => void) => () => void
}

export function libraryBridge(b: GestureBridge): Partial<GestureLibraryBridge> {
  return b as unknown as Partial<GestureLibraryBridge>
}

/** The host's gesture API, when the Mac app installed one. */
export function gestureBridge(win: Record<string, unknown>): GestureBridge | null {
  const b = win.naruGestures as Partial<GestureBridge> | undefined
  return b && typeof b.load === 'function' && typeof b.save === 'function' &&
    typeof b.setOn === 'function' && typeof b.onSeen === 'function'
    ? (b as GestureBridge)
    : null
}

export const GESTURES: { id: string; label: string; holdS: number }[] = [
  { id: 'palm-hold', label: 'Palm hold', holdS: 1 },
  { id: 'fist-hold', label: 'Fist hold', holdS: 1 },
  { id: 'swipe-right', label: 'Swipe right', holdS: 0 },
  { id: 'swipe-left', label: 'Swipe left', holdS: 0 },
  { id: 'pinch', label: 'Pinch', holdS: 0 },
]

export function gestureLabel(id: string): string {
  const g = GESTURES.find((x) => x.id === id)
  if (!g) return id
  return g.holdS > 0 ? `${g.label} (${g.holdS.toFixed(1)}s)` : g.label
}

export const CATEGORIES = ['Naru', 'Voice', 'Navigate', 'Scripts', 'Workflows', 'System'] as const
export type ActionCategory = (typeof CATEGORIES)[number]

export type GestureAction = {
  id: string
  label: string
  category: ActionCategory
  sub: string
  /** Absent = no behavior choice. */
  behaviors?: ActionBehavior[]
}

const ALL: ActionBehavior[] = ['toggle', 'on', 'off']

export const ACTIONS: GestureAction[] = [
  { id: 'toggle-mic', label: 'Toggle mic', category: 'Voice', sub: 'on↔off', behaviors: ALL },
  { id: 'pause-voice', label: 'Pause voice', category: 'Voice', sub: 'pause or resume the conversation', behaviors: ALL },
  { id: 'mute-speaker', label: 'Mute speaker', category: 'Voice', sub: 'silence Naru’s replies', behaviors: ALL },
  { id: 'ambient-mode', label: 'Ambient mode', category: 'Voice', sub: 'ambient ↔ live', behaviors: ALL },
  { id: 'say-phrase', label: 'Say a phrase', category: 'Voice', sub: 'speak a fixed line' },
  { id: 'open-palette', label: 'Open command palette', category: 'Naru', sub: 'search everything' },
  { id: 'toggle-chat', label: 'Chat panel', category: 'Naru', sub: 'show or hide the conversation', behaviors: ALL },
  { id: 'next-task', label: 'Next task', category: 'Navigate', sub: 'on the tasks page' },
  { id: 'prev-task', label: 'Previous task', category: 'Navigate', sub: 'on the tasks page' },
  { id: 'go-live', label: 'Go to Live', category: 'Navigate', sub: 'open the live page' },
  { id: 'run-script', label: 'Run script', category: 'Scripts', sub: 'a script from the Library' },
  { id: 'run-workflow', label: 'Run workflow', category: 'Workflows', sub: 'a workflow by name' },
  { id: 'lock-screen', label: 'Lock screen', category: 'System', sub: 'lock this Mac' },
]

export function actionLabel(id: string): string {
  return ACTIONS.find((a) => a.id === id)?.label ?? id
}

const BEHAVIOR_TEXT: Record<ActionBehavior, string> = { toggle: 'Toggle', on: 'Always on', off: 'Always off' }
export const behaviorLabel = (b: ActionBehavior): string => BEHAVIOR_TEXT[b]

/** Actions matching a search (name or sub-label, case-insensitive) across all
 *  categories, or within one when the search is blank. */
export function filterActions(query: string, category: ActionCategory | null): GestureAction[] {
  const q = query.trim().toLowerCase()
  if (q) {
    return ACTIONS.filter((a) => `${a.label} ${a.sub}`.toLowerCase().includes(q))
  }
  return category ? ACTIONS.filter((a) => a.category === category) : ACTIONS
}

/** The "When" column: page, then the two flags; "anywhere" if none. */
export function whenText(b: Pick<GestureBinding, 'page' | 'micLive' | 'naruFocused'>): string {
  const parts: string[] = []
  if (b.page !== 'any') parts.push(`${b.page.charAt(0).toUpperCase()}${b.page.slice(1)} page`)
  if (b.micLive) parts.push('mic live')
  if (b.naruFocused) parts.push('Naru focused')
  return parts.length ? parts.join(', ') : 'anywhere'
}

/** The action column, with a non-default behavior spelled out. */
export function actionText(b: Pick<GestureBinding, 'action' | 'behavior'>): string {
  const a = ACTIONS.find((x) => x.id === b.action)
  const base = a?.label ?? b.action
  return a?.behaviors && b.behavior !== 'toggle' ? `${base} (${behaviorLabel(b.behavior).toLowerCase()})` : base
}

/** Another binding that uses the same gesture where this one could also fire
 *  (pages overlap when either is `any` or they match). */
export function conflictWarning(draft: GestureBinding, others: GestureBinding[]): string | null {
  const o = others.find(
    (x) => x.id !== draft.id && x.gesture === draft.gesture && (x.page === 'any' || draft.page === 'any' || x.page === draft.page),
  )
  if (!o) return null
  const where = o.page === 'any' ? '' : ` on the ${o.page.charAt(0).toUpperCase()}${o.page.slice(1)} page`
  const tail = draft.page === 'any' && o.page === 'any' ? ' Only one can fire.' : ' Conditions keep them apart.'
  return `${gestureLabel(draft.gesture).replace(/ \(.*\)$/, '')} is also used by ${actionLabel(o.action)}${where}.${tail}`
}

/** Why a draft cannot be saved, or null. */
export function draftError(d: GestureBinding): string | null {
  if (!d.action) return 'Choose an action'
  if (!d.gesture) return 'Choose a gesture'
  if (!Number.isFinite(d.cooldownS) || d.cooldownS < 0) return 'Cooldown cannot be negative'
  return null
}

/** The live test strip. */
export function seenText(on: boolean, seen: GestureSeen | null, bindings: GestureBinding[]): string {
  if (!on) return 'Gestures are off'
  if (!seen) return 'No gesture seen'
  const name = gestureLabel(seen.gesture).replace(/ \(.*\)$/, '').toLowerCase()
  const num = (n: number) => `${Math.round(n * 10) / 10}s`
  const held = seen.needS > 0 ? `, ${num(seen.heldS)} of ${num(seen.needS)}` : ''
  const b = bindings.find((x) => x.gesture === seen.gesture)
  const act = seen.action ?? (b ? actionText(b) : null)
  return `Seen: ${name}${held}${act ? ` → ${act}` : ''}`
}

let n = 0
export function newBinding(): GestureBinding {
  n += 1
  return {
    id: `new-${Date.now()}-${n}`,
    gesture: 'palm-hold',
    action: '',
    behavior: 'toggle',
    page: 'any',
    micLive: false,
    naruFocused: false,
    cooldownS: 2,
    ask: false,
    enabled: true,
  }
}
