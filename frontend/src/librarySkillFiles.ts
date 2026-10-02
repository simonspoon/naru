/**
 * Pure draft logic for a skill's sibling files in the Library editor (mesa
 * task 1605), the second half of `libraryDraft.ts`: SKILL.md is the item's
 * `body`, every other file is one entry in `LibraryItem.files` (path relative
 * to the skill dir → text). The editor shows them as one list, SKILL.md first
 * and then the siblings in path order, and a save sends the body and the whole
 * map in one PATCH — the server replaces the map, so a removed file is simply
 * absent from it.
 *
 * The path rules mirror `library_file_path_is_valid` in `store.rs`; the
 * server stays the authority, this only spares a round trip.
 */

/** The skill's own file, the item's `body` — always first, never removable. */
export const SKILL_FILE = 'SKILL.md'

export const FILES_MAX = 100
export const FILE_PATH_MAX = 200
export const FILE_DEPTH_MAX = 9

export type SkillFiles = Record<string, string>

/** Every file the editor lists: SKILL.md, then the siblings in path order. */
export function fileList(files: SkillFiles): string[] {
  return [SKILL_FILE, ...Object.keys(files).sort()]
}

/** The error this path would earn as a new sibling, or `null`. `existing` is
 * the current map, so a duplicate is caught here. */
export function pathError(path: string, existing: SkillFiles): string | null {
  if (path === '') return 'a file path is required'
  if (path.length > FILE_PATH_MAX) return `a path is at most ${FILE_PATH_MAX} characters`
  if (path.startsWith('/')) return 'a path is relative to the skill folder'
  if (path.includes('\\') || path.includes('\0')) return 'a path may not contain "\\"'
  if (path.toLowerCase() === SKILL_FILE.toLowerCase()) {
    return `${SKILL_FILE} is the skill itself`
  }
  const parts = path.split('/')
  if (parts.length > FILE_DEPTH_MAX) return `a path is at most ${FILE_DEPTH_MAX} levels deep`
  if (parts.some((p) => p === '' || p.startsWith('.'))) {
    return 'a path may not hold an empty or dot-prefixed part'
  }
  if (path in existing) return `${path} already exists`
  if (Object.keys(existing).length >= FILES_MAX) return `a skill holds at most ${FILES_MAX} files`
  return null
}

/** Adds an empty sibling; the caller has checked `pathError`. */
export function addFile(files: SkillFiles, path: string): SkillFiles {
  return { ...files, [path]: '' }
}

/** Drops a sibling. SKILL.md is not in the map, so it can never be dropped. */
export function removeFile(files: SkillFiles, path: string): SkillFiles {
  const next = { ...files }
  delete next[path]
  return next
}

/** One sibling's new text. */
export function setFileText(files: SkillFiles, path: string, text: string): SkillFiles {
  return { ...files, [path]: text }
}

/** The text the editor shows for `path` — SKILL.md is the body. */
export function textOf(path: string, body: string, files: SkillFiles): string {
  return path === SKILL_FILE ? body : (files[path] ?? '')
}

/** Whether two maps differ (keys or text) — key order is not content. */
export function filesDiffer(a: SkillFiles, b: SkillFiles): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return true
  return ka.some((k) => !(k in b) || a[k] !== b[k])
}

/** Which listed files differ from what was saved, for the dirty marks. */
export function changedFiles(
  savedBody: string,
  savedFiles: SkillFiles,
  body: string,
  files: SkillFiles,
): string[] {
  const out: string[] = []
  if (body !== savedBody) out.push(SKILL_FILE)
  for (const p of Object.keys(files).sort()) {
    if (savedFiles[p] !== files[p]) out.push(p)
  }
  return out
}

/** The `files` a save sends: the whole map for a skill, absent for any other
 * kind (the server would refuse siblings there). */
export function filesPayload(kind: string, files: SkillFiles): SkillFiles | undefined {
  return kind === 'skill' ? files : undefined
}

/** The selection after a removal or a reload: `path` if still listed, else
 * SKILL.md. */
export function selectionAfter(path: string, files: SkillFiles): string {
  return path === SKILL_FILE || path in files ? path : SKILL_FILE
}
