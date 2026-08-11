// @ts-check
'use strict'

/**
 * A Chevrotain JSON parser, for benchmarking against.
 *
 * `EmbeddedActionsParser` is the right comparison: like our grammar's `action`
 * nodes it produces the JavaScript value directly, rather than building a CST
 * that a separate visitor pass would then walk.
 */

import { createToken, Lexer, EmbeddedActionsParser } from 'chevrotain'

const WhiteSpace = createToken({ name: 'WhiteSpace', pattern: /[ \t\r\n]+/, group: Lexer.SKIPPED })
const StringLiteral = createToken({ name: 'StringLiteral', pattern: /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/ })
const NumberLiteral = createToken({ name: 'NumberLiteral', pattern: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/ })
const True = createToken({ name: 'True', pattern: /true/ })
const False = createToken({ name: 'False', pattern: /false/ })
const Null = createToken({ name: 'Null', pattern: /null/ })
const LCurly = createToken({ name: 'LCurly', pattern: /{/ })
const RCurly = createToken({ name: 'RCurly', pattern: /}/ })
const LSquare = createToken({ name: 'LSquare', pattern: /\[/ })
const RSquare = createToken({ name: 'RSquare', pattern: /]/ })
const Comma = createToken({ name: 'Comma', pattern: /,/ })
const Colon = createToken({ name: 'Colon', pattern: /:/ })

export const allTokens = [
  WhiteSpace, StringLiteral, NumberLiteral, True, False, Null,
  LCurly, RCurly, LSquare, RSquare, Comma, Colon
]

/**
 * `positionTracking: 'full'` is Chevrotain's default, and it is what makes this
 * a like-for-like comparison: our lexer always records line and column, so
 * timing it against `onlyOffset` would be timing it against strictly less work.
 */
export const lexer = new Lexer(allTokens, { positionTracking: 'full' })

/** Exposed so the benchmark can show what position tracking actually costs. */
export const lexerOnlyOffset = new Lexer(allTokens, { positionTracking: 'onlyOffset' })

class JsonParser extends EmbeddedActionsParser {
  constructor () {
    super(allTokens)
    const $ = this

    // Every computation over a token is wrapped in `$.ACTION`. Chevrotain runs
    // each rule once at construction with placeholder tokens to record the
    // grammar; `$.ACTION` is how you mark code that must be skipped during that pass.

    $.RULE('value', () => $.OR([
      { ALT: () => $.SUBRULE($.object) },
      { ALT: () => $.SUBRULE($.array) },
      { ALT: () => { const t = $.CONSUME(StringLiteral); return $.ACTION(() => JSON.parse(t.image)) } },
      { ALT: () => { const t = $.CONSUME(NumberLiteral); return $.ACTION(() => Number(t.image)) } },
      { ALT: () => { $.CONSUME(True); return true } },
      { ALT: () => { $.CONSUME(False); return false } },
      { ALT: () => { $.CONSUME(Null); return null } }
    ]))

    $.RULE('object', () => {
      const out = {}
      $.CONSUME(LCurly)
      $.MANY_SEP({
        SEP: Comma,
        DEF: () => {
          const pair = $.SUBRULE($.pair)
          $.ACTION(() => { if (pair !== undefined) out[pair[0]] = pair[1] })
        }
      })
      $.CONSUME(RCurly)
      return out
    })

    $.RULE('pair', () => {
      const key = $.CONSUME(StringLiteral)
      $.CONSUME(Colon)
      const value = $.SUBRULE($.value)
      return $.ACTION(() => [JSON.parse(key.image), value])
    })

    $.RULE('array', () => {
      const out = []
      $.CONSUME(LSquare)
      $.MANY_SEP({
        SEP: Comma,
        DEF: () => {
          const item = $.SUBRULE($.value)
          $.ACTION(() => out.push(item))
        }
      })
      $.CONSUME(RSquare)
      return out
    })

    this.performSelfAnalysis()
  }
}

export const parser = new JsonParser()

/** @param {string} text */
export function parse (text) {
  const lexed = lexer.tokenize(text)
  parser.input = lexed.tokens
  const value = parser.value()
  if (parser.errors.length > 0) throw new Error(parser.errors[0].message)
  return value
}
