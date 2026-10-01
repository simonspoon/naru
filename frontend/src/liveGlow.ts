import type { LiveIndicator } from './liveIndicator'
import { PALETTES } from './liveMark'

/**
 * The mood light (mesa task 1557): a faint glow around the whole window
 * tinted by the same ranked state the header mark wears (`liveIndicator.ts`),
 * in the same palette (`liveMark.ts`) — speaking amber, hearing cyan, working
 * and resting violet. Listening is the resting state and paused is a held
 * breath, so both — like no conversation at all — are no glow: the light says
 * something is happening, and a permanent tint would say nothing.
 */
export function glowColor(state: LiveIndicator | null): string | null {
  if (state === 'speaking') return PALETTES.speak.glow
  if (state === 'hearing') return PALETTES.hear.glow
  if (state === 'working' || state === 'resting') return PALETTES.think.glow
  return null
}
