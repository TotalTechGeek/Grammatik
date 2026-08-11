/**
 * `jl-grammar/runtime` — the surface a generated parser imports.
 *
 * Deliberately small: a generated file needs the lexer, the parse state and
 * error construction, and nothing else. The analyzer, planner and code
 * generator were already run when the file was written.
 */

import type { Token, TokenDef, PositionMode, Lexer, Parser } from './index.js'

export declare const FAIL: symbol

export declare function createState (
  tokens: Token[],
  grammar: Record<string, Parser>,
  options?: { memo?: boolean, maxSteps?: number, track?: boolean }
): any

/** Records that `expectation` would have been accepted at the cursor. */
export declare function expect (state: any, expectation: string): void

export declare function buildParseError (state: any): ParseError

export declare function createLexer (
  tokens: TokenDef[],
  options?: { positions?: PositionMode }
): Lexer

export declare class ParseError extends Error {
  name: 'ParseError'
  token: Token | null
  expected: string[]
  ruleStack: string[]
}

export declare class LexError extends Error {
  name: 'LexError'
}

export type { Token, TokenDef, PositionMode, Lexer }
