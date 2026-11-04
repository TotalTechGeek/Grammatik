/**
 * Compiles token definitions into a fast sticky-regex lexer.
 *
 * Literal tokens are matched with `startsWith` rather than a regex, which is a
 * large win for punctuation-heavy grammars (JSON is ~60% punctuation by token count).
 *
 * @param {TokenDef[]} defs
 * @param {{ positions?: 'full' | 'offset', scanners?: boolean, fuse?: boolean, incremental?: boolean, recover?: boolean, errorToken?: string }} [options]
 *   `full` (default) records line and column on every token. `offset` records
 *   only `start`/`end`, which skips a scan of the entire input for newlines —
 *   worth taking when errors do not need to name a line, or when positions are
 *   resolved lazily from the offset afterwards.
 *
 *   `incremental` (default false) is opt-in: when set, the returned lexer also
 *   exposes `tokenizeIncremental` and `relex`, for editors that want to re-lex
 *   only the region touched by a single edit instead of the whole document.
 *   A lexer created without it is bit-for-bit the plain lexer — no overhead.
 *
 *   `scanners` (default true) runs patterns of a few common shapes as
 *   table-driven loops instead of regex calls. The tokens are identical;
 *   `false` forces every pattern through its regex.
 *
 *   `fuse` (default true) joins runs of three or more consecutive regex candidates
 *   into one alternation, so a position where several tokens could start costs one
 *   regex call rather than one per rejected token. Same tokens; `false` tries them
 *   one at a time.
 *
 *   `recover` (default false, only meaningful with `incremental`) makes an
 *   unmatched character produce a single-character token of type `errorToken`
 *   (default `'Error'`) instead of throwing, so highlighting survives invalid
 *   or half-typed input.
 * @returns {{ tokenize: (text: string) => Token[], tokenizeIncremental?: (text: string) => IncrementalResult, relex?: (text: string, prev: IncrementalResult, edit: { start: number, oldEnd: number, newEnd: number }) => IncrementalResult, tokenNames: string[], positions: string, modeNames: string[] }}
 */
export function createLexer(defs: TokenDef[], options?: {
    positions?: "full" | "offset";
    scanners?: boolean;
    fuse?: boolean;
    incremental?: boolean;
    recover?: boolean;
    errorToken?: string;
}): {
    tokenize: (text: string) => Token[];
    tokenizeIncremental?: (text: string) => IncrementalResult;
    relex?: (text: string, prev: IncrementalResult, edit: {
        start: number;
        oldEnd: number;
        newEnd: number;
    }) => IncrementalResult;
    tokenNames: string[];
    positions: string;
    modeNames: string[];
};
/**
 * Opaque state returned by `tokenizeIncremental`/`relex` — pass it back into
 * `relex` unmodified; only `.tokens` is meant to be read directly.
 */
export type IncrementalResult = {
    text: string;
    tokens: Token[];
    checkpoints: object[];
    eof: object;
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
