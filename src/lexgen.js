// @ts-check
'use strict'

import { firstCharSet } from './firstchars.js'
import { buildScanner, SCANNER_KINDS } from './scan.js'

/**
 * Writes a grammar's lexer out as JavaScript source.
 *
 * `createLexer` is an engine: handed the token table, it compiles regexes,
 * analyses them for first-character dispatch, picks hand-written scanners, builds
 * per-mode tables and fuses runs of regexes — at load time, in every process, and
 * it ships all of that to every consumer. None of it depends on anything but the
 * token table, so for an emitted parser it can happen once, when the file is
 * written. What is left to ship is the code that grammar needs.
 *
 * The generated `tokenize` means exactly what `createLexer(defs, options).tokenize`
 * means: for each offset the candidates are the tokens of the current mode whose
 * first character allows it, in declaration order, and the first that matches
 * wins. Same tokens, same fields, same errors. `test/lexgen.test.js` holds it to
 * that across every example grammar.
 *
 * Measured against the engine, for the emitted parser:
 *   - bundle: JSON 24.0 -> 9.6 KB minified (8.4 -> 3.1 KB gzipped); a seven-mode
 *     Handlebars grammar 44.6 -> 40.2 KB (12.1 -> 7.3 KB gzipped);
 *   - load: 2.5x quicker (nothing is analysed on import);
 *   - lexing: 1.4x on JSON (`offset` positions), 1.2x on Handlebars.
 *
 * The code is laid out around two decisions that came out of measuring:
 *
 * - **Dispatch is a table, not nested switches.** A table maps (mode, first
 *   character) to a candidate-list id, and each *distinct* list is written once.
 *   A switch per mode repeated the same bodies in every mode that shares most of
 *   its tokens (a template language's five expression modes), and made that
 *   grammar's lexer 38 KB instead of 14.
 * - **Patterns are read from the module's own token table**, not repeated, so a
 *   long lookaround pattern is in the file once.
 *
 * @param {any[]} defs  Token definitions, already validated (by `createLexer`).
 * @param {{ positions?: 'full' | 'offset', scanners?: boolean, fuse?: boolean }} [options]
 * @returns {string} A JavaScript expression that evaluates to the lexer object, which
 *   needs `tokens` (the definitions) and `LexError` in scope.
 */
export function generateLexer (defs, options = {}) {
  const positions = options.positions === 'offset' ? 'offset' : 'full'
  const trackLines = positions === 'full'
  const useScanners = options.scanners !== false
  const useFuse = options.fuse !== false

  // ---- modes: numbered the way createLexer numbers them ----
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
    const flags = def.ignoreCase ? 'iy' : 'y'
    return {
      id,
      name: def.name,
      skip: !!def.skip,
      literal: def.literal,
      pattern: def.pattern,
      flags,
      longerAlt: def.longerAlt || null,
      scanner: useScanners && def.pattern ? buildScanner(def.pattern, !!def.ignoreCase) : null,
      modes: modesOf(def),
      pushMode: def.pushMode ? idOf(def.pushMode) : -1,
      popMode: !!def.popMode,
      firstChars: def.literal !== undefined
        ? (def.literal.length > 0 ? new Set([def.literal.charCodeAt(0)]) : null)
        : firstCharSet(new RegExp(def.pattern, flags).source, !!def.ignoreCase)
    }
  })
  const byName = new Map(compiled.map((c) => [c.name, c]))
  const multiMode = modeNames.length > 1 || compiled.some((c) => c.popMode || c.pushMode !== -1)

  // ---- what the generated file needs besides the loop itself ----
  const regexes = []              // [token id, flags]: every token matched by a regex, read from `tokens`
  const regexIndex = new Map()
  const rxFor = (c) => {
    if (!regexIndex.has(c.id)) {
      regexIndex.set(c.id, regexes.length)
      regexes.push([c.id, c.flags])
    }
    return /** @type {number} */ (regexIndex.get(c.id))
  }
  const fusedRuns = []            // { flags, ids, rx }
  const helpers = []              // function source, one per scanner that needs a function
  const keywords = []             // [lower codes, upper codes] per KEYWORD token
  const lookFns = new Map()       // condition source -> name, for KEYWORD's trailing lookahead
  const need = { digits: false, hex: false, keyword: false }

  /** Statements that run a token's regex and, on a match, set id/end/matched and leave `found`. */
  function emitRegex (c) {
    const rx = rxFor(c)
    if (c.skip) {
      // A skipped token's text is never read, so `test` avoids building a match.
      return `RX[${rx}].lastIndex = offset; if (RX[${rx}].test(text) && RX[${rx}].lastIndex > offset) { id = ${c.id}; end = RX[${rx}].lastIndex; matched = null; break found }`
    }
    return `RX[${rx}].lastIndex = offset; m = RX[${rx}].exec(text); if (m !== null && m[0].length > 0) { id = ${c.id}; matched = m[0]; end = offset + matched.length; break found }`
  }

  /**
   * Statements that try one definition at `offset`. A token appears in many candidate lists but its code is
   * the same in each, and writing it records helpers and tables, so it is produced once.
   */
  const emitted = new Map()
  function emitDef (c) {
    let code = emitted.get(c.id)
    if (code === undefined) {
      code = emitDefOnce(c)
      emitted.set(c.id, code)
    }
    return code
  }

  function emitDefOnce (c) {
    if (c.literal !== undefined) {
      const lit = c.literal
      const test = lit.length === 1 ? `code === ${lit.charCodeAt(0)}` : `text.startsWith(${q(lit)}, offset)`
      return `if (${test}) { id = ${c.id}; end = offset + ${lit.length}; matched = ${q(lit)}; break found }`
    }
    const s = c.scanner
    if (s === null) return emitRegex(c)
    const hit = `{ id = ${c.id}; end = e; matched = null; break found }`

    switch (s.kind) {
      case SCANNER_KINDS.CLASS: {
        if (s.wide) {
          // `\s`: a non-ASCII character is not ours to judge, so the regex decides there.
          helpers.push(wideClassHelper(c.id, s))
          return `{ const e = scan${c.id}(text, offset, length); if (e === -2) { ${emitRegex(c)} } else if (e !== -1) ${hit} }`
        }
        return `if (${condition(s.first, 'code')}) { let j = offset + 1; while (j < length) { const c = text.charCodeAt(j); if (!(${condition(s.rest, 'c')})) break; j++ } id = ${c.id}; end = j; matched = null; break found }`
      }
      case SCANNER_KINDS.SEQ2:
        return `if (${condition(s.first, 'code')}) { let j = offset + 1; while (j < length) { const c = text.charCodeAt(j); if (${condition(s.first, 'c')}) j++; else break } const mid = j; while (j < length) { const c = text.charCodeAt(j); if (${condition(s.second, 'c')}) j++; else break } if (j > mid) { id = ${c.id}; end = j; matched = null; break found } }`
      case SCANNER_KINDS.KEYWORD: {
        need.keyword = true
        const cond = condition(s.look, 'c')
        let look = lookFns.get(cond)
        if (look === undefined) {
          look = `look${lookFns.size}`
          lookFns.set(cond, look)
        }
        keywords.push([s.lower, s.upper])
        return `{ const e = scanKeyword(text, offset, length, KW[${keywords.length - 1}][0], KW[${keywords.length - 1}][1], ${look}); if (e !== -1) ${hit} }`
      }
      case SCANNER_KINDS.LINE:
        return `if (text.startsWith(${q(s.prefix)}, offset)) { let j = offset + ${s.prefix.length}; while (j < length) { const c = text.charCodeAt(j); if (${condition(s.look, 'c')}) break; j++ } id = ${c.id}; end = j; matched = null; break found }`
      case SCANNER_KINDS.QUOTED:
        helpers.push(quotedHelper(c.id, s))
        return `{ const e = scan${c.id}(text, offset); if (e !== -1) ${hit} }`
      case SCANNER_KINDS.NUMBER:
        need.digits = true
        helpers.push(numberHelper(c.id, s))
        return `{ const e = scan${c.id}(text, offset, length); if (e !== -1) ${hit} }`
      case SCANNER_KINDS.STRING:
        if (s.uni) need.hex = true
        helpers.push(stringHelper(c.id, s))
        return `{ const e = scan${c.id}(text, offset, length); if (e !== -1) ${hit} }`
      default:
        return emitRegex(c)
    }
  }

  /** Two definitions can share one fused alternation only if their patterns cannot disturb each other's groups. */
  const fusible = (c) =>
    c.literal === undefined && c.scanner === null &&
    !/\\[1-9]|\\k</.test(c.pattern) &&
    new RegExp(c.pattern + '|').exec('').length === 1

  /**
   * The code for a whole candidate list. Runs of three or more consecutive regexes are fused into one
   * alternation (see `fuse` in lexer.js for why and for the measurements): one regex call rather than one
   * per rejected token, and the engine tries the members left to right exactly as this loop would.
   */
  function emitList (list) {
    const out = []
    for (let i = 0; i < list.length;) {
      let j = i
      while (useFuse && j < list.length && fusible(list[j]) && list[j].flags === list[i].flags) j++
      if (j - i < 3) {
        out.push(emitDef(list[i]))
        i++
        continue
      }
      const run = list.slice(i, j)
      run.forEach(rxFor)
      const k = fusedRuns.length
      fusedRuns.push({ flags: run[0].flags, ids: run.map((d) => d.id), rx: run.map((d) => /** @type {number} */ (regexIndex.get(d.id))) })
      out.push(
        `FX[${k}].lastIndex = offset; m = FX[${k}].exec(text)
          if (m !== null) {
            if (m[0].length > 0) { let g = 1; while (m[g] === undefined) g++; id = FIDS[${k}][g - 1]; matched = m[0]; end = offset + matched.length; break found }
            // An empty match is "no match" to a lexer, so the members after it still get their turn.
            for (let k = 0; k < FRX[${k}].length; k++) { const r = RX[FRX[${k}][k]]; r.lastIndex = offset; const mm = r.exec(text); if (mm !== null && mm[0].length > 0) { id = FIDS[${k}][k]; matched = mm[0]; end = offset + matched.length; break found } }
          }`)
      i = j
    }
    return out.join('\n          ')
  }

  // ---- dispatch: (mode, first character) -> candidate list, each distinct list written once ----
  const lists = [{ list: /** @type {any[]} */ ([]) }]     // list 0 is "no candidates"
  const listIds = new Map([['', 0]])
  const listFor = (list) => {
    const key = list.map((c) => c.id).join(',')
    let id = listIds.get(key)
    if (id === undefined) {
      id = lists.length
      listIds.set(key, id)
      lists.push({ list })
    }
    return id
  }
  const WIDTH = 129                                       // 128 ASCII codes, then "anything else"
  const table = []
  for (const name of modeNames) {
    const members = compiled.filter((c) => c.modes.includes(name))
    if (members.length === 0) throw new Error(`generateLexer: mode '${name}' has no tokens`)
    // Definitions whose first characters could not be determined must be tried everywhere.
    const dispatch = members.some((c) => c.firstChars !== null)
    for (let code = 0; code < 128; code++) {
      table.push(listFor(dispatch ? members.filter((c) => c.firstChars === null || c.firstChars.has(code)) : members))
    }
    // Any non-ASCII character: every token that could begin with one. A superset is safe, because
    // each candidate still has to match.
    table.push(listFor(dispatch ? members.filter((c) => c.firstChars === null || [...c.firstChars].some((x) => x >= 128)) : members))
  }
  if (lists.length > 60000) throw new Error('generateLexer: too many distinct candidate lists')
  const dispatchTable = String.fromCharCode(...table.map((id) => 256 + id))
  const listCases = lists.slice(1).map(({ list }, i) => `case ${i + 1}: {\n          ${emitList(list)}\n          break\n        }`)

  // ---- longerAlt: after a token matches, a longer match of its alternative wins ----
  const longer = compiled.filter((c) => c.longerAlt)
  const longerCode = longer.length === 0
    ? ''
    : `
      switch (id) {
${longer.map((c) => {
    const alt = /** @type {any} */ (byName.get(/** @type {string} */ (c.longerAlt)))
    const altEnd = alt.literal !== undefined
      ? `text.startsWith(${q(alt.literal)}, offset) ? offset + ${alt.literal.length} : -1`
      : `(RX[${rxFor(alt)}].lastIndex = offset, RX[${rxFor(alt)}].test(text) ? RX[${rxFor(alt)}].lastIndex : -1)`
    return `        case ${c.id}: { const altEnd = ${altEnd}; if (altEnd > end) { end = altEnd; id = ${alt.id}; matched = ${alt.literal !== undefined ? q(alt.literal) : 'null'} } break }`
  }).join('\n')}
      }`

  // ---- mode transitions belong to the token that finally won ----
  const transitions = compiled.filter((c) => c.popMode || c.pushMode !== -1)
  const describe = trackLines ? "'line ' + line + ' column ' + (offset - lineStart + 1)" : "'offset ' + offset"
  const transitionCode = transitions.length === 0
    ? ''
    : `
      switch (id) {
${transitions.map((c) => c.popMode
    ? `        case ${c.id}:
          if (depth === 0) throw new LexError('Token \\'' + NAMES[id] + '\\' popped the initial lexer mode at ' + ${describe}, { offset, line: ${trackLines ? 'line' : '0'}, col: ${trackLines ? 'offset - lineStart + 1' : '0'} })
          mode = stack[--depth]
          break`
    : `        case ${c.id}: stack[depth++] = mode; mode = ${c.pushMode}; break`).join('\n')}
      }`

  const where = trackLines ? "'line ' + line + ' column ' + column" : "'offset ' + offset"
  const inMode = modeNames.length > 1 ? " + ' (in lexer mode \\'' + MODE_NAMES[mode] + '\\')'" : ''

  // Everything below is assembled last: emitting the lists above is what discovers which helpers are needed.
  return `(() => {
  const NAMES = tokens.map((t) => t.name)
  const SKIP = tokens.map((t) => (t.skip ? 1 : 0))
  const DISPATCH = ${q(dispatchTable)}
  ${modeNames.length > 1 ? `const MODE_NAMES = ${q(modeNames)}` : ''}
  // Patterns are read from the token table above rather than repeated here.
  const RX = ${q(regexes)}.map(([i, flags]) => new RegExp(tokens[i].pattern, flags))
  ${fusedRuns.length ? `const FX = ${q(fusedRuns.map((f) => [f.ids, f.flags]))}.map(([ids, flags]) => new RegExp(ids.map((i) => '(' + tokens[i].pattern + ')').join('|'), flags))
  const FIDS = ${q(fusedRuns.map((f) => f.ids))}
  const FRX = ${q(fusedRuns.map((f) => f.rx))}` : ''}
  ${need.digits ? 'const skipDigits = (text, i, length) => { while (i < length) { const c = text.charCodeAt(i); if (c < 48 || c > 57) break; i++ } return i }' : ''}
  ${need.hex ? 'const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)' : ''}
  ${need.keyword ? `const KW = ${q(keywords)}\n  ${[...lookFns].map(([cond, name]) => `const ${name} = (c) => ${cond}`).join('\n  ')}\n  ${KEYWORD_HELPER}` : ''}
  ${helpers.join('\n')}

  function tokenize (text) {
    if (typeof text !== 'string') throw new TypeError('tokenize: expected a string')
    const tokens_ = []
    let offset = 0
    let line = 1
    let lineStart = 0
    const length = text.length
    ${multiMode ? 'let mode = 0\n    const stack = []\n    let depth = 0' : ''}
    let m = null
    while (offset < length) {
      const code = text.charCodeAt(offset)
      let id = -1
      let end = -1
      let matched = null
      found: {
        switch (DISPATCH.charCodeAt(${multiMode ? `mode * ${WIDTH} + ` : ''}(code < 128 ? code : 128)) - 256) {
        ${listCases.join('\n        ')}
        }
      }
      if (id === -1) {
        const column = offset - lineStart + 1
        throw new LexError('Unexpected character \\'' + text[offset] + '\\' at ' + ${where}${inMode}, { offset, line: ${trackLines ? 'line' : '0'}, col: ${trackLines ? 'column' : '0'} })
      }${longerCode}
      if (SKIP[id] === 0) {
        const image = matched !== null ? matched : text.slice(offset, end)
        tokens_.push(${trackLines
    ? '{ type: NAMES[id], image, start: offset, end, line, col: offset - lineStart + 1 }'
    : '{ type: NAMES[id], id, image, start: offset, end }'})
      }
      ${trackLines ? 'for (let j = offset; j < end; j++) { if (text.charCodeAt(j) !== 10) continue; line++; lineStart = j + 1 }' : ''}${transitionCode}
      offset = end
    }
    return tokens_
  }
  return { tokenize, tokenNames: NAMES, positions: ${q(positions)}, modeNames: ${q(modeNames)} }
})()`
}

// ---------------------------------------------------------------------------------------------
// helpers shared by the generator
// ---------------------------------------------------------------------------------------------

const DEFAULT_MODE = 'default'
const q = JSON.stringify

/** The modes one definition belongs to, however it spelled them (as lexer.js reads them). */
function modesOf (def) {
  if (Array.isArray(def.modes) && def.modes.length > 0) return def.modes
  if (def.mode) return [def.mode]
  return [DEFAULT_MODE]
}

/**
 * A JavaScript condition on the character code in `v` that is true exactly for the members of a
 * 128-entry table, written as ranges: `v === 95 || (v >= 48 && v <= 57)`.
 *
 * @param {Uint8Array} table
 * @param {string} v
 */
function condition (table, v) {
  const parts = []
  for (let i = 0; i < 128;) {
    if (table[i] !== 1) {
      i++
      continue
    }
    let j = i
    while (j + 1 < 128 && table[j + 1] === 1) j++
    parts.push(i === j ? `${v} === ${i}` : `(${v} >= ${i} && ${v} <= ${j})`)
    i = j + 1
  }
  return parts.length > 0 ? parts.join(' || ') : 'false'
}

// The scanners below are `scan.js`'s cases written out for one token, with its fields as constants.
// Where they differ in form they must not differ in meaning; test/lexgen.test.js checks that.

/** KEYWORD: shared by every keyword token, which differ only in their tables. */
const KEYWORD_HELPER = `function scanKeyword (text, offset, length, lower, upper, look) {
    const n = lower.length
    if (offset + n > length) return -1
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(offset + i)
      if (c !== lower[i] && c !== upper[i]) return -1
    }
    const end = offset + n
    if (end < length && look(text.charCodeAt(end))) return -1
    return end
  }`

/** CLASS over `\s`: returns -2 where a non-ASCII character means the regex has to decide. */
function wideClassHelper (id, s) {
  return `function scan${id} (text, offset, length) {
    const code = text.charCodeAt(offset)
    if (code >= 128) return -2
    if (!(${condition(s.first, 'code')})) return -1
    let j = offset + 1
    while (j < length) {
      const c = text.charCodeAt(j)
      if (c >= 128) return -2
      if (!(${condition(s.rest, 'c')})) break
      j++
    }
    return j
  }`
}

/** QUOTED: `'(?:''|[^'])*'`, where the regex prefers `''` as an escape and backs off to the latest pair. */
function quotedHelper (id, s) {
  return `function scan${id} (text, offset) {
    if (text.charCodeAt(offset) !== ${s.quote}) return -1
    let fallback = -1
    let j = offset + 1
    for (;;) {
      j = text.indexOf(${q(String.fromCharCode(s.quote))}, j)
      if (j === -1) return fallback
      if (text.charCodeAt(j + 1) !== ${s.quote}) return j + 1
      fallback = j + 1
      j += 2
    }
  }`
}

/** NUMBER: a sign, an integer part, a fraction and an exponent, each only if the pattern has it. */
function numberHelper (id, s) {
  return `function scan${id} (text, offset, length) {
    let j = offset
    ${s.sign ? 'if (text.charCodeAt(j) === 45) j++' : ''}
    const c = text.charCodeAt(j)
    ${s.jsonInt
    ? 'if (c === 48) j++\n    else if (c >= 49 && c <= 57) j = skipDigits(text, j + 1, length)\n    else return -1'
    : 'if (!(c >= 48 && c <= 57)) return -1\n    j = skipDigits(text, j + 1, length)'}
    ${s.frac ? 'if (text.charCodeAt(j) === 46) { const k = skipDigits(text, j + 1, length); if (k > j + 1) j = k }' : ''}
    ${s.exp ? 'const e = text.charCodeAt(j)\n    if (e === 101 || e === 69) { let k = j + 1; const sg = text.charCodeAt(k); if (sg === 43 || sg === 45) k++; const end = skipDigits(text, k, length); if (end > k) j = end }' : ''}
    return j
  }`
}

/** STRING: a quote, then characters and escapes, then the quote. */
function stringHelper (id, s) {
  return `function scan${id} (text, offset, length) {
    if (text.charCodeAt(offset) !== ${s.quote}) return -1
    let j = offset + 1
    for (;;) {
      if (j >= length) return -1
      const c = text.charCodeAt(j)
      if (c === ${s.quote}) return j + 1
      if (c === 92) {
        const d = text.charCodeAt(j + 1)
        ${s.escAny
    ? 'if (!(d >= 0) || d === 10 || d === 13 || d === 0x2028 || d === 0x2029) return -1\n        j += 2'
    : `if (${condition(s.esc, 'd')}) j += 2\n        ${s.uni ? 'else if (d === 117 && isHex(text.charCodeAt(j + 2)) && isHex(text.charCodeAt(j + 3)) && isHex(text.charCodeAt(j + 4)) && isHex(text.charCodeAt(j + 5))) j += 6\n        ' : ''}else return -1`}
        continue
      }
      ${s.ctrl ? 'if (c < 32) return -1' : ''}
      j++
    }
  }`
}
