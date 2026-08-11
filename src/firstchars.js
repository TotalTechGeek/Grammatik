// @ts-check
'use strict'

/**
 * Static analysis of a regex source to find which characters a match can begin with.
 *
 * This drives the lexer's first-character dispatch: at each offset we only try
 * the patterns that could possibly match the character sitting there. Profiling
 * showed ~44% of lexing time was `RegExp.exec`, most of it on patterns that
 * could never have matched — the JSON string pattern alone was being run at
 * every single offset.
 *
 * The one invariant that matters for correctness: the returned set must be a
 * **superset** of the characters the pattern can really start with. Anything
 * this analyzer does not fully understand makes it return `null`, meaning
 * "unknown — always try this pattern". Being wrong in that direction only costs
 * speed; being wrong in the other direction would silently drop tokens.
 */

const DIGITS = []
for (let c = 0x30; c <= 0x39; c++) DIGITS.push(c)

const WORD = DIGITS.concat([0x5f])
for (let c = 0x41; c <= 0x5a; c++) WORD.push(c)
for (let c = 0x61; c <= 0x7a; c++) WORD.push(c)

const SPACE = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]
for (let c = 0x2000; c <= 0x200a; c++) SPACE.push(c)

const SIMPLE_ESCAPES = {
  n: 0x0a, r: 0x0d, t: 0x09, f: 0x0c, v: 0x0b, 0: 0x00
}

/**
 * @param {string} source Regex source text.
 * @param {boolean} ignoreCase
 * @returns {Set<number>|null} Possible first char codes, or null if undetermined.
 */
export function firstCharSet (source, ignoreCase) {
  /** @type {Set<number>} */
  const found = new Set()
  let pos = 0
  let bailed = false

  const bail = () => { bailed = true }

  /** Adds a char code, plus its case counterpart when the pattern is case-insensitive. */
  function add (code) {
    found.add(code)
    if (!ignoreCase) return
    const char = String.fromCharCode(code)
    const upper = char.toUpperCase()
    const lower = char.toLowerCase()
    if (upper.length === 1) found.add(upper.charCodeAt(0))
    if (lower.length === 1) found.add(lower.charCodeAt(0))
  }

  function addAll (codes) {
    for (const code of codes) add(code)
  }

  /**
   * Parses `a|b|c` up to a closing paren or end of input.
   * @returns {boolean} whether the whole alternation can match empty
   */
  function alternation (collect) {
    let nullable = false
    for (;;) {
      if (sequence(collect)) nullable = true
      if (bailed) return true
      if (source[pos] === '|') {
        pos++
        continue
      }
      break
    }
    return nullable
  }

  /**
   * Parses a concatenation. Characters are only collected while every element so
   * far could match empty — once something must consume, nothing after it can
   * contribute to the first set.
   * @returns {boolean} whether the sequence can match empty
   */
  function sequence (collect) {
    let stillNullable = true
    while (pos < source.length && source[pos] !== '|' && source[pos] !== ')') {
      const nullable = element(collect && stillNullable)
      if (bailed) return true
      if (!nullable) stillNullable = false
    }
    return stillNullable
  }

  /**
   * Parses one atom plus its quantifier.
   * @returns {boolean} whether it can match empty
   */
  function element (collect) {
    const zeroWidth = atom(collect)
    if (bailed) return true

    const quantifier = source[pos]

    if (quantifier === '?' || quantifier === '*') {
      pos++
      if (source[pos] === '?' || source[pos] === '+') pos++
      return true
    }

    if (quantifier === '+') {
      pos++
      if (source[pos] === '?' || source[pos] === '+') pos++
      return zeroWidth
    }

    if (quantifier === '{') {
      const close = source.indexOf('}', pos)
      if (close === -1) { bail(); return true }
      const body = source.slice(pos + 1, close)
      if (!/^\d+(,\d*)?$/.test(body)) { bail(); return true }
      pos = close + 1
      if (source[pos] === '?' || source[pos] === '+') pos++
      const min = parseInt(body, 10)
      return min === 0 ? true : zeroWidth
    }

    return zeroWidth
  }

  /**
   * Parses a single atom.
   * @returns {boolean} whether the atom is zero-width (an anchor)
   */
  function atom (collect) {
    const char = source[pos]

    if (char === '(') {
      // A lookaround is zero-width. Treating it as such and letting whatever
      // follows contribute its own first characters still yields a superset,
      // which is all the invariant requires.
      let lookaround = false
      if (source.startsWith('(?:', pos)) pos += 3
      else if (source.startsWith('(?=', pos) || source.startsWith('(?!', pos)) {
        pos += 3
        lookaround = true
      } else if (source.startsWith('(?<=', pos) || source.startsWith('(?<!', pos)) {
        pos += 4
        lookaround = true
      } else if (source.startsWith('(?<', pos)) {
        // Named capture group: skip the name.
        const close = source.indexOf('>', pos)
        if (close === -1) { if (collect) bail(); return true }
        pos = close + 1
      } else pos += 1

      const nullable = alternation(collect && !lookaround)
      if (bailed) return true
      if (source[pos] !== ')') { if (collect) bail(); return true }
      pos++
      return lookaround ? true : nullable
    }

    if (char === '[') return charClass(collect)

    if (char === '\\') return escape(collect)

    if (char === '.') {
      // Matches nearly everything, so there is no useful set to report — but
      // only when we are still collecting. Past the first mandatory element it
      // is just another atom to step over.
      if (collect) { bail(); return true }
      pos++
      return false
    }

    if (char === '^' || char === '$') {
      pos++
      return true
    }

    if (char === undefined) { bail(); return true }

    // An ordinary literal character.
    if (collect) add(source.charCodeAt(pos))
    pos++
    return false
  }

  /** Steps over a character class without interpreting it. */
  function skipCharClass () {
    pos++ // past '['
    if (source[pos] === '^') pos++
    if (source[pos] === ']') pos++ // a literal ']' first is allowed
    while (pos < source.length && source[pos] !== ']') {
      if (source[pos] === '\\') pos += 2
      else pos++
    }
    if (source[pos] !== ']') { bail(); return false }
    pos++
    return false
  }

  /** @returns {boolean} always false (a class consumes one character) */
  function charClass (collect) {
    // A negated class is an enormous set; not worth enumerating. Once we are
    // past the first mandatory element we only need to step over it.
    if (source[pos + 1] === '^') {
      if (collect) { bail(); return false }
      return skipCharClass()
    }
    if (!collect) return skipCharClass()

    pos++ // past '['

    while (pos < source.length && source[pos] !== ']') {
      let low
      if (source[pos] === '\\') {
        const before = pos
        const zero = escape(collect, true)
        if (bailed) return false
        if (zero === null) {
          // A class shorthand like \d inside the class: already collected.
          low = null
        } else {
          low = zero
        }
        if (pos === before) { bail(); return false }
      } else {
        low = source.charCodeAt(pos)
        pos++
      }

      if (low !== null && source[pos] === '-' && source[pos + 1] !== ']' && pos + 1 < source.length) {
        pos++
        let high
        if (source[pos] === '\\') {
          high = escape(collect, true)
          if (bailed) return false
          if (high === null) { bail(); return false }
        } else {
          high = source.charCodeAt(pos)
          pos++
        }
        if (high < low) { bail(); return false }
        // Guard against absurd ranges blowing up memory.
        if (high - low > 0x1000) { bail(); return false }
        if (collect) for (let c = low; c <= high; c++) add(c)
      } else if (low !== null && collect) {
        add(low)
      }
    }

    if (source[pos] !== ']') { bail(); return false }
    pos++
    return false
  }

  /**
   * Parses an escape sequence.
   * @param {boolean} collect
   * @param {boolean} [inClass]
   * @returns {any} In a class: the char code, or null when it was a shorthand
   *                set (already collected). Outside: whether it is zero-width.
   */
  function escape (collect, inClass = false) {
    pos++ // past '\'
    const char = source[pos]
    if (char === undefined) { bail(); return inClass ? null : true }

    if (char === 'd' || char === 'w' || char === 's') {
      pos++
      if (collect) addAll(char === 'd' ? DIGITS : char === 'w' ? WORD : SPACE)
      return inClass ? null : false
    }

    if (char === 'D' || char === 'W' || char === 'S' || char === 'p' || char === 'P') {
      // Complement / unicode property classes: too large to enumerate. Only a
      // problem while collecting; otherwise just step over it.
      if (collect) { bail(); return inClass ? null : false }
      pos++
      if ((char === 'p' || char === 'P') && source[pos] === '{') {
        const close = source.indexOf('}', pos)
        if (close === -1) { bail(); return inClass ? null : false }
        pos = close + 1
      }
      return inClass ? null : false
    }

    if (char === 'b' || char === 'B') {
      pos++
      if (inClass) {
        // \b inside a class is a backspace.
        if (collect) add(0x08)
        return 0x08
      }
      return true // zero-width assertion
    }

    if (char === 'u') {
      if (source[pos + 1] === '{') {
        const close = source.indexOf('}', pos)
        if (close === -1) { bail(); return inClass ? null : false }
        const code = parseInt(source.slice(pos + 2, close), 16)
        pos = close + 1
        if (Number.isNaN(code)) { bail(); return inClass ? null : false }
        if (collect) add(code)
        return inClass ? code : false
      }
      const hex = source.slice(pos + 1, pos + 5)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) { bail(); return inClass ? null : false }
      pos += 5
      const code = parseInt(hex, 16)
      if (collect) add(code)
      return inClass ? code : false
    }

    if (char === 'x') {
      const hex = source.slice(pos + 1, pos + 3)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) { bail(); return inClass ? null : false }
      pos += 3
      const code = parseInt(hex, 16)
      if (collect) add(code)
      return inClass ? code : false
    }

    if (char >= '1' && char <= '9' && !inClass) {
      // A backreference can start with anything the referenced group can.
      if (collect) { bail(); return false }
      while (source[pos] >= '0' && source[pos] <= '9') pos++
      return false
    }

    if (char in SIMPLE_ESCAPES) {
      pos++
      const code = SIMPLE_ESCAPES[char]
      if (collect) add(code)
      return inClass ? code : false
    }

    // An escaped literal such as \. or \[
    pos++
    const code = char.charCodeAt(0)
    if (collect) add(code)
    return inClass ? code : false
  }

  alternation(true)

  if (bailed || pos !== source.length || found.size === 0) return null
  return found
}
