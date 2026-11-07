# Custom panels (naru task 2613)

A person (or an agent, through the library) writes an HTML fragment, stores it
as a Library item of kind `panel`, and opens it as a dock tab. It runs in a
sandboxed iframe and reads Naru only through a small, read-only, per-permission
API that the page enforces. v1 is read-only: no write methods, no scripts or
tools, no external script or CDN.

## Storage

Kind `panel` (`LibraryKind::Panel`) is a stored row with **no file on disk**:
`relative_path` answers `None`, like a prompt that does not export. Sync,
`scan_disk` and `sync status` never see it; export and import carry it as any
row. There is no migration (the `kind` column has no CHECK) and `Store` does
not validate the body. User scope in practice (the Library page lists user-scope
rows); a project-scope row is allowed but has no UI. The shipped example is the
built-in `project-stats` (`src/core/builtins/project-stats.html`).

## Manifest

```html
<meta name="naru-panel" content='{"title":"Project stats","permissions":["stats:read"]}'>
```

Parsed in the page with `DOMParser` (`panelSdk.ts::parseManifest`), never in
the iframe. No meta means no permissions and the panel simply runs. Bad JSON,
a non-object, a non-string `title` or an unknown permission word means the panel
**refuses to run** and the tab shows the reason.

## Permissions and methods

| permission | method | params | answers |
| --- | --- | --- | --- |
| `projects:read` | `projects.list` | `{include_archived?: bool}` | `listProjects()` |
| `projects:read` | `project.get` | `{id: number}` | `getProject(id)` |
| `tasks:read` | `tasks.list` | `{project?: number, status?: Status}` | `listTasks({project, status})` |
| `stats:read` | `stats` | `{}` | `{projects:[{id, name, total, blocked, by_status}]}` |

There is no stats endpoint: `stats` is computed in the page from `listProjects()`
and `listTasks()`, in project-list order, dropping tasks of unlisted projects.
`projects:read` exposes each project's `local_path`.

## Grants

The grant is a **browser** fact, not a database one: `localStorage` key
`naru-panel-grants` = `{v:1, grants:{[itemKey]: string[]}}`, `itemKey` being
`libraryOverride.ts::itemKey` (`id:<n>` or `builtin:<id>`). Enforcement is in
the parent page, so a server-side grant would add no security and would let an
agent grant itself through the CLI or API; only a person in a browser can write
this key, and a sandboxed iframe cannot reach it. It is per browser.

A panel runs iff what its manifest requests is a subset of what is granted. A
body edit that keeps the same permissions does not re-prompt; asking for more
does; a fork of a built-in has a new key and prompts again. The grant is
re-read on **every request**, so a revoke (the Library row's "revoke", or
clearing the key) takes effect at once.

The prompt is in the tab, **before any iframe exists**: the panel's name, one
line per permission, **Allow and run** (writes the grant, mounts the iframe) and
**Close**.

## Sandbox

`<iframe sandbox="allow-scripts" srcdoc=…>`: no `allow-same-origin`, popups or
forms. The document is `<!doctype html><html><head>` + a CSP `<meta>` as the
**first child of `<head>`** + a `<style>:root{--naru-*}</style>` + the SDK script
+ `</head><body>` + the author's body. The CSP (`panelSdk.ts::PANEL_CSP`) is
`api.rs::RENDER_CSP` minus `frame-ancestors` and `sandbox`, which a meta tag
ignores: `default-src 'none'; script-src 'unsafe-inline'; style-src
'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action
'none'; base-uri 'none'`. The theme arrives as the same `--naru-*` variables an
html board sees (`boardTheme.ts`); a new theme rebuilds the document, which
reloads the frame.

## Protocol and SDK

Panel to page: `{naru: 1, k, id, method, params?}`, where `k` is a random
key minted per tab mount and baked into the SDK. Page to panel: `{naru: 1, id,
result}` or `{naru: 1, id, error: {code, message}}`; codes are `forbidden` (not
granted), `usage` (unknown method or bad params), else the API's own code and
message. The page accepts a message only when `e.source` is the iframe's
`contentWindow` (read at message time: it changes when the dock reparents the
frame), `k` matches and the shape matches; anything else is silently ignored. Replies use
`contentWindow.postMessage(reply, '*')` since an opaque origin cannot be
targeted. `naru: 1` is a number, so it cannot collide with the board, mark-skin
and key-relay messages (`naru: '<string>'`).

`window.naru` inside the frame: `naru.permissions` (the granted list) and
`naru.call(method, params)` returning a Promise that rejects with an `Error`
carrying `.code`.

## Tabs

`panel:<itemKey>` tabs are transient like `agent:` tabs (`docs/dock.md`): never
in `PANEL_IDS`, no last spot on close, gone after a reload. The button is shown
only on the docked tiers.

## Known limits

- A panel can navigate its own frame to an attacker URL and so exfiltrate what
  it read: CSP cannot stop self-navigation. The same accepted limit as artifacts
  and boards. The prompt is the control; grant only panels you trust. A
  document the frame navigates to does not hold the SDK key `k`, so it cannot
  call the SDK on the panel's grant (unless the panel's own code handed it
  over, which an exfiltrating panel has no need to).
- A grant is per item and permission set, not per body: an edit that asks for
  no new permission (by a person, the CLI or the API) runs under the existing
  grant without a new prompt.
- `projects:read` exposes local folder paths.
- Moving a panel's tab between groups reparents the iframe and reloads it.
- The library routes are agent-grade (`require_agent_access`): on a non-local
  `--lan` desktop the item fetch fails and the tab shows that error.
- Out of scope in v1: write methods, scripts and tools, tabs across reloads,
  the phone tier, a project-scope panel UI, external scripts or CDNs, key relay
  from the panel, a starter template in the create form.
