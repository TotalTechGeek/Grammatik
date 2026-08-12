import { createParser } from './parser.js'
import { splitMethodsBlock, evaluateMethodsBlock } from './methodsblock.js'

/**
 * The grammar-definition language: a small surface syntax for the same grammars
 * `createParser` takes as JSON. `examples/*.gram` are written in it.
 *
 * It is defined by a grammar in this library's own format and parsed by this
 * library — the bootstrap is the point. `test/meta-formula.test.js` asserts that
 * parsing `formula.gram` produces a structure deep-equal to the hand-authored
 * grammar object, so the two spellings cannot drift.
 */

const consume = (name) => ({ consume: name })
const subrule = (name) => ({ subrule: name })
const label = (name, parser) => ({ label: [name, parser] })
const seq = (...items) => ({ seq: items })
const alt = (...items) => ({ alt: items })
const many = (item) => ({ many: item })
const action = (logic) => ({ action: logic })
const call = (name, value) => ({ [`meta.${name}`]: value })
const keyword = (name, literal) => ({ name, literal, longerAlt: 'Identifier' })

export const definitionTokens = [
  { name: 'Whitespace', pattern: '[ \\t\\r\\n]+', skip: true },
  { name: 'LineComment', pattern: '//[^\\r\\n]*', skip: true },
  keyword('GrammarKeyword', 'grammar'),
  keyword('StartKeyword', 'start'),
  keyword('TokenKeyword', 'token'),
  keyword('RuleKeyword', 'rule'),
  keyword('PatternKeyword', 'pattern'),
  keyword('LiteralKeyword', 'literal'),
  keyword('SkipKeyword', 'skip'),
  keyword('IgnoreCaseKeyword', 'ignoreCase'),
  keyword('LongerAltKeyword', 'longerAlt'),
  keyword('ModeKeyword', 'mode'),
  keyword('PushModeKeyword', 'pushMode'),
  keyword('PopModeKeyword', 'popMode'),
  keyword('TrueKeyword', 'true'),
  keyword('FalseKeyword', 'false'),
  keyword('NullKeyword', 'null'),
  { name: 'String', pattern: '"(?:\\\\.|[^"\\\\])*"' },
  { name: 'Number', pattern: '-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?' },
  { name: 'Identifier', pattern: '[A-Za-z_][A-Za-z0-9_]*' },
  { name: 'LParen', literal: '(' },
  { name: 'RParen', literal: ')' },
  { name: 'LBrace', literal: '{' },
  { name: 'RBrace', literal: '}' },
  { name: 'LBracket', literal: '[' },
  { name: 'RBracket', literal: ']' },
  { name: 'Comma', literal: ',' },
  { name: 'Colon', literal: ':' },
  { name: 'Equals', literal: '=' },
  { name: 'Semicolon', literal: ';' }
]

const identifier = seq(label('token', consume('Identifier')), action({ val: ['token', 'image'] }))
const stringValue = seq(label('token', consume('String')), action(call('string', { val: ['token', 'image'] })))

export const definitionRules = {
  Document: seq(
    consume('GrammarKeyword'), label('name', subrule('IdentifierValue')), consume('Semicolon'),
    consume('StartKeyword'), label('start', subrule('IdentifierValue')), consume('Semicolon'),
    label('declarations', many(subrule('Declaration'))),
    action(call('document', [{ val: 'name' }, { val: 'start' }, { val: 'declarations' }]))
  ),
  Declaration: alt(subrule('TokenDeclaration'), subrule('RuleDeclaration')),
  TokenDeclaration: seq(
    consume('TokenKeyword'), label('name', subrule('IdentifierValue')),
    label('kind', subrule('TokenKind')), label('flags', many(subrule('TokenFlag'))), consume('Semicolon'),
    action(call('token', [{ val: 'name' }, { val: 'kind' }, { val: 'flags' }]))
  ),
  TokenKind: alt(
    seq(consume('PatternKeyword'), label('source', subrule('StringValue')), action(['pattern', { val: 'source' }])),
    seq(consume('LiteralKeyword'), label('source', subrule('StringValue')), action(['literal', { val: 'source' }]))
  ),
  TokenFlag: alt(
    seq(consume('SkipKeyword'), action(['skip', true])),
    seq(consume('IgnoreCaseKeyword'), action(['ignoreCase', true])),
    seq(consume('LongerAltKeyword'), label('name', subrule('IdentifierValue')), action(['longerAlt', { val: 'name' }])),
    // `mode` may be repeated, for a token that serves several modes.
    seq(consume('ModeKeyword'), label('name', subrule('IdentifierValue')), action(['mode', { val: 'name' }])),
    seq(consume('PushModeKeyword'), label('name', subrule('IdentifierValue')), action(['pushMode', { val: 'name' }])),
    seq(consume('PopModeKeyword'), action(['popMode', true]))
  ),
  RuleDeclaration: seq(
    consume('RuleKeyword'), label('name', subrule('IdentifierValue')), consume('Equals'),
    label('parser', subrule('ParserExpression')), consume('Semicolon'),
    action(call('rule', [{ val: 'name' }, { val: 'parser' }]))
  ),
  ParserExpression: subrule('Call'),
  Call: seq(
    label('name', subrule('IdentifierValue')), consume('LParen'),
    label('args', subrule('CallArguments')), consume('RParen'),
    action(call('call', [{ val: 'name' }, { val: 'args' }]))
  ),
  CallArguments: alt(
    seq({ lookahead: consume('RParen') }, action([])),
    seq(
      label('head', subrule('CallArgument')),
      label('tail', many(seq(consume('Comma'), label('value', subrule('CallArgument')), action({ val: 'value' })))),
      action(call('list', [{ val: 'head' }, { val: 'tail' }]))
    )
  ),
  CallArgument: alt(subrule('Call'), subrule('JsonValue'), subrule('IdentifierValue')),
  JsonValue: alt(
    subrule('JsonObject'), subrule('JsonArray'), subrule('StringValue'), subrule('NumberValue'),
    seq(consume('TrueKeyword'), action(true)),
    seq(consume('FalseKeyword'), action(false)),
    seq(consume('NullKeyword'), action(null))
  ),
  JsonObject: alt(
    seq(consume('LBrace'), consume('RBrace'), action(call('object', []))),
    seq(
      consume('LBrace'), label('head', subrule('JsonPair')),
      label('tail', many(seq(consume('Comma'), label('pair', subrule('JsonPair')), action({ val: 'pair' })))),
      consume('RBrace'), action(call('object', [{ val: 'head' }, { val: 'tail' }]))
    )
  ),
  JsonPair: seq(
    label('key', subrule('StringValue')), consume('Colon'), label('value', subrule('JsonValue')),
    action([{ val: 'key' }, { val: 'value' }])
  ),
  JsonArray: alt(
    seq(consume('LBracket'), consume('RBracket'), action([])),
    seq(
      consume('LBracket'), label('head', subrule('JsonValue')),
      label('tail', many(seq(consume('Comma'), label('value', subrule('JsonValue')), action({ val: 'value' })))),
      consume('RBracket'), action(call('list', [{ val: 'head' }, { val: 'tail' }]))
    )
  ),
  IdentifierValue: identifier,
  StringValue: stringValue,
  NumberValue: seq(label('token', consume('Number')), action(call('number', { val: ['token', 'image'] })))
}

export const definitionGrammar = { tokens: definitionTokens, rules: definitionRules, start: 'Document' }

function assertArity(name, args, minimum, maximum = minimum) {
  if (args.length < minimum || args.length > maximum) {
    const expected = minimum === maximum ? String(minimum) : `${minimum}-${maximum}`
    throw new Error(`${name} expects ${expected} argument(s), received ${args.length}`)
  }
}

export function createMetaMethods () {
  const methods = {
    string: (image) => JSON.parse(image),
    number: (image) => Number(image),
    list: ([head, tail]) => {
      const output = new Array(tail.length + 1)
      output[0] = head
      for (let i = 0; i < tail.length; i++) output[i + 1] = tail[i]
      return output
    },
    object: (value) => {
      const output = {}
      if (value.length === 0) return output
      const head = value[0]
      const tail = value[1]
      output[head[0]] = head[1]
      for (let i = 0; i < tail.length; i++) output[tail[i][0]] = tail[i][1]
      return output
    },
    token: ([name, kind, flags]) => {
      const value = { name, [kind[0]]: kind[1] }
      // `mode` is the one repeatable flag: one occurrence stays `mode`, several
      // collapse to `modes`, which is what a token serving two modes looks like.
      const modes = []
      for (let i = 0; i < flags.length; i++) {
        if (flags[i][0] === 'mode') modes.push(flags[i][1])
        else value[flags[i][0]] = flags[i][1]
      }
      if (modes.length === 1) value.mode = modes[0]
      else if (modes.length > 1) value.modes = modes
      return ['token', value]
    },
    rule: ([name, parser]) => ['rule', name, parser],
    document: ([name, start, declarations]) => {
      const tokens = []
      const rules = {}
      for (let i = 0; i < declarations.length; i++) {
        const declaration = declarations[i]
        if (declaration[0] === 'token') tokens.push(declaration[1])
        else rules[declaration[1]] = declaration[2]
      }
      return { name, tokens, rules, start }
    },
    call: ([name, args]) => {
      const build = CONSTRUCTORS[name]
      if (!build) throw new Error(`Unknown parser constructor ${name}`)
      if (args.length < build.arity[0] || args.length > build.arity[1]) {
        const [min, max] = build.arity
        const expected = min === max ? String(min) : `${min}-${max}`
        throw new Error(`${name} expects ${expected} argument(s), received ${args.length}`)
      }
      return build.of(args)
    }
  }

  const descriptors = {}
  for (const key of Object.keys(methods)) {
    descriptors[`meta.${key}`] = { method: methods[key], optimizeUnary: true }
  }
  return descriptors
}

/**
 * How each constructor in the language maps onto a grammar node.
 *
 * Table-driven so the language cannot fall behind the operator set: adding a
 * combinator means adding a line here, and `test/definition.test.js` asserts
 * every operator in `OPERATORS` has one.
 */
const VARIADIC = [0, Infinity]

/** `action(...)` is accepted where raw logic is wanted; unwrap it. */
const logicOf = (node) => (node && node.action !== undefined ? node.action : node)

const CONSTRUCTORS = {
  seq: { arity: VARIADIC, of: (args) => ({ seq: args }) },
  alt: { arity: VARIADIC, of: (args) => ({ alt: args }) },
  oneOf: { arity: VARIADIC, of: (args) => ({ oneOf: args }) },

  consume: { arity: [1, 1], of: ([a]) => ({ consume: a }) },
  subrule: { arity: [1, 1], of: ([a]) => ({ subrule: a }) },
  many: { arity: [1, 1], of: ([a]) => ({ many: a }) },
  many1: { arity: [1, 1], of: ([a]) => ({ many1: a }) },
  option: { arity: [1, 1], of: ([a]) => ({ option: a }) },
  action: { arity: [1, 1], of: ([a]) => ({ action: a }) },
  lookahead: { arity: [1, 1], of: ([a]) => ({ lookahead: a }) },
  negLookahead: { arity: [1, 1], of: ([a]) => ({ negLookahead: a }) },
  text: { arity: [1, 1], of: ([a]) => ({ text: a }) },

  eof: { arity: [0, 0], of: () => ({ eof: null }) },
  epsilon: { arity: [0, 0], of: () => ({ epsilon: null }) },

  label: { arity: [2, 2], of: ([a, b]) => ({ label: [a, b] }) },
  as: { arity: [2, 2], of: ([a, b]) => ({ as: [a, logicOf(b)] }) },
  manySep: { arity: [2, 2], of: ([a, b]) => ({ manySep: { rule: a, sep: b } }) },
  many1Sep: { arity: [2, 2], of: ([a, b]) => ({ many1Sep: { rule: a, sep: b } }) },

  between: { arity: [3, 3], of: ([a, b, c]) => ({ between: { open: a, body: b, close: c } }) },
  infixLeft: { arity: [3, 3], of: ([a, b, c]) => ({ infixLeft: { operand: a, operator: b, combine: logicOf(c) } }) },
  infixRight: { arity: [3, 3], of: ([a, b, c]) => ({ infixRight: { operand: a, operator: b, combine: logicOf(c) } }) },
  prefix: { arity: [3, 3], of: ([a, b, c]) => ({ prefix: { operator: a, operand: b, combine: logicOf(c) } }) },
  postfix: { arity: [3, 3], of: ([a, b, c]) => ({ postfix: { operand: a, suffix: b, combine: logicOf(c) } }) }
}

/** Constructor names the language understands. */
export const CONSTRUCTOR_NAMES = Object.keys(CONSTRUCTORS)

/** A parser for the grammar-definition language itself. */
export const createDefinitionParser = (options = {}) =>
  createParser(definitionGrammar, { ...options, methods: createMetaMethods() })

/**
 * Parses definition source into a grammar object — plain data, safe to
 * `JSON.stringify` and hand to `createParser`.
 *
 * A trailing `methods { ... }` block is separated out before the language sees
 * the source and carried on the result as `methodsBlock`, an opaque string. The
 * grammar itself is unchanged by its presence.
 *
 * @param {string} source
 * @param {object} [options] Passed to the definition parser itself.
 */
export function parseDefinition (source, options = {}) {
  const { grammar: text, block } = splitMethodsBlock(source)
  const grammar = createDefinitionParser(options).parse(text)
  if (block !== null) grammar.methodsBlock = block
  return grammar
}

/**
 * Definition source straight to a working parser.
 *
 * A `methods` block is evaluated here, which needs `new Function`. Explicit
 * `options.methods` win over it, and a block that imports has to go through
 * `emitModule` or the CLI instead — see `evaluateMethodsBlock`.
 *
 * @param {string} source
 * @param {object} [options] Passed to `createParser` for the resulting grammar.
 */
export function createParserFromSource (source, options = {}) {
  const grammar = parseDefinition(source, { execution: options.execution })
  if (grammar.methodsBlock === undefined || options.methods) return createParser(grammar, options)

  const { methods } = evaluateMethodsBlock(grammar.methodsBlock)
  return createParser(grammar, { ...options, methods })
}
