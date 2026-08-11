// @ts-check
'use strict'

import { firstCharSet } from './firstchars.js'

/**
 * A Chevrotain-style lexer. Token definitions are plain JSON, so a whole
 * grammar (tokens + rules) stays serializable.
 *
 * @typedef {object} TokenDef
 * @property {string} name       The token type produced.
 * @property {string} [pattern]  A regex source string, matched sticky at the current offset.
 * @property {string} [literal]  A literal string to match. Cheaper than a pattern; prefer it.
 * @property {boolean} [skip]    When true the match is consumed but produces no token (whitespace, comments).
 * @property {string} [longerAlt] Name of another token to prefer when it matches a longer string
 *                                at the same offset (the classic `if` / `identifier` problem).
 * @property {boolean} [ignoreCase] Case-insensitive matching.
 */

/**
 * @typedef {object} Token
 * @property {string} type
 * @property {string} image
 * @property {number} start
 * @property {number} end
 * @property {number} line
 * @property {number} col
 */

export class LexError extends Error {
  /**
   * @param {string} message
   * @param {{ offset: number, line: number, col: number }} position
   */
  constructor (message, position) {
    super(message)
    this.name = 'LexError'
    this.offset = position.offset
    this.line = position.line
    this.col = position.col
  }
}

/**
 * Compiles token definitions into a fast sticky-regex lexer.
 *
 * Literal tokens are matched with `startsWith` rather than a regex, which is a
 * large win for punctuation-heavy grammars (JSON is ~60% punctuation by token count).
 *
 * @param {TokenDef[]} defs
 * @param {{ positions?: 'full' | 'offset' }} [options]
 *   `full` (default) records line and column on every token. `offset` records
 *   only `start`/`end`, which skips a scan of the entire input for newlines —
 *   worth taking when errors do not need to name a line, or when positions are
 *   resolved lazily from the offset afterwards.
 * @returns {{ tokenize: (text: string) => Token[], tokenNames: string[], positions: string }}
 */
export function createLexer (defs, options = {}) {
  const positions = options.positions === 'offset' ? 'offset' : 'full'
  const trackLines = positions === 'full'
  if (!Array.isArray(defs) || defs.length === 0) throw new Error('createLexer: expected a non-empty array of token definitions')

  const tokenNames = defs.map((d) => d.name)
  const seen = new Set()
  for (const name of tokenNames) {
    if (seen.has(name)) throw new Error(`createLexer: duplicate token name '${name}'`)
    seen.add(name)
  }

  const compiled = defs.map((def) => {
    if (!def.name) throw new Error('createLexer: every token definition needs a name')
    if (!def.pattern && !def.literal) throw new Error(`createLexer: token '${def.name}' needs a pattern or a literal`)
    if (def.pattern && def.literal) throw new Error(`createLexer: token '${def.name}' has both a pattern and a literal; pick one`)
    if (def.longerAlt && !seen.has(def.longerAlt)) throw new Error(`createLexer: token '${def.name}' has longerAlt '${def.longerAlt}', which is not a defined token`)

    return {
      name: def.name,
      skip: !!def.skip,
      literal: def.literal,
      longerAlt: def.longerAlt || null,
      regex: def.pattern ? new RegExp(def.pattern, def.ignoreCase ? 'iy' : 'y') : null
    }
  })

  const byName = new Map(compiled.map((c) => [c.name, c]))
  // Resolve longerAlt names to the compiled definitions once, up front.
  for (const c of compiled) if (c.longerAlt) c.longerAltDef = byName.get(c.longerAlt)

  const count = compiled.length

  // ---- first-character dispatch ----
  // For each definition, work out which characters it can start with, so that a
  // given offset only tries the handful of patterns that could match there
  // rather than all of them in declaration order.
  for (const c of compiled) {
    c.firstChars = c.literal !== undefined
      ? (c.literal.length > 0 ? new Set([c.literal.charCodeAt(0)]) : null)
      : firstCharSet(c.regex.source, !!c.regex.ignoreCase)
  }

  // Definitions whose first characters could not be determined must be tried at
  // every offset, so they belong in every bucket.
  const alwaysTry = compiled.filter((c) => c.firstChars === null)

  /** Builds the ordered candidate list for one char code. */
  const candidatesFor = (code) =>
    compiled.filter((c) => c.firstChars === null || c.firstChars.has(code))

  const asciiTable = new Array(128)
  for (let code = 0; code < 128; code++) asciiTable[code] = candidatesFor(code)

  /** @type {Map<number, any[]>} */
  const wideCache = new Map()
  function candidates (code) {
    if (code < 128) return asciiTable[code]
    let list = wideCache.get(code)
    if (list === undefined) {
      list = candidatesFor(code)
      wideCache.set(code, list)
    }
    return list
  }

  // If nothing could be analyzed, dispatch is pure overhead; skip it.
  const dispatchWorthwhile = alwaysTry.length < count

  /**
   * @param {string} text
   * @returns {Token[]}
   */
  /** The `longerAlt` match end, or -1. Only reached when a `longerAlt` is set. */
  function longerAltEnd (def, text, offset) {
    const alt = def.longerAltDef
    if (alt.literal !== undefined) return text.startsWith(alt.literal, offset) ? offset + alt.literal.length : -1
    alt.regex.lastIndex = offset
    return alt.regex.test(text) ? alt.regex.lastIndex : -1
  }

  function tokenize (text) {
    if (typeof text !== 'string') throw new TypeError('tokenize: expected a string')

    /** @type {Token[]} */
    const tokens = []
    let offset = 0
    let line = 1
    let lineStart = 0
    const length = text.length

    outer: while (offset < length) {
      const applicable = dispatchWorthwhile ? candidates(text.charCodeAt(offset)) : compiled

      for (let i = 0; i < applicable.length; i++) {
        const def = applicable[i]

        // Find where the match ends without necessarily building it. `test` on a
        // sticky regex advances `lastIndex` just like `exec` but skips
        // materializing the match array, and a skipped token's text is never
        // read at all, so nothing is allocated for it.
        let end = -1
        let matched = null
        if (def.literal !== undefined) {
          if (text.startsWith(def.literal, offset)) end = offset + def.literal.length
        } else if (def.skip) {
          def.regex.lastIndex = offset
          // A zero-length match would spin forever; treat it as no match.
          if (def.regex.test(text) && def.regex.lastIndex > offset) end = def.regex.lastIndex
        } else {
          def.regex.lastIndex = offset
          const match = def.regex.exec(text)
          if (match !== null && match[0].length > 0) matched = match[0]
          if (matched !== null) end = offset + matched.length
        }

        if (end === -1) continue

        // `longerAlt` lets a keyword defer to an identifier that matches more
        // text: `iffy` is an identifier, not `if` followed by `fy`.
        let winner = def
        if (def.longerAltDef) {
          const altEnd = longerAltEnd(def, text, offset)
          if (altEnd > end) {
            end = altEnd
            winner = def.longerAltDef
          }
        }

        if (!winner.skip) {
          const image = winner.literal !== undefined
            ? winner.literal
            : (winner === def && matched !== null ? matched : text.slice(offset, end))
          // One object shape either way, so the parser's property loads stay
          // monomorphic regardless of the position mode.
          tokens.push({
            type: winner.name,
            image,
            start: offset,
            end,
            line: trackLines ? line : 0,
            col: trackLines ? offset - lineStart + 1 : 0
          })
        }

        // A bounded scan over this token's own span, so the whole tokenize costs
        // one pass over the input — and nothing at all in `offset` mode.
        //
        // An `indexOf('\n')` cursor was tried instead and looks strictly better:
        // native scanning, and no work when the input has no newlines. It made
        // `tokenize` slightly faster in isolation and then made parsing
        // freshly-lexed tokens *sixty times slower* (6.8 ms -> 361 ms),
        // reproducibly, for reasons that did not survive investigation. Do not
        // "optimize" this without measuring the full pipeline.
        if (trackLines) {
          for (let j = offset; j < end; j++) {
            if (text.charCodeAt(j) !== 10) continue
            line++
            lineStart = j + 1
          }
        }

        offset = end
        continue outer
      }

      const column = offset - lineStart + 1
      throw new LexError(
        trackLines
          ? `Unexpected character '${text[offset]}' at line ${line} column ${column}`
          : `Unexpected character '${text[offset]}' at offset ${offset}`,
        { offset, line: trackLines ? line : 0, col: trackLines ? column : 0 }
      )
    }

    return tokens
  }

  return { tokenize, tokenNames, positions }
}
