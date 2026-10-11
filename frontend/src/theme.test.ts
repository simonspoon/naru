/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  THEMES,
  THEME_SETTINGS,
  THEME_STORAGE_KEY,
  applyTheme,
  parseSetting,
  resolveTheme,
  storedSetting,
} from './theme'

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
    expect(THEME_SETTINGS).toEqual(['system', 'dark', 'light', 'contrast', 'red'])
    for (const t of THEMES) {
      expect(t.label).not.toBe('')
      expect(t.swatch).toHaveLength(4)
    }
  })

  it('parseSetting keeps known values only', () => {
    expect(parseSetting('light')).toBe('light')
    expect(parseSetting('LIGHT')).toBe('system')
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
