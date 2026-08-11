// @ts-check
'use strict'

/**
 * The same JSON grammar, expressed in jl-grammar-codex's DSL.
 *
 * Written to produce byte-identical output to our own JSON grammar so the two
 * implementations can be compared on equal terms: same tokens, same semantic
 * actions, same resulting JavaScript values.
 */

import { LogicEngine } from 'json-logic-engine'
import {
  createParser, consume, subrule, seq, or, manySep, map
} from '../../jl-grammar-codex/src/index.js'

export const tokens = [
  { name: 'WS', pattern: '[ \\t\\r\\n]+', skip: true, lineBreaks: true },
  { name: 'String', pattern: '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"' },
  { name: 'Number', pattern: '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?' },
  { name: 'True', pattern: 'true' },
  { name: 'False', pattern: 'false' },
  { name: 'Null', pattern: 'null' },
  { name: 'LCurly', pattern: '\\{' },
  { name: 'RCurly', pattern: '\\}' },
  { name: 'LSquare', pattern: '\\[' },
  { name: 'RSquare', pattern: '\\]' },
  { name: 'Comma', pattern: ',' },
  { name: 'Colon', pattern: ':' }
]

export const grammar = {
  outputCst: false,
  tokens,
  start: 'value',
  rules: {
    value: {
      body: or(
        subrule('object'),
        subrule('array'),
        map(consume('String'), { unquote: { val: ['value', 'image'] } }),
        map(consume('Number'), { num: { val: ['value', 'image'] } }),
        map(consume('True'), true),
        map(consume('False'), false),
        map(consume('Null'), null)
      )
    },
    object: {
      body: seq(consume('LCurly'), manySep(subrule('pair'), consume('Comma')), consume('RCurly')),
      action: { fromPairs: { val: ['value', 1] } }
    },
    pair: {
      body: seq(consume('String'), consume('Colon'), subrule('value')),
      action: [{ unquote: { val: ['value', 0, 'image'] } }, { val: ['value', 2] }]
    },
    array: {
      body: seq(consume('LSquare'), manySep(subrule('value'), consume('Comma')), consume('RSquare')),
      action: { val: ['value', 1] }
    }
  }
}

/** Same semantic helpers our grammar uses, registered on a shared engine. */
export function buildParser (options = {}) {
  const engine = new LogicEngine()
  engine.addMethod('unquote', { method: (image) => JSON.parse(image), optimizeUnary: true })
  engine.addMethod('num', { method: (image) => +image, optimizeUnary: true })
  engine.addMethod('fromPairs', {
    method: (pairs) => {
      const out = {}
      for (let i = 0; i < pairs.length; i++) out[pairs[i][0]] = pairs[i][1]
      return out
    },
    optimizeUnary: true
  })
  return createParser(grammar, { engine, ...options })
}
