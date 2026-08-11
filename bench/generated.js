// @ts-check
'use strict'

/**
 * The generated parser file against the other emitted parser for the same
 * language: Peggy's.
 *
 * This is the closest like-for-like comparison in the repo — two parser
 * generators, each handed the same grammar, each producing a JavaScript file,
 * both measured on the same inputs. The runtime-built parser and the Chevrotain
 * implementation are included so the generated file can be placed against them.
 *
 * Generate the file first:
 *   node bench/generate-formula.js
 * then:
 *   node bench/generated.js
 */

import assert from 'node:assert/strict'

import { createParser } from '../src/index.js'
import { grammar as formulaGrammar, createFormulaMethods } from '../examples/formula.js'
import { compile as compilePeggy } from '../../formulas/src/compile.js'
import { compileChevrotain } from '../../formulas/src/grammar.chevrotain.js'
import * as generated from '../.generated/formula-parser.js'

const options = {
  functions: new Set(['SUM', 'IF', 'ABS', 'MAX', 'ROUND']),
  unaryFunctions: new Set(['ABS'])
}

generated.registerMethods(createFormulaMethods(options))
const runtime = createParser(formulaGrammar, { methods: createFormulaMethods(options), positions: 'offset' })

const samples = [
  '=1 + 2 * 3',
  'IF(A1>=10,SUM(B1:B5),ABS(C1))',
  'items[*].price * items[*].quantity',
  '"Total: " & ROUND(subtotal * 1.0825, 2)',
  "'Quarter 1'!$B$2 + MAX({1,2;3,4})",
  'a[*].b[*].c & root[0]["suffix"]'
]

const longParts = new Array(30)
for (let i = 0; i < longParts.length; i++) {
  longParts[i] = `IF(A${i + 1}>=${i},SUM(B${i + 1}:B${i + 4}),ABS(items[${i}].total))`
}
const longSample = longParts.join(' + ')

const parsers = {
  'jl-grammar (generated file)': (source) => generated.parse(source),
  'jl-grammar (built at runtime)': (source) => runtime.parse(source),
  'Peggy (generated file)': (source) => compilePeggy(source, options),
  'Chevrotain (hand-written)': (source) => compileChevrotain(source, options)
}

const names = Object.keys(parsers)

for (const source of [...samples, longSample]) {
  const expected = parsers[names[0]](source)
  for (let i = 1; i < names.length; i++) {
    assert.deepStrictEqual(parsers[names[i]](source), expected, `${names[i]} disagreed on: ${source}`)
  }
}

const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1]

function measure (selectInput, iterations, rounds) {
  const measurements = Object.fromEntries(names.map((name) => [name, []]))

  const warmup = Math.min(iterations, 5000)
  for (const name of names) {
    for (let i = 0; i < warmup; i++) parsers[name](selectInput(i))
  }

  for (let round = 0; round < rounds; round++) {
    for (let offset = 0; offset < names.length; offset++) {
      // Rotate the start order so no entrant is always first or last.
      const name = names[(offset + round) % names.length]
      const parse = parsers[name]
      const started = process.hrtime.bigint()
      for (let i = 0; i < iterations; i++) parse(selectInput(i))
      measurements[name].push(Number(process.hrtime.bigint() - started) / iterations)
    }
  }

  return names.map((name) => ({ name, nanoseconds: median(measurements[name]) }))
}

function report (title, results, baselineName) {
  const baseline = results.find((r) => r.name === baselineName)
  const width = Math.max(...results.map((r) => r.name.length))
  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))
  for (const result of [...results].sort((a, b) => a.nanoseconds - b.nanoseconds)) {
    console.log(
      `  ${result.name.padEnd(width)}  ` +
      `${(1e9 / result.nanoseconds).toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(9)} ops/s  ` +
      `${result.nanoseconds.toFixed(0).padStart(8)} ns/op  ` +
      `${(baseline.nanoseconds / result.nanoseconds).toFixed(2).padStart(5)}x`
    )
  }
  console.log(`  (relative to ${baselineName})`)
}

const rounds = Number.parseInt(process.env.BENCH_ROUNDS || '5', 10)
const shortIterations = Number.parseInt(process.env.BENCH_ITERATIONS || '30000', 10)
const longIterations = Number.parseInt(process.env.BENCH_LONG_ITERATIONS || '500', 10)

console.log(`node ${process.version}; median of ${rounds} interleaved rounds`)
console.log('all four emit deep-equal JSON Logic; timed work is lex + parse + semantic value')

report(
  `${samples.length} rotating formulas (${shortIterations.toLocaleString()} iterations/round)`,
  measure((index) => samples[index % samples.length], shortIterations, rounds),
  'Peggy (generated file)'
)

report(
  `${longSample.length.toLocaleString()}-character formula (${longIterations.toLocaleString()} iterations/round)`,
  measure(() => longSample, longIterations, rounds),
  'Peggy (generated file)'
)

console.log()
