import { readFile } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import { createParser } from '../src/index.js'
import { createDefinitionParser } from '../src/index.js'
import { grammar, createFormulaMethods } from '../examples/formula.js'

const definition = await readFile(new URL('../examples/formula.jlg', import.meta.url), 'utf8')
const metaCompiled = createDefinitionParser()
const metaInterpreted = createDefinitionParser({ execution: 'interpreted' })
const generated = metaCompiled.parse(definition)

const options = {
  functions: new Set(['SUM', 'IF', 'ABS']),
  unaryFunctions: new Set(['ABS'])
}

const cases = [
  ['=1 + 2 * 3', { '+': [1, { '*': [2, 3] }] }],
  ['2^3^2', { POWER: [{ POWER: [2, 3] }, 2] }],
  ['SUM(1,,3)', { SUM: [1, null, 3] }],
  ['ABS(x)', { ABS: { val: 'x' } }],
  ['{1,2;3,4}', { preserve: [[1, 2], [3, 4]] }],
  ["'My Sheet'!$b$2", { val: ['My Sheet', 'B2'] }],
  ['root[0]["key"]', { val: ['root', 0, 'key'] }],
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

describe('grammar-definition bootstrap', () => {
  it('meta-parses Sheetlang into the hand-authored serializable grammar', () => {
    const interpreted = metaInterpreted.parse(definition)
    expect(generated.name).toBe('Sheetlang')
    expect(generated.tokens).toEqual(grammar.tokens)
    expect(generated.rules).toEqual(grammar.rules)
    expect(generated.start).toBe(grammar.start)
    expect(interpreted).toEqual(generated)
    expect(JSON.parse(JSON.stringify(generated))).toEqual(generated)
  })

  it('uses the emitted grammar in compiled and interpreted modes', () => {
    const serialized = JSON.parse(JSON.stringify(generated))
    const methods = createFormulaMethods(options)
    const compiled = createParser(serialized, { methods })
    const interpreted = createParser(serialized, { methods, execution: 'interpreted' })
    for (let i = 0; i < cases.length; i++) {
      const [source, expected] = cases[i]
      expect(compiled.parse(source), source).toEqual(expected)
      expect(interpreted.parse(source), `interpreted: ${source}`).toEqual(expected)
    }
  })
})
