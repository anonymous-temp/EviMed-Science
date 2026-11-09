#!/usr/bin/env node
// The RUN file's tables, printed from the committed result so that no number in it is typed: node tables.mjs result-YYYYMMDD.json
import { readFileSync } from 'node:fs'
const r = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const f = (/** @type {number|null} */ x, d = 2) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d))
const s = (/** @type {number} */ x) => (x > 0 ? `+${f(x)}` : f(x))
const cell = (/** @type {any} */ m) => `${f(m.predicted)} [${f(m.lower)}, ${f(m.upper)}]`
console.log('### Primary (background donepezil), per arm\n')
console.log('| Arm | wk | N | Observed (SE) | Predicted [2.5, 97.5] | Bias | z | Covered | Model baseline vs reported | Model completion vs reported |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const t of r.trials) {
  const m = t.primary.metrics
  console.log(`| ${t.label.split(',')[0]} | ${t.endpointWeek} | ${t.nSimulated} | ${f(t.observed.change)} (${f(t.observed.se)}) | ${cell(m)} | ${s(m.bias)} | ${f(m.z)} | ${m.covered ? 'yes' : 'no'} | ${f(t.primary.baselineModelAdas, 1)} vs ${t.baselineReported.mean} | ${f(t.primary.completionModel * 100, 0)}% vs ${f(t.completionReported.share * 100, 0)}% |`)
}
console.log('\n### No background, and the second structure, per arm\n')
console.log('| Arm | No background: predicted [2.5, 97.5] | bias | covered | Conrado 2014: predicted [2.5, 97.5] | bias | covered | difference from primary |')
console.log('|---|---|---|---|---|---|---|---|')
for (const t of r.trials) {
  const a = t.noBackground.metrics; const c = t.conradoStructure.metrics
  console.log(`| ${t.label.split(',')[0]} | ${cell(a)} | ${s(a.bias)} | ${a.covered ? 'yes' : 'no'} | ${cell(c)} | ${s(c.bias)} | ${c.covered ? 'yes' : 'no'} | ${s(t.conradoStructure.differenceFromPrimary)} |`)
}
console.log('\n### Summary\n')
console.log('| Set | Horizon | Arms | Mean bias | Mean abs. bias | RMSE | Mean z | Covered |')
console.log('|---|---|---|---|---|---|---|---|')
for (const [name, key] of [['primary', 'primary'], ['no background', 'noBackground'], ['Conrado 2014', 'conradoStructure']]) {
  for (const [h, hk] of [['76-78 wk', 'longHorizon'], ['24 wk', 'shortHorizon'], ['all', 'all']]) {
    const x = r.summary[hk][key]
    console.log(`| ${name} | ${h} | ${x.trials} | ${s(x.meanBias)} | ${f(x.meanAbsoluteBias)} | ${f(x.rmse)} | ${f(x.meanZ)} | ${x.coverage}/${x.trials} |`)
  }
}
