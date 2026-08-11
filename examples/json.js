// @ts-check
'use strict'

/**
 * A complete JSON grammar.
 *
 * This is the benchmark workload, and it is also the best demonstration of the
 * LL(1) dispatch: every branch of `value` begins with a distinct token, so the
 * analyzer collapses a seven-way choice into a single Map lookup on the next
 * token — no branch is ever tried and rolled back.
 */

export const tokens = [
  { name: 'WS', pattern: '[ \\t\\r\\n]+', skip: true },
  { name: 'String', pattern: '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"' },
  { name: 'Number', pattern: '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?' },
  { name: 'True', literal: 'true' },
  { name: 'False', literal: 'false' },
  { name: 'Null', literal: 'null' },
  { name: 'LCurly', literal: '{' },
  { name: 'RCurly', literal: '}' },
  { name: 'LSquare', literal: '[' },
  { name: 'RSquare', literal: ']' },
  { name: 'Comma', literal: ',' },
  { name: 'Colon', literal: ':' }
]

/**
 * Semantic helpers. Registering plain functions as JSON Logic methods is how
 * you reach past what the base operator set can express — here, decoding string
 * escapes and folding key/value pairs into an object.
 *
 * All three declare `optimizeUnary`, which tells the optimizer and the compiler
 * that the method takes one argument and does not want it wrapped. Without it
 * the engine funnels the evaluated argument through `coerceArray`, which both
 * allocates and — for `fromPairs`, whose argument is *itself* an array —
 * conflates the argument with the argument list. `optimizeUnary` erases the
 * array entirely and hands the method its value directly.
 */
export const methods = {
  /** Decodes a JSON string literal, escapes and all. */
  unquote: { method: (image) => JSON.parse(image), optimizeUnary: true },
  /** Coerces a numeric literal's source text to a number. */
  num: { method: (image) => +image, optimizeUnary: true },
  /** `[[k, v], ...]` -> `{ k: v }` */
  fromPairs: {
    method: (pairs) => {
      const out = {}
      for (let i = 0; i < pairs.length; i++) out[pairs[i][0]] = pairs[i][1]
      return out
    },
    optimizeUnary: true
  }
}

export const rules = {
  value: {
    alt: [
      { subrule: 'object' },
      { subrule: 'array' },
      { seq: [{ label: ['s', { consume: 'String' }] }, { action: { unquote: { val: ['s', 'image'] } } }] },
      { seq: [{ label: ['n', { consume: 'Number' }] }, { action: { num: { val: ['n', 'image'] } } }] },
      { seq: [{ consume: 'True' }, { action: true }] },
      { seq: [{ consume: 'False' }, { action: false }] },
      { seq: [{ consume: 'Null' }, { action: null }] }
    ]
  },

  object: {
    seq: [
      { consume: 'LCurly' },
      { label: ['pairs', { manySep: { rule: { subrule: 'pair' }, sep: 'Comma' } }] },
      { consume: 'RCurly' },
      { action: { fromPairs: { val: 'pairs' } } }
    ]
  },

  pair: {
    seq: [
      { label: ['k', { consume: 'String' }] },
      { consume: 'Colon' },
      { label: ['v', { subrule: 'value' }] },
      { action: [{ unquote: { val: ['k', 'image'] } }, { val: 'v' }] }
    ]
  },

  array: {
    seq: [
      { consume: 'LSquare' },
      { label: ['items', { manySep: { rule: { subrule: 'value' }, sep: 'Comma' } }] },
      { consume: 'RSquare' },
      { action: { val: 'items' } }
    ]
  }
}

export const grammar = { tokens, rules, start: 'value' }
export default grammar
