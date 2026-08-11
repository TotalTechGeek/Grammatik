/**
 * Compiles token definitions into a fast sticky-regex lexer.
 *
 * Literal tokens are matched with `startsWith` rather than a regex, which is a
 * large win for punctuation-heavy grammars (JSON is ~60% punctuation by token count).
 *
 * @param {TokenDef[]} defs
 * @param {{ positions?: 'full' | 'offset' }} [options]
 *   `full` (default) records line and column on every token. `offset` records
 *   only `start`/`end`, which skips a scan of the entire input for newlines —
 *   worth taking when errors do not need to name a line, or when positions are
 *   resolved lazily from the offset afterwards.
 * @returns {{ tokenize: (text: string) => Token[], tokenNames: string[], positions: string }}
 */
export function createLexer(defs: TokenDef[], options?: {
    positions?: "full" | "offset";
}): {
    tokenize: (text: string) => Token[];
    tokenNames: string[];
    positions: string;
};
/**
 * A Chevrotain-style lexer. Token definitions are plain JSON, so a whole
 * grammar (tokens + rules) stays serializable.
 *
 * @typedef {object} TokenDef
 * @property {string} name       The token type produced.
 * @property {string} [pattern]  A regex source string, matched sticky at the current offset.
 * @property {string} [literal]  A literal string to match. Cheaper than a pattern; prefer it.
 * @property {boolean} [skip]    When true the match is consumed but produces no token (whitespace, comments).
 * @property {string} [longerAlt] Name of another token to prefer when it matches a longer string
 *                                at the same offset (the classic `if` / `identifier` problem).
 * @property {boolean} [ignoreCase] Case-insensitive matching.
 */
/**
 * @typedef {object} Token
 * @property {string} type
 * @property {string} image
 * @property {number} start
 * @property {number} end
 * @property {number} line
 * @property {number} col
 */
export class LexError extends Error {
    /**
     * @param {string} message
     * @param {{ offset: number, line: number, col: number }} position
     */
    constructor(message: string, position: {
        offset: number;
        line: number;
        col: number;
    });
    offset: number;
    line: number;
    col: number;
}
/**
 * A Chevrotain-style lexer. Token definitions are plain JSON, so a whole
 * grammar (tokens + rules) stays serializable.
 */
export type TokenDef = {
    /**
     * The token type produced.
     */
    name: string;
    /**
     * A regex source string, matched sticky at the current offset.
     */
    pattern?: string;
    /**
     * A literal string to match. Cheaper than a pattern; prefer it.
     */
    literal?: string;
    /**
     * When true the match is consumed but produces no token (whitespace, comments).
     */
    skip?: boolean;
    /**
     * Name of another token to prefer when it matches a longer string
     *  at the same offset (the classic `if` / `identifier` problem).
     */
    longerAlt?: string;
    /**
     * Case-insensitive matching.
     */
    ignoreCase?: boolean;
};
export type Token = {
    type: string;
    image: string;
    start: number;
    end: number;
    line: number;
    col: number;
};
