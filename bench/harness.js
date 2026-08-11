// @ts-check
'use strict'

/** Shared timing + reporting helpers for the benchmark scripts. */


/**
 * Times `fn` by running it in batches until `budgetMs` elapses.
 * Reports the best batch rate, which is far more stable than the mean on a
 * JIT-compiled runtime where GC pauses land arbitrarily.
 *
 * @param {string} name
 * @param {() => any} fn
 * @param {{ warmupMs?: number, budgetMs?: number }} [options]
 */
export function measure (name, fn, options = {}) {
  const { warmupMs = 300, budgetMs = 1500, minWarmupOps = 60 } = options

  // The driving loop is written inline, deliberately.
  //
  // An earlier version hoisted it into a per-measurement driver function to keep
  // the `fn()` call site monomorphic. That was a theoretical fix for a problem
  // that never showed up, and it caused a real one: a driver built with
  // `new Function` ran the same 2.8 ms operation in 419 ms, and even a plain
  // closure factory reproduced it for every measurement after the first. Both
  // looked exactly like code regressions. An inline loop has none of that, and
  // measurements are order-independent to under 1% with it.

  // Warm up on time *and* iteration count.
  //
  // Time alone is not enough: a slow operation runs only a handful of times in
  // the warmup window, which is not enough for V8 to tier the code up, so the
  // cost estimate below is taken from unoptimized execution. That estimate then
  // sizes the batches, and the whole measurement runs on cold code — which
  // reported a 2.8 ms lexer pass as 420 ms, a 100x error that looked exactly
  // like a code regression.
  const warmupEnd = performance.now() + warmupMs
  const hardStop = performance.now() + warmupMs + 5000
  let warmupOps = 0
  while ((performance.now() < warmupEnd || warmupOps < minWarmupOps) && performance.now() < hardStop) {
    fn()
    warmupOps++
  }

  // Re-probe on warm code; the warmup average is skewed by the cold iterations.
  const probeStart = performance.now()
  for (let i = 0; i < 3; i++) fn()
  const perOpMs = (performance.now() - probeStart) / 3

  // Size the batch from the measured cost so a batch lands near `targetBatchMs`.
  // Fixed doubling was the bug here: for an operation taking ~10 ms it produced
  // batches lasting seconds, so only a couple of samples fit in the budget and
  // whichever one caught a GC pause set the reported rate. Sizing by cost keeps
  // the sample count high for slow and fast operations alike.
  const targetBatchMs = 50
  const batch = Math.max(1, Math.min(4096, Math.round(targetBatchMs / Math.max(perOpMs, 1e-6))))

  let bestRate = 0
  let iterations = 0
  let samples = 0
  const end = performance.now() + budgetMs
  while (performance.now() < end) {
    const start = performance.now()
    for (let i = 0; i < batch; i++) fn()
    const elapsed = performance.now() - start
    iterations += batch
    samples++
    if (elapsed > 0) bestRate = Math.max(bestRate, batch / (elapsed / 1000))
  }

  return { name, opsPerSec: bestRate, iterations, samples, batch }
}

/**
 * @param {string} title
 * @param {{ name: string, opsPerSec: number, iterations: number }[]} results
 * @param {string} baselineName
 */
export function report (title, results, baselineName) {
  const baseline = results.find((r) => r.name === baselineName)
  const nameWidth = Math.max(...results.map((r) => r.name.length))

  console.log(`\n${title}`)
  console.log('-'.repeat(title.length))

  for (const result of results) {
    const ops = result.opsPerSec
    const relative = baseline ? ops / baseline.opsPerSec : 1
    const bar = '#'.repeat(Math.max(1, Math.round(Math.log10(Math.max(ops, 1)) * 6)))
    console.log(
      `  ${result.name.padEnd(nameWidth)}  ` +
      `${formatOps(ops).padStart(12)} ops/s  ` +
      `${relative.toFixed(2).padStart(7)}x  ${bar}`
    )
  }
  if (baseline) console.log(`  (relative to ${baselineName})`)
}

export const formatOps = (n) =>
  n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1)

// --------------------------------------------------------------- payloads ---

/** Builds a deterministic, realistically-shaped JSON document. */
export function buildDocument (recordCount) {
  let seed = 12345
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }

  const records = []
  for (let i = 0; i < recordCount; i++) {
    records.push({
      id: i,
      name: `record-${i}`,
      active: random() < 0.5,
      score: Math.round(random() * 10000) / 100,
      tags: Array.from({ length: Math.floor(random() * 4) }, (_, t) => `tag-${t}`),
      meta: random() < 0.3 ? null : { created: '2026-08-11T00:00:00Z', weight: random(), nested: { depth: 2, ok: true } }
    })
  }
  return JSON.stringify({ version: 1, generated: '2026-08-11', records })
}

