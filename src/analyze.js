// @ts-check
'use strict'

/**
 * Static analysis of a grammar, in the spirit of Chevrotain's grammar recording.
 *
 * Two things come out of this:
 *
 *  1. FIRST sets, which let `alt` dispatch on the next token in O(1) instead of
 *     trying each branch and backtracking. This is the difference between an
 *     LL(1) parser and a PEG one, and it is most of the performance story.
 *  2. Errors a grammar author actually wants at build time rather than at 3am:
 *     left recursion, references to rules or tokens that do not exist.
 */

/**
 * @typedef {object} First
 * @property {Set<string>} tokens  Token types that can begin this node.
 * @property {boolean} nullable    Whether the node can match while consuming nothing.
 * @property {boolean} unknown     Whether analysis could not fully determine the set.
 *                                 Any `unknown` disables LL(1) dispatch for the enclosing
 *                                 `alt`, which is a correctness guard, not a bug.
 */

/** @returns {First} */
const emptyFirst = () => ({ tokens: new Set(), nullable: false, unknown: false })

/** @returns {First} A node that matches nothing and consumes nothing (an action). */
const epsilon = () => ({ tokens: new Set(), nullable: true, unknown: false })

/** @returns {First} A node whose behaviour we cannot see through. */
const opaque = () => ({ tokens: new Set(), nullable: true, unknown: true })

/**
 * @param {First} target
 * @param {First} source
 * @returns {boolean} whether target changed
 */
function absorb (target, source) {
  let changed = false
  for (const t of source.tokens) {
    if (!target.tokens.has(t)) {
      target.tokens.add(t)
      changed = true
    }
  }
  if (source.unknown && !target.unknown) {
    target.unknown = true
    changed = true
  }
  return changed
}

/** Returns the single operator key of a JSON Logic node, or null. */
export function opOf (node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null
  const keys = Object.keys(node)
  return keys.length === 1 ? keys[0] : null
}

/** The set of node shapes this module understands as *parsers*. */
export const PARSER_OPS = new Set([
  'consume', 'seq', 'alt', 'many', 'many1', 'option', 'flag',
  'manySep', 'many1Sep', 'infixLeft', 'infixRight', 'postfix', 'prefix',
  'between', 'pick', 'yields', 'as', 'oneOf', 'eof',
  'subrule', 'label', 'action',
  'lookahead', 'negLookahead', 'text', 'epsilon'
])

/**
 * Computes the FIRST set of a node given current per-rule estimates.
 * @param {*} node
 * @param {Map<string, First>} ruleFirsts
 * @returns {First}
 */
function firstOf (node, ruleFirsts) {
  const op = opOf(node)
  if (op === null) return opaque()
  const arg = node[op]

  switch (op) {
    case 'consume': {
      const result = emptyFirst()
      const name = Array.isArray(arg) ? arg[0] : arg
      if (typeof name === 'string') result.tokens.add(name)
      else result.unknown = true
      return result
    }

    case 'epsilon':
    case 'action':
      return epsilon()

    case 'text':
    case 'label':
      // {label: [name, parser]} / {text: parser}
      return firstOf(op === 'label' ? arg[1] : arg, ruleFirsts)

    case 'seq': {
      const result = epsilon()
      if (!Array.isArray(arg)) return opaque()
      for (const child of arg) {
        const childFirst = firstOf(child, ruleFirsts)
        absorb(result, childFirst)
        if (!childFirst.nullable) {
          result.nullable = false
          break
        }
      }
      return result
    }

    case 'alt': {
      const result = emptyFirst()
      if (!Array.isArray(arg)) return opaque()
      for (const child of arg) {
        const childFirst = firstOf(child, ruleFirsts)
        absorb(result, childFirst)
        if (childFirst.nullable) result.nullable = true
      }
      return result
    }

    case 'many':
    case 'option':
    case 'flag': {
      const inner = firstOf(arg, ruleFirsts)
      return { tokens: inner.tokens, nullable: true, unknown: inner.unknown }
    }

    case 'many1': {
      const inner = firstOf(arg, ruleFirsts)
      return { tokens: inner.tokens, nullable: inner.nullable, unknown: inner.unknown }
    }

    case 'oneOf': {
      const result = emptyFirst()
      const names = Array.isArray(arg) ? arg : [arg]
      for (const name of names) {
        if (typeof name === 'string') result.tokens.add(name)
        else result.unknown = true
      }
      return result
    }

    case 'eof':
      // Zero-width and constraining, like a lookahead: never dispatch past it.
      return opaque()

    case 'as':
      return firstOf(Array.isArray(arg) ? arg[0] : arg && arg.parser, ruleFirsts)

    case 'between':
      // Exactly a sequence of open, body, close.
      return firstOf({ seq: [arg && arg.open, arg && arg.body, arg && arg.close] }, ruleFirsts)

    case 'pick':
    case 'yields':
      // Exactly a sequence of its parsers.
      return firstOf({ seq: arg && Array.isArray(arg.parsers) ? arg.parsers : [] }, ruleFirsts)

    case 'prefix': {
      // Zero operators are allowed, so the operand's first set counts too.
      const ops = firstOf(arg && arg.operator, ruleFirsts)
      const inner = firstOf(arg && arg.operand, ruleFirsts)
      const result = emptyFirst()
      absorb(result, ops)
      absorb(result, inner)
      result.nullable = inner.nullable
      return result
    }

    case 'postfix': {
      // Begins and matches exactly where its operand does; suffixes are optional.
      const inner = firstOf(arg && arg.operand, ruleFirsts)
      return { tokens: inner.tokens, nullable: inner.nullable, unknown: inner.unknown }
    }

    case 'infixRight':
    case 'infixLeft': {
      // The level begins wherever its operand begins, and matches whenever the
      // operand does — the operator part is optional by construction.
      const inner = firstOf(arg && arg.operand, ruleFirsts)
      return { tokens: inner.tokens, nullable: inner.nullable, unknown: inner.unknown }
    }

    case 'manySep':
    case 'many1Sep': {
      const inner = firstOf(arg && arg.rule, ruleFirsts)
      return {
        tokens: inner.tokens,
        nullable: op === 'manySep' ? true : inner.nullable,
        unknown: inner.unknown
      }
    }

    case 'subrule': {
      const name = Array.isArray(arg) ? arg[0] : arg
      const known = ruleFirsts.get(name)
      if (!known) return opaque()
      return { tokens: known.tokens, nullable: known.nullable, unknown: known.unknown }
    }

    // Zero-width assertions constrain the input without consuming it. They are
    // nullable, but treating them as transparent would let `alt` dispatch past a
    // guard that was meant to reject, so they are deliberately opaque.
    case 'lookahead':
    case 'negLookahead':
      return opaque()

    default:
      // Any other JSON Logic (`+`, `cat`, `var`, ...) is a value expression: it
      // produces a result without touching the token stream.
      return epsilon()
  }
}

/**
 * Rewrites a `seq` into a cheaper equivalent combinator when it matches a known
 * idiom, in the spirit of json-logic-engine's own `checkIdioms`.
 *
 * Grammars are usually written with the general primitives, because that is
 * what a grammar author reaches for. Two of those spellings are both very
 * common and needlessly expensive, and both can be recognized mechanically:
 *
 *   seq(open, label(n, body), close, action({val: n}))  ->  between(open, body, close)
 *   seq(label(n, parser), action(A))                    ->  as(parser, A')
 *
 * Together they were 40% of all `seq` invocations in the formula benchmark.
 * Recognition means an existing grammar gets the faster path without being
 * rewritten by hand.
 *
 * Returns the replacement node, or null when nothing matched.
 *
 * @param {any[]} children
 */
export function recognizeSeqIdiom (children) {
  if (!Array.isArray(children)) return null

  // between: open, label(n, body), close, action({val: n})
  if (children.length === 4) {
    const [open, labelled, close, act] = children
    if (opOf(labelled) === 'label' && opOf(act) === 'action' &&
        isPlainParser(open) && isPlainParser(close)) {
      const [name, body] = labelled.label
      const logic = act.action
      if (opOf(logic) === 'val' && logic.val === name) {
        return { between: { open, body, close } }
      }
    }
  }

  // as: label(n, parser), action(A) — where every reference in A is rooted at n
  if (children.length === 2) {
    const [labelled, act] = children
    if (opOf(labelled) === 'label' && opOf(act) === 'action') {
      const [name, parser] = labelled.label
      const rewritten = rebaseOnLabel(act.action, name)
      if (rewritten !== BAIL) return { as: [parser, rewritten] }
    }
  }

  // The two idioms below drop the `seq`'s bindings object, so they decline when a
  // child could reach into an enclosing scope: without that object an outward hop
  // would land one scope further out than it did.
  if (children.length >= 2) {
    const last = children[children.length - 1]
    const head = children.slice(0, -1)

    // yields: parsers, then an action that is a constant — `seq(consume(True), action(true))`
    if (opOf(last) === 'action' && isConstant(last.action) && head.every(isPlainParser) && !head.some(usesOuterScope)) {
      return { yields: { parsers: head, value: last.action } }
    }

    // pick: any number of unlabelled parsers around exactly one labelled one, then
    // an action that returns just that label — `seq(consume(Where), label(e, P), action({val: e}))`.
    // `between` is the special case with one on each side.
    if (opOf(last) === 'action' && opOf(last.action) === 'val' && typeof last.action.val === 'string') {
      const name = last.action.val
      const labelled = head.map((child, i) => (opOf(child) === 'label' ? i : -1)).filter((i) => i !== -1)
      if (labelled.length === 1 && head[labelled[0]].label[0] === name &&
          head.every((child, i) => i === labelled[0] || isPlainParser(child)) &&
          !head.some(usesOuterScope)) {
        return { pick: { parsers: head.map((child, i) => (i === labelled[0] ? child.label[1] : child)), index: labelled[0] } }
      }
    }
  }

  return null
}

/** A value that cannot be mutated or aliased: safe to hand out from every parse. */
const isConstant = (value) =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/**
 * True when the logic reads from an outer scope (`{val: [[-1], ...]}` or
 * `{var: "../x"}`). The engine's compiler does not thread `above` into built
 * functions, so such actions must stay interpreted — and a rewrite that removes
 * a `seq`'s bindings object would change what such a hop reaches.
 */
export function usesOuterScope (logic) {
  if (Array.isArray(logic)) return logic.some(usesOuterScope)
  if (!logic || typeof logic !== 'object') return false

  for (const key of Object.keys(logic)) {
    const arg = logic[key]
    if (key === 'val' && Array.isArray(arg) && Array.isArray(arg[0])) return true
    if (key === 'var') {
      if (typeof arg === 'string' && arg.includes('../')) return true
      if (Array.isArray(arg) && typeof arg[0] === 'string' && arg[0].includes('../')) return true
    }
    if (usesOuterScope(arg)) return true
  }
  return false
}

/** A node that is a parser and not one of `seq`'s own interpreted shapes. */
function isPlainParser (node) {
  const op = opOf(node)
  return op !== null && op !== 'label' && op !== 'action'
}

/** Structural equality over plain JSON — every shape a grammar node can be. */
function deepEqual (a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false
  }
  return true
}

/**
 * Left-factors an `alt` whose branches are all `seq` and share a literal
 * leading run of nodes — `alt(seq(P, X, actionX), seq(P, Y, actionY))`
 * becomes `seq(P, alt(seq(X, actionX), seq(Y, actionY)))`, so a shared,
 * possibly multi-token prefix is matched once per attempt instead of once per
 * colliding branch.
 *
 * Two things have to hold for the rewrite to be safe, not just structurally
 * possible:
 *
 *  - The shared prefix cannot contain a `label` or an `action`. A `seq`'s
 *    bindings are scoped to itself; hoisting a labelled node out from under
 *    the branch that reads it would strand the binding in a different scope
 *    than the action that expects to see it.
 *  - Every branch must already end its own decision with an `action`
 *    somewhere in its remainder (`seq` yields that action's value instead of
 *    the flat array of its children). That is what lets the rewritten form
 *    reproduce the original value exactly, by wrapping the factored `alt` in
 *    one more `label`/`action` pair rather than redesigning what the branch
 *    returns.
 *
 * A branch that is a strict prefix of another (nothing left after the shared
 * run) fails the second check on its own — its remainder is empty, so it has
 * no action left to find — and the whole rewrite backs off rather than guess
 * what an author meant by writing one alternative as a prefix of another.
 *
 * @param {any[]} branches
 * @returns {any|null}
 */
export function recognizeAltPrefixIdiom (branches) {
  if (!Array.isArray(branches) || branches.length < 2) return null
  if (!branches.every((b) => opOf(b) === 'seq' && Array.isArray(b.seq))) return null

  const seqs = branches.map((b) => b.seq)
  const minLen = Math.min(...seqs.map((s) => s.length))

  let n = 0
  while (n < minLen) {
    const candidate = seqs[0][n]
    const op = opOf(candidate)
    if (op === 'label' || op === 'action') break
    if (!seqs.every((s) => deepEqual(s[n], candidate))) break
    n++
  }
  if (n === 0) return null
  if (!seqs.every((s) => s.slice(n).some((child) => opOf(child) === 'action'))) return null

  const prefix = seqs[0].slice(0, n)
  const remainders = seqs.map((s) => ({ seq: s.slice(n) }))
  return {
    seq: [
      ...prefix,
      { label: ['__grammatik_rest', { alt: remainders }] },
      { action: { val: '__grammatik_rest' } }
    ]
  }
}

/**
 * Rewrites an `alt` whose every branch is a bare `consume` into `oneOf`:
 * `alt(consume(Plus), consume(Minus))` is `oneOf(Plus, Minus)`.
 *
 * Same language, same value (the matched token), same expected-token list on
 * failure — a token has one type, so "first branch that matches" and "any of
 * these" cannot differ. What differs is cost: `alt` builds a branch per token,
 * `oneOf` is a single test. Measured at 1.3–1.8x for the 2–7 token operator sets
 * grammars actually have, and still 1.2x at 24.
 *
 * @param {any[]} branches
 * @returns {{ oneOf: string[] } | null}
 */
export function recognizeAltConsumeIdiom (branches) {
  if (!Array.isArray(branches) || branches.length < 2) return null
  const names = []
  for (const branch of branches) {
    if (opOf(branch) !== 'consume') return null
    const arg = branch.consume
    const name = typeof arg === 'string' ? arg : (Array.isArray(arg) && arg.length === 1 ? arg[0] : null)
    if (typeof name !== 'string') return null
    names.push(name)
  }
  return { oneOf: names }
}

const BAIL = Symbol('grammatik.bail')

/**
 * Rewrites logic that reads `name` from its enclosing sequence's bindings into
 * logic that reads the value directly, since `as` passes the parsed value as
 * the context itself.
 *
 *   {val: name}            -> {val: []}        (the value)
 *   {val: [name, "image"]} -> {val: "image"}
 *
 * Returns BAIL for anything else that touches the context: a different label, a
 * scope hop (`{val: [[-1], ...]}`), a bare `{val: []}` that would have meant the
 * whole bindings object, or any `var` — whose path syntax is not worth
 * re-deriving here.
 */
function rebaseOnLabel (logic, name) {
  if (Array.isArray(logic)) {
    const out = new Array(logic.length)
    for (let i = 0; i < logic.length; i++) {
      const value = rebaseOnLabel(logic[i], name)
      if (value === BAIL) return BAIL
      out[i] = value
    }
    return out
  }

  if (!logic || typeof logic !== 'object') return logic

  const keys = Object.keys(logic)
  if (keys.length === 1 && keys[0] === 'val') {
    const path = logic.val
    if (path === name) return { val: [] }
    if (Array.isArray(path) && path[0] === name) {
      const rest = path.slice(1)
      return { val: rest.length === 1 ? rest[0] : rest }
    }
    return BAIL
  }
  if (keys.length === 1 && keys[0] === 'var') return BAIL

  const out = {}
  for (const key of keys) {
    const value = rebaseOnLabel(logic[key], name)
    if (value === BAIL) return BAIL
    out[key] = value
  }
  return out
}

/**
 * Runs a fixpoint over the grammar so recursive rules converge.
 * @param {Record<string, any>} grammar
 * @returns {Map<string, First>}
 */
function computeFirsts (grammar) {
  /** @type {Map<string, First>} */
  const ruleFirsts = new Map()
  for (const name of Object.keys(grammar)) ruleFirsts.set(name, emptyFirst())

  let changed = true
  while (changed) {
    changed = false
    for (const name of Object.keys(grammar)) {
      const current = ruleFirsts.get(name)
      const computed = firstOf(grammar[name], ruleFirsts)
      if (absorb(current, computed)) changed = true
      if (computed.nullable && !current.nullable) {
        current.nullable = true
        changed = true
      }
    }
  }

  return ruleFirsts
}


// ---------------------------------------------------------------------------
// Two-token lookahead
//
// FIRST sets say which token can begin a branch. `buildDispatch` uses them to
// pick a branch in O(1), and where several branches can begin with the same
// token it falls back to trying them in order. Often a *second* token tells
// them apart: `Identifier (` is a function call, `Identifier .` a reference
// path, and a branch that needs `(` next need not be attempted when `.` is.
// FIRST_2 is the standard extension: the set of 1- and 2-token prefixes a
// node can begin with.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} First2
 * @property {Set<string>} seqs  Prefixes of the tokens a match can begin with: `a` for a derivation that
 *                               ends after one token (what follows is not known here, so it is a wildcard
 *                               for the second token), `a\u0001b` for two or more.
 * @property {boolean} eps       Whether the node can match consuming nothing.
 * @property {boolean} unknown   Whether analysis could not see through the node. Anything unknown
 *                               disables pruning; a wrong guess here would skip a branch that matches.
 */

const SEP2 = '\u0001'
/**
 * In the second position: any token at all. It marks a prefix that is known only up to its first token
 * and continues in ways this analysis does not model (an operator, a separator, a suffix). That is not the
 * same as a derivation that simply ends after one token, whose continuation is whatever the enclosing
 * sequence puts next — `concat2` appends the next element to the latter and must not to the former.
 */
const ANY2 = '\u0002'

/** @returns {First2} */
const emptyFirst2 = () => ({ seqs: new Set(), eps: false, unknown: false })
/** @returns {First2} */
const epsilon2 = () => ({ seqs: new Set(), eps: true, unknown: false })
/** @returns {First2} */
const opaque2 = () => ({ seqs: new Set(), eps: true, unknown: true })

/** `x` followed by `y`, cut to two tokens. */
function concat2 (x, y) {
  const out = emptyFirst2()
  out.eps = x.eps && y.eps
  out.unknown = x.unknown || y.unknown
  for (const a of x.seqs) {
    if (a.includes(SEP2)) { out.seqs.add(a); continue }
    if (y.eps) out.seqs.add(a)
    for (const b of y.seqs) out.seqs.add(a + SEP2 + (b.includes(SEP2) ? b.slice(0, b.indexOf(SEP2)) : b))
  }
  if (x.eps) for (const b of y.seqs) out.seqs.add(b)
  return out
}

/** Union of alternatives. */
function union2 (...parts) {
  const out = emptyFirst2()
  for (const part of parts) {
    for (const a of part.seqs) out.seqs.add(a)
    if (part.eps) out.eps = true
    if (part.unknown) out.unknown = true
  }
  return out
}

/** `inner`, followed by something unmodeled: every prefix that stops at one token becomes `token, anything`. */
function open2 (inner) {
  const seqs = new Set()
  for (const a of inner.seqs) seqs.add(a.includes(SEP2) ? a : a + SEP2 + ANY2)
  return { seqs, eps: inner.eps, unknown: inner.unknown || inner.eps }
}

/** `inner` zero or more times. A repetition's third and later tokens never matter at depth two. */
function star2 (inner) {
  const out = union2(epsilon2(), inner, concat2(inner, inner))
  if (inner.eps) out.unknown = true // a repeated parser that can match nothing is a grammar error elsewhere
  return out
}

/**
 * FIRST_2 of a node, given the current per-rule estimates. Mirrors `firstOf`, case for case.
 * Where a construct is followed by tokens this function does not model (a separator, an operator,
 * a suffix), its one-token derivations stay one token long, which makes the second token a wildcard.
 *
 * @param {*} node
 * @param {Map<string, First2>} rules
 * @returns {First2}
 */
function firstOf2 (node, rules) {
  const op = opOf(node)
  if (op === null) return opaque2()
  const arg = node[op]

  switch (op) {
    case 'consume': {
      const name = Array.isArray(arg) ? arg[0] : arg
      const out = emptyFirst2()
      if (typeof name === 'string') out.seqs.add(name)
      else out.unknown = true
      return out
    }
    case 'epsilon':
    case 'action':
      return epsilon2()
    case 'text':
      return firstOf2(arg, rules)
    case 'label':
      return Array.isArray(arg) ? firstOf2(arg[1], rules) : opaque2()
    case 'seq': {
      if (!Array.isArray(arg)) return opaque2()
      let out = epsilon2()
      for (const child of arg) out = concat2(out, firstOf2(child, rules))
      return out
    }
    case 'alt': {
      if (!Array.isArray(arg)) return opaque2()
      return union2(emptyFirst2(), ...arg.map((child) => firstOf2(child, rules)))
    }
    case 'many':
    case 'option':
    case 'flag': {
      const inner = firstOf2(arg, rules)
      return op === 'many' ? star2(inner) : union2(epsilon2(), inner)
    }
    case 'many1': {
      const inner = firstOf2(arg, rules)
      return concat2(inner, star2(inner))
    }
    case 'oneOf': {
      const out = emptyFirst2()
      for (const name of Array.isArray(arg) ? arg : [arg]) {
        if (typeof name === 'string') out.seqs.add(name)
        else out.unknown = true
      }
      return out
    }
    case 'as':
      return firstOf2(Array.isArray(arg) ? arg[0] : arg && arg.parser, rules)
    case 'between':
      return firstOf2({ seq: [arg && arg.open, arg && arg.body, arg && arg.close] }, rules)
    case 'pick':
    case 'yields':
      return firstOf2({ seq: arg && Array.isArray(arg.parsers) ? arg.parsers : [] }, rules)
    case 'prefix': {
      // operator* operand
      const operator = firstOf2(arg && arg.operator, rules)
      const operand = firstOf2(arg && arg.operand, rules)
      return concat2(star2(operator), operand)
    }
    case 'postfix':
    case 'infixLeft':
    case 'infixRight': {
      // operand (suffix | operator operand)*: only the operand's own prefixes are listed, and one that
      // stops at a single token may be followed by an operator or suffix, so its second token is open.
      return open2(firstOf2(arg && arg.operand, rules))
    }
    case 'manySep':
    case 'many1Sep': {
      const inner = open2(firstOf2(arg && arg.rule, rules))
      return { seqs: inner.seqs, eps: op === 'manySep' || inner.eps, unknown: inner.unknown }
    }
    case 'subrule': {
      const name = Array.isArray(arg) ? arg[0] : arg
      const known = rules.get(name)
      if (!known) return opaque2()
      return { seqs: known.seqs, eps: known.eps, unknown: known.unknown }
    }
    case 'eof':
    case 'lookahead':
    case 'negLookahead':
      return opaque2()
    default:
      return epsilon2() // a value expression: touches no tokens
  }
}

/**
 * FIRST_2 of every rule, by a fixpoint over the grammar so recursive rules converge.
 * @param {Record<string, any>} grammar
 * @returns {Map<string, First2>}
 */
function computeFirsts2 (grammar) {
  /** @type {Map<string, First2>} */
  const rules = new Map()
  for (const name of Object.keys(grammar)) rules.set(name, emptyFirst2())
  for (let changed = true; changed;) {
    changed = false
    for (const name of Object.keys(grammar)) {
      const current = rules.get(name)
      const computed = firstOf2(grammar[name], rules)
      for (const a of computed.seqs) if (!current.seqs.has(a)) { current.seqs.add(a); changed = true }
      if (computed.eps && !current.eps) { current.eps = true; changed = true }
      if (computed.unknown && !current.unknown) { current.unknown = true; changed = true }
    }
  }
  return rules
}

/**
 * For a group of branches that all begin with one of `firstTokens`, which of them can still match once the
 * *second* token is known? Returns null when that cannot be answered soundly (a branch is unknown or can
 * match nothing at all) or when it would not narrow anything.
 *
 * A branch's bit is set for a second token when some prefix it can begin with is `first second`, or when
 * one of its prefixes ends after the first token (what follows is not known, so it stays a candidate).
 *
 * @param {any[]} branches      The group, in `alt` order.
 * @param {Map<string, First2>} firsts2
 * @param {Iterable<string>} firstTokens  The tokens this group is reached on.
 * @returns {{ bySecond: Map<string, number>, other: number, full: number } | null}
 */
export function secondTokenMasks (branches, firsts2, firstTokens) {
  if (branches.length < 2 || branches.length > 30) return null
  const firstSet = new Set(firstTokens)
  /** @type {Array<{ any: boolean, seconds: Set<string> }>} */
  const perBranch = []
  for (const branch of branches) {
    const f = firstOf2(branch, firsts2)
    if (f.unknown || f.eps || f.seqs.size === 0) return null
    const info = { any: false, seconds: new Set() }
    for (const seq of f.seqs) {
      const cut = seq.indexOf(SEP2)
      const first = cut === -1 ? seq : seq.slice(0, cut)
      if (!firstSet.has(first)) continue
      const second = cut === -1 ? null : seq.slice(cut + 1)
      // Ends after one token (what follows is unknown here) or is open-ended: either way any second token fits.
      if (second === null || second === ANY2) info.any = true
      else info.seconds.add(second)
    }
    if (!info.any && info.seconds.size === 0) return null // in the group but starts with none of its tokens: do not guess
    perBranch.push(info)
  }

  const full = (1 << branches.length) - 1
  const named = new Set()
  for (const info of perBranch) for (const second of info.seconds) named.add(second)

  let other = 0
  perBranch.forEach((info, i) => { if (info.any) other |= 1 << i })
  const bySecond = new Map()
  for (const second of named) {
    let mask = 0
    perBranch.forEach((info, i) => { if (info.any || info.seconds.has(second)) mask |= 1 << i })
    bySecond.set(second, mask)
  }

  // Worth emitting only if some second token rules out some branch.
  const narrows = other !== full || [...bySecond.values()].some((mask) => mask !== full)
  return narrows ? { bySecond, other, full } : null
}

/**
 * Collects the rules a node can invoke without having consumed anything first.
 * Used to find left recursion.
 * @param {*} node
 * @param {Map<string, First>} ruleFirsts
 * @param {Set<string>} out
 */
export function leftmostCalls (node, ruleFirsts, out) {
  const op = opOf(node)
  if (op === null) return
  const arg = node[op]

  switch (op) {
    case 'subrule': {
      const name = Array.isArray(arg) ? arg[0] : arg
      out.add(name)
      break
    }
    case 'label':
      leftmostCalls(arg[1], ruleFirsts, out)
      break
    case 'text':
    case 'many':
    case 'many1':
    case 'option':
    case 'flag':
    case 'lookahead':
    case 'negLookahead':
      leftmostCalls(arg, ruleFirsts, out)
      break
    case 'as':
      leftmostCalls(Array.isArray(arg) ? arg[0] : arg && arg.parser, ruleFirsts, out)
      break
    case 'between':
      if (arg) leftmostCalls({ seq: [arg.open, arg.body, arg.close] }, ruleFirsts, out)
      break
    case 'pick':
    case 'yields':
      if (arg && Array.isArray(arg.parsers)) leftmostCalls({ seq: arg.parsers }, ruleFirsts, out)
      break
    case 'prefix':
      if (arg) {
        leftmostCalls(arg.operator, ruleFirsts, out)
        leftmostCalls(arg.operand, ruleFirsts, out)
      }
      break
    case 'infixLeft':
    case 'infixRight':
    case 'postfix':
      if (arg) leftmostCalls(arg.operand, ruleFirsts, out)
      break
    case 'manySep':
    case 'many1Sep':
      if (arg) leftmostCalls(arg.rule, ruleFirsts, out)
      break
    case 'alt':
      if (Array.isArray(arg)) for (const child of arg) leftmostCalls(child, ruleFirsts, out)
      break
    case 'seq':
      if (Array.isArray(arg)) {
        for (const child of arg) {
          leftmostCalls(child, ruleFirsts, out)
          // Stop at the first element that must consume something.
          if (!firstOf(child, ruleFirsts).nullable) break
        }
      }
      break
  }
}

/**
 * Walks every node, reporting unknown rule/token references.
 * @param {*} node
 * @param {Record<string, any>} grammar
 * @param {Set<string>|null} tokenNames
 * @param {string[]} errors
 * @param {string} path
 */
function validateNode (node, grammar, tokenNames, errors, path) {
  const op = opOf(node)
  if (op === null) {
    if (Array.isArray(node)) node.forEach((c, i) => validateNode(c, grammar, tokenNames, errors, `${path}[${i}]`))
    return
  }
  const arg = node[op]

  switch (op) {
    case 'consume': {
      const name = Array.isArray(arg) ? arg[0] : arg
      if (typeof name !== 'string') errors.push(`${path}: 'consume' expects a token name, got ${JSON.stringify(name)}`)
      else if (tokenNames && !tokenNames.has(name)) errors.push(`${path}: 'consume' references unknown token '${name}'`)
      break
    }
    case 'subrule': {
      const name = Array.isArray(arg) ? arg[0] : arg
      if (typeof name !== 'string') errors.push(`${path}: 'subrule' expects a rule name, got ${JSON.stringify(name)}`)
      else if (!(name in grammar)) errors.push(`${path}: 'subrule' references unknown rule '${name}'`)
      break
    }
    case 'label': {
      if (!Array.isArray(arg) || arg.length !== 2 || typeof arg[0] !== 'string') {
        errors.push(`${path}: 'label' expects [name, parser]`)
      } else validateNode(arg[1], grammar, tokenNames, errors, `${path}.label(${arg[0]})`)
      break
    }
    case 'seq':
    case 'alt': {
      if (!Array.isArray(arg)) errors.push(`${path}: '${op}' expects an array`)
      else {
        if (op === 'alt' && arg.length === 0) errors.push(`${path}: 'alt' needs at least one branch`)
        arg.forEach((c, i) => validateNode(c, grammar, tokenNames, errors, `${path}.${op}[${i}]`))
      }
      break
    }
    case 'many':
    case 'many1':
    case 'option':
    case 'flag':
    case 'text':
    case 'lookahead':
    case 'negLookahead':
      validateNode(arg, grammar, tokenNames, errors, `${path}.${op}`)
      break
    case 'as': {
      const parser = Array.isArray(arg) ? arg[0] : arg && arg.parser
      if (parser === undefined) errors.push(`${path}: 'as' expects [parser, logic]`)
      else validateNode(parser, grammar, tokenNames, errors, `${path}.as`)
      break
    }
    case 'between': {
      if (!arg || typeof arg !== 'object' || !('open' in arg) || !('body' in arg) || !('close' in arg)) {
        errors.push(`${path}: 'between' expects { open, body, close }`)
      } else {
        validateNode(arg.open, grammar, tokenNames, errors, `${path}.between.open`)
        validateNode(arg.body, grammar, tokenNames, errors, `${path}.between.body`)
        validateNode(arg.close, grammar, tokenNames, errors, `${path}.between.close`)
      }
      break
    }
    case 'pick': {
      if (!arg || !Array.isArray(arg.parsers) || arg.parsers.length === 0) {
        errors.push(`${path}: 'pick' expects { parsers: [parser, ...], index }`)
      } else if (!Number.isInteger(arg.index) || arg.index < 0 || arg.index >= arg.parsers.length) {
        errors.push(`${path}: 'pick' index ${JSON.stringify(arg.index)} is out of range for ${arg.parsers.length} parser(s)`)
      } else {
        arg.parsers.forEach((c, i) => validateNode(c, grammar, tokenNames, errors, `${path}.pick[${i}]`))
      }
      break
    }
    case 'yields': {
      if (!arg || !Array.isArray(arg.parsers) || arg.parsers.length === 0 || !('value' in arg)) {
        errors.push(`${path}: 'yields' expects { parsers: [parser, ...], value }`)
      } else if (!isConstant(arg.value)) {
        errors.push(`${path}: 'yields' value must be a string, number, boolean or null, got ${JSON.stringify(arg.value)}`)
      } else {
        arg.parsers.forEach((c, i) => validateNode(c, grammar, tokenNames, errors, `${path}.yields[${i}]`))
      }
      break
    }
    case 'prefix': {
      if (!arg || typeof arg !== 'object' || !('operator' in arg) || !('operand' in arg) || !('combine' in arg)) {
        errors.push(`${path}: 'prefix' expects { operator, operand, combine }`)
      } else {
        validateNode(arg.operator, grammar, tokenNames, errors, `${path}.prefix.operator`)
        validateNode(arg.operand, grammar, tokenNames, errors, `${path}.prefix.operand`)
      }
      break
    }
    case 'postfix': {
      if (!arg || typeof arg !== 'object' || !('operand' in arg) || !('suffix' in arg) || !('combine' in arg)) {
        errors.push(`${path}: 'postfix' expects { operand, suffix, combine }`)
      } else {
        validateNode(arg.operand, grammar, tokenNames, errors, `${path}.postfix.operand`)
        validateNode(arg.suffix, grammar, tokenNames, errors, `${path}.postfix.suffix`)
      }
      break
    }
    case 'oneOf': {
      const names = Array.isArray(arg) ? arg : [arg]
      for (const name of names) {
        if (typeof name !== 'string') errors.push(`${path}: 'oneOf' expects token names`)
        else if (tokenNames && !tokenNames.has(name)) errors.push(`${path}: 'oneOf' references unknown token '${name}'`)
      }
      break
    }
    case 'eof':
      break
    case 'infixRight':
    case 'infixLeft': {
      if (!arg || typeof arg !== 'object' || !('operand' in arg) || !('combine' in arg)) {
        errors.push(`${path}: '${op}' expects { operand, combine, operator? }`)
      } else {
        validateNode(arg.operand, grammar, tokenNames, errors, `${path}.${op}.operand`)
        if (arg.operator !== undefined) validateNode(arg.operator, grammar, tokenNames, errors, `${path}.${op}.operator`)
      }
      break
    }
    case 'manySep':
    case 'many1Sep': {
      if (!arg || typeof arg !== 'object' || !('rule' in arg) || !('sep' in arg)) {
        errors.push(`${path}: '${op}' expects { rule, sep }`)
      } else {
        validateNode(arg.rule, grammar, tokenNames, errors, `${path}.${op}.rule`)
        if (typeof arg.sep === 'string') {
          if (tokenNames && !tokenNames.has(arg.sep)) errors.push(`${path}: '${op}' separator references unknown token '${arg.sep}'`)
        } else validateNode(arg.sep, grammar, tokenNames, errors, `${path}.${op}.sep`)
      }
      break
    }
    // Everything else is a value expression; the logic engine validates it.
  }
}

/**
 * @param {Record<string, any>} grammar
 * @param {{ tokenNames?: string[] }} [options]
 * @returns {{ firsts: Map<string, First>, firsts2: Map<string, First2>, errors: string[], leftRecursive: string[] }}
 */
export function analyze (grammar, options = {}) {
  const errors = []
  const tokenNames = options.tokenNames ? new Set(options.tokenNames) : null

  for (const name of Object.keys(grammar)) {
    validateNode(grammar[name], grammar, tokenNames, errors, name)
  }

  const firsts = computeFirsts(grammar)
  const firsts2 = computeFirsts2(grammar)

  // A rule is left-recursive when it can reach itself without consuming a token.
  const leftEdges = new Map()
  for (const name of Object.keys(grammar)) {
    const out = new Set()
    leftmostCalls(grammar[name], firsts, out)
    leftEdges.set(name, out)
  }

  const leftRecursive = []
  for (const start of Object.keys(grammar)) {
    const seen = new Set()
    const stack = [...(leftEdges.get(start) || [])]
    while (stack.length) {
      const next = stack.pop()
      if (next === start) {
        leftRecursive.push(start)
        break
      }
      if (seen.has(next)) continue
      seen.add(next)
      for (const edge of leftEdges.get(next) || []) stack.push(edge)
    }
  }

  for (const name of leftRecursive) {
    errors.push(`rule '${name}' is left-recursive; this parser is LL-style and would not terminate. Rewrite it with 'many'/'many1Sep' (the standard left-recursion elimination).`)
  }

  return { firsts, firsts2, errors, leftRecursive }
}

/**
 * Builds an O(1) dispatch table for an `alt`, or null when no branch has a
 * known, non-nullable FIRST set (a nullable/opaque branch could match
 * anything, so no table is safe at all).
 *
 * A token whose FIRST set membership is unique to one branch maps straight to
 * that branch. A token shared by more than one branch — the choice needs more
 * than one token of lookahead there — maps to an array of the colliding
 * branches, in their original `alt` order; a caller resolves that case with
 * ordered backtracking over just that subset, rather than over every branch.
 * Equal-content collision groups are the same array instance, so a caller
 * that dedupes on the table's values (e.g. to share generated code between
 * case labels) gets that for free.
 *
 * @param {any[]} branches
 * @param {Map<string, First>} firsts
 * @returns {Map<string, any>|null}
 */
export function buildDispatch (branches, firsts) {
  const perBranch = branches.map((branch) => firstOf(branch, firsts))
  for (const first of perBranch) {
    if (first.nullable || first.unknown || first.tokens.size === 0) return null
  }

  /** @type {Map<string, any[]>} */
  const byToken = new Map()
  for (let i = 0; i < branches.length; i++) {
    for (const token of perBranch[i].tokens) {
      let list = byToken.get(token)
      if (list === undefined) { list = []; byToken.set(token, list) }
      list.push(branches[i])
    }
  }
  if (byToken.size === 0) return null

  const canonical = new Map()
  const table = new Map()
  for (const [token, list] of byToken) {
    if (list.length === 1) { table.set(token, list[0]); continue }
    const key = list.map((branch) => branches.indexOf(branch)).join(',')
    let group = canonical.get(key)
    if (group === undefined) { group = list; canonical.set(key, group) }
    table.set(token, group)
  }

  return table
}

export { firstOf }
