# jl-grammar

A parser toolkit whose grammars are data. Tokens, rules and semantic actions are
all JSON Logic, so a grammar can be stored in a database, shipped over the wire,
diffed, generated, or edited by someone who is not allowed to run code.

Semantic actions are evaluated by
[`json-logic-engine`](https://github.com/TotalTechGeek/json-logic-engine); the
parser itself is specialized ahead of time.

```js
import { createParser } from 'jl-grammar'

const parser = createParser({
  tokens: [
    { name: 'WS', pattern: '\\s+', skip: true },
    { name: 'Int', pattern: '\\d+' },
    { name: 'Plus', literal: '+' }
  ],
  rules: {
    sum: {
      infixLeft: {
        operand: { as: [{ consume: 'Int' }, { '+': [{ val: 'image' }, 0] }] },
        operator: { consume: 'Plus' },
        combine: { '+': [{ val: 'left' }, { val: 'right' }] }
      }
    }
  },
  start: 'sum'
})

parser.parse('1 + 2 + 3')   // 6
```

## Install

```
npm install jl-grammar json-logic-engine
```

## A grammar

A grammar is `{ tokens, rules, start }`.

**Tokens** are matched in declaration order at each position:

| field | meaning |
| --- | --- |
| `name` | the token type |
| `pattern` | a regex source string, matched sticky at the cursor |
| `literal` | a literal string; cheaper than a pattern, prefer it |
| `skip` | consume but produce no token (whitespace, comments) |
| `ignoreCase` | case-insensitive matching |
| `longerAlt` | defer to another token when it matches more text — `iffy` should lex as an identifier, not `if` + `fy` |

**Rules** map a name to a parser, and may reference each other with `subrule`,
including recursively. Left recursion is rejected when the parser is built:

```
Invalid grammar:
  - rule 'expr' is left-recursive; this parser is LL-style and would not
    terminate. Rewrite it with 'many'/'many1Sep' (the standard left-recursion
    elimination).
```

## Operators

| Operator | Form | Meaning |
| --- | --- | --- |
| `consume` | `{"consume": "Token"}` | Match one token; yields the token object. |
| `oneOf` | `{"oneOf": ["Plus", "Minus"]}` | Any of a set of token types. |
| `eof` | `{"eof": null}` | Matches only at end of input, consuming nothing. |
| `epsilon` | `{"epsilon": null}` | Matches, consuming nothing. |
| `seq` | `{"seq": [...]}` | Ordered concatenation; rolls back on failure. |
| `alt` | `{"alt": [...]}` | Ordered choice. |
| `many` | `{"many": p}` | Zero or more. |
| `many1` | `{"many1": p}` | One or more. |
| `option` | `{"option": p}` | Zero or one; yields `null` when absent. |
| `manySep` | `{"manySep": {"rule": p, "sep": "Comma", "trailing": false}}` | Separated list. |
| `many1Sep` | as above | Separated list, at least one. |
| `between` | `{"between": {"open": p, "body": p, "close": p}}` | Bracketed; yields the body. |
| `infixLeft` | `{"infixLeft": {"operand": p, "operator": p, "combine": logic}}` | One left-associative precedence level; `combine` sees `left`/`op`/`right`. |
| `infixRight` | as above | Right-associative: `a ^ b ^ c` is `a ^ (b ^ c)`. |
| `prefix` | `{"prefix": {"operator": p, "operand": p, "combine": logic}}` | Prefix operators, folded right; `combine` sees `op`/`operand`. |
| `postfix` | `{"postfix": {"operand": p, "suffix": p, "combine": logic}}` | Operand plus suffixes; `combine` sees `left`/`suffix`. |
| `subrule` | `{"subrule": "name"}` | Invoke a named rule. |
| `label` | `{"label": ["n", p]}` | Bind a result for `action`. |
| `action` | `{"action": logic}` | Semantic action over the bindings; consumes nothing. |
| `as` | `{"as": [p, logic]}` | Parse, then transform. The parsed value *is* the logic's context. |
| `lookahead` | `{"lookahead": p}` | Positive lookahead. |
| `negLookahead` | `{"negLookahead": p}` | Negative lookahead. |
| `text` | `{"text": p}` | Yields the raw source span the parser covered. |

A `seq` yields the array of its children's results, unless it contains an
`action`, in which case it yields that action's value.

The transform is `as`, not `map`, deliberately: `map` is an ordinary JSON Logic
operator, and taking that name would shadow it inside every semantic action.

## Semantic actions

Actions are JSON Logic, evaluated against the enclosing sequence's bindings:

```js
{
  seq: [
    { label: ['a', { consume: 'Int' }] },
    { consume: 'Comma' },
    { label: ['b', { consume: 'Int' }] },
    { action: { '+': [{ val: ['a', 'image'] }, { val: ['b', 'image'] }] } }
  ]
}
```

The parser state is one scope up, reachable with `{"val": [[-1], "idx"]}`.

Pass `methods` to reach past the base operator set. Declare `optimizeUnary` on
single-argument methods: it tells the engine not to wrap the evaluated argument,
which skips an allocation and — for a method whose argument is *itself* an array
— avoids conflating the argument with the argument list.

```js
createParser(grammar, {
  methods: {
    fromPairs: { method: (pairs) => Object.fromEntries(pairs), optimizeUnary: true }
  }
})
```

## The grammar-definition language

Grammars can also be written in a surface syntax that parses *into* that JSON.
`examples/formula.jlg` is a complete Excel-formula grammar in it — 196 lines with
no JavaScript in them.

```
grammar Calc;
start sum;

token WS   pattern "\\s+" skip;
token Int  pattern "[0-9]+";
token Plus literal "+";

rule sum = infixLeft(
  as(consume(Int), action({"+":[{"val":"image"},0]})),
  consume(Plus),
  action({"+":[{"val":"left"},{"val":"right"}]})
);
```

```js
import { parseDefinition, createParserFromSource } from 'jl-grammar'

const grammar = parseDefinition(source)      // plain data, JSON.stringify-able
const parser = createParserFromSource(source)
parser.parse('1 + 2 + 3')                    // 6
```

Every constructor corresponds to one operator above. The language is itself
defined by a grammar in this format, and parsed by this library.

## API

| | |
| --- | --- |
| `createParser(spec, options?)` | Build a parser from a grammar object. |
| `parseDefinition(source, options?)` | Definition source to a grammar object. |
| `createParserFromSource(source, options?)` | Definition source straight to a parser. |
| `createDefinitionParser(options?)` | A parser for the definition language itself. |
| `emitModule(spec, options?)` | Write a grammar out as a JavaScript module. |
| `createLexer(defs, options?)` | The lexer on its own. |
| `analyze(rules, options?)` | FIRST sets, nullability, left recursion, validation errors. |

A parser exposes `parse(text)`, `parseTokens(tokens, source?)`, `tokenize(text)`,
`execution` and `analysis`.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `methods` | — | Extra JSON Logic methods for semantic actions. |
| `execution` | `'generated'` | `'generated'` (a JS function per rule) or `'interpreted'` (closures, no code generation). |
| `positions` | `'full'` | `'full'` records line and column per token; `'offset'` records byte offsets only and skips scanning for newlines. |
| `memo` | `false` | Packrat memoization on `(rule, position)`. Changes the complexity class on grammars that backtrack; pure overhead on grammars that do not. |
| `strict` | `true` | Require the whole token stream to be consumed. |
| `ll1` | `true` | Use FIRST-set dispatch for `alt`. Off forces ordered backtracking. |
| `validate` | `true` | Throw `GrammarError` on left recursion and bad references. |
| `maxSteps` | `0` | Runaway guard; `0` disables. |

## Errors

Failures report the furthest position reached, not the last alternative tried:

```
Expecting one of [False, LCurly, LSquare, Null, Number, String, True]
  but found --> ] <-- (RSquare) at line 1 column 4
```

`ParseError` carries `token`, `expected` and `ruleStack`, the rule nesting at the
point of failure:

```js
['value', 'object', 'pair', 'value', 'array', 'value']
```

## Generating a parser file

```
npx jl-grammar generate grammar.jlg -o parser.js
```

```js
import { parse, registerMethods } from './parser.js'
parse('5*3+2*5-1')
```

The file holds the same rule functions `createParser` would build at run time, as
source. The grammar was analyzed when the file was written, so importing it does
no grammar work and calls no `new Function`.

Pass `--methods ./methods.js` and the emitter compiles the semantic actions to
source as well. When every action compiles, the `json-logic-engine` import is
dropped and the file's only dependency is `jl-grammar/runtime`. Actions that
cannot be compiled — `reduce`, `map` and `merge` become closures with no source
to emit — fall back to shipping as data, one at a time.

```
  -o, --out <file>        Write here instead of stdout
      --methods <file>    Module whose default export is the semantic methods
      --execution <mode>  generated (default) | interpreted
      --positions <mode>  full (default) | offset
      --memo              Enable packrat memoization
      --no-ll1            Force ordered backtracking
      --max-steps <n>     Runaway guard
```

## Running without `eval`

Both fast paths generate code: rule functions via `new Function`, and semantic
actions compiled by json-logic-engine, which builds through `eval`. A
Content-Security-Policy without `unsafe-eval` forbids both.

```js
createParser(grammar, { execution: 'interpreted' })
```

turns off both — same grammars, same results, same error messages. It is also
cheaper to construct, so it wins when a parser is built to read one short input
and then discarded.

`npm run test:csp` checks this under
`node --disallow-code-generation-from-strings`, where `eval` and `new Function`
actually throw.

## Performance

Against two hand-written parsers for the same language — one generated by Peggy,
one written with Chevrotain — on an Excel-formula grammar, all of them emitting
deep-equal JSON Logic:

```
6 rotating formulas                     1,393-character formula
  jl-grammar (runtime)      3.56x         jl-grammar (runtime)      2.93x
  jl-grammar (generated)    3.18x         jl-grammar (generated)    2.57x
  Chevrotain                1.46x         Chevrotain                1.25x
  Peggy                     1.00x         Peggy                     1.00x
```

`npm run bench` compares against Chevrotain on JSON; `npm run bench:formula` and
`npm run bench:generated` run the comparisons above. Every benchmark asserts all
parsers produce identical output before timing anything, and each case runs in
its own process.

## Development

```
npm test           # 351 tests
npm run test:csp   # the no-eval path, under a code-generation ban
npm run bench
```

```
src/lexer.js      Token definitions to a sticky-regex lexer with first-char dispatch
src/firstchars.js Static analysis of regex sources, for that dispatch
src/analyze.js    FIRST sets, nullability, left recursion, idiom recognition
src/plan.js       Specializes a grammar into closures
src/codegen.js    Generates a JavaScript function per rule
src/emit.js       Writes a grammar out as a module
src/definition.js The grammar-definition language
src/parser.js     createParser
src/runtime.js    The surface a generated module imports
examples/         JSON, arithmetic and Excel-formula grammars, in both notations
```

## Licence

MIT
