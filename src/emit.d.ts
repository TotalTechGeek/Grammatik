/**
 * @param {import('./parser.js').GrammarSpec} spec
 * @param {{ memo?: boolean, strict?: boolean, ll1?: boolean, maxSteps?: number,
 *           positions?: 'full'|'offset', execution?: 'generated'|'interpreted',
 *           format?: 'esm'|'cjs', validate?: boolean, moduleName?: string,
 *           runtimeSpecifier?: string, engineSpecifier?: string,
 *           methods?: Record<string, any> }} [options]
 * @returns {string} JavaScript module source
 */
export function emitModule(spec: import("./parser.js").GrammarSpec, options?: {
    memo?: boolean;
    strict?: boolean;
    ll1?: boolean;
    maxSteps?: number;
    positions?: "full" | "offset";
    execution?: "generated" | "interpreted";
    format?: "esm" | "cjs";
    validate?: boolean;
    moduleName?: string;
    runtimeSpecifier?: string;
    engineSpecifier?: string;
    methods?: Record<string, any>;
}): string;
