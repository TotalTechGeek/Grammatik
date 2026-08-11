// @ts-check
'use strict'

/**
 * The sentinel returned by any parser that did not match. A symbol, so a rule
 * stays free to legitimately produce `null`/`undefined`, and nothing in JSON
 * Logic can forge it.
 */
export const FAIL = Symbol('jl-grammar.fail')

/**
 * One mutable object threaded through the whole parse as the JSON Logic
 * *context*. Mutation rather than a rebuilt state per step is what keeps this
 * fast: `{"val": "idx"}` reads the cursor with no allocation, and backtracking
 * is a single integer assignment.
 *
 * @typedef {object} ParserState
 * @property {import('./lexer.js').Token[]} tokens
 * @property {number} idx           Cursor into `tokens`.
 * @property {number} maxIdx        Furthest cursor reached, for error reporting.
 * @property {string[]} expected    Token types acceptable at `maxIdx`.
 * @property {Record<string, any>} grammar Rule name -> JSON Logic.
 * @property {Map<string, any>|null} memo   Packrat cache, when enabled.
 * @property {string[]} ruleNames   Rule-name stack, written by index, never popped.
 * @property {number} ruleDepth     Live depth within `ruleNames`.
 * @property {string[]|null} failureStack  Snapshot taken at the furthest failure.
 * @property {boolean} track        Whether to record error-reporting detail.
 * @property {number} steps         Combinator invocations, for the runaway guard.
 * @property {number} maxSteps      0 disables the guard.
 */

/**
 * @param {import('./lexer.js').Token[]} tokens
 * @param {Record<string, any>} grammar
 * @param {{ memo?: boolean, maxSteps?: number, track?: boolean }} [options]
 * @returns {ParserState}
 */
export const createState = (tokens, grammar, options = {}) => ({
  tokens,
  idx: 0,
  maxIdx: 0,
  expected: [],
  grammar,
  memo: options.memo ? new Map() : null,
  // Entering a rule is one array store rather than an object allocation, and
  // the stack is snapshotted only on a furthest failure — by the time an error
  // is built it would otherwise have unwound to just the start rule.
  ruleNames: [],
  ruleDepth: 0,
  failureStack: null,
  track: options.track === true,
  steps: 0,
  maxSteps: options.maxSteps || 0
})

/**
 * Records that `expectation` would have been accepted at the cursor, keeping
 * only the *furthest* position — the alternative that got deepest is almost
 * always the one the author meant.
 *
 * Tracking is off during the first parse. `expect` fires on every failed token
 * match, so the bookkeeping (acceptable tokens, rule stack) is most of the work
 * in a backtracking grammar — slicing the rule stack per advance measured ~50x.
 * On failure `parseTokens` re-runs with `track` on and builds the message from
 * that; the parser is deterministic, so it lands in the same place.
 *
 * @param {ParserState} state
 * @param {string} expectation
 */
export function expect (state, expectation) {
  if (state.idx > state.maxIdx) {
    state.maxIdx = state.idx
    if (!state.track) return
    // An array, not a Set: a handful of names, so a linear scan beats hashing.
    state.expected = []
    state.failureStack = state.ruleNames.slice(0, state.ruleDepth)
  }
  if (!state.track || state.idx !== state.maxIdx) return
  if (!state.expected.includes(expectation)) state.expected.push(expectation)
}

export class ParseError extends Error {
  /**
   * @param {string} message
   * @param {{ token: import('./lexer.js').Token | null, expected: string[], ruleStack: string[] }} details
   */
  constructor (message, details) {
    super(message)
    this.name = 'ParseError'
    this.token = details.token
    this.expected = details.expected
    this.ruleStack = details.ruleStack
  }
}

/** Chevrotain-flavoured message built from the furthest failure. */
const describeExpected = (expected) =>
  expected.length === 0 ? 'nothing'
    : expected.length === 1 ? expected[0]
      : `one of [${expected.join(', ')}]`

/**
 * @param {ParserState} state
 * @returns {ParseError}
 */
export function buildParseError (state) {
  const token = state.tokens[state.maxIdx] || null
  const expected = [...state.expected].sort()
  const ruleStack = state.failureStack || state.ruleNames.slice(0, state.ruleDepth)

  // Without line tracking there is no line to name, so report the offset.
  const at = (t) => state.positions === 'offset'
    ? `offset ${t.start}`
    : `line ${t.line} column ${t.col}`
  const found = token ? `--> ${token.image} <-- (${token.type}) at ${at(token)}` : 'end of input'

  return new ParseError(
    `Expecting ${describeExpected(expected)} but found ${found}`,
    { token, expected, ruleStack }
  )
}
