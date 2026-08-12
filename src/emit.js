// @ts-check
'use strict'

import { createLexer } from './lexer.js'
import { analyze } from './analyze.js'
import { createPlanner } from './plan.js'
import { createCodegen } from './codegen.js'
import { usesOuterScope } from './plan.js'
import { emitMethodsBlock, evaluateMethodsBlock } from './methodsblock.js'
import { createValueMethods } from './values.js'
import { Compiler, LogicEngine } from 'json-logic-engine'

/**
 * Things the engine's compiler can emit that a generated file has no way to
 * provide: its coercion helpers, its `truthy`, closures captured by a compile
 * hook (`reduce` and friends), and raw logic kept for lazy operators. An action
 * whose source touches any of them keeps its `action({...})` wrapper.
 *
 * `engine.methods` is deliberately *not* here — it is only a lookup table for
 * the semantic methods the caller registers, and a generated file can hold one
 * of those itself.
 */
const UNSUPPORTED = /\b(coerceArray|precoerceNumber|compareCheck|assertAllowedDepth|assertSize|asyncIterators|notTraversed)\b|(?<!engine\.)\bmethods\[|engine\.(?!methods\b)/

/**
 * Tries to compile one action to inlinable source.
 *
 * Returns null when it cannot, which is always safe: the caller falls back to
 * shipping the logic as data and letting the engine compile it at import.
 */
function inlineAction (logic, engine) {
  try {
    // `build` populates the buildState defaults (notably `compile`); a fresh
    // state then collects exactly what this one action needs.
    const seed = { engine }
    Compiler.build(logic, seed)
    const state = {
      engine, compile: seed.compile, values: [], methods: [], notTraversed: [], processing: [], state: {}
    }
    const source = Compiler.buildString(logic, state)

    if (state.methods.length || state.notTraversed.length || state.processing.length) return null
    if (UNSUPPORTED.test(source)) return null

    // Constants the compiler hoisted. Emittable only if they are really data.
    let values = null
    if (state.values.length > 0) {
      values = JSON.stringify(state.values)
      if (JSON.parse(values) === undefined) return null
      if (JSON.stringify(JSON.parse(values)) !== values) return null
    }

    return {
      source,
      values,
      needsMethods: source.includes('engine.methods'),
      needsAbove: /\babove\b/.test(source)
    }
  } catch {
    return null
  }
}
import { GrammarError } from './parser.js'

/**
 * The block's methods, or null when it cannot be evaluated here — an importing
 * block, or a host with no `new Function`. Failing is not fatal: the actions
 * that would have been compiled ship as JSON Logic instead.
 */
function tryEvaluate (body) {
  try {
    return evaluateMethodsBlock(body).methods
  } catch {
    return null
  }
}

/**
 * Writes a grammar out as a JavaScript module, the way Peggy emits a parser.
 *
 * The generated file contains the same rule functions `createParser` would build
 * at run time, as source. What that buys is not speed — it is the same code —
 * but everything around it: the grammar is analyzed once, at build time, so
 * there is no FIRST-set computation or planning at startup; the file is a
 * reviewable, diffable artifact; and nothing calls `new Function`, so it runs
 * under a Content-Security-Policy without `unsafe-eval`.
 *
 * The file imports `grammatik/runtime` for the lexer and parse state, and
 * `json-logic-engine` for the semantic actions, which stay as JSON Logic data
 * in the file and are compiled at import. Actions can be interpreted instead
 * with `execution: 'interpreted'`, which keeps the whole module eval-free.
 */

const quote = (value) => JSON.stringify(value)

/** Pretty-prints data with a stable indent, for readability in the output. */
const literal = (value, indent = 0) => JSON.stringify(value, null, 2)
  .split('\n')
  .join('\n' + ' '.repeat(indent))

/**
 * @param {import('./parser.js').GrammarSpec} spec
 * @param {{ memo?: boolean, strict?: boolean, ll1?: boolean, maxSteps?: number,
 *           positions?: 'full'|'offset', execution?: 'generated'|'interpreted',
 *           format?: 'esm'|'cjs', validate?: boolean, moduleName?: string,
 *           runtimeSpecifier?: string, engineSpecifier?: string,
 *           methods?: Record<string, any> }} [options]
 * @returns {string} JavaScript module source
 */
export function emitModule (spec, options = {}) {
  const { tokens: tokenDefs, rules, start } = spec
  const {
    memo = false,
    strict = true,
    ll1 = true,
    maxSteps = 0,
    positions = 'full',
    execution = 'generated',
    format = 'esm',
    validate = true,
    moduleName = spec.name || 'parser',
    runtimeSpecifier = 'grammatik/runtime',
    engineSpecifier = 'json-logic-engine',
    methods: semanticMethods
  } = options

  if (format !== 'esm' && format !== 'cjs') throw new Error(`emitModule: format must be 'esm' or 'cjs', got ${quote(format)}`)

  // A `methods { ... }` block travels with the grammar and is written into the
  // output as source. Nothing evaluates it here, so this path stays eval-free.
  const methodsBlock = options.methodsBlock !== undefined ? options.methodsBlock : spec.methodsBlock
  const block = methodsBlock ? emitMethodsBlock(methodsBlock, format) : null
  if (!start || !(start in rules)) throw new Error(`emitModule: start rule '${start}' is not defined in rules`)

  const lexer = createLexer(tokenDefs, { positions })
  const analysis = analyze(rules, { tokenNames: lexer.tokenNames })
  if (validate && analysis.errors.length > 0) throw new GrammarError(analysis.errors)

  // The planner is needed only so codegen can record what each helper is; the
  // closures it makes are thrown away.
  const firsts = ll1 ? analysis.firsts : null
  // The generated file's own `createLexer(tokenDefs, ...)` call assigns the same
  // ids, from the same `tokenDefs` array in the same order — see the matching
  // comment in parser.js.
  const tokenIds = new Map(lexer.tokenNames.map((name, id) => [name, id]))
  const engine = { build: () => { throw new Error('not compiled during emit') }, run: () => {} }
  const planner = createPlanner({ engine, rules, firsts, memo, maxSteps, unsafeEval: false, tokenIds })
  const codegen = createCodegen({ planner, rules, firsts, memo, maxSteps, tokenIds })

  codegen.compile(start)

  const reached = [...codegen.ruleIndex.entries()].sort((a, b) => a[1] - b[1])
  const unsupported = codegen.ORIGINS
    .map((origin, index) => ({ origin, index }))
    .filter(({ origin }) => origin.kind === 'unknownRule')
  if (unsupported.length > 0) {
    const names = unsupported.map(({ origin }) => origin.name).join(', ')
    throw new Error(`emitModule: cannot emit a grammar with unknown rules (${names})`)
  }

  // Each action is compiled to source where possible and shipped as data where
  // not. An action that climbs to the parser state always stays interpreted:
  // the engine does not thread `above` into built functions.
  //
  // Compiling an action that calls a method needs that method to exist, so a
  // grammar carrying its own methods block is evaluated here — the functions are
  // used only to compile, never emitted. A block that imports cannot be
  // evaluated in place; the CLI resolves those as a module and passes them in,
  // and without that the actions simply ship as data.
  const blockMethods = block && !semanticMethods ? tryEvaluate(methodsBlock) : null
  const compileEngine = new LogicEngine()
  for (const [name, method] of Object.entries(createValueMethods())) compileEngine.addMethod(name, method)
  for (const [name, method] of Object.entries(semanticMethods || blockMethods || {})) compileEngine.addMethod(name, method)

  let needsEngine = execution === 'interpreted'
  let needsAbove = false

  const emitAction = (logic) => {
    if (usesOuterScope(logic) || execution === 'interpreted') {
      needsEngine = true
      return `interpretedAction(${literal(logic, 2)})`
    }
    const inlined = inlineAction(logic, compileEngine)
    if (!inlined) {
      needsEngine = true
      return `action(${literal(logic, 2)})`
    }
    if (inlined.needsAbove) needsAbove = true
    const body = `(context) => { let prev; return ${inlined.source} }`
    return inlined.values ? `((values) => ${body})(${inlined.values})` : body
  }

  const helpers = codegen.ORIGINS.map((origin) => {
    if (origin.kind === 'constant') return `constant(${literal(origin.node, 2)})`
    if (origin.kind === 'action') return emitAction(origin.logic)
    if (origin.kind === 'valueExpression') return `valueExpression(${emitAction(origin.logic)})`
    throw new Error(`emitModule: unsupported helper (${origin.kind})`)
  })

  // With every action inlined, all that is left of the engine is a table of the
  // caller's own semantic methods — which the file can hold itself.
  const engineFree = !needsEngine

  const ruleSources = reached.map(([name, index]) =>
    `// ${name}\nR[${index}] = ${codegen.SOURCES[index]}`
  ).join('\n\n')

  const interpretedActions = execution === 'interpreted'

  // The two formats differ only in how the file opens and closes; every rule,
  // helper and action between them is the same source.
  const cjs = format === 'cjs'
  // A module that still has an engine runs some actions through it, and those
  // actions may use the value methods, so it has to register them the way
  // `createParser` does. They come from the runtime rather than being written
  // out here, so there is one implementation rather than two.
  const runtimeImports = ['FAIL as F', 'expect as E', 'createState', 'buildParseError', 'createLexer']
  if (needsEngine) runtimeImports.push('createValueMethods')

  const importRuntime = cjs
    ? `const { ${runtimeImports.map((b) => b.replace(' as ', ': ')).join(', ')} } = require(${quote(runtimeSpecifier)})`
    : `import { ${runtimeImports.join(', ')} } from ${quote(runtimeSpecifier)}`
  const importEngine = engineFree
    ? ''
    : cjs
      ? `const { LogicEngine } = require(${quote(engineSpecifier)})\n`
      : `import { LogicEngine } from ${quote(engineSpecifier)}\n`

  const PUBLIC = ['parse', 'parseTokens', 'tokenize', 'tokens', 'start', 'registerMethods']

  // A block's named exports come out of the generated parser too: a grammar that
  // needs a helper on the host side can ship it rather than make the caller keep
  // a matching file in sync.
  for (const name of block ? block.names : []) {
    if (PUBLIC.includes(name)) throw new Error(`emitModule: the methods block exports '${name}', which the generated parser already exports`)
  }
  const exported = block ? [...PUBLIC, ...block.names] : PUBLIC

  const exports = cjs
    ? `module.exports = { ${exported.join(', ')} }\n// Named the same under \`default\`, so an \`import parser from\` interops.\nmodule.exports.default = module.exports`
    : `export { ${exported.join(', ')} }\nexport default { ${PUBLIC.join(', ')} }`

  return `// Generated by grammatik from the ${quote(moduleName)} grammar. Do not edit.
//
// The grammar was analyzed when this file was written: FIRST sets, left-recursion
// checks and rule specialization all happened then. Importing it does no grammar
// work and generates no code.
${engineFree
  ? '// Every semantic action was compiled to source too, so this file has no\n// dependency on json-logic-engine at all.'
  : interpretedActions
    ? '// Semantic actions are interpreted, so nothing here calls `eval`.'
    : '// Semantic actions that could not be compiled to source are shipped as JSON\n// Logic and built by json-logic-engine when this module loads.'}

${importRuntime}
${importEngine}

const tokens = ${literal(tokenDefs)}

const start = ${quote(start)}

const lexer = createLexer(tokens, { positions: ${quote(positions)} })
const tokenize = lexer.tokenize

${engineFree
  ? `// Every semantic action compiled to source, so the engine reduced to a table
// of the methods below. Nothing here imports json-logic-engine.
const M = Object.create(null)
const engine = { methods: M }
${needsAbove ? 'const above = []\n' : ''}
/**
 * Semantic methods the grammar refers to. Pass the same object you would give
 * \`createParser\`; anything the actions call must be registered before use.
 */
function registerMethods (methods) {
  for (const [name, method] of Object.entries(methods || {})) {
    M[name] = typeof method === 'function' ? { method } : method
  }
  return engine
}`
  : `const engine = new LogicEngine()
for (const [name, method] of Object.entries(createValueMethods())) engine.addMethod(name, method)
${needsAbove ? 'const above = []\n' : ''}
/**
 * Semantic methods the grammar refers to. Pass the same object you would give
 * \`createParser\`; anything the actions call must be registered before use.
 */
function registerMethods (methods) {
  for (const [name, method] of Object.entries(methods || {})) engine.addMethod(name, method)
  return engine
}`}

${block
  ? `// ---------------------------------------------------------------------------
// The grammar's \`methods { ... }\` block, written out as source. It is registered
// below, so importing this module is enough — no wiring at the call site.
// ---------------------------------------------------------------------------

${block.source}

registerMethods(${block.table})
`
  : ''}
${engineFree ? '' : `const interpretedAction = (logic) => (bindings, state) => engine.run(logic, bindings, { above: [state] })
`}
${engineFree
  ? ''
  : interpretedActions
  ? 'const action = interpretedAction'
  : `const action = (logic) => {
  // Compiled on first use, so \`registerMethods\` can run first.
  let fn
  return (bindings, state) => {
    if (fn === undefined) {
      try {
        const built = engine.build(logic)
        fn = typeof built === 'function' ? (b) => built(b) : () => built
      } catch {
        fn = (b, s) => engine.run(logic, b, { above: [s] })
      }
    }
    return fn(bindings, state)
  }
}`}

/** A JSON Logic value expression sitting in parser position. */
const valueExpression = (run) => (state) => run(state.bindings || {}, state)
const constant = (value) => () => value

const P = (op, at) => {
  throw new Error(\`'\${op}' matched without consuming any input at token index \${at}; this would loop forever.\`)
}
const T = () => { throw new Error('Parser exceeded maxSteps (${maxSteps}); the grammar is likely looping.') }

/** Rule functions, indexed. Filled below; recursion resolves through the array. */
const R = []

/** Values the rules close over: semantic actions and literals. */
const H = [
${helpers.map((source, index) => `  /* ${index} */ ${source}`).join(',\n')}
]

/**
 * Name -> id, the same numbering \`lexer\` assigns. A generated \`alt\`'s switch
 * dispatches on a token's id when it has one; this is only read as a fallback,
 * for a hand-built token from \`parseTokens\` that bypassed this file's own
 * lexer and so has no id of its own.
 */
const I = ${literal(Object.fromEntries(tokenIds))}

${ruleSources}

const RULES = ${literal(Object.fromEntries(reached.map(([name, index]) => [name, index])))}

/**
 * Parses a token stream you lexed yourself.
 * @param {any[]} tokenList
 * @param {string} [source]
 */
function parseTokens (tokenList, source, track = false) {
  const state = createState(tokenList, {}, { memo: ${memo}, maxSteps: ${maxSteps}, track })
  state.source = source
  state.positions = ${quote(positions)}
  state.ruleNames[0] = start
  state.ruleDepth = 1

  const result = R[RULES[start]](state)
  const trailing = ${strict ? 'state.idx < tokenList.length' : 'false'}
  if (result !== F && !trailing) return result

  if (!track) return parseTokens(tokenList, source, true)
  if (trailing && state.maxIdx < state.idx) {
    state.maxIdx = state.idx
    state.expected = ['end of input']
    state.failureStack = state.ruleNames.slice(0, state.ruleDepth)
  }
  throw buildParseError(state)
}

/** Lexes and parses text. @param {string} text */
function parse (text) {
  return parseTokens(lexer.tokenize(text), text)
}

${exports}
`
}
