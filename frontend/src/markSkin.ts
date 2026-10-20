import type { MarkMode } from './liveMark'

/**
 * Mark skins (naru task 2120): the live mark is a host (`NaruMark.tsx`, which
 * owns the one rAF loop, the level reading and the aria) around a pluggable
 * skin that draws the picture. This module is the pure half — the contract,
 * the known ids with their fallback, and the one current-skin value every mark
 * reads; the skin implementations live in `components/markSkins/`.
 */

/** A palette as `liveMark.ts::paletteFor` answers it: per-bar colours + glow. */
export interface MarkPalette {
  bars: string[]
  glow: string
}

/** What a skin is handed every frame. */
export interface MarkInput {
  /** The mark mode (`liveMark.ts::markMode`). */
  mode: MarkMode
  /** The live level 0..1 of this mode's side of the conversation, smoothed. */
  level: number
  /** The state palette for `mode` (`paletteFor`, theme-independent on purpose). */
  palette: MarkPalette
  /** `prefers-reduced-motion`, read live: half speed, never frozen. */
  reduced: boolean
  /** Seconds since the loop started. */
  t: number
  /** Seconds since the last frame, capped at 0.05. */
  dt: number
}

/** A mounted skin: painted straight into attributes, never through React. */
export interface MarkPainter {
  paint(input: MarkInput): void
}

/**
 * A skin. `markup` is the static SVG content drawn inside the host's
 * `<svg class="naru-mark" viewBox="0 0 64 64">` (rendered once per skin);
 * `mount` is called after it is in the DOM with the idle palette the mark
 * rests in, and answers the painter the host's rAF loop calls every frame.
 */
export interface MarkSkin<Markup = unknown> {
  id: string
  markup(): Markup
  mount(svg: SVGSVGElement, idle: MarkPalette): MarkPainter
}

/** Every built-in skin id — keep in step with `config::MARK_SKINS`. */
export const MARK_SKIN_IDS = ['waveform', 'face', 'blob'] as const
export const DEFAULT_MARK_SKIN = 'waveform'

/** Each built-in skin's name in the Settings picker (naru task 2121). */
export const MARK_SKIN_LABELS: Record<(typeof MARK_SKIN_IDS)[number], string> = {
  waveform: 'Waveform',
  face: 'Face',
  blob: 'Blob',
}

/** The skin id to draw for a saved setting: an unknown or absent id is the default. */
export function markSkinId(setting: string | null | undefined): string {
  const id = setting?.trim() ?? ''
  return (MARK_SKIN_IDS as readonly string[]).includes(id) ? id : DEFAULT_MARK_SKIN
}

// The current skin: one value for every mark on the page, set from the saved
// appearance (`main.tsx`); the default until that answers.
let current = DEFAULT_MARK_SKIN
const listeners = new Set<() => void>()

/** Sets the current skin from a saved setting; notifies only on a change. */
export function setMarkSkin(setting: string | null | undefined): void {
  const id = markSkinId(setting)
  if (id === current) return
  current = id
  listeners.forEach((l) => l())
}

export function currentMarkSkin(): string {
  return current
}

/** `useSyncExternalStore`'s subscribe: answers the unsubscribe. */
export function subscribeMarkSkin(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
