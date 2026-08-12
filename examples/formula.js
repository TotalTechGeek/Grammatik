import { readFileSync } from 'node:fs'
import { createParser, parseDefinition, evaluateMethodsBlock } from '../src/index.js'

/**
 * The Excel-formula example, loaded from `formula.gram`.
 *
 * There is nothing of the language in this file. The rules, the actions and the
 * semantic methods all live in the `.gram`; this reads it, evaluates its `methods`
 * block, and returns a parser.
 *
 * Evaluating a block needs `new Function`, which is why this module is not
 * importable under a Content-Security-Policy without `unsafe-eval` — a block is
 * a build-time feature. `grammatik generate` writes the block out as source
 * instead, and the resulting parser needs no eval at all. See
 * `scripts/check-no-eval.mjs`, which builds this grammar the other way.
 */

const source = readFileSync(new URL('./formula.gram', import.meta.url), 'utf8')

// Interpreted, so reading the grammar itself generates no code; only the block
// below does.
export const grammar = parseDefinition(source, { execution: 'interpreted' })

export const { tokens, rules } = grammar

const block = evaluateMethodsBlock(grammar.methodsBlock)

/** Restricts the accepted function names. See `configure` in the grammar. */
export const configure = block.exports.configure

/**
 * The semantic methods, configured for these options.
 *
 * A parser registers its methods once, so the function sets are module state
 * rather than a fresh table per call — two parsers built from this module share
 * the most recent configuration.
 */
export function createFormulaMethods (options = {}) {
  configure(options)
  return block.methods
}

export function createFormulaParser (options = {}) {
  return createParser(grammar, { ...options, methods: createFormulaMethods(options) })
}

export default grammar
