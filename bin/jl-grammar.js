#!/usr/bin/env node
// @ts-check
'use strict'

/**
 * Generates a parser module from a grammar, the way `peggy` does.
 *
 *   jl-grammar generate <grammar.jlg|grammar.json> [-o out.js] [options]
 *
 * A `.jlg` file is parsed with the grammar-definition language; a `.json` file
 * is read as a grammar object directly.
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseDefinition, emitModule } from '../src/index.js'

const USAGE = `Usage: jl-grammar generate <grammar.jlg|grammar.json> [options]

  -o, --out <file>        Write here instead of stdout
      --format <format>   esm (default) | cjs
      --execution <mode>  generated (default) | interpreted
      --positions <mode>  full (default) | offset
      --memo              Enable packrat memoization
      --no-ll1            Force ordered backtracking
      --max-steps <n>     Runaway guard (0 disables)
      --name <name>       Name recorded in the file header
      --methods <file>    Module whose default export is the semantic methods.
                          Supplying them lets actions that call them be compiled
                          to source, which can remove the json-logic-engine
                          dependency from the generated file entirely.
`

const args = process.argv.slice(2)
if (args[0] !== 'generate' || args.length < 2) {
  console.error(USAGE)
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1)
}

/** Minimal flag parsing: enough for this, without a dependency. */
const flags = {}
let input = null
for (let i = 1; i < args.length; i++) {
  const arg = args[i]
  if (arg === '-o' || arg === '--out') flags.out = args[++i]
  else if (arg === '--format') flags.format = args[++i]
  else if (arg === '--execution') flags.execution = args[++i]
  else if (arg === '--positions') flags.positions = args[++i]
  else if (arg === '--max-steps') flags.maxSteps = Number(args[++i])
  else if (arg === '--name') flags.name = args[++i]
  else if (arg === '--methods') flags.methods = args[++i]
  else if (arg === '--memo') flags.memo = true
  else if (arg === '--no-ll1') flags.ll1 = false
  else if (arg.startsWith('-')) { console.error(`unknown option ${arg}\n\n${USAGE}`); process.exit(1) }
  else input = arg
}

if (!input) { console.error(USAGE); process.exit(1) }

const source = await readFile(input, 'utf8')
const grammar = input.endsWith('.json') ? JSON.parse(source) : parseDefinition(source)
const name = flags.name || grammar.name || path.basename(input, path.extname(input))

let methods
if (flags.methods) {
  const loaded = await import(path.resolve(flags.methods))
  methods = typeof loaded.default === 'function' ? loaded.default() : loaded.default || loaded
}

const output = emitModule(grammar, {
  moduleName: name,
  methods,
  format: flags.format,
  execution: flags.execution,
  positions: flags.positions,
  memo: flags.memo,
  ll1: flags.ll1,
  maxSteps: flags.maxSteps
})

if (flags.out) {
  await writeFile(flags.out, output)
  const engineFree = !/^(?:import|const) .*json-logic-engine/m.test(output)
  console.error(
    `wrote ${flags.out} (${output.length} bytes, ${Object.keys(grammar.rules).length} rules` +
    `${engineFree ? ', no json-logic-engine dependency' : ''})`
  )
} else {
  process.stdout.write(output)
}
