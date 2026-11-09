#!/usr/bin/env node
/**
 * The domain's copy of the external validation (plan R27): `packages/domain/src/vcr-external-validation.json`, computed from the committed result, never typed.
 *
 *   node summarise.mjs <result-YYYYMMDD.json>            print the JSON
 *   node summarise.mjs <result-YYYYMMDD.json> --write    write it to the domain
 *   node summarise.mjs <result-YYYYMMDD.json> --check    exit 1 when the domain's copy is not what the result gives
 *
 * Hidden knowledge: the premise on an Alzheimer page says "predicted 78-week change is off by X points on N trials"; X and N are read from this file, which is
 * made from the result by this script and by nothing else.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.resolve(here, '../../../packages/domain/src/vcr-external-validation.json')

/** @param {string} resultPath */
export function summarise(resultPath) {
  const bytes = readFileSync(resultPath)
  const result = JSON.parse(bytes.toString('utf8'))
  if (result.synthetic) throw new Error('a synthetic run is never a result')
  const trialsDoc = JSON.parse(readFileSync(path.join(here, 'trials.json'), 'utf8'))
  const round = (/** @type {number} */ x) => Number(x.toPrecision(4))
  const arm = (/** @type {any} */ s) => ({ arms: s.trials, meanBias: round(s.meanBias), meanAbsoluteBias: round(s.meanAbsoluteBias), rmse: round(s.rmse), meanZ: round(s.meanZ), covered: s.coverage })
  const spread = (/** @type {(r: any) => boolean} */ pick) => {
    const d = result.trials.filter(pick).map((/** @type {any} */ r) => Math.abs(r.conradoStructure.differenceFromPrimary))
    return d.length ? round(d.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) / d.length) : null
  }
  const ranges = trialsDoc.trials.map((/** @type {any} */ t) => t.mmse.entryRange)
  return {
    schemaVersion: 1,
    protocol: 'evals/vcr-in-silico/external-validation',
    resultSha256: createHash('sha256').update(bytes).digest('hex'),
    ranOn: String(result.ranOn).slice(0, 10),
    arms: result.trials.length,
    primary: { long: { weeks: result.summary.longHorizon.weeks, ...arm(result.summary.longHorizon.primary) }, short: { weeks: result.summary.shortHorizon.weeks, ...arm(result.summary.shortHorizon.primary) }, all: arm(result.summary.all.primary) },
    noBackground: { long: arm(result.summary.longHorizon.noBackground), short: arm(result.summary.shortHorizon.noBackground), all: arm(result.summary.all.noBackground) },
    secondStructure: {
      name: 'Conrado et al. 2014', long: arm(result.summary.longHorizon.conradoStructure), short: arm(result.summary.shortHorizon.conradoStructure), all: arm(result.summary.all.conradoStructure),
      meanAbsoluteDifferenceFromPrimary: { long: spread((/** @type {any} */ r) => r.endpointWeek >= 76), short: spread((/** @type {any} */ r) => r.endpointWeek < 76) },
    },
    domain: { mmseHull: [Math.min(...ranges.map((/** @type {number[]} */ r) => r[0])), Math.max(...ranges.map((/** @type {number[]} */ r) => r[1]))], horizonsWeeks: [...new Set(trialsDoc.trials.map((/** @type {any} */ t) => t.endpointWeek))].sort((a, b) => a - b), onlyPlacebo: true },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [resultPath, flag] = process.argv.slice(2)
  if (!resultPath) { console.error('usage: summarise.mjs <result.json> [--write|--check]'); process.exit(2) }
  const text = `${JSON.stringify(summarise(path.resolve(resultPath)), null, 2)}\n`
  if (flag === '--write') writeFileSync(target, text)
  else if (flag === '--check') { if (readFileSync(target, 'utf8') !== text) { console.error('the domain copy of the external validation is not what the result gives'); process.exit(1) } }
  else process.stdout.write(text)
}
