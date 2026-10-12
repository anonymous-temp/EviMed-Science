// The run directory: an append-only record that makes a run resumable.
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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
