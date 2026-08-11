/** Returns the single operator key of a JSON Logic node, or null. */
export function opOf(node: any): string;
/**
 * Rewrites a `seq` into a cheaper equivalent combinator when it matches a known
 * idiom, in the spirit of json-logic-engine's own `checkIdioms`.
 *
 * Grammars are usually written with the general primitives, because that is
 * what a grammar author reaches for. Two of those spellings are both very
 * common and needlessly expensive, and both can be recognized mechanically:
 *
 *   seq(open, label(n, body), close, action({val: n}))  ->  between(open, body, close)
 *   seq(label(n, parser), action(A))                    ->  as(parser, A')
 *
 * Together they were 40% of all `seq` invocations in the formula benchmark.
 * Recognition means an existing grammar gets the faster path without being
 * rewritten by hand.
 *
 * Returns the replacement node, or null when nothing matched.
 *
 * @param {any[]} children
 */
export function recognizeSeqIdiom(children: any[]): {
    between: {
        open: any;
        body: any;
        close: any;
    };
    as?: undefined;
} | {
    as: any[];
    between?: undefined;
};
/**
 * @param {Record<string, any>} grammar
 * @param {{ tokenNames?: string[] }} [options]
 * @returns {{ firsts: Map<string, First>, errors: string[], leftRecursive: string[] }}
 */
export function analyze(grammar: Record<string, any>, options?: {
    tokenNames?: string[];
}): {
    firsts: Map<string, First>;
    errors: string[];
    leftRecursive: string[];
};
/**
 * Builds an O(1) dispatch table for an `alt`, or null when the branches are not
 * LL(1)-separable and we must fall back to ordered backtracking.
 *
 * @param {any[]} branches
 * @param {Map<string, First>} firsts
 * @returns {Map<string, any>|null}
 */
export function buildDispatch(branches: any[], firsts: Map<string, First>): Map<string, any> | null;
/** The set of node shapes this module understands as *parsers*. */
export const PARSER_OPS: Set<string>;
export type First = {
    /**
     * Token types that can begin this node.
     */
    tokens: Set<string>;
    /**
     * Whether the node can match while consuming nothing.
     */
    nullable: boolean;
    /**
     * Whether analysis could not fully determine the set.
     * Any `unknown` disables LL(1) dispatch for the enclosing
     * `alt`, which is a correctness guard, not a bug.
     */
    unknown: boolean;
};
/**
 * Computes the FIRST set of a node given current per-rule estimates.
 * @param {*} node
 * @param {Map<string, First>} ruleFirsts
 * @returns {First}
 */
export function firstOf(node: any, ruleFirsts: Map<string, First>): First;
