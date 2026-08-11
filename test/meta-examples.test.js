import { readFile } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import { createParser } from '../src/index.js'
import { createDefinitionParser } from '../src/index.js'
import arithmeticGrammar from '../examples/calc.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'

const arithmeticSource = await readFile(new URL('../examples/arithmetic.jlg', import.meta.url), 'utf8')
const jsonSource = await readFile(new URL('../examples/json.jlg', import.meta.url), 'utf8')
const metaCompiled = createDefinitionParser()
const metaInterpreted = createDefinitionParser({ execution: 'interpreted' })

function expectGrammarParity(source, expected, compiled) {
  const interpreted = metaInterpreted.parse(source)
  expect(compiled.tokens).toEqual(expected.tokens)
  expect(compiled.rules).toEqual(expected.rules)
  expect(compiled.start).toBe(expected.start)
  expect(interpreted).toEqual(compiled)
  expect(JSON.parse(JSON.stringify(compiled))).toEqual(compiled)
}

describe('hosted arithmetic grammar', () => {
  const generated = metaCompiled.parse(arithmeticSource)
  const compiled = createParser(JSON.parse(JSON.stringify(generated)))
  const interpreted = createParser(JSON.parse(JSON.stringify(generated)), { execution: 'interpreted' })

  it('emits the hand-authored serializable grammar', () => {
    expectGrammarParity(arithmeticSource, arithmeticGrammar, generated)
  })

  it('evaluates identically in generated and planned modes', () => {
    const cases = [
      ['1 + 2 * 3', 7],
      ['10-3-2', 5],
      ['100/5/2', 10],
      ['-(2+3)*4', -20],
      ['--5 + 1.5*2', 8]
    ]
    for (let i = 0; i < cases.length; i++) {
      const [source, expected] = cases[i]
      expect(compiled.parse(source), source).toBe(expected)
      expect(interpreted.parse(source), `interpreted: ${source}`).toBe(expected)
    }
  })
})

describe('hosted JSON grammar', () => {
  const generated = metaCompiled.parse(jsonSource)
  const compiled = createParser(JSON.parse(JSON.stringify(generated)), { methods: jsonMethods })
  const interpreted = createParser(JSON.parse(JSON.stringify(generated)), { methods: jsonMethods, execution: 'interpreted' })

  it('emits the hand-authored serializable grammar', () => {
    expectGrammarParity(jsonSource, jsonGrammar, generated)
  })

  it('matches JSON.parse in generated and planned modes', () => {
    const cases = [
      'null',
      '-1.5e3',
      '"escaped\\nstring"',
      '[]',
      '{}',
      '[1,true,null,{"x":"y"}]',
      '{"nested":{"deep":[1,2,3]}}'
    ]
    for (let i = 0; i < cases.length; i++) {
      const source = cases[i]
      const expected = JSON.parse(source)
      expect(compiled.parse(source), source).toEqual(expected)
      expect(interpreted.parse(source), `interpreted: ${source}`).toEqual(expected)
    }
  })
})
