/**
 * A real source generator for grammars.
 *
 * The planner removes per-token *decisions*, but it still pays one indirect
 * call per grammar node, through call sites that see many closure shapes and so
 * cannot be inlined. That is the floor for a closure tree, and it is where the
 * remaining gap against hand-written parsers lives.
 *
 * This module emits one JavaScript function per rule with every node inlined as
 * straight-line statements — the shape a hand-written recursive-descent parser
 * has. `alt` becomes a real `switch` on the token type, which V8 compiles to a
 * jump table rather than a Map lookup. Only rule boundaries remain calls.
 *
 * Anything it does not know how to emit falls back to the planner's closure via
 * the helper table, so adding an operator here is optional and incremental.
 */
/**
 * @param {{ planner: any, rules: Record<string, any>, firsts: Map<string, any>|null,
 *           memo: boolean, maxSteps: number }} config
 */
export function createCodegen(config: {
    planner: any;
    rules: Record<string, any>;
    firsts: Map<string, any> | null;
    memo: boolean;
    maxSteps: number;
}): {
    compile: (start: string) => (state: any) => any;
    functionFor: (name: any) => any;
    sourceFor: (name: any) => string;
    ruleIndex: Map<any, any>;
    RULES: any[];
    SOURCES: any[];
    ORIGINS: any[];
    guard: boolean;
};
