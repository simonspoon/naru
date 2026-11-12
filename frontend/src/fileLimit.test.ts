import { describe, expect, it } from 'vitest'
import { PREVIEW_MAX_CHARS, limitLabel, previewsAt, tooLargeNotice } from './fileLimit'

describe('limitLabel', () => {
  it('names whole and fractional megabytes', () => {
    expect(limitLabel(8 * 1024 * 1024)).toBe('8 MB')
    expect(limitLabel(2.5 * 1024 * 1024)).toBe('2.5 MB')
    expect(limitLabel(1024 * 1024)).toBe('1 MB')
  })

  it('falls back to kilobytes under one megabyte', () => {
    expect(limitLabel(256 * 1024)).toBe('256 KB')
  })
})

describe('previewsAt', () => {
  it('renders markdown up to the threshold and not past it', () => {
    expect(previewsAt(0)).toBe(true)
    expect(previewsAt(PREVIEW_MAX_CHARS)).toBe(true)
    expect(previewsAt(PREVIEW_MAX_CHARS + 1)).toBe(false)
  })
})

describe('tooLargeNotice', () => {
  it('says why the file is read-only and names the limit', () => {
    const notice = tooLargeNotice(4 * 1024 * 1024)
    expect(notice).toContain('Too large to edit here (4 MB limit)')
    expect(notice).toContain('read-only')
    expect(notice).toContain('Download')
  })
})
