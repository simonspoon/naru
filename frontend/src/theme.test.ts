/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  THEMES,
  THEME_SETTINGS,
  THEME_STORAGE_KEY,
  applyTheme,
  customThemeCss,
  THEME_CSS_STORAGE_KEY,
  migrateLegacyTheme,
  normalizeHex,
  warningText,
  parseSetting,
  resolveTheme,
  storedSetting,
} from './theme'
import type { Theme } from './types/Theme'

describe('resolveTheme', () => {
  it('maps system to the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('returns a named theme regardless of the OS preference', () => {
    for (const t of THEMES) {
      expect(resolveTheme(t.id, true)).toBe(t.id)
      expect(resolveTheme(t.id, false)).toBe(t.id)
    }
  })

  it('treats unknown, null and non-strings as system', () => {
    expect(resolveTheme('neon', true)).toBe('dark')
    expect(resolveTheme(null, false)).toBe('light')
    expect(resolveTheme(42, false)).toBe('light')
  })
})

describe('theme list', () => {
  it('offers system plus every theme, ids unique, with four swatches', () => {
    expect(THEME_SETTINGS[0]).toBe('system')
    expect(new Set(THEME_SETTINGS).size).toBe(THEME_SETTINGS.length)
    expect(THEME_SETTINGS).toEqual(['system', 'dark', 'light', 'contrast', 'crimson'])
    for (const t of THEMES) {
      expect(t.label).not.toBe('')
      expect(t.swatch).toHaveLength(4)
    }
  })

  it('parseSetting keeps known values only', () => {
    expect(parseSetting('light')).toBe('light')
    expect(parseSetting('LIGHT')).toBe('system')
  })

  it('maps the legacy red id to crimson', () => {
    expect(migrateLegacyTheme('red')).toBe('crimson')
    expect(migrateLegacyTheme('dark')).toBe('dark')
    expect(parseSetting('red')).toBe('crimson')
    expect(resolveTheme('red', false)).toBe('crimson')
  })
})

describe('applyTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.theme
    localStorage.clear()
  })

  function stubMedia(dark: boolean) {
    const listeners: (() => void)[] = []
    const mq = {
      matches: dark,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => {
        listeners.splice(listeners.indexOf(fn), 1)
      },
    }
    vi.stubGlobal('matchMedia', () => mq)
    return {
      flip(next: boolean) {
        mq.matches = next
        for (const fn of [...listeners]) fn()
      },
      listeners,
    }
  }

  it('sets data-theme and mirrors the setting', () => {
    stubMedia(true)
    expect(applyTheme('light')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(storedSetting()).toBe('light')
  })

  it('follows prefers-color-scheme live only while the setting is system', () => {
    const media = stubMedia(true)
    applyTheme('system')
    expect(document.documentElement.dataset.theme).toBe('dark')
    media.flip(false)
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('contrast')
    expect(media.listeners).toHaveLength(0)
    media.flip(true)
    expect(document.documentElement.dataset.theme).toBe('contrast')
  })

  it('storedSetting falls back to system', () => {
    expect(storedSetting()).toBe('system')
    localStorage.setItem(THEME_STORAGE_KEY, 'bogus')
    expect(storedSetting()).toBe('system')
  })
})

describe('themes.css', () => {
  it('has exactly one [data-theme] block per theme id', () => {
    // vitest runs from frontend/
    const css = readFileSync('src/themes.css', 'utf8')
    const blocks = [...css.matchAll(/\[data-theme='([\w-]+)'\]/g)].map((m) => m[1])
    expect([...blocks].sort()).toEqual(THEMES.map((t) => t.id).sort())
  })
})

function customTheme(vars: Record<string, string>, id = 'custom-3'): Theme {
  return {
    id,
    name: 'T',
    builtin: false,
    scheme: 'dark',
    slots: {} as Theme['slots'],
    vars,
    warnings: [],
    created_at: null,
    updated_at: null,
  }
}

describe('custom themes', () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.themeRev
    document.getElementById('naru-custom-theme')?.remove()
    localStorage.clear()
  })

  it('parseSetting keeps custom-N only', () => {
    expect(parseSetting('custom-3')).toBe('custom-3')
    expect(parseSetting('custom-x')).toBe('system')
    expect(parseSetting('custom-')).toBe('system')
  })

  it('customThemeCss emits good vars and drops unsafe ones', () => {
    const css = customThemeCss(
      customTheme({
        '--bg-rgb': '15, 6, 8',
        'color-scheme': 'dark',
        '--evil': 'red; } body { x: y',
        '--evil2': 'a}',
        background: 'red',
      }),
    )
    expect(css).toContain(":root[data-theme='custom-3'] {")
    expect(css).toContain('--bg-rgb: 15, 6, 8;')
    expect(css).toContain('color-scheme: dark;')
    expect(css).not.toContain('evil')
    expect(css).not.toContain('background')
  })

  it('customThemeCss refuses a non-custom id', () => {
    expect(customThemeCss(customTheme({ '--a': '1' }, "x'] {}"))).toBe('')
  })

  it('a custom setting with no theme falls back to system', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    expect(applyTheme('custom-3', null)).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
    vi.unstubAllGlobals()
  })

  it('injects one style, bumps the rev on change, and mirrors the css', () => {
    expect(applyTheme('custom-3', customTheme({ '--cyan-rgb': '1, 2, 3' }))).toBe('custom-3')
    expect(document.documentElement.dataset.theme).toBe('custom-3')
    expect(document.querySelectorAll('#naru-custom-theme')).toHaveLength(1)
    expect(document.documentElement.dataset.themeRev).toBe('1')
    applyTheme('custom-3', customTheme({ '--cyan-rgb': '1, 2, 3' }))
    expect(document.documentElement.dataset.themeRev).toBe('1')
    applyTheme('custom-3', customTheme({ '--cyan-rgb': '4, 5, 6' }))
    expect(document.documentElement.dataset.themeRev).toBe('2')
    expect(document.querySelectorAll('#naru-custom-theme')).toHaveLength(1)
    expect(localStorage.getItem(THEME_CSS_STORAGE_KEY)).toContain('4, 5, 6')
  })

  it('first paint reuses the mirrored css', () => {
    applyTheme('custom-3', customTheme({ '--cyan-rgb': '1, 2, 3' }))
    document.getElementById('naru-custom-theme')?.remove()
    expect(applyTheme('custom-3')).toBe('custom-3')
    expect(document.getElementById('naru-custom-theme')?.textContent).toContain('1, 2, 3')
  })
})

describe('editor helpers', () => {
  it('normalizeHex accepts full and short hex, rejects the rest', () => {
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc')
    expect(normalizeHex('abc')).toBe('#aabbcc')
    expect(normalizeHex(' #0f0 ')).toBe('#00ff00')
    expect(normalizeHex('#12')).toBeNull()
    expect(normalizeHex('#12345g')).toBeNull()
    expect(normalizeHex('')).toBeNull()
  })

  it('warningText reads as a sentence', () => {
    expect(warningText({ pair: 'text/panel', ratio: 3.94, min: 4.5 })).toBe(
      'Text on panel 3.9:1 — below 4.5:1',
    )
    expect(warningText({ pair: 'muted/bg', ratio: 2, min: 4.5 })).toBe('Muted text on background 2.0:1 — below 4.5:1')
  })
})
