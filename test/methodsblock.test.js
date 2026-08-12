import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import {
  splitMethodsBlock, analyzeMethodsBlock, evaluateMethodsBlock,
  parseDefinition, createParserFromSource, emitModule
} from '../src/index.js'

/**
 * A `.gram` file can carry the JavaScript its actions call, so a grammar is one
 * file rather than a file plus a module the caller has to wire up.
 *
 * The property that must not break: the grammar half stays data. Parsing a file
 * with a block has to produce the same JSON-serializable object it would
 * without one, plus the block as an opaque string.
 */

const GRAMMAR = `
grammar Sum;
start sum;

token WS pattern "\\\\s+" skip;
token Int pattern "[0-9]+";
token Plus literal "+";

rule sum = infixLeft(
  as(consume(Int), action({"number": {"val": "image"}})),
  consume(Plus),
  action({"add": [{"val": "left"}, {"val": "right"}]})
);
`

const BLOCK = `
methods {
  export const number = { method: (image) => Number.parseFloat(image), optimizeUnary: true }
  export const add = ([left, right]) => left + right
}
`

let dir
let counter = 0
const runtimeUrl = pathToFileURL(path.resolve('src/runtime.js')).href

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'grammatik-block-'))
  // A CommonJS build of the runtime, so an emitted `.cjs` parser can require it.
  const { build } = await import('esbuild')
  const cjs = { bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' }
  await build({ ...cjs, entryPoints: [path.resolve('src/runtime.js')], outfile: path.join(dir, 'runtime.cjs') })
  await build({
    ...cjs,
    stdin: { contents: "export { LogicEngine } from 'json-logic-engine'", resolveDir: process.cwd() },
    outfile: path.join(dir, 'engine.cjs')
  })
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

async function loadEmitted (source, options = {}) {
  const file = path.join(dir, `parser-${counter++}.mjs`)
  const emitted = emitModule(parseDefinition(source), {
    runtimeSpecifier: runtimeUrl, engineSpecifier: 'json-logic-engine', ...options
  })
  await writeFile(file, emitted)
  return { module: await import(pathToFileURL(file).href), source: emitted }
}

describe('splitMethodsBlock', () => {
  it('leaves a file with no block alone', () => {
    expect(splitMethodsBlock(GRAMMAR)).toEqual({ grammar: GRAMMAR, block: null })
  })

  it('separates the block from the grammar', () => {
    const { grammar, block } = splitMethodsBlock(GRAMMAR + BLOCK)
    expect(grammar).toContain('rule sum =')
    expect(grammar).not.toContain('Number.parseFloat')
    expect(block).toContain('export const add')
  })

  it('keeps offsets intact so parse errors still point at the right line', () => {
    const source = GRAMMAR + BLOCK
    const { grammar } = splitMethodsBlock(source)
    expect(grammar.length).toBe(source.length)
    expect(grammar.split('\n').length).toBe(source.split('\n').length)
  })

  it('rejects anything after the block', () => {
    expect(() => splitMethodsBlock(GRAMMAR + BLOCK + '\nrule extra = consume(Int);'))
      .toThrow(/must be the last thing in the file/)
  })

  it('rejects a block that is never closed', () => {
    expect(() => splitMethodsBlock(GRAMMAR + '\nmethods {\n  export const a = 1\n'))
      .toThrow(/not closed/)
  })

  it('is not started by an identifier that merely says methods', () => {
    const source = 'grammar G;\nstart methods;\ntoken A literal "a";\nrule methods = consume(A);\n'
    expect(splitMethodsBlock(source).block).toBeNull()
  })
})

describe('analyzeMethodsBlock', () => {
  it('finds exported names without executing anything', () => {
    const info = analyzeMethodsBlock(`
      export const a = 1
      export function b () {}
      export class C {}
      const notExported = 2
    `)
    expect(info.names).toEqual(['a', 'b', 'C'])
    expect(info.hasDefault).toBe(false)
    expect(info.imports).toEqual([])
  })

  it('notices a default export and imports', () => {
    const info = analyzeMethodsBlock("import { x } from './x.js'\nexport default { x }")
    expect(info.hasDefault).toBe(true)
    expect(info.imports).toEqual(["import { x } from './x.js'"])
  })
})

describe('parseDefinition', () => {
  it('carries the block and leaves the grammar unchanged', () => {
    const withBlock = parseDefinition(GRAMMAR + BLOCK)
    const without = parseDefinition(GRAMMAR)
    expect(withBlock.methodsBlock).toContain('Number.parseFloat')
    delete withBlock.methodsBlock
    expect(withBlock).toEqual(without)
  })

  it('adds no key at all when there is no block', () => {
    expect('methodsBlock' in parseDefinition(GRAMMAR)).toBe(false)
  })

  it('still produces something JSON can round-trip', () => {
    const grammar = parseDefinition(GRAMMAR + BLOCK)
    expect(JSON.parse(JSON.stringify(grammar))).toEqual(grammar)
  })
})

describe('createParserFromSource', () => {
  it('uses the block, with no methods supplied', () => {
    expect(createParserFromSource(GRAMMAR + BLOCK).parse('1 + 2 + 3')).toBe(6)
  })

  it('lets an explicit methods option win', () => {
    const methods = {
      number: { method: (image) => Number.parseFloat(image), optimizeUnary: true },
      add: ([left, right]) => left * right
    }
    expect(createParserFromSource(GRAMMAR + BLOCK, { methods }).parse('2 + 3 + 4')).toBe(24)
  })

  it('works under the interpreter too', () => {
    expect(createParserFromSource(GRAMMAR + BLOCK, { execution: 'interpreted' }).parse('1 + 2 + 3')).toBe(6)
  })

  it('takes a default export as the whole table', () => {
    const source = GRAMMAR + `
methods {
  const number = (image) => Number.parseFloat(image)
  export default {
    number: { method: number, optimizeUnary: true },
    add: ([left, right]) => left + right
  }
}
`
    expect(createParserFromSource(source).parse('4 + 5')).toBe(9)
  })

  it('explains itself when the block imports', () => {
    const source = GRAMMAR + "\nmethods {\n  import { add } from './add.js'\n  export default { add }\n}\n"
    expect(() => createParserFromSource(source)).toThrow(/cannot be evaluated in place/)
  })

  it('rejects a block that exports nothing', () => {
    expect(() => createParserFromSource(GRAMMAR + '\nmethods {\n  const a = 1\n}\n'))
      .toThrow(/exports nothing/)
  })
})

describe('emitModule', () => {
  it('writes the block into the file and registers it', async () => {
    const { module, source } = await loadEmitted(GRAMMAR + BLOCK)
    expect(source).toContain('const add = ([left, right]) => left + right')
    expect(source).toContain('registerMethods({ number, add })')
    // Nothing has to be wired up by the importer.
    expect(module.parse('1 + 2 + 3')).toBe(6)
  })

  it('needs no engine when the block declares optimizeUnary', async () => {
    const { source } = await loadEmitted(GRAMMAR + BLOCK)
    expect(source).not.toMatch(/^import .*json-logic-engine/m)
  })

  it('re-exports the block’s named exports', async () => {
    const source = GRAMMAR + `
methods {
  export const number = { method: (image) => Number.parseFloat(image), optimizeUnary: true }
  export const add = ([left, right]) => left + right
  export const scale = (n) => n * 10
}
`
    const { module } = await loadEmitted(source)
    expect(module.scale(4)).toBe(40)
    expect(module.parse('1 + 2')).toBe(3)
  })

  it('keeps the block out of the default export, which is the parser surface', async () => {
    const { module } = await loadEmitted(GRAMMAR + BLOCK)
    expect(Object.keys(module.default).sort())
      .toEqual(['parse', 'parseTokens', 'registerMethods', 'start', 'tokenize', 'tokens'])
  })

  it('de-indents the block rather than emitting it two spaces in', async () => {
    const { source } = await loadEmitted(GRAMMAR + BLOCK)
    expect(source).toMatch(/^const number = \{ method:/m)
  })

  it('refuses a block that shadows the parser surface', () => {
    const source = GRAMMAR + '\nmethods {\n  export const parse = 1\n  export const add = 2\n  export const number = 3\n}\n'
    expect(() => emitModule(parseDefinition(source))).toThrow(/already exports/)
  })

  it('keeps a block with imports, which only the file path can support', async () => {
    // `new Function` cannot import; a module can. This is why an importing block
    // is a build-time feature.
    await writeFile(path.join(dir, 'helper.mjs'), 'export const add = ([l, r]) => l + r\n')
    const source = GRAMMAR + `
methods {
  import { add } from './helper.mjs'
  export const number = { method: (image) => Number.parseFloat(image), optimizeUnary: true }
  export { add }
}
`
    const { module } = await loadEmitted(source)
    expect(module.parse('1 + 2 + 3')).toBe(6)
  })
})

describe('CommonJS output', () => {
  it('rewrites the block’s imports as requires', async () => {
    const file = path.join(dir, `parser-cjs-${counter++}.cjs`)
    await writeFile(path.join(dir, 'helper.cjs'), 'exports.add = ([l, r]) => l + r\n')
    const source = GRAMMAR + `
methods {
  import { add } from './helper.cjs'
  export const number = { method: (image) => Number.parseFloat(image), optimizeUnary: true }
  export { add }
}
`
    const emitted = emitModule(parseDefinition(source), {
      format: 'cjs', runtimeSpecifier: './runtime.cjs', engineSpecifier: './engine.cjs'
    })
    expect(emitted).toContain("const { add } = require('./helper.cjs')")
    await writeFile(file, emitted)
    expect(createRequire(file)(file).parse('1 + 2 + 3')).toBe(6)
  })
})
