// @ts-check
'use strict'

/**
 * Benchmarks.
 *
 * Each case runs in its own process (see `bench/case.js` for why), so this
 * script is a runner: it spawns, collects, and reports.
 *
 * Two things are being measured, and they are worth keeping separate:
 *
 *  1. jl-grammar against Chevrotain, a mature parser toolkit whose rule bodies
 *     are ordinary JavaScript that V8 JITs directly. A demanding baseline.
 *  2. jl-grammar against itself with compilation, LL(1) dispatch and
 *     memoization toggled, to isolate what each actually buys.
 *
 * `JSON.parse` is a floor, not a target: it is native C++.
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { createParser } from '../src/index.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'
import * as chevrotainJson from './chevrotain-json.js'
import { report, buildDocument } from './harness.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const caseRunner = path.join(here, 'case.js')

/**
 * Runs one case in a fresh process, a few times, and keeps the best result.
 *
 * This machine runs dozens of background node processes (language servers and
 * the like), and a case that catches one occasionally reports an order of
 * magnitude slow. Best-of-N across processes makes the suite robust to that
 * without flattering any particular implementation: every entrant gets the same
 * treatment, and the best run is the one least contaminated by interference.
 */
function run (name, attempts = 3) {
  let best = 0
  for (let i = 0; i < attempts; i++) {
    const output = execFileSync(process.execPath, [caseRunner, name], { encoding: 'utf8' })
    const parsed = JSON.parse(output.trim().split('\n').pop())
    if (parsed.opsPerSec > best) best = parsed.opsPerSec
  }
  return { name, opsPerSec: best, iterations: 0 }
}

/** Runs several cases and relabels them for the report. */
const runAll = (entries) => entries.map(([label, id]) => ({ ...run(id), name: label }))

// ------------------------------------------------------------ correctness ---

const small = buildDocument(10)
const large = buildDocument(1500)

const parsers = {
  compiled: createParser(jsonGrammar, { methods: jsonMethods }),
  interpreted: createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted' }),
  memo: createParser(jsonGrammar, { methods: jsonMethods, memo: true }),
  backtracking: createParser(jsonGrammar, { methods: jsonMethods, ll1: false })
}

for (const [label, payload] of [['small', small], ['large', large]]) {
  const expected = JSON.stringify(JSON.parse(payload))
  for (const [name, parser] of Object.entries(parsers)) {
    if (JSON.stringify(parser.parse(payload)) !== expected) {
      throw new Error(`${name} produced the wrong result on the ${label} payload`)
    }
  }
  if (JSON.stringify(chevrotainJson.parse(payload)) !== expected) {
    throw new Error(`chevrotain produced the wrong result on the ${label} payload`)
  }
}

console.log(`node ${process.version}`)
console.log(`payloads: small ${(small.length / 1024).toFixed(1)} KiB, large ${(large.length / 1024).toFixed(1)} KiB`)
console.log('all parsers agree with JSON.parse; each case timed in its own process\n')

// ------------------------------------------------------------------ report ---

report('JSON, small document (lex + parse + build value)', runAll([
  ['JSON.parse (native)', 'small:native'],
  ['chevrotain', 'small:chevrotain'],
  ['jl-grammar (compiled)', 'small:compiled'],
  ['jl-grammar (interpreted)', 'small:interpreted'],
  ['jl-grammar (compiled + memo)', 'small:memo'],
  ['jl-grammar (backtracking)', 'small:backtracking']
]), 'jl-grammar (compiled)')

report('JSON, large document (lex + parse + build value)', runAll([
  ['JSON.parse (native)', 'large:native'],
  ['chevrotain', 'large:chevrotain'],
  ['jl-grammar (compiled)', 'large:compiled'],
  ['jl-grammar (interpreted)', 'large:interpreted'],
  ['jl-grammar (compiled + memo)', 'large:memo'],
  ['jl-grammar (backtracking)', 'large:backtracking'],
  ['jl-grammar (compiled, offsets only)', 'large:offsets']
]), 'jl-grammar (compiled)')

// Both lexers record line and column here. Chevrotain's cheaper `onlyOffset`
// mode is shown too, since position tracking is a real slice of the cost.
report('JSON, large document — lexing only', runAll([
  ['chevrotain lexer (onlyOffset)', 'lex:chevrotain-offset'],
  ['chevrotain lexer (full line+col)', 'lex:chevrotain-full'],
  ['jl-grammar lexer (full line+col)', 'lex:jl'],
  ['jl-grammar lexer (offsets only)', 'lex:jl-offset']
]), 'jl-grammar lexer (full line+col)')

report('JSON, large document — parsing only (pre-lexed)', runAll([
  ['chevrotain parser', 'parse:chevrotain'],
  ['jl-grammar parser (compiled)', 'parse:compiled'],
  ['jl-grammar parser (interpreted)', 'parse:interpreted']
]), 'jl-grammar parser (compiled)')

report('Exponential backtracking, depth 15 (2^15 leaf visits unmemoized)', runAll([
  ['jl-grammar (no memo)', 'exp:nomemo'],
  ['jl-grammar (memo)', 'exp:memo']
]), 'jl-grammar (no memo)')

report('Arithmetic expressions (action on every node)', runAll([
  ['jl-grammar (compiled)', 'calc:compiled'],
  ['jl-grammar (interpreted)', 'calc:interpreted'],
  ['jl-grammar (compiled + memo)', 'calc:memo']
]), 'jl-grammar (compiled)')

console.log()
