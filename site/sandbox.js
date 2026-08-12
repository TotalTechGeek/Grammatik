import { parseDefinition, createParser, createLexer, emitModule, evaluateMethodsBlock } from './grammatik.js'
import { EXAMPLES } from './examples.js'

const $ = (id) => document.getElementById(id)
const els = {
  grammar: $('grammar'),
  input: $('input'),
  output: $('output'),
  status: $('grammar-status'),
  timing: $('timing'),
  example: $('example'),
  execution: $('execution'),
  positions: $('positions')
}

let tab = 'result'
/** Rebuilt only when the grammar or the options change, not on every keystroke. */
let built = null

for (const [index, example] of EXAMPLES.entries()) {
  const option = document.createElement('option')
  option.value = String(index)
  option.textContent = example.name
  els.example.append(option)
}

/**
 * Builds a parser from the grammar pane.
 *
 * A `methods { ... }` block is evaluated here, which is what lets the formula
 * example work in the browser at all — its semantics are JavaScript, carried in
 * the grammar file.
 */
function buildParser () {
  const source = els.grammar.value
  const options = { execution: els.execution.value, positions: els.positions.value }
  const started = performance.now()
  const grammar = parseDefinition(source, { execution: 'interpreted' })
  const methods = grammar.methodsBlock ? evaluateMethodsBlock(grammar.methodsBlock).methods : undefined
  const parser = createParser(grammar, { ...options, methods })
  return { grammar, parser, methods, options, ms: performance.now() - started }
}

const stringify = (value) => JSON.stringify(value, (_, v) => (v === undefined ? '<undefined>' : v), 2)

function renderTokens () {
  const lexer = createLexer(built.grammar.tokens, { positions: built.options.positions })
  const tokens = lexer.tokenize(els.input.value)
  if (tokens.length === 0) return '(no tokens)'
  const width = Math.max(...tokens.map((t) => t.type.length))
  const header = built.options.positions === 'full' ? 'line:col' : 'offset'
  return [`${'type'.padEnd(width)}  ${header.padEnd(9)}  image`, '']
    .concat(tokens.map((t) => {
      const where = built.options.positions === 'full' ? `${t.line}:${t.col}` : String(t.start)
      return `${t.type.padEnd(width)}  ${where.padEnd(9)}  ${JSON.stringify(t.image)}`
    }))
    .join('\n')
}

function renderModule () {
  try {
    return emitModule(built.grammar, {
      positions: built.options.positions,
      execution: built.options.execution,
      methods: built.methods
    })
  } catch (error) {
    return `This grammar cannot be emitted as a module:\n\n${error.message}`
  }
}

function render () {
  els.output.classList.remove('bad')

  if (!built) {
    els.output.textContent = ''
    return
  }

  if (tab === 'json') {
    els.output.textContent = stringify(built.grammar)
    return
  }
  if (tab === 'module') {
    els.output.textContent = renderModule()
    return
  }
  if (tab === 'tokens') {
    try {
      els.output.textContent = renderTokens()
    } catch (error) {
      els.output.classList.add('bad')
      els.output.textContent = error.message
    }
    return
  }

  const started = performance.now()
  try {
    const result = built.parser.parse(els.input.value)
    els.timing.textContent = `parsed in ${(performance.now() - started).toFixed(2)} ms`
    els.output.textContent = result === undefined ? '<undefined>' : stringify(result)
  } catch (error) {
    els.timing.textContent = ''
    els.output.classList.add('bad')
    // A parse failure names what it wanted and where; a lexer failure names the
    // character. Both are more useful than the stack.
    const detail = error.ruleStack ? `\n\nrule stack:\n  ${error.ruleStack.join(' → ')}` : ''
    els.output.textContent = `${error.name || 'Error'}: ${error.message}${detail}`
  }
}

function rebuild () {
  try {
    built = buildParser()
    els.status.textContent = `${Object.keys(built.grammar.rules).length} rules, ` +
      `${built.grammar.tokens.length} tokens, built in ${built.ms.toFixed(1)} ms`
    els.status.classList.remove('bad')
  } catch (error) {
    built = null
    els.status.textContent = 'invalid'
    els.status.classList.add('bad')
    els.output.classList.add('bad')
    els.timing.textContent = ''
    els.output.textContent = `${error.name || 'Error'}: ${error.message}`
    return
  }
  render()
}

/** Keystrokes are cheap; rebuilding a parser is not. */
function debounce (fn, ms) {
  let handle
  return () => {
    clearTimeout(handle)
    handle = setTimeout(fn, ms)
  }
}

const rebuildSoon = debounce(rebuild, 250)
const renderSoon = debounce(render, 120)

els.grammar.addEventListener('input', rebuildSoon)
els.input.addEventListener('input', renderSoon)
els.execution.addEventListener('change', rebuild)
els.positions.addEventListener('change', rebuild)

els.example.addEventListener('change', () => {
  const example = EXAMPLES[Number(els.example.value)]
  els.grammar.value = example.source
  els.input.value = example.input
  rebuild()
})

for (const button of document.querySelectorAll('.tabs button')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tabs button')) other.classList.toggle('active', other === button)
    tab = button.dataset.tab
    render()
  })
}

// Tabs are indentation here, not focus changes.
els.grammar.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return
  event.preventDefault()
  const { selectionStart: start, selectionEnd: end, value } = event.target
  event.target.value = `${value.slice(0, start)}  ${value.slice(end)}`
  event.target.selectionStart = event.target.selectionEnd = start + 2
  rebuildSoon()
})

els.grammar.value = EXAMPLES[0].source
els.input.value = EXAMPLES[0].input
rebuild()
