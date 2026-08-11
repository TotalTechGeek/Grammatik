import { describe, it, expect } from 'vitest'
import { createParser, ParseError } from '../src/index.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'

const parser = createParser(jsonGrammar, { methods: jsonMethods })

describe('ParseError', () => {
  it('is a ParseError with structured details', () => {
    try {
      parser.parse('{"a" 1}')
      throw new Error('should not reach here')
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError)
      expect(error.expected).toEqual(['Colon'])
      expect(error.token).toMatchObject({ type: 'Number', image: '1', line: 1, col: 6 })
    }
  })

  it('points at the token where the parse broke, not the start', () => {
    try {
      parser.parse('[1, 2, ]')
    } catch (error) {
      expect(error.token.image).toBe(']')
      expect(error.token.col).toBe(8)
    }
  })

  it('reports the furthest failure, not the last branch tried', () => {
    // `{"a": [1, }` gets several tokens deep before failing. A naive
    // implementation would report the outermost alternative's expectation.
    try {
      parser.parse('{"a": [1, }')
    } catch (error) {
      expect(error.token.image).toBe('}')
      expect(error.expected).toContain('LSquare')
    }
  })

  it('lists all acceptable tokens at a choice point', () => {
    try {
      parser.parse('[,]')
    } catch (error) {
      expect(error.expected).toEqual(
        ['False', 'LCurly', 'LSquare', 'Null', 'Number', 'RSquare', 'String', 'True']
      )
    }
  })

  it('reports end of input when the document is truncated', () => {
    try {
      parser.parse('{"a":')
    } catch (error) {
      expect(error.token).toBeNull()
      expect(error.message).toMatch(/end of input/)
    }
  })

  it('reports trailing input in strict mode', () => {
    expect(() => parser.parse('{} []')).toThrow(/Expecting end of input/)
  })

  it('carries the rule stack for context', () => {
    try {
      parser.parse('{"a" 1}')
    } catch (error) {
      expect(Array.isArray(error.ruleStack)).toBe(true)
      expect(error.ruleStack[0]).toBe('value')
    }
  })

  it('reports the rule stack as it was at the point of failure', () => {
    // The stack must describe where the parse actually broke, not where it
    // ended up after unwinding. A mutable push/pop array would have emptied
    // itself by the time the error was constructed, leaving only the start rule.
    try {
      parser.parse('{"a": [1, {"b": }]}')
    } catch (error) {
      expect(error.ruleStack).toEqual(
        ['value', 'object', 'pair', 'value', 'array', 'value', 'object', 'pair', 'value']
      )
    }
  })

  it('reports the same rule stack compiled and interpreted', () => {
    const interpreted = createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted' })
    const stackOf = (p) => {
      try {
        p.parse('{"a": [1, {"b": }]}')
        return null
      } catch (error) {
        return error.ruleStack
      }
    }
    expect(stackOf(interpreted)).toEqual(stackOf(parser))
  })

  it('resets error state between parses', () => {
    expect(() => parser.parse('{"a" 1}')).toThrow()
    expect(parser.parse('{"a":1}')).toEqual({ a: 1 })
    try {
      parser.parse('[')
    } catch (error) {
      // Would still say `Colon` if `expected` leaked from the earlier failure.
      expect(error.expected).not.toContain('Colon')
    }
  })
})

describe('ll1 dispatch and backtracking agree', () => {
  const backtracking = createParser(jsonGrammar, { methods: jsonMethods, ll1: false })

  const cases = ['1', '"x"', 'true', 'null', '[]', '{}', '[1,{"a":[null,false]}]', '{"a":{"b":{"c":1}}}']

  for (const source of cases) {
    it(`same result for ${source}`, () => {
      expect(backtracking.parse(source)).toEqual(parser.parse(source))
    })
  }

  it('rejects the same inputs', () => {
    for (const bad of ['', '{', '[1,]', '{"a"}', '1 2']) {
      expect(() => backtracking.parse(bad), bad).toThrow()
    }
  })

  it('does not let one parser reuse the other parser dispatch table', () => {
    // Both parsers share the very same `alt` branch arrays, so a cache keyed
    // only on the node would hand the ll1:false parser a dispatch table.
    expect(backtracking.parse('[1,2]')).toEqual([1, 2])
    expect(parser.parse('[1,2]')).toEqual([1, 2])
  })
})

describe('offset position mode', () => {
  const offsets = createParser(jsonGrammar, { methods: jsonMethods, positions: 'offset' })

  it('parses identically to full position mode', () => {
    for (const source of ['1', '{"a":[1,true,null]}', '  {  "a" : 2 }  ']) {
      expect(offsets.parse(source)).toEqual(parser.parse(source))
    }
  })

  it('reports the failure by offset instead of line and column', () => {
    try {
      offsets.parse('{"a" 1}')
      throw new Error('should not reach here')
    } catch (error) {
      expect(error.message).toMatch(/at offset 5/)
      expect(error.message).not.toMatch(/line/)
      expect(error.expected).toEqual(['Colon'])
      expect(error.token).toMatchObject({ type: 'Number', image: '1', start: 5 })
    }
  })

  it('still rejects exactly the same inputs', () => {
    for (const bad of ['', '{', '[1,]', '{"a"}', '1 2']) {
      expect(() => offsets.parse(bad), bad).toThrow()
    }
  })
})
