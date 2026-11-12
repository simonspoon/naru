// The words for a file the Files tab will not open in its editor (naru task
// 2803). Here rather than inline in `FilesView.tsx` so the number a person
// reads is unit-tested against the number the server enforces.

/** The longest markdown file (in characters) that opens as its rendered
 * preview. The preview is one synchronous render of the whole text — 1.5 s
 * measured at 1.8 MB — and before the edit cap was raised it never saw more
 * than 256 KiB. Past this a markdown file opens in the editor like any other
 * text file. */
export const PREVIEW_MAX_CHARS = 1024 * 1024

/** Whether markdown of `length` characters gets a rendered preview. */
export function previewsAt(length: number): boolean {
  return length <= PREVIEW_MAX_CHARS
}

/** A byte limit as the size a person would call it: `8 MB`, `2.5 MB`,
 * `256 KB`. Binary units, since that is how the server's caps are written. */
export function limitLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${Math.round(mb * 10) / 10} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/** Why a `truncated` file is read-only, and where the rest of it is.
 * `editLimit` is `FileContentView.edit_limit`. */
export function tooLargeNotice(editLimit: number): string {
  return `Too large to edit here (${limitLabel(editLimit)} limit). This is the start of the file, read-only; Download saves all of it.`
}
