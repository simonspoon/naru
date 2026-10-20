import { boardThemeVars } from './boardTheme'
import type { VarReader } from './boardTheme'
import type { MarkInput } from './markSkin'

/**
 * Custom mark skins (naru task 2122, `docs/mark-skins.md`): the pure half of
 * the iframe host in `NaruMark.tsx`. A custom skin is one HTML document the
 * server renders under the artifact CSP into an `<iframe sandbox=
 * "allow-scripts">`; the host posts it a frame message every rAF tick and the
 * theme on ready and on every theme change, and the frame's bootstrap
 * (`api.rs::MARK_SKIN_BOOTSTRAP`) answers `mark-ready` / `mark-error`.
 */

/** How long a skin has to call `naruMark.onFrame` before the host gives up. */
export const MARK_SKIN_READY_MS = 2000

/** Where a custom skin's host stands; `fallback` draws waveform, for good. */
export type SkinLoadState = 'loading' | 'ready' | 'fallback'

export interface MarkFrameMessage extends MarkInput {
  naru: 'mark-frame'
}

export interface MarkThemeMessage {
  naru: 'mark-theme'
  vars: Record<string, string>
}

/** The per-frame message: exactly what a built-in painter is handed. */
export function frameMessage(input: MarkInput): MarkFrameMessage {
  return {
    naru: 'mark-frame',
    mode: input.mode,
    level: input.level,
    palette: input.palette,
    reduced: input.reduced,
    t: input.t,
    dt: input.dt,
  }
}

/** The theme message: the html board's `--naru-*` vocabulary (`boardTheme.ts`). */
export function themeMessage(read: VarReader): MarkThemeMessage {
  return { naru: 'mark-theme', vars: boardThemeVars(read) }
}

/** What can happen to a loading skin: a message, or the ready timer running out. */
export type SkinEvent = { kind: 'message'; fromFrame: boolean; data: unknown } | { kind: 'timeout' }

/**
 * The host's state after `event`. Only a message from this host's own frame
 * counts (every mark on the page has a frame posting to the same window);
 * `mark-error` at any time, or the timer while still loading, is a fallback,
 * and a fallback is final.
 */
export function nextSkinState(state: SkinLoadState, event: SkinEvent): SkinLoadState {
  if (state === 'fallback') return state
  if (event.kind === 'timeout') return state === 'loading' ? 'fallback' : state
  if (!event.fromFrame) return state
  const naru = (event.data as { naru?: unknown } | null)?.naru
  if (naru === 'mark-error') return 'fallback'
  if (naru === 'mark-ready' && state === 'loading') return 'ready'
  return state
}

/** The longest skin name the server accepts. */
const NAME_MAX = 40

/** A picked file's skin name: its name without the extension, cut to fit. */
export function importName(filename: string): string {
  const stem = filename.replace(/\.[^.]*$/, '').trim()
  const name = [...(stem || 'Custom skin')].slice(0, NAME_MAX).join('').trim()
  return name || 'Custom skin'
}

/** The download name for a skin's file: `<name>.html`, path-unsafe characters dashed. */
export function exportFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').trim()
  return `${safe || 'mark-skin'}.html`
}
