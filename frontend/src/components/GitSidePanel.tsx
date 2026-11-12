import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import {
  getProjectGitBranches,
  getProjectGitStashes,
  getProjectGitWorktreeDetails,
} from '../api'
import { relativeTime } from '../gitGraph'
import {
  SIDE_SECTIONS_KEY,
  activeWorktreePath,
  aheadBehind,
  branchBadges,
  branchTitle,
  branchTrackText,
  changedText,
  detailsByPath,
  disabledReason,
  exactTime,
  filterBranches,
  filterCountLabel,
  groupBranches,
  groupOpen,
  groupedName,
  moreCount,
  orderWorktrees,
  parseSections,
  sameScope,
  shortFolder,
  shownCount,
  stashMessage,
  stashSub,
  stashTitle,
  worktreeLabel,
  worktreeSelectable,
  worktreeTitle,
} from '../gitPanel'
import type { BranchGroup, BranchScope, SectionId } from '../gitPanel'
import {
  branchTargetLine,
  deleteReason,
  isUnborn,
  newBranchReason,
  refLabel,
  renameReason,
  stashApplyReason,
  stashPushReason,
  stashTargetLine,
  switchReason,
  writeOffReason,
} from '../gitRefs'
import type { RefCtx } from '../gitRefs'
import { shouldIgnoreShortcut } from '../keyboardScope'
import type { GitRefOps } from '../useGitRefOps'
import { GitRefMessages } from './GitRefMessages'
import { useFetch } from '../useFetch'
import type { GitBranch } from '../types/GitBranch'
import type { GitStash } from '../types/GitStash'
import type { GitWorktree } from '../types/GitWorktree'

const SKEL_ROWS = [0, 1, 2]

/** A fixed-size placeholder bar: same line box as the text it stands for, so
 * the row does not change height when the value arrives. */
function Skel({ w }: { w: string }) {
  return <span className="git-skel" style={{ width: w }} aria-hidden="true" />
}

function Badge({ kind, children, title }: { kind: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge git-ref git-ref-${kind}`} title={title}>
      {children}
    </span>
  )
}

function SkelRows() {
  return (
    <>
      {SKEL_ROWS.map((i) => (
        <div key={i} className="git-side-row git-side-row-skel" aria-hidden="true">
          <span className="git-side-line">
            <Skel w="55%" />
          </span>
          <span className="git-side-sub">
            <Skel w="80%" />
          </span>
        </div>
      ))}
    </>
  )
}

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <button type="button" className="git-side-retry" onClick={onRetry}>
      Couldn&apos;t load. Retry
    </button>
  )
}

/** One write control of a row or a header (naru task 2741). Off = `aria-disabled`
 * (never `disabled`, which drops focus and the tooltip) and a reason; the press
 * is ignored. The same text is the aria-label and the title, and always names
 * the target. */
function ActBtn({
  act,
  glyph,
  text,
  label,
  reason,
  inflight,
  className,
  onPress,
}: {
  act: string
  glyph: string
  text: string
  label: string
  reason: string | null
  inflight?: boolean
  className?: string
  onPress: () => void
}) {
  const name = reason === null ? label : `${label}. ${reason}`
  return (
    <button
      type="button"
      className={`git-wt-act git-side-act${className ? ` ${className}` : ''}`}
      data-side-act={act}
      aria-label={name}
      title={name}
      aria-disabled={reason !== null ? 'true' : undefined}
      onClick={() => {
        if (reason === null) onPress()
      }}
    >
      <span className="git-side-act-glyph" aria-hidden="true">
        {inflight ? '…' : glyph}
      </span>
      <span className="git-side-act-text" aria-hidden="true">
        {text}
      </span>
    </button>
  )
}

function Section({
  id,
  title,
  count,
  open,
  onToggle,
  actions,
  children,
}: {
  id: SectionId
  title: string
  count: number | null
  open: boolean
  onToggle: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="git-side-section">
      <div className="git-side-headbar">
        <button
          type="button"
          className="git-side-head"
          aria-expanded={open}
          aria-controls={`git-side-body-${id}`}
          onClick={onToggle}
        >
          <span className="git-side-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="git-side-title">{title}</span>
          {count !== null && <span className="git-side-count">{count}</span>}
        </button>
        <span className="git-side-actions">{actions}</span>
      </div>
      {open && (
        <div id={`git-side-body-${id}`} className="git-side-body">
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * The Git tab's refs panel (naru task 2737, docs/git-tab.md "Side panel"):
 * worktrees, branches and stashes in one scroller. All the rules (ordering,
 * grouping, filtering, capping, texts) live in `gitPanel.ts`; every repo string
 * is rendered as a text node. Picking a worktree selects it for the whole tab,
 * a branch scopes History to it, a stash opens its commit. Branches and stashes
 * also carry write controls (task 2741, "Branch and stash writes"): the rules
 * are in `gitRefs.ts`, the gate in `gitActions.ts`, the state in `ops`
 * (`useGitRefOps`, owned by the tab); nothing here calls the api itself.
 */
export function GitSidePanel({
  projectId,
  repo,
  worktrees,
  selectedWorktree,
  scope,
  onPickWorktree,
  onPickBranch,
  onPickStash,
  hidden,
  ctx,
  ops,
  registerRefetch,
}: {
  projectId: number
  repo: string | undefined
  worktrees: GitWorktree[] | null
  /** The explicit pick; null = whichever worktree is the current one. */
  selectedWorktree: string | null
  scope: BranchScope | null
  onPickWorktree: (path: string) => void
  onPickBranch: (b: GitBranch) => void
  onPickStash: (s: GitStash) => void
  /** Inline and closed: stays mounted (no refetch, state kept) but not shown. */
  hidden: boolean
  /** Where the writes act (the selected worktree, as loaded). */
  ctx: RefCtx
  ops: GitRefOps
  /** Hands the tab a function that re-reads the panel's three lists (null on
   * unmount); the tab calls it after every write. Must be stable. */
  registerRefetch: (fn: (() => Promise<void>) | null) => void
}) {
  const repoKey = `${projectId}-${repo ?? ''}`
  const details = useFetch(
    () => getProjectGitWorktreeDetails(projectId, repo),
    `git-side-wt-${repoKey}`,
  )
  const branches = useFetch(
    () => getProjectGitBranches(projectId, selectedWorktree ?? undefined, repo),
    `git-side-br-${repoKey}-${selectedWorktree ?? ''}`,
  )
  const stashes = useFetch(() => getProjectGitStashes(projectId, repo), `git-side-st-${repoKey}`)
  // A worktree switch re-keys the branches fetch (its marks are relative to
  // the worktree); keep showing the last list of this repo until the new one
  // arrives, so the section never drops to skeleton rows mid-use.
  const [lastBranches, setLastBranches] = useState<{
    repoKey: string
    data: NonNullable<typeof branches.data>
  } | null>(null)
  if (branches.data !== null && lastBranches?.data !== branches.data) {
    setLastBranches({ repoKey, data: branches.data })
  }
  const branchData =
    branches.data ?? (lastBranches?.repoKey === repoKey ? lastBranches.data : null)

  const refetchAll = async () => {
    await Promise.all([details.refetch(), branches.refetch(), stashes.refetch()])
  }
  const refetchAllRef = useRef(refetchAll)
  useEffect(() => {
    refetchAllRef.current = refetchAll
  })
  useEffect(() => {
    registerRefetch(() => refetchAllRef.current())
    return () => registerRefetch(null)
  }, [registerRefetch])

  const asideRef = useRef<HTMLElement>(null)
  // After a write settles, a focused control that went away with its row
  // leaves focus on the body: put it on the section header instead.
  const focusBack = useRef<SectionId | null>(null)
  const settled = !ops.busy && !ops.dialogOpen
  useEffect(() => {
    const section = focusBack.current
    if (!settled || section === null) return
    focusBack.current = null
    const t = setTimeout(() => {
      const a = document.activeElement
      if (a && a !== document.body) return
      asideRef.current
        ?.querySelector<HTMLElement>(`.git-side-head[aria-controls="git-side-body-${section}"]`)
        ?.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [settled])
  const [pressed, setPressed] = useState<string | null>(null)
  const press = (section: SectionId, key: string, go: () => void | Promise<void>) => {
    focusBack.current = section
    setPressed(key)
    void Promise.resolve(go()).finally(() => setPressed(null))
  }

  const [sections, setSections] = useState(() => {
    try {
      return parseSections(localStorage.getItem(SIDE_SECTIONS_KEY))
    } catch {
      return parseSections(null)
    }
  })
  const toggleSection = (id: SectionId) => {
    const next = { ...sections, [id]: !sections[id] }
    setSections(next)
    try {
      localStorage.setItem(SIDE_SECTIONS_KEY, JSON.stringify(next))
    } catch {
      // not remembered
    }
  }

  const [query, setQuery] = useState('')
  const [groupState, setGroupState] = useState<Record<string, boolean>>({})
  const [more, setMore] = useState<Record<string, number>>({})
  const filterRef = useRef<HTMLInputElement>(null)
  const wantFilter = useRef(false)
  useEffect(() => {
    if (!wantFilter.current) return
    wantFilter.current = false
    filterRef.current?.focus()
    filterRef.current?.select()
  }, [sections.branches])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.target as HTMLElement).closest('input, textarea, select')) return
    // Esc is the tab's (GitView.onKeyDown): it also has to close the `?` popover.
    if (e.key === '/' && !shouldIgnoreShortcut(e.nativeEvent)) {
      e.preventDefault()
      e.stopPropagation()
      if (filterRef.current) {
        filterRef.current.focus()
        filterRef.current.select()
      } else if (!sections.branches) {
        wantFilter.current = true
        toggleSection('branches')
      }
    }
  }

  const now = new Date()
  const unborn = isUnborn(branchData?.branches ?? null, ctx)
  // Why every write control is off right now (busy, a dialog, no worktree), else null.
  const off = writeOffReason(ctx, ops.busy || ops.dialogOpen)
  const ordered = useMemo(() => orderWorktrees(worktrees ?? []), [worktrees])
  const active = activeWorktreePath(worktrees ?? [], selectedWorktree)
  const dmap = useMemo(() => detailsByPath(details.data?.details ?? null), [details.data])
  const detailsLoading = details.data === null && details.error === null
  const detailsFailed = details.data === null && details.error !== null
  const base = details.data?.base_branch ?? null

  const worktreeRow = (w: GitWorktree) => {
    const d = dmap.get(w.path)
    const ok = worktreeSelectable(w)
    const reason = disabledReason(w)
    const selected = w.path === active
    const changed = d ? changedText(d.changed) : null
    const ab = d ? aheadBehind(d.ahead, d.behind) : { ahead: null, behind: null }
    const abWhy =
      d && d.ahead !== null && d.behind !== null
        ? `Against ${base ?? 'the main checkout'}, as of the last fetch`
        : undefined
    const sub = d
      ? [d.subject, d.date ? relativeTime(d.date, now) : null].filter((x) => x)
      : []
    return (
      <button
        key={w.path}
        type="button"
        className={`git-side-row${selected ? ' selected' : ''}`}
        data-git-item={ok ? '' : undefined}
        data-path={w.path}
        aria-current={selected ? 'true' : undefined}
        disabled={!ok}
        title={reason ?? worktreeTitle(w, d, base)}
        onClick={() => onPickWorktree(w.path)}
      >
        <span className="git-side-line">
          {w.is_main && <Badge kind="branch">main</Badge>}
          <span className="git-side-name">{worktreeLabel(w)}</span>
          {w.detached && <Badge kind="detached">detached</Badge>}
          {w.locked && <Badge kind="other" title={w.lock_reason ?? undefined}>locked</Badge>}
          {w.prunable && <Badge kind="other" title={w.prunable_reason ?? undefined}>prunable</Badge>}
          {w.bare && <Badge kind="other">bare</Badge>}
          {ok &&
            (changed !== null ? (
              <span className={`git-side-cell${changed === 'clean' ? ' muted' : ''}`}>{changed}</span>
            ) : detailsLoading ? (
              <Skel w="3.5rem" />
            ) : detailsFailed ? (
              <span className="git-side-cell muted">—</span>
            ) : null)}
          {ok &&
            !w.is_main &&
            (d ? (
              <>
                {ab.ahead && (
                  <span className="git-ahead" title={abWhy}>
                    {ab.ahead}
                  </span>
                )}
                {ab.behind && (
                  <span className="git-behind" title={abWhy}>
                    {ab.behind}
                  </span>
                )}
              </>
            ) : detailsLoading ? (
              <Skel w="2rem" />
            ) : detailsFailed ? (
              <span className="git-side-cell muted">—</span>
            ) : null)}
          <span className="git-side-row-menu" />
        </span>
        <span className="git-side-sub">
          <span className="git-side-sub-text">
            {shortFolder(w.path)}
            {ok && sub.length > 0 && ` · ${sub.join(' · ')}`}
            {ok && d === undefined && detailsLoading && (
              <>
                {' · '}
                <Skel w="8rem" />
              </>
            )}
            {ok && d === undefined && detailsFailed && ' · —'}
          </span>
          <span className="git-side-row-menu" />
        </span>
      </button>
    )
  }

  const allBranches = useMemo(() => branchData?.branches ?? [], [branchData])
  const filtering = query.trim() !== ''
  const matched = useMemo(() => filterBranches(allBranches, query), [allBranches, query])
  const grouped = useMemo(() => groupBranches(matched), [matched])

  const branchRow = (b: GitBranch, label: string) => {
    const bd = branchBadges(b, active)
    const track = branchTrackText(b)
    const subs = [b.upstream && !track.gone ? b.upstream : null, b.subject, relativeTime(b.date, now)]
    const selected = scope !== null && sameScope(scope, { name: b.name, kind: b.kind })
    const rowKey = `${b.kind}:${b.name}`
    const isLocal = b.kind === 'local'
    const rSwitch = off ?? switchReason(ctx, b)
    const rRename = off ?? renameReason(b)
    const rDelete = off ?? deleteReason(b)
    // The reasons that belong to the row itself, for the touch layout's line.
    const why = isLocal
      ? [...new Set([switchReason(ctx, b), renameReason(b), deleteReason(b)].filter((x) => x !== null))]
      : []
    return (
      <div key={rowKey} className="git-side-rowwrap" data-git-row="" data-nacts={isLocal ? 3 : 1}>
        <button
          type="button"
          className={`git-side-row${selected ? ' selected' : ''}`}
          data-git-item=""
          data-branch={b.name}
          aria-current={selected ? 'true' : undefined}
          title={branchTitle(b)}
          onClick={() => onPickBranch(b)}
        >
          <span className="git-side-line">
            <span className="git-side-name">{label}</span>
            {bd.current && <Badge kind="head">current</Badge>}
            {bd.inWorktree !== null && (
              <Badge kind="other" title={`Checked out in ${bd.inWorktree}`}>
                in worktree
              </Badge>
            )}
            {bd.merged && (
              <Badge kind="other" title="Fully merged into the selected worktree's HEAD">
                merged
              </Badge>
            )}
            <span className="git-side-row-menu" />
          </span>
          <span className="git-side-sub">
            <span className="git-side-sub-text">
              {track.gone && <span className="muted">gone</span>}
              {track.ahead && <span className="git-ahead">{track.ahead}</span>}
              {track.behind && <span className="git-behind">{track.behind}</span>}
              {(track.gone || track.ahead || track.behind) && ' '}
              {subs.filter((x) => x).join(' · ')}
            </span>
            <span className="git-side-row-menu" />
          </span>
        </button>
        <span className="git-side-row-acts" data-side-acts="">
          {isLocal ? (
            <>
              <ActBtn
                act="switch"
                glyph="→"
                text="Switch"
                label={refLabel('switch', b.name, ctx)}
                reason={rSwitch}
                inflight={pressed === `switch:${b.name}`}
                onPress={() => press('branches', `switch:${b.name}`, () => ops.switchTo(b))}
              />
              <ActBtn
                act="rename"
                glyph="✎"
                text="Rename"
                label={refLabel('rename', b.name, ctx)}
                reason={rRename}
                onPress={() => press('branches', `rename:${b.name}`, () => ops.openRename(b))}
              />
              <ActBtn
                act="delete"
                glyph="✕"
                text="Delete"
                label={refLabel('delete', b.name, ctx)}
                reason={rDelete}
                inflight={pressed === `delete:${b.name}`}
                onPress={() => press('branches', `delete:${b.name}`, () => ops.deleteBranch(b))}
              />
            </>
          ) : (
            <ActBtn
              act="branch-from-remote"
              glyph="+"
              text="Create branch"
              label={refLabel('branch-from-remote', b.name, ctx)}
              reason={off}
              onPress={() =>
                press('branches', `remote:${b.name}`, () =>
                  ops.openCreate({ kind: 'remote', name: b.name }),
                )
              }
            />
          )}
        </span>
        {why.length > 0 && (
          <p className="git-side-why muted" data-side-why="">
            {why.join(' · ')}
          </p>
        )}
      </div>
    )
  }

  const moreButton = (key: string, total: number) => {
    const n = moreCount(total, more[key] ?? 0)
    if (n <= 0) return null
    return (
      <button
        type="button"
        className="git-side-more"
        data-git-item=""
        onClick={() => setMore((m) => ({ ...m, [key]: (m[key] ?? 0) + 1 }))}
      >
        Show {n} more
      </button>
    )
  }

  const capped = (key: string, list: GitBranch[], strip: boolean) => (
    <>
      {list
        .slice(0, shownCount(list.length, more[key] ?? 0))
        .map((b) => branchRow(b, strip ? groupedName(b) : b.name))}
      {moreButton(key, list.length)}
    </>
  )

  const groupBlock = (g: BranchGroup) => {
    const open = groupOpen(g, filtering, groupState)
    return (
      <div key={g.key} className="git-side-groupwrap">
        <button
          type="button"
          className="git-side-group"
          data-git-item=""
          aria-expanded={open}
          title={g.remote ? `Remote ${g.label}` : `${g.label}/`}
          onClick={() => setGroupState((s) => ({ ...s, [g.key]: !open }))}
        >
          <span className="git-side-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="git-side-name">{g.remote ? g.label : `${g.label}/`}</span>
          <span className="git-side-count">{g.branches.length}</span>
        </button>
        {open && capped(g.key, g.branches, true)}
      </div>
    )
  }

  const branchCount = branchData?.branches ? allBranches.length : null
  const stashList = stashes.data?.stashes ?? null

  return (
    <aside
      id="git-side"
      ref={asideRef}
      className="git-side"
      role="region"
      aria-label="Refs"
      hidden={hidden}
      aria-busy={ops.busy}
      data-side-busy={ops.busy ? '' : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="git-side-scroll">
      <Section
        id="worktrees"
        title="Worktrees"
        count={worktrees === null ? null : ordered.length}
        open={sections.worktrees}
        onToggle={() => toggleSection('worktrees')}
      >
        <div className="git-side-list" data-git-list="worktrees">
          {ordered.map(worktreeRow)}
        </div>
        {detailsFailed && (
          <button type="button" className="git-side-retry" onClick={() => void details.refetch()}>
            Details unavailable. Retry
          </button>
        )}
      </Section>

      <Section
        id="branches"
        title="Branches"
        count={branchCount}
        open={sections.branches}
        onToggle={() => toggleSection('branches')}
        actions={
          <ActBtn
            act="new-branch"
            glyph="+"
            text="New branch"
            label={refLabel('new-branch', '', ctx)}
            reason={off ?? newBranchReason(unborn)}
            onPress={() => press('branches', 'new', () => ops.openCreate({ kind: 'head' }))}
          />
        }
      >
        <p className="git-side-target muted" data-side-target="branches" title={branchTargetLine(ctx)}>
          {branchTargetLine(ctx)}
        </p>
        {ctx.detached && (
          <div className="git-side-detached" data-side-detached="">
            <span>HEAD is detached at {ctx.branch}</span>
            <ActBtn
              act="branch-here"
              glyph="+"
              text="Create branch here"
              label={refLabel('branch-here', ctx.branch, ctx)}
              reason={off}
              className="git-side-act-wide"
              onPress={() => press('branches', 'here', () => ops.openCreate({ kind: 'head' }))}
            />
          </div>
        )}
        {branchData === null && branches.error === null && <SkelRows />}
        {branchData === null && branches.error !== null && (
          <Failed onRetry={() => void branches.refetch()} />
        )}
        {branchData !== null && allBranches.length === 0 && (
          <p className="git-side-note muted">No branches yet.</p>
        )}
        {branchData !== null && allBranches.length > 0 && (
          <>
            <input
              ref={filterRef}
              type="search"
              className="git-filter-input git-side-filter"
              placeholder="Filter branches"
              aria-label="Filter branches"
              data-git-for="branches"
              data-git-branch-filter=""
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {filtering && (
              <p className="git-side-note muted" role="status">
                {filterCountLabel(query, matched.length, allBranches.length)}
              </p>
            )}
            {filtering && matched.length === 0 && (
              <p className="git-side-note muted">
                No branches match.{' '}
                <button type="button" className="git-side-retry" onClick={() => setQuery('')}>
                  Clear
                </button>
              </p>
            )}
            <div className="git-side-list" data-git-list="branches">
              {capped('local:', grouped.ungrouped, false)}
              {grouped.groups.map(groupBlock)}
            </div>
          </>
        )}
      </Section>

      <Section
        id="stashes"
        title="Stashes"
        count={stashList === null ? null : stashList.length}
        open={sections.stashes}
        onToggle={() => toggleSection('stashes')}
        actions={
          <ActBtn
            act="stash"
            glyph="+"
            text="Stash"
            label={refLabel('stash', '', ctx)}
            reason={off ?? stashPushReason(ctx, unborn)}
            onPress={() => press('stashes', 'stash', () => ops.openStash())}
          />
        }
      >
        <p className="git-side-target muted" data-side-target="stashes" title={stashTargetLine(ctx)}>
          {stashTargetLine(ctx)}
        </p>
        {stashes.data === null && stashes.error === null && <SkelRows />}
        {stashes.data === null && stashes.error !== null && (
          <Failed onRetry={() => void stashes.refetch()} />
        )}
        {stashList !== null && stashList.length === 0 && (
          <p className="git-side-note muted">No stashes</p>
        )}
        {stashList !== null && stashList.length > 0 && (
          <div className="git-side-list" data-git-list="stashes">
            {stashList.map((s) => {
              const m = stashMessage(s)
              const rApply = off ?? stashApplyReason(ctx)
              return (
                <div
                  key={s.hash + s.index}
                  className="git-side-rowwrap"
                  data-git-row=""
                  data-nacts={3}
                >
                  <button
                    type="button"
                    className="git-side-row"
                    data-git-item=""
                    title={stashTitle(s)}
                    onClick={() => onPickStash(s)}
                  >
                    <span className="git-side-line">
                      <span className={`git-side-name${m.empty ? ' muted' : ''}`}>{m.text}</span>
                      <span className="git-side-mono muted">{s.name}</span>
                      <span className="git-side-row-menu" />
                    </span>
                    <span className="git-side-sub">
                      <span className="git-side-sub-text" title={exactTime(s.date)}>
                        {stashSub(s, now)}
                      </span>
                      <span className="git-side-row-menu" />
                    </span>
                  </button>
                  <span className="git-side-row-acts" data-side-acts="">
                    <ActBtn
                      act="apply"
                      glyph="↧"
                      text="Apply"
                      label={refLabel('apply', s.name, ctx)}
                      reason={rApply}
                      inflight={pressed === `apply:${s.hash}`}
                      onPress={() => press('stashes', `apply:${s.hash}`, () => ops.apply(s))}
                    />
                    <ActBtn
                      act="pop"
                      glyph="⤒"
                      text="Pop"
                      label={refLabel('pop', s.name, ctx)}
                      reason={rApply}
                      inflight={pressed === `pop:${s.hash}`}
                      onPress={() => press('stashes', `pop:${s.hash}`, () => ops.pop(s))}
                    />
                    <ActBtn
                      act="drop"
                      glyph="✕"
                      text="Drop"
                      label={refLabel('drop', s.name, ctx)}
                      reason={off}
                      inflight={pressed === `drop:${s.hash}`}
                      onPress={() => press('stashes', `drop:${s.hash}`, () => ops.drop(s))}
                    />
                  </span>
                  {stashApplyReason(ctx) !== null && (
                    <p className="git-side-why muted" data-side-why="">
                      {stashApplyReason(ctx)}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Section>

      <p className="git-side-foot muted">Ahead/behind is as of the last fetch. Naru never fetches.</p>
      </div>
      {/* Outside the scroller: it is never clipped, scrolled away or shrunk. */}
      <GitRefMessages ops={ops} />
    </aside>
  )
}
