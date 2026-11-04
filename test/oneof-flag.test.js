import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

import { createParser, createParserFromSource, parseDefinition, analyze } from '../src/index.js'
import { recognizeAltConsumeIdiom } from '../src/analyze.js'

const modes = ['generated', 'interpreted']
const outcome = (parser, input) => {
  try { return JSON.stringify(parser.parse(input)) } catch (e) { return `${e.name}: ${e.message} | ${JSON.stringify(e.expected)}` }
}

describe('recognizeAltConsumeIdiom', () => {
  const c = (name) => ({ consume: name })

  it('rewrites an alt of bare consumes into oneOf, keeping the order', () => {
    expect(recognizeAltConsumeIdiom([c('Plus'), c('Minus'), c('Star')])).toEqual({ oneOf: ['Plus', 'Minus', 'Star'] })
    expect(recognizeAltConsumeIdiom([c('A'), { consume: ['B'] }])).toEqual({ oneOf: ['A', 'B'] })
  })

  it('declines anything that is not purely consumes', () => {
    expect(recognizeAltConsumeIdiom([c('A'), { subrule: 'X' }])).toBeNull()
    expect(recognizeAltConsumeIdiom([c('A'), { seq: [c('B')] }])).toBeNull()
    expect(recognizeAltConsumeIdiom([c('A'), { consume: ['B', 'alias'] }])).toBeNull()
    expect(recognizeAltConsumeIdiom([c('A'), { consume: 7 }])).toBeNull()
  })

  it('declines a single branch', () => {
    expect(recognizeAltConsumeIdiom([c('A')])).toBeNull()
    expect(recognizeAltConsumeIdiom([])).toBeNull()
    expect(recognizeAltConsumeIdiom(null)).toBeNull()
  })
})

// More names than the generated oneOf switches at, and fewer.
const names = (count) => Array.from({ length: count }, (_, i) => 'T' + i)
const lexemes = (count) => names(count).map((name, i) => ({ name, literal: String.fromCharCode(97 + i) }))
const tokensFor = (count) => [{ name: 'WS', pattern: '\\s+', skip: true }, ...lexemes(count), { name: 'Int', pattern: '[0-9]+' }]

describe('alt of consumes and oneOf agree', () => {
  for (const count of [2, 3, 7, 12, 13, 20]) {
    for (const execution of modes) {
      it(`${count} names (${execution})`, () => {
        const members = names(count)
        const build = (op, options) => createParser({
          tokens: tokensFor(count),
          rules: { Top: { many: { seq: [{ subrule: 'Op' }, { consume: 'Int' }, { action: { val: [] } }] } }, Op: op },
          start: 'Top'
        }, { execution, ...options })

        const written = build({ alt: members.map((m) => ({ consume: m })) }, { idioms: false })
        const rewritten = build({ alt: members.map((m) => ({ consume: m })) })
        const explicit = build({ oneOf: members }, { idioms: false })

        const all = members.map((_, i) => String.fromCharCode(97 + i) + ' 1').join(' ')
        const inputs = [all, 'a 1', 'a', '1', 'a 1 a', '', ...members.map((_, i) => String.fromCharCode(97 + i) + ' 1 ?'), String.fromCharCode(97 + count) + ' 1']
        for (const input of inputs) {
          const want = outcome(written, input)
          expect(outcome(rewritten, input), `rewritten: ${input}`).toBe(want)
          expect(outcome(explicit, input), `explicit: ${input}`).toBe(want)
        }
      })
    }
  }

  it('matches a token that was built by hand, with no id', () => {
    for (const count of [3, 20]) {
      for (const execution of modes) {
        const members = names(count)
        const parser = createParser({ tokens: tokensFor(count), rules: { Top: { oneOf: members } }, start: 'Top' }, { execution })
        const handBuilt = (type) => [{ type, image: 'x', start: 0, end: 1, line: 1, col: 1 }]
        expect(parser.parseTokens(handBuilt('T' + (count - 1)), 'x').type).toBe('T' + (count - 1))
        expect(() => parser.parseTokens(handBuilt('Int'), 'x')).toThrow(/Expecting/)
      }
    }
  })

  it('lists the same expected tokens when it fails', () => {
    const members = names(20)
    const build = (options) => createParser({ tokens: tokensFor(20), rules: { Top: { alt: members.map((m) => ({ consume: m })) } }, start: 'Top' }, options)
    const grab = (parser) => { try { parser.parse('1') } catch (e) { return e.expected } }
    expect(grab(build({}))).toEqual(grab(build({ idioms: false })))
    expect(grab(build({}))).toHaveLength(20)
  })

  it('changes the generated code, so the comparisons compare two different programs', () => {
    const rules = { Top: { alt: names(3).map((m) => ({ consume: m })) } }
    const on = createParser({ tokens: tokensFor(3), rules, start: 'Top' })
    const off = createParser({ tokens: tokensFor(3), rules, start: 'Top' }, { idioms: false })
    expect(on.codegen.sourceFor('Top')).not.toContain('switch')
    expect(off.codegen.sourceFor('Top')).toContain('switch')
  })

  it('uses a switch for a large set, and a chain of comparisons for a small one', () => {
    const source = (count) => createParser({ tokens: tokensFor(count), rules: { Top: { oneOf: names(count) } }, start: 'Top' }).codegen.sourceFor('Top')
    expect(source(5)).not.toContain('switch')
    expect(source(20)).toContain('switch')
  })

  it('applies to the real grammars without changing what they accept', () => {
    const read = (file) => readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8')
    const cases = {
      'sql.gram': ['SELECT a FROM t WHERE a <> 1 AND b >= 2 OR c != 3 AND d < 4', 'SELECT a FROM t WHERE a ~ 1', 'SELECT a + b - c * d / e FROM t'],
      'formula.gram': ['1 <= 2', '1 <> 2', '1 >= 2', '1 + 2 - 3 * 4 / 5', '1 ?? 2', '1 <']
    }
    for (const [file, inputs] of Object.entries(cases)) {
      for (const execution of modes) {
        const on = createParserFromSource(read(file), { execution })
        const off = createParserFromSource(read(file), { execution, idioms: false })
        for (const input of inputs) expect(outcome(on, input), `${file} ${execution}: ${input}`).toBe(outcome(off, input))
      }
    }
  })
})

describe('flag', () => {
  const tokens = [
    { name: 'WS', pattern: '\\s+', skip: true },
    { name: 'Id', pattern: '[a-z]+' },
    { name: 'Not', literal: 'NOT' },
    { name: 'Is', literal: 'IS' },
    { name: 'Semi', literal: ';' }
  ]
  const A = (name) => ({ consume: name })

  for (const execution of modes) {
    it(`is true when its parser matched and false when it did not (${execution})`, () => {
      const p = createParser({
        tokens,
        rules: { Top: { seq: [A('Id'), A('Is'), { label: ['n', { flag: A('Not') }] }, A('Id'), { action: { obj: ['negated', { val: 'n' }] } }] } },
        start: 'Top'
      }, { execution })
      expect(p.parse('a IS b')).toEqual({ negated: false })
      expect(p.parse('a IS NOT b')).toEqual({ negated: true })
    })

    it(`never fails, and leaves the cursor where it was when it does not match (${execution})`, () => {
      const p = createParser({
        tokens,
        // `Not Is` must be tried as a unit: flag(seq(Not, Is)) fails after consuming Not.
        rules: { Top: { seq: [{ label: ['f', { flag: { seq: [A('Not'), A('Is')] } }] }, A('Not'), A('Id'), { action: { val: 'f' } }] } },
        start: 'Top'
      }, { execution })
      expect(p.parse('NOT x')).toBe(false)
      expect(p.parse('NOT IS NOT x')).toBe(true)
    })

    it(`agrees with option and a null test, which is what it replaces (${execution})`, () => {
      const make = (flagged) => createParser({
        tokens,
        rules: { Top: { many: { subrule: 'P' } }, P: { seq: [
          { label: ['l', A('Id')] }, A('Is'),
          { label: ['n', flagged ? { flag: A('Not') } : { option: A('Not') }] },
          { label: ['r', A('Id')] }, A('Semi'),
          { action: { obj: ['negated', flagged ? { val: 'n' } : { '!==': [{ val: 'n' }, null] }, 'l', { val: ['l', 'image'] }, 'r', { val: ['r', 'image'] }] } }
        ] } },
        start: 'Top'
      }, { execution })
      const flagged = make(true)
      const written = make(false)
      for (const input of ['a IS b;', 'a IS NOT b;', 'a IS b; c IS NOT d;', 'a IS NOT;', 'a IS b', '']) {
        expect(outcome(flagged, input), input).toBe(outcome(written, input))
      }
    })
  }

  it('is optional for dispatch: nullable, with its parser\'s first token', () => {
    const rules = { Top: { seq: [{ flag: A('Not') }, A('Id'), { action: { val: [] } }] } }
    const { firsts, errors } = analyze(rules, { tokenNames: tokens.map((t) => t.name) })
    expect(errors).toEqual([])
    const flagFirst = firsts.get('Top')
    expect([...flagFirst.tokens].sort()).toEqual(['Id', 'Not'])
  })

  it('validates its parser', () => {
    const { errors } = analyze({ Top: { flag: { consume: 'Nope' } } }, { tokenNames: tokens.map((t) => t.name) })
    expect(errors[0]).toMatch(/unknown token 'Nope'/)
  })

  it('is written flag(p) in the definition language', () => {
    const grammar = parseDefinition('grammar T; start main; token A literal "a"; rule main = flag(consume(A));')
    expect(grammar.rules.main).toEqual({ flag: { consume: 'A' } })
    expect(createParserFromSource('grammar T; start main; token A literal "a"; rule main = flag(consume(A));').parse('a')).toBe(true)
  })

  it('is not rewritten to from option, because that would change the action too', () => {
    // Documented in the README: `flag` is something you write, not something found.
    const rules = { Top: { seq: [{ label: ['n', { option: A('Not') }] }, A('Id'), { action: { '!==': [{ val: 'n' }, null] } }] } }
    const p = createParser({ tokens, rules, start: 'Top' })
    expect(p.codegen.sourceFor('Top')).not.toContain('= false')
  })
})
