// @ts-check
'use strict'

import { FAIL, expect } from './state.js'
import { buildDispatch, opOf, recognizeSeqIdiom, recognizeAltPrefixIdiom, recognizeAltConsumeIdiom } from './analyze.js'

/**
 * A real source generator for grammars.
 *
 * The planner removes per-token *decisions*, but it still pays one indirect
 * call per grammar node, through call sites that see many closure shapes and so
 * cannot be inlined. That is the floor for a closure tree, and it is where the
 * remaining gap against hand-written parsers lives.
 *
 * This module emits one JavaScript function per rule with every node inlined as
 * straight-line statements — the shape a hand-written recursive-descent parser
 * has. `alt` becomes a real `switch` on the token type, which V8 compiles to a
 * jump table rather than a Map lookup. Only rule boundaries remain calls.
 *
 * Anything it does not know how to emit falls back to the planner's closure via
 * the helper table, so adding an operator here is optional and incremental.
 */

/**
 * @param {{ planner: any, rules: Record<string, any>, firsts: Map<string, any>|null,
 *           memo: boolean, maxSteps: number, tokenIds?: Map<string, number>|null,
 *           memoSlots?: Map<string, number>, inlineRules?: boolean, idioms?: boolean }} config
 */
export function createCodegen (config) {
  const { planner, rules, firsts, memo, maxSteps, tokenIds = null, memoSlots = new Map(), inlineRules = true, idioms = true } = config

  /**
   * `token.id === <n>` is an integer compare instead of a string compare, and
   * is what generated code prefers wherever a token's declared type matters.
   * Falls back to `token.type === <name>` only for a hand-built token that
   * bypassed this parser's own lexer (`parseTokens` accepts anything shaped
   * like a Token) — every token the bundled lexer produces has an id.
   */
  const typeCheck = (tokenVar, name) => {
    const id = tokenIds ? tokenIds.get(name) : undefined
    if (id === undefined) return `${tokenVar}.type === ${JSON.stringify(name)}`
    return `(${tokenVar}.id === ${id} || (${tokenVar}.id === undefined && ${tokenVar}.type === ${JSON.stringify(name)}))`
  }

  /** Runtime values the generated code closes over. */
  const HELPERS = []
  /** What each helper was built from; parallel to HELPERS. */
  const ORIGINS = []
  /** Generated rule functions, indexed; filled in as they are built. */
  const RULES = []
  /** The source each rule was built from, parallel to RULES. */
  const SOURCES = []
  const ruleIndex = new Map()
  const pending = []

  let counter = 0
  const nextId = () => '_' + (counter++)

  /**
   * Registers a runtime value and returns its accessor source.
   *
   * `origin` records what the value *is*, so `emitModule` can write an
   * equivalent table into a generated file. A closure cannot be serialized; the
   * JSON Logic it was compiled from can.
   */
  function helper (value, origin) {
    HELPERS.push(value)
    ORIGINS.push(origin)
    return `H[${HELPERS.length - 1}]`
  }

  /** A semantic action, recorded as the logic it came from. */
  const actionHelper = (logic) => helper(planner.planAction(logic), { kind: 'action', logic })

  /** A literal value sitting in parser position. */
  const constantHelper = (node) => helper(planner.plan(node), { kind: 'constant', node })

  /**
   * Operator-precedence levels (`Additive = infixLeft(subrule(Multiplicative), ...)`)
   * are written as a chain of rules, one per level, and each level costs a call, a
   * loop and a token check even when no operator of that level follows: measured at
   * ~10 ns per level per atom, so an 8-level chain costs several times the atom
   * itself. A level with exactly one caller can be written into that caller's body
   * instead, which keeps the loop and drops the call.
   *
   * Only these four shapes, and only a single call site: nothing is duplicated, and
   * the function that results stays small enough for V8 to optimize (a rule like
   * `Primary`, with an `alt` of many branches, is not a level and is left a call).
   */
  // How many levels go into one function. Unbounded, a long chain makes a function
  // larger than V8 will optimize at all (its `max-optimized-bytecode-size`), and the
  // gain turns back into a loss: measured on a synthetic chain, 8 levels in one
  // function ran at 66 ns per atom against 33 ns for 7. Six per function was the best
  // of the caps tried (2, 3, 4, 5, 6, 8) across chains of 3 to 16 levels.
  const MAX_INLINE_DEPTH = 6
  /** `oneOf` with more names than this is generated as a `switch` on the token id. */
  const ONE_OF_SWITCH_AT = 12
  const INLINE_OPS = new Set(['infixLeft', 'infixRight', 'prefix', 'postfix'])
  const callSites = new Map()
  ;(function count (node) {
    if (Array.isArray(node)) { for (const child of node) count(child); return }
    if (!node || typeof node !== 'object') return
    if ('subrule' in node) {
      const target = Array.isArray(node.subrule) ? node.subrule[0] : node.subrule
      if (typeof target === 'string') callSites.set(target, (callSites.get(target) || 0) + 1)
    }
    for (const key of Object.keys(node)) count(node[key])
  })(rules)
  /** Rules being written into a caller right now, so a cycle cannot recurse forever. */
  const inlining = new Set()
  /**
   * Some constructs write a child twice: `infixLeft` and `infixRight` their operand (once for the
   * first, once inside the loop), `many1` and `many1Sep` their item. Inline a rule into *both*
   * copies and a chain of such rules multiplies out — one copy per level at the first, two at the
   * next, four at the next: measured, the formula grammar's module nearly doubled and a six-level
   * chain grew fivefold. The second copy is the loop body, which only runs when more input follows,
   * so it stays a call; only the first copy, the one every parse goes through, is inlined.
   */
  let coldDepth = 0
  const cold = (write) => {
    coldDepth++
    try { return write() } finally { coldDepth-- }
  }
  const canInline = (name) =>
    inlineRules && coldDepth === 0 && !memo && !memoSlots.has(name) && !inlining.has(name) && inlining.size < MAX_INLINE_DEPTH &&
    callSites.get(name) === 1 && INLINE_OPS.has(opOf(rules[name]))

  function indexOfRule (name) {
    let index = ruleIndex.get(name)
    if (index !== undefined) return index
    index = RULES.length
    ruleIndex.set(name, index)
    RULES.push(null)
    pending.push(name)
    return index
  }

  const guard = maxSteps > 0
  const tickSrc = guard ? `if (++c.steps > ${maxSteps}) T();` : ''

  /**
   * Emits statements computing `node` into a fresh variable.
   * @param {*} node
   * @param {string[]} out Statement buffer.
   * @param {string|null} bindingsVar Current sequence's bindings variable, if any.
   * @returns {string} Name of the variable holding the result.
   */
  function gen (node, out, bindingsVar) {
    const op = opOf(node)
    const result = nextId()

    if (op === null) {
      out.push(`const ${result} = ${constantHelper(node)}(c);`)
      return result
    }

    const arg = node[op]

    switch (op) {
      case 'consume': {
        const name = typeof arg === 'string' ? arg : arg[0]
        const token = nextId()
        out.push(
          `let ${result};`,
          `const ${token} = c.tokens[c.idx];`,
          `if (${token} !== undefined && ${typeCheck(token, name)}) { c.idx++; ${result} = ${token}; }`,
          `else { E(c, ${JSON.stringify(name)}); ${result} = F; }`
        )
        return result
      }

      case 'epsilon':
        out.push(`const ${result} = null;`)
        return result

      case 'label': {
        const value = gen(arg[1], out, bindingsVar)
        if (bindingsVar) out.push(`if (${value} !== F) ${bindingsVar}[${JSON.stringify(arg[0])}] = ${value};`)
        else out.push(`if (${value} !== F && c.bindings) c.bindings[${JSON.stringify(arg[0])}] = ${value};`)
        out.push(`const ${result} = ${value};`)
        return result
      }

      case 'action': {
        const fn = actionHelper(arg)
        out.push(`const ${result} = ${fn}(${bindingsVar || 'c.bindings || {}'}, c);`)
        return result
      }

      case 'seq':
        return genSeq(arg, out, result)

      case 'alt':
        return genAlt(arg, out, result, bindingsVar)

      case 'option': {
        const start = nextId()
        out.push(`let ${result};`, `const ${start} = c.idx;`, '{')
        const value = gen(arg, out, bindingsVar)
        out.push(
          `if (${value} === F) { c.idx = ${start}; ${result} = null; } else ${result} = ${value};`,
          '}'
        )
        return result
      }

      case 'flag': {
        const start = nextId()
        out.push(`let ${result};`, `const ${start} = c.idx;`, '{')
        const value = gen(arg, out, bindingsVar)
        out.push(
          `if (${value} === F) { c.idx = ${start}; ${result} = false; } else ${result} = true;`,
          '}'
        )
        return result
      }

      case 'many':
      case 'many1': {
        const atLeastOne = op === 'many1'
        const before = nextId()
        const label = 'L' + nextId()
        out.push(tickSrc, `let ${result} = [];`, `${label}: {`)

        if (atLeastOne) {
          const start = nextId()
          out.push(`const ${start} = c.idx;`)
          const first = gen(arg, out, bindingsVar)
          out.push(
            `if (${first} === F) { c.idx = ${start}; ${result} = F; break ${label}; }`,
            `if (c.idx === ${start}) P(${JSON.stringify(op)}, ${start});`,
            `${result}.push(${first});`
          )
        }

        out.push('for (;;) {', `const ${before} = c.idx;`)
        const value = atLeastOne ? cold(() => gen(arg, out, bindingsVar)) : gen(arg, out, bindingsVar)
        out.push(
          `if (${value} === F) { c.idx = ${before}; break; }`,
          `if (c.idx === ${before}) P(${JSON.stringify(op)}, ${before});`,
          `${result}.push(${value});`,
          '}',
          '}'
        )
        return result
      }

      case 'infixLeft': {
        // One precedence level, inlined: operand, then a loop that only runs
        // when an operator actually follows. Nothing is allocated for the
        // common case of a bare operand.
        const label = 'L' + nextId()
        const left = nextId()
        const bindings = nextId()
        const mark = nextId()
        const combine = actionHelper(arg.combine)

        out.push(tickSrc, `let ${result};`, `${label}: {`)
        const first = gen(arg.operand, out, bindingsVar)
        out.push(
          `if (${first} === F) { ${result} = F; break ${label}; }`,
          `let ${left} = ${first};`,
          `let ${bindings} = null;`,
          'for (;;) {',
          `const ${mark} = c.idx;`
        )

        let operatorVar = 'null'
        if (arg.operator !== undefined) {
          operatorVar = gen(arg.operator, out, bindingsVar)
          out.push(`if (${operatorVar} === F) { c.idx = ${mark}; break; }`)
        }

        const right = cold(() => gen(arg.operand, out, bindingsVar))
        out.push(
          `if (${right} === F) { c.idx = ${mark}; break; }`,
          `if (${bindings} === null) ${bindings} = { left: null, op: null, right: null };`,
          `${bindings}.left = ${left}; ${bindings}.op = ${operatorVar}; ${bindings}.right = ${right};`,
          `${left} = ${combine}(${bindings}, c);`,
          '}',
          `${result} = ${left};`,
          '}'
        )
        return result
      }

      case 'oneOf': {
        const names = Array.isArray(arg) ? arg : [arg]
        const token = nextId()
        const ids = tokenIds ? names.map((n) => tokenIds.get(n)) : []
        const failed = `else { ${names.map((n) => `E(c, ${JSON.stringify(n)});`).join(' ')} ${result} = F; }`

        if (names.length > ONE_OF_SWITCH_AT && ids.every((id) => id !== undefined)) {
          // Past a handful of names a chain of comparisons costs more than a jump
          // table: measured, the chain matched `alt`'s switch at 12 names and lost
          // beyond. Integer cases only, as `alt` does it — a `case undefined` for a
          // hand-built token would stop V8 building the table — so the id is
          // normalised first, from the type name when the token has none.
          const hit = nextId()
          const cases = [...new Set(ids)].map((id) => `case ${id}:`).join(' ')
          out.push(
            `let ${result};`,
            `const ${token} = c.tokens[c.idx];`,
            `let ${hit} = false;`,
            `if (${token} !== undefined) { switch (${token}.id !== undefined ? ${token}.id : I[${token}.type]) { ${cases} ${hit} = true; } }`,
            `if (${hit}) { c.idx++; ${result} = ${token}; }`,
            failed
          )
          return result
        }

        const test = names.map((n) => typeCheck(token, n)).join(' || ')
        out.push(
          `let ${result};`,
          `const ${token} = c.tokens[c.idx];`,
          `if (${token} !== undefined && (${test})) { c.idx++; ${result} = ${token}; }`,
          failed
        )
        return result
      }

      case 'eof':
        out.push(
          `let ${result};`,
          `if (c.idx >= c.tokens.length) ${result} = null;`,
          `else { E(c, "end of input"); ${result} = F; }`
        )
        return result

      case 'infixRight': {
        const label = 'L' + nextId()
        const left = nextId()
        const items = nextId()
        const mark = nextId()
        const bindings = nextId()
        const value = nextId()
        const combine = actionHelper(arg.combine)

        out.push(tickSrc, `let ${result};`, `${label}: {`)
        const first = gen(arg.operand, out, bindingsVar)
        out.push(
          `if (${first} === F) { ${result} = F; break ${label}; }`,
          `const ${left} = ${first};`,
          `let ${items} = null;`,
          'for (;;) {',
          `const ${mark} = c.idx;`
        )
        let operatorVar = 'null'
        if (arg.operator !== undefined) {
          operatorVar = gen(arg.operator, out, bindingsVar)
          out.push(`if (${operatorVar} === F) { c.idx = ${mark}; break; }`)
        }
        const right = cold(() => gen(arg.operand, out, bindingsVar))
        out.push(
          `if (${right} === F) { c.idx = ${mark}; break; }`,
          `if (${items} === null) ${items} = [];`,
          `${items}.push(${operatorVar}, ${right});`,
          '}',
          `if (${items} === null) { ${result} = ${left}; break ${label}; }`,
          `const ${bindings} = { left: null, op: null, right: null };`,
          `let ${value} = ${items}[${items}.length - 1];`,
          `for (let i = ${items}.length - 2; i >= 0; i -= 2) {`,
          `${bindings}.left = i === 0 ? ${left} : ${items}[i - 1];`,
          `${bindings}.op = ${items}[i]; ${bindings}.right = ${value};`,
          `${value} = ${combine}(${bindings}, c);`,
          '}',
          `${result} = ${value};`,
          '}'
        )
        return result
      }

      case 'lookahead': {
        const start = nextId()
        out.push(`const ${start} = c.idx;`)
        const value = gen(arg, out, bindingsVar)
        out.push(`c.idx = ${start};`, `const ${result} = ${value};`)
        return result
      }

      case 'negLookahead': {
        const start = nextId()
        out.push(`const ${start} = c.idx;`)
        const value = gen(arg, out, bindingsVar)
        out.push(`c.idx = ${start};`, `const ${result} = ${value} === F ? null : F;`)
        return result
      }

      case 'text': {
        const label = 'L' + nextId()
        const start = nextId()
        const first = nextId()
        const last = nextId()
        out.push(`let ${result};`, `${label}: {`, `const ${start} = c.idx;`)
        const value = gen(arg, out, bindingsVar)
        out.push(
          `if (${value} === F) { c.idx = ${start}; ${result} = F; break ${label}; }`,
          `if (c.idx === ${start}) { ${result} = ''; break ${label}; }`,
          `const ${first} = c.tokens[${start}];`,
          `const ${last} = c.tokens[c.idx - 1];`,
          `if (c.source !== undefined) { ${result} = c.source.slice(${first}.start, ${last}.end); break ${label}; }`,
          `let ${result}_s = '';`,
          `for (let i = ${start}; i < c.idx; i++) ${result}_s += c.tokens[i].image;`,
          `${result} = ${result}_s;`,
          '}'
        )
        return result
      }

      case 'as': {
        const transform = actionHelper(Array.isArray(arg) ? arg[1] : arg.to)
        const value = gen(Array.isArray(arg) ? arg[0] : arg.parser, out, bindingsVar)
        out.push(`const ${result} = ${value} === F ? F : ${transform}(${value}, c);`)
        return result
      }

      case 'between': {
        const label = 'L' + nextId()
        const start = nextId()
        out.push(tickSrc, `let ${result};`, `${label}: {`, `const ${start} = c.idx;`)
        const open = gen(arg.open, out, bindingsVar)
        out.push(`if (${open} === F) { c.idx = ${start}; ${result} = F; break ${label}; }`)
        const body = gen(arg.body, out, bindingsVar)
        out.push(`if (${body} === F) { c.idx = ${start}; ${result} = F; break ${label}; }`)
        const close = gen(arg.close, out, bindingsVar)
        out.push(
          `if (${close} === F) { c.idx = ${start}; ${result} = F; break ${label}; }`,
          `${result} = ${body};`,
          '}'
        )
        return result
      }

      case 'pick':
      case 'yields': {
        // The parsers in order, then one of their results or a constant; no
        // bindings object, which is the point (see `recognizeSeqIdiom`).
        const label = 'L' + nextId()
        const start = nextId()
        out.push(tickSrc, `let ${result};`, `${label}: {`, `const ${start} = c.idx;`)
        const values = arg.parsers.map((parser) => {
          const value = gen(parser, out, bindingsVar)
          out.push(`if (${value} === F) { c.idx = ${start}; ${result} = F; break ${label}; }`)
          return value
        })
        out.push(`${result} = ${op === 'pick' ? values[arg.index] : JSON.stringify(arg.value)};`, '}')
        return result
      }

      case 'prefix': {
        const label = 'L' + nextId()
        const start = nextId()
        const ops = nextId()
        const mark = nextId()
        const bindings = nextId()
        const value = nextId()
        const combine = actionHelper(arg.combine)

        out.push(tickSrc, `let ${result};`, `${label}: {`, `const ${start} = c.idx;`, `let ${ops} = null;`, 'for (;;) {', `const ${mark} = c.idx;`)
        const op = gen(arg.operator, out, bindingsVar)
        out.push(
          `if (${op} === F) { c.idx = ${mark}; break; }`,
          `if (${ops} === null) ${ops} = [];`,
          `${ops}.push(${op});`,
          '}'
        )
        const operand = gen(arg.operand, out, bindingsVar)
        out.push(
          `if (${operand} === F) { c.idx = ${start}; ${result} = F; break ${label}; }`,
          `let ${value} = ${operand};`,
          `if (${ops} !== null) {`,
          `const ${bindings} = { op: null, operand: null };`,
          `for (let i = ${ops}.length - 1; i >= 0; i--) { ${bindings}.op = ${ops}[i]; ${bindings}.operand = ${value}; ${value} = ${combine}(${bindings}, c); }`,
          '}',
          `${result} = ${value};`,
          '}'
        )
        return result
      }

      case 'postfix': {
        const label = 'L' + nextId()
        const left = nextId()
        const bindings = nextId()
        const mark = nextId()
        const combine = actionHelper(arg.combine)

        out.push(tickSrc, `let ${result};`, `${label}: {`)
        const first = gen(arg.operand, out, bindingsVar)
        out.push(
          `if (${first} === F) { ${result} = F; break ${label}; }`,
          `let ${left} = ${first};`,
          `let ${bindings} = null;`,
          'for (;;) {',
          `const ${mark} = c.idx;`
        )
        const found = gen(arg.suffix, out, bindingsVar)
        out.push(
          `if (${found} === F) { c.idx = ${mark}; break; }`,
          `if (${bindings} === null) ${bindings} = { left: null, suffix: null };`,
          `${bindings}.left = ${left}; ${bindings}.suffix = ${found};`,
          `${left} = ${combine}(${bindings}, c);`,
          '}',
          `${result} = ${left};`,
          '}'
        )
        return result
      }

      case 'manySep':
      case 'many1Sep': {
        if (!arg || typeof arg !== 'object') throw new Error("'manySep' expects { rule, sep }")
        const atLeastOne = op === 'many1Sep'
        const sepNode = typeof arg.sep === 'string' ? { consume: arg.sep } : arg.sep
        const trailing = arg.trailing === true
        const start = nextId()
        const beforeSep = nextId()
        const beforeItem = nextId()
        const label = 'L' + nextId()

        out.push(tickSrc, `let ${result} = [];`, `${label}: {`, `const ${start} = c.idx;`)
        const first = gen(arg.rule, out, bindingsVar)
        out.push(
          `if (${first} === F) { c.idx = ${start}; ${result} = ${atLeastOne ? 'F' : '[]'}; break ${label}; }`,
          `${result}.push(${first});`,
          'for (;;) {',
          `const ${beforeSep} = c.idx;`
        )
        const sep = gen(sepNode, out, bindingsVar)
        out.push(`if (${sep} === F) { c.idx = ${beforeSep}; break; }`, `const ${beforeItem} = c.idx;`)
        const item = cold(() => gen(arg.rule, out, bindingsVar))
        out.push(
          `if (${item} === F) { c.idx = ${trailing ? beforeItem : beforeSep}; break; }`,
          `${result}.push(${item});`,
          '}',
          '}'
        )
        return result
      }

      case 'subrule': {
        const name = typeof arg === 'string' ? arg : arg[0]
        if (!(name in rules)) {
          // Preserve the runtime error rather than failing to generate.
          out.push(`const ${result} = ${helper(planner.plan(node), { kind: 'unknownRule', name })}(c);`)
          return result
        }
        const parent = nextId()
        if (canInline(name)) {
          out.push(tickSrc)
          out.push(
            `const ${parent} = c.ruleDepth;`,
            `if (c.track) { c.ruleNames[${parent}] = ${JSON.stringify(name)}; c.ruleDepth = ${parent} + 1; }`
          )
          inlining.add(name)
          const inner = gen(rules[name], out, null)
          inlining.delete(name)
          out.push(`if (c.track) c.ruleDepth = ${parent};`)
          return inner
        }
        const index = indexOfRule(name)
        out.push(tickSrc)
        if (memo) {
          const key = nextId()
          const hit = nextId()
          const start = nextId()
          out.push(
            `let ${result};`,
            `const ${key} = ${JSON.stringify(name + ':')} + c.idx;`,
            `const ${hit} = c.memo.get(${key});`,
            `if (${hit} !== undefined) { c.idx = ${hit}.end; ${result} = ${hit}.value; }`,
            'else {',
            `const ${start} = c.idx;`,
            `const ${parent} = c.ruleDepth;`,
            `if (c.track) { c.ruleNames[${parent}] = ${JSON.stringify(name)}; c.ruleDepth = ${parent} + 1; }`,
            `${result} = R[${index}](c);`,
            `if (c.track) c.ruleDepth = ${parent};`,
            `if (${result} === F) c.idx = ${start};`,
            `c.memo.set(${key}, { value: ${result}, end: c.idx });`,
            '}'
          )
        } else if (memoSlots.has(name)) {
          // Chosen by `selectMemoRules`: remember the result per position.
          const table = nextId()
          const at = nextId()
          const end = nextId()
          out.push(
            `let ${result};`,
            `const ${table} = c.rm[${memoSlots.get(name)}];`,
            `const ${at} = c.idx;`,
            `const ${end} = ${table}.ends[${at}];`,
            `if (${end} !== 0) { c.idx = ${end} - 1; ${result} = ${table}.vals[${at}]; }`,
            'else {',
            `const ${parent} = c.ruleDepth;`,
            `if (c.track) { c.ruleNames[${parent}] = ${JSON.stringify(name)}; c.ruleDepth = ${parent} + 1; }`,
            `${result} = R[${index}](c);`,
            `if (c.track) c.ruleDepth = ${parent};`,
            `if (${result} === F) c.idx = ${at};`,
            `${table}.ends[${at}] = c.idx + 1;`,
            `${table}.vals[${at}] = ${result};`,
            '}'
          )
        } else {
          out.push(
            `const ${parent} = c.ruleDepth;`,
            `if (c.track) { c.ruleNames[${parent}] = ${JSON.stringify(name)}; c.ruleDepth = ${parent} + 1; }`,
            `const ${result} = R[${index}](c);`,
            `if (c.track) c.ruleDepth = ${parent};`
          )
        }
        return result
      }

      default:
        // Not generated: defer to the planner's closure.
        out.push(`const ${result} = ${helper(planner.plan(node))}(c);`)
        return result
    }
  }

  function genSeq (children, out, result) {
    if (!Array.isArray(children)) throw new Error("'seq' expects an array of parsers")

    // Same idiom recognition as the planner, so both paths agree.
    const idiom = idioms ? recognizeSeqIdiom(children) : null
    if (idiom !== null) return gen(idiom, out, null)

    let hasLabels = false
    let hasAction = false
    for (const child of children) {
      const childOp = opOf(child)
      if (childOp === 'label') hasLabels = true
      else if (childOp === 'action') hasAction = true
    }
    const needsScope = hasLabels || hasAction

    const start = nextId()
    const label = 'L' + nextId()
    const bindingsVar = needsScope ? nextId() : null
    const saved = nextId()
    const collected = []

    out.push(tickSrc, `let ${result};`, `${label}: {`, `const ${start} = c.idx;`)
    if (needsScope) {
      out.push(`const ${saved} = c.bindings;`, `const ${bindingsVar} = {};`, `c.bindings = ${bindingsVar};`)
    }

    let actionResult = null
    for (const child of children) {
      const childOp = opOf(child)
      if (childOp === 'action') {
        actionResult = gen(child, out, bindingsVar)
        continue
      }
      const value = gen(child, out, bindingsVar)
      out.push(
        `if (${value} === F) { c.idx = ${start};` +
        (needsScope ? ` c.bindings = ${saved};` : '') +
        ` ${result} = F; break ${label}; }`
      )
      collected.push(value)
    }

    if (needsScope) out.push(`c.bindings = ${saved};`)
    out.push(`${result} = ${hasAction ? actionResult : '[' + collected.join(', ') + ']'};`, '}')
    return result
  }

  /**
   * Emits an inline ordered-backtracking block over `list`, into a fresh
   * variable. Used both for a whole `alt` with no dispatch table, and for the
   * residual subset of branches a dispatch table cannot separate by one
   * token.
   */
  function genOrderedBacktrack (list, out, bindingsVar) {
    const result = nextId()
    const label = 'L' + nextId()
    const start = nextId()
    out.push(`let ${result};`, `${label}: {`, `const ${start} = c.idx;`)
    for (const branch of list) {
      out.push('{')
      const value = gen(branch, out, bindingsVar)
      out.push(`if (${value} !== F) { ${result} = ${value}; break ${label}; }`, `c.idx = ${start};`, '}')
    }
    out.push(`${result} = F;`, '}')
    return result
  }

  function genAlt (branches, out, result, bindingsVar) {
    if (!Array.isArray(branches)) throw new Error("'alt' expects an array of branches")

    const oneOf = idioms ? recognizeAltConsumeIdiom(branches) : null
    if (oneOf !== null) return gen(oneOf, out, bindingsVar)

    const factored = idioms ? recognizeAltPrefixIdiom(branches) : null
    if (factored !== null) return gen(factored, out, bindingsVar)

    const table = firsts ? buildDispatch(branches, firsts) : null
    const label = 'L' + nextId()

    if (table !== null) {
      // A switch on the token type: V8 turns a dense string switch into a
      // hash lookup with inlined bodies, and every branch is inlined here.
      // A table value that is an array is a residual group — tokens shared by
      // more than one branch — resolved by ordered backtracking over just
      // that subset instead of a single inlined branch.
      //
      // Switching on token.id (an integer) instead of token.type (a string)
      // when every expected token resolves to one — a numeric switch is a jump
      // table without even the string-hashing step a dense string switch still
      // does. `I[token.type]` is the same fallback typeCheck uses: a hand-built
      // token from parseTokens has no id, and I is a name -> id table built
      // once from the same tokenIds this parser resolved every other id from.
      const expected = [...table.keys()]
      const expectedIds = tokenIds ? expected.map((t) => tokenIds.get(t)) : null
      const numeric = expectedIds !== null && expectedIds.every((id) => id !== undefined)
      const token = nextId()
      out.push(tickSrc, `let ${result};`, `${label}: {`, `const ${token} = c.tokens[c.idx];`)
      out.push(`if (${token} === undefined) { ${expected.map((t) => `E(c, ${JSON.stringify(t)});`).join(' ')} ${result} = F; break ${label}; }`)

      let discriminant
      if (numeric) {
        discriminant = nextId()
        out.push(`const ${discriminant} = ${token}.id !== undefined ? ${token}.id : I[${token}.type];`)
        out.push(`switch (${discriminant}) {`)
      } else {
        discriminant = `${token}.type`
        out.push(`switch (${discriminant}) {`)
      }

      const byBranch = new Map()
      for (const tokenName of expected) {
        const branch = table.get(tokenName)
        if (!byBranch.has(branch)) byBranch.set(branch, [])
        byBranch.get(branch).push(tokenName)
      }
      const caseLabel = (t) => numeric ? tokenIds.get(t) : JSON.stringify(t)
      for (const [branch, tokenNames] of byBranch) {
        out.push(tokenNames.map((t) => `case ${caseLabel(t)}:`).join(' ') + ' {')
        const value = Array.isArray(branch) ? genOrderedBacktrack(branch, out, bindingsVar) : gen(branch, out, bindingsVar)
        out.push(`${result} = ${value}; break ${label};`, '}')
      }
      out.push(
        `default: { ${expected.map((t) => `E(c, ${JSON.stringify(t)});`).join(' ')} ${result} = F; break ${label}; }`,
        '}',
        '}'
      )
      return result
    }

    // Ordered backtracking, still fully inlined.
    out.push(tickSrc)
    return genOrderedBacktrack(branches, out, bindingsVar)
  }

  /** Name -> id, for a generated switch's runtime fallback when token.id is missing. */
  const idByName = tokenIds ? Object.fromEntries(tokenIds) : null

  /** Generates and installs the function for one rule. */
  function buildRule (name) {
    const out = []
    const value = gen(rules[name], out, null)
    const body = `(c) => {\n${out.join('\n')}\nreturn ${value};\n}`
    // Kept so `emitModule` can write out exactly what was built here, with the
    // helper indices that go with it. Regenerating later would allocate fresh
    // helpers and the indices would not line up.
    SOURCES[ruleIndex.get(name)] = body
    const source = `return ${body}`
    // eslint-disable-next-line no-new-func
    const factory = new Function('F', 'E', 'P', 'T', 'R', 'H', 'I', source)
    return factory(FAIL, expect, progressError, stepsError, RULES, HELPERS, idByName)
  }

  function progressError (op, at) {
    throw new Error(
      `'${op}' matched without consuming any input at token index ${at}; ` +
      'this would loop forever. Make the repeated parser consume at least one token.'
    )
  }

  function stepsError () {
    throw new Error(`Parser exceeded maxSteps (${maxSteps}); the grammar is likely looping.`)
  }

  /**
   * Compiles `start` and everything it reaches.
   * @param {string} start
   * @returns {(state: any) => any}
   */
  function compile (start) {
    const index = indexOfRule(start)
    while (pending.length) {
      const name = pending.shift()
      RULES[ruleIndex.get(name)] = buildRule(name)
    }
    return RULES[index]
  }

  /** The generated function for a rule, if it was reached from the start rule. */
  function functionFor (name) {
    const index = ruleIndex.get(name)
    return index === undefined ? null : RULES[index]
  }

  /**
   * Exposed for tests and debugging: the source we actually emit.
   *
   * Generating appends to the helper table and can queue rules, so the state is
   * snapshotted and restored — inspecting a parser must not perturb it.
   */
  function sourceFor (name) {
    const helperCount = HELPERS.length
    const pendingCount = pending.length
    try {
      const out = []
      const value = gen(rules[name], out, null)
      return `(c) => {\n${out.join('\n')}\nreturn ${value};\n}`
    } finally {
      HELPERS.length = helperCount
      ORIGINS.length = helperCount
      pending.length = pendingCount
    }
  }

  return { compile, functionFor, sourceFor, ruleIndex, RULES, SOURCES, ORIGINS, guard }
}
