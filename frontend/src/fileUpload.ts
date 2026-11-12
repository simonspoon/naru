/**
 * Dropping files into the Files tab (naru task 2732): the decisions the upload
 * makes before and after it touches the network — where does this drop land,
 * is this drag even an upload, may this file go, and what does the person read
 * when it is over.
 *
 * A pure module rather than inline `if`s in `FilesView.tsx`, for the reason
 * `newFile.ts` is (CLAUDE.md): these are predicates that ship wrong, and a
 * component is not where they can be tested. The name rules are `newFilePath`'s
 * (one component, no `.`/`..`, no separator) — reused, not re-derived. The
 * SERVER stays authoritative for all of it, the 25 MiB cap included; this copy
 * exists so an obviously bad file is an instant message instead of a 25 MiB
 * request that comes back as a bare, non-JSON 413.
 */

/** The server's cap on one decoded file (`POST /files/upload`). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * The tree-relative directory a drop on a row means: a folder row is the
 * folder itself, a file row is that file's folder, and anything that is not a
 * row (empty tree area, content pane, search panel) is the project root.
 */
export function uploadTargetDir(
  row: { path: string; isDir: boolean } | null,
): string {
  if (row === null) return ''
  if (row.isDir) return row.path
  const i = row.path.lastIndexOf('/')
  return i < 0 ? '' : row.path.slice(0, i)
}

/**
 * Whether a drag is an OS file drag — the only kind that uploads. `types`
 * carries `"Files"` for one; an internal tab drag sets only `text/plain`, and
 * is additionally recognised by the Files view's own `dragging` slot, so the
 * two can never be mistaken for each other even if a browser added `"Files"`
 * to a synthetic drag.
 */
export function isOsFileDrag(
  types: ArrayLike<string> | null | undefined,
  tabDragActive: boolean,
): boolean {
  if (tabDragActive || !types) return false
  return Array.from(types).includes('Files')
}

/** Why a file of `size` bytes may not go, or `null` when it may. A zero-byte
 * file is fine. */
export function uploadSizeProblem(size: number): string | null {
  return size <= MAX_UPLOAD_BYTES ? null : 'larger than the 25 MB upload limit.'
}

/**
 * Splits a drop into the files to upload and the count of folders to refuse.
 * `isDirectory[i]` is whether the i-th dropped file is a folder, from
 * `webkitGetAsEntry()` — `undefined` or shorter than `files` where that API is
 * missing, in which case every entry is treated as a file (a folder then fails
 * at read time with its own message rather than being guessed at here).
 */
export function splitDropped<T>(
  files: readonly T[],
  isDirectory: ReadonlyArray<boolean | undefined>,
): { files: T[]; folders: number } {
  const kept: T[] = []
  let folders = 0
  files.forEach((file, i) => {
    if (isDirectory[i] === true) folders += 1
    else kept.push(file)
  })
  return { files: kept, folders }
}

/** What a `FileReader.readAsDataURL` result carries after its
 * `data:<type>;base64,` prefix — the standard base64 the route takes. */
export function stripDataUrl(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

/** Reads a file as base64 without building a binary string: the browser
 * encodes it, and only the data-URL prefix is cut off. */
export function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(stripDataUrl(String(reader.result)))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** How one file of a drop ended. `message` is the reason for anything but an
 * upload. */
export type UploadResult =
  | { name: string; outcome: 'uploaded' }
  | { name: string; outcome: 'skipped' | 'failed'; message: string }

/** Shown for each folder in a drop. */
export const FOLDERS_UNSUPPORTED = 'Folders cannot be dropped yet.'

/** The message for a file the person declined to replace. */
export const SKIPPED = 'already exists and was not replaced.'

/** The in-flight line: which file, of how many. */
export function progressLabel(name: string, index: number, total: number): string {
  return total > 1
    ? `Uploading ${name} (${index} of ${total})…`
    : `Uploading ${name}…`
}

/** The hint while a drag is over a target. */
export function dropHint(dir: string): string {
  return dir === '' ? 'Drop to upload to the project root' : `Drop to upload to ${dir}`
}

/**
 * The text left on screen when an upload is over: an `ok` line when anything
 * went up, and one `problems` line per file that did not (plus one for dropped
 * folders), each naming the file. Empty on both sides means nothing to say.
 */
export function summarizeUploads(
  results: readonly UploadResult[],
  folders: number,
): { ok: string | null; problems: string[] } {
  const uploaded = results.filter((r) => r.outcome === 'uploaded').length
  const problems = results.flatMap((r) =>
    r.outcome === 'uploaded' ? [] : [`${r.name}: ${r.message}`],
  )
  if (folders > 0) problems.push(FOLDERS_UNSUPPORTED)
  const ok =
    uploaded === 0
      ? null
      : uploaded === 1
        ? 'Uploaded 1 file.'
        : `Uploaded ${uploaded} files.`
  return { ok, problems }
}
