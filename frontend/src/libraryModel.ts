import { splitFrontmatter } from './frontmatter'

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'none' | 'other'

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const

/** The `model:` value from an agent body's YAML frontmatter, unquoted, or null
 *  when there is no frontmatter, no such key, or an empty value. */
export function agentModel(body: string): string | null {
  const { frontmatter } = splitFrontmatter(body)
  if (frontmatter === null) return null
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = /^model\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[1].trim()
    // A trailing comment, then matching quotes.
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '')
    v = v.replace(/^(["'])(.*)\1\s*(?:#.*)?$/, '$2').trim()
    return v === '' ? null : v
  }
  return null
}

/** The pill's text and colour family. A full id maps to the family whose name
 *  it contains; anything else is `other` and keeps its raw value. */
export function modelPill(body: string): { label: string; family: ModelFamily } {
  const model = agentModel(body)
  if (model === null) return { label: 'none', family: 'none' }
  const lower = model.toLowerCase()
  const family = FAMILIES.find((f) => lower.includes(f))
  return family ? { label: model, family } : { label: model, family: 'other' }
}
