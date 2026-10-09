// The ambient "can help" offer (naru task 1700): the server holds the newest
// overheard offer and `GET /api/live` carries it as `offer` while no session
// is live. This is the page's one decision about it, kept out of the .tsx.

import type { LiveOffer } from './types/LiveOffer'

/** The orb glows iff an offer is waiting and no conversation is live, or the
 *  host holds the live session in ambient mode (naru task 1746). */
export function offerGlows(
  offer: LiveOffer | null | undefined,
  live: boolean,
  ambient = false,
): boolean {
  return offer != null && (!live || ambient)
}

/** The first `max` characters of the overheard text, one line, ellipsised. */
export function offerPreview(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat
}

/** The glowing orb's accessible name and tooltip. */
export function offerTitle(offer: LiveOffer): string {
  const heard = offerPreview(offer.text)
  return heard === ''
    ? 'Naru can help — start a conversation'
    : `Naru can help — start a conversation. Overheard: “${heard}”`
}
