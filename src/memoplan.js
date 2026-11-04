// @ts-check
'use strict'

import { opOf, firstOf, buildDispatch, leftmostCalls } from './analyze.js'
import { usesOuterScope } from './plan.js'

/**
 * Chooses the rules worth memoizing, so a grammar does not have to switch on
 * packrat memoization everywhere to escape one exponential spot.
 *
 * The spot is an `alt` whose branches the dispatch table cannot tell apart and
 * that all begin with the same sub-parser:
 *
 *   Predicate = alt(Comparison, In, Between, Like, IsNull, Additive)
 *
 * where every branch starts by parsing an `Additive`. Ordered backtracking
 * parses that `Additive` again for each branch it tries, and since an
 * `Additive` can contain a parenthesised `Predicate`, the repetition compounds
 * at every level of nesting: about 6x per level in the SQL example, 255 ms for
 * seven nested parentheses. Left-factoring cannot help when the shared prefix is
 * labelled or sits behind a rule boundary, as here.
 *
 * Remembering the shared rule's result per position makes every branch after the
 * first a lookup. Only that rule needs it — global memoization costs about 2x on
 * grammars that do not need it.
 *
 * Which rule: for each group of colliding branches, the rules each branch can
 * start by invoking (transitively, without consuming a token). A rule shared by
 * two or more branches is a candidate; among candidates only the *topmost* is
 * kept, since memoizing it already covers everything it starts with.
 *
 * And only a candidate whose own work contains such an `alt` again. Re-parsing a
 * shared rule once per branch is a constant factor; it becomes an exponent only
 * when the re-parsed work re-parses *its* shared rule in turn. That happens along
 * a cycle — `Predicate` -> `Additive` -> `(` `Predicate` `)` — or down a chain of
 * such alts (`r0 := r1 ';' | r1`, `r1 := r2 ';' | r2`, ...). A shared rule that is
 * a leaf of that structure costs a constant factor, and a memo table costs more
 * than that: on the formula example, memoizing the two shared name rules made
 * short inputs ~10% slower.
 *
 * Memoization replays a stored result instead of running the rule, so it is
 * valid only for a rule whose result depends on nothing but the position. A rule
 * that can reach an action reading an enclosing scope (`{val: [[-1], ...]}`)
 * depends on its caller, and is left alone.
 *
 * @param {Record<string, any>} grammar
 * @param {Map<string, import('./analyze.js').First>} firsts
 * @param {{ ll1?: boolean }} [options] `ll1: false` means no dispatch table, so
 *   every `alt` backtracks over all of its branches.
 * @returns {string[]} Rule names, in declaration order.
 */
export function selectMemoRules (grammar, firsts, options = {}) {
  const ll1 = options.ll1 !== false
  const names = Object.keys(grammar)

  /** Rules a rule can invoke first, with no token consumed before. */
  const leftEdges = new Map()
  /** Every rule a rule mentions anywhere. */
  const callEdges = new Map()
  for (const name of names) {
    const left = new Set()
    leftmostCalls(grammar[name], firsts, left)
    leftEdges.set(name, [...left].filter((r) => r in grammar))

    const calls = new Set()
    walk(grammar[name], (node) => {
      if (opOf(node) !== 'subrule') return
      const arg = node.subrule
      const target = Array.isArray(arg) ? arg[0] : arg
      if (typeof target === 'string' && target in grammar) calls.add(target)
    })
    callEdges.set(name, [...calls])
  }

  const closure = (edges, from) => {
    const seen = new Set()
    const stack = [...from]
    while (stack.length > 0) {
      const next = stack.pop()
      if (seen.has(next)) continue
      seen.add(next)
      for (const edge of edges.get(next) || []) stack.push(edge)
    }
    return seen
  }

  const leftCache = new Map()
  const leftReach = (name) => {
    let reach = leftCache.get(name)
    if (reach === undefined) {
      reach = closure(leftEdges, leftEdges.get(name) || [])
      leftCache.set(name, reach)
    }
    return reach
  }

  /** Rules a branch can start by invoking. */
  const startsWith = (branch) => {
    const direct = new Set()
    leftmostCalls(branch, firsts, direct)
    const all = new Set()
    for (const rule of direct) {
      if (!(rule in grammar)) continue
      all.add(rule)
      for (const deeper of leftReach(rule)) all.add(deeper)
    }
    return all
  }

  // Every rule hosting an `alt` whose colliding branches share a rule, with the
  // topmost shared rules of each such `alt`.
  const sites = []
  for (const name of names) {
    walk(grammar[name], (node) => {
      if (opOf(node) !== 'alt' || !Array.isArray(node.alt) || node.alt.length < 2) return

      for (const group of collisionGroups(node.alt, firsts, ll1)) {
        const counts = new Map()
        for (const branch of group) {
          for (const rule of startsWith(branch)) counts.set(rule, (counts.get(rule) || 0) + 1)
        }
        const shared = [...counts].filter(([, n]) => n >= 2).map(([rule]) => rule)
        const topmost = shared.filter((rule) => !shared.some((other) =>
          other !== rule && leftReach(other).has(rule) && !leftReach(rule).has(other)))
        if (topmost.length > 0) sites.push({ host: name, rules: topmost })
      }
    })
  }

  // Worth a table only if its work can reach a site again — see above.
  const hosts = new Set(sites.map((site) => site.host))
  const chosen = new Set()
  for (const { rules } of sites) {
    for (const rule of rules) {
      const inside = closure(callEdges, [rule])
      inside.add(rule)
      for (const host of hosts) {
        if (inside.has(host)) { chosen.add(rule); break }
      }
    }
  }

  // A rule is only safe to replay if nothing it can run reads the caller's scope.
  const dependsOnCaller = (name) => {
    const reachable = closure(callEdges, [name])
    reachable.add(name)
    for (const rule of reachable) if (usesOuterScope(grammar[rule])) return true
    return false
  }

  return names.filter((name) => chosen.has(name) && !dependsOnCaller(name))
}

/**
 * The groups of an `alt`'s branches that dispatch cannot separate and that are
 * therefore tried in order: each array in the dispatch table, or — with no table
 * (a nullable or unanalysable branch, or `ll1` off) — every branch together.
 */
function collisionGroups (branches, firsts, ll1) {
  const table = ll1 ? buildDispatch(branches, firsts) : null
  if (table === null) return [branches]
  const groups = new Set()
  for (const entry of table.values()) if (Array.isArray(entry) && entry.length > 1) groups.add(entry)
  return [...groups]
}

/** Calls `visit` on every parser node under `node`, itself included. */
function walk (node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  const op = opOf(node)
  if (op === null) return
  visit(node)
  const arg = node[op]

  switch (op) {
    case 'seq':
    case 'alt':
      if (Array.isArray(arg)) for (const child of arg) walk(child, visit)
      break
    case 'label':
      if (Array.isArray(arg)) walk(arg[1], visit)
      break
    case 'many':
    case 'many1':
    case 'option':
    case 'flag':
    case 'text':
    case 'lookahead':
    case 'negLookahead':
      walk(arg, visit)
      break
    case 'as':
      walk(Array.isArray(arg) ? arg[0] : arg && arg.parser, visit)
      break
    case 'between':
      if (arg) for (const part of [arg.open, arg.body, arg.close]) walk(part, visit)
      break
    case 'pick':
    case 'yields':
      if (arg && Array.isArray(arg.parsers)) for (const part of arg.parsers) walk(part, visit)
      break
    case 'prefix':
      if (arg) { walk(arg.operator, visit); walk(arg.operand, visit) }
      break
    case 'postfix':
      if (arg) { walk(arg.operand, visit); walk(arg.suffix, visit) }
      break
    case 'infixLeft':
    case 'infixRight':
      if (arg) { walk(arg.operand, visit); if (arg.operator !== undefined) walk(arg.operator, visit) }
      break
    case 'manySep':
    case 'many1Sep':
      if (arg) { walk(arg.rule, visit); if (typeof arg.sep !== 'string') walk(arg.sep, visit) }
      break
  }
}
