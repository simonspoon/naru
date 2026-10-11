# Dock (mesa task 1567)

The desktop tiers' panel layout. The left nav stays on the left (collapsible as
before) and is itself a **dock zone** (mesa task 1574, below); everything else
is a **dockable panel** with a tab header and a grip. Frontend-only: no CLI, API
or Rust surface.

| Panel | Content |
|---|---|
| `main` | the routed page (`<main>{page}</main>`) |
| `chat` | the live conversation: head, transcript, composer |
| `board` | the live whiteboard (`LiveBoardPanel`), or "No whiteboard yet" |
| `agents` | `AgentSidebar` with its `docked` prop |
| `terminal` | the global `TerminalPage` |
| `workflows` | `WorkflowsPanel`: the workflows of the project the route is on, opened in place (a saved layout naming the old `diagrams` id is renamed on load) |

The live orb is **not** a panel (naru task 1798; it was one, `orb`, from mesa
task 1574): see "The nav's orb" below. Each panel appears at most once. The phone tier (`usePhoneTier()`) is **not**
docked and keeps its drawers, tab bar and the old live aside unchanged.

## The nav zone and the rail (mesa task 1574)

`DockState.nav` is an ordered stack of panels docked into the left nav, above
its links, outside the split tree; a panel is in a group **or** in `nav`.
Presets leave it empty. Each nav item has a grip (drag it out), a label and a close; dropping a dragged
panel on the zone (`NavZone`, `components/NavDock.tsx`) inserts it where the
cyan line shows (`dockToNav`); an empty zone takes no room until a drag starts.
Any panel may be docked there. A panel in a collapsed nav is not mounted, so it
counts as hidden (`isVisible(state, panel, navCollapsed)`), and revealing one expands the nav — only then
(`revealNeedsNav`): a board push or route change on any other panel never
re-expands a nav the person collapsed.

There is no Panels list in the nav: the header `⋯` menu (see Close / reopen)
is the one place that lists panels. It replaces the old top-right chat and
whiteboard toggles, which are no longer rendered when docked (the phone tier
keeps them).

Collapsing the nav leaves a slim **rail**: the expand handle, the dashboard (⌂)
and inbox (✉, with its unread count) links, a separator, and one icon per
panel (dotted when open; a click reveals it). Panels docked in a collapsed nav
are parked, not shown. The orb is hidden in the rail (no mini variant).

## The nav's orb (naru task 1798)

A permanent, fixed element at the top of the expanded nav, under the collapse
arrow and above the nav links: the animated mark over its state-coloured glow
(`LiveOrb.tsx`'s `OrbPanel`), with no title bar, grip or close, and no part of
the dock state — it cannot be moved, closed or listed in the `⋯` menu. Its
mic / pause / sound buttons stay in the page header (`OrbHeaderControls`).
`NavOrb` (`components/NavDock.tsx`) is only a mount point for the stable
`nav-orb` host (`dockHosts`); `LiveHub` (mounted once, in the header) owns the
mic level, playback level and indicator state and portals the orb into that
host while the nav is expanded, so closing Chat stops nothing. Collapsing the
nav unmounts the orb's view (only the host stays stable) and expanding mounts
it afresh; the state is LiveHub's, so nothing of the conversation restarts. The phone tier has no dock, no nav
orb, and keeps its floating orb.

## Gestures

- **Drag by the tab** (or, for any panel, by a nav item or a row of the `⋯` menu; the
  in-flight drag is `lib/panelDrag.ts`). Dropping on a panel's body lights five zones
  (`computeDropEdge`'s rule: the middle 40% stacks, the outer ring is
  quartered): left/right/top/bottom split the target, the centre stacks the
  dragged panel as a tab. While a drag is in flight a transparent shield sits
  over every group so an iframe (a board) or xterm cannot swallow the drop; it
  goes up one tick after `dragstart`, since mounting it inside the event
  cancels the drag in some browsers. A group showing a board that holds unsent
  ink takes no drops and its tab does not drag or close.
- **Thin dividers** resize splits (the other pane surfaces' divider math,
  `MIN_PANE_PX` floor).
- **Close / reopen.** A tab's × closes the panel; the header's `⋯` menu lists
  **only the closed panels** (`closedPanels`: in no group and not in the nav) —
  opening or docking one removes its row, closing one puts it back, and with
  none closed it says "Every panel is open". A click reopens a row where it sat;
  dragging a row docks it where dropped (the same `panelDrag` flow as a tab).
  The menu is hidden, not unmounted, while a row is dragged — unmounting the
  drag source cancels the drag — and closes on drop or dragend. A closed panel remembers where it sat
  (`lastSpot`: beside the neighbour it left, or stacked with its tab mate) and
  reopens there, else on the root's right.
- **Saved layouts.** The header switcher holds Talk, Review and Build plus any
  the person adds with `+` (the current arrangement under a new name). Edits
  save into the active layout live; a built-in has a reset (`↺`). Every layout,
  built-in or not, can be renamed, deleted and moved from its menu — right-click
  the layout, or the `⋮` button beside the active one: Rename (inline, Enter
  saves; empty or a name another layout wears is refused), Delete (refused for
  the last layout), Move left / Move right, and Restore default layouts. A
  built-in is tracked by its id (`talk`/`review`/`build`), never its name, so a
  renamed Talk is still Talk: Restore appends only the built-ins whose id is gone
  (default arrangement, a taken name gets a number) and touches nothing else.
  Workflows starts closed in all three presets.

## Pieces

| Piece | File | Owns |
|---|---|---|
| State | `frontend/src/dockLayout.ts` (+ `.test.ts`) | pure: types, `dropPanel`, `dockToNav`, `closePanel`, `revealPanel`, `isVisible`, `panelEntries` (the rail), presets, versioned parse/serialize, saved-layout CRUD (rename, delete, move, restore defaults) |
| Nav | `frontend/src/components/NavDock.tsx` | the nav zone, the collapsed rail |
| Store hook | `frontend/src/useDockStore.ts` | the store in React, persisted on every change; stable `reveal`/`hide` |
| Hosts | `frontend/src/lib/dockHosts.ts`, `components/DockSlot.tsx` | one container per panel, moved between groups |
| Chrome | `frontend/src/components/DockLayout.tsx` | the split tree, tab strips, shield/zones, dividers, the header bar |

The tree is `lib/paneTree.ts`, reused unchanged. Each **leaf is a group** (an
opaque id) and the group's tab stack lives in a side map, so an edge drop is
the same move `projectPanes.dropTab` makes: append a new group to the root and
`splitLeafAt` it beside the target.

## Moving never remounts

A panel's content renders **once**, by `createPortal` into its host container
(`ptyPool.ts`'s pattern); a `DockSlot` appends that container to whichever group
shows the panel and parks it in a hidden div otherwise. So the conversation's
microphone, audio element and session state (LiveHub), the agents' PTYs and
the terminal's shells never restart because a tab moved. A move carries scroll
offsets and focus across the reparent. A background tab stays in its own group,
hidden in place (`visibility: hidden`), so a tab switch reparents nothing. The
limit: an `<iframe>` reloads whenever the browser reparents it, so **moving a
panel to another group, or closing and reopening it, reloads a board's
document** (it re-renders from its stored body); a closed panel is parked in a
hidden div.

Crossing the 600px phone tier switches between the dock and the old layout, so
the **page, agents and terminal panels remount** (the PTYs live in the pool and
LiveHub is mounted either way, so shells and the conversation survive; the
agents' pane tree and the page's local state reset).

## Persistence

One `localStorage` key, `naru-dock-layouts` = `{v: 2, active, layouts: [{id,
name, builtin, state}]}`; machine-local. A v1 store (before a built-in could be
deleted) loads with any missing built-in put back and is rewritten as v2; in v2
a deleted built-in stays deleted, and an empty store is the default one. A state carries `nav` (the zone's
panels); a layout saved before task 1574 has no `nav` key and loads with an
empty one. Parsing is total: unknown panel ids are dropped — which is how a
layout saved while the orb was a panel (`orb` in a group, the nav list or a
`lastSpot`) loads without it, leaving no duplicate and no empty group — a panel in two groups (or a group named twice) rejects that
layout, and a layout with nothing docked falls back to its preset (a built-in)
or is dropped (a user one) — never an empty layout. (So a user layout with
every panel closed is dropped on the next reload; one whose only docked panels
are in the nav zone is kept.) Writes are debounced
(250ms, flushed on page hide and unmount), so a divider drag is one write.
While a board holds unsent ink the header's switch, `+` and reset are disabled.

## Live behaviours

LiveHub takes an optional `dock` prop (`chatVisible`, `boardVisible`, `reveal`,
`hide`, `setBoardFrozen`) instead of the `slot`: "open" is the chat panel being
a group's front tab, and every opener goes through the dock.

- A board push reveals the board panel.
- `navigate` reveals the main panel; so does any route change. `#/live`
  reveals the chat panel.
- `#/terminal` is a verb like `#/live`: it reveals the terminal panel and the
  hash goes back to where the person was.
- `collapse-sidebars` collapses the nav and closes the agents panel (remembering
  its spot); `expand-sidebars` expands the nav and reveals agents.
- The view line (`chatOpen`/`agentsOpen`/`boardOpen`/`navCollapsed`) reads dock
  visibility.
- Unsent ink freezes the board: the dock blocks its tab drag and close. (Its
  neighbours' dividers still move, so the old pinned-size floor is not applied
  when docked.)

The width drag, the board/chat section-ratio drag, swap and arrange toggles of
the old aside are not rendered when docked; the dock's dividers replace them.
