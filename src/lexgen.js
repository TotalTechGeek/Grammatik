// @ts-check
'use strict'

import { firstCharSet } from './firstchars.js'
import { buildScanner, mayContainNewline, SCANNER_KINDS } from './scan.js'
import { parseToken, parseRelaxed, isDeterministic, buildDfa, loopedLookahead, SYM, OTHER, NAWS, BOS } from './dfa.js'
import { analyzeWords } from './words.js'

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
 * @param {{ positions?: 'full' | 'offset', scanners?: boolean, fuse?: boolean, dfa?: boolean, words?: boolean }} [options]
 * @returns {string} A JavaScript expression that evaluates to the lexer object, which
 *   needs `tokens` (the definitions) and `LexError` in scope.
 */
export function generateLexer (defs, options = {}) {
  const positions = options.positions === 'offset' ? 'offset' : 'full'
  const trackLines = positions === 'full'
  const useScanners = options.scanners !== false
  const useFuse = options.fuse !== false
  const useDfa = options.dfa !== false
  const useWords = options.words !== false

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
        : firstCharSet(new RegExp(def.pattern, flags).source, !!def.ignoreCase),
      // What dfa.js makes of the pattern, and whether the DFA's longest accepted prefix is the end its regex reports.
      parsed: null,
      exact: false,
      filter: false
    }
  })
  if (useDfa) {
    for (const c of compiled) {
      if (!c.pattern) continue
      let token = parseToken(c.pattern, c.flags === 'iy')
      let filter = false
      if (token === null) {
        // Not modelled exactly, but without the assertions it cannot model it can still say it certainly does not match here.
        token = parseRelaxed(c.pattern, c.flags === 'iy')
        if (token === null) continue
        filter = true
      }
      // A lookahead in every iteration of a loop makes the automaton report a delayed match at every character, which
      // costs more than the regex engine does for it: measured on Handlebars' names, the walk was slower than the regex,
      // and leaving them out made the lexer 4% quicker than with them.
      if (loopedLookahead(token.tree)) continue
      c.parsed = token
      c.filter = filter
      c.exact = !filter && isDeterministic(token.tree)
    }
  }
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
  // ---- DFA groups (see dfa.js and `dfaGroups` in lexer.js) ----
  // Here only runs in which every pattern's end is the DFA's — deterministic, or able to end in one place only — so the
  // generated code needs no fallback to a matcher of its own. That is known only once the automaton exists, so a run is
  // built first and split at the patterns that fail it.
  const dfas = []
  const dfaPlans = new Map()

  /** A run of filter definitions: one automaton that says which of them may match, if there are few enough to name in a bit each. */
  function planFilter (run) {
    const key = 'f' + run.map((d) => d.id).join(',')
    let plan = dfaPlans.get(key)
    if (plan !== undefined) return plan
    plan = run.map((def) => ({ def }))
    const dfa = run.length <= 31 ? buildDfa(run.map((d) => d.parsed)) : null
    if (dfa !== null) plan = [{ group: dfas.push({ dfa, ids: run.map((d) => d.id), filter: true, members: run }) - 1, size: run.length, filter: true }]
    dfaPlans.set(key, plan)
    return plan
  }

  /**
   * How a maximal run of DFA-eligible definitions is to be written: groups (`{ group, size }`) and the definitions that
   * stay as they are (`{ def }`).
   */
  function planDfa (run) {
    const key = run.map((d) => d.id).join(',')
    let plan = dfaPlans.get(key)
    if (plan !== undefined) return plan
    // `Boolean` then `AnchoredCell, Cell, Identifier` is the second group with the first prepended: the states of the second written
    // out twice. When the tail of a run already has a group of its own, the head is planned alone and the tail is reused.
    for (let from = 1; from < run.length; from++) {
      const tail = dfaPlans.get(run.slice(from).map((d) => d.id).join(','))
      if (tail !== undefined && tail.length === 1 && tail[0].group !== undefined && !tail[0].filter) {
        plan = [...planDfa(run.slice(0, from)), tail[0]]
        dfaPlans.set(key, plan)
        return plan
      }
    }
    plan = run.map((def) => ({ def }))
    const dfa = buildDfa(run.map((d) => d.parsed))
    if (dfa !== null) {
      const exact = run.map((d, k) => d.exact || dfa.prefixFree[k] === 1)
      if (exact.every(Boolean)) {
        // The generated scanners are straight-line code and beat a table walk, so a run is worth walking only where
        // it replaces regex calls: measured, a SQL lexer made of keyword scanners got 20% slower grouped, and a
        // formula lexer with regex-backed cell references and numbers got 8% quicker.
        if (run.some((d) => d.scanner === null)) plan = [{ group: dfas.push({ dfa, ids: run.map((d) => d.id) }) - 1, size: run.length }]
      } else if (run.length > 1) {
        // Group what can be grouped on either side of each pattern that cannot, and leave those as they are.
        plan = []
        for (let from = 0; from < run.length;) {
          if (!exact[from]) { plan.push({ def: run[from] }); from++; continue }
          let to = from
          while (to < run.length && exact[to]) to++
          plan.push(...planDfa(run.slice(from, to)))
          from = to
        }
      }
    }
    dfaPlans.set(key, plan)
    return plan
  }

  // ---- keyword groups (see words.js) ----
  const wordGroups = []
  const wordIndex = new Map()
  function wordFor (run) {
    const key = run.map((d) => d.id).join(',')
    let k = wordIndex.get(key)
    if (k === undefined) {
      const found = analyzeWords(run, (d) => d.flags === 'iy')
      k = found === null ? -1 : wordGroups.push(found) - 1
      wordIndex.set(key, k)
    }
    return k
  }

  /** Plain definitions in order, with runs of regexes fused (see `fuse` in lexer.js). */
  function emitPlain (list) {
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
    return out
  }

  /**
   * The code for a whole candidate list: first decide what each stretch of it is — a keyword group, a DFA group, or plain
   * definitions — then write it out, fusing the plain stretches.
   */
  function emitList (list) {
    /** @type {({ word: number } | { dfa: number } | { defs: any[] })[]} */
    const items = []
    const plain = (def) => {
      const last = items[items.length - 1]
      if (last !== undefined && 'defs' in last) last.defs.push(def)
      else items.push({ defs: [def] })
    }
    for (let i = 0; i < list.length;) {
      if (useWords) {
        let w = i
        while (w < list.length && list[w].scanner !== null && list[w].scanner.kind === SCANNER_KINDS.KEYWORD) w++
        const k = w > i && w < list.length ? wordFor(list.slice(i, w + 1)) : -1
        if (k !== -1) {
          items.push({ word: k })
          i = w + 1
          continue
        }
      }
      if (useDfa) {
        let e = i
        while (e < list.length && list[e].parsed !== null && list[e].literal === undefined && list[e].filter === list[i].filter) e++
        if (e > i) {
          const run = list.slice(i, e)
          for (const piece of run[0].filter ? planFilter(run) : planDfa(run)) {
            if (piece.def !== undefined) plain(piece.def)
            else items.push(piece.filter ? { filter: piece.group } : { dfa: piece.group })
          }
          i = e
          continue
        }
      }
      plain(list[i])
      i++
    }
    const out = []
    for (const item of items) {
      if ('word' in item) out.push(`{ const e = word${item.word}(text, offset, length); if (e !== -1) { id = wordId; end = e; matched = null; break found } }`)
      else if ('dfa' in item) out.push(`{ const e = dfa${item.dfa}(text, offset, length); if (e !== -1) { id = dfaId; end = e; matched = null; break found } }`)
      else if ('filter' in item) {
        // The automaton names the definitions that may match; each of those is asked for real, in order. A group that has
        // found it rules out too little stops walking and asks all of them, as it would have without the automaton.
        const k = item.filter
        const members = dfas[k].members
        out.push(`{
          let maybe${k} = -1
          if (!off${k}) {
            maybe${k} = dfa${k}(text, offset, length)
            if (++calls${k} === 64 && passes${k} * 10 > 448) off${k} = true
            if (maybe${k} !== 0 && calls${k} <= 64) passes${k}++
          }
          if (maybe${k} !== 0) {
            ${members.map((d, t) => `if ((maybe${k} & ${1 << t}) !== 0) { ${emitDef(d)} }`).join('\n            ')}
          }
        }`)
      }
      else out.push(...emitPlain(item.defs))
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
  // Plan every run of DFA-eligible definitions shortest first, so that a longer run can reuse the group of its tail.
  if (useDfa) {
    const runs = new Map()
    for (const { list } of lists.slice(1)) {
      for (let i = 0; i < list.length;) {
        if (useWords) {
          let w = i
          while (w < list.length && list[w].scanner !== null && list[w].scanner.kind === SCANNER_KINDS.KEYWORD) w++
          if (w > i && w < list.length && wordFor(list.slice(i, w + 1)) !== -1) { i = w + 1; continue }
        }
        let e = i
        while (e < list.length && list[e].parsed !== null && list[e].literal === undefined && list[e].filter === list[i].filter) e++
        if (e > i) {
          const run = list.slice(i, e)
          if (!run[0].filter) runs.set(run.map((d) => d.id).join(','), run)
          i = e
        } else {
          i++
        }
      }
    }
    for (const run of [...runs.values()].sort((a, b) => a.length - b.length)) planDfa(run)
  }
  const listCases = lists.slice(1).map(({ list }, i) => `case ${i + 1}: {\n          ${emitList(list)}\n          break\n        }`)

  // ---- longerAlt: after a token matches, a longer match of its alternative wins ----
  const longer = compiled.filter((c) => c.longerAlt)
  const NL = compiled.map((c) => (mayContainNewline(c) ? 1 : 0))
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
  ${trackLines ? `const NL = ${q(NL)}` : ''}
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
  ${dfas.length ? dfaSource(dfas) : ''}
  ${wordGroups.length ? wordSource(wordGroups) : ''}

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
      ${trackLines ? 'if (NL[id] === 1) for (let j = offset; j < end; j++) { if (text.charCodeAt(j) !== 10) continue; line++; lineStart = j + 1 }' : ''}${transitionCode}
      offset = end
    }
    return tokens_
  }
  return { tokenize, tokenNames: NAMES, positions: ${q(positions)}, modeNames: ${q(modeNames)} }
})()`
}

/**
 * The DFA groups written out as code: one function per group, one `case` per state. A state's outgoing transitions are
 * character tests (the same `condition` the scanners use, plus a test for the two kinds of non-ASCII character), and
 * what a state reports is decided here, so the function reads no table and does no generic bookkeeping. The walk it
 * replaces is `dfaEnd` in lexer.js, and this must mean exactly what that means for a group whose every pattern is
 * exact: the first pattern (in order) that ever reports a valid end wins, and ends where it last reported one. A report
 * is `(pattern, delay)`: the match ended `delay` characters before the point where its lookahead resolved, or, at the
 * end of the text, `delay` before the end. A group whose start depends on the character before the match picks its start
 * state from that character.
 */
function dfaSource (dfas) {
  // The same few character sets (letters, digits, word characters) are tested in state after state. Each distinct set is written
  // once, as a predicate, and named where it is used: the engine inlines a function this small, and the file does not repeat
  // `(c >= 65 && c <= 90) || (c >= 97 && c <= 122) || ...` in every state.
  const predicates = new Map()
  const runners = new Set()
  const predicate = (set) => {
    const ascii = condition(set, 'c')
    const wide = set[OTHER] && set[NAWS] ? 'c >= 128' : set[OTHER] ? '(c >= 128 && !isNaWs(c))' : set[NAWS] ? '(c >= 128 && isNaWs(c))' : null
    const body = [ascii === 'false' ? null : ascii, wide].filter(Boolean).join(' || ')
    let name = predicates.get(body)
    if (name === undefined) {
      name = `is${predicates.size}`
      predicates.set(body, name)
    }
    return name
  }
  const functions = dfas.map(({ dfa, ids, filter }, k) => {
    const { trans, T } = dfa
    const states = trans.length / SYM
    const update = filter
      ? (tok) => `mask |= ${1 << tok}`
      : (tok, end) => `if (winner === -1 || ${tok} < winner) { winner = ${tok}; end = ${end} } else if (winner === ${tok} && ${end} > end) end = ${end}`
    const report = (tok, delay, base) => (delay === 0 ? update(tok, base) : `if (${base} - ${delay} > offset) { ${update(tok, `${base} - ${delay}`)} }`)

    const moves = []
    const accepting = []
    const atEnd = []
    for (let q = 1; q < states; q++) {
      const byTarget = new Map()
      for (let c = 0; c < SYM; c++) {
        const to = trans[q * SYM + c]
        if (to === 0 || c === 130) continue
        if (!byTarget.has(to)) byTarget.set(to, new Uint8Array(SYM))
        byTarget.get(to)[c] = 1
      }
      const test = (set, v) => `${predicate(set)}(${v})`
      const tests = [...byTarget].map(([to, set]) => {
        if (to === q) {
          // A state that loops on itself: run the loop here. What the state reports is the same at every turn of it and
          // only the last end matters, so it is reported once, when the loop is done.
          const name = predicate(set)
          runners.add(name)
          return `if (${name}(c)) { i = ${name.replace('is', 'skip')}(text, i, length) }`
        }
        return `if (${test(set, 'c')}) { state = ${to} }`
      })
      moves.push(tests.length ? `case ${q}: ${tests.join(' else ')} else break loop; break` : `case ${q}: break loop`)

      const reports = []
      for (let tok = 0; tok < T; tok++) if (dfa.accepts[q * T + tok] === 1) reports.push(report(tok, 0, 'i'))
      for (let at = dfa.lateStart[q]; at < dfa.lateStart[q + 1]; at += 2) reports.push(report(dfa.lateData[at], dfa.lateData[at + 1], 'i'))
      if (reports.length) accepting.push(`case ${q}: ${reports.join('; ')}; break`)

      const ending = []
      for (let at = dfa.eosStart[q]; at < dfa.eosStart[q + 1]; at += 2) ending.push(report(dfa.eosData[at], dfa.eosData[at + 1], 'length'))
      if (ending.length) atEnd.push(`case ${q}: ${ending.join('; ')}; break`)
    }
    const begin = dfa.hasCtx
      ? `const S${k} = ${JSON.stringify(Array.from(dfa.starts))}\n  `
      : ''
    const first = dfa.hasCtx ? `S${k}[offset === 0 ? ${BOS} : symOf(text.charCodeAt(offset - 1))]` : String(dfa.start)
    if (filter) {
      return `${begin}let calls${k} = 0
  let passes${k} = 0
  let off${k} = false
  function dfa${k} (text, offset, length) {
    let state = ${first}
    let mask = 0
    let i = offset
    loop: for (; i < length;) {
      const c = text.charCodeAt(i)
      switch (state) {
        ${moves.join('\n        ')}
      }
      i++
      ${accepting.length ? `switch (state) {\n        ${accepting.join('\n        ')}\n      }` : ''}
    }
    ${atEnd.length ? `if (i >= length) {\n      switch (state) {\n        ${atEnd.join('\n        ')}\n      }\n    }` : ''}
    return mask
  }`
    }
    return `${begin}const G${k} = ${JSON.stringify(ids)}
  function dfa${k} (text, offset, length) {
    let state = ${first}
    let winner = -1
    let end = -1
    let i = offset
    loop: for (; i < length;) {
      const c = text.charCodeAt(i)
      switch (state) {
        ${moves.join('\n        ')}
      }
      i++
      ${accepting.length ? `switch (state) {\n        ${accepting.join('\n        ')}\n      }` : ''}
    }
    ${atEnd.length ? `if (i >= length) {\n      switch (state) {\n        ${atEnd.join('\n        ')}\n      }\n    }` : ''}
    if (winner === -1) return -1
    dfaId = G${k}[winner]
    return end
  }`
  })
  const definitions = [...predicates].map(([body, name]) => `const ${name} = (c) => ${body}`).join('\n  ')
  const skippers = [...runners].map((name) => `const ${name.replace('is', 'skip')} = (text, i, length) => { while (i + 1 < length && ${name}(text.charCodeAt(i + 1))) i++; return i }`).join('\n  ')
  const usesNote = false
  return `let dfaId = 0
  ${usesNote ? `let dW = -1
  let dE = -1
  // A group reports each match it passes; the lowest-numbered pattern wins, and ends at the last place it reported.
  const note = (t, e) => { if (dW === -1 || t < dW) { dW = t; dE = e } else if (dW === t && e > dE) dE = e }` : ''}
  const isNaWs = (c) => c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  const symOf = (c) => (c < 128 ? c : isNaWs(c) ? ${NAWS} : ${OTHER})
  ${definitions}
  ${skippers}
  ${functions.join('\n  ')}`
}

/**
 * Keyword groups written out: scan the identifier's run once, hashing as it goes, then `switch` on the hash. Each
 * case confirms the word character by character, so a hash collision costs a comparison and never a wrong answer.
 * Must mean what `wordEnd` in lexer.js means.
 */
function wordSource (groups) {
  const functions = groups.map((g, k) => {
    const byHash = new Map()
    for (const e of g.entries) {
      if (!byHash.has(e.hash)) byHash.set(e.hash, [])
      byHash.get(e.hash).push(e)
    }
    const cases = [...byHash].map(([hash, entries]) => {
      const tests = entries.map((e) => {
        const chars = e.lower.map((lo, n) => {
          const up = e.upper[n]
          return lo === up ? `text.charCodeAt(offset + ${n}) === ${lo}` : `((c = text.charCodeAt(offset + ${n})) === ${lo} || c === ${up})`
        })
        return `if (len === ${e.lower.length} && ${chars.join(' && ')}) { wordId = ${g.keywords[e.index].id}; return j }`
      })
      return `case ${hash}: ${tests.join('\n        ')}\n        break`
    })
    const foldCode = g.fold ? 'if (c >= 65 && c <= 90) c += 32\n      ' : ''
    // An identifier whose continue-set is larger than the keywords' lookahead goes on past the end of the run, and one that may
    // start with something outside it starts from nothing.
    const extend = g.extend
      ? `if (j === offset) j++
    while (j < length) {
      c = text.charCodeAt(j)
      if (!(${condition(g.rest, 'c')})) break
      j++
    }`
      : ''
    // When the keywords' lookahead class is the identifier's own continue-set, the identifier is the run, and the first character
    // (already known to start it) seeds the hash.
    if (!g.extend) {
      return `function word${k} (text, offset, length) {
    let c = text.charCodeAt(offset)
    if (!(${condition(g.first, 'c')})) return -1
    let h = ${g.fold ? 'c >= 65 && c <= 90 ? c + 32 : c' : 'c'}
    let j = offset + 1
    while (j < length) {
      c = text.charCodeAt(j)
      if (!(${condition(g.rest, 'c')})) break
      ${foldCode}h = (Math.imul(h, 31) + c) | 0
      j++
    }
    const len = j - offset
    switch (h) {
      ${cases.join('\n      ')}
    }
    wordId = ${g.word.id}
    return j
  }`
    }
    return `function word${k} (text, offset, length) {
    let c = text.charCodeAt(offset)
    if (!(${condition(g.first, 'c')})) return -1
    let h = 0
    let j = offset
    while (j < length) {
      c = text.charCodeAt(j)
      if (!(${condition(g.look, 'c')})) break
      ${foldCode}h = (Math.imul(h, 31) + c) | 0
      j++
    }
    const len = j - offset
    if (len > 0) {
      switch (h) {
        ${cases.join('\n        ')}
      }
    }
    ${extend}
    wordId = ${g.word.id}
    return j
  }`
  })
  return `let wordId = 0\n  ${functions.join('\n  ')}`
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
