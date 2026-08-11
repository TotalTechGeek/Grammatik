import { describe, it, expect } from 'vitest'
import { createParser } from '../src/index.js'
import { recognizeSeqIdiom } from '../src/analyze.js'

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
