import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

import { createParser, createParserFromSource, emitModule } from '../src/index.js'
import { createFormulaParser } from '../examples/formula.js'

/**
 * A line of `infixLeft` / `infixRight` rules, one per precedence level, is run as one precedence-climbing
 * function instead of a call per level per operand. That changes how a line is run and nothing about what it
 * means, so most of this file is about the ways it could differ: shape of the tree, which operator ends an
 * expression, where a parse may enter the middle of a line, and what an error says.
 */

const OPS = 6
const tokens = [
  { name: 'WS', pattern: '\\s+', skip: true },
  { name: 'Int', pattern: '[0-9]+' },
  { name: 'Semi', literal: ';' },
  { name: 'LParen', literal: '(' },
  { name: 'RParen', literal: ')' },
  ...Array.from({ length: OPS }, (_, i) => ({ name: 'Op' + i, literal: 'abcdef'[i] }))
]

const node = { obj: [{ val: ['op', 'image'] }, [{ val: 'left' }, { val: 'right' }]] }

/**
 * `assoc` has one entry per level, outermost (loosest) first: 'left' or 'right'. Level i's operator is `Op<i>`,
 * written `a`, `b`, ... in the input. The innermost operand is an Int or a parenthesised whole expression.
 */
function ladder (assoc, extra = {}) {
  const rules = {
    Atom: { alt: [{ as: [{ consume: 'Int' }, { val: 'image' }] }, { between: { open: { consume: 'LParen' }, body: { subrule: 'L0' }, close: { consume: 'RParen' } } }] }
  }
  assoc.forEach((kind, i) => {
    rules['L' + i] = {
      [kind === 'right' ? 'infixRight' : 'infixLeft']: {
        operand: { subrule: i === assoc.length - 1 ? 'Atom' : 'L' + (i + 1) },
        operator: { consume: 'Op' + i },
        combine: node
      }
    }
  })
  rules.Top = { seq: [{ label: ['e', { subrule: extra.entry || 'L0' }] }, { consume: 'Semi' }, { action: { val: 'e' } }] }
  return { tokens, rules, start: 'Top' }
}

/** `{ a: [x, y] }` as `(a x y)`, so a tree reads as it is shaped. */
const show = (tree) => {
  if (tree !== null && typeof tree === 'object') {
    const [op] = Object.keys(tree)
    return `(${op} ${tree[op].map(show).join(' ')})`
  }
  return String(tree)
}

const climbed = (parser, name = 'L0') => parser.codegen.ruleIndex.has(name + '$climb')

const outcome = (parser, input) => {
  try {
    return JSON.stringify(parser.parse(input))
  } catch (e) {
    return JSON.stringify([e.name, e.message, e.expected, e.ruleStack, e.offset])
  }
}

describe('what is collapsed', () => {
  it('collapses a line of levels, and keeps a rule of its own for each', () => {
    const parser = createParser(ladder(['left', 'left', 'left']))
    expect(climbed(parser)).toBe(true)
    for (const name of ['L0', 'L1', 'L2']) expect(parser.codegen.ruleIndex.has(name + '$tower')).toBe(true)
  })

  it('leaves a single level alone: there is nothing to collapse', () => {
    expect(climbed(createParser(ladder(['left'])))).toBe(false)
  })

  it('leaves the line alone when two levels can start with the same operator token', () => {
    // A token owned by two levels cannot pick one, and the tower's answer depends on the order they nest.
    const spec = ladder(['left', 'left', 'left'])
    spec.rules.L1.infixLeft.operator = { consume: 'Op0' }
    expect(climbed(createParser(spec))).toBe(false)
  })

  it('leaves the line alone when a level has no operator (juxtaposition)', () => {
    const spec = ladder(['left', 'left', 'left'])
    delete spec.rules.L1.infixLeft.operator
    expect(climbed(createParser(spec))).toBe(false)
  })

  it('does not collapse into a rule that two levels both use as an operand', () => {
    const spec = ladder(['left', 'left', 'left'])
    spec.rules.Side = { infixLeft: { operand: { subrule: 'L2' }, operator: { consume: 'Op5' }, combine: node } }
    spec.rules.Top = { seq: [{ label: ['e', { alt: [{ subrule: 'L0' }, { subrule: 'Side' }] }] }, { consume: 'Semi' }, { action: { val: 'e' } }] }
    const parser = createParser(spec)
    // L2 is the operand of both L1 and Side, so the links into it are cut.
    expect(parser.parse('1 a 2 b 3;')).toEqual(createParser(spec, { precedence: false }).parse('1 a 2 b 3;'))
  })

  it('is off when asked, when memoizing, and without FIRST sets', () => {
    const spec = ladder(['left', 'left', 'left'])
    expect(climbed(createParser(spec, { precedence: false }))).toBe(false)
    expect(climbed(createParser(spec, { memo: true }))).toBe(false)
    expect(climbed(createParser(spec, { ll1: false }))).toBe(false)
  })

  it('is written into an emitted module, and left out when off', () => {
    const spec = ladder(['left', 'right', 'left'])
    expect(emitModule(spec, { runtimeSpecifier: './runtime.js' })).toContain('// L0$climb')
    expect(emitModule(spec, { runtimeSpecifier: './runtime.js', precedence: false })).not.toContain('$climb')
  })
})

describe('the tree it builds', () => {
  const parse = (assoc, input) => show(createParser(ladder(assoc)).parse(input))

  it('binds tighter operators first, whatever order they arrive in', () => {
    // `a` is the loosest operator, `c` the tightest
    expect(parse(['left', 'left', 'left'], '1 a 2 b 3 c 4;')).toBe('(a 1 (b 2 (c 3 4)))')
    expect(parse(['left', 'left', 'left'], '1 c 2 b 3 a 4;')).toBe('(a (b (c 1 2) 3) 4)')
    expect(parse(['left', 'left', 'left'], '1 b 2 c 3 b 4 a 5;')).toBe('(a (b (b 1 (c 2 3)) 4) 5)')
  })

  it('folds a left-associative level to the left', () => {
    expect(parse(['left', 'left'], '1 b 2 b 3;')).toBe('(b (b 1 2) 3)')
    expect(parse(['left', 'left', 'left'], '1 a 2 a 3 a 4;')).toBe('(a (a (a 1 2) 3) 4)')
  })

  it('folds a right-associative level to the right', () => {
    expect(parse(['left', 'right'], '1 b 2 b 3;')).toBe('(b 1 (b 2 3))')
    expect(parse(['right', 'right', 'right'], '1 c 2 c 3 c 4;')).toBe('(c 1 (c 2 (c 3 4)))')
  })

  it('mixes the two, a loose right-associative level over a tight left-associative one', () => {
    expect(parse(['right', 'left'], '1 a 2 a 3 b 4 b 5;')).toBe('(a 1 (a 2 (b (b 3 4) 5)))')
  })

  it('takes a parenthesised expression as an operand and starts over inside it', () => {
    expect(parse(['left', 'left'], '(1 a 2) b 3;')).toBe('(b (a 1 2) 3)')
    expect(parse(['left', 'left'], '1 b (2 a 3 a 4) b 5;')).toBe('(b (b 1 (a (a 2 3) 4)) 5)')
  })

  it('agrees with the plain tower on all of the above', () => {
    const on = createParser(ladder(['left', 'right', 'left']))
    const off = createParser(ladder(['left', 'right', 'left']), { precedence: false })
    for (const input of ['1 a 2 b 3 c 4;', '1 c 2 b 3 b 4 a 5;', '(1 b 2) b 3 c (4 a 5);']) expect(on.parse(input), input).toEqual(off.parse(input))
  })
})

describe('where a parse may start and stop', () => {
  it('stops a level at an operator that belongs to a looser level', () => {
    // Entering at L1 (the `b` level) must not consume `a`, which belongs to L0.
    const spec = ladder(['left', 'left'], { entry: 'L1' })
    const on = createParser(spec)
    const off = createParser(spec, { precedence: false })
    expect(on.parse('1 b 2 b 3;')).toEqual(off.parse('1 b 2 b 3;'))
    expect(outcome(on, '1 b 2 a 3;')).toBe(outcome(off, '1 b 2 a 3;'))
    expect(() => on.parse('1 b 2 a 3;')).toThrow()
  })

  it('ends the whole expression, not just one level, when an operator has nothing on its right', () => {
    const on = createParser(ladder(['left', 'left', 'left']), { strict: false })
    const off = createParser(ladder(['left', 'left', 'left']), { strict: false, precedence: false })
    for (const input of ['1 a;', '1 a 2 b;', '1 a 2 b 3 c;', '1 c;', '1 a 2 b 3 c 4 a']) {
      expect(outcome(on, input), input).toBe(outcome(off, input))
    }
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

// A parse that fails, or leaves tokens over, is repeated with tracking on, and tracking runs the untouched tower.
// So at the top level a wrongly shaped tree is not hidden by a retry only when the retry also succeeds; with
// `strict: false` the first pass is the answer, and any difference in the tree or in where it stops shows.
describe.each([true, false])('collapsing a line does not change what parses or what an error says (strict: %s)', (strict) => {
  const shapes = [
    ['left', 'left', 'left', 'left'],
    ['left', 'right', 'left'],
    ['right', 'right', 'right'],
    ['right', 'left', 'right', 'left', 'left', 'right']
  ]

  shapes.forEach((assoc, index) => {
    it(`on a ladder of ${assoc.join(', ')}`, () => {
      const spec = ladder(assoc)
      const on = createParser(spec, { strict })
      const off = createParser(spec, { strict, precedence: false })
      // Operators of this ladder only, so a fair share of the mutations are still valid expressions.
      const ops = 'abcdef'.slice(0, assoc.length).split('')
      const chain = (names) => names.reduce((text, op, i) => `${text} ${op} ${i + 2}`, '1')
      const pieces = [...ops, ...ops, ' 1 ', '2', '(', ')', ';', ' ']
      const bases = [`${chain(ops)};`, `(${chain(ops.slice(1))}) ${ops[0]} (${chain(ops)} ${ops[0]} 9) ${ops[ops.length - 1]} 6;`]
      let valid = 0
      let invalid = 0
      for (const input of bases.flatMap((base, k) => mutations(base, pieces, 1200, 500 + index * 7 + k))) {
        const a = outcome(on, input)
        expect(a, input).toBe(outcome(off, input))
        if (a.startsWith('[')) invalid++; else valid++
      }
      expect(valid).toBeGreaterThan(100)
      expect(invalid).toBeGreaterThan(100)
    })
  })

  it('on the formula grammar', () => {
    const on = createFormulaParser({ strict })
    const off = createFormulaParser({ strict, precedence: false })
    const pieces = ['(', ')', ',', '+', '-', '*', '/', '^', '&', '=', '<', '>=', '<>', '%', ' ', '1', 'a', 'A1', 'SUM(', '"s"', '.5']
    const bases = ['=1 + 2 * 3', '1 - 2 - 3 - 4', '2 ^ 3 ^ 2', '-1 ^ 2', 'a & b & c', '1 < 2 = 3 >= 4', '(1 + 2) * (3 - 4) / 5 ^ 2', '5% + 10%', 'SUM(1, 2 * 3, 4 & 5) + A1 * 2', '1 + * 2', '1 +']
    bases.forEach((base, i) => {
      for (const input of mutations(base, pieces, 400, 3000 + i)) expect(outcome(on, input), input).toBe(outcome(off, input))
    })
  })

  it('on the SQL grammar, which calls a middle level directly', () => {
    const source = readFileSync(new URL('../examples/sql.gram', import.meta.url), 'utf8')
    const on = createParserFromSource(source, { strict })
    const off = createParserFromSource(source, { strict, precedence: false })
    const pieces = ['(', ')', ',', '+', '-', '*', '/', '||', ' = ', ' < ', ' AND ', ' OR ', ' NOT ', ' IN ', ' BETWEEN ', ' LIKE ', ' IS NULL', '1', 'a', "'s'", ' ']
    const bases = [
      'SELECT a + b * c FROM t WHERE a * b = c AND d - e < 3',
      'SELECT a FROM t WHERE x BETWEEN 1 + 2 AND 3 * 4 OR y IN (1, 2 + 3)',
      'SELECT -a * -b, (a + b) * c, a || b FROM t'
    ]
    bases.forEach((base, i) => {
      for (const input of mutations(base, pieces, 400, 4000 + i)) expect(outcome(on, input), input).toBe(outcome(off, input))
    })
  })
})
