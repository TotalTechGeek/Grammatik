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

/**
 * `obj` — build an object whose keys are computed.
 *
 *   {"obj": [{"val": "op"}, [{"val": "left"}, {"val": "right"}]]}
 *   -> {"+": [1, 2]}   when `op` is "+"
 *
 * This is the one thing a parser action does constantly that JSON Logic could
 * not express. Building a node whose *type* comes from the input — `binary`,
 * `func`, `call`, every "wrap this in an operator" helper in every grammar here
 * — was the single most common reason to drop into JavaScript, and none of those
 * helpers were doing anything a data form could not.
 *
 * Arguments are flat key/value pairs, so `{"obj": [k, v]}` is the common case and
 * `{"obj": [k1, v1, k2, v2]}` builds two entries. `eachKey` already covers static
 * keys; this covers the rest.
 *
 * The `compile` hook is not an optimization. Without it the emitter cannot turn
 * an action using `obj` into source, so the generated parser would fall back to
 * shipping the action as data and carrying json-logic-engine — a new operator
 * that quietly costs a grammar its engine-free build would be worse than no
 * operator at all.
 */
const badArity = (length) =>
  new Error(`obj expects an even number of arguments (key, value, ...), received ${length}`)

const objectFrom = (args) => {
  if (!Array.isArray(args) || args.length === 0 || args.length % 2 !== 0) {
    throw badArity(Array.isArray(args) ? args.length : 1)
  }
  const result = {}
  for (let i = 0; i < args.length; i += 2) result[args[i]] = args[i + 1]
  return result
}

/**
 * Emits `({[k]: v, [k]: v})` with each key and value compiled in place, so the
 * whole thing is one object literal with no call into the engine.
 */
const compileObject = (args, buildState) => {
  if (!Array.isArray(args) || args.length === 0 || args.length % 2 !== 0) return false
  const strings = ['({[']
  const items = []
  for (let i = 0; i < args.length; i += 2) {
    items.push(args[i])
    strings.push(']: ')
    items.push(args[i + 1])
    strings.push(i + 2 < args.length ? ', [' : '})')
  }
  return buildState.compile(strings, ...items)
}

/**
 * JSON Logic methods available inside semantic actions, beyond the engine's own.
 * Registered by `createParser` and by the emitter, so an action can use them
 * whether it is interpreted, compiled at run time, or written out as source.
 *
 * @returns {Record<string, any>}
 */
export const createValueMethods = () => ({
  obj: { method: objectFrom, compile: compileObject }
})
