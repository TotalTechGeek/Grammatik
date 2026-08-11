import { describe, it, expect } from 'vitest'
import { createParser } from '../src/index.js'
import { grammar, methods } from '../examples/json.js'
import { buildDispatch } from '../src/analyze.js'

const parser = createParser(grammar, { methods })
const memoParser = createParser(grammar, { methods, memo: true })

describe('JSON grammar', () => {
  const cases = [
    '1', '0', '-1', '1.5', '-1.5e3', '1E+2',
    '"hello"', '""', '"a\\nb"', '"\\u00e9"', '"quote:\\""', '"sl\\\\ash"',
    'true', 'false', 'null',
    '[]', '[1]', '[1,2,3]', '[[],[[]]]',
    '{}', '{"a":1}', '{"a":1,"b":2}',
    '{"nested":{"deep":[1,{"x":null}]}}',
    '  {  "a" :  [ 1 , 2 ]  }  ',
    '{"":0}', '{"a.b":1}', '{"dup":1,"dup":2}'
  ]

  for (const source of cases) {
    it(`matches JSON.parse for ${source.trim()}`, () => {
      expect(parser.parse(source)).toEqual(JSON.parse(source))
    })
  }

  it('produces the same results with memoization enabled', () => {
    for (const source of cases) {
      expect(memoParser.parse(source)).toEqual(JSON.parse(source))
    }
  })

  it('handles deep nesting', () => {
    const deep = '['.repeat(200) + ']'.repeat(200)
    expect(parser.parse(deep)).toEqual(JSON.parse(deep))
  })

  it('is reusable across parses without state leaking', () => {
    expect(parser.parse('[1]')).toEqual([1])
    expect(parser.parse('{"a":2}')).toEqual({ a: 2 })
    expect(parser.parse('[1]')).toEqual([1])
  })

  const invalid = ['', '{', '}', '[', ']', '[1,]', '{,}', '{"a"}', '{"a":}', '1 2', '[1 2]', 'tru', '{"a":1,}']
  for (const source of invalid) {
    it(`rejects ${JSON.stringify(source)}`, () => {
      expect(() => parser.parse(source)).toThrow()
      expect(() => JSON.parse(source)).toThrow()
    })
  }

  it('collapses the seven-way value choice into an LL(1) dispatch table', () => {
    // This is the property the whole design rests on: no branch of `value` is
    // ever speculatively tried and rolled back.
    const table = buildDispatch(grammar.rules.value.alt, parser.analysis.firsts)
    expect(table).not.toBeNull()
    expect([...table.keys()].sort()).toEqual(
      ['False', 'LCurly', 'LSquare', 'Null', 'Number', 'String', 'True']
    )
  })
})

describe('JSON differential fuzz', () => {
  // A small deterministic PRNG keeps failures reproducible.
  const makeRandom = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }

  const build = (random, depth) => {
    const roll = random()
    if (depth <= 0 || roll < 0.35) {
      const leaf = random()
      if (leaf < 0.2) return null
      if (leaf < 0.4) return random() < 0.5
      if (leaf < 0.7) return Math.round(random() * 2000 - 1000)
      return ['plain', 'with "quote"', 'tab\there', 'nl\nhere', 'unié', ''][Math.floor(random() * 6)]
    }
    const size = Math.floor(random() * 5)
    if (roll < 0.7) return Array.from({ length: size }, () => build(random, depth - 1))
    const out = {}
    for (let i = 0; i < size; i++) out['k' + i] = build(random, depth - 1)
    return out
  }

  it('round-trips 300 generated documents', () => {
    const random = makeRandom(20260811)
    for (let i = 0; i < 300; i++) {
      const value = build(random, 4)
      const source = JSON.stringify(value)
      expect(parser.parse(source), `failed on ${source}`).toEqual(JSON.parse(source))
    }
  })

  it('round-trips pretty-printed documents with varied whitespace', () => {
    const random = makeRandom(777)
    for (let i = 0; i < 100; i++) {
      const source = JSON.stringify(build(random, 4), null, 2)
      expect(parser.parse(source), `failed on ${source}`).toEqual(JSON.parse(source))
    }
  })
})
