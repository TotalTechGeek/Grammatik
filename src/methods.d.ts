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
export const OPERATORS: string[];
export function createMethods(): Record<string, any>;
