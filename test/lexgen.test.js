import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createLexer } from '../src/lexer.js'
import { generateLexer } from '../src/lexgen.js'
import { LexError } from '../src/state.js'
import { emitModule, parseDefinition } from '../src/index.js'
import { grammar as json } from '../examples/json.js'

/**
 * A lexer written out as source has to mean exactly what `createLexer` means. Every
 * case here lexes the same input both ways and compares everything observable: the
 * tokens (every field), the error message and the error's position.
 */

const load = (file) => parseDefinition(readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8'), { execution: 'interpreted' }).tokens

/** The generated lexer, evaluated the way an emitted module evaluates it. */
const generate = (tokens, options) => new Function('tokens', 'LexError', `return ${generateLexer(tokens, options)}`)(tokens, LexError) // eslint-disable-line no-new-func

const outcome = (lexer, input) => {
  try {
    return JSON.stringify(lexer.tokenize(input))
  } catch (e) {
    return `${e.name}: ${e.message} @${e.offset},${e.line},${e.col}`
  }
}

// ---- a deterministic source of inputs ----
function prng (seed) {
  let a = seed >>> 0
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}
const fuzz = (pieces, count, seed) => {
  const rnd = prng(seed)
  return Array.from({ length: count }, () => Array.from({ length: 1 + rnd(14) }, () => pieces[rnd(pieces.length)]).join(rnd(4) === 0 ? ' ' : ''))
}

// ---- grammars: the three examples, and one that uses every feature the generator writes out ----
const t = (name, pattern, extra = {}) => ({ name, pattern, ...extra })
const kitchenSink = [
  t('Ws', '\\s+', { skip: true }),
  t('Line', '--[^\\n]*', { skip: true }),
  t('Hash', '#[^\\n\\r]*', { skip: true }),
  t('Select', 'SELECT(?![A-Za-z0-9_])', { ignoreCase: true }),
  t('If', 'if', { longerAlt: 'Word' }),
  { name: 'Then', literal: 'then', longerAlt: 'Word' },
  t('Cell', '[A-Z]+[0-9]+'),
  t('Word', '[a-z]+'),
  t('Num', '-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'),
  // a class whose first character is NOT one of its run characters, so the two tests differ
  t('Signed', '[+-][0-9]*'),
  { name: 'Del', literal: '\u007f' },
  t('Json', '-?(?:0|[1-9]\\d*)(?:\\.\\d+)?'),
  t('Str', '"(?:[^"\\\\]|\\\\.)*"'),
  t('Quoted', "'(?:''|[^'])*'"),
  t('Jstr', '`(?:[^`\\\\\\u0000-\\u001f]|\\\\(?:[`\\\\/bfnrt]|u[0-9a-fA-F]{4}))*`'),
  t('A1', 'ab1+'), t('A2', 'ab2+'), t('A3', 'ab3+'), t('A4', 'ab4+'),
  { name: 'Open', literal: '<<', pushMode: 'in' },
  { name: 'Underflow', literal: '!!', popMode: true },
  t('InWs', ' +', { mode: 'in', skip: true }),
  t('InNum', '[0-9]+', { mode: 'in' }),
  { name: 'InClose', literal: '>>', mode: 'in', popMode: true },
  { name: 'InDeeper', literal: '<<', mode: 'in', pushMode: 'in' },
  { name: 'Punct', literal: ',' },
  { name: 'Semi', literal: ';' }
]
// a mode whose every token starts with a lookahead, so first-character dispatch can tell nothing
const noDispatch = [
  t('Ws', '\\s+', { skip: true }),
  t('X', '(?=[xy])[a-z]+'),
  t('N', '(?=[0-9])[0-9a-f]+'),
  { name: 'Dot', literal: '.' }
]

// the first member of a fused run matches the empty string, so the ones after it must still be tried
const emptyWinner = [t('Look', '(?=b)'), t('Bs', 'b+'), t('Dash', 'b-'), t('Bc', 'bc'), t('Rest', '[^b]')]
// whitespace that is a real token, so where a run of it ends is visible
const wideTokens = [t('Space', '\\s+'), t('Word', '[a-z]+')]

const grammars = {
  sql: {
    tokens: load('sql.gram'),
    pieces: ['SELECT', 'select', 'Select', 'selecting', 'FROM', 'where', 'AND', 'or', 'NOT', 'x', 'tbl_1', '12', '3.14', '1.', '.5', "'a'", "'it''s'", "'open", '--c\n', '-- c', '/* c */', '/*', '*/', ' ', '\n', '\t', '\u00a0', '\u2003', ',', '.', '(', ')', '=', '<>', '<=', '>=', '<', '>', '+', '-', '*', '/', ';', '@', 'é']
  },
  formula: {
    tokens: load('formula.gram'),
    pieces: ['IF(', 'SUM(', 'A1', 'B2:C3', '$A$1', 'x', '1.5e3', '.5', '"str"', '"a""b"', "'Sheet 1'!", '#N/A', '#REF!', 'TRUE', 'false', '[name]', '&', '^', '%', ' ', '\u00a0', '{', '}', ';', ',', '+', '-', '*', '/', '=', '<', '>', '(', ')', 'é', '1e', '1.']
  },
  json: {
    tokens: json.tokens,
    pieces: ['0', '-0', '01', '-', '1.', '1.5', '1.5e', '1.5e+3', '1E-2', '.5', '"', '""', '"a"', '"a\\"b"', '"\\u00e9"', '"\\u00g9"', '"\\x"', '"a\nb"', '"é☃"', '"\\', ' ', '\n', '\t', ',', '[', ']', '{', '}', ':', 'true', 'false', 'null', 'nul', 'x', '\u00a0']
  },
  kitchenSink: {
    tokens: kitchenSink,
    pieces: ['SELECT', 'select', 'SeLeCt', 'selected', 'if', 'iffy', 'then', 'thence', 'word', 'A12', 'AB12', 'ab1', 'ab11', 'ab2', 'ab3', 'ab4', 'ab5', '12', '-3.5', '1e9', '1E+2', '0', '07', '"s"', '"a\\"b"', '"x\\', "'q'", "'it''s'", "'open", '`j`', '`\\u00e9`', '`\\u12`', '`a\nb`', '<<', '<< 12 >>', '<<<<', '>>', '!!', ' ', '  ', '\n', '\t', '\u00a0', '--c\n', '#h\n', ',', ';', '?', 'é', '+5', '+', '-', '\u007f']
  },
  noDispatch: {
    tokens: noDispatch,
    pieces: ['x', 'xyz', 'y', 'zz', '1', 'ff', '1a', 'g', '.', ' ', '\n', '\u00a0', 'é']
  },
  emptyWinner: {
    tokens: emptyWinner,
    pieces: ['b', 'bb', 'b-', 'bc', 'bbc', 'x', '-', ' ', 'é']
  },
  wideTokens: {
    tokens: wideTokens,
    pieces: [' ', '  ', '\u00a0', '\u2003', '\u2028', '\n', '\t', 'a', 'bc', 'é', '\ufeff', '\u007f']
  }
}

const settings = []
for (const positions of ['full', 'offset']) for (const scanners of [true, false]) for (const fuse of [true, false]) settings.push({ positions, scanners, fuse })

describe('a generated lexer is the createLexer lexer', () => {
  for (const [name, { tokens, pieces }] of Object.entries(grammars)) {
    describe(name, () => {
      const inputs = ['', ' ', ...pieces, ...fuzz(pieces, 700, name.length * 97 + 11)]
      for (const options of settings) {
        it(`positions: ${options.positions}, scanners: ${options.scanners}, fuse: ${options.fuse}`, () => {
          const generated = generate(tokens, options)
          const engine = createLexer(tokens, options)
          expect(generated.tokenNames).toEqual(engine.tokenNames)
          expect(generated.positions).toEqual(engine.positions)
          expect(generated.modeNames).toEqual(engine.modeNames)
          for (const input of inputs) expect(outcome(generated, input), JSON.stringify(input)).toBe(outcome(engine, input))
        })
      }
    })
  }

  it('really does lex: the corpora produce plenty of tokens, and plenty of errors', () => {
    // Guards against comparing two lexers that both fail on everything.
    for (const [name, { tokens, pieces }] of Object.entries(grammars)) {
      const lexer = generate(tokens, { positions: 'offset' })
      let ok = 0
      let failed = 0
      for (const input of fuzz(pieces, 300, name.length * 97 + 11)) {
        try { lexer.tokenize(input); ok++ } catch (e) { failed++ }
      }
      expect(ok, `${name}: lexed`).toBeGreaterThan(20)
      if (!['noDispatch', 'wideTokens', 'emptyWinner'].includes(name)) expect(failed, `${name}: rejected`).toBeGreaterThan(5)
    }
  })

  it('throws the runtime LexError, with the position on it', () => {
    const lexer = generate(kitchenSink, { positions: 'full' })
    let caught
    try { lexer.tokenize('word\n  ?') } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LexError)
    // This grammar has several modes, so the message names the one the lexer was in.
    expect(caught.message).toBe("Unexpected character '?' at line 2 column 3 (in lexer mode 'default')")
    expect([caught.offset, caught.line, caught.col]).toEqual([7, 2, 3])
  })

  it('names the mode in an error, and reports an underflowing pop, as the engine does', () => {
    for (const positions of ['full', 'offset']) {
      const generated = generate(kitchenSink, { positions })
      const engine = createLexer(kitchenSink, { positions })
      for (const input of ['<< ?', '<<<< 5 >>', 'word !!', '<< 1 >> >>', '<< !!']) {
        expect(outcome(generated, input), input).toBe(outcome(engine, input))
      }
      expect(outcome(generated, 'word !!')).toContain('popped the initial lexer mode')
      expect(outcome(generated, '<< ?')).toContain("(in lexer mode 'in')")
    }
  })

  it('ignores an empty match from a skipped token instead of spinning on it', () => {
    // `(?=a)` matches the empty string wherever an 'a' follows. An empty token never advances, so
    // the lexer must treat it as "no match" and move on. If it did not, tokenize would never return —
    // so this runs in a child process that can be killed.
    const script = `
      import { generateLexer } from ${JSON.stringify(pathToFileURL(path.resolve('src/lexgen.js')).href)}
      import { LexError } from ${JSON.stringify(pathToFileURL(path.resolve('src/state.js')).href)}
      const tokens = [{ name: 'Peek', pattern: '(?=a)', skip: true }, { name: 'A', pattern: 'a+' }, { name: 'B', pattern: 'b+' }]
      const lexer = new Function('tokens', 'LexError', 'return ' + generateLexer(tokens, { positions: 'offset' }))(tokens, LexError)
      console.log(lexer.tokenize('aabba').map((x) => x.type + ':' + x.image).join(' '))`
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 })
    expect(out.trim()).toBe('A:aa B:bb A:a')
  })

  it('rejects a non-string, as the engine does', () => {
    expect(() => generate(kitchenSink, {}).tokenize(42)).toThrow(TypeError)
  })
})

describe('what the generated source contains', () => {
  it('writes out only the scanners the grammar uses', () => {
    const jsonSource = generateLexer(json.tokens, { positions: 'offset' })
    expect(jsonSource).not.toContain('scanKeyword')       // JSON has no keyword tokens
    expect(jsonSource).toContain('skipDigits')            // but it has numbers
    const sqlSource = generateLexer(load('sql.gram'), { positions: 'offset' })
    expect(sqlSource).toContain('scanKeyword')
    expect(sqlSource).toContain('skipDigits')             // SQL's decimals are a number scanner too

  })

  it('writes each helper once, however many candidate lists a token is in', () => {
    const source = generateLexer(kitchenSink, { positions: 'full' })
    for (const id of [...source.matchAll(/function scan(\d+) \(/g)].map((m) => m[1])) {
      expect(source.split(`function scan${id} (`).length - 1, `scan${id}`).toBe(1)
    }
    expect((source.match(/function scanKeyword/g) || []).length).toBeLessThanOrEqual(1)
  })

  it('reads patterns from the token table instead of repeating them', () => {
    const pattern = '(?:[^\\\\{\\s]|\\{(?!\\{))+marker-that-appears-once'
    const source = generateLexer([t('Weird', pattern), t('Other', '(?=[0-9])[0-9]+'), t('Third', '(?=[a-z])[a-z]+'), t('Fourth', '(?=[A-Z])[A-Z]+')], {})
    expect(source).not.toContain('marker-that-appears-once')
  })

  it('refuses a mode with no tokens', () => {
    expect(() => generateLexer([{ name: 'A', literal: 'a', mode: 'x', pushMode: 'y' }], {})).toThrow(/mode 'default' has no tokens|mode 'y'/)
  })
})

describe('emitModule', () => {
  let dir
  let counter = 0
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'grammatik-lexgen-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  const runtimeUrl = pathToFileURL(path.resolve('src/runtime.js')).href
  async function emit (options) {
    const grammar = parseDefinition(readFileSync(new URL('../examples/arithmetic.gram', import.meta.url), 'utf8'))
    const source = emitModule(grammar, { runtimeSpecifier: runtimeUrl, ...options })
    const file = path.join(dir, `lexer-${counter++}.mjs`)
    await writeFile(file, source)
    return { source, module: await import(pathToFileURL(file).href) }
  }

  it('writes the lexer into the file and imports only the error class from the runtime', async () => {
    const { source, module } = await emit({})
    expect(source).not.toContain('createLexer')
    expect(source).toMatch(/import \{[^}]*\bLexError\b[^}]*\} from/)
    expect(module.tokenize('1 + 2').map((x) => x.type)).toEqual(['Number', 'Plus', 'Number'])
  })

  it('throws the same LexError class the runtime exports', async () => {
    const { module } = await emit({})
    expect(() => module.tokenize('1 + ?')).toThrow(LexError)
  })

  it('keeps the engine when asked to', async () => {
    const { source, module } = await emit({ lexer: 'runtime' })
    expect(source).toContain('createLexer(tokens')
    expect(module.tokenize('1 + 2').length).toBe(3)
  })

  it('tokenizes exactly as the engine-lexer module does', async () => {
    const generated = await emit({ positions: 'full' })
    const engine = await emit({ positions: 'full', lexer: 'runtime' })
    for (const input of ['1 + 2 * (3 - 4)', '12.5/3', ' ', '', '1 +\n 2', '1 ? 2']) {
      expect(outcome(generated.module, input), input).toBe(outcome(engine.module, input))
    }
  })

  it('passes the scanners and fuse switches through', async () => {
    const off = await emit({ scanners: false, fuse: false })
    const on = await emit({})
    expect(off.source).not.toContain('function scan')
    expect(off.module.tokenize('1 + 22').map((x) => x.image)).toEqual(on.module.tokenize('1 + 22').map((x) => x.image))
    const engineOff = await emit({ lexer: 'runtime', scanners: false, fuse: false })
    expect(engineOff.source).toContain('scanners: false, fuse: false')
  })

  it('rejects an unknown lexer mode', () => {
    expect(() => emitModule({ tokens: [{ name: 'A', literal: 'a' }], rules: { s: { consume: 'A' } }, start: 's' }, { lexer: 'jit' })).toThrow(/lexer must be/)
  })
})
