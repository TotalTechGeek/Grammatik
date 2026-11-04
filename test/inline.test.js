import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

import { createParser, createParserFromSource, parseDefinition, emitModule } from '../src/index.js'

/**
 * Operator-level rules with a single caller are written into that caller's
 * generated function rather than called. That must change nothing a user can
 * see: same values, same errors, same rule stack in an error, same step count.
 */

const tokens = [
  { name: 'WS', pattern: '\\s+', skip: true },
  { name: 'Int', pattern: '[0-9]+' },
  { name: 'Semi', literal: ';' },
  { name: 'Minus', literal: '-' },
  { name: 'Bang', literal: '!' },
  ...Array.from({ length: 20 }, (_, i) => ({ name: 'Op' + i, literal: String.fromCharCode(97 + i) }))
]

/** `levels` infix levels over an Int atom, then a prefix and a postfix level on top. */
function chain (levels) {
  const rules = { Atom: { consume: 'Int' } }
  rules.Post = { postfix: { operand: { subrule: 'Atom' }, suffix: { consume: 'Bang' }, combine: { obj: ['bang', { val: 'left' }] } } }
  rules.Pre = { prefix: { operator: { consume: 'Minus' }, operand: { subrule: 'Post' }, combine: { obj: ['neg', { val: 'operand' }] } } }
  for (let i = 0; i < levels; i++) {
    rules['L' + i] = {
      infixLeft: {
        operand: { subrule: i === levels - 1 ? 'Pre' : 'L' + (i + 1) },
        operator: { consume: 'Op' + i },
        combine: { obj: [{ val: ['op', 'image'] }, [{ val: 'left' }, { val: 'right' }]] }
      }
    }
  }
  rules.Top = { seq: [{ subrule: 'L0' }, { consume: 'Semi' }, { action: { val: [] } }] }
  return { tokens, rules, start: 'Top' }
}

const run = (p, input) => {
  try { return JSON.stringify(p.parse(input)) } catch (e) { return `${e.name}: ${e.message} | ${JSON.stringify(e.ruleStack)}` }
}

describe('inlineRules', () => {
  const inputs = ['1;', '1 a 2;', '1 a 2 b 3;', '-1 a 2! b -3!;', '1 c 2 a 3 t 4;', '1 a;', '1 a 2', ';', '1 z 2;', '- ;', '1 2;']

  for (const levels of [1, 3, 6, 7, 12, 20]) {
    it(`gives identical values and errors, including the rule stack, for ${levels} levels`, () => {
      const spec = chain(levels)
      const on = createParser(spec)
      const off = createParser(spec, { inlineRules: false })
      for (const input of inputs) expect(run(on, input), input).toBe(run(off, input))
    })
  }

  it('inlines only the first copy of an operand: the second, inside the loop, stays a call', () => {
    // `infixLeft` writes its operand twice. Inlining both would multiply a chain's size at every level;
    // the second copy only runs when an operator follows, so it is the one left as a call.
    const calls = (options) => {
      const parser = createParser(chain(5), options)
      const source = parser.codegen.sourceFor('L0')
      return source.split(`R[${parser.codegen.ruleIndex.get('L1')}](c)`).length - 1
    }
    expect(calls({ inlineRules: false })).toBe(2)
    expect(calls({ inlineRules: true })).toBe(1)
  })

  it('does not grow exponentially with the length of the chain', () => {
    // Before the second copy was kept as a call, a six-level chain was 5.0x and a ten-level one 4.7x
    // the size of the same module without inlining, and the formula grammar's module nearly doubled.
    const size = (levels, inlineRules) => emitModule(chain(levels), { runtimeSpecifier: './runtime.js', inlineRules }).length
    expect(size(6, true) / size(6, false)).toBeLessThan(3)
    expect(size(10, true) / size(10, false)).toBeLessThan(4)
  })

  it('is on for a parser built at run time and off for an emitted module, where size is shipped', () => {
    const spec = chain(5)
    const emitted = (options) => emitModule(spec, { runtimeSpecifier: './runtime.js', ...options }).length
    expect(emitted({})).toBe(emitted({ inlineRules: false }))
    expect(emitted({})).toBeLessThan(emitted({ inlineRules: true }))
    const parser = createParser(spec)
    expect(parser.codegen.sourceFor('L0').split(`R[${parser.codegen.ruleIndex.get('L1')}](c)`).length - 1).toBe(1)
  })

  it('counts steps the same way, so maxSteps trips at the same input size', () => {
    const spec = chain(6)
    const input = '1 a 2 b 3 c 4 d 5;'
    const budget = (options) => {
      for (let n = 1; n < 500; n++) {
        try { createParser(spec, { ...options, maxSteps: n }).parse(input); return n } catch (e) { if (!/maxSteps/.test(e.message)) throw e }
      }
      return -1
    }
    expect(budget({ inlineRules: true })).toBe(budget({ inlineRules: false }))
  })

  it('does not inline a rule with more than one caller, or a recursive one', () => {
    const rules = {
      Top: { seq: [{ subrule: 'Sum' }, { subrule: 'Sum' }, { action: { val: [] } }] }, // two callers
      Sum: { infixLeft: { operand: { subrule: 'Atom' }, operator: { consume: 'Op0' }, combine: { obj: ['s', { val: 'left' }] } } },
      Atom: { alt: [{ consume: 'Int' }, { between: { open: { consume: 'Minus' }, body: { subrule: 'Sum' }, close: { consume: 'Bang' } } }] }
    }
    const spec = { tokens, rules, start: 'Top' }
    const on = createParser(spec)
    const off = createParser(spec, { inlineRules: false })
    expect(on.codegen.sourceFor('Top')).toContain('R[')
    for (const input of ['1 a 2 3', '- 1 a 2 ! 3', '- 1 !', '1']) expect(run(on, input), input).toBe(run(off, input))
  })

  for (const file of ['formula.gram', 'sql.gram']) {
    it(`leaves ${file} parsing and failing exactly as before`, () => {
      const source = readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8')
      const methods = file === 'formula.gram' ? undefined : undefined
      const on = createParserFromSource(source, { methods })
      const off = createParserFromSource(source, { methods, inlineRules: false })
      const good = file === 'formula.gram'
        ? ['1 + 2 * 3', '-A1^2 + 5% * (B2 - 3)', 'IF(A1>=10,SUM(B1:B5),ABS(C1)) & "x"']
        : ['SELECT a + b * 2 FROM t WHERE x > 1 AND NOT y IN (1, 2) OR z = 3', 'SELECT -a FROM t']
      const bad = file === 'formula.gram' ? ['1 +', '(1', '1 + * 2', 'IF(']  : ['SELECT a + FROM t', 'SELECT (a FROM t', 'SELECT a FROM t WHERE AND x']
      for (const input of [...good, ...bad]) expect(run(on, input), input).toBe(run(off, input))
    })
  }

  it('does not apply to the interpreted path, which has no generated source to inline into', () => {
    const spec = chain(5)
    const a = createParser(spec, { execution: 'interpreted' })
    const b = createParser(spec, { execution: 'interpreted', inlineRules: false })
    for (const input of inputs) expect(run(a, input), input).toBe(run(b, input))
  })
})
