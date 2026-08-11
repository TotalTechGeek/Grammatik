// @ts-check
'use strict'

/**
 * Verifies `execution: 'interpreted'` really generates no code.
 *
 * Run under `--disallow-code-generation-from-strings`, which makes `eval` and
 * `new Function` throw — the same restriction a Content-Security-Policy without
 * `unsafe-eval` imposes in a browser. Asserting it this way is stronger than
 * mocking: nothing can slip through, including inside json-logic-engine.
 *
 *   npm run test:csp
 */

import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

import { createParser } from '../src/index.js'
import { createFormulaParser } from '../examples/formula.js'
import { createDefinitionParser } from '../src/index.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'

assert.throws(() => new Function('return 1'), 'code generation must be blocked for this check to mean anything')

const checks = []

// A grammar with custom semantic methods.
const json = createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted' })
assert.deepEqual(json.parse('{"a":[1,true,null,"x"],"b":{"c":-1.5e3}}'), { a: [1, true, null, 'x'], b: { c: -1500 } })
assert.equal(json.compiled, false, "execution: 'interpreted' must not generate rule functions")
checks.push('JSON grammar')

// The formula grammar: 36 semantic actions, all interpreted here.
const formula = createFormulaParser({
  functions: new Set(['SUM', 'IF', 'ABS']),
  unaryFunctions: new Set(['ABS']),
  execution: 'interpreted'
})
assert.deepEqual(formula.parse('IF(A1>=10,SUM(B1:B5),ABS(C1))'), {
  IF: [{ '>=': [{ val: 'A1' }, 10] }, { SUM: [{ RANGE: ['B1', 'B5'] }] }, { ABS: { val: 'C1' } }]
})
checks.push('formula grammar')

// The grammar-definition language, then a grammar loaded from a file as data.
const meta = createDefinitionParser({ execution: 'interpreted' })
const source = await readFile(new URL('../examples/arithmetic.jlg', import.meta.url), 'utf8')
const grammar = JSON.parse(JSON.stringify(meta.parse(source)))
assert.equal(createParser(grammar, { execution: 'interpreted' }).parse('5*3+2*5-1'), 24)
checks.push('meta-grammar and a .jlg file')

// Errors still report properly (the failure path re-parses with tracking on).
assert.throws(() => json.parse('{"a" 1}'), /Expecting Colon/)
checks.push('error reporting')

// Memoization and backtracking variants.
assert.deepEqual(
  createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted', memo: true, ll1: false }).parse('[1,{"a":2}]'),
  [1, { a: 2 }]
)
checks.push('memo and backtracking')

console.log(`no code generation: ${checks.join(', ')}`)
