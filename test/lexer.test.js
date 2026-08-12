import { describe, it, expect } from 'vitest'
import { createLexer, LexError } from '../src/lexer.js'

describe('createLexer', () => {
  const defs = [
    { name: 'WS', pattern: '\\s+', skip: true },
    { name: 'Int', pattern: '\\d+' },
    { name: 'Plus', literal: '+' }
  ]

  it('produces tokens with positions', () => {
    const { tokenize } = createLexer(defs)
    expect(tokenize('12 + 3')).toEqual([
      { type: 'Int', id: 1, image: '12', start: 0, end: 2, line: 1, col: 1 },
      { type: 'Plus', id: 2, image: '+', start: 3, end: 4, line: 1, col: 4 },
      { type: 'Int', id: 1, image: '3', start: 5, end: 6, line: 1, col: 6 }
    ])
  })

  it('drops skipped tokens but still advances position', () => {
    const { tokenize } = createLexer(defs)
    const tokens = tokenize('   7')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].start).toBe(3)
  })

  it('tracks line and column across newlines, including inside skipped text', () => {
    const { tokenize } = createLexer(defs)
    const tokens = tokenize('1\n\n  22')
    expect(tokens[1]).toMatchObject({ image: '22', line: 3, col: 3 })
  })

  it('tracks lines inside a multi-line token image', () => {
    const { tokenize } = createLexer([
      { name: 'Block', pattern: '/\\*[\\s\\S]*?\\*/' },
      { name: 'Int', pattern: '\\d+' },
      { name: 'WS', pattern: '\\s+', skip: true }
    ])
    const tokens = tokenize('/* a\nb */ 5')
    expect(tokens[1]).toMatchObject({ image: '5', line: 2 })
  })

  it('throws a positioned LexError on an unmatched character', () => {
    const { tokenize } = createLexer(defs)
    expect(() => tokenize('1 $ 2')).toThrowError(LexError)
    try {
      tokenize('1\n$')
    } catch (error) {
      expect(error.line).toBe(2)
      expect(error.col).toBe(1)
      expect(error.offset).toBe(2)
    }
  })

  it('prefers a longer alternative when longerAlt is set', () => {
    const { tokenize } = createLexer([
      { name: 'WS', pattern: '\\s+', skip: true },
      { name: 'Identifier', pattern: '[a-zA-Z_]\\w*' },
      { name: 'If', literal: 'if', longerAlt: 'Identifier' }
    ])
    // `If` is declared after `Identifier`, so ordering alone would never pick it;
    // what matters here is that `iffy` does not lex as If + fy.
    expect(tokenize('iffy').map((t) => t.type)).toEqual(['Identifier'])
  })

  it('lets an earlier keyword win when longerAlt does not match more text', () => {
    const { tokenize } = createLexer([
      { name: 'WS', pattern: '\\s+', skip: true },
      { name: 'If', literal: 'if', longerAlt: 'Identifier' },
      { name: 'Identifier', pattern: '[a-zA-Z_]\\w*' }
    ])
    expect(tokenize('if iffy').map((t) => t.type)).toEqual(['If', 'Identifier'])
  })

  it('supports case-insensitive patterns', () => {
    const { tokenize } = createLexer([{ name: 'Select', pattern: 'select', ignoreCase: true }])
    expect(tokenize('SeLeCt')[0].type).toBe('Select')
  })

  it('never loops on a pattern that can match empty', () => {
    const { tokenize } = createLexer([
      { name: 'Maybe', pattern: '\\d*' },
      { name: 'Word', pattern: '[a-z]+' }
    ])
    expect(tokenize('ab').map((t) => t.type)).toEqual(['Word'])
  })

  it('rejects malformed definitions', () => {
    expect(() => createLexer([])).toThrow(/non-empty array/)
    expect(() => createLexer([{ name: 'A' }])).toThrow(/pattern or a literal/)
    expect(() => createLexer([{ name: 'A', pattern: 'a', literal: 'a' }])).toThrow(/pick one/)
    expect(() => createLexer([{ name: 'A', literal: 'a' }, { name: 'A', literal: 'b' }])).toThrow(/duplicate/)
    expect(() => createLexer([{ name: 'A', literal: 'a', longerAlt: 'Nope' }])).toThrow(/not a defined token/)
  })

  it('returns an empty token list for empty input', () => {
    const { tokenize } = createLexer(defs)
    expect(tokenize('')).toEqual([])
  })
})

describe('position tracking modes', () => {
  const defs = [
    { name: 'WS', pattern: '\\s+', skip: true },
    { name: 'Int', pattern: '\\d+' }
  ]

  it('records line and column by default', () => {
    const { tokenize, positions } = createLexer(defs)
    expect(positions).toBe('full')
    expect(tokenize('1\n\n  22')[1]).toMatchObject({ image: '22', line: 3, col: 3 })
  })

  it('offset mode keeps offsets and drops line/column', () => {
    const { tokenize, positions } = createLexer(defs, { positions: 'offset' })
    expect(positions).toBe('offset')
    const [, second] = tokenize('1\n\n  22')
    expect(second).toMatchObject({ image: '22', start: 5, end: 7, line: 0, col: 0 })
  })

  it('produces the same types, images and offsets in both modes', () => {
    const full = createLexer(defs).tokenize('1\n 22\n\n333')
    const offset = createLexer(defs, { positions: 'offset' }).tokenize('1\n 22\n\n333')
    const shape = (tokens) => tokens.map((t) => ({ type: t.type, image: t.image, start: t.start, end: t.end }))
    expect(shape(offset)).toEqual(shape(full))
  })

  it('reports lex errors by offset when lines are not tracked', () => {
    const { tokenize } = createLexer(defs, { positions: 'offset' })
    expect(() => tokenize('1 $')).toThrow(/at offset 2/)
  })
})
