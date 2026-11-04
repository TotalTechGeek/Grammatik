// @ts-check
'use strict'

/**
 * Hand-rolled matchers for the handful of regex shapes that dominate real
 * token definitions.
 *
 * A sticky regex call has a fixed cost — reset `lastIndex`, enter the engine,
 * come back — that is larger than the matching itself for the short tokens
 * lexers mostly see (identifiers, whitespace, keywords). Recognising a pattern's
 * *shape* once, when the lexer is built, and running a table-driven loop for it
 * afterwards is measurably faster: ~1.3x on a SQL lexer, ~1.1x on a spreadsheet
 * formula lexer, and ~1.2x on a JSON lexer once its string and number patterns
 * are covered (with `positions: 'offset'`; the default `full` mode spends much of
 * the rest on newline tracking).
 *
 * Recognised shapes, all ASCII-only and case-sensitive unless noted:
 *
 *   CLASS      `[a-z]+`  `[a-z]*`  `[A-Za-z_][A-Za-z0-9_]*`  `\s+`  `\d+`
 *   SEQ2       `[A-Za-z]+[0-9]+`        (the two classes must be disjoint)
 *   KEYWORD    `SELECT(?![A-Za-z0-9_])`   (also with `ignoreCase`)
 *   LINE       `--[^\n]*`
 *   QUOTED     `'(?:''|[^'])*'`         (also with `"`)
 *   NUMBER     `-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?`  (JSON), `\d+(?:\.\d+)?`,
 *              and the combinations of: a `-?` sign, a JSON or plain integer part,
 *              an optional `.digits` fraction, an optional exponent
 *   STRING     `"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"` (JSON),
 *              and `"(?:[^"\\]|\\.)*"` — either quote character
 *
 * Anything else yields `null` from `buildScanner` and stays a regex. That
 * includes every negated class other than the LINE shape, `ignoreCase` on
 * anything but KEYWORD, the `u`/`v` flags, and any class member outside ASCII:
 * declining is always safe, a wrong scanner is a silent lexing bug.
 *
 * Contract: `scanEnd` returns exactly what the regex would, as an end offset or
 * -1, except that it may return `DEFER` where it cannot decide (see below), in
 * which case the caller runs the regex. `test/scan.test.js` fuzzes every
 * scanner against its regex.
 *
 * Every scanner has the same object shape (see `make`). That is deliberate:
 * `scanEnd` is called from the lexer's hottest loop, and with one shape per
 * kind its property loads went megamorphic and the whole gain (1.34x) fell to
 * 1.13x. Add a field to `make`, never to one kind's literal.
 */

/** Returned by `scanEnd` when the regex must decide (non-ASCII text under `\s`). */
export const DEFER = -2

const CLASS = 0
const SEQ2 = 1
const KEYWORD = 2
const LINE = 3
const QUOTED = 4
const NUMBER = 5
const STRING = 6

/** The kinds of scanner `buildScanner` can return, for code that writes them out as source. */
export const SCANNER_KINDS = Object.freeze({ CLASS, SEQ2, KEYWORD, LINE, QUOTED, NUMBER, STRING })

const NONE = new Uint8Array(128)

/**
 * @typedef {object} Scanner
 * @property {number} kind
 * @property {boolean} wide      Class contains `\s`: non-ASCII input is not ours to judge.
 * @property {Uint8Array} first  CLASS/SEQ2: may start the match. LINE: unused.
 * @property {Uint8Array} rest   CLASS/SEQ2: may continue the first run.
 * @property {Uint8Array} second SEQ2: the second run's class.
 * @property {Uint8Array} look   KEYWORD: characters that must NOT follow. LINE: stop characters.
 * @property {number[]} lower    KEYWORD: each character's lower-case code.
 * @property {number[]} upper    KEYWORD: each character's upper-case code.
 * @property {string} prefix     LINE: the literal prefix.
 * @property {number} quote      QUOTED, STRING: the quote's char code.
 * @property {boolean} sign      NUMBER: an optional leading `-`.
 * @property {boolean} jsonInt   NUMBER: the integer part is `0|[1-9]\d*` rather than `\d+`.
 * @property {boolean} frac      NUMBER: an optional `.digits`.
 * @property {boolean} exp       NUMBER: an optional `e[+-]digits`.
 * @property {boolean} ctrl      STRING: characters below U+0020 are not allowed inside.
 * @property {boolean} uni       STRING: `\uXXXX` is an escape.
 * @property {boolean} escAny    STRING: a backslash may precede any character but a line terminator.
 * @property {Uint8Array} esc    STRING: the characters that may follow a backslash.
 */

/** @returns {Scanner} */
function make (kind, fields) {
  return {
    kind,
    wide: false,
    first: NONE,
    rest: NONE,
    second: NONE,
    look: NONE,
    lower: [],
    upper: [],
    prefix: '',
    quote: -1,
    sign: false,
    jsonInt: false,
    frac: false,
    exp: false,
    ctrl: false,
    uni: false,
    escAny: false,
    esc: NONE,
    ...fields
  }
}

const SHORTHAND = {
  d: (t) => { for (let k = 48; k < 58; k++) t[k] = 1 },
  w: (t) => { for (let k = 0; k < 128; k++) if (/\w/.test(String.fromCharCode(k))) t[k] = 1 },
  s: (t) => { for (const k of [9, 10, 11, 12, 13, 32]) t[k] = 1 }
}
const SIMPLE_ESCAPES = { t: '\t', r: '\r', n: '\n', f: '\f', v: '\v' }
const ALNUM = /[a-zA-Z0-9]/

/**
 * The membership table of a bracket class body (the text between `[` and `]`),
 * or null when it is anything but plain ASCII members, ranges and simple
 * escapes. `\s` is refused inside brackets — only the bare `\s` shape is
 * handled, because a class mixing it with other members would need its
 * non-ASCII-whitespace behaviour reproduced here.
 *
 * @param {string} body
 * @returns {Uint8Array | null}
 */
function parseClass (body) {
  if (body.length === 0 || body[0] === '^') return null
  const table = new Uint8Array(128)
  for (let i = 0; i < body.length; i++) {
    let c = body[i]
    if (c === '\\') {
      const n = body[++i]
      if (n === 'd' || n === 'w') { SHORTHAND[n](table); continue }
      if (n === undefined) return null
      if (ALNUM.test(n) && !(n in SIMPLE_ESCAPES)) return null // \s \b \0 \x41 A \cJ ...
      c = SIMPLE_ESCAPES[n] ?? n
    }
    if (body[i + 1] === '-' && i + 2 < body.length) {
      let hi = body[i + 2]
      let advance = 2
      if (hi === '\\') {
        hi = body[i + 3]
        advance = 3
        if (hi === undefined || ALNUM.test(hi)) return null
      }
      const from = c.charCodeAt(0)
      const to = hi.charCodeAt(0)
      if (from > to || to >= 128) return null
      for (let k = from; k <= to; k++) table[k] = 1
      i += advance
      continue
    }
    const code = c.charCodeAt(0)
    if (code >= 128) return null
    table[code] = 1
  }
  return table
}

const BODY = String.raw`((?:[^\]\\]|\\.)*)`
const RE_CLASS_RUN = new RegExp(String.raw`^\[${BODY}\]([+*])$`)
const RE_CLASS_PAIR = new RegExp(String.raw`^\[${BODY}\]\[${BODY}\]\*$`)
const RE_CLASS_SEQ = new RegExp(String.raw`^\[${BODY}\]\+\[${BODY}\]\+$`)
const RE_SHORTHAND = /^\\([sdw])[+*]$/
const RE_KEYWORD = new RegExp(String.raw`^([A-Za-z0-9_]+)\(\?!\[${BODY}\]\)$`)
const RE_LINE = new RegExp(String.raw`^([^\\\[\]()*+?.|^$]+)\[\^${BODY}\]\*$`)
const RE_QUOTED = /^(['"])\(\?:\1\1\|\[\^\1\]\)\*\1$/
// -?  (?:0|[1-9]\d*) or \d+   (?:\.\d+)?   (?:[eE][+-]?\d+)?     — `[0-9]` is read as `\d`
const RE_NUMBER = /^(-\?)?(?:(\(\?:0\|\[1-9\]\\d\*\))|\\d\+)(\(\?:\\\.\\d\+\)\?)?(\(\?:\[eE\]\[\+-\]\?\\d\+\)\?)?$/
// "(?:[^"\<ctrl>?]|\(?:[<escapes>](|u[0-9a-fA-F]{4})?))*"
const RE_STRING_ESC = new RegExp(String.raw`^(["'])\(\?:\[\^\1\\\\(\\u0000-\\u001f|\\x00-\\x1f)?\]\|\\\\\(\?:\[${BODY}\](\|u\[0-9a-fA-F\]\{4\})?\)\)\*\1$`)
// "(?:[^"\]|\.)*"
const RE_STRING_ANY = new RegExp(String.raw`^(["'])\(\?:\[\^\1\\\\\]\|\\\\\.\)\*\1$`)

/**
 * @param {string} source      The token's `pattern`.
 * @param {boolean} ignoreCase
 * @returns {Scanner | null}
 */
export function buildScanner (source, ignoreCase) {
  let m = RE_KEYWORD.exec(source)
  if (m) {
    const look = parseClass(m[2])
    if (look === null) return null
    const word = m[1]
    const lower = []
    const upper = []
    for (const ch of word) {
      lower.push((ignoreCase ? ch.toLowerCase() : ch).charCodeAt(0))
      upper.push((ignoreCase ? ch.toUpperCase() : ch).charCodeAt(0))
    }
    return make(KEYWORD, { look, lower, upper })
  }

  // Everything below is case-sensitive only: a case-folded class would need its
  // folding reproduced, and no pattern in the wild has asked for it yet.
  if (ignoreCase) return null

  m = RE_STRING_ESC.exec(source)
  if (m) {
    const esc = parseClass(m[3])
    if (esc === null) return null
    return make(STRING, { quote: m[1].charCodeAt(0), ctrl: m[2] !== undefined, uni: m[4] !== undefined, esc })
  }
  m = RE_STRING_ANY.exec(source)
  if (m) return make(STRING, { quote: m[1].charCodeAt(0), escAny: true })

  // A number needs at least one feature beyond a bare digit run, which CLASS already does.
  m = RE_NUMBER.exec(source.replace(/\[0-9\]/g, '\\d'))
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    return make(NUMBER, { sign: m[1] !== undefined, jsonInt: m[2] !== undefined, frac: m[3] !== undefined, exp: m[4] !== undefined })
  }

  m = RE_CLASS_RUN.exec(source)
  if (m) {
    const table = parseClass(m[1])
    return table && make(CLASS, { first: table, rest: table })
  }

  m = RE_CLASS_PAIR.exec(source)
  if (m) {
    const first = parseClass(m[1])
    const rest = parseClass(m[2])
    return first && rest && make(CLASS, { first, rest })
  }

  m = RE_CLASS_SEQ.exec(source)
  if (m) {
    const first = parseClass(m[1])
    const second = parseClass(m[2])
    // Disjoint classes mean the first run never has to give anything back to
    // the second, so greedy scanning agrees with the regex's backtracking.
    if (first && second && first.every((v, i) => !(v && second[i]))) {
      return make(SEQ2, { first, rest: first, second })
    }
    return null
  }

  m = RE_SHORTHAND.exec(source)
  if (m) {
    const table = new Uint8Array(128)
    SHORTHAND[m[1]](table)
    return make(CLASS, { first: table, rest: table, wide: m[1] === 's' })
  }

  m = RE_QUOTED.exec(source)
  if (m) return make(QUOTED, { quote: m[1].charCodeAt(0) })

  m = RE_LINE.exec(source)
  if (m) {
    const stop = parseClass(m[2])
    return stop && make(LINE, { prefix: m[1], look: stop })
  }

  return null
}

const skipDigits = (text, i, length) => {
  while (i < length) {
    const c = text.charCodeAt(i)
    if (c < 48 || c > 57) break
    i++
  }
  return i
}

const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)

/**
 * Where the pattern's sticky match at `offset` ends, -1 for none, or `DEFER`.
 * A zero-length match is reported as -1, as the lexer treats it that way.
 *
 * @param {Scanner} sc
 * @param {string} text
 * @param {number} offset  Always below `length`.
 * @param {number} length
 * @returns {number}
 */
export function scanEnd (sc, text, offset, length) {
  switch (sc.kind) {
    case CLASS: {
      const code = text.charCodeAt(offset)
      if (code >= 128) return sc.wide ? DEFER : -1
      if (sc.first[code] !== 1) return -1
      const rest = sc.rest
      let j = offset + 1
      while (j < length) {
        const c = text.charCodeAt(j)
        if (c >= 128) return sc.wide ? DEFER : j
        if (rest[c] !== 1) break
        j++
      }
      return j
    }

    case SEQ2: {
      const c0 = text.charCodeAt(offset)
      if (c0 >= 128 || sc.first[c0] !== 1) return -1
      const { first, second } = sc
      let j = offset + 1
      while (j < length) {
        const c = text.charCodeAt(j)
        if (c < 128 && first[c] === 1) j++
        else break
      }
      const mid = j
      while (j < length) {
        const c = text.charCodeAt(j)
        if (c < 128 && second[c] === 1) j++
        else break
      }
      return j > mid ? j : -1
    }

    case KEYWORD: {
      const { lower, upper } = sc
      const n = lower.length
      if (offset + n > length) return -1
      for (let i = 0; i < n; i++) {
        const c = text.charCodeAt(offset + i)
        if (c !== lower[i] && c !== upper[i]) return -1
      }
      const end = offset + n
      if (end < length) {
        const c = text.charCodeAt(end)
        if (c < 128 && sc.look[c] === 1) return -1
      }
      return end
    }

    case LINE: {
      if (!text.startsWith(sc.prefix, offset)) return -1
      let j = offset + sc.prefix.length
      const stop = sc.look
      while (j < length) {
        const c = text.charCodeAt(j)
        if (c < 128 && stop[c] === 1) break
        j++
      }
      return j
    }

    case NUMBER: {
      let j = offset
      if (sc.sign && text.charCodeAt(j) === 45) j++
      const c = text.charCodeAt(j)
      if (sc.jsonInt) {
        // `0` stands alone: "01" is the number 0 followed by 1.
        if (c === 48) j++
        else if (c >= 49 && c <= 57) j = skipDigits(text, j + 1, length)
        else return -1
      } else {
        if (!(c >= 48 && c <= 57)) return -1
        j = skipDigits(text, j + 1, length)
      }
      // A fraction or exponent counts only if it is complete: "1." is 1 then ".".
      if (sc.frac && text.charCodeAt(j) === 46) {
        const k = skipDigits(text, j + 1, length)
        if (k > j + 1) j = k
      }
      if (sc.exp) {
        const e = text.charCodeAt(j)
        if (e === 101 || e === 69) {
          let k = j + 1
          const s = text.charCodeAt(k)
          if (s === 43 || s === 45) k++
          const end = skipDigits(text, k, length)
          if (end > k) j = end
        }
      }
      return j
    }

    case STRING: {
      const q = sc.quote
      if (text.charCodeAt(offset) !== q) return -1
      let j = offset + 1
      for (;;) {
        if (j >= length) return -1
        const c = text.charCodeAt(j)
        if (c === q) return j + 1
        if (c === 92) {
          const d = text.charCodeAt(j + 1)
          if (sc.escAny) {
            // `\\.`: any character but a line terminator (or the end of the text).
            if (!(d >= 0) || d === 10 || d === 13 || d === 0x2028 || d === 0x2029) return -1
            j += 2
          } else if (d < 128 && sc.esc[d] === 1) {
            j += 2
          } else if (sc.uni && d === 117 && isHex(text.charCodeAt(j + 2)) && isHex(text.charCodeAt(j + 3)) &&
                     isHex(text.charCodeAt(j + 4)) && isHex(text.charCodeAt(j + 5))) {
            j += 6
          } else {
            return -1
          }
          continue
        }
        if (sc.ctrl && c < 32) return -1
        j++
      }
    }

    default: { // QUOTED
      const q = sc.quote
      if (text.charCodeAt(offset) !== q) return -1
      const quote = String.fromCharCode(q)
      // The regex prefers to read `''` as an escaped quote, and only when that
      // leaves no closing quote does it backtrack to the *latest* pair and
      // close on its first quote instead.
      let fallback = -1
      let j = offset + 1
      for (;;) {
        j = text.indexOf(quote, j)
        if (j === -1) return fallback
        if (text.charCodeAt(j + 1) !== q) return j + 1
        fallback = j + 1
        j += 2
      }
    }
  }
}
