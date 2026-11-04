import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'

import { createLexer, LexError } from '../src/lexer.js'
import { parseDefinition } from '../src/index.js'
import { grammar as json } from '../examples/json.js'

/**
 * `fuse` joins runs of consecutive regex candidates into one alternation. It has
 * to be invisible: the same tokens, and the same errors, as trying them one at a
 * time. Every case here is run both ways and compared.
 */

const run = (lexer, text) => {
  try { return JSON.stringify(lexer.tokenize(text)) } catch (e) { return `${e.name}: ${e.message}` }
}

function same (tokens, inputs, options = {}) {
  for (const positions of ['full', 'offset']) {
    const fused = createLexer(tokens, { positions, ...options })
    const plain = createLexer(tokens, { positions, ...options, fuse: false })
    for (const input of inputs) expect(run(fused, input), `${positions}: ${JSON.stringify(input)}`).toBe(run(plain, input))
  }
}

/** How many regex calls tokenizing makes; each fused run replaces several with one. */
function regexCalls (tokens, text, options) {
  const lexer = createLexer(tokens, options)
  const spy = vi.spyOn(RegExp.prototype, 'exec')
  try {
    lexer.tokenize(text)
    return spy.mock.calls.length
  } finally {
    spy.mockRestore()
  }
}

// Ten tokens that all start with `{` and differ a character or two in, in the
// shape of a template language's tag openers — some with lookbehind, some with
// lookahead, some pushing a mode.
const tags = [
  { name: 'BlockStandalone', pattern: '(?:\\s*\\{\\{~#|(?:(?<=\\n)|^)[ \\t]*\\{\\{#)(?=(?:(?!\\}\\})[^\\r\\n])*~?\\}\\}[ \\t]*(?:\\r?\\n|$))', pushMode: 'tag' },
  { name: 'EndStandalone', pattern: '(?:\\s*\\{\\{~/|(?:(?<=\\n)|^)[ \\t]*\\{\\{/)(?=(?:(?!\\}\\})[^\\r\\n])*~?\\}\\}[ \\t]*(?:\\r?\\n|$))', pushMode: 'tag' },
  { name: 'ElseStandalone', pattern: '(?:\\s*\\{\\{~else|(?:(?<=\\n)|^)[ \\t]*\\{\\{else)(?=(?:(?!\\}\\})[^\\r\\n])*~?\\}\\}[ \\t]*(?:\\r?\\n|$))', pushMode: 'tag' },
  { name: 'OpenTriple', literal: '{{{', pushMode: 'tag' },
  { name: 'OpenBlock', pattern: '(?:\\s*\\{\\{~#|\\{\\{#)', pushMode: 'tag' },
  { name: 'OpenEnd', pattern: '(?:\\s*\\{\\{~/|\\{\\{/)', pushMode: 'tag' },
  { name: 'OpenElse', pattern: '(?:\\s*\\{\\{~else|\\{\\{else)(?![A-Za-z0-9_])', pushMode: 'tag' },
  { name: 'OpenPartial', pattern: '(?:\\s*\\{\\{~>|\\{\\{>)', pushMode: 'tag' },
  { name: 'OpenComment', pattern: '\\{\\{!--[\\s\\S]*?--\\}\\}' },
  { name: 'Open', pattern: '(?:\\s*\\{\\{~|\\{\\{)', pushMode: 'tag' },
  { name: 'Text', pattern: '(?:[^{\\s]|\\{(?!\\{)|\\s+(?!\\s*\\{\\{~))+' },
  { name: 'Name', pattern: '[A-Za-z_][A-Za-z0-9_.]*', mode: 'tag' },
  { name: 'Space', pattern: '[ \\t]+', mode: 'tag', skip: true },
  { name: 'Close', pattern: '~?\\}\\}', mode: 'tag', popMode: true }
]

const templates = [
  'Hello {{name}}!',
  '{{#if a}}yes{{else}}no{{/if}}',
  '  {{#if a}}\n  yes\n  {{else}}\n  no\n  {{/if}}\n',
  'a {{~#each xs~}} b {{~/each~}} c',
  '{{> partial name}} and {{{raw}}} and {{!-- note --}} done',
  '{{#if a}}\n{{#if b}}\ninner\n{{/if}}\n{{/if}}',
  '{{elsewhere}} {{else_}} {{else}}',
  '{{', '{{#', '{{#if', '{{ name', 'text only', '', '   \n  ', '{ not a tag } {{x}}', '{{x}}}}', '\n{{#a}}\n'
]

describe('fuse: lookaround-heavy openers in lexer modes', () => {
  it('tokenizes exactly as one-at-a-time does', () => same(tags, templates))

  it('actually fuses them: far fewer regex calls', () => {
    const text = Array.from({ length: 30 }, () => '{{name}} and {{other}}').join(' ')
    const fused = regexCalls(tags, text, {})
    const plain = regexCalls(tags, text, { fuse: false })
    expect(fused).toBeLessThan(plain * 0.6)
  })

  it('survives random mutations of real-looking templates', () => {
    let seed = 99
    const rnd = (n) => (seed = (seed * 1664525 + 1013904223) >>> 0) % n
    const pieces = ['{{', '}}', '{{#', '{{/', '{{~', '~}}', '{{else', '{{>', '{{{', '}}}', '{{!--', '--}}', ' ', '\n', '\n  ', 'name', 'a.b', 'x', '{', '}', '~', '#', '/', '!', '>']
    const inputs = Array.from({ length: 1500 }, () => Array.from({ length: 1 + rnd(14) }, () => pieces[rnd(pieces.length)]).join(''))
    same(tags, inputs)
  })

  it('matches the incremental lexer as well, with and without recovery', () => {
    for (const recover of [false, true]) {
      const fused = createLexer(tags, { incremental: true, recover })
      const plain = createLexer(tags, { incremental: true, recover, fuse: false })
      for (const input of templates) {
        const go = (l) => { try { return JSON.stringify(l.tokenizeIncremental(input).tokens) } catch (e) { return String(e.message) } }
        expect(go(fused), input).toBe(go(plain))
      }
    }
  })
})

describe('fuse: what may and may not be joined', () => {
  const t = (name, pattern, extra = {}) => ({ name, pattern, ...extra })
  const abc = ['a', 'b', 'c', 'ab', 'abc', 'aab', 'bca', 'xabcx', 'cba', 'aaa bbb ccc', '']

  it('keeps the first member that matches, even when a later one would match more', () => {
    same([t('Short', 'ab'), t('Long', 'abc'), t('Longer', 'abcd'), t('Other', '[a-z]')], ['abc', 'abcd', 'ab', 'abcdef', 'a'])
    const lexer = createLexer([t('Short', 'ab'), t('Long', 'abc'), t('Longer', 'abcd'), t('Other', '[a-z]')])
    expect(lexer.tokenize('abcd').map((x) => x.type)).toEqual(['Short', 'Other', 'Other'])
  })

  // Everything below puts its members in ONE first-character bucket (all start with
  // `x`, or are zero-width and so tried everywhere). Otherwise dispatch would keep
  // them apart and the guard being tested would never be reached.
  const types = (tokens, input) => createLexer(tokens).tokenize(input).map((x) => x.type)

  it('treats a member that matches the empty string as not matching, and tries the rest', () => {
    // `(?=b)` is zero-width, so it is tried at every offset and, at a 'b', wins the
    // alternation with an empty match. The lexer never accepts an empty token, so
    // the members after it must still get their turn.
    const tokens = [t('Look', '(?=b)'), t('Bs', 'b+'), t('Dash', 'b-'), t('Bc', 'bc'), t('Rest', '[^b]')]
    same(tokens, ['b', 'bbb', 'b-', 'bc', 'bbc', 'xb', 'bcb', '-b-'])
    expect(types(tokens, 'bbbc')).toEqual(['Bs', 'Rest'])
    expect(types(tokens, 'xbb')).toEqual(['Rest', 'Bs'])
  })

  it('fails to lex when only empty matches are left, as the loop does', () => {
    const tokens = [t('Look', '(?=b)'), t('Look2', '(?=b)'), t('Look3', '(?=b)')]
    for (const fuse of [true, false]) expect(() => createLexer(tokens, { fuse }).tokenize('b')).toThrow(/Unexpected character/)
  })

  it('does not join a member with its own capture group, whose group numbers would shift the rest', () => {
    // XGroup has a group of its own (and no backreference, so only the capture-group
    // guard stops it). Joined, every later member's index would be off by one.
    const tokens = [t('X1', 'x1+'), t('XGroup', 'x(2|7)'), t('X3', 'x3+'), t('X4', 'x4+'), t('XLone', 'x')]
    same(tokens, ['x2', 'x7', 'x3', 'x33', 'x4', 'x', 'x2x3x4x', 'x7x4x3x'])
    expect(types(tokens, 'x2x3x4x')).toEqual(['XGroup', 'X3', 'X4', 'XLone'])
  })

  it('does not join a named capture group', () => {
    const tokens = [t('X1', 'x1+'), t('Named', 'x(?<d>[5-9])'), t('X3', 'x3+'), t('X4', 'x4+'), t('XLone', 'x')]
    same(tokens, ['x5', 'x9', 'x3', 'x4', 'x', 'x6x3x4x'])
    expect(types(tokens, 'x6x3x4x')).toEqual(['Named', 'X3', 'X4', 'XLone'])
  })

  it('does not join a member with a group and a backreference either', () => {
    const tokens = [t('X1', 'x1+'), t('XGroup', 'x(2)\\1'), t('X3', 'x3+'), t('X4', 'x4+'), t('XLone', 'x')]
    same(tokens, ['x22', 'x2', 'x3', 'x4', 'x', 'x22x3x4x'])
  })

  it('does not join a pattern whose `\\1` is an octal escape, not a backreference', () => {
    // With no group of its own, `x\\1` is "x then character U+0001". Inside a fused
    // alternation the same text would be a backreference to the first member's
    // group, which matches the empty string — and 'x' would be taken for this token.
    const tokens = [t('X1', 'x1+'), t('Octal', 'x\\1'), t('X3', 'x3+'), t('XLone', 'x')]
    same(tokens, ['x', 'x\u0001', 'x1', 'x3', 'xx\u0001x3'])
    expect(types(tokens, 'x')).toEqual(['XLone'])
    expect(types(tokens, 'x\u0001')).toEqual(['Octal'])
  })

  it('does not join patterns with different flags', () => {
    // C is case-sensitive between four case-insensitive neighbours. Joined under the
    // first member's flags, C would match 'xa' too, and win it from E.
    const tokens = [t('A', 'xq+', { ignoreCase: true }), t('B', 'xr+', { ignoreCase: true }), t('C', 'xA+'), t('D', 'xs+', { ignoreCase: true }), t('E', 'x[a-z]', { ignoreCase: true })]
    same(tokens, ['xa', 'xA', 'XA', 'xQ', 'XQQ', 'xrR', 'xS', 'xaxA'])
    expect(types(tokens, 'xa')).toEqual(['E'])
    expect(types(tokens, 'xA')).toEqual(['C'])
  })

  it('runs skipped, mode-changing and longerAlt members from inside a run', () => {
    const tokens = [
      t('Word', '[a-z]+'),
      t('If', 'if', { longerAlt: 'Word' }),
      t('Ws', '\\s+', { skip: true }),
      t('Open', '<<', { pushMode: 'in' }),
      t('Num', '[0-9]+', { mode: 'in' }),
      t('Sp', ' +', { mode: 'in', skip: true }),
      t('Close', '>>', { mode: 'in', popMode: true }),
      t('Sym', '[-+]', { mode: 'in' })
    ]
    same(tokens, ['if iffy ifs', 'a <<1 + 2>> b', '<<  >>', 'if<<7>>if', '<<1', '>>', 'x  y\n z'])
  })

  it('reports the same error, at the same place, when nothing matches', () => {
    const tokens = [t('A', 'a+'), t('B', 'b+'), t('C', 'c+'), t('D', 'd+')]
    for (const input of ['aab?', '?', 'a\nb\n!']) {
      for (const fuse of [true, false]) {
        expect(() => createLexer(tokens, { fuse }).tokenize(input)).toThrow(LexError)
      }
      expect(run(createLexer(tokens), input)).toBe(run(createLexer(tokens, { fuse: false }), input))
    }
  })

  it('leaves runs shorter than three alone', () => {
    const two = [t('A', 'a+'), t('B', 'b+'), { name: 'X', literal: 'x' }]
    expect(regexCalls(two, 'aabbaabb', {})).toBe(regexCalls(two, 'aabbaabb', { fuse: false }))
  })

  it('a literal or scanner in the middle splits the run in two', () => {
    const tokens = [t('A', '[a-z]+(?=:)'), t('B', '[a-z]+(?=;)'), t('C', '[a-z]+(?=,)'), { name: 'Lit', literal: '??' }, t('D', '[a-z]+(?=:)'), t('E', '[a-z]+(?=;)'), t('F', '[a-z]+(?=,)'), t('Any', '[a-z]+')]
    same(tokens, ['x: y; z, ?? p: q; r, w', 'abc', '??', 'a:??b;'])
  })

  for (const input of abc) {
    it(`agrees on ${JSON.stringify(input)} across a dense family of overlapping patterns`, () => {
      same([t('A', 'a'), t('B', 'b'), t('C', 'c'), t('AB', 'ab'), t('ABC', 'abc'), t('Aa', 'a+'), t('Any', '[a-c]+')], [input])
    })
  }
})

describe('fuse: the example grammars', () => {
  const load = (file) => parseDefinition(readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8'), { execution: 'interpreted' }).tokens

  it('sql', () => same(load('sql.gram'), [
    "SELECT a + b FROM t WHERE x <> 1 AND y >= 2 -- trailing\nORDER BY a /* c */ DESC",
    "INSERT INTO t VALUES ('it''s', 1.5)", 'select Select SELECT selecting', '@', "'unterminated"
  ]))

  it('formula', () => same(load('formula.gram'), [
    'IF(A1>=10,SUM(B1:B5),ABS(C1))', "'Quarter 1'!$B$2 + #N/A + TRUE", '"a ""quoted"" b" & [x y]', '1.5e3 + .5 - 3.', '#BAD!'
  ]))

  it('json', () => same(json.tokens, ['{"a": [1, 2.5e3, true, null], "b": "x\\"y"}', '[\n  1,\n\t2\r\n]', '{"a": ]', '"\u0000"']))
})
