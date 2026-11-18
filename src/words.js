// @ts-check
'use strict'

import { SCANNER_KINDS } from './scan.js'

/**
 * Keyword groups: a run of keyword tokens followed by the identifier token that would otherwise match every one of them.
 *
 * `SELECT(?![A-Za-z0-9_])`, `FROM(?![A-Za-z0-9_])` and so on, then `[A-Za-z_][A-Za-z0-9_]*`. Trying them in order
 * means each word in the text is compared against keywords that cannot match before the identifier takes it. But all
 * the keywords share one lookahead class L, and a keyword matches precisely when the text starts with its word and the
 * next character is not in L, which is when the maximal run of L characters from there is exactly its word. So that run
 * can be scanned once and looked up, and the lowest-numbered keyword whose word equals it wins. If none does, the
 * identifier does, and it carries on from the end of that run through its own continue-set R. When L and R are the same
 * set there is nothing further to scan; when R is the larger (an identifier that may contain `$`, `-`), or the identifier may
 * start with something outside L, it is scanned on from there, and a keyword still ends where its run ends. The same tokens, in one pass.
 *
 * Everything the equivalence needs is checked here, and anything that fails it returns null and keeps the ordinary path:
 *
 * - every keyword is a `KEYWORD` scanner (a plain word and one lookahead class), and so is the identifier a `CLASS`
 *   scanner that is not `wide` (non-ASCII text under `\s` is a regex's to decide);
 * - the keywords share one lookahead class L, and L is within the identifier's continue-set R (otherwise the run of L
 *   could leave the identifier's, and its end would depend on more than the run);
 * - every character of every keyword, in each case it can be written, is in L, and the first is in the identifier's
 *   start-set — otherwise the run could not be the keyword, or the identifier could not start where the keyword does;
 * - the keywords agree on `ignoreCase`, so one hash function serves them all;
 * - the identifier has no `longerAlt` (a keyword's is applied afterwards, as usual, to whichever token won).
 *
 * @typedef {object} Entry
 * @property {number} index   Position in `keywords`.
 * @property {number} hash    The hash of the (case-folded, if `fold`) word.
 * @property {number[]} lower
 * @property {number[]} upper
 *
 * @param {any[]} run         Candidate definitions, the identifier last. Each has `.scanner`, `.longerAlt`.
 * @param {(def: any) => boolean} ignoreCaseOf
 * @returns {{ keywords: any[], word: any, first: Uint8Array, rest: Uint8Array, look: Uint8Array, extend: boolean, fold: boolean, entries: Entry[] } | null}
 */
export function analyzeWords (run, ignoreCaseOf) {
  const word = run[run.length - 1]
  const keywords = run.slice(0, -1)
  if (keywords.length === 0) return null
  const ws = word.scanner
  if (ws === null || ws.kind !== SCANNER_KINDS.CLASS || ws.wide || word.longerAlt) return null
  const fold = ignoreCaseOf(keywords[0])
  const look = keywords[0].scanner?.look
  if (look === undefined) return null
  // L within R. The identifier needs scanning on past the run when R holds more than L does, or when it may start with
  // something the run cannot (then the run is empty and the whole identifier is still to be read).
  let extend = false
  for (let n = 0; n < 128; n++) {
    if (look[n] === 1 && ws.rest[n] !== 1) return null
    if ((ws.rest[n] === 1 || ws.first[n] === 1) && look[n] !== 1) extend = true
  }
  for (const k of keywords) {
    const sc = k.scanner
    if (sc === null || sc.kind !== SCANNER_KINDS.KEYWORD || ignoreCaseOf(k) !== fold) return null
    for (let n = 0; n < 128; n++) if (sc.look[n] !== look[n]) return null
    for (let n = 0; n < sc.lower.length; n++) {
      const lo = sc.lower[n]
      const up = sc.upper[n]
      if (lo >= 128 || up >= 128 || look[lo] !== 1 || look[up] !== 1) return null
      if (n === 0 && (ws.first[lo] !== 1 || ws.first[up] !== 1)) return null
    }
  }

  /** @type {Entry[]} */
  const entries = []
  const seen = new Set()
  keywords.forEach((k, index) => {
    const { lower, upper } = k.scanner
    // A word declared twice belongs to the first declaration.
    const key = `${lower.join(',')}|${upper.join(',')}`
    if (seen.has(key)) return
    seen.add(key)
    let hash = 0
    for (const c of lower) hash = (Math.imul(hash, 31) + c) | 0
    entries.push({ index, hash, lower, upper })
  })
  return { keywords, word, first: ws.first, rest: ws.rest, look, extend, fold, entries }
}
