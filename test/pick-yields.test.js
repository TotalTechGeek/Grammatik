import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

import { createParser, createParserFromSource, parseDefinition, analyze } from '../src/index.js'
import { recognizeSeqIdiom } from '../src/analyze.js'

/**
 * `pick` and `yields` are what a `seq` with a single labelled result, or a
 * constant action, is rewritten into. They have to mean exactly what the `seq`
 * spelling meant — values, failures, rollback, dispatch, rule stack — while
 * skipping the bindings object, so every claim here is checked against it.
 */

const tokens = [
  { name: 'WS', pattern: '\\s+', skip: true },
  { name: 'Int', pattern: '[0-9]+' },
  { name: 'Where', literal: 'where' },
  { name: 'Asc', literal: 'asc' },
  { name: 'Desc', literal: 'desc' },
  { name: 'True', literal: 'true' },
  { name: 'Null', literal: 'null' },
  { name: 'Comma', literal: ',' },
  { name: 'LP', literal: '(' },
  { name: 'RP', literal: ')' }
]

const A = (name) => ({ consume: name })
const item = { as: [A('Int'), { '+': [{ val: 'image' }, 0] }] }
const modes = ['generated', 'interpreted']

/** The same grammar twice: written with the new ops, and with the seq they replace. */
function both (build) {
  return { fast: build(true), plain: build(false) }
}

const outcome = (parser, input) => {
  try { return JSON.stringify(parser.parse(input)) } catch (e) { return `${e.name}: ${e.message} | ${JSON.stringify(e.ruleStack)}` }
}

describe('pick', () => {
  const rules = (fast) => ({
    Clause: fast
      ? { pick: { parsers: [A('Where'), { subrule: 'Item' }], index: 1 } }
      : { seq: [A('Where'), { label: ['e', { subrule: 'Item' }] }, { action: { val: 'e' } }] },
    Item: item,
    Top: { seq: [{ option: { subrule: 'Clause' } }, { many: { pick: { parsers: [A('Comma'), { subrule: 'Item' }], index: 1 } } }, { action: { val: [] } }] }
  })

  for (const execution of modes) {
    it(`yields the picked parser's value (${execution})`, () => {
      const p = createParser({ tokens, rules: rules(true), start: 'Clause' }, { execution })
      expect(p.parse('where 41')).toBe(41)
    })

    it(`parses and fails like the seq it replaces (${execution})`, () => {
      const { fast, plain } = both((f) => createParser({ tokens, rules: rules(f), start: 'Top' }, { execution }))
      for (const input of ['where 1', 'where 1 , 2 , 3', '', 'where', 'where ,', '1', ', 1', 'where 1 ,', 'where 1 , , 2']) {
        expect(outcome(fast, input), input).toBe(outcome(plain, input))
      }
    })
  }

  it('lets an enclosing alt retry from the original position after a late failure', () => {
    const rules2 = {
      // pick consumes `(` then an Int, then fails on the missing `)`; the alt must then
      // try the second branch from the original position.
      Top: { alt: [
        { pick: { parsers: [A('LP'), A('Int'), A('RP')], index: 1 } },
        { seq: [A('LP'), A('Int'), A('Comma'), { action: 'second' }] }
      ] }
    }
    for (const execution of modes) {
      const p = createParser({ tokens, rules: rules2, start: 'Top' }, { execution })
      expect(p.parse('(7)').image).toBe('7')
      expect(p.parse('(7,')).toBe('second')
    }
  })

  it('dispatches on its first parser, like the seq it replaces', () => {
    const { fast } = both((f) => createParser({ tokens, rules: rules(f), start: 'Top' }))
    const firsts = fast.analysis.firsts
    expect([...firsts.get('Clause').tokens]).toEqual(['Where'])
  })
})

describe('yields', () => {
  const rules = (fast) => ({
    Dir: { alt: [
      fast ? { yields: { parsers: [A('Asc')], value: 'ASC' } } : { seq: [A('Asc'), { action: 'ASC' }] },
      fast ? { yields: { parsers: [A('Desc')], value: 'DESC' } } : { seq: [A('Desc'), { action: 'DESC' }] },
      fast ? { yields: { parsers: [A('True')], value: true } } : { seq: [A('True'), { action: true }] },
      fast ? { yields: { parsers: [A('Null')], value: null } } : { seq: [A('Null'), { action: null }] },
      fast ? { yields: { parsers: [A('Where'), A('Int')], value: 0 } } : { seq: [A('Where'), A('Int'), { action: 0 }] }
    ] },
    Top: { many: { subrule: 'Dir' } }
  })

  for (const execution of modes) {
    it(`gives back its constant, including falsy ones (${execution})`, () => {
      const { fast, plain } = both((f) => createParser({ tokens, rules: rules(f), start: 'Top' }, { execution }))
      for (const input of ['asc', 'desc', 'true', 'null', 'where 5', 'asc desc true null where 1', 'asc bogus', 'where', '']) {
        expect(outcome(fast, input), input).toBe(outcome(plain, input))
      }
      expect(fast.parse('asc desc true null where 1')).toEqual(['ASC', 'DESC', true, null, 0])
    })
  }

  it('falls back to a shorter alternative after consuming part of a longer one', () => {
    const p = createParser({
      tokens,
      rules: { Top: { alt: [{ yields: { parsers: [A('Where'), A('Int')], value: 'long' } }, { yields: { parsers: [A('Where')], value: 'short' } }] } },
      start: 'Top'
    })
    expect(p.parse('where 3')).toBe('long')
    expect(p.parse('where')).toBe('short')
  })
})

describe('validation', () => {
  const problems = (rules) => analyze(rules, { tokenNames: tokens.map((t) => t.name) }).errors
  const one = (node) => problems({ Top: node })

  it('accepts well-formed nodes', () => {
    expect(one({ pick: { parsers: [A('Int')], index: 0 } })).toEqual([])
    expect(one({ yields: { parsers: [A('Int')], value: 'x' } })).toEqual([])
  })

  it('rejects an index outside the parsers', () => {
    expect(one({ pick: { parsers: [A('Int')], index: 1 } })[0]).toMatch(/index 1 is out of range/)
    expect(one({ pick: { parsers: [A('Int')], index: -1 } })[0]).toMatch(/out of range/)
    expect(one({ pick: { parsers: [A('Int')], index: 'x' } })[0]).toMatch(/out of range/)
  })

  it('rejects empty or missing parsers', () => {
    expect(one({ pick: { parsers: [], index: 0 } })[0]).toMatch(/expects/)
    expect(one({ yields: { parsers: [], value: 1 } })[0]).toMatch(/expects/)
    expect(one({ yields: { value: 1 } })[0]).toMatch(/expects/)
  })

  it('rejects a value that could be shared between parses', () => {
    expect(one({ yields: { parsers: [A('Int')], value: [1] } })[0]).toMatch(/string, number, boolean or null/)
    expect(one({ yields: { parsers: [A('Int')], value: { a: 1 } } })[0]).toMatch(/string, number, boolean or null/)
  })

  it('validates the parsers inside', () => {
    expect(one({ pick: { parsers: [A('Nope')], index: 0 } })[0]).toMatch(/unknown token 'Nope'/)
    expect(one({ yields: { parsers: [{ subrule: 'Missing' }], value: 1 } })[0]).toMatch(/unknown rule 'Missing'/)
  })

  it('detects left recursion through them', () => {
    const errors = problems({ Top: { pick: { parsers: [{ subrule: 'Top' }, A('Int')], index: 1 } } })
    expect(errors.join('\n')).toMatch(/left-recursive/)
  })
})

describe('the definition language', () => {
  const source = (body) => `
    grammar T; start main;
    token A literal "a"; token B literal "b"; token C literal "c";
    rule main = ${body};
  `

  it('builds them from pick(index, ...) and yields(..., value)', () => {
    expect(parseDefinition(source('pick(1, consume(A), consume(B), consume(C))')).rules.main).toEqual({
      pick: { parsers: [{ consume: 'A' }, { consume: 'B' }, { consume: 'C' }], index: 1 }
    })
    expect(parseDefinition(source('yields(consume(A), consume(B), "done")')).rules.main).toEqual({
      yields: { parsers: [{ consume: 'A' }, { consume: 'B' }], value: 'done' }
    })
    expect(parseDefinition(source('yields(consume(A), null)')).rules.main).toEqual({ yields: { parsers: [{ consume: 'A' }], value: null } })
    expect(parseDefinition(source('yields(consume(A), false)')).rules.main).toEqual({ yields: { parsers: [{ consume: 'A' }], value: false } })
  })

  it('runs them', () => {
    const parser = createParserFromSource(source('seq(yields(consume(A), 7), pick(0, consume(B)), action({"val":[]}))'))
    expect(parser).toBeTruthy()
    const direct = createParserFromSource(source('pick(1, consume(A), consume(B), consume(C))'))
    expect(direct.parse('abc').image).toBe('b')
    expect(createParserFromSource(source('yields(consume(A), consume(B), "done")')).parse('ab')).toBe('done')
  })

  it('rejects a call with too few arguments', () => {
    expect(() => parseDefinition(source('pick(1)'))).toThrow(/pick expects/)
    expect(() => parseDefinition(source('yields(true)'))).toThrow(/yields expects/)
  })
})

describe('real grammars use them, and behave exactly as before', () => {
  const read = (name) => readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8')

  const walk = (node, visit) => {
    if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
    if (!node || typeof node !== 'object') return
    visit(node)
    for (const value of Object.values(node)) walk(value, visit)
  }
  const rewrites = (file) => {
    const found = { pick: 0, yields: 0 }
    walk(parseDefinition(read(file), { execution: 'interpreted' }).rules, (node) => {
      const idiom = Array.isArray(node.seq) ? recognizeSeqIdiom(node.seq) : null
      if (idiom && idiom.pick) found.pick++
      if (idiom && idiom.yields) found.yields++
    })
    return found
  }

  it('finds them in the grammars that are written with the long spelling', () => {
    // Counts, not just "some": a recogniser that silently stopped matching would
    // leave every behavioural test below comparing a grammar with itself.
    expect(rewrites('sql.gram')).toEqual({ pick: 10, yields: 10 })
    expect(rewrites('formula.gram')).toEqual({ pick: 6, yields: 0 })
    expect(rewrites('json.gram')).toEqual({ pick: 0, yields: 3 })
  })

  const compare = (file, inputs, options = {}) => {
    for (const execution of modes) {
      const parser = createParserFromSource(read(file), { execution, ...options })
      // The seq spelling, by switching the rewrite off at its source.
      const plain = createParserFromSource(read(file), { execution, ...options, idioms: false })
      for (const input of inputs) expect(outcome(parser, input), `${file} ${execution}: ${input}`).toBe(outcome(plain, input))
    }
  }

  it('parses and rejects sql identically', () => {
    compare('sql.gram', [
      'SELECT a FROM t WHERE x = 1 ORDER BY a DESC LIMIT 5 OFFSET 2',
      'SELECT a, b FROM t LEFT OUTER JOIN u ON t.id = u.id WHERE x IS NOT NULL',
      "SELECT CASE WHEN a THEN 1 ELSE 2 END FROM t GROUP BY a HAVING COUNT(*) > 1",
      'INSERT INTO t (a, b) VALUES (1, 2), (3, 4)',
      'UPDATE t SET a = 1 WHERE b = 2', 'DELETE FROM t WHERE a = 1',
      'SELECT a FROM t WHERE', 'SELECT FROM t', 'SELECT a FROM t ORDER BY', 'SELECT a FROM t LIMIT'
    ])
  })

  it('parses and rejects formulas identically', () => {
    compare('formula.gram', [
      '1 + 2 * 3', '-A1^2 + 5% * (B2 - 3)', 'IF(A1>=10,SUM(B1:B5),ABS(C1)) & "x"', 'items[*].price * 2', "'Quarter 1'!$B$2 + MAX({1,2;3,4})",
      '1 +', '(1', 'IF(', '{1,2;', 'a[', "'x'!"
    ])
  })

  it('parses and rejects json identically', () => {
    const grammar = parseDefinition(read('json.gram'), { execution: 'interpreted' })
    const methods = { unquote: { method: (s) => s.slice(1, -1), optimizeUnary: true }, num: { method: (s) => Number(s), optimizeUnary: true }, fromPairs: { method: (p) => Object.fromEntries(p), optimizeUnary: true } }
    for (const execution of modes) {
      const on = createParser(grammar, { execution, methods })
      const off = createParser(grammar, { execution, methods, idioms: false })
      for (const input of ['[true, false, null]', '{"a": [1, 2.5, "x"], "b": null}', '[true,', '{"a" true}', 'nul', '']) {
        expect(outcome(on, input), `${execution}: ${input}`).toBe(outcome(off, input))
      }
    }
  })

  it('changes the generated code, so the comparisons above compare two different programs', () => {
    const bindingObjects = (options) => {
      const parser = createParserFromSource(read('sql.gram'), options)
      let count = 0
      for (const name of parser.codegen.ruleIndex.keys()) count += (parser.codegen.sourceFor(name).match(/= \{\};/g) || []).length
      return count
    }
    expect(bindingObjects({ idioms: true })).toBeLessThan(bindingObjects({ idioms: false }))
  })
})
