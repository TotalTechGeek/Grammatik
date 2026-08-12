import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { emitModule, createParser, parseDefinition } from '../src/index.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'
import { grammar as formulaGrammar, createFormulaMethods } from '../examples/formula.js'
import calcGrammar from '../examples/calc.js'

/**
 * A generated module has to behave exactly like the parser `createParser` builds
 * from the same grammar — same values, same errors — while importing none of the
 * analyzer, planner or code generator.
 */

let dir
let counter = 0

/** Writes emitted source to disk and imports it, so this really is a module. */
async function load (grammar, options = {}, methods) {
  const file = path.join(dir, `parser-${counter++}.mjs`)
  const source = emitModule(grammar, {
    // Supplying the methods lets the emitter compile actions that call them.
    methods, ...options, runtimeSpecifier: runtimeUrl, engineSpecifier: 'json-logic-engine'
  })
  await writeFile(file, source)
  const module = await import(pathToFileURL(file).href)
  if (methods) module.registerMethods(methods)
  return { module, source }
}

const runtimeUrl = pathToFileURL(path.resolve('src/runtime.js')).href

/**
 * Same as `load`, for CommonJS. The published package resolves
 * `grammatik/runtime` to a CommonJS build; here that build is made on the spot,
 * so the emitted file is required exactly the way a consumer's would be.
 */
async function loadCjs (grammar, options = {}, methods) {
  const file = path.join(dir, `parser-${counter++}.cjs`)
  const source = emitModule(grammar, {
    methods, ...options, format: 'cjs', runtimeSpecifier: './runtime.cjs', engineSpecifier: './engine.cjs'
  })
  await writeFile(file, source)
  const module = createRequire(file)(file)
  if (methods) module.registerMethods(methods)
  return { module, source }
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'grammatik-emit-'))
  // A CommonJS build of the runtime, so an emitted `.cjs` parser can require it
  // the way the published package's `require` condition would.
  const { build } = await import('esbuild')
  const cjs = { bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' }
  await build({ ...cjs, entryPoints: [path.resolve('src/runtime.js')], outfile: path.join(dir, 'runtime.cjs') })
  // The engine is ESM-only source too, and a temp directory cannot resolve it by
  // name; both stand in for what the published package resolves for `require`.
  await build({
    ...cjs,
    stdin: { contents: "export { LogicEngine } from 'json-logic-engine'", resolveDir: process.cwd() },
    outfile: path.join(dir, 'engine.cjs')
  })
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('emitted modules parse identically', () => {
  it('arithmetic', async () => {
    const { module } = await load(calcGrammar)
    const reference = createParser(calcGrammar)
    for (const source of ['1+2', '2+3*4', '(2+3)*4', '10-3-2', '100/5/2', '-(2+3)', '--5', '5*3+2*5-1']) {
      expect(module.parse(source), source).toBe(reference.parse(source))
    }
  })

  it('JSON, against JSON.parse', async () => {
    const { module } = await load(jsonGrammar, {}, jsonMethods)
    for (const source of [
      '1', '-1.5e3', '"a\\nb"', 'true', 'null', '[]', '{}',
      '[1,2,3]', '{"a":1,"b":[true,null,{"c":"d"}]}', '  { "x" : [ 1 ] } '
    ]) {
      expect(module.parse(source), source).toEqual(JSON.parse(source))
    }
  })

  it('the formula grammar, with custom methods', async () => {
    const options = { functions: new Set(['SUM', 'IF', 'ABS']), unaryFunctions: new Set(['ABS']) }
    const { module } = await load(formulaGrammar, {}, createFormulaMethods(options))
    const reference = createParser(formulaGrammar, { methods: createFormulaMethods(options) })
    for (const source of ['=1 + 2 * 3', 'IF(A1>=10,SUM(B1:B5),ABS(C1))', "'Q 1'!$B$2", 'items[*].total', '2^3^2', '+5%%']) {
      expect(module.parse(source), source).toEqual(reference.parse(source))
    }
  })

  it('a grammar written in the definition language', async () => {
    const grammar = parseDefinition(`
      grammar Sum; start sum;
      token WS pattern "\\\\s+" skip;
      token Int pattern "[0-9]+";
      token Plus literal "+";
      rule sum = infixLeft(
        as(consume(Int), action({"+":[{"val":"image"},0]})),
        consume(Plus),
        action({"+":[{"val":"left"},{"val":"right"}]})
      );
    `)
    const { module } = await load(grammar)
    expect(module.parse('1 + 2 + 3')).toBe(6)
  })
})

describe('emitted modules report errors identically', () => {
  it('same message and rule stack', async () => {
    const { module } = await load(jsonGrammar, {}, jsonMethods)
    const reference = createParser(jsonGrammar, { methods: jsonMethods })
    const describeFailure = (parse, source) => {
      try {
        parse(source)
        return 'accepted'
      } catch (error) {
        return `${error.message} :: ${JSON.stringify(error.ruleStack)}`
      }
    }
    for (const source of ['', '{', '[1,]', '{"a"}', '1 2', '{"a": [1, {"b": }]}']) {
      expect(describeFailure(module.parse, source), source)
        .toBe(describeFailure((s) => reference.parse(s), source))
    }
  })
})

describe('what the generated file is', () => {
  it('imports only the runtime, not the toolkit', async () => {
    const { source } = await load(calcGrammar)
    expect(source).not.toMatch(/from ['"][^'"]*\/(analyze|plan|codegen|parser|definition|emit)\.js['"]/)
    // Mentioned in a doc comment, but never called.
    expect(source).not.toMatch(/\bcreateParser\s*\(/)
    // The rule bodies are present as source, not rebuilt at import.
    expect(source).toMatch(/switch \(/)
    expect(source).toMatch(/R\[0\] = \(c\) =>/)
  })

  it('never calls new Function or eval for the rules', async () => {
    const { source } = await load(calcGrammar)
    expect(source).not.toMatch(/new Function/)
    expect(source).not.toMatch(/\beval\(/)
  })

  it("execution: 'interpreted' keeps the module free of engine.build", async () => {
    const { source, module } = await load(jsonGrammar, { execution: 'interpreted' }, jsonMethods)
    expect(source).not.toMatch(/engine\.build/)
    expect(module.parse('[1,{"a":2}]')).toEqual([1, { a: 2 }])
  })

  it('carries the token definitions and start rule as data', async () => {
    const { module } = await load(calcGrammar)
    expect(module.start).toBe(calcGrammar.start)
    expect(module.tokens.map((t) => t.name)).toEqual(calcGrammar.tokens.map((t) => t.name))
    expect(module.tokenize('1+2').map((t) => t.type)).toEqual(['Number', 'Plus', 'Number'])
  })

  it('honours memo and offset positions', async () => {
    const { module } = await load(jsonGrammar, { memo: true, positions: 'offset' }, jsonMethods)
    expect(module.parse('{"a":[1,2]}')).toEqual({ a: [1, 2] })
    expect(module.tokenize('1')[0].line).toBe(0)
  })
})

describe("format: 'cjs'", () => {
  it('emits a module that requires and parses identically', async () => {
    const { module, source } = await loadCjs(calcGrammar)
    expect(source).toMatch(/^const \{ FAIL: F, expect: E,/m)
    expect(source).not.toMatch(/^(?:import|export) /m)
    const reference = createParser(calcGrammar)
    for (const source of ['1+2', '2+3*4', '(2+3)*4', '5*3+2*5-1']) {
      expect(module.parse(source), source).toBe(reference.parse(source))
    }
  })

  it('exports the same surface as the ES module, plus a default alias', async () => {
    const { module } = await loadCjs(calcGrammar)
    expect(Object.keys(module).sort())
      .toEqual(['default', 'parse', 'parseTokens', 'registerMethods', 'start', 'tokenize', 'tokens'])
    expect(module.default.parse).toBe(module.parse)
    expect(module.start).toBe(calcGrammar.start)
  })

  it('requires json-logic-engine rather than importing it', async () => {
    // calc folds with `reduce`, so one action cannot be compiled to source and
    // the engine stays.
    const { source } = await loadCjs(calcGrammar)
    expect(source).toMatch(/^const \{ LogicEngine \} = require\("\.\/engine\.cjs"\)$/m)
  })

  it('drops the engine entirely when every action inlines', async () => {
    const options = { functions: new Set(['SUM', 'IF', 'ABS']), unaryFunctions: new Set(['ABS']) }
    const { source, module } = await loadCjs(formulaGrammar, {}, createFormulaMethods(options))
    expect(source).not.toMatch(/require\("\.\/engine\.cjs"\)/)
    const reference = createParser(formulaGrammar, { methods: createFormulaMethods(options) })
    for (const text of ['=1 + 2 * 3', 'IF(A1>=10,SUM(B1:B5),ABS(C1))', 'items[*].total', '2^3^2']) {
      expect(module.parse(text), text).toEqual(reference.parse(text))
    }
  })

  it('rejects a format it does not know', () => {
    expect(() => emitModule(calcGrammar, { format: 'umd' })).toThrow(/format must be 'esm' or 'cjs'/)
  })
})

describe('emitModule refuses what it cannot write', () => {
  it('rejects a bad start rule', () => {
    expect(() => emitModule({ ...calcGrammar, start: 'nope' })).toThrow(/start rule 'nope'/)
  })

  it('rejects a left-recursive grammar', () => {
    expect(() => emitModule({
      tokens: [{ name: 'Int', pattern: '\\d+' }],
      rules: { a: { seq: [{ subrule: 'a' }, { consume: 'Int' }] } },
      start: 'a'
    })).toThrow(/left-recursive/)
  })

  it('rejects a grammar referencing a rule that does not exist', () => {
    expect(() => emitModule({
      tokens: [{ name: 'Int', pattern: '\\d+' }],
      rules: { a: { subrule: 'ghost' } },
      start: 'a'
    }, { validate: false })).toThrow(/unknown rules \(ghost\)/)
  })
})

describe('actions compiled to source', () => {
  const formulaOptions = { functions: new Set(['SUM', 'IF', 'ABS']), unaryFunctions: new Set(['ABS']) }

  it('drops the engine import entirely when every action inlines', async () => {
    const { source } = await load(formulaGrammar, {}, createFormulaMethods(formulaOptions))
    expect(source).not.toMatch(/^import .*json-logic-engine/m)
    expect(source).not.toMatch(/\baction\(\{/)
    // What is left of the engine is a table of the caller's own methods.
    expect(source).toMatch(/const engine = \{ methods: M \}/)
  })

  it('parses identically with the engine gone', async () => {
    const methods = createFormulaMethods(formulaOptions)
    const { module } = await load(formulaGrammar, {}, methods)
    const reference = createParser(formulaGrammar, { methods: createFormulaMethods(formulaOptions) })
    for (const source of [
      '=1 + 2 * 3', 'IF(A1>=10,SUM(B1:B5),ABS(C1))', "'Q 1'!$B$2",
      'items[*].total', 'a[*].b[*].c', '2^3^2', '+5%%', '{1,2;3,4}', '#DIV/0!'
    ]) {
      expect(module.parse(source), source).toEqual(reference.parse(source))
    }
  })

  it('also drops it for the JSON grammar', async () => {
    const { source, module } = await load(jsonGrammar, {}, jsonMethods)
    expect(source).not.toMatch(/^import .*json-logic-engine/m)
    expect(module.parse('{"a":[1,true,null,"x"]}')).toEqual({ a: [1, true, null, 'x'] })
  })

  it('falls back per action when one cannot be compiled', async () => {
    // calc folds with `reduce`, which compiles to a closure with no source.
    const { source, module } = await load(calcGrammar)
    expect(source).toMatch(/^import .*json-logic-engine/m)
    expect(source).toMatch(/\baction\(\{/)
    // The ones that could still inline did.
    expect(source).toMatch(/\(context\) => \{ let prev; return/)
    expect(module.parse('5*3+2*5-1')).toBe(24)
  })

  it('keeps everything interpreted when asked, engine and all', async () => {
    const { source, module } = await load(formulaGrammar, { execution: 'interpreted' }, createFormulaMethods(formulaOptions))
    expect(source).toMatch(/^import .*json-logic-engine/m)
    expect(source).not.toMatch(/engine\.build/)
    expect(module.parse('=1 + 2 * 3')).toEqual({ '+': [1, { '*': [2, 3] }] })
  })

  it('registers methods given as plain functions or descriptors', async () => {
    const grammar = {
      tokens: [{ name: 'Int', pattern: '\\d+' }],
      rules: { main: { as: [{ consume: 'Int' }, { double: { val: 'image' } }] } },
      start: 'main'
    }
    const plain = { double: (args) => Number(args[0]) * 2 }
    const { module } = await load(grammar, {}, plain)
    expect(module.parse('21')).toBe(42)
  })

  it('emits without methods, falling back rather than failing', async () => {
    // No methods supplied and no block to find them in: the emitter cannot
    // compile calls it knows nothing about, so those actions ship as data.
    const { methodsBlock, ...withoutBlock } = formulaGrammar
    const { source } = await load(withoutBlock, {})
    expect(source).toMatch(/^import .*json-logic-engine/m)
    expect(source).toMatch(/\baction\(\{/)
  })
})
