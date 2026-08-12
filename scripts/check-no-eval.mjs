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

import { createParser, createDefinitionParser, parseDefinition, evaluateMethodsBlock } from '../src/index.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'

assert.throws(() => new Function('return 1'), 'code generation must be blocked for this check to mean anything')

const checks = []

// A grammar with custom semantic methods.
const json = createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted' })
assert.deepEqual(json.parse('{"a":[1,true,null,"x"],"b":{"c":-1.5e3}}'), { a: [1, true, null, 'x'], b: { c: -1500 } })
assert.equal(json.compiled, false, "execution: 'interpreted' must not generate rule functions")
checks.push('JSON grammar')

// A grammar read from a `.gram` at run time, with methods supplied by the host:
// 30-odd rules and every action interpreted, none of it generating code.
const jsonSource = await readFile(new URL('../examples/json.gram', import.meta.url), 'utf8')
const fromFile = createParser(parseDefinition(jsonSource, { execution: 'interpreted' }), {
  methods: jsonMethods,
  execution: 'interpreted'
})
assert.deepEqual(fromFile.parse('{"a":[1,{"b":null}],"c":true}'), { a: [1, { b: null }], c: true })
checks.push('a .gram parsed and run as data')

// A `methods { ... }` block is the one part of a `.gram` that cannot be used
// here: turning it into functions needs `new Function`. That is why
// `examples/formula.js` is not imported by this script, and why blocks are
// documented as a build-time feature — `grammatik generate` writes the block
// out as source, and the resulting parser needs no eval at all.
const formulaSource = await readFile(new URL('../examples/formula.gram', import.meta.url), 'utf8')
const formulaGrammar = parseDefinition(formulaSource, { execution: 'interpreted' })
assert.ok(formulaGrammar.methodsBlock, 'the formula grammar should carry a methods block')
assert.equal(formulaGrammar.rules.Formula.seq.length, 3, 'the grammar itself still parses without eval')
assert.throws(() => evaluateMethodsBlock(formulaGrammar.methodsBlock), /Code generation/)
checks.push('a methods block refused, as documented')

// The grammar-definition language, then a grammar loaded from a file as data.
const meta = createDefinitionParser({ execution: 'interpreted' })
const source = await readFile(new URL('../examples/arithmetic.gram', import.meta.url), 'utf8')
const grammar = JSON.parse(JSON.stringify(meta.parse(source)))
assert.equal(createParser(grammar, { execution: 'interpreted' }).parse('5*3+2*5-1'), 24)
checks.push('meta-grammar and a .gram file')

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
