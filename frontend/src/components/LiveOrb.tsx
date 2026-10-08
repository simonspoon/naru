import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LiveIndicator } from '../liveIndicator'
import { markMode } from '../liveMark'
import {
  clampPlacement,
  clampPoint,
  isDrag,
  muteIcon,
  ORB_SIZE,
  ORB_STORAGE_KEY,
  orbBrightness,
  parsePlacement,
  serializePlacement,
  settle,
  type Placement,
  type Point,
  usableHeight,
} from '../liveOrb'
import { isPhone, usePhoneTier } from '../phoneTier'
import { NaruMark } from './NaruMark'

/** How far the pie blooms past the body, px, and its ring radii in the
 *  pie's own viewBox (centre = PIE / 2). */
const PAD = 34
const PIE = ORB_SIZE + 2 * PAD
// The sectors touch the body: a gap would drop `:hover` on the way out to them.
const R_IN = ORB_SIZE / 2
const R_OUT = PIE / 2 - 2

function polar(deg: number, r: number): string {
  const a = (deg * Math.PI) / 180
  return `${(PIE / 2 + r * Math.cos(a)).toFixed(2)} ${(PIE / 2 + r * Math.sin(a)).toFixed(2)}`
}

/** An annular sector from `a0` to `a1` degrees (screen angles, y down). */
function sector(a0: number, a1: number): string {
  return `M ${polar(a0, R_IN)} A ${R_IN} ${R_IN} 0 0 1 ${polar(a1, R_IN)} L ${polar(a1, R_OUT)} A ${R_OUT} ${R_OUT} 0 0 0 ${polar(a0, R_OUT)} Z`
}

/** Centre of a segment's icon. */
function mid(deg: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180
  const r = (R_IN + R_OUT) / 2
  return { x: PIE / 2 + r * Math.cos(a), y: PIE / 2 + r * Math.sin(a) }
}

function MicGlyph({ slashed = false }: { slashed?: boolean }) {
  return (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d={slashed ? 'M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16' : 'M5 11a7 7 0 0 0 14 0M12 18v3'} />
    </g>
  )
}

function SpeakerGlyph({ muted }: { muted: boolean }) {
  return (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d={muted ? 'M16 9l5 6M21 9l-5 6' : 'M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11'} />
    </g>
  )
}

function PauseGlyph({ paused }: { paused: boolean }) {
  return paused ? (
    <path d="M8 5l11 7-11 7z" fill="currentColor" />
  ) : (
    <g stroke="currentColor" strokeWidth="3.4" strokeLinecap="round">
      <path d="M8 5v14M16 5v14" />
    </g>
  )
}

/** One pie segment: a real button for the keyboard, drawn as an SVG sector. */
function Segment({
  d,
  at,
  label,
  active,
  off,
  disabled,
  onPress,
  children,
}: {
  d: string
  at: { x: number; y: number }
  label: string
  active: boolean
  /** The control is in its off state (muted / paused): drawn red, else blue. */
  off: boolean
  disabled?: boolean
  onPress: () => void
  children: React.ReactNode
}) {
  return (
    <g
      className={`live-orb-seg${off ? ' off' : ''}${disabled ? ' disabled' : ''}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-pressed={active}
      aria-disabled={disabled}
      onClick={(e) => {
        // A pointer press leaves focus on the segment, which would hold the
        // pie open through `:focus-within`; the keyboard path is onKeyDown.
        e.currentTarget.blur()
        if (!disabled) onPress()
      }}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onPress()
        }
      }}
    >
      <title>{label}</title>
      <path d={d} />
      <svg x={at.x - 11} y={at.y - 11} width="22" height="22" viewBox="0 0 24 24" pointerEvents="none">
        {children}
      </svg>
    </g>
  )
}

/** Height of the phone tab bar, or 0 off the phone tier (the bar's own 3rem
 *  reserve stands in before it has mounted). */
function tabbarHeight(phone: boolean): number {
  if (!phone) return 0
  return document.querySelector('.phone-tabbar')?.getBoundingClientRect().height || 48
}

function loadPlacement(): Placement {
  const w = window.innerWidth
  const h = usableHeight(window.innerHeight, tabbarHeight(isPhone()))
  try {
    return parsePlacement(window.localStorage.getItem(ORB_STORAGE_KEY), w, h)
  } catch {
    return parsePlacement(null, w, h)
  }
}

/** What an orb shows and the three presses its pie offers — the hub's own
 *  state and handlers, so every orb (floating, docked panel, rail) agrees. */
export type OrbProps = {
  state: LiveIndicator | null
  level: number
  speechRms: () => number | null
  /** The microphone is a way in at all (the head's mic-button predicate). */
  micAvailable: boolean
  /** The microphone is off (the hub's `muted`). */
  micMuted: boolean
  speechMuted: boolean
  paused: boolean
  pauseLabel: string
  pauseDisabled: boolean
  /** Pause and sound mute are offered (the head's `pauseButton` predicate). */
  canPause: boolean
  onToggleMic: () => void
  onTogglePause: () => void
  onToggleSpeech: () => void
  /** An overheard "can help" offer is waiting (naru task 1700): the orb glows
   *  silently and a press accepts it. Absent/null = no offer. */
  offer?: { title: string; onAccept: () => void } | null
}

/** The props that make an orb element a button while an offer glows. */
function offerButton(offer: OrbProps['offer']) {
  if (!offer) return {}
  return {
    role: 'button' as const,
    tabIndex: 0,
    title: offer.title,
    'aria-label': offer.title,
    onClick: offer.onAccept,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        offer.onAccept()
      }
    },
  }
}

/** The three-segment pie: mic left, pause right, sound below. */
function OrbPie(p: OrbProps) {
  if (!(p.micAvailable || p.canPause)) return null
  return (
    <svg className="live-orb-pie" viewBox={`0 0 ${PIE} ${PIE}`} width={PIE} height={PIE}>
      {p.micAvailable && (
        <Segment
          d={sector(140, 220)}
          at={mid(180)}
          label={p.micMuted ? 'Listen through this browser' : 'Stop listening'}
          active={!p.micMuted}
          off={p.micMuted}
          onPress={p.onToggleMic}
        >
          <MicGlyph />
        </Segment>
      )}
      {p.canPause && (
        <Segment
          d={sector(-40, 40)}
          at={mid(0)}
          label={p.pauseLabel}
          active={p.paused}
          off={p.paused}
          disabled={p.pauseDisabled}
          onPress={p.onTogglePause}
        >
          <PauseGlyph paused={p.paused} />
        </Segment>
      )}
      {p.canPause && (
        <Segment
          d={sector(50, 130)}
          at={mid(90)}
          label={p.speechMuted ? 'Unmute spoken replies' : 'Mute spoken replies'}
          active={p.speechMuted}
          off={p.speechMuted}
          onPress={p.onToggleSpeech}
        >
          <SpeakerGlyph muted={p.speechMuted} />
        </Segment>
      )}
    </svg>
  )
}

function OrbBadge({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <span className="live-orb-badge" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14">
        <SpeakerGlyph muted />
      </svg>
    </span>
  )
}

function orbClasses(state: LiveIndicator | null, mute: ReturnType<typeof muteIcon>): string {
  return `${orbBrightness(state) === 'bright' ? 'bright' : 'dim'} mode-${markMode(state)}${mute !== null ? ' muted' : ''}`
}

/**
 * The rail's mini orb (mesa task 1574, docs/dock.md): the floating orb's sphere,
 * in flow, scaled to `size` px, that only reacts — no pie, no dragging.
 */
export function InlineOrb({ size, ...p }: OrbProps & { size: number }) {
  const mute = muteIcon(p.micAvailable && p.micMuted, p.speechMuted)
  const k = size / ORB_SIZE
  return (
    <div
      className={`live-orb live-orb-inline ${orbClasses(p.state, mute)}${p.offer ? ' can-help' : ''}`}
      {...offerButton(p.offer)}
      // The box keeps the 116px geometry; `scale` shrinks it, and the negative
      // margin gives back the layout space it no longer takes.
      style={{ width: ORB_SIZE, height: ORB_SIZE, scale: k, margin: -((ORB_SIZE - size) / 2) }}
    >
      <div className="live-orb-body">
        <div className="live-orb-mark">
          <NaruMark state={p.state} level={p.level} speechRms={p.speechRms} decorative offer={!!p.offer} />
        </div>
      </div>
    </div>
  )
}

/**
 * The `orb` dock panel's body (mesa task 1577): the animated mark filling the
 * panel over a soft glow in the state's colour — no sphere, no ring, no words,
 * no controls (those are `OrbHeaderControls`, in the page header).
 * The mark's box is a square fitted by container units, so it takes the height
 * of a short wide panel and the width of a tall narrow one.
 */
export function OrbPanel(p: OrbProps) {
  return (
    <div
      className={`orb-panel ${orbClasses(p.state, null)}${p.offer ? ' can-help' : ''}`}
      aria-label="Naru"
      {...offerButton(p.offer)}
    >
      <div className="orb-panel-stage">
        <div className="orb-panel-mark">
          <div className="orb-panel-glow" />
          <NaruMark state={p.state} level={p.level} speechRms={p.speechRms} decorative offer={!!p.offer} />
        </div>
        {p.offer && <div className="orb-panel-caption">Naru can help — click to talk</div>}
      </div>
    </div>
  )
}

/** One of the header's small icon buttons: a real button, named, no label. */
function HeaderButton({
  label,
  off,
  disabled,
  onPress,
  children,
}: {
  label: string
  /** The control is in its off state (muted / paused): drawn red. */
  off: boolean
  disabled?: boolean
  onPress: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={`header-orb-btn${off ? ' off' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={off}
      disabled={disabled}
      onClick={onPress}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        {children}
      </svg>
    </button>
  )
}

/**
 * The mic / pause / sound icon buttons in the page header, left of the usage
 * chips (mesa task 1579). Rendered by `LiveHub` itself, which lives in the
 * header, so they work whether the Naru panel is open, closed or docked in the
 * collapsed nav; the muted mic is red and slashed.
 */
export function OrbHeaderControls(p: OrbProps) {
  if (!p.micAvailable && !p.canPause) return null
  return (
    <>
      <div className="header-orb-ctrls">
        {p.micAvailable && (
          <HeaderButton
            label={p.micMuted ? 'Listen through this browser' : 'Stop listening'}
            off={p.micMuted}
            onPress={p.onToggleMic}
          >
            <MicGlyph slashed={p.micMuted} />
          </HeaderButton>
        )}
        {p.canPause && (
          <HeaderButton label={p.pauseLabel} off={p.paused} disabled={p.pauseDisabled} onPress={p.onTogglePause}>
            <PauseGlyph paused={p.paused} />
          </HeaderButton>
        )}
        {p.canPause && (
          <HeaderButton
            label={p.speechMuted ? 'Unmute spoken replies' : 'Mute spoken replies'}
            off={p.speechMuted}
            onPress={p.onToggleSpeech}
          >
            <SpeakerGlyph muted={p.speechMuted} />
          </HeaderButton>
        )}
      </div>
      <span className="header-orb-divider" aria-hidden="true" />
    </>
  )
}

/**
 * The floating Naru orb (mesa task 1553): the animated mark as a draggable
 * panel above every page for as long as a conversation is live and joined.
 * The body is the drag handle and stays exactly where it is dropped, except
 * near the top edge, where it docks small (remembered in localStorage); hovering — or tapping, for touch — blooms a
 * three-segment pie: mic left, pause right, sound below. The segments are the
 * hub's own handlers, passed in, so the orb and the panel head can never
 * disagree. No text is drawn on it. Portalled to `document.body` so no
 * sidebar, drawer or route can cover it.
 */
export function LiveOrb(props: OrbProps) {
  const { state, level, speechRms } = props
  const [placed, setPlaced] = useState<Placement>(loadPlacement)
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [drag, setDrag] = useState<Point | null>(null)
  const [pinned, setPinned] = useState(false)
  const dragRef = useRef<Point | null>(null)
  const press = useRef<{ id: number; start: Point; grab: Point; moved: boolean } | null>(null)

  useEffect(() => {
    const onResize = (): void => setVp({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // A pinned pie closes on a press anywhere outside the orb, and on Escape.
  useEffect(() => {
    if (!pinned) return
    const away = (e: PointerEvent): void => {
      if (!(e.target instanceof Element) || e.target.closest('.live-orb') === null) setPinned(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPinned(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [pinned])

  const phone = usePhoneTier()
  const vh = usableHeight(vp.h, tabbarHeight(phone))
  const rest = clampPlacement(placed, vp.w, vh)
  const pos = drag ?? rest

  const onDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      const box = e.currentTarget.getBoundingClientRect()
      press.current = {
        id: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        // The point on the body under the pointer, as a fraction of its box as
        // painted now (a docked orb is shrunk), so growing under the pointer
        // on a drag does not move the orb out from under it.
        grab: {
          x: ((e.clientX - box.left) / box.width) * ORB_SIZE,
          y: ((e.clientY - box.top) / box.height) * ORB_SIZE,
        },
        moved: false,
      }
    },
    [],
  )
  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = press.current
    if (p === null || p.id !== e.pointerId) return
    const at = { x: e.clientX, y: e.clientY }
    if (!p.moved && !isDrag(p.start, at)) return
    p.moved = true
    const next = clampPoint({ x: at.x - p.grab.x, y: at.y - p.grab.y }, vp.w, vh)
    dragRef.current = next
    setDrag(next)
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = press.current
    if (p === null || p.id !== e.pointerId) return
    press.current = null
    if (!p.moved) {
      if (props.offer) props.offer.onAccept()
      else setPinned((v) => !v)
      return
    }
    const to = dragRef.current ?? rest
    dragRef.current = null
    setDrag(null)
    const next = settle(to, vp.w, vh)
    setPlaced(next)
    try {
      window.localStorage.setItem(ORB_STORAGE_KEY, serializePlacement(next))
    } catch {
      // Storage refused (private mode): the orb still stays, it just forgets.
    }
  }

  const mute = muteIcon(props.micAvailable && props.micMuted, props.speechMuted)

  return createPortal(
    <div
      className={`live-orb ${orbClasses(state, mute)}${
        (drag !== null ? ' dragging' : '') + (rest.docked ? ' docked' : '')
      }${pinned ? ' pinned' : ''}${props.offer ? ' can-help' : ''}`}
      style={{ left: pos.x, top: pos.y, width: ORB_SIZE, height: ORB_SIZE }}
    >
      <OrbPie {...props} />
      <div
        className="live-orb-body"
        {...(props.offer
          ? {
              role: 'button',
              tabIndex: 0,
              title: props.offer.title,
              'aria-label': props.offer.title,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  props.offer?.onAccept()
                }
              },
            }
          : {})}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => {
          press.current = null
          dragRef.current = null
          setDrag(null)
        }}
      >
        <div className="live-orb-mark">
          <NaruMark state={state} level={level} speechRms={speechRms} decorative offer={!!props.offer} />
        </div>
      </div>
      <OrbBadge show={mute === 'speaker' || mute === 'both'} />
    </div>,
    document.body,
  )
}
