import { describe, it, expect } from 'vitest'
import { createParser } from '../src/index.js'
import grammar from '../examples/calc.js'

const parser = createParser(grammar)

describe('calculator grammar', () => {
  const cases = [
    ['1', 1],
    ['1+2', 3],
    ['1 + 2 + 3', 6],
    ['2*3', 6],
    ['2+3*4', 14],
    ['2*3+4', 10],
    ['(2+3)*4', 20],
    ['10/4', 2.5],
    ['-5', -5],
    ['-5+2', -3],
    ['--5', 5],
    ['-(2+3)', -5],
    ['1 + 2 * (3 - 1)', 5],
    ['1.5*2', 3],
    ['((((7))))', 7]
  ]

  for (const [source, expected] of cases) {
    it(`${source} = ${expected}`, () => {
      expect(parser.parse(source)).toBe(expected)
    })
  }

  it('is left-associative for subtraction', () => {
    // Right association would give 8, which is the classic fold-direction bug.
    expect(parser.parse('10-3-2')).toBe(5)
  })

  it('is left-associative for division', () => {
    expect(parser.parse('100/5/2')).toBe(10)
  })

  it('agrees with JavaScript on a batch of generated expressions', () => {
    let seed = 4242
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const expr = (depth) => {
      if (depth <= 0 || random() < 0.3) return String(Math.floor(random() * 20) + 1)
      const op = ['+', '-', '*'][Math.floor(random() * 3)]
      return `(${expr(depth - 1)} ${op} ${expr(depth - 1)})`
    }
    for (let i = 0; i < 200; i++) {
      const source = expr(4)
      // eslint-disable-next-line no-eval
      expect(parser.parse(source), `failed on ${source}`).toBe(eval(source))
    }
  })

  const invalid = ['', '1+', '+1', '(1', '1)', '1 2', '*3', '()']
  for (const source of invalid) {
    it(`rejects ${JSON.stringify(source)}`, () => {
      expect(() => parser.parse(source)).toThrow()
    })
  }

  it('rejects an unknown character at the lexer', () => {
    expect(() => parser.parse('1 $ 2')).toThrow(/Unexpected character/)
  })
})
