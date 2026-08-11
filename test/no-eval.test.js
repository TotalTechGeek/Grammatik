import { describe, it, expect, vi } from 'vitest'
import { LogicEngine } from 'json-logic-engine'
import { createParser } from '../src/index.js'
import { grammar as jsonGrammar, methods as jsonMethods } from '../examples/json.js'
import calcGrammar from '../examples/calc.js'

/**
 * `execution: 'interpreted'` is for environments with a Content-Security-Policy
 * that omits `unsafe-eval`. `npm run test:csp` proves the claim properly, by running
 * under `--disallow-code-generation-from-strings` so `eval` and `new Function`
 * actually throw. These tests cover the option's behaviour and results.
 */

describe("execution: 'interpreted'", () => {
  it('does not generate rule functions', () => {
    expect(createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted' }).compiled).toBe(false)
    expect(createParser(jsonGrammar, { methods: jsonMethods }).compiled).toBe(true)
  })

  it('never asks the engine to compile anything', () => {
    const build = vi.spyOn(LogicEngine.prototype, 'build')
    try {
      const parser = createParser(calcGrammar, { execution: 'interpreted' })
      parser.parse('1 + 2 * (3 - 1)')
      parser.parse('-(2+3)*4')
      expect(build).not.toHaveBeenCalled()
    } finally {
      build.mockRestore()
    }
  })

  it('still compiles actions in generated mode', () => {
    const build = vi.spyOn(LogicEngine.prototype, 'build')
    try {
      createParser(calcGrammar, { execution: 'generated' }).parse('1 + 2')
      expect(build).toHaveBeenCalled()
    } finally {
      build.mockRestore()
    }
  })

  it('never generates rule functions, since that needs new Function', () => {
    expect(createParser(calcGrammar, { execution: 'interpreted' }).compiled).toBe(false)
  })

  it('accepts the booleans it replaced as aliases', () => {
    expect(createParser(calcGrammar, { compile: false }).execution).toBe('interpreted')
    expect(createParser(calcGrammar, { compile: true }).execution).toBe('generated')
    expect(createParser(calcGrammar, { unsafeEval: false }).execution).toBe('interpreted')
    expect(createParser(calcGrammar, {}).execution).toBe('generated')
    // An explicit `execution` wins over a legacy alias.
    expect(createParser(calcGrammar, { compile: false, execution: 'generated' }).execution).toBe('generated')
  })

  it('still rejects a mode that does not exist', () => {
    expect(() => createParser(calcGrammar, { execution: 'planned' })).toThrow(/must be one of generated, interpreted/)
  })

  it('produces identical results to the default parser', () => {
    const noEval = createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted' })
    const normal = createParser(jsonGrammar, { methods: jsonMethods })
    for (const source of [
      '1', '-1.5e3', '"a\\nb"', 'true', 'null', '[]', '{}',
      '[1,2,3]', '{"a":1,"b":[true,null,{"c":"d"}]}', '  { "x" : [ ] } '
    ]) {
      expect(noEval.parse(source), source).toEqual(normal.parse(source))
    }
  })

  it('evaluates arithmetic identically', () => {
    const noEval = createParser(calcGrammar, { execution: 'interpreted' })
    const normal = createParser(calcGrammar)
    for (const source of ['1+2', '2+3*4', '(2+3)*4', '10-3-2', '100/5/2', '--5', '-(2+3)']) {
      expect(noEval.parse(source), source).toBe(normal.parse(source))
    }
  })

  it('reports the same errors', () => {
    const noEval = createParser(jsonGrammar, { methods: jsonMethods, execution: 'interpreted' })
    const normal = createParser(jsonGrammar, { methods: jsonMethods })
    const messageOf = (parser, source) => {
      try {
        parser.parse(source)
        return 'accepted'
      } catch (error) {
        return `${error.message} :: ${JSON.stringify(error.ruleStack)}`
      }
    }
    for (const source of ['', '{', '[1,]', '{"a"}', '1 2', '{"a": [1, {"b": }]}']) {
      expect(messageOf(noEval, source), source).toBe(messageOf(normal, source))
    }
  })

  it('works with memo, backtracking and offset positions', () => {
    const options = { methods: jsonMethods, execution: 'interpreted', memo: true, ll1: false, positions: 'offset' }
    expect(createParser(jsonGrammar, options).parse('[1,{"a":2}]')).toEqual([1, { a: 2 }])
  })
})
