/**
 * Moving a tree entry into another folder (naru task 2745): the decisions made
 * before a request goes out — is this move a no-op, is it illegal, what path
 * does the entry end up at, and what does a typed "Move to…" folder mean.
 *
 * A pure module for the reason `newFile.ts` is (CLAUDE.md). The SERVER stays
 * authoritative; this copy only turns an obviously wrong move into an instant
 * message, or into no request at all.
 */

/** The `dataTransfer` type a dragged tree row carries. The authoritative
 *  "a tree row is being dragged" signal is `FilesView`'s module slot, since
 *  `getData` is unreadable during `dragover`; this marks the drag for anything
 *  that does inspect `types`. */
export const TREE_MOVE_TYPE = 'application/x-naru-tree-path'

/** What dropping `source` on `destDir` means. `noop` makes no request and
 *  shows nothing; `refused` carries the message to show inline. */
export type MoveDecision =
  | { kind: 'move'; path: string }
  | { kind: 'noop' }
  | { kind: 'refused'; reason: string }

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** Whether `path` is `root` or lies inside it. `src2` is not inside `src`. */
export function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/**
 * Moving `source` into `destDir` (both tree-relative, `''` = the project
 * root). The entry keeps its name: the result is `destDir/name`.
 *
 * Its current folder, or itself, is a no-op; a destination inside it is
 * refused (a folder cannot hold itself).
 */
export function moveTarget(source: string, destDir: string): MoveDecision {
  if (source === '') return { kind: 'refused', reason: 'Cannot move the project root.' }
  if (destDir === source) return { kind: 'noop' }
  if (isInside(destDir, source)) {
    return { kind: 'refused', reason: 'Cannot move a folder into itself.' }
  }
  if (parentOf(source) === destDir) return { kind: 'noop' }
  const name = source.slice(source.lastIndexOf('/') + 1)
  return { kind: 'move', path: destDir === '' ? name : `${destDir}/${name}` }
}

/** A typed "Move to…" folder as the relative path to send, or why not. Blank
 *  and `/` are the project root; surrounding slashes and spaces are dropped. */
export type DestDir = { ok: true; dir: string } | { ok: false; reason: string }

export function normalizeDestDir(typed: string): DestDir {
  if (typed.includes('\\') || typed.includes('\0')) {
    return { ok: false, reason: 'Enter a folder path with / separators.' }
  }
  const dir = typed.trim().replace(/^\/+|\/+$/g, '')
  if (dir === '') return { ok: true, dir: '' }
  const parts = dir.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    return { ok: false, reason: 'A folder path cannot contain empty, . or .. parts.' }
  }
  return { ok: true, dir: parts.join('/') }
}
