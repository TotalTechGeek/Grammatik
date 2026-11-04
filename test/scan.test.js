import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import { createLexer } from '../src/lexer.js'
import { buildScanner, scanEnd, DEFER } from '../src/scan.js'
import { parseDefinition } from '../src/index.js'
import { grammar as json } from '../examples/json.js'

const load = (name) => parseDefinition(
  readFileSync(new URL(`../examples/${name}.gram`, import.meta.url), 'utf8'),
  { execution: 'interpreted' }
).tokens

// A small deterministic PRNG, so a failure reproduces.
function prng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Fragments chosen to sit on the edges of every recognised shape: both quote
// styles and doubled quotes, keywords and near-misses, case-folding traps
// (Kelvin sign, long s, dotless i), non-ASCII whitespace for `\s`, and digits
// next to letters.
const FRAGMENTS = [
  "'", "'", "''", '"', '""', ' ', '\n', '\t', '\r', '\u00a0', '\u2003', 'é', 'a', 'B', 'z', '_', '0', '9',
  '-', '--', '/*', '*/', 'S', 'e', 'L', 'E', 'C', 'T', 's', 'select', 'SELECT', 'Select', 'selec', 'f',
  'From', 'FROM', 'IN', 'in', 'int', 'ınt', 'K', 'K', 'ſ', 'A1', '$', 'x9', '7', '.', '1e5',
  '#N/A', 'TRUE', '[', ']', 'items', '12ab',
  // numbers: leading zeros, signs, incomplete fractions and exponents
  '0', '-0', '00', '01', '-', '--', '+', '.', '1.', '.5', '1.5', '2e', 'e5', '1e5', '1E+5', '1e-', '1.5e+', '12.34E-56', '9',
  // strings: escapes (valid, invalid, truncated), controls, non-ASCII, the other quote
  '\\', '\\\\', '\\"', "\\'", '\\n', '\\u00e9', '\\u00g9', '\\u12', '\\x', '\n', '\r', '\u0001', '\u2028', '\u00e9', '\u2603', '\ud83d',
  // exactly three, four and five hex digits after \\u; a backslash before each kind of line terminator
  '\\u123', '\\u1234', '\\u12345', '\\uABCD', '\\uabcg', '\\ug123', '\\u1g23', '\\u12g3', '\\u123g', '\\uffff', '\\uFFFF', '\\u0000', '\\u9G99', '\\u`000', '\\u@000', '\\u/000', '\\u:000', '\\\n', '\\\r', '\\\u2028', '\\\u2029'
]

const PATTERNS = [
  ...load('sql'),
  ...load('formula'),
  ...json.tokens,
  { pattern: '[ \\t\\r\\n]+' },
  { pattern: '[A-Za-z_][A-Za-z0-9_]*' },
  { pattern: '[0-9]+' },
  { pattern: '\\d*' },
  { pattern: '\\w+' },
  { pattern: '"(?:""|[^"])*"' },
  { pattern: '//[^\\n]*' },
  { pattern: '#[^\\n\\r]*' },
  // the number and string family beyond what the example grammars spell
  { pattern: '-?\\d+' },
  { pattern: '\\d+(?:\\.\\d+)?' },
  { pattern: '[0-9]+(?:\\.[0-9]+)?' },
  { pattern: '\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?' },
  { pattern: '-?(?:0|[1-9]\\d*)' },
  { pattern: '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?' },
  { pattern: '(?:0|[1-9]\\d*)(?:[eE][+-]?\\d+)?' },
  { pattern: '"(?:[^"\\\\]|\\\\.)*"' },
  { pattern: "'(?:[^'\\\\]|\\\\.)*'" },
  { pattern: '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"' },
  { pattern: '"(?:[^"\\\\]|\\\\(?:["\\\\/bfnrt]))*"' },
  { pattern: "'(?:[^'\\\\]|\\\\(?:['\\\\nt]|u[0-9a-fA-F]{4}))*'" }
].filter((t) => t.pattern)

describe('scanEnd agrees with the regex it stands in for', () => {
  const scannable = PATTERNS.filter((t) => buildScanner(t.pattern, !!t.ignoreCase))

  it('recognises a useful share of the real patterns', () => {
    // Guards against the recogniser silently matching nothing.
    expect(scannable.length).toBeGreaterThan(50)
  })

  for (const t of scannable) {
    it(`${t.pattern}${t.ignoreCase ? ' (ignoreCase)' : ''}`, () => {
      const sc = buildScanner(t.pattern, !!t.ignoreCase)
      const re = new RegExp(t.pattern, t.ignoreCase ? 'iy' : 'y')
      const rand = prng(0xc0ffee)
      for (let n = 0; n < 4000; n++) {
        let text = ''
        for (let k = Math.floor(rand() * 8); k > 0; k--) text += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]
        if (text.length === 0) continue
        const offset = Math.floor(rand() * text.length) // the lexer never scans at the end
        re.lastIndex = offset
        const m = re.exec(text)
        const want = m && m[0].length > 0 ? offset + m[0].length : -1
        const got = scanEnd(sc, text, offset, text.length)
        if (got === DEFER) continue
        expect({ text, offset, got }).toEqual({ text, offset, got: want })
      }
    })
  }
})

describe('buildScanner takes the number and string family', () => {
  it.each([
    ['JSON number', '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'],
    ['JSON number spelt with [0-9]', '-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?'],
    ['decimal', '\\d+(?:\\.\\d+)?'],
    ['signed integer', '-?\\d+'],
    ['decimal with exponent', '\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'],
    ['JSON string', '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"'],
    ['JSON string without the control exclusion', '"(?:[^"\\\\]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"'],
    ['JSON string without \\u', '"(?:[^"\\\\]|\\\\(?:["\\\\/bfnrt]))*"'],
    ['single-quoted string with escapes', "'(?:[^'\\\\]|\\\\.)*'"],
    ['double-quoted string with escapes', '"(?:[^"\\\\]|\\\\.)*"']
  ])('%s', (_, pattern) => {
    expect(buildScanner(pattern, false)).not.toBeNull()
  })

  it('knows a backslash cannot escape a line terminator in the `\\.` form, but can in the JSON form', () => {
    const anyEscape = buildScanner('"(?:[^"\\\\]|\\\\.)*"', false)
    const jsonEscape = buildScanner('"(?:[^"\\\\]|\\\\(?:["\\\\nrt]|u[0-9a-fA-F]{4}))*"', false)
    for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
      const text = '"a\\' + terminator + 'b"'
      expect(scanEnd(anyEscape, text, 0, text.length), JSON.stringify(text)).toBe(new RegExp('"(?:[^"\\\\]|\\\\.)*"', 'y').exec(text) ? text.length : -1)
      expect(scanEnd(jsonEscape, text, 0, text.length), JSON.stringify(text)).toBe(-1)
    }
  })

  it('leaves a bare digit run to the class scanner', () => {
    expect(buildScanner('\\d+', false).kind).not.toBe(buildScanner('-?\\d+', false).kind)
  })
})

describe('buildScanner declines what it cannot reproduce', () => {
  it.each([
    ['negated class', '[^a-z]+'],
    ['class with \\s inside brackets', '[\\s,]+'],
    ['class with a non-ASCII member', '[a-zé]+'],
    ['class with a hex escape', '[\\x41-\\x5a]+'],
    ['alternation', '[a-z]+|[0-9]+'],
    ['bounded repeat', '[a-z]{2,4}'],
    ['lazy quantifier', '[a-z]+?'],
    ['overlapping SEQ2 classes', '[a-z]+[a-c]+'],
    ['empty class', '[]+'],
    ['unterminated range', '[z-a]+'],
    ['number with a mandatory fraction', '\\d+\\.\\d+'],
    ['number with an optional integer part', '\\d*(?:\\.\\d+)?'],
    ['number with a sign class', '[+-]?\\d+(?:\\.\\d+)?'],
    ['number with a bounded repeat', '\\d{1,3}(?:\\.\\d+)?'],
    ['number with a different exponent marker', '\\d+(?:[dD][+-]?\\d+)?'],
    ['string with a lazy body', '"[^"]*?"'],
    ['string with different quotes at each end', '"(?:[^"\\\\]|\\\\.)*\''],
    ['string whose escape class is not ASCII', '"(?:[^"\\\\]|\\\\(?:[é]|u[0-9a-fA-F]{4}))*"'],
    ['string with a \\u escape of the wrong length', '"(?:[^"\\\\]|\\\\(?:[n]|u[0-9a-fA-F]{2}))*"'],
    ['string with a dotAll escape', '"(?:[^"\\\\]|\\\\[\\s\\S])*"']
  ])('%s', (_, pattern) => {
    expect(buildScanner(pattern, false)).toBeNull()
  })

  it('declines everything but keywords under ignoreCase', () => {
    expect(buildScanner('[a-z]+', true)).toBeNull()
    expect(buildScanner('SELECT(?![A-Za-z0-9_])', true)).not.toBeNull()
  })
})

describe('the lexer gives the same tokens with and without scanners', () => {
  const corpora = {
    sql: [load('sql'), [
      "SELECT u.id, COUNT(o.id) AS n FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.name LIKE 'it''s' -- tail\n AND x IN (1, 2.5)",
      "select  \u00a0 DISTINCT a from /* c */ t where b = 'unterminated''",
      'INSERT INTO t VALUES (1)'
    ]],
    formula: [load('formula'), [
      'IF(A1>=10,SUM(B1:B5),ABS(C1))',
      "'Quarter 1'!$B$2 + MAX({1,2;3,4})",
      '"Total: " & ROUND(subtotal * 1.0825, 2) + items[*].price'
    ]],
    json: [json.tokens, ['{"a": [1, 2.5e3, true, null], "b": "x\\"y"}', '[\n  1,\n\t2\r\n]']]
  }

  for (const [name, [tokens, inputs]] of Object.entries(corpora)) {
    for (const positions of ['full', 'offset']) {
      it(`${name} (${positions})`, () => {
        const plain = createLexer(tokens, { positions, scanners: false })
        const fast = createLexer(tokens, { positions })
        for (const input of inputs) {
          const run = (lexer) => { try { return lexer.tokenize(input) } catch (e) { return String(e.message) } }
          expect(run(fast)).toEqual(run(plain))
        }
      })
    }
  }

  it('reports the same error for text no token matches', () => {
    const tokens = [{ name: 'Id', pattern: '[a-z]+' }, { name: 'Ws', pattern: '\\s+', skip: true }]
    const message = (opts) => { try { createLexer(tokens, opts).tokenize('ab \u00a0 cd !') } catch (e) { return e.message } }
    expect(message({})).toBe(message({ scanners: false }))
    expect(message({})).toMatch(/Unexpected character '!'/)
  })

  it('lexes JSON numbers and strings exactly as the regex does, edge by edge', () => {
    const inputs = [
      '0', '-0', '01', '-01', '1.', '1.e5', '1.5', '1.5e', '1.5e+', '1.5e+3', '-', '-x', '--1', '+1', '.5', '1e5', '1E-5', '12345678901234567890',
      '"a"', '""', '"a\\"b"', '"\\u00e9"', '"\\u00g9"', '"\\u12"', '"\\u123"', '"\\u1234"', '"\\u12345"', '"\\u123"x"', '"\\u12"x"',
      '"\\ug123"', '"\\u1g23"', '"\\u12g3"', '"\\u123g"', '"\\uABCD"', '"\\uabcd"', '"\\uffff"', '"\\uFFFF"', '"\\u0aAfF"', '"\\u`000"', '"\\u@000"', '"\\u/000"', '"\\u:000"', '"\\uGGGG"', '"\\ugggg"', '"\\x"', '"a\nb"', '"\tx"', '"\u2603 \ud83d\ude00"', '"unterminated', '"\\', '"\\"',
      '[1, -2.5e3, "x", "y\\n"]', '{"a":01,"b":"\\q"}', '1 2.5 "a" -3'
    ]
    for (const positions of ['full', 'offset']) {
      const fast = createLexer(json.tokens, { positions })
      const plain = createLexer(json.tokens, { positions, scanners: false })
      for (const input of inputs) {
        const go = (lexer) => { try { return JSON.stringify(lexer.tokenize(input)) } catch (e) { return String(e.message) } }
        expect(go(fast), `${positions}: ${JSON.stringify(input)}`).toBe(go(plain))
      }
    }
  })

  it('treats non-ASCII whitespace under \\s exactly as the regex does', () => {
    const tokens = [{ name: 'Id', pattern: '[a-z]+' }, { name: 'Ws', pattern: '\\s+', skip: true }]
    const text = 'ab\u00a0\u2003 cd'
    expect(createLexer(tokens).tokenize(text)).toEqual(createLexer(tokens, { scanners: false }).tokenize(text))
    expect(createLexer(tokens).tokenize(text).map((t) => t.image)).toEqual(['ab', 'cd'])
  })

  it('agrees with the incremental lexer too', () => {
    const [tokens, inputs] = corpora.sql
    const a = createLexer(tokens, { incremental: true, recover: true, scanners: false })
    const b = createLexer(tokens, { incremental: true, recover: true })
    for (const input of inputs) {
      expect(b.tokenizeIncremental(input).tokens).toEqual(a.tokenizeIncremental(input).tokens)
    }
  })
})
