import { createParser } from '../src/index.js'

const WILDCARD = Object.freeze({ wildcard: true })

const consume = (name) => ({ consume: name })
const subrule = (name) => ({ subrule: name })
const label = (name, parser) => ({ label: [name, parser] })
const seq = (...items) => ({ seq: items })
const alt = (...items) => ({ alt: items })
const many = (item) => ({ many: item })
const option = (item) => ({ option: item })
const action = (logic) => ({ action: logic })
/** One left-associative precedence level. `combine` sees left / op / right. */
const infixLeft = (operand, operator, combine) => ({ infixLeft: { operand, operator, combine } })
/** An operand followed by any number of suffixes. `combine` sees left / suffix. */
const postfix = (operand, suffix, combine) => ({ postfix: { operand, suffix, combine } })
/** Any number of prefix operators, folded right. `combine` sees op / operand. */
const prefix = (operator, operand, combine) => ({ prefix: { operator, operand, combine } })
/** `open body close`, yielding the body. */
const between = (open, body, close) => ({ between: { open, body, close } })
/** Parse, then transform: the parsed value is the logic's context. */
const as = (parser, to) => ({ as: [parser, to] })
const call = (name, value) => ({ [`formula.${name}`]: value })
const nameToken = () => alt(consume('Identifier'), consume('Cell'))

export const tokens = [
  { name: 'Whitespace', pattern: '[ \\t\\r\\n]+', skip: true },
  { name: 'String', pattern: '"(?:""|[^"])*"' },
  { name: 'QuotedName', pattern: "'(?:''|[^'])*'" },
  { name: 'Error', pattern: '#(?:NULL!|DIV/0!|VALUE!|REF!|NAME\\?|NUM!|N/A)' },
  { name: 'Boolean', pattern: '(?:TRUE|FALSE)(?![A-Za-z0-9_])', ignoreCase: true },
  { name: 'Number', pattern: '(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?' },
  { name: 'BracketedName', pattern: '\\[[A-Za-z_][^\\]]*\\]' },
  { name: 'AnchoredCell', pattern: '(?:\\$[A-Za-z]+\\$?[0-9]+|[A-Za-z]+\\$[0-9]+)' },
  { name: 'Cell', pattern: '[A-Za-z]+[0-9]+' },
  { name: 'Identifier', pattern: '[A-Za-z_][A-Za-z0-9_]*' },
  { name: 'LessEqual', literal: '<=' },
  { name: 'GreaterEqual', literal: '>=' },
  { name: 'NotEqual', literal: '<>' },
  { name: 'Less', literal: '<' },
  { name: 'Greater', literal: '>' },
  { name: 'Equals', literal: '=' },
  { name: 'Plus', literal: '+' },
  { name: 'Minus', literal: '-' },
  { name: 'Multiply', literal: '*' },
  { name: 'Divide', literal: '/' },
  { name: 'Power', literal: '^' },
  { name: 'Ampersand', literal: '&' },
  { name: 'Percent', literal: '%' },
  { name: 'LParen', literal: '(' },
  { name: 'RParen', literal: ')' },
  { name: 'LBrace', literal: '{' },
  { name: 'RBrace', literal: '}' },
  { name: 'LBracket', literal: '[' },
  { name: 'RBracket', literal: ']' },
  { name: 'Comma', literal: ',' },
  { name: 'Semicolon', literal: ';' },
  { name: 'Colon', literal: ':' },
  { name: 'Bang', literal: '!' },
  { name: 'Dot', literal: '.' }
]

export const rules = {
  Formula: seq(
    option(consume('Equals')),
    label('expression', subrule('Expression')),
    action({ val: 'expression' })
  ),
  Expression: subrule('Comparison'),
  Comparison: infixLeft(
    subrule('Concatenation'),
    subrule('ComparisonOperator'),
    call('binary', [{ val: 'op' }, { val: 'left' }, { val: 'right' }])
  ),
  ComparisonOperator: seq(
    label('token', alt(
      consume('LessEqual'), consume('GreaterEqual'), consume('NotEqual'),
      consume('Less'), consume('Greater'), consume('Equals')
    )),
    action(call('operator', { val: ['token', 'image'] }))
  ),
  Concatenation: infixLeft(
    subrule('Additive'),
    consume('Ampersand'),
    call('concat2', [{ val: 'left' }, { val: 'right' }])
  ),
  Additive: infixLeft(
    subrule('Multiplicative'),
    alt(consume('Plus'), consume('Minus')),
    call('binary', [{ val: ['op', 'image'] }, { val: 'left' }, { val: 'right' }])
  ),
  Multiplicative: infixLeft(
    subrule('Exponent'),
    alt(consume('Multiply'), consume('Divide')),
    call('binary', [{ val: ['op', 'image'] }, { val: 'left' }, { val: 'right' }])
  ),
  Exponent: infixLeft(
    subrule('Unary'),
    consume('Power'),
    call('power2', [{ val: 'left' }, { val: 'right' }])
  ),
  Unary: prefix(
    alt(consume('Minus'), consume('Plus')),
    subrule('Postfix'),
    call('unary', [{ val: ['op', 'image'] }, { val: 'operand' }])
  ),
  Postfix: postfix(
    subrule('Primary'),
    consume('Percent'),
    call('percent', { val: 'left' })
  ),
  Primary: alt(
    between(consume('LParen'), subrule('Expression'), consume('RParen')),
    subrule('ArrayLiteral'), subrule('ErrorLiteral'), subrule('NumberLiteral'),
    subrule('StringLiteral'), subrule('FunctionCall'), subrule('BooleanLiteral'), subrule('Reference')
  ),
  FunctionCall: seq(
    label('name', subrule('FunctionName')), consume('LParen'),
    label('args', subrule('ArgumentList')), consume('RParen'),
    action(call('call', [{ val: 'name' }, { val: 'args' }]))
  ),
  FunctionName: seq(
    label('head', subrule('Name')),
    label('tail', many(seq(consume('Dot'), label('name', subrule('Name')), action({ val: 'name' })))),
    action(call('functionName', [{ val: 'head' }, { val: 'tail' }]))
  ),
  ArgumentList: seq(
    label('head', option(subrule('Expression'))),
    label('tail', many(seq(consume('Comma'), label('arg', option(subrule('Expression'))), action({ val: 'arg' })))),
    action(call('arguments', [{ val: 'head' }, { val: 'tail' }]))
  ),
  NumberLiteral: as(consume('Number'), call('number', { val: 'image' })),
  StringLiteral: as(consume('String'), call('string', { val: 'image' })),
  BooleanLiteral: as(consume('Boolean'), call('boolean', { val: 'image' })),
  ErrorLiteral: as(consume('Error'), call('error', { val: 'image' })),
  ArrayLiteral: seq(
    consume('LBrace'), label('rows', subrule('ArrayRows')), consume('RBrace'),
    action(call('array', { val: 'rows' }))
  ),
  ArrayRows: seq(
    label('head', subrule('ArrayRow')),
    label('tail', many(seq(consume('Semicolon'), label('row', subrule('ArrayRow')), action({ val: 'row' })))),
    action(call('list', [{ val: 'head' }, { val: 'tail' }]))
  ),
  ArrayRow: seq(
    label('head', subrule('ArrayElement')),
    label('tail', many(seq(consume('Comma'), label('element', subrule('ArrayElement')), action({ val: 'element' })))),
    action(call('list', [{ val: 'head' }, { val: 'tail' }]))
  ),
  ArrayElement: alt(
    seq(consume('Minus'), label('number', subrule('NumberLiteral')), action(call('negativeNumber', { val: 'number' }))),
    subrule('NumberLiteral'), subrule('StringLiteral'), subrule('BooleanLiteral')
  ),
  Reference: alt(
    seq(
      label('scope', option(subrule('ScopePrefix'))), label('start', subrule('CellReference')),
      consume('Colon'), label('end', subrule('CellReference')),
      action(call('range', [{ val: 'scope' }, { val: 'start' }, { val: 'end' }]))
    ),
    seq(
      label('scope', option(subrule('ScopePrefix'))), label('address', subrule('AnchoredReference')),
      action(call('directReference', [{ val: 'scope' }, { val: 'address' }]))
    ),
    seq(
      label('scope', subrule('ScopePrefix')), label('path', subrule('Path')),
      action(call('scopedPath', [{ val: 'scope' }, { val: 'path' }]))
    ),
    seq(label('path', subrule('Path')), action(call('pathReference', { val: 'path' })))
  ),
  AnchoredReference: as(consume('AnchoredCell'), call('cell', { val: 'image' })),
  ScopePrefix: seq(
    label('name', alt(subrule('QuotedName'), subrule('Name'))), consume('Bang'),
    action(call('scope', { val: 'name' }))
  ),
  QuotedName: as(consume('QuotedName'), call('quotedName', { val: 'image' })),
  CellReference: as(alt(consume('AnchoredCell'), consume('Cell')), call('cell', { val: 'image' })),
  Path: seq(
    label('head', subrule('PathRoot')), label('tail', many(subrule('PathSegment'))),
    action(call('path', [{ val: 'head' }, { val: 'tail' }]))
  ),
  PathRoot: alt(
    as(consume('BracketedName'), call('bracketedName', { val: 'image' })),
    subrule('Name')
  ),
  PathSegment: alt(
    seq(consume('Dot'), label('name', subrule('Name')), action({ val: 'name' })),
    seq(consume('LBracket'), consume('Multiply'), consume('RBracket'), action(call('wildcard', []))),
    between(consume('LBracket'), subrule('NumberLiteral'), consume('RBracket')),
    between(consume('LBracket'), subrule('StringLiteral'), consume('RBracket'))
  ),
  Name: nameToken()
}

export const grammar = { tokens, rules, start: 'Formula' }

function val(path) {
  return { val: path.length === 1 ? path[0] : path }
}

function reference(path) {
  let wildcard = -1
  for (let index = 0; index < path.length; index++) {
    if (path[index] === WILDCARD) { wildcard = index; break }
  }
  if (wildcard === -1) return val(path)
  const source = val(path.slice(0, wildcard))
  const rest = path.slice(wildcard + 1)
  return rest.length ? { merge: { map: [source, reference(rest)] } } : { merge: source }
}

export function createFormulaMethods(options = {}) {
  const functions = options.functions && new Set(Array.from(options.functions, (name) => String(name).toUpperCase()))
  const unaryFunctions = options.unaryFunctions && new Set(Array.from(options.unaryFunctions, (name) => String(name).toUpperCase()))
  const methods = {
    operator: (image) => ({ '=': '==', '<>': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' })[image],
    binary: ([op, left, right]) => ({ [op]: [left, right] }),
    concat2: ([left, right]) => (left && typeof left === 'object' && Array.isArray(left.CONCAT)
      ? { CONCAT: left.CONCAT.concat([right]) }
      : { CONCAT: [left, right] }),
    power2: ([left, right]) => ({ POWER: [left, right] }),
    foldLeft: ([head, tail]) => {
      let output = head
      for (let index = 0; index < tail.length; index++) output = { [tail[index][0]]: [output, tail[index][1]] }
      return output
    },
    concat: ([head, tail]) => {
      let output = head
      for (let index = 0; index < tail.length; index++) {
        const right = tail[index]
        output = output && typeof output === 'object' && Array.isArray(output.CONCAT)
          ? { CONCAT: output.CONCAT.concat([right]) }
          : { CONCAT: [output, right] }
      }
      return output
    },
    power: ([head, tail]) => {
      let output = head
      for (let index = 0; index < tail.length; index++) output = { POWER: [output, tail[index]] }
      return output
    },
    unaryMinus: (operand) => ({ '-': [operand] }),
    unary: ([op, operand]) => (op === '-' ? { '-': [operand] } : operand),
    percent: (left) => ({ '/': [left, 100] }),
    postfix: ([operand, suffixes]) => {
      let output = operand
      for (let index = 0; index < suffixes.length; index++) output = { '/': [output, 100] }
      return output
    },
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
    error: (image) => ({ ERRORVALUE: [image] }),
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

export function createFormulaParser(options = {}) {
  return createParser(grammar, { ...options, methods: createFormulaMethods(options) })
}

export default grammar
