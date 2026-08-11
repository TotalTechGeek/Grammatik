/**
 * Produces the published build in `dist/`:
 *
 *   dist/esm/index.js     ES module
 *   dist/esm/runtime.js   ES module, the surface generated parsers import
 *   dist/cjs/index.js     CommonJS
 *   dist/cjs/runtime.js   CommonJS
 *   dist/types/*.d.ts     hand-written type declarations (copied from ./types)
 *
 * `json-logic-engine` is left external so it resolves to whatever version the
 * consumer installed, rather than being inlined.
 *
 * The runtime is a separate entry point rather than a slice of the bundle: a
 * generated parser imports it and nothing else, so it must not drag the
 * analyzer, planner or code generator in behind it. Bundling the two entries
 * independently is what keeps that true — `dist/*\/runtime.js` is a few
 * kilobytes, and anything that leaked into it would show up immediately.
 */

import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const shared = {
  bundle: true,
  // The only runtime dependency; keep it external so consumers dedupe it.
  external: ['json-logic-engine'],
  target: ['es2021', 'node18'],
  logLevel: 'info'
}

const entries = { index: join(root, 'src', 'index.js'), runtime: join(root, 'src', 'runtime.js') }

for (const [name, entry] of Object.entries(entries)) {
  await build({ ...shared, entryPoints: [entry], format: 'esm', platform: 'neutral', outfile: join(dist, 'esm', `${name}.js`) })
  await build({ ...shared, entryPoints: [entry], format: 'cjs', platform: 'node', outfile: join(dist, 'cjs', `${name}.js`) })
}

// The root package is `"type": "module"`, so a bare `.js` under dist/cjs would be
// loaded as ESM. These per-directory markers pin each format, avoiding the
// dual-package trap without renaming files to .mjs/.cjs.
writeFileSync(join(dist, 'esm', 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n')
writeFileSync(join(dist, 'cjs', 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n')

// Type declarations. Hand-written (see ./types) because the public API types are
// known precisely, which is more accurate than inferring `any` from JSDoc.
cpSync(join(root, 'types'), join(dist, 'types'), { recursive: true })

const kb = (file) => `${(statSync(file).size / 1024).toFixed(1)} kB`
console.log(
  `\nbuilt dist/esm, dist/cjs and dist/types` +
  `\n  index   ${kb(join(dist, 'esm', 'index.js'))}` +
  `\n  runtime ${kb(join(dist, 'esm', 'runtime.js'))}`
)
