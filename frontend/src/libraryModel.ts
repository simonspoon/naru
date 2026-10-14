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

/** The dropdown's choices for an agent body (naru task 1911): the four
 *  families, then the current value when it is some other string (so the
 *  select can show it). The empty string is the "inherit" choice, which the
 *  caller sends as a null model to remove the line. */
export function modelChoices(body: string): string[] {
  const current = agentModel(body)
  const list: string[] = [...FAMILIES]
  if (current !== null && !list.includes(current)) list.push(current)
  return list
}

/** The select's value for a body: the current model, or '' for inherit. */
export function modelSelectValue(body: string): string {
  return agentModel(body) ?? ''
}

/** The `model` a select value is sent as: '' (inherit) becomes null. */
export function modelFromSelect(value: string): string | null {
  return value === '' ? null : value
}
