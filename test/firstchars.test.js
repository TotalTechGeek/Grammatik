import { describe, it, expect } from 'vitest'
import { firstCharSet } from '../src/firstchars.js'
import { createLexer } from '../src/lexer.js'

const codes = (set) => (set === null ? null : [...set].sort((a, b) => a - b))
const chars = (set) => (set === null ? null : codes(set).map((c) => String.fromCharCode(c)).join(''))

describe('firstCharSet', () => {
  it('handles a plain literal', () => {
    expect(chars(firstCharSet('abc', false))).toBe('a')
  })

  it('handles alternation', () => {
    expect(chars(firstCharSet('a|b|c', false))).toBe('abc')
  })

  it('handles a character class', () => {
    expect(chars(firstCharSet('[abc]+', false))).toBe('abc')
  })

  it('handles a class range', () => {
    expect(chars(firstCharSet('[a-e]', false))).toBe('abcde')
  })

  it('handles \\d, \\w and \\s shorthands', () => {
    expect(chars(firstCharSet('\\d+', false))).toBe('0123456789')
    expect(firstCharSet('\\w+', false).has('_'.charCodeAt(0))).toBe(true)
    expect(firstCharSet('\\s+', false).has(0x20)).toBe(true)
    expect(firstCharSet('\\s+', false).has(0x09)).toBe(true)
  })

  it('sees through an optional prefix', () => {
    // `-?` is optional, so digits can also start the match.
    expect(chars(firstCharSet('-?\\d+', false))).toBe('-0123456789')
  })

  it('sees through a nullable group', () => {
    expect(chars(firstCharSet('(?:ab)*c', false))).toBe('ac')
  })

  it('stops at the first mandatory element', () => {
    expect(chars(firstCharSet('ab*c', false))).toBe('a')
  })

  it('handles {n,m} quantifiers', () => {
    expect(chars(firstCharSet('a{0,3}b', false))).toBe('ab')
    expect(chars(firstCharSet('a{2,}b', false))).toBe('a')
    expect(chars(firstCharSet('a{2}b', false))).toBe('a')
  })

  it('handles escaped literals and unicode escapes', () => {
    expect(chars(firstCharSet('\\.', false))).toBe('.')
    expect(chars(firstCharSet('\\u0041', false))).toBe('A')
    expect(chars(firstCharSet('\\x41', false))).toBe('A')
    expect(chars(firstCharSet('\\n', false))).toBe('\n')
  })

  it('handles the JSON string pattern', () => {
    const pattern = '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"'
    expect(chars(firstCharSet(pattern, false))).toBe('"')
  })

  it('handles the JSON number pattern', () => {
    const pattern = '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'
    expect(chars(firstCharSet(pattern, false))).toBe('-0123456789')
  })

  it('includes both cases when ignoreCase is set', () => {
    expect(chars(firstCharSet('select', true))).toBe('Ss')
  })

  it('bails to null on constructs it cannot bound', () => {
    expect(firstCharSet('.', false)).toBeNull()          // matches nearly everything
    expect(firstCharSet('[^a]', false)).toBeNull()       // negated class
    expect(firstCharSet('\\D+', false)).toBeNull()       // complement shorthand
    expect(firstCharSet('\\1a', false)).toBeNull()        // leading backreference
    expect(firstCharSet('(', false)).toBeNull()          // malformed
  })

  it('treats lookaround as zero-width rather than bailing', () => {
    // The constraint is dropped and the following element supplies the set,
    // which over-approximates — exactly the safe direction.
    expect(chars(firstCharSet('(?=[a-c])\\w+', false))).toContain('a')
    expect(chars(firstCharSet('(?=a)b', false))).toBe('b')
    expect(chars(firstCharSet('(?!x)ab', false))).toBe('a')
  })

  it('only bails on unbounded constructs that could start the match', () => {
    // Past the first mandatory element, a negated class or `.` cannot
    // contribute to the first set, so it must not poison the analysis.
    expect(chars(firstCharSet('"[^"]*"', false))).toBe('"')
    expect(chars(firstCharSet('#.*', false))).toBe('#')
    expect(chars(firstCharSet('x\\D+', false))).toBe('x')
    expect(chars(firstCharSet('<(a)\\1>', false))).toBe('<')
    expect(chars(firstCharSet('(a)\\1', false))).toBe('a')
  })

  it('treats an anchor as zero-width and keeps looking', () => {
    expect(chars(firstCharSet('^ab', false))).toBe('a')
  })
})

describe('firstCharSet is a sound over-approximation', () => {
  // The invariant the lexer depends on: if a pattern can match text starting
  // with character c, then c must be in the set (or the set must be null).
  // Violating this direction would make the lexer silently skip tokens.
  const patterns = [
    '\\s+', '\\d+', '\\w+', '[a-z]+', '[A-Za-z_]\\w*', '-?\\d+(?:\\.\\d+)?',
    '"(?:[^"\\\\]|\\\\.)*"', "'[^']*'", '//[^\\n]*', '/\\*[\\s\\S]*?\\*/',
    '0[xX][0-9a-fA-F]+', '(?:true|false)', '[+-]?\\d*\\.?\\d+', '\\$\\w+',
    '[\\d.]+', 'a|bc|def', '(?:ab)*c', '\\.\\.\\.', '[()\\[\\]{}]',
    '(?=[a-z])\\w+', '(?!_)[a-z_]+', '"[^"]*"', '#.*', '<[^>]*>',
    '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'
  ]

  // A corpus wide enough to actually exercise each pattern's entry points.
  const corpus = []
  for (let code = 0; code < 256; code++) {
    const char = String.fromCharCode(code)
    corpus.push(char, char + 'x', char + '1', char + '"', char + char)
  }
  corpus.push('true', 'false', '0x1F', '...', '/* c */', '// c', '$name', '3.14', '-42', '"str"', "'s'", 'abc')

  for (const pattern of patterns) {
    it(`over-approximates ${pattern}`, () => {
      const set = firstCharSet(pattern, false)
      if (set === null) return // "always try" is trivially sound

      const regex = new RegExp(pattern, 'y')
      for (const sample of corpus) {
        regex.lastIndex = 0
        const match = regex.exec(sample)
        if (match === null || match[0].length === 0) continue
        const code = sample.charCodeAt(0)
        expect(
          set.has(code),
          `${pattern} matched ${JSON.stringify(sample)} but ${JSON.stringify(sample[0])} (${code}) was not in the first-char set`
        ).toBe(true)
      }
    })
  }
})

describe('lexer dispatch preserves declaration-order semantics', () => {
  it('still prefers the earlier definition when two can match', () => {
    const { tokenize } = createLexer([
      { name: 'Keyword', pattern: 'if' },
      { name: 'Identifier', pattern: '[a-z]+' }
    ])
    expect(tokenize('if').map((t) => t.type)).toEqual(['Keyword'])
  })

  it('lexes tokens whose patterns could not be analyzed', () => {
    const { tokenize } = createLexer([
      { name: 'WS', pattern: '\\s+', skip: true },
      { name: 'Any', pattern: '.' },           // bails to always-try
      { name: 'Int', pattern: '\\d+' }
    ])
    // `Any` is declared first, so it wins on every single character.
    expect(tokenize('a1 b').map((t) => t.image)).toEqual(['a', '1', 'b'])
  })

  it('lexes non-ASCII input', () => {
    const { tokenize } = createLexer([
      { name: 'Word', pattern: '[\\u00e0-\\u00ff]+' },
      { name: 'Ascii', pattern: '[a-z]+' }
    ])
    expect(tokenize('éàxyz').map((t) => t.type)).toEqual(['Word', 'Ascii'])
  })

  it('handles a grammar where every pattern is unanalyzable', () => {
    const { tokenize } = createLexer([
      { name: 'Dot', pattern: '.' }
    ])
    expect(tokenize('ab').map((t) => t.image)).toEqual(['a', 'b'])
  })

  it('matches a brute-force lexer across a varied corpus', () => {
    const defs = [
      { name: 'WS', pattern: '\\s+', skip: true },
      { name: 'Number', pattern: '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?' },
      { name: 'String', pattern: '"(?:[^"\\\\]|\\\\.)*"' },
      { name: 'Ident', pattern: '[A-Za-z_]\\w*' },
      { name: 'Punct', pattern: '[()\\[\\]{},:;+\\-*/]' }
    ]
    const { tokenize } = createLexer(defs)

    // Independent reference implementation: try every pattern, in order, always.
    const regexes = defs.map((d) => ({ ...d, re: new RegExp(d.pattern, 'y') }))
    const bruteForce = (text) => {
      const out = []
      let offset = 0
      while (offset < text.length) {
        let matched = false
        for (const def of regexes) {
          def.re.lastIndex = offset
          const m = def.re.exec(text)
          if (m === null || m[0].length === 0) continue
          if (!def.skip) out.push({ type: def.name, image: m[0], start: offset })
          offset += m[0].length
          matched = true
          break
        }
        if (!matched) throw new Error('brute force stuck at ' + offset)
      }
      return out
    }

    const samples = [
      'foo(1, 2.5)', '{"a": -3, "b": [true]}', 'x_1 + y2 * 30',
      'a:b;c', '"esc \\" here" rest', '  spaced   out  ', '-0.5', '0',
      'mixed "str" 12 ident (nested [list])'
    ]
    for (const sample of samples) {
      const got = tokenize(sample).map((t) => ({ type: t.type, image: t.image, start: t.start }))
      expect(got, sample).toEqual(bruteForce(sample))
    }
  })
})
