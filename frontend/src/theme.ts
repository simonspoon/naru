// Colour themes (naru task 1784). Pure apart from `applyTheme` and
// `watchSystemTheme`, which touch the document / matchMedia they are handed.
// The palettes themselves are CSS (`themes.css`, one `:root[data-theme]`
// block per id here); this module is the list the picker draws, the rule that
// turns a saved setting into one concrete theme, and the DOM glue.
// The ids must match `config::APPEARANCE_THEMES` in Rust, which validates the
// saved setting.

export type ThemeId = 'dark' | 'light' | 'contrast' | 'crimson'
export type ThemeSetting = 'system' | ThemeId

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
  return typeof v === 'string' && (THEME_SETTINGS as readonly string[]).includes(v)
    ? (v as ThemeSetting)
    : 'system'
}

/** The concrete theme a setting means right now. */
export function resolveTheme(setting: unknown, prefersDark: boolean): ThemeId {
  const s = parseSetting(setting)
  if (s === 'system') return prefersDark ? 'dark' : 'light'
  return s
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

function prefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DARK_QUERY).matches
}

let stopWatching: (() => void) | null = null

/** Applies a setting: sets `data-theme` on <html>, mirrors the setting into
 *  localStorage, and (re)installs the prefers-color-scheme listener while the
 *  setting is `system`. Returns the theme applied. */
export function applyTheme(setting: unknown): ThemeId {
  const s = parseSetting(setting)
  stopWatching?.()
  stopWatching = null
  const apply = () => {
    const id = resolveTheme(s, prefersDark())
    document.documentElement.dataset.theme = id
    return id
  }
  const id = apply()
  try {
    localStorage.setItem(THEME_STORAGE_KEY, s)
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

/** Calls `fn` whenever <html>'s `data-theme` changes; returns the disposer. */
export function onThemeChange(fn: () => void): () => void {
  const mo = new MutationObserver(fn)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => mo.disconnect()
}
