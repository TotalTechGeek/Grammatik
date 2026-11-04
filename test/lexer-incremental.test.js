import { describe, it, expect } from 'vitest'
import { createLexer } from '../src/lexer.js'

describe('createLexer incremental mode', () => {
  const defs = [
    { name: 'WS', pattern: '\\s+', skip: true },
    { name: 'Int', pattern: '\\d+' },
    { name: 'Id', pattern: '[a-zA-Z_]+' },
    { name: 'Plus', literal: '+' }
  ]

  it('is not exposed unless opted in', () => {
    const lexer = createLexer(defs)
    expect(lexer.tokenizeIncremental).toBeUndefined()
    expect(lexer.relex).toBeUndefined()
  })

  it('relex matches a from-scratch tokenize after a middle edit', () => {
    const lexer = createLexer(defs, { incremental: true })
    const oldText = 'foo 12 + 34 bar'
    const newText = 'foo 999 + 34 bar'
    const prev = lexer.tokenizeIncremental(oldText)
    const result = lexer.relex(newText, prev, { start: 4, oldEnd: 6, newEnd: 7 })
    expect(result.tokens).toEqual(lexer.tokenizeIncremental(newText).tokens)
  })

  it('reuses the unaffected prefix and suffix untouched', () => {
    const lexer = createLexer(defs, { incremental: true })
    const oldText = 'aaa 111 bbb'
    const newText = 'aaa 222 bbb'
    const prev = lexer.tokenizeIncremental(oldText)
    const result = lexer.relex(newText, prev, { start: 4, oldEnd: 7, newEnd: 7 })
    expect(result.tokens[0]).toBe(prev.tokens[0]) // same object, not just equal
    expect(result.tokens[2].start).toBe(prev.tokens[2].start)
  })

  it('re-lexes a token an insertion merges into, instead of splitting it', () => {
    const lexer = createLexer(defs, { incremental: true })
    const oldText = 'foo bar'
    const newText = 'foobar bar'
    const prev = lexer.tokenizeIncremental(oldText)
    const result = lexer.relex(newText, prev, { start: 3, oldEnd: 3, newEnd: 6 })
    expect(result.tokens.map((t) => t.image)).toEqual(['foobar', 'bar'])
  })

  it('keeps line and column correct when an edit inserts newlines', () => {
    const lexer = createLexer(defs, { incremental: true })
    const oldText = 'a + b\nc'
    const newText = 'a +\n\nb\nc'
    const prev = lexer.tokenizeIncremental(oldText)
    const result = lexer.relex(newText, prev, { start: 3, oldEnd: 4, newEnd: 5 })
    expect(result.tokens).toEqual(lexer.tokenizeIncremental(newText).tokens)
    expect(result.tokens.find((t) => t.image === 'c')).toMatchObject({ line: 4, col: 1 })
  })

  it('backs up across a whole contiguous run when maximal munch cascades through more than one token', () => {
    // `\d+(?:\.\d+)?` means an edit touching only the `.` can retroactively
    // change what the *previous* token should have matched — `2` `.` next to
    // an inserted digit becomes one `2.3` token, not three. Backing up over
    // just the one token touching the edit (the original heuristic) isn't
    // enough here; it has to walk back across the whole gap-free run.
    const numDefs = [
      { name: 'WS', pattern: '\\s+', skip: true },
      { name: 'Num', pattern: '\\d+(?:\\.\\d+)?' },
      { name: 'Op', pattern: '[./]' }
    ]
    const lexer = createLexer(numDefs, { incremental: true })
    const oldText = '2./'
    const newText = '2.3'
    const prev = lexer.tokenizeIncremental(oldText)
    const result = lexer.relex(newText, prev, { start: 2, oldEnd: 3, newEnd: 3 })
    expect(result.tokens).toEqual(lexer.tokenizeIncremental(newText).tokens)
    expect(result.tokens).toEqual([{ type: 'Num', image: '2.3', start: 0, end: 3, line: 1, col: 1 }])
  })

  it('falls back to a full re-scan when a mode stack never reconverges', () => {
    const modeDefs = [
      { name: 'Open', literal: '"', pushMode: 'str' },
      { name: 'Close', literal: '"', popMode: true, modes: ['str'] },
      { name: 'Text', pattern: '[^"]+', modes: ['str'] },
      { name: 'Id', pattern: '[a-zA-Z]+' },
      { name: 'WS', pattern: '\\s+', skip: true }
    ]
    const lexer = createLexer(modeDefs, { incremental: true })
    const oldText = 'a "hi" b'
    const newText = 'a "hi b' // deletes the closing quote, leaving an open string
    const prev = lexer.tokenizeIncremental(oldText)
    const result = lexer.relex(newText, prev, { start: 5, oldEnd: 6, newEnd: 5 })
    expect(result.tokens).toEqual(lexer.tokenizeIncremental(newText).tokens)
  })

  describe('recover: true', () => {
    it('emits an error token instead of throwing on unmatched input', () => {
      const lexer = createLexer(defs, { incremental: true, recover: true })
      const result = lexer.tokenizeIncremental('12 $ 34')
      expect(result.tokens.map((t) => t.type)).toEqual(['Int', 'Error', 'Int'])
      expect(result.tokens[1].image).toBe('$')
    })

    it('uses a custom error token name', () => {
      const lexer = createLexer(defs, { incremental: true, recover: true, errorToken: 'Bad' })
      const result = lexer.tokenizeIncremental('$')
      expect(result.tokens[0].type).toBe('Bad')
    })
  })
})
