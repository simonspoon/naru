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

function MicGlyph() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
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
export function LiveOrb({
  state,
  level,
  speechRms,
  micAvailable,
  micMuted,
  speechMuted,
  paused,
  pauseLabel,
  pauseDisabled,
  canPause,
  onToggleMic,
  onTogglePause,
  onToggleSpeech,
}: {
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
}) {
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
      setPinned((v) => !v)
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

  const mute = muteIcon(micAvailable && micMuted, speechMuted)
  const bright = orbBrightness(state) === 'bright'
  const mode = markMode(state)
  const hasPie = micAvailable || canPause

  return createPortal(
    <div
      className={`live-orb ${bright ? 'bright' : 'dim'} mode-${mode}${mute !== null ? ' muted' : ''}${
        (drag !== null ? ' dragging' : '') + (rest.docked ? ' docked' : '')
      }${pinned ? ' pinned' : ''}`}
      style={{ left: pos.x, top: pos.y, width: ORB_SIZE, height: ORB_SIZE }}
    >
      {hasPie && (
        <svg className="live-orb-pie" viewBox={`0 0 ${PIE} ${PIE}`} width={PIE} height={PIE}>
          {micAvailable && (
            <Segment
              d={sector(140, 220)}
              at={mid(180)}
              label={micMuted ? 'Listen through this browser' : 'Stop listening'}
              active={!micMuted}
              off={micMuted}
              onPress={onToggleMic}
            >
              <MicGlyph />
            </Segment>
          )}
          {canPause && (
            <Segment
              d={sector(-40, 40)}
              at={mid(0)}
              label={pauseLabel}
              active={paused}
              off={paused}
              disabled={pauseDisabled}
              onPress={onTogglePause}
            >
              <PauseGlyph paused={paused} />
            </Segment>
          )}
          {canPause && (
            <Segment
              d={sector(50, 130)}
              at={mid(90)}
              label={speechMuted ? 'Unmute spoken replies' : 'Mute spoken replies'}
              active={speechMuted}
              off={speechMuted}
              onPress={onToggleSpeech}
            >
              <SpeakerGlyph muted={speechMuted} />
            </Segment>
          )}
        </svg>
      )}
      <div
        className="live-orb-body"
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
          <NaruMark state={state} level={level} speechRms={speechRms} decorative />
        </div>
      </div>
      {mute !== null && (
        <span className="live-orb-badge" aria-hidden="true">
          {(mute === 'mic' || mute === 'both') && (
            <svg viewBox="0 0 24 24" width="14" height="14">
              <MicGlyph />
            </svg>
          )}
          {(mute === 'speaker' || mute === 'both') && (
            <svg viewBox="0 0 24 24" width="14" height="14">
              <SpeakerGlyph muted />
            </svg>
          )}
        </span>
      )}
    </div>,
    document.body,
  )
}
