import { describe, it, expect } from 'vitest'
import { createParser } from '../src/index.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'
import calcGrammar from '../examples/calc.js'

/**
 * The generated-source path is the default, and it outruns a mature
 * hand-written parser, so it gets adversarial treatment: every claim it makes
 * is cross-checked against the planner path and against a trusted oracle.
 */

const generated = createParser(jsonGrammar, { methods: jsonMethods })
const planned = createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted' })

const makeRandom = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}

const buildValue = (random, depth) => {
  const roll = random()
  if (depth <= 0 || roll < 0.35) {
    const leaf = random()
    if (leaf < 0.15) return null
    if (leaf < 0.3) return random() < 0.5
    if (leaf < 0.6) return Math.round(random() * 1e6 - 5e5) / (random() < 0.5 ? 1 : 100)
    return ['', 'plain', 'q"q', 'back\\slash', 'nl\nhere', 'tab\there', 'unié☃'][Math.floor(random() * 7)]
  }
  const size = Math.floor(random() * 6)
  if (roll < 0.7) return Array.from({ length: size }, () => buildValue(random, depth - 1))
  const out = {}
  for (let i = 0; i < size; i++) {
    out[['k' + i, '', 'dot.key', 'q"k'][Math.floor(random() * 4)]] = buildValue(random, depth - 1)
  }
  return out
}

describe('generated source', () => {
  it('emits inlined recursive descent, not a call into the planner', () => {
    const source = generated.codegen.sourceFor('value')
    // A switch on the token type is the whole point: no branch is tried.
    expect(source).toMatch(/switch \(/)
    // The terminal test is inlined rather than delegated.
    expect(source).toMatch(/\.type === "String"/)
    // Only semantic actions should fall back to the helper table.
    expect(source).not.toMatch(/H\[\d+\]\(c\)/)
  })

  it('inspecting a parser does not perturb it', () => {
    const parser = createParser(jsonGrammar, { methods: jsonMethods })
    expect(parser.parse('[1,2]')).toEqual([1, 2])
    parser.codegen.sourceFor('value')
    parser.codegen.sourceFor('object')
    expect(parser.parse('[1,2]')).toEqual([1, 2])
    expect(parser.parse('{"a":{"b":[1]}}')).toEqual({ a: { b: [1] } })
  })

  it('publishes generated rules into the engine optimizedMap', () => {
    // The specialization has to be visible to the engine, not hidden in a
    // private cache, or anything reaching the node via engine.run takes the
    // slow lazy wrapper instead.
    const parser = createParser(jsonGrammar, { methods: jsonMethods })
    for (const name of Object.keys(jsonGrammar.rules)) {
      expect(parser.engine.optimizedMap.has(jsonGrammar.rules[name]), name).toBe(true)
    }
  })
})

describe('generated and planned paths agree', () => {
  it('on 600 generated documents, compact and pretty', () => {
    const random = makeRandom(987654321)
    for (let i = 0; i < 300; i++) {
      const value = buildValue(random, 5)
      for (const source of [JSON.stringify(value), JSON.stringify(value, null, 2)]) {
        const expected = JSON.parse(source)
        expect(generated.parse(source), source.slice(0, 80)).toEqual(expected)
        expect(planned.parse(source), source.slice(0, 80)).toEqual(expected)
      }
    }
  })

  const malformed = [
    '', '{', '}', '[', ']', '[1,]', '{,}', '{"a"}', '{"a":}', '1 2', '[1 2]',
    'tru', '{"a":1,}', '[[[', '{"a":{"b":}}', '"unterminated', '[1,,2]', '{"a" 1}', 'nul', '[}', '{]'
  ]

  it('reject the same inputs with the same messages', () => {
    const run = (parser, source) => {
      try {
        parser.parse(source)
        return 'accepted'
      } catch (error) {
        return `${error.constructor.name}: ${error.message}`
      }
    }
    for (const source of malformed) {
      const fromGenerated = run(generated, source)
      expect(fromGenerated, source).not.toBe('accepted')
      expect(run(planned, source), source).toBe(fromGenerated)
    }
  })

  it('report the same rule stacks', () => {
    const stackOf = (parser, source) => {
      try {
        parser.parse(source)
        return null
      } catch (error) {
        return error.ruleStack
      }
    }
    for (const source of ['{"a": [1, {"b": }]}', '{"a" 1}', '[1,']) {
      expect(stackOf(planned, source), source).toEqual(stackOf(generated, source))
    }
  })

  it('on the arithmetic grammar, against JavaScript', () => {
    const random = makeRandom(24680)
    const codegenCalc = createParser(calcGrammar)
    const plannedCalc = createParser(calcGrammar, { execution: 'interpreted' })
    const expr = (depth) => {
      if (depth <= 0 || random() < 0.3) return String(Math.floor(random() * 20) + 1)
      // Parenthesised so `--x` never appears; JavaScript would read that as a
      // decrement, while the grammar correctly reads double negation.
      if (random() < 0.15) return `-(${expr(depth - 1)})`
      return `(${expr(depth - 1)} ${['+', '-', '*'][Math.floor(random() * 3)]} ${expr(depth - 1)})`
    }
    for (let i = 0; i < 200; i++) {
      const source = expr(4)
      // eslint-disable-next-line no-eval
      const expected = eval(source)
      expect(codegenCalc.parse(source), source).toBe(expected)
      expect(plannedCalc.parse(source), source).toBe(expected)
    }
  })

  it('across memo and ll1 option combinations', () => {
    const random = makeRandom(1357)
    const variants = [
      createParser(jsonGrammar, { methods: jsonMethods, memo: true }),
      createParser(jsonGrammar, { methods: jsonMethods, ll1: false }),
      createParser(jsonGrammar, { methods: jsonMethods, memo: true, ll1: false }),
      createParser(jsonGrammar, { methods: jsonMethods, memo: true, execution: 'interpreted' })
    ]
    for (let i = 0; i < 120; i++) {
      const source = JSON.stringify(buildValue(random, 4))
      const expected = JSON.parse(source)
      for (const parser of variants) expect(parser.parse(source), source.slice(0, 80)).toEqual(expected)
    }
  })
})

describe('generated code preserves the guards', () => {
  const tokens = [
    { name: 'WS', pattern: '\\s+', skip: true },
    { name: 'Int', pattern: '\\d+' },
    { name: 'Semi', literal: ';' }
  ]

  it('still enforces maxSteps', () => {
    const parser = createParser(
      { tokens, rules: { main: { seq: [{ subrule: 'main' }] } }, start: 'main' },
      { validate: false, maxSteps: 1000 }
    )
    expect(() => parser.parse('1')).toThrow(/maxSteps/)
  })

  it('still detects a zero-consumption loop', () => {
    const parser = createParser({ tokens, rules: { main: { many: { option: { consume: 'Int' } } } }, start: 'main' })
    expect(() => parser.parse(';')).toThrow(/without consuming any input/)
  })

  it('still memoizes exponential backtracking', () => {
    const depth = 18
    const rules = {}
    for (let i = 0; i < depth; i++) {
      rules['r' + i] = {
        alt: [{ seq: [{ subrule: 'r' + (i + 1) }, { consume: 'Semi' }] }, { subrule: 'r' + (i + 1) }]
      }
    }
    rules['r' + depth] = { consume: 'Int' }
    const spec = { tokens, rules, start: 'r0' }
    expect(createParser(spec, { memo: true, maxSteps: 100000 }).parse('7').image).toBe('7')
    expect(() => createParser(spec, { maxSteps: 100000 }).parse('7')).toThrow(/maxSteps/)
  })
})
