import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createLexer } from '../src/lexer.js'
import { generateLexer } from '../src/lexgen.js'
import { LexError } from '../src/state.js'
import { parseDefinition } from '../src/index.js'

/**
 * The DFA path has to be invisible: the same tokens, and the same errors, as trying the candidates one at a time.
 * Every case here is lexed both ways and compared.
 */

const load = (name) => parseDefinition(readFileSync(new URL(`../examples/${name}.gram`, import.meta.url), 'utf8')).tokens

function prng (seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

const run = (lexer, text) => {
  try { return JSON.stringify(lexer.tokenize(text)) } catch (e) { return `${e.name}: ${e.message}` }
}

function same (tokens, fragments, { inputs = 3000, options = {} } = {}) {
  const rand = prng(0xd0f)
  for (const positions of ['full', 'offset']) {
    const on = createLexer(tokens, { positions, ...options })
    const off = createLexer(tokens, { positions, ...options, dfa: false, words: false })
    for (let n = 0; n < inputs; n++) {
      let text = ''
      for (let k = Math.floor(rand() * 9); k >= 0; k--) text += fragments[Math.floor(rand() * fragments.length)]
      expect(run(on, text), `${positions}: ${JSON.stringify(text)}`).toBe(run(off, text))
    }
  }
}

const FORMULA = ['A', 'b', 'Z', '_', '0', '9', '1', '$', '.', ',', ';', ':', '!', '"', '""', "'", "''", '#', '#N/A', '#REF!', '#NULL!', '#NAME?',
  '[', ']', '{', '}', '(', ')', '+', '-', '*', '/', '^', '&', '%', '<', '>', '=', '<=', '>=', '<>', ' ', '\t', '\n', 'e', 'E', 'TRUE', 'false',
  'True', 'tru', 'TRUEX', 'true1', 'FALSE_', 'items', 'A1', 'B$2', '$C$3', '$D4', 'AB12', 'x1y2', '1e5', '1.5', '.5', '5.', '1e', '1e+', 'é', '@', ' ']

const SQL = ['SELECT', 'select', 'Select', 'selectx', 'FROM', 'from', 'WHERE', 'AS', 'as', 'ASC', 'ass', 'IN', 'in', 'INNER', 'int', 'ıt', 'ſ', 'K', 'IS', 'is',
  'NULL', 'null', 'users', 'u', 'u.id', '_x', 'x9', '1', '2.5', "'a'", "'it''s'", "'", '-- c\n', '--', '/* c */', '/*', '*/', '<>', '<=', '>=', '!=', '<', '>', '=',
  ',', '.', ';', '(', ')', '*', '+', '-', '/', ' ', '\n', '\t', 'é', '`']

describe('the DFA path gives the same tokens as trying candidates one at a time', () => {
  it('on the formula grammar', () => same(load('formula'), FORMULA))
  it('on the SQL grammar, whose keywords carry a lookahead and ignoreCase', () => same(load('sql'), SQL))
  it('on the JSON grammar, which it leaves to its scanners', () => same(load('json'), ['{', '}', '[', ']', ',', ':', '"a"', '"\\n"', '"', '1', '-1.5e3', '0', '01', 'true', 'null', ' ', '\n', 'x']))

  it('with longerAlt, where a keyword defers to a longer identifier', () => {
    const tokens = [
      { name: 'WS', pattern: '\\s+', skip: true },
      { name: 'If', pattern: 'if', longerAlt: 'Id' },
      { name: 'Else', literal: 'else', longerAlt: 'Id' },
      { name: 'Cell', pattern: '[a-z]+[0-9]+' },
      { name: 'Id', pattern: '[a-z_][a-z0-9_]*' },
      { name: 'Num', pattern: '[0-9]+(?:\\.[0-9]+)?' }
    ]
    same(tokens, ['if', 'iff', 'else', 'elsewhere', 'a1', 'a1b', 'x', '_', '12', '1.5', ' ', 'ifa1', 'if1'])
  })

  it('across lexer modes', () => {
    const tokens = [
      { name: 'Text', pattern: '(?:[^{]|\\{(?!\\{))+', mode: 'default' },
      { name: 'Open', literal: '{{', mode: 'default', pushMode: 'expression' },
      { name: 'Close', literal: '}}', mode: 'expression', popMode: true },
      { name: 'WS', pattern: '[ \\t]+', mode: 'expression', skip: true },
      { name: 'Cell', pattern: '[A-Za-z]+[0-9]+', mode: 'expression' },
      { name: 'Name', pattern: '[A-Za-z_][A-Za-z0-9_.]*', mode: 'expression' },
      { name: 'Num', pattern: '[0-9]+(?:\\.[0-9]+)?', mode: 'expression' },
      { name: 'Str', pattern: '"(?:[^"\\\\]|\\\\.)*"', mode: 'expression' }
    ]
    same(tokens, ['hi ', '{', '{{', '}}', ' ', 'A1', 'name.x', 'b2c', '12', '1.5', '"s"', '"', 'é', '\n', '}'])
  })

  it('when a pattern is not deterministic its own matcher decides the end', () => {
    const tokens = [
      { name: 'Str', pattern: '"(?:""|[^"])*"' },
      { name: 'Err', pattern: '#(?:NULL!|NUM!|N/A)' },
      { name: 'Ab', pattern: 'a|ab' },
      { name: 'Word', pattern: '[a-z]+' },
      { name: 'WS', pattern: ' +', skip: true }
    ]
    same(tokens, ['"', '""', 'a', 'ab', 'abc', '#NULL!', '#NUM!', '#N/A', '#N', ' ', 'b', '"x"', '"x""y"', 'é'])
  })

  it('falls back to the members one after another when a DFA would need too many states', () => {
    // "an a, then 12 more letters" needs 2^12 states to remember which of the last 12 were a's.
    const blowup = '(?:a|b)*a' + '(?:a|b)'.repeat(12)
    const tokens = [
      { name: 'Blow', pattern: blowup },
      { name: 'Word', pattern: '[a-z]+' },
      { name: 'WS', pattern: ' +', skip: true }
    ]
    same(tokens, ['a', 'b', 'ab', 'aaaaaaaaaaaaa', 'baaaaaaaaaaaab', 'abababababababab', 'c', ' ', 'abc'], { inputs: 600 })
  })

  describe('keyword groups', () => {
    const word = (name, w, extra = {}) => ({ name, pattern: `${w}(?![A-Za-z0-9_])`, ...extra })
    const ID = { name: 'Id', pattern: '[A-Za-z_][A-Za-z0-9_]*' }
    const WS = { name: 'WS', pattern: '\\s+', skip: true }
    const FRAG = ['if', 'IF', 'If', 'iF', 'else', 'ELSE', 'elsewhere', 'iff', 'i', 'ifx', 'if1', 'if_', 'if$', 'ifé', 'éif', 'a', 'a1', 'A1', 'a_b', '_', '_if', 'in', 'int', 'ıf', 'ſ', 'K', ' ', '\n', '-', '1', '12', 'iff-if', 'if.if']

    it('with ignoreCase keywords and an identifier', () => {
      same([WS, word('If', 'if', { ignoreCase: true }), word('Else', 'else', { ignoreCase: true }), word('In', 'in', { ignoreCase: true }), word('Int', 'int', { ignoreCase: true }), ID], FRAG)
    })

    it('with case-sensitive keywords', () => {
      same([WS, word('If', 'if'), word('Else', 'else'), word('In', 'in'), ID], FRAG)
    })

    it('with a repeated keyword, where the first declaration wins', () => {
      same([WS, word('First', 'if'), word('Second', 'if'), word('SecondCaseless', 'IF', { ignoreCase: true }), ID], FRAG)
    })

    it('with keywords that digits and underscores can follow or be part of', () => {
      same([WS, word('A1', 'a1'), word('Ab', 'a_b'), word('U', '_'), ID], FRAG)
    })

    it('with a keyword that has a longerAlt of its own', () => {
      same([WS, word('If', 'if', { longerAlt: 'Id' }), word('Else', 'else'), ID], FRAG)
    })

    it('with another token between the keywords and the identifier', () => {
      same([WS, word('If', 'if'), { name: 'Hash', pattern: 'i[0-9]' }, ID], FRAG)
    })

    it('with a keyword before the identifier in the other order, where the identifier wins outright', () => {
      same([WS, ID, word('If', 'if'), word('Else', 'else')], FRAG)
    })

    it('declines a lookahead that is not the identifier\'s own class, and still lexes the same', () => {
      // `if$` matches the keyword (the `$` is not in its lookahead) but the identifier run would swallow it.
      same([WS, word('If', 'if'), { name: 'Id', pattern: '[A-Za-z_$][A-Za-z0-9_$]*' }], FRAG)
      same([WS, { name: 'If', pattern: 'if(?![A-Za-z_])' }, ID], FRAG)
    })

    it('declines keywords whose characters the identifier cannot contain', () => {
      same([WS, word('If', 'if'), word('Dig', '9x'), { name: 'Id', pattern: '[a-z_][a-z0-9_]*' }], FRAG)
    })

    describe('when the identifier can go on, or start, where the keywords\' lookahead class does not', () => {
      const keywords = (look, extra = {}) => ['if', 'else', 'in', 'int', 'select'].map((w) => ({ name: w, pattern: `${w}(?!${look})`, ...extra }))
      const FRAGMENTS = ['if', 'IF', 'else', 'in', 'int', 'select', 'if$', 'if$x', '$if', 'in$', 'int$', 'if-', 'if-x', 'x-if', 'if_x', 'if1', 'if1$', 'a$b', '$', '$$', '-', '@if', 'if@', ' ', '\n', 'é', 'ifé', 'a', 'A1', '_']
      const checkBoth = (tokens, expectGroups) => {
        same(tokens, FRAGMENTS, { inputs: 3000 })
        const rand = prng(0xe17d)
        for (const positions of ['full', 'offset']) {
          const generated = new Function('tokens', 'LexError', `return ${generateLexer(tokens, { positions })}`)(tokens, LexError) // eslint-disable-line no-new-func
          const plain = createLexer(tokens, { positions, dfa: false, words: false })
          for (let n = 0; n < 3000; n++) {
            let text = ''
            for (let k = Math.floor(rand() * 8); k >= 0; k--) text += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]
            expect(run(generated, text), `${positions}: ${JSON.stringify(text)}`).toBe(run(plain, text))
          }
        }
        expect(/function word\d+ \(/.test(generateLexer(tokens, { positions: 'offset' }))).toBe(expectGroups)
      }

      it('an identifier that may contain $ (the keywords stop at it, the identifier goes on)', () => {
        checkBoth([{ name: 'WS', pattern: '\\s+', skip: true }, ...keywords('[A-Za-z0-9_]', { ignoreCase: true }), { name: 'Id', pattern: '[A-Za-z_][A-Za-z0-9_$]*' }], true)
      })

      it('an identifier that may contain a hyphen, and keywords without ignoreCase', () => {
        checkBoth([{ name: 'WS', pattern: '\\s+', skip: true }, ...keywords('[a-z0-9_]'), { name: 'Id', pattern: '[a-z_][a-z0-9_-]*' }], true)
      })

      it('an identifier that may start with something the lookahead class lacks', () => {
        // Still lexes the same. (A keyword group only ever sees a first character that can start a keyword, so the group never
        // has to start an identifier from nothing; the code that would is there for correctness, not reachable through this.)
        checkBoth([{ name: 'WS', pattern: '\\s+', skip: true }, ...keywords('[A-Za-z0-9]'), { name: 'Id', pattern: '[$@A-Za-z][A-Za-z0-9]*' }], true)
      })

      it('both at once', () => {
        checkBoth([{ name: 'WS', pattern: '\\s+', skip: true }, ...keywords('[A-Za-z0-9_]'), { name: 'Id', pattern: '[$@A-Za-z_][A-Za-z0-9_$-]*' }], true)
      })

      it('is declined when the lookahead class is not within the identifier\'s', () => {
        // The run of lookahead characters could leave the identifier's, so its end would depend on more than the run.
        checkBoth([{ name: 'WS', pattern: '\\s+', skip: true }, ...keywords('[A-Za-z0-9_$]'), { name: 'Id', pattern: '[A-Za-z_][A-Za-z0-9_]*' }], false)
      })

      it('is declined when keywords that compete for a first letter do not share a lookahead class', () => {
        checkBoth([{ name: 'WS', pattern: '\\s+', skip: true }, { name: 'If', pattern: 'if(?![A-Za-z0-9_])' }, { name: 'In', pattern: 'in(?![A-Za-z_])' }, { name: 'Id', pattern: '[A-Za-z_][A-Za-z0-9_$]*' }], false)
      })
    })

    it('actually replaces the candidate-by-candidate path: no regex calls and no repeated scans', () => {
      const tokens = load('sql')
      const lexer = createLexer(tokens, { positions: 'offset' })
      const exec = vi.spyOn(RegExp.prototype, 'exec')
      const test = vi.spyOn(RegExp.prototype, 'test')
      try {
        const types = lexer.tokenize('select users from orders where x in (1)').map((t) => t.type)
        expect(types).toEqual(['Select', 'Identifier', 'From', 'Identifier', 'Where', 'Identifier', 'In', 'LParen', 'Number', 'RParen'])
        expect(exec.mock.calls.length + test.mock.calls.length).toBe(0)
      } finally {
        exec.mockRestore()
        test.mockRestore()
      }
    })
  })

  it('with the incremental scanner', () => {
    const on = createLexer(load('formula'), { positions: 'offset', incremental: true })
    const off = createLexer(load('formula'), { positions: 'offset', incremental: true, dfa: false, words: false })
    const text = 'IF(A1>=10,SUM(B1:B5),ABS(items[0].total)) + $B$2 & "x""y"'
    expect(JSON.stringify(on.tokenizeIncremental(text).tokens)).toBe(JSON.stringify(off.tokenizeIncremental(text).tokens))
  })

  it('actually uses the DFA where tokens share a first character', () => {
    // Guards against the whole thing silently falling back to the old path: the old path calls the regex engine
    // for each of these, the DFA path for none of them.
    const calls = (options) => {
      const lexer = createLexer(load('formula'), { positions: 'offset', ...options })
      const exec = vi.spyOn(RegExp.prototype, 'exec')
      const test = vi.spyOn(RegExp.prototype, 'test')
      try {
        expect(lexer.tokenize('items A1 $B$2 12.5').map((t) => t.type)).toEqual(['Identifier', 'Cell', 'AnchoredCell', 'Number'])
        return exec.mock.calls.length + test.mock.calls.length
      } finally {
        exec.mockRestore()
        test.mockRestore()
      }
    }
    expect(calls({ dfa: false, words: false })).toBeGreaterThan(0)
    expect(calls({})).toBe(0)
  })
})

// Tokens written with every kind of assertion: a lookbehind and ^ for the start of a line, bounded lookaheads (positive,
// negative, two characters long) and $ for the end of the text, over \\s.
const MARKUP = [
  { name: 'Heading', pattern: '(?:(?<=\\n)|^)#+(?=[ \\t])' },
  { name: 'Bullet', pattern: '(?<=\\n)[-*](?=\\s)' },
  { name: 'Quote', pattern: '(?<![A-Za-z0-9])>' },
  { name: 'Frac', pattern: '[0-9]+\\.[0-9]+(?![0-9])' },
  { name: 'Int', pattern: '[0-9]+(?!\\.[0-9])' },
  { name: 'Word', pattern: '[A-Za-z]+(?![A-Za-z0-9_])' },
  { name: 'Close', pattern: '(?:~\\}\\}[\\s]*|\\}\\}[ \\t]*(?:\\r?\\n|$))' },
  { name: 'Final', pattern: '\\.(?=$)' },
  { name: 'Dot', literal: '.' },
  { name: 'Hash', literal: '#' },
  { name: 'Dash', literal: '-' },
  { name: 'Star', literal: '*' },
  { name: 'Gt', literal: '>' },
  { name: 'Brace', literal: '}' },
  { name: 'Tilde', literal: '~' },
  { name: 'Blank', pattern: '[ \\t\\r\\n\\u00a0]+', skip: true },
  { name: 'Other', pattern: '[^\\s]' }
]
const MARKUP_FRAGMENTS = ['#', '##', '# ', '#\t', '#x', '- ', '* ', '-', '*', '-x', '>', 'a>', '1>', ' >', 'word', 'Word2', 'a_b', '12', '1.5', '1.', '.5', '1.5.', '.', '..', '}}', '~}}', '} }', '}}\n', '}} \n', '}}  ', '~}} \n ', '\n', '\r\n', ' ', '\t', '\u00a0', 'é', '$', ';']

describe('assertions in the DFA path', () => {
  it('gives the same tokens as trying candidates one at a time, on the runtime lexer', () => same(MARKUP, MARKUP_FRAGMENTS, { inputs: 4000 }))

  it('gives the same tokens from the generated lexer', () => {
    const rand = prng(0xa55e)
    for (const positions of ['full', 'offset']) {
      const generated = new Function('tokens', 'LexError', `return ${generateLexer(MARKUP, { positions })}`)(MARKUP, LexError) // eslint-disable-line no-new-func
      const plain = createLexer(MARKUP, { positions, dfa: false, words: false })
      for (let n = 0; n < 4000; n++) {
        let text = ''
        for (let k = Math.floor(rand() * 9); k >= 0; k--) text += MARKUP_FRAGMENTS[Math.floor(rand() * MARKUP_FRAGMENTS.length)]
        expect(run(generated, text), `${positions}: ${JSON.stringify(text)}`).toBe(run(plain, text))
      }
    }
  })

  it('over long runs, where a state that loops on itself is walked without stopping at each character', () => {
    const long = ['a'.repeat(60), 'Ab1'.repeat(25), '1'.repeat(40), '12.5'.repeat(15), ' '.repeat(30), '\n'.repeat(5), '#'.repeat(20), '}'.repeat(9), '\u00a0'.repeat(7), 'é'.repeat(5), 'x'.repeat(35) + '.', '- ' + 'w'.repeat(45)]
    same(MARKUP, [...MARKUP_FRAGMENTS, ...long], { inputs: 3000 })
    same(load('formula'), [...FORMULA, 'items'.repeat(20), 'A1'.repeat(25), '"' + 'q'.repeat(50) + '"', '1'.repeat(40), 'a_b'.repeat(25), '$A$1$A$1'.repeat(5)], { inputs: 3000 })
    same(load('sql'), [...SQL, 'users'.repeat(15), 'SELECT'.repeat(8), "'" + 'x'.repeat(50) + "'", '1'.repeat(40), '_'.repeat(30)], { inputs: 3000 })
    const rand = prng(0x10c)
    for (const positions of ['full', 'offset']) {
      const generated = new Function('tokens', 'LexError', `return ${generateLexer(MARKUP, { positions })}`)(MARKUP, LexError) // eslint-disable-line no-new-func
      const plain = createLexer(MARKUP, { positions, dfa: false, words: false })
      for (let n = 0; n < 2000; n++) {
        const pieces = [...MARKUP_FRAGMENTS, ...long]
        let text = ''
        for (let k = Math.floor(rand() * 8); k >= 0; k--) text += pieces[Math.floor(rand() * pieces.length)]
        expect(run(generated, text), `${positions}: ${JSON.stringify(text)}`).toBe(run(plain, text))
      }
    }
  })

  it('reads the character before a token, wherever the token starts', () => {
    const lexer = createLexer(MARKUP, { positions: 'offset' })
    const types = (text) => lexer.tokenize(text).map((t) => t.type)
    expect(types('# a')).toEqual(['Heading', 'Word'])
    expect(types('x # a')).toEqual(['Word', 'Hash', 'Word'])
    expect(types('x\n# a')).toEqual(['Word', 'Heading', 'Word'])
    expect(types('a>')).toEqual(['Word', 'Gt'])
    expect(types(' >')).toEqual(['Quote'])
    expect(types('1.5')).toEqual(['Frac'])
    expect(types('1.')).toEqual(['Int', 'Final'])
    expect(types('1. x')).toEqual(['Int', 'Dot', 'Word'])
  })

  it('settles `$` and a pending lookahead at the end of the text', () => {
    const lexer = createLexer(MARKUP, { positions: 'offset' })
    const types = (text) => lexer.tokenize(text).map((t) => t.type)
    expect(types('a.')).toEqual(['Word', 'Final'])
    expect(types('a.b')).toEqual(['Word', 'Dot', 'Word'])
    expect(types('a}}')).toEqual(['Word', 'Close'])
    expect(types('a}}x')).toEqual(['Word', 'Brace', 'Brace', 'Word'])
    expect(types('a}} \nb')).toEqual(['Word', 'Close', 'Word'])
  })

  it('across lexer modes, in a template grammar with the same kinds of pattern', () => {
    const modes = ['expression', 'blockExpression']
    const inModes = (extra) => ({ mode: undefined, modes, ...extra })
    const tokens = [
      { name: 'OpenBlock', pattern: '(?:\\s*\\{\\{~#|\\{\\{#)', mode: 'default', pushMode: 'blockExpression' },
      { name: 'OpenEnd', pattern: '(?:\\s*\\{\\{~/|\\{\\{/)', mode: 'default', pushMode: 'expression' },
      { name: 'OpenElse', pattern: '(?:\\s*\\{\\{~(?:else|\\^)|\\{\\{(?:else|\\^))(?=[\\s}~])', mode: 'default', pushMode: 'expression' },
      { name: 'Open', pattern: '(?:\\s*\\{\\{~|\\{\\{)', mode: 'default', pushMode: 'expression' },
      { name: 'Text', pattern: '(?:[^\\\\{\\s]|\\{(?!\\{)|\\s(?!\\s*\\{\\{~))+', mode: 'default' },
      { name: 'Blank', pattern: '\\s+', mode: 'default' },
      { name: 'Ws', pattern: '[ \\t\\r\\n]+', skip: true, ...inModes() },
      { name: 'Str', pattern: '"[^"]*"|\'[^\']*\'', ...inModes() },
      { name: 'CloseBlock', pattern: '(?:~\\}\\}[\\s]*|\\}\\})', mode: 'blockExpression', popMode: true },
      { name: 'Close', pattern: '(?:~\\}\\}[\\s]*|\\}\\})', mode: 'expression', popMode: true },
      { name: 'Bool', pattern: 'true|false', ...inModes(), longerAlt: 'Name' },
      { name: 'Num', pattern: '[0-9]+', ...inModes(), longerAlt: 'Name' },
      { name: 'Name', pattern: '(?:(?!~?\\}\\})[^\\s|=()])+', ...inModes() }
    ]
    const frag = ['{{', '}}', '{{#', '{{/', '{{~', '~}}', '{{else', '{{^', '{{~else', ' ', '\n', '  ', 'if', 'true', 'trueish', '12', '12a', 'x.y', '"s"', "'t'", '"', '{', '}', 'é', '\u00a0', '=', '(', ')', '|']
    same(tokens, frag, { inputs: 4000 })
  })

  it('actually walks the automaton where assertions used to force the regex engine', () => {
    const calls = (options) => {
      const lexer = createLexer(MARKUP, { positions: 'offset', ...options })
      const exec = vi.spyOn(RegExp.prototype, 'exec')
      const test = vi.spyOn(RegExp.prototype, 'test')
      try {
        lexer.tokenize('# title\n- item 12 and 1.5 }}')
        return exec.mock.calls.length + test.mock.calls.length
      } finally {
        exec.mockRestore()
        test.mockRestore()
      }
    }
    expect(calls({ dfa: false, words: false })).toBeGreaterThan(5)
    expect(calls({})).toBeLessThan(calls({ dfa: false, words: false }))
  })
})

// The openers of a template language that must sit alone on their line, as a real grammar writes them: a lookbehind, `^`, a
// bounded lookahead, and an unbounded one that checks the rest of the line. The last is out of the automaton's reach, so these
// are filtered by it instead: the automaton says which may match, and each of those is asked for real.
const STANDALONE_OPENERS = [
  { name: 'OpenBlockStandalone', pattern: '(?:\\s*\\{\\{~#|(?:(?<=\\n)|^)[ \\t]*\\{\\{#)(?=(?:(?!\\}\\})[^\\r\\n])*~?\\}\\}[ \\t]*(?:\\r?\\n|$))', mode: 'default', pushMode: 'blockStandalone' },
  { name: 'OpenEndStandalone', pattern: '(?:\\s*\\{\\{~/|(?:(?<=\\n)|^)[ \\t]*\\{\\{/)(?=(?:(?!\\}\\})[^\\r\\n])*~?\\}\\}[ \\t]*(?:\\r?\\n|$))', mode: 'default', pushMode: 'standalone' },
  { name: 'OpenElseIfStandalone', pattern: '(?:\\s*\\{\\{~else[ \\t]+if|(?:(?<=\\n)|^)[ \\t]*\\{\\{else[ \\t]+if)(?=(?:(?!\\}\\})[^\\r\\n])*~?\\}\\}[ \\t]*(?:\\r?\\n|$))', mode: 'default', pushMode: 'standalone' },
  { name: 'OpenElseStandalone', pattern: '(?:\\s*\\{\\{~(?:else|\\^)|(?:(?<=\\n)|^)[ \\t]*\\{\\{(?:else|\\^))(?=[\\s}~])(?=(?:(?!\\}\\})[^\\r\\n])*~?\\}\\}[ \\t]*(?:\\r?\\n|$))', mode: 'default', pushMode: 'standalone' },
  { name: 'OpenBlock', pattern: '(?:\\s*\\{\\{~#|\\{\\{#)', mode: 'default', pushMode: 'block' },
  { name: 'OpenEnd', pattern: '(?:\\s*\\{\\{~/|\\{\\{/)', mode: 'default', pushMode: 'expression' },
  { name: 'OpenElseIf', pattern: '(?:\\s*\\{\\{~else|\\{\\{else)[ \\t\\r\\n]+if(?=[\\s(}])', mode: 'default', pushMode: 'expression' },
  { name: 'OpenElse', pattern: '(?:\\s*\\{\\{~(?:else|\\^)|\\{\\{(?:else|\\^))(?=[\\s}~])', mode: 'default', pushMode: 'expression' },
  { name: 'Open', pattern: '(?:\\s*\\{\\{~|\\{\\{)', mode: 'default', pushMode: 'expression' },
  { name: 'Text', pattern: '(?:[^\\\\{\\s]|\\{(?!\\{)|\\s(?!\\s*\\{\\{~))+', mode: 'default' },
  { name: 'Blank', pattern: '\\s+', mode: 'default' },
  ...['expression', 'block', 'standalone', 'blockStandalone'].flatMap((mode) => [
    { name: `Ws_${mode}`, pattern: '[ \\t\\r\\n]+', mode, skip: true },
    { name: `Name_${mode}`, pattern: '[^\\s|=(){}~]+', mode },
    { name: `Close_${mode}`, pattern: mode.endsWith('tandalone') ? '(?:~\\}\\}[\\s]*|\\}\\}[ \\t]*(?:\\r?\\n|$))' : '(?:~\\}\\}[\\s]*|\\}\\})', mode, popMode: true }
  ])
]
const TEMPLATE_PIECES = ['{{#if x}}', '{{#each items}}', '{{/if}}', '{{/each}}', '{{else}}', '{{^}}', '{{else if y}}', '{{~#if x~}}', '{{~else~}}', '{{name}}', '{{ a.b }}', 'text', ' ', '  ', '\n', '\n  ', '\r\n', '}}', '~}}', '{{#', '{{', '{', '}', 'é', ' ', 'x }}', '{{#if x}} tail', 'a {{#if x}}\n', '\n{{/if}} ', '{{else}} y', '{{#each i}}\n  ']

describe('filter groups: patterns the automaton can only over-approximate', () => {
  it('give the same tokens as asking each pattern in turn, on the runtime lexer', () => same(STANDALONE_OPENERS, TEMPLATE_PIECES, { inputs: 4000 }))

  it('give the same tokens from the generated lexer', () => {
    const rand = prng(0xf1171e)
    for (const positions of ['full', 'offset']) {
      const generated = new Function('tokens', 'LexError', `return ${generateLexer(STANDALONE_OPENERS, { positions })}`)(STANDALONE_OPENERS, LexError) // eslint-disable-line no-new-func
      const plain = createLexer(STANDALONE_OPENERS, { positions, dfa: false, words: false })
      for (let n = 0; n < 4000; n++) {
        let text = ''
        for (let k = Math.floor(rand() * 10); k >= 0; k--) text += TEMPLATE_PIECES[Math.floor(rand() * TEMPLATE_PIECES.length)]
        expect(run(generated, text), `${positions}: ${JSON.stringify(text)}`).toBe(run(plain, text))
      }
    }
  })

  it('ask each pattern that might match in turn: a later one wins when an earlier one fails', () => {
    // Without its lookahead each of these is just `a`, so the automaton lets both through; only asking tells them apart.
    const tokens = [
      { name: 'NeedsC', pattern: 'a(?=b+c)' },
      { name: 'NeedsD', pattern: 'a(?=b+d)' },
      { name: 'NeedsE', pattern: 'a(?=b+e)' },
      { name: 'B', pattern: 'b+' },
      { name: 'Rest', pattern: '[cde]' }
    ]
    const pieces = ['a', 'ab', 'abb', 'abbc', 'abbd', 'abbe', 'abe', 'b', 'bd', 'c', 'd', 'e', 'ad', 'abx']
    same(tokens, pieces, { inputs: 2000 })
    for (const positions of ['full', 'offset']) {
      const generated = new Function('tokens', 'LexError', `return ${generateLexer(tokens, { positions })}`)(tokens, LexError) // eslint-disable-line no-new-func
      const plain = createLexer(tokens, { positions, dfa: false, words: false })
      for (const text of ['abbd', 'abbe', 'abbc', 'abbdabbeabbc', 'aabbd']) expect(run(generated, text), `${positions}: ${text}`).toBe(run(plain, text))
      expect(generated.tokenize('abbe').map((t) => t.type)).toEqual(['NeedsE', 'B', 'Rest'])
    }
    expect(createLexer(tokens, { positions: 'offset' }).tokenize('abbd').map((t) => t.type)).toEqual(['NeedsD', 'B', 'Rest'])
  })

  it('rule out the openers that cannot match, and ask only the ones that might', () => {
    const calls = (options) => {
      const lexer = createLexer(STANDALONE_OPENERS, { positions: 'offset', ...options })
      const exec = vi.spyOn(RegExp.prototype, 'exec')
      const test = vi.spyOn(RegExp.prototype, 'test')
      try {
        lexer.tokenize('{{name}} and {{other}} and {{third}}\n{{#if x}}\nbody\n{{/if}}\n')
        return exec.mock.calls.length + test.mock.calls.length
      } finally {
        exec.mockRestore()
        test.mockRestore()
      }
    }
    expect(calls({ dfa: false, words: false })).toBeGreaterThan(calls({}))
  })

  it('stop walking once they have found they rule out too little', () => {
    // A filter that lets nearly everything through is a walk wasted before every regex. After 64 calls the group looks at its own
    // record and, if it kept more than 70%, stops asking the automaton and goes back to asking each pattern.
    const tokens = [
      { name: 'Anything', pattern: '(?:[^\\s]|\\s(?!\\s*\\{\\{~))+(?=(?:[^\\n])*\\n?)' },
      { name: 'Blank', pattern: '\\s+' }
    ]
    const lexer = createLexer(tokens, { positions: 'offset' })
    const plain = createLexer(tokens, { positions: 'offset', dfa: false, words: false })
    const text = Array.from({ length: 300 }, (_, i) => `word${i} `).join('')
    expect(JSON.stringify(lexer.tokenize(text))).toBe(JSON.stringify(plain.tokenize(text)))
  })
})

describe('a generated lexer with DFA groups gives the same tokens as the plain runtime lexer', () => {
  const generate = (tokens, options) => new Function('tokens', 'LexError', `return ${generateLexer(tokens, options)}`)(tokens, LexError) // eslint-disable-line no-new-func

  function sameGenerated (tokens, fragments, inputs = 3000) {
    const rand = prng(0x6e17)
    for (const positions of ['full', 'offset']) {
      const generated = generate(tokens, { positions })
      const plain = createLexer(tokens, { positions, dfa: false, words: false })
      for (let n = 0; n < inputs; n++) {
        let text = ''
        for (let k = Math.floor(rand() * 9); k >= 0; k--) text += fragments[Math.floor(rand() * fragments.length)]
        expect(run(generated, text), `${positions}: ${JSON.stringify(text)}`).toBe(run(plain, text))
      }
    }
  }

  it('on the formula grammar', () => sameGenerated(load('formula'), FORMULA))
  it('on the SQL grammar', () => sameGenerated(load('sql'), SQL))
  it('with keyword groups: case, repeats, lookahead classes the identifier lacks, and a keyword that has a longerAlt', () => {
    const word = (name, w, extra = {}) => ({ name, pattern: `${w}(?![A-Za-z0-9_])`, ...extra })
    const ID = { name: 'Id', pattern: '[A-Za-z_][A-Za-z0-9_]*' }
    const WS = { name: 'WS', pattern: '\\s+', skip: true }
    const FRAG = ['if', 'IF', 'If', 'else', 'elsewhere', 'iff', 'i', 'ifx', 'if1', 'if_', 'if$', 'ifé', 'a', 'a1', 'A1', 'a_b', '_', 'in', 'int', 'ıf', ' ', '\n', '1', 'iff-if']
    sameGenerated([WS, word('If', 'if', { ignoreCase: true }), word('Else', 'else', { ignoreCase: true }), word('In', 'in', { ignoreCase: true }), ID], FRAG)
    sameGenerated([WS, word('If', 'if'), word('Else', 'else'), word('In', 'in'), ID], FRAG)
    sameGenerated([WS, word('First', 'if'), word('Second', 'if'), word('A1', 'a1'), ID], FRAG)
    sameGenerated([WS, word('If', 'if', { longerAlt: 'Id' }), word('Else', 'else'), ID], FRAG)
    sameGenerated([WS, word('If', 'if'), { name: 'Id', pattern: '[A-Za-z_$][A-Za-z0-9_$]*' }], FRAG)
  })
  it('with longerAlt and modes', () => {
    sameGenerated([
      { name: 'WS', pattern: '[ \\t]+', mode: 'expression', skip: true },
      { name: 'Text', pattern: '(?:[^{]|\\{(?!\\{))+', mode: 'default' },
      { name: 'Open', literal: '{{', mode: 'default', pushMode: 'expression' },
      { name: 'Close', literal: '}}', mode: 'expression', popMode: true },
      { name: 'If', pattern: 'if', mode: 'expression', longerAlt: 'Name' },
      { name: 'Cell', pattern: '[A-Za-z]+[0-9]+', mode: 'expression' },
      { name: 'Name', pattern: '[A-Za-z_][A-Za-z0-9_.]*', mode: 'expression' },
      { name: 'Num', pattern: '[0-9]+(?:\\.[0-9]+)?', mode: 'expression' }
    ], ['hi ', '{', '{{', '}}', ' ', 'if', 'iffy', 'A1', 'a.b', '12', '1.5', 'é', '\n', '}'])
  })
})
