import { describe, it, expect } from 'vitest'
import { createParser } from '../src/index.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'
import calcGrammar from '../examples/calc.js'

/**
 * Compiled mode is the default, so its equivalence to the interpreted path is
 * the property that matters most: the same grammar must accept the same
 * language and produce the same values either way.
 */

const tokens = [
  { name: 'WS', pattern: '\\s+', skip: true },
  { name: 'Int', pattern: '\\d+' },
  { name: 'Word', pattern: '[a-z]+' },
  { name: 'Comma', literal: ',' },
  { name: 'Semi', literal: ';' },
  { name: 'Star', literal: '*' }
]

/** Runs the same source through both modes and asserts they agree. */
function bothAgree (spec, sources, options = {}) {
  const compiled = createParser(spec, { ...options, execution: 'generated' })
  const interpreted = createParser(spec, { ...options, execution: 'interpreted' })

  expect(compiled.compiled).toBe(true)
  expect(interpreted.compiled).toBe(false)

  for (const source of sources) {
    const runOne = (parser) => {
      try {
        return { ok: true, value: JSON.stringify(parser.parse(source)) }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    }
    expect(runOne(interpreted), `source: ${JSON.stringify(source)}`).toEqual(runOne(compiled))
  }
}

describe('compiled and interpreted modes agree', () => {
  it('on the JSON grammar', () => {
    bothAgree(
      jsonGrammar,
      [
        '1', '-2.5e3', '"x"', '"esc\\n"', 'true', 'false', 'null',
        '[]', '{}', '[1,2,3]', '{"a":1,"b":[null,{"c":true}]}',
        '  {  "a" : [ ] }  ',
        // failures must match too, message and all
        '', '{', '[1,]', '{"a"}', '1 2', 'tru'
      ],
      { methods: jsonMethods }
    )
  })

  it('on the arithmetic grammar', () => {
    bothAgree(calcGrammar, [
      '1', '1+2', '2*3+4', '(2+3)*4', '10/4', '-5+2', '--5', '1 + 2 * (3 - 1)',
      '100/5/2', '10-3-2', '', '1+', '(1', '*3'
    ])
  })

  it('on every combinator', () => {
    const specs = [
      { main: { consume: 'Int' } },
      { main: { seq: [{ consume: 'Int' }, { consume: 'Word' }] } },
      { main: { alt: [{ consume: 'Int' }, { consume: 'Word' }] } },
      // overlapping prefixes: no LL(1) table, so both must backtrack
      { main: { alt: [{ seq: [{ consume: 'Int' }, { consume: 'Comma' }] }, { seq: [{ consume: 'Int' }, { consume: 'Semi' }] }] } },
      { main: { many: { consume: 'Int' } } },
      { main: { many1: { consume: 'Int' } } },
      { main: { seq: [{ option: { consume: 'Int' } }, { consume: 'Word' }] } },
      { main: { manySep: { rule: { consume: 'Int' }, sep: 'Comma' } } },
      { main: { many1Sep: { rule: { consume: 'Int' }, sep: 'Comma', trailing: true } } },
      { main: { seq: [{ lookahead: { consume: 'Int' } }, { consume: 'Int' }] } },
      { main: { seq: [{ negLookahead: { consume: 'Word' } }, { consume: 'Int' }] } },
      { main: { text: { seq: [{ consume: 'Int' }, { consume: 'Comma' }, { consume: 'Int' }] } } },
      { main: { seq: [{ epsilon: null }, { consume: 'Int' }] } },
      {
        main: {
          seq: [
            { label: ['a', { consume: 'Int' }] },
            { consume: 'Comma' },
            { label: ['b', { consume: 'Int' }] },
            { action: { '+': [{ val: ['a', 'image'] }, { val: ['b', 'image'] }] } }
          ]
        }
      },
      // an action that climbs to the parser state, which cannot be compiled
      { main: { seq: [{ consume: 'Int' }, { action: { val: [[-1], 'idx'] } }] } },
      // nested scopes
      {
        main: {
          seq: [
            { label: ['a', { consume: 'Int' }] },
            { seq: [{ label: ['a', { consume: 'Int' }] }, { action: { val: ['a', 'image'] } }] },
            { action: { val: ['a', 'image'] } }
          ]
        }
      },
      { main: { seq: [{ consume: 'Int' }, { subrule: 'tail' }] }, tail: { many: { consume: 'Word' } } }
    ]

    const sources = ['', '1', '1 a', '1,2', '1;', '1 2 3', 'a', '1,2,', '1 a b', '1 , 2']
    for (const rules of specs) {
      bothAgree({ tokens, rules, start: 'main' }, sources)
    }
  })

  it('on a recursive grammar', () => {
    const rules = {
      list: {
        alt: [
          {
            seq: [
              { label: ['h', { consume: 'Int' }] },
              { consume: 'Comma' },
              { label: ['t', { subrule: 'list' }] },
              { action: { merge: [[{ val: ['h', 'image'] }], { val: 't' }] } }
            ]
          },
          { seq: [{ label: ['h', { consume: 'Int' }] }, { action: [{ val: ['h', 'image'] }] }] }
        ]
      }
    }
    bothAgree({ tokens, rules, start: 'list' }, ['1', '1,2', '1,2,3', '1,', ''])
  })

  it('with memoization enabled', () => {
    const rules = {
      main: { alt: [{ seq: [{ subrule: 'l' }, { consume: 'Semi' }] }, { subrule: 'l' }] },
      l: { many1Sep: { rule: { consume: 'Int' }, sep: 'Comma' } }
    }
    bothAgree({ tokens, rules, start: 'main' }, ['1', '1,2', '1,2;', ''], { memo: true })
  })

  it('with ll1 dispatch disabled', () => {
    bothAgree(jsonGrammar, ['1', '{"a":[1,2]}', '[1,]'], { methods: jsonMethods, ll1: false })
  })

  it('with strict mode disabled', () => {
    bothAgree({ tokens, rules: { main: { consume: 'Int' } }, start: 'main' }, ['1 2', '1'], { strict: false })
  })
})

describe('compiled mode specifics', () => {
  it('still enforces maxSteps', () => {
    const parser = createParser(
      { tokens, rules: { main: { seq: [{ subrule: 'main' }] } }, start: 'main' },
      { validate: false, maxSteps: 1000 }
    )
    expect(() => parser.parse('1')).toThrow(/maxSteps/)
  })

  it('still detects a zero-consumption loop', () => {
    const parser = createParser({ tokens, rules: { main: { many: { option: { consume: 'Int' } } } }, start: 'main' })
    expect(() => parser.parse('a')).toThrow(/without consuming any input/)
  })

  it('still throws on an unknown rule', () => {
    const parser = createParser(
      { tokens, rules: { main: { subrule: 'ghost' } }, start: 'main' },
      { validate: false }
    )
    expect(() => parser.parse('1')).toThrow(/Unknown rule 'ghost'/)
  })

  it('falls back to interpretation for actions that climb scopes', () => {
    // `{val: [[-1], ...]}` needs `above`, which built functions do not thread.
    const parser = createParser(
      { tokens, rules: { main: { seq: [{ consume: 'Int' }, { action: { val: [[-1], 'idx'] } }] } }, start: 'main' }
    )
    expect(parser.parse('1')).toBe(1)
  })

  it('compiles custom semantic methods', () => {
    const parser = createParser(
      {
        tokens,
        rules: { main: { seq: [{ label: ['n', { consume: 'Int' }] }, { action: { double: { val: ['n', 'image'] } } }] } },
        start: 'main'
      },
      { methods: { double: { method: (image) => Number(image) * 2, optimizeUnary: true } } }
    )
    expect(parser.parse('21')).toBe(42)
  })

  it('reuses one plan across parses without leaking state', () => {
    const parser = createParser(jsonGrammar, { methods: jsonMethods })
    expect(parser.parse('[1,2]')).toEqual([1, 2])
    expect(() => parser.parse('[1,')).toThrow()
    expect(parser.parse('{"a":1}')).toEqual({ a: 1 })
    expect(parser.parse('[1,2]')).toEqual([1, 2])
  })
})
