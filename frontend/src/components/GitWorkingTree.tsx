import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MutableRefObject, ReactNode } from 'react'
import { getProjectGitDiff } from '../api'
import { useFetch } from '../useFetch'
import { DiffView } from './DiffView'
import type { DiffStaging } from './DiffView'
import { GitCommitBox } from './GitCommitBox'
import { GitConfirmDialog } from './GitConfirmDialog'
import {
  alertText,
  controlLabel,
  createGitActions,
  plural,
  projectGitApi,
} from '../gitActions'
import type {
  CommitOutcome,
  CommitRequest,
  DiscardItem,
  DiscardPlan,
  Verb,
  WriteCtx,
  WriteOutcome,
} from '../gitActions'
import { hunkLostLines, wholeHunk } from '../gitHunks'
import type { HunkPick } from '../gitHunks'
import {
  SECTION_ORDER,
  SECTION_TITLES,
  TREE_MODE_KEY,
  WT_SECTIONS_KEY,
  badgeOf,
  bulkAction,
  clickSelect,
  dirKey,
  filterEntries,
  parseOpenSections,
  parseViewMode,
  pruneToVisible,
  reconcileSelection,
  sectionRows,
  splitPath,
  splitSections,
  statusWord,
} from '../gitWorktree'
import type { Entry, Row, SectionKind, Sections, Selection, ViewMode } from '../gitWorktree'
import type { GitRepoView } from '../types/GitRepoView'

const OPERATIONS: Record<string, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
  bisect: 'Bisect',
}

/** One hunk or line write the diff pane asks for (naru task 2739). */
type HunkWrite = {
  verb: 'stage' | 'unstage' | 'discard'
  digest: string
  picks: HunkPick[]
  /** The lines a discard loses, for its dialog. */
  lost?: string[]
}

/** What `GitWorkingTree` gives the diff pane to enable hunk and line staging. */
type HunkOps = {
  staged: boolean
  busy: boolean
  label: DiffStaging['label']
  onWrite: (w: HunkWrite) => void
  registerClear: DiffStaging['registerClear']
}

/** The selected working-tree file's unified diff, scoped to `worktree` when a
 * non-default one is selected. `staged` picks the side: true = index vs HEAD,
 * false = working tree vs index, undefined = plain (a conflict's markers).
 * A bump of `rev` (a write settled) re-reads the diff IN PLACE: the previous
 * diff of the same file and side stays mounted, so the scroll position
 * survives; another file still shows "Loading…". */
function DiffPane({
  projectId,
  path,
  worktree,
  repo,
  staged,
  rev,
  hunkOps,
}: {
  projectId: number
  path: string
  worktree: string | null
  repo: string | undefined
  staged: boolean | undefined
  rev: number
  hunkOps: HunkOps | undefined
}) {
  const { data, error, refetch } = useFetch(
    () => getProjectGitDiff(projectId, path, worktree ?? undefined, repo, staged),
    `git-diff-${projectId}-${repo ?? ''}-${worktree ?? ''}-${String(staged)}-${path}`,
  )
  const [loadedRev, setLoadedRev] = useState(rev)
  const firstRev = useRef(true)
  useEffect(() => {
    if (firstRev.current) {
      firstRev.current = false
      return
    }
    void refetch().then(() => setLoadedRev(rev))
  }, [rev, refetch])
  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  const staging: DiffStaging | undefined = hunkOps && {
    staged: hunkOps.staged,
    digest: data.digest,
    // The digest belongs to the diff on screen: no write until it is reloaded.
    disabled: hunkOps.busy || loadedRev !== rev,
    label: hunkOps.label,
    onHunk: (verb, hunk, model) =>
      data.digest !== null &&
      hunkOps.onWrite({
        verb,
        digest: data.digest,
        picks: wholeHunk(hunk),
        lost: verb === 'discard' ? hunkLostLines(model, hunk) : undefined,
      }),
    onLines: (verb, picks) =>
      data.digest !== null && hunkOps.onWrite({ verb, digest: data.digest, picks }),
    registerClear: hunkOps.registerClear,
  }
  return (
    <DiffView
      key={`${worktree ?? ''} ${String(staged)} ${path}`}
      diff={data.diff}
      path={path}
      staging={staging}
    />
  )
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode: the pick just is not remembered
  }
}

const GLYPH: Record<Verb, string> = { stage: '+', unstage: '−', discard: '↶', delete: '✕' }
const WORD: Record<Verb, string> = {
  stage: 'Stage',
  unstage: 'Unstage',
  discard: 'Discard',
  delete: 'Delete',
}

/**
 * The Git tab's working-tree half (naru task 2738, docs/git-tab.md "Working
 * tree view"): Conflicts / Staged / Changes / Untracked sections with flat or
 * folder-tree rows, multi-select, stage / unstage / discard, and the file's
 * diff beside them. Every rule is pure in `gitWorktree.ts` and `gitActions.ts`;
 * this renders them. Repo text (paths, names, git's messages) is only ever a
 * text node. Discards go through `createGitActions`, which asks the person
 * first; nothing here calls the discard route itself.
 */
export function GitWorkingTree({
  projectId,
  repo,
  repoView,
  branch,
  ahead,
  behind,
  worktreePath,
  diffWorktree,
  query,
  toolbarStart,
  refetch,
  busy,
  setBusy,
  externalRev,
  onSelectedPath,
  onOpenCommit,
  backRef,
}: {
  projectId: number
  repo: string | undefined
  repoView: GitRepoView
  branch: string
  ahead: number
  behind: number
  /** The explicit path of the worktree this view is for; null = unresolved,
   * and every write control is off. */
  worktreePath: string | null
  /** The picked worktree as the diff route wants it (null = default). */
  diffWorktree: string | null
  query: string
  /** The filter box, placed at the start of the toolbar. */
  toolbarStart: ReactNode
  refetch: () => Promise<void>
  /** The tab's one write flag, shared with the side panel's branch and stash
   * actions (naru task 2741): while either writes, the other's controls are off. */
  busy: boolean
  setBusy: (b: boolean) => void
  /** Bumped by the tab when a branch or stash action settled: the open diff and
   * the commit box read again, so a switch shows the new branch at once. */
  externalRev: number
  /** The path whose diff is open, for the live focus. */
  onSelectedPath: (path: string | null) => void
  /** A commit's short sha was clicked: open it in History. */
  onOpenCommit: (sha: string) => void
  /** Esc in the diff: the tab's key handler calls this to go back to the row. */
  backRef: MutableRefObject<(() => boolean) | null>
}) {
  const [mode, setMode] = useState<ViewMode>(() => parseViewMode(readStored(TREE_MODE_KEY)))
  const [open, setOpen] = useState(() => parseOpenSections(readStored(WT_SECTIONS_KEY)))
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [showAll, setShowAll] = useState<Record<SectionKind, boolean>>({
    conflicts: false,
    staged: false,
    changes: false,
    untracked: false,
  })
  const [sel, setSel] = useState<Selection | null>(null)
  const [alert, setAlert] = useState<{ prefix: string; message: string } | null>(null)
  const [pending, setPending] = useState<{
    plan: DiscardPlan
    resolve: (ok: boolean) => void
  } | null>(null)
  // Bumped when a write settles, so the open diff is read again.
  const [ownRev, setRev] = useState(0)
  const rev = ownRev + externalRev
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [keepFocus, setKeepFocus] = useState(false)
  const pendingRef = useRef(pending)
  // Esc in the diff clears a line selection first; the diff fills this in.
  const clearLines = useRef<(() => boolean) | null>(null)

  const split = useMemo(() => splitSections(repoView.files), [repoView.files])
  const filterActive = query.trim() !== ''
  const shown = useMemo<Sections>(
    () => ({
      conflicts: filterEntries(split.conflicts, query),
      staged: filterEntries(split.staged, query),
      changes: filterEntries(split.changes, query),
      untracked: filterEntries(split.untracked, query),
    }),
    [split, query],
  )
  const rows = useMemo(() => {
    const out = {} as Record<SectionKind, ReturnType<typeof sectionRows>>
    for (const k of SECTION_ORDER) out[k] = sectionRows(k, shown[k], mode, collapsed, showAll[k])
    return out
  }, [shown, mode, collapsed, showAll])
  const byPath = useMemo(() => {
    const out = {} as Record<SectionKind, Map<string, Entry>>
    for (const k of SECTION_ORDER) out[k] = new Map(split[k].map((e) => [e.file.path, e]))
    return out
  }, [split])
  const stagedPaths = byPath.staged

  // The file list changed under the selection (a refetch): drop what left.
  // A multi-selection also never outlives its rows on screen (filter, folder
  // collapse, mode switch, row cap): writes act only on what is visible.
  const reconciled = pruneToVisible(reconcileSelection(sel, split), {
    conflicts: rows.conflicts.visible,
    staged: rows.staged.visible,
    changes: rows.changes.visible,
    untracked: rows.untracked.visible,
  })
  if (reconciled !== sel) setSel(reconciled)
  const selSet = useMemo(() => new Set(sel?.paths ?? []), [sel])
  const multi = sel !== null && sel.paths.length > 1 ? sel : null
  const multiEntries = useMemo(
    () => (multi ? multi.paths.flatMap((p) => byPath[multi.section].get(p) ?? []) : []),
    [multi, byPath],
  )

  const primary = sel !== null ? (byPath[sel.section].get(sel.primary) ?? null) : null
  const primaryPath = primary?.file.path ?? null
  useEffect(() => onSelectedPath(primaryPath), [primaryPath, onSelectedPath])

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])
  // A dialog never outlives the worktree it was opened for.
  useEffect(
    () => () => {
      pendingRef.current?.resolve(false)
      setPending(null)
    },
    [worktreePath],
  )

  const confirm = useCallback(
    (plan: DiscardPlan) => new Promise<boolean>((resolve) => setPending({ plan, resolve })),
    [],
  )
  const actions = useMemo(
    () => createGitActions({ api: projectGitApi(projectId), confirm }),
    [projectId, confirm],
  )
  const resolvePending = useCallback((ok: boolean) => {
    pendingRef.current?.resolve(ok)
    setPending(null)
  }, [])

  const ctx: WriteCtx = { worktree: worktreePath, branch, repo }
  const writeOff = busy || worktreePath === null

  async function run(op: () => Promise<WriteOutcome>) {
    // The buttons are disabled while busy, and a discrete event re-renders
    // before the next one, so this state is enough of a guard.
    if (busy) return
    setBusy(true)
    setAlert(null)
    const a = document.activeElement
    setKeepFocus(a instanceof Element && a.closest('[data-git-list="tree"], [data-wt-selbar]') !== null)
    try {
      const out = await op()
      if (out.ok || out.reason === 'error') {
        // Match reality whatever happened; never retry on our own.
        await refetch()
        setRev((n) => n + 1)
      }
      if (!out.ok && out.reason === 'error') setAlert(alertText(out))
      if (!out.ok && out.reason === 'no-worktree') {
        setAlert({ prefix: 'Nothing was sent:', message: 'The worktree path is unknown.' })
      }
    } finally {
      setBusy(false)
    }
  }

  /** The commit box's write: it shares `busy` with the list's writes (each
   * turns the other's controls off) and re-reads the view and, through `rev`,
   * the commit info, whatever happened. The box shows its own result. */
  async function runCommit(req: CommitRequest): Promise<CommitOutcome> {
    if (busy) return { ok: false, reason: 'busy' }
    setBusy(true)
    setAlert(null)
    setKeepFocus(false)
    try {
      const out = await actions.commit(ctx, req)
      if (out.ok || out.reason === 'error') {
        await refetch()
        setRev((n) => n + 1)
      }
      return out
    } finally {
      setBusy(false)
    }
  }

  // A write that removed the focused row unmounts it: keep keyboard focus in the list.
  useEffect(() => {
    if (!keepFocus) return
    const list = scrollRef.current
    if (!list || list.contains(document.activeElement)) return
    const item =
      list.querySelector<HTMLElement>('[data-git-item][aria-current="true"]') ??
      list.querySelector<HTMLElement>('[data-git-item]')
    item?.focus()
  }, [rev, keepFocus])

  useEffect(() => {
    backRef.current = () => {
      if (clearLines.current?.()) return true
      if (sel === null) return false
      const row = scrollRef.current?.querySelector<HTMLElement>(
        `[data-wt-section="${sel.section}"][data-path="${CSS.escape(sel.primary)}"]`,
      )
      row?.focus()
      setSel(null)
      return true
    }
    return () => {
      backRef.current = null
    }
  }, [backRef, sel])

  const toItem = (e: Entry): DiscardItem => ({
    path: e.file.path,
    untracked: e.section === 'untracked',
    folder: e.file.path.endsWith('/'),
    alsoStaged: e.section === 'changes' && stagedPaths.has(e.file.path),
  })
  const stage = (es: Entry[]) =>
    run(() => actions.stage(ctx, { paths: es.map((e) => e.file.path) }))
  const unstage = (es: Entry[]) =>
    run(() => actions.unstage(ctx, { paths: es.map((e) => e.file.path) }))
  const discard = (es: Entry[]) => run(() => actions.discard(ctx, es.map(toItem)))

  const registerClear = useCallback((fn: (() => boolean) | null) => {
    clearLines.current = fn
  }, [])
  const hunkWrite = (w: HunkWrite) => {
    if (primaryPath === null) return
    const t = { path: primaryPath, digest: w.digest, hunks: w.picks }
    if (w.verb === 'stage') return void run(() => actions.stageHunks(ctx, t))
    if (w.verb === 'unstage') return void run(() => actions.unstageHunks(ctx, t))
    return void run(() => actions.discardHunks(ctx, t, w.lost ?? []))
  }

  const subjectOf = (es: Entry[]) => (es.length === 1 ? es[0].file.path : plural(es.length, 'file'))

  /** The buttons that act on `es` (all in `section`). */
  function actionButtons(section: SectionKind, es: Entry[], subject: string, compact: boolean) {
    const btn = (verb: Verb, run: () => void, danger = false) => {
      const label = controlLabel(verb, subject, worktreePath, branch)
      return (
        <button
          key={verb}
          type="button"
          className={`git-wt-act${danger ? ' danger' : ''}`}
          aria-label={label}
          title={label}
          disabled={writeOff}
          data-wt-action={verb}
          onClick={run}
        >
          <span aria-hidden={compact ? 'true' : undefined}>
            {compact ? GLYPH[verb] : WORD[verb]}
          </span>
        </button>
      )
    }
    if (section === 'staged') return [btn('unstage', () => void unstage(es))]
    if (section === 'changes') {
      return [btn('stage', () => void stage(es)), btn('discard', () => void discard(es), true)]
    }
    if (section === 'untracked') {
      return [btn('stage', () => void stage(es)), btn('delete', () => void discard(es), true)]
    }
    return []
  }

  const pick = (
    section: SectionKind,
    path: string,
    e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => {
    setSel(
      clickSelect(sel, section, path, rows[section].visible, {
        toggle: e.metaKey || e.ctrlKey,
        range: e.shiftKey,
      }),
    )
  }

  const setMode2 = (m: ViewMode) => {
    setMode(m)
    writeStored(TREE_MODE_KEY, m)
  }
  const toggleSection = (k: SectionKind) => {
    const next = { ...open, [k]: !open[k] }
    setOpen(next)
    writeStored(WT_SECTIONS_KEY, JSON.stringify(next))
  }
  const toggleDir = (section: SectionKind, id: string) => {
    const key = dirKey(section, id)
    const next = new Set(collapsed)
    if (!next.delete(key)) next.add(key)
    setCollapsed(next)
  }

  const renderFile = (section: SectionKind, entry: Entry, depth: number) => {
    const { file } = entry
    const { dir, name } = splitPath(file.path)
    const badge = badgeOf(entry)
    const isSel = sel !== null && sel.section === section && selSet.has(file.path)
    const isPrimary = sel !== null && sel.section === section && sel.primary === file.path
    // A row in a multi-selection acts on the whole selection, else on itself.
    const targets = multi !== null && isSel ? multiEntries : [entry]
    const word = statusWord(entry)
    return (
      <li
        key={`${section}\0${file.path}`}
        className={`git-wt-row${isSel ? ' selected' : ''}${isPrimary ? ' primary' : ''}`}
        style={{ '--depth': depth } as CSSProperties}
        data-wt-row=""
      >
        <button
          type="button"
          className="git-tree-row git-wt-main"
          data-git-item=""
          data-path={file.path}
          data-wt-section={section}
          aria-current={isPrimary ? 'true' : undefined}
          aria-pressed={isSel}
          title={file.path}
          onClick={(e) => pick(section, file.path, e)}
        >
          <span className={`git-wt-badge tone-${badge.tone}`} aria-hidden="true">
            {badge.letter}
          </span>
          <span className="git-wt-text">
            {file.orig_path !== null ? (
              <span className="git-wt-name git-wt-rename">
                {file.orig_path} → {file.path}
              </span>
            ) : (
              <>
                <span className="git-wt-name">{name}</span>
                {mode === 'flat' && dir !== '' && <span className="git-wt-dir muted"> {dir}</span>}
              </>
            )}
            {file.submodule && <span className="badge git-wt-tag">submodule</span>}
          </span>
          <span className={`git-wt-word${section === 'conflicts' ? ' conflict' : ' muted'}`}>
            {section === 'conflicts' ? `conflict · ${word}` : word}
          </span>
        </button>
        <span className="git-wt-actions">
          {actionButtons(section, targets, subjectOf(targets), true)}
        </span>
      </li>
    )
  }

  const renderDir = (section: SectionKind, row: Extract<Row, { type: 'dir' }>) => {
    return (
      <li
        key={`${section}\0dir\0${row.id}`}
        className="git-wt-row git-wt-dirrow"
        style={{ '--depth': row.depth } as CSSProperties}
      >
        <button
          type="button"
          className="git-tree-row git-wt-main git-wt-dir-main"
          data-git-item=""
          data-wt-head=""
          data-wt-section={section}
          aria-expanded={row.open}
          title={row.id}
          onClick={() => toggleDir(section, row.id)}
        >
          <span className="git-side-chevron" aria-hidden="true">
            {row.open ? '▾' : '▸'}
          </span>
          <span className="git-wt-text">
            <span className="git-wt-name">{row.label}/</span>
          </span>
          <span className="git-side-count">{row.entries.length}</span>
        </button>
        <span className="git-wt-actions">
          {actionButtons(section, row.entries, `folder ${row.id} (${plural(row.entries.length, 'file')})`, true)}
        </span>
      </li>
    )
  }

  const renderSection = (k: SectionKind) => {
    const list = shown[k]
    if (list.length === 0) return null
    const isOpen = open[k]
    const paths = list.map((e) => e.file.path)
    let header: ReactNode = null
    if (k === 'staged' || k === 'changes' || k === 'untracked') {
      const verb = k === 'staged' ? 'unstage' : 'stage'
      const bulk = bulkAction(verb, k, paths, filterActive, split.conflicts.length > 0)
      const wholeRepo = 'all' in bulk.target
      const subject = wholeRepo
        ? verb === 'stage'
          ? split.untracked.length > 0
            ? 'all changes and untracked files'
            : 'all changes'
          : 'all staged files'
        : plural(paths.length, 'file')
      // Bulk unstage mid-merge would drop cleanly merged files from the
      // result (the server refuses `all` too); rows and selections still work.
      const midOp = verb === 'unstage' ? repoView.operation : null
      const label =
        midOp !== null
          ? `A ${midOp} is in progress in this worktree; unstage files one at a time, or finish or abort it in the terminal.`
          : controlLabel(verb, subject, worktreePath, branch)
      header = (
        <button
          type="button"
          className="git-wt-act git-wt-bulk"
          aria-label={label}
          title={label}
          disabled={writeOff || midOp !== null}
          data-wt-action={`${verb}-${wholeRepo ? 'all' : 'shown'}`}
          onClick={() =>
            void run(() =>
              verb === 'stage' ? actions.stage(ctx, bulk.target) : actions.unstage(ctx, bulk.target),
            )
          }
        >
          {bulk.label}
        </button>
      )
    }
    const r = rows[k]
    return (
      <section key={k} className="git-wt-section" data-wt-section={k}>
        <div className="git-side-headbar git-wt-headbar">
          <button
            type="button"
            className="git-side-head"
            data-git-item=""
            data-wt-head=""
            data-wt-toggle={k}
            aria-expanded={isOpen}
            aria-controls={`git-wt-body-${k}`}
            onClick={() => toggleSection(k)}
          >
            <span className="git-side-chevron" aria-hidden="true">
              {isOpen ? '▾' : '▸'}
            </span>
            <span className="git-side-title">{SECTION_TITLES[k]}</span>
            <span className="git-side-count">{list.length}</span>
          </button>
          <span className="git-side-actions">{header}</span>
        </div>
        {isOpen && (
          <div id={`git-wt-body-${k}`} className="git-wt-body">
            {k === 'conflicts' && (
              <p className="muted git-wt-hint">Resolve in the terminal, then stage.</p>
            )}
            <ul className="git-wt-rows">
              {r.rows.map((row) =>
                row.type === 'dir' ? renderDir(k, row) : renderFile(k, row.entry, row.depth),
              )}
            </ul>
            {r.hidden > 0 && (
              <button
                type="button"
                className="git-side-more git-wt-showall"
                data-wt-showall={k}
                onClick={() => setShowAll((s) => ({ ...s, [k]: true }))}
              >
                Show all {list.length}
              </button>
            )}
          </div>
        )}
      </section>
    )
  }

  const op = repoView.operation
  const opWord = op !== null ? (OPERATIONS[op] ?? op) : null
  const total = SECTION_ORDER.reduce((n, k) => n + shown[k].length, 0)
  const staged = primary === null ? undefined : primary.section === 'staged'
    ? true
    : primary.section === 'conflicts'
      ? undefined
      : false

  // Hunk and line controls: a tracked file's diff of one side, in a known worktree.
  const hunkOps: HunkOps | undefined =
    worktreePath === null || staged === undefined || primary?.section === 'untracked'
      ? undefined
      : {
          staged,
          busy: writeOff,
          label: (verb, subject) => controlLabel(verb, subject, worktreePath, branch),
          onWrite: hunkWrite,
          registerClear,
        }

  return (
    // The size container of the working tree: `@container` rules in App.css
    // stack the list over the diff when this (not the viewport) is narrow.
    <div className="git-wt-root">
      {opWord !== null && (
        <p className="git-wt-banner" role="status" data-wt-banner={op}>
          <strong>{opWord} in progress in this worktree.</strong> Finish or abort it in the
          terminal.
        </p>
      )}
      {alert !== null && (
        <div className="git-wt-alert" role="alert" data-wt-alert="">
          <div className="git-wt-alert-body">
            <strong>{alert.prefix}</strong>
            <pre className="git-wt-alert-msg">{alert.message}</pre>
          </div>
          <button
            type="button"
            className="git-wt-alert-close"
            aria-label="Dismiss"
            onClick={() => setAlert(null)}
          >
            ×
          </button>
        </div>
      )}
      <div className="git-layout">
        <div className="git-wt" data-wt="">
          {/* The one statement of where the controls act (the tab's header line
              is hidden while this list is shown). */}
          <p className="git-wt-target" title={worktreePath ?? undefined} data-wt-target="">
            <span className="git-branch">{branch}</span>
            {ahead > 0 && <span className="git-ahead">↑{ahead}</span>}
            {behind > 0 && <span className="git-behind">↓{behind}</span>}
            <span className="muted git-wt-target-path">
              {worktreePath ?? 'unknown worktree: write controls are off'}
            </span>
          </p>
          <div className="git-wt-toolbar">
            {toolbarStart}
            <div className="git-wt-viewtoggle" role="group" aria-label="List layout">
              {(['flat', 'tree'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={mode === m ? 'active' : ''}
                  aria-pressed={mode === m}
                  data-wt-mode={m}
                  onClick={() => setMode2(m)}
                >
                  {m === 'flat' ? 'Flat' : 'Tree'}
                </button>
              ))}
            </div>
          </div>
          {multi !== null && (
            <div className="git-wt-selbar" role="group" aria-label="Selection" data-wt-selbar="">
              <span className="git-wt-selcount">{multi.paths.length} selected</span>
              {actionButtons(multi.section, multiEntries, subjectOf(multiEntries), false)}
              <button type="button" className="git-wt-act" onClick={() => setSel(null)}>
                Clear
              </button>
            </div>
          )}
          <div className="git-wt-scroll" ref={scrollRef} data-git-list="tree">
            {total === 0 && (
              <p className="muted git-wt-hint">
                {repoView.files.length === 0
                  ? 'Working tree clean — no changed files.'
                  : 'No changed files match.'}
              </p>
            )}
            {SECTION_ORDER.map((k) => (
              <Fragment key={k}>
                {k === 'staged' &&
                  !filterActive &&
                  split.staged.length === 0 &&
                  split.changes.length + split.untracked.length > 0 && (
                    <p className="muted git-wt-hint" data-wt-nothing-staged="">
                      Nothing staged
                    </p>
                  )}
                {renderSection(k)}
                {k === 'staged' && (
                  <GitCommitBox
                    key={`${projectId}\0${repo ?? ''}\0${worktreePath ?? ''}`}
                    projectId={projectId}
                    repo={repo}
                    worktreePath={worktreePath}
                    diffWorktree={diffWorktree}
                    stagedCount={split.staged.length}
                    hasConflicts={split.conflicts.length > 0}
                    busy={busy}
                    rev={rev}
                    branch={branch}
                    onCommit={runCommit}
                    onOpenCommit={onOpenCommit}
                  />
                )}
              </Fragment>
            ))}
          </div>
        </div>
        {repoView.files.length > 0 && (
          <div className="git-diff-pane" tabIndex={0} data-git-diff="tree" aria-label="Diff">
            {primary === null ? (
              <p className="muted">Select a file to see its diff.</p>
            ) : primary.file.path.endsWith('/') ? (
              <p className="muted">
                An untracked folder: its files are listed once it is staged. Stage it to see them.
              </p>
            ) : (
              <DiffPane
                projectId={projectId}
                path={primary.file.path}
                worktree={diffWorktree}
                repo={repo}
                staged={staged}
                rev={rev}
                hunkOps={hunkOps}
              />
            )}
          </div>
        )}
      </div>
      {pending !== null && <GitConfirmDialog plan={pending.plan} onResolve={resolvePending} />}
    </div>
  )
}
