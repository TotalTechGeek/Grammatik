import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

import { createParser, createParserFromSource, emitModule } from '../src/index.js'
import { recognizeAltFactoring } from '../src/analyze.js'

/**
 * Branches that all begin with the same parsers (`ComparisonPredicate`, `InPredicate`, ... each start with
 * `label(left, Additive)`) parse that part once and then try what each does after it. The shared part sits
 * behind a rule boundary and is labelled, which is the case the memoization planner's header says
 * left-factoring cannot reach, so most of this file is about the ways the rewrite could differ from the
 * branches run one after another: a label that leaks from an attempt that failed, an attempt that does not
 * reset the cursor, a branch that is skipped when it should have matched, and what an error says.
 */

const tokens = [
  { name: 'WS', pattern: '\\s+', skip: true },
  { name: 'Num', pattern: '[0-9]+' },
  { name: 'Eq', literal: '=' },
  { name: 'Lt', literal: '<' },
  { name: 'Not', literal: 'not' },
  { name: 'In', literal: 'in' },
  { name: 'Is', literal: 'is' },
  { name: 'Null', literal: 'null' },
  { name: 'Dot', literal: '.' },
  { name: 'LParen', literal: '(' },
  { name: 'RParen', literal: ')' },
  { name: 'Comma', literal: ',' }
]

const c = (name) => ({ consume: name })
const rule = (name) => ({ subrule: name })
const label = (name, parser) => ({ label: [name, parser] })
const val = (...path) => ({ val: path.length === 1 ? path[0] : path })

/** `Pred` over a shared `left`; each tail is its own rule, reached through a subrule. */
function grammar (extraTails = []) {
  const tails = ['Cmp', 'InP', 'IsP', ...extraTails.map((t) => t.name)]
  const rules = {
    Base: { as: [c('Num'), val('image')] },
    Cmp: {
      seq: [
        label('left', rule('Base')),
        label('op', { alt: [c('Eq'), c('Lt')] }),
        label('right', rule('Base')),
        { action: { obj: ['k', 'cmp', 'op', val('op', 'image'), 'l', val('left'), 'r', val('right')] } }
      ]
    },
    InP: {
      seq: [
        label('left', rule('Base')),
        label('neg', { option: c('Not') }),
        c('In'), c('LParen'),
        label('items', { many1Sep: { rule: rule('Base'), sep: 'Comma' } }),
        c('RParen'),
        { action: { obj: ['k', 'in', 'l', val('left'), 'neg', { '!==': [val('neg'), null] }, 'items', val('items')] } }
      ]
    },
    IsP: {
      seq: [
        label('left', rule('Base')),
        c('Is'),
        label('neg', { option: c('Not') }),
        c('Null'),
        { action: { obj: ['k', 'is', 'l', val('left'), 'neg', { '!==': [val('neg'), null] }] } }
      ]
    },
    Pred: { alt: [...tails.map(rule), rule('Base')] }
  }
  for (const tail of extraTails) rules[tail.name] = tail.body
  return { tokens, rules, start: 'Pred' }
}

/** A tail that can match with nothing after the prefix, and one that starts with a lookahead: neither has a known first token. */
const loose = {
  name: 'LooseP',
  body: { seq: [label('left', rule('Base')), { option: c('Not') }, { option: c('Dot') }, { action: { obj: ['k', 'loose', 'l', val('left')] } }] }
}
const guarded = {
  name: 'GuardedP',
  body: { seq: [label('left', rule('Base')), { lookahead: c('Comma') }, c('Comma'), { action: { obj: ['k', 'guarded', 'l', val('left')] } }] }
}

const outcome = (parser, input) => {
  try {
    return JSON.stringify(parser.parse(input))
  } catch (e) {
    return JSON.stringify([e.name, e.message, e.expected, e.ruleStack, e.offset])
  }
}

describe('recognizeAltFactoring', () => {
  const plan = (spec, name = 'Pred') => recognizeAltFactoring(spec.rules[name].alt, spec.rules)

  it('finds a shared labelled prefix behind a rule boundary, and a branch that is only the prefix', () => {
    const found = plan(grammar())
    expect(found.prefix).toEqual([label('left', rule('Base'))])
    expect(found.branches.map((b) => ('bare' in b ? 'bare' : b.rest.length))).toEqual([3, 6, 4, 'bare'])
  })

  it('finds it when the branches are written inline too', () => {
    const spec = grammar()
    const inline = { alt: ['Cmp', 'InP', 'IsP'].map((n) => spec.rules[n]).concat([rule('Base')]) }
    expect(recognizeAltFactoring(inline.alt, spec.rules)).not.toBeNull()
  })

  it('takes the longest shared run, not just the first parser', () => {
    const spec = {
      Base: { consume: 'Num' },
      A: { seq: [label('x', rule('Base')), c('Dot'), c('Eq'), { action: { val: 'x' } }] },
      B: { seq: [label('x', rule('Base')), c('Dot'), c('Lt'), { action: { val: 'x' } }] }
    }
    const found = recognizeAltFactoring([rule('A'), rule('B')], spec)
    expect(found.prefix).toHaveLength(2)
  })

  it('declines when there is nothing shared', () => {
    const spec = { A: { seq: [c('Eq'), { action: { val: [] } }] }, B: { seq: [c('Lt'), { action: { val: [] } }] } }
    expect(recognizeAltFactoring([rule('A'), rule('B')], spec)).toBeNull()
  })

  it('declines when a branch has no action: its value is a list of what it parsed', () => {
    const spec = grammar()
    spec.rules.IsP = { seq: [label('left', rule('Base')), c('Is'), c('Null')] }
    expect(plan(spec)).toBeNull()
  })

  it('declines when an action reaches outside its own scope', () => {
    const spec = grammar()
    spec.rules.IsP.seq[spec.rules.IsP.seq.length - 1] = { action: { val: [[1], 'left'] } }
    expect(plan(spec)).toBeNull()
  })

  it('declines when a tail relabels a name the prefix already bound', () => {
    const spec = grammar()
    spec.rules.IsP.seq.splice(1, 0, label('left', c('Dot')))
    expect(plan(spec)).toBeNull()
  })

  it('declines when a bare branch is not the shared parser', () => {
    const spec = grammar()
    spec.rules.Pred = { alt: [rule('Cmp'), rule('InP'), c('Num')] }
    expect(plan(spec)).toBeNull()
  })

  it('declines with only one branch that has a tail to share', () => {
    const spec = grammar()
    spec.rules.Pred = { alt: [rule('Cmp'), rule('Base')] }
    expect(plan(spec)).toBeNull()
  })

  it('declines when a branch is not a seq or a rule that is one, unless it is the prefix itself', () => {
    const spec = grammar()
    spec.rules.Pred = { alt: [rule('Cmp'), rule('InP'), { option: c('Eq') }] }
    expect(plan(spec)).toBeNull()
  })
})

describe('the generated code', () => {
  it('parses the shared prefix once, outside tracking, and keeps the alt as written for the tracked re-run', () => {
    const on = createParser(grammar()).codegen.sourceFor('Pred')
    const off = createParser(grammar(), { factoring: false }).codegen.sourceFor('Pred')
    expect(on).toMatch(/if \(c\.track\) \{/)
    // the original alt still names each rule it goes through, for the error's rule stack
    expect(on).toContain('"InP"')
    expect(on.length).toBeGreaterThan(off.length)
    // the shared parser is called in the fast path once, not once per branch
    const calls = (source) => source.split('\n').filter((line) => line.includes('R[') && line.includes('](c)')).length
    expect(calls(on)).toBeLessThan(calls(off) + 8)
  })

  it('is left out when asked', () => {
    expect(createParser(grammar(), { factoring: false }).codegen.sourceFor('Pred')).not.toMatch(/if \(c\.track\) \{\s*\n*let/)
  })

  it('is written into an emitted module', () => {
    const on = emitModule(grammar(), { runtimeSpecifier: './runtime.js' })
    const off = emitModule(grammar(), { runtimeSpecifier: './runtime.js', factoring: false })
    expect(on.length).toBeGreaterThan(off.length)
  })
})

describe('what a tail sees', () => {
  it('starts every attempt with the prefix labels and nothing a failed attempt set', () => {
    // `InP` sets `neg` (it parses `not`), then fails at `in`. `Dot` also parses `not`, but does not
    // label it, and its action reads `neg`. Run alone it finds nothing there; if the attempts shared a
    // bindings object it would find the token `InP` left behind.
    const dot = {
      name: 'DotP',
      body: {
        seq: [
          label('left', rule('Base')),
          { option: c('Not') },
          c('Dot'),
          { action: { obj: ['k', 'dot', 'l', val('left'), 'neg', val('neg')] } }
        ]
      }
    }
    const spec = grammar([dot])
    const on = createParser(spec)
    const off = createParser(spec, { factoring: false })
    const input = '1 not .'
    expect(outcome(on, input)).toBe(outcome(off, input))
    expect(on.parse(input)).toMatchObject({ k: 'dot', l: '1' })
    expect(on.parse(input).neg ?? null).toBeNull()
  })

  it('moves the cursor back to just after the prefix before each attempt', () => {
    // `Cmp` takes `=`, then fails on a missing right side; `IsP` must start again at `=`'s position.
    const spec = grammar()
    const on = createParser(spec)
    const off = createParser(spec, { factoring: false })
    for (const input of ['1 =', '1 = 2', '1 is null', '1 is not null', '1 in (2, 3)', '1 not in (2)', '1', '1 =  not', '']) {
      expect(outcome(on, input), input).toBe(outcome(off, input))
    }
  })

  it('returns the prefix value for a branch that is only the prefix, and nothing after it is tried', () => {
    const on = createParser(grammar())
    expect(on.parse('42')).toBe('42')
  })

  it('does not let the first-token filter skip a tail that could match', () => {
    // `LooseP` can match with nothing after the prefix, and `GuardedP` starts with a lookahead, so neither
    // has a known first token: both stay candidates whatever the next token is, even one (`not`, `in`)
    // that is the known first token of a tail before them.
    const spec = grammar([guarded, loose])
    const on = createParser(spec, { strict: false })
    const off = createParser(spec, { strict: false, factoring: false })
    for (const input of ['1 not in (1)', '1 in (1)', '1 is not null', '1 < 2', '1 not', '1 not .', '1 .', '1 ,', '1', '1 not ,']) {
      expect(outcome(on, input), input).toBe(outcome(off, input))
    }
    expect(on.parse('1 not')).toMatchObject({ k: 'loose', l: '1' })
    expect(on.parse('1 ,')).toMatchObject({ k: 'guarded' })
  })
})

// ---- the differential ----

function prng (seed) {
  let a = seed >>> 0
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

function mutations (base, pieces, count, seed) {
  const rnd = prng(seed)
  const out = [base]
  for (let n = 0; n < count; n++) {
    let text = base
    for (let k = 1 + rnd(3); k > 0; k--) {
      const at = rnd(text.length + 1)
      const kind = rnd(3)
      if (kind === 0) text = text.slice(0, at) + text.slice(at + 1 + rnd(3))
      else if (kind === 1) text = text.slice(0, at) + pieces[rnd(pieces.length)] + text.slice(at)
      else text = text.slice(0, at) + pieces[rnd(pieces.length)] + text.slice(at + 1)
    }
    out.push(text)
  }
  return out
}

// A failed or incomplete parse is repeated with tracking on, and tracking runs the alt as written, so at the
// top level a wrongly skipped or wrongly shaped branch can be hidden by the retry. With `strict: false` the
// first pass is the answer and the mistake shows.
describe.each([true, false])('factoring does not change what parses or what an error says (strict: %s)', (strict) => {
  it('on a small grammar, over every mix of the tails', () => {
    const dot = {
      name: 'DotP',
      body: { seq: [label('left', rule('Base')), { option: c('Not') }, c('Dot'), { action: { obj: ['k', 'dot', 'l', val('left'), 'neg', val('neg')] } }] }
    }
    const spec = grammar([dot, guarded, loose])
    const on = createParser(spec, { strict })
    const off = createParser(spec, { strict, factoring: false })
    const pieces = ['=', '<', ' not ', ' in ', ' is ', ' null ', '.', '(', ')', ',', '1', '2', ' ']
    const bases = ['1 = 2', '1 < 2', '1 in (2, 3)', '1 not in (2)', '1 is null', '1 is not null', '1 not .', '1 .', '7', '1 ,', '1 not']
    let valid = 0
    let invalid = 0
    bases.forEach((base, i) => {
      for (const input of mutations(base, pieces, 500, 100 + i)) {
        const a = outcome(on, input)
        expect(a, input).toBe(outcome(off, input))
        if (a.startsWith('["')) invalid++; else valid++
      }
    })
    expect(valid).toBeGreaterThan(200)
    expect(invalid).toBeGreaterThan(200)
  })

  it('on the SQL grammar', () => {
    const source = readFileSync(new URL('../examples/sql.gram', import.meta.url), 'utf8')
    const on = createParserFromSource(source, { strict })
    const off = createParserFromSource(source, { strict, factoring: false })
    const pieces = ['(', ')', ',', '.', '*', 'a', 'x1', '1', "'s'", ' ', ' NOT ', ' IN ', ' IS NULL', ' LIKE ', ' BETWEEN ', ' AND ', ' = ', '<>', '-', 'SELECT ', ' FROM ', ' WHERE ', ' AS ', 'CASE ', ' END', ' WHEN ', ' THEN ', 'COUNT(']
    const bases = [
      'SELECT a FROM t WHERE x IS NOT NULL',
      "SELECT a FROM t WHERE name LIKE 'a%' AND b NOT BETWEEN 1 AND 9 OR c IN (1, 2, 3)",
      'SELECT a FROM t WHERE ((((x IS NULL))))',
      'SELECT u.id, COUNT(o.id) AS n FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id ORDER BY n DESC',
      'SELECT a * b FROM t WHERE a * b = c AND d NOT IN (1, 2) AND e BETWEEN 1 + 2 AND 3',
      'SELECT CASE WHEN a = 1 THEN b ELSE c END FROM t WHERE (x = 1 OR y IS NULL) AND z LIKE 1'
    ]
    let valid = 0
    let invalid = 0
    bases.forEach((base, i) => {
      for (const input of mutations(base, pieces, 400, 7000 + i)) {
        const a = outcome(on, input)
        expect(a, input).toBe(outcome(off, input))
        if (a.startsWith('["')) invalid++; else valid++
      }
    })
    expect(valid).toBeGreaterThan(100)
    expect(invalid).toBeGreaterThan(200)
  })
})
