# Dock (mesa task 1567)

The desktop tiers' panel layout. The left nav stays pinned on the left (and
collapsible as before); everything else is a **dockable panel** with a tab
header and a grip. Frontend-only: no CLI, API or Rust surface.

| Panel | Content |
|---|---|
| `main` | the routed page (`<main>{page}</main>`) |
| `chat` | the live conversation: head, transcript, composer |
| `board` | the live whiteboard (`LiveBoardPanel`), or "No whiteboard yet" |
| `agents` | `AgentSidebar` with its `docked` prop |
| `terminal` | the global `TerminalPage` |
| `diagrams` | `DiagramsPanel`: the boards of the project the route is on, opened in place |

Each panel appears at most once. The phone tier (`usePhoneTier()`) is **not**
docked and keeps its drawers, tab bar and the old live aside unchanged.

## Gestures

- **Drag by the tab.** Dropping on a panel's body lights five zones
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
  every panel and reopens a closed one. A closed panel remembers where it sat
  (`lastSpot`: beside the neighbour it left, or stacked with its tab mate) and
  reopens there, else on the root's right.
- **Saved layouts.** The header switcher holds Talk, Review and Build plus any
  the person adds with `+` (the current arrangement under a new name). Edits
  save into the active layout live; a built-in has a reset (`↺`), a user layout
  a delete (`×`). Diagrams starts closed in all three presets.

## Pieces

| Piece | File | Owns |
|---|---|---|
| State | `frontend/src/dockLayout.ts` (+ `.test.ts`) | pure: types, `dropPanel`, `closePanel`, `revealPanel`, `isVisible`, presets, versioned parse/serialize, saved-layout CRUD |
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
offsets and focus across the reparent. An `<iframe>` inside a moved container
still reloads (the browser does that on any reparent): a board's document
re-renders from its stored body.

## Persistence

One `localStorage` key, `naru-dock-layouts` = `{v: 1, active, layouts: [{id,
name, builtin, state}]}`; machine-local. Parsing is total: unknown panel ids
are dropped, a panel in two groups (or a group named twice) rejects that
layout, and a layout with nothing docked falls back to its preset (a built-in)
or is dropped (a user one) — never an empty layout.

## Live behaviours

LiveHub takes an optional `dock` prop (`chatVisible`, `boardVisible`, `reveal`,
`hide`, `setBoardFrozen`) instead of the `slot`: "open" is the chat panel being
a group's front tab, and every opener goes through the dock.

- A board push (and the header's "show the whiteboard") reveals the board panel.
- `navigate` reveals the main panel; so does any route change. `#/live`
  reveals the chat panel and the header chat toggle toggles it.
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
