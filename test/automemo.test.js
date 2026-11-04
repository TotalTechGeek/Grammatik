import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createParser, createParserFromSource, parseDefinition, emitModule, analyze } from '../src/index.js'
import { selectMemoRules } from '../src/memoplan.js'

/**
 * `autoMemo` remembers a rule's result per position, but only for the rules where
 * an `alt` would otherwise parse the same prefix again for each colliding branch.
 * Everything here pins one of two things: it picks the right rules, and it never
 * changes what a parse means.
 */

const tokens = [
  { name: 'WS', pattern: '\\s+', skip: true },
  { name: 'Int', pattern: '[0-9]+' },
  { name: 'Plus', literal: '+' },
  { name: 'Is', literal: 'is' },
  { name: 'Eq', literal: '=' },
  { name: 'Lt', literal: '<' },
  { name: 'LP', literal: '(' },
  { name: 'RP', literal: ')' }
]

const firstsOf = (rules) => analyze(rules, { tokenNames: tokens.map((t) => t.name) }).firsts
const pick = (rules, options) => selectMemoRules(rules, firstsOf(rules), options)

// The shape that hurts: every branch of `Pred` begins by parsing an `Add`, and an
// `Add` can contain a parenthesised `Pred`.
const predicate = {
  Pred: { alt: [
    { subrule: 'Cmp' },
    { subrule: 'IsNull' },
    { subrule: 'Add' }
  ] },
  Cmp: { seq: [{ label: ['l', { subrule: 'Add' }] }, { consume: 'Eq' }, { label: ['r', { subrule: 'Add' }] }, { action: { val: 'l' } }] },
  IsNull: { seq: [{ label: ['l', { subrule: 'Add' }] }, { consume: 'Is' }, { action: { val: 'l' } }] },
  Add: { seq: [{ subrule: 'Atom' }, { many: { seq: [{ consume: 'Plus' }, { subrule: 'Atom' }] } }] },
  Atom: { alt: [{ consume: 'Int' }, { seq: [{ consume: 'LP' }, { subrule: 'Pred' }, { consume: 'RP' }] }] }
}

describe('selectMemoRules', () => {
  it('picks the topmost rule the colliding branches share, and only that', () => {
    // Add starts every branch; Atom is also reachable from all of them, but Add
    // already covers it.
    expect(pick(predicate)).toEqual(['Add'])
  })

  it('picks nothing when dispatch separates the branches', () => {
    const rules = {
      S: { alt: [{ seq: [{ consume: 'Int' }, { subrule: 'X' }] }, { seq: [{ consume: 'LP' }, { subrule: 'X' }] }] },
      X: { consume: 'Int' }
    }
    expect(pick(rules)).toEqual([])
  })

  it('picks nothing when the shared rule cannot lead back to the alt (the rework is bounded)', () => {
    // Re-parsing X once per branch costs a constant factor, not an exponent, and a
    // memo table costs more than that. This is the formula example's `Name`.
    const rules = {
      S: { alt: [{ seq: [{ subrule: 'X' }, { consume: 'Eq' }] }, { seq: [{ subrule: 'X' }, { consume: 'Lt' }] }] },
      X: { consume: 'Int' }
    }
    expect(pick(rules)).toEqual([])
  })

  it('memoizes down a chain of colliding alts, which is exponential without any cycle', () => {
    // r_i := r_{i+1} ';' | r_{i+1}: each level doubles the work below it. The last
    // shared rule is a leaf, so it is left alone.
    const rules = {}
    for (let i = 0; i < 5; i++) {
      rules['r' + i] = { alt: [{ seq: [{ subrule: 'r' + (i + 1) }, { consume: 'Eq' }] }, { subrule: 'r' + (i + 1) }] }
    }
    rules.r5 = { consume: 'Int' }
    expect(pick(rules)).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  it('picks nothing when branches start with different rules', () => {
    const rules = {
      S: { alt: [{ subrule: 'A' }, { subrule: 'B' }] },
      A: { seq: [{ consume: 'Int' }, { consume: 'Plus' }] },
      B: { seq: [{ consume: 'Int' }, { consume: 'Eq' }] }
    }
    // Both start with Int but through consume, not a shared rule.
    expect(pick(rules)).toEqual([])
  })

  it('finds the shared rule through a label and a rule boundary', () => {
    const rules = {
      S: { alt: [{ subrule: 'A' }, { subrule: 'B' }] },
      A: { seq: [{ label: ['x', { subrule: 'Shared' }] }, { consume: 'Eq' }, { action: { val: 'x' } }] },
      B: { seq: [{ label: ['x', { subrule: 'Shared' }] }, { consume: 'Lt' }, { action: { val: 'x' } }] },
      // Shared can lead back to S, so the repeated work repeats itself.
      Shared: { alt: [{ consume: 'Int' }, { seq: [{ consume: 'LP' }, { subrule: 'S' }, { consume: 'RP' }] }] }
    }
    expect(pick(rules)).toEqual(['Shared'])
  })

  it('treats every branch as colliding when ll1 is off', () => {
    const rules = {
      S: { alt: [{ seq: [{ subrule: 'X' }, { consume: 'Eq' }] }, { seq: [{ subrule: 'X' }, { consume: 'Lt' }] }] },
      X: { alt: [{ consume: 'Int' }, { seq: [{ consume: 'LP' }, { subrule: 'S' }, { consume: 'RP' }] }] }
    }
    expect(pick(rules, { ll1: false })).toEqual(['X'])
  })

  it('leaves a rule alone when anything it runs reads the caller\'s scope', () => {
    const rules = {
      S: { alt: [{ seq: [{ subrule: 'X' }, { consume: 'Eq' }] }, { seq: [{ subrule: 'X' }, { consume: 'Lt' }] }] },
      // `[[1], 'x']` hops out of this rule's own bindings.
      X: { alt: [
        { seq: [{ label: ['x', { consume: 'Int' }] }, { action: { val: [[1], 'x'] } }] },
        { seq: [{ consume: 'LP' }, { subrule: 'S' }, { consume: 'RP' }] }
      ] }
    }
    expect(pick(rules)).toEqual([])
  })

  it('returns names in declaration order', () => {
    const rules = {
      Z: { alt: [{ seq: [{ subrule: 'B' }, { consume: 'Eq' }] }, { seq: [{ subrule: 'B' }, { consume: 'Lt' }] }] },
      A: { alt: [{ seq: [{ subrule: 'C' }, { consume: 'Eq' }] }, { seq: [{ subrule: 'C' }, { consume: 'Lt' }] }] },
      B: { alt: [{ consume: 'Int' }, { seq: [{ consume: 'LP' }, { subrule: 'Z' }, { consume: 'RP' }] }] },
      C: { alt: [{ consume: 'Int' }, { seq: [{ consume: 'LP' }, { subrule: 'A' }, { consume: 'RP' }] }] }
    }
    expect(pick(rules)).toEqual(['B', 'C'])
  })
})

describe('createParser autoMemo', () => {
  const spec = { tokens, rules: predicate, start: 'Pred' }

  it('is on by default, reports what it chose, and can be turned off or superseded', () => {
    expect(createParser(spec).memoRules).toEqual(['Add'])
    expect(createParser(spec, { autoMemo: false }).memoRules).toEqual([])
    expect(createParser(spec, { memo: true }).memoRules).toEqual([])
  })

  const inputs = ['1', '1 + 2', '1 = 2', '1 is', '(1) is', '((1 + 2)) = (3)', '(((1 + (2)))) is', '1 +', '(1', '1 = ', ') 1', '1 2']
  for (const execution of ['generated', 'interpreted']) {
    it(`parses and rejects exactly what the unmemoized parser does (${execution})`, () => {
      const on = createParser(spec, { execution })
      const off = createParser(spec, { execution, autoMemo: false })
      for (const input of inputs) {
        const run = (p) => { try { return JSON.stringify(p.parse(input)) } catch (e) { return `${e.name}: ${e.message}` } }
        expect(run(on), input).toBe(run(off))
      }
    })

    it(`is not exponential in nesting depth (${execution})`, () => {
      // Without it this input costs about 6^depth rule entries; the step guard
      // would trip long before depth 30.
      const depth = 30
      const input = '('.repeat(depth) + '1 is' + ')'.repeat(depth)
      const p = createParser(spec, { execution, maxSteps: 200000 })
      expect(() => p.parse(input)).not.toThrow()
      expect(() => createParser(spec, { execution, autoMemo: false, maxSteps: 200000 }).parse(input)).toThrow(/maxSteps/)
    })
  }

  it('gives the same tree for the SQL example, with and without', () => {
    const source = readFileSync(new URL('../examples/sql.gram', import.meta.url), 'utf8')
    const on = createParserFromSource(source)
    const off = createParserFromSource(source, { autoMemo: false })
    expect(on.memoRules).toEqual(['Additive'])
    const queries = [
      'SELECT a FROM t WHERE x IS NOT NULL',
      "SELECT a FROM t WHERE name LIKE 'a%' AND b NOT BETWEEN 1 AND 9 OR c IN (1, 2, 3)",
      'SELECT a FROM t WHERE ((((x IS NULL))))',
      'SELECT u.id, COUNT(o.id) AS n FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id ORDER BY n DESC'
    ]
    for (const q of queries) expect(on.parse(q)).toEqual(off.parse(q))
    // The case this exists for: seven levels is ~250 ms unmemoized.
    const deep = 'SELECT a FROM t WHERE ' + '('.repeat(7) + 'x IS NULL' + ')'.repeat(7)
    const t = performance.now()
    on.parse(deep)
    expect(performance.now() - t).toBeLessThan(100)
  })

  it('reports the same error, at the same place, as the unmemoized parser', () => {
    const source = readFileSync(new URL('../examples/sql.gram', import.meta.url), 'utf8')
    const on = createParserFromSource(source)
    const off = createParserFromSource(source, { autoMemo: false })
    for (const q of ['SELECT a FROM t WHERE ((x IS', 'SELECT a FROM t WHERE x IS NULL )', 'SELECT FROM t', 'SELECT a FROM t WHERE (x BETWEEN 1']) {
      const message = (p) => { try { p.parse(q) } catch (e) { return [e.message, e.expected, e.ruleStack] } }
      expect(message(on), q).toEqual(message(off))
    }
  })
})

describe('emitModule autoMemo', () => {
  let dir
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'grammatik-automemo-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  const runtimeUrl = pathToFileURL(path.resolve('src/runtime.js')).href
  let counter = 0
  async function load (options) {
    const file = path.join(dir, `p-${counter++}.mjs`)
    const source = emitModule({ tokens, rules: predicate, start: 'Pred', name: 'Pred' }, { runtimeSpecifier: runtimeUrl, engineSpecifier: 'json-logic-engine', ...options })
    await writeFile(file, source)
    return { module: await import(pathToFileURL(file).href), source }
  }

  it('writes the per-rule tables into the file and behaves like the runtime parser', async () => {
    const { module, source } = await load({})
    expect(source).toContain('memoSlots: 1')
    expect(source).toContain('c.rm[0]')

    const runtime = createParser({ tokens, rules: predicate, start: 'Pred' })
    for (const input of ['1', '((1 + 2)) = (3)', '(((1 + (2)))) is', '(1', '1 +']) {
      const run = (p) => { try { return JSON.stringify(p.parse(input)) } catch (e) { return `${e.name}: ${e.message}` } }
      expect(run(module), input).toBe(run(runtime))
    }
    const deep = '('.repeat(30) + '1 is' + ')'.repeat(30)
    expect(() => module.parse(deep)).not.toThrow()
  })

  it('writes no tables when switched off', async () => {
    const { source } = await load({ autoMemo: false })
    expect(source).toContain('memoSlots: 0')
    expect(source).not.toContain('c.rm[')
  })
})
