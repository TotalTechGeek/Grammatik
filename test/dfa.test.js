import { describe, it, expect } from 'vitest'
import { parsePattern, parseToken, parseRelaxed, isDeterministic, buildDfa, walkDfa, symbolOf, SYM, NAWS, OTHER } from '../src/dfa.js'

function prng (seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

const parse = (source, ignoreCase = false) => parsePattern(source, ignoreCase)

describe('the alphabet', () => {
  it('has a symbol for non-ASCII whitespace, apart from every other non-ASCII character', () => {
    expect(symbolOf(65)).toBe(65)
    expect(symbolOf(0x00e9)).toBe(OTHER)
    expect(symbolOf(0x00a0)).toBe(NAWS)
    for (const c of [0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) expect(symbolOf(c), c.toString(16)).toBe(NAWS)
    for (const c of [0x200b, 0x2060, 0x180e, 0x0085]) expect(symbolOf(c), c.toString(16)).toBe(OTHER)
  })

  it('agrees with the regex engine about which non-ASCII characters are whitespace', () => {
    for (let c = 128; c < 0x10000; c++) {
      if (/\s/.test(String.fromCharCode(c)) !== (symbolOf(c) === NAWS)) throw new Error(`\\u${c.toString(16)} disagrees`)
    }
  })
})

describe('parsePattern', () => {
  it.each([
    ['a dot', 'a.b'],
    ['a bounded repeat', 'a{2,3}'],
    ['a lazy quantifier', 'a+?'],
    ['a doubled quantifier', 'a++'],
    ['a backreference', '(a)\\1'],
    ['a capture group', '(ab)+'],
    ['a named group', '(?<name>a)'],
    ['a non-ASCII literal', 'é+'],
    ['a non-ASCII class member', '[aé]'],
    ['an unterminated class', '[ab'],
    ['an empty class', '[]'],
    ['a stray close', 'a)'],
    ['a letter escape', '\\bfoo'],
    ['an unbounded lookahead', 'a(?=b+)'],
    ['a lookahead with a star', 'a(?!b*c)'],
    ['a lookahead too long to track', 'a(?!bcdefghij)'],
    ['a lookahead inside a lookahead', 'a(?=(?!b))'],
    ['a lookbehind inside a lookahead', 'a(?=(?<=b))'],
    ['a lookbehind after something was consumed', 'a(?<=a)b'],
    ['a lookbehind inside a loop', '(?:(?<=a)b)+'],
    ['a ^ after something was consumed', 'a^b'],
    ['a lookbehind of more than one character', '(?<=ab)c'],
    ['a lookbehind of a loop', '(?<=a+)c'],
    ['a quantified lookahead', 'a(?=b)*'],
    ['a quantified ^', '^*a'],
    ['a loop around nothing but an assertion', '(?:(?=a))*b']
  ])('declines %s', (_, source) => {
    expect(parse(source)).toBeNull()
  })

  it('accepts the shapes real grammars use', () => {
    for (const source of [
      '[A-Za-z_][A-Za-z0-9_]*', '\\d+(?:\\.\\d+)?', '(?:\\$[A-Za-z]+\\$?[0-9]+|[A-Za-z]+\\$[0-9]+)',
      '"(?:""|[^"])*"', "'(?:''|[^'])*'", '#(?:NULL!|DIV/0!|N/A)', '[ \\t\\r\\n]+', '0[xX][0-9a-fA-F]+', '--[^\\n]*',
      'SELECT(?![A-Za-z0-9_])', 'if(?=[\\s(}])', '(?:(?!~?\\}\\})[^\\s|=()])+', '(?:~\\}\\}[\\s]*|\\}\\}[ \\t]*(?:\\r?\\n|$))',
      '(?:(?<=\\n)|^)[ \\t]*\\{\\{#', '(?<![a-z])x+', '(?<=\\n)x', '^x', 'a$', '(?:\\s*\\{\\{~|\\{\\{)', '[^\\s|.\\[\\]]+', '\\S+', '\\W\\D'
    ]) expect(parse(source), source).not.toBeNull()
  })

  it('treats \\s as the regex engine does, ASCII and non-ASCII', () => {
    const t = parse('\\s')
    const s = t.xs[0].s
    for (const c of [9, 10, 11, 12, 13, 32]) expect(s[c], String(c)).toBe(1)
    expect(s[NAWS]).toBe(1)
    expect(s[65]).toBe(0)
    expect(s[OTHER]).toBe(0)
    const notSpace = parse('[^\\s]').xs[0].s
    expect(notSpace[NAWS]).toBe(0)
    expect(notSpace[OTHER]).toBe(1)
    expect(notSpace[65]).toBe(1)
  })

  it('folds ASCII letters under ignoreCase and nothing else', () => {
    const t = parse('k[^s]', true)
    const [k, notS] = t.xs.map((x) => x.s)
    expect(k['k'.charCodeAt(0)] && k['K'.charCodeAt(0)]).toBe(1)
    expect(notS['s'.charCodeAt(0)] || notS['S'.charCodeAt(0)]).toBe(0)
    expect(notS['x'.charCodeAt(0)]).toBe(1)
    // The Kelvin sign and the long s are not ASCII letters' case variants in a non-unicode ignoreCase regex.
    expect(k[OTHER]).toBe(0)
  })
})

describe('parseToken', () => {
  it('reads a pattern into a tree, and declines what it cannot', () => {
    expect(parseToken('SELECT(?![A-Za-z0-9_])', true).tree).toBeTruthy()
    expect(parseToken('a.b', false)).toBeNull()
  })
})

describe('parseRelaxed', () => {
  it('parses what the exact parse declines, by leaving out the assertions it cannot model', () => {
    for (const source of [
      'a(?=b+)c', 'a(?!b*c)', 'a(?!bcdefghij)', 'a(?=(?!b))c', 'a(?<=a)b', '(?:(?<=a)b)+', 'a^b', '(?<=ab)c', '(?<=a+)c', 'a(?=b)*c',
      '(?:\\s*\\{\\{~#|(?:(?<=\\n)|^)[ \\t]*\\{\\{#)(?=(?:(?!\\}\\})[^\\r\\n])*~?\\}\\}[ \\t]*(?:\\r?\\n|$))'
    ]) {
      expect(parsePattern(source), `exact: ${source}`).toBeNull()
      expect(parseRelaxed(source, false), `relaxed: ${source}`).not.toBeNull()
    }
  })

  it('still declines what it would have to consume differently', () => {
    for (const source of ['a.b', 'a{2,3}', 'a+?', '(a)\\1', '[aé]', '(?<name>a)', 'a(?=b']) expect(parseRelaxed(source, false), source).toBeNull()
  })

  it('keeps an assertion it can model, so the filter rules out as much as it can', () => {
    const dfa = buildDfa([parseRelaxed('ab(?!c)(?=d+)', false)])
    expect(walkDfa(dfa, 'abc', 0)[0]).toBe(-1) // the (?!c) is modelled, so this is ruled out
    expect(walkDfa(dfa, 'abx', 0)[0]).toBe(2) // the unbounded (?=d+) is not: it only widens
  })

  it('never rules out a text the pattern matches', () => {
    // The whole point: whatever the pattern matches, the relaxed automaton must find possible.
    const rand = prng(0xf117)
    const pick = (xs) => xs[Math.floor(rand() * xs.length)]
    const assertion = () => pick(['(?=b+)', '(?!a*c)', '(?=(?!b))', '(?<=a)', '(?<=ab)', '(?<![a-c])', '(?=\\s*x)', '(?!(?:ab)+)', '(?=[ab]{2})', '(?<=\\n)', '^'])
    let relaxedOnly = 0
    let checked = 0
    for (let n = 0; n < 4000; n++) {
      const parts = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => (rand() < 0.35 ? assertion() : pick(['a', 'b', 'c', '[ab]', '[^a]', '\\s', 'x', '\\n']) + pick(['', '', '+', '*', '?'])))
      const source = parts.join('')
      const tree = parseRelaxed(source, false)
      if (tree === null) continue
      if (parsePattern(source) === null) relaxedOnly++
      const dfa = buildDfa([tree])
      if (dfa === null) continue
      const re = new RegExp(source, 'y')
      for (let k = 0; k < 20; k++) {
        let text = ''
        for (let j = Math.floor(rand() * 8); j > 0; j--) text += pick(['a', 'b', 'c', 'x', '\n', ' ', 'ab', 'é'])
        const offset = text.length === 0 ? 0 : Math.floor(rand() * text.length)
        re.lastIndex = offset
        const m = re.exec(text)
        checked++
        if (m !== null && m[0].length > 0) expect({ source, text, offset, possible: walkDfa(dfa, text, offset)[0] > offset }).toEqual({ source, text, offset, possible: true })
      }
    }
    expect(relaxedOnly).toBeGreaterThan(800)
    expect(checked).toBeGreaterThan(50000)
  }, 120000)
})

describe('isDeterministic', () => {
  it.each([
    ['an identifier', '[A-Za-z_][A-Za-z0-9_]*', true],
    ['a cell reference', '[A-Za-z]+[0-9]+', true],
    ['an alternation with distinct first characters', '(?:\\$[A-Za-z]+\\$?[0-9]+|[A-Za-z]+\\$[0-9]+)', true],
    ['a decimal', '\\d+(?:\\.\\d+)?', true],
    ['alternatives sharing a first character', 'a|ab', false],
    ['an overlap between a loop and what follows', 'a*a', false],
    ['an empty alternative', '(?:|a)', false],
    ['a loop over something nullable', '(?:a?)*', false],
    ['a doubled quote against its closing quote', '"(?:""|[^"])*"', false],
    ['keywords with a common first letter', '#(?:NULL!|NUM!)', false],
    ['a keyword with a trailing lookahead', 'SELECT(?![A-Za-z0-9_])', true],
    ['a loop with a lookahead in every iteration', '(?:(?!~?\\}\\})[^\\s|=()])+', true],
    ['an alternation of nothing but start conditions', '(?:(?<=\\n)|^)[ \\t]*x', true],
    ['an alternation that can be empty and is not only a condition', '(?:(?<=\\n)|x?)y', false]
  ])('%s', (_, source, expected) => {
    expect(isDeterministic(parse(source))).toBe(expected)
  })
})

// ---- random patterns ----

const ALPHABET = ['a', 'b', 'c', '0', '1', '$', '.', '\n', ' ', '\t', ' ', 'é', '}', '~', 'x']

function randomPattern (rand, depth) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)]
  const body = () => {
    const parts = Array.from({ length: 1 + Math.floor(rand() * 2) }, () => pick(['a', 'b', '[ab]', '[^a]', '\\s', '\\S', '\\d', '\\}', '~', 'x']) + pick(['', '', '?']))
    if (rand() < 0.15) parts.push('$') // an anchor takes no quantifier
    return parts.join('')
  }
  const lookahead = () => `(?${pick(['=', '!', '!'])}${rand() < 0.3 ? `${body()}|${body()}` : body()})`
  const atom = () => {
    const r = rand()
    if (r < 0.3) return pick(['a', 'b', 'c', '0', '1', '\\$', '\\.', 'x', '\\}', '~'])
    if (r < 0.55) return pick(['[ab]', '[a-c]', '[^a]', '[0-9]', '[^\\s]', '\\d', '\\w', '\\s', '\\S', '[\\s}]', '[^\\s|}]'])
    if (depth > 0 && r < 0.75) return '(?:' + randomPattern(rand, depth - 1) + ')'
    return pick(['a', 'b', '[ab]'])
  }
  const piece = () => {
    if (rand() < 0.14) return lookahead()
    if (rand() < 0.04) return '$'
    return atom() + pick(['', '', '', '+', '*', '?'])
  }
  const branch = () => {
    const guard = depth === 2 && rand() < 0.35 ? pick(['(?<=\\n)', '(?<![a-c])', '^', '(?:(?<=\\n)|^)', '(?<!\\s)', '(?<=[ab\\n])', '(?<!^)']) : ''
    return guard + Array.from({ length: 1 + Math.floor(rand() * 3) }, piece).join('')
  }
  const n = 1 + (rand() < 0.35 ? Math.floor(rand() * 3) : 0)
  return Array.from({ length: n }, branch).join('|')
}

describe('the DFA agrees with the regex it stands in for', () => {
  it('on whether anything matches, and on where when the pattern can end in only one place', () => {
    const rand = prng(0xdfa)
    let exactCount = 0
    let withAssertions = 0
    let checked = 0
    for (let n = 0; n < 6000; n++) {
      const ignoreCase = rand() < 0.2
      const source = randomPattern(rand, 2)
      const tree = parse(source, ignoreCase)
      if (tree === null) continue // a generated shape the module declines (a lookbehind that is not first, say)
      if (/\(\?[=!<]|\^|\$/.test(source)) withAssertions++
      const dfa = buildDfa([tree])
      if (dfa === null) continue
      const exact = isDeterministic(tree) || dfa.prefixFree[0] === 1
      if (exact) exactCount++
      const re = new RegExp(source, ignoreCase ? 'iy' : 'y')
      for (let k = 0; k < 25; k++) {
        let text = ''
        for (let j = Math.floor(rand() * 8); j > 0; j--) text += ALPHABET[Math.floor(rand() * ALPHABET.length)]
        const offset = text.length === 0 ? 0 : Math.floor(rand() * text.length)
        re.lastIndex = offset
        const m = re.exec(text)
        const regexLength = m === null ? 0 : m[0].length
        const found = walkDfa(dfa, text, offset)[0]
        const ctx = { source, ignoreCase, text, offset }
        checked++
        // A non-empty regex match means the language has a non-empty valid end, and the other way round.
        if (regexLength > 0) expect({ ...ctx, any: found > 0 }).toEqual({ ...ctx, any: true })
        if (found > 0) expect({ ...ctx, matched: m !== null }).toEqual({ ...ctx, matched: true })
        if (exact) expect({ ...ctx, length: found > 0 ? found - offset : 0 }).toEqual({ ...ctx, length: regexLength })
      }
    }
    // Guards against a generator or a check that quietly stops testing anything.
    expect(exactCount).toBeGreaterThan(1500)
    expect(withAssertions).toBeGreaterThan(1500)
    expect(checked).toBeGreaterThan(100000)
  }, 120000)

  it('takes the context of a lookbehind from the character before the match, and `^` only at the start of the text', () => {
    const dfa = buildDfa([parse('(?:(?<=\\n)|^)ab')])
    const end = (text, offset) => walkDfa(dfa, text, offset)[0]
    expect(end('ab', 0)).toBe(2)
    expect(end('x\nab', 2)).toBe(4)
    expect(end('xab', 1)).toBe(-1)
    expect(end('\nab', 1)).toBe(3)
    const not = buildDfa([parse('(?<!\\n)ab')])
    expect(walkDfa(not, 'ab', 0)[0]).toBe(2) // nothing before it is not a newline
    expect(walkDfa(not, '\nab', 1)[0]).toBe(-1)
    expect(walkDfa(not, 'xab', 1)[0]).toBe(3)
  })

  it('reports a match that ended before its lookahead resolved', () => {
    const dfa = buildDfa([parse('ab(?!c)')])
    expect(walkDfa(dfa, 'abd', 0)[0]).toBe(2)
    expect(walkDfa(dfa, 'abc', 0)[0]).toBe(-1)
    expect(walkDfa(dfa, 'ab', 0)[0]).toBe(2) // the text ended: nothing can match, so the negative lookahead holds
    const positive = buildDfa([parse('ab(?=cd)')])
    expect(walkDfa(positive, 'abcd', 0)[0]).toBe(2)
    expect(walkDfa(positive, 'abcx', 0)[0]).toBe(-1)
    expect(walkDfa(positive, 'abc', 0)[0]).toBe(-1) // the text ended first: a positive lookahead has failed
    const eos = buildDfa([parse('ab(?=$)')])
    expect(walkDfa(eos, 'ab', 0)[0]).toBe(2)
    expect(walkDfa(eos, 'abc', 0)[0]).toBe(-1)
  })

  it('applies a lookahead at every iteration of a loop', () => {
    const dfa = buildDfa([parse('(?:(?!~?\\}\\})[^\\s|=()])+')])
    const length = (text) => Math.max(0, walkDfa(dfa, text, 0)[0])
    expect(length('name}}')).toBe(4)
    expect(length('name~}}')).toBe(4)
    expect(length('na}me}}')).toBe(5) // a lone } is fine; the } before the second one is where it must stop
    expect(length('}}')).toBe(0)
    expect(length('a b')).toBe(1)
  })

  it('knows when a pattern can end in only one place', () => {
    const flags = (sources) => Array.from(buildDfa(sources.map((s) => parse(s))).prefixFree)
    // A fixed set of strings, none a prefix of another: one possible end.
    expect(flags(['#(?:NULL!|NUM!|N/A)'])).toEqual([1])
    expect(flags(['SELECT(?![A-Za-z0-9_])'])).toEqual([1])
    // A doubled quote makes "a" a prefix of "a""b": two possible ends.
    expect(flags(['"(?:""|[^"])*"'])).toEqual([0])
    expect(flags(['a|ab', 'x'])).toEqual([0, 1])
  })

  it('picks the first token in order, and ends it at its own last valid end', () => {
    // Cell and Identifier compete; "A1B" is Cell "A1" then Identifier "B", not one Identifier.
    const dfa = buildDfa(['[A-Za-z]+[0-9]+', '[A-Za-z_][A-Za-z0-9_]*'].map((s) => parse(s)))
    const first = (text) => {
      const ends = walkDfa(dfa, text, 0)
      const winner = ends.findIndex((e) => e !== -1)
      return { winner, end: winner === -1 ? 0 : ends[winner] }
    }
    expect(first('A1B')).toEqual({ winner: 0, end: 2 })
    expect(first('items')).toEqual({ winner: 1, end: 5 })
    expect(first('A1')).toEqual({ winner: 0, end: 2 })
    expect(first('1A')).toEqual({ winner: -1, end: 0 })
  })

  it('gives up on a group that would need too many states', () => {
    // Remembering which of 12 positions held an 'a' needs 2^12 states.
    const tree = parse('(?:a|b)*a' + '(?:a|b)'.repeat(12))
    expect(buildDfa([tree])).toBeNull()
  })

  it('declines nothing by accident: every symbol class is handled', () => {
    expect(SYM).toBe(131)
  })
})
