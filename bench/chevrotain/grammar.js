/**
 * The Excel-formula grammar of `examples/formula.jlg`, hand-written with
 * Chevrotain — the benchmark rival, kept here so the comparison is reproducible
 * from this repository alone.
 *
 * Chevrotain is not a parser generator: this is a hand-rolled lexer plus an
 * `EmbeddedActionsParser` whose rules are built at run time, which is why it is
 * the interesting entrant. It emits the same JSON Logic as the grammar it
 * mirrors, and every benchmark asserts that before timing anything.
 *
 * Coverage mirrors formula.jlg closely enough for the formulas the benchmarks
 * exercise; it has not been hardened against every edge case (e.g.
 * case-preservation nuances of bare, unanchored cell-like identifiers).
 */

import { createToken, Lexer, EmbeddedActionsParser } from 'chevrotain'

// The benchmarks always pass both sets explicitly, so these fall back to "no
// check" and "no collapsing" rather than pulling in a library of function
// definitions purely to name them. Agreement with the other parsers is asserted
// on every sample, which is what would catch it if that ever stopped holding.
const DEFAULT_FUNCTION_NAMES = null
const DEFAULT_UNARY_NAMES = null

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const WhiteSpace = createToken({ name: 'WhiteSpace', pattern: /[ \t\r\n]+/, group: Lexer.SKIPPED })

const ErrorLiteral = createToken({
  name: 'ErrorLiteral',
  pattern: /#NULL!|#DIV\/0!|#VALUE!|#REF!|#NAME\?|#NUM!|#N\/A/
})

// `[Total Sales]` — a bracketed name that isn't a wildcard, index, or quoted key.
const BracketedName = createToken({
  name: 'BracketedName',
  pattern: /\[(?!\*\s*\]|\d|")([^\]]*)\]/
})

const QuotedName = createToken({ name: 'QuotedName', pattern: /'(?:''|[^'])*'/ })
const StringLiteral = createToken({ name: 'StringLiteral', pattern: /"(?:""|[^"])*"/ })

const BooleanLiteral = createToken({ name: 'BooleanLiteral', pattern: /TRUE(?![A-Za-z0-9_])|FALSE(?![A-Za-z0-9_])/i })

// A1-style address, `$` anchors optional. Deliberately shaped like Identifier +
// trailing digits, so it also stands in for identifiers/scope names/function names
// that happen to look like a cell (`Sheet1`, `LOG10`) — see identifierText() below.
const CellReference = createToken({
  name: 'CellReference',
  pattern: /\$?[A-Za-z]+\$?[0-9]+(?![A-Za-z0-9_])/
})

const NumberLiteral = createToken({
  name: 'NumberLiteral',
  pattern: /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/
})

const Identifier = createToken({ name: 'Identifier', pattern: /[A-Za-z_][A-Za-z0-9_]*/ })

const LtEq = createToken({ name: 'LtEq', pattern: /<=/ })
const GtEq = createToken({ name: 'GtEq', pattern: />=/ })
const Ne = createToken({ name: 'Ne', pattern: /<>/ })
const Eq = createToken({ name: 'Eq', pattern: /=/ })
const Lt = createToken({ name: 'Lt', pattern: /</ })
const Gt = createToken({ name: 'Gt', pattern: />/ })

const Plus = createToken({ name: 'Plus', pattern: /\+/ })
const Minus = createToken({ name: 'Minus', pattern: /-/ })
const Star = createToken({ name: 'Star', pattern: /\*/ })
const Slash = createToken({ name: 'Slash', pattern: /\// })
const Caret = createToken({ name: 'Caret', pattern: /\^/ })
const Amp = createToken({ name: 'Amp', pattern: /&/ })
const Percent = createToken({ name: 'Percent', pattern: /%/ })

const LParen = createToken({ name: 'LParen', pattern: /\(/ })
const RParen = createToken({ name: 'RParen', pattern: /\)/ })
const LBracket = createToken({ name: 'LBracket', pattern: /\[/ })
const RBracket = createToken({ name: 'RBracket', pattern: /\]/ })
const LBrace = createToken({ name: 'LBrace', pattern: /\{/ })
const RBrace = createToken({ name: 'RBrace', pattern: /\}/ })

const Comma = createToken({ name: 'Comma', pattern: /,/ })
const Semicolon = createToken({ name: 'Semicolon', pattern: /;/ })
const Colon = createToken({ name: 'Colon', pattern: /:/ })
const Bang = createToken({ name: 'Bang', pattern: /!/ })
const Dot = createToken({ name: 'Dot', pattern: /\./ })

const allTokens = [
  WhiteSpace,
  ErrorLiteral,
  BracketedName,
  QuotedName,
  StringLiteral,
  BooleanLiteral,
  CellReference,
  NumberLiteral,
  Identifier,
  LtEq, GtEq, Ne, Eq, Lt, Gt,
  Plus, Minus, Star, Slash, Caret, Amp, Percent,
  LParen, RParen, LBracket, RBracket, LBrace, RBrace,
  Comma, Semicolon, Colon, Bang, Dot
]

const lexer = new Lexer(allTokens, { positionTracking: 'onlyStart' })

// ---------------------------------------------------------------------------
// Shared helpers (identical semantics to grammar.jlg)
// ---------------------------------------------------------------------------

const COMPARISON_OPS = { [Eq.name]: '==', [Ne.name]: '!=', [Lt.name]: '<', [LtEq.name]: '<=', [Gt.name]: '>', [GtEq.name]: '>=' }

function val (path) {
  return { val: path.length === 1 ? path[0] : path }
}

const WILDCARD = { wildcard: true }
function isWildcard (segment) { return segment === WILDCARD }

function reference (path) {
  let i = -1
  for (let k = 0; k < path.length; k++) if (isWildcard(path[k])) { i = k; break }
  if (i === -1) return val(path)
  const source = val(path.slice(0, i))
  const rest = path.slice(i + 1)
  return rest.length ? { merge: { map: [source, reference(rest)] } } : { merge: source }
}

function foldLeft (head, tail) {
  let acc = head
  for (let k = 0; k < tail.length; k++) acc = { [tail[k][0]]: [acc, tail[k][1]] }
  return acc
}

function concat (left, right) {
  if (left && typeof left === 'object' && Array.isArray(left.CONCAT)) {
    return { CONCAT: [...left.CONCAT, right] }
  }
  return { CONCAT: [left, right] }
}

/** Text of an Identifier-shaped token, stripping `$` anchors a CellReference token may carry. */
function identifierText (token) {
  return token.image.indexOf('$') === -1 ? token.image : token.image.replace(/\$/g, '')
}

function unquote (raw, quoteChar) {
  const escaped = quoteChar + quoteChar
  let out = ''
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] === quoteChar && raw[i + 1] === quoteChar) { out += quoteChar; i++ } else out += raw[i]
  }
  return out
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class FormulaParser extends EmbeddedActionsParser {
  constructor (options) {
    super(allTokens)
    const $ = this
    this.options = options

    $.RULE('formula', () => {
      $.OPTION(() => $.CONSUME(Eq))
      const expr = $.SUBRULE($.expression)
      return expr
    })

    $.RULE('expression', () => $.SUBRULE($.comparison))

    $.RULE('comparison', () => {
      const head = $.SUBRULE($.concatenation)
      const tail = []
      $.MANY(() => {
        const op = $.OR([
          { ALT: () => $.CONSUME(LtEq) },
          { ALT: () => $.CONSUME(GtEq) },
          { ALT: () => $.CONSUME(Ne) },
          { ALT: () => $.CONSUME(Eq) },
          { ALT: () => $.CONSUME(Lt) },
          { ALT: () => $.CONSUME(Gt) }
        ])
        const right = $.SUBRULE2($.concatenation)
        $.ACTION(() => tail.push([COMPARISON_OPS[op.tokenType.name], right]))
      })
      return foldLeft(head, tail)
    })

    $.RULE('concatenation', () => {
      let acc = $.SUBRULE($.additive)
      $.MANY(() => {
        $.CONSUME(Amp)
        const right = $.SUBRULE2($.additive)
        $.ACTION(() => { acc = concat(acc, right) })
      })
      return acc
    })

    $.RULE('additive', () => {
      const head = $.SUBRULE($.multiplicative)
      const tail = []
      $.MANY(() => {
        const op = $.OR([{ ALT: () => $.CONSUME(Plus) }, { ALT: () => $.CONSUME(Minus) }])
        const right = $.SUBRULE2($.multiplicative)
        $.ACTION(() => tail.push([op.tokenType === Plus ? '+' : '-', right]))
      })
      return foldLeft(head, tail)
    })

    $.RULE('multiplicative', () => {
      const head = $.SUBRULE($.exponent)
      const tail = []
      $.MANY(() => {
        const op = $.OR([{ ALT: () => $.CONSUME(Star) }, { ALT: () => $.CONSUME(Slash) }])
        const right = $.SUBRULE2($.exponent)
        $.ACTION(() => tail.push([op.tokenType === Star ? '*' : '/', right]))
      })
      return foldLeft(head, tail)
    })

    $.RULE('exponent', () => {
      let acc = $.SUBRULE($.unary)
      $.MANY(() => {
        $.CONSUME(Caret)
        const right = $.SUBRULE2($.unary)
        $.ACTION(() => { acc = { POWER: [acc, right] } })
      })
      return acc
    })

    $.RULE('unary', () => $.OR([
      { ALT: () => { $.CONSUME(Minus); const v = $.SUBRULE($.unary); return $.ACTION(() => ({ '-': [v] })) } },
      { ALT: () => { $.CONSUME(Plus); return $.SUBRULE2($.unary) } },
      { ALT: () => $.SUBRULE($.postfix) }
    ]))

    $.RULE('postfix', () => {
      let acc = $.SUBRULE($.primary)
      $.MANY(() => { $.CONSUME(Percent); $.ACTION(() => { acc = { '/': [acc, 100] } }) })
      return acc
    })

    $.RULE('primary', () => $.OR([
      { ALT: () => { $.CONSUME(LParen); const e = $.SUBRULE($.expression); $.CONSUME(RParen); return e } },
      { ALT: () => $.SUBRULE($.arrayLiteral) },
      { ALT: () => { const t = $.CONSUME(ErrorLiteral); return $.ACTION(() => ({ ERRORVALUE: [t.image] })) } },
      { ALT: () => $.SUBRULE($.numberLiteral) },
      { ALT: () => $.SUBRULE($.stringLiteral) },
      { GATE: () => $.LA(2).tokenType === LParen, ALT: () => $.SUBRULE($.functionCall) },
      { ALT: () => { const t = $.CONSUME(BooleanLiteral); return $.ACTION(() => /true/i.test(t.image)) } },
      { ALT: () => $.SUBRULE($.reference) }
    ]))

    $.RULE('numberLiteral', () => {
      const t = $.CONSUME(NumberLiteral)
      return $.ACTION(() => parseFloat(t.image))
    })

    $.RULE('stringLiteral', () => {
      const t = $.CONSUME(StringLiteral)
      return $.ACTION(() => unquote(t.image, '"'))
    })

    $.RULE('functionCall', () => {
      const nameTok = $.OR([{ ALT: () => $.CONSUME(Identifier) }, { ALT: () => $.CONSUME(CellReference) }])
      $.CONSUME(LParen)
      const args = $.SUBRULE($.argumentList)
      $.CONSUME(RParen)

      return $.ACTION(() => {
        const canonical = identifierText(nameTok).toUpperCase()
        const known = $.options.functions
        if (known && !known.has(canonical)) {
          throw new Error(`Unknown function ${canonical}`)
        }
        const unary = $.options.unaryFunctions
        if (unary && args.length === 1 && !Array.isArray(args[0]) && unary.has(canonical)) {
          return { [canonical]: args[0] }
        }
        return { [canonical]: args }
      })
    })

    $.RULE('argumentList', () => {
      const args = []
      let sawAny = false
      $.OPTION(() => {
        $.ACTION(() => { sawAny = true })
        const first = $.SUBRULE($.argument)
        $.ACTION(() => args.push(first))
        $.MANY(() => {
          $.CONSUME(Comma)
          const next = $.SUBRULE2($.argument)
          $.ACTION(() => args.push(next))
        })
      })
      return $.ACTION(() => {
        if (!sawAny) return []
        if (args.length === 1 && args[0] === null) return []
        return args
      })
    })

    $.RULE('argument', () => {
      let result = null
      $.OPTION(() => { const e = $.SUBRULE($.expression); $.ACTION(() => { result = e }) })
      return result
    })

    $.RULE('arrayLiteral', () => {
      $.CONSUME(LBrace)
      const rows = []
      const first = $.SUBRULE($.arrayRow)
      $.ACTION(() => rows.push(first))
      $.MANY(() => {
        $.CONSUME(Semicolon)
        const next = $.SUBRULE2($.arrayRow)
        $.ACTION(() => rows.push(next))
      })
      $.CONSUME(RBrace)
      return $.ACTION(() => ({ preserve: rows.length === 1 ? rows[0] : rows }))
    })

    $.RULE('arrayRow', () => {
      const row = []
      const first = $.SUBRULE($.arrayElement)
      $.ACTION(() => row.push(first))
      $.MANY(() => {
        $.CONSUME(Comma)
        const next = $.SUBRULE2($.arrayElement)
        $.ACTION(() => row.push(next))
      })
      return row
    })

    $.RULE('arrayElement', () => $.OR([
      { ALT: () => { $.CONSUME(Minus); const n = $.SUBRULE($.numberLiteral); return $.ACTION(() => -n) } },
      { ALT: () => $.SUBRULE2($.numberLiteral) },
      { ALT: () => $.SUBRULE($.stringLiteral) },
      { ALT: () => { const t = $.CONSUME(BooleanLiteral); return $.ACTION(() => /true/i.test(t.image)) } }
    ]))

    // --- references -----------------------------------------------------

    $.RULE('reference', () => {
      const scope = $.SUBRULE($.scopePrefix)
      return $.OR([
        {
          GATE: () => $.LA(1).tokenType === CellReference && $.LA(2).tokenType === Colon,
          ALT: () => {
            const start = $.SUBRULE($.cellReference)
            $.CONSUME(Colon)
            const end = $.SUBRULE2($.cellReference)
            return $.ACTION(() => (scope ? { RANGE: [start, end, { preserve: scope }] } : { RANGE: [start, end] }))
          }
        },
        {
          GATE: () => $.LA(1).tokenType === CellReference && $.LA(1).image[0] === '$',
          ALT: () => {
            const address = $.SUBRULE3($.cellReference)
            return $.ACTION(() => val([...(scope || []), address]))
          }
        },
        {
          ALT: () => {
            const path = $.SUBRULE($.path)
            return $.ACTION(() => reference([...(scope || []), ...path]))
          }
        }
      ])
    })

    $.RULE('scopePrefix', () => {
      let scope = null
      $.OPTION({
        GATE: () => {
          const t1 = $.LA(1).tokenType
          const t2 = $.LA(2).tokenType
          return (t1 === QuotedName || t1 === Identifier || t1 === CellReference) && t2 === Bang
        },
        DEF: () => {
          const nameTok = $.OR([
            { ALT: () => $.CONSUME(QuotedName) },
            { ALT: () => $.CONSUME(Identifier) },
            { ALT: () => $.CONSUME(CellReference) }
          ])
          $.CONSUME(Bang)
          $.ACTION(() => {
            scope = [nameTok.tokenType === QuotedName ? unquote(nameTok.image, "'") : identifierText(nameTok)]
          })
        }
      })
      return scope
    })

    $.RULE('cellReference', () => {
      const t = $.CONSUME(CellReference)
      return $.ACTION(() => t.image.replace(/\$/g, '').toUpperCase())
    })

    $.RULE('path', () => {
      const head = $.SUBRULE($.pathRoot)
      const segments = []
      $.ACTION(() => segments.push(head))
      $.MANY(() => {
        const seg = $.SUBRULE($.pathSegment)
        $.ACTION(() => segments.push(seg))
      })
      return segments
    })

    $.RULE('pathRoot', () => $.OR([
      { ALT: () => { const t = $.CONSUME(BracketedName); return $.ACTION(() => t.image.slice(1, -1)) } },
      { ALT: () => { const t = $.CONSUME(Identifier); return $.ACTION(() => t.image) } },
      { ALT: () => { const t = $.CONSUME(CellReference); return $.ACTION(() => identifierText(t)) } }
    ]))

    $.RULE('pathSegment', () => $.OR([
      { ALT: () => { $.CONSUME(Dot); return $.SUBRULE($.identifierLike) } },
      {
        GATE: () => $.LA(2).tokenType === Star,
        ALT: () => { $.CONSUME(LBracket); $.CONSUME(Star); $.CONSUME(RBracket); return WILDCARD }
      },
      {
        GATE: () => $.LA(2).tokenType === NumberLiteral,
        ALT: () => { $.CONSUME2(LBracket); const n = $.SUBRULE($.numberLiteral); $.CONSUME2(RBracket); return n }
      },
      {
        ALT: () => { $.CONSUME3(LBracket); const s = $.SUBRULE($.stringLiteral); $.CONSUME3(RBracket); return s }
      }
    ]))

    $.RULE('identifierLike', () => $.OR([
      { ALT: () => { const t = $.CONSUME(Identifier); return $.ACTION(() => t.image) } },
      { ALT: () => { const t = $.CONSUME(CellReference); return $.ACTION(() => identifierText(t)) } }
    ]))

    this.performSelfAnalysis()
  }
}

const parser = new FormulaParser({})

/**
 * Compile a formula into JSON Logic using the Chevrotain grammar. Mirrors
 * `compile()` in compile.js (same options shape, same default function set).
 */
export function compileChevrotain (source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('A formula must be a string')

  const lexResult = lexer.tokenize(source)
  if (lexResult.errors.length) {
    const e = lexResult.errors[0]
    throw new SyntaxError(`Unexpected character at offset ${e.offset}: ${e.message}`)
  }

  const names = options.functions === null
    ? null
    : options.functions
      ? new Set([...options.functions].map((name) => name.toUpperCase()))
      : DEFAULT_FUNCTION_NAMES

  const unary = options.unaryFunctions
    ? new Set([...options.unaryFunctions].map((name) => name.toUpperCase()))
    : DEFAULT_UNARY_NAMES

  parser.input = lexResult.tokens
  parser.options = { functions: names, unaryFunctions: unary }
  const result = parser.formula()

  if (parser.errors.length) {
    const e = parser.errors[0]
    throw new SyntaxError(e.message)
  }
  return result
}

export { lexer, FormulaParser }
