import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createLexer, createParser, parseDefinition, createParserFromSource, emitModule } from '../src/index.js'

/**
 * Lexer modes: a token belongs to one or more modes and only competes while one
 * of them is current.
 *
 * The motivating case is a templating language, where the same character means
 * different things inside and outside a tag — whitespace is literal text in one
 * and skippable in the other. Without modes that needs a hand-written scanner,
 * which is exactly the thing a data grammar is supposed to avoid.
 */

const TEMPLATE_TOKENS = [
  { name: 'Text', pattern: '(?:[^{]|\\{(?!\\{))+', mode: 'default' },
  { name: 'Open', literal: '{{', mode: 'default', pushMode: 'expression' },
  { name: 'Close', literal: '}}', mode: 'expression', popMode: true },
  { name: 'WS', pattern: '[ \\t\\r\\n]+', mode: 'expression', skip: true },
  { name: 'Name', pattern: '[A-Za-z_][A-Za-z0-9_.]*', mode: 'expression' }
]

const typesOf = (tokens) => tokens.map((t) => t.type)
const imagesOf = (tokens) => tokens.map((t) => t.image)

describe('a grammar with one mode is untouched', () => {
  const defs = [
    { name: 'WS', pattern: '\\s+', skip: true },
    { name: 'Int', pattern: '\\d+' },
    { name: 'Plus', literal: '+' }
  ]

  it('reports the one mode it has', () => {
    expect(createLexer(defs).modeNames).toEqual(['default'])
  })

  it('lexes exactly as before', () => {
    const tokens = createLexer(defs).tokenize('1 + 22')
    expect(typesOf(tokens)).toEqual(['Int', 'Plus', 'Int'])
    expect(tokens[2]).toEqual({ type: 'Int', id: 1, image: '22', start: 4, end: 6, line: 1, col: 5 })
  })

  it('says nothing about modes in its errors', () => {
    expect(() => createLexer(defs).tokenize('1 & 2')).toThrow(/Unexpected character '&' at line 1 column 3$/)
  })
})

describe('pushing and popping', () => {
  const lexer = createLexer(TEMPLATE_TOKENS)

  it('switches vocabulary at the delimiters', () => {
    const tokens = lexer.tokenize('hi {{ name }} there')
    expect(typesOf(tokens)).toEqual(['Text', 'Open', 'Name', 'Close', 'Text'])
    // Whitespace is text outside and skipped inside — the whole point.
    expect(imagesOf(tokens)).toEqual(['hi ', '{{', 'name', '}}', ' there'])
  })

  it('names every mode it saw', () => {
    expect(lexer.modeNames).toEqual(['default', 'expression'])
  })

  it('handles a template that is all tag', () => {
    expect(typesOf(lexer.tokenize('{{a}}'))).toEqual(['Open', 'Name', 'Close'])
  })

  it('handles a template with no tags at all', () => {
    expect(typesOf(lexer.tokenize('just text'))).toEqual(['Text'])
  })

  it('nests pushes and pops', () => {
    const defs = [
      { name: 'Text', pattern: '[a-z]+', mode: 'default' },
      { name: 'LParen', literal: '(', mode: 'default', pushMode: 'default' },
      { name: 'RParen', literal: ')', mode: 'default', popMode: true }
    ]
    // Pushing the mode you are already in still stacks, so pops have to match.
    expect(typesOf(createLexer(defs).tokenize('a(b(c))'))).toEqual(
      ['Text', 'LParen', 'Text', 'LParen', 'Text', 'RParen', 'RParen']
    )
  })

  it('lets one token serve several modes', () => {
    const defs = [
      { name: 'Open', literal: '{{', mode: 'default', pushMode: 'expression' },
      { name: 'OpenRaw', literal: '{!', mode: 'default', pushMode: 'raw' },
      { name: 'Text', pattern: '[a-z ]+', mode: 'default' },
      { name: 'Name', pattern: '[A-Z]+', modes: ['expression', 'raw'] },
      { name: 'WS', pattern: '\\s+', modes: ['expression', 'raw'], skip: true },
      { name: 'Close', literal: '}}', mode: 'expression', popMode: true },
      { name: 'CloseRaw', literal: '!}', mode: 'raw', popMode: true }
    ]
    const lexer = createLexer(defs)
    expect(typesOf(lexer.tokenize('a {{ B }} c {! D !}'))).toEqual(
      ['Text', 'Open', 'Name', 'Close', 'Text', 'OpenRaw', 'Name', 'CloseRaw']
    )
  })

  it('transitions on a skipped token', () => {
    const defs = [
      { name: 'Word', pattern: '[a-z]+', mode: 'default' },
      { name: 'CommentOpen', literal: '/*', mode: 'default', skip: true, pushMode: 'comment' },
      { name: 'CommentBody', pattern: '[^*]+', mode: 'comment', skip: true },
      { name: 'CommentClose', literal: '*/', mode: 'comment', skip: true, popMode: true }
    ]
    // Nothing is emitted by any of the comment tokens, but the modes still move.
    expect(typesOf(createLexer(defs).tokenize('a/* junk */b'))).toEqual(['Word', 'Word'])
  })
})

describe('the mode stack belongs to one tokenize call', () => {
  const lexer = createLexer(TEMPLATE_TOKENS)

  it('starts fresh even when the previous call ended mid-tag', () => {
    // Reaching the end inside a pushed mode is not a lexer error; the parser
    // reports the missing `}}` far better than the lexer could.
    expect(typesOf(lexer.tokenize('a {{ b'))).toEqual(['Text', 'Open', 'Name'])
    expect(typesOf(lexer.tokenize('c'))).toEqual(['Text'])
  })

  it('starts fresh after a failure', () => {
    expect(() => lexer.tokenize('{{ ! }}')).toThrow(/Unexpected character/)
    expect(typesOf(lexer.tokenize('plain'))).toEqual(['Text'])
  })

  it('reports the mode it failed in', () => {
    expect(() => lexer.tokenize('{{ ! }}')).toThrow(/in lexer mode 'expression'/)
  })
})

describe('what the lexer refuses to build', () => {
  it('a token that both pushes and pops', () => {
    expect(() => createLexer([
      { name: 'A', literal: 'a', pushMode: 'other', popMode: true },
      { name: 'B', literal: 'b', mode: 'other' }
    ])).toThrow(/both pushes 'other' and pops/)
  })

  it('a push to a mode no token belongs to', () => {
    expect(() => createLexer([{ name: 'A', literal: 'a', pushMode: 'ghost' }]))
      .toThrow(/pushes mode 'ghost', which no token belongs to/)
  })

  it('a longerAlt that is not active where it could win', () => {
    expect(() => createLexer([
      { name: 'Open', literal: '{{', pushMode: 'expression' },
      { name: 'If', literal: 'if', mode: 'expression', longerAlt: 'Name' },
      { name: 'Name', pattern: '[a-z]+', mode: 'default' }
    ])).toThrow(/longerAlt 'Name', which is not active there/)
  })
})

describe('popping past the bottom', () => {
  it('is a LexError naming the token that did it', () => {
    const lexer = createLexer([
      { name: 'Word', pattern: '[a-z]+', mode: 'default' },
      { name: 'Close', literal: '}}', mode: 'default', popMode: true }
    ])
    expect(() => lexer.tokenize('a}}')).toThrow(/Token 'Close' popped the initial lexer mode at line 1 column 2/)
  })

  it('carries the position, like any other lex error', () => {
    const lexer = createLexer([
      { name: 'Word', pattern: '[a-z]+', mode: 'default' },
      { name: 'NL', pattern: '\\n', mode: 'default', skip: true },
      { name: 'Close', literal: '}}', mode: 'default', popMode: true }
    ])
    try {
      lexer.tokenize('a\nb\n}}')
      expect.unreachable()
    } catch (error) {
      expect(error.name).toBe('LexError')
      expect({ offset: error.offset, line: error.line, col: error.col }).toEqual({ offset: 4, line: 3, col: 1 })
    }
  })
})

describe('longerAlt across a transition', () => {
  // `if` opens a block; `iffy` is an ordinary name and opens nothing. The
  // transition has to come from whichever token actually won.
  const defs = [
    { name: 'WS', pattern: '\\s+', modes: ['default', 'block'], skip: true },
    { name: 'If', literal: 'if', longerAlt: 'Name', pushMode: 'block' },
    { name: 'Name', pattern: '[a-z]+' },
    { name: 'End', literal: '.', mode: 'block', popMode: true },
    { name: 'Inner', pattern: '[A-Z]+', mode: 'block' }
  ]

  it('takes the winner’s transition when the alternative wins', () => {
    // `iffy` wins over `if`, so no mode is pushed and `X` is not lexable.
    expect(() => createLexer(defs).tokenize('iffy X')).toThrow(/Unexpected character 'X'/)
  })

  it('takes the keyword’s transition when the keyword wins', () => {
    expect(typesOf(createLexer(defs).tokenize('if X. y'))).toEqual(['If', 'Inner', 'End', 'Name'])
  })
})

describe('positions across transitions', () => {
  it('tracks line and column through a mode change', () => {
    const tokens = createLexer(TEMPLATE_TOKENS).tokenize('one\ntwo {{\n  name\n}} end')
    const name = tokens.find((t) => t.type === 'Name')
    expect({ line: name.line, col: name.col }).toEqual({ line: 3, col: 3 })
    const close = tokens.find((t) => t.type === 'Close')
    expect({ line: close.line, col: close.col }).toEqual({ line: 4, col: 1 })
  })

  it('records offsets only, when asked', () => {
    const tokens = createLexer(TEMPLATE_TOKENS, { positions: 'offset' }).tokenize('ab {{ cd }}')
    const name = tokens.find((t) => t.type === 'Name')
    expect({ start: name.start, end: name.end, line: name.line }).toEqual({ start: 6, end: 8, line: 0 })
  })

  it('reports offsets in errors when not tracking lines', () => {
    expect(() => createLexer(TEMPLATE_TOKENS, { positions: 'offset' }).tokenize('{{ ! }}'))
      .toThrow(/at offset 3 \(in lexer mode 'expression'\)/)
  })
})

describe('the definition language', () => {
  const SOURCE = `
    grammar Template;
    start doc;

    token Text pattern "(?:[^{]|\\\\{(?!\\\\{))+" mode default;
    token Open literal "{{" mode default pushMode expression;
    token Close literal "}}" mode expression popMode;
    token WS pattern "[ \\\\t\\\\r\\\\n]+" mode expression skip;
    token Name pattern "[A-Za-z_][A-Za-z0-9_.]*" mode expression;

    rule doc = many1(alt(
      as(consume(Text), action({"val":"image"})),
      seq(consume(Open), label(n, as(consume(Name), action({"val":"image"}))), consume(Close), action({"val":"n"}))
    ));
  `

  it('parses the mode flags into plain data', () => {
    const grammar = parseDefinition(SOURCE)
    expect(grammar.tokens[1]).toEqual({ name: 'Open', literal: '{{', mode: 'default', pushMode: 'expression' })
    expect(grammar.tokens[2]).toEqual({ name: 'Close', literal: '}}', mode: 'expression', popMode: true })
    expect(JSON.parse(JSON.stringify(grammar))).toEqual(grammar)
  })

  it('collapses a repeated mode flag into a modes array', () => {
    const grammar = parseDefinition(`
      grammar T; start main;
      token A literal "a" mode default pushMode one;
      token B literal "b" mode one mode two;
      token C literal "c" mode one popMode;
      token D literal "d" mode two popMode;
      rule main = many1(consume(A));
    `)
    expect(grammar.tokens[1]).toEqual({ name: 'B', literal: 'b', modes: ['one', 'two'] })
  })

  it('builds a parser that uses them', () => {
    expect(createParserFromSource(SOURCE).parse('hi {{ name }}!')).toEqual(['hi ', 'name', '!'])
  })
})

describe('runtime and emitted parsers agree', () => {
  let dir
  let counter = 0
  const runtimeUrl = pathToFileURL(path.resolve('src/runtime.js')).href

  const grammar = {
    tokens: TEMPLATE_TOKENS,
    start: 'doc',
    rules: {
      doc: {
        many1: {
          alt: [
            { as: [{ consume: 'Text' }, { val: 'image' }] },
            {
              seq: [
                { consume: 'Open' },
                { label: ['n', { as: [{ consume: 'Name' }, { val: 'image' }] }] },
                { consume: 'Close' },
                { action: { val: 'n' } }
              ]
            }
          ]
        }
      }
    }
  }

  const samples = ['hi {{ name }} there', '{{a}}{{b}}', 'plain', 'x {{ y.z }}']

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'grammatik-modes-'))
    const { build } = await import('esbuild')
    await build({
      entryPoints: [path.resolve('src/runtime.js')],
      outfile: path.join(dir, 'runtime.cjs'),
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent'
    })
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('an emitted ES module matches the runtime parser', async () => {
    const file = path.join(dir, `parser-${counter++}.mjs`)
    await writeFile(file, emitModule(grammar, { runtimeSpecifier: runtimeUrl }))
    const module = await import(pathToFileURL(file).href)
    const reference = createParser(grammar)
    for (const sample of samples) expect(module.parse(sample), sample).toEqual(reference.parse(sample))
  })

  it('an emitted CommonJS module matches too', async () => {
    const file = path.join(dir, `parser-${counter++}.cjs`)
    await writeFile(file, emitModule(grammar, { format: 'cjs', runtimeSpecifier: './runtime.cjs' }))
    const module = createRequire(file)(file)
    const reference = createParser(grammar)
    for (const sample of samples) expect(module.parse(sample), sample).toEqual(reference.parse(sample))
  })

  it('carries the mode flags through as data', async () => {
    const source = emitModule(grammar, { runtimeSpecifier: runtimeUrl })
    expect(source).toContain('"pushMode": "expression"')
    expect(source).toContain('"popMode": true')
  })
})
