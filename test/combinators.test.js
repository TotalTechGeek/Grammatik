import { describe, it, expect } from 'vitest'
import { createParser } from '../src/index.js'

const tokens = [
  { name: 'WS', pattern: '\\s+', skip: true },
  { name: 'Int', pattern: '\\d+' },
  { name: 'Word', pattern: '[a-z]+' },
  { name: 'Comma', literal: ',' },
  { name: 'Semi', literal: ';' },
  { name: 'Star', literal: '*' }
]

/** Builds a single-rule parser around `logic`. */
const parserFor = (logic, options) =>
  createParser({ tokens, rules: { main: logic }, start: 'main' }, options)

const images = (result) => (Array.isArray(result) ? result.map((t) => t.image) : result.image)

describe('consume', () => {
  it('matches and advances', () => {
    expect(parserFor({ consume: 'Int' }).parse('42').image).toBe('42')
  })

  it('fails on the wrong token type', () => {
    expect(() => parserFor({ consume: 'Int' }).parse('abc')).toThrow(/Expecting Int/)
  })

  it('accepts the array spelling', () => {
    expect(parserFor({ consume: ['Int'] }).parse('7').image).toBe('7')
  })
})

describe('seq', () => {
  it('returns the results of its children in order', () => {
    const p = parserFor({ seq: [{ consume: 'Int' }, { consume: 'Word' }] })
    expect(images(p.parse('1 a'))).toEqual(['1', 'a'])
  })

  it('rolls the cursor back when a later child fails', () => {
    // The first alt branch consumes Int then fails on Word; the second must
    // still see the Int, which only works if seq restored the cursor.
    const p = parserFor({
      alt: [
        { seq: [{ consume: 'Int' }, { consume: 'Word' }] },
        { seq: [{ consume: 'Int' }, { consume: 'Star' }] }
      ]
    })
    expect(images(p.parse('1 *'))).toEqual(['1', '*'])
  })

  it('excludes actions from the default result array', () => {
    const p = parserFor({ seq: [{ consume: 'Int' }, { action: 'ignored' }, { consume: 'Word' }] })
    expect(p.parse('1 a')).toBe('ignored')
  })
})

describe('alt', () => {
  it('picks whichever branch matches', () => {
    const p = parserFor({ alt: [{ consume: 'Int' }, { consume: 'Word' }] })
    expect(p.parse('9').type).toBe('Int')
    expect(p.parse('hi').type).toBe('Word')
  })

  it('reports every acceptable token when no branch matches', () => {
    const p = parserFor({ alt: [{ consume: 'Int' }, { consume: 'Word' }] })
    expect(() => p.parse('*')).toThrow(/one of \[Int, Word\]/)
  })

  it('backtracks between branches that share a prefix', () => {
    const p = parserFor({
      alt: [
        { seq: [{ consume: 'Int' }, { consume: 'Comma' }, { consume: 'Int' }] },
        { seq: [{ consume: 'Int' }, { consume: 'Semi' }] }
      ]
    })
    expect(images(p.parse('1 ; '))).toEqual(['1', ';'])
  })

  it('prefers the earlier branch when both could match', () => {
    const p = parserFor({
      alt: [
        { seq: [{ consume: 'Int' }, { action: 'first' }] },
        { seq: [{ consume: 'Int' }, { action: 'second' }] }
      ]
    })
    expect(p.parse('1')).toBe('first')
  })
})

describe('many / many1', () => {
  it('many matches zero occurrences', () => {
    const p = parserFor({ many: { consume: 'Int' } })
    expect(p.parse('')).toEqual([])
  })

  it('many collects repeats', () => {
    const p = parserFor({ many: { consume: 'Int' } })
    expect(images(p.parse('1 2 3'))).toEqual(['1', '2', '3'])
  })

  it('many1 requires at least one', () => {
    const p = parserFor({ many1: { consume: 'Int' } })
    expect(images(p.parse('1'))).toEqual(['1'])
    expect(() => p.parse('')).toThrow(/Expecting Int/)
  })

  it('many stops without consuming when the next item does not match', () => {
    const p = parserFor({ seq: [{ many: { consume: 'Int' } }, { consume: 'Word' }] })
    const [repeated, trailing] = p.parse('1 2 end')
    expect(images(repeated)).toEqual(['1', '2'])
    expect(trailing.image).toBe('end')
  })

  it('refuses to loop on a parser that consumes nothing', () => {
    const p = parserFor({ many: { option: { consume: 'Int' } } })
    expect(() => p.parse('a')).toThrow(/without consuming any input/)
  })
})

describe('option', () => {
  it('yields null when absent and does not consume', () => {
    const p = parserFor({ seq: [{ option: { consume: 'Int' } }, { consume: 'Word' }] })
    const [first, second] = p.parse('a')
    expect(first).toBeNull()
    expect(second.image).toBe('a')
  })

  it('yields the value when present', () => {
    const p = parserFor({ option: { consume: 'Int' } })
    expect(p.parse('5').image).toBe('5')
  })

  it('rolls back a partially matched option', () => {
    const p = parserFor({
      seq: [{ option: { seq: [{ consume: 'Int' }, { consume: 'Comma' }] } }, { consume: 'Int' }]
    })
    const [optional, required] = p.parse('7')
    expect(optional).toBeNull()
    expect(required.image).toBe('7')
  })
})

describe('manySep / many1Sep', () => {
  const listOf = (op, extra = {}) =>
    parserFor({ [op]: { rule: { consume: 'Int' }, sep: 'Comma', ...extra } })

  it('parses a separated list and drops separators', () => {
    expect(images(listOf('manySep').parse('1,2,3'))).toEqual(['1', '2', '3'])
  })

  it('manySep accepts an empty list', () => {
    expect(listOf('manySep').parse('')).toEqual([])
  })

  it('many1Sep requires one element', () => {
    expect(() => listOf('many1Sep').parse('')).toThrow(/Expecting Int/)
  })

  it('rejects a trailing separator by default', () => {
    expect(() => listOf('manySep').parse('1,2,')).toThrow()
  })

  it('allows a trailing separator when asked', () => {
    expect(images(listOf('manySep', { trailing: true }).parse('1,2,'))).toEqual(['1', '2'])
  })

  it('leaves a non-trailing separator for an enclosing rule', () => {
    // The inner list must not swallow the comma that separates the outer pair.
    const p = parserFor({
      seq: [
        { manySep: { rule: { consume: 'Int' }, sep: 'Comma' } },
        { consume: 'Comma' },
        { consume: 'Word' }
      ]
    })
    const [list, , word] = p.parse('1,2,end')
    expect(images(list)).toEqual(['1', '2'])
    expect(word.image).toBe('end')
  })

  it('accepts a full parser as the separator', () => {
    const p = parserFor({ manySep: { rule: { consume: 'Int' }, sep: { alt: [{ consume: 'Comma' }, { consume: 'Semi' }] } } })
    expect(images(p.parse('1,2;3'))).toEqual(['1', '2', '3'])
  })
})

describe('lookahead / negLookahead', () => {
  it('lookahead matches without consuming', () => {
    const p = parserFor({ seq: [{ lookahead: { consume: 'Int' } }, { consume: 'Int' }] })
    expect(p.parse('5')[1].image).toBe('5')
  })

  it('lookahead failing fails the sequence', () => {
    const p = parserFor({ seq: [{ lookahead: { consume: 'Word' } }, { consume: 'Int' }] })
    expect(() => p.parse('5')).toThrow()
  })

  it('negLookahead succeeds when the guarded parser fails', () => {
    const p = parserFor({ seq: [{ negLookahead: { consume: 'Word' } }, { consume: 'Int' }] })
    expect(p.parse('5')[1].image).toBe('5')
  })

  it('negLookahead fails when the guarded parser succeeds', () => {
    const p = parserFor({ seq: [{ negLookahead: { consume: 'Int' } }, { consume: 'Int' }] })
    expect(() => p.parse('5')).toThrow()
  })
})

describe('text', () => {
  it('captures the exact source span, whitespace included', () => {
    const p = parserFor({ text: { seq: [{ consume: 'Int' }, { consume: 'Comma' }, { consume: 'Int' }] } })
    expect(p.parse('1 ,  2')).toBe('1 ,  2')
  })

  it('yields an empty string when nothing was consumed', () => {
    const p = parserFor({ seq: [{ text: { many: { consume: 'Word' } } }, { consume: 'Int' }] })
    expect(p.parse('4')[0]).toBe('')
  })

  it('falls back to joined images when parsing a token stream with no source', () => {
    const p = parserFor({ text: { seq: [{ consume: 'Int' }, { consume: 'Int' }] } })
    expect(p.parseTokens(p.tokenize('1 2'))).toBe('12')
  })
})

describe('label and action', () => {
  it('binds results for a later action', () => {
    const p = parserFor({
      seq: [
        { label: ['a', { consume: 'Int' }] },
        { consume: 'Comma' },
        { label: ['b', { consume: 'Int' }] },
        { action: { '+': [{ val: ['a', 'image'] }, { val: ['b', 'image'] }] } }
      ]
    })
    expect(p.parse('20,22')).toBe(42)
  })

  it('scopes bindings to the enclosing sequence', () => {
    // The inner sequence binds its own `a`; the outer action must still see the outer one.
    const p = parserFor({
      seq: [
        { label: ['a', { consume: 'Int' }] },
        { seq: [{ label: ['a', { consume: 'Int' }] }, { action: { val: ['a', 'image'] } }] },
        { action: { val: ['a', 'image'] } }
      ]
    })
    expect(p.parse('1 2')).toBe('1')
  })

  it('lets an action climb to the parser state with a val scope hop', () => {
    const p = parserFor({
      seq: [{ consume: 'Int' }, { action: { val: [[-1], 'idx'] } }]
    })
    expect(p.parse('1')).toBe(1)
  })

  it('does not bind when the labelled parser fails', () => {
    const p = parserFor({
      seq: [
        { label: ['a', { option: { consume: 'Word' } }] },
        { label: ['b', { consume: 'Int' }] },
        { action: [{ val: 'a' }, { val: ['b', 'image'] }] }
      ]
    })
    expect(p.parse('9')).toEqual([null, '9'])
  })
})

describe('epsilon', () => {
  it('matches without consuming', () => {
    const p = parserFor({ seq: [{ epsilon: null }, { consume: 'Int' }] })
    expect(p.parse('1')[1].image).toBe('1')
  })
})

describe('subrule recursion', () => {
  it('handles right recursion', () => {
    const p = createParser({
      tokens,
      rules: {
        list: {
          alt: [
            { seq: [{ label: ['h', { consume: 'Int' }] }, { consume: 'Comma' }, { label: ['t', { subrule: 'list' }] }, { action: { merge: [[{ val: ['h', 'image'] }], { val: 't' }] } }] },
            { seq: [{ label: ['h', { consume: 'Int' }] }, { action: [{ val: ['h', 'image'] }] }] }
          ]
        }
      },
      start: 'list'
    })
    expect(p.parse('1,2,3')).toEqual(['1', '2', '3'])
  })

  it('throws on an unknown rule at parse time when validation is off', () => {
    const p = createParser(
      { tokens, rules: { main: { subrule: 'nope' } }, start: 'main' },
      { validate: false }
    )
    expect(() => p.parse('1')).toThrow(/Unknown rule 'nope'/)
  })
})

describe('parser options', () => {
  it('strict mode rejects trailing input', () => {
    const p = parserFor({ consume: 'Int' })
    expect(() => p.parse('1 2')).toThrow(/Expecting end of input/)
  })

  it('non-strict mode allows a partial parse', () => {
    const p = parserFor({ consume: 'Int' }, { strict: false })
    expect(p.parse('1 2').image).toBe('1')
  })

  it('maxSteps trips on a runaway grammar', () => {
    const p = createParser(
      { tokens, rules: { main: { seq: [{ subrule: 'main' }] } }, start: 'main' },
      { validate: false, maxSteps: 1000 }
    )
    expect(() => p.parse('1')).toThrow(/maxSteps/)
  })

  it('produces identical results with memoization on and off', () => {
    const logic = { manySep: { rule: { consume: 'Int' }, sep: 'Comma' } }
    const plain = parserFor(logic)
    const memoized = parserFor(logic, { memo: true })
    expect(images(memoized.parse('1,2,3'))).toEqual(images(plain.parse('1,2,3')))
  })

  it('memoization collapses exponential backtracking', () => {
    // `r_i := r_{i+1} ';' | r_{i+1}` parses its successor twice per level, so
    // an unmemoized parse of a semicolon-less input costs 2^depth leaf visits.
    const depth = 18
    const rules = {}
    for (let i = 0; i < depth; i++) {
      rules['r' + i] = {
        alt: [{ seq: [{ subrule: 'r' + (i + 1) }, { consume: 'Semi' }] }, { subrule: 'r' + (i + 1) }]
      }
    }
    rules['r' + depth] = { consume: 'Int' }

    const spec = { tokens, rules, start: 'r0' }
    // maxSteps would trip long before 2^18 combinator calls without memoization.
    const memoized = createParser(spec, { memo: true, maxSteps: 100000 })
    expect(memoized.parse('7').image).toBe('7')

    const plain = createParser(spec, { maxSteps: 100000 })
    expect(() => plain.parse('7')).toThrow(/maxSteps/)
  })

  it('memoization does not change which inputs are rejected', () => {
    const spec = {
      tokens,
      rules: { main: { alt: [{ seq: [{ subrule: 'l' }, { consume: 'Semi' }] }, { subrule: 'l' }] }, l: { many1Sep: { rule: { consume: 'Int' }, sep: 'Comma' } } },
      start: 'main'
    }
    const plain = createParser(spec)
    const memoized = createParser(spec, { memo: true })
    for (const source of ['1', '1,2', '1,2;', '']) {
      const plainResult = (() => { try { return JSON.stringify(plain.parse(source)) } catch { return 'throw' } })()
      const memoResult = (() => { try { return JSON.stringify(memoized.parse(source)) } catch { return 'throw' } })()
      expect(memoResult, source).toBe(plainResult)
    }
  })
})

describe('postfix', () => {
  const p = parserFor({
    postfix: {
      operand: { seq: [{ label: ['n', { consume: 'Int' }] }, { action: { val: ['n', 'image'] } }] },
      suffix: { consume: 'Star' },
      combine: { cat: [{ val: 'left' }, '*'] }
    }
  })

  it('matches a bare operand with no suffixes', () => {
    expect(p.parse('7')).toBe('7')
  })

  it('folds repeated suffixes left', () => {
    expect(p.parse('7*')).toBe('7*')
    expect(p.parse('7***')).toBe('7***')
  })

  it('leaves an unmatched suffix for the enclosing rule', () => {
    const outer = parserFor({
      seq: [
        { postfix: { operand: { consume: 'Int' }, suffix: { consume: 'Star' }, combine: { val: 'left' } } },
        { consume: 'Word' }
      ]
    })
    expect(outer.parse('1 end')[1].image).toBe('end')
  })

  it('fails when the operand fails', () => {
    expect(() => p.parse('a')).toThrow(/Expecting Int/)
  })
})

describe('binding scope reuse', () => {
  // A sequence of terminals and actions reuses one binding object, since
  // nothing can re-enter it between writing a binding and reading it. These
  // pin the cases where that must not be observable.
  it('does not leak bindings between parses', () => {
    const p = parserFor({
      seq: [
        { label: ['a', { consume: 'Int' }] },
        { consume: 'Comma' },
        { label: ['b', { consume: 'Int' }] },
        { action: { cat: [{ val: ['a', 'image'] }, '-', { val: ['b', 'image'] }] } }
      ]
    })
    expect(p.parse('1,2')).toBe('1-2')
    expect(p.parse('3,4')).toBe('3-4')
    expect(p.parse('1,2')).toBe('1-2')
  })

  it('does not alias when an action hands back the whole binding object', () => {
    // `{val: []}` returns the context itself. Reuse must be disabled here, or
    // the first result would mutate when the second parse runs.
    const p = parserFor({
      seq: [{ label: ['a', { consume: 'Int' }] }, { action: { val: [] } }]
    })
    const first = p.parse('1')
    const second = p.parse('2')
    expect(first.a.image).toBe('1')
    expect(second.a.image).toBe('2')
    expect(first).not.toBe(second)
  })

  it('is unaffected by nested sequences reached through a subrule', () => {
    const p = createParser({
      tokens,
      rules: {
        main: { seq: [{ label: ['x', { subrule: 'inner' }] }, { action: { val: 'x' } }] },
        inner: { seq: [{ label: ['y', { consume: 'Int' }] }, { action: { val: ['y', 'image'] } }] }
      },
      start: 'main'
    })
    expect(p.parse('5')).toBe('5')
    expect(p.parse('6')).toBe('6')
  })
})
