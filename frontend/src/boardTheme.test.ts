import { describe, expect, it } from 'vitest'
import { boardScheme, boardThemeMessage, boardThemeVars } from './boardTheme'

const dark: Record<string, string> = {
  '--bg-rgb': '6, 10, 16',
  '--text-rgb': '184, 221, 232',
  '--muted-rgb': '93, 127, 143',
  '--edge-rgb': '42, 106, 138',
  '--cyan-rgb': '0, 229, 255',
  '--violet-rgb': '176, 107, 255',
  '--green-rgb': '43, 255, 156',
  '--amber-rgb': '255, 180, 68',
  '--red-rgb': '255, 59, 92',
  '--panel': '#0b1119',
  '--panel-raised': '#0e1722',
  'color-scheme': 'dark',
}
const reader = (m: Record<string, string>) => (n: string) => m[n] ?? ''

describe('boardThemeVars', () => {
  it('maps the computed theme variables onto the --naru-* vocabulary', () => {
    expect(boardThemeVars(reader(dark))).toEqual({
      '--naru-bg': 'rgb(6, 10, 16)',
      '--naru-fg': 'rgb(184, 221, 232)',
      '--naru-muted': 'rgb(93, 127, 143)',
      '--naru-surface': '#0b1119',
      '--naru-raised': '#0e1722',
      '--naru-ring': 'rgba(42, 106, 138, 0.35)',
      '--naru-accent': 'rgb(0, 229, 255)',
      '--naru-accent-2': 'rgb(176, 107, 255)',
      '--naru-good': 'rgb(43, 255, 156)',
      '--naru-warn': 'rgb(255, 180, 68)',
      '--naru-bad': 'rgb(255, 59, 92)',
      '--naru-color-scheme': 'dark',
    })
  })

  it('omits what the theme leaves unset', () => {
    const vars = boardThemeVars(reader({ '--text-rgb': '1, 2, 3' }))
    expect(vars['--naru-fg']).toBe('rgb(1, 2, 3)')
    expect(vars).not.toHaveProperty('--naru-bg')
    expect(vars).not.toHaveProperty('--naru-ring')
  })
})

describe('boardScheme', () => {
  it('is light only for a light-only color-scheme', () => {
    expect(boardScheme(reader({ 'color-scheme': 'light' }))).toBe('light')
    expect(boardScheme(reader({ 'color-scheme': 'light dark' }))).toBe('dark')
    expect(boardScheme(reader({ 'color-scheme': 'dark' }))).toBe('dark')
    expect(boardScheme(reader({}))).toBe('dark')
  })
})

describe('boardThemeMessage', () => {
  it('tags the vars for the board frame', () => {
    const m = boardThemeMessage(reader(dark))
    expect(m.naru).toBe('board-theme')
    expect(m.vars['--naru-bg']).toBe('rgb(6, 10, 16)')
  })
})
