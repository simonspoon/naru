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
  purpose (`docs/style-guide.md` "Themes"); a skin must not read the site's
  CSS theme vars to colour the mark.

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
