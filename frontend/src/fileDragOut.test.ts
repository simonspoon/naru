import { describe, expect, it } from 'vitest'
import { dragOutFileName, dragOutPayload, setDragOutData } from './fileDragOut'

describe('dragOutPayload', () => {
  it('builds an absolute URL and a mime:name:url triple', () => {
    const p = dragOutPayload('http://127.0.0.1:7771', 2, 'src/main.rs')
    expect(p.uriList).toBe('http://127.0.0.1:7771/api/projects/2/files/download?path=src%2Fmain.rs')
    expect(p.downloadUrl).toBe(`application/octet-stream:main.rs:${p.uriList}`)
    expect(p.text).toBe('src/main.rs')
  })
  it('picks image and media mimes', () => {
    expect(dragOutPayload('http://h', 1, 'a/b.png').downloadUrl.startsWith('image/png:b.png:')).toBe(true)
    expect(dragOutPayload('http://h', 1, 'a.mp4').downloadUrl.startsWith('video/mp4:a.mp4:')).toBe(true)
  })
  it('keeps the name field colon-free for awkward names', () => {
    const p = dragOutPayload('http://h', 1, 'd/a:b c.txt')
    const [mime, name, ...rest] = p.downloadUrl.split(':')
    expect(mime).toBe('application/octet-stream')
    expect(name).toBe('a_b c.txt')
    expect(rest.join(':')).toBe(p.uriList)
  })
  it('handles leading dot and unicode', () => {
    expect(dragOutFileName('.gitignore')).toBe('.gitignore')
    expect(dragOutFileName('x/日本語 ü.md')).toBe('日本語 ü.md')
    expect(dragOutFileName('x/')).toBe('file')
  })
  it('encodes the path in the URL', () => {
    expect(dragOutPayload('http://h', 1, 'a b/#?.txt').uriList).toContain('path=a%20b%2F%23%3F.txt')
  })
})

describe('setDragOutData', () => {
  it('sets copyMove and all three formats', () => {
    const got: Record<string, string> = {}
    const dt = { effectAllowed: '', setData: (f: string, d: string) => void (got[f] = d) }
    setDragOutData(dt, 'http://h', 3, 'a.txt')
    expect(dt.effectAllowed).toBe('copyMove')
    expect(Object.keys(got).sort()).toEqual(['DownloadURL', 'text/plain', 'text/uri-list'])
    expect(got['text/plain']).toBe('a.txt')
  })
})
