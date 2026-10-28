// The Ambient view's lines (naru task 2375): naru-audio's `GET /ambient/log`
// events, relayed by `GET /api/live/ambient/log`, as what the page draws.
// Pure, so vitest reaches it; the view only renders.

/** One drawn line: a transcribed chunk (`heard`), or one of the ambient
 * machine's markers — a wake word, or the gate flagging an idea or offering
 * help. */
export interface AmbientLine {
  key: string
  kind: 'heard' | 'wake' | 'idea' | 'can_help'
  speaker: string
  text: string
}

type Speaker = { is_him?: unknown; person?: unknown; reason?: unknown } | undefined

/** Who said a line, as naru-audio's ambient machine decides it: a matched
 * person by name, else the enrolled owner, else a scored stranger, else
 * nobody could tell (no enrollment, too short, no model). */
export function speakerLabel(speaker: Speaker): string {
  if (typeof speaker?.person === 'string' && speaker.person.trim()) return speaker.person
  if (speaker?.reason === 'scored') return speaker.is_him === true ? 'You' : 'Someone else'
  return 'Unknown'
}

/** The events as lines, oldest first (the order naru-audio keeps them in, so
 * the newest is at the bottom). Anything that is not a line with text — or
 * not an object at all — is skipped rather than drawn empty. */
export function ambientLines(body: unknown): AmbientLine[] {
  const events = (body as { events?: unknown } | null)?.events
  if (!Array.isArray(events)) return []
  const lines: AmbientLine[] = []
  // Keys from the event itself, never its index: the ring drops lines off the
  // front every poll, and an index key would remount the whole list each time.
  const seen = new Map<string, number>()
  events.forEach((e: unknown) => {
    if (typeof e !== 'object' || e === null) return
    const ev = e as Record<string, unknown>
    const text = typeof ev.text === 'string' ? ev.text.trim() : ''
    if (!text) return
    const base = `${String(ev.type)}-${String(ev.id ?? ev.at_ms ?? '')}-${text}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const key = n === 0 ? base : `${base}#${n}`
    switch (ev.type) {
      case 'ambient_flag':
      case 'utterance':
        lines.push({ key, kind: 'heard', speaker: speakerLabel(ev.speaker as Speaker), text })
        break
      case 'wake':
        lines.push({ key, kind: 'wake', speaker: 'Wake word', text })
        break
      case 'ambient_verdict':
        lines.push({
          key,
          kind: ev.kind === 'idea' ? 'idea' : 'can_help',
          speaker: ev.kind === 'idea' ? 'Idea flagged' : 'Naru can help',
          text,
        })
        break
    }
  })
  return lines
}
