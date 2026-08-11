/**
 * Type declarations for jl-grammar.
 *
 * Hand-written rather than inferred: JSON Logic is `any` by construction, so
 * generated declarations would say `any` everywhere the interesting shapes are.
 */

/** A JSON Logic node. Deliberately loose — grammars are open-ended data. */
export type Logic = any

/** A parser expression: one of the combinators, as JSON Logic. */
export type Parser = Logic

export interface TokenDef {
  /** The token type produced. */
  name: string
  /** Regex source, matched sticky at the cursor. Mutually exclusive with `literal`. */
  pattern?: string
  /** A literal string. Cheaper than a pattern; prefer it. */
  literal?: string
  /** Consume but produce no token, e.g. whitespace and comments. */
  skip?: boolean
  ignoreCase?: boolean
  /** Defer to this token when it matches more text, e.g. `if` yielding to an identifier. */
  longerAlt?: string
}

export interface Token {
  type: string
  image: string
  start: number
  end: number
  /** 1-based; 0 under `positions: 'offset'`. */
  line: number
  /** 1-based; 0 under `positions: 'offset'`. */
  col: number
}

export interface GrammarSpec {
  tokens: TokenDef[]
  rules: Record<string, Parser>
  start: string
  /** Recorded in a generated file's header; also the default `moduleName`. */
  name?: string
  /** A .jlg file's `methods { ... }` block, as source. */
  methodsBlock?: string
}

export type ExecutionMode = 'generated' | 'interpreted'
export type PositionMode = 'full' | 'offset'

export interface ParserOptions {
  /** Extra JSON Logic methods available to semantic actions. */
  methods?: Record<string, any>
  /**
   * `generated` builds one JavaScript function per rule and compiles semantic
   * actions; `interpreted` uses closures and walks the actions, which needs no
   * `eval` and so runs under a strict Content-Security-Policy.
   */
  execution?: ExecutionMode
  /** `offset` skips scanning the input for newlines. */
  positions?: PositionMode
  /** Packrat memoization on (rule, position). */
  memo?: boolean
  /** Require the whole token stream to be consumed. */
  strict?: boolean
  /** FIRST-set dispatch for `alt`. Off forces ordered backtracking. */
  ll1?: boolean
  /** Throw `GrammarError` on left recursion and unknown rule references. */
  validate?: boolean
  /** Runaway guard; 0 disables. */
  maxSteps?: number
  /** @deprecated Legacy alias: `false` selects `execution: 'interpreted'`. */
  compile?: boolean
  /** @deprecated Legacy alias: `false` selects `execution: 'interpreted'`. */
  unsafeEval?: boolean
}

export interface Analysis {
  /** Rule name -> the token types that can begin it. */
  firsts: Record<string, Set<string>>
  /** Rule names that can match the empty string. */
  nullable: Set<string>
  /** Left recursion, unknown references and malformed nodes. */
  errors: string[]
}

export interface Lexer {
  tokenize (text: string): Token[]
  tokenNames: string[]
  positions: PositionMode
}

export interface JLParser {
  parse (text: string): any
  parseTokens (tokens: Token[], source?: string): any
  tokenize (text: string): Token[]
  lexer: Lexer
  engine: any
  analysis: Analysis
  execution: ExecutionMode
  compiled: boolean
  readonly firsts: Record<string, Set<string>>
}

export declare function createParser (spec: GrammarSpec, options?: ParserOptions): JLParser

export declare function createLexer (
  tokens: TokenDef[],
  options?: { positions?: PositionMode }
): Lexer

export declare function analyze (
  rules: Record<string, Parser>,
  options?: { tokenNames?: string[] }
): Analysis

export interface EmitOptions extends ParserOptions {
  /** Module format of the generated file. */
  format?: 'esm' | 'cjs'
  /** Name recorded in the file header. Defaults to `spec.name`. */
  moduleName?: string
  /** What the file imports the runtime from. Defaults to `jl-grammar/runtime`. */
  runtimeSpecifier?: string
  /** What the file imports the engine from, when it still needs one. */
  engineSpecifier?: string
  /** Overrides the block carried on the grammar. */
  methodsBlock?: string
}

/**
 * Writes a grammar out as a JavaScript module: one function per rule, as source.
 * Supplying `methods` lets semantic actions be compiled to source too, which can
 * remove the `json-logic-engine` dependency from the output entirely.
 */
export declare function emitModule (spec: GrammarSpec, options?: EmitOptions): string

/** Parses the grammar-definition language into a plain grammar object. */
export declare function parseDefinition (source: string, options?: ParserOptions): GrammarSpec
export declare function createParserFromSource (source: string, options?: ParserOptions): JLParser
export declare function createDefinitionParser (options?: ParserOptions): JLParser

export declare const definitionGrammar: GrammarSpec
export declare const definitionTokens: TokenDef[]
export declare const definitionRules: Record<string, Parser>
export declare const CONSTRUCTOR_NAMES: string[]

/** Separates a trailing `methods { ... }` block from the grammar text. */
export declare function splitMethodsBlock (source: string): { grammar: string, block: string | null }

export declare function analyzeMethodsBlock (body: string): {
  names: string[]
  hasDefault: boolean
  imports: string[]
}

/** Evaluates a block to its methods table. Needs `new Function`; no imports. */
export declare function evaluateMethodsBlock (body: string): {
  methods: Record<string, any>
  exports: Record<string, any>
}

/** Every combinator name, e.g. `seq`, `alt`, `infixLeft`. */
export declare const OPERATORS: string[]
export declare const PARSER_OPS: Set<string>
export declare function createMethods (): Record<string, any>
export declare function buildDispatch (...args: any[]): any
export declare function firstOf (...args: any[]): any

/** The sentinel a parser returns when it did not match. */
export declare const FAIL: symbol

export declare function createState (
  tokens: Token[],
  grammar: Record<string, Parser>,
  options?: { memo?: boolean, maxSteps?: number, track?: boolean }
): any

export declare class ParseError extends Error {
  name: 'ParseError'
  /** The token the parse stopped at, or null at end of input. */
  token: Token | null
  /** Token types that would have been accepted there. */
  expected: string[]
  /** The rule nesting at the point of failure, outermost first. */
  ruleStack: string[]
}

export declare class GrammarError extends Error {
  name: 'GrammarError'
  problems: string[]
}

export declare class LexError extends Error {
  name: 'LexError'
}
