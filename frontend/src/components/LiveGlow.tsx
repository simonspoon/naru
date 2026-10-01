import { useState } from 'react'
import type { LiveIndicator } from '../liveIndicator'
import { glowColor } from '../liveGlow'

/** The mood light (mesa task 1557): one fixed, click-through overlay, always
 *  mounted so its opacity can fade out instead of vanishing. It remembers the
 *  last colour so a fade-out keeps the tint it is leaving. */
export function LiveGlow({ state }: { state: LiveIndicator | null }) {
  const color = glowColor(state)
  const [last, setLast] = useState('#b06bff')
  if (color && color !== last) setLast(color)
  return (
    <div
      className={`live-glow${color ? ' live-glow-on' : ''}`}
      style={{ ['--glow' as string]: last }}
      aria-hidden="true"
    />
  )
}
