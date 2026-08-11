export function createMetaMethods(): {};
export const definitionTokens: ({
    name: any;
    literal: any;
    longerAlt: string;
} | {
    name: string;
    pattern: string;
    skip: boolean;
    literal?: undefined;
} | {
    name: string;
    pattern: string;
    skip?: undefined;
    literal?: undefined;
} | {
    name: string;
    literal: string;
    pattern?: undefined;
    skip?: undefined;
})[];
export namespace definitionRules {
    export namespace Document {
        export { items as seq };
    }
    export namespace Declaration {
        export { items as alt };
    }
    export namespace TokenDeclaration { }
    export namespace TokenKind { }
    export namespace TokenFlag { }
    export namespace RuleDeclaration { }
    export namespace ParserExpression {
        export { name as subrule };
    }
    export namespace Call { }
    export namespace CallArguments { }
    export namespace CallArgument { }
    export namespace JsonValue { }
    export namespace JsonObject { }
    export namespace JsonPair { }
    export namespace JsonArray { }
    export { identifier as IdentifierValue };
    export { stringValue as StringValue };
    export namespace NumberValue { }
}
export namespace definitionGrammar {
    export { definitionTokens as tokens };
    export { definitionRules as rules };
    export let start: string;
}
/** Constructor names the language understands. */
export const CONSTRUCTOR_NAMES: string[];
export function createDefinitionParser(options?: {}): {
    parse: (text: string) => any;
    parseTokens: (tokens: import("./lexer.js").Token[], source?: string, track?: boolean) => any;
    tokenize: (text: string) => Token[];
    lexer: {
        tokenize: (text: string) => Token[];
        tokenNames: string[];
        positions: string;
    };
    engine: import("json-logic-engine").LogicEngine;
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
    readonly firsts: Map<string, import("./analyze.js").First>;
};
export function parseDefinition(source: string, options?: object): any;
export function createParserFromSource(source: string, options?: object): {
    parse: (text: string) => any;
    parseTokens: (tokens: import("./lexer.js").Token[], source?: string, track?: boolean) => any;
    tokenize: (text: string) => Token[];
    lexer: {
        tokenize: (text: string) => Token[];
        tokenNames: string[];
        positions: string;
    };
    engine: import("json-logic-engine").LogicEngine;
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
    readonly firsts: Map<string, import("./analyze.js").First>;
};
declare namespace identifier { }
declare namespace stringValue { }
export {};
