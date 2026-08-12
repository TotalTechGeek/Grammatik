// @ts-check
'use strict'

import { declareSync } from './plan.js'

/**
 * The grammar combinators, as json-logic-engine methods.
 *
 * Every one is the same shape, because every one does the same thing: hand the
 * node to the planner and run the closure it gives back. The per-operator
 * behaviour lives in `plan.js` (interpreted) and `codegen.js` (compiled) —
 * nothing here needs to know what `alt` or `manySep` mean.
 *
 * Two flags matter, and both are load-bearing:
 *
 * `lazy: true` — a combinator's arguments are alternatives and repetitions. The
 * engine must not evaluate them before the combinator has decided whether, and
 * how many times, each should run, so the method takes raw logic.
 *
 * `deterministic: false` — the optimizer inlines deterministic calls *at
 * optimize time* (`optimizer.js`: `if (deterministic) return result()`), which
 * for a parser would mean running it against no input before the parse begins.
 */

export const OPERATORS = [
  'consume', 'epsilon', 'seq', 'alt', 'oneOf', 'eof',
  'many', 'many1', 'option', 'manySep', 'many1Sep',
  'infixLeft', 'infixRight', 'prefix', 'postfix', 'between', 'as',
  'subrule', 'label', 'action', 'lookahead', 'negLookahead', 'text'
]

const plannerOf = (engine) => {
  const context = engine.__jlGrammar
  if (!context) throw new Error('grammar combinators require a parser built by createParser')
  return context.planner
}

/**
 * The compiler calls this while generating source. Interpolating a *function*
 * into `buildState.compile` puts it in the generated code's scope and emits a
 * reference to it, so what comes back is a direct call into the planner's
 * closure — no engine dispatch, no operator lookup, no per-node lookup at parse
 * time. Returning `false` falls back to calling the method, which is what
 * happens on an engine `createParser` never set up.
 */
const compileVia = (op) => (logic, buildState) => {
  const context = buildState.engine.__jlGrammar
  if (!context) return false
  return buildState.compile`${declareSync(context.planner.planOp(op, logic))}(context)`
}

const combinator = (op) => ({
  lazy: true,
  deterministic: false,
  compile: compileVia(op),
  method: (logic, state, above, engine) => plannerOf(engine).planOp(op, logic)(state)
})

/** @returns {Record<string, any>} */
export const createMethods = () =>
  Object.fromEntries(OPERATORS.map((op) => [op, combinator(op)]))
