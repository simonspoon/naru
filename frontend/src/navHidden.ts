// Whether the left nav is hidden on the desktop tiers (naru task 2805). The
// nav is either fully shown or completely gone there — the palette (Mod+K) and
// the header's project switcher are how you move around. A per-browser
// preference like `mainCollapse.ts`; the phone tier's drawer never reads it.
//
// Hidden is the default: an absent key hides, and only the literal "shown"
// shows, so a hand-edited or stale value can never leave a person with a
// nav they did not ask for.

const KEY = 'naru-nav-shown'

export function loadNavHidden(): boolean {
  return localStorage.getItem(KEY) !== 'shown'
}

export function saveNavHidden(hidden: boolean): void {
  if (hidden) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, 'shown')
}
