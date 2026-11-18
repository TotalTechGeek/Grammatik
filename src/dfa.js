// @ts-check
'use strict'

/**
 * A DFA for a group of token patterns that compete at the same position.
 *
 * The lexer picks, at each offset, the first token in declaration order whose regex matches there, and that
 * token's own match is what it keeps. When several patterns share a first character — `A1`, `A$1`, `items`
 * all start with a letter and are tried as `AnchoredCell`, `Cell`, `Identifier` — trying them one by one scans
 * the same characters over and over, and every rejected attempt pays for a regex call. A DFA over the whole group
 * reads the characters once and says which patterns matched.
 *
 * What it computes: walk the text once; every state knows which patterns accept there. The winner is the
 * lowest-index pattern that ever accepted a non-empty prefix. That much is exact, because a regex matches at an
 * offset exactly when some prefix of the text is in its language (lookaround included, as modelled below). The
 * winner's end is a different matter: the DFA knows the longest valid end, a backtracking regex reports the end of
 * the first match it finds, and the two can differ (`(?:|a)` matches the empty string first; `a|ab` stops at
 * `a`). They agree when the pattern has no choice to make — it is deterministic — or when it has only one
 * possible end (its language is prefix-free). `buildDfa` computes the second property from the automaton itself
 * and `isDeterministic` the first; a winner with neither has its end re-derived by its own matcher (lexer.js).
 *
 * Supported: literals, `[...]` classes (ASCII members, negation allowed), `\d \w \s` and their complements,
 * simple escapes, `(?:...)`, alternation, the greedy quantifiers `+ * ?`, `ignoreCase` over ASCII letters,
 * `$` (end of text), and three kinds of assertion:
 *
 * - `^`, `(?<=X)` and `(?<!X)` where X is one character class (or `^`, or an alternation of those) — and only before
 *   the match has consumed anything. They look at the character before the match, which the walk never sees, so
 *   the lexer picks a start state from it: there is one start state per distinct outcome (`starts`).
 * - `(?=Q)` and `(?!Q)` where Q is bounded — no `+` or `*`, at most `MAX_LOOK` characters, no assertion inside — placed
 *   anywhere, inside a loop included. Each is an obligation carried by the thread that passed it: a small checker
 *   for Q reads the same characters, and the thread lives or dies by whether Q matched. A thread that reaches the
 *   end of the token with obligations unresolved becomes a pending accept; when the last one resolves it reports
 *   that the match ended some `r` characters ago. Reaching the end of the text resolves what remains: a negative
 *   lookahead holds (nothing more can match), a positive one fails.
 *
 * Anything else — unbounded or nested lookaround, lookbehind past the start, `.`, bounded repeats, lazy
 * quantifiers, backreferences, non-ASCII members — is declined, and the token keeps its scanner or regex.
 * Declining is always safe.
 *
 * The alphabet is the 128 ASCII characters plus two symbols standing for every non-ASCII code unit that is not
 * whitespace and every one that is (`\s` names eighteen of them), plus an end-of-text marker. That is sound
 * because no supported class names a non-ASCII member other than through `\s`, `\S` and negation.
 */

/** 0..127 ASCII, then these. A context for a start state is a previous-character symbol, or `BOS`. */
const SYM = 131
const OTHER = 128
const NAWS = 129
const EOS = 130
const BOS = 130
/** The symbols that are characters (everything but the end-of-text marker). */
const CHARS = 130
const SIMPLE_ESCAPES = { t: 9, r: 13, n: 10, f: 12, v: 11 }
const MAX_STATES = 1024
const MAX_LOOK = 8

/** @typedef {{ t: 'set', s: Uint8Array } | { t: 'cat', xs: Node[] } | { t: 'alt', xs: Node[] } | { t: 'rep', x: Node, min: 0 | 1, many: boolean } | { t: 'look', pos: boolean, q: Node } | { t: 'ctx', set: Uint8Array } | { t: 'eos' }} Node */

/** Whether a code unit of 128 or more is one `\s` matches. */
export function isNonAsciiSpace (/** @type {number} */ c) {
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
}

/** The alphabet symbol of a code unit. */
export function symbolOf (/** @type {number} */ code) {
  return code < 128 ? code : (isNonAsciiSpace(code) ? NAWS : OTHER)
}

/** @param {string} n */
function shorthand (n) {
  const lower = n.toLowerCase()
  const s = new Uint8Array(SYM)
  if (lower === 'd') {
    for (let c = 48; c < 58; c++) s[c] = 1
  } else if (lower === 'w') {
    for (let c = 0; c < 128; c++) {
      if (/\w/.test(String.fromCharCode(c))) s[c] = 1
    }
  } else if (lower === 's') {
    for (const c of [9, 10, 11, 12, 13, 32]) s[c] = 1
    s[NAWS] = 1
  } else {
    return null
  }
  if (n !== lower) for (let c = 0; c < CHARS; c++) s[c] = s[c] ? 0 : 1
  return s
}

/**
 * The pattern as a tree, or null if it uses anything outside the supported subset.
 * @param {string} source
 * @param {boolean} [ignoreCase]
 * @returns {Node | null}
 */
export function parsePattern (source, ignoreCase = false, relax = false) {
  let i = 0

  /**
   * In `relax` mode, an assertion this module cannot model is replaced by an empty match. An assertion only ever
   * restricts what a pattern matches, so without it the pattern matches at least as much: what is left is a
   * superset of the real language, safe to use as a filter, never as an answer.
   * Skips the parenthesised group starting at `i`; null if it never closes.
   */
  function skipGroup () {
    let depth = 0
    for (let j = i; j < source.length; j++) {
      const c = source[j]
      if (c === '\\') { j++; continue }
      if (c === '[') {
        for (j++; j < source.length && source[j] !== ']'; j++) if (source[j] === '\\') j++
        continue
      }
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) { i = j + 1; return { t: 'cat', xs: [] } }
    }
    return null
  }

  /** Under `ignoreCase`, a set holding one case of an ASCII letter holds both. Non-ASCII never folds to ASCII. */
  const fold = (/** @type {Uint8Array} */ s) => {
    if (!ignoreCase) return s
    for (let c = 65; c <= 90; c++) if (s[c] || s[c + 32]) { s[c] = 1; s[c + 32] = 1 }
    return s
  }

  /** @returns {Node | null} */
  function alt () {
    const first = seq()
    if (first === null) return null
    const branches = [first]
    while (source[i] === '|') {
      i++
      const next = seq()
      if (next === null) return null
      branches.push(next)
    }
    return branches.length === 1 ? first : { t: 'alt', xs: branches }
  }

  /** @returns {Node | null} */
  function seq () {
    const xs = []
    while (i < source.length && source[i] !== '|' && source[i] !== ')') {
      const a = atom()
      if (a === null) return null
      const q = quantified(a)
      if (q === null) return null
      xs.push(q)
    }
    return { t: 'cat', xs }
  }

  /** @param {Node} x @returns {Node | null} */
  function quantified (x) {
    const q = source[i]
    if (q === '{') return null
    if (q !== '+' && q !== '*' && q !== '?') return x
    if (x.t === 'look' || x.t === 'ctx' || x.t === 'eos') {
      if (!relax) return null // a quantified assertion is not something to model
      i++ // ...but one that may repeat or be absent restricts nothing, which is what an empty match does
      if (source[i] === '?') i++
      return { t: 'cat', xs: [] }
    }
    i++
    const next = source[i]
    if (next === '?' || next === '+' || next === '*' || next === '{') return null // lazy, possessive, doubled, bounded
    return { t: 'rep', x, min: q === '+' ? 1 : 0, many: q !== '?' }
  }

  /** The set of previous-character symbols a lookbehind body accepts, or null if it is not one character of context. */
  function contextSet (/** @type {Node} */ n) {
    if (n.t === 'set') return n.s[EOS] ? null : n.s
    if (n.t === 'ctx') return n.set
    if (n.t === 'cat') return n.xs.length === 1 ? contextSet(n.xs[0]) : null
    if (n.t === 'alt') {
      const out = new Uint8Array(SYM)
      for (const x of n.xs) {
        const m = contextSet(x)
        if (m === null) return null
        for (let k = 0; k < SYM; k++) if (m[k]) out[k] = 1
      }
      return out
    }
    return null
  }

  /** @returns {Node | null} */
  function atom () {
    const ch = source[i]
    if (source.startsWith('(?:', i)) {
      i += 3
      const inner = alt()
      if (inner === null || source[i] !== ')') return null
      i++
      return inner
    }
    if (source.startsWith('(?=', i) || source.startsWith('(?!', i)) {
      const pos = source[i + 2] === '='
      const from = i
      i += 3
      const q = alt()
      if (q !== null && source[i] === ')') {
        i++
        return { t: 'look', pos, q }
      }
      if (!relax) return null
      i = from
      return skipGroup()
    }
    if (source.startsWith('(?<=', i) || source.startsWith('(?<!', i)) {
      const pos = source[i + 3] === '='
      const from = i
      i += 4
      const body = alt()
      const closed = body !== null && source[i] === ')'
      const members = closed ? contextSet(body) : null
      if (members === null) {
        if (!relax) return null
        i = from
        return skipGroup()
      }
      i++
      const set = new Uint8Array(SYM)
      for (let k = 0; k < SYM; k++) set[k] = (pos ? members[k] : !members[k]) ? 1 : 0
      return { t: 'ctx', set }
    }
    if (ch === '^') {
      i++
      const set = new Uint8Array(SYM)
      set[BOS] = 1
      return { t: 'ctx', set }
    }
    if (ch === '$') {
      i++
      return { t: 'eos' }
    }
    if ('(){}*+?.|'.includes(ch)) return null
    if (ch === '[') return classAtom()
    if (ch === '\\') {
      const n = source[i + 1]
      if (n === undefined) return null
      i += 2
      const sh = shorthand(n)
      if (sh) return { t: 'set', s: sh }
      const s = new Uint8Array(SYM)
      if (n in SIMPLE_ESCAPES) s[SIMPLE_ESCAPES[n]] = 1
      else if (/[a-zA-Z0-9]/.test(n) || n.charCodeAt(0) >= 128) return null
      else s[n.charCodeAt(0)] = 1
      return { t: 'set', s: fold(s) }
    }
    if (ch.charCodeAt(0) >= 128) return null
    i++
    const s = new Uint8Array(SYM)
    s[ch.charCodeAt(0)] = 1
    return { t: 'set', s: fold(s) }
  }

  /** @returns {Node | null} */
  function classAtom () {
    let j = i + 1
    let negated = false
    if (source[j] === '^') { negated = true; j++ }
    const s = new Uint8Array(SYM)
    let any = false
    while (j < source.length && source[j] !== ']') {
      any = true
      let lo
      if (source[j] === '\\') {
        const n = source[j + 1]
        if (n === undefined) return null
        j += 2
        const sh = shorthand(n)
        if (sh) { for (let k = 0; k < SYM; k++) if (sh[k]) s[k] = 1; continue }
        if (n in SIMPLE_ESCAPES) lo = SIMPLE_ESCAPES[n]
        else if (/[a-zA-Z0-9]/.test(n) || n.charCodeAt(0) >= 128) return null
        else lo = n.charCodeAt(0)
      } else {
        lo = source[j].charCodeAt(0)
        j++
      }
      if (lo >= 128) return null
      if (source[j] === '-' && j + 1 < source.length && source[j + 1] !== ']') {
        let hi
        if (source[j + 1] === '\\') {
          const n = source[j + 2]
          if (n === undefined || /[a-zA-Z0-9]/.test(n) || n.charCodeAt(0) >= 128) return null
          hi = n.charCodeAt(0)
          j += 3
        } else {
          hi = source[j + 1].charCodeAt(0)
          j += 2
        }
        if (hi >= 128 || hi < lo) return null
        for (let k = lo; k <= hi; k++) s[k] = 1
      } else s[lo] = 1
    }
    if (source[j] !== ']' || !any) return null
    i = j + 1
    fold(s)
    if (negated) for (let k = 0; k < CHARS; k++) s[k] = s[k] ? 0 : 1
    return { t: 'set', s }
  }

  const ast = alt()
  if (ast === null || i !== source.length) return null
  const tree = relax ? relaxed(ast) : ast
  return placed(tree) ? tree : null
}

/**
 * The tree with every assertion that `placed` would refuse replaced by an empty match: a lookahead too long or unbounded
 * or with an assertion inside, a lookbehind or `^` after something was consumed, a loop around nothing.
 *
 * @param {Node} root
 * @returns {Node}
 */
function relaxed (root) {
  const empty = () => /** @type {Node} */ ({ t: 'cat', xs: [] })
  const zeroWidth = (/** @type {Node} */ n) => n.t === 'eos' || n.t === 'look' || n.t === 'ctx' ||
    ((n.t === 'cat' || n.t === 'alt') && n.xs.every(zeroWidth))
  function go (/** @type {Node} */ n, /** @type {boolean} */ atStart) {
    switch (n.t) {
      case 'set':
      case 'eos': return n
      case 'look': { const length = lookLength(n.q); return length >= 0 && length <= MAX_LOOK ? n : empty() }
      case 'ctx': return atStart ? n : empty()
      case 'cat': {
        let still = atStart
        const xs = n.xs.map((x) => { const y = go(x, still); still = still && zeroWidth(y); return y })
        return { t: 'cat', xs }
      }
      case 'alt': return { t: 'alt', xs: n.xs.map((x) => go(x, atStart)) }
      default: { const x = go(n.x, false); return zeroWidth(x) ? empty() : { ...n, x } }
    }
  }
  return go(root, true)
}

/** How many characters a lookahead body can read, or -1 if it is not a bounded, assertion-free regex. */
function lookLength (/** @type {Node} */ n) {
  if (n.t === 'set' || n.t === 'eos') return 1
  if (n.t === 'cat') {
    let total = 0
    for (const x of n.xs) {
      const l = lookLength(x)
      if (l < 0) return -1
      total += l
    }
    return total
  }
  if (n.t === 'alt') {
    let longest = 0
    for (const x of n.xs) {
      const l = lookLength(x)
      if (l < 0) return -1
      longest = Math.max(longest, l)
    }
    return longest
  }
  if (n.t === 'rep') return n.many ? -1 : lookLength(n.x)
  return -1
}

/**
 * Whether every assertion in the tree is somewhere the automaton can model it. A lookbehind or `^` reads the character
 * before the match, so it must come before anything is consumed: every sibling ahead of it, on the way down from the
 * root, must itself be zero-width. A lookahead must be bounded. `emptyOnly` is whether a node can match only the empty
 * string.
 *
 * @param {Node} root
 */
function placed (root) {
  /** @returns {boolean | null} `emptyOnly`, or null when something is out of place */
  function walk (/** @type {Node} */ n, /** @type {boolean} */ atStart) {
    switch (n.t) {
      case 'set': return false
      case 'eos': return true
      case 'ctx': return atStart ? true : null
      case 'look': {
        const length = lookLength(n.q)
        return length >= 0 && length <= MAX_LOOK ? true : null
      }
      case 'cat': {
        let still = atStart
        let all = true
        for (const x of n.xs) {
          const e = walk(x, still)
          if (e === null) return null
          still = still && e
          all = all && e
        }
        return all
      }
      case 'alt': {
        let all = true
        for (const x of n.xs) {
          const e = walk(x, atStart)
          if (e === null) return null
          all = all && e
        }
        return all
      }
      default: {
        const e = walk(n.x, false) // a loop's body is never at the start, and a zero-width body would never end
        return e === false ? false : null
      }
    }
  }
  return walk(root, true) !== null
}

/**
 * @typedef {object} Token
 * @property {Node} tree
 */

/**
 * A token pattern as a tree. Null when any of it is outside what this module understands.
 *
 * @param {string} source
 * @param {boolean} ignoreCase
 * @returns {Token | null}
 */
export function parseToken (source, ignoreCase) {
  const tree = parsePattern(source, ignoreCase)
  return tree === null ? null : { tree }
}

/**
 * A token pattern as a tree that may match more than the pattern does: the same pattern with each assertion this module
 * cannot model left out. Anything it rejects, the pattern rejects too, so it can stand in front of the real matcher to
 * save the calls that would fail. Null when the pattern consumes something outside what this module understands.
 *
 * @param {string} source
 * @param {boolean} ignoreCase
 * @returns {Token | null}
 */
export function parseRelaxed (source, ignoreCase) {
  const tree = parsePattern(source, ignoreCase, true)
  return tree === null ? null : { tree }
}

/**
 * Whether a lookahead sits inside a loop, so that one resolves after (nearly) every character. The automaton then
 * reports a delayed match at every step, which costs the walk more than it costs the regex engine.
 *
 * @param {Node} n
 * @param {boolean} [inLoop]
 * @returns {boolean}
 */
export function loopedLookahead (n, inLoop = false) {
  if (n.t === 'look' || n.t === 'eos') return inLoop && n.t === 'look'
  if (n.t === 'cat' || n.t === 'alt') return n.xs.some((x) => loopedLookahead(x, inLoop))
  if (n.t === 'rep') return loopedLookahead(n.x, inLoop || n.many)
  return false
}

/**
 * Whether the pattern is deterministic enough that its longest valid end is the end a backtracking regex reports.
 * Two things must hold. Reading one character must never leave a choice: at the start and after every position,
 * the characters that can come next must belong to exactly one position (the Glushkov automaton is deterministic).
 * And no alternation or repetition may be able to match nothing — `(?:|a)` and `(?:a?)*` have an empty path the
 * regex prefers over a longer one. Assertions are zero-width and take no part in either: they only decide which of
 * the pattern's single path's ends are valid, and the regex, which takes the longest valid one along that path,
 * agrees with the automaton. An alternation of nothing but assertions, `(?:(?<=\n)|^)`, is one condition.
 *
 * @param {Node} root
 * @returns {boolean}
 */
export function isDeterministic (root) {
  /** @type {Uint8Array[]} */
  const tables = []
  /** @type {Set<number>[]} */
  const follow = []
  let ok = true

  /** @returns {{ nullable: boolean, first: Set<number>, last: Set<number>, empty: boolean }} */
  function walk (/** @type {Node} */ n) {
    if (n.t === 'look' || n.t === 'ctx' || n.t === 'eos') return { nullable: true, first: new Set(), last: new Set(), empty: true }
    if (n.t === 'set') {
      const id = tables.length
      tables.push(n.s)
      follow.push(new Set())
      return { nullable: false, first: new Set([id]), last: new Set([id]), empty: false }
    }
    if (n.t === 'cat') {
      let nullable = true
      let empty = true
      const first = new Set()
      let last = new Set()
      for (const x of n.xs) {
        const r = walk(x)
        for (const p of last) for (const q of r.first) follow[p].add(q)
        if (nullable) for (const q of r.first) first.add(q)
        last = r.nullable ? new Set([...last, ...r.last]) : r.last
        nullable = nullable && r.nullable
        empty = empty && r.empty
      }
      return { nullable, first, last, empty }
    }
    if (n.t === 'alt') {
      let nullable = false
      let empty = true
      let anyNullable = false
      const first = new Set()
      const last = new Set()
      for (const x of n.xs) {
        const r = walk(x)
        anyNullable = anyNullable || r.nullable
        nullable = nullable || r.nullable
        empty = empty && r.empty
        for (const q of r.first) first.add(q)
        for (const q of r.last) last.add(q)
      }
      if (anyNullable && !empty) ok = false // an empty branch is preferred over a later, longer one
      return { nullable, first, last, empty }
    }
    const r = walk(n.x)
    if (r.nullable) ok = false // an iteration that matches nothing
    if (n.many) for (const p of r.last) for (const q of r.first) follow[p].add(q)
    return { nullable: n.min === 0 || r.nullable, first: r.first, last: r.last, empty: false }
  }

  const top = walk(root)
  if (!ok) return false

  /** No symbol may be accepted by two of the positions that can come next. */
  const disjoint = (/** @type {Set<number>} */ positions) => {
    const seen = new Uint8Array(SYM)
    for (const p of positions) {
      const t = tables[p]
      for (let c = 0; c < SYM; c++) {
        if (!t[c]) continue
        if (seen[c]) return false
        seen[c] = 1
      }
    }
    return true
  }
  if (!disjoint(top.first)) return false
  for (const f of follow) if (!disjoint(f)) return false
  return true
}

/**
 * @typedef {object} Dfa
 * @property {Int16Array} trans        `state * SYM + symbol` -> next state; 0 is dead.
 * @property {Uint8Array} accepts      `state * T + pattern` -> 1 if that pattern ends a valid match right here.
 * @property {Int16Array} best         The lowest such pattern in each state, or -1.
 * @property {boolean} hasLate         Whether any state reports a match that ended earlier (a lookahead resolved late).
 * @property {Int32Array} lateStart    `lateData[lateStart[s] .. lateStart[s + 1])` are state `s`'s (pattern, delay) pairs, delay >= 1:
 *                                     the match ended `delay` characters before the current position.
 * @property {Int16Array} lateData
 * @property {boolean} hasEos          Whether the end of the text can complete a match.
 * @property {Int32Array} eosStart     As `lateStart`, for what the end of the text resolves in a state: ends at `length - delay`.
 * @property {Int16Array} eosData
 * @property {boolean} hasCtx          Whether the start state depends on the character before the match (`starts`).
 * @property {Int16Array} starts       Previous-character symbol (or `BOS`) -> start state.
 * @property {number} start            The start state when `hasCtx` is false.
 * @property {Uint8Array} prefixFree   Per pattern: it has at most one possible end, so the DFA's end is the regex's.
 * @property {Uint8Array} classOf      Symbol -> the class it shares a column of the table with: symbols in one class behave alike.
 * @property {number} classes          How many classes there are.
 * @property {number} T                Number of patterns.
 */

/**
 * @typedef {object} Obligation
 * @property {boolean} pos
 * @property {number} qe      The accepting state of the lookahead's checker.
 * @property {number[]} set   The checker's current states.
 */

/**
 * One DFA over `items`, in order. Null when it would be too large — a grammar that is not worth this falls
 * back to trying its tokens one by one.
 *
 * @param {(Node | Token)[]} items
 * @returns {Dfa | null}
 */
export function buildDfa (items) {
  const trees = items.map((item) => ('tree' in item ? item.tree : item))
  const T = trees.length

  /** @type {{ eps: number[], edges: [Uint8Array, number][], looks: { pos: boolean, qs: number, qe: number, to: number }[], ctxs: { set: Uint8Array, to: number }[] }[]} */
  const pool = []
  const mk = () => pool.push({ eps: [], edges: [], looks: [], ctxs: [] }) - 1

  const endMarker = new Uint8Array(SYM)
  endMarker[EOS] = 1

  /** @returns {[number, number]} */
  function frag (/** @type {Node} */ n, /** @type {boolean} */ inLook = false) {
    if (n.t === 'set') { const a = mk(); const b = mk(); pool[a].edges.push([n.s, b]); return [a, b] }
    if (n.t === 'eos') {
      const a = mk(); const b = mk()
      if (inLook) {
        pool[a].edges.push([endMarker, b])
      } else {
        // Zero-width: the thread carries on, owing the end of the text, which the walk settles when it gets there.
        const [qs, qe] = frag(n, true)
        pool[a].looks.push({ pos: true, qs, qe, to: b })
      }
      return [a, b]
    }
    if (n.t === 'cat') {
      if (n.xs.length === 0) { const a = mk(); return [a, a] }
      let [s, e] = frag(n.xs[0], inLook)
      for (let k = 1; k < n.xs.length; k++) { const [s2, e2] = frag(n.xs[k], inLook); pool[e].eps.push(s2); e = e2 }
      return [s, e]
    }
    if (n.t === 'alt') {
      const a = mk(); const b = mk()
      for (const x of n.xs) { const [s, e] = frag(x, inLook); pool[a].eps.push(s); pool[e].eps.push(b) }
      return [a, b]
    }
    if (n.t === 'look') {
      const a = mk(); const b = mk()
      const [qs, qe] = frag(n.q, true)
      pool[a].looks.push({ pos: n.pos, qs, qe, to: b })
      return [a, b]
    }
    if (n.t === 'ctx') { const a = mk(); const b = mk(); pool[a].ctxs.push({ set: n.set, to: b }); return [a, b] }
    const a = mk(); const b = mk()
    const [s, e] = frag(n.x, inLook)
    pool[a].eps.push(s)
    pool[e].eps.push(b)
    if (n.many) pool[e].eps.push(s)
    if (n.min === 0) pool[a].eps.push(b)
    return [a, b]
  }

  const start = mk()
  /** @type {Map<number, number>} NFA accepting state -> pattern index */
  const acceptOf = new Map()
  trees.forEach((tree, index) => {
    const [s, e] = frag(tree)
    pool[start].eps.push(s)
    acceptOf.set(e, index)
  })

  const closureQ = (/** @type {number[]} */ states) => {
    const seen = new Set(states)
    const stack = [...seen]
    while (stack.length > 0) {
      for (const n of pool[/** @type {number} */ (stack.pop())].eps) if (!seen.has(n)) { seen.add(n); stack.push(n) }
    }
    return [...seen].sort((a, b) => a - b)
  }

  const obKey = (/** @type {Obligation} */ o) => `${o.pos ? '+' : '-'}${o.qe}:${o.set.join(',')}`
  const obsKey = (/** @type {Obligation[]} */ obs) => obs.map(obKey).join(';')
  const withObligation = (/** @type {Obligation[]} */ obs, /** @type {Obligation} */ o) => {
    const key = obKey(o)
    if (obs.some((x) => obKey(x) === key)) return obs
    return [...obs, o].sort((a, b) => (obKey(a) < obKey(b) ? -1 : 1))
  }

  /**
   * The obligations after one more symbol, or null when the thread dies: a lookahead that must hold has run out of
   * ways to match, or one that must not has matched.
   */
  function stepObligations (/** @type {Obligation[]} */ obs, /** @type {number} */ c) {
    if (obs.length === 0) return obs
    /** @type {Obligation[]} */
    const out = []
    for (const o of obs) {
      const moved = new Set()
      for (const n of o.set) for (const [set, to] of pool[n].edges) if (set[c]) moved.add(to)
      const next = closureQ([...moved])
      const matched = next.includes(o.qe)
      if (o.pos) {
        if (matched) continue
        if (next.length === 0) return null
      } else {
        if (matched) return null
        if (next.length === 0) continue
      }
      out.push({ pos: o.pos, qe: o.qe, set: next })
    }
    return out
  }

  /**
   * @typedef {{ s: number, obs: Obligation[], key: string } | { tok: number, r: number, obs: Obligation[], key: string }} Thread
   */

  /**
   * Everything reachable from `seeds` without reading a symbol. Threads that can read one are kept, as are
   * pending accepts; a thread that reaches the end of its pattern with nothing owed is an event instead.
   */
  function close (/** @type {{ s: number, obs: Obligation[] }[]} */ seeds, /** @type {number | undefined} */ ctx) {
    /** @type {Map<string, Thread>} */
    const threads = new Map()
    /** @type {[number, number][]} */
    const events = []
    const seen = new Set()
    const stack = seeds.slice()
    while (stack.length > 0) {
      const { s, obs } = /** @type {{ s: number, obs: Obligation[] }} */ (stack.pop())
      const ok = obsKey(obs)
      const key = `${s}|${ok}`
      if (seen.has(key)) continue
      seen.add(key)
      const tok = acceptOf.get(s)
      if (tok !== undefined) {
        if (obs.length === 0) events.push([tok, 0])
        else threads.set(`p${tok}|0|${ok}`, { tok, r: 0, obs, key: `p${tok}|0|${ok}` })
        continue
      }
      const node = pool[s]
      if (node.edges.length > 0) threads.set(`m${key}`, { s, obs, key: `m${key}` })
      for (const e of node.eps) stack.push({ s: e, obs })
      for (const l of node.looks) {
        const initial = closureQ([l.qs])
        const matched = initial.includes(l.qe)
        if (l.pos) stack.push({ s: l.to, obs: matched ? obs : withObligation(obs, { pos: true, qe: l.qe, set: initial }) })
        else if (!matched) stack.push({ s: l.to, obs: withObligation(obs, { pos: false, qe: l.qe, set: initial }) })
      }
      if (ctx !== undefined) for (const c of node.ctxs) if (c.set[ctx]) stack.push({ s: c.to, obs })
    }
    return { threads, events }
  }

  /** One symbol: the seeds the main threads move to, the matches that complete, and the pending accepts that remain. */
  function step (/** @type {Thread[]} */ threads, /** @type {number} */ c) {
    /** @type {{ s: number, obs: Obligation[] }[]} */
    const seeds = []
    /** @type {[number, number][]} */
    const events = []
    /** @type {Thread[]} */
    const pending = []
    for (const t of threads) {
      const obs = stepObligations(t.obs, c)
      if (obs === null) continue
      if ('tok' in t) {
        const r = t.r + (c === EOS ? 0 : 1) // the end-of-text marker is zero-width
        if (obs.length === 0) events.push([t.tok, r])
        else pending.push({ tok: t.tok, r, obs, key: `p${t.tok}|${r}|${obsKey(obs)}` })
      } else {
        for (const [set, to] of pool[t.s].edges) if (set[c]) seeds.push({ s: to, obs })
      }
    }
    return { seeds, events, pending }
  }

  // ---- the states ----
  /** @type {({ threads: Thread[], events: [number, number][] } | null)[]} */
  const states = [null]
  const index = new Map()
  const intern = (/** @type {Map<string, Thread>} */ threads, /** @type {[number, number][]} */ events) => {
    if (threads.size === 0 && events.length === 0) return 0
    const sorted = [...threads.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
    const ev = [...new Map(events.map((e) => [`${e[0]}@${e[1]}`, e])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const key = `${sorted.map((t) => t.key).join('\n')}#${ev.map((e) => `${e[0]}@${e[1]}`).join(',')}`
    let id = index.get(key)
    if (id === undefined) {
      id = states.length
      index.set(key, id)
      states.push({ threads: sorted, events: ev })
    }
    return id
  }

  const hasCtx = pool.some((n) => n.ctxs.length > 0)
  const starts = new Int16Array(SYM)
  let startState = 0
  if (hasCtx) {
    for (let ctx = 0; ctx < SYM; ctx++) {
      const { threads, events } = close([{ s: start, obs: [] }], ctx)
      starts[ctx] = intern(threads, events)
    }
    startState = starts[0]
  } else {
    const { threads, events } = close([{ s: start, obs: [] }], undefined)
    startState = intern(threads, events)
    starts.fill(startState)
  }

  // Symbols the automaton cannot tell apart share a column of the table: one signature per symbol across every set.
  const sets = []
  const setIndex = new Map()
  for (const node of pool) for (const [set] of node.edges) if (!setIndex.has(set)) { setIndex.set(set, sets.length); sets.push(set) }
  /** @type {Map<string, number[]>} */
  const classes = new Map()
  for (let c = 0; c < CHARS; c++) {
    const signature = sets.map((s) => s[c]).join('')
    const members = classes.get(signature) ?? []
    members.push(c)
    classes.set(signature, members)
  }
  const classList = [...classes.values()]
  const classOf = new Uint8Array(SYM)
  classList.forEach((members, id) => { for (const c of members) classOf[c] = id })

  /** @type {Int32Array[]} */
  const rows = [new Int32Array(SYM)]
  for (let q = 1; q < states.length; q++) {
    if (states.length > MAX_STATES) return null
    const row = new Int32Array(SYM)
    const state = /** @type {{ threads: Thread[] }} */ (states[q])
    for (const members of classList) {
      const { seeds, events, pending } = step(state.threads, members[0])
      const next = close(seeds, undefined)
      for (const p of pending) next.threads.set(p.key, p)
      const id = intern(next.threads, events.concat(next.events))
      for (const c of members) row[c] = id
    }
    rows[q] = row
  }
  if (states.length > MAX_STATES) return null
  while (rows.length < states.length) rows.push(new Int32Array(SYM))

  const S = states.length

  // ---- what the end of the text settles, per state ----
  /** @type {[number, number][][]} */
  const eosEvents = [[]]
  for (let q = 1; q < S; q++) {
    const state = /** @type {{ threads: Thread[] }} */ (states[q])
    const { seeds, events, pending } = step(state.threads, EOS)
    const next = close(seeds, undefined)
    const out = events.concat(next.events)
    // Nothing more can be read, so a lookahead that must not match holds and one that must match has failed.
    for (const p of [...pending, ...next.threads.values()]) {
      if ('tok' in p && p.obs.every((o) => !o.pos)) out.push([p.tok, p.r])
    }
    eosEvents.push([...new Map(out.map((e) => [`${e[0]}@${e[1]}`, e])).values()])
  }

  // ---- tables ----
  const trans = new Int16Array(S * SYM)
  const accepts = new Uint8Array(S * T)
  const best = new Int16Array(S).fill(-1)
  const lateList = [[]]
  for (let q = 1; q < S; q++) {
    trans.set(rows[q], q * SYM)
    const late = []
    for (const [tok, r] of /** @type {{ events: [number, number][] }} */ (states[q]).events) {
      if (r === 0) {
        accepts[q * T + tok] = 1
        if (best[q] === -1 || tok < best[q]) best[q] = tok
      } else {
        late.push(tok, r)
      }
    }
    lateList.push(late)
  }
  const flatten = (/** @type {number[][]} */ lists) => {
    const startAt = new Int32Array(S + 1)
    const data = []
    for (let q = 0; q < S; q++) {
      startAt[q] = data.length
      data.push(...(lists[q] ?? []))
    }
    startAt[S] = data.length
    return { startAt, data: Int16Array.from(data) }
  }
  const late = flatten(lateList)
  const eos = flatten(eosEvents.map((list) => list.flatMap(([tok, r]) => [tok, r])))

  // ---- which patterns can end in only one place ----
  // A pattern whose language is prefix-free has at most one valid end at any position, so the end the DFA finds is the
  // end the regex finds, however the regex gets there. It is not prefix-free if some text reaches two of its matches:
  // two in one state, or one in a state from which another can be reached.
  const W = (T + 31) >>> 5
  const here = new Uint32Array(S * W)
  const ahead = new Uint32Array(S * W)
  const prefixFree = new Uint8Array(T).fill(1)
  /** @type {number[][]} */
  const successors = [[]]
  for (let q = 1; q < S; q++) {
    const counts = new Map()
    for (const [tok] of /** @type {{ events: [number, number][] }} */ (states[q]).events) {
      counts.set(tok, (counts.get(tok) ?? 0) + 1)
      here[q * W + (tok >>> 5)] |= 1 << (tok & 31)
    }
    for (const [tok] of eosEvents[q]) counts.set(tok, (counts.get(tok) ?? 0) + 1)
    for (const [tok, n] of counts) if (n > 1) prefixFree[tok] = 0
    const targets = new Set()
    for (let c = 0; c < CHARS; c++) if (rows[q][c] !== 0) targets.add(rows[q][c])
    successors.push([...targets])
  }
  for (let changed = true; changed;) {
    changed = false
    for (let q = 1; q < S; q++) {
      for (const q2 of successors[q]) {
        for (let w = 0; w < W; w++) {
          const v = ahead[q * W + w] | here[q2 * W + w] | ahead[q2 * W + w]
          if (v !== ahead[q * W + w]) { ahead[q * W + w] = v; changed = true }
        }
      }
    }
  }
  for (let q = 1; q < S; q++) {
    for (let tok = 0; tok < T; tok++) {
      if ((here[q * W + (tok >>> 5)] & ahead[q * W + (tok >>> 5)] & (1 << (tok & 31))) !== 0) prefixFree[tok] = 0
    }
  }

  return {
    trans,
    accepts,
    best,
    hasLate: late.data.length > 0,
    lateStart: late.startAt,
    lateData: late.data,
    hasEos: eos.data.length > 0,
    eosStart: eos.startAt,
    eosData: eos.data,
    hasCtx,
    starts,
    start: startState,
    prefixFree,
    classOf,
    classes: classList.length,
    T
  }
}

/**
 * The longest valid end of each pattern when the DFA walks `text` from `offset`, or -1: the reference walk, with no
 * winner logic, for tests to compare with a regex.
 *
 * @param {Dfa} dfa
 * @param {string} text
 * @param {number} offset
 * @returns {Int32Array}
 */
export function walkDfa (dfa, text, offset) {
  const T = dfa.T
  const out = new Int32Array(T).fill(-1)
  const note = (/** @type {number} */ tok, /** @type {number} */ end) => { if (end > offset && end > out[tok]) out[tok] = end }
  let state = dfa.hasCtx ? dfa.starts[offset === 0 ? BOS : symbolOf(text.charCodeAt(offset - 1))] : dfa.start
  let dead = false
  for (let i = offset; i < text.length; i++) {
    state = dfa.trans[state * SYM + symbolOf(text.charCodeAt(i))]
    if (state === 0) { dead = true; break }
    for (let tok = 0; tok < T; tok++) if (dfa.accepts[state * T + tok] === 1) note(tok, i + 1)
    for (let k = dfa.lateStart[state]; k < dfa.lateStart[state + 1]; k += 2) note(dfa.lateData[k], i + 1 - dfa.lateData[k + 1])
  }
  if (!dead && text.length > offset) {
    for (let k = dfa.eosStart[state]; k < dfa.eosStart[state + 1]; k += 2) note(dfa.eosData[k], text.length - dfa.eosData[k + 1])
  }
  return out
}

export { SYM, OTHER, NAWS, EOS, BOS }
