// Whether the live transcript should follow the conversation. Pure: the panel
// reads its scroller's geometry and hands the numbers in.

/** How close to the bottom (px) still counts as "at the bottom". */
export const NEAR_BOTTOM_PX = 48

/** True when the reader is at, or within `threshold` px of, the end. */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = NEAR_BOTTOM_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

/** Turns that arrived since the reader scrolled away (`awayAt` = the turn
 *  count at that moment); 0 when they never left or the list shrank. */
export function newSince(turnCount: number, awayAt: number | null): number {
  return awayAt === null ? 0 : Math.max(0, turnCount - awayAt)
}

/** True when `turns` holds one of the person's own turns newer than `seenId`
 *  (the highest turn id the transcript had already shown). Their own message —
 *  typed or spoken — always brings the transcript back to the bottom, even if
 *  they had scrolled up (naru task 2312). */
export function ownTurnSince(
  turns: readonly { id: number; role: string }[],
  seenId: number,
): boolean {
  return turns.some((t) => t.role === 'user' && t.id > seenId)
}
