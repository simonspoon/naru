import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'
import { SyntaxHighlighter, usePrismStyle, prismGrammar } from '../syntaxHighlighter'
import {
  activateTab,
  bulkCloseTargets,
  clampMenu,
  closeSubtree,
  closeTab,
  closeTabs,
  collapseSplit,
  cycleTab,
  dropIndex,
  focusPane,
  moveTab,
  openFile,
  openPaths,
  paneOf,
  renameSubtree,
  setRatio,
  splitPane,
  splitWithTab,
  type BulkClose,
  type PaneSide,
  type TabSource,
  type TabsState,
} from '../fileTabs'
import {
  closeLabel,
  dirtyPaths,
  diskChange,
  isDirty,
  needsCloseConfirm,
  splitBulkClose,
  tabLabel,
} from '../fileDirty'
import {
  clampFilesTreeWidth,
  clearFilesTreeWidth,
  DEFAULT_FILES_TREE_WIDTH,
  loadFilesTreeCollapsed,
  loadFilesTreeWidth,
  saveFilesTreeCollapsed,
  saveFilesTreeWidth,
} from '../filesTreeWidth'
import {
  gutterText,
  lineAtScroll,
  lineCount,
  normalizeNewlines,
  offsetForLine,
  viewerLineCount,
  type CaretPosition,
} from '../editorStatus'
import {
  anchorAfterStep,
  applyEdits,
  boxNeedsReveal,
  findMatches,
  matchIndexFrom,
  matchLabel,
  replaceEdits,
  scrollLeftForBox,
  stepMatch,
  type FindMatch,
} from '../fileFind'
import {
  MAX_SEARCH_QUERY,
  searchRequestQuery,
  searchSummary,
  snippetSegments,
} from '../fileSearch'
import { shouldIgnoreFilesShortcut } from '../keyboardScope'
import { goToOffset } from '../goToLine'
import { stashDrafts, stashedDrafts } from '../fileDrafts'
import { loadWordWrap, saveWordWrap } from '../wordWrap'
import { onNarrowTierChange, useNarrowTier } from '../phoneTier'
import { CodeEditor, type CodeEditorHandle } from '../components/CodeEditor'
import { FindLayer } from '../components/FindLayer'
import { Markdown } from '../components/Markdown'
import { SideBySideDiff } from '../components/SideBySideDiff'
import { splitFrontmatter } from '../frontmatter'
import { delimiterFor, parseDelimited, type DelimitedTable } from '../fileCsv'
import { isHtmlDocumentPath } from '../fileHtml'
import { isImagePath } from '../fileImage'
import { setDragOutData } from '../fileDragOut'
import {
  isFit,
  panBy,
  pinchView,
  resolveView,
  stepScale,
  wheelZoomFactor,
  zoomAt,
  zoomKeyAction,
  zoomPercent,
  type Point,
  type Size,
  type ZoomView,
} from '../imageZoom'
import { mediaKindForPath } from '../fileMedia'
import { resolveMarkdownImageSrc } from '../markdownAssets'
import { newFilePath } from '../newFile'
import {
  SKIPPED,
  dropHint,
  isOsFileDrag,
  progressLabel,
  readAsBase64,
  splitDropped,
  summarizeUploads,
  uploadSizeProblem,
  uploadTargetDir,
  type UploadResult,
} from '../fileUpload'
import { loadOpenFiles, saveOpenFiles } from '../openFiles'
import {
  ApiError,
  createProjectFile,
  deleteProjectFileEntry,
  getProjectFiles,
  getProjectFilesContent,
  getProjectGitCommitDiff,
  getProjectGitFileLog,
  projectFileDownloadUrl,
  projectFileRawUrl,
  renameProjectFileEntry,
  searchProjectFiles,
  updateProjectFilesContent,
  uploadProjectFile,
  watchProjectFiles,
} from '../api'
import { levelsToRefetch, reconnectDelayMs } from '../filesWatch'
import type { FileTreeEntry } from '../types/FileTreeEntry'
import type { ProjectFileSearch } from '../types/ProjectFileSearch'
import type { GitCommit } from '../types/GitCommit'
import { useLiveContext } from '../liveContext'
import { useFetch } from '../useFetch'

/** The content half's own floor, the twin of `MIN_MAIN_WIDTH` in Sidebar.tsx /
 * AgentSidebar.tsx: dragging the tree wider may never squeeze the file it
 * exists to open down to a strip. */
const MIN_FILES_CONTENT_WIDTH = 320

/** The widest the tree pane may be right now, or null while either half is
 * unmounted (the tab is still loading) and there is nothing to measure.
 *
 * `.files-layout` puts a gap between the two, so the room the tree can take is
 * the distance to the panes' right edge *minus that gap* — measured, not
 * assumed, since it is a `rem` in App.css — minus the content half's own
 * floor. Left out, the ceiling hands the content a pane one gap under its
 * floor. */
function maxTreeWidth(
  tree: HTMLElement | null,
  panes: HTMLElement | null,
): number | null {
  if (tree === null || panes === null) return null
  const t = tree.getBoundingClientRect()
  const p = panes.getBoundingClientRect()
  return p.right - t.left - (p.left - t.right) - MIN_FILES_CONTENT_WIDTH
}

// Extension -> language tag, a client-side copy of core::files::language_of's
// table (arch.md §4 / src/core/files.rs). The TREE endpoint carries no
// `language` field per entry (would multiply payload size by up to
// MAX_TREE_ENTRIES for a value the frontend can derive for free from
// `name`), so tree-row tinting looks this table up directly off
// `FileTreeEntry.name`'s extension; the CONTENT endpoint returns `language`
// already computed server-side and is used verbatim (not re-derived here).
const EXTENSION_LANGUAGE: Record<string, string> = {
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  py: 'python',
  pyi: 'python',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  webmanifest: 'json',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  html: 'html',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  svg: 'svg',
  go: 'go',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  hh: 'cpp',
  cxx: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  java: 'java',
  m: 'objectivec',
  mm: 'objectivec',
  php: 'php',
  dart: 'dart',
  scala: 'scala',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  hs: 'haskell',
  ex: 'elixir',
  exs: 'elixir',
  dockerfile: 'docker',
  mk: 'makefile',
  diff: 'diff',
  patch: 'diff',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  ps1: 'powershell',
  psm1: 'powershell',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  groovy: 'groovy',
  gradle: 'groovy',
  sql: 'sql',
  csv: 'csv',
  tsv: 'tsv',
  kql: 'kql',
  csl: 'kql',
  xml: 'xml',
  csproj: 'xml',
  xaml: 'xml',
  plist: 'xml',
  storyboard: 'xml',
  xib: 'xml',
  xcworkspacedata: 'xml',
}

// Whole file name -> language tag, the client-side copy of
// core::files::language_of_name: the files an extension cannot describe —
// those carrying none at all (Dockerfile, Makefile) and dotfiles, whose
// leading dot is the start of the stem rather than a separator. The .env
// family is a prefix rather than a fixed set and is handled in
// `languageOfName` itself.
const NAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell',
}

// Language tag -> one of the theme's five neon accent hues. The Tron palette
// (index.css) has only cyan/magenta/amber/green/red, far fewer than the
// language vocabulary above, so this groups by rough category (systems,
// scripting, web markup, data/config) rather than assigning each language its
// own hue — enough tint to tell entries apart at a glance and to visually
// agree between a tree row and the content-pane header once clicked, without
// inventing a second color per language.
const LANGUAGE_ACCENT: Record<string, string> = {
  rust: 'cyan',
  go: 'cyan',
  c: 'cyan',
  cpp: 'cyan',
  csharp: 'cyan',
  swift: 'cyan',
  kotlin: 'cyan',
  java: 'cyan',
  objectivec: 'cyan',
  scala: 'cyan',
  dart: 'cyan',
  haskell: 'cyan',
  python: 'green',
  ruby: 'green',
  shell: 'green',
  php: 'green',
  lua: 'green',
  perl: 'green',
  r: 'green',
  elixir: 'green',
  groovy: 'green',
  powershell: 'green',
  docker: 'green',
  makefile: 'green',
  javascript: 'magenta',
  typescript: 'magenta',
  html: 'magenta',
  xml: 'magenta',
  css: 'magenta',
  scss: 'magenta',
  less: 'magenta',
  json: 'amber',
  yaml: 'amber',
  toml: 'amber',
  markdown: 'amber',
  sql: 'amber',
  csv: 'amber',
  tsv: 'amber',
  kql: 'amber',
  diff: 'amber',
  ini: 'amber',
  protobuf: 'amber',
  graphql: 'amber',
}

/** Language tag for a filename, or null when unrecognized (an unlisted
 * extension, or a dotfile like ".gitignore" neither table knows). Its
 * extension first, its whole name only when the extension answered nothing —
 * the same order core::files::language_for_path takes, so the two tables can
 * never shadow each other. */
function languageOfName(name: string): string | null {
  const lower = name.toLowerCase()
  const i = name.lastIndexOf('.')
  const byExtension = i > 0 ? EXTENSION_LANGUAGE[lower.slice(i + 1)] : undefined
  if (byExtension !== undefined) return byExtension
  // The .env family is a prefix rather than a fixed set: `.env.production`
  // and `.env.local` are one file per environment, and what looks like their
  // extension is the environment's name rather than a format.
  if (lower === '.env' || lower.startsWith('.env.')) return 'ini'
  return NAME_LANGUAGE[lower] ?? null
}

/** CSS class for a language tag (or its absence) — shared by tree rows
 * (client-derived) and the content header (server-derived), so the two
 * always render the same tint for the same file. */
function accentClass(language: string | null): string {
  return `files-accent-${LANGUAGE_ACCENT[language ?? ''] ?? 'muted'}`
}

/** Same "no linked folder" copy shape as GitView's placeholder (M10), worded
 * for browsing files instead of git status. */
function NoLocalPathPlaceholder({ projectId }: { projectId: number }) {
  return (
    <div className="files-placeholder muted">
      <p>
        This project has no linked folder, so Naru cannot browse its files.
        Run <code>mesa project resolve</code> inside the repo, or{' '}
        <code>mesa project update {projectId} --path &lt;dir&gt;</code>, to
        link one.
      </p>
    </div>
  )
}

/** Dead/unreadable folder — collapses "gone" and "unreadable" into one rung,
 * same as the API's own ladder (arch.md §3) and the Git tab's precedent. */
function DeadFolderPlaceholder({ path }: { path: string }) {
  return (
    <div className="files-placeholder muted">
      <p>
        <code>{path}</code> no longer exists or is not readable.
      </p>
    </div>
  )
}

/**
 * One open tab's view state, the part that must outlive a tab switch (mesa
 * task 670).
 *
 * Before tabs there was one open file and `ContentPane` was
 * `key={selectedPath}`-remounted, which meant this state simply died with the
 * old file. That is still the right answer for *closing* a tab — but flipping
 * to another tab and back is a navigation, and a navigation that silently ate
 * a half-typed edit would be a bug. So it is lifted into `FilesView`, keyed by
 * path, and this component is controlled. (Leaving the Files tab or switching
 * project keeps it too, in `fileDrafts.ts`.)
 *
 * Deliberately not lifted: `saving`/`downloading`/`saveError`, which describe
 * one in-flight request rather than the file, and which the pane has to be
 * mounted to show.
 */
interface FileUiState {
  /** Whether this path has a draft at all (naru task 2743). There is no edit
   * mode: the first keystroke in the editor sets this, with `draft` and
   * `baseline`; until then the pane shows the fetched content. See
   * `fileDirty.ts::DraftState`. */
  editing: boolean
  draft: string
  /** The file on disk as this draft last knew it — when it started, after a
   * successful save, and after "Keep mine" (task 809, slice 4; naru task
   * 2743). Kept beside the draft rather than compared against the fetched
   * content, because the tab strip that has to paint the unsaved-changes dot
   * lives two components above the only one holding that response:
   * `fileDirty.ts` can answer from this pair alone. */
  baseline: string
  /** A rendered type (markdown, HTML, a table, an SVG) showing its source in
   * the editor instead of its preview (naru task 2743). Per path, so it
   * survives a tab switch like the draft does. */
  source: boolean
  /** The file's content (LF) at the last read of the disk this draft was
   * reconciled against, or null before the first — and the text of the last
   * save, a beat before the refetch that follows one lands. Here rather than
   * in the pane because the same path can be mounted in both halves of a
   * split: two copies would disagree for as long as one pane's fetch lags,
   * and one of them would report a conflict that is the other's save. */
  seenDisk: string | null
  /** How many saves this path has completed. A read that set out before the
   * latest one describes a disk that no longer exists and is not reconciled. */
  saves: number
  historyOpen: boolean
  /** The commit shown as a diff in place of the content, if any. */
  selectedCommit: GitCommit | null
}

const BLANK_FILE_UI: FileUiState = {
  editing: false,
  draft: '',
  baseline: '',
  source: false,
  seenDisk: null,
  saves: 0,
  historyOpen: false,
  selectedCommit: null,
}

/** How often a mounted file is re-read from disk, as the backstop under the
 * watch stream (see `ContentPane`). */
const OPEN_FILE_POLL_MS = 3000

/** What a save says when it will not write over a change it has not been
 * told to: the "changed on disk" bar holds the two answers. */
const CHANGED_ON_DISK = 'This file changed on disk. Choose "Reload" or "Keep mine" first.'

/** The patch that drops a path's draft: the pane shows the disk again. */
const NO_DRAFT = { editing: false, draft: '', baseline: '' }

/** A write to one path's state: a patch, or a decision made against the
 * *latest* state (null = write nothing). The second form is for anything
 * decided outside a render — a fetch landing — where the state closed over
 * may be a keystroke old. */
type UiPatch =
  | Partial<FileUiState>
  | ((prev: FileUiState) => Partial<FileUiState> | null)

/** A burst of changes on disk, from the watch stream: which directories
 * (project-relative, `''` the root; null = unknown, treat as all), and a
 * number that makes each burst a new value. */
interface DiskChange {
  seq: number
  dirs: string[] | null
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)

/**
 * The find bar's whole state (task 809, slice 3).
 *
 * Deliberately *not* part of `FileUiState`: a search is a question about the
 * bytes on screen right now, not an edit that would be a bug to lose, so it
 * dies with the mounted pane exactly as `saving` and `caret` do — the same
 * split `FileUiState`'s own doc draws.
 *
 * `anchor` is where the search runs from — the caret when the bar was opened
 * over the editor, the first line on screen over the viewer. Kept rather than
 * re-read per keystroke so that growing the query walks *forward from where the
 * user was*, instead of the result jumping about as the caret follows each new
 * selection. It moves on exactly one event, a step (`anchorAfterStep`), because
 * a step is the user saying "here is where I am now": without that, narrowing a
 * query after walking five matches down the file teleports back to the top of
 * the original search.
 */
interface FindState {
  open: boolean
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  /** The query is a regular expression (naru task 2743). Off by default: a
   * query is typing until the user says it is a pattern. */
  regex: boolean
  /** The replace row, and what it holds (naru task 2743). Only ever shown
   * over the editor. */
  replaceOpen: boolean
  replacement: string
  /** Index into the current match list, or -1 for none. */
  index: number
  anchor: number
  /** Whether the bar should take the caret as it comes up. True for every way
   * a *user* opens it (Cmd/Ctrl+F is "let me type a query"), false for the one
   * way it opens without being asked for — a project-search result landing in
   * this pane (task 813), where the caret belongs to the panel the user is
   * still clicking through. */
  autoFocus: boolean
}

/** How many renders a search-result landing may spend trying to scroll its
 * match into view before giving up (task 813). More than one because the first
 * try happens as the pane is mounting and can measure a layout that has not
 * settled; bounded, because a match the readable band can never contain must
 * not re-scroll on every render for as long as the landing is active. */
const MAX_LANDING_REVEALS = 3

/** How many data rows of a delimited file the table view renders (mesa task
 * 1110). A file capped at `FILE_CONTENT_CAP` can still hold tens of thousands
 * of rows, and every one of them is a live DOM row; past this the view renders
 * the first `MAX_CSV_ROWS` and says how many it is short of. Download is how
 * the whole file is read. */
const MAX_CSV_ROWS = 1000

const BLANK_FIND: FindState = {
  open: false,
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  replaceOpen: false,
  replacement: '',
  index: -1,
  anchor: 0,
  autoFocus: true,
}

/**
 * A result clicked in the project-search panel (mesa task 813), handed to the
 * pane that opens the file so it can show the reader *which* line matched.
 *
 * It is deliberately expressed as a search rather than as a scroll offset: the
 * pane already knows how to run a query, land on the first match at or after an
 * anchor, and reveal it in either mode and either wrap setting (`runFind`, and
 * the machinery task 809 built under it). Handing it a line and the query that
 * found the line reuses all of that — and leaves the reader with the in-file
 * bar open on the same query, which is where they wanted to be next anyway.
 *
 * `seq` is what makes a second click on the *same* result land again: every
 * other field can be identical, and only a fresh number says "this is a new
 * click" to the pane that already consumed the last one.
 */
interface SearchLanding {
  seq: number
  path: string
  /** 1-based, over the same capped bytes the content route serves. */
  line: number
  query: string
  caseSensitive: boolean
  wholeWord: boolean
}

/** The selected file's content: monospace, with a language-tinted header and
 * binary/truncation indicators in place of raw/garbled bytes (M5/M6).
 *
 * A text file that is neither binary nor truncated opens **in the editor**
 * (naru task 2743) — there is no edit mode to enter or leave. A truncated
 * file's displayed bytes aren't its full content, so saving them back would
 * corrupt it (the same reason the API itself refuses that write); it and a
 * binary stay read-only. The rendered types (markdown, HTML, a delimited
 * table, an SVG) open as their preview, with the editor one toggle away. */
function ContentPane({
  projectId,
  path,
  ui,
  onUi,
  wrap,
  onWrapChange,
  focused,
  landing,
  imageZoom,
  reload,
  changed,
  focusSeq,
  onFocusTaken,
}: {
  projectId: number
  path: string
  ui: FileUiState
  onUi: (patch: UiPatch) => void
  /** Soft wrap — one preference for the whole tab, owned by `FilesView` and
   * persisted there, so both panes and every tab agree on it. */
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
  /** Whether this is the pane a Files-tab keystroke belongs to. Only it binds
   * Cmd/Ctrl+F — in a split, both panes are mounted, and two find bars racing
   * for one keystroke is the bug that scoping avoids. */
  focused: boolean
  /** The project-search result this pane was opened for, if any (task 813) —
   * consumed once, by `seq`. Null in every other case, which is every case
   * before this feature existed. */
  landing: SearchLanding | null
  /** The owning pane's zoom per open image (naru task 2731); see `FilePane`. */
  imageZoom: Map<string, ZoomView | null>
  /** Bumped when an upload replaces this file on disk (naru task 2732); part
   * of the fetch key, so the bytes on screen are re-read. */
  reload: number
  /** The watch stream's latest burst (naru task 2743): this file is re-read
   * when its directory is in it. */
  changed: DiskChange | null
  /** Non-zero when the person just opened or switched to this file here, and
   * the editor should take the caret — once per number. Zero on a page load, a
   * search-result landing and the phone tier, where it must not. */
  focusSeq: number
  /** The editor took the caret for `focusSeq`: the request is spent. */
  onFocusTaken: () => void
}) {
  // What a landing fetch checks before it is reconciled against the draft:
  // that this pane is still mounted, still showing the file the request was
  // for (the pane is keyed by path, so a project switch reuses it), and that
  // no save has completed since the request set out (`FileUiState.saves`).
  const fetchKey = `files-content-${projectId}-${path}-${reload}`
  // `ui` rides along for the one caller that outlives its render: a save,
  // which has to look at the draft again after its own pre-read.
  const live = useRef({ alive: true, key: fetchKey, saves: ui.saves, ui })
  useLayoutEffect(() => {
    live.current = { alive: true, key: fetchKey, saves: ui.saves, ui }
    return () => {
      live.current.alive = false
    }
  })
  // Reads of one file can overlap (window focus, the watch stream, a save's
  // refetch) and land out of order. A response that set out before one already
  // applied describes an older disk: it must neither be reconciled — it could
  // retract a conflict the newer read raised — nor shown, so it resolves to
  // the newer response instead.
  const loads = useRef<{
    key: string
    started: number
    landed: number
    data: Awaited<ReturnType<typeof getProjectFilesContent>> | null
  }>({ key: fetchKey, started: 0, landed: 0, data: null })
  const { data, error, refetch } = useFetch(() => {
    const { key, saves } = live.current
    if (loads.current.key !== key) loads.current = { key, started: 0, landed: 0, data: null }
    const order = loads.current
    const seq = ++order.started
    return getProjectFilesContent(projectId, path).then((d) => {
      if (seq < order.landed) return order.data ?? d
      order.landed = seq
      order.data = d
      if (live.current.alive && live.current.key === key) {
        reconcile(normalizeNewlines(d.content), saves)
      }
      return d
    })
    // Polled as well as watched. The watch stream is what makes a change
    // show at once, but on macOS a single in-place write is delivered late
    // or folded into the next one, and "reload it, or tell me it changed"
    // has to hold for the file on screen either way. An identical read
    // changes nothing (`useFetch`), and a hidden tab does not poll.
  }, fetchKey, { pollMs: OPEN_FILE_POLL_MS })

  /** A fresh read of the file, against this path's draft (`diskChange`): a
   * clean draft is dropped so the pane shows the disk, and unsaved work is
   * left exactly as typed — the "Changed on disk" bar below is derived from
   * `seenDisk` and asks. Decided in the updater, against the latest state: a
   * keystroke, or a save, may have landed since this render. */
  function reconcile(disk: string, saves: number) {
    onUi((prev) => {
      if (prev.saves !== saves) return null
      const reload = diskChange(prev, disk) === 'reload'
      if (!reload && prev.seenDisk === disk) return null
      return reload ? { ...NO_DRAFT, seenDisk: disk } : { seenDisk: disk }
    })
  }

  // A change on disk in this file's directory: read it again. Not a new fetch
  // key — that would blank the pane and remount the editor.
  useEffect(() => {
    if (changed === null) return
    if (changed.dirs === null || changed.dirs.includes(dirname(path))) void refetch()
  }, [changed, path, refetch])
  // In-flight state for one save, and the error it may leave behind — the only
  // two the tab does not carry (see `FileUiState`).
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  /** "Revert file" pressed over unsaved work, waiting on its confirm. */
  const [pendingRevert, setPendingRevert] = useState(false)
  /** The go-to-line prompt in the status bar (naru task 2743). */
  const [gotoOpen, setGotoOpen] = useState(false)
  /** What the last Replace all did, said beside its button. */
  const [replaceNote, setReplaceNote] = useState<string | null>(null)
  // The caret the status bar reports (task 809). Local, and not in
  // `FileUiState`: it describes where one live editor's cursor is, so it dies
  // with the mounted editor exactly as `saving` does. A freshly opened editor
  // autofocuses at offset 0, which is where this starts.
  const [caret, setCaret] = useState<CaretPosition>({ line: 1, col: 1 })
  // Find-in-file (task 809). Same lifetime as `caret` above, for the reason
  // `FindState` sets out. `find` itself is *derived* just below — a search
  // result landing in this pane overrides it until the user touches the bar,
  // which is what `setFind` records (task 813).
  const [findState, setFindState] = useState<FindState>(BLANK_FIND)
  const [consumedLanding, setConsumedLanding] = useState<number | null>(null)
  const editorRef = useRef<CodeEditorHandle>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Armed by `reveal` in view mode and consumed by the effect that measures the
  // mark — a flag rather than a dependency list, for the reason stated at both.
  const pendingReveal = useRef(false)
  // The last search result this pane actually scrolled to (task 813), so one
  // click reveals once however many times the pane re-renders after it — and
  // how many times the current one has been attempted without arriving, which
  // is what bounds the retry.
  const revealedLanding = useRef<number | null>(null)
  const landingTries = useRef(0)

  // Everything below is computed before the early returns, because hooks are:
  // `data` is still loading on the first renders, and a search over "" is a
  // search with no matches, which is exactly the right answer then.
  // The file as the editor holds it: the draft once there is one, else the
  // disk's content, LF either way (`normalizeNewlines` — CodeMirror reports
  // every offset against the LF form). `viewText` is the same thing for the
  // read-only renders, which show the bytes as fetched until a draft exists.
  const disk = useMemo(() => normalizeNewlines(data?.content ?? ''), [data])
  const draft = ui.editing ? ui.draft : disk
  const viewText = ui.editing ? ui.draft : (data?.content ?? '')
  const dirtyNow = isDirty(ui)
  // What may be typed in: text the server sent whole. Unsaved work keeps the
  // editor even if the file on disk has since become something that would not
  // have opened in one — the draft is the person's, and hiding it is losing it.
  const editable = data != null && ((!data.is_binary && !data.truncated) || dirtyNow)
  // The delimiter this file's language tag calls for, or null when it is not
  // one of the tabular kinds — server-derived, never sniffed (`fileCsv.ts`).
  const csvDelimiter = delimiterFor(data?.language ?? null)
  // The types with a rendered view. Decided by what the file *is*, never by
  // what its text currently parses to, so typing cannot flip the pane between
  // the editor and a preview.
  const renderable =
    data != null &&
    (isImagePath(data.path) ||
      data.language === 'markdown' ||
      isHtmlDocumentPath(data.path) ||
      csvDelimiter !== null)
  /** Whether the body is the editor: an editable file, and for a rendered
   * type only once its Source toggle is on. */
  const showEditor = editable && (!renderable || ui.source)
  /** ...and actually on screen — a picked commit's diff takes its place. */
  const editorUp = showEditor && ui.selectedCommit === null
  const searchText = showEditor ? draft : viewText
  /**
   * The parsed table, or null when this file is not rendered as one — either it
   * is not tabular, or the text has no table in it (`parseDelimited`'s
   * degenerate cases), in which case the preview falls back to the plain text
   * render below. Computed here rather than inside `CsvBody` because two
   * things need the answer: which branch of `body` runs, and whether the find
   * bar has offsets to point at. Not parsed while the editor is up.
   */
  const csvTable = useMemo(
    () =>
      csvDelimiter === null || data == null || data.is_binary || showEditor
        ? null
        : parseDelimited(viewText, csvDelimiter, MAX_CSV_ROWS),
    [csvDelimiter, data, showEditor, viewText],
  )
  // Where a search is even meaningful: over text this pane is showing *as
  // text*. A binary or an image has no offsets; a commit's diff is another
  // revision's bytes, not these; and a markdown file's preview is rendered
  // prose whose paragraphs no longer correspond to source offsets — there the
  // key is deliberately left to the browser's own find, which works on exactly
  // what is painted. An HTML document's preview is the same case one step
  // further (mesa task 1249): it is a rendered page, and inside a sandboxed
  // frame at that. In the editor any of them is source, and findable.
  const findable =
    data != null &&
    ui.selectedCommit === null &&
    (showEditor ||
      (!data.is_binary &&
        !isImagePath(data.path) &&
        data.language !== 'markdown' &&
        !isHtmlDocumentPath(data.path) &&
        csvTable === null))
  /**
   * A project-search result the user clicked, still waiting to be shown
   * (task 813): the pane is displaying the file, the reader is looking for the
   * line, and nothing they have done since says otherwise.
   *
   * It stops being active the moment the bar is touched — every write to the
   * find state goes through `setFind` below, which records the landing as
   * consumed — so this is "the search panel's answer, until you take over",
   * not a mode. It also needs the fetch to have landed, since the line is an
   * offset into content that may not be here yet.
   *
   * And it needs the file to be **findable**: a binary, an image or markdown
   * rendered as prose has no offsets to point at, so there the click is just
   * "open this file". That is a condition rather than a discard, which has one
   * consequence worth naming: switching a markdown file opened from a result
   * to Source makes it findable, and the landing takes effect then — the
   * first moment there is something to point at.
   */
  const landingActive =
    landing !== null && landing.seq !== consumedLanding && data != null && findable
  /**
   * The bar's state: normally the state above, and a landing's own while one
   * is active.
   *
   * Derived rather than written into state from an effect, which is the same
   * choice `blocked` is in the store and `findOpen` is two lines down: an
   * effect would paint the top of the file first and jump a frame later, and
   * it would have to decide what "the same result clicked twice" means. Here
   * that falls out — a fresh `seq` is not the consumed one, so the derivation
   * simply answers differently.
   */
  const find: FindState = landingActive
    ? {
        open: true,
        // The caret stays with the panel the reader is clicking through; the
        // bar is here to be stepped, not typed in, until they say otherwise.
        autoFocus: false,
        query: landing.query,
        caseSensitive: landing.caseSensitive,
        wholeWord: landing.wholeWord,
        // The panel's search is literal; the replace row is the person's own.
        regex: false,
        replaceOpen: findState.replaceOpen,
        replacement: findState.replacement,
        index: -1,
        // The line becomes an anchor through the same function the status bar
        // counts lines with — so "which match" is `matchIndexFrom`'s ordinary
        // answer rather than a second rule about landings.
        anchor: offsetForLine(searchText, landing.line),
      }
    : findState
  /** Every write to the bar — typing, a toggle, a step, a close — and the one
   * place a landing is marked as taken over. They are the same event: the user
   * has said where they are now, so the panel's answer stops overriding it. */
  function setFind(next: FindState | ((prev: FindState) => FindState)) {
    // An updater resolves against the *derived* state, not the stored one:
    // `{...f}` there has to be what is on screen.
    setFindState(typeof next === 'function' ? next(find) : next)
    setConsumedLanding(landing?.seq ?? null)
  }
  // Whether the bar is actually *up*, which is what every reader below wants —
  // `find.open` alone is not it. The two part company on their own: switching
  // a markdown file from Source back to Preview makes it rendered prose, which
  // is not findable, and the flag would otherwise stay set behind a bar that is
  // no longer rendered. Deriving it once is what keeps the render, the Escape
  // routing and the highlights from each answering that question differently.
  const findOpen = findable && find.open
  // A closed bar searches for nothing, which is how the highlights go away
  // without a second flag deciding whether to paint them.
  const {
    matches,
    capped,
    error: findError,
  } = useMemo(
    () =>
      findMatches(searchText, findOpen ? find.query : '', {
        caseSensitive: find.caseSensitive,
        wholeWord: find.wholeWord,
        regex: find.regex,
      }),
    [searchText, findOpen, find.query, find.caseSensitive, find.wholeWord, find.regex],
  )
  // Clamped rather than trusted: the list shrinks under the index every time
  // the query grows a character. A landing has no index to clamp — it has a
  // line — so it asks the same question `runFind` asks: the first match at or
  // after the anchor, wrapping if there is none past it.
  const current = landingActive
    ? matchIndexFrom(matches, find.anchor, true)
    : matches.length === 0
      ? -1
      : Math.min(Math.max(find.index, 0), matches.length - 1)

  /** Search for `next`'s query/options from `anchor` and land on a match.
   *
   * Recomputes rather than reading the render's `matches`, because every caller
   * is changing one of the three inputs and needs the answer for the value it
   * is *setting*, not the one on screen. `findMatches` is a linear scan of a
   * string that is already in memory, so this is cheaper than the re-render it
   * triggers. */
  function runFind(next: FindState, forward: boolean) {
    const { matches: found } = findMatches(searchText, next.query, next)
    const index = matchIndexFrom(found, next.anchor, forward)
    setFind({ ...next, index })
    setReplaceNote(null)
    reveal(found[index])
  }

  /** Show a match. In the editor, the editor does it; in a viewer the work is the
   * effect below, because the highlight to measure does not exist in the DOM
   * until React has painted the new `current`.
   *
   * The viewer's half is therefore *armed* here rather than performed — a flag,
   * the same shape as `CodeEditor`'s own `pendingReveal`, and for the same
   * reason: a step is an event, and no value the effect could list reports one.
   * `matches` is a fresh array on every keystroke, so listing it scrolled the
   * pane back on every character typed; and `current` alone misses the
   * legitimate no-op step — `(0 + 1) % 1 === 0`, Enter on a one-match file —
   * which leaves the counter stepping while the view sits still, the exact
   * failure the reveal exists to prevent.
   *
   * Focus stays in the query box on purpose: Enter has to keep stepping, and a
   * editor that grabbed the caret on every step would swallow the next
   * character of the query. Closing the bar is what hands focus back
   * (`closeFind`), with this selection already in place and ready to be typed
   * over. */
  function reveal(match: FindMatch | undefined) {
    if (match === undefined) return
    if (showEditor) editorRef.current?.reveal(match.start, match.end)
    else pendingReveal.current = true
  }

  function openFind() {
    if (findOpen) {
      // Cmd+F on an open bar is "let me retype that", the browser's own
      // behaviour for its find bar. `select()` sets a selection range and does
      // NOT move focus, so the focus call is half of it and not a belt-and-
      // braces extra: the chord is deliberately allowed while the caret is in
      // the code (`shouldIgnoreFilesShortcut`), which is the case where the
      // characters typed next would otherwise land in the file.
      findInputRef.current?.focus()
      findInputRef.current?.select()
      return
    }
    runFind({ ...find, open: true, autoFocus: true, anchor: findAnchor() }, true)
  }

  // ...and the same selection when the bar comes *up*, which is the reopen the
  // branch above cannot reach: `closeFind` keeps the query, so the second
  // Cmd/Ctrl+F re-mounts the box with the previous one in it, and `autoFocus`
  // focuses without selecting — so typing appended (`foofoobar`) instead of
  // replacing. Cmd+F-then-type is the reflex the whole bar is for, and it is
  // the browser's own behaviour for its find bar. An effect rather than a call
  // in `openFind`, because on a fresh open the input does not exist until React
  // has rendered it.
  useEffect(() => {
    if (findOpen && find.autoFocus) findInputRef.current?.select()
  }, [findOpen, find.autoFocus])

  /** Where a fresh search starts from: what the user is looking at.
   *
   * Editing, that is the caret. Read-only there is no caret, so it is the first
   * line still on screen — measured off the pane's own scroll, since the code
   * and the scroller are both real elements here. Without it Cmd+F halfway down
   * a 2,000-line file lands on the first match at the *top* of the file and
   * `scrollIntoView` yanks the pane there, which is the opposite of what the
   * key was pressed for.
   *
   * "On screen" means *readable*, so the sticky block's own height counts as
   * scrolled-away too: `.files-content-top` covers the top of the scrollport
   * (two rows of code, more once the find bar itself is up), and without
   * subtracting it the anchor is the first line in the scrollport rather than
   * the first line the user can see — which is how a fresh Cmd+F could anchor
   * on, and land on, a match hidden behind the header.
   *
   * Anchored at 0 under soft wrap, and that is deliberate rather than a gap: a
   * wrapped logical line is several visual rows, so pixels-scrolled ÷
   * line-height counts rows and would overshoot into the file — the same reason
   * the gutter is hidden and the editor's reveal is measured rather than
   * calculated when wrap is on. Landing at the top is a worse anchor; landing
   * past what you were reading is a wrong one. */
  function findAnchor(): number {
    if (showEditor) return editorRef.current?.caretOffset() ?? 0
    const content = contentRef.current
    const code = content?.querySelector<HTMLElement>('.files-code-main')
    // `.files-content` is the scrolling pane body's only child (`FilePane`), so
    // its parent is the scrollport the line is or is not inside.
    const port = content?.parentElement
    if (wrap || content == null || code == null || port == null) return 0
    const header = content.querySelector<HTMLElement>('.files-content-top')
    const hidden =
      port.getBoundingClientRect().top -
      code.getBoundingClientRect().top +
      (header?.offsetHeight ?? 0)
    const line = lineAtScroll(hidden, parseFloat(getComputedStyle(code).lineHeight))
    return offsetForLine(searchText, line)
  }

  function closeFind() {
    setFind({ ...find, open: false, index: -1 })
    // Focus has to land somewhere deliberate: the query box is unmounted while
    // it holds the caret, and a control that disappears focused drops focus on
    // `<body>` — Tab then restarts at the top of the page and Escape reads as
    // having done nothing at all. Editing, the code is where it belongs, with
    // the last match still selected in it and ready to be typed over. In view
    // mode there is no control to hand it to, so the content column takes it
    // (`tabIndex={-1}`, focusable only programmatically) and Tab carries on
    // from the file the user was reading. `preventScroll` because this is a
    // hand-back, not a reveal — the pane is already where the reader left it.
    if (showEditor) editorRef.current?.focus()
    else contentRef.current?.focus({ preventScroll: true })
  }

  function stepFind(forward: boolean) {
    const index = stepMatch(matches, current, forward)
    // The anchor follows the step (`anchorAfterStep`): refining a query after
    // walking to the 5th match must narrow *there*, not throw the user back to
    // wherever the bar was opened. Only a step moves it — a fresh open still
    // anchors on what is on screen.
    setFind({ ...find, index, anchor: anchorAfterStep(matches, index, find.anchor) })
    reveal(matches[index])
  }

  /** Cmd/Ctrl+Alt+F (and Ctrl+H off macOS), or the bar's own toggle: the
   * replace row, over the editor only. Opening the bar with it puts the caret
   * in the query, as Cmd/Ctrl+F does; on a bar already up it goes to the
   * replacement — `FindBar` moves it there as the row appears, and the direct
   * call covers a row that was already showing. */
  function openReplace() {
    if (!findOpen) {
      runFind(
        { ...find, open: true, replaceOpen: true, autoFocus: true, anchor: findAnchor() },
        true,
      )
      return
    }
    // `index: current` on every write that is not a search: over a landing the
    // derived state has no index of its own, and writing its -1 back would
    // drop the match the reader was shown.
    setFind({ ...find, replaceOpen: true, index: current })
    replaceInputRef.current?.focus()
  }

  /** Replace the match the bar is on, then step to the next one — found in
   * the text as it is *after* the edit, from just past what was put in, so a
   * replacement that itself matches the query is not replaced again. */
  function replaceCurrent() {
    const match = matches[current]
    if (!showEditor || match === undefined) return
    const { edits } = replaceEdits(searchText, find.query, find.replacement, find, match)
    if (edits.length === 0) return
    editorRef.current?.applyEdits(edits)
    const anchor = edits[0].start + edits[0].text.length
    const { matches: found } = findMatches(applyEdits(searchText, edits), find.query, find)
    const index = matchIndexFrom(found, anchor, true)
    setFind({ ...find, index, anchor })
    setReplaceNote(null)
    const next = found[index]
    if (next !== undefined) editorRef.current?.reveal(next.start, next.end)
  }

  /** Replace every match — all of them, past the 2000 the bar will highlight
   * (`replaceEdits`) — as one editor transaction, so one undo restores the
   * file. The count said afterwards is the real one. */
  function replaceEverything() {
    if (!showEditor) return
    const { edits, error } = replaceEdits(searchText, find.query, find.replacement, find)
    if (error !== undefined) {
      setReplaceNote('Invalid regex')
      return
    }
    if (edits.length === 0) {
      setReplaceNote('Nothing to replace')
      return
    }
    editorRef.current?.applyEdits(edits)
    setFind({ ...find, index: -1 })
    setReplaceNote(`Replaced ${edits.length}`)
  }

  /** The go-to-line prompt's Enter: jump, and hand the caret to the code.
   * Input that is not a position leaves the prompt up to be corrected. */
  function goTo(input: string) {
    const offset = goToOffset(draft, input)
    if (offset === null) return
    setGotoOpen(false)
    editorRef.current?.reveal(offset, offset)
    editorRef.current?.focus()
  }

  // The editor takes the caret when the person opens or switches to this file
  // (`focusSeq`), once per request: taking it clears the request, so a later
  // remount of this file, or a click on this pane's own find bar, is not
  // answered by the caret jumping into the code. No dependency list: the
  // editor mounts when the fetch lands, which is no value this could name.
  useEffect(() => {
    if (focusSeq === 0 || !editorUp || editorRef.current === null) return
    editorRef.current.focus()
    onFocusTaken()
  })

  // The keystrokes the Files tab takes off the browser: Cmd/Ctrl+F, and over
  // the editor Cmd/Ctrl+Alt+F (replace; also Ctrl+H off macOS, where that
  // chord is not the editor's own delete-backward) and Ctrl+G (go to line —
  // Ctrl on every platform, since Cmd+G is the browser's find-next). Scoped three ways
  // before it is claimed: this pane must be the focused one, the file must be
  // findable at all, and `shouldIgnoreFilesShortcut` must agree the caret is not
  // somewhere with a better claim (a task modal's field, the tree's naming
  // row). `preventDefault` fires only after all three pass, so everywhere else
  // in the app Cmd/Ctrl+F still opens the browser's own find.
  //
  // No dependency array: the handler closes over the live query and anchor, and
  // listing them would be listing most of this component's state. One
  // add/remove of one cheap listener per render is the smaller price.
  useEffect(() => {
    if (!focused || !findable) return
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the bar from anywhere over a viewer, not only from the
      // query box: the option and step buttons are focusable, and clicking one
      // used to leave the key answered by nothing at all. Over the editor its
      // own `onCancel` already closes the bar and this must not race that.
      if (e.key === 'Escape' && findOpen && !showEditor) {
        if (shouldIgnoreFilesShortcut(e, 'find')) return
        e.preventDefault()
        closeFind()
        return
      }
      const mod = e.metaKey || e.ctrlKey
      if (showEditor && !e.shiftKey && !e.getModifierState('AltGraph')) {
        const plain = e.ctrlKey && !e.metaKey && !e.altKey
        if (plain && (e.key === 'g' || e.key === 'G')) {
          if (shouldIgnoreFilesShortcut(e, 'goto')) return
          e.preventDefault()
          setGotoOpen(true)
          return
        }
        // `code`, not `key`: Alt+F on macOS *is* the character `ƒ`.
        if (
          (mod && e.altKey && e.code === 'KeyF') ||
          (!IS_MAC && plain && (e.key === 'h' || e.key === 'H'))
        ) {
          if (shouldIgnoreFilesShortcut(e, 'replace')) return
          e.preventDefault()
          openReplace()
          return
        }
      }
      if (!mod || e.altKey) return
      // Cmd/Ctrl+**Shift**+F is "find in files" everywhere it is bound, and on
      // some setups a browser or extension chord — swallowing it to open the
      // in-file bar is claiming a key this tab was never offered.
      if (e.shiftKey) return
      if (e.key !== 'f' && e.key !== 'F') return
      if (shouldIgnoreFilesShortcut(e, 'find')) return
      e.preventDefault()
      openFind()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // The viewer's scroll-into-view, consuming what `reveal` armed — no
  // dependency list, for the reason spelled out there and in `CodeEditor`'s
  // twin of this effect.
  //
  // *Vertically* this one can be a real `scrollIntoView`, unlike the editor's:
  // the current match is a real element in the highlight layer, so the browser
  // is the thing that knows where it ended up — no line arithmetic, and it is
  // correct with soft wrap on as much as off. What the browser will not do is
  // *not* scroll: `block: 'center'` re-centres unconditionally, so stepping
  // between two matches a screenful apart threw the file by half a pane on every
  // Enter while the editor, whose reveal scrolls to the `nearest` edge and so
  // leaves a match already in view alone, sat still on the same keystroke. Asking
  // first (`boxNeedsReveal`) is what makes the two panes answer alike. The band
  // it is asked about is not the scrollport: `.files-content-top` is pinned over
  // its top and the status bar over its bottom, and a match painted under either
  // is not one the reader can see — the vertical twin of the gutter lead-in
  // below. `block: 'nearest'` is not that answer, since it would land the match
  // flush at the scrollport's top edge, i.e. behind the header.
  //
  // Sideways it cannot be a `scrollIntoView` at all, and that is not a second
  // answer to the same question but the one thing the call does not know:
  // `.files-code-gutter` is `position: sticky` over the left edge of
  // `.files-code-scroll`, and `inline: 'nearest'` aligns a match lying left of
  // the current view flush to that edge — under the numbers, with the counter
  // and the `.current` class both reporting success. It is the same overlay the
  // editor's `scrollLeftForBox` lead-in exists for, so it is the same call: the
  // scroller has a real `scrollLeft`, the gutter a real `offsetWidth` and
  // `.files-code-main` the same 0.5rem channel past it the editor's computed
  // `padding-left` already includes — so a match revealed from the left arrives
  // with a column of code beside it in *both* panes, rather than abutting the
  // numbers in one of them. Measured off rects rather than `offsetLeft` because
  // the mark's offset parent is `.files-code-main`, one box in from the
  // scroller.
  //
  // A **landing** arms it too (task 813), and by the same kind of flag rather
  // than by watching `landing`: the pane is being *rendered* with the panel's
  // answer in place (`landingActive`), and the mark to measure exists only
  // after that render — which is exactly the state this effect already exists
  // to handle. `revealedLanding` is the once-per-`seq` guard; a second click on
  // the same result is a new `seq` and reveals again, while an unrelated
  // re-render (a keystroke elsewhere, a resize) is the same one and does not.
  // Over the editor there is no mark to measure and the editor does it, which
  // is the one branch that leaves this effect early.
  useEffect(() => {
    const landed =
      landingActive && current >= 0 && revealedLanding.current !== landing.seq
    if (!pendingReveal.current && !landed) return
    pendingReveal.current = false
    // Over the editor there is no mark of this pane's to measure and the
    // editor does its own reveal — the branch a landing takes, since `reveal`
    // could not call an editor that was not mounted yet.
    if (showEditor) {
      if (landed) revealedLanding.current = landing.seq
      const match = matches[current]
      if (match !== undefined) editorRef.current?.reveal(match.start, match.end)
      return
    }
    const content = contentRef.current
    const mark = content?.querySelector<HTMLElement>('.files-find-hit.current')
    if (content == null || mark == null || !findOpen || current < 0) {
      return
    }
    // `.files-content` is the scrolling pane body's only child (`FilePane`), so
    // its parent is the scrollport the sticky bars are pinned inside.
    const port = content.parentElement
    const band = port?.getBoundingClientRect()
    /** The readable band, in the mark's own coordinates. */
    const readable = (): [number, number] | null => {
      if (band === undefined) return null
      const head = content.querySelector<HTMLElement>('.files-content-top')
      const status = content.querySelector<HTMLElement>('.files-status-bar')
      return [
        band.top + (head?.offsetHeight ?? 0),
        band.bottom - (status?.offsetHeight ?? 0),
      ]
    }
    const bounds = readable()
    if (bounds !== null) {
      const box = mark.getBoundingClientRect()
      if (boxNeedsReveal(box.top, box.height, bounds[0], bounds[1])) {
        mark.scrollIntoView({ block: 'center', inline: 'nearest' })
      }
    }
    // A landing is marked done only once the match has actually **arrived** in
    // the readable band — not when the attempt was made.
    //
    // The step case is armed by a call and lands on a pane that is already
    // laid out; a landing is armed by a *render* of a pane that is usually
    // mounting, and on a large file that first pass can measure a layout the
    // browser has not settled — the scroll is issued and nothing moves.
    // Consuming on the attempt turns that into a permanent silent miss ("the
    // counter stepped and the view sat still", the failure this whole reveal
    // exists to prevent), so instead the next render tries again. Bounded by
    // `MAX_LANDING_REVEALS` rather than by the check alone, so a file the band
    // can never contain (a match taller than the pane) cannot re-scroll on
    // every unrelated render for as long as the landing is active.
    if (landed) {
      const after = mark.getBoundingClientRect()
      const settled =
        bounds === null || !boxNeedsReveal(after.top, after.height, bounds[0], bounds[1])
      landingTries.current = settled ? 0 : landingTries.current + 1
      if (settled || landingTries.current >= MAX_LANDING_REVEALS) {
        revealedLanding.current = landing.seq
        landingTries.current = 0
      }
    }
    const scroller = mark.closest<HTMLElement>('.files-code-scroll')
    if (scroller === null) return
    const gutter = scroller.querySelector<HTMLElement>('.files-code-gutter')
    const main = mark.closest<HTMLElement>('.files-code-main')
    const channel = main === null ? 0 : parseFloat(getComputedStyle(main).paddingLeft)
    // After the call above, so the rect is read against the scroll position it
    // left behind rather than the one before it.
    const box = mark.getBoundingClientRect()
    const rect = scroller.getBoundingClientRect()
    scroller.scrollLeft = scrollLeftForBox(
      box.left - rect.left + scroller.scrollLeft,
      box.width,
      scroller.clientWidth,
      scroller.scrollLeft,
      (gutter?.offsetWidth ?? 0) + (Number.isFinite(channel) ? channel : 0),
    )
  })

  // A failed *re*-read (the file deleted underneath, the server gone) is said
  // inline below, over whatever is already on screen: replacing the pane with
  // the error would hide a draft the person may still want to copy out.
  //
  // The same holds when there is nothing on screen yet — a tab switched back
  // to after its file was deleted mounts with no data and a read that fails.
  // The draft is all there is to show, so it is shown, still editable, with
  // the error over it.
  if (!data) {
    if (!error) return <p className="muted">Loading…</p>
    if (!dirtyNow) return <p className="error">{error}</p>
    return (
      <div className="files-content">
        <p className="error">{error}</p>
        <p className="muted">Your unsaved edits to {basename(path)} are below.</p>
        <CodeEditor
          value={ui.draft}
          language={languageOfName(basename(path))}
          onChange={(next) => onUi({ draft: next })}
          autoFocus={false}
          wrap={wrap}
        />
      </div>
    )
  }

  const { historyOpen, selectedCommit } = ui
  // Re-asked every render: once the buffer is clean there is nothing to
  // confirm, and a prompt left armed behind that would re-mount — autofocused
  // button and all — the moment the next character is typed.
  if (pendingRevert && !dirtyNow) setPendingRevert(false)
  // The prompt lives in the status bar, which a commit's diff hides; it must
  // not be waiting there, open, when the diff closes.
  if (gotoOpen && !editorUp) setGotoOpen(false)
  /** Unsaved work the disk has moved under. Derived, so it clears itself by
   * any route that resolves it: a save, a revert, either answer below, or the
   * draft coming to say what the disk does. */
  const conflict = ui.seenDisk !== null && diskChange(ui, ui.seenDisk) === 'conflict'

  function closeHistory() {
    onUi({ historyOpen: false, selectedCommit: null })
  }

  /** "Revert file": drop the draft and read the disk again. Over unsaved work
   * it asks first (`RevertConfirmBar`); over a clean buffer it is a reload. */
  function revert() {
    setPendingRevert(false)
    setSaveError(null)
    onUi(NO_DRAFT)
    void refetch()
    // The confirm's button is unmounted with the caret in it; hand it to the
    // pane rather than dropping it on `<body>` (the same hand-back, and the
    // same target, as `closeFind`'s). Not the editor: on a phone that would
    // raise the keyboard for a tap on a button.
    contentRef.current?.focus({ preventScroll: true })
  }

  async function save() {
    // Nothing to write: no draft, or a draft that is what the disk holds.
    if (saving || !dirtyNow) return
    if (conflict) {
      // Never an accidental overwrite: the bar's "Keep mine" is how the
      // person says the disk's version is the one to lose.
      setSaveError(CHANGED_ON_DISK)
      return
    }
    const saved = ui.draft
    setSaving(true)
    setSaveError(null)
    try {
      // Look before writing: a change on disk the watch stream has not
      // delivered yet (or never will, if it is down) must not be overwritten
      // by a save that could not have known. A read that fails is not an
      // answer either way — the write below reports the same failure.
      const fresh = await getProjectFilesContent(projectId, path).then(
        (d) => normalizeNewlines(d.content),
        () => null,
      )
      if (fresh !== null && fresh !== ui.baseline && fresh !== saved) {
        onUi({ seenDisk: fresh })
        setSaveError(CHANGED_ON_DISK)
        return
      }
      // The read took a round trip, and the draft may not be what it was:
      // reverted or reloaded away (nothing left to save — writing it now
      // would undo the answer just given), or put in conflict by a read that
      // landed meanwhile. More typing is fine: what was asked for is saved,
      // and the rest stays dirty.
      const now = live.current.ui
      if (!now.editing) return
      if (now.seenDisk !== null && diskChange(now, now.seenDisk) === 'conflict') {
        setSaveError(CHANGED_ON_DISK)
        return
      }
      await updateProjectFilesContent(projectId, path, saved)
      // What was sent *is* the file now, so the baseline moves onto it, which
      // is what makes the tab read clean (`fileDirty.ts`) — unless more was
      // typed while the request was out, which stays unsaved. Nothing else
      // moves: the caret, the scroll and the find bar are where they were.
      onUi((prev) => ({ baseline: saved, seenDisk: saved, saves: prev.saves + 1 }))
      void refetch()
    } catch (e) {
      // The draft is untouched: a 422 or a 404 is said inline and the work
      // stays in the editor.
      setSaveError(e instanceof ApiError ? e.message : 'Failed to save file.')
    } finally {
      setSaving(false)
    }
  }

  /** Saves the file to disk as its real bytes (task 683). `fetch` + a blob
   * rather than an `<a href>`: a 404/422 must render in this pane, not
   * navigate the SPA away to a JSON error page — and the bytes have to come
   * from the download route, since `data.content` is blank for a binary file
   * and short for a truncated one. */
  async function download() {
    setDownloading(true)
    setSaveError(null)
    const failure = await downloadProjectFile(projectId, path)
    if (failure !== null) setSaveError(failure)
    setDownloading(false)
  }

  // The file itself, in whichever form applies. Pulled out of the JSX below
  // because history mode renders it in a narrower column beside the commit
  // list — and swaps it for a commit's diff once one is picked.
  const body = showEditor ? (
    <CodeEditor
      value={draft}
      language={data.language}
      // The first keystroke is what makes a draft: it starts from the disk
      // content the editor was showing, which is also its baseline.
      //
      // And a draft that comes back to nothing worth keeping while the disk
      // has moved (undo, under an unanswered "changed on disk") is dropped
      // like any clean one, so the pane never sits on old text with nothing
      // to save.
      onChange={(next) =>
        onUi((prev) => {
          const typed = prev.editing
            ? { draft: next }
            : { editing: true, draft: next, baseline: disk }
          return prev.seenDisk !== null &&
            diskChange({ ...prev, ...typed }, prev.seenDisk) === 'reload'
            ? NO_DRAFT
            : typed
        })
      }
      // Never on mount: opening a file on a phone must not raise the
      // keyboard, and a page load must not put the caret in a file. The
      // `focusSeq` effect above is what focuses it, when asked.
      autoFocus={false}
      // Escape closes the find bar when one is up — stepping matches leaves the
      // caret in the code, so this is where the key usually lands mid-search.
      // With no bar it is not this pane's key at all: there is no mode to
      // leave, and the editor keeps its own Escape (collapse a multi-cursor
      // selection, arm the Tab hatch).
      onCancel={findOpen ? closeFind : undefined}
      onSave={save}
      wrap={wrap}
      onCaret={setCaret}
      matches={matches}
      current={current}
      ref={editorRef}
    />
  ) : isImagePath(data.path) ? (
    // Ahead of the binary branch, so the one image test covers both halves of
    // the allowlist uniformly: a raster arrives as `is_binary` with blank
    // content, an `.svg` arrives as ordinary text. Neither is displayable as
    // its bytes; both are displayable as an image. Keyed on the path so the
    // load-error state below can't leak from one file into the next.
    <FileImageBody
      key={data.path}
      projectId={projectId}
      path={data.path}
      zoomStore={imageZoom}
    />
  ) : mediaKindForPath(data.path) !== null ? (
    // Video/audio (naru task 1751): same raw route, native controls. Keyed on
    // the path so the error fallback can't leak into the next file.
    <FileMediaBody
      key={data.path}
      projectId={projectId}
      path={data.path}
      kind={mediaKindForPath(data.path) ?? 'video'}
    />
  ) : data.is_binary ? (
    <p className="muted">Binary file — cannot display.</p>
  ) : data.language === 'markdown' ? (
    // The previews render the draft once there is one, so Preview shows what
    // Source holds rather than what was last saved.
    <MarkdownBody
      projectId={projectId}
      path={data.path}
      content={viewText}
      wrap={wrap}
    />
  ) : isHtmlDocumentPath(data.path) ? (
    // Keyed on the path rather than on `data.language` — see
    // `isHtmlDocumentPath`, which is the whole reason that predicate exists:
    // `.vue`/`.svelte`/`.astro` are tagged `html` too and keep the code view.
    <HtmlBody content={viewText} />
  ) : csvTable !== null ? (
    // A table is the *preview* of a delimited file; its Source toggle is the
    // editor branch above — there is no cell editing. A file `parseDelimited`
    // finds no table in falls through to `FileCode` below.
    <CsvBody table={csvTable} fileTruncated={data.truncated} />
  ) : (
    <FileCode
      content={viewText}
      language={data.language}
      wrap={wrap}
      numbered
      matches={matches}
      current={current}
    />
  )

  return (
    // `tabIndex={-1}`: not in the tab order, but a place `closeFind` can put
    // focus back when the bar it was in disappears (see there).
    // `is-table` only where the table branch renders: that view's own box is
    // the scroller (so its sticky header pins), and it needs a *bounded* column
    // to fill. See the class's rule in App.css.
    <div
      className={`files-content${
        csvTable !== null
          ? ' is-table'
          : !showEditor && !historyOpen && isImagePath(data.path)
            ? ' is-image'
            : ''
      }`}
      ref={contentRef}
      tabIndex={-1}
    >
      {/* Header and find bar in one sticky block, so the bar cannot scroll
          away from the file it is searching — two independently sticky rows
          would have to agree on each other's height to stack. */}
      <div className="files-content-top">
        <p className={`files-content-header ${accentClass(data.language)}`}>
          <span className="files-content-path">{data.path}</span>
          {data.language !== null && (
            <span className="badge files-lang-badge">{data.language}</span>
          )}
          {data.truncated && (
            <span className="badge files-truncated-badge">truncated</span>
          )}
          <span className="files-header-actions">
            {editable && (
              <button
                className="files-edit-btn"
                onClick={save}
                disabled={saving || !dirtyNow}
                title="Save (Cmd/Ctrl+S)"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
            {/* Discard the draft and read the disk again. Two steps when there
             * is a draft to lose (`RevertConfirmBar`). */}
            {editable && (
              <button
                className="files-edit-btn"
                onClick={() => (dirtyNow ? setPendingRevert(true) : revert())}
                disabled={saving}
              >
                Revert file
              </button>
            )}
            {/* A rendered type's two views. Named for where it goes, and
             * remembered per tab (`FileUiState.source`). */}
            {editable && renderable && (
              <button
                className="files-edit-btn"
                onClick={() => onUi({ source: !ui.source })}
              >
                {ui.source ? 'Preview' : 'Source'}
              </button>
            )}
            <button
              className="files-edit-btn"
              onClick={() =>
                historyOpen ? closeHistory() : onUi({ historyOpen: true })
              }
            >
              {historyOpen ? 'Hide history' : 'History'}
            </button>
            {/* Offered for EVERY file — a binary or truncated file is exactly
             * the case the viewer can show nothing useful for. A real <button>
             * because the app's button chrome hangs off the `button` element
             * selector in index.css; an <a download> would need all of it
             * duplicated. */}
            <button
              className="files-edit-btn"
              onClick={download}
              disabled={downloading}
            >
              {downloading ? 'Downloading…' : 'Download'}
            </button>
          </span>
        </p>
        {/* Under the header rather than over the file, for the reason the
            close prompt is under the tab strip: pushing the content down is
            what makes it impossible to miss. */}
        {pendingRevert && dirtyNow && (
          <RevertConfirmBar
            path={data.path}
            onConfirm={revert}
            onCancel={() => {
              setPendingRevert(false)
              contentRef.current?.focus({ preventScroll: true })
            }}
          />
        )}
        {/* The disk moved under unsaved work (naru task 2743). Neither button
            is autofocused: this bar arrives unasked, mid-typing, and must not
            take the caret out of the code. */}
        {conflict && (
          <div className="files-close-confirm confirm-delete" role="alert">
            <span className="confirm-message">
              {basename(data.path)} changed on disk.
            </span>
            <button
              className="danger"
              onClick={() => {
                setSaveError(null)
                onUi(NO_DRAFT)
                void refetch()
              }}
            >
              Reload (discard my edits)
            </button>
            <button
              onClick={() => {
                setSaveError(null)
                // The disk's version is now the one this draft is measured
                // against — and the one the next save overwrites.
                onUi({ baseline: ui.seenDisk ?? ui.baseline })
              }}
            >
              Keep mine
            </button>
          </div>
        )}
        {findOpen && (
          <FindBar
            query={find.query}
            caseSensitive={find.caseSensitive}
            wholeWord={find.wholeWord}
            regex={find.regex}
            label={
              findError !== undefined
                ? 'Invalid regex'
                : matchLabel(current, matches.length, capped)
            }
            takeFocus={find.autoFocus}
            inputRef={findInputRef}
            onSearch={(patch) => runFind({ ...find, ...patch }, true)}
            onStep={stepFind}
            onClose={closeFind}
            replaceInputRef={replaceInputRef}
            replace={
              // Replace is an edit, so it exists only over the editor.
              showEditor
                ? {
                    open: find.replaceOpen,
                    text: find.replacement,
                    note: replaceNote,
                    hasMatch: current >= 0,
                    onToggle: () =>
                      setFind({ ...find, replaceOpen: !find.replaceOpen, index: current }),
                    onText: (text) => setFind({ ...find, replacement: text, index: current }),
                    onOne: replaceCurrent,
                    onAll: replaceEverything,
                  }
                : null
            }
          />
        )}
      </div>
      {error && error !== saveError && <p className="error">{error}</p>}
      {saveError && <p className="error">{saveError}</p>}
      {historyOpen ? (
        <div className="files-history-layout">
          <FileHistoryPane
            projectId={projectId}
            path={path}
            selected={selectedCommit}
            onSelect={(commit) => onUi({ selectedCommit: commit })}
          />
          <div className="files-history-main">
            {selectedCommit !== null ? (
              <CommitSideBySidePane
                projectId={projectId}
                commit={selectedCommit}
                path={path}
                onBack={() => onUi({ selectedCommit: null })}
              />
            ) : (
              body
            )}
          </div>
        </div>
      ) : (
        body
      )}
      {/* Not over a commit's diff: the bar describes the file on disk, and
          beside another revision's diff its counts would be a lie. Not for a
          binary or an image either — neither has lines. */}
      {selectedCommit === null && !data.is_binary && !isImagePath(data.path) && (
        <FileStatusBar
          editing={editorUp}
          caret={caret}
          lines={showEditor ? lineCount(draft) : viewerLineCount(viewText)}
          language={data.language}
          wrap={wrap}
          onWrapChange={onWrapChange}
          gotoOpen={gotoOpen}
          onGotoOpen={() => setGotoOpen(true)}
          onGoto={goTo}
          onGotoClose={(refocus) => {
            setGotoOpen(false)
            if (refocus) editorRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

/** The pane's status bar (task 809): where the caret is, how long the file is,
 * what language it is being read as, and the wrap toggle.
 *
 * The caret is shown only over the editor, because that is the only state
 * where there is one — a read-only `<pre>` has a selection at most, and a "Ln
 * 1, Col 1" that never moved would read as a broken indicator rather than an
 * absent one. The line count is the one the gutter beside it was built from,
 * so the bar and the last number in the gutter can never disagree.
 *
 * The caret readout is also the way into **go to line** (naru task 2743): a
 * click, or Ctrl+G, swaps it for a small prompt taking `line` or
 * `line:column`. Enter jumps (`goToLine.ts` decides where) and Escape hands
 * the caret back to the code; clicking away just closes it. */
function FileStatusBar({
  editing,
  caret,
  lines,
  language,
  wrap,
  onWrapChange,
  gotoOpen,
  onGotoOpen,
  onGoto,
  onGotoClose,
}: {
  editing: boolean
  caret: CaretPosition
  lines: number
  language: string | null
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
  gotoOpen: boolean
  onGotoOpen: () => void
  onGoto: (input: string) => void
  /** `refocus`: whether the caret goes back to the code (Escape) or is left
   * wherever the person just put it (a click away). */
  onGotoClose: (refocus: boolean) => void
}) {
  return (
    <div className="files-status-bar">
      {editing &&
        (gotoOpen ? (
          <input
            autoFocus
            className="files-goto-input"
            placeholder="line or line:column"
            aria-label="Go to line"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onGoto(e.currentTarget.value)
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onGotoClose(true)
              }
            }}
            onBlur={() => onGotoClose(false)}
          />
        ) : (
          <button
            type="button"
            className="files-goto-btn"
            title="Go to line (Ctrl+G)"
            onClick={onGotoOpen}
          >
            Ln {caret.line}, Col {caret.col}
          </button>
        ))}
      <span>
        {lines} {lines === 1 ? 'line' : 'lines'}
      </span>
      <span>{language ?? 'plain text'}</span>
      <button
        type="button"
        className="files-edit-btn files-wrap-btn"
        aria-pressed={wrap}
        onClick={() => onWrapChange(!wrap)}
      >
        Wrap: {wrap ? 'on' : 'off'}
      </button>
    </div>
  )
}

/** The replace row's props (naru task 2743): its state, and the two actions. */
interface ReplaceControls {
  open: boolean
  text: string
  /** What the last Replace all did ("Replaced 12"), or null. */
  note: string | null
  /** Whether there is a current match for Replace to act on. */
  hasMatch: boolean
  onToggle: () => void
  onText: (text: string) => void
  onOne: () => void
  onAll: () => void
}

/** Find-in-file's controls (task 809): the query box, the counter, the
 * option toggles and the step/close buttons — and, over the editor, the
 * replace row under them (naru task 2743).
 *
 * Presentational on purpose — it decides nothing. Which match is current, what
 * the counter says and where the view scrolls to are all `fileFind.ts` and
 * `ContentPane`; this component turns a keystroke into one `onSearch`/`onStep`
 * call. That split is what lets the whole feature be unit-tested without
 * rendering a component.
 *
 * Enter/Shift+Enter step rather than submit: there is no form here, and Enter
 * is the one key every editor's find box binds. Escape closes, which is also
 * the editor's own discard binding — but the bar is a separate control, so a
 * keystroke aimed at it never reaches the editor underneath.
 *
 * **Every button hands the caret back to the query box** (`refocus`), which is
 * what keeps those two keys meaning what they say. Left alone, clicking `Aa`
 * moves focus to that button, and the next Enter re-toggles case sensitivity
 * instead of stepping — with Shift+Enter and Enter suddenly identical, and
 * Escape answered by nothing. VS Code keeps the caret in the box for exactly
 * this reason. The close button is the one exception: it is *leaving*, and the
 * caret it hands back belongs to the editor (`closeFind`). */
function FindBar({
  query,
  caseSensitive,
  wholeWord,
  regex,
  label,
  takeFocus,
  inputRef,
  onSearch,
  onStep,
  onClose,
  replace,
  replaceInputRef,
}: {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  /** Already-formatted "n of N" / "No results" — the arithmetic is
   * `matchLabel`'s, not this component's. */
  label: string
  /** Whether the query box takes the caret as the bar mounts. False for the
   * one open nobody asked for — a project-search result landing in this pane
   * (task 813), where the caret stays with the panel being clicked through. */
  takeFocus: boolean
  /** Held by the parent so a second Cmd/Ctrl+F can re-select the query. */
  inputRef: RefObject<HTMLInputElement | null>
  /** Any change that re-runs the search from the anchor. */
  onSearch: (patch: {
    query?: string
    caseSensitive?: boolean
    wholeWord?: boolean
    regex?: boolean
  }) => void
  onStep: (forward: boolean) => void
  onClose: () => void
  /** Null where there is nothing to replace in: a read-only view. */
  replace: ReplaceControls | null
  /** Held by the parent so the replace chord can put the caret there. */
  replaceInputRef: RefObject<HTMLInputElement | null>
}) {
  /** Do the thing, then put the caret back where the typing goes. */
  function refocus<T>(act: (arg: T) => void): (arg: T) => void {
    return (arg) => {
      act(arg)
      inputRef.current?.focus()
    }
  }
  // The replace row appearing on a bar that is already up takes the caret:
  // the person just asked for it. Not on the bar's own mount — there the
  // query box has it (`takeFocus`), which is where a fresh search starts.
  const replaceOpen = replace?.open ?? false
  const wasReplaceOpen = useRef(replaceOpen)
  useEffect(() => {
    if (replaceOpen && !wasReplaceOpen.current) replaceInputRef.current?.focus()
    wasReplaceOpen.current = replaceOpen
  }, [replaceOpen, replaceInputRef])
  return (
    <>
    <div className="files-find-bar">
      <input
        autoFocus={takeFocus}
        ref={inputRef}
        className="files-find-input"
        value={query}
        placeholder="Find"
        spellCheck={false}
        aria-label="Find in file"
        onChange={(e) => onSearch({ query: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onStep(!e.shiftKey)
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="files-find-count">{label}</span>
      {/* `aria-pressed` rather than a checkbox: these are toggle buttons in
          every editor that has them, and a checkbox would need a label the
          strip has no room for. */}
      <button
        type="button"
        className="files-find-toggle"
        aria-pressed={caseSensitive}
        title="Match case"
        onClick={refocus(() => onSearch({ caseSensitive: !caseSensitive }))}
      >
        Aa
      </button>
      <button
        type="button"
        className="files-find-toggle"
        aria-pressed={wholeWord}
        title="Whole word"
        onClick={refocus(() => onSearch({ wholeWord: !wholeWord }))}
      >
        |ab|
      </button>
      <button
        type="button"
        className="files-find-toggle"
        aria-pressed={regex}
        title="Regular expression"
        onClick={refocus(() => onSearch({ regex: !regex }))}
      >
        .*
      </button>
      <button
        type="button"
        className="files-find-toggle"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        onClick={refocus(() => onStep(false))}
      >
        ↑
      </button>
      <button
        type="button"
        className="files-find-toggle"
        aria-label="Next match"
        title="Next match (Enter)"
        onClick={refocus(() => onStep(true))}
      >
        ↓
      </button>
      {replace !== null && (
        <button
          type="button"
          className="files-find-toggle"
          aria-pressed={replace.open}
          title="Replace (Cmd/Ctrl+Alt+F)"
          onClick={replace.onToggle}
        >
          Replace
        </button>
      )}
      <button
        type="button"
        className="files-find-toggle"
        aria-label="Close find"
        title="Close (Escape)"
        onClick={onClose}
      >
        ×
      </button>
    </div>
    {replace !== null && replace.open && (
      <div className="files-find-bar files-replace-row">
        <input
          ref={replaceInputRef}
          className="files-find-input files-replace-input"
          value={replace.text}
          placeholder="Replace"
          spellCheck={false}
          aria-label="Replace with"
          onChange={(e) => replace.onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              replace.onOne()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        {/* `role="status"`: the count is the only report a Replace all gives,
            and it has to reach a screen reader as well as the eye. */}
        <span className="files-find-count" role="status">
          {replace.note ?? ''}
        </span>
        <button
          type="button"
          className="files-find-toggle"
          title="Replace this match (Enter)"
          disabled={!replace.hasMatch}
          onClick={() => {
            replace.onOne()
            replaceInputRef.current?.focus()
          }}
        >
          Replace
        </button>
        <button
          type="button"
          className="files-find-toggle"
          title="Replace every match"
          disabled={!replace.hasMatch}
          onClick={() => {
            replace.onAll()
            replaceInputRef.current?.focus()
          }}
        >
          Replace all
        </button>
      </div>
    )}
    </>
  )
}

/** Fetches a file from the download route and hands it to the browser as a
 * save. Returns the failure message (404, over the cap, network), or null on
 * success — shared by the content pane's Download and the tree row's. */
async function downloadProjectFile(projectId: number, path: string): Promise<string | null> {
  try {
    const resp = await fetch(projectFileDownloadUrl(projectId, path))
    if (!resp.ok) return await downloadErrorMessage(resp)
    const url = URL.createObjectURL(await resp.blob())
    const link = document.createElement('a')
    link.href = url
    link.download = basename(path)
    link.click()
    URL.revokeObjectURL(url)
    return null
  } catch {
    return 'Failed to download file.'
  }
}

/** The message out of a failed download response's `{"error": {code, message}}`
 * envelope — the same shape `request()` unwraps into an `ApiError`, re-read
 * here because this one call goes through raw `fetch` to keep the bytes out of
 * the JSON wrapper. A non-JSON or shapeless body falls back to a generic line
 * rather than showing the raw text. */
async function downloadErrorMessage(resp: Response): Promise<string> {
  const fallback = 'Failed to download file.'
  try {
    const body: unknown = await resp.json()
    const error =
      typeof body === 'object' && body !== null
        ? (body as { error?: { message?: unknown } }).error
        : undefined
    return typeof error?.message === 'string' ? error.message : fallback
  } catch {
    return fallback
  }
}

/** The selected file's own commit history, as a vertical pane beside the
 * content. Same three-rung empty-state ladder as GitView's HistoryPane —
 * quiet placeholders, never a hard error — plus a fourth rung this route
 * adds: an empty list means the file exists on disk but has no commits yet
 * (never committed), which is a state, not a failure. */
function FileHistoryPane({
  projectId,
  path,
  selected,
  onSelect,
}: {
  projectId: number
  path: string
  selected: GitCommit | null
  onSelect: (commit: GitCommit) => void
}) {
  const { data, error } = useFetch(
    () => getProjectGitFileLog(projectId, path),
    `files-log-${projectId}-${path}`,
  )
  if (error) return <div className="files-history-pane error">{error}</div>
  if (!data) return <div className="files-history-pane muted">Loading…</div>
  if (data.path === null || data.commits === null) {
    return (
      <div className="files-history-pane muted">
        No git repository for this project's folder.
      </div>
    )
  }
  if (data.commits.length === 0) {
    return (
      <div className="files-history-pane muted">
        No commits touch this file yet.
      </div>
    )
  }
  return (
    <ul className="card-list files-history-pane">
      {data.commits.map((c) => (
        <li
          key={c.hash}
          className={c.hash === selected?.hash ? 'selected' : ''}
          onClick={() => onSelect(c)}
        >
          <span className="badge git-status-badge">{c.short_hash}</span>
          <span className="git-file-path">{c.subject}</span>
          <div className="muted git-file-label">
            {c.author} · {c.date}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** One commit's change to the selected file, rendered old|new. Reuses the
 * Git tab's per-commit diff route verbatim — every commit `FileHistoryPane`
 * lists is one that route accepts for this path (that's why the server's
 * file log doesn't follow renames). */
function CommitSideBySidePane({
  projectId,
  commit,
  path,
  onBack,
}: {
  projectId: number
  commit: GitCommit
  path: string
  onBack: () => void
}) {
  const { data, error } = useFetch(
    () => getProjectGitCommitDiff(projectId, commit.hash, path),
    `files-commit-diff-${projectId}-${commit.hash}-${path}`,
  )
  return (
    <>
      <button type="button" className="git-back" onClick={onBack}>
        ← File
      </button>
      <p className="git-commit-summary">
        <span className="badge git-status-badge">{commit.short_hash}</span>{' '}
        {commit.subject}
      </p>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && <SideBySideDiff diff={data.diff} />}
    </>
  )
}

/** Markdown content, with a leading YAML frontmatter block (if any) split off
 * and rendered as a highlighted YAML panel instead of being fed to
 * react-markdown — untouched, it renders as two stray `<hr>`s around plain
 * paragraph text (`---` is a thematic break, not a block react-markdown
 * knows). */
function MarkdownBody({
  projectId,
  path,
  content,
  wrap,
}: {
  projectId: number
  path: string
  content: string
  /** The tab's soft-wrap preference, threaded through for the frontmatter
   * panel alone: the prose below it wraps whatever the toggle says, so a
   * frontmatter block scrolling sideways beside it is one pane rendering under
   * two wrap rules. It is still `numbered={false}` — an excerpt has no line
   * numbers — which is the one thing that stays asked-for explicitly here. */
  wrap: boolean
}) {
  const { frontmatter, body } = splitFrontmatter(content)
  // A relative `![alt](img/x.png)` in a repo file means "beside this file", so
  // resolution is anchored on the md file's own directory ("" at the root) and
  // the result goes through the raw route rather than the SPA's own URL space.
  // `resolveMarkdownImageSrc` answers null for everything that must not be
  // fetched (remote/data/protocol-relative sources, or a path escaping the
  // project root) — Markdown then renders the alt text inert.
  const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  const resolveImageSrc = useCallback(
    (src: string) => {
      const rel = resolveMarkdownImageSrc(dir, src)
      return rel === null ? null : projectFileRawUrl(projectId, rel)
    },
    [dir, projectId],
  )
  return (
    <div className="markdown-body">
      {frontmatter !== null && (
        <div className="files-frontmatter">
          <p className="files-frontmatter-label muted">Frontmatter</p>
          <FileCode content={frontmatter} language="yaml" wrap={wrap} />
        </div>
      )}
      <Markdown text={body} resolveImageSrc={resolveImageSrc} />
    </div>
  )
}

/** An HTML file rendered as the page it is (mesa task 1249) — the read view for
 * `.html`/`.htm`, the way `MarkdownBody` is the read view for `.md`. Edit mode
 * is the branch above, so pressing Edit still gives the raw source and Save or
 * Cancel comes straight back here.
 *
 * The document goes in through `srcDoc` under an **empty** `sandbox`: no
 * `allow-scripts`, no `allow-same-origin`, no `allow-top-navigation`. That is
 * deliberately stricter than the artifact render route, which grants
 * `allow-scripts` because an artifact is a mockup an agent wrote in order to be
 * run; this is an arbitrary file out of somebody's repo, opened to be read. An
 * empty sandbox also leaves the frame's origin opaque, so the page cannot
 * reach this one's DOM, storage or cookies.
 *
 * Truncation is the markdown treatment exactly: the header's `truncated` badge
 * is the whole statement and `editable` is already false there — a capped
 * document renders as far as its bytes got, as half a markdown file does.
 *
 * Relative `img`/`href` references do not resolve: the frame has no base URL of
 * its own, and nothing rewrites them the way `MarkdownBody` rewrites image
 * srcs. */
function HtmlBody({ content }: { content: string }) {
  return (
    <iframe
      className="files-content-html"
      title="Rendered HTML"
      sandbox=""
      srcDoc={content}
    />
  )
}

/** An image file, rendered as the image itself rather than as its bytes
 * (task 801) — the one file kind whose content view is not text. The bytes
 * come from the raw route via a plain `<img src>`, never through `fetch`: the
 * route is the only place they are served with an image mime, and keeping the
 * load in the element means the browser's own decoder is what interprets
 * them.
 *
 * `onError` covers everything the element cannot show — a file the server
 * refused, or bytes with an image extension that are not a decodable image —
 * with the same muted line the non-image binary branch uses, so a failure
 * reads as a state rather than as a broken-image icon. The parent keys this
 * component on the path, which is what resets the flag when the tab switches
 * files.
 *
 * Zoom and pan (naru task 2731): the image sits in a stage that clips it, and
 * `imageZoom.ts` decides the view — this component only measures the stage and
 * the image, routes events to it and applies the answer as a size and a
 * translate. The view is stored as `null` while the image is at fit, so a
 * fitted image refits when the pane is resized or split. It is written through
 * to the owning pane's `zoomStore`, which is what carries it across a tab
 * switch (this component is unmounted then). */
function FileImageBody({
  projectId,
  path,
  zoomStore,
}: {
  projectId: number
  path: string
  zoomStore: Map<string, ZoomView | null>
}) {
  const [failed, setFailed] = useState(false)
  const [view, setViewState] = useState<ZoomView | null>(() => zoomStore.get(path) ?? null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [stage, setStage] = useState<Size | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  // The latest of everything the native wheel listener and the pointer
  // handlers read, so they can be bound once rather than re-bound per render.
  const live = useRef<{ shown: ZoomView | null; natural: Size | null; stage: Size | null }>({
    shown: null,
    natural: null,
    stage: null,
  })

  const setView = useCallback(
    (asked: ZoomView | null) => {
      const { natural, stage } = live.current
      // A view that is the fit (a double-click on an image already at 100%,
      // a zoom-out clamped at a fit below 10%) is stored as fit, so it keeps
      // refitting as the pane resizes.
      const next =
        asked !== null && natural !== null && stage !== null && isFit(asked, natural, stage)
          ? null
          : asked
      zoomStore.set(path, next)
      setViewState(next)
      // Every view `imageZoom.ts` answers is already bounded, so it is what
      // will be on screen: record it now, so a second wheel or pointer event
      // landing before the re-render builds on this one instead of dropping it.
      live.current.shown =
        next === null && natural !== null && stage !== null
          ? resolveView(null, natural, stage)
          : next
    },
    [zoomStore, path],
  )

  useLayoutEffect(() => {
    const el = stageRef.current
    if (el === null) return
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [failed])

  const shown = natural !== null && stage !== null ? resolveView(view, natural, stage) : null

  const latestSetView = useRef(setView)
  useLayoutEffect(() => {
    live.current = { shown, natural, stage }
    latestSetView.current = setView
  })

  // Native and non-passive: React's `onWheel` is passive, and a passive
  // listener cannot stop Ctrl/Cmd + wheel (and a trackpad pinch, which arrives
  // as one) from zooming the whole page. Bound on the stage only, so browser
  // zoom everywhere else is untouched.
  useEffect(() => {
    const el = stageRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      const { shown, natural, stage } = live.current
      const setView = latestSetView.current
      if (shown === null || natural === null || stage === null) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const at = pointIn(el, e)
        setView(zoomAt(shown, shown.scale * wheelZoomFactor(e.deltaY, e.deltaMode), at, natural, stage))
        return
      }
      // A plain wheel / two-finger scroll pans — only once there is something
      // to pan to; a fitted image lets the wheel through.
      if (natural.w * shown.scale <= stage.w && natural.h * shown.scale <= stage.h) return
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.h : 1
      setView(panBy(shown, -e.deltaX * unit, -e.deltaY * unit, natural, stage))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [failed])

  // Pointers down on the stage: one drags the image, two (touch) pinch it.
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<
    | { kind: 'drag'; last: Point }
    | { kind: 'pinch'; start: ZoomView; distance: number; centre: Point }
    | null
  >(null)

  function startGesture() {
    const pts = [...pointers.current.values()]
    const { shown } = live.current
    if (pts.length === 1) gesture.current = { kind: 'drag', last: pts[0] }
    else if (pts.length === 2 && shown !== null)
      gesture.current = {
        kind: 'pinch',
        start: shown,
        distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        centre: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
      }
    else gesture.current = null
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, pointIn(e.currentTarget, e))
    startGesture()
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return
    const p = pointIn(e.currentTarget, e)
    pointers.current.set(e.pointerId, p)
    const g = gesture.current
    const { shown, natural, stage } = live.current
    if (g === null || shown === null || natural === null || stage === null) return
    if (g.kind === 'drag') {
      const dx = p.x - g.last.x
      const dy = p.y - g.last.y
      g.last = p
      if (dx !== 0 || dy !== 0) setView(panBy(shown, dx, dy, natural, stage))
    } else {
      const pts = [...pointers.current.values()]
      const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
      const centre = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
      setView(pinchView(g.start, g.distance, distance, g.centre, centre, natural, stage))
    }
  }

  function onPointerEnd(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(e.pointerId)) return
    // Lifting one finger of a pinch carries on as a drag from where it is.
    startGesture()
  }

  /** Zoom about the stage's centre — the buttons and the keys. */
  function zoomCentre(scale: number) {
    if (shown === null || natural === null || stage === null) return
    setView(zoomAt(shown, scale, { x: stage.w / 2, y: stage.h / 2 }, natural, stage))
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const action = zoomKeyAction(e)
    if (action === null || shown === null) return
    e.preventDefault()
    if (action === 'in') zoomCentre(stepScale(shown.scale, 1))
    else if (action === 'out') zoomCentre(stepScale(shown.scale, -1))
    else if (action === 'fit') setView(null)
    else zoomCentre(1)
  }

  function onDoubleClick(e: ReactMouseEvent<HTMLDivElement>) {
    if (shown === null || natural === null || stage === null) return
    if (isFit(shown, natural, stage)) setView(zoomAt(shown, 1, pointIn(e.currentTarget, e), natural, stage))
    else setView(null)
  }

  if (failed) return <p className="muted">Binary file — cannot display.</p>
  return (
    <div className="files-image-view">
      <div className="files-image-toolbar" role="toolbar" aria-label="Image zoom">
        <button
          type="button"
          className="files-image-btn"
          aria-label="Zoom out"
          title="Zoom out (-)"
          disabled={shown === null}
          onClick={() => shown && zoomCentre(stepScale(shown.scale, -1))}
        >
          −
        </button>
        <span className="files-image-percent" aria-live="polite">
          {shown === null ? '—' : zoomPercent(shown.scale)}
        </span>
        <button
          type="button"
          className="files-image-btn"
          aria-label="Zoom in"
          title="Zoom in (+)"
          disabled={shown === null}
          onClick={() => shown && zoomCentre(stepScale(shown.scale, 1))}
        >
          +
        </button>
        <button
          type="button"
          className="files-image-btn"
          title="Fit to pane (0)"
          disabled={shown === null}
          onClick={() => setView(null)}
        >
          Fit
        </button>
        <button
          type="button"
          className="files-image-btn"
          title="Actual size (1)"
          disabled={shown === null}
          onClick={() => zoomCentre(1)}
        >
          100%
        </button>
        {natural !== null && (
          <span className="files-image-dims">
            {natural.w} × {natural.h} px
          </span>
        )}
      </div>
      <div
        className={`files-image-stage${shown !== null && shown.scale > 1 ? ' is-pixelated' : ''}`}
        ref={stageRef}
        tabIndex={0}
        aria-label={`${basename(path)} — scroll with Ctrl or Cmd to zoom, drag to pan`}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
      >
        <img
          className="files-content-image"
          src={projectFileRawUrl(projectId, path)}
          alt={basename(path)}
          draggable={false}
          style={
            shown === null || natural === null
              ? { visibility: 'hidden' }
              : {
                  width: natural.w * shown.scale,
                  height: natural.h * shown.scale,
                  transform: `translate(${shown.x}px, ${shown.y}px)`,
                }
          }
          onLoad={(e) => setNatural(imageSize(e.currentTarget))}
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  )
}

/** A pointer's position in an element's own coordinates. */
function pointIn(el: Element, e: { clientX: number; clientY: number }): Point {
  const r = el.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

/** The loaded image's pixel size. An SVG with no width/height of its own can
 * report 0, which would leave nothing to scale: it is given the replaced
 * element default (300 × 150) instead. */
function imageSize(img: HTMLImageElement): Size {
  if (img.naturalWidth > 0 && img.naturalHeight > 0)
    return { w: img.naturalWidth, h: img.naturalHeight }
  return { w: 300, h: 150 }
}

/** A video or audio file played inline with the browser's native controls
 * (naru task 1751). `mov`/`m4a` depend on codec, so the element's `error`
 * event swaps in a short note with a download link rather than a dead player. */
function FileMediaBody({
  projectId,
  path,
  kind,
}: {
  projectId: number
  path: string
  kind: 'video' | 'audio'
}) {
  const [failed, setFailed] = useState(false)
  const src = projectFileRawUrl(projectId, path)
  if (failed) {
    return (
      <p className="muted">
        This browser cannot play this file.{' '}
        <a href={projectFileDownloadUrl(projectId, path)} download={basename(path)}>
          Download {basename(path)}
        </a>
      </p>
    )
  }
  return (
    <div className="files-content-image-wrap">
      {kind === 'video' ? (
        <video
          className="files-content-image"
          src={src}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
        />
      ) : (
        <audio src={src} controls preload="metadata" onError={() => setFailed(true)} />
      )}
    </div>
  )
}

/** A delimited file rendered as a table (mesa task 1110). The parse is the
 * parent's — see `csvTable` in `ContentPane` — so this component is the DOM
 * alone: a sticky header row over monospace cells, in a wrapper that scrolls
 * sideways rather than stretching the pane, the same treatment
 * `.files-content-image-wrap` gives an image.
 *
 * Ragged rows are padded and clipped to the header's width HERE rather than in
 * the parser: a `<tr>` shorter than the header slides every cell after it under
 * the wrong column, and a longer one widens the table past its own header.
 *
 * The note says what the view is short of — but only what is TRUE. `table.total`
 * counts the rows in the text this pane was given, and the content route caps
 * that at `FILE_CONTENT_CAP`: on a `truncated` file it is the row count of the
 * first 256 KiB, not of the file, so naming it would state a number that is
 * simply wrong. There the note claims the rendered count alone and says the
 * bytes ran out. */
function CsvBody({
  table,
  fileTruncated,
}: {
  table: DelimitedTable
  /** `FileContentView.truncated` — the file was longer than the read cap. */
  fileTruncated: boolean
}) {
  const width = table.header.length
  return (
    <div className="files-content-csv-wrap">
      <table className="files-content-csv">
        <thead>
          <tr>
            {table.header.map((cell, i) => (
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {Array.from({ length: width }, (_, c) => (
                <td key={c}>{row[c] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {fileTruncated ? (
        <p className="muted files-content-csv-note">
          Showing the first {table.rows.length.toLocaleString()} rows; the file
          was truncated before it was read.
        </p>
      ) : (
        table.truncated && (
          <p className="muted files-content-csv-note">
            Showing first {table.rows.length.toLocaleString()} of{' '}
            {table.total.toLocaleString()} rows.
          </p>
        )
      )}
    </div>
  )
}

/** Non-markdown file content: Prism-highlighted for a recognized language,
 * plain monospace text otherwise (unknown extension or a language our
 * highlighter build doesn't carry a grammar for).
 *
 * `numbered` puts a line-number gutter beside it (task 809) — asked for
 * explicitly rather than always, because the same component also renders a
 * markdown file's frontmatter panel, which is an excerpt rather than a file and
 * has no line numbers to speak of. The gutter is dropped while `wrap` is on for
 * the reason `CodeEditor` sets out: a soft-wrapped logical line is several
 * visual rows, so logical numbers cannot stay beside it.
 *
 * Find matches are painted as their **own inert layer over untouched Prism
 * output**, never spliced into it (task 809, slice 3). Prism's markup is a tree
 * of nested spans whose text nodes cut across match boundaries at will, so
 * inserting `<mark>`s into it by offset would mean rewriting somebody else's
 * DOM and getting every boundary right — one mistake and the colouring is
 * corrupt, silently and for that file only. A second `<pre>` of the same text
 * with the same metrics, absolutely positioned over the first with transparent
 * glyphs, cannot corrupt anything: the worst a bug in it can do is misplace a
 * background. It is the same trick, and the same alignment rules, as the
 * editor's highlight layer — which is the precedent this follows rather than
 * invents — and it is the same `FindLayer` the editor stack mounts, so the two
 * panes cannot come to disagree about what a highlight means. */
function FileCode({
  content,
  language,
  wrap = false,
  numbered = false,
  matches = [],
  current = -1,
}: {
  content: string
  language: string | null
  wrap?: boolean
  numbered?: boolean
  /** Offsets into `content`, from `fileFind.ts`. Empty means no find is
   * running, and no layer is rendered at all. */
  matches?: FindMatch[]
  /** Which of them is the one being stepped to, or -1. */
  current?: number
}) {
  const prismStyle = usePrismStyle()
  const prismLanguage = prismGrammar(language)
  const code =
    prismLanguage === undefined ? (
      <pre className="files-content-text">{content}</pre>
    ) : (
      <SyntaxHighlighter
        language={prismLanguage}
        style={prismStyle}
        customStyle={{
          margin: 0,
          padding: 0,
          background: 'transparent',
        }}
        codeTagProps={{ className: 'files-content-text' }}
      >
        {content}
      </SyntaxHighlighter>
    )
  if (!numbered && !wrap && matches.length === 0) return code
  return (
    // Two boxes, not one: the row is sized to the file's longest line (so the
    // sticky gutter stays pinned across the whole sideways scroll) and this
    // wrapper is what scrolls it. They cannot be the same element — a
    // scroller's children are clamped to its own width — and the scroll has to
    // be caught here rather than left to the pane, or the pane's sticky
    // header/find bar/status bar, which pin vertically only, slide out from
    // under the code. See `.files-code-scroll` in App.css.
    <div className="files-code-scroll">
      <div className={`files-code-layout${wrap ? ' wrap' : ''}`}>
        {numbered && !wrap && (
          // Built from the count a <pre> actually paints, and inert to the
          // accessibility tree and to selection — copying the file must never
          // copy its line numbers.
          <pre className="files-code-gutter" aria-hidden="true">
            {gutterText(viewerLineCount(content))}
          </pre>
        )}
        <div className="files-code-main">
          {code}
          {matches.length > 0 && (
            <FindLayer
              className="files-find-layer files-content-text"
              text={content}
              matches={matches}
              current={current}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** A directory's fetched-or-not-yet-fetched state (mesa task 410's lazy
 * per-directory walk). `'loading'`/`'error'` are transient states a
 * `Loaded` entry replaces once the fetch settles; a `Loaded` entry stays in
 * the cache across collapse/re-expand so re-opening a directory never
 * re-fetches it. */
type DirState =
  | 'loading'
  | 'error'
  | { entries: FileTreeEntry[]; truncated: boolean }

/**
 * The one inline thing the tree has open, if any — create (mesa task 672),
 * rename or delete (task 877).
 *
 * **One value, not three flags**, and that is the point: all three occupy a row
 * of the tree, and two of them open at once would be two prompts fighting over
 * the same strip of pixels. Opening any one is therefore a write of this whole
 * field, which closes whatever was there.
 *
 * `create.parent` is the directory the naming row belongs to (`''` = the project
 * root). `rename`/`delete` name an existing entry, and carry `is_dir` because
 * both read differently for a folder — a rename of a directory re-points a
 * subtree of tabs, and a delete of one takes its contents with it.
 */
type TreeAction =
  | { kind: 'create'; parent: string }
  | { kind: 'rename'; path: string; name: string; isDir: boolean }
  | { kind: 'delete'; path: string; name: string; isDir: boolean }

/** The tree's inline actions, threaded down as one object rather than a dozen
 * props. The naming *decision* isn't here: it is `newFile.ts`, shared by create
 * and rename since both ask exactly "parent + single component → path". */
interface TreeOps {
  action: TreeAction | null
  /** The message under the open row — either `newFile.ts`'s reason (no request
   *  made) or the server's own 409/422/404, rendered the same way for both. */
  error: string | null
  busy: boolean
  /** The folder an OS file drag would upload into right now (naru task 2732),
   *  `''` for the project root, or null when no such drag is over the tab. */
  dropDir: string | null
  onCreateStart: (parent: string) => void
  onCreateSubmit: (name: string) => void
  onRenameStart: (entry: FileTreeEntry) => void
  onRenameSubmit: (name: string) => void
  onDeleteStart: (entry: FileTreeEntry) => void
  onDeleteConfirm: () => void
  onCancel: () => void
  /** Task 2733: Download on a file row, and the dragstart that lets Chromium
   *  save the file to the desktop. `downloadError` is the failed row's
   *  `{path, message}`. */
  onDownload: (entry: FileTreeEntry) => void
  onFileDragStart: (e: ReactDragEvent, path: string) => void
  downloadError: { path: string; message: string } | null
}

/** The `+` that opens a naming row, on a directory row and on the tree pane's
 * own header (the project root). The row it sits on toggles the directory on
 * click, so this must stop the event from reaching it. */
function NewFileButton({
  parent,
  label,
  ops,
}: {
  parent: string
  label: string
  ops: TreeOps
}) {
  return (
    <button
      type="button"
      className="files-tree-add"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        ops.onCreateStart(parent)
      }}
    >
      +
    </button>
  )
}

/** The `↑` beside the root's `+` (naru task 2732): the click route into the
 * same upload a drop starts, so it works by keyboard and on a phone. The file
 * input is hidden and driven by the button; it is emptied after every pick,
 * because picking the same file twice must fire `change` twice. */
function UploadButton({ onPick }: { onPick: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        type="button"
        className="files-tree-add files-tree-upload"
        aria-label="Upload files into the project root"
        title="Upload files (or drop them anywhere on this tab)"
        onClick={(e) => {
          e.stopPropagation()
          inputRef.current?.click()
        }}
      >
        ↑
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        className="files-upload-input"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          e.target.value = ''
          onPick(picked)
        }}
      />
    </>
  )
}

/** Rename and delete, on **every** row — file and directory alike, unlike `+`,
 * which only a directory can hold. Same reveal rules as `+` (hover or
 * `:focus-visible`, always up under `@media (hover: none)`) so a column of
 * paths stays quiet, and the same `stopPropagation`, since the row's own click
 * selects a file or toggles a folder. */
function TreeRowButtons({ entry, ops }: { entry: FileTreeEntry; ops: TreeOps }) {
  const what = entry.is_dir ? 'folder' : 'file'
  return (
    <>
      {!entry.is_dir && (
        <button
          type="button"
          className="files-tree-add"
          aria-label={`Download file ${entry.path}`}
          title={`Download ${entry.name}`}
          onClick={(e) => {
            e.stopPropagation()
            ops.onDownload(entry)
          }}
        >
          ↓
        </button>
      )}
      <button
        type="button"
        className="files-tree-add"
        aria-label={`Rename ${what} ${entry.path}`}
        title={`Rename ${entry.name}`}
        onClick={(e) => {
          e.stopPropagation()
          ops.onRenameStart(entry)
        }}
      >
        ✎
      </button>
      <button
        type="button"
        className="files-tree-add files-tree-danger"
        aria-label={`Delete ${what} ${entry.path}`}
        title={`Delete ${entry.name}`}
        onClick={(e) => {
          e.stopPropagation()
          ops.onDeleteStart(entry)
        }}
      >
        ⨯
      </button>
    </>
  )
}

/** The inline naming row: one autofocused input, Enter to create, Escape or
 * blur to cancel. The typed name is local — nothing above needs a keystroke,
 * only the submitted name. */
function NewFileRow({ depth, ops }: { depth: number; ops: TreeOps }) {
  const [name, setName] = useState('')
  const indent = { paddingLeft: `${depth * 1.1 + 0.5}rem` }
  return (
    <>
      <li className="files-tree-new" style={indent}>
        <input
          autoFocus
          className="files-tree-new-input"
          value={name}
          placeholder="new-file.ts"
          spellCheck={false}
          aria-label="New file name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ops.onCreateSubmit(name)
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              ops.onCancel()
            }
          }}
          // Deliberately never `disabled` while a create is in flight: the
          // browser blurs a control it disables, and blur cancels — so
          // disabling would close the row mid-request. `busy` is enforced in
          // the submit handler instead.
          onBlur={ops.onCancel}
        />
      </li>
      {ops.error !== null && (
        <li className="files-tree-note error" style={indent}>
          {ops.error}
        </li>
      )}
    </>
  )
}

/**
 * The rename input, standing **in place of the row's own label** rather than on
 * a row of its own — a rename is an edit of that name, and putting the box
 * anywhere else would leave the old name on screen beside the new one.
 *
 * Prefilled with the current name and opened with the *basename* selected, so
 * the common case (retype the name, keep the extension) is one gesture. Focus
 * and selection are set once from an effect, not from the `ref` callback, which
 * fires again on every keystroke and would eat the caret.
 *
 * Enter submits, Escape and blur cancel — the naming row's rules exactly, since
 * this is the same kind of thing.
 */
function RenameInput({ current, ops }: { current: string; ops: TreeOps }) {
  const [name, setName] = useState(current)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    el.focus()
    const dot = current.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : current.length)
    // `current` is fixed for this row's lifetime (a different row is a
    // different mount, keyed by path), so this runs once.
  }, [current])
  return (
    <input
      ref={ref}
      className="files-tree-new-input"
      value={name}
      spellCheck={false}
      aria-label={`Rename ${current}`}
      // The row underneath selects a file / toggles a folder, and every one of
      // these would otherwise reach it.
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          ops.onRenameSubmit(name)
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          ops.onCancel()
        }
      }}
      // Same reason as the naming row: never `disabled` mid-request, since the
      // browser's own blur would cancel the row the request belongs to.
      onBlur={ops.onCancel}
    />
  )
}

/**
 * The delete prompt, inline on the row (mesa task 877) — never
 * `window.confirm`, the same call `CloseConfirmBar` makes one pane over, and it
 * earns being the app's second confirmation for the same reason the first did:
 * the click destroys work irrecoverably. There is no undo and no trash, and the
 * server's delete of a directory is recursive, so a folder's wording says that
 * outright rather than asking a bare yes/no.
 *
 * It wears `.confirm-delete`'s classes, so the confirm/cancel pair matches every
 * other two-step in the app, with the destructive answer red and the *safe* one
 * autofocused — so Enter resolves the harmless way and the keyboard has a route
 * back out. Escape cancels and is stopped from bubbling, since the tree's own
 * key handling is not what should answer this.
 */
function DeleteConfirmRow({
  depth,
  action,
  ops,
}: {
  depth: number
  action: { path: string; name: string; isDir: boolean }
  ops: TreeOps
}) {
  const indent = { paddingLeft: `${depth * 1.1 + 0.5}rem` }
  return (
    <>
      <li className="files-tree-confirm" style={indent}>
        <div
          className="confirm-delete"
          role="alert"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            ops.onCancel()
          }}
        >
          <span className="confirm-message">
            {action.isDir
              ? `Delete ${action.name} and everything in it?`
              : `Delete ${action.name}?`}
          </span>
          <button className="danger" onClick={ops.onDeleteConfirm}>
            delete
          </button>
          <button autoFocus onClick={ops.onCancel}>
            cancel
          </button>
        </div>
      </li>
      {ops.error !== null && (
        <li className="files-tree-note error" style={indent}>
          {ops.error}
        </li>
      )}
    </>
  )
}

/** The inline row a tree entry has open below it, if it is the one holding the
 *  tree's single action — a delete prompt, or a rename's message (the rename
 *  *input* renders in the row itself, but its message needs a row of its own,
 *  the same one the naming row puts it on; create belongs to the directory it
 *  is creating into). Both messages read identically whether they are
 *  `newFile.ts`'s reason or the server's own 409/422/404. */
function TreeRowAction({
  entry,
  depth,
  ops,
}: {
  entry: FileTreeEntry
  depth: number
  ops: TreeOps
}) {
  const action = ops.action
  if (action === null || action.kind === 'create' || action.path !== entry.path) {
    return null
  }
  if (action.kind === 'delete') {
    return <DeleteConfirmRow depth={depth} action={action} ops={ops} />
  }
  if (action.kind === 'rename' && ops.error !== null) {
    return (
      <li
        className="files-tree-note error"
        style={{ paddingLeft: `${depth * 1.1 + 0.5}rem` }}
      >
        {ops.error}
      </li>
    )
  }
  return null
}

/** Whether this row's label is currently being retyped. */
function renamingRow(ops: TreeOps, path: string): boolean {
  return ops.action?.kind === 'rename' && ops.action.path === path
}

/** One tree row (directory or file), recursing into an expanded directory's
 * children via the shared `childrenCache` (fetched lazily on first expand,
 * not carried on the entry itself — the tree endpoint returns one level per
 * call now). Returns a fragment of sibling <li>s so it drops straight into
 * the parent <ul> with no extra wrapper element. */
function TreeNode({
  entry,
  depth,
  expanded,
  onToggle,
  childrenCache,
  selectedPath,
  onSelectFile,
  ops,
}: {
  entry: FileTreeEntry
  depth: number
  expanded: Set<string>
  onToggle: (entry: FileTreeEntry) => void
  childrenCache: Map<string, DirState>
  selectedPath: string | null
  onSelectFile: (path: string) => void
  ops: TreeOps
}) {
  const indent = { paddingLeft: `${depth * 1.1 + 0.5}rem` }
  const renaming = renamingRow(ops, entry.path)
  if (entry.is_dir) {
    const isOpen = expanded.has(entry.path)
    const state = childrenCache.get(entry.path)
    return (
      <>
        <li
          className={`files-tree-dir${
            ops.dropDir === entry.path ? ' upload-target' : ''
          }`}
          style={indent}
          data-upload-path={entry.path}
          data-upload-row="dir"
          onClick={() => onToggle(entry)}
        >
          <span className={`files-tree-toggle ${isOpen ? 'open' : ''}`}>
            {isOpen ? '▾' : '▸'}
          </span>
          {renaming ? (
            <RenameInput current={entry.name} ops={ops} />
          ) : (
            <>
              {entry.name}
              <NewFileButton
                parent={entry.path}
                label={`New file in ${entry.path}`}
                ops={ops}
              />
              <TreeRowButtons entry={entry} ops={ops} />
            </>
          )}
        </li>
        <TreeRowAction entry={entry} depth={depth} ops={ops} />
        {/* First row of this directory's children — above the loading note as
            much as above the entries, so it never jumps once the level
            lands. */}
        {ops.action?.kind === 'create' && ops.action.parent === entry.path && (
          <NewFileRow depth={depth + 1} ops={ops} />
        )}
        {isOpen && state === 'loading' && (
          <li className="files-tree-note muted" style={indent}>
            Loading…
          </li>
        )}
        {isOpen && state === 'error' && (
          <li className="files-tree-note error" style={indent}>
            Failed to load.
          </li>
        )}
        {isOpen &&
          state !== undefined &&
          state !== 'loading' &&
          state !== 'error' &&
          state.entries.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              childrenCache={childrenCache}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              ops={ops}
            />
          ))}
        {isOpen &&
          state !== undefined &&
          state !== 'loading' &&
          state !== 'error' &&
          state.truncated && (
            <li
              className="files-tree-note muted"
              style={{ paddingLeft: `${(depth + 1) * 1.1 + 0.5}rem` }}
            >
              This folder is larger than what's shown here.
            </li>
          )}
      </>
    )
  }
  const language = languageOfName(entry.name)
  return (
    <>
      <li
        className={`files-tree-file ${accentClass(language)} ${
          entry.path === selectedPath ? 'selected' : ''
        }`}
        style={indent}
        data-upload-path={entry.path}
        data-upload-row="file"
        draggable={!renaming}
        onDragStart={(e) => ops.onFileDragStart(e, entry.path)}
        onClick={() => onSelectFile(entry.path)}
      >
        {renaming ? (
          <RenameInput current={entry.name} ops={ops} />
        ) : (
          <>
            {entry.name}
            <TreeRowButtons entry={entry} ops={ops} />
          </>
        )}
      </li>
      <TreeRowAction entry={entry} depth={depth} ops={ops} />
      {ops.downloadError?.path === entry.path && (
        <li className="files-tree-note error" style={indent}>
          {ops.downloadError.message}
        </li>
      )}
    </>
  )
}

/** A path's last segment — what a tab is labelled with. The full relative
 *  path stays on the tab's `title`, since basenames collide constantly
 *  (`mod.rs`, `index.ts`) and the strip has no room to disambiguate. */
function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** A path's directory part, `''` at the project root — the dimmed half of a
 *  search result's heading, for the same reason a tab shows its basename: the
 *  names collide, the paths do not. */
function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/** What the panel is searching for and how, plus whether it is showing at
 *  all. The result of the last search it *ran* is separate state: the two part
 *  company the moment a character is typed, and the rows on screen must keep
 *  being highlighted against the query they were found with, not against the
 *  one being typed over it. */
interface SearchState {
  open: boolean
  query: string
  caseSensitive: boolean
  wholeWord: boolean
}

/** One completed search: the answer, and the query and options it answers —
 *  carried together so a row can never be highlighted against a query that
 *  found something else. */
interface SearchRun {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  data: ProjectFileSearch
}

/**
 * The project-wide search panel (mesa task 813) — Cmd/Ctrl+Shift+F.
 *
 * It takes the tree pane's place rather than opening over the file, so it
 * inherits that pane's width, collapse and phone-tier stacking (task 671/559)
 * and leaves the editor beside it fully visible: reading a result *is*
 * reading the file it points into.
 *
 * **The search runs on submit, not on every keystroke.** Every other query box
 * in this tab searches a string already in memory; this one is a filesystem
 * walk of the whole project, and firing one per character would have the
 * server re-reading every file under `local_path` five times for `needle`. So
 * Enter (or a toggle, which is a deliberate re-ask of the same question) is
 * what sends it, and the box says so.
 */
function SearchPanel({
  state,
  run,
  busy,
  error,
  inputRef,
  onChange,
  onSubmit,
  onOpen,
  onClose,
}: {
  state: SearchState
  /** The last completed search, or null before the first one — which is what
   * makes an empty panel silent rather than claiming "No results". */
  run: SearchRun | null
  busy: boolean
  error: string | null
  inputRef: RefObject<HTMLInputElement | null>
  onChange: (patch: Partial<SearchState>) => void
  onSubmit: () => void
  onOpen: (path: string, line: number) => void
  onClose: () => void
}) {
  /** Do the thing, then put the caret back in the query box — the find bar's
   * rule and its reason: otherwise the next Enter re-activates the button that
   * was clicked instead of re-running the search. */
  function refocus(act: () => void): () => void {
    return () => {
      act()
      inputRef.current?.focus()
    }
  }
  const options = {
    caseSensitive: run?.caseSensitive ?? false,
    wholeWord: run?.wholeWord ?? false,
  }
  return (
    <div
      className="files-search-panel"
      // Escape is bound here rather than on `document`, and that is the whole
      // scoping: the panel sits beside the file instead of over it, so the
      // editor's own Escape (discard the edit) and the find bar's (close the
      // bar) must keep working while it is open. A React handler on this
      // wrapper answers the key exactly when focus is inside the panel.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        // Stopped rather than allowed to bubble, the close-confirm bar's rule:
        // the focused pane binds Escape on `document` too (close the find
        // bar), and a keystroke aimed at this panel must not also answer a
        // question asked over there. `shouldIgnoreFilesShortcut` already
        // stands that listener down while the caret is in this input; this
        // covers the panel's buttons, which are not text controls.
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="files-search-bar">
        <input
          autoFocus
          ref={inputRef}
          className="files-search-input"
          value={state.query}
          maxLength={MAX_SEARCH_QUERY}
          placeholder="Search project"
          spellCheck={false}
          aria-label="Search in project files"
          onChange={(e) => onChange({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            onSubmit()
          }}
        />
        <button
          type="button"
          className="files-find-toggle"
          aria-pressed={state.caseSensitive}
          title="Match case"
          onClick={refocus(() => onChange({ caseSensitive: !state.caseSensitive }))}
        >
          Aa
        </button>
        <button
          type="button"
          className="files-find-toggle"
          aria-pressed={state.wholeWord}
          title="Whole word"
          onClick={refocus(() => onChange({ wholeWord: !state.wholeWord }))}
        >
          |ab|
        </button>
        <button
          type="button"
          className="files-find-toggle"
          aria-label="Close search"
          title="Close (Escape)"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="files-search-summary muted">
        {busy ? 'Searching…' : (searchSummary(run?.data ?? null) || 'Press Enter to search')}
      </p>
      {error !== null && <p className="error">{error}</p>}
      {run !== null && (
        <ul className="files-search-results">
          {run.data.files.map((file) => (
            <li key={file.path} className="files-search-group">
              {/* The heading opens the file at its first hit — the same thing
                  a tree row does, with a line to land on. */}
              <button
                type="button"
                className={`files-search-file ${accentClass(file.language)}`}
                title={file.path}
                onClick={() => onOpen(file.path, file.matches[0]?.line ?? 1)}
              >
                <span className="files-search-file-name">{basename(file.path)}</span>
                <span className="files-search-file-dir">{dirname(file.path)}</span>
                <span className="files-search-file-count">
                  {file.matches.length}
                  {file.truncated ? '+' : ''}
                </span>
              </button>
              <ul>
                {file.matches.map((match, i) => (
                  // Index in the key because a file legitimately holds two
                  // hits on one line — that is two rows, not one.
                  <li key={`${match.line}-${i}`}>
                    <button
                      type="button"
                      className="files-search-hit"
                      onClick={() => onOpen(file.path, match.line)}
                    >
                      <span className="files-search-hit-line">{match.line}</span>
                      <span className="files-search-hit-text">
                        {/* Highlighted by re-running the same literal scan the
                            find bar uses, never by offsets off the wire —
                            `fileSearch.ts` says why. */}
                        {snippetSegments(match.text, run.query, options).map((seg, s) =>
                          seg.match < 0 ? (
                            <span key={s}>{seg.text}</span>
                          ) : (
                            <mark key={s} className="files-search-mark">
                              {seg.text}
                            </mark>
                          ),
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The tab being dragged, for the length of one HTML5 drag.
 *
 * Module scope rather than component state on purpose: `dragover` fires many
 * times a second and must be able to *read* the source to decide whether the
 * drop is legal, and `DataTransfer.getData` is deliberately blank outside
 * `drop` for exactly that read. A ref would work too; a module-level slot is
 * simpler and there is only ever one drag in flight in one window. */
let dragging: TabSource | null = null

/** Where a drop indicator is currently showing: a strip and the gap in it. */
interface DropMark {
  side: PaneSide
  index: number
}

/**
 * One pane's tab strip: its open files in order, plus the Split control.
 *
 * All of the decision-making is `fileTabs.ts`; this owns the DOM half of it —
 * measuring the tabs so `dropIndex` has rects to work with, and painting the
 * indicator at the gap that measurement chose.
 */
function TabStrip({
  projectId,
  side,
  tabs,
  active,
  focused,
  canSplit,
  mark,
  dirty,
  onActivate,
  onClose,
  onMenu,
  onSplit,
  onDragBegin,
  onDragFinish,
  onDragOverStrip,
  onDropOnStrip,
  onDragLeaveStrip,
}: {
  projectId: number
  side: PaneSide
  tabs: string[]
  active: string | null
  focused: boolean
  canSplit: boolean
  mark: DropMark | null
  /** Paths with unsaved edits, from `fileDirty.ts` — the whole tab's set, not
   * this strip's, since a path may be open in both. */
  dirty: ReadonlySet<string>
  onActivate: (path: string) => void
  /** *Requests* a close: a dirty tab's is answered by the confirm bar rather
   * than by the tab going away (`FilesView.requestClose`). */
  onClose: (path: string) => void
  /** Opens the tab menu (naru task 2730) for `path` at a viewport point;
   * `trigger` is where focus goes back to when it closes. */
  onMenu: (path: string, at: { x: number; y: number }, trigger: HTMLElement) => void
  onSplit: () => void
  onDragBegin: () => void
  onDragFinish: () => void
  onDragOverStrip: (index: number) => void
  onDropOnStrip: (index: number) => void
  onDragLeaveStrip: () => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  // The phone tier's long-press into the tab menu: the pending timer, and
  // whether it fired — a fired press swallows its own touchend, or the
  // synthesized click after it would land outside the menu and close it.
  const press = useRef<{ timer: number; fired: boolean; x: number; y: number } | null>(null)
  const cancelPress = () => {
    if (press.current !== null) window.clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => cancelPress, [])

  // The pure part is `dropIndex`; the measuring stays here, where the DOM is.
  function indexAt(clientX: number): number {
    const strip = stripRef.current
    if (strip === null) return tabs.length
    const rects = [...strip.querySelectorAll('[data-file-tab]')].map((el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right }
    })
    return dropIndex(rects, clientX)
  }

  // `dragenter` and `dragover` do the same thing, and both must: a browser
  // treats an element as a drop target only from the moment one of them calls
  // `preventDefault()`, so a pointer that crosses into a strip and releases
  // before the first `dragover` fires would otherwise see the drop rejected.
  function over(e: ReactDragEvent) {
    if (dragging === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    onDragOverStrip(indexAt(e.clientX))
  }

  return (
    <div
      className={`files-tab-strip${focused ? ' focused' : ''}`}
      ref={stripRef}
      onDragEnter={over}
      onDragOver={over}
      onDragLeave={onDragLeaveStrip}
      onDrop={(e) => {
        if (dragging === null) return
        e.preventDefault()
        onDropOnStrip(indexAt(e.clientX))
      }}
    >
      {tabs.map((path, i) => (
        <div
          key={path}
          data-file-tab=""
          title={tabLabel(path, dirty.has(path))}
          draggable
          className={`files-tab ${accentClass(languageOfName(basename(path)))}${
            path === active ? ' active' : ''
          }${dirty.has(path) ? ' dirty' : ''}${
            mark !== null && mark.side === side && mark.index === i ? ' drop-before' : ''
          }`}
          onDragStart={(e) => {
            cancelPress()
            dragging = { side, path }
            // Also carries the Chromium `DownloadURL` so a tab dragged out of
            // the window saves its file (naru task 2733); `copyMove` keeps the
            // internal move and allows that external copy.
            setDragOutData(e.dataTransfer, location.origin, projectId, path)
            onDragBegin()
          }}
          onDragEnd={() => {
            dragging = null
            onDragFinish()
          }}
          // Middle-click closes, the editor convention. `auxclick` rather than
          // `mouseup` so it fires once and only for a real button-2 click.
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(path)
            }
          }}
          // The tab menu (naru task 2730): right-click, the menu key or
          // Shift+F10 on the focused tab, and a long-press on touch.
          onContextMenu={(e) => {
            e.preventDefault()
            onMenu(path, { x: e.clientX, y: e.clientY }, e.currentTarget.querySelector('button') ?? e.currentTarget)
          }}
          onKeyDown={(e) => {
            if (!((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) return
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            onMenu(path, { x: r.left, y: r.bottom }, (e.target as HTMLElement))
          }}
          onTouchStart={(e) => {
            const t = e.touches[0]
            const el = e.currentTarget
            const at = { x: t.clientX, y: t.clientY }
            cancelPress()
            const p = { fired: false, timer: 0, ...at }
            p.timer = window.setTimeout(() => {
              p.fired = true
              onMenu(path, at, el.querySelector('button') ?? el)
            }, 500)
            press.current = p
          }}
          // A held finger jitters a few pixels; only a real move (a scroll,
          // a swipe) cancels the press.
          onTouchMove={(e) => {
            const p = press.current
            const t = e.touches[0]
            if (p !== null && !p.fired && Math.hypot(t.clientX - p.x, t.clientY - p.y) > 10) cancelPress()
          }}
          onTouchCancel={cancelPress}
          onTouchEnd={(e) => {
            const p = press.current
            press.current = null
            if (p === null) return
            window.clearTimeout(p.timer)
            if (p.fired) e.preventDefault()
          }}
        >
          <button
            type="button"
            className="files-tab-label"
            // The visible text is the basename, which collides constantly; the
            // accessible name is the full path plus, when it applies, the
            // unsaved-changes state the dot beside it shows sighted users.
            aria-label={tabLabel(path, dirty.has(path))}
            onClick={() => onActivate(path)}
          >
            {basename(path)}
          </button>
          {/* The editor convention: a dirty tab wears a dot where its × goes,
              and hovering (or tabbing into) the tab swaps the two back — CSS
              alone, App.css, since both elements are always rendered and only
              one is ever shown. */}
          {dirty.has(path) && (
            <span className="files-tab-dirty" aria-hidden="true">
              ●
            </span>
          )}
          <button
            type="button"
            className="files-tab-close"
            aria-label={closeLabel(path, dirty.has(path))}
            onClick={() => onClose(path)}
          >
            ×
          </button>
        </div>
      ))}
      {/* The tail gap, so a drop past the last tab has something to mark. */}
      {mark !== null && mark.side === side && mark.index >= tabs.length && (
        <span className="files-tab-drop-tail" aria-hidden="true" />
      )}
      {canSplit && (
        <button
          type="button"
          className="files-split-btn"
          onClick={onSplit}
          title="Show a second file beside this one"
        >
          Split
        </button>
      )}
    </div>
  )
}

/**
 * The prompt a dirty tab's close puts up instead of going away (task 809).
 *
 * Deliberately the house two-step pattern, not `window.confirm`: mesa's
 * confirmations are inline and non-modal everywhere else, and a native dialog
 * here would also be the only thing in the app able to block the render loop.
 *
 * It reuses `ConfirmDelete`'s *classes* (`.confirm-delete`/`.confirm-message`,
 * the red confirm button) but not the component. `ConfirmDelete` owns its own
 * trigger — a labelled `danger` button that arms on the first click — and takes
 * an async `onDelete` whose rejection it renders. Here the trigger already
 * exists (the tab's ×, plus middle-click and Alt+W, three ways into the same
 * state), the armed state must survive being raised from any of them, and
 * closing a tab is synchronous local state that cannot fail. Wrapping that in a
 * component built to own a button and await a promise would mean fighting both
 * halves of it.
 *
 * The wording names what is lost rather than asking a yes/no question, and the
 * discarding button is the red one: this is the one place in the Files tab
 * where a click destroys work that was never on disk.
 */
function CloseConfirmBar({
  path,
  onDiscard,
  onCancel,
}: {
  path: string
  onDiscard: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="files-close-confirm confirm-delete"
      role="alert"
      // Escape is the universal cancel, and this is the one modal-ish prompt in
      // the tab — without it the bar answered Enter (the autofocused "keep
      // editing") and nothing else. It resolves the safe way, so there is no
      // precedence question with the find bar or the editor underneath; the
      // event is stopped all the same, so neither of them also acts on it.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
    >
      <span className="confirm-message">
        {basename(path)} has unsaved changes.
      </span>
      <button className="danger" onClick={onDiscard}>
        discard and close
      </button>
      {/* Autofocused so the keyboard route in (Alt+W) has a keyboard route
          back out, and so Enter answers the safe way. */}
      <button autoFocus onClick={onCancel}>
        keep editing
      </button>
    </div>
  )
}

/** An open tab menu: which tab it was raised on, where, and what to hand
 *  focus back to. */
interface TabMenuState {
  side: PaneSide
  path: string
  x: number
  y: number
  trigger: HTMLElement
}

/** The menu's items, in order. `'close'` is the single close; the rest are
 *  `fileTabs.ts`'s bulk actions. */
const TAB_MENU_ITEMS: { action: 'close' | BulkClose; label: string }[] = [
  { action: 'close', label: 'Close' },
  { action: 'others', label: 'Close others' },
  { action: 'right', label: 'Close to the right' },
  { action: 'saved', label: 'Close saved' },
  { action: 'all', label: 'Close all' },
]

/**
 * A tab's context menu (naru task 2730): the editor set of closes over that
 * tab's pane. The workflow canvas's pin menu is the house pattern — same
 * classes, portalled to the body, first item focused, arrows move, Escape and
 * a click away close — plus a clamp so it never opens past the viewport edge.
 * Items with nothing to close are disabled rather than hidden, so the menu
 * keeps one shape.
 */
function TabMenu({
  menu,
  enabled,
  onPick,
  onClose,
}: {
  menu: TabMenuState
  enabled: (action: 'close' | BulkClose) => boolean
  onPick: (action: 'close' | BulkClose) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ x: menu.x, y: menu.y })
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    setAt(clampMenu(menu.x, menu.y, r.width, r.height, window.innerWidth, window.innerHeight))
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu.x, menu.y])
  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('touchstart', away)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('touchstart', away)
    }
  }, [onClose])
  return createPortal(
    <div
      ref={ref}
      className="wf-pin-menu files-tab-menu"
      role="menu"
      aria-label={`Tab ${basename(menu.path)}`}
      style={{ left: at.x, top: at.y }}
      // Handled here and stopped, so the app's arrow-key focus movement and
      // the Files tab's own Escape owners never see a key meant for the menu.
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault()
          e.stopPropagation()
          // A keyboard dismissal hands the caret back to the tab it came from.
          menu.trigger.focus()
          onClose()
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          e.stopPropagation()
          const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
          const i = items.indexOf(document.activeElement as HTMLButtonElement)
          items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
        }
      }}
    >
      <div className="wf-pin-menu-head">{basename(menu.path)}</div>
      {TAB_MENU_ITEMS.map(({ action, label }) => (
        <button
          key={action}
          type="button"
          role="menuitem"
          disabled={!enabled(action)}
          onClick={() => onPick(action)}
        >
          {label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

/**
 * The one prompt a bulk close leaves behind (naru task 2730): every clean tab
 * in the set has already gone, and these dirty ones are still open. Same
 * classes and two-step shape as `CloseConfirmBar`, for the reasons given
 * there; its own component because it counts files rather than naming one.
 */
function BulkCloseConfirmBar({
  count,
  onDiscard,
  onCancel,
}: {
  count: number
  onDiscard: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="files-close-confirm confirm-delete"
      role="alert"
      // Escape resolves the safe way and is stopped, as `CloseConfirmBar`'s is.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
    >
      <span className="confirm-message">
        {count} unsaved {count === 1 ? 'file remains' : 'files remain'} open.
      </span>
      <button className="danger" onClick={onDiscard}>
        Discard {count} and close
      </button>
      <button autoFocus onClick={onCancel}>
        Keep
      </button>
    </div>
  )
}

/**
 * The prompt unsaved work puts in front of "Revert file" (naru task 2743;
 * until then this bar guarded the two ways out of edit mode, mesa task 1271).
 *
 * `CloseConfirmBar`'s shape and classes for the reason given there — the
 * app's confirmations are inline and non-modal, never `window.confirm`. The
 * discarding button is the red one: the file on disk does not have these
 * edits, and this click is what throws them away.
 */
function RevertConfirmBar({
  path,
  onConfirm,
  onCancel,
}: {
  path: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="files-close-confirm confirm-delete"
      role="alert"
      // Escape resolves the safe way, and is stopped, as `CloseConfirmBar`'s is.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
    >
      <span className="confirm-message">
        {basename(path)} has unsaved changes.
      </span>
      <button className="danger" onClick={onConfirm}>
        discard edits
      </button>
      {/* Autofocused so Enter answers the safe way, as it does one pane over. */}
      <button autoFocus onClick={onCancel}>
        keep editing
      </button>
    </div>
  )
}

/** A tab strip over the pane's active file — or, with nothing open, the same
 *  empty state the single pane showed before tabs existed. */
function FilePane({
  projectId,
  side,
  tabs,
  active,
  focused,
  canSplit,
  mark,
  dirty,
  pendingClose,
  pendingBulk,
  fileUi,
  reloads,
  changed,
  focusSeq,
  onFocusTaken,
  onUi,
  wrap,
  onWrapChange,
  landing,
  onFocus,
  onActivate,
  onClose,
  onConfirmClose,
  onCancelClose,
  onMenu,
  onConfirmBulk,
  onCancelBulk,
  onSplit,
  onDragBegin,
  onDragFinish,
  onDragOverStrip,
  onDropOnStrip,
  onDragLeaveStrip,
  style,
}: {
  projectId: number
  side: PaneSide
  tabs: string[]
  active: string | null
  focused: boolean
  canSplit: boolean
  mark: DropMark | null
  dirty: ReadonlySet<string>
  /** The path in *this* pane awaiting a discard/keep answer, if any. */
  pendingClose: string | null
  /** How many dirty tabs a bulk close in *this* pane left awaiting an answer
   * (naru task 2730); 0 for none. */
  pendingBulk: number
  fileUi: Map<string, FileUiState>
  /** Per-path counts of uploads that replaced the file (naru task 2732). */
  reloads: Record<string, number>
  /** The watch stream's latest burst, for the mounted file to re-read on. */
  changed: DiskChange | null
  /** Non-zero when this pane's active file should take the caret (see
   * `ContentPane`). */
  focusSeq: number
  onFocusTaken: () => void
  onUi: (path: string, patch: UiPatch) => void
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
  /** The project-search result to land on, if it names a file this pane has
   * open (task 813). Handed to whichever pane is showing that path rather than
   * to a chosen side: the same file can be open in both, and both should show
   * the reader the line they clicked. */
  landing: SearchLanding | null
  onFocus: () => void
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onConfirmClose: () => void
  onCancelClose: () => void
  onMenu: (path: string, at: { x: number; y: number }, trigger: HTMLElement) => void
  onConfirmBulk: () => void
  onCancelBulk: () => void
  onSplit: () => void
  onDragBegin: () => void
  onDragFinish: () => void
  onDragOverStrip: (index: number) => void
  onDropOnStrip: (index: number) => void
  onDragLeaveStrip: () => void
  style?: CSSProperties
}) {
  // Each open image's zoom (naru task 2731), held by the pane rather than in
  // `fileUi`: that is keyed by path alone, and the same image open in both
  // halves of a split zooms independently. A mutable Map that is never
  // replaced, because only the mounted image reads or writes it — it never
  // needs to re-render the pane. Entries for tabs this pane no longer has are
  // dropped, so reopening starts at fit.
  const [imageZoom] = useState(() => new Map<string, ZoomView | null>())
  useEffect(() => {
    for (const p of [...imageZoom.keys()]) if (!tabs.includes(p)) imageZoom.delete(p)
  }, [tabs, imageZoom])
  return (
    <section
      className={`files-content-pane${focused ? ' focused' : ''}`}
      style={style}
      onMouseDown={onFocus}
    >
      <TabStrip
        projectId={projectId}
        side={side}
        tabs={tabs}
        active={active}
        focused={focused}
        canSplit={canSplit}
        mark={mark}
        dirty={dirty}
        onActivate={onActivate}
        onClose={onClose}
        onMenu={onMenu}
        onSplit={onSplit}
        onDragBegin={onDragBegin}
        onDragFinish={onDragFinish}
        onDragOverStrip={onDragOverStrip}
        onDropOnStrip={onDropOnStrip}
        onDragLeaveStrip={onDragLeaveStrip}
      />
      {/* Under the strip rather than over the file: it answers a click on a
          tab, and pushing the content down is what makes it impossible to
          miss. */}
      {pendingClose !== null && (
        <CloseConfirmBar
          path={pendingClose}
          onDiscard={onConfirmClose}
          onCancel={onCancelClose}
        />
      )}
      {pendingBulk > 0 && (
        <BulkCloseConfirmBar
          count={pendingBulk}
          onDiscard={onConfirmBulk}
          onCancel={onCancelBulk}
        />
      )}
      <div className="files-pane-body">
        {active !== null ? (
          // Only the *active* tab of each pane is mounted, so a dozen open
          // files never means a dozen live syntax highlighters. What survives
          // the switch is `fileUi`, one plain object per path, in the parent.
          // `key` still carries the path so `useFetch` and the editor start
          // clean per file, exactly as the pre-tabs `key={selectedPath}` did.
          <ContentPane
            key={active}
            projectId={projectId}
            path={active}
            ui={fileUi.get(active) ?? BLANK_FILE_UI}
            onUi={(patch) => onUi(active, patch)}
            wrap={wrap}
            onWrapChange={onWrapChange}
            focused={focused}
            landing={landing?.path === active ? landing : null}
            imageZoom={imageZoom}
            reload={reloads[active] ?? 0}
            changed={changed}
            focusSeq={focusSeq}
            onFocusTaken={onFocusTaken}
          />
        ) : (
          <p className="muted">Select a file to see its content.</p>
        )}
      </div>
    </section>
  )
}

/** A project's open set as the tab mounts or switches to it: the remembered
 *  tabs, and whatever per-file state the stash still holds for them. */
function restoreOpen(
  projectId: number,
  narrow: boolean,
): { tabs: TabsState; fileUi: Map<string, FileUiState> } {
  const tabs = loadOpenFiles(projectId, narrow)
  return { tabs, fileUi: stashedDrafts<FileUiState>(projectId, openPaths(tabs)) }
}

/**
 * The Files tab: the project's file tree (rooted at local_path) on the left,
 * expandable per directory, with the open files' content on the right.
 * The root level loads eagerly with the tab; each directory's own contents
 * load lazily on first expand and are cached thereafter (mesa task 410),
 * so the per-directory entry cap applies to one folder at a time instead of
 * truncating the whole tree. A non-binary, non-truncated file can be edited
 * and saved back to disk (task 327, `ContentPane`'s Edit affordance);
 * everything else — browsing, the tree, no create/delete/rename — stays
 * read-only. Rendered in place inside ProjectTasksPage's frame, like
 * GitView. Empty states are quiet placeholders, matching the Git tab's
 * ladder, never a hard error (M10).
 *
 * The content half holds *many* open files as a strip of draggable tabs and
 * can split once, into two side-by-side panes with independent strips (mesa
 * task 670). None of that is deep-linked or persisted: it is component state
 * with the same lifetime `selectedPath` had, reset on project change.
 */
export function FilesView({ projectId }: { projectId: number }) {
  const { data, error, refetch } = useFetch(
    () => getProjectFiles(projectId),
    `files-${projectId}`,
  )
  // A split of a ≤860px content area is two unusable columns, and the split is
  // a React data structure rather than styling — so unlike `treeOpen` below
  // this one genuinely needs the breakpoint in JS (`docs/mobile.md`, same
  // exception the terminal's pane tree takes one tier down). Read before the
  // open set because the seed folds a stored split against it.
  const narrow = useNarrowTier()
  // The open set — tabs, order, which pane is focused, whether it is split and
  // at what ratio — together with the per-open-path view state that must
  // outlive a tab switch. The tabs half is remembered per project in
  // localStorage (`openFiles.ts`, mesa task 696); `fileUi` is not — a draft
  // lives in memory only, for the page's lifetime: it is stashed per project
  // (`fileDrafts.ts`, naru task 2743) so leaving the Files tab and coming back
  // finds it again. Still no URL deep-linking into the tree.
  //
  // **One** state object, not two, and that is load-bearing: dropping a
  // closed path's draft has to happen in the same update that closes it, and
  // an updater is the only place with both the previous and the next tabs in
  // hand. `fileUi` is keyed by path, so the same file open in both panes of a
  // split shares one draft — the only coherent answer when both are editing
  // the same bytes.
  const [open, setOpen] = useState<{
    tabs: TabsState
    fileUi: Map<string, FileUiState>
  }>(() => restoreOpen(projectId, narrow))
  const { tabs, fileUi } = open
  // Mirror the per-file state into the stash on every change, which is also
  // what arms and disarms the page-unload warning (`fileDrafts.ts`).
  useEffect(() => {
    stashDrafts(projectId, fileUi)
  }, [projectId, fileUi])
  // The watch stream's latest burst, for the open files to re-read on.
  const [changed, setChanged] = useState<DiskChange | null>(null)
  const changedSeq = useRef(0)
  // The file the person just opened or switched to, whose editor should take
  // the caret (`ContentPane`'s `focusSeq`). Null for anything they did not ask
  // for by opening a file: a page load, a search-result landing.
  const [focusReq, setFocusReq] = useState<{ path: string; seq: number } | null>(null)
  const focusSeq = useRef(0)
  function focusEditor(path: string | null | undefined) {
    if (path != null) setFocusReq({ path, seq: ++focusSeq.current })
  }
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Fetched-directory cache (mesa task 410's lazy per-directory walk):
  // populated on first expand, kept for the component's lifetime so
  // collapsing and re-expanding a directory never re-fetches it.
  const [childrenCache, setChildrenCache] = useState<Map<string, DirState>>(
    new Map(),
  )
  // The watch stream (naru task 1873) reads the loaded levels through a ref so
  // its effect is keyed on the project alone, not restarted by every cache edit.
  const childrenRef = useRef(childrenCache)
  useEffect(() => {
    childrenRef.current = childrenCache
  })
  const hasRoot = data?.path != null
  useEffect(() => {
    if (!hasRoot) return
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let opened = false
    const refetchDir = (dir: string) => {
      getProjectFiles(projectId, dir).then(
        (res) => {
          if (ctrl.signal.aborted) return
          // Replace in place — no 'loading' flash; skip a level dropped meanwhile.
          setChildrenCache((prev) =>
            prev.has(dir)
              ? new Map(prev).set(dir, { entries: res.tree ?? [], truncated: res.truncated })
              : prev,
          )
        },
        (e: unknown) => {
          if (ctrl.signal.aborted) return
          if (!(e instanceof ApiError) || e.status !== 404) return
          // The folder is gone: drop it (and anything under it) from view state.
          const gone = (p: string) => p === dir || p.startsWith(dir + '/')
          setChildrenCache((prev) => {
            const next = new Map(prev)
            for (const k of prev.keys()) if (gone(k)) next.delete(k)
            return next
          })
          setExpanded((prev) => new Set([...prev].filter((p) => !gone(p))))
        },
      )
    }
    const refetchLevels = (dirs: string[] | null) => {
      // The open files hear about it too, whether or not the tree has that
      // level loaded.
      setChanged({ seq: ++changedSeq.current, dirs })
      const { root, dirs: levels } = levelsToRefetch(dirs, childrenRef.current.keys())
      if (root) void refetch()
      levels.forEach(refetchDir)
    }
    const connect = () => {
      watchProjectFiles(
        projectId,
        (ev) => {
          if (ev.type === 'ready') {
            attempt = 0
            // Events may have been missed while disconnected.
            if (opened) refetchLevels(null)
            opened = true
          } else if (ev.type === 'change') {
            refetchLevels(ev.dirs)
          }
        },
        ctrl.signal,
      )
        .catch(() => {})
        .then(() => {
          if (ctrl.signal.aborted) return
          timer = setTimeout(connect, reconnectDelayMs(attempt++))
        })
    }
    connect()
    return () => {
      ctrl.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [projectId, hasRoot, refetch])
  // Whether the tree is showing. Only the phone tier can turn this off, and
  // only the phone tier renders anything that reacts to it — above 600px the
  // toggle button is `display: none` and `.files-tree-collapsed` has no rule
  // at all, so the tree is always up and this flag is inert. That is
  // deliberate: the breakpoint stays in CSS alone, with no second
  // `matchMedia` for the component to keep in sync (same rule the phone tab
  // bar follows, App.css).
  const [treeOpen, setTreeOpen] = useState(true)
  // The tree's one open inline row — a naming row (mesa task 672), a rename or
  // a delete prompt (task 877) — plus the message under it and whether its
  // request is in flight. **One** slot, not three flags and not a map: see
  // `TreeAction`. Opening any of the three overwrites this field, which is what
  // makes "at most one at a time" true by construction.
  const [treeAction, setTreeAction] = useState<TreeAction | null>(null)
  const [treeActionError, setTreeActionError] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<{ path: string; message: string } | null>(
    null,
  )
  const [treeBusy, setTreeBusy] = useState(false)
  // Uploading (naru task 2732). `dropDir` is where an OS file drag would land
  // right now; `upload` is the batch in flight (which file, a Replace question
  // waiting on an answer) or, once it ends, what it left on screen. A ref
  // marks the batch so a second one can't interleave with it, and holds the
  // resolver of the Replace question the loop is awaiting.
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [upload, setUpload] = useState<{
    progress: { name: string; index: number; total: number } | null
    replace: string | null
    /** The project path the Replace question is about — so the prompt can say
     * when the answer also discards unsaved edits (naru task 2743). */
    replacePath?: string
    /** Said beside the progress line when a second drop arrives mid-batch. */
    note: string | null
    done: { ok: string | null; problems: string[] } | null
  }>({ progress: null, replace: null, note: null, done: null })
  const uploading = useRef(false)
  const replaceAnswer = useRef<((replace: boolean) => void) | null>(null)
  // Bumped when the project changes or the tab goes away; a batch that started
  // before the bump stops, rather than finishing against another project's
  // tree and tabs.
  const uploadRun = useRef(0)
  // Paths an upload has replaced, counted — see `ContentPane`'s `reload`.
  const [reloads, setReloads] = useState<Record<string, number>>({})
  // A Replace question still open at that point is answered "no", or its loop
  // would wait forever.
  useEffect(
    () => () => {
      uploadRun.current += 1
      uploading.current = false
      replaceAnswer.current?.(false)
    },
    [projectId],
  )
  // The wide-tier tree pane's own width and collapse (mesa task 671), both
  // persisted globally for the Files tab (`filesTreeWidth.ts`). Deliberately
  // independent of `treeOpen` above: that one is the phone tier's control and
  // is inert above 600px, these two are the wide tier's and are made inert at
  // and below 860px by CSS alone — neither flag ever reads the other, and no
  // second `matchMedia` is introduced (`docs/mobile.md`).
  const [treeWidth, setTreeWidth] = useState(loadFilesTreeWidth)
  const [treeCollapsed, setTreeCollapsed] = useState(loadFilesTreeCollapsed)
  const [treeResizing, setTreeResizing] = useState(false)
  const treeRef = useRef<HTMLDivElement>(null)
  // Soft wrap (mesa task 809), persisted globally for the Files tab like the
  // tree width above. Held here rather than per pane so a split, and every tab
  // in it, reads code the same way — the toggle in one pane's status bar is a
  // statement about the tab, not about that file.
  const [wrap, setWrap] = useState(loadWordWrap)
  // Project-wide search (mesa task 813): what the panel is asking, the last
  // answer it got, and whether one is in flight. Component state with the
  // tab's lifetime — nothing about a search is persisted or deep-linked, the
  // same posture the find bar takes one file down.
  const [search, setSearch] = useState<SearchState>({
    open: false,
    query: '',
    caseSensitive: false,
    wholeWord: false,
  })
  const [searchRun, setSearchRun] = useState<SearchRun | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  // Which request the panel is still interested in. A search is a filesystem
  // walk, so a slow one can land after a later, narrower one — and the answer
  // to the older question overwriting the newer one is the classic version of
  // this bug.
  const searchSeq = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Where the caret goes when the panel closes: a real control that outlives
  // it. Closing without a hand-off drops focus on <body>, which is the same
  // trap `closeFind` documents.
  const searchToggleRef = useRef<HTMLButtonElement>(null)
  // The result being opened, if any — handed to whichever pane holds that file
  // so it can reveal the line (`SearchLanding`). Its `seq` is what makes a
  // second click on the same result land again.
  const [landing, setLanding] = useState<SearchLanding | null>(null)
  const landingSeq = useRef(0)
  // The tab whose close is waiting on a discard/keep answer (task 809, slice
  // 4), or null. One at a time and identified by pane *and* path, since the
  // same file can be open in both panes of a split and only one of the two
  // closes is the one being asked about.
  const [pendingClose, setPendingClose] = useState<{
    side: PaneSide
    path: string
  } | null>(null)
  // A bulk close's dirty leftovers awaiting one discard/keep answer (naru task
  // 2730), and the open tab menu. Raising either close prompt drops the other,
  // so a pane never shows two.
  const [pendingBulk, setPendingBulk] = useState<{
    side: PaneSide
    paths: string[]
  } | null>(null)
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  // Whether a tab drag is in flight at all — what arms the right-edge split
  // zone. Distinct from `mark`, which is only set while the pointer is over a
  // strip: leaving the strip for the edge clears the indicator but must not
  // take the drop target it is heading for with it.
  const [dragActive, setDragActive] = useState(false)
  // Where the drop indicator is painting, for the length of one drag.
  const [mark, setMark] = useState<DropMark | null>(null)
  // Whether a tab is currently over the right-edge split zone.
  const [edgeArmed, setEdgeArmed] = useState(false)
  const panesRef = useRef<HTMLDivElement>(null)
  // Edge-triggered on the crossing, never derived: re-deriving would re-fold a
  // split the user opened at, say, 800px, on every render.
  useEffect(
    () =>
      onNarrowTierChange((isNarrow) => {
        if (!isNarrow) return
        setOpen((prev) =>
          prev.tabs.right === null
            ? prev
            : { ...prev, tabs: collapseSplit(prev.tabs) },
        )
      }),
    [],
  )
  // A stored width is loaded unclamped (`filesTreeWidth.ts` can't see the
  // layout), so pull it into range once the tree is mounted and on every
  // window resize — the state must never *hold* an out-of-range value, not
  // merely render as one. `data` is a dependency because the tree only exists
  // once the fetch has landed; until then there is nothing to measure against.
  useEffect(() => {
    const clampToLayout = () => {
      const max = maxTreeWidth(treeRef.current, panesRef.current)
      if (max === null) return
      setTreeWidth((w) => clampFilesTreeWidth(w, max))
    }
    clampToLayout()
    window.addEventListener('resize', clampToLayout)
    return () => window.removeEventListener('resize', clampToLayout)
  }, [treeCollapsed, data])

  // Listeners go on `document`, not the handle, so the drag keeps tracking
  // when the pointer outruns it. The new width is the pointer's distance from
  // the tree's own left edge (the handle is on its *right* edge — this is the
  // left pane, the mirror of the nav's and the agent rail's). The <body> class
  // matches `body.nav-resizing` so a sweep across the page doesn't select text
  // under it.
  useEffect(() => {
    if (!treeResizing) return
    // The listeners live for the whole drag, so they'd close over the
    // `treeWidth` this effect started with. `latest` carries the value forward
    // for `onUp` to persist without re-subscribing on every move. It stays
    // null until the pointer actually moves, so a press-and-release that never
    // dragged writes nothing.
    let latest: number | null = null
    const onMove = (e: MouseEvent) => {
      const treeLeft = treeRef.current?.getBoundingClientRect().left
      const max = maxTreeWidth(treeRef.current, panesRef.current)
      if (treeLeft === undefined || max === null) return
      latest = clampFilesTreeWidth(e.clientX - treeLeft, max)
      setTreeWidth(latest)
    }
    // Persist on drag end only: once per drag, not once a frame. Written here
    // rather than from a `[treeWidth]` effect so the double-click reset's
    // `clearFilesTreeWidth()` isn't immediately undone by a re-save of the
    // default.
    const onUp = () => {
      setTreeResizing(false)
      if (latest !== null) saveFilesTreeWidth(latest)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('files-tree-resizing')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('files-tree-resizing')
    }
  }, [treeResizing])

  // Which open files hold work that is not on disk. Derived, never stored: it
  // is a function of the drafts `fileUi` already carries, and a second copy
  // would be a second thing to keep true.
  const dirty = useMemo(() => dirtyPaths(fileUi), [fileUi])

  // What the person is looking at (mesa task 888): the file the *focused* pane
  // is showing — with a split open, the other pane's file is on screen but is
  // not what "this file" means. The path is the identity; the label is the
  // basename, because a path read aloud by a synthesiser is a string of
  // slashes. An empty tab strip still reports the page, so the conversation
  // knows the Files tab is open with nothing in it.
  const focusedPath = paneOf(tabs, tabs.focused)?.active ?? null
  useLiveContext({
    kind: 'files',
    id: focusedPath,
    label: focusedPath === null ? null : basename(focusedPath),
    detail: focusedPath !== null && dirty.has(focusedPath) ? 'unsaved changes' : null,
  })

  // A real page unload while any draft is dirty is warned about by
  // `fileDrafts.ts`, which the stash effect above feeds — there rather than
  // here, so the warning also holds while this tab is not the one on screen.

  // The Files tab's tab-management chords (task 809, slice 4).
  //
  // **Not Cmd/Ctrl+W.** That chord closes the browser tab and no page can
  // intercept it — Chrome and Safari deliver it to the browser, not to the
  // document — so binding it would ship a shortcut that works nowhere and
  // loses the window. Alt+W is the closest thing that is actually the page's
  // to take, and Alt+[ / Alt+] cycle, in place of Ctrl+Tab and
  // Cmd/Ctrl+Shift+[ / ], which are browser-tab switching for the same reason.
  //
  // Matched on `e.code`, not `e.key`: Alt+W on macOS *is* the character `∑`,
  // and Alt+[ is `“` — the physical key is the only stable thing about these.
  // `preventDefault` fires only once a binding has actually decided to act, so
  // an Alt chord this tab does nothing with still reaches whatever else wants
  // it.
  //
  // Which is the trade, and it is paid in the editor: `shouldIgnoreFilesShortcut`
  // deliberately does NOT stand down in `.files-content-editor` — closing or
  // cycling the file you are editing is what these are for — so with the caret in
  // the code `∑`, `“` and `‘` do not type. Alt is the only chord space this page
  // owns (Cmd/Ctrl+W and Ctrl+Tab are the browser's), and a curly quote lost in a
  // code editor is the smaller loss; `docs/keyboard.md` names it rather than
  // claiming the characters survive everywhere. The find bar's own query box is
  // the one control these stand down in (`'tabs'`, not `'find'`): closing or
  // cycling a tab unmounts that input while it holds focus, and unlike
  // `closeFind` there is nowhere to hand the caret — the pane that would take it
  // is about to be remounted.
  //
  // No dependency array, for the same reason the find effect above has none:
  // the handler closes over the live tabs and dirty set, and listing them is
  // listing most of this component's state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return
      const side = tabs.focused
      if (e.code === 'KeyW') {
        const active = paneOf(tabs, side)?.active
        if (active == null || shouldIgnoreFilesShortcut(e, 'tabs')) return
        e.preventDefault()
        requestClose(side, active)
        return
      }
      if (e.code !== 'BracketLeft' && e.code !== 'BracketRight') return
      const forward = e.code === 'BracketRight'
      // Asked before claiming the key: a pane with nothing to step to leaves
      // the chord alone rather than swallowing it to do nothing.
      const stepped = cycleTab(tabs, side, forward)
      if (stepped === null) return
      if (shouldIgnoreFilesShortcut(e, 'tabs')) return
      e.preventDefault()
      commit((prev) => cycleTab(prev, side, forward))
      focusEditor(paneOf(stepped, side)?.active)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // Cmd/Ctrl+Shift+F — the project-search chord (mesa task 813).
  //
  // This is the chord the in-file find bar deliberately let go: Cmd/Ctrl+F
  // excludes Shift because "find in files" is what Cmd/Ctrl+Shift+F means
  // everywhere it is bound, and the tab had no such surface to open. It has
  // one now, so the tab claims the key it was already declining to misuse —
  // and `docs/keyboard.md` moved with it.
  //
  // Bound on `FilesView` rather than on a pane, unlike Cmd/Ctrl+F: the panel
  // belongs to the tab, not to a file, so there is no focused-pane condition
  // and nothing to race in a split. Escape is NOT bound here — it belongs to
  // whatever has focus (the editor's discard, the find bar's close), and the
  // panel answers it from its own subtree instead.
  //
  // No dependency array, for the reason the tab chords' listener above states.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || !e.shiftKey) return
      if (e.key !== 'f' && e.key !== 'F') return
      if (shouldIgnoreFilesShortcut(e, 'search')) return
      e.preventDefault()
      openSearch()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // Select the query on a fresh open, the same reflex — and for the same
  // reason — as the find bar's twin of this effect: the input does not exist
  // until React has rendered the panel, and a re-open keeps the last query,
  // which `autoFocus` would focus without selecting.
  useEffect(() => {
    if (search.open) searchInputRef.current?.select()
  }, [search.open])

  // Persist the open set (never `fileUi`). Every tabs write funnels through
  // `commit()`, so this one effect covers open/close/activate/focus/split/
  // move/ratio — no save calls sprinkled through the handlers.
  useEffect(() => saveOpenFiles(projectId, tabs), [projectId, tabs])

  // Reset on project change (render-time, off the changed prop — same
  // pattern as GitView/HistoryPane): this component isn't remounted when the
  // route moves between projects, so a stale selection from project A must
  // not leak into project B. Tabs are the one thing that *restores* rather
  // than empties — the new project's own remembered set, never A's.
  //
  // Unsaved drafts are not lost by this, nor by leaving the Files tab (which
  // unmounts this component): they wait in `fileDrafts.ts`, keyed by project —
  // `fileUi` is keyed by a path relative to one, so the same `src/main.rs` in
  // two projects must never inherit the other's text — and `restoreOpen` hands
  // this project's back. What still *discards* a draft is closing its tab
  // (the ×, a middle-click, Alt+W, the bulk closes — each asks first) and a
  // real page unload, which `beforeunload` warns about.
  const [prevProject, setPrevProject] = useState(projectId)
  if (projectId !== prevProject) {
    setPrevProject(projectId)
    setOpen(restoreOpen(projectId, narrow))
    setFocusReq(null)
    setExpanded(new Set())
    setChildrenCache(new Map())
    setTreeOpen(true)
    setTreeAction(null)
    setTreeActionError(null)
    setDownloadError(null)
    setDropDir(null)
    setUpload({ progress: null, replace: null, note: null, done: null })
    setPendingClose(null)
    setPendingBulk(null)
    setTabMenu(null)
    // A search is about one project's tree, and so is the result open on
    // screen; both are meaningless against the next one. The query itself goes
    // with them rather than being carried over, since the panel would
    // otherwise show project A's hits under project B's name until the next
    // Enter. Bumping `searchSeq` is what stops an in-flight walk of A from
    // landing in B.
    searchSeq.current++
    setSearch({ open: false, query: '', caseSensitive: false, wholeWord: false })
    setSearchRun(null)
    setSearchBusy(false)
    setSearchError(null)
    setLanding(null)
  }

  // Drop a pending close whose reason has gone — the file was saved from the
  // pane underneath the bar, the tab was dragged to the other pane, or the
  // other pane opened the same file so closing this one discards nothing.
  // Hiding the bar (which `paneProps` does by re-asking the same predicate) is
  // NOT clearing it: `needsCloseConfirm` is not monotonic, so a tab that goes
  // clean and then dirty again would re-mount a prompt nobody raised — and its
  // "keep editing" button is autofocused, so it would pull the caret out of the
  // code mid-keystroke. `requestClose` is the only thing that arms this, and
  // this is the only thing that disarms it without an answer.
  if (
    pendingClose !== null &&
    !needsCloseConfirm(tabs, pendingClose.side, pendingClose.path, dirty)
  ) {
    setPendingClose(null)
  }
  // The bulk prompt's paths that still need it, re-asked every render by the
  // same rule — and dropped, by the same reasoning as above, once none do.
  const bulkLeft =
    pendingBulk === null
      ? []
      : splitBulkClose(tabs, pendingBulk.side, pendingBulk.paths, dirty).ask
  if (pendingBulk !== null && bulkLeft.length === 0) setPendingBulk(null)

  /**
   * Every tabs write goes through here, as a **transition off the previous
   * state** rather than off the render's `tabs` — so two opens landing in one
   * batch both take effect, instead of the second overwriting the first from
   * a stale closure. A `null` transition (`fileTabs.ts`'s no-op answer) writes
   * nothing at all.
   *
   * It is also where a path whose last tab just closed drops its draft and
   * history — the "closing a tab discards its draft, no confirm" half of the
   * state lifetime, and the reason this is one updater and not two.
   */
  function commit(step: (prev: TabsState) => TabsState | null) {
    setOpen((prev) => {
      const next = step(prev.tabs)
      if (next === null || next === prev.tabs) return prev
      const keep = new Set(openPaths(next))
      const stale = [...prev.fileUi.keys()].filter((p) => !keep.has(p))
      if (stale.length === 0) return { tabs: next, fileUi: prev.fileUi }
      const fileUi = new Map(prev.fileUi)
      for (const p of stale) fileUi.delete(p)
      return { tabs: next, fileUi }
    })
  }

  /**
   * The one way a tab is closed — the × , a middle-click and Alt+W all land
   * here (task 809, slice 4).
   *
   * `closeTab` discards the draft with the tab, deliberately and with no
   * confirmation (`fileTabs.ts`, and the app's no-prompt posture generally).
   * That is right for a clean tab and wrong for unsaved work, so this is the
   * one close that stops to ask — and only when the answer matters:
   * `needsCloseConfirm` says no for a clean tab, and no for a dirty file the
   * other pane still holds, where nothing is discarded at all.
   */
  function requestClose(side: PaneSide, path: string) {
    if (needsCloseConfirm(tabs, side, path, dirty)) {
      setPendingBulk(null)
      setPendingClose({ side, path })
      return
    }
    setPendingClose(null)
    commit((prev) => closeTab(prev, side, path))
  }

  /** A tab menu pick (naru task 2730). The clean tabs in the set close now;
   *  the dirty ones stay open behind one prompt, never discarded unasked. */
  function pickTabMenu(menu: TabMenuState, action: 'close' | BulkClose) {
    setTabMenu(null)
    // The picked item unmounts with the menu; once the closes have rendered,
    // hand the caret back to the tab it came from, or — if that one closed —
    // to the focused pane's active tab, so a keyboard user stays in the strip.
    // A confirm bar the pick raised keeps its autofocused safe answer.
    requestAnimationFrame(() => {
      if (document.activeElement?.closest('.files-close-confirm')) return
      const back = menu.trigger.isConnected
        ? menu.trigger
        : document.querySelector<HTMLElement>('.files-content-pane.focused .files-tab.active .files-tab-label')
      back?.focus()
    })
    if (action === 'close') {
      requestClose(menu.side, menu.path)
      return
    }
    const targets = bulkCloseTargets(tabs, menu.side, menu.path, action, dirty)
    const { now, ask } = splitBulkClose(tabs, menu.side, targets, dirty)
    setPendingClose(null)
    setPendingBulk(ask.length > 0 ? { side: menu.side, paths: ask } : null)
    commit((prev) => closeTabs(prev, menu.side, now))
  }

  /** "Discard N and close" — the bulk prompt's destructive answer. */
  function confirmBulk() {
    const pending = pendingBulk
    if (pending === null) return
    const paths = bulkLeft
    setPendingBulk(null)
    commit((prev) => closeTabs(prev, pending.side, paths))
  }

  const closeTabMenu = useCallback(() => setTabMenu(null), [])

  /** "discard and close" — the prompt's one destructive answer. */
  function confirmClose() {
    const pending = pendingClose
    if (pending === null) return
    setPendingClose(null)
    commit((prev) => closeTab(prev, pending.side, pending.path))
  }

  /** Cmd/Ctrl+Shift+F, and the tree pane's Search toggle.
   *
   * On an already-open panel it is "let me retype that" — a `focus()` *and* a
   * `select()`, the pair `openFind` documents: `select()` alone sets a range
   * without moving focus, and this chord is deliberately claimed from the
   * editor, where the characters typed next would otherwise land in the file.
   *
   * Opening also undoes whatever is hiding the pane the panel appears in: the
   * wide tier's collapse and the phone tier's `treeOpen`. A shortcut that
   * opened a surface the user cannot see would read as doing nothing. */
  function openSearch() {
    setTreeCollapsed(false)
    saveFilesTreeCollapsed(false)
    setTreeOpen(true)
    if (search.open) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return
    }
    setSearch((prev) => ({ ...prev, open: true }))
  }

  /** Closing keeps the query and the results — the panel reopens where it was,
   *  the same promise `closeFind` makes one file down — and hands the caret to
   *  the toggle that reopens it, rather than dropping it on `<body>`. */
  function closeSearch() {
    setSearch((prev) => ({ ...prev, open: false }))
    searchToggleRef.current?.focus()
  }

  /** Run the search: Enter in the box, or a toggle click (a deliberate re-ask
   *  of the same question). Never a keystroke — see `SearchPanel`.
   *
   *  `next` is passed in rather than read from state because a toggle click
   *  runs the search for the value it is *setting*, not the one on screen —
   *  the same reason `runFind` recomputes instead of reading its render's
   *  matches. */
  function runSearch(next: SearchState) {
    const query = searchRequestQuery(next.query)
    if (query === null) {
      setSearchRun(null)
      setSearchError(null)
      return
    }
    const seq = ++searchSeq.current
    setSearchBusy(true)
    setSearchError(null)
    const options = {
      caseSensitive: next.caseSensitive,
      wholeWord: next.wholeWord,
    }
    searchProjectFiles(projectId, query, options).then(
      (data) => {
        // A walk that lands after a later one asked a different question is
        // an answer nobody is waiting for.
        if (seq !== searchSeq.current) return
        setSearchBusy(false)
        setSearchRun({ query, ...options, data })
      },
      (e) => {
        if (seq !== searchSeq.current) return
        setSearchBusy(false)
        setSearchError(e instanceof ApiError ? e.message : 'Search failed.')
      },
    )
  }

  /** A result clicked: open the file the way the tree opens one, and hand the
   *  pane that gets it the line to land on (`SearchLanding`). */
  function openResult(path: string, line: number) {
    commit((prev) => openFile(prev, path))
    // The caret stays with the panel being clicked through.
    setFocusReq(null)
    setLanding({
      seq: ++landingSeq.current,
      path,
      line,
      query: searchRun?.query ?? '',
      caseSensitive: searchRun?.caseSensitive ?? false,
      wholeWord: searchRun?.wholeWord ?? false,
    })
    // Same reason a tree click does it: on the phone tier the pane and the
    // file are stacked, so leaving the panel up pushes the file below the
    // fold. Inert above 600px, where both are on screen at once.
    setTreeOpen(false)
  }

  function patchUi(path: string, patch: UiPatch) {
    setOpen((prev) => {
      const held = prev.fileUi.get(path) ?? BLANK_FILE_UI
      const next = typeof patch === 'function' ? patch(held) : patch
      if (next === null) return prev
      return { ...prev, fileUi: new Map(prev.fileUi).set(path, { ...held, ...next }) }
    })
  }

  /** Fetches one directory level and installs it in the cache, replacing
   *  whatever was there — the "drop the entry and re-fetch" half of a create,
   *  and the fetch half of `ensureChildren`'s first expand. */
  function loadDir(path: string) {
    setChildrenCache((prev) => new Map(prev).set(path, 'loading'))
    getProjectFiles(projectId, path).then(
      (res) => {
        setChildrenCache((prev) =>
          new Map(prev).set(path, {
            entries: res.tree ?? [],
            truncated: res.truncated,
          }),
        )
      },
      () => {
        setChildrenCache((prev) => new Map(prev).set(path, 'error'))
      },
    )
  }

  function ensureChildren(path: string) {
    if (childrenCache.has(path)) return // loaded or already loading
    loadDir(path)
  }

  function toggle(entry: FileTreeEntry) {
    const opening = !expanded.has(entry.path)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
    if (opening) ensureChildren(entry.path)
  }

  /** Opens one of the three inline rows, closing whatever was open and clearing
   *  the last one's message — the single chokepoint that makes `TreeAction`'s
   *  "at most one" hold however the row was reached. */
  function openTreeAction(action: TreeAction) {
    setTreeActionError(null)
    setTreeAction(action)
  }

  function cancelTreeAction() {
    setTreeAction(null)
    setTreeActionError(null)
  }

  /** Re-reads the directory level a change landed in. The server has already
   *  evicted its own 5s cache entry for that level, so this sees the result;
   *  the root is the tab's own loader, anything deeper is the per-directory
   *  cache. */
  function reloadLevel(parent: string) {
    if (parent === '') refetch()
    else loadDir(parent)
  }

  /** Opens the naming row under `parent` (`''` = the project root), expanding
   *  that directory first so the row has somewhere to appear. */
  function startCreate(parent: string) {
    openTreeAction({ kind: 'create', parent })
    if (parent === '') return
    setExpanded((prev) => new Set(prev).add(parent))
    ensureChildren(parent)
  }

  /** Enter on the naming row. The client-side name rules run first
   *  (`newFile.ts`) so an obviously bad name is an instant message rather than
   *  a round trip; the server re-validates everything regardless, and its own
   *  409/422/404 lands in the same place. */
  async function submitCreate(name: string) {
    if (treeAction?.kind !== 'create' || treeBusy) return
    const parent = treeAction.parent
    const decided = newFilePath(parent, name)
    if (!decided.ok) {
      setTreeActionError(decided.reason)
      return
    }
    setTreeBusy(true)
    setTreeActionError(null)
    try {
      await createProjectFile(projectId, decided.path)
      setTreeAction(null)
      reloadLevel(parent)
      commit((prev) => openFile(prev, decided.path))
      focusEditor(decided.path)
      // Same reason the tree closes when a file is picked: on the phone tier
      // a full column of rows would push the file below the fold. Inert above
      // 600px.
      setTreeOpen(false)
    } catch (e) {
      setTreeActionError(
        e instanceof ApiError ? e.message : 'Failed to create file.',
      )
    } finally {
      setTreeBusy(false)
    }
  }

  /**
   * Enter on the rename input (mesa task 877).
   *
   * The same client-side gate the create row uses, and for the same reason: a
   * rename is "this entry's parent + one component → a path", which is exactly
   * `newFilePath`'s question, so an obviously bad name is an instant message and
   * fires no request. The server stays authoritative.
   *
   * A name equal to the current one is a plain cancel — the request would be a
   * no-op at best and a spurious 409 at worst.
   *
   * On success the file stays open and viewing: the tabs transition goes through
   * `commit()` like every other, so `fileUi` for a path that is no longer open
   * is dropped by the machinery that already does that, and a renamed file's
   * draft/history are re-keyed onto the new path just before it.
   */
  async function submitRename(name: string) {
    if (treeAction?.kind !== 'rename' || treeBusy) return
    const { path, isDir } = treeAction
    const parent = dirname(path)
    const decided = newFilePath(parent, name)
    if (!decided.ok) {
      setTreeActionError(decided.reason)
      return
    }
    if (decided.path === path) {
      cancelTreeAction()
      return
    }
    setTreeBusy(true)
    setTreeActionError(null)
    try {
      const entry = await renameProjectFileEntry(projectId, path, name.trim())
      setTreeAction(null)
      reloadLevel(parent)
      // A renamed directory's cached children and expanded flags are all filed
      // under the old path. The cache entries are simply dead — nothing can ask
      // for that level again — but the expanded flags still mean something: the
      // user has those folders open, so they are re-keyed onto the new prefix
      // *and re-fetched*. Re-keying alone is what shipped wrong first: a row
      // that is expanded with no cache entry is neither 'loading' nor a level
      // with entries, so a renamed folder sat open and blank until it was
      // collapsed and opened again.
      if (isDir) {
        const rekey = (key: string) => entry.path + key.slice(path.length)
        const under = (key: string) => key === path || key.startsWith(`${path}/`)
        const reopened = [...expanded].filter(under).map(rekey)
        setChildrenCache((prev) => {
          const next = new Map(prev)
          for (const key of prev.keys()) {
            if (under(key)) next.delete(key)
          }
          return next
        })
        setExpanded((prev) => {
          const next = new Set<string>()
          for (const key of prev) next.add(under(key) ? rekey(key) : key)
          return next
        })
        for (const dir of reopened) loadDir(dir)
      }
      // The per-file state is keyed by path, so it moves with the rename — an
      // unsaved draft above all — before the tabs do: `commit` drops whatever
      // is filed under a path that is no longer open. A destination that
      // already has state of its own (a stale tab for the new name) keeps it.
      setOpen((prev) => {
        const fileUi = new Map<string, FileUiState>()
        for (const [key, ui] of prev.fileUi) {
          const moved =
            key === path || key.startsWith(`${path}/`)
              ? entry.path + key.slice(path.length)
              : key
          if (moved === key || !prev.fileUi.has(moved)) fileUi.set(moved, ui)
        }
        return { ...prev, fileUi }
      })
      commit((prev) => renameSubtree(prev, path, entry.path))
    } catch (e) {
      setTreeActionError(
        e instanceof ApiError ? e.message : 'Failed to rename.',
      )
    } finally {
      setTreeBusy(false)
    }
  }

  /** "delete" — the prompt's one destructive answer (mesa task 877). A
   *  directory goes recursively, which is what its wording says; the tabs it
   *  had open close through `closeSubtree`, since the bytes they were showing
   *  are gone. */
  async function confirmDeleteEntry() {
    if (treeAction?.kind !== 'delete' || treeBusy) return
    const { path, isDir } = treeAction
    setTreeBusy(true)
    setTreeActionError(null)
    try {
      await deleteProjectFileEntry(projectId, path)
      setTreeAction(null)
      reloadLevel(dirname(path))
      if (isDir) {
        setChildrenCache((prev) => {
          const next = new Map(prev)
          for (const key of prev.keys()) {
            if (key === path || key.startsWith(`${path}/`)) next.delete(key)
          }
          return next
        })
      }
      commit((prev) => closeSubtree(prev, path))
    } catch (e) {
      setTreeActionError(
        e instanceof ApiError ? e.message : 'Failed to delete.',
      )
    } finally {
      setTreeBusy(false)
    }
  }

  /**
   * Uploads `files` into `dir`, one at a time (naru task 2732), then re-reads
   * that level and expands it. Each file is checked client-side first
   * (`fileUpload.ts`); a 409 raises the Replace question and the loop waits for
   * its answer before moving on. One file failing never stops the rest — every
   * outcome is collected and summarised at the end. Exactly one uploaded file
   * opens in the focused pane, the way a created file does.
   */
  async function uploadFiles(dir: string, files: File[], folders: number) {
    if (files.length === 0 && folders === 0) return
    if (uploading.current) {
      setUpload((prev) => ({
        ...prev,
        note: 'An upload is already running — drop again when it finishes.',
      }))
      return
    }
    uploading.current = true
    const run = uploadRun.current
    setUpload({ progress: null, replace: null, note: null, done: null })
    const results: UploadResult[] = []
    let opened: string | null = null
    for (const [i, file] of files.entries()) {
      if (uploadRun.current !== run) return
      const name = file.name
      setUpload((prev) => ({
        ...prev,
        progress: { name, index: i + 1, total: files.length },
      }))
      const named = newFilePath('', name)
      const tooBig = uploadSizeProblem(file.size)
      if (!named.ok || tooBig !== null) {
        const message = !named.ok ? named.reason : (tooBig ?? '')
        results.push({ name, outcome: 'failed', message })
        continue
      }
      let content: string
      try {
        content = await readAsBase64(file)
      } catch {
        results.push({ name, outcome: 'failed', message: 'could not be read.' })
        continue
      }
      if (uploadRun.current !== run) return
      try {
        let entry: FileTreeEntry
        try {
          entry = await uploadProjectFile(projectId, dir, name, content, false)
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e
          if (uploadRun.current !== run) return
          setUpload((prev) => ({
            ...prev,
            replace: name,
            replacePath: dir === '' ? name : `${dir}/${name}`,
          }))
          const replace = await new Promise<boolean>((resolve) => {
            replaceAnswer.current = resolve
          })
          replaceAnswer.current = null
          if (uploadRun.current !== run) return
          setUpload((prev) => ({ ...prev, replace: null }))
          if (!replace) {
            results.push({ name, outcome: 'skipped', message: SKIPPED })
            continue
          }
          entry = await uploadProjectFile(projectId, dir, name, content, true)
          // The file is open somewhere with the old bytes: re-read it, and
          // drop its draft — the person just chose to replace it, and a draft
          // kept would overwrite the upload on the next save.
          patchUi(entry.path, NO_DRAFT)
          setReloads((prev) => ({ ...prev, [entry.path]: (prev[entry.path] ?? 0) + 1 }))
        }
        results.push({ name, outcome: 'uploaded' })
        opened = entry.path
      } catch (e) {
        results.push({
          name,
          outcome: 'failed',
          message: e instanceof Error ? e.message : 'upload failed.',
        })
      }
    }
    if (uploadRun.current !== run) return
    uploading.current = false
    if (results.some((r) => r.outcome === 'uploaded')) {
      if (dir !== '') setExpanded((prev) => new Set(prev).add(dir))
      reloadLevel(dir)
    }
    if (files.length === 1 && opened !== null) {
      const path = opened
      commit((prev) => openFile(prev, path))
      // Same reason the create flow closes the tree: the phone tier stacks it.
      setTreeOpen(false)
    }
    setUpload({
      progress: null,
      replace: null,
      note: null,
      done: summarizeUploads(results, folders),
    })
  }

  /** Where an OS file drag over `target` would land — the row's folder, or the
   *  project root where it is not over a row. */
  function dropTarget(target: EventTarget): string {
    const row = target instanceof Element ? target.closest('[data-upload-path]') : null
    return uploadTargetDir(
      row instanceof HTMLElement
        ? { path: row.dataset.uploadPath ?? '', isDir: row.dataset.uploadRow === 'dir' }
        : null,
    )
  }

  // `dragenter` and `dragover` do the same, as the strips' do. Every OS file
  // drag over the Files tab is `preventDefault()`ed, target or not, or the
  // browser would navigate to the dropped file.
  function overUpload(e: ReactDragEvent) {
    if (!isOsFileDrag(e.dataTransfer.types, dragging !== null)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropDir(dropTarget(e.target))
  }

  function dropUpload(e: ReactDragEvent) {
    if (!isOsFileDrag(e.dataTransfer.types, dragging !== null)) return
    e.preventDefault()
    setDropDir(null)
    // Read now: the item list is emptied once the handler returns.
    const items = Array.from(e.dataTransfer.items ?? []).filter((it) => it.kind === 'file')
    const dropped = splitDropped(
      Array.from(e.dataTransfer.files),
      items.map((it) => it.webkitGetAsEntry?.()?.isDirectory),
    )
    void uploadFiles(dropTarget(e.target), dropped.files, dropped.folders)
  }

  const treeOps: TreeOps = {
    action: treeAction,
    error: treeActionError,
    busy: treeBusy,
    dropDir,
    onCreateStart: startCreate,
    onCreateSubmit: submitCreate,
    onRenameStart: (entry) =>
      openTreeAction({
        kind: 'rename',
        path: entry.path,
        name: entry.name,
        isDir: entry.is_dir,
      }),
    onRenameSubmit: submitRename,
    onDeleteStart: (entry) =>
      openTreeAction({
        kind: 'delete',
        path: entry.path,
        name: entry.name,
        isDir: entry.is_dir,
      }),
    onDeleteConfirm: confirmDeleteEntry,
    onCancel: cancelTreeAction,
    onDownload: (entry) => {
      setDownloadError(null)
      void downloadProjectFile(projectId, entry.path).then((message) => {
        if (message !== null) setDownloadError({ path: entry.path, message })
      })
    },
    onFileDragStart: (e, path) =>
      setDragOutData(e.dataTransfer, location.origin, projectId, path),
    downloadError,
  }

  // Same `dragenter`-as-well-as-`dragover` rule as the strips above.
  function armEdge(e: ReactDragEvent) {
    if (dragging === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setEdgeArmed(true)
  }

  function endDrag() {
    // Cleared here as well as in the tab's `dragend`: a tab that moved panes
    // was unmounted mid-drag and may never fire one, and a stale slot would
    // make every later OS file drag look like a tab drag (naru task 2732).
    dragging = null
    setDragActive(false)
    setMark(null)
    setEdgeArmed(false)
  }

  // Written through on every flip rather than in an effect: this is one
  // deliberate click, and storage should carry exactly what the status bar
  // shows.
  function toggleWrap(next: boolean) {
    setWrap(next)
    saveWordWrap(next)
  }

  if (error && !data) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>

  // Quiet empty states (M10) — data shapes, not errors.
  if (data.path === null) {
    return <NoLocalPathPlaceholder projectId={projectId} />
  }
  if (data.tree === null) {
    return <DeadFolderPlaceholder path={data.path} />
  }

  const split = tabs.right !== null
  // The tree's highlight follows the focused pane's active tab — the file the
  // user is looking at, in a split as much as out of one.
  const selectedPath = (split && tabs.focused === 'right' ? tabs.right! : tabs.left)
    .active

  function paneProps(side: PaneSide) {
    const pane = side === 'left' ? tabs.left : tabs.right!
    return {
      projectId,
      side,
      tabs: pane.tabs,
      active: pane.active,
      focused: !split || tabs.focused === side,
      // One level of splitting, and the control only makes sense with
      // something to show in the second pane.
      canSplit: !split && !narrow && pane.active !== null,
      mark,
      dirty,
      // Re-asked every render rather than trusted: the prompt must vanish by
      // itself if its own reason does — the file gets saved from the pane
      // underneath, the tab is dragged to the other pane, or the other pane
      // opens the same file and closing this one stops discarding anything.
      // The same predicate that raised it is the one that keeps it up.
      pendingClose:
        pendingClose?.side === side &&
        needsCloseConfirm(tabs, side, pendingClose.path, dirty)
          ? pendingClose.path
          : null,
      fileUi,
      reloads,
      changed,
      // Only the pane the keyboard belongs to, and never on the phone tier,
      // where focusing the editor raises the soft keyboard over the file.
      focusSeq:
        !narrow &&
        focusReq !== null &&
        focusReq.path === pane.active &&
        (!split || tabs.focused === side)
          ? focusReq.seq
          : 0,
      onFocusTaken: () => setFocusReq(null),
      onUi: patchUi,
      wrap,
      onWrapChange: toggleWrap,
      landing,
      onFocus: () => commit((prev) => focusPane(prev, side)),
      onActivate: (path: string) => {
        commit((prev) => activateTab(prev, side, path))
        focusEditor(path)
      },
      onClose: (path: string) => requestClose(side, path),
      onConfirmClose: confirmClose,
      onCancelClose: () => setPendingClose(null),
      pendingBulk: pendingBulk?.side === side ? bulkLeft.length : 0,
      onMenu: (path: string, at: { x: number; y: number }, trigger: HTMLElement) =>
        setTabMenu({ side, path, x: at.x, y: at.y, trigger }),
      onConfirmBulk: confirmBulk,
      onCancelBulk: () => setPendingBulk(null),
      onSplit: () => commit(splitPane),
      onDragBegin: () => setDragActive(true),
      onDragFinish: endDrag,
      onDragOverStrip: (index: number) => {
        setEdgeArmed(false)
        setMark({ side, index })
      },
      onDropOnStrip: (index: number) => {
        const from = dragging
        if (from !== null) commit((prev) => moveTab(prev, from, side, index))
        endDrag()
      },
      // Only the indicator goes; the drag is still live and may yet land on
      // the other strip or the split zone.
      onDragLeaveStrip: () => setMark(null),
    }
  }

  return (
    <div
      className={`files-view${dropDir !== null ? ' upload-dragging' : ''}`}
      onDragEnter={overUpload}
      onDragOver={overUpload}
      onDragLeave={(e) => {
        // Entering a child fires leave on its parent; only leaving the view
        // (or the window) ends the highlight.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setDropDir(null)
      }}
      onDrop={dropUpload}
    >
      {dropDir !== null && <div className="files-upload-hint">{dropHint(dropDir)}</div>}
      {upload.progress !== null && (
        <p className="muted files-upload-progress" role="status">
          {progressLabel(upload.progress.name, upload.progress.index, upload.progress.total)}
          {upload.note !== null && <span className="error"> {upload.note}</span>}
        </p>
      )}
      {upload.replace !== null && (
        <div
          className="confirm-delete files-upload-replace"
          role="alert"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            replaceAnswer.current?.(false)
          }}
        >
          <span className="confirm-message">
            Replace {upload.replace}?
            {/* The upload drops the open file's draft with the bytes it was
                typed over; say so when there is one. */}
            {upload.replacePath !== undefined &&
              dirty.has(upload.replacePath) &&
              ' Its unsaved edits will be discarded.'}
          </span>
          <button className="danger files-upload-replace-yes" onClick={() => replaceAnswer.current?.(true)}>
            replace
          </button>
          <button autoFocus className="files-upload-replace-no" onClick={() => replaceAnswer.current?.(false)}>
            cancel
          </button>
        </div>
      )}
      {upload.progress === null && upload.replace === null && upload.done !== null && (
        <div className="files-upload-summary" role="status">
          {upload.done.ok !== null && <span className="muted">{upload.done.ok}</span>}
          {upload.done.problems.map((problem, i) => (
            <span key={i} className="error">
              {problem}
            </span>
          ))}
          <button
            type="button"
            className="files-upload-dismiss"
            onClick={() => setUpload((prev) => ({ ...prev, done: null }))}
          >
            dismiss
          </button>
        </div>
      )}
      {data.truncated && (
        <p className="muted files-truncated-note">
          This folder is larger than what's shown here — the tree was capped.
        </p>
      )}
      {/* An empty root is a row inside the tree, not a placeholder instead of
          it (task 672): the layout has to render for the root's own `+` to
          exist, and creating the first file in an empty project is exactly
          when it is wanted. */}
      <div className={`files-layout${dropDir === '' ? ' upload-root' : ''}`}>
        {/* Phone-tier affordance for the collapse above; hidden by CSS at
            every wider tier, where the tree never leaves. Rendered before
            the tree so it stays put as the tree comes and goes, and so the
            two read as one control in the tab order. */}
        <button
          type="button"
          className="files-tree-phone-toggle"
          aria-expanded={treeOpen}
          onClick={() => setTreeOpen((open) => !open)}
        >
          {treeOpen ? '▾' : '▸'} file tree
          {!treeOpen && selectedPath !== null && (
            <span className="files-tree-phone-crumb"> — {selectedPath}</span>
          )}
        </button>
        {/* The tree pane (mesa task 671): the sized, collapsible box the
            tree scrolls inside. The width is applied as a custom property,
            never an inline `width` — the ≤860px tier stacks the panes into
            a column and relaxes the tree to `width: auto`, and an inline
            width would beat that rule and hand a 390px screen a drag-width
            tree. The collapse is CSS-only for the same reason: the rail and
            the tree are both always rendered, and only the wide tier has a
            rule that hides either, so the flag cannot leak downward. */}
        <div
          className={`files-tree-pane${treeCollapsed ? ' collapsed' : ''}${
            treeResizing ? ' resizing' : ''
          }${treeOpen ? '' : ' files-tree-collapsed'}`}
          ref={treeRef}
          style={{ '--files-tree-width': `${treeWidth}px` } as CSSProperties}
        >
          {/* Header rail above the tree: the root's own `+` beside the
              collapse toggle, since the root has no row of its own to hang
              one on. */}
          <div className="files-tree-head">
            <NewFileButton
              parent=""
              label="New file in the project root"
              ops={treeOps}
            />
            <UploadButton onPick={(files) => void uploadFiles('', files, 0)} />
            {/* The mouse route to the same panel Cmd/Ctrl+Shift+F opens, and
                the control the panel hands the caret back to when it closes.
                Rendered whether or not the panel is open, so that hand-off
                always has somewhere to go. */}
            <button
              type="button"
              ref={searchToggleRef}
              className="files-tree-search-toggle"
              aria-pressed={search.open}
              aria-label="Search in project files"
              title="Search in project files (Cmd/Ctrl+Shift+F)"
              onClick={() => (search.open ? closeSearch() : openSearch())}
            >
              ⌕
            </button>
            <button
              type="button"
              className="files-tree-collapse-toggle"
              aria-expanded={!treeCollapsed}
              aria-label={
                treeCollapsed ? 'Expand file tree' : 'Collapse file tree'
              }
              title={treeCollapsed ? 'Expand file tree' : 'Collapse file tree'}
              // Written straight through rather than from a `[treeCollapsed]`
              // effect: an updater with a localStorage write inside it isn't
              // pure, and an effect would also re-save on mount.
              onClick={() => {
                setTreeCollapsed(!treeCollapsed)
                saveFilesTreeCollapsed(!treeCollapsed)
              }}
            >
              {treeCollapsed ? '»' : '«'}
            </button>
          </div>
          {/* The panel takes the tree's place rather than opening over the
              file (mesa task 813): it inherits this pane's width, collapse
              and phone-tier stack, and leaves the file it points into fully
              visible beside it. The tree is unmounted while it is up, so the
              two can never scroll past each other in one column — reopening
              the tree costs nothing, since `childrenCache` outlives this. */}
          {search.open ? (
            <SearchPanel
              state={search}
              run={searchRun}
              busy={searchBusy}
              error={searchError}
              inputRef={searchInputRef}
              onChange={(patch) => {
                const next = { ...search, ...patch }
                setSearch(next)
                // A toggle is a deliberate re-ask of the same question, so it
                // re-runs immediately — but only once there is a query to
                // re-ask, and never for typing, which is what `onSubmit` is.
                if (patch.query === undefined && searchRun !== null) runSearch(next)
              }}
              onSubmit={() => runSearch(search)}
              onOpen={openResult}
              onClose={closeSearch}
            />
          ) : (
          <ul className="files-tree">
            {treeOps.action?.kind === 'create' &&
              treeOps.action.parent === '' && (
                <NewFileRow depth={0} ops={treeOps} />
              )}
            {data.tree.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                expanded={expanded}
                onToggle={toggle}
                childrenCache={childrenCache}
                selectedPath={selectedPath}
                onSelectFile={(path) => {
                  // Opens into the focused pane and activates it — or just
                  // activates the tab already holding it, wherever that is.
                  commit((prev) => openFile(prev, path))
                  focusEditor(path)
                  // Opening a file closes the tree, which is what makes the
                  // phone tier's stacked layout usable: the tree is a full
                  // column of rows, so leaving it up pushes the file itself
                  // below the fold (measured at 390x844: the content pane's
                  // top sat at 643px of an 844px viewport). Inert above
                  // 600px, per `treeOpen` above.
                  setTreeOpen(false)
                }}
                ops={treeOps}
              />
            ))}
            {data.tree.length === 0 && (
              <li className="files-tree-note muted">This folder is empty.</li>
            )}
          </ul>
          )}
          {/* Drag handle on the pane's own right edge — absolutely
              positioned so the tree's `overflow-y: auto` can't scroll it
              away, straddling the border so it's grabbable from either
              side (the agent rail's trick). Hidden along with the tree
              while collapsed, and by CSS at every tier that stacks. */}
          <div
            className="files-tree-resize-handle"
            onMouseDown={(e) => {
              e.preventDefault()
              setTreeResizing(true)
            }}
            onDoubleClick={() => {
              setTreeWidth(DEFAULT_FILES_TREE_WIDTH)
              clearFilesTreeWidth()
            }}
          />
        </div>
        <div className="files-panes" ref={panesRef}>
          <FilePane
            {...paneProps('left')}
            style={split ? { flex: `0 0 calc(${tabs.ratio * 100}% - 0.25rem)` } : undefined}
          />
          {split && (
            <>
              {/* Pointer events, not HTML5 drag: a divider is a continuous
                  resize, and a drag image following the cursor would be
                  nonsense. Capture keeps the drag alive over the panes'
                  own iframes/textareas. */}
              <div
                className="files-pane-divider"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId)
                }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
                  const box = panesRef.current?.getBoundingClientRect()
                  if (box === undefined || box.width === 0) return
                  const ratio = (e.clientX - box.left) / box.width
                  commit((prev) => setRatio(prev, ratio))
                }}
                onPointerUp={(e) => {
                  e.currentTarget.releasePointerCapture(e.pointerId)
                }}
              />
              <FilePane {...paneProps('right')} style={{ flex: '1 1 0' }} />
            </>
          )}
          {/* Drag a tab onto the right edge to open the split. Rendered
              only mid-drag, so it never eats a click, and never at the
              narrow tier, where there is no split to enter. */}
          {!split && !narrow && dragActive && (
            <div
              className={`files-split-drop${edgeArmed ? ' armed' : ''}`}
              onDragEnter={armEdge}
              onDragOver={armEdge}
              onDragLeave={() => setEdgeArmed(false)}
              onDrop={(e) => {
                if (dragging === null) return
                e.preventDefault()
                const from = dragging
                commit((prev) => splitWithTab(prev, from))
                endDrag()
              }}
            >
              <span>Split</span>
            </div>
          )}
        </div>
      </div>
      {tabMenu !== null && (
        <TabMenu
          menu={tabMenu}
          enabled={(action) =>
            action === 'close' ||
            bulkCloseTargets(tabs, tabMenu.side, tabMenu.path, action, dirty).length > 0
          }
          onPick={(action) => pickTabMenu(tabMenu, action)}
          onClose={closeTabMenu}
        />
      )}
    </div>
  )
}
