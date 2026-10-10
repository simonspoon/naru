import { describe, expect, it } from 'vitest'
import { isMediaPath, mediaKindForPath, mediaMimeForPath } from './fileMedia'

describe('fileMedia', () => {
  it('classifies video and audio extensions', () => {
    for (const n of ['a.mp4', 'a.mov', 'a.m4v', 'a.webm']) {
      expect(mediaKindForPath(n)).toBe('video')
    }
    for (const n of [
      'a.m4a',
      'a.mp3',
      'a.wav',
      'a.ogg',
      'a.oga',
      'a.aac',
      'a.flac',
    ]) {
      expect(mediaKindForPath(n)).toBe('audio')
    }
  })

  it('maps mime types like the server', () => {
    expect(mediaMimeForPath('x/clip.mov')).toBe('video/quicktime')
    expect(mediaMimeForPath('a.m4a')).toBe('audio/mp4')
    expect(mediaMimeForPath('a.m4v')).toBe('video/mp4')
    expect(mediaMimeForPath('a.oga')).toBe('audio/ogg')
  })

  it('is case-insensitive and judges the last extension only', () => {
    expect(isMediaPath('DIR/Song.MP3')).toBe(true)
    expect(isMediaPath('clip.mp4.html')).toBe(false)
  })

  it('refuses non-media, extensionless and dotfile names', () => {
    for (const n of ['a.png', 'a.mkv', 'noext', '.mp4', 'dir.mp4/file', 'a.txt']) {
      expect(isMediaPath(n)).toBe(false)
      expect(mediaKindForPath(n)).toBeNull()
    }
  })
})
