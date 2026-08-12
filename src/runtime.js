// @ts-check
'use strict'

/**
 * The surface a generated parser module needs at run time.
 *
 * `emitModule` writes files that import from `jl-grammar/runtime` rather than
 * from the main entry point, so a generated parser pulls in the lexer, the parse
 * state and error construction — but not the analyzer, the planner, or the code
 * generator, none of which it can ever use. The grammar was already analyzed
 * when the file was written.
 */

export { FAIL, expect, createState, buildParseError, ParseError } from './state.js'
export { createLexer, LexError } from './lexer.js'
export { createValueMethods } from './values.js'
