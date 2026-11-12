// @ts-check
'use strict'

import { FAIL, expect } from './state.js'
import { buildDispatch, secondTokenMasks, recognizeAltFactoring, firstOf, opOf, recognizeSeqIdiom, recognizeAltPrefixIdiom, recognizeAltConsumeIdiom } from './analyze.js'

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
 *           memoSlots?: Map<string, number>, inlineRules?: boolean, idioms?: boolean,
 *           firsts2?: Map<string, any>|null, lookahead?: boolean, precedence?: boolean, factoring?: boolean }} config
 */
export function createCodegen (config) {
  const { planner, rules, firsts, memo, maxSteps, tokenIds = null, memoSlots = new Map(), inlineRules = true, idioms = true, firsts2 = null, lookahead = true, precedence = true, factoring = true } = config

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
  /** Rules that are a level of a collapsed precedence tower: name -> { tower, level }. */
  const towerOf = new Map()
  /** Rules with no entry in the grammar, written from a function: the climber, and each level's kept original. */
  const synthetic = new Map()

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
    callSites.get(name) === 1 && INLINE_OPS.has(opOf(rules[name])) && !towerOf.has(name)

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

  /**
   * Source recording that `names` were expected here. Only the tracked re-run reads what is recorded (the first
   * pass is untracked, and a parse that fails is repeated with tracking on to build its message), so on the
   * first pass the calls are skipped rather than made just to be ignored.
   */
  const expects = (...names) => `if (c.track) { ${names.map((n) => `E(c, ${JSON.stringify(n)});`).join(' ')} }`

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
          `else { ${expects(name)} ${result} = F; }`
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
        const failed = `else { ${expects(...names)} ${result} = F; }`

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
          `else { ${expects('end of input')} ${result} = F; }`
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

  function genSeq (children, out, result, preset = null) {
    if (!Array.isArray(children)) throw new Error("'seq' expects an array of parsers")

    // Same idiom recognition as the planner, so both paths agree. Not when the bindings already hold
    // values from before the first child: an idiom would rewrite the tail without them.
    const idiom = idioms && preset === null ? recognizeSeqIdiom(children) : null
    if (idiom !== null) return gen(idiom, out, null)

    let hasLabels = false
    let hasAction = false
    for (const child of children) {
      const childOp = opOf(child)
      if (childOp === 'label') hasLabels = true
      else if (childOp === 'action') hasAction = true
    }
    const needsScope = hasLabels || hasAction || preset !== null

    const start = nextId()
    const label = 'L' + nextId()
    const bindingsVar = needsScope ? nextId() : null
    const saved = nextId()
    const collected = []

    out.push(tickSrc, `let ${result};`, `${label}: {`, `const ${start} = c.idx;`)
    if (needsScope) {
      const initial = preset === null ? '{}' : `{ ${preset.map(([name, value]) => `${JSON.stringify(name)}: ${value}`).join(', ')} }`
      out.push(`const ${saved} = c.bindings;`, `const ${bindingsVar} = ${initial};`, `c.bindings = ${bindingsVar};`)
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

  /**
   * `genOrderedBacktrack`, for a group of branches that all begin with the same token, when the token after
   * that one rules some of them out (`Identifier (` can be a call, `Identifier .` cannot be a plain
   * reference). Each branch is still emitted once; a bitmask picked by a switch on the second token says
   * which to try. Order is kept, so the first branch that matches still wins, and a branch is skipped only
   * when the analysis proves it cannot match.
   *
   * Only while not tracking: the tracking re-run is what builds error messages, and it needs every branch
   * to record what it expected. A parse that fails untracked is re-run tracked, so errors are unchanged.
   *
   * @param {any[]} list
   * @param {{ bySecond: Map<string, number>, other: number, full: number }} masks
   */
  function genMaskedBacktrack (list, masks, out, bindingsVar) {
    const result = nextId()
    const label = 'L' + nextId()
    const start = nextId()
    const mask = nextId()
    const second = nextId()
    const ids = tokenIds ? [...masks.bySecond.keys()].map((t) => tokenIds.get(t)) : null
    const numeric = ids !== null && ids.every((id) => id !== undefined)

    // Equal masks share a case, so the switch has one arm per distinct outcome.
    const byMask = new Map()
    for (const [token, m] of masks.bySecond) {
      if (!byMask.has(m)) byMask.set(m, [])
      byMask.get(m).push(numeric ? tokenIds.get(token) : JSON.stringify(token))
    }
    const arms = [...byMask].map(([m, labels]) => `${labels.map((l) => `case ${l}:`).join(' ')} ${mask} = ${m}; break;`)

    out.push(`let ${result};`, `${label}: {`, `const ${start} = c.idx;`, `let ${mask} = ${masks.full};`)
    out.push(
      'if (!c.track) {',
      `const ${second} = c.tokens[${start} + 1];`,
      numeric
        ? `switch (${second} === undefined ? -1 : (${second}.id !== undefined ? ${second}.id : I[${second}.type])) {`
        : `switch (${second} === undefined ? '' : ${second}.type) {`,
      ...arms,
      `default: ${mask} = ${masks.other}; break;`,
      '}',
      '}'
    )
    list.forEach((branch, i) => {
      out.push(`if (${mask} & ${1 << i}) {`)
      const value = gen(branch, out, bindingsVar)
      out.push(`if (${value} !== F) { ${result} = ${value}; break ${label}; }`, `c.idx = ${start};`, '}')
    })
    out.push(`${result} = F;`, '}')
    return result
  }

  /**
   * An `alt` whose branches all begin with the same parsers (see `recognizeAltFactoring`): parse that once,
   * then try what each branch does after it, in order. A branch that is just the shared parser returns its value.
   *
   * Each attempt starts with a bindings object holding the prefix's labels and nothing else, as the branch
   * would have had running alone, so a label set by an attempt that failed cannot reach a later action. Which
   * attempts are worth making is narrowed by the next token: one whose first token cannot be it is skipped.
   *
   * @param {{ prefix: any[], branches: Array<{ rest: any[] } | { bare: true }> }} plan
   */
  function genFactoredAlt (plan, out) {
    const result = nextId()
    const label = 'L' + nextId()
    const start = nextId()
    out.push(tickSrc, `let ${result};`, `${label}: {`, `const ${start} = c.idx;`)

    const preset = []
    let shared = null
    for (const child of plan.prefix) {
      const isLabel = opOf(child) === 'label'
      const value = gen(isLabel ? child.label[1] : child, out, null)
      out.push(`if (${value} === F) { c.idx = ${start}; ${result} = F; break ${label}; }`)
      if (isLabel) preset.push([child.label[0], value])
      shared = value
    }

    // Which branches can begin with the next token. A branch we cannot see through is always a candidate.
    const reachable = []
    for (const branch of plan.branches) {
      reachable.push(branch)
      if (branch.bare) break // always succeeds once the prefix has: whatever follows it is never reached
    }
    const after = nextId()
    out.push(`const ${after} = c.idx;`)

    let mask = null
    const candidates = reachable.map((branch) => {
      if (branch.bare || !firsts || !tokenIds) return null
      const first = firstOf({ seq: branch.rest }, firsts)
      return first.unknown || first.nullable || first.tokens.size === 0 ? null : first.tokens
    })
    const ids = candidates.map((tokens) => tokens === null ? null : [...tokens].map((t) => tokenIds.get(t)))
    if (reachable.length <= 30 && ids.some((list) => list !== null) && ids.every((list) => list === null || list.every((id) => id !== undefined))) {
      mask = nextId()
      const next = nextId()
      const byToken = new Map()
      let always = 0
      reachable.forEach((_, i) => {
        if (ids[i] === null) { always |= 1 << i; return }
        for (const id of ids[i]) byToken.set(id, (byToken.get(id) || 0) | (1 << i))
      })
      const byMask = new Map()
      for (const [id, bits] of byToken) {
        const m = bits | always
        if (!byMask.has(m)) byMask.set(m, [])
        byMask.get(m).push(id)
      }
      out.push(
        `let ${mask} = ${always};`,
        `const ${next} = c.tokens[${after}];`,
        `if (${next} !== undefined) {`,
        `switch (${next}.id !== undefined ? ${next}.id : I[${next}.type]) {`,
        ...[...byMask].map(([m, list]) => `${list.map((id) => `case ${id}:`).join(' ')} ${mask} = ${m}; break;`),
        '}',
        '}'
      )
    }

    reachable.forEach((branch, i) => {
      if (branch.bare) {
        out.push(`${result} = ${shared}; break ${label};`)
        return
      }
      const attempt = nextId()
      if (mask !== null) out.push(`if (${mask} & ${1 << i}) {`); else out.push('{')
      genSeq(branch.rest, out, attempt, preset)
      out.push(`if (${attempt} !== F) { ${result} = ${attempt}; break ${label}; }`, '}') // a failed `seq` has already put the cursor back where it began
    })
    out.push(`${result} = F; c.idx = ${start};`, '}')
    return result
  }

  function genAlt (branches, out, result, bindingsVar) {
    if (!Array.isArray(branches)) throw new Error("'alt' expects an array of branches")

    // Branches that begin with the same parsers parse them once. The first pass only: the tracked re-run that
    // builds an error message runs the alt as written, so a failure still names the rules it went through.
    if (factoring && bindingsVar === null && firsts && !(idioms && (recognizeAltConsumeIdiom(branches) || recognizeAltPrefixIdiom(branches)))) {
      const plan = recognizeAltFactoring(branches, rules)
      if (plan !== null) {
        const merged = nextId()
        out.push(`let ${merged};`, 'if (c.track) {')
        const plain = genAltPlain(branches, out, result, bindingsVar)
        out.push(`${merged} = ${plain};`, '} else {')
        const fast = genFactoredAlt(plan, out)
        out.push(`${merged} = ${fast};`, '}')
        return merged
      }
    }
    return genAltPlain(branches, out, result, bindingsVar)
  }

  function genAltPlain (branches, out, result, bindingsVar) {
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
      out.push(`if (${token} === undefined) { ${expects(...expected)} ${result} = F; break ${label}; }`)

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
        let value
        if (Array.isArray(branch)) {
          const masks = lookahead && firsts2 ? secondTokenMasks(branch, firsts2, tokenNames) : null
          value = masks ? genMaskedBacktrack(branch, masks, out, bindingsVar) : genOrderedBacktrack(branch, out, bindingsVar)
        } else {
          value = gen(branch, out, bindingsVar)
        }
        out.push(`${result} = ${value}; break ${label};`, '}')
      }
      out.push(
        `default: { ${expects(...expected)} ${result} = F; break ${label}; }`,
        '}',
        '}'
      )
      return result
    }

    // Ordered backtracking, still fully inlined.
    out.push(tickSrc)
    return genOrderedBacktrack(branches, out, bindingsVar)
  }

  // ---- precedence towers ----
  //
  // `Comparison > Concatenation > Additive > Multiplicative > Exponent > ...` is written as a line of rules, one
  // per level, and every operand descends the whole line and climbs back, each level peeking at the next token
  // for an operator it will not find. Measured at about 5-6 ns per level per operand. Precedence climbing does
  // the same job with one function: parse the innermost operand, then loop, asking which level the next token
  // belongs to and parsing the right-hand side one level tighter.
  //
  // This is a rewrite of how a line is *run*, not of what it means. It applies only where the two are provably
  // the same: every level an `infixLeft` or `infixRight` with an operator, each one's operand the next level,
  // and no token able to start the operator of two levels. Each level's rule becomes
  // `c.track ? original : climb`, so the tracked re-run that builds an error message executes the untouched
  // original, and rules outside the line that call a middle level keep working.

  /** @returns {{ kind: string, arg: any } | null} */
  function infixLevel (name) {
    const body = rules[name]
    const kind = opOf(body)
    if (kind !== 'infixLeft' && kind !== 'infixRight') return null
    const arg = body[kind]
    if (!arg || arg.operator === undefined || arg.combine === undefined || arg.operand === undefined) return null
    return { kind, arg }
  }

  function findTowers () {
    const next = new Map()
    const operandOf = new Map()
    for (const name of Object.keys(rules)) {
      const level = infixLevel(name)
      if (level === null || opOf(level.arg.operand) !== 'subrule') continue
      const target = Array.isArray(level.arg.operand.subrule) ? level.arg.operand.subrule[0] : level.arg.operand.subrule
      if (typeof target !== 'string' || target === name || infixLevel(target) === null) continue
      next.set(name, target)
      operandOf.set(target, (operandOf.get(target) || 0) + 1)
    }
    // A rule that is the operand of two levels is not part of a line. Cut the links into it.
    for (const [name, target] of [...next]) if (operandOf.get(target) > 1) next.delete(name)
    const targets = new Set(next.values())

    for (const start of next.keys()) {
      if (targets.has(start)) continue
      const names = [start]
      const seen = new Set(names)
      for (let cur = start; next.has(cur);) {
        cur = next.get(cur)
        if (seen.has(cur)) break
        seen.add(cur)
        names.push(cur)
      }
      if (names.length >= 2) defineTower(names)
    }
  }

  function defineTower (names) {
    const levels = names.map((name) => ({ name, ...infixLevel(name) }))
    // Which level owns each operator token. A token that can start two levels' operators, or an operator that
    // cannot be seen through, means the line is not one this can run.
    const ownerOf = new Map()
    for (let i = 0; i < levels.length; i++) {
      const first = firstOf(levels[i].arg.operator, firsts)
      if (first.unknown || first.nullable || first.tokens.size === 0) return
      for (const token of first.tokens) {
        const id = tokenIds.get(token)
        if (id === undefined || ownerOf.has(id)) return
        ownerOf.set(id, i)
      }
    }
    const climb = names[0] + '$climb'
    if (climb in rules || names.some((name) => (name + '$tower') in rules)) return

    const tower = { names, levels, ownerOf, climb }
    synthetic.set(climb, () => climbSource(tower))
    names.forEach((name, i) => {
      towerOf.set(name, { tower, level: i })
      synthetic.set(name + '$tower', () => ruleSource(name))
      synthetic.set(name, () => `(c) => c.track ? R[${indexOfRule(name + '$tower')}](c) : R[${indexOfRule(climb)}](c, ${i})`)
    })
  }

  /** The climber for a tower: parses level `from` and everything tighter than it. */
  function climbSource (tower) {
    const { levels, ownerOf, climb } = tower
    const out = []
    const loop = 'L' + nextId()
    const mark = nextId()
    const token = nextId()
    const level = nextId()
    const left = nextId()
    const bindings = levels.map(() => nextId())
    const self = indexOfRule(climb)

    out.push(tickSrc)
    const first = gen(levels[levels.length - 1].arg.operand, out, null)
    out.push(
      `if (${first} === F) return F;`,
      `let ${left} = ${first};`,
      `let ${bindings.map((b) => `${b} = null`).join(', ')};`,
      `${loop}: for (;;) {`,
      `const ${mark} = c.idx;`,
      `const ${token} = c.tokens[${mark}];`,
      `if (${token} === undefined) break;`,
      `let ${level};`,
      `switch (${token}.id !== undefined ? ${token}.id : I[${token}.type]) {`
    )
    for (let i = 0; i < levels.length; i++) {
      const ids = [...ownerOf].filter(([, owner]) => owner === i).map(([id]) => id)
      out.push(`${ids.map((id) => `case ${id}:`).join(' ')} ${level} = ${i}; break;`)
    }
    out.push(`default: break ${loop};`, '}', `if (${level} < from) break;`, `switch (${level}) {`)

    levels.forEach(({ kind, arg }, i) => {
      out.push(`case ${i}: {`)
      const operator = gen(arg.operator, out, null)
      const right = nextId()
      out.push(
        // Whatever stops a level here stops the whole expression: no other level's operator can start with this token.
        `if (${operator} === F) { c.idx = ${mark}; break ${loop}; }`,
        `const ${right} = R[${self}](c, ${kind === 'infixRight' ? i : i + 1});`,
        `if (${right} === F) { c.idx = ${mark}; break ${loop}; }`,
        `if (${bindings[i]} === null) ${bindings[i]} = { left: null, op: null, right: null };`,
        `${bindings[i]}.left = ${left}; ${bindings[i]}.op = ${operator}; ${bindings[i]}.right = ${right};`,
        `${left} = ${actionHelper(arg.combine)}(${bindings[i]}, c);`,
        'break;',
        '}'
      )
    })
    out.push('}', '}')
    return `(c, from) => {\n${out.join('\n')}\nreturn ${left};\n}`
  }

  if (precedence && firsts && tokenIds && !memo) findTowers()

  /** Name -> id, for a generated switch's runtime fallback when token.id is missing. */
  const idByName = tokenIds ? Object.fromEntries(tokenIds) : null

  /** The source of the function for a grammar rule, as written. */
  function ruleSource (name) {
    const out = []
    const value = gen(rules[name], out, null)
    return `(c) => {\n${out.join('\n')}\nreturn ${value};\n}`
  }

  /** Generates and installs the function for one rule. */
  function buildRule (name) {
    // Helper indices are allocated as the source is written, so a rule's source and its helpers stay together.
    const body = synthetic.has(name) ? synthetic.get(name)() : ruleSource(name)
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
