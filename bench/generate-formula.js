// @ts-check
'use strict'

/** Writes the generated formula parser that `bench/generated.js` measures. */

import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { emitModule } from '../src/index.js'
import { grammar, createFormulaMethods } from '../examples/formula.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', '.generated', 'formula-parser.js')

const options = { functions: new Set(['SUM', 'IF', 'ABS', 'MAX', 'ROUND']), unaryFunctions: new Set(['ABS']) }
const source = emitModule({ ...grammar, name: 'Sheetlang' }, {
  methods: createFormulaMethods(options),
  runtimeSpecifier: '../src/runtime.js',
  positions: 'offset'
})

await mkdir(path.dirname(out), { recursive: true })
await writeFile(out, source)
console.log(
  `wrote .generated/formula-parser.js (${source.length} bytes` +
  `${/^import .*json-logic-engine/m.test(source) ? '' : ', no json-logic-engine dependency'})`
)
