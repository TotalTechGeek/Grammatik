// @ts-check
'use strict'

/**
 * Builds the sandbox into `docs/`, which is what GitHub Pages serves.
 *
 * Everything is inlined: the toolkit, json-logic-engine, and the example
 * grammars read out of `examples/`. The page then has no network dependency at
 * all, which matters more than it sounds — a playground that breaks when a CDN
 * changes is worse than no playground.
 */

import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'docs')
mkdirSync(out, { recursive: true })

/** The example grammars, so the picker is never out of step with the repo. */
const EXAMPLES = [
  ['Arithmetic', 'arithmetic.gram', '5*3+2*5-1'],
  ['Excel formulas', 'formula.gram', 'IF(A1>=10, SUM(B1:B5), ABS(C1))']
]

const examples = EXAMPLES.map(([name, file, input]) => ({
  name,
  input,
  source: readFileSync(path.join(root, 'examples', file), 'utf8')
}))

// Written for the sandbox rather than taken from examples/: these carry their
// own `methods` blocks, so a reader can see the whole language in one pane.
for (const [name, file, input] of [
  ['JSON', 'json.gram', '{"a": [1, true, null], "b": {"c": "d"}}'],
  ['Template (lexer modes)', 'template.gram', 'Hello {{ name }}, you have {{ count }} messages.']
]) {
  examples.push({ name, input, source: readFileSync(path.join(root, 'site', file), 'utf8') })
}

const bundle = await build({
  stdin: { contents: "export * from '../src/index.js'", resolveDir: path.join(root, 'site') },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  write: false,
  logLevel: 'info'
})

writeFileSync(path.join(out, 'grammatik.js'), bundle.outputFiles[0].text)
writeFileSync(path.join(out, 'examples.js'), `export const EXAMPLES = ${JSON.stringify(examples)}\n`)
writeFileSync(path.join(out, 'sandbox.js'), readFileSync(path.join(root, 'site', 'sandbox.js'), 'utf8'))
writeFileSync(path.join(out, 'index.html'), readFileSync(path.join(root, 'site', 'index.html'), 'utf8'))
writeFileSync(path.join(out, 'style.css'), readFileSync(path.join(root, 'site', 'style.css'), 'utf8'))
// Tells Pages not to run the output through Jekyll, which would eat nothing here
// but is one less thing to debug later.
writeFileSync(path.join(out, '.nojekyll'), '')

const size = (file) => `${(readdirSync(out).includes(file) ? readFileSync(path.join(out, file)).length / 1024 : 0).toFixed(1)} kB`
console.log(`built docs/  grammatik.js ${size('grammatik.js')}  examples.js ${size('examples.js')}`)
