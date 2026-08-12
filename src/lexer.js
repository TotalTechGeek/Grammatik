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
 * @property {string} [mode]     The lexer mode this token belongs to. Default `'default'`.
 * @property {string[]} [modes]  Several modes, when one token serves more than one.
 * @property {string} [pushMode] Enter this mode after the token matches.
 * @property {boolean} [popMode] Leave the current mode after the token matches.
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

const DEFAULT_MODE = 'default'

/** The modes one definition belongs to, however it spelled them. */
function modesOf (def) {
  if (Array.isArray(def.modes) && def.modes.length > 0) return def.modes
  if (def.mode) return [def.mode]
  return [DEFAULT_MODE]
}

/**
 * Compiles token definitions into a fast sticky-regex lexer.
 *
 * Literal tokens are matched with `startsWith` rather than a regex, which is a
 * large win for punctuation-heavy grammars (JSON is ~60% punctuation by token count).
 *
 * ## Modes
 *
 * A token belongs to one or more modes and only competes while one of them is
 * current. `pushMode` enters a mode after the token matches, `popMode` leaves
 * one, and the stack starts fresh at `'default'` on every `tokenize` call. This
 * is how context-sensitive vocabularies are expressed as data: in Handlebars,
 * whitespace is literal text outside `{{ }}` and skipped inside it, which is one
 * token definition per mode rather than a hand-written scanner.
 *
 * Everything a mode needs — its candidate list and its first-character dispatch
 * table — is compiled here, so the hot path only indexes by mode id. A grammar
 * with a single mode never touches a mode stack at all.
 *
 * @param {TokenDef[]} defs
 * @param {{ positions?: 'full' | 'offset' }} [options]
 *   `full` (default) records line and column on every token. `offset` records
 *   only `start`/`end`, which skips a scan of the entire input for newlines —
 *   worth taking when errors do not need to name a line, or when positions are
 *   resolved lazily from the offset afterwards.
 * @returns {{ tokenize: (text: string) => Token[], tokenNames: string[], positions: string, modeNames: string[] }}
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

  // ---- modes ----
  // Mode ids are assigned before anything else so a definition can carry the
  // numbers rather than the names, and the hot path never touches a string.
  const modeIds = new Map([[DEFAULT_MODE, 0]])
  const modeNames = [DEFAULT_MODE]
  const idOf = (name) => {
    let id = modeIds.get(name)
    if (id === undefined) {
      id = modeNames.length
      modeIds.set(name, id)
      modeNames.push(name)
    }
    return id
  }
  for (const def of defs) for (const mode of modesOf(def)) idOf(mode)

  const compiled = defs.map((def) => {
    if (!def.name) throw new Error('createLexer: every token definition needs a name')
    if (!def.pattern && !def.literal) throw new Error(`createLexer: token '${def.name}' needs a pattern or a literal`)
    if (def.pattern && def.literal) throw new Error(`createLexer: token '${def.name}' has both a pattern and a literal; pick one`)
    if (def.longerAlt && !seen.has(def.longerAlt)) throw new Error(`createLexer: token '${def.name}' has longerAlt '${def.longerAlt}', which is not a defined token`)
    if (def.pushMode && def.popMode) {
      throw new Error(
        `createLexer: token '${def.name}' both pushes '${def.pushMode}' and pops. ` +
        'One token cannot do both — split it into two tokens, one per mode.'
      )
    }
    // A mode nothing declares is a typo, and would otherwise strand the lexer in
    // a mode where no token can ever match.
    if (def.pushMode && !modeIds.has(def.pushMode)) {
      throw new Error(`createLexer: token '${def.name}' pushes mode '${def.pushMode}', which no token belongs to`)
    }

    return {
      name: def.name,
      skip: !!def.skip,
      literal: def.literal,
      longerAlt: def.longerAlt || null,
      regex: def.pattern ? new RegExp(def.pattern, def.ignoreCase ? 'iy' : 'y') : null,
      modes: modesOf(def),
      pushMode: def.pushMode ? idOf(def.pushMode) : -1,
      popMode: !!def.popMode
    }
  })

  const byName = new Map(compiled.map((c) => [c.name, c]))
  // Resolve longerAlt names to the compiled definitions once, up front.
  for (const c of compiled) if (c.longerAlt) c.longerAltDef = byName.get(c.longerAlt)

  // A longerAlt can only win where it is itself active; otherwise a token would
  // silently lose its alternative in one mode and keep it in another.
  for (const c of compiled) {
    if (!c.longerAltDef) continue
    for (const mode of c.modes) {
      if (c.longerAltDef.modes.includes(mode)) continue
      throw new Error(
        `createLexer: token '${c.name}' is active in mode '${mode}' with longerAlt '${c.longerAlt}', ` +
        `which is not active there. Add '${mode}' to '${c.longerAlt}'.`
      )
    }
  }

  // ---- per-mode dispatch tables ----
  // For each definition, work out which characters it can start with, so that a
  // given offset only tries the handful of patterns that could match there
  // rather than all of them in declaration order. Built once per mode, since a
  // mode's candidate set never changes after the lexer is created.
  for (const c of compiled) {
    c.firstChars = c.literal !== undefined
      ? (c.literal.length > 0 ? new Set([c.literal.charCodeAt(0)]) : null)
      : firstCharSet(c.regex.source, !!c.regex.ignoreCase)
  }

  const modes = modeNames.map((name) => {
    const members = compiled.filter((c) => c.modes.includes(name))
    // Definitions whose first characters could not be determined must be tried
    // at every offset, so they belong in every bucket.
    const alwaysTry = members.filter((c) => c.firstChars === null)
    const candidatesFor = (code) => members.filter((c) => c.firstChars === null || c.firstChars.has(code))

    const ascii = new Array(128)
    for (let code = 0; code < 128; code++) ascii[code] = candidatesFor(code)

    return {
      name,
      members,
      ascii,
      wide: new Map(),
      candidatesFor,
      // If nothing could be analyzed, dispatch is pure overhead; skip it.
      dispatch: alwaysTry.length < members.length
    }
  })

  for (const mode of modes) {
    if (mode.members.length === 0) throw new Error(`createLexer: mode '${mode.name}' has no tokens`)
  }

  function candidates (mode, code) {
    if (code < 128) return mode.ascii[code]
    let list = mode.wide.get(code)
    if (list === undefined) {
      list = mode.candidatesFor(code)
      mode.wide.set(code, list)
    }
    return list
  }

  // No transitions anywhere means no stack and no per-token mode checks — the
  // loop this had before modes existed. A grammar can declare one mode and still
  // pop out of it, which is always an underflow; that has to be reported, not
  // skipped along with the rest of the machinery.
  const multiMode = modes.length > 1 || compiled.some((c) => c.popMode || c.pushMode !== -1)
  // Naming the mode in an error only helps when there is more than one.
  const namesModes = modes.length > 1
  const initial = modes[0]

  /** The `longerAlt` match end, or -1. Only reached when a `longerAlt` is set. */
  function longerAltEnd (def, text, offset) {
    const alt = def.longerAltDef
    if (alt.literal !== undefined) return text.startsWith(alt.literal, offset) ? offset + alt.literal.length : -1
    alt.regex.lastIndex = offset
    return alt.regex.test(text) ? alt.regex.lastIndex : -1
  }

  /**
   * @param {string} text
   * @returns {Token[]}
   */
  function tokenize (text) {
    if (typeof text !== 'string') throw new TypeError('tokenize: expected a string')

    /** @type {Token[]} */
    const tokens = []
    let offset = 0
    let line = 1
    let lineStart = 0
    const length = text.length

    // The stack is local to this call, so a lexer is reusable and a failure
    // partway through leaves nothing behind for the next one.
    let mode = initial
    const stack = multiMode ? [] : null
    let depth = 0

    outer: while (offset < length) {
      // Inlining the ASCII table lookup here instead of calling `candidates` was
      // measured and made no difference; the cost is in the patterns, not the
      // dispatch.
      const applicable = mode.dispatch ? candidates(mode, text.charCodeAt(offset)) : mode.members

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

        // The transition belongs to whichever token was actually produced, so a
        // `longerAlt` that wins brings its own mode change with it. Skipped
        // tokens transition too: a comment can open a mode without being one.
        if (multiMode) {
          if (winner.popMode) {
            if (depth === 0) {
              throw new LexError(
                `Token '${winner.name}' popped the initial lexer mode at ${describe(offset, line, lineStart)}`,
                { offset, line: trackLines ? line : 0, col: trackLines ? offset - lineStart + 1 : 0 }
              )
            }
            mode = stack[--depth]
          } else if (winner.pushMode !== -1) {
            stack[depth++] = mode
            mode = modes[winner.pushMode]
          }
        }

        offset = end
        continue outer
      }

      const column = offset - lineStart + 1
      throw new LexError(
        trackLines
          ? `Unexpected character '${text[offset]}' at line ${line} column ${column}${inMode(mode)}`
          : `Unexpected character '${text[offset]}' at offset ${offset}${inMode(mode)}`,
        { offset, line: trackLines ? line : 0, col: trackLines ? column : 0 }
      )
    }

    // Reaching the end inside a pushed mode is not a lexer error: the tokens are
    // all valid, and the parser gives a better message for the missing closer
    // than "unexpected end of input" ever could.
    return tokens
  }

  /** Names the mode in an error, but only when there is more than one to confuse. */
  const inMode = (mode) => namesModes ? ` (in lexer mode '${mode.name}')` : ''
  const describe = (offset, line, lineStart) =>
    trackLines ? `line ${line} column ${offset - lineStart + 1}` : `offset ${offset}`

  return { tokenize, tokenNames, positions, modeNames }
}
