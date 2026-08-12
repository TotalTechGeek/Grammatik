import { readFileSync } from 'node:fs'
import { createParser, parseDefinition } from '../src/index.js'

/**
 * The Excel-formula example: the grammar loaded from `formula.jlg`, plus the
 * semantic methods its actions call.
 *
 * The rules used to be spelled out here as well, in JavaScript, with a test
 * asserting the two agreed. They agreed because someone kept them agreeing.
 * The `.jlg` is now the only copy and this module loads it.
 *
 * What is left here is the part that genuinely needs JavaScript: string
 * manipulation, a couple of conditionals, and the recursive rebuild of a path
 * containing `[*]`. Building a node whose key comes from the input is no longer
 * on that list — `obj` does it as data.
 */

const WILDCARD = Object.freeze({ wildcard: true })

// Read with the interpreted definition parser: this module is imported by the
// no-eval check, so loading the grammar must not itself generate code. It is one
// parse of one file at import, and the parser built from the result is still the
// generated one unless the caller asks otherwise.
export const grammar = parseDefinition(
  readFileSync(new URL('./formula.jlg', import.meta.url), 'utf8'),
  { execution: 'interpreted' }
)

export const { tokens, rules } = grammar

function val (path) {
  return { val: path.length === 1 ? path[0] : path }
}

/** A path containing `[*]` becomes a `merge`/`map` over the segment before it. */
function reference (path) {
  let wildcard = -1
  for (let index = 0; index < path.length; index++) {
    if (path[index] === WILDCARD) { wildcard = index; break }
  }
  if (wildcard === -1) return val(path)
  const source = val(path.slice(0, wildcard))
  const rest = path.slice(wildcard + 1)
  return rest.length ? { merge: { map: [source, reference(rest)] } } : { merge: source }
}

export function createFormulaMethods (options = {}) {
  const functions = options.functions && new Set(Array.from(options.functions, (name) => String(name).toUpperCase()))
  const unaryFunctions = options.unaryFunctions && new Set(Array.from(options.unaryFunctions, (name) => String(name).toUpperCase()))
  const methods = {
    operator: (image) => ({ '=': '==', '<>': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' })[image],
    // `a & b & c` is one CONCAT of three, not two nested ones.
    concat2: ([left, right]) => (left && typeof left === 'object' && Array.isArray(left.CONCAT)
      ? { CONCAT: left.CONCAT.concat([right]) }
      : { CONCAT: [left, right] }),
    unary: ([op, operand]) => (op === '-' ? { '-': [operand] } : operand),
    call: ([rawName, args]) => {
      const name = rawName.toUpperCase()
      if (functions && !functions.has(name)) throw new Error(`Unknown function ${name}`)
      if (unaryFunctions && args.length === 1 && !Array.isArray(args[0]) && unaryFunctions.has(name)) return { [name]: args[0] }
      return { [name]: args }
    },
    functionName: ([head, tail]) => {
      let output = head.image
      for (let index = 0; index < tail.length; index++) output += `.${tail[index].image}`
      return output
    },
    arguments: ([head, tail]) => tail.length === 0 && head === null ? [] : [head, ...tail],
    number: (image) => Number.parseFloat(image),
    string: (image) => image.slice(1, -1).replace(/""/g, '"'),
    boolean: (image) => image.toUpperCase() === 'TRUE',
    array: (rows) => ({ preserve: rows.length === 1 ? rows[0] : rows }),
    list: ([head, tail]) => [head, ...tail],
    negativeNumber: (number) => -number,
    range: ([scope, start, end]) => scope ? { RANGE: [start, end, { preserve: scope }] } : { RANGE: [start, end] },
    directReference: ([scope, address]) => val([...(scope || []), address]),
    scopedPath: ([scope, path]) => reference(scope.concat(path)),
    pathReference: (path) => reference(path),
    cell: (image) => image.replace(/\$/g, '').toUpperCase(),
    scope: (name) => [typeof name === 'string' ? name : name.image],
    quotedName: (image) => image.slice(1, -1).replace(/''/g, "'"),
    path: ([head, tail]) => {
      const path = new Array(tail.length + 1)
      path[0] = head && typeof head === 'object' && 'image' in head ? head.image : head
      for (let i = 0; i < tail.length; i++) {
        const item = tail[i]
        path[i + 1] = item && typeof item === 'object' && 'image' in item ? item.image : item
      }
      return path
    },
    bracketedName: (image) => image.slice(1, -1),
    wildcard: () => WILDCARD
  }
  const descriptors = {}
  const names = Object.keys(methods)
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    descriptors[`formula.${name}`] = { method: methods[name], optimizeUnary: true }
  }
  return descriptors
}

export function createFormulaParser (options = {}) {
  return createParser(grammar, { ...options, methods: createFormulaMethods(options) })
}

export default grammar
