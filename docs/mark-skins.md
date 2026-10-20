# Mark skins

The live mark (the conversation panel head and the nav orb) is a **host**
around a pluggable **skin** (naru task 2120). Three are built in:

- `waveform` — the favicon's seven bars, unchanged from mesa task 1544 (the
  default);
- `face` (naru task 2121) — a round head that blinks every 2.5–6 s, opens its
  mouth with the speech level, looks wide-eyed and leans in while hearing,
  looks up and aside with a raised brow while thinking, and dims with its
  eyes half shut when paused;
- `blob` (naru task 2121) — a soft shape through eight radii that breathes at
  idle, wobbles and pulses with the level while hearing or speaking, turns
  slowly with a two-lobed ripple while thinking, and holds still when paused.

The face's and the blob's arithmetic lives in `frontend/src/markSkinFrames.ts`
(unit-tested, `reduced` halving the clock blinks included); their painters
fill a radial gradient from the palette's slots, so every state colour still
comes from the host's palette. Each mounted painter gets its own gradient id
(`markSkins/paint.ts`), and every skin writes the host svg's scale, opacity
and filter on every painted frame, since a skin swap keeps the same `<svg>`.

## The split

- **Host** — `frontend/src/components/NaruMark.tsx`. Owns the `<svg
  class="naru-mark" viewBox="0 0 64 64">`, its aria (`role=status` +
  `indicatorLabel`, or `aria-hidden` when decorative), the reduced-motion
  query (read live) and the **one rAF loop**. Each frame it works out the
  mode (`liveMark.ts::markMode`), the level (mic RMS when hearing, the
  playback analyser or `simEnvelope` when speaking, smoothed by
  `smoothLevel`) and the palette (`paletteFor(mode, brandIdle)`), and hands
  them to the skin's painter. Props, refs and the no-rerender property are
  unchanged: state and level reach the loop through refs.
- **Skin** — `frontend/src/components/markSkins/<id>.tsx`, registered in
  `markSkins/index.ts`. A `MarkSkin` (`frontend/src/markSkin.ts`):
  - `id`;
  - `markup()` — the static SVG content inside the host's svg;
  - `mount(svg, idlePalette)` — called once the markup is in the DOM;
    answers a painter whose `paint({mode, level, palette, reduced, t, dt})`
    the loop calls every frame and which writes attributes directly, never
    through React.

  The palette is the per-state one from `liveMark.ts`, theme-independent on
  purpose (`docs/style-guide.md` "Themes"); a built-in skin colours the mark
  from the palette alone, never from the site's CSS theme vars. A custom skin
  (below) is handed the theme's `--naru-*` vars as well, for chrome only —
  the state colours still come from the palette.

## Choosing a skin

The `appearance.mark-skin` config key (`docs/config.md` "Appearance"),
`GET`/`PUT /api/config/appearance` (`mark_skin`). `main.tsx`'s appearance
poll calls `markSkin.ts::setMarkSkin`; every mark reads that one value through
`useSyncExternalStore`, so a change re-renders each mark once and re-mounts
its painter. An unknown or absent id draws `waveform`, and the waveform draws
before the config answers.

Settings → Appearance → **Mark** (naru task 2121) is the picker: a radio
card per skin with a live preview — a `NaruMark` with its `skin` prop set,
cycling idle, hearing (a made-up mic level), speaking (the simulated
envelope), thinking and paused two seconds each on one shared clock. A pick
calls `setMarkSkin` at once and saves through `api.ts::updateMarkSkin`, which
sends `{mark_skin}` alone so the theme is left untouched; a refused save puts
the previous skin back and shows the error.

## Custom skins

Naru task 2122 lets a person add their own skins. A custom skin is **one
self-contained HTML document** — inline SVG, CSS and JS, at most 64 KiB,
nothing loaded from anywhere — stored server-side in the `mark_skins` table
(`Store::create_mark_skin`/`list_mark_skins`/`get_mark_skin`/
`delete_mark_skin`), so every browser of that Naru shows it. Its id is
`custom-<n>` (AUTOINCREMENT, never reissued after a delete); its name is
1–40 characters, unique case-insensitively, and may not be a built-in id or
`custom-<digits>`.

### Routes

| Route | Gate | Answer |
| --- | --- | --- |
| `GET /api/mark-skins` | `require_agent_access` | every skin, oldest first, no `body` (`MarkSkinSummary`) |
| `POST /api/mark-skins {name, body}` | `require_agent_access` | 201 + the `MarkSkinRecord`; a taken name 409 `conflict`, a bad name, an empty body or one over 64 KiB 422 `validation` |
| `GET /api/mark-skins/{id}` | `require_agent_access` | the record with its body (the picker's Export) |
| `DELETE /api/mark-skins/{id}` | `require_agent_access` | echoes the destroyed record; clears `appearance.mark-skin` if it named this skin |
| `GET /api/mark-skins/{id}/render` | plain guard only | the document for the iframe |

Moving a skin between machines is the web UI: Export on one Naru's picker
downloads `<name>.html`, Import skin… on the other uploads it.

### CLI

`naru mark` (naru task 2123) is the CLI over the same store and config, no
server needed. SKIN is a built-in id, `custom-<n>` or a name,
case-insensitive.

| Command | Does |
| --- | --- |
| `naru mark list` | a bare array: the three built-ins (`{id, name, builtin: true}`), then each custom skin (`builtin: false`, timestamps, no body) |
| `naru mark show <SKIN>` (`get`) | the `MarkSkinRecord` with its body; a built-in id is `validation` (it has no document) |
| `naru mark add <NAME> --file <PATH\|-> [--use]` (`install`) | `Store::create_mark_skin`; `--use` also makes it the mark's skin |
| `naru mark use <SKIN>` | writes `appearance.mark-skin`, prints the appearance setting like `theme use`; an unknown skin is `validation` |
| `naru mark preview <SKIN> \| --file <PATH\|-> [--title] [--say]` | pushes the skin to the live whiteboard as an `html` board (below); no live session is `not_found`, a bad body `validation`, and neither pushes a board |
| `naru mark remove <SKIN>` (`delete`) | `theme::delete_mark_skin`: echoes the record and clears `appearance.mark-skin` if it named this skin |

`--quiet` drops `body` on `show`, `add`, `preview` and `remove`, and the
active custom theme's `vars` on `use`.

**Preview.** A board has no host posting frames, so `preview` puts a driver
first in the document (`theme::mark_skin_preview_body`, after a leading
`<!doctype>` like the render route's bootstrap) that defines the same
`window.naruMark` and calls the skin itself every animation frame: idle,
hear, speak, think, paused and offer two seconds each, with the host's level
rules and `liveMark.ts::PALETTES` (a unit test pins the copy against that
file). It paints the stage the dark `--naru-bg` the mark really sits on, shows
a `preview · <mode>` chip at the top left, and listens for the board's own
`board-theme` relay to feed `onTheme`; it posts nothing to the page. An error
of the skin's own (the rule under the contract below), or no `onFrame` call
within 2 s, shows a `skin error · …` banner and stops the
skin for good, as the real mark's fallback does. The body is held to the same
64 KiB limit as an installed skin, so a previewed file installs as is.

**Designing one.** The built-in library skill `mark-skin-design` (`naru
library show mark-skin-design`) is the contract, the sample and the
write → preview → adjust → `add --use` loop for an agent; the live agent's
rule 18 sends it there when the person describes a look.

### How it runs

The render route serves the stored document as `text/html` under the
artifact route's `RENDER_CSP` (`sandbox allow-scripts`, `default-src
'none'`, so an opaque origin and no network) with `nosniff`, identically in
both serve modes, and puts **a bootstrap first** — right after a leading
`<!doctype …>`, else in front of everything — so it exists before the skin's
own scripts run. The page loads it in `<iframe sandbox="allow-scripts">`
(never `allow-same-origin`) inside the mark's box
(`NaruMark.tsx::CustomMark`); the frame's viewport *is* the mark, so draw to
`100vw`/`100vh` (an `<svg viewBox="0 0 64 64">` at full size is the easy
way). The bootstrap also sets `:root{color-scheme:light}` and
`html,body{margin:0;background:transparent;overflow:hidden}`; keep the
background transparent and leave `color-scheme` alone — the iframe element
is pinned to `light` too, and a frame whose scheme differs from its
element's is painted on an opaque white canvas.

The bootstrap gives the skin one object:

- `naruMark.onFrame(cb)` — `cb({naru:'mark-frame', mode, level, palette,
  reduced, t, dt})` every animation frame, exactly what a built-in painter is
  handed (`MarkInput` above: `mode` is `idle|hear|speak|think|paused|offer`,
  `level` 0..1, `palette` `{bars: [4 colours], glow}`, outer to centre). The **first** call is
  what tells the page the skin is ready.
- `naruMark.onTheme(cb)` — `cb(vars)` with the theme's `--naru-*` map (the
  html board vocabulary, `docs/live.md`) on ready and on every theme change;
  the bootstrap has already set each var on `<html>`, so CSS can just use
  `var(--naru-fg)`.

Only messages from the parent page count. An uncaught error, an unhandled
rejection or a handler throwing posts `mark-error` once and the skin is
called no more. Only the skin's **own** errors count (naru task 2166): an
error whose `filename` is the skin document, and a rejection with no stack
(a rejected string) or a stack naming it. An error a browser extension's
injected script throws inside the frame (a `chrome-extension://…` filename,
or a muted "Script error." with none) and a rejection whose stack names only
foreign scripts are ignored, so a wallet extension failing to connect never
knocks a working skin back to waveform. The preview driver applies the same
rule.

### Fallback

A custom skin that is broken draws **waveform** instead
(`markSkinCustom.ts::nextSkinState`, final once taken): no `onFrame` call
within 2 s (`MARK_SKIN_READY_MS` — which also catches a deleted or unknown
id, whose 404 page never announces itself), or a `mark-error` at any time.
The host span carries `data-skin-state="loading|ready|fallback"`; the picker
card adds "failed to load · showing waveform".

### Sample

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>svg { display: block; width: 100vw; height: 100vh; }</style>
</head>
<body>
<svg viewBox="0 0 64 64">
  <circle id="ring" cx="32" cy="32" r="27" fill="none" stroke-width="3" stroke-linecap="round"/>
  <circle id="core" cx="32" cy="32" r="16"/>
</svg>
<script>
  var ring = document.getElementById('ring')
  var core = document.getElementById('core')
  naruMark.onFrame(function (f) {
    var speed = f.reduced ? 0.5 : 1
    var r = 12 + 10 * f.level
    if (f.mode === 'idle' || f.mode === 'offer') r = 13 + 1.5 * Math.sin(f.t * 2 * speed)
    if (f.mode === 'think') r = 11
    core.setAttribute('r', r.toFixed(2))
    core.setAttribute('fill', f.palette.bars[3])
    core.style.opacity = f.mode === 'paused' ? 0.35 : 1
    ring.setAttribute('stroke', f.palette.glow)
    ring.setAttribute('stroke-dasharray', f.mode === 'think' ? '10 7' : f.mode === 'hear' ? '2 5' : 'none')
    ring.setAttribute('transform', 'rotate(' + ((f.t * 120 * speed) % 360).toFixed(1) + ' 32 32)')
    ring.style.opacity = f.mode === 'paused' ? 0.2 : 0.4 + 0.6 * f.level
  })
</script>
</body>
</html>
```
