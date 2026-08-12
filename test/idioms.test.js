import { describe, it, expect } from 'vitest'
import { createParser } from '../src/index.js'
import { recognizeSeqIdiom, recognizeAltPrefixIdiom } from '../src/analyze.js'

const tokens = [
  { name: 'WS', pattern: '\\s+', skip: true },
  { name: 'Int', pattern: '\\d+' },
  { name: 'Word', pattern: '[a-z]+' },
  { name: 'LP', literal: '(' },
  { name: 'RP', literal: ')' },
  { name: 'Comma', literal: ',' }
]

const parserFor = (logic, options) =>
  createParser({ tokens, rules: { main: logic }, start: 'main' }, options)

describe('recognizeSeqIdiom', () => {
  it('rewrites open/label/close/action into between', () => {
    const children = [
      { consume: 'LP' },
      { label: ['v', { consume: 'Int' }] },
      { consume: 'RP' },
      { action: { val: 'v' } }
    ]
    expect(recognizeSeqIdiom(children)).toEqual({
      between: { open: { consume: 'LP' }, body: { consume: 'Int' }, close: { consume: 'RP' } }
    })
  })

  it('rewrites label/action into as, rebasing the paths', () => {
    const children = [
      { label: ['n', { consume: 'Int' }] },
      { action: { '+': [{ val: ['n', 'image'] }, 0] } }
    ]
    expect(recognizeSeqIdiom(children)).toEqual({
      as: [{ consume: 'Int' }, { '+': [{ val: 'image' }, 0] }]
    })
  })

  it('rebases a bare label reference to the value itself', () => {
    const children = [{ label: ['n', { consume: 'Int' }] }, { action: { val: 'n' } }]
    expect(recognizeSeqIdiom(children)).toEqual({ as: [{ consume: 'Int' }, { val: [] }] })
  })

  it('rebases a deep path', () => {
    const children = [{ label: ['n', { consume: 'Int' }] }, { action: { val: ['n', 'a', 'b'] } }]
    expect(recognizeSeqIdiom(children)).toEqual({ as: [{ consume: 'Int' }, { val: ['a', 'b'] }] })
  })

  it('declines when the action names a different binding', () => {
    expect(recognizeSeqIdiom([
      { label: ['n', { consume: 'Int' }] },
      { action: { val: ['other', 'image'] } }
    ])).toBeNull()
  })

  it('declines when the action wants the whole binding object', () => {
    expect(recognizeSeqIdiom([
      { label: ['n', { consume: 'Int' }] },
      { action: { val: [] } }
    ])).toBeNull()
  })

  it('declines on a scope hop, which would change meaning', () => {
    expect(recognizeSeqIdiom([
      { label: ['n', { consume: 'Int' }] },
      { action: { val: [[-1], 'idx'] } }
    ])).toBeNull()
  })

  it('declines on var, whose path syntax is not rebased', () => {
    expect(recognizeSeqIdiom([
      { label: ['n', { consume: 'Int' }] },
      { action: { var: 'n.image' } }
    ])).toBeNull()
  })

  it("declines when the between action does not simply return the body", () => {
    expect(recognizeSeqIdiom([
      { consume: 'LP' },
      { label: ['v', { consume: 'Int' }] },
      { consume: 'RP' },
      { action: { '+': [{ val: 'v' }, 1] } }
    ])).toBeNull()
  })

  it('declines when the middle child is not a label', () => {
    expect(recognizeSeqIdiom([
      { consume: 'LP' }, { consume: 'Int' }, { consume: 'RP' }, { action: { val: 'v' } }
    ])).toBeNull()
  })

  it('declines on shapes it does not know', () => {
    expect(recognizeSeqIdiom([{ consume: 'Int' }, { consume: 'Word' }])).toBeNull()
    expect(recognizeSeqIdiom([{ label: ['a', { consume: 'Int' }] }])).toBeNull()
    expect(recognizeSeqIdiom('not an array')).toBeNull()
  })
})

describe('recognized grammars behave identically to the explicit spelling', () => {
  const verboseBetween = {
    seq: [
      { consume: 'LP' },
      { label: ['v', { consume: 'Int' }] },
      { consume: 'RP' },
      { action: { val: 'v' } }
    ]
  }
  const explicitBetween = {
    between: { open: { consume: 'LP' }, body: { consume: 'Int' }, close: { consume: 'RP' } }
  }

  const verboseAs = {
    seq: [
      { label: ['n', { consume: 'Int' }] },
      { action: { '+': [{ val: ['n', 'image'] }, 0] } }
    ]
  }
  const explicitAs = { as: [{ consume: 'Int' }, { '+': [{ val: 'image' }, 0] }] }

  for (const [name, verbose, explicit] of [
    ['between', verboseBetween, explicitBetween],
    ['as', verboseAs, explicitAs]
  ]) {
    for (const execution of ['generated', 'interpreted']) {
      it(`${name}, execution: ${execution}`, () => {
        const a = parserFor(verbose, { execution })
        const b = parserFor(explicit, { execution })
        const source = name === 'between' ? '(42)' : '42'
        const fromVerbose = a.parse(source)
        const fromExplicit = b.parse(source)
        expect(name === 'between' ? fromVerbose.image : fromVerbose)
          .toEqual(name === 'between' ? fromExplicit.image : fromExplicit)
      })
    }
  }

  it('rolls back a rewritten between exactly like the sequence did', () => {
    // The whole construct must fail atomically, leaving the cursor untouched
    // so a sibling alternative still sees the open token.
    const p = parserFor({
      alt: [verboseBetween, { seq: [{ consume: 'LP' }, { consume: 'Word' }, { consume: 'RP' }] }]
    })
    expect(p.parse('(a)')[1].image).toBe('a')
  })

  it('keeps declined shapes working unchanged', () => {
    const p = parserFor({
      seq: [
        { label: ['a', { consume: 'Int' }] },
        { consume: 'Comma' },
        { label: ['b', { consume: 'Int' }] },
        { action: { cat: [{ val: ['a', 'image'] }, { val: ['b', 'image'] }] } }
      ]
    })
    expect(p.parse('1,2')).toBe('12')
  })

  it('still gives the whole binding object when the action asks for it', () => {
    const p = parserFor({
      seq: [{ label: ['n', { consume: 'Int' }] }, { action: { val: [] } }]
    })
    expect(p.parse('7').n.image).toBe('7')
  })
})

describe('recognizeAltPrefixIdiom', () => {
  const branchA = {
    seq: [{ consume: 'LP' }, { label: ['n', { consume: 'Int' }] }, { consume: 'RP' }, { action: { val: 'n' } }]
  }
  const branchB = {
    seq: [{ consume: 'LP' }, { label: ['w', { consume: 'Word' }] }, { consume: 'RP' }, { action: { val: 'w' } }]
  }

  it('hoists a shared, action-free, unlabelled prefix', () => {
    const factored = recognizeAltPrefixIdiom([branchA, branchB])
    expect(factored).toEqual({
      seq: [
        { consume: 'LP' },
        { label: ['__grammatik_rest', { alt: [{ seq: branchA.seq.slice(1) }, { seq: branchB.seq.slice(1) }] }] },
        { action: { val: '__grammatik_rest' } }
      ]
    })
  })

  it('finds the longest shared run, not just the first node', () => {
    const wide = { seq: [{ consume: 'LP' }, { consume: 'Comma' }, { consume: 'Int' }, { action: { val: [] } }] }
    const narrow = { seq: [{ consume: 'LP' }, { consume: 'Comma' }, { consume: 'Word' }, { action: { val: [] } }] }
    const factored = recognizeAltPrefixIdiom([wide, narrow])
    expect(factored.seq.slice(0, 2)).toEqual([{ consume: 'LP' }, { consume: 'Comma' }])
  })

  it('declines when a branch is not a seq', () => {
    expect(recognizeAltPrefixIdiom([branchA, { consume: 'Int' }])).toBeNull()
  })

  it('declines when there is no shared leading node at all', () => {
    const other = { seq: [{ consume: 'Word' }, { action: { val: [] } }] }
    expect(recognizeAltPrefixIdiom([branchA, other])).toBeNull()
  })

  it('declines when the shared run reaches a label, even if the branches would otherwise agree', () => {
    // Both branches share `label(n, consume(Int))` verbatim, but hoisting a
    // labelled node would move its binding out of the scope that reads it.
    const withLabel1 = {
      seq: [{ label: ['n', { consume: 'Int' }] }, { consume: 'Comma' }, { action: { val: 'n' } }]
    }
    const withLabel2 = {
      seq: [{ label: ['n', { consume: 'Int' }] }, { consume: 'Semi' }, { action: { val: 'n' } }]
    }
    expect(recognizeAltPrefixIdiom([withLabel1, withLabel2])).toBeNull()
  })

  it('declines when the shortest branch is entirely shared prefix, with nothing left to hold an action', () => {
    // Every element of `short` matches `long` node-for-node, so the shared
    // run grows to `short`'s full length — and `short` has no action
    // anywhere, so its remainder (empty) could never have one either.
    const short = { seq: [{ consume: 'LP' }, { consume: 'RP' }] }
    const long = { seq: [{ consume: 'LP' }, { consume: 'RP' }, { consume: 'Word' }, { action: { val: [] } }] }
    expect(recognizeAltPrefixIdiom([short, long])).toBeNull()
  })

  it('declines with fewer than two branches', () => {
    expect(recognizeAltPrefixIdiom([branchA])).toBeNull()
    expect(recognizeAltPrefixIdiom('not an array')).toBeNull()
  })
})

describe('a factored alt behaves identically to the explicit spelling', () => {
  // FunctionCall vs. Reference in formula.gram's Primary rule is the real
  // collision this idiom targets: both start with the same token, and one
  // is a strict extension of what the other could also start with.
  const verbose = {
    alt: [
      {
        seq: [
          { consume: 'LP' },
          { label: ['a', { consume: 'Int' }] },
          { consume: 'Comma' },
          { label: ['b', { consume: 'Int' }] },
          { consume: 'RP' },
          { action: { cat: [{ val: ['a', 'image'] }, { val: ['b', 'image'] }] } }
        ]
      },
      {
        seq: [
          { consume: 'LP' },
          { label: ['w', { consume: 'Word' }] },
          { consume: 'RP' },
          { action: { val: ['w', 'image'] } }
        ]
      }
    ]
  }

  for (const execution of ['generated', 'interpreted']) {
    it(`matches the first branch (${execution})`, () => {
      const p = parserFor(verbose, { execution })
      expect(p.parse('(1,2)')).toBe('12')
    })

    it(`matches the second branch after backtracking off the first (${execution})`, () => {
      const p = parserFor(verbose, { execution })
      expect(p.parse('(a)')).toBe('a')
    })

    it(`still fails cleanly when neither branch matches (${execution})`, () => {
      const p = parserFor(verbose, { execution })
      expect(() => p.parse('(,)')).toThrow()
    })
  }
})

describe('a factored alt matches its shared prefix once per attempt, not once per colliding branch', () => {
  // The prefix itself can't hold the counting `action` directly — the idiom
  // refuses to hoist a prefix that contains one, since that is exactly the
  // case that would strand a binding in the wrong scope. Routing it through
  // a `subrule` sidesteps that without weakening what is being proved: a
  // `subrule` re-invokes its body on every call, so counting calls to it is
  // still counting how many times the (still token-for-token identical)
  // prefix actually ran.
  const grammar = {
    tokens,
    rules: {
      main: {
        alt: [
          {
            seq: [
              { subrule: 'open' },
              { label: ['a', { consume: 'Int' }] },
              { consume: 'Comma' },
              { label: ['b', { consume: 'Int' }] },
              { consume: 'RP' },
              { action: { cat: [{ val: ['a', 'image'] }, { val: ['b', 'image'] }] } }
            ]
          },
          {
            seq: [
              { subrule: 'open' },
              { label: ['w', { consume: 'Word' }] },
              { consume: 'RP' },
              { action: { val: ['w', 'image'] } }
            ]
          }
        ]
      },
      open: { seq: [{ consume: 'LP' }, { action: { 'grammatik.test.count': [] } }] }
    },
    start: 'main'
  }

  for (const execution of ['generated', 'interpreted']) {
    it(`(${execution})`, () => {
      const calls = []
      const methods = { 'grammatik.test.count': { method: () => { calls.push(1); return null }, optimizeUnary: true } }
      const p = createParser(grammar, { execution, methods })

      // Branch one's own prefix match succeeds, then the rest of that branch
      // fails on `Word` where it wanted `Int`, backtracking to branch two —
      // which starts with the identical `subrule('open')`. Two calls would
      // mean the prefix was re-attempted per branch, exactly what factoring
      // it out of the alt is meant to avoid.
      expect(p.parse('(a)')).toBe('a')
      expect(calls.length).toBe(1)
    })
  }
})
