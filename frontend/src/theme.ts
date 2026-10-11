// Colour themes (naru task 1784). Pure apart from `applyTheme` and
// `watchSystemTheme`, which touch the document / matchMedia they are handed.
// The palettes themselves are CSS (`themes.css`, one `:root[data-theme]`
// block per id here); this module is the list the picker draws, the rule that
// turns a saved setting into one concrete theme, and the DOM glue.
// The ids must match `config::APPEARANCE_THEMES` in Rust, which validates the
// saved setting.

import type { Theme } from './types/Theme'
import type { ThemeSlots } from './types/ThemeSlots'
import type { ContrastWarning } from './types/ContrastWarning'

export type ThemeId = 'dark' | 'light' | 'contrast' | 'crimson'
export type CustomThemeId = `custom-${number}`
export type ThemeSetting = 'system' | ThemeId | CustomThemeId

export interface ThemeInfo {
  id: ThemeId
  label: string
  /** Picker swatch colours: background, panel, text, accent. */
  swatch: readonly [string, string, string, string]
}

export const THEMES: readonly ThemeInfo[] = [
  { id: 'dark', label: 'Dark', swatch: ['#060a10', '#0b1119', '#b8dde8', '#00e5ff'] },
  { id: 'light', label: 'Light', swatch: ['#f4f7fa', '#ffffff', '#162634', '#00668a'] },
  { id: 'contrast', label: 'High contrast', swatch: ['#000000', '#101820', '#ffffff', '#40f0ff'] },
  { id: 'crimson', label: 'Crimson', swatch: ['#0f0608', '#190c0f', '#f2d6d8', '#ff5466'] },
]

export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', ...THEMES.map((t) => t.id)]

const CUSTOM_ID = /^custom-\d+$/

export function isCustomId(value: unknown): value is CustomThemeId {
  return typeof value === 'string' && CUSTOM_ID.test(value)
}

/** localStorage key mirroring the last-applied *setting*, read before first
 *  render so a reload does not flash the wrong theme. */
export const THEME_STORAGE_KEY = 'naru-theme'

/** The pre-rename id `red` is the theme now called `crimson`; every parsed
 *  stored or configured value goes through this first. */
export function migrateLegacyTheme(value: unknown): unknown {
  return value === 'red' ? 'crimson' : value
}

/** A stored or configured value as a setting; anything unknown is `system`. */
export function parseSetting(value: unknown): ThemeSetting {
  const v = migrateLegacyTheme(value)
  if (isCustomId(v)) return v
  return typeof v === 'string' && (THEME_SETTINGS as readonly string[]).includes(v)
    ? (v as ThemeSetting)
    : 'system'
}

/** The concrete theme a setting means right now (a built-in or custom id). */
export function resolveTheme(setting: unknown, prefersDark: boolean): ThemeId | CustomThemeId {
  const s = parseSetting(setting)
  if (s === 'system') return prefersDark ? 'dark' : 'light'
  return s
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

function prefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DARK_QUERY).matches
}

let stopWatching: (() => void) | null = null

/** localStorage key mirroring the active custom theme's css text, so a reload
 *  paints it before the config fetch answers. */
export const THEME_CSS_STORAGE_KEY = 'naru-theme-css'
const STYLE_ID = 'naru-custom-theme'

const VAR_KEY = /^(--[a-z0-9-]+|color-scheme)$/
const VAR_VALUE = /^[#a-z0-9(),.%\s-]+$/i

/** The rule that makes a custom theme's server-derived `vars` live under
 *  `:root[data-theme='custom-N']`. The frontend never derives colours. Keys and
 *  values outside a strict charset are dropped and the id must be a custom id,
 *  so no data can break out of the rule. */
export function customThemeCss(theme: Theme): string {
  if (!isCustomId(theme.id)) return ''
  const lines: string[] = []
  for (const [k, v] of Object.entries(theme.vars ?? {})) {
    if (typeof v !== 'string' || !VAR_KEY.test(k) || !VAR_VALUE.test(v)) continue
    lines.push(`  ${k}: ${v.trim()};`)
  }
  return `:root[data-theme='${theme.id}'] {\n${lines.join('\n')}\n}`
}

/** Installs (or removes, for empty text) the single custom <style>, bumping
 *  `data-theme-rev` on <html> when the text changed so observers repaint. */
function installCss(css: string) {
  let el = document.getElementById(STYLE_ID)
  const before = el?.textContent ?? ''
  if (before === css) return
  if (css === '') {
    el?.remove()
  } else {
    if (!el) {
      el = document.createElement('style')
      el.id = STYLE_ID
      document.head.appendChild(el)
    }
    el.textContent = css
  }
  const root = document.documentElement
  root.dataset.themeRev = String((Number(root.dataset.themeRev) || 0) + 1)
}

function storedCss(setting: string): string {
  try {
    const css = localStorage.getItem(THEME_CSS_STORAGE_KEY) ?? ''
    return css.startsWith(`:root[data-theme='${setting}']`) ? css : ''
  } catch {
    return ''
  }
}

/** Applies a setting: sets `data-theme` on <html>, mirrors the setting into
 *  localStorage, and (re)installs the prefers-color-scheme listener while the
 *  setting is `system`. A custom setting needs its `custom` theme: `undefined`
 *  reuses the css mirrored in localStorage (first paint), `null` or a theme of
 *  another id means it is gone and falls back to `system`. Returns the theme
 *  applied. */
export function applyTheme(setting: unknown, custom?: Theme | null): ThemeId | CustomThemeId {
  let s = parseSetting(setting)
  let css = ''
  if (isCustomId(s)) {
    css = custom === undefined ? storedCss(s) : custom && custom.id === s ? customThemeCss(custom) : ''
    if (css === '') s = 'system'
  }
  stopWatching?.()
  stopWatching = null
  installCss(css)
  const apply = () => {
    const id = resolveTheme(s, prefersDark())
    document.documentElement.dataset.theme = id
    return id
  }
  const id = apply()
  try {
    localStorage.setItem(THEME_STORAGE_KEY, s)
    if (css) localStorage.setItem(THEME_CSS_STORAGE_KEY, css)
    else localStorage.removeItem(THEME_CSS_STORAGE_KEY)
  } catch {
    // storage blocked: the config GET still reconciles on load
  }
  if (s === 'system' && typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia(DARK_QUERY)
    const onChange = () => {
      apply()
    }
    mq.addEventListener('change', onChange)
    stopWatching = () => mq.removeEventListener('change', onChange)
  }
  return id
}

/** The setting mirrored in localStorage, `system` when absent or unreadable. */
export function storedSetting(): ThemeSetting {
  try {
    return parseSetting(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

/** Reads a CSS custom property off <html> at call time, so chrome painted by
 *  script (xterm, canvas export) follows the active theme. */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Calls `fn` whenever <html>'s `data-theme` changes, or `data-theme-rev` does
 *  (the active custom theme's css was edited); returns the disposer. */
export function onThemeChange(fn: () => void): () => void {
  const mo = new MutationObserver(fn)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-rev'] })
  return () => mo.disconnect()
}

/** The editor's nine rows, in display order. */
export const SLOT_ROWS: readonly { key: keyof ThemeSlots; label: string }[] = [
  { key: 'bg', label: 'Background' },
  { key: 'panel', label: 'Panel' },
  { key: 'text', label: 'Text' },
  { key: 'muted', label: 'Muted text' },
  { key: 'accent', label: 'Accent' },
  { key: 'accent2', label: 'Second accent' },
  { key: 'good', label: 'Good' },
  { key: 'warn', label: 'Warning' },
  { key: 'bad', label: 'Bad' },
]

/** A typed colour as the server's `#rrggbb` (lowercase), or null when it is
 *  not a complete hex colour. Accepts `#rgb` / `rgb` shorthand and a missing
 *  `#`. */
export function normalizeHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim())
  if (!m) return null
  const h = m[1].toLowerCase()
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h)
}

const PAIR_NAMES: Record<string, string> = { bg: 'background', panel: 'panel', text: 'text', muted: 'muted text' }

/** One contrast warning as a sentence, e.g. "Text on panel 3.9:1 — below 4.5:1". */
export function warningText(w: ContrastWarning): string {
  const [fg, bg] = w.pair.split('/')
  const name = (k: string) => PAIR_NAMES[k] ?? k
  const head = name(fg)
  return `${head.charAt(0).toUpperCase()}${head.slice(1)} on ${name(bg ?? '')} ${w.ratio.toFixed(1)}:1 — below ${w.min}:1`
}

/** The four swatch colours a picker row draws for a theme. */
export function themeSwatch(t: Theme): [string, string, string, string] {
  return [t.slots.bg, t.slots.panel, t.slots.text, t.slots.accent]
}
