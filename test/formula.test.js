import { describe, it, expect } from 'vitest'
import { createFormulaParser } from '../examples/formula.js'

const options = {
  functions: new Set(['SUM', 'IF', 'ABS', 'FOO.BAR']),
  unaryFunctions: new Set(['ABS'])
}

const cases = [
  ['=1 + 2 * 3', { '+': [1, { '*': [2, 3] }] }],
  ['1 < 2 = TRUE', { '==': [{ '<': [1, 2] }, true] }],
  ['a & b & "!"', { CONCAT: [{ val: 'a' }, { val: 'b' }, '!'] }],
  ['10 - 3 - 2', { '-': [{ '-': [10, 3] }, 2] }],
  ['20 / 2 * 3', { '*': [{ '/': [20, 2] }, 3] }],
  ['2^3^2', { POWER: [{ POWER: [2, 3] }, 2] }],
  ['-2^2', { POWER: [{ '-': [2] }, 2] }],
  ['+5%%', { '/': [{ '/': [5, 100] }, 100] }],
  ['SUM()', { SUM: [] }],
  ['SUM(1,,3)', { SUM: [1, null, 3] }],
  ['IF(a,,b)', { IF: [{ val: 'a' }, null, { val: 'b' }] }],
  ['ABS(x)', { ABS: { val: 'x' } }],
  ['FOO.BAR(1)', { 'FOO.BAR': [1] }],
  ['1. + .5e2', { '+': [1, 50] }],
  ['"a""b"', 'a"b'],
  ['false', false],
  ['#DIV/0!', { ERRORVALUE: ['#DIV/0!'] }],
  ['{1,2}', { preserve: [1, 2] }],
  ['{1,2;3,4}', { preserve: [[1, 2], [3, 4]] }],
  ['A1:B3', { RANGE: ['A1', 'B3'] }],
  ['Sheet1!A1:B3', { RANGE: ['A1', 'B3', { preserve: ['Sheet1'] }] }],
  ["'My Sheet'!$b$2", { val: ['My Sheet', 'B2'] }],
  ['$A$1', { val: 'A1' }],
  ['a.b.c', { val: ['a', 'b', 'c'] }],
  ['root[0]["key"]', { val: ['root', 0, 'key'] }],
  ['[Total Sales]', { val: 'Total Sales' }],
  ['items[*].total', { merge: { map: [{ val: 'items' }, { val: 'total' }] } }],
  ['a[*].b[*].c', {
    merge: {
      map: [
        { val: 'a' },
        { merge: { map: [{ val: 'b' }, { val: 'c' }] } }
      ]
    }
  }]
]

describe('formula grammar', () => {
  it('emits JSON Logic identically when compiled or interpreted', () => {
    const compiled = createFormulaParser(options)
    const interpreted = createFormulaParser({ ...options, execution: 'interpreted' })
    for (let i = 0; i < cases.length; i++) {
      const [source, expected] = cases[i]
      expect(compiled.parse(source), source).toEqual(expected)
      expect(interpreted.parse(source), `interpreted: ${source}`).toEqual(expected)
    }
  })

  it('validates known functions and malformed input', () => {
    const parser = createFormulaParser(options)
    expect(() => parser.parse('NOPE(1)')).toThrow(/Unknown function NOPE/)
    const malformed = ['1 +', 'SUM(1', '{1,}', 'A1:', '"unterminated']
    for (let i = 0; i < malformed.length; i++) {
      expect(() => parser.parse(malformed[i]), malformed[i]).toThrow()
    }
  })
})
