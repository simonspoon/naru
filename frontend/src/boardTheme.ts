// The theme vocabulary an html board sees (naru task 1792). The page reads the
// active theme's computed variables (`theme.ts::cssVar`) and posts the result
// into the board's frame as `{naru: 'board-theme', vars}`; the render route's
// injected script sets each key on the frame's <html>. Pure: the reader is
// handed in, so a theme added in `themes.css` reaches every board and template
// with no edit here. The key set is public (docs/live.md, the --naru-* table).

export type VarReader = (name: string) => string

/** The message the board frame understands. */
export interface BoardThemeMessage {
  naru: 'board-theme'
  vars: Record<string, string>
}

/** `--x-rgb: 6, 10, 16` as `rgb(6, 10, 16)`; empty when the variable is unset. */
function rgb(read: VarReader, name: string): string {
  const v = read(name).trim()
  return v ? `rgb(${v})` : ''
}

/** The scheme the theme paints in: `light` only when the resolved
 *  `color-scheme` says light and nothing dark. */
export function boardScheme(read: VarReader): 'light' | 'dark' {
  const s = read('color-scheme').toLowerCase()
  return s.includes('light') && !s.includes('dark') ? 'light' : 'dark'
}

/** The `--naru-*` map for the active theme; a variable the theme leaves unset
 *  is omitted so the board's own fallback applies. */
export function boardThemeVars(read: VarReader): Record<string, string> {
  const edge = read('--edge-rgb').trim()
  const all: Record<string, string> = {
    '--naru-bg': rgb(read, '--bg-rgb'),
    '--naru-fg': rgb(read, '--text-rgb'),
    '--naru-muted': rgb(read, '--muted-rgb'),
    '--naru-surface': read('--panel').trim(),
    '--naru-raised': read('--panel-raised').trim(),
    '--naru-ring': edge ? `rgba(${edge}, 0.35)` : '',
    '--naru-accent': rgb(read, '--cyan-rgb'),
    '--naru-accent-2': rgb(read, '--violet-rgb'),
    '--naru-good': rgb(read, '--green-rgb'),
    '--naru-warn': rgb(read, '--amber-rgb'),
    '--naru-bad': rgb(read, '--red-rgb'),
    '--naru-color-scheme': boardScheme(read),
  }
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== ''))
}

export function boardThemeMessage(read: VarReader): BoardThemeMessage {
  return { naru: 'board-theme', vars: boardThemeVars(read) }
}
