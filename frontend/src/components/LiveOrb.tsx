import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LiveIndicator } from '../liveIndicator'
import { markMode } from '../liveMark'
import {
  anchorPosition,
  clampPoint,
  isDrag,
  muteIcon,
  ORB_SIZE,
  ORB_STORAGE_KEY,
  orbBrightness,
  parseAnchor,
  serializeAnchor,
  snapAnchor,
  type OrbAnchor,
  type Point,
} from '../liveOrb'
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
  disabled,
  onPress,
  children,
}: {
  d: string
  at: { x: number; y: number }
  label: string
  active: boolean
  disabled?: boolean
  onPress: () => void
  children: React.ReactNode
}) {
  return (
    <g
      className={`live-orb-seg${active ? ' on' : ''}${disabled ? ' disabled' : ''}`}
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

function loadAnchor(): OrbAnchor {
  try {
    return parseAnchor(window.localStorage.getItem(ORB_STORAGE_KEY))
  } catch {
    return parseAnchor(null)
  }
}

/**
 * The floating Naru orb (mesa task 1553): the animated mark as a draggable
 * panel above every page for as long as a conversation is live and joined.
 * The body is the drag handle and snaps to the nearest corner/edge on release
 * (remembered in localStorage); hovering — or tapping, for touch — blooms a
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
  const [anchor, setAnchor] = useState<OrbAnchor>(loadAnchor)
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

  const rest = anchorPosition(anchor, vp.w, vp.h)
  const pos = drag ?? rest

  const onDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      press.current = {
        id: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        grab: { x: e.clientX - rest.x, y: e.clientY - rest.y },
        moved: false,
      }
    },
    [rest.x, rest.y],
  )
  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = press.current
    if (p === null || p.id !== e.pointerId) return
    const at = { x: e.clientX, y: e.clientY }
    if (!p.moved && !isDrag(p.start, at)) return
    p.moved = true
    const next = clampPoint({ x: at.x - p.grab.x, y: at.y - p.grab.y }, vp.w, vp.h)
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
    const next = snapAnchor(to, vp.w, vp.h)
    setAnchor(next)
    try {
      window.localStorage.setItem(ORB_STORAGE_KEY, serializeAnchor(next))
    } catch {
      // Storage refused (private mode): the orb still snaps, it just forgets.
    }
  }

  const mute = muteIcon(micAvailable && micMuted, speechMuted)
  const bright = orbBrightness(state) === 'bright'
  const mode = markMode(state)
  const hasPie = micAvailable || canPause

  return createPortal(
    <div
      className={`live-orb ${bright ? 'bright' : 'dim'} mode-${mode}${mute !== null ? ' muted' : ''}${
        drag !== null ? ' dragging' : ` row-${anchor.row}`
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
        {mute !== null && (
          <svg className="live-orb-slash" viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="47" />
            <path d="M17 17L83 83" />
          </svg>
        )}
      </div>
      {mute !== null && (
        <span className="live-orb-badge" aria-hidden="true">
          {(mute === 'mic' || mute === 'both') && (
            <svg viewBox="0 0 24 24" width="14" height="14">
              <MicGlyph />
              <path d="M3 3l18 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
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
