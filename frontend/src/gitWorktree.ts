// The pure half of the Git tab's working-tree view (naru task 2738,
// docs/git-tab.md "Working tree view"): which section a porcelain-v2 entry
// belongs to, its badge and words, the flat / tree row model with the render
// cap, multi-select, and what a header's bulk button sends. No DOM, no React:
// covered by `gitWorktree.test.ts`. Every string here comes from the repo and
// is only ever rendered as a text node.
import type { GitFile } from './types/GitFile'
import { filterByPath } from './gitSearch'

export type SectionKind = 'conflicts' | 'staged' | 'changes' | 'untracked'
export const SECTION_ORDER: SectionKind[] = ['conflicts', 'staged', 'changes', 'untracked']
export const SECTION_TITLES: Record<SectionKind, string> = {
  conflicts: 'Conflicts',
  staged: 'Staged',
  changes: 'Changes',
  untracked: 'Untracked',
}

/** Most rows one section renders before "Show all N". */
export const ROW_CAP = 500

export const TREE_MODE_KEY = 'naru-git-tree-mode'
export const WT_SECTIONS_KEY = 'naru-git-wt-sections'

export type ViewMode = 'flat' | 'tree'

/** Remembered Flat | Tree pick; flat unless it says "tree". */
export function parseViewMode(raw: string | null): ViewMode {
  return raw === 'tree' ? 'tree' : 'flat'
}

/** Remembered per-section open flags; every section defaults to open. */
export function parseOpenSections(raw: string | null): Record<SectionKind, boolean> {
  const out: Record<SectionKind, boolean> = {
    conflicts: true,
    staged: true,
    changes: true,
    untracked: true,
  }
  if (raw === null) return out
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v === 'object' && v !== null) {
      for (const id of SECTION_ORDER) {
        const f = (v as Record<string, unknown>)[id]
        if (typeof f === 'boolean') out[id] = f
      }
    }
  } catch {
    // a corrupt value is the default
  }
  return out
}

// ---- classification ----

/** One row of one section: the file as seen from that section. */
export type Entry = {
  section: SectionKind
  file: GitFile
  /** The status char describing the file in this section (X for Staged, Y for
   * Changes); `U` for untracked and `!` for a conflict. */
  code: string
}

export function isConflict(status: string): boolean {
  return status.includes('U') || status === 'AA' || status === 'DD'
}

export function isUntracked(status: string): boolean {
  return status === '??'
}

const unchanged = (c: string | undefined): boolean => c === undefined || c === '.' || c === ' '

/** Which sections a file shows in, with the char that describes it there. A
 * conflict is only in Conflicts; a file changed in both the index and the
 * working tree is in both Staged (by X) and Changes (by Y). */
export function entriesOf(file: GitFile): Entry[] {
  const s = file.status
  if (isConflict(s)) return [{ section: 'conflicts', file, code: '!' }]
  if (isUntracked(s)) return [{ section: 'untracked', file, code: 'U' }]
  const out: Entry[] = []
  if (!unchanged(s[0])) out.push({ section: 'staged', file, code: s[0] })
  if (!unchanged(s[1])) out.push({ section: 'changes', file, code: s[1] })
  // A pair with nothing in either column should not happen; keep the file
  // visible rather than losing it.
  if (out.length === 0) out.push({ section: 'changes', file, code: '?' })
  return out
}

export type Sections = Record<SectionKind, Entry[]>

export function splitSections(files: GitFile[]): Sections {
  const out: Sections = { conflicts: [], staged: [], changes: [], untracked: [] }
  for (const f of files) for (const e of entriesOf(f)) out[e.section].push(e)
  return out
}

/** Entries whose path (or rename source) contains `query`, case-insensitive. */
export function filterEntries(entries: Entry[], query: string): Entry[] {
  if (query.trim() === '') return entries
  const keep = new Set(filterByPath(entries.map((e) => e.file), query))
  return entries.filter((e) => keep.has(e.file))
}

const CHANGE_WORDS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
}

const CONFLICT_WORDS: Record<string, string> = {
  UU: 'both modified',
  AA: 'both added',
  DD: 'both deleted',
  AU: 'added by us',
  UA: 'added by them',
  DU: 'deleted by us',
  UD: 'deleted by them',
}

/** The plain status word of an entry ("modified", "deleted by them", …); an
 * unknown char is shown verbatim. */
export function statusWord(e: Entry): string {
  if (e.section === 'untracked') return 'untracked'
  if (e.section === 'conflicts') return CONFLICT_WORDS[e.file.status] ?? 'conflict'
  return CHANGE_WORDS[e.code] ?? e.code
}

export type BadgeTone =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked'
  | 'conflict'
  | 'unknown'

const TONES: Record<string, BadgeTone> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
}

/** The single-letter badge and the tone class that colours it. */
export function badgeOf(e: Entry): { letter: string; tone: BadgeTone } {
  if (e.section === 'untracked') return { letter: 'U', tone: 'untracked' }
  if (e.section === 'conflicts') return { letter: '!', tone: 'conflict' }
  return { letter: e.code, tone: TONES[e.code] ?? 'unknown' }
}

/** `a/b/c.ts` -> dir `a/b/`, name `c.ts`; an untracked folder `a/b/` keeps its
 * trailing slash on the name (`b/`) and has dir `a/`. */
export function splitPath(path: string): { dir: string; name: string } {
  const isDir = path.endsWith('/')
  const trimmed = isDir ? path.slice(0, -1) : path
  const at = trimmed.lastIndexOf('/')
  const dir = at < 0 ? '' : trimmed.slice(0, at + 1)
  const name = at < 0 ? trimmed : trimmed.slice(at + 1)
  return { dir, name: isDir ? `${name}/` : name }
}

// ---- tree ----

export type TreeNode =
  | { kind: 'dir'; id: string; label: string; children: TreeNode[]; entries: Entry[] }
  | { kind: 'file'; entry: Entry }

type Trie = { dirs: Map<string, Trie>; files: Entry[] }

function toNodes(trie: Trie, prefix: string): TreeNode[] {
  const dirs = [...trie.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))
  const nodes: TreeNode[] = []
  for (const [name, sub] of dirs) {
    // Compact a chain of folders that each hold only one folder: `a/b/c`.
    let label = name
    let cur = sub
    while (cur.files.length === 0 && cur.dirs.size === 1) {
      const [[n, next]] = [...cur.dirs.entries()]
      label += `/${n}`
      cur = next
    }
    const id = `${prefix}${label}/`
    const children = toNodes(cur, id)
    nodes.push({ kind: 'dir', id, label, children, entries: collect(children) })
  }
  const files = [...trie.files].sort((a, b) =>
    splitPath(a.file.path).name.localeCompare(splitPath(b.file.path).name),
  )
  for (const entry of files) nodes.push({ kind: 'file', entry })
  return nodes
}

function collect(nodes: TreeNode[]): Entry[] {
  return nodes.flatMap((n) => (n.kind === 'file' ? [n.entry] : n.entries))
}

/** Group one section's entries by folder: folders first, single-child chains
 * compacted. An untracked folder entry (`dir/`) is a file-like leaf. */
export function buildTree(entries: Entry[]): TreeNode[] {
  const root: Trie = { dirs: new Map(), files: [] }
  for (const e of entries) {
    const { dir } = splitPath(e.file.path)
    let at = root
    for (const seg of dir.split('/').filter((s) => s !== '')) {
      let next = at.dirs.get(seg)
      if (next === undefined) {
        next = { dirs: new Map(), files: [] }
        at.dirs.set(seg, next)
      }
      at = next
    }
    at.files.push(e)
  }
  return toNodes(root, '')
}

// ---- rows ----

export type Row =
  | { type: 'dir'; id: string; label: string; depth: number; entries: Entry[]; open: boolean }
  | { type: 'file'; entry: Entry; depth: number }

export type SectionRows = {
  rows: Row[]
  /** File rows left out by the cap. */
  hidden: number
  /** Paths of the rendered file rows, in order (the range-select order). */
  visible: string[]
}

export const dirKey = (section: SectionKind, id: string): string => `${section}\0${id}`

/** The rows one section renders. Flat keeps git's order; tree groups by
 * folder. At most `cap` file rows are produced unless `showAll`; a collapsed
 * folder's files are not rendered and not counted as hidden. */
export function sectionRows(
  section: SectionKind,
  entries: Entry[],
  mode: ViewMode,
  collapsed: ReadonlySet<string>,
  showAll: boolean,
  cap: number = ROW_CAP,
): SectionRows {
  const rows: Row[] = []
  const visible: string[] = []
  let hidden = 0
  const room = () => showAll || visible.length < cap
  const addFile = (entry: Entry, depth: number) => {
    if (!room()) {
      hidden++
      return
    }
    rows.push({ type: 'file', entry, depth })
    visible.push(entry.file.path)
  }
  if (mode === 'flat') {
    for (const e of entries) addFile(e, 0)
    return { rows, hidden, visible }
  }
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      if (n.kind === 'file') {
        addFile(n.entry, depth)
        continue
      }
      const open = !collapsed.has(dirKey(section, n.id))
      rows.push({ type: 'dir', id: n.id, label: n.label, depth, entries: n.entries, open })
      if (open) walk(n.children, depth + 1)
    }
  }
  walk(buildTree(entries), 0)
  return { rows, hidden, visible }
}

// ---- selection ----

/** A multi-select inside one section. Identity is (section, path): the same
 * path can be in Staged and in Changes. */
export type Selection = {
  section: SectionKind
  paths: string[]
  anchor: string
  /** The path whose diff is shown. */
  primary: string
}

export function selectOne(section: SectionKind, path: string): Selection {
  return { section, paths: [path], anchor: path, primary: path }
}

/** What a click on a file row does. Plain selects one; toggle (cmd/ctrl)
 * adds or removes it; range (shift) extends from the anchor over `visible`,
 * the section's rendered order. A selection never spans sections: anything
 * from another section starts over. */
export function clickSelect(
  sel: Selection | null,
  section: SectionKind,
  path: string,
  visible: string[],
  mods: { toggle: boolean; range: boolean },
): Selection | null {
  const same = sel !== null && sel.section === section
  if (mods.range && same) {
    const a = visible.indexOf(sel.anchor)
    const b = visible.indexOf(path)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      return { section, paths: visible.slice(lo, hi + 1), anchor: sel.anchor, primary: path }
    }
    return selectOne(section, path)
  }
  if (mods.toggle && same) {
    if (sel.paths.includes(path)) {
      const rest = sel.paths.filter((p) => p !== path)
      if (rest.length === 0) return null
      const primary = sel.primary === path ? rest[rest.length - 1] : sel.primary
      return { section, paths: rest, anchor: primary, primary }
    }
    return { section, paths: [...sel.paths, path], anchor: path, primary: path }
  }
  return selectOne(section, path)
}

/** The selection after the file list changed: paths that left the section are
 * dropped. A lone selected file that moved to another section (a staged file
 * now only in Changes) is followed there. Returns `sel` itself when nothing
 * changed. */
export function reconcileSelection(sel: Selection | null, sections: Sections): Selection | null {
  if (sel === null) return null
  const here = new Set(sections[sel.section].map((e) => e.file.path))
  const kept = sel.paths.filter((p) => here.has(p))
  if (kept.length === sel.paths.length) return sel
  if (kept.length === 0) {
    if (sel.paths.length === 1) {
      const path = sel.paths[0]
      const to = SECTION_ORDER.find(
        (s) => s !== sel.section && sections[s].some((e) => e.file.path === path),
      )
      if (to !== undefined) return selectOne(to, path)
    }
    return null
  }
  const primary = kept.includes(sel.primary) ? sel.primary : kept[kept.length - 1]
  const anchor = kept.includes(sel.anchor) ? sel.anchor : primary
  return { section: sel.section, paths: kept, anchor, primary }
}

/** A multi-selection restricted to the rows on screen, so a bar count, a
 * button label, the confirm plan and the request all name the same files. A
 * lone selection is left alone (it only opens a diff; no button can reach a
 * row that is not shown). Returns `sel` itself when nothing changed. */
export function pruneToVisible(
  sel: Selection | null,
  visible: Record<SectionKind, string[]>,
): Selection | null {
  if (sel === null || sel.paths.length < 2) return sel
  const on = new Set(visible[sel.section])
  const kept = sel.paths.filter((p) => on.has(p))
  if (kept.length === sel.paths.length) return sel
  if (kept.length === 0) return null
  const primary = kept.includes(sel.primary) ? sel.primary : kept[kept.length - 1]
  const anchor = kept.includes(sel.anchor) ? sel.anchor : primary
  return { section: sel.section, paths: kept, anchor, primary }
}

// ---- bulk header buttons ----

export type BulkTarget = { all: true } | { paths: string[] }

/** What a section header's bulk button sends. With no filter and no conflict
 * in the repo "all" is `all: true` (one request, whatever the size); with a
 * filter it is exactly the shown paths, labelled "shown"; with a conflict
 * around it never asks the server to stage or unstage everything. */
export function bulkAction(
  verb: 'stage' | 'unstage',
  section: SectionKind,
  shownPaths: string[],
  filterActive: boolean,
  hasConflicts: boolean,
): { label: string; target: BulkTarget } {
  const noun = filterActive ? 'shown' : 'all'
  const label = `${verb === 'stage' ? 'Stage' : 'Unstage'} ${noun}`
  // Only Staged ("Unstage all") and Changes ("Stage all", which with git add -A
  // semantics includes untracked files) may speak for the whole repo.
  const wholeRepo = section === 'staged' || section === 'changes'
  if (!filterActive && !hasConflicts && wholeRepo) return { label, target: { all: true } }
  return { label, target: { paths: shownPaths } }
}
