/**
 * Records that `expectation` would have been accepted at the cursor, keeping
 * only the *furthest* position — the alternative that got deepest is almost
 * always the one the author meant.
 *
 * Tracking is off during the first parse. `expect` fires on every failed token
 * match, so the bookkeeping (acceptable tokens, rule stack) is most of the work
 * in a backtracking grammar — slicing the rule stack per advance measured ~50x.
 * On failure `parseTokens` re-runs with `track` on and builds the message from
 * that; the parser is deterministic, so it lands in the same place.
 *
 * @param {ParserState} state
 * @param {string} expectation
 */
export function expect(state: ParserState, expectation: string): void;
/**
 * @param {ParserState} state
 * @returns {ParseError}
 */
export function buildParseError(state: ParserState): ParseError;
/**
 * The sentinel returned by any parser that did not match. A symbol, so a rule
 * stays free to legitimately produce `null`/`undefined`, and nothing in JSON
 * Logic can forge it.
 */
export const FAIL: unique symbol;
export function createState(tokens: import("./lexer.js").Token[], grammar: Record<string, any>, options?: {
    memo?: boolean;
    maxSteps?: number;
    track?: boolean;
}): ParserState;
export class ParseError extends Error {
    /**
     * @param {string} message
     * @param {{ token: import('./lexer.js').Token | null, expected: string[], ruleStack: string[] }} details
     */
    constructor(message: string, details: {
        token: import("./lexer.js").Token | null;
        expected: string[];
        ruleStack: string[];
    });
    token: import("./lexer.js").Token;
    expected: string[];
    ruleStack: string[];
}
/**
 * One mutable object threaded through the whole parse as the JSON Logic
 * *context*. Mutation rather than a rebuilt state per step is what keeps this
 * fast: `{"val": "idx"}` reads the cursor with no allocation, and backtracking
 * is a single integer assignment.
 */
export type ParserState = {
    tokens: import("./lexer.js").Token[];
    /**
     * Cursor into `tokens`.
     */
    idx: number;
    /**
     * Furthest cursor reached, for error reporting.
     */
    maxIdx: number;
    /**
     * Token types acceptable at `maxIdx`.
     */
    expected: string[];
    /**
     * Rule name -> JSON Logic.
     */
    grammar: Record<string, any>;
    /**
     * Packrat cache, when enabled.
     */
    memo: Map<string, any> | null;
    /**
     * Rule-name stack, written by index, never popped.
     */
    ruleNames: string[];
    /**
     * Live depth within `ruleNames`.
     */
    ruleDepth: number;
    /**
     * Snapshot taken at the furthest failure.
     */
    failureStack: string[] | null;
    /**
     * Whether to record error-reporting detail.
     */
    track: boolean;
    /**
     * Combinator invocations, for the runaway guard.
     */
    steps: number;
    /**
     * 0 disables the guard.
     */
    maxSteps: number;
};
