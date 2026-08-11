// @ts-check
'use strict'

/**
 * Runs exactly one benchmark case and prints its result as JSON, then exits.
 *
 * Cases are run in separate processes because measuring them in sequence inside
 * one process is not trustworthy here. After the first heavy case completes,
 * every later measurement of a token-allocating function reported ~150x slower
 * than the same function timed on its own — reproducibly, and independently of
 * how the driving loop was written (inline, closure factory, or `new Function`)
 * and of `--no-allocation-site-pretenuring`. Whatever the mechanism, a fresh
 * process per case sidesteps it, and repeated runs agree to about 1%.
 *
 * Usage: node bench/case.js <case-name>
 */

import { createParser } from '../src/index.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'
import calcGrammar from '../examples/calc.js'
import * as chevrotainJson from './chevrotain-json.js'
import { measure, buildDocument } from './harness.js'

const small = buildDocument(10)
const large = buildDocument(1500)

/** Lazily built so a case only pays for what it uses. */
const build = {
  compiled: () => createParser(jsonGrammar, { methods: jsonMethods }),
  interpreted: () => createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted' }),
  memo: () => createParser(jsonGrammar, { methods: jsonMethods, memo: true }),
  backtracking: () => createParser(jsonGrammar, { methods: jsonMethods, ll1: false }),
  offsets: () => createParser(jsonGrammar, { methods: jsonMethods, positions: 'offset' })
}

const exponentialSpec = (depth) => {
  const rules = {}
  for (let i = 0; i < depth; i++) {
    rules['r' + i] = {
      alt: [{ seq: [{ subrule: 'r' + (i + 1) }, { consume: 'Semi' }] }, { subrule: 'r' + (i + 1) }]
    }
  }
  rules['r' + depth] = { consume: 'Int' }
  return {
    tokens: [
      { name: 'WS', pattern: '\\s+', skip: true },
      { name: 'Int', pattern: '\\d+' },
      { name: 'Comma', literal: ',' },
      { name: 'Semi', literal: ';' }
    ],
    rules,
    start: 'r0'
  }
}

const calcInput = Array.from({ length: 60 }, (_, i) => `(${i} + ${i * 2} * 3 - ${i % 7})`).join(' + ')

/** @type {Record<string, () => () => any>} */
const cases = {
  'small:native': () => () => JSON.parse(small),
  'small:chevrotain': () => () => chevrotainJson.parse(small),
  'small:compiled': () => { const p = build.compiled(); return () => p.parse(small) },
  'small:interpreted': () => { const p = build.interpreted(); return () => p.parse(small) },
  'small:memo': () => { const p = build.memo(); return () => p.parse(small) },
  'small:backtracking': () => { const p = build.backtracking(); return () => p.parse(small) },

  'large:native': () => () => JSON.parse(large),
  'large:chevrotain': () => () => chevrotainJson.parse(large),
  'large:compiled': () => { const p = build.compiled(); return () => p.parse(large) },
  'large:interpreted': () => { const p = build.interpreted(); return () => p.parse(large) },
  'large:memo': () => { const p = build.memo(); return () => p.parse(large) },
  'large:backtracking': () => { const p = build.backtracking(); return () => p.parse(large) },

  'lex:chevrotain-offset': () => () => chevrotainJson.lexerOnlyOffset.tokenize(large),
  'lex:chevrotain-full': () => () => chevrotainJson.lexer.tokenize(large),
  'lex:jl': () => { const p = build.compiled(); return () => p.tokenize(large) },
  'lex:jl-offset': () => { const p = build.offsets(); return () => p.tokenize(large) },
  'large:offsets': () => { const p = build.offsets(); return () => p.parse(large) },

  'parse:chevrotain': () => {
    const tokens = chevrotainJson.lexer.tokenize(large).tokens
    return () => { chevrotainJson.parser.input = tokens; return chevrotainJson.parser.value() }
  },
  'parse:compiled': () => {
    const p = build.compiled()
    const tokens = p.tokenize(large)
    return () => p.parseTokens(tokens, large)
  },
  'parse:interpreted': () => {
    const p = build.interpreted()
    const tokens = p.tokenize(large)
    return () => p.parseTokens(tokens, large)
  },

  'exp:memo': () => {
    const p = createParser(exponentialSpec(15), { memo: true })
    return () => p.parse('7')
  },
  'exp:nomemo': () => {
    const p = createParser(exponentialSpec(15))
    return () => p.parse('7')
  },

  'calc:compiled': () => { const p = createParser(calcGrammar); return () => p.parse(calcInput) },
  'calc:interpreted': () => { const p = createParser(calcGrammar, { execution: 'interpreted' }); return () => p.parse(calcInput) },
  'calc:memo': () => { const p = createParser(calcGrammar, { memo: true }); return () => p.parse(calcInput) }
}

const name = process.argv[2]
if (!(name in cases)) {
  console.error(`unknown case '${name}'. Known: ${Object.keys(cases).join(', ')}`)
  process.exit(1)
}

const fn = cases[name]()
const result = measure(name, fn, { warmupMs: 400, budgetMs: 2000 })
console.log(JSON.stringify({ name, opsPerSec: result.opsPerSec, batch: result.batch, samples: result.samples }))
