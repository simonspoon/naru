import { imageMimeForPath } from './fileImage'
import { mediaMimeForPath } from './fileMedia'

/** What a dragged file row or tab carries so Chromium can save it to the
 * desktop (naru task 2733). Pure: the caller hands over the origin, so this is
 * testable without a `window`. */
export interface DragOutPayload {
  /** The Chromium `DownloadURL` triple, `<mime>:<filename>:<absolute url>`. */
  downloadUrl: string
  /** `text/uri-list`: the same absolute URL. */
  uriList: string
  /** `text/plain`: the project-relative path, for a terminal or chat box. */
  text: string
}

/** The middle field of the triple. A colon would end the field early, a
 * slash or control character is not a file name; both become `_`. Never
 * empty. A leading dot is kept: `.gitignore` is a legitimate name. */
export function dragOutFileName(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[:/\\\u0000-\u001f]/g, '_').trim()
  return clean === '' ? 'file' : clean
}

export function dragOutPayload(origin: string, projectId: number, path: string): DragOutPayload {
  const url = `${origin}/api/projects/${projectId}/files/download?path=${encodeURIComponent(path)}`
  const mime = imageMimeForPath(path) ?? mediaMimeForPath(path) ?? 'application/octet-stream'
  return {
    downloadUrl: `${mime}:${dragOutFileName(path)}:${url}`,
    uriList: url,
    text: path,
  }
}

/** The structural slice of `DataTransfer` this writes to. */
interface DragData {
  effectAllowed: string
  setData(format: string, data: string): void
}

/** Sets all three payloads and allows both the internal move and the external
 * copy. Chromium alone acts on `DownloadURL`; elsewhere the drag still carries
 * the path text. */
export function setDragOutData(
  dt: DragData,
  origin: string,
  projectId: number,
  path: string,
): void {
  const p = dragOutPayload(origin, projectId, path)
  dt.effectAllowed = 'copyMove'
  dt.setData('text/plain', p.text)
  dt.setData('text/uri-list', p.uriList)
  dt.setData('DownloadURL', p.downloadUrl)
}
