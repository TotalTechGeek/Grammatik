import { readFile } from 'node:fs/promises'
import { describe, it, expect } from 'vitest'
import { createParser, parseDefinition } from '../src/index.js'
import { grammar, createFormulaMethods } from '../examples/formula.js'

/**
 * The definition language, bootstrapped on the largest grammar here.
 *
 * This test used to assert that `formula.gram` and a hand-written JavaScript twin
 * produced the same structure. They did, because someone kept them agreeing;
 * the twin is gone and the `.gram` is the only copy. What is left is the part
 * that was always load-bearing: both execution modes of the meta-parser must
 * agree, the result must survive a JSON round trip, and the grammar must still
 * produce exactly these trees.
 *
 * That last list is what guards the `obj` conversion. Several rules build their
 * node with computed keys as data now instead of calling into JavaScript, and
 * the outputs below did not move.
 */

const definition = await readFile(new URL('../examples/formula.gram', import.meta.url), 'utf8')
// `parseDefinition` rather than the definition parser directly: the file ends
// with a `methods` block, which is separated out before the language sees it.
const generated = parseDefinition(definition)

const options = {
  functions: new Set(['SUM', 'IF', 'ABS']),
  unaryFunctions: new Set(['ABS'])
}

const cases = [
  ['=1 + 2 * 3', { '+': [1, { '*': [2, 3] }] }],
  ['2^3^2', { POWER: [{ POWER: [2, 3] }, 2] }],
  ['a >= 10', { '>=': [{ val: 'a' }, 10] }],
  ['5%', { '/': [5, 100] }],
  ['#DIV/0!', { ERRORVALUE: ['#DIV/0!'] }],
  ['-x', { '-': [{ val: 'x' }] }],
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
  it('meta-parses Sheetlang the same way in both execution modes', () => {
    expect(generated.name).toBe('Sheetlang')
    expect(parseDefinition(definition, { execution: 'interpreted' })).toEqual(generated)
  })

  it('produces something JSON can round-trip', () => {
    expect(JSON.parse(JSON.stringify(generated))).toEqual(generated)
  })

  it('is the same grammar the example module exports', () => {
    // The example loads this file rather than restating it, so this is a check
    // that the loader is honest, not that two copies agree.
    expect(generated.rules).toEqual(grammar.rules)
    expect(generated.tokens).toEqual(grammar.tokens)
  })

  it('uses the emitted grammar in compiled and interpreted modes', () => {
    const serialized = JSON.parse(JSON.stringify(generated))
    const methods = createFormulaMethods(options)
    const compiled = createParser(serialized, { methods })
    const interpreted = createParser(serialized, { methods, execution: 'interpreted' })
    for (const [source, expected] of cases) {
      expect(compiled.parse(source), source).toEqual(expected)
      expect(interpreted.parse(source), `interpreted: ${source}`).toEqual(expected)
    }
  })

  it('builds nodes with computed keys as data, not JavaScript', () => {
    // The methods that used to do this are gone; if one comes back, this fails.
    const methods = Object.keys(createFormulaMethods(options))
    for (const gone of ['formula.binary', 'formula.power2', 'formula.percent', 'formula.error']) {
      expect(methods, `${gone} should no longer exist`).not.toContain(gone)
    }
    expect(definition).toContain('"obj"')
  })
})
