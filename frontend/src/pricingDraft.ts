import type { ConfigPrice } from './types/ConfigPrice'
import type { ContextTier } from './types/ContextTier'
import type { ModelRates } from './types/ModelRates'

/**
 * Pure draft logic for the Settings page's model-pricing editor, hoisted out
 * of the component so it is unit-testable (see CLAUDE.md: the frontend tests
 * cover the pure modules, never a rendered tree).
 *
 * Two things it models, both of which the server also draws:
 *
 * - **Blank means "use the built-in rate"**, exactly as a blank command box
 *   means "use the built-in template". A row whose four boxes are all blank is
 *   PUT as `null`, which restores the shipped rate for a family mesa knows and
 *   deletes the row for a prefix the user added.
 * - **A rate is edited as text, not as a number.** Half-typed input (`"0."`,
 *   `"-"`, `""`) has to survive a keystroke, so the draft holds strings and
 *   only `changedPricing` converts — parsing per render would clobber typing.
 */

/** The four rate fields, in the order the editor lays them out. */
export const RATE_FIELDS = [
  'input',
  'output',
  'cache_read',
  'cache_write',
] as const

export type RateField = (typeof RATE_FIELDS)[number]

/** A context tier's boxes: a token threshold plus the four rates. */
export const TIER_FIELDS = ['above_tokens', ...RATE_FIELDS] as const

export type TierField = (typeof TIER_FIELDS)[number]

export type TierDraft = Record<TierField, string>

/**
 * One row's four boxes as typed, plus its optional context-size tiers
 * (`tiers`, the rates a request pays once its prompt is over a threshold).
 * `tiers` has two states, and the difference matters: `undefined` = not
 * touched (inherits the built-in's tiers, if any); an array = the tiers as
 * typed, possibly empty (explicitly flat). Tiers the user never touched are
 * therefore carried through a save rather than dropped.
 */
export type RateDraft = Record<RateField, string> & {
  tiers?: TierDraft[]
}

/** Per-prefix draft state, keyed exactly as the server keys the config. */
export type PricingDraft = Record<string, RateDraft>

const BLANK: RateDraft = {
  input: '',
  output: '',
  cache_read: '',
  cache_write: '',
}

/** A blank row — what "add model prefix" appends and what a reset restores. */
export function blankRates(): RateDraft {
  return { ...BLANK }
}

function tierText(t: ContextTier): TierDraft {
  return {
    above_tokens: String(t.above_tokens),
    input: String(t.input),
    output: String(t.output),
    cache_read: String(t.cache_read),
    cache_write: String(t.cache_write),
  }
}

function textFor(value: ModelRates | null): RateDraft {
  if (!value) return blankRates()
  return {
    tiers: (value.tiers ?? []).map(tierText),
    input: String(value.input),
    output: String(value.output),
    cache_read: String(value.cache_read),
    cache_write: String(value.cache_write),
  }
}

/** The editable text for each row as loaded: an unconfigured row is blank. */
export function draftFrom(prices: ConfigPrice[]): PricingDraft {
  const draft: PricingDraft = {}
  for (const p of prices) draft[p.prefix] = textFor(p.value)
  return draft
}

/** True when every box in a row is blank — the "no override" state. */
export function isBlank(row: RateDraft): boolean {
  return (
    RATE_FIELDS.every((f) => (row[f] ?? '').trim() === '') &&
    (row.tiers === undefined || row.tiers.length === 0)
  )
}

/** The tiers a row shows: the drafted ones, else the built-in's, else none. */
export function shownTiers(
  row: RateDraft,
  defaults?: ModelRates | null,
): TierDraft[] {
  if (row.tiers !== undefined) return row.tiers
  return (defaults?.tiers ?? []).map(tierText)
}

const BLANK_TIER: TierDraft = {
  above_tokens: '',
  input: '',
  output: '',
  cache_read: '',
  cache_write: '',
}

/** Appends a blank tier (after the built-in's, which a first edit adopts). */
export function addTier(row: RateDraft, defaults?: ModelRates | null): RateDraft {
  return { ...row, tiers: [...shownTiers(row, defaults), { ...BLANK_TIER }] }
}

/** Removes the tier at `index`; removing the last one leaves the row flat. */
export function removeTier(
  row: RateDraft,
  index: number,
  defaults?: ModelRates | null,
): RateDraft {
  return {
    ...row,
    tiers: shownTiers(row, defaults).filter((_, i) => i !== index),
  }
}

/** Edits one box of the tier at `index`, first adopting the built-in tiers. */
export function editTier(
  row: RateDraft,
  index: number,
  field: TierField,
  value: string,
  defaults?: ModelRates | null,
): RateDraft {
  return {
    ...row,
    tiers: shownTiers(row, defaults).map((t, i) =>
      i === index ? { ...t, [field]: value } : t,
    ),
  }
}

/**
 * The complaints about a row's drafted tiers: every box is required, a
 * threshold is a whole number ≥ 1, and no two tiers share a threshold (the
 * server rejects a duplicate, naming it).
 */
export function tierErrors(tiers: TierDraft[] | undefined): string[] {
  if (!tiers) return []
  const errors: string[] = []
  const seen = new Set<number>()
  tiers.forEach((tier, i) => {
    const n = i + 1
    const t = (tier.above_tokens ?? '').trim()
    const v = Number(t)
    if (t === '') errors.push(`tier ${n} above_tokens: required`)
    else if (!Number.isInteger(v) || v < 1) {
      errors.push(`tier ${n} above_tokens: must be a whole number ≥ 1`)
    } else if (seen.has(v)) {
      errors.push(`tier ${n} above_tokens: ${v} is already used by another tier`)
    } else seen.add(v)
    for (const f of RATE_FIELDS) {
      const e = rateError(tier[f] ?? '')
      if (e) errors.push(`tier ${n} ${f}: ${e}`)
    }
  })
  return errors
}

/**
 * The complaint about one rate box, or `null` if it is fine. Blank is only an
 * error when the *rest* of the row isn't — a wholly blank row is the reset,
 * not four mistakes — and, on a row mesa ships a rate for, not even then: the
 * box shows that rate as its placeholder, so a blank box means "keep it".
 */
export function rateError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return 'required'
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return 'not a number'
  if (n < 0) return 'must be ≥ 0'
  return null
}

/** Mirrors `config::validate_prefix`, so the mistake is named as it is typed. */
export function prefixError(text: string): string | null {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return 'a model prefix is required'
  if (/\s/.test(trimmed)) return 'a model id has no whitespace'
  if ([...trimmed].length > 64) return 'longer than 64 characters'
  return null
}

/**
 * Every error in one drafted row — the prefix's, plus each rate's unless the
 * row is entirely blank (which is the legitimate "remove this override").
 *
 * `defaults` is the built-in rate the row's boxes show as placeholders, and it
 * is what a *blank* box in a part-filled row means: the server needs all four
 * numbers, so mesa fills the untouched ones from the rate the user was looking
 * at rather than calling the row unsavable (mesa task 1020). A prefix the user
 * added has no default, so there a blank box is still `required`.
 */
export function rowErrors(
  prefix: string,
  row: RateDraft,
  defaults?: ModelRates | null,
): string[] {
  const errors: string[] = []
  const bad = prefixError(prefix)
  if (bad) errors.push(bad)
  if (!isBlank(row)) {
    for (const f of RATE_FIELDS) {
      if (defaults && (row[f] ?? '').trim() === '') continue
      const e = rateError(row[f] ?? '')
      if (e) errors.push(`${f}: ${e}`)
    }
  }
  errors.push(...tierErrors(row.tiers))
  return errors
}

/**
 * The four numbers a part-filled row resolves to: each box as typed, each
 * blank one from the built-in rate. Only meaningful once [`rowErrors`] is
 * empty, which is what guarantees a blank box has a default to fall back on.
 */
export function resolveRates(
  row: RateDraft,
  defaults?: ModelRates | null,
): ModelRates {
  const at = (f: RateField): number => {
    const text = (row[f] ?? '').trim()
    if (text === '' && defaults) return defaults[f]
    return Number(text)
  }
  const out: ModelRates = {
    input: at('input'),
    output: at('output'),
    cache_read: at('cache_read'),
    cache_write: at('cache_write'),
  }
  const tiers: ContextTier[] =
    row.tiers === undefined
      ? (defaults?.tiers ?? [])
      : row.tiers.map((t) => ({
          above_tokens: Number(t.above_tokens.trim()),
          input: Number(t.input.trim()),
          output: Number(t.output.trim()),
          cache_read: Number(t.cache_read.trim()),
          cache_write: Number(t.cache_write.trim()),
        }))
  // Ascending, the order the server stores; an empty list is left off.
  if (tiers.length > 0) {
    out.tiers = [...tiers].sort((a, b) => a.above_tokens - b.above_tokens)
  }
  return out
}

/** What a row's cost will actually be computed from: the draft, else the default. */
export function effectiveRates(
  price: ConfigPrice,
  draft: PricingDraft,
): ModelRates | null {
  const row = draft[price.prefix]
  if (!row || isBlank(row)) return price.default
  if (rowErrors(price.prefix, row, price.default).length > 0) {
    return price.default
  }
  return resolveRates(row, price.default)
}

function sameRates(a: ModelRates | null, b: ModelRates | null): boolean {
  if (!a || !b) return a === b
  if (!RATE_FIELDS.every((f) => a[f] === b[f])) return false
  const x = [...(a.tiers ?? [])].sort((p, q) => p.above_tokens - q.above_tokens)
  const y = [...(b.tiers ?? [])].sort((p, q) => p.above_tokens - q.above_tokens)
  return (
    x.length === y.length &&
    x.every(
      (t, i) =>
        t.above_tokens === y[i].above_tokens &&
        RATE_FIELDS.every((f) => t[f] === y[i][f]),
    )
  )
}

/** True when this row's boxes differ from what the server last reported. */
export function isRowChanged(price: ConfigPrice, draft: PricingDraft): boolean {
  const row = draft[price.prefix]
  if (!row) return false
  if (isBlank(row)) return price.value !== null
  if (rowErrors(price.prefix, row, price.default).length > 0) return true
  return !sameRates(resolveRates(row, price.default), price.value)
}

/**
 * The subset to PUT: only rows whose values actually changed. A row cleared to
 * blank sends `null` (the server's "remove this key"), which is the reset for
 * a built-in family and the delete for a user-added prefix.
 *
 * Rows the user never touched are left out, so the API's "only the keys
 * present are touched" rule keeps two editors from clobbering each other.
 */
export function changedPricing(
  prices: ConfigPrice[],
  draft: PricingDraft,
): Record<string, ModelRates | null> {
  const changed: Record<string, ModelRates | null> = {}
  for (const p of prices) {
    if (!isRowChanged(p, draft)) continue
    const row = draft[p.prefix]
    changed[p.prefix] = isBlank(row) ? null : resolveRates(row, p.default)
  }
  return changed
}

/** True when anything is pending, i.e. the Save button does something. */
export function isDirty(prices: ConfigPrice[], draft: PricingDraft): boolean {
  return prices.some((p) => isRowChanged(p, draft))
}

/** True when nothing drafted would be rejected by the server. */
export function isSavable(prices: ConfigPrice[], draft: PricingDraft): boolean {
  return prices.every((p) => {
    const row = draft[p.prefix] ?? blankRates()
    return rowErrors(p.prefix, row, p.default).length === 0
  })
}

/**
 * A row the user is adding, whose prefix is still being typed. Held apart from
 * [`PricingDraft`] on purpose: the draft is keyed by prefix, and a key that
 * changes on every keystroke would need renaming mid-edit. Once saved, the
 * server echoes it back as an ordinary row and this one is dropped.
 */
export type NewRow = { prefix: string; rates: RateDraft }

/** An empty new row — what "add model prefix" appends. */
export function newRow(): NewRow {
  return { prefix: '', rates: blankRates() }
}

/** True for a new row the user has started filling in (so it must be saved). */
export function isNewRowStarted(row: NewRow): boolean {
  return row.prefix.trim() !== '' || !isBlank(row.rates)
}

/** Every complaint across the new rows, so the save button can stay disabled. */
export function newRowErrors(rows: NewRow[]): string[] {
  return rows
    .filter(isNewRowStarted)
    .flatMap((r) =>
      rowErrors(r.prefix, r.rates).concat(
        isBlank(r.rates) ? ['every rate is required on a new prefix'] : [],
      ),
    )
}

/** The new rows as PUT payload entries, keyed by their trimmed prefix. */
export function addedPricing(rows: NewRow[]): Record<string, ModelRates | null> {
  const added: Record<string, ModelRates | null> = {}
  for (const r of rows) {
    if (!isNewRowStarted(r) || newRowErrors([r]).length > 0) continue
    added[r.prefix.trim()] = resolveRates(r.rates)
  }
  return added
}
