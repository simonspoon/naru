import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './App.css'
import { getCcUsage, getNaruVersion, getTask, listInbox } from './api'
import { AgentSidebar } from './components/AgentSidebar'
import { CommandPalette } from './components/CommandPalette'
import { WorkflowsPanel } from './components/WorkflowsPanel'
import { DockBar, DockLayout } from './components/DockLayout'
import { useDockStore } from './useDockStore'
import { inNav, isVisible, revealNeedsNav, type PanelId } from './dockLayout'
import { NavRail, NavZone } from './components/NavDock'
import { hostFor } from './lib/dockHosts'
import { DoneToasts } from './components/DoneToasts'
import { PhoneTabBar } from './components/PhoneTabBar'
import { PtyPool } from './components/PtyPool'
import { Sidebar } from './components/Sidebar'
import { ccOriginFromHash, splitHashQuery } from './ccOrigin'
import { inboxFilterFor } from './inboxFilter'
import { unreadCount } from './inboxRead'
import { matchesShortcut, type Keymap } from './keymap'
import { useKeymap } from './keymapStore'
import { rememberView } from './lastView'
import { CCDashboardView } from './pages/CCDashboardView'
import type { CcTab } from './ccTab'
import { CCSessionDetailView } from './pages/CCSessionDetailView'
import { CCSessionTimelineView } from './pages/CCSessionTimelineView'
import { InboxView } from './pages/InboxView'
import { LibraryView } from './pages/LibraryView'
import { LiveHub, type LiveDock } from './components/LiveHub'
import { ProjectTasksPage } from './pages/ProjectTasksPage'
import { ScriptsView } from './pages/ScriptsView'
import { WorkflowsOverview } from './pages/WorkflowsOverview'
import { SettingsView } from './pages/SettingsView'
import { settingsTabFromPath } from './settingsTab'
import { TerminalPage } from './pages/TerminalPage'
import { isNavLinkClick, loadMainCollapsed, saveMainCollapsed } from './mainCollapse'
import { isPhone, onPhoneTierChange, usePhoneTier } from './phoneTier'
import { useSpatialNav } from './spatialNav'
import { useFetch } from './useFetch'
import { usagePct, usageSeverity } from './usageMeter'
import { useVisualViewportHeightVar } from './visualViewport'

// Hash-based routing: #/ (placeholder), #/projects/:id,
// #/projects/:id/tasks/:tid (task open in the side panel),
// #/projects/:id/workflows, #/projects/:id/workflows/:sid,
// #/projects/:id/git (working-tree status + per-file diffs),
// #/projects/:id/files (file tree + content viewer),
// #/projects/:id/terminal (the Terminal page's shell panes, rooted at the
// project's local_path — the project-scoped twin of #/terminal below),
// #/projects/:id/dashboard (project-scoped CC telemetry),
// #/projects/:id/settings (this project's folder / parent / archive — not to
// be confused with #/settings, the global ~/.mesa/config.json editor),
// #/projects/:id/create-task (opens straight into the create-task form;
// closing/saving it returns to the plain project URL — see
// ProjectTasksPage's `createTask` prop), #/terminal (global shell pane-tree;
// TerminalPage is a permanent sibling mount, not resolved into `page` — see
// the render below), #/scripts (the global store of user-authored shell
// scripts and their generated run forms — global like #/inbox, since a script
// may bind a project but does not have to), #/scripts/runs/:id (one stored
// run, live or long finished — a run outlives the tab that started it since
// mesa task 1224, so it needs an address a reload can land on). The spoken
// conversation is no
// route at all (mesa task 857): it lives in the header (`LiveHub`), which is
// mounted for the life of the app, because a live turn may `navigate` this
// browser somewhere else and the conversation has to survive the navigation
// it just performed. `#/live` survives only as a verb — LiveHub intercepts it,
// opens the conversation panel — a right-hand sidebar since task 887,
// portalled into the `.live-slot` below — and puts the hash back.
//
// Every project-tab and #/cc route is *recorded* browser-local as the last
// view (`lastView.ts`), so the nav's project and CC Dashboard links reopen it.
// Links only — nothing here ever rewrites the hash, so these routes stay
// refresh- and back-stable.
function useHashPath(): string {
  // `rememberView` runs *before* the state update, not in an effect: the nav's
  // links read the remembered tab during render, and an effect would land a
  // render too late, leaving them one navigation stale.
  const read = () => {
    const p = window.location.hash.slice(1) || '/'
    rememberView(p)
    return p
  }
  const [path, setPath] = useState(read)
  useEffect(() => {
    const onChange = () => setPath(read())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return path
}

// Legacy #/tasks/:id links: resolve the task's project, then rewrite the
// hash into the panel route.
function LegacyTaskRedirect({ taskId }: { taskId: number }) {
  const { data: task, error } = useFetch(
    () => getTask(taskId),
    `legacy-task-${taskId}`,
  )
  useEffect(() => {
    if (task) {
      window.location.hash = `#/projects/${task.project_id}/tasks/${task.id}`
    }
  }, [task])
  if (error) return <p className="error">{error}</p>
  return <p className="muted">Loading…</p>
}

// The header's right-hand plan-limit chips (mesa task 834): how much of the
// Claude subscription's 5-hour and 7-day windows is spent, on every page. The
// same `/api/cc/usage` read the CC dashboard's Subscription Limits card makes
// — one live network call per server cache miss, so poll on its 60s TTL — and
// the same clamp/severity arithmetic (`usageMeter.ts`), never a second copy.
//
// Decoration, like the version beside the wordmark: it renders nothing while
// loading, on an error (no token, offline — a permanent state on a machine
// that never authenticated), or for a window the plan does not meter. The
// dashboard card is where an unavailable read is explained.
function HeaderUsage() {
  const { data } = useFetch(getCcUsage, 'cc-usage-header', { pollMs: 60000 })
  const windows: { label: string; title: string; pct: number }[] = []
  for (const [label, title, w] of [
    ['5h', '5-hour session window', data?.five_hour],
    ['7d', '7-day window (all models)', data?.seven_day],
  ] as const) {
    const pct = usagePct(w)
    if (pct !== null) windows.push({ label, title, pct })
  }
  if (windows.length === 0) return null
  return (
    <div className="header-usage" aria-label="Claude plan limits">
      {windows.map(({ label, title, pct }) => (
        <span
          key={label}
          className={`header-usage-chip ${usageSeverity(pct)}`}
          title={`${title} · ${pct.toFixed(0)}% of plan limit`}
        >
          <span className="header-usage-label">{label}</span>
          <span className="header-usage-pct">{pct.toFixed(0)}%</span>
        </span>
      ))}
    </div>
  )
}

// Cmd+Shift+P (Mac) / Ctrl+Shift+P (elsewhere) opens the command palette,
// wherever the app is mounted — the `command-palette` action in `keymap.ts`,
// which is what makes it rebindable from Settings (mesa task 1079) and folds
// the two platforms' modifiers into one `Mod`. Always preventDefault so the
// browser's own binding for whatever chord this is never fires underneath it.
function useCommandPaletteShortcut(onOpen: () => void, keymap: Keymap) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesShortcut('command-palette', e, keymap)) return
      e.preventDefault()
      onOpen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpen, keymap])
}

function App() {
  const hash = useHashPath()
  // A CC session drill-down carries the dashboard it was reached from as a
  // `?project=<id>` suffix (mesa task 1234). Split it off here, before any
  // route pattern below runs: a `[^/]+` id segment would otherwise swallow it.
  const { path } = splitHashQuery(hash)
  const ccOrigin = ccOriginFromHash(hash)
  // Bumped after project create/rename/delete so the sidebar refetches.
  const [navVersion, setNavVersion] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // The element LiveHub portals its conversation panel into (mesa task 887).
  // State written by a ref callback, not read out of the DOM: the slot is
  // rendered in this same commit, so it does not exist while the hub above is
  // rendering, and the ref landing is what says it does now.
  const [liveSlot, setLiveSlot] = useState<HTMLDivElement | null>(null)
  // The dock (mesa task 1567, docs/dock.md): on the desktop tiers every panel
  // but the nav is a dockable panel; the phone tier keeps its drawers and tab
  // bar exactly as they were.
  const docked = !usePhoneTier()
  const dock = useDockStore()
  const [boardFrozen, setBoardFrozen] = useState(false)
  const locked = useMemo<ReadonlySet<PanelId>>(
    () => new Set<PanelId>(boardFrozen ? ['board'] : []),
    [boardFrozen],
  )
  const { hide } = dock

  // What the keyboard is bound to right now — the shipped chords until the
  // one `GET /api/config/keymap` this page makes resolves (mesa task 1079).
  const keymap = useKeymap()
  useCommandPaletteShortcut(() => setPaletteOpen(true), keymap)
  // h/j/k/l + arrow-key spatial focus nav (mesa spec 449 story 454): a
  // second global window keydown listener, disjoint key set from the
  // shortcut above, mounted alongside it per arch-449-keyboard.md §3.
  useSpatialNav(keymap)
  // Keeps `--visual-viewport-height` current for the phone tier's
  // keyboard-aware shell (mesa task 560). Mounted here because `#root` is the
  // element the var sizes and App is the only permanent owner of it.
  useVisualViewportHeightVar()
  // Both sidebars' collapse state lives here rather than inside each of them
  // (mesa task 556): the phone tab bar's Agents/More slots open the drawers,
  // so a third party now drives what used to be two private booleans. The
  // sidebars are otherwise unchanged — in particular they are still permanent
  // mounts that only ever toggle CSS, never unmount, which is what keeps
  // AgentSidebar's live PTY sessions alive across a tab switch.
  //
  // The nav sidebar starts collapsed on phones (it is an overlay drawer
  // there); the agents sidebar defaults to collapsed at every width.
  const [navCollapsed, setNavCollapsed] = useState(isPhone)
  // A panel docked in a collapsed nav is not mounted (the rail shows only the
  // orb), so it counts as hidden there.
  const agentsVisible = isVisible(dock.state, 'agents', navCollapsed)
  const terminalVisible = isVisible(dock.state, 'terminal', navCollapsed)
  const chatVisible = isVisible(dock.state, 'chat', navCollapsed)
  const boardVisible = isVisible(dock.state, 'board', navCollapsed)
  // The orb panel itself is shown only in an expanded nav (the rail's mini orb
  // is the other view), or as the front tab of a group.
  const orbPanelShown = inNav(dock.state, 'orb') ? !navCollapsed : isVisible(dock.state, 'orb')
  // Revealing a panel that would stay hidden in a collapsed nav expands it —
  // and only then (`revealNeedsNav`), so a board push or a route change never
  // re-expands a nav the person collapsed. The refs are the latest dock state
  // and collapse, so the callback below stays stable for LiveHub's effects.
  const dockStateRef = useRef(dock.state)
  const navCollapsedRef = useRef(navCollapsed)
  useEffect(() => {
    dockStateRef.current = dock.state
    navCollapsedRef.current = navCollapsed
  }, [dock.state, navCollapsed])
  const dockReveal = dock.reveal
  const reveal = useCallback(
    (p: PanelId) => {
      if (revealNeedsNav(dockStateRef.current, p, navCollapsedRef.current)) setNavCollapsed(false)
      dockReveal(p)
    },
    [dockReveal],
  )
  const liveDock = useMemo<LiveDock | null>(
    () =>
      docked ? { chatVisible, boardVisible, orbPanelShown, reveal, hide, setBoardFrozen } : null,
    [docked, chatVisible, boardVisible, orbPanelShown, reveal, hide],
  )
  const [agentsCollapsed, setAgentsCollapsed] = useState(true)
  // The main panel folded to a rail so the live and agents panels take its
  // width (mesa task 1485). Desktop tiers only: App.css ignores the class on
  // the phone tier, where main is the whole screen.
  const [mainCollapsed, setMainCollapsedState] = useState(loadMainCollapsed)
  // Whether the agents panel's auto-fold below is what folded main right now.
  // Any deliberate change (the toggle, the rail, a nav click, a route change)
  // clears it, so closing the panel never undoes a fold the person made.
  const autoFolded = useRef(false)
  const setMainCollapsed = (collapsed: boolean) => {
    autoFolded.current = false
    saveMainCollapsed(collapsed)
    setMainCollapsedState(collapsed)
  }
  // Opening the agents panel folds main, so it opens as full-width cards
  // (mesa task 1491); a phone has no fold to make. Edge-triggered, and never
  // persisted (a reload must not start on it): closing the panel gives the fold
  // back, but only if this effect made it and nothing has changed it since.
  const agentsWereCollapsed = useRef(true)
  useEffect(() => {
    if (agentsWereCollapsed.current && !agentsCollapsed && !isPhone() && !mainCollapsed) {
      autoFolded.current = true
      setMainCollapsedState(true)
    } else if (!agentsWereCollapsed.current && agentsCollapsed && autoFolded.current) {
      autoFolded.current = false
      setMainCollapsedState(false)
    }
    agentsWereCollapsed.current = agentsCollapsed
    // Edge-triggered on the panel alone; `mainCollapsed` is read at the edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsCollapsed])
  // Choosing somewhere to go — a nav click (handled on `.shell-body`) or a
  // route change from anywhere, the live agent's `navigate` included — brings
  // a folded main back. The first run is the mount, which must keep the
  // remembered fold.
  const seenPath = useRef(path)
  useEffect(() => {
    if (seenPath.current === path) return
    seenPath.current = path
    autoFolded.current = false
    saveMainCollapsed(false)
    setMainCollapsedState(false)
  }, [path])
  // Docked, a route change brings the main panel forward (it may be a background
  // tab or closed), and `#/terminal` is a verb like `#/live`: it shows the
  // terminal panel and the hash goes back to where the person was, since the
  // terminal is a panel here, not a page. `bounced` stops the put-back, which
  // is itself a path change, from pulling main back over the terminal.
  const prevHash = useRef(hash === '/terminal' ? '#/' : `#${hash}`)
  const bounced = useRef(false)
  // `null` until the first run: the mount keeps the remembered layout (a
  // closed main stays closed over a reload), except that a page loaded *on*
  // `#/terminal` still has to bounce.
  const dockSeenPath = useRef<string | null>(null)
  useEffect(() => {
    if (!docked || dockSeenPath.current === path) return
    const first = dockSeenPath.current === null
    dockSeenPath.current = path
    if (first && path !== '/terminal') return
    if (path === '/terminal') {
      bounced.current = true
      reveal('terminal')
      window.location.replace(prevHash.current === '#/terminal' ? '#/' : prevHash.current)
      return
    }
    prevHash.current = `#${hash}`
    if (bounced.current) {
      bounced.current = false
      return
    }
    reveal('main')
  }, [path, hash, docked, reveal])
  // `useState(isPhone)` above decides the nav drawer's state once, at mount,
  // and nothing re-decided it afterwards (mesa task 562; the flaw predates the
  // hoist to App and was filed against Sidebar.tsx, where it used to live).
  // That is not merely a stale default: the same boolean *means* two different
  // things either side of 600px — an in-flow sidebar above it, a fixed overlay
  // drawer below (`.sidebar:not(.collapsed)` in App.css's phone block) — so
  // crossing the boundary without re-deciding strands the nav in the other
  // tier's interpretation. Measured at 390x844: an expanded desktop sidebar
  // became a 256px overlay drawer nobody opened, and a collapsed phone rail
  // stayed a 34px stub on a 1200px window.
  //
  // Keyed on the *crossing*, not on the current value. A plain derived value
  // (`collapsed = phone`) would re-assert on every render and fight the user's
  // own toggle — reopening a drawer they just closed — so within a tier this
  // is inert and manual toggles survive (verified at 390 -> 375).
  useEffect(
    () =>
      onPhoneTierChange((phone) => {
        // Entering the phone tier collapses both drawers, because both become
        // fixed overlays there and neither was opened *as* one. Leaving it
        // only restores the nav: the nav's wide-screen default is expanded,
        // while the agents sidebar defaults to collapsed at every width, so
        // auto-expanding it on the way out would invent state nobody asked
        // for.
        setNavCollapsed(phone)
        if (phone) setAgentsCollapsed(true)
      }),
    [],
  )
  // One inbox poll for two badges. The sidebar's nav entry and the phone tab
  // bar both show the count of items still UNREAD (mesa task 831 — before it,
  // the count was every item, which never went down while triage was pending),
  // and a fetch each would let them skew by up to a poll interval —
  // `useFetch` caches nothing
  // across components, so an identical `key` in both would still be two
  // independent requests.
  const { data: inbox } = useFetch(() => listInbox(), 'inbox-nav', {
    pollMs: 5000,
  })
  const unread = unreadCount(inbox)
  // Which build am I looking at? Fetched once — a running server's version
  // cannot change, so no `pollMs`. Pure decoration: no error branch, and
  // nothing renders until it lands (a placeholder would be noise).
  const { data: naruVersion } = useFetch(() => getNaruVersion(), 'naru-version')

  // The inbox and its three sub-views (mesa task 845). One page, one fetch:
  // capture group 1 names the slice to show, and its absence is the "New"
  // triage queue, so the plain `#/inbox` URL every existing link uses still
  // lands where it always did.
  const inboxMatch = /^\/inbox(?:\/(read|archived))?$/.exec(path)
  const inboxFilter = inboxMatch ? inboxFilterFor(inboxMatch[1]) : null
  // Settings: global, above projects like the Inbox — the config file it edits
  // is per-machine, not per-project. The optional segment is the page's tab
  // (`settingsTab.ts`, mesa task 1140); anchored, so `/projects/<id>/settings`
  // below is never mistaken for it.
  const settingsMatch = /^\/settings(?:\/([^/]+))?$/.exec(path)
  // Scripts: global too. A script may bind a project (whose `local_path` is
  // then the run's cwd), but it is not a project tab — an unbound one runs in
  // $HOME and belongs to no project at all.
  // `/runs/:id` is a sub-view of the same page, addressed rather than held in
  // component state: a detached run survives the tab, so reopening one has to
  // survive a reload too (mesa task 1224).
  const scriptsMatch = /^\/scripts(?:\/runs\/(\d+))?$/.exec(path)
  // Workflows overview: every workflow across all projects, global like
  // Scripts. Anchored, so `/projects/<id>/workflows` is never mistaken for it.
  const workflowsOverviewMatch = /^\/workflows$/.exec(path)
  // Library: global too, same reasoning as Scripts — a project-scoped item
  // binds a project, but the page itself is not a project tab.
  const libraryMatch = /^\/library$/.exec(path)
  // Terminal is not resolved into `page` (see below) — it's a permanent
  // sibling mount alongside `main`/`AgentSidebar` (mesa task 396,
  // .scratch/arch.md §4.3), toggled via `visibility` so panes and their
  // websockets survive navigating away and back. This match only drives
  // that visibility toggle and the nav's active-link highlight.
  const terminalMatch = /^\/terminal$/.exec(path)
  const terminalActive = terminalMatch !== null
  // CC Dashboard is the default landing view: the root path (#/ or empty) shows
  // the overview, and the brand link points back here. The three sub-pages
  // (#/cc/skills-agents, #/cc/projects, #/cc/sessions) carry the table views;
  // capture group 1 is the active sub-page, undefined for the overview.
  const ccMatch = /^\/(?:cc(?:\/(skills-agents|projects|sessions))?)?$/.exec(path)
  // One session, drilled into from the Sessions table: the aggregate detail
  // page by default, its timeline one link further in. Session ids are UUIDs,
  // but the segment is matched loosely and decoded rather than pattern-matched,
  // so an id shape change upstream can't silently 404 here.
  //
  // `/graph` is the timeline's old URL, kept as an alias so existing links and
  // bookmarks from the React Flow canvas era still land somewhere (mesa task
  // 691).
  //
  // The two patterns cannot swallow each other: the id segment is `[^/]+`, so
  // a trailing suffix can never be part of it and the detail pattern anchors
  // its end right after the id. Keep it that way — a `.+` there would make the
  // order of these two matches load-bearing.
  const ccDetailMatch = /^\/cc\/sessions\/([^/]+)$/.exec(path)
  const ccTimelineMatch = /^\/cc\/sessions\/([^/]+)\/(?:graph|timeline)$/.exec(path)
  // Both are drill-downs *of* the Sessions tab, so the nav keeps highlighting
  // Sessions while either is open.
  const ccTab = ccMatch
    ? ((ccMatch[1] ?? 'overview') as CcTab)
    : ccDetailMatch || ccTimelineMatch
      ? ('sessions' as CcTab)
      : null
  const workflowMatch = /^\/projects\/(\d+)\/workflows\/(\d+)$/.exec(path)
  const workflowListMatch = /^\/projects\/(\d+)\/workflows$/.exec(path)
  const gitMatch = /^\/projects\/(\d+)\/git$/.exec(path)
  const filesMatch = /^\/projects\/(\d+)\/files$/.exec(path)
  const artifactsMatch = /^\/projects\/(\d+)\/artifacts$/.exec(path)
  // Distinct from `terminalMatch` above: this one is a project tab rendered
  // inside `main`'s project frame (like Files/Git), not the permanently
  // mounted global page.
  const projectTerminalMatch = /^\/projects\/(\d+)\/terminal$/.exec(path)
  const dashboardMatch = /^\/projects\/(\d+)\/dashboard$/.exec(path)
  // The project's OWN settings tab (folder / parent / archive) — distinct
  // from `settingsMatch` above, which is the global config.json editor.
  const projectSettingsMatch = /^\/projects\/(\d+)\/settings$/.exec(path)
  // The project's own pane layout (mesa task 843) — the tab a tab-into-the-
  // main-area drag creates. URL-driven like every other project tab; the tree
  // it shows is machine-local (`projectPanes.ts`), and a project with no
  // remembered tree renders the Board here instead.
  const projectCustomMatch = /^\/projects\/(\d+)\/custom(?:\/tasks\/(\d+))?$/.exec(path)
  // Route the command palette's "Create task in <project>" entry navigates
  // to; ProjectTasksPage opens the create-task form on arrival and returns
  // to the plain project route once the form is closed or saved (spec
  // Assumption 2: the create panel itself stays ephemeral local state).
  const createTaskMatch = /^\/projects\/(\d+)\/create-task$/.exec(path)
  const projectMatch = /^\/projects\/(\d+)(?:\/tasks\/(\d+))?$/.exec(path)
  const legacyTaskMatch = /^\/tasks\/(\d+)$/.exec(path)
  const activeProjectId = workflowMatch
    ? Number(workflowMatch[1])
    : workflowListMatch
      ? Number(workflowListMatch[1])
      : gitMatch
        ? Number(gitMatch[1])
        : filesMatch
          ? Number(filesMatch[1])
          : artifactsMatch
            ? Number(artifactsMatch[1])
            : projectTerminalMatch
              ? Number(projectTerminalMatch[1])
              : dashboardMatch
                ? Number(dashboardMatch[1])
                : projectSettingsMatch
                  ? Number(projectSettingsMatch[1])
                  : projectCustomMatch
                    ? Number(projectCustomMatch[1])
                    : createTaskMatch
                      ? Number(createTaskMatch[1])
                      : projectMatch
                        ? Number(projectMatch[1])
                        : null

  let page
  if (settingsMatch) {
    // ~/.mesa/config.json editor: no project frame, no active project.
    page = <SettingsView tab={settingsTabFromPath(path)} />
  } else if (scriptsMatch) {
    // Stored shell scripts + their run forms: global, so no project frame and
    // no active project, exactly like the inbox below.
    page = <ScriptsView runId={scriptsMatch[1] ? Number(scriptsMatch[1]) : null} />
  } else if (workflowsOverviewMatch) {
    page = <WorkflowsOverview />
  } else if (libraryMatch) {
    // Agents/skills/hooks/commands/prompts/CLAUDE.md, synced against
    // .claude: global, same reasoning as Scripts above.
    page = <LibraryView />
  } else if (inboxMatch) {
    // Global inbox: lives above projects, so it renders on its own (no project
    // frame) and carries no active project in the nav.
    page = <InboxView filter={inboxFilter!} />
  } else if (ccTimelineMatch) {
    // Checked before `ccMatch` for readability only — every one of these
    // patterns is disjoint (`ccMatch` anchors the end right after `sessions`).
    page = (
      <CCSessionTimelineView
        sessionId={decodeURIComponent(ccTimelineMatch[1])}
        origin={ccOrigin}
      />
    )
  } else if (ccDetailMatch) {
    page = (
      <CCSessionDetailView sessionId={decodeURIComponent(ccDetailMatch[1])} origin={ccOrigin} />
    )
  } else if (ccMatch) {
    // CC Dashboard: global telemetry view, also above projects. `ccTab` is
    // non-null whenever ccMatch is.
    page = <CCDashboardView tab={ccTab!} />
  } else if (workflowMatch) {
    // Single board: in-place workflow view inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(workflowMatch[1])}
        taskId={null}
        workflows
        workflowId={Number(workflowMatch[2])}
        git={false}
        files={false}
        artifacts={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (workflowListMatch) {
    // Boards index: in-place workflows view inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(workflowListMatch[1])}
        taskId={null}
        workflows
        workflowId={null}
        git={false}
        files={false}
        artifacts={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (gitMatch) {
    // Working-tree git view, in place inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(gitMatch[1])}
        taskId={null}
        workflows={false}
        workflowId={null}
        git
        files={false}
        artifacts={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (filesMatch) {
    // File tree + content viewer, in place inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(filesMatch[1])}
        taskId={null}
        workflows={false}
        workflowId={null}
        git={false}
        files
        artifacts={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (artifactsMatch) {
    // Agent-written pages for the project, in place inside the project page
    // frame (mesa task 974).
    page = (
      <ProjectTasksPage
        projectId={Number(artifactsMatch[1])}
        taskId={null}
        workflows={false}
        workflowId={null}
        git={false}
        files={false}
        artifacts
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (projectTerminalMatch) {
    // Shell panes rooted at the project's folder, in place inside the
    // project page frame. Unlike the global Terminal page (a permanent
    // sibling mount below), this one unmounts with the route — its panes'
    // shells survive anyway, since every PtyTerminal lives in the
    // always-mounted PtyPool and the pane tree is kept per scope by
    // TerminalPage itself (mesa task 524).
    page = (
      <ProjectTasksPage
        projectId={Number(projectTerminalMatch[1])}
        taskId={null}
        workflows={false}
        workflowId={null}
        git={false}
        files={false}
        artifacts={false}
        terminal
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (dashboardMatch) {
    // Project-scoped CC dashboard, in place inside the project page frame.
    page = (
      <ProjectTasksPage
        projectId={Number(dashboardMatch[1])}
        taskId={null}
        workflows={false}
        workflowId={null}
        git={false}
        files={false}
        artifacts={false}
        terminal={false}
        dashboard
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (projectSettingsMatch) {
    // Whole-project settings (folder / parent / archive), in place inside the
    // project page frame like Git/Files (mesa task 682).
    page = (
      <ProjectTasksPage
        projectId={Number(projectSettingsMatch[1])}
        taskId={null}
        workflows={false}
        workflowId={null}
        git={false}
        files={false}
        artifacts={false}
        terminal={false}
        dashboard={false}
        settings
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (projectCustomMatch) {
    // The project's own pane layout, in place inside the project page frame
    // like every other tab (mesa task 843).
    page = (
      <ProjectTasksPage
        projectId={Number(projectCustomMatch[1])}
        taskId={projectCustomMatch[2] ? Number(projectCustomMatch[2]) : null}
        workflows={false}
        workflowId={null}
        git={false}
        files={false}
        artifacts={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (createTaskMatch) {
    // Opens straight into the create-task form, in place inside the project
    // page frame (Board view underneath) — see the route comment above.
    page = (
      <ProjectTasksPage
        projectId={Number(createTaskMatch[1])}
        taskId={null}
        workflows={false}
        workflowId={null}
        git={false}
        files={false}
        artifacts={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (projectMatch) {
    page = (
      <ProjectTasksPage
        projectId={Number(projectMatch[1])}
        taskId={projectMatch[2] ? Number(projectMatch[2]) : null}
        workflows={false}
        workflowId={null}
        git={false}
        files={false}
        artifacts={false}
        terminal={false}
        dashboard={false}
        settings={false}
        custom={false}
        createTask={false}
        onProjectsChanged={() => setNavVersion((v) => v + 1)}
      />
    )
  } else if (legacyTaskMatch) {
    page = <LegacyTaskRedirect taskId={Number(legacyTaskMatch[1])} />
  } else {
    page = <p className="muted placeholder">Select a project.</p>
  }

  return (
    <>
      <DoneToasts />
      <header>
        <a className="brand" href="#/">
          <svg className="brand-mark" viewBox="0 0 64 64" role="img" aria-hidden="true">
            <g strokeLinecap="round">
              <g stroke="#07030f" strokeWidth="6" strokeOpacity="0.55">
                <line x1="8" y1="28" x2="8" y2="36" />
                <line x1="16" y1="21" x2="16" y2="43" />
                <line x1="24" y1="14" x2="24" y2="50" />
                <line x1="32" y1="8" x2="32" y2="56" />
                <line x1="40" y1="14" x2="40" y2="50" />
                <line x1="48" y1="21" x2="48" y2="43" />
                <line x1="56" y1="28" x2="56" y2="36" />
              </g>
              <g strokeWidth="4">
                <line x1="8" y1="28" x2="8" y2="36" stroke="#8a2bff" />
                <line x1="16" y1="21" x2="16" y2="43" stroke="#ff2bd6" />
                <line x1="24" y1="14" x2="24" y2="50" stroke="#2b8aff" />
                <line x1="32" y1="8" x2="32" y2="56" stroke="#29e6ff" />
                <line x1="40" y1="14" x2="40" y2="50" stroke="#2b8aff" />
                <line x1="48" y1="21" x2="48" y2="43" stroke="#ff2bd6" />
                <line x1="56" y1="28" x2="56" y2="36" stroke="#8a2bff" />
              </g>
              <g stroke="#f1e6ff" strokeWidth="1.2">
                <line x1="8" y1="28" x2="8" y2="36" />
                <line x1="16" y1="21" x2="16" y2="43" />
                <line x1="24" y1="14" x2="24" y2="50" />
                <line x1="32" y1="8" x2="32" y2="56" />
                <line x1="40" y1="14" x2="40" y2="50" />
                <line x1="48" y1="21" x2="48" y2="43" />
                <line x1="56" y1="28" x2="56" y2="36" />
              </g>
            </g>
          </svg>
          <span className="brand-text">
            Naru
            {naruVersion && (
              <span className="brand-version">v{naruVersion.version}</span>
            )}
          </span>
        </a>
        {/* The right cluster (mesa task 857): the live conversation's controls
            sit beside the plan-limit chips, on every page. */}
        {docked && <DockBar dock={dock} locked={locked} />}
        <div className="header-right">
          {!docked && (
          <button
            type="button"
            className="sidebar-toggle main-collapse-toggle"
            aria-label={mainCollapsed ? 'Expand main panel' : 'Collapse main panel'}
            title={mainCollapsed ? 'Expand main panel' : 'Collapse main panel'}
            aria-pressed={mainCollapsed}
            onClick={() => setMainCollapsed(!mainCollapsed)}
          >
            {mainCollapsed ? '▣' : '◧'}
          </button>
          )}
          {/* A `collapse-sidebars` turn moves both panels at once (task 859):
              the conversation asked for room, and "the sidebars" is the pair.
              Both flags live here already — the phone tab bar writes the same
              two — so the hub relays the request rather than owning it. */}
          <LiveHub
            slot={docked ? null : liveSlot}
            dock={liveDock}
            navCollapsed={navCollapsed}
            agentsCollapsed={docked ? !agentsVisible : agentsCollapsed}
            activeProjectId={activeProjectId}
            onSidebars={(collapsed) => {
              setNavCollapsed(collapsed)
              if (!docked) setAgentsCollapsed(collapsed)
              // Docked, "closing the agents panel" is closing the panel, which
              // remembers its spot for the expand that follows.
              else if (collapsed) hide('agents')
              else reveal('agents')
            }}
          />
          <HeaderUsage />
        </div>
      </header>
      <div
        className={`shell-body${mainCollapsed && !docked ? ' main-collapsed' : ''}${docked ? ' docked' : ''}`}
        onClick={(e) => {
          if (!docked && mainCollapsed && isNavLinkClick(e.target)) setMainCollapsed(false)
        }}
      >
        <Sidebar
          activeProjectId={activeProjectId}
          inboxFilter={inboxFilter}
          settingsActive={settingsMatch !== null}
          scriptsActive={scriptsMatch !== null}
          workflowsActive={workflowsOverviewMatch !== null}
          libraryActive={libraryMatch !== null}
          terminalActive={terminalActive}
          ccTab={ccTab}
          version={navVersion}
          unread={unread}
          collapsed={navCollapsed}
          onCollapsedChange={setNavCollapsed}
          dockZone={docked ? <NavZone state={dock.state} update={dock.update} locked={locked} /> : undefined}
          rail={
            docked ? (
              <NavRail state={dock.state} navCollapsed={navCollapsed} unread={unread} onReveal={reveal} onExpand={() => setNavCollapsed(false)} />
            ) : undefined
          }
        />
        {docked ? (
          <div className="dock-area">
            <DockLayout state={dock.state} update={dock.update} locked={locked} />
          </div>
        ) : (
          <>
        <div className="main-slot">
          {mainCollapsed && (
            <button
              type="button"
              className="main-rail"
              aria-label="Expand main panel"
              title="Expand main panel"
              onClick={() => setMainCollapsed(false)}
            >
              «
            </button>
          )}
          {/* Both panes are permanent siblings, never conditionally rendered —
              same invariant AgentSidebar's own collapse relies on. `main`'s
              content (`page`) keeps its existing per-route mount/unmount
              behavior; only the pane wrapper's visibility toggles alongside
              Terminal's, so navigating to/from Terminal never touches
              TerminalPage's own mounted state (arch.md §4.3). */}
          <div
            className={terminalActive ? 'main-slot-pane main-slot-pane-hidden' : 'main-slot-pane'}
          >
            <main>{page}</main>
          </div>
          <div className={terminalActive ? 'main-slot-pane' : 'main-slot-pane main-slot-pane-hidden'}>
            <TerminalPage active={terminalActive} />
          </div>
        </div>
        {/* Where LiveHub portals its conversation panel (mesa task 887). The
            hub itself stays in the header — everything that makes it work is
            anchored there — but the panel is a right-hand sidebar, a sibling
            of the agents one, so the two can be open together, singly, or not
            at all. A slot rather than the panel itself because the state is
            all the hub's; `display: contents`, so the panel is the flex item
            and an empty slot takes no room. */}
        <div className="live-slot" ref={setLiveSlot} />
        <AgentSidebar
          activeProjectId={activeProjectId}
          liveSlot={liveSlot}
          collapsed={agentsCollapsed}
          onCollapsedChange={setAgentsCollapsed}
        />
          </>
        )}
        {/* Each dock panel renders once into its own stable host, which the
            dock moves between groups (`lib/dockHosts.ts`), so re-docking never
            remounts the page, the terminal's shells or the agents' panes. The
            conversation's two panels are portalled the same way by LiveHub. */}
        {docked &&
          createPortal(<main>{page}</main>, hostFor('main'))}
        {docked &&
          createPortal(<TerminalPage active={terminalVisible} />, hostFor('terminal'))}
        {docked &&
          createPortal(
            <AgentSidebar
              docked
              activeProjectId={activeProjectId}
              collapsed={!agentsVisible}
              onCollapsedChange={(collapsed) => (collapsed ? hide('agents') : reveal('agents'))}
            />,
            hostFor('agents'),
          )}
        {docked &&
          createPortal(<WorkflowsPanel projectId={activeProjectId} />, hostFor('workflows'))}
        {/* Single always-mounted owner of every open leaf's PtyTerminal
            (mesa task 399, .scratch/arch.md §6.2), across BOTH AgentSidebar
            and TerminalPage — a permanent sibling, never inside `page` or
            conditionally rendered, same never-unmount invariant AgentSidebar
            itself already relies on. */}
        <PtyPool />
      </div>
      {/* Phone-tier only (hidden by CSS above 600px), outside `.shell-body`
          because it is `position: fixed` and must not participate in the
          shell's flex row. */}
      <PhoneTabBar
        activeProjectId={activeProjectId}
        inboxActive={inboxMatch !== null}
        unread={unread}
        navOpen={!navCollapsed}
        agentsOpen={!agentsCollapsed}
        onNavOpenChange={(open) => setNavCollapsed(!open)}
        onAgentsOpenChange={(open) => setAgentsCollapsed(!open)}
      />
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  )
}

export default App
