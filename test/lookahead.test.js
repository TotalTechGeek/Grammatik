import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

import { createParser, createParserFromSource, analyze } from '../src/index.js'
import { buildDispatch, secondTokenMasks } from '../src/analyze.js'
import { createFormulaParser } from '../examples/formula.js'

/**
 * Two tokens of lookahead. Where an `alt`'s dispatch table cannot tell branches apart by the next token
 * (`Identifier` begins both a function call and a reference), the token after it often can (`(` or `.`
 * versus anything else), and a branch is not attempted once it provably cannot match.
 *
 * Skipping a branch is only sound if the analysis is a true over-approximation, so most of this file is
 * about the ways it could be wrong.
 */

const tok = (name, pattern) => ({ name, pattern })
const tokens = [
  { name: 'Ws', pattern: '\\s+', skip: true },
  tok('Id', '[a-z]+'), tok('Num', '[0-9]+'), tok('LParen', '\\('), tok('RParen', '\\)'), tok('Dot', '\\.'),
  tok('Star', '\\*'), tok('Eq', '='), tok('Semi', ';'), tok('Comma', ',')
]
const c = (name) => ({ consume: name })
const rule = (name) => ({ subrule: name })

/** firsts, firsts2 and the dispatch table of a rule's top-level `alt`. */
function groupsOf (rules, name) {
  const { firsts, firsts2 } = analyze(rules, { tokenNames: tokens.map((t) => t.name) })
  const branches = rules[name].alt
  const table = buildDispatch(branches, firsts)
  const groups = new Map()
  for (const [token, value] of table) if (Array.isArray(value)) groups.set(value, [...(groups.get(value) || []), token])
  return { firsts2, groups: [...groups].map(([group, firstTokens]) => ({ group, firstTokens })) }
}

describe('secondTokenMasks', () => {
  it('lets the second token choose between a call and a reference', () => {
    const rules = {
      Primary: { alt: [rule('Call'), rule('Ref')] },
      Call: { seq: [c('Id'), c('LParen'), c('RParen')] },
      Ref: { seq: [c('Id'), { option: { seq: [c('Dot'), c('Id')] } }] }
    }
    const { firsts2, groups } = groupsOf(rules, 'Primary')
    expect(groups).toHaveLength(1)
    const masks = secondTokenMasks(groups[0].group, firsts2, groups[0].firstTokens)
    // bit 0 = Call, bit 1 = Ref. `(` could still be either; anything else can only be a reference.
    expect(masks.bySecond.get('LParen')).toBe(0b11)
    expect(masks.other).toBe(0b10)
  })

  it('treats a prefix that may continue as matching any second token', () => {
    // An operator level begins with its operand, but then `Id * Id = Id` continues past the operand, so
    // a branch built on it must stay a candidate whatever the second token is. Concluding that only
    // `=` could follow `Id` would skip the comparison for `a * b = c` and accept just `a * b`.
    const rules = {
      Predicate: { alt: [rule('Comparison'), rule('Sum')] },
      Comparison: { seq: [rule('Sum'), c('Eq'), rule('Sum')] },
      Sum: { infixLeft: { operand: c('Id'), operator: c('Star') } }
    }
    const { firsts2, groups } = groupsOf(rules, 'Predicate')
    expect(groups).toHaveLength(1)
    expect(secondTokenMasks(groups[0].group, firsts2, groups[0].firstTokens)).toBeNull()
  })

  it('keeps a branch that can end after the first token for every second token', () => {
    const rules = {
      Top: { alt: [{ seq: [c('Id'), c('Semi')] }, c('Id')] }
    }
    const { firsts2, groups } = groupsOf(rules, 'Top')
    const masks = secondTokenMasks(groups[0].group, firsts2, groups[0].firstTokens)
    expect(masks.bySecond.get('Semi')).toBe(0b11)
    expect(masks.other).toBe(0b10) // a bare `Id` is the only thing that can end there
  })

  it('declines when it cannot see through a branch', () => {
    const rules = {
      Top: { alt: [{ seq: [c('Id'), { lookahead: c('Dot') }, c('Dot')] }, { seq: [c('Id'), c('Comma')] }] }
    }
    const { firsts2, groups } = groupsOf(rules, 'Top')
    expect(secondTokenMasks(groups[0].group, firsts2, groups[0].firstTokens)).toBeNull()
  })

  it('rules out every branch when the second token cannot be any of theirs', () => {
    const rules = { Top: { alt: [{ seq: [c('Id'), c('Dot'), c('Id')] }, { seq: [c('Id'), c('Dot'), c('Num')] }] } }
    const { firsts2, groups } = groupsOf(rules, 'Top')
    const masks = secondTokenMasks(groups[0].group, firsts2, groups[0].firstTokens)
    expect(masks.bySecond.get('Dot')).toBe(0b11)
    expect(masks.other).toBe(0) // neither branch can match unless the second token is a `.`
  })

  it('declines when no second token rules anything out', () => {
    const rules = { Top: { alt: [c('Id'), { seq: [c('Id'), { option: c('Dot') }] }] } }
    const { firsts2, groups } = groupsOf(rules, 'Top')
    expect(secondTokenMasks(groups[0].group, firsts2, groups[0].firstTokens)).toBeNull()
  })

  it('sees through repetition, options and separated lists', () => {
    const rules = {
      Top: { alt: [{ seq: [c('Id'), { many: c('Star') }, c('Eq')] }, { seq: [c('Id'), { option: c('Dot') }, c('Semi')] }] }
    }
    const { firsts2, groups } = groupsOf(rules, 'Top')
    const masks = secondTokenMasks(groups[0].group, firsts2, groups[0].firstTokens)
    expect(masks.bySecond.get('Star')).toBe(0b01)
    expect(masks.bySecond.get('Eq')).toBe(0b01)
    expect(masks.bySecond.get('Dot')).toBe(0b10)
    expect(masks.bySecond.get('Semi')).toBe(0b10)
    expect(masks.other).toBe(0)
  })
})

describe('generated code', () => {
  const spec = {
    tokens,
    rules: {
      Primary: { alt: [rule('Call'), rule('Ref')] },
      Call: { seq: [c('Id'), c('LParen'), c('RParen')] },
      Ref: { seq: [c('Id'), { option: { seq: [c('Dot'), c('Id')] } }] }
    },
    start: 'Primary'
  }

  it('tests the second token only when it can help, and only outside tracking', () => {
    const on = createParser(spec).codegen.sourceFor('Primary')
    const off = createParser(spec, { lookahead: false }).codegen.sourceFor('Primary')
    expect(on).toContain('if (!c.track) {')
    expect(off).not.toContain('if (!c.track) {')
  })

  it('parses the same with it on and off', () => {
    const on = createParser(spec)
    const off = createParser(spec, { lookahead: false })
    for (const input of ['a', 'a.b', 'a()', 'a(', 'a.b()', '', '.', 'a b']) {
      const run = (p) => { try { return JSON.stringify(p.parse(input)) } catch (e) { return `${e.message}|${e.expected}` } }
      expect(run(on), input).toBe(run(off))
    }
  })

  it('rescues a grammar that backtracks exponentially, as autoMemo does', () => {
    // r_i := r_{i+1} ';' | r_{i+1}: with no `;` after the input, the first branch at every level fails
    // only after parsing everything below it. Two tokens of lookahead see there is no `;` and skip it.
    const rules = {}
    const depth = 18
    for (let i = 0; i < depth; i++) {
      rules['r' + i] = { alt: [{ seq: [rule('r' + (i + 1)), c('Semi')] }, rule('r' + (i + 1))] }
    }
    rules['r' + depth] = c('Num')
    const grammar = { tokens, rules, start: 'r0' }
    expect(() => createParser(grammar, { autoMemo: false, lookahead: false, maxSteps: 100000 }).parse('7')).toThrow(/maxSteps/)
    expect(createParser(grammar, { autoMemo: false, maxSteps: 100000 }).parse('7').image).toBe('7')
  })
})

// ---- the differential: lookahead on and off must be indistinguishable ----

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

/** A handful of edits to a string, so most results are near-valid and the rest are damaged. */
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

const outcome = (parser, input) => {
  try {
    return JSON.stringify(parser.parse(input))
  } catch (e) {
    return JSON.stringify([e.name, e.message, e.expected, e.ruleStack, e.offset])
  }
}

// A parse that fails, or leaves tokens over, is re-run with tracking on, and tracking disables the pruning.
// So at the top level a wrongly skipped branch heals itself: the answer is right and only slower, and a
// comparison of final results cannot see the mistake. With `strict: false` trailing tokens are accepted, the
// first pass is the answer, and a branch skipped in error shows up as a different tree.
describe.each([true, false])('lookahead does not change what parses or what an error says (strict: %s)', (strict) => {
  it('on the formula grammar', () => {
    const on = createFormulaParser({ strict })
    const off = createFormulaParser({ strict, lookahead: false })
    const pieces = ['(', ')', ',', '.', ':', '!', '[', ']', '*', 'a', 'A1', '1', "'S 1'!", '"s"', '#N/A', ' ', '$', '{', '}', ';', '+', '-', '&', 'SUM(', 'IF(', '[*]', '.x', '1e']
    const bases = [
      '=1 + 2 * 3', 'IF(A1>=10,SUM(B1:B5),ABS(C1))', 'items[*].price * items[*].quantity', '"Total: " & ROUND(subtotal * 1.0825, 2)',
      "'Quarter 1'!$B$2 + MAX({1,2;3,4})", 'a[*].b[*].c & root[0]["suffix"]', 'Sheet1!A1:B2', 'x.y.z', 'f(g(1), h.i)', '$A$1:$B$2', "'a b'!A1", 'a[0]'
    ]
    let valid = 0
    let invalid = 0
    bases.forEach((base, i) => {
      for (const input of mutations(base, pieces, 400, 1000 + i)) {
        const a = outcome(on, input)
        expect(a, input).toBe(outcome(off, input))
        if (a.startsWith('["')) invalid++; else valid++
      }
    })
    // The corpus must exercise both outcomes, or this proves little.
    expect(valid).toBeGreaterThan(200)
    if (strict) expect(invalid).toBeGreaterThan(200)
  })

  it('on the SQL grammar', () => {
    const source = readFileSync(new URL('../examples/sql.gram', import.meta.url), 'utf8')
    const on = createParserFromSource(source, { strict })
    const off = createParserFromSource(source, { strict, lookahead: false })
    const pieces = ['(', ')', ',', '.', '*', 'a', 'x1', '1', "'s'", ' ', ' NOT ', ' IN ', ' IS NULL', ' LIKE ', ' BETWEEN ', ' AND ', ' = ', '<>', '-', 'SELECT ', ' FROM ', ' WHERE ', ' AS ', 'CASE ', ' END', ' WHEN ', ' THEN ', 'COUNT(']
    const bases = [
      'SELECT a FROM t WHERE x IS NOT NULL',
      "SELECT a FROM t WHERE name LIKE 'a%' AND b NOT BETWEEN 1 AND 9 OR c IN (1, 2, 3)",
      'SELECT a FROM t WHERE ((((x IS NULL))))',
      'SELECT u.id, COUNT(o.id) AS n FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id ORDER BY n DESC',
      'SELECT a * b FROM t WHERE a * b = c',
      'SELECT CASE WHEN a = 1 THEN b ELSE c END FROM t',
      'SELECT f(x), y.z AS w FROM t WHERE -a < 3'
    ]
    let valid = 0
    let invalid = 0
    bases.forEach((base, i) => {
      for (const input of mutations(base, pieces, 400, 2000 + i)) {
        const a = outcome(on, input)
        expect(a, input).toBe(outcome(off, input))
        if (a.startsWith('["')) invalid++; else valid++
      }
    })
    expect(valid).toBeGreaterThan(100)
    if (strict) expect(invalid).toBeGreaterThan(200)
  })

  it('on a comparison that continues past an operator (the case a careless analysis gets wrong)', () => {
    const source = readFileSync(new URL('../examples/sql.gram', import.meta.url), 'utf8')
    const on = createParserFromSource(source, { strict })
    const off = createParserFromSource(source, { strict, lookahead: false })
    for (const where of ['a * b = c', 'a + b * c > d - e', 'a = b', 'a * b', 'a IN (1, 2) ', '-a * -b <= 3 * 4']) {
      const q = `SELECT 1 FROM t WHERE ${where}`
      expect(outcome(on, q), q).toBe(outcome(off, q))
    }
  })
})
