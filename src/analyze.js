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
  'consume', 'seq', 'alt', 'many', 'many1', 'option',
  'manySep', 'many1Sep', 'infixLeft', 'infixRight', 'postfix', 'prefix',
  'between', 'as', 'oneOf', 'eof',
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
    case 'option': {
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

  return null
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

/**
 * Collects the rules a node can invoke without having consumed anything first.
 * Used to find left recursion.
 * @param {*} node
 * @param {Map<string, First>} ruleFirsts
 * @param {Set<string>} out
 */
function leftmostCalls (node, ruleFirsts, out) {
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
 * @returns {{ firsts: Map<string, First>, errors: string[], leftRecursive: string[] }}
 */
export function analyze (grammar, options = {}) {
  const errors = []
  const tokenNames = options.tokenNames ? new Set(options.tokenNames) : null

  for (const name of Object.keys(grammar)) {
    validateNode(grammar[name], grammar, tokenNames, errors, name)
  }

  const firsts = computeFirsts(grammar)

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

  return { firsts, errors, leftRecursive }
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
