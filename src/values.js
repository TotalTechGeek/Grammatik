// @ts-check
'use strict'

/**
 * JSON Logic methods available inside semantic actions, beyond the engine's own.
 *
 * Deliberately a module of its own with no imports. It is needed in four places
 * — `createParser`'s engine, the emitter's compile engine, and the engine a
 * generated module builds when it still has one — and the last of those reaches
 * it through `jl-grammar/runtime`, which must not grow a dependency on the
 * planner or the analyzer to get here.
 */

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
 *
 * This hook is not an optimization. Without it the emitter cannot turn an action
 * using `obj` into source, so the generated parser would fall back to shipping
 * the action as data and carrying json-logic-engine — a new operator that
 * quietly cost a grammar its engine-free build would be worse than no operator.
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

/** @returns {Record<string, any>} */
export const createValueMethods = () => ({
  obj: { method: objectFrom, compile: compileObject }
})
