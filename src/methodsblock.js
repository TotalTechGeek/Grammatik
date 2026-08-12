// @ts-check
'use strict'

/**
 * The `methods { ... }` block: a terminal section of a `.gram` file holding the
 * JavaScript its semantic actions call.
 *
 * A grammar's actions name methods — `{"formula.number": {"val": "image"}}` —
 * and those methods have to be real functions somewhere. Without this, "somewhere"
 * is a second file the caller has to wire up by hand.
 *
 * The block does not compromise the grammar's data property. It is separated
 * textually *before* the definition language sees the source, so what
 * `parseDefinition` returns is the same JSON-serializable object it always was,
 * with the block carried alongside as an opaque string. A `.gram` with no block
 * parses exactly as it did.
 *
 * The block is a module body: its default export is the methods table, or, with
 * no default export, its named exports become the table. Named exports are also
 * re-exported by a generated parser, which is how a grammar can ship helpers
 * that its host needs — see `useFunctionSet` in sheetlang.
 */

/** Matches the block header. Anchored to a line so a stray identifier cannot start one. */
const HEADER = /^[ \t]*methods[ \t]*\{/gm

/** `import` as a single statement, which is all the CommonJS transform handles. */
const IMPORT = /^[ \t]*import\b[^\n]*?['"][^'"]+['"][ \t]*;?[ \t]*$/gm

/** `export const x`, `export function x`, `export class x`. */
const DECLARED_EXPORT = /^[ \t]*export[ \t]+(?:const|let|var|function|class|async[ \t]+function)[ \t]+([A-Za-z_$][\w$]*)/gm

/** `export { a, b as c }` — a standalone list, not a re-export from a module. */
const EXPORT_LIST = /^[ \t]*export[ \t]*\{([^}]*)\}[ \t]*;?[ \t]*$/gm

/**
 * Splits definition source into the grammar text and the block body.
 *
 * The block is terminal by construction: it runs from its `{` to the last `}` in
 * the file. That makes finding its end a search rather than a parse — no
 * counting braces through string literals, comments and regex literals, which is
 * where this kind of thing usually goes wrong.
 *
 * @param {string} source
 * @returns {{ grammar: string, block: string | null }}
 */
export function splitMethodsBlock (source) {
  HEADER.lastIndex = 0
  let header = null
  for (let match = HEADER.exec(source); match; match = HEADER.exec(source)) header = match

  if (!header) return { grammar: source, block: null }

  const open = header.index + header[0].length
  const close = source.lastIndexOf('}')
  if (close < open) throw new Error('methods block is not closed: no `}` after it')

  const trailing = source.slice(close + 1).trim()
  if (trailing) throw new Error(`the methods block must be the last thing in the file; found ${JSON.stringify(trailing.slice(0, 40))} after it`)

  // Keep the grammar text the same length so parse errors still report true
  // offsets; the block becomes whitespace rather than disappearing.
  const blanked = source.slice(header.index, source.length).replace(/[^\n]/g, ' ')
  return { grammar: source.slice(0, header.index) + blanked, block: source.slice(open, close) }
}

/**
 * Reads a block body without executing it: which names it exports, whether it has
 * a default export, and whether it imports anything.
 *
 * @param {string} body
 */
export function analyzeMethodsBlock (body) {
  const names = []
  for (const match of body.matchAll(DECLARED_EXPORT)) names.push(match[1])

  // `export { a, b as c }`, including re-exports of things the block imported.
  for (const match of body.matchAll(EXPORT_LIST)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/).pop()
      if (name) names.push(name)
    }
  }

  return {
    names,
    hasDefault: /^[ \t]*export[ \t]+default\b/m.test(body),
    imports: (body.match(IMPORT) || []).map((line) => line.trim())
  }
}

/**
 * The block body as a plain function body: `export` stripped, and a `return`
 * yielding the methods table.
 *
 * @param {string} body
 * @param {{ names: string[], hasDefault: boolean }} info
 */
function asFunctionBody (body, info) {
  const stripped = body
    .replace(/^([ \t]*)export[ \t]+default[ \t]+/m, '$1const __default = ')
    // `export { a, b }` names things already bound above it; the list itself goes.
    .replace(EXPORT_LIST, '')
    .replace(/^([ \t]*)export[ \t]+/gm, '$1')
  const table = info.hasDefault ? '__default' : `{ ${info.names.join(', ')} }`
  return `${stripped}\nreturn { methods: ${table}, exports: { ${info.names.join(', ')} } }`
}

/**
 * Evaluates a block to its methods table.
 *
 * Needs `new Function`, so it is unavailable under a Content-Security-Policy
 * without `unsafe-eval` — and unavailable to a block that imports anything,
 * since a function body cannot. Both are build-time concerns: `emitModule`
 * writes the block out as source and never runs it, and the CLI resolves an
 * importing block through a real module.
 *
 * @param {string} body
 * @returns {{ methods: Record<string, any>, exports: Record<string, any> }}
 */
export function evaluateMethodsBlock (body) {
  const info = analyzeMethodsBlock(body)
  if (info.imports.length > 0) {
    throw new Error(
      'this methods block imports, so it cannot be evaluated in place: ' +
      `${JSON.stringify(info.imports[0])}. Generate a parser file from it instead ` +
      '(`grammatik generate`), or pass `methods` explicitly.'
    )
  }
  if (!info.hasDefault && info.names.length === 0) {
    throw new Error('methods block exports nothing; it needs `export default <table>` or named exports')
  }
  // eslint-disable-next-line no-new-func
  return new Function(asFunctionBody(body, info))()
}

/**
 * Removes the indentation the block carried inside its braces, so it lands at
 * the left margin of the generated module instead of two spaces in.
 */
function dedent (body) {
  const lines = body.replace(/^\n+|\s+$/g, '').split('\n')
  let common = Infinity
  for (const line of lines) {
    if (!line.trim()) continue
    common = Math.min(common, line.length - line.trimStart().length)
  }
  if (!Number.isFinite(common) || common === 0) return lines.join('\n')
  return lines.map((line) => line.slice(common)).join('\n')
}

/** Rewrites the `import` forms a CommonJS file can express as `require`. */
function toRequire (line) {
  const namespace = line.match(/^import[ \t]*\*[ \t]*as[ \t]+([\w$]+)[ \t]+from[ \t]*(['"][^'"]+['"])/)
  if (namespace) return `const ${namespace[1]} = require(${namespace[2]})`

  const named = line.match(/^import[ \t]*(\{[^}]*\})[ \t]*from[ \t]*(['"][^'"]+['"])/)
  if (named) return `const ${named[1].replace(/\bas\b/g, ':')} = require(${named[2]})`

  const fallback = line.match(/^import[ \t]+([\w$]+)[ \t]+from[ \t]*(['"][^'"]+['"])/)
  if (fallback) return `const ${fallback[1]} = require(${fallback[2]}).default ?? require(${fallback[2]})`

  const bare = line.match(/^import[ \t]*(['"][^'"]+['"])/)
  if (bare) return `require(${bare[1]})`

  throw new Error(`cannot express this import in CommonJS, move it or emit ES modules: ${JSON.stringify(line)}`)
}

/**
 * The block as source for a generated module: `export` stripped so nothing
 * escapes by accident, and the table bound to a name the file can register.
 *
 * @param {string} body
 * @param {'esm'|'cjs'} format
 * @returns {{ source: string, table: string, names: string[] }}
 */
export function emitMethodsBlock (body, format) {
  const info = analyzeMethodsBlock(body)
  if (!info.hasDefault && info.names.length === 0) {
    throw new Error('methods block exports nothing; it needs `export default <table>` or named exports')
  }

  let source = dedent(body)
    .replace(/^export[ \t]+default[ \t]+/m, 'const __methods = ')
    .replace(EXPORT_LIST, '')
    .replace(/^export[ \t]+/gm, '')

  // ES modules take the imports as they are — an import declaration is legal
  // anywhere at the top level of a module, so the block needs no hoisting.
  if (format === 'cjs') source = source.replace(IMPORT, (line) => toRequire(line.trim()))

  return {
    source,
    table: info.hasDefault ? '__methods' : `{ ${info.names.join(', ')} }`,
    names: info.names
  }
}
