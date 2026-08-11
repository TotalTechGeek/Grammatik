/**
 * @param {{ engine: any, rules: Record<string, any>, firsts: Map<string, any>|null,
 *           memo: boolean, maxSteps: number, unsafeEval?: boolean }} config
 */
export function createPlanner(config: {
    engine: any;
    rules: Record<string, any>;
    firsts: Map<string, any> | null;
    memo: boolean;
    maxSteps: number;
    unsafeEval?: boolean;
}): {
    plan: (node: any) => (state: any) => any;
    planOp: (op: string, args: any) => (state: any) => any;
    planAction: (logic: any) => (bindings: any, state: any) => any;
    planRule: (name: any) => {
        fn: ((state: any) => any) | null;
    };
    /** Wraps a plan so json-logic-engine's compiler can embed it. */
    declareSync: typeof declareSync;
};
/** Marks a closure as synchronous so the engine's compiler inlines it directly. */
export function declareSync(fn: any): any;
/**
 * True when the logic reads from an outer scope (`{val: [[-1], ...]}` or
 * `{var: "../x"}`). The engine's compiler does not thread `above` into built
 * functions, so such actions must stay interpreted.
 */
export function usesOuterScope(logic: any): boolean;
