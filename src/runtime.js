// @ts-check
'use strict'

/**
 * The surface a generated parser module needs at run time.
 *
 * `emitModule` writes files that import from `grammatik/runtime` rather than
 * from the main entry point, so a generated parser pulls in the parse state and
 * error construction — and not the analyzer, the planner or the code generator,
 * none of which it can ever use. The grammar was already analyzed when the file
 * was written, and so, by default, was its lexer (see `lexgen.js`): the file
 * carries that as source and needs only `LexError` from here. `createLexer` is
 * exported for files emitted with `lexer: 'runtime'`.
 */

export { FAIL, expect, createState, buildParseError, ParseError, LexError } from './state.js'
export { createLexer } from './lexer.js'
export { createValueMethods } from './values.js'
