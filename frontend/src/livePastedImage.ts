/**
 * A picture the person **pastes** into the live capture box (mesa task 1475)
 * — the composer's sibling to `liveInk.ts`'s whiteboard ink: staged in this
 * browser as one PNG until the turn it rides on is sent, with no board of
 * its own.
 */

/** One staged pasted image: the PNG already base64-encoded, ready to post,
 *  and a data URL for the composer's thumbnail (so the chip needs no extra
 *  decode of what was just encoded). */
export interface StagedImage {
  png_base64: string
  previewUrl: string
}

/**
 * Which picture a turn about to post should carry, when both a pasted image
 * and new whiteboard ink are pending at once. The image wins and the ink
 * stays pending for a later turn, since the server accepts at most one
 * picture per turn (`validation` on both) — the person just pasted this one,
 * so it is what the turn they are about to send is about.
 */
export function mediaForTurn(
  hasPastedImage: boolean,
  hasPendingInk: boolean,
): 'image' | 'ink' | 'none' {
  if (hasPastedImage) return 'image'
  if (hasPendingInk) return 'ink'
  return 'none'
}
