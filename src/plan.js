// @ts-check
'use strict'

import { FAIL, expect } from './state.js'
import { buildDispatch, opOf, recognizeSeqIdiom, recognizeAltPrefixIdiom } from './analyze.js'

/**
 * The specializing planner.
 *
 * Profiling the interpreted parser showed the cost was not in the parsing logic
 * itself but in re-deciding things that never change: `Object.keys` on every
 * child of every `seq` to find its operator, a WeakMap lookup per node to find
 * its cached execution plan, and another to find an `alt`'s dispatch table.
 * All of that is a function of the *grammar*, which is fixed.
 *
 * The planner walks the grammar once and produces a tree of closures with those
 * decisions already baked in: an `alt` closes over its dispatch Map, a `seq`
 * closes over a pre-classified list of steps, a `consume` closes over its token
 * name. Parsing is then just calling closures.
 *
 * These closures are what the combinators' `compile` hooks hand to
 * json-logic-engine's compiler, so `engine.build(rule)` produces a function that
 * calls straight into them.
 */

const SYNC = Symbol.for('json_logic_sync')

/** Marks a closure as synchronous so the engine's compiler inlines it directly. */
function declareSync (fn) {
  fn[SYNC] = true
  return fn
}

/**
 * True when the logic reads from an outer scope (`{val: [[-1], ...]}` or
 * `{var: "../x"}`). The engine's compiler does not thread `above` into built
 * functions, so such actions must stay interpreted.
 */
function usesOuterScope (logic) {
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

/**
 * True when the logic could return the *context object itself* rather than a
 * value derived from it — `{"var": ""}` and `{"val": []}` both do.
 *
 * That matters for sequences that reuse their binding object: handing the live
 * object to a caller would alias it, and the next invocation would appear to
 * mutate the value they were given. Only `var`/`val` can surface the context;
 * a method receives evaluated arguments, never the context.
 */
function mayReturnContext (logic) {
  if (Array.isArray(logic)) return logic.some(mayReturnContext)
  if (!logic || typeof logic !== 'object') return false

  for (const key of Object.keys(logic)) {
    const arg = logic[key]
    if (key === 'val' && Array.isArray(arg) && arg.length === 0) return true
    if (key === 'var' && (arg === '' || arg === null || (Array.isArray(arg) && (arg.length === 0 || arg[0] === '')))) return true
    if (mayReturnContext(arg)) return true
  }
  return false
}

/**
 * @param {{ engine: any, rules: Record<string, any>, firsts: Map<string, any>|null,
 *           memo: boolean, maxSteps: number, unsafeEval?: boolean,
 *           tokenIds?: Map<string, number>|null }} config
 */
export function createPlanner (config) {
  const { engine, rules, firsts, memo, maxSteps, unsafeEval = true, tokenIds = null } = config

  /** @type {Map<string, { fn: ((state: any) => any) | null }>} */
  const slots = new Map()
  /** @type {WeakMap<object, (state: any) => any>} */
  const planCache = new WeakMap()
  /** @type {Map<string, {byObject: WeakMap<object, any>, byPrimitive: Map<string, any>}>} */
  const opCaches = new Map()

  const guard = maxSteps > 0

  function tick (state) {
    if (guard && ++state.steps > maxSteps) {
      throw new Error(`Parser exceeded maxSteps (${maxSteps}); the grammar is likely looping.`)
    }
  }

  function assertProgress (state, before, op) {
    if (state.idx === before) {
      throw new Error(
        `'${op}' matched without consuming any input at token index ${before}; ` +
        'this would loop forever. Make the repeated parser consume at least one token.'
      )
    }
  }

  /** Resolves a rule to a slot, pre-registering it so recursion terminates. */
  function slotFor (name) {
    let slot = slots.get(name)
    if (slot !== undefined) return slot

    slot = { fn: null }
    slots.set(name, slot)

    const body = rules[name]
    if (body === undefined) {
      slot.fn = () => { throw new Error(`Unknown rule '${name}'`) }
      return slot
    }
    // The slot is already in the map, so a recursive reference finds it and
    // reads `slot.fn` at call time rather than at plan time.
    slot.fn = plan(body)
    return slot
  }

  /**
   * Compiles a semantic action to a `(bindings, state) => value` function.
   *
   * Interpreted rather than compiled when `unsafeEval` is off (the engine's
   * compiler builds through `eval`), when the action reads an outer scope
   * (`above` is not threaded into built functions), or when the compiler simply
   * cannot handle it.
   */
  function planAction (logic) {
    const interpret = (bindings, state) => engine.run(logic, bindings, { above: [state] })
    if (!unsafeEval || usesOuterScope(logic)) return interpret
    try {
      const built = engine.build(logic)
      return typeof built === 'function' ? (bindings) => built(bindings) : () => built
    } catch {
      return interpret
    }
  }

  /**
   * Plans a node given its operator and raw arguments, memoized on the
   * arguments themselves.
   *
   * This is the entry point the *interpreted* combinators use. A lazy method is
   * handed only its arguments, never the enclosing `{op: args}` object, so
   * rebuilding that object to call `plan()` would allocate a fresh key on every
   * invocation and miss the cache every time. Keying on the argument object —
   * which is stable, it is part of the grammar — gives the interpreted path the
   * same specialize-once behaviour the compiled path gets.
   *
   * @param {string} op
   * @param {*} args
   * @returns {(state: any) => any}
   */
  function planOp (op, args) {
    let cache = opCaches.get(op)
    if (cache === undefined) {
      cache = { byObject: new WeakMap(), byPrimitive: new Map() }
      opCaches.set(op, cache)
    }

    if (args !== null && typeof args === 'object') {
      let planned = cache.byObject.get(args)
      if (planned === undefined) {
        planned = planUncached({ [op]: args })
        cache.byObject.set(args, planned)
      }
      return planned
    }

    // Primitive arguments (`{consume: "Int"}`) cannot key a WeakMap.
    const key = typeof args + ':' + String(args)
    let planned = cache.byPrimitive.get(key)
    if (planned === undefined) {
      planned = planUncached({ [op]: args })
      cache.byPrimitive.set(key, planned)
    }
    return planned
  }

  /**
   * @param {*} node
   * @returns {(state: any) => any}
   */
  function plan (node) {
    if (node === null || typeof node !== 'object') {
      const constant = node
      return () => constant
    }

    const cached = planCache.get(node)
    if (cached !== undefined) return cached

    const planned = planUncached(node)
    planCache.set(node, planned)
    publish(node, planned)
    return planned
  }

  /**
   * Publishes a plan into the engine's own `optimizedMap`.
   *
   * Without this the planner is a shadow cache: the engine would still hold its
   * own entry for the same node — for a lazy method that entry is the slow
   * `(data, abv) => called(rawArgs, ...)` wrapper — and anything reaching the
   * node through `engine.run` or another method's `runOptimizedOrFallback`
   * would take that path instead, then bounce through the combinator to reach
   * the plan anyway.
   *
   * Injecting makes the specialization visible to the engine on its own terms:
   * the node is now genuinely optimized as far as the rest of the engine is
   * concerned, so a grammar embedded inside larger JSON Logic gets the fast path
   * for free. The signature lines up because a plan ignores the extra `above`
   * argument the engine passes.
   */
  function publish (node, planned) {
    if (engine && engine.optimizedMap && !engine.disableInterpretedOptimization) {
      engine.optimizedMap.set(node, planned)
    }
  }
  /** @returns {(state: any) => any} */
  const buildConsume = (arg) => {
      const name = typeof arg === 'string' ? arg : arg[0]
      const id = tokenIds ? tokenIds.get(name) : undefined
      // `token.id` is undefined only for a hand-built token that bypassed
      // `createLexer` (parseTokens accepts any array shaped like a Token), in
      // which case falling back to the string compare keeps that documented
      // path working; every token this parser's own lexer produces has an id.
      return (state) => {
        const token = state.tokens[state.idx]
        if (token !== undefined && (token.id === id || (token.id === undefined && token.type === name))) {
          state.idx++
          return token
        }
        expect(state, name)
        return FAIL
      }
  }

  /** @returns {(state: any) => any} */
  const buildMany = (arg) => {
      const child = plan(arg)
      return (state) => {
        tick(state)
        const results = []
        for (;;) {
          const before = state.idx
          const value = child(state)
          if (value === FAIL) {
            state.idx = before
            return results
          }
          assertProgress(state, before, 'many')
          results.push(value)
        }
      }
  }

  /** @returns {(state: any) => any} */
  const buildMany1 = (arg) => {
      const child = plan(arg)
      return (state) => {
        tick(state)
        const start = state.idx
        const first = child(state)
        if (first === FAIL) {
          state.idx = start
          return FAIL
        }
        assertProgress(state, start, 'many1')
        const results = [first]
        for (;;) {
          const before = state.idx
          const value = child(state)
          if (value === FAIL) {
            state.idx = before
            return results
          }
          assertProgress(state, before, 'many1')
          results.push(value)
        }
      }
  }

  /** @returns {(state: any) => any} */
  const buildOption = (arg) => {
      const child = plan(arg)
      return (state) => {
        const start = state.idx
        const value = child(state)
        if (value === FAIL) {
          state.idx = start
          return null
        }
        return value
      }
  }

  /** @returns {(state: any) => any} */
  const buildInfixLeft = (arg) => {
      // A whole precedence level in one closure.
      //
      // Spelled out of the primitives this is
      //   seq(label(head, operand), label(tail, many(seq(op, operand, action))), action(fold))
      // which pays a bindings object, an empty `tail` array and a fold action
      // on every level *even when there is no operator* — and a precedence
      // chain is six or seven levels deep, so a bare operand pays all of it
      // several times over. Here the no-operator case is one operand parse
      // and one failed operator match, with nothing allocated.
      const operand = plan(arg.operand)
      const operator = arg.operator === undefined ? null : plan(arg.operator)
      const combine = planAction(arg.combine)
      return (state) => {
        tick(state)
        let left = operand(state)
        if (left === FAIL) return FAIL
        // Allocated on the first operator only, then reused for the rest of
        // this fold: `combine` reads it and does not retain it.
        let bindings = null
        for (;;) {
          const mark = state.idx
          let op = null
          if (operator !== null) {
            op = operator(state)
            if (op === FAIL) {
              state.idx = mark
              return left
            }
          }
          const right = operand(state)
          if (right === FAIL) {
            state.idx = mark
            return left
          }
          if (bindings === null) bindings = { left: null, op: null, right: null }
          bindings.left = left
          bindings.op = op
          bindings.right = right
          left = combine(bindings, state)
        }
      }
  }

  /** @returns {(state: any) => any} */
  const buildOneOf = (arg) => {
      // `{"oneOf": ["Plus", "Minus"]}` — any of a set of token types.
      // Terser than an `alt` of `consume`s, and a single set lookup.
      const names = Array.isArray(arg) ? arg : [arg]
      const set = new Set(names)
      const idSet = tokenIds ? new Set(names.map((n) => tokenIds.get(n))) : null
      const count = names.length
      return (state) => {
        const token = state.tokens[state.idx]
        if (token !== undefined && (idSet ? (token.id !== undefined ? idSet.has(token.id) : set.has(token.type)) : set.has(token.type))) {
          state.idx++
          return token
        }
        for (let i = 0; i < count; i++) expect(state, names[i])
        return FAIL
      }
  }

  /** @returns {(state: any) => any} */
  const buildEof = (arg) => {
      // Matches only at the end of the token stream, consuming nothing.
      return (state) => {
        if (state.idx >= state.tokens.length) return null
        expect(state, 'end of input')
        return FAIL
      }
  }

  /** @returns {(state: any) => any} */
  const buildInfixRight = (arg) => {
      // The mirror of `infixLeft`: `a ^ b ^ c` is `a ^ (b ^ c)`.
      const operand = plan(arg.operand)
      const operator = arg.operator === undefined ? null : plan(arg.operator)
      const combine = planAction(arg.combine)
      return (state) => {
        tick(state)
        const left = operand(state)
        if (left === FAIL) return FAIL
        // Flat [op, operand, op, operand, ...]; allocated only if an
        // operator is actually present.
        let items = null
        for (;;) {
          const mark = state.idx
          let op = null
          if (operator !== null) {
            op = operator(state)
            if (op === FAIL) {
              state.idx = mark
              break
            }
          }
          const right = operand(state)
          if (right === FAIL) {
            state.idx = mark
            break
          }
          if (items === null) items = []
          items.push(op, right)
        }
        if (items === null) return left
        const bindings = { left: null, op: null, right: null }
        let value = items[items.length - 1]
        for (let i = items.length - 2; i >= 0; i -= 2) {
          bindings.left = i === 0 ? left : items[i - 1]
          bindings.op = items[i]
          bindings.right = value
          value = combine(bindings, state)
        }
        return value
      }
  }

  /** @returns {(state: any) => any} */
  const buildAs = (arg) => {
      // `{"as": [parser, logic]}` — parse, then transform the result.
      //
      // The parsed value *is* the logic's context, so `{"val": "image"}`
      // reads a token's image directly and nothing is allocated. Spelled out
      // of primitives this is seq(label(x, parser), action(...)), which needs
      // a bindings object purely to give the value a name.
      //
      // Not called `map`: that is an ordinary JSON Logic operator, and
      // shadowing it would break any semantic action that uses it.
      const child = plan(Array.isArray(arg) ? arg[0] : arg.parser)
      const transform = planAction(Array.isArray(arg) ? arg[1] : arg.to)
      return (state) => {
        const value = child(state)
        if (value === FAIL) return FAIL
        return transform(value, state)
      }
  }

  /** @returns {(state: any) => any} */
  const buildBetween = (arg) => {
      // `{"between": {open, body, close}}` — yields the body.
      const open = plan(arg.open)
      const body = plan(arg.body)
      const close = plan(arg.close)
      return (state) => {
        tick(state)
        const start = state.idx
        if (open(state) === FAIL) {
          state.idx = start
          return FAIL
        }
        const value = body(state)
        if (value === FAIL) {
          state.idx = start
          return FAIL
        }
        if (close(state) === FAIL) {
          state.idx = start
          return FAIL
        }
        return value
      }
  }

  /** @returns {(state: any) => any} */
  const buildPrefix = (arg) => {
      // Any number of prefix operators, folded right onto the operand:
      // `- - x` is combine(-, combine(-, x)). `combine` sees `op` and `operand`.
      const operator = plan(arg.operator)
      const operand = plan(arg.operand)
      const combine = planAction(arg.combine)
      return (state) => {
        tick(state)
        const start = state.idx
        // Allocated only when a prefix is actually present.
        let ops = null
        for (;;) {
          const mark = state.idx
          const op = operator(state)
          if (op === FAIL) {
            state.idx = mark
            break
          }
          if (ops === null) ops = []
          ops.push(op)
        }
        let value = operand(state)
        if (value === FAIL) {
          state.idx = start
          return FAIL
        }
        if (ops !== null) {
          const bindings = { op: null, operand: null }
          for (let i = ops.length - 1; i >= 0; i--) {
            bindings.op = ops[i]
            bindings.operand = value
            value = combine(bindings, state)
          }
        }
        return value
      }
  }

  /** @returns {(state: any) => any} */
  const buildPostfix = (arg) => {
      // `operand` followed by any number of suffixes, folded left.
      //
      // Same shape of waste as `infixLeft` replaced: written out of
      // primitives this is seq(label(operand), label(many(suffix)), action),
      // which allocates a bindings object and an array and runs a fold for
      // every operand — while the suffix (`%` here) is rare.
      const operand = plan(arg.operand)
      const suffix = plan(arg.suffix)
      const combine = planAction(arg.combine)
      return (state) => {
        tick(state)
        let left = operand(state)
        if (left === FAIL) return FAIL
        let bindings = null
        for (;;) {
          const mark = state.idx
          const found = suffix(state)
          if (found === FAIL) {
            state.idx = mark
            return left
          }
          if (bindings === null) bindings = { left: null, suffix: null }
          bindings.left = left
          bindings.suffix = found
          left = combine(bindings, state)
        }
      }
  }

  /** @returns {(state: any) => any} */
  const buildSubrule = (arg) => {
      const name = typeof arg === 'string' ? arg : arg[0]
      const slot = slotFor(name)
      if (memo) {
        return (state) => {
          tick(state)
          const key = name + ':' + state.idx
          const hit = state.memo.get(key)
          if (hit !== undefined) {
            state.idx = hit.end
            return hit.value
          }
          const start = state.idx
          // The rule stack exists only to describe a failure. A successful
          // parse never reads it, so maintaining it is skipped unless this is
          // the tracking re-parse — same reasoning as `expect`.
          let depth = 0
          if (state.track) {
            depth = state.ruleDepth
            state.ruleNames[depth] = name
            state.ruleDepth = depth + 1
          }
          const value = slot.fn(state)
          if (state.track) state.ruleDepth = depth
          if (value === FAIL) state.idx = start
          state.memo.set(key, { value, end: state.idx })
          return value
        }
      }
      return (state) => {
        tick(state)
        // See above: rule-stack bookkeeping is failure-path only.
        if (!state.track) return slot.fn(state)
        const depth = state.ruleDepth
        state.ruleNames[depth] = name
        state.ruleDepth = depth + 1
        const value = slot.fn(state)
        state.ruleDepth = depth
        return value
      }
  }

  /** @returns {(state: any) => any} */
  const buildLabel = (arg) => {
      const name = arg[0]
      const child = plan(arg[1])
      return (state) => {
        const value = child(state)
        if (value !== FAIL && state.bindings) state.bindings[name] = value
        return value
      }
  }

  /** @returns {(state: any) => any} */
  const buildAction = (arg) => {
      const action = planAction(arg)
      return (state) => action(state.bindings || {}, state)
  }

  /** @returns {(state: any) => any} */
  const buildLookahead = (arg) => {
      const child = plan(arg)
      return (state) => {
        const start = state.idx
        const value = child(state)
        state.idx = start
        return value
      }
  }

  /** @returns {(state: any) => any} */
  const buildNegLookahead = (arg) => {
      const child = plan(arg)
      return (state) => {
        const start = state.idx
        const value = child(state)
        state.idx = start
        return value === FAIL ? null : FAIL
      }
  }

  /** @returns {(state: any) => any} */
  const buildText = (arg) => {
      const child = plan(arg)
      return (state) => {
        const start = state.idx
        const value = child(state)
        if (value === FAIL) {
          state.idx = start
          return FAIL
        }
        if (state.idx === start) return ''
        const first = state.tokens[start]
        const last = state.tokens[state.idx - 1]
        if (state.source !== undefined) return state.source.slice(first.start, last.end)
        let out = ''
        for (let i = start; i < state.idx; i++) out += state.tokens[i].image
        return out
      }
  }

  /** @returns {(state: any) => any} */
  const buildValue = (node) => {
      // An ordinary JSON Logic value expression sitting in parser position.
      const built = planAction(node)
      return (state) => built(state.bindings || {}, state)
  }

  /**
   * One builder per operator. Each takes the operator's raw arguments and
   * returns the closure that parses it; dispatch happens once, at plan time.
   */
  const BUILDERS = {
    consume: buildConsume,
    epsilon: () => () => null,
    seq: planSeq,
    alt: planAlt,
    many: buildMany,
    many1: buildMany1,
    option: buildOption,
    infixLeft: buildInfixLeft,
    oneOf: buildOneOf,
    eof: buildEof,
    infixRight: buildInfixRight,
    as: buildAs,
    between: buildBetween,
    prefix: buildPrefix,
    postfix: buildPostfix,
    manySep: (arg) => planSeparated(arg, false),
    many1Sep: (arg) => planSeparated(arg, true),
    subrule: buildSubrule,
    label: buildLabel,
    action: buildAction,
    lookahead: buildLookahead,
    negLookahead: buildNegLookahead,
    text: buildText
  }

  function planUncached (node) {
    const op = opOf(node)
    // Not a single-operator node: a literal array or object used as a value.
    if (op === null) return () => node
    const build = BUILDERS[op]
    return build ? build(node[op]) : buildValue(node)
  }

  function planSeq (children) {
    if (!Array.isArray(children)) throw new Error("'seq' expects an array of parsers")

    // A `seq` written in one of the recognized idioms is planned as the cheaper
    // combinator instead, so grammars written with the general primitives get
    // the same treatment as ones written with the specific ones.
    const idiom = recognizeSeqIdiom(children)
    if (idiom !== null) return planUncached(idiom)

    // Step kinds. Terminals are inlined rather than dispatched to a closure:
    // most sequence children are a bare `consume` (or a labelled one), and
    // calling a closure for a two-field comparison is pure overhead — an
    // indirect call per token, through a call site that sees every terminal in
    // the grammar and so cannot be inlined by the JIT.
    const PARSER = 0
    const LABELLED = 1
    const ACTION = 2
    const TERMINAL = 3
    const LABELLED_TERMINAL = 4

    const kinds = []
    const names = []     // binding name, for the labelled kinds
    const tokens = []    // token type, for the terminal kinds
    const tokenIdList = [] // token.id equivalent of `tokens`, for the terminal kinds
    const fns = []
    const actionLogic = []   // raw logic of each action child, for the reuse check
    let hasAction = false
    let hasLabels = false

    /** `{consume: "X"}` -> "X", else null. */
    const terminalOf = (node) => {
      if (opOf(node) !== 'consume') return null
      const arg = node.consume
      const name = typeof arg === 'string' ? arg : (Array.isArray(arg) ? arg[0] : null)
      return typeof name === 'string' ? name : null
    }

    for (const child of children) {
      const childOp = opOf(child)

      if (childOp === 'label') {
        const [name, inner] = child.label
        const terminal = terminalOf(inner)
        hasLabels = true
        if (terminal !== null) {
          kinds.push(LABELLED_TERMINAL)
          names.push(name)
          tokens.push(terminal)
          tokenIdList.push(tokenIds ? tokenIds.get(terminal) : undefined)
          fns.push(null)
        } else {
          kinds.push(LABELLED)
          names.push(name)
          tokens.push(null)
          tokenIdList.push(undefined)
          fns.push(plan(inner))
        }
        continue
      }

      if (childOp === 'action') {
        kinds.push(ACTION)
        names.push(null)
        tokens.push(null)
        tokenIdList.push(undefined)
        fns.push(planAction(child.action))
        actionLogic.push(child.action)
        hasAction = true
        continue
      }

      const terminal = terminalOf(child)
      if (terminal !== null) {
        kinds.push(TERMINAL)
        names.push(null)
        tokens.push(terminal)
        tokenIdList.push(tokenIds ? tokenIds.get(terminal) : undefined)
        fns.push(null)
      } else {
        kinds.push(PARSER)
        names.push(null)
        tokens.push(null)
        tokenIdList.push(undefined)
        fns.push(plan(child))
      }
    }

    const count = fns.length
    // A sequence opens a binding scope only when it directly contains a
    // `label` or an `action`; otherwise the allocation would be dead weight.
    const needsScope = hasLabels || hasAction

    // When every child is a terminal or an action, nothing can re-enter this
    // sequence between writing a binding and the action reading it — no
    // `subrule`, `many` or `alt` to recurse through. The binding object can
    // then be created once for the plan and reused on every invocation instead
    // of allocated per parse.
    //
    // `label(consume) + action` — match one token and convert it — is the most
    // common sequence shape in a real grammar (23% of all `seq` invocations in
    // the formula benchmark), and it is exactly this case.
    //
    // The exception is an action that could hand back the binding object
    // itself, which would alias a reused object into the caller's result.
    const reusableScope = needsScope &&
      kinds.every((k) => k === TERMINAL || k === LABELLED_TERMINAL || k === ACTION) &&
      !actionLogic.some(mayReturnContext)
    const scratch = reusableScope ? {} : null

    // Terminals are matched inline in this loop rather than through a step
    // closure per child. Compiling each child into a uniform
    // `(state, bindings) => value` step was tried, to trade the per-step kind
    // branch for a baked-in one; it was ~12% *slower*, because it adds an
    // indirect call per child through a site that sees every step shape in the
    // grammar. A predictable branch beats a megamorphic call.
    return (state) => {
      tick(state)
      const start = state.idx
      const previousBindings = state.bindings
      const bindings = reusableScope ? scratch : (needsScope ? {} : previousBindings)
      if (needsScope) state.bindings = bindings

      // With an action present the result array is never observed.
      const results = hasAction ? null : []
      let actionResult

      for (let i = 0; i < count; i++) {
        const kind = kinds[i]
        let value

        if (kind === TERMINAL || kind === LABELLED_TERMINAL) {
          const token = state.tokens[state.idx]
          if (token !== undefined && (token.id === tokenIdList[i] || (token.id === undefined && token.type === tokens[i]))) {
            state.idx++
            value = token
          } else {
            expect(state, tokens[i])
            state.idx = start
            if (needsScope) state.bindings = previousBindings
            return FAIL
          }
          if (kind === LABELLED_TERMINAL) bindings[names[i]] = value
        } else if (kind === ACTION) {
          actionResult = fns[i](bindings, state)
          continue
        } else {
          value = fns[i](state)
          if (value === FAIL) {
            state.idx = start
            if (needsScope) state.bindings = previousBindings
            return FAIL
          }
          if (kind === LABELLED) bindings[names[i]] = value
        }

        if (results !== null) results.push(value)
      }

      if (needsScope) state.bindings = previousBindings
      return hasAction ? actionResult : results
    }
  }

  function planAlt (branches) {
    if (!Array.isArray(branches)) throw new Error("'alt' expects an array of branches")

    // A shared, possibly multi-token prefix across every branch is matched
    // once here rather than once per branch that has it — see the comment on
    // recognizeAltPrefixIdiom for the safety conditions.
    const factored = recognizeAltPrefixIdiom(branches)
    if (factored !== null) return planUncached(factored)

    const planned = branches.map(plan)
    const table = firsts ? buildDispatch(branches, firsts) : null

    if (table !== null) {
      // Resolve the dispatch table to closures once, and precompute the
      // expected-token list used when nothing matches.
      //
      // A null-prototype object rather than a Map: `Map.get` on a string hashes
      // the key on every lookup, and it showed up in profiles as 5% of parse
      // time (`FindOrderedHashMapEntry`). A plain object lookup on an
      // internalized string is an inline-cached property load instead. The null
      // prototype also means a token type of `toString` or `constructor` cannot
      // find an inherited value.
      const byToken = Object.create(null)
      const groupClosures = new Map()
      for (const [token, branch] of table) {
        if (Array.isArray(branch)) {
          let closure = groupClosures.get(branch)
          if (closure === undefined) {
            const group = branch.map((b) => planned[branches.indexOf(b)])
            closure = (state) => {
              const start = state.idx
              for (let i = 0; i < group.length; i++) {
                const value = group[i](state)
                if (value !== FAIL) return value
                state.idx = start
              }
              return FAIL
            }
            groupClosures.set(branch, closure)
          }
          byToken[token] = closure
        } else {
          byToken[token] = planned[branches.indexOf(branch)]
        }
      }
      const expectedTokens = [...table.keys()]
      const expectedCount = expectedTokens.length

      return (state) => {
        tick(state)
        const token = state.tokens[state.idx]
        if (token !== undefined) {
          const branch = byToken[token.type]
          if (branch !== undefined) return branch(state)
        }
        for (let i = 0; i < expectedCount; i++) expect(state, expectedTokens[i])
        return FAIL
      }
    }

    const count = planned.length
    return (state) => {
      tick(state)
      const start = state.idx
      for (let i = 0; i < count; i++) {
        const value = planned[i](state)
        if (value !== FAIL) return value
        state.idx = start
      }
      return FAIL
    }
  }

  function planSeparated (arg, atLeastOne) {
    if (!arg || typeof arg !== 'object') throw new Error("'manySep' expects { rule, sep }")
    const { rule, sep, trailing = false } = arg

    const item = plan(rule)
    // A string separator is by far the common case, so its token check is
    // inlined instead of dispatched through a `consume` closure — that is one
    // indirect call per list element removed.
    const sepToken = typeof sep === 'string' ? sep : null
    const separator = sepToken === null ? plan(sep) : null

    return (state) => {
      tick(state)
      const start = state.idx
      const first = item(state)
      if (first === FAIL) {
        state.idx = start
        return atLeastOne ? FAIL : []
      }

      const results = [first]
      for (;;) {
        const beforeSep = state.idx
        if (sepToken !== null) {
          const token = state.tokens[state.idx]
          if (token === undefined || token.type !== sepToken) {
            expect(state, sepToken)
            return results
          }
          state.idx++
        } else if (separator(state) === FAIL) {
          state.idx = beforeSep
          return results
        }
        const beforeItem = state.idx
        const value = item(state)
        if (value === FAIL) {
          state.idx = trailing ? beforeItem : beforeSep
          return results
        }
        results.push(value)
      }
    }
  }

  return {
    plan,
    planOp,
    planAction,
    planRule: (name) => slotFor(name),
    /** Wraps a plan so json-logic-engine's compiler can embed it. */
    declareSync
  }
}

export { declareSync, usesOuterScope }
