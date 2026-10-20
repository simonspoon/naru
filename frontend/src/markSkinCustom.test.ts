import { describe, expect, it } from 'vitest'
import { exportFilename, frameMessage, importName, nextSkinState, themeMessage } from './markSkinCustom'
import type { SkinLoadState } from './markSkinCustom'

describe('nextSkinState', () => {
  const msg = (naru: string, fromFrame = true) => ({ kind: 'message' as const, fromFrame, data: { naru } })

  it('goes ready on its own frame announcing itself', () => {
    expect(nextSkinState('loading', msg('mark-ready'))).toBe('ready')
  })

  it('ignores a message from another frame', () => {
    expect(nextSkinState('loading', msg('mark-ready', false))).toBe('loading')
    expect(nextSkinState('ready', msg('mark-error', false))).toBe('ready')
  })

  it('falls back on an error, loading or ready', () => {
    expect(nextSkinState('loading', msg('mark-error'))).toBe('fallback')
    expect(nextSkinState('ready', msg('mark-error'))).toBe('fallback')
  })

  it('falls back when the timer runs out while loading, never once ready', () => {
    expect(nextSkinState('loading', { kind: 'timeout' })).toBe('fallback')
    expect(nextSkinState('ready', { kind: 'timeout' })).toBe('ready')
  })

  it('keeps a fallback final and ignores junk', () => {
    expect(nextSkinState('fallback', msg('mark-ready'))).toBe('fallback')
    for (const data of [null, 'mark-ready', 7, {}, { naru: 'board-ready' }]) {
      const s: SkinLoadState = 'loading'
      expect(nextSkinState(s, { kind: 'message', fromFrame: true, data })).toBe('loading')
    }
  })
})

describe('messages', () => {
  it('frame message carries exactly the painter input', () => {
    const input = {
      mode: 'hear' as const,
      level: 0.4,
      palette: { bars: ['#000'], glow: '#fff' },
      reduced: false,
      t: 1.5,
      dt: 0.016,
    }
    expect(frameMessage(input)).toEqual({ naru: 'mark-frame', ...input })
  })

  it('theme message is the --naru-* map', () => {
    const vars: Record<string, string> = { '--bg-rgb': '1, 2, 3', 'color-scheme': 'dark' }
    const m = themeMessage((n) => vars[n] ?? '')
    expect(m.naru).toBe('mark-theme')
    expect(m.vars['--naru-bg']).toBe('rgb(1, 2, 3)')
    expect(m.vars['--naru-color-scheme']).toBe('dark')
    expect(Object.keys(m.vars).every((k) => k.startsWith('--naru-'))).toBe(true)
  })
})

describe('file names', () => {
  it('imports a file under its stem', () => {
    expect(importName('pulse.html')).toBe('pulse')
    expect(importName('  my skin.v2.html ')).toBe('my skin.v2')
    expect(importName('noext')).toBe('noext')
    expect(importName('.html')).toBe('Custom skin')
    expect(importName(`${'x'.repeat(60)}.html`)).toHaveLength(40)
  })

  it('exports under a safe <name>.html', () => {
    expect(exportFilename('Pulse')).toBe('Pulse.html')
    expect(exportFilename('a/b:c')).toBe('a-b-c.html')
    expect(exportFilename('  ')).toBe('mark-skin.html')
  })
})
