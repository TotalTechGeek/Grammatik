import { describe, it, expect } from 'vitest'
import { analyze, buildDispatch, firstOf } from '../src/analyze.js'
import { createParser, GrammarError } from '../src/index.js'

const tokenNames = ['Int', 'Word', 'Comma', 'Plus', 'LParen', 'RParen']
const run = (rules) => analyze(rules, { tokenNames })

describe('FIRST sets', () => {
  it('computes the first token of a terminal', () => {
    const { firsts } = run({ a: { consume: 'Int' } })
    expect([...firsts.get('a').tokens]).toEqual(['Int'])
    expect(firsts.get('a').nullable).toBe(false)
  })

  it('unions the branches of an alt', () => {
    const { firsts } = run({ a: { alt: [{ consume: 'Int' }, { consume: 'Word' }] } })
    expect([...firsts.get('a').tokens].sort()).toEqual(['Int', 'Word'])
  })

  it('sees past nullable elements at the head of a seq', () => {
    const { firsts } = run({
      a: { seq: [{ option: { consume: 'Plus' } }, { consume: 'Int' }] }
    })
    expect([...firsts.get('a').tokens].sort()).toEqual(['Int', 'Plus'])
    expect(firsts.get('a').nullable).toBe(false)
  })

  it('marks a rule nullable when every element can be skipped', () => {
    const { firsts } = run({ a: { seq: [{ many: { consume: 'Int' } }, { option: { consume: 'Word' } }] } })
    expect(firsts.get('a').nullable).toBe(true)
  })

  it('converges on mutually recursive rules', () => {
    const { firsts } = run({
      a: { alt: [{ consume: 'Int' }, { subrule: 'b' }] },
      b: { seq: [{ consume: 'LParen' }, { subrule: 'a' }, { consume: 'RParen' }] }
    })
    expect([...firsts.get('a').tokens].sort()).toEqual(['Int', 'LParen'])
    expect([...firsts.get('b').tokens]).toEqual(['LParen'])
  })

  it('treats a lookahead as opaque so it cannot be dispatched past', () => {
    expect(firstOf({ lookahead: { consume: 'Int' } }, new Map()).unknown).toBe(true)
  })
})

describe('buildDispatch', () => {
  it('builds a table when branches begin with distinct tokens', () => {
    const { firsts } = run({ a: { alt: [{ consume: 'Int' }, { consume: 'Word' }] } })
    const table = buildDispatch(firsts && [{ consume: 'Int' }, { consume: 'Word' }], firsts)
    expect(table).not.toBeNull()
    expect([...table.keys()].sort()).toEqual(['Int', 'Word'])
  })

  it('groups branches that share a first token, in original order, for ordered backtracking', () => {
    const branches = [
      { seq: [{ consume: 'Int' }, { consume: 'Comma' }] },
      { seq: [{ consume: 'Int' }, { consume: 'Plus' }] }
    ]
    const table = buildDispatch(branches, run({ a: { alt: branches } }).firsts)
    expect(table).not.toBeNull()
    expect(table.get('Int')).toEqual(branches)
  })

  it('keeps unambiguous tokens as a direct table entry alongside a collision group', () => {
    const branches = [
      { seq: [{ consume: 'Int' }, { consume: 'Comma' }] },
      { seq: [{ consume: 'Int' }, { consume: 'Plus' }] },
      { consume: 'Word' }
    ]
    const table = buildDispatch(branches, run({ a: { alt: branches } }).firsts)
    expect(table.get('Int')).toEqual([branches[0], branches[1]])
    expect(table.get('Word')).toBe(branches[2])
  })

  it('shares one array instance across tokens with an identical collision group', () => {
    const branches = [
      { alt: [{ consume: 'Int' }, { consume: 'Comma' }] },
      { alt: [{ consume: 'Int' }, { consume: 'Comma' }] }
    ]
    const table = buildDispatch(branches, run({ a: { alt: branches } }).firsts)
    expect(table.get('Int')).toBe(table.get('Comma'))
  })

  it('refuses when a branch is nullable', () => {
    const branches = [{ option: { consume: 'Int' } }, { consume: 'Word' }]
    expect(buildDispatch(branches, run({ a: { alt: branches } }).firsts)).toBeNull()
  })

  it('refuses when a branch is opaque', () => {
    const branches = [{ lookahead: { consume: 'Int' } }, { consume: 'Word' }]
    expect(buildDispatch(branches, run({ a: { alt: branches } }).firsts)).toBeNull()
  })

  it('dispatches an alt of subrules', () => {
    const rules = {
      a: { alt: [{ subrule: 'b' }, { subrule: 'c' }] },
      b: { consume: 'Int' },
      c: { consume: 'Word' }
    }
    const table = buildDispatch(rules.a.alt, run(rules).firsts)
    expect([...table.keys()].sort()).toEqual(['Int', 'Word'])
  })
})

describe('left recursion detection', () => {
  it('catches direct left recursion', () => {
    const { leftRecursive } = run({
      expr: { alt: [{ seq: [{ subrule: 'expr' }, { consume: 'Plus' }, { consume: 'Int' }] }, { consume: 'Int' }] }
    })
    expect(leftRecursive).toEqual(['expr'])
  })

  it('catches indirect left recursion', () => {
    const { leftRecursive } = run({
      a: { seq: [{ subrule: 'b' }, { consume: 'Int' }] },
      b: { seq: [{ subrule: 'a' }] }
    })
    expect(leftRecursive.sort()).toEqual(['a', 'b'])
  })

  it('catches recursion hidden behind a nullable prefix', () => {
    const { leftRecursive } = run({
      a: { seq: [{ option: { consume: 'Plus' } }, { subrule: 'a' }] }
    })
    expect(leftRecursive).toEqual(['a'])
  })

  it('allows right recursion', () => {
    const { leftRecursive, errors } = run({
      a: { alt: [{ seq: [{ consume: 'Int' }, { consume: 'Comma' }, { subrule: 'a' }] }, { consume: 'Int' }] }
    })
    expect(leftRecursive).toEqual([])
    expect(errors).toEqual([])
  })

  it('allows recursion guarded by a consumed token', () => {
    const { leftRecursive } = run({
      a: { seq: [{ consume: 'LParen' }, { subrule: 'a' }, { consume: 'RParen' }] }
    })
    expect(leftRecursive).toEqual([])
  })
})

describe('grammar validation', () => {
  it('reports unknown token references', () => {
    expect(run({ a: { consume: 'Nope' } }).errors).toEqual([
      expect.stringContaining("unknown token 'Nope'")
    ])
  })

  it('reports unknown rule references', () => {
    expect(run({ a: { subrule: 'nope' } }).errors).toEqual([
      expect.stringContaining("unknown rule 'nope'")
    ])
  })

  it('reports a malformed label', () => {
    expect(run({ a: { label: [{ consume: 'Int' }] } }).errors).toEqual([
      expect.stringContaining("'label' expects [name, parser]")
    ])
  })

  it('reports a malformed manySep', () => {
    expect(run({ a: { manySep: { rule: { consume: 'Int' } } } }).errors).toEqual([
      expect.stringContaining('expects { rule, sep }')
    ])
  })

  it('reports an empty alt', () => {
    expect(run({ a: { alt: [] } }).errors).toEqual([
      expect.stringContaining("'alt' needs at least one branch")
    ])
  })

  it('includes a path to the offending node', () => {
    const { errors } = run({ expr: { seq: [{ consume: 'Int' }, { alt: [{ consume: 'Bad' }] }] } })
    expect(errors[0]).toMatch(/^expr\.seq\[1\]\.alt\[0\]/)
  })

  it('accepts a valid grammar', () => {
    expect(run({ a: { seq: [{ consume: 'Int' }, { option: { subrule: 'a' } }] } }).errors).toEqual([])
  })
})

describe('createParser validation', () => {
  const tokens = [
    { name: 'Int', pattern: '\\d+' },
    { name: 'Plus', literal: '+' }
  ]

  it('throws a GrammarError on a left-recursive grammar', () => {
    expect(() => createParser({
      tokens,
      rules: { expr: { alt: [{ seq: [{ subrule: 'expr' }, { consume: 'Plus' }] }, { consume: 'Int' }] } },
      start: 'expr'
    })).toThrowError(GrammarError)
  })

  it('names left recursion and suggests the fix', () => {
    try {
      createParser({ tokens, rules: { expr: { seq: [{ subrule: 'expr' }] } }, start: 'expr' })
    } catch (error) {
      expect(error.problems[0]).toMatch(/left-recursive/)
      expect(error.problems[0]).toMatch(/many/)
    }
  })

  it('can be told to skip validation', () => {
    expect(() => createParser(
      { tokens, rules: { expr: { subrule: 'ghost' } }, start: 'expr' },
      { validate: false }
    )).not.toThrow()
  })

  it('rejects a missing start rule', () => {
    expect(() => createParser({ tokens, rules: { a: { consume: 'Int' } }, start: 'b' }))
      .toThrow(/start rule 'b' is not defined/)
  })
})
