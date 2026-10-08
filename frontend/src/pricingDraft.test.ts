import { describe, expect, it } from 'vitest'
import {
  addTier,
  addedPricing,
  blankRates,
  changedPricing,
  removeTier,
  draftFrom,
  editTier,
  effectiveRates,
  isBlank,
  isDirty,
  isNewRowStarted,
  isRowChanged,
  isSavable,
  newRowErrors,
  prefixError,
  rateError,
  tierErrors,
  resolveRates,
  rowErrors,
  type NewRow,
  type PricingDraft,
} from './pricingDraft'
import type { ConfigPrice } from './types/ConfigPrice'
import type { ModelRates } from './types/ModelRates'

const rates = (
  input: number,
  output: number,
  cache_read: number,
  cache_write: number,
): ModelRates => ({ input, output, cache_read, cache_write })

const OPUS: ConfigPrice = {
  prefix: 'claude-opus',
  value: null,
  default: rates(5, 25, 0.5, 6.25),
}
const ADDED: ConfigPrice = {
  prefix: 'newco',
  value: rates(1, 2, 3, 4),
  default: null,
}

function text(r: ModelRates) {
  return {
    input: String(r.input),
    output: String(r.output),
    cache_read: String(r.cache_read),
    cache_write: String(r.cache_write),
  }
}

describe('draftFrom', () => {
  it('renders an unconfigured row blank and a configured one as text', () => {
    const draft = draftFrom([OPUS, ADDED])
    expect(draft['claude-opus']).toEqual(blankRates())
    expect(draft['newco'].output).toBe('2')
  })

  it('reports a freshly loaded table as pristine', () => {
    const prices = [OPUS, ADDED]
    expect(isDirty(prices, draftFrom(prices))).toBe(false)
  })
})

describe('rateError', () => {
  it('accepts a finite number ≥ 0 and nothing else', () => {
    expect(rateError('0')).toBeNull()
    expect(rateError(' 6.25 ')).toBeNull()
    expect(rateError('')).toBe('required')
    expect(rateError('abc')).toBe('not a number')
    expect(rateError('-1')).toBe('must be ≥ 0')
    expect(rateError('Infinity')).toBe('not a number')
  })
})

describe('prefixError', () => {
  it('mirrors the server: non-empty, no whitespace, ≤ 64 chars', () => {
    expect(prefixError('claude-opus')).toBeNull()
    expect(prefixError('  ')).toBe('a model prefix is required')
    expect(prefixError('claude opus')).toBe('a model id has no whitespace')
    expect(prefixError('x'.repeat(64))).toBeNull()
    expect(prefixError('x'.repeat(65))).toBe('longer than 64 characters')
  })
})

describe('effectiveRates', () => {
  it('prefers the drafted override, falling back to the built-in', () => {
    const draft: PricingDraft = { 'claude-opus': blankRates() }
    expect(effectiveRates(OPUS, draft)).toEqual(OPUS.default)
    draft['claude-opus'] = text(rates(9, 9, 9, 9))
    expect(effectiveRates(OPUS, draft)).toEqual(rates(9, 9, 9, 9))
    // A part-filled row takes the built-in rate for the boxes left blank,
    // which is what their placeholders showed (mesa task 1020).
    draft['claude-opus'] = { ...blankRates(), input: '9' }
    expect(effectiveRates(OPUS, draft)).toEqual(rates(9, 25, 0.5, 6.25))
    // A garbage number still shows the default rather than NaN.
    draft['claude-opus'] = { ...blankRates(), input: 'abc' }
    expect(effectiveRates(OPUS, draft)).toEqual(OPUS.default)
  })

  it('is null for a user-added prefix cleared to blank', () => {
    expect(effectiveRates(ADDED, { newco: blankRates() })).toBeNull()
  })
})

describe('changedPricing', () => {
  it('sends only the rows that moved', () => {
    const prices = [OPUS, ADDED]
    const draft = draftFrom(prices)
    draft['claude-opus'] = text(rates(1, 1, 1, 1))
    expect(isRowChanged(OPUS, draft)).toBe(true)
    expect(isRowChanged(ADDED, draft)).toBe(false)
    expect(changedPricing(prices, draft)).toEqual({
      'claude-opus': rates(1, 1, 1, 1),
    })
  })

  it('sends null for a row cleared back to blank', () => {
    const prices = [OPUS, ADDED]
    const draft = draftFrom(prices)
    draft['newco'] = blankRates()
    expect(changedPricing(prices, draft)).toEqual({ newco: null })
    expect(isDirty(prices, draft)).toBe(true)
  })

  it('treats a re-typed identical value as no change', () => {
    const prices = [ADDED]
    const draft = { newco: text(rates(1, 2, 3, 4)) }
    expect(changedPricing(prices, draft)).toEqual({})
    // Trailing-zero spellings are the same number, not an edit.
    expect(changedPricing(prices, { newco: text(rates(1, 2, 3, 4)) })).toEqual({})
    expect(
      changedPricing(prices, {
        newco: { input: '1.0', output: '2', cache_read: '3', cache_write: '4' },
      }),
    ).toEqual({})
  })
})

describe('isSavable', () => {
  it('is false while a row holds a bad number', () => {
    const draft: PricingDraft = {
      'claude-opus': { ...blankRates(), input: '-3' },
    }
    expect(isSavable([OPUS], draft)).toBe(false)
    expect(isSavable([OPUS], draftFrom([OPUS]))).toBe(true)
  })

  it('is true for a part-filled row over a built-in rate (mesa task 1020)', () => {
    const draft: PricingDraft = {
      'claude-opus': { ...blankRates(), input: '9' },
    }
    expect(rowErrors(OPUS.prefix, draft['claude-opus'], OPUS.default)).toEqual(
      [],
    )
    expect(isSavable([OPUS], draft)).toBe(true)
    expect(isDirty([OPUS], draft)).toBe(true)
  })

  it('still demands every box on a prefix with no built-in rate', () => {
    const draft: PricingDraft = { newco: { ...blankRates(), input: '9' } }
    expect(rowErrors(ADDED.prefix, draft['newco'], ADDED.default)).toEqual([
      'output: required',
      'cache_read: required',
      'cache_write: required',
    ])
    expect(isSavable([ADDED], draft)).toBe(false)
  })
})

describe('resolveRates', () => {
  it('fills each blank box from the built-in rate the placeholder showed', () => {
    const draft: PricingDraft = {
      'claude-opus': { ...blankRates(), input: '9' },
    }
    expect(changedPricing([OPUS], draft)).toEqual({
      'claude-opus': rates(9, 25, 0.5, 6.25),
    })
    expect(effectiveRates(OPUS, draft)).toEqual(rates(9, 25, 0.5, 6.25))
    expect(resolveRates(draft['claude-opus'], OPUS.default)).toEqual(
      rates(9, 25, 0.5, 6.25),
    )
  })

  it('leaves a wholly blank row meaning reset, not the default written out', () => {
    const prices = [OPUS, ADDED]
    const draft = draftFrom(prices)
    draft['newco'] = blankRates()
    expect(changedPricing(prices, draft)).toEqual({ newco: null })
    // The built-in row is untouched: blank is its loaded state.
    expect(isRowChanged(OPUS, draft)).toBe(false)
  })

  it('rejects a negative box even where the rest fall back', () => {
    const draft: PricingDraft = {
      'claude-opus': { ...blankRates(), input: '-1' },
    }
    expect(rowErrors(OPUS.prefix, draft['claude-opus'], OPUS.default)).toEqual([
      'input: must be ≥ 0',
    ])
    expect(isSavable([OPUS], draft)).toBe(false)
  })

  it('treats the default typed back into one box as an explicit override', () => {
    const draft: PricingDraft = {
      'claude-opus': { ...blankRates(), input: '5' },
    }
    expect(changedPricing([OPUS], draft)).toEqual({
      'claude-opus': rates(5, 25, 0.5, 6.25),
    })
  })
})

describe('new rows', () => {
  const complete: NewRow = { prefix: 'newco-x', rates: text(rates(2, 4, 0, 0)) }

  it('ignores an untouched row entirely', () => {
    const empty: NewRow = { prefix: '', rates: blankRates() }
    expect(isNewRowStarted(empty)).toBe(false)
    expect(newRowErrors([empty])).toEqual([])
    expect(addedPricing([empty])).toEqual({})
  })

  it('sends a complete row keyed by its trimmed prefix', () => {
    expect(addedPricing([{ ...complete, prefix: '  newco-x  ' }])).toEqual({
      'newco-x': rates(2, 4, 0, 0),
    })
    expect(newRowErrors([complete])).toEqual([])
  })

  it('demands every rate once the row is started, and never sends a bad one', () => {
    const noRates: NewRow = { prefix: 'newco-x', rates: blankRates() }
    expect(newRowErrors([noRates])).toContain(
      'every rate is required on a new prefix',
    )
    expect(addedPricing([noRates])).toEqual({})
    const noPrefix: NewRow = { prefix: '', rates: text(rates(1, 1, 1, 1)) }
    expect(newRowErrors([noPrefix])).toContain('a model prefix is required')
    expect(addedPricing([noPrefix])).toEqual({})
  })
})

describe('context tiers', () => {
  const tier = (above_tokens: number, x: number) => ({
    above_tokens,
    input: x,
    output: x,
    cache_read: x,
    cache_write: x,
  })
  const text = (above_tokens: string, x: string) => ({
    above_tokens,
    input: x,
    output: x,
    cache_read: x,
    cache_write: x,
  })
  const HAIKU: ConfigPrice = {
    prefix: 'claude-haiku-5-5',
    value: null,
    default: { ...rates(0.1, 0.5, 0.01, 0.125), tiers: [tier(100000, 0.5)] },
  }
  const TWO: ConfigPrice = {
    prefix: 'two',
    value: { ...rates(1, 2, 3, 4), tiers: [tier(100, 5), tier(500, 6)] },
    default: null,
  }

  it('keeps the built-in tiers when only the base rates change', () => {
    const draft: PricingDraft = {
      [HAIKU.prefix]: { ...blankRates(), input: '0.2' },
    }
    const sent = changedPricing([HAIKU], draft)[HAIKU.prefix]
    expect(sent?.input).toBe(0.2)
    expect(sent?.tiers).toEqual([tier(100000, 0.5)])
  })

  it('loads two configured tiers as text and reports them pristine', () => {
    const draft = draftFrom([TWO])
    expect(draft.two.tiers).toHaveLength(2)
    expect(draft.two.tiers?.[1].above_tokens).toBe('500')
    expect(isDirty([TWO], draft)).toBe(false)
    expect(changedPricing([TWO], draft)).toEqual({})
  })

  it('adds a second tier after the built-in one and sends both ascending', () => {
    let row = addTier(blankRates(), HAIKU.default)
    expect(row.tiers).toHaveLength(2)
    row = editTier(row, 1, 'above_tokens', '50000', HAIKU.default)
    for (const f of ['input', 'output', 'cache_read', 'cache_write'] as const) {
      row = editTier(row, 1, f, '0.3', HAIKU.default)
    }
    const sent = changedPricing([HAIKU], { [HAIKU.prefix]: row })
    expect(sent[HAIKU.prefix]?.tiers).toEqual([
      tier(50000, 0.3),
      tier(100000, 0.5),
    ])
  })

  it('removes one tier and keeps the other', () => {
    const row = removeTier(draftFrom([TWO]).two, 0)
    const sent = changedPricing([TWO], { two: row })
    expect(sent.two?.tiers).toEqual([tier(500, 6)])
  })

  it('removing the last tier sends the row flat', () => {
    const row = removeTier(blankRates(), 0, HAIKU.default)
    const sent = changedPricing([HAIKU], { [HAIKU.prefix]: row })
    expect(sent[HAIKU.prefix]).toEqual(rates(0.1, 0.5, 0.01, 0.125))
  })

  it('names a duplicate threshold and blocks the save', () => {
    const row = {
      ...text0(),
      tiers: [text('100', '1'), text('100', '2')],
    }
    const errors = rowErrors('newco', row)
    expect(errors.some((e) => e.includes('already used'))).toBe(true)
    expect(isSavable([ADDED], { newco: row })).toBe(false)
  })

  it('rejects a missing, fractional or zero threshold and a bad tier rate', () => {
    expect(tierErrors([text('', '1')])).not.toEqual([])
    expect(tierErrors([text('0', '1')])).not.toEqual([])
    expect(tierErrors([text('1.5', '1')])).not.toEqual([])
    expect(tierErrors([text('5', '-1')])).not.toEqual([])
    expect(tierErrors([text('5', '1')])).toEqual([])
  })

  it('treats a lone tier add on an unconfigured row as non-blank', () => {
    expect(isBlank(addTier(blankRates()))).toBe(false)
  })

  function text0() {
    return { input: '1', output: '2', cache_read: '3', cache_write: '4' }
  }
})
