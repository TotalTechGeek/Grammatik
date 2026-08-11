/**
 * Builds a parser from a JSON grammar.
 *
 * @param {GrammarSpec} spec
 * @param {ParserOptions} [options]
 */
export function createParser(spec: GrammarSpec, options?: ParserOptions): {
    parse: (text: string) => any;
    parseTokens: (tokens: import("./lexer.js").Token[], source?: string, track?: boolean) => any;
    tokenize: (text: string) => Token[];
    lexer: {
        tokenize: (text: string) => Token[];
        tokenNames: string[];
        positions: string;
    };
    engine: LogicEngine;
    analysis: {
        firsts: Map<string, First>;
        errors: string[];
        leftRecursive: string[];
    };
    planner: {
        plan: (node: any) => (state: any) => any;
        planOp: (op: string, args: any) => (state: any) => any;
        planAction: (logic: any) => (bindings: any, state: any) => any;
        planRule: (name: any) => {
            fn: ((state: any) => any) | null;
        };
        declareSync: typeof import("./plan.js").declareSync;
    };
    codegen: {
        compile: (start: string) => (state: any) => any;
        functionFor: (name: any) => any;
        sourceFor: (name: any) => string;
        ruleIndex: Map<any, any>;
        RULES: any[];
        SOURCES: any[];
        ORIGINS: any[];
        guard: boolean;
    };
    execution: "generated" | "interpreted";
    compiled: boolean;
    /** Rules whose `alt`s resolved to O(1) LL(1) dispatch, for introspection. */
    readonly firsts: Map<string, import("./analyze.js").First>;
};
export class GrammarError extends Error {
    /** @param {string[]} problems */
    constructor(problems: string[]);
    problems: string[];
}
export type GrammarSpec = {
    /**
     * Token definitions for the lexer.
     */
    tokens: import("./lexer.js").TokenDef[];
    /**
     * Rule name -> JSON Logic parser.
     */
    rules: Record<string, any>;
    /**
     * Entry rule.
     */
    start: string;
};
export type ParserOptions = {
    /**
     * Enable packrat memoization. Costs a Map
     *       write per rule invocation; pays for itself
     *       only on grammars that backtrack heavily.
     */
    memo?: boolean;
    /**
     * Require the whole token stream to be consumed.
     */
    strict?: boolean;
    /**
     * Throw on grammar errors (left recursion, bad refs).
     */
    validate?: boolean;
    /**
     * Runaway guard; 0 disables.
     */
    maxSteps?: number;
    /**
     * Compile the grammar through json-logic-engine's
     *     compiler into a tree of specialized closures.
     *     Off falls back to interpreting the JSON Logic,
     *     which is slower but easier to step through.
     */
    compile?: boolean;
    /**
     * Use FIRST-set dispatch for `alt`. Turning it
     *         off forces ordered backtracking everywhere,
     *         which parses the same language, just slower.
     *         Mostly useful for benchmarking and debugging.
     */
    ll1?: boolean;
    /**
     * Legacy alias: `false` selects `'interpreted'`.
     */
    unsafeEval?: boolean;
    /**
     * How the grammar is run.
     *
     * - `generated`   one JavaScript function per rule, semantic actions compiled
     * by the engine. The default: ~2.5x faster to parse, ~0.5 ms
     * more to construct.
     * - `interpreted` rules as planner closures, actions walked by the engine. No
     * `eval` or `new Function` anywhere, which is what a strict
     * Content-Security-Policy (no `unsafe-eval`) requires, and
     * cheaper to construct — so it also wins when a grammar is
     * built to parse one short input and then discarded.
     */
    execution?: "generated" | "interpreted";
    /**
     * `full` records line and column
     * on every token; `offset` records only
     * byte offsets and skips scanning the
     * input for newlines.
     */
    positions?: "full" | "offset";
    /**
     * Extra JSON Logic methods for semantic actions.
     */
    methods?: Record<string, any>;
};
import { LogicEngine } from 'json-logic-engine';
import { FAIL } from './state.js';
import { ParseError } from './state.js';
export { FAIL, ParseError };
