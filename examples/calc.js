// @ts-check
'use strict'

/**
 * An arithmetic expression grammar that evaluates as it parses.
 *
 * Note the shape of `expression` and `term`: the classic left-recursion
 * elimination. `expr := expr '+' term` is rewritten as `expr := term ('+' term)*`
 * and the left-associative fold is done by a `reduce` in the semantic action.
 * The analyzer will reject the left-recursive spelling outright.
 */

export const tokens = [
  { name: 'WS', pattern: '\\s+', skip: true },
  { name: 'Number', pattern: '\\d+(?:\\.\\d+)?' },
  { name: 'Plus', literal: '+' },
  { name: 'Minus', literal: '-' },
  { name: 'Mult', literal: '*' },
  { name: 'Div', literal: '/' },
  { name: 'LParen', literal: '(' },
  { name: 'RParen', literal: ')' }
]

/** Folds `[[op, operand], ...]` onto a head value, left-associatively. */
const foldLeft = (headVar) => ({
  reduce: [
    { val: 'tail' },
    {
      if: [
        { '===': [{ val: ['current', 0] }, '+'] }, { '+': [{ val: 'accumulator' }, { val: ['current', 1] }] },
        { '===': [{ val: ['current', 0] }, '-'] }, { '-': [{ val: 'accumulator' }, { val: ['current', 1] }] },
        { '===': [{ val: ['current', 0] }, '*'] }, { '*': [{ val: 'accumulator' }, { val: ['current', 1] }] },
        { '/': [{ val: 'accumulator' }, { val: ['current', 1] }] }
      ]
    },
    { val: headVar }
  ]
})

export const rules = {
  expression: {
    seq: [
      { label: ['head', { subrule: 'term' }] },
      {
        label: ['tail', {
          many: {
            seq: [
              { label: ['op', { alt: [{ consume: 'Plus' }, { consume: 'Minus' }] }] },
              { label: ['operand', { subrule: 'term' }] },
              { action: [{ val: ['op', 'image'] }, { val: 'operand' }] }
            ]
          }
        }]
      },
      { action: foldLeft('head') }
    ]
  },

  term: {
    seq: [
      { label: ['head', { subrule: 'factor' }] },
      {
        label: ['tail', {
          many: {
            seq: [
              { label: ['op', { alt: [{ consume: 'Mult' }, { consume: 'Div' }] }] },
              { label: ['operand', { subrule: 'factor' }] },
              { action: [{ val: ['op', 'image'] }, { val: 'operand' }] }
            ]
          }
        }]
      },
      { action: foldLeft('head') }
    ]
  },

  factor: {
    alt: [
      {
        seq: [
          { consume: 'Minus' },
          { label: ['value', { subrule: 'factor' }] },
          // Multiplying by -1 rather than subtracting from 0: the two differ at
          // zero, where `0 - 0` is `+0` but true negation gives `-0`.
          { action: { '*': [-1, { val: 'value' }] } }
        ]
      },
      {
        seq: [
          { consume: 'LParen' },
          { label: ['value', { subrule: 'expression' }] },
          { consume: 'RParen' },
          { action: { val: 'value' } }
        ]
      },
      {
        seq: [
          { label: ['n', { consume: 'Number' }] },
          { action: { '+': [{ val: ['n', 'image'] }, 0] } }
        ]
      }
    ]
  }
}

export const grammar = { tokens, rules, start: 'expression' }
export default grammar
