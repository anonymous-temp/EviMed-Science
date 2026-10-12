// From the per-run records to the numbers the decision reads. Pure: no files, no network.
import { THRESHOLDS, decide } from './decide.mjs'
import { BOOTSTRAP_ITERATIONS, BOOTSTRAP_SEED, mean, percentile, pairedBootstrap, seededRandom } from './stats.mjs'

export const ARM_IDS = Object.freeze(['A', 'Aprime', 'B'])
export const KINDS = Object.freeze(['synthesis', 'single'])
export const COMPARISONS = Object.freeze([['B', 'Aprime'], ['B', 'A'], ['Aprime', 'A']])

const round = (value, digits = 4) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)))
const comparisonName = ([left, right]) => `${left}-${right}`

/** Bootstrap of a pooled-rate difference, resampling questions. @param {Array<{ left: { v: number, m: number }, right: { v: number, m: number } }>} items */
export function pairedRateBootstrap(items, { iterations = BOOTSTRAP_ITERATIONS, seed = BOOTSTRAP_SEED } = {}) {
  const rate = (pairs, side) => {
    const markers = pairs.reduce((sum, pair) => sum + pair[side].m, 0)
    return markers ? pairs.reduce((sum, pair) => sum + pair[side].v, 0) / markers : null
  }
  const point = (() => { const l = rate(items, 'left'); const r = rate(items, 'right'); return l == null || r == null ? null : l - r })()
  if (!items.length || point == null) return { n: items.length, mean: null, ciLow: null, ciHigh: null }
  const random = seededRandom(seed)
  const draws = []
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = Array.from({ length: items.length }, () => items[Math.floor(random() * items.length)])
    const l = rate(sample, 'left')
    const r = rate(sample, 'right')
    if (l != null && r != null) draws.push(l - r)
  }
  draws.sort((a, b) => a - b)
  return { n: items.length, mean: point, ciLow: percentile(draws, 0.025), ciHigh: percentile(draws, 0.975) }
}

/**
 * @param {{ runs: any[], compiles: Array<{ topic: string, rep: number, stats: any }>, ledger: any[], corpus: Array<{ id: string, questions: any[] }>,
 *   judgeSanity?: any, config?: any, runId?: string, iterations?: number, minReps?: number }} input
 */
export function summarize({ runs, compiles, ledger, corpus, judgeSanity = null, config = null, runId = null, iterations = BOOTSTRAP_ITERATIONS, minReps = THRESHOLDS.minRepsPerCell }) {
  const kindOf = new Map()
  for (const topic of corpus) for (const question of topic.questions) kindOf.set(`${topic.id}/${question.id}`, question.kind)
  const judged = runs.filter((run) => run.judge?.ok && run.score != null)

  /** (topic/question/arm) -> judged runs */
  const cells = new Map()
  for (const run of judged) {
    const key = `${run.topic}/${run.questionId}/${run.arm}`
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(run)
  }
  const expectedCells = kindOf.size * ARM_IDS.length
  let completeCells = 0
  for (const questionKey of kindOf.keys()) for (const arm of ARM_IDS) if ((cells.get(`${questionKey}/${arm}`)?.length ?? 0) >= minReps) completeCells += 1

  /** question -> mean over its judged repetitions, for questions whose cell is complete. */
  const questionMeans = (arm, kind) => {
    const result = new Map()
    for (const [questionKey, questionKind] of kindOf) {
      if (questionKind !== kind) continue
      const list = cells.get(`${questionKey}/${arm}`) ?? []
      if (list.length >= minReps) result.set(questionKey, mean(list.map((run) => run.score)))
    }
    return result
  }

  const categories = {}
  for (const kind of KINDS) {
    const means = Object.fromEntries(ARM_IDS.map((arm) => [arm, questionMeans(arm, kind)]))
    const arms = {}
    for (const arm of ARM_IDS) {
      const armRuns = judged.filter((run) => run.arm === arm && kindOf.get(`${run.topic}/${run.questionId}`) === kind)
      arms[arm] = {
        questions: means[arm].size,
        runs: armRuns.length,
        correctness: round(mean([...means[arm].values()])),
        tokensPerRun: round(mean(armRuns.map((run) => run.tokens.total)), 0),
        toolCallsPerRun: round(mean(armRuns.map((run) => run.toolCalls)), 2),
        answerCostCnyPerRun: round(mean(armRuns.map((run) => run.cost)), 5),
      }
    }
    const diffs = {}
    for (const [left, right] of COMPARISONS) {
      const shared = [...means[left].keys()].filter((key) => means[right].has(key))
      const boot = pairedBootstrap(shared.map((key) => means[left].get(key) - means[right].get(key)), { iterations })
      diffs[comparisonName([left, right])] = { n: boot.n, mean: round(boot.mean), ciLow: round(boot.ciLow), ciHigh: round(boot.ciHigh) }
    }
    categories[kind] = { questions: [...kindOf.values()].filter((value) => value === kind).length, arms, diffs }
  }

  // Citation integrity: pooled over markers, so an answer with many citations weighs more, as it does for a reader.
  const citationOf = (selection) => {
    const out = {}
    for (const arm of ARM_IDS) {
      const armRuns = runs.filter((run) => run.arm === arm && run.citations && selection(run))
      const markerCount = armRuns.reduce((sum, run) => sum + run.citations.markerCount, 0)
      const verified = armRuns.reduce((sum, run) => sum + run.citations.verified, 0)
      const byStatus = {}
      for (const run of armRuns) for (const [status, count] of Object.entries(run.citations.byStatus)) byStatus[status] = (byStatus[status] ?? 0) + count
      out[arm] = {
        answers: armRuns.length,
        answersWithMarkers: armRuns.filter((run) => run.citations.markerCount > 0).length,
        answersWithMarkersRate: round(armRuns.length ? armRuns.filter((run) => run.citations.markerCount > 0).length / armRuns.length : null),
        markerCount,
        verified,
        verifiedRate: round(markerCount ? verified / markerCount : null),
        markersPerAnswer: round(armRuns.length ? markerCount / armRuns.length : null, 2),
        pageCited: armRuns.reduce((sum, run) => sum + run.citations.pageCited, 0),
        byStatus,
      }
    }
    return out
  }
  const citations = {
    overall: citationOf(() => true),
    synthesis: citationOf((run) => kindOf.get(`${run.topic}/${run.questionId}`) === 'synthesis'),
    single: citationOf((run) => kindOf.get(`${run.topic}/${run.questionId}`) === 'single'),
    diffs: {},
  }
  for (const [left, right] of COMPARISONS) {
    const items = []
    for (const questionKey of kindOf.keys()) {
      const sides = [left, right].map((arm) => {
        const list = runs.filter((run) => run.arm === arm && `${run.topic}/${run.questionId}` === questionKey && run.citations)
        return { v: list.reduce((sum, run) => sum + run.citations.verified, 0), m: list.reduce((sum, run) => sum + run.citations.markerCount, 0) }
      })
      if (sides[0].m || sides[1].m) items.push({ left: sides[0], right: sides[1] })
    }
    const boot = pairedRateBootstrap(items, { iterations })
    citations.diffs[comparisonName([left, right])] = { n: boot.n, mean: round(boot.mean), ciLow: round(boot.ciLow), ciHigh: round(boot.ciHigh) }
  }

  const perTopic = {}
  for (const topic of corpus) {
    perTopic[topic.id] = {}
    for (const arm of ARM_IDS) {
      perTopic[topic.id][arm] = {}
      for (const kind of KINDS) {
        const values = topic.questions.filter((q) => q.kind === kind).map((q) => questionMeans(arm, kind).get(`${topic.id}/${q.id}`)).filter((value) => value != null)
        perTopic[topic.id][arm][kind] = round(mean(values))
      }
    }
  }

  const compileByTopic = {}
  for (const entry of compiles) {
    ;(compileByTopic[entry.topic] ??= []).push(entry.stats)
  }
  const compile = { perTopic: {}, overall: null }
  const allStats = compiles.map((entry) => entry.stats)
  const compileAggregate = (list) => {
    const heldByReason = {}
    for (const stats of list) for (const [reason, count] of Object.entries(stats.heldByReason ?? {})) heldByReason[reason] = (heldByReason[reason] ?? 0) + count
    const claims = list.reduce((sum, stats) => sum + stats.claims, 0)
    const held = list.reduce((sum, stats) => sum + stats.held, 0)
    return {
      compiles: list.length,
      meanCostCny: round(mean(list.map((stats) => stats.cost)), 4),
      meanTokens: round(mean(list.map((stats) => stats.promptTokens + stats.completionTokens)), 0),
      meanRounds: round(mean(list.map((stats) => stats.rounds)), 2),
      meanPages: round(mean(list.map((stats) => stats.pages)), 2),
      meanClaimsWritten: round(mean(list.map((stats) => stats.claims)), 1),
      meanClaimsKept: round(mean(list.map((stats) => stats.kept)), 1),
      claimsWritten: claims,
      claimsHeld: held,
      heldShare: round(claims ? held / claims : null),
      heldByReason,
      meanDocumentsCited: round(mean(list.map((stats) => stats.documentsCited)), 2),
      documents: list[0]?.documents ?? null,
      unreadablePatches: list.filter((stats) => stats.unreadablePatch).length,
    }
  }
  for (const [topic, list] of Object.entries(compileByTopic)) compile.perTopic[topic] = compileAggregate(list)
  if (allStats.length) compile.overall = compileAggregate(allStats)

  const cost = { totalCny: round(ledger.reduce((sum, entry) => sum + (entry.cost || 0), 0), 4), byKind: {}, calls: ledger.length }
  for (const entry of ledger) {
    const kind = String(entry.label).split(':')[0]
    cost.byKind[kind] = round((cost.byKind[kind] ?? 0) + (entry.cost || 0), 4)
  }

  const summary = {
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    config,
    thresholds: THRESHOLDS,
    bootstrap: { iterations, seed: BOOTSTRAP_SEED, unit: 'question (mean over its repetitions)', interval: 'percentile 95%' },
    coverage: { expectedCells, completeCells, minRepsPerCell: minReps, judgedRuns: judged.length, runsRecorded: runs.length },
    categories,
    citations,
    perTopic,
    compile,
    cost,
    judgeSanity,
  }
  summary.decision = decide(summary)
  return summary
}

/** A fixed-width table of the summary for stdout. @param {ReturnType<typeof summarize>} summary */
export function renderTable(summary) {
  const f = (value, digits = 3) => (value == null ? '  n/a' : value.toFixed(digits).padStart(6))
  const lines = []
  lines.push(`run ${summary.runId}  cells complete ${summary.coverage.completeCells}/${summary.coverage.expectedCells}  judged runs ${summary.coverage.judgedRuns}  spend CNY ${summary.cost.totalCny}`)
  lines.push('')
  lines.push('Correctness (0-1, mean of per-question means)')
  lines.push('category     arm        questions  score  tokens/run  searches/run')
  for (const kind of KINDS) {
    for (const arm of ARM_IDS) {
      const row = summary.categories[kind].arms[arm]
      lines.push(`${kind.padEnd(12)} ${arm.padEnd(10)} ${String(row.questions).padStart(9)} ${f(row.correctness)} ${String(row.tokensPerRun ?? 'n/a').padStart(11)} ${f(row.toolCallsPerRun, 2).padStart(13)}`)
    }
  }
  lines.push('')
  lines.push('Paired bootstrap of the difference (95% CI, questions resampled)')
  for (const kind of KINDS) {
    for (const [left, right] of COMPARISONS) {
      const d = summary.categories[kind].diffs[comparisonName([left, right])]
      lines.push(`${kind.padEnd(12)} ${comparisonName([left, right]).padEnd(10)} mean ${f(d.mean)}  CI [${f(d.ciLow)}, ${f(d.ciHigh)}]  n=${d.n}`)
    }
  }
  lines.push('')
  lines.push('Citations checked by code (all answers)')
  lines.push('arm        answers  with markers  markers  verifiedRate  pageCited')
  for (const arm of ARM_IDS) {
    const c = summary.citations.overall[arm]
    lines.push(`${arm.padEnd(10)} ${String(c.answers).padStart(7)} ${f(c.answersWithMarkersRate).padStart(13)} ${String(c.markerCount).padStart(8)} ${f(c.verifiedRate).padStart(13)} ${String(c.pageCited).padStart(10)}`)
  }
  const cd = summary.citations.diffs
  lines.push(`verifiedRate difference B-Aprime ${f(cd['B-Aprime']?.mean)} [${f(cd['B-Aprime']?.ciLow)}, ${f(cd['B-Aprime']?.ciHigh)}]   B-A ${f(cd['B-A']?.mean)} [${f(cd['B-A']?.ciLow)}, ${f(cd['B-A']?.ciHigh)}]`)
  lines.push('')
  if (summary.compile.overall) {
    const o = summary.compile.overall
    lines.push(`Compile (arm B, per topic per repetition): CNY ${o.meanCostCny}, ${o.meanTokens} tokens, ${o.meanRounds} rounds, ${o.meanPages} pages, ${o.meanClaimsKept} claims kept, held ${o.claimsHeld}/${o.claimsWritten} (${f(o.heldShare)}) ${JSON.stringify(o.heldByReason)}`)
  }
  lines.push('')
  lines.push(`DECISION: ${summary.decision.open ? 'OPEN by default' : 'DO NOT open by default'}${summary.decision.inconclusive ? ' (inconclusive)' : ''}`)
  for (const reason of summary.decision.reasons) lines.push(`  ${reason}`)
  return lines.join('\n')
}
