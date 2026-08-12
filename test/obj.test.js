import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { createParser, createParserFromSource, emitModule, createValueMethods } from '../src/index.js'

/**
 * `obj` builds an object with computed keys.
 *
 * This exists because building a node whose *type* comes from the input is what
 * a parser action does more than anything else — `{[op]: [left, right]}` — and it
 * was the one shape JSON Logic could not express, so every grammar here had a
 * JavaScript method that did nothing else.
 *
 * The requirement that matters is the last describe block: an action using `obj`
 * has to compile to source. An operator that quietly costs a grammar its
 * engine-free build would be worse than no operator.
 */

const grammar = {
  tokens: [
    { name: 'WS', pattern: '\\s+', skip: true },
    { name: 'Int', pattern: '[0-9]+' },
    { name: 'Op', pattern: '[-+*/]' }
  ],
  rules: {
    expr: {
      infixLeft: {
        operand: { as: [{ consume: 'Int' }, { val: 'image' }] },
        operator: { consume: 'Op' },
        combine: { obj: [{ val: ['op', 'image'] }, [{ val: 'left' }, { val: 'right' }]] }
      }
    }
  },
  start: 'expr'
}

describe('building a node whose key comes from the input', () => {
  for (const execution of ['generated', 'interpreted']) {
    it(`works under execution: '${execution}'`, () => {
      const parser = createParser(grammar, { execution })
      expect(parser.parse('1 + 2')).toEqual({ '+': ['1', '2'] })
      expect(parser.parse('1 + 2 * 3')).toEqual({ '*': [{ '+': ['1', '2'] }, '3'] })
    })
  }

  it('takes flat key/value pairs, so several entries need no nesting', () => {
    const method = createValueMethods().obj.method
    expect(method(['a', 1])).toEqual({ a: 1 })
    expect(method(['a', 1, 'b', 2])).toEqual({ a: 1, b: 2 })
  })

  it('keeps values whole rather than flattening them', () => {
    const method = createValueMethods().obj.method
    expect(method(['k', [1, 2, 3]])).toEqual({ k: [1, 2, 3] })
    expect(method(['k', { nested: true }])).toEqual({ k: { nested: true } })
  })

  it('rejects an odd number of arguments', () => {
    const method = createValueMethods().obj.method
    expect(() => method(['a', 1, 'b'])).toThrow(/even number of arguments.*received 3/)
    expect(() => method([])).toThrow(/even number of arguments/)
  })

  it('is available in the definition language with no wiring', () => {
    const parser = createParserFromSource(`
      grammar Calc; start expr;
      token WS pattern "\\\\s+" skip;
      token Int pattern "[0-9]+";
      token Op pattern "[-+*/]";
      rule expr = infixLeft(
        as(consume(Int), action({"val":"image"})),
        consume(Op),
        action({"obj":[{"val":["op","image"]},[{"val":"left"},{"val":"right"}]]})
      );
    `)
    expect(parser.parse('4 - 5')).toEqual({ '-': ['4', '5'] })
  })

  it('yields to a grammar that registers its own', () => {
    const parser = createParser(
      { ...grammar, rules: { expr: { as: [{ consume: 'Int' }, { obj: [{ val: 'image' }] }] } } },
      { methods: { obj: { method: (image) => `overridden:${image}`, optimizeUnary: true } } }
    )
    expect(parser.parse('7')).toBe('overridden:7')
  })
})

describe('an action using it still compiles to source', () => {
  let dir
  let counter = 0
  const runtimeUrl = pathToFileURL(path.resolve('src/runtime.js')).href

  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'jl-grammar-obj-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  // Only `obj` and binding reads, so nothing else can be blamed for an engine.
  const plain = {
    tokens: [{ name: 'WS', pattern: '\\s+', skip: true }, { name: 'Word', pattern: '[a-z]+' }],
    rules: {
      main: {
        seq: [
          { label: ['k', { as: [{ consume: 'Word' }, { val: 'image' }] }] },
          { label: ['v', { as: [{ consume: 'Word' }, { val: 'image' }] }] },
          { action: { obj: [{ val: 'k' }, { val: 'v' }, 'fixed', 1] } }
        ]
      }
    },
    start: 'main'
  }

  it('emits an object literal, not a call into the engine', () => {
    const source = emitModule(plain)
    expect(source).toMatch(/return \(\{\[/)
    expect(source).not.toMatch(/engine\.methods\["obj"\]/)
  })

  it('leaves the generated module with no json-logic-engine dependency', () => {
    expect(emitModule(plain)).not.toMatch(/^(?:import|const) .*json-logic-engine/m)
  })

  it('the emitted module agrees with the runtime parser', async () => {
    const file = path.join(dir, `parser-${counter++}.mjs`)
    await writeFile(file, emitModule(plain, { runtimeSpecifier: runtimeUrl }))
    const module = await import(pathToFileURL(file).href)
    const reference = createParser(plain)
    for (const sample of ['a b', 'hello world', 'x y']) {
      expect(module.parse(sample), sample).toEqual(reference.parse(sample))
    }
  })

  it('and so does one built from the operator-heavy grammar', async () => {
    const file = path.join(dir, `parser-${counter++}.mjs`)
    await writeFile(file, emitModule(grammar, { runtimeSpecifier: runtimeUrl }))
    const module = await import(pathToFileURL(file).href)
    const reference = createParser(grammar)
    for (const sample of ['1 + 2', '1 + 2 * 3', '9 / 3 - 1']) {
      expect(module.parse(sample), sample).toEqual(reference.parse(sample))
    }
  })
})
