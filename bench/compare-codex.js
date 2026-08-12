// @ts-check
'use strict'

/**
 * Head-to-head against jl-grammar-codex, a separate implementation of the same
 * idea (a serializable Chevrotain-like grammar run on json-logic-engine).
 *
 * Both projects independently landed on the same two core ideas — `lazy`
 * combinators plus `compile` hooks that hand specialized closures to the
 * engine's compiler, and first-character dispatch in the lexer — so this is a
 * genuine like-for-like comparison rather than a comparison of strategies.
 *
 * The grammars are written to produce identical output, and that is asserted
 * before any timing runs. Chevrotain and `JSON.parse` are included for scale.
 *
 * Run with: node bench/compare-codex.js
 */

import { createParser } from '../src/index.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'
import calcGrammar from '../examples/calc.js'
import * as chevrotainJson from './chevrotain-json.js'
import { buildParser as buildCodexJson } from './codex-json.js'
import { measure, report, buildDocument } from './harness.js'

import { createParser as createCodexParser } from '../../jl-grammar-codex/src/index.js'
import { arithmeticGrammar } from '../../jl-grammar-codex/examples/arithmetic.js'

const small = buildDocument(10)
const large = buildDocument(1500)

console.log(`node ${process.version}`)
console.log(`payloads: small ${(small.length / 1024).toFixed(1)} KiB, large ${(large.length / 1024).toFixed(1)} KiB`)

// ------------------------------------------------------------------ setup ---

const mine = createParser(jsonGrammar, { methods: jsonMethods })
const mineInterpreted = createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted' })
const codex = buildCodexJson()
const codexInterpreted = buildCodexJson({ compiled: false })

// `parse` returns a result object rather than throwing, so unwrap it.
const runCodex = (parser, text) => {
  const result = parser.parse(text)
  if (!result.success) throw result.errors[0]
  return result.value
}

// ------------------------------------------------------------ correctness ---

for (const [label, payload] of [['small', small], ['large', large]]) {
  const expected = JSON.stringify(JSON.parse(payload))
  const checks = [
    ['grammatik (compiled)', () => mine.parse(payload)],
    ['grammatik (interpreted)', () => mineInterpreted.parse(payload)],
    ['codex (compiled)', () => runCodex(codex, payload)],
    ['codex (interpreted)', () => runCodex(codexInterpreted, payload)],
    ['chevrotain', () => chevrotainJson.parse(payload)]
  ]
  for (const [name, fn] of checks) {
    if (JSON.stringify(fn()) !== expected) {
      throw new Error(`${name} produced the wrong result on the ${label} payload`)
    }
  }
}
console.log('all parsers produce identical output\n')

// ------------------------------------------------------------------- JSON ---

report('JSON, small document (lex + parse + build value)', [
  measure('JSON.parse (native)', () => JSON.parse(small)),
  measure('chevrotain', () => chevrotainJson.parse(small)),
  measure('grammatik (compiled)', () => mine.parse(small)),
  measure('codex (compiled)', () => runCodex(codex, small)),
  measure('grammatik (interpreted)', () => mineInterpreted.parse(small)),
  measure('codex (interpreted)', () => runCodex(codexInterpreted, small))
], 'grammatik (compiled)')

report('JSON, large document (lex + parse + build value)', [
  measure('JSON.parse (native)', () => JSON.parse(large)),
  measure('chevrotain', () => chevrotainJson.parse(large)),
  measure('grammatik (compiled)', () => mine.parse(large)),
  measure('codex (compiled)', () => runCodex(codex, large)),
  measure('grammatik (interpreted)', () => mineInterpreted.parse(large)),
  measure('codex (interpreted)', () => runCodex(codexInterpreted, large))
], 'grammatik (compiled)')

report('JSON, large document — lexing only', [
  measure('chevrotain lexer', () => chevrotainJson.lexer.tokenize(large)),
  measure('grammatik lexer', () => mine.tokenize(large)),
  measure('codex lexer', () => codex.tokenize(large))
], 'grammatik lexer')

// ------------------------------------------------------------- arithmetic ---

// Codex's bundled arithmetic grammar has no unary minus, so the shared input
// avoids it. Both grammars evaluate as they parse.
const calcInput = Array.from({ length: 60 }, (_, i) => `(${i + 1} + ${i * 2 + 1} * 3 / 2)`).join(' + ')

const myCalc = createParser(calcGrammar)
const codexCalc = createCodexParser(arithmeticGrammar)

const myCalcResult = myCalc.parse(calcInput)
const codexCalcResult = runCodex(codexCalc, calcInput)
// eslint-disable-next-line no-eval
const expectedCalc = eval(calcInput)
if (myCalcResult !== expectedCalc || codexCalcResult !== expectedCalc) {
  throw new Error(`arithmetic mismatch: mine=${myCalcResult} codex=${codexCalcResult} expected=${expectedCalc}`)
}
console.log(`\narithmetic grammars agree (= ${expectedCalc})`)

report('Arithmetic expressions (action on every node)', [
  measure('grammatik (compiled)', () => myCalc.parse(calcInput)),
  measure('codex (compiled)', () => runCodex(codexCalc, calcInput))
], 'grammatik (compiled)')

console.log()
