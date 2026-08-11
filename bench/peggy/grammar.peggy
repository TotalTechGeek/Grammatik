/*
 * An Excel-like formula grammar that emits JSON Logic directly.
 *
 * There is no separate AST: every rule's action returns the JSON Logic node for
 * that construct, so parsing *is* compiling. Variables use `val` — `{ val: 'x' }`
 * for a direct key, `{ val: ['a', 'b', 'c'] }` for a deep path.
 *
 * Precedence, loosest to tightest (matching Excel):
 *   comparison  =  <>  <  <=  >  >=
 *   concat      &
 *   additive    +  -
 *   multiplic.  *  /
 *   exponent    ^
 *   unary       -x  +x
 *   postfix     x%
 *   reference   A1:B3   Sheet1!A1   a.b.c
 */

{{
  const COMPARISON_OPS = {
    '=': '==',
    '<>': '!=',
    '<': '<',
    '<=': '<=',
    '>': '>',
    '>=': '>='
  }

  /** Build a `val` node, collapsing a single-segment path to the unary form. */
  function val (path) {
    return { val: path.length === 1 ? path[0] : path }
  }

  /** Marks a `[*]` projection within a path. */
  const WILDCARD = { wildcard: true }

  function isWildcard (segment) { return segment === WILDCARD }

  /**
   * Turn a path into a reference. Without a `[*]` it is a plain `val`. A `[*]`
   * splits the path into an array source and a per-element projection, compiled to
   * json-logic `map` — so `items[*].total` reads `total` from every item. Nested
   * wildcards (`a[*].b[*].c`) produce one `map` per level.
   */
  function reference (path) {
    let i = -1
    for (let k = 0; k < path.length; k++) if (isWildcard(path[k])) { i = k; break }
    if (i === -1) return val(path)
    const source = val(path.slice(0, i))
    const rest = path.slice(i + 1)
    return rest.length ? { merge: { map: [source, reference(rest)] } } : { merge: source }
  }

  /** Fold a list of `[operator, operand]` pairs left-associatively. */
  function foldLeft (head, tail) {
    return tail.reduce((left, [op, right]) => ({ [op]: [left, right] }), head)
  }

  /** `&` chains flatten into a single CONCAT rather than nesting. */
  function concat (left, right) {
    if (left && typeof left === 'object' && Array.isArray(left.CONCAT)) {
      return { CONCAT: [...left.CONCAT, right] }
    }
    return { CONCAT: [left, right] }
  }
}}

// ---------------------------------------------------------------------------

Formula
  = _ '='? _ expression:Expression _ !. { return expression }

Expression
  = Comparison

Comparison
  = head:Concatenation tail:(_ op:ComparisonOperator _ right:Concatenation { return [op, right] })* {
      return foldLeft(head, tail)
    }

ComparisonOperator
  = op:('<=' / '>=' / '<>' / '<' / '>' / '=') { return COMPARISON_OPS[op] }

Concatenation
  = head:Additive tail:(_ '&' _ right:Additive { return right })* {
      return tail.reduce(concat, head)
    }

Additive
  = head:Multiplicative tail:(_ op:[+-] _ right:Multiplicative { return [op, right] })* {
      return foldLeft(head, tail)
    }

Multiplicative
  = head:Exponent tail:(_ op:[*/] _ right:Exponent { return [op, right] })* {
      return foldLeft(head, tail)
    }

// Excel's `^` is left-associative: 2^3^2 is 64, not 512.
Exponent
  = head:Unary tail:(_ '^' _ right:Unary { return right })* {
      return tail.reduce((left, right) => ({ POWER: [left, right] }), head)
    }

// Unary minus binds tighter than `^`, which is why -2^2 is 4 in Excel.
Unary
  = '-' _ operand:Unary { return { '-': [operand] } }
  / '+' _ operand:Unary { return operand }
  / Postfix

Postfix
  = operand:Primary suffixes:(_ '%')* {
      return suffixes.reduce((value) => ({ '/': [value, 100] }), operand)
    }

Primary
  = '(' _ expression:Expression _ ')' { return expression }
  / ArrayLiteral
  / ErrorLiteral
  / NumberLiteral
  / StringLiteral
  / FunctionCall
  / BooleanLiteral
  / Reference

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

FunctionCall
  = name:FunctionName _ '(' _ args:ArgumentList _ ')' {
      const canonical = name.toUpperCase()
      const known = options.functions
      if (known && !known.has(canonical)) {
        error(`Unknown function ${canonical}`)
      }
      // Functions declared `optimizeUnary` take their argument unwrapped, so emit
      // `{ ABS: x }` rather than `{ ABS: [x] }`. The engine would otherwise strip the
      // wrapper itself; not adding it is cheaper and reads better in the tree.
      // The Array guard mirrors the engine's own condition in optimizer.js.
      const unary = options.unaryFunctions
      if (unary && args.length === 1 && !Array.isArray(args[0]) && unary.has(canonical)) {
        return { [canonical]: args[0] }
      }
      return { [canonical]: args }
    }

FunctionName
  = $([A-Za-z_][A-Za-z0-9_.]*)

ArgumentList
  = head:Argument tail:(_ ',' _ arg:Argument { return arg })* {
      // `SUM()` is no arguments; `SUM(,)` really is two omitted ones.
      if (!tail.length && head === null) return []
      return [head, ...tail]
    }

// Excel allows omitted arguments, as in IF(a,,b); they arrive as null.
Argument
  = expression:Expression? { return expression }

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

NumberLiteral
  = value:$([0-9]+ ('.' [0-9]*)? ExponentPart? / '.' [0-9]+ ExponentPart?) {
      return parseFloat(value)
    }

ExponentPart
  = [eE] [+-]? [0-9]+

StringLiteral
  = '"' chars:('""' { return '"' } / [^"])* '"' { return chars.join('') }

BooleanLiteral
  = 'TRUE'i !IdentifierChar { return true }
  / 'FALSE'i !IdentifierChar { return false }

ErrorLiteral
  = code:('#NULL!' / '#DIV/0!' / '#VALUE!' / '#REF!' / '#NAME?' / '#NUM!' / '#N/A') {
      return { ERRORVALUE: [code] }
    }

// Excel array constants: {1,2;3,4}. Wrapped in `preserve` so the engine treats
// them as data rather than as logic to evaluate.
ArrayLiteral
  = '{' _ rows:ArrayRows _ '}' {
      return { preserve: rows.length === 1 ? rows[0] : rows }
    }

ArrayRows
  = head:ArrayRow tail:(_ ';' _ row:ArrayRow { return row })* { return [head, ...tail] }

ArrayRow
  = head:ArrayElement tail:(_ ',' _ element:ArrayElement { return element })* {
      return [head, ...tail]
    }

ArrayElement
  = '-' _ value:NumberLiteral { return -value }
  / NumberLiteral
  / StringLiteral
  / BooleanLiteral

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

Reference
  = scope:ScopePrefix? start:CellReference _ ':' _ end:CellReference {
      return scope ? { RANGE: [start, end, { preserve: scope }] } : { RANGE: [start, end] }
    }
  / scope:ScopePrefix? address:AnchoredCell { return val([...(scope || []), address]) }
  / scope:ScopePrefix path:Path { return reference([...scope, ...path]) }
  / path:Path { return reference(path) }

/** `$A$1` is unambiguously a cell, so the anchors are stripped and it uppercases. */
AnchoredCell
  = &'$' address:CellReference { return address }

/** `Sheet1!` or `'My Sheet'!` — becomes the leading segments of the val path. */
ScopePrefix
  = name:(QuotedName / Identifier) '!' { return [name] }

QuotedName
  = "'" chars:("''" { return "'" } / [^'])* "'" { return chars.join('') }

/** A1-style address. `$` anchors are accepted and discarded; letters uppercase. */
CellReference
  = address:$('$'? [A-Za-z]+ '$'? [0-9]+) !IdentifierChar {
      return address.replace(/\$/g, '').toUpperCase()
    }

Path
  = head:PathRoot tail:PathSegment* { return [head, ...tail] }

PathRoot
  = BracketedName
  / Identifier

PathSegment
  = '.' name:Identifier { return name }
  / '[' _ '*' _ ']' { return WILDCARD }
  / '[' _ index:NumberLiteral _ ']' { return index }
  / '[' _ key:StringLiteral _ ']' { return key }

/** `[Total Sales]` — a name containing spaces or punctuation. */
BracketedName
  = '[' chars:[^\]]+ ']' { return chars.join('') }

Identifier
  = $([A-Za-z_][A-Za-z0-9_]*)

IdentifierChar
  = [A-Za-z0-9_]

// ---------------------------------------------------------------------------

_ "whitespace"
  = [ \t\r\n]*
