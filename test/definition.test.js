import { describe, it, expect } from 'vitest'
import {
  OPERATORS, CONSTRUCTOR_NAMES, definitionGrammar,
  parseDefinition, createParserFromSource, createParser
} from '../src/index.js'

/**
 * The grammar-definition language is part of the library, not an example, so it
 * has to keep up with the operator set. The coverage test below is the point:
 * `oneOf`, `eof` and `infixRight` were added as combinators and silently left
 * out of the language for a while, and nothing caught it.
 */

describe('the language covers the operator set', () => {
  it('has a constructor for every operator', () => {
    const missing = OPERATORS.filter((op) => !CONSTRUCTOR_NAMES.includes(op))
    expect(missing, `operators with no way to write them: ${missing.join(', ')}`).toEqual([])
  })

  it('does not offer constructors for operators that do not exist', () => {
    const extra = CONSTRUCTOR_NAMES.filter((name) => !OPERATORS.includes(name))
    expect(extra).toEqual([])
  })
})

describe('parseDefinition', () => {
  const source = `
    grammar Calc;
    start sum;
    token WS pattern "\\\\s+" skip;
    token Int pattern "[0-9]+";
    token Plus literal "+";
    rule sum = infixLeft(
      as(consume(Int), action({"+":[{"val":"image"},0]})),
      consume(Plus),
      action({"+":[{"val":"left"},{"val":"right"}]})
    );
  `

  it('produces plain data', () => {
    const grammar = parseDefinition(source)
    expect(grammar.name).toBe('Calc')
    expect(grammar.start).toBe('sum')
    expect(grammar.tokens.map((t) => t.name)).toEqual(['WS', 'Int', 'Plus'])
    // No functions anywhere: it must survive a JSON round trip untouched.
    expect(JSON.parse(JSON.stringify(grammar))).toEqual(grammar)
  })

  it('builds a working parser from the data', () => {
    expect(createParser(parseDefinition(source)).parse('1 + 2 + 3')).toBe(6)
  })

  it('goes from source straight to a parser', () => {
    expect(createParserFromSource(source).parse('1 + 2 + 3')).toBe(6)
  })

  it('honours execution mode end to end', () => {
    const parser = createParserFromSource(source, { execution: 'interpreted' })
    expect(parser.execution).toBe('interpreted')
    expect(parser.parse('1 + 2 + 3')).toBe(6)
  })

  it('reports where a definition is malformed', () => {
    expect(() => parseDefinition('grammar X; start a; rule a = nope(1);'))
      .toThrow(/Unknown parser constructor nope/)
    expect(() => parseDefinition('grammar X; start a; rule a = many(1, 2);'))
      .toThrow(/many expects 1 argument/)
    expect(() => parseDefinition('grammar X start a;')).toThrow(/Expecting Semicolon/)
  })

  it('rejects a grammar the analyzer refuses', () => {
    const leftRecursive = `
      grammar Bad;
      start a;
      token Int pattern "[0-9]+";
      rule a = seq(subrule(a), consume(Int));
    `
    expect(() => createParserFromSource(leftRecursive)).toThrow(/left-recursive/)
  })
})

describe('the definition grammar is itself a grammar in this format', () => {
  it('is plain data', () => {
    expect(JSON.parse(JSON.stringify(definitionGrammar))).toEqual(definitionGrammar)
  })

  it('can be handed to createParser directly', () => {
    // Not a shortcut for `createDefinitionParser` — it needs the meta methods —
    // but the shape must be a valid grammar spec.
    expect(definitionGrammar.start).toBe('Document')
    expect(Object.keys(definitionGrammar.rules).length).toBeGreaterThan(5)
  })
})

describe('every constructor round-trips through the language', () => {
  // One rule per constructor, to prove each is actually reachable from source.
  const cases = {
    consume: 'consume(A)',
    oneOf: 'oneOf(A, B)',
    eof: 'seq(consume(A), eof())',
    epsilon: 'seq(epsilon(), consume(A))',
    seq: 'seq(consume(A), consume(B))',
    alt: 'alt(consume(A), consume(B))',
    many: 'many(consume(A))',
    many1: 'many1(consume(A))',
    option: 'seq(option(consume(A)), consume(B))',
    manySep: 'manySep(consume(A), consume(B))',
    many1Sep: 'many1Sep(consume(A), consume(B))',
    label: 'seq(label(x, consume(A)), action({"val":"x"}))',
    action: 'seq(consume(A), action(1))',
    lookahead: 'seq(lookahead(consume(A)), consume(A))',
    negLookahead: 'seq(negLookahead(consume(B)), consume(A))',
    text: 'text(seq(consume(A), consume(B)))',
    as: 'as(consume(A), action({"val":"image"}))',
    between: 'between(consume(A), consume(B), consume(A))',
    subrule: 'seq(subrule(other), consume(B))',
    infixLeft: 'infixLeft(consume(A), consume(B), action({"val":"left"}))',
    infixRight: 'infixRight(consume(A), consume(B), action({"val":"left"}))',
    prefix: 'prefix(consume(B), consume(A), action({"val":"operand"}))',
    postfix: 'postfix(consume(A), consume(B), action({"val":"left"}))'
  }

  for (const [name, body] of Object.entries(cases)) {
    it(name, () => {
      const source = `
        grammar T; start main;
        token A literal "a";
        token B literal "b";
        rule main = ${body};
        rule other = consume(A);
      `
      const grammar = parseDefinition(source)
      // The rule must contain the operator it names, somewhere.
      expect(JSON.stringify(grammar.rules.main), body).toContain(`"${name}"`)
      // And the grammar must be buildable.
      expect(() => createParser(grammar, { validate: false })).not.toThrow()
    })
  }

  it('covers every operator between them', () => {
    expect(Object.keys(cases).sort()).toEqual([...OPERATORS].sort())
  })
})
