// @ts-check
'use strict'

import { firstCharSet } from './firstchars.js'
import { buildScanner, scanEnd, DEFER } from './scan.js'
import { LexError } from './state.js'

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
 * @property {number} [id]   The token definition's declaration index, present
 *                           in `offset` position mode only — see the note on
 *                           `positions` below. Not part of the public contract
 *                           of a token — internal combinators use it as a
 *                           faster stand-in for `type` (an integer compare and
 *                           an array index instead of a string compare and a
 *                           property lookup); `type` is what a grammar
 *                           author's code should read.
 * @property {string} image
 * @property {number} start
 * @property {number} end
 * @property {number} [line] Present in `full` position mode only.
 * @property {number} [col]  Present in `full` position mode only.
 */

export { LexError }

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
 * @param {{ positions?: 'full' | 'offset', scanners?: boolean, fuse?: boolean }} [options]
 *   `full` (default) records line and column on every token. `offset` records
 *   only `start`/`end` plus `id`, which skips a scan of the entire input for
 *   newlines — worth taking when errors do not need to name a line, or when
 *   positions are resolved lazily from the offset afterwards. The two modes
 *   deliberately differ in which extra field they carry rather than both
 *   carrying every field: a 7th own property on the token object, in either
 *   mode, measured at a real ~30% tokenize regression (see the comment at the
 *   push site) that a 6-field object does not pay.
 *
 *   `scanners` (default true) lets patterns of a few common shapes — identifier
 *   and digit runs, `KEYWORD(?![A-Za-z0-9_])`, line comments, doubled-quote
 *   strings — run as table-driven loops rather than regex calls (see `scan.js`).
 *   The tokens produced are identical; `false` forces every pattern through its
 *   regex, which is for debugging and for benchmarking the difference.
 *
 *   `fuse` (default true) joins runs of three or more consecutive regex
 *   candidates into one alternation, so a position where several tokens could
 *   start (a template language's `{{` openers) costs one regex call rather than
 *   one per rejected token. Same tokens; `false` tries them one at a time.
 * @returns {{ tokenize: (text: string) => Token[], tokenNames: string[], positions: string, modeNames: string[] }}
 */
export function createLexer (defs, options = {}) {
  const positions = options.positions === 'offset' ? 'offset' : 'full'
  const trackLines = positions === 'full'
  const useScanners = options.scanners !== false
  const useFuse = options.fuse !== false
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

  const compiled = defs.map((def, id) => {
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
      // The declaration index. `createParser` derives the identical mapping
      // from `tokenNames` independently (same array, same order), so a
      // combinator that resolves a `consume` target's id at build time agrees
      // with what a token actually carries without the two ever comparing notes.
      id,
      skip: !!def.skip,
      literal: def.literal,
      longerAlt: def.longerAlt || null,
      regex: def.pattern ? new RegExp(def.pattern, def.ignoreCase ? 'iy' : 'y') : null,
      // A table-driven stand-in for the regex where its shape is recognised;
      // null otherwise (and always, with `scanners: false`). It is a field on
      // every definition so they all keep one shape. See scan.js.
      scanner: useScanners && def.pattern ? buildScanner(def.pattern, !!def.ignoreCase) : null,
      modes: modesOf(def),
      pushMode: def.pushMode ? idOf(def.pushMode) : -1,
      popMode: !!def.popMode,
      // Set only on the stand-in `fuse` builds for a run of regexes; see there.
      members: null
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

  // ---- fused regex runs ----
  // Dispatch narrows candidates by first character, but several tokens can share
  // one: a template language's `{{` openers (`{{#`, `{{/`, `{{>`, `{{^`, `{{else`,
  // plus a `~` variant and a standalone-line variant of each) all start with `{`,
  // and the plain `{{name}}` tag matches only after ten of them have been tried
  // and rejected. Each rejection is a regex call — a trip into the engine and a
  // `lastIndex` write — that costs more than the few characters it examines.
  //
  // So consecutive plain-regex candidates are joined into one alternation, a capture
  // group per member: one call, and the engine tries the members left to right
  // exactly as the loop would, so the first one that matches still wins. Tokens are
  // identical. Measured, one lexer per process: 1.11x lexing on a Handlebars grammar
  // (1.13x through its own benchmark; ten of its twelve attempts per tag were
  // failures), and no change on the JSON, SQL and formula examples, which have no
  // position where three regexes compete. A perfect dispatch would be 1.67x on the
  // Handlebars grammar; this gets about a fifth of that gap without analysing any
  // regex. (Narrowing candidates by more than the first character would get more,
  // and needs a prefix analysis of the patterns.)
  //
  // Only runs of three or more are worth the match array `exec` allocates, and only
  // members that cannot disturb the numbering or meaning of the groups: no capture
  // groups of their own, no backreferences, and the same flags.
  const FUSE_MIN = 3
  const fusible = (def) =>
    def.literal === undefined && def.scanner === null && def.regex !== null &&
    !/\\[1-9]|\\k</.test(def.regex.source) &&
    // `exec` of an always-matching `|` alternative returns one slot per capture group.
    new RegExp(def.regex.source + '|').exec('').length === 1

  function fuse (list) {
    if (!useFuse) return list
    const out = []
    for (let i = 0; i < list.length;) {
      let j = i
      while (j < list.length && fusible(list[j]) && list[j].regex.flags === list[i].regex.flags) j++
      if (j - i < FUSE_MIN) {
        out.push(list[i++])
        continue
      }
      const run = list.slice(i, j)
      // A stand-in with every field a definition has, so they all share one shape.
      out.push({
        name: run.map((d) => d.name).join('|'),
        id: -1,
        skip: false,
        literal: undefined,
        longerAlt: null,
        longerAltDef: undefined,
        regex: new RegExp(run.map((d) => `(${d.regex.source})`).join('|'), run[0].regex.flags),
        scanner: null,
        modes: run[0].modes,
        pushMode: -1,
        popMode: false,
        members: run
      })
      i = j
    }
    return out
  }

  const modes = modeNames.map((name, id) => {
    const members = compiled.filter((c) => c.modes.includes(name))
    // Definitions whose first characters could not be determined must be tried
    // at every offset, so they belong in every bucket.
    const alwaysTry = members.filter((c) => c.firstChars === null)
    const candidatesFor = (code) => fuse(members.filter((c) => c.firstChars === null || c.firstChars.has(code)))

    const ascii = new Array(128)
    for (let code = 0; code < 128; code++) ascii[code] = candidatesFor(code)

    return {
      name,
      id,
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

  /** The member of a fused run that matched, and its text, set by `fusedEnd`. */
  let fusedMember = null
  let fusedText = ''

  /**
   * Where a fused run matches at `offset`, or -1, leaving the winning member and
   * its text in `fusedMember`/`fusedText`. A member that matched nothing counts as
   * not matching (an empty token would never advance), so when the alternation's
   * winner is empty the members are tried one at a time, as the loop would have.
   */
  function fusedEnd (run, text, offset) {
    run.regex.lastIndex = offset
    const match = run.regex.exec(text)
    if (match === null) return -1
    if (match[0].length === 0) {
      for (const member of run.members) {
        member.regex.lastIndex = offset
        const one = member.regex.exec(text)
        if (one !== null && one[0].length > 0) {
          fusedMember = member
          fusedText = one[0]
          return offset + fusedText.length
        }
      }
      return -1
    }
    let group = 1
    while (match[group] === undefined) group++
    fusedMember = run.members[group - 1]
    fusedText = match[0]
    return offset + fusedText.length
  }

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
        let def = applicable[i]

        // Find where the match ends without necessarily building it. `test` on a
        // sticky regex advances `lastIndex` just like `exec` but skips
        // materializing the match array, and a skipped token's text is never
        // read at all, so nothing is allocated for it.
        let end = -1
        let matched = null
        if (def.members !== null) {
          end = fusedEnd(def, text, offset)
          if (end === -1) continue
          def = fusedMember
          matched = fusedText
        } else if (def.literal !== undefined) {
          if (text.startsWith(def.literal, offset)) end = offset + def.literal.length
        } else {
          end = def.scanner === null ? DEFER : scanEnd(def.scanner, text, offset, length)
          if (end === DEFER) {
            end = -1
            if (def.skip) {
              def.regex.lastIndex = offset
              // A zero-length match would spin forever; treat it as no match.
              if (def.regex.test(text) && def.regex.lastIndex > offset) end = def.regex.lastIndex
            } else {
              def.regex.lastIndex = offset
              const match = def.regex.exec(text)
              if (match !== null && match[0].length > 0) matched = match[0]
              if (matched !== null) end = offset + matched.length
            }
          }
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
          // Two shapes, not one: a 7th own property on this literal — in
          // either position mode — measured at a genuine ~30% tokenize
          // regression in this exact function, reproducible and isolated to
          // the field count alone (a constant 7th field regresses exactly as
          // much as a computed one), but one that does not reduce to a
          // minimal repro elsewhere. Each mode instead stays at 6 own
          // properties: `id` only in offset mode, where line/col would have
          // been dead weight (always 0) anyway; line/col only in full mode,
          // where `id` is what gets dropped. `token.id === undefined` is
          // already how consume/oneOf/alt's dispatch fall back to comparing
          // `type` for a hand-built token from parseTokens, so a full-mode
          // token needs no special casing there — it takes the same fallback.
          tokens.push(trackLines
            ? { type: winner.name, image, start: offset, end, line, col: offset - lineStart + 1 }
            : { type: winner.name, id: winner.id, image, start: offset, end })
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

  if (!options.incremental) return { tokenize, tokenNames, positions, modeNames }

  // ---- incremental mode (opt-in) ----
  // Everything above — matching, dispatch, `tokenize` itself — is untouched by
  // this. A lexer created without `incremental: true` never allocates or runs
  // any of the following, so the benchmarked default path pays nothing for it.
  const recover = !!options.recover
  const errorTokenName = options.errorToken || 'Error'

  /** A mode-stack snapshot as plain mode ids, comparable with `===`-free equality. */
  function snapshotStack (stack, depth) {
    const ids = new Array(depth)
    for (let i = 0; i < depth; i++) ids[i] = stack[i].id
    return ids
  }

  function sameStack (a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  /**
   * Same matching loop as `tokenize`, but resumable: starts from an arbitrary
   * offset and lexer state instead of the beginning, and — the one thing that
   * makes re-lexing possible at all — records the mode/stack/line state
   * *before* every token, so a later edit can resume from the token nearest
   * it instead of from offset 0.
   *
   * With `recover: true`, an unmatched character no longer throws: it becomes
   * a single-character token of type `errorTokenName` and scanning continues,
   * which is what lets a syntax highlighter survive invalid/half-typed input.
   *
   * @param {string} text
   * @param {number} offset
   * @param {*} mode
   * @param {*[]} stack
   * @param {number} depth
   * @param {number} line
   * @param {number} lineStart
   * @returns {{ tokens: Token[], checkpoints: {modeId: number, stack: number[], line: number, lineStart: number, offset: number}[], mode: *, stack: *[], depth: number, line: number, lineStart: number }}
   */
  function scan (text, offset, mode, stack, depth, line, lineStart) {
    const tokens = []
    const checkpoints = []
    const length = text.length

    outer: while (offset < length) {
      checkpoints.push({ modeId: mode.id, stack: snapshotStack(stack, depth), line, lineStart, offset })

      const applicable = mode.dispatch ? candidates(mode, text.charCodeAt(offset)) : mode.members

      for (let i = 0; i < applicable.length; i++) {
        let def = applicable[i]

        let end = -1
        let matched = null
        if (def.members !== null) {
          end = fusedEnd(def, text, offset)
          if (end === -1) continue
          def = fusedMember
          matched = fusedText
        } else if (def.literal !== undefined) {
          if (text.startsWith(def.literal, offset)) end = offset + def.literal.length
        } else {
          end = def.scanner === null ? DEFER : scanEnd(def.scanner, text, offset, length)
          if (end === DEFER) {
            end = -1
            if (def.skip) {
              def.regex.lastIndex = offset
              if (def.regex.test(text) && def.regex.lastIndex > offset) end = def.regex.lastIndex
            } else {
              def.regex.lastIndex = offset
              const match = def.regex.exec(text)
              if (match !== null && match[0].length > 0) matched = match[0]
              if (matched !== null) end = offset + matched.length
            }
          }
        }

        if (end === -1) continue

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
          tokens.push(trackLines
            ? { type: winner.name, image, start: offset, end, line, col: offset - lineStart + 1 }
            : { type: winner.name, id: winner.id, image, start: offset, end })
        }

        if (trackLines) {
          for (let j = offset; j < end; j++) {
            if (text.charCodeAt(j) !== 10) continue
            line++
            lineStart = j + 1
          }
        }

        if (multiMode) {
          if (winner.popMode) {
            if (depth === 0) {
              if (!recover) {
                throw new LexError(
                  `Token '${winner.name}' popped the initial lexer mode at ${describe(offset, line, lineStart)}`,
                  { offset, line: trackLines ? line : 0, col: trackLines ? offset - lineStart + 1 : 0 }
                )
              }
              // Under recovery, an underflowing pop just stays in the current mode.
            } else {
              mode = stack[--depth]
            }
          } else if (winner.pushMode !== -1) {
            stack[depth++] = mode
            mode = modes[winner.pushMode]
          }
        }

        offset = end
        continue outer
      }

      if (recover) {
        tokens.push(trackLines
          ? { type: errorTokenName, image: text[offset], start: offset, end: offset + 1, line, col: offset - lineStart + 1 }
          : { type: errorTokenName, id: -1, image: text[offset], start: offset, end: offset + 1 })
        if (trackLines && text.charCodeAt(offset) === 10) {
          line++
          lineStart = offset + 1
        }
        offset++
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

    return { tokens, checkpoints, mode, stack, depth, line, lineStart }
  }

  /**
   * Full tokenize, but retaining the checkpoints `relex` needs to resume.
   * The result is opaque state to pass back into `relex`; only `.tokens` is
   * meant to be read directly.
   *
   * @param {string} text
   */
  function tokenizeIncremental (text) {
    if (typeof text !== 'string') throw new TypeError('tokenizeIncremental: expected a string')
    const result = scan(text, 0, initial, multiMode ? [] : [], 0, 1, 0)
    return { text, tokens: result.tokens, checkpoints: result.checkpoints, eof: { modeId: result.mode.id, stack: snapshotStack(result.stack, result.depth), line: result.line, lineStart: result.lineStart, offset: text.length } }
  }

  /**
   * Index of the first token with `.start >= offset` (tokens are produced in
   * ascending offset order, so this is a binary search, not a scan).
   */
  function tokenFloor (tokens, offset) {
    let lo = 0
    let hi = tokens.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (tokens[mid].start < offset) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * Index of the last checkpoint with `.offset <= offset`, treating `eof` as
   * one checkpoint past the end of `checkpoints` — so the result ranges over
   * `-1 .. checkpoints.length` inclusive, `checkpoints.length` meaning "eof".
   */
  function checkpointFloor (checkpoints, eof, offset) {
    let lo = 0
    let hi = checkpoints.length + 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const at = mid < checkpoints.length ? checkpoints[mid].offset : eof.offset
      if (at <= offset) lo = mid + 1
      else hi = mid
    }
    return lo - 1
  }

  /** Binary search for a checkpoint at an exact offset, or null. Also checks `eof`. */
  function checkpointAt (checkpoints, eof, offset) {
    if (eof.offset === offset) return eof
    let lo = 0
    let hi = checkpoints.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (checkpoints[mid].offset < offset) lo = mid + 1
      else hi = mid
    }
    return lo < checkpoints.length && checkpoints[lo].offset === offset ? checkpoints[lo] : null
  }

  /**
   * Re-lexes `newText` given the previous `tokenizeIncremental`/`relex` result
   * and a description of what changed, touching only the tokens an editor
   * would actually need to redraw: unaffected tokens are neither copied nor
   * reallocated, and only the region between the edit and the next point
   * where the lexer state provably reconverges is re-scanned. Everything
   * downstream of that point keeps its own object identity — it is mutated
   * in place (offsets shifted by a constant) rather than rebuilt, the same
   * way a real editor's buffer amends positions after an edit instead of
   * reallocating the whole document's worth of them. `prev` is invalidated
   * by this call — it *is* the returned value, mutated; do not keep using
   * a `prev` object after passing it to `relex`.
   *
   * A grammar requirement this depends on: any token whose pattern needs a
   * closing delimiter that can be arbitrarily far away — a block comment or
   * string written as one `/\*[\s\S]*?\*\/`-style regex, rather than a
   * pushMode/popMode pair — has genuinely unbounded lookahead. Typing the
   * missing closer somewhere later can retroactively fold an unbounded
   * amount of intervening text into one token, and no bounded backward walk
   * can see that coming (a checkpoint only records mode + mode-stack; a
   * single-regex delimited token leaves nothing there to notice). Express
   * such tokens as modes — the same reason the library's mode support
   * exists in the first place (see the Handlebars example above) — and this
   * stays correct; a monolithic delimiter regex can produce a wrong result
   * under `relex` even though `tokenize` handles it fine standalone.
   *
   * @param {string} newText
   * @param {{ text: string, tokens: Token[], checkpoints: object[], eof: object }} prev
   * @param {{ start: number, oldEnd: number, newEnd: number }} edit
   *   `start`/`oldEnd` describe the replaced span in the *old* text, `newEnd`
   *   where that span ends in `newText`.
   */
  function relex (newText, prev, edit) {
    if (typeof newText !== 'string') throw new TypeError('relex: expected a string')
    const tokens = prev.tokens
    const checkpoints = prev.checkpoints
    const delta = edit.newEnd - edit.oldEnd

    // The last old checkpoint at or before the edit start is where the old
    // lexer state is still known-good — but two different things can still
    // reach back further than that:
    //
    // 1. Maximal munch cascading through more than one *token*: `2` `.` next
    //    to an edit can become `2.3`, reaching back through two previous
    //    tokens (`\d+(?:\.\d+)?`), not just the one touching the edit. A gap
    //    bounds this — tokens can only merge by touching — so walking back
    //    across the whole contiguous, gap-free run of tokens ending at the
    //    resume point is always enough.
    //
    // 2. A *skip* token's own extent depending on what follows it — a line
    //    comment matched `//[^\n]*` up to a newline that the edit is about
    //    to delete. Skip tokens never appear in `tokens`, so (1) can't see
    //    them; back up one checkpoint first; checkpoints record every
    //    iteration, skip or not, and are always contiguous with each other
    //    (unlike tokens, which skip over the gaps skip-tokens fill in), so
    //    exactly one step is enough to reconsider whichever iteration —
    //    token or skip — actually touches the resume point.
    let resumeIndex = checkpointFloor(checkpoints, prev.eof, edit.start)
    if (resumeIndex > 0) resumeIndex--
    let boundary = resumeIndex < checkpoints.length ? checkpoints[resumeIndex].offset : prev.eof.offset
    let ti = tokenFloor(tokens, boundary)
    while (ti > 0 && tokens[ti - 1].end === boundary) {
      ti--
      boundary = tokens[ti].start
    }
    if (boundary < (resumeIndex < checkpoints.length ? checkpoints[resumeIndex].offset : prev.eof.offset)) {
      resumeIndex = checkpointFloor(checkpoints, prev.eof, boundary)
    }
    const resume = resumeIndex < checkpoints.length ? checkpoints[resumeIndex] : prev.eof
    const resumeMode = modes[resume.modeId]
    const resumeStack = resume.stack.map((id) => modes[id])

    const scanned = scan(newText, resume.offset, resumeMode, resumeStack, resumeStack.length, resume.line, resume.lineStart)
    const scannedEof = { modeId: scanned.mode.id, stack: snapshotStack(scanned.stack, scanned.depth), line: scanned.line, lineStart: scanned.lineStart, offset: newText.length }

    // A checkpoint's mode + stack matching is necessary but not sufficient: a
    // pattern with a lookbehind (`(?<!...)`, needed e.g. to tell `.5` apart
    // from a path segment written `@.a.5`) reads characters *before* its own
    // start, which a checkpoint carries no record of. Trusting old tail
    // tokens on state equality alone can silently keep a token the old lexer
    // only produced because of text that no longer sits where it looked.
    // `scanned` is already a fully correct scan to EOF regardless of where
    // convergence is found, so checking a small window of it against the
    // corresponding old tokens costs nothing extra — a candidate is only
    // accepted once actual tokens agree, not just lexer state.
    const VERIFY_WINDOW = 4
    function convergenceVerified (oldOffset, newOffset) {
      const oldStart = tokenFloor(tokens, oldOffset)
      const freshStart = tokenFloor(scanned.tokens, newOffset)
      for (let k = 0; k < VERIFY_WINDOW; k++) {
        const oldTok = tokens[oldStart + k]
        const freshTok = scanned.tokens[freshStart + k]
        if (oldTok === undefined && freshTok === undefined) return true
        if (oldTok === undefined || freshTok === undefined) return false
        if (oldTok.type !== freshTok.type || oldTok.image !== freshTok.image) return false
      }
      return true
    }

    // Look for a point past the edit where the freshly-scanned lexer state
    // matches what the old lexer had at the corresponding old offset — that's
    // where the untouched old token stream can be kept, past this point,
    // instead of re-scanned.
    let convergeNewOffset = -1
    let convergeOldOffset = -1
    let convergeOldCheckpoint = null
    let freshCheckpointCount = 0
    for (let s = 0; s <= scanned.checkpoints.length; s++) {
      const cp = s < scanned.checkpoints.length ? scanned.checkpoints[s] : scannedEof
      if (cp.offset < edit.newEnd) continue
      const oldOffset = cp.offset - delta
      const oldCp = checkpointAt(checkpoints, prev.eof, oldOffset)
      if (oldCp && oldCp.modeId === cp.modeId && sameStack(oldCp.stack, cp.stack) && convergenceVerified(oldOffset, cp.offset)) {
        convergeNewOffset = cp.offset
        convergeOldOffset = oldOffset
        convergeOldCheckpoint = oldCp
        freshCheckpointCount = s
        break
      }
    }

    const tokenFrom = tokenFloor(tokens, resume.offset)
    const checkpointFrom = resumeIndex

    if (convergeNewOffset === -1) {
      // No reconvergence found (e.g. the edit permanently changed the mode
      // stack, such as opening an unterminated string) — the full re-scan
      // `scan` already did stands as the rest of the result; nothing after
      // it survives to be spliced back in.
      tokens.splice(tokenFrom, tokens.length - tokenFrom, ...scanned.tokens)
      checkpoints.splice(checkpointFrom, checkpoints.length - checkpointFrom, ...scanned.checkpoints)
      prev.text = newText
      prev.eof = scannedEof
      return prev
    }

    const freshTokenCount = tokenFloor(scanned.tokens, convergeNewOffset)
    const lineDelta = trackLines ? scanned.checkpoints.length > freshCheckpointCount
      ? scanned.checkpoints[freshCheckpointCount].line - convergeOldCheckpoint.line
      : scannedEof.line - convergeOldCheckpoint.line
      : 0

    // The line *containing* the convergence point can't be shifted by a
    // formula — the edit may have inserted or removed newlines inside it, so
    // its true start has to come from the real scan. Every later line is
    // untouched original text reused verbatim past that point, so its start
    // shifts by the plain character delta.
    const boundaryOldLineStart = convergeOldCheckpoint.lineStart
    const boundaryNewLineStart = (freshCheckpointCount < scanned.checkpoints.length ? scanned.checkpoints[freshCheckpointCount] : scannedEof).lineStart
    const shiftedLineStart = (oldLineStart) => oldLineStart === boundaryOldLineStart ? boundaryNewLineStart : oldLineStart + delta

    const tailTokenFrom = tokenFloor(tokens, convergeOldOffset)
    for (let i = tailTokenFrom; i < tokens.length; i++) {
      const t = tokens[i]
      if (trackLines) {
        const oldLineStart = t.start - (t.col - 1)
        t.col = (t.start + delta) - shiftedLineStart(oldLineStart) + 1
        t.line += lineDelta
      }
      t.start += delta
      t.end += delta
    }
    tokens.splice(tokenFrom, tailTokenFrom - tokenFrom, ...scanned.tokens.slice(0, freshTokenCount))

    const tailCheckpointFrom = checkpointFloor(checkpoints, prev.eof, convergeOldOffset - 1) + 1
    for (let i = tailCheckpointFrom; i < checkpoints.length; i++) {
      const cp = checkpoints[i]
      cp.lineStart = shiftedLineStart(cp.lineStart)
      cp.line += lineDelta
      cp.offset += delta
    }
    checkpoints.splice(checkpointFrom, tailCheckpointFrom - checkpointFrom, ...scanned.checkpoints.slice(0, freshCheckpointCount))

    prev.text = newText
    prev.eof.lineStart = shiftedLineStart(prev.eof.lineStart)
    prev.eof.line += lineDelta
    prev.eof.offset += delta
    return prev
  }

  return { tokenize, tokenizeIncremental, relex, tokenNames, positions, modeNames }
}
