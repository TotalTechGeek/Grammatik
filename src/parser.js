// @ts-check
'use strict'

import { LogicEngine } from 'json-logic-engine'

import { createLexer } from './lexer.js'
import { createMethods, createValueMethods } from './methods.js'
import { analyze } from './analyze.js'
import { createPlanner } from './plan.js'
import { createCodegen } from './codegen.js'
import { FAIL, createState, buildParseError, ParseError } from './state.js'

/**
 * @typedef {object} GrammarSpec
 * @property {import('./lexer.js').TokenDef[]} tokens Token definitions for the lexer.
 * @property {Record<string, any>} rules             Rule name -> JSON Logic parser.
 * @property {string} start                          Entry rule.
 */

/**
 * @typedef {object} ParserOptions
 * @property {boolean} [memo=false]      Enable packrat memoization. Costs a Map
 *                                       write per rule invocation; pays for itself
 *                                       only on grammars that backtrack heavily.
 * @property {boolean} [strict=true]     Require the whole token stream to be consumed.
 * @property {boolean} [validate=true]   Throw on grammar errors (left recursion, bad refs).
 * @property {number} [maxSteps=0]       Runaway guard; 0 disables.
 * @property {boolean} [compile=true]   Compile the grammar through json-logic-engine's
 *                                       compiler into a tree of specialized closures.
 *                                       Off falls back to interpreting the JSON Logic,
 *                                       which is slower but easier to step through.
 * @property {boolean} [ll1=true]        Use FIRST-set dispatch for `alt`. Turning it
 *                                       off forces ordered backtracking everywhere,
 *                                       which parses the same language, just slower.
 *                                       Mostly useful for benchmarking and debugging.
 * @property {boolean} [compile] Legacy alias: `false` selects `'interpreted'`.
 * @property {boolean} [unsafeEval] Legacy alias: `false` selects `'interpreted'`.
 * @property {'generated'|'interpreted'} [execution='generated']
 *   How the grammar is run.
 *
 *   - `generated`   one JavaScript function per rule, semantic actions compiled
 *                   by the engine. The default: ~2.5x faster to parse, ~0.5 ms
 *                   more to construct.
 *   - `interpreted` rules as planner closures, actions walked by the engine. No
 *                   `eval` or `new Function` anywhere, which is what a strict
 *                   Content-Security-Policy (no `unsafe-eval`) requires, and
 *                   cheaper to construct — so it also wins when a grammar is
 *                   built to parse one short input and then discarded.
 * @property {'full'|'offset'} [positions='full'] `full` records line and column
 *                                       on every token; `offset` records only
 *                                       byte offsets and skips scanning the
 *                                       input for newlines.
 * @property {Record<string, any>} [methods] Extra JSON Logic methods for semantic actions.
 */

const EXECUTION_MODES = new Set(['generated', 'interpreted'])

export class GrammarError extends Error {
  /** @param {string[]} problems */
  constructor (problems) {
    super(`Invalid grammar:\n  - ${problems.join('\n  - ')}`)
    this.name = 'GrammarError'
    this.problems = problems
  }
}

/**
 * Builds a parser from a JSON grammar.
 *
 * @param {GrammarSpec} spec
 * @param {ParserOptions} [options]
 */
export function createParser (spec, options = {}) {
  const { tokens: tokenDefs, rules, start } = spec
  const {
    memo = false,
    strict = true,
    validate = true,
    maxSteps = 0,
    ll1 = true,
    execution = 'generated',
    positions = 'full',
    methods: extraMethods
  } = options

  // `compile` and `unsafeEval` were the booleans this replaced. Either one set
  // to false selects the interpreter; `execution` wins when both are given.
  const mode = options.execution !== undefined
    ? execution
    : (options.compile === false || options.unsafeEval === false) ? 'interpreted' : 'generated'

  if (!EXECUTION_MODES.has(mode)) {
    throw new Error(`createParser: \`execution\` must be one of ${[...EXECUTION_MODES].join(', ')}, got ${JSON.stringify(mode)}`)
  }
  const compile = mode === 'generated'
  const unsafeEval = mode === 'generated'

  if (!rules || typeof rules !== 'object') throw new Error('createParser: `rules` must be an object of rule name -> logic')
  if (!start) throw new Error('createParser: `start` is required')
  if (!(start in rules)) throw new Error(`createParser: start rule '${start}' is not defined in rules`)

  const lexer = createLexer(tokenDefs, { positions })

  const analysis = analyze(rules, { tokenNames: lexer.tokenNames })
  if (validate && analysis.errors.length > 0) throw new GrammarError(analysis.errors)

  const engine = new LogicEngine()
  for (const [name, method] of Object.entries(createMethods())) engine.addMethod(name, method)
  // Value methods before the caller's, so a grammar can override one.
  for (const [name, method] of Object.entries(createValueMethods())) engine.addMethod(name, method)
  for (const [name, method] of Object.entries(extraMethods || {})) engine.addMethod(name, method)

  const startRule = rules[start]
  const firsts = ll1 ? analysis.firsts : null

  // The planner specializes the grammar into closures; the combinators'
  // `compile` hooks reach it through the engine.
  const planner = createPlanner({ engine, rules, firsts, memo, maxSteps, unsafeEval })
  engine.__jlGrammar = { planner }

  // Source generation emits one JS function per rule with every node inlined,
  // so only rule boundaries remain calls. Generated functions are published into
  // the engine's `optimizedMap` too, so reaching a rule through `engine.run`
  // lands on the generated code rather than a method dispatch.
  // Code generation needs `new Function`, so it is off whenever eval is.
  const codegen = compile && unsafeEval
    ? createCodegen({ planner, rules, firsts, memo, maxSteps })
    : null
  const compiledStart = codegen && codegen.compile(start)

  if (codegen && !engine.disableInterpretedOptimization) {
    for (const name of Object.keys(rules)) {
      const generated = codegen.functionFor(name)
      if (generated) engine.optimizedMap.set(rules[name], generated)
    }
  }

  /**
   * Parses a token stream that you lexed yourself.
   * @param {import('./lexer.js').Token[]} tokens
   * @param {string} [source] Original text, so `text` can slice exact spans.
   */
  function parseTokens (tokens, source, track = false) {
    const state = createState(tokens, rules, { memo, maxSteps, track })
    state.firsts = firsts
    state.source = source
    state.positions = lexer.positions
    state.ruleNames[0] = start
    state.ruleDepth = 1

    const result = compiledStart ? compiledStart(state) : engine.run(startRule, state, { above: [] })
    const trailing = strict && state.idx < tokens.length
    if (result !== FAIL && !trailing) return result

    // Re-run with error bookkeeping on, so the message can name what was
    // expected and where. Only failures pay for it.
    if (!track) return parseTokens(tokens, source, true)

    // A parse that succeeded but stopped early: the furthest failure is a better
    // error site than the cursor, so prefer it when it is ahead.
    if (trailing && state.maxIdx < state.idx) {
      state.maxIdx = state.idx
      state.expected = ['end of input']
      state.failureStack = state.ruleNames.slice(0, state.ruleDepth)
    }
    throw buildParseError(state)
  }

  /**
   * Lexes and parses text.
   * @param {string} text
   */
  function parse (text) {
    return parseTokens(lexer.tokenize(text), text)
  }

  return {
    parse,
    parseTokens,
    tokenize: lexer.tokenize,
    lexer,
    engine,
    analysis,
    planner,
    codegen,
    execution: mode,
    compiled: Boolean(compiledStart),
    /** Rules whose `alt`s resolved to O(1) LL(1) dispatch, for introspection. */
    get firsts () { return analysis.firsts }
  }
}

export { FAIL, ParseError }
