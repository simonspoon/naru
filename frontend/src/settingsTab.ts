// Which tab of the Settings page a hash route is on (mesa task 1140). The page
// is seven tabs, an eighth (`gestures`, naru task 1972) only inside the Naru
// Mac app — six over one `~/.mesa/config.json`, plus the live notebook
// (mesa task 1147, a db table) — each on its own `#/settings/…`
// segment so a tab is bookmarkable and Back-stable, exactly as a project's
// tabs are (`lastView.ts`). Pure: no DOM, no React — the page reads the tab
// from here and the strip's hrefs come from here, so the two cannot disagree.

export type SettingsTab = 'hooks' | 'keyboard' | 'appearance' | 'voice' | 'memory' | 'pricing' | 'system' | 'gestures'

/** The strip's order. `hooks` is first and is also the bare `#/settings`
 *  route, so every existing link to the page still lands where it always did. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  'hooks',
  'keyboard',
  'appearance',
  'voice',
  'memory',
  'pricing',
  'system',
  'gestures',
]

const LABELS: Record<SettingsTab, string> = {
  hooks: 'Hooks',
  keyboard: 'Keyboard',
  appearance: 'Appearance',
  voice: 'Voice',
  memory: 'Memory',
  pricing: 'Pricing',
  system: 'System',
  gestures: 'Gestures',
}

/** The tabs a page may show: `gestures` belongs to the Mac app's camera, so a
 *  plain browser (no native host) never lists it (naru task 1972, like 1748). */
export function visibleSettingsTabs(native: boolean): readonly SettingsTab[] {
  return native ? SETTINGS_TABS : SETTINGS_TABS.filter((t) => t !== 'gestures')
}

export function settingsTabLabel(tab: SettingsTab): string {
  return LABELS[tab]
}

/** The route a tab lives on. `hooks` emits the bare `#/settings` rather than
 *  `#/settings/hooks`, so the first tab's link is the one the nav already has. */
export function settingsTabHref(tab: SettingsTab): string {
  return tab === 'hooks' ? '#/settings' : `#/settings/${tab}`
}

/** The tab a `/settings` path is on. Bare `/settings`, `/settings/hooks` and
 *  any segment this page does not know are all the first tab — an unknown
 *  segment is a stale link, not an error page. The segment is matched
 *  case-insensitively, since that is what a hand-typed hash produces. */
export function settingsTabFromPath(path: string, native = false): SettingsTab {
  const m = /^\/settings(?:\/([^/]+))?$/.exec(path)
  const seg = m?.[1]?.toLowerCase()
  return seg !== undefined && (visibleSettingsTabs(native) as readonly string[]).includes(seg)
    ? (seg as SettingsTab)
    : 'hooks'
}
