import { describe, expect, it } from 'vitest'
import {
  FOLDERS_UNSUPPORTED,
  MAX_UPLOAD_BYTES,
  SKIPPED,
  dropHint,
  isOsFileDrag,
  progressLabel,
  splitDropped,
  stripDataUrl,
  summarizeUploads,
  uploadSizeProblem,
  uploadTargetDir,
} from './fileUpload'

describe('uploadTargetDir', () => {
  it('is the folder itself for a folder row', () => {
    expect(uploadTargetDir({ path: 'src/core', isDir: true })).toBe('src/core')
  })
  it('is the containing folder for a file row', () => {
    expect(uploadTargetDir({ path: 'src/core/a.rs', isDir: false })).toBe('src/core')
    expect(uploadTargetDir({ path: 'a.rs', isDir: false })).toBe('')
  })
  it('is the project root where there is no row', () => {
    expect(uploadTargetDir(null)).toBe('')
  })
})

describe('isOsFileDrag', () => {
  it('accepts a Files drag with no tab drag in flight', () => {
    expect(isOsFileDrag(['Files'], false)).toBe(true)
    expect(isOsFileDrag(['text/plain', 'Files'], false)).toBe(true)
  })
  it('rejects a tab drag, even one that claims Files', () => {
    expect(isOsFileDrag(['text/plain'], true)).toBe(false)
    expect(isOsFileDrag(['Files'], true)).toBe(false)
  })
  it('rejects a drag without Files, and a missing list', () => {
    expect(isOsFileDrag(['text/plain'], false)).toBe(false)
    expect(isOsFileDrag([], false)).toBe(false)
    expect(isOsFileDrag(null, false)).toBe(false)
  })
})

describe('uploadSizeProblem', () => {
  it('allows zero bytes and exactly the cap', () => {
    expect(uploadSizeProblem(0)).toBeNull()
    expect(uploadSizeProblem(MAX_UPLOAD_BYTES)).toBeNull()
  })
  it('rejects one byte over, naming the limit', () => {
    expect(uploadSizeProblem(MAX_UPLOAD_BYTES + 1)).toContain('25 MB')
  })
})

describe('splitDropped', () => {
  it('drops folders and counts them', () => {
    expect(splitDropped(['a', 'dir', 'b'], [false, true, false])).toEqual({
      files: ['a', 'b'],
      folders: 1,
    })
  })
  it('treats everything as a file where the entry API is missing', () => {
    expect(splitDropped(['a', 'b'], [])).toEqual({ files: ['a', 'b'], folders: 0 })
    expect(splitDropped(['a'], [undefined])).toEqual({ files: ['a'], folders: 0 })
  })
})

describe('stripDataUrl', () => {
  it('cuts through the first comma', () => {
    expect(stripDataUrl('data:text/plain;base64,aGk=')).toBe('aGk=')
  })
  it('leaves an empty file as the empty string', () => {
    expect(stripDataUrl('data:application/octet-stream;base64,')).toBe('')
  })
})

describe('labels', () => {
  it('says which file of how many', () => {
    expect(progressLabel('a.txt', 2, 5)).toBe('Uploading a.txt (2 of 5)…')
    expect(progressLabel('a.txt', 1, 1)).toBe('Uploading a.txt…')
  })
  it('names the destination', () => {
    expect(dropHint('')).toContain('project root')
    expect(dropHint('src')).toContain('src')
  })
})

describe('summarizeUploads', () => {
  it('counts uploads and names each failure', () => {
    const s = summarizeUploads(
      [
        { name: 'a', outcome: 'uploaded' },
        { name: 'b', outcome: 'failed', message: 'boom' },
        { name: 'c', outcome: 'skipped', message: SKIPPED },
      ],
      0,
    )
    expect(s.ok).toBe('Uploaded 1 file.')
    expect(s.problems).toEqual(['b: boom', `c: ${SKIPPED}`])
  })
  it('adds the folder refusal and has no ok line when nothing went up', () => {
    expect(summarizeUploads([], 2)).toEqual({
      ok: null,
      problems: [FOLDERS_UNSUPPORTED],
    })
  })
  it('pluralises', () => {
    expect(
      summarizeUploads(
        [
          { name: 'a', outcome: 'uploaded' },
          { name: 'b', outcome: 'uploaded' },
        ],
        0,
      ).ok,
    ).toBe('Uploaded 2 files.')
  })
})
