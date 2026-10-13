// The run directory: an append-only record that makes a run resumable, and everything a summary is recomputed from.
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { THRESHOLDS } from './decide.mjs'
import { orderArms, summarize } from './summary.mjs'
import { readUpstreamTrees, upstreamTreeStats } from './upstream.mjs'

/** Where a run keeps the trees arm C searched, inside its own directory; the layout is the export directory's. */
export const RUN_TREES = 'upstream'

/** Records of a JSON-lines file; a torn last line (an interrupted write) is ignored. @param {string} path */
export function readJsonl(path) {
  if (!existsSync(path)) return []
  const records = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { records.push(JSON.parse(line)) } catch { /* torn line */ }
  }
  return records
}

export function appendJsonl(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`)
}

export const runKey = (topic, questionId, arm, rep) => `${topic}/${questionId}/${arm}/${rep}`

/** The latest record per key. @param {any[]} records */
export function latestByKey(records) {
  const latest = new Map()
  for (const record of records) latest.set(record.key, record)
  return latest
}

/**
 * The statistics of one of arm B's compiles, as the 2026-10-12 runs recorded them in `compiled/<topic>-rep<N>/compile.json`,
 * or null. The compiler that wrote them is gone; the pages, the held claims and the patches stay in those directories.
 * @param {string} runDir @param {string} topicId @param {number} rep
 */
function readCompileStats(runDir, topicId, rep) {
  try { return JSON.parse(readFileSync(join(runDir, 'compiled', `${topicId}-rep${rep}`, 'compile.json'), 'utf8')).stats ?? null } catch { return null }
}

/**
 * The summary of a run directory, recomputed from what it holds and with no model call: the latest record per key, the spend
 * ledger, the judge's sanity check, arm B's recorded compile statistics and the trees arm C searched (counted again from
 * their pages). `--stage summarize` and every finished run write this.
 * @param {{ runDir: string, runId: string, corpus: any[], reps: number, arms: string[], config: any }} input
 *   `arms`: the arms the run was to ask; any other arm its records hold is reported too
 */
export function summarizeRunDirectory({ runDir, runId, corpus, reps, arms, config }) {
  const runs = [...latestByKey(readJsonl(join(runDir, 'runs.jsonl'))).values()]
  const compiles = []
  const upstreamTrees = []
  for (const topic of corpus) {
    for (let rep = 1; rep <= reps; rep += 1) {
      const stats = readCompileStats(runDir, topic.id, rep)
      if (stats) compiles.push({ topic: topic.id, rep, stats })
    }
    for (const tree of readUpstreamTrees(join(runDir, RUN_TREES), topic.id)) upstreamTrees.push({ topic: topic.id, tree: tree.name, sha256: tree.sha256, stats: upstreamTreeStats(tree, topic.documents) })
  }
  const sanityPath = join(runDir, 'judge-sanity.json')
  const sanity = existsSync(sanityPath) ? JSON.parse(readFileSync(sanityPath, 'utf8')) : null
  return summarize({
    runs, compiles, upstreamTrees, ledger: readJsonl(join(runDir, 'calls.jsonl')), corpus, config, runId,
    // An arm that was planned and never answered is missing data, not an arm the run did not have.
    arms: orderArms([...arms, ...runs.map((run) => run.arm)]),
    judgeSanity: sanity ? { n: sanity.n, referenceMean: sanity.referenceMean, emptyMean: sanity.emptyMean } : null,
    minReps: reps < THRESHOLDS.minRepsPerCell ? reps : THRESHOLDS.minRepsPerCell,
  })
}

/** CNY already spent by every run directory under `resultsDir` except `exceptRunId`. */
export function spentElsewhere(resultsDir, exceptRunId) {
  if (!existsSync(resultsDir)) return 0
  let total = 0
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === exceptRunId) continue
    for (const record of readJsonl(join(resultsDir, entry.name, 'calls.jsonl'))) total += Number(record.cost) || 0
  }
  return total
}
