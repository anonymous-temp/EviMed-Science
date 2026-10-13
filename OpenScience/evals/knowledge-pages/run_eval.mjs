#!/usr/bin/env node
// Do compiled knowledge pages make cross-document answers better than kb_search? Three arms can be run: A (kb_search),
// A' (kb_search + decomposition sentence) and C (pages compiled by OpenViking's official skill, exported from the engine,
// + kb_search). Arm B (the pages of the self-built compiler removed on 2026-10-13) is on record under results/2026-10-12-*
// and can only be summarized. See README.md for the design, the thresholds and how to read the results.
// Resumable: run the same command again.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { answerQuestion, MAX_TOOL_CALLS, TOP_K } from './lib/answer.mjs'
import { checkAnswerCitations } from './lib/citations.mjs'
import { ROOT, checkCorpus, loadCorpus, loadRunCorpus } from './lib/corpus.mjs'
import { THRESHOLDS } from './lib/decide.mjs'
import { judgeAnswer } from './lib/judge.mjs'
import { buildKnowledgeBase, treesFor } from './lib/kb.mjs'
import { BudgetExceeded, createLlm, readKeyFile, ledgerTotal } from './lib/llm.mjs'
import { ANSWER_SYSTEM, ARMS, ARM_B_REMOVED, DECOMPOSITION_GUIDANCE, JUDGE_SYSTEM, sha256 } from './lib/prompts.mjs'
import { RUN_TREES, appendJsonl, latestByKey, readJsonl, runKey, spentElsewhere, summarizeRunDirectory } from './lib/store.mjs'
import { BOOTSTRAP_ITERATIONS, BOOTSTRAP_SEED } from './lib/stats.mjs'
import { ARM_IDS, RUNNABLE_ARM_IDS, renderTable } from './lib/summary.mjs'
import { adoptUpstreamTrees, readUpstreamTrees, upstreamTreeStats } from './lib/upstream.mjs'

/**
 * Rough per-unit spend (CNY), used only by --dry-run to print an upper bound. From the spend of the 2026-10-12 runs (an
 * answer cost CNY 0.014 on average without pages and 0.016 with arm B's); arm C's passages are longer, hence the margin.
 */
const ESTIMATE_CNY = { answerRun: 0.02, answerRunWithPages: 0.03, judge: 0.01, sanity: 0.01 }

function parseArgs(argv) {
  const options = {
    runId: null, stage: 'all', reps: 3, arms: [...RUNNABLE_ARM_IDS], topics: null, questionsPerTopic: null, budget: 15, totalCap: 20,
    concurrency: 4, answerModel: 'deepseek-v4-flash', judgeModel: 'deepseek-v4-pro', thinking: 'disabled', temperature: 0.7,
    dryRun: false, forceConfig: false, kbScope: 'topic', reuseFrom: null, upstreamPages: null, resultsDir: join(ROOT, 'results'),
  }
  /** The options the command line named, so that `--stage summarize` can take the others from what the run recorded. */
  const given = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => argv[++index]
    const set = (name, value) => { options[name] = value; given.add(name) }
    switch (flag) {
      case '--run-id': set('runId', next()); break
      case '--stage': set('stage', next()); break
      case '--reps': set('reps', Number(next())); break
      case '--arms': set('arms', next().split(',').map((arm) => arm.trim())); break
      case '--topics': set('topics', next().split(',').map((topic) => topic.trim())); break
      case '--questions-per-topic': set('questionsPerTopic', Number(next())); break
      case '--budget': set('budget', Number(next())); break
      case '--total-cap': set('totalCap', Number(next())); break
      case '--concurrency': set('concurrency', Number(next())); break
      case '--answer-model': set('answerModel', next()); break
      case '--judge-model': set('judgeModel', next()); break
      case '--thinking': set('thinking', next()); break
      case '--temperature': set('temperature', Number(next())); break
      case '--dry-run': set('dryRun', true); break
      case '--force-config': set('forceConfig', true); break
      case '--kb-scope': set('kbScope', next()); break
      case '--reuse-from': set('reuseFrom', next()); break
      case '--upstream-pages': set('upstreamPages', resolvePath(next())); break
      case '--results-dir': set('resultsDir', resolvePath(next())); break
      default: throw new Error(`unknown argument ${flag}`)
    }
  }
  if (options.stage === 'compile') throw new Error('there is no compile stage any more: the harness compiles nothing. Arm C reads trees exported from the engine (--upstream-pages), and arm B\'s compiler was removed on 2026-10-13.')
  if (!['all', 'sanity', 'run', 'summarize'].includes(options.stage)) throw new Error(`unknown --stage ${options.stage}`)
  for (const arm of options.arms) if (!ARM_IDS.includes(arm)) throw new Error(`unknown arm ${arm}`)
  if (options.dryRun && options.stage === 'summarize') throw new Error('--dry-run plans a run; --stage summarize makes no model call and has nothing to plan')
  if (options.arms.includes('B') && options.stage !== 'summarize') throw new Error(ARM_B_REMOVED)
  if (!['topic', 'pooled'].includes(options.kbScope)) throw new Error('--kb-scope must be topic or pooled')
  if (!Number.isInteger(options.reps) || options.reps < 1) throw new Error('--reps must be a positive integer')
  if (!options.runId && !options.dryRun) throw new Error('--run-id <id> is required: it names the directory under results/ the run is written to (or read from)')
  return { options, given }
}

function seedOf(key) {
  return Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, 7), 16)
}

async function runPool(tasks, concurrency, work, shouldStop) {
  let next = 0
  const failures = []
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < tasks.length && !shouldStop()) {
      const task = tasks[next++]
      try { await work(task) } catch (error) {
        if (error instanceof BudgetExceeded) { failures.push({ budget: true, message: error.message }); return }
        failures.push({ key: task.key ?? null, message: String(error?.message ?? error).slice(0, 300) })
      }
    }
  })
  await Promise.all(workers)
  return failures
}

/** `summary.json` of a run directory, and the table on stdout. @param {Parameters<typeof summarizeRunDirectory>[0]} input */
function writeSummary(input) {
  const summary = summarizeRunDirectory(input)
  writeFileSync(join(input.runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`\n${renderTable(summary)}`)
}

/**
 * `--stage summarize`: recompute a recorded run's summary. The plan (arms, repetitions, topics) and the configuration are
 * the ones the run recorded in `config.json`, unless the command line names them; nothing but `summary.json` is written.
 */
async function summarizeRecorded(options, given) {
  const runDir = join(options.resultsDir, options.runId)
  const configPath = join(runDir, 'config.json')
  if (!existsSync(join(runDir, 'runs.jsonl')) && !existsSync(configPath)) throw new Error(`nothing is recorded under ${runDir}`)
  const recorded = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null
  const planned = (name) => (given.has(name) || recorded?.plan?.[name] === undefined ? options[name] : recorded.plan[name])
  const corpus = await loadRunCorpus(planned('topics'), planned('questionsPerTopic'))
  // With no arms named and none recorded, the summary covers the arms the records hold.
  const arms = given.has('arms') ? options.arms : recorded?.plan?.arms ?? []
  writeSummary({ runDir, runId: options.runId, corpus, reps: planned('reps'), arms, config: recorded?.core ?? null })
}

async function main() {
  const { options, given } = parseArgs(process.argv.slice(2))
  const corpusReport = await checkCorpus()
  if (corpusReport.issues.length) { for (const issue of corpusReport.issues) console.error(`corpus: ${issue}`); throw new Error('the corpus does not check out; run check_corpus.mjs') }
  if (options.stage === 'summarize') return summarizeRecorded(options, given)

  const corpus = await loadRunCorpus(options.topics, options.questionsPerTopic)
  const fullCorpus = await loadCorpus()
  const questionTotal = fullCorpus.reduce((sum, topic) => sum + topic.questions.length, 0)
  const runDir = options.runId ? join(options.resultsDir, options.runId) : null
  const pooled = options.kbScope === 'pooled'

  const config = {
    schemaVersion: 2,
    models: { answer: options.answerModel, judge: options.judgeModel },
    thinking: options.thinking,
    kbScope: options.kbScope,
    temperature: { answer: options.temperature, judge: 0 },
    retrieval: { engine: 'bm25', topK: TOP_K, maxToolCalls: MAX_TOOL_CALLS },
    prompts: { answerSystemSha256: sha256(ANSWER_SYSTEM), decompositionSentence: DECOMPOSITION_GUIDANCE, judgeSystemSha256: sha256(JUDGE_SYSTEM) },
    thresholds: THRESHOLDS,
    bootstrap: { iterations: BOOTSTRAP_ITERATIONS, seed: BOOTSTRAP_SEED },
    arms: Object.fromEntries(RUNNABLE_ARM_IDS.map((arm) => [arm, ARMS[arm].label])),
  }
  const configPath = runDir ? join(runDir, 'config.json') : null
  // Checked before anything is written: a run directory made under other settings is not added to.
  const otherSettings = Boolean(configPath) && existsSync(configPath) && JSON.stringify(JSON.parse(readFileSync(configPath, 'utf8')).core) !== JSON.stringify(config)
  if (otherSettings && !options.forceConfig && !options.dryRun) {
    throw new Error(`${configPath} was written with different models, prompts or settings; use a new --run-id (or --force-config to keep going on purpose)`)
  }
  // Read before anything is written, so that a run that cannot start leaves no directory behind. The key stays in memory.
  const apiKey = options.dryRun ? null : readKeyFile(process.env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE)

  // --- arm C's pages -------------------------------------------------------------------------------------------------------
  // A run that reuses another's judge check searches that run's trees too, unless told otherwise.
  const reusedTrees = options.reuseFrom ? join(options.resultsDir, options.reuseFrom, RUN_TREES) : null
  const exportDir = options.upstreamPages ?? (reusedTrees && existsSync(reusedTrees) ? reusedTrees : join(ROOT, 'upstream'))
  const runTrees = runDir ? join(runDir, RUN_TREES) : null
  /** topic id -> the trees this run searches for it; empty when the topic has none. A dry run copies nothing. */
  const trees = new Map()
  /** topic id -> what each of its trees holds, for the plan. */
  const treeStats = new Map()
  /** The topics whose trees the run already holds: it reads only those (see `adoptUpstreamTrees`). */
  const heldByRun = []
  if (options.arms.includes('C')) {
    for (const topic of corpus) {
      const held = runTrees ? readUpstreamTrees(runTrees, topic.id) : []
      if (held.length) heldByRun.push(topic.id)
      const candidates = held.length ? held : readUpstreamTrees(exportDir, topic.id)
      // Checked before anything is copied. A tree compiled from documents pushed under other ids (a project of the product
      // derives its own) names none of the topic's documents, and every source of every page would be a dead end.
      const stats = candidates.map((tree) => ({ tree: tree.name, ...upstreamTreeStats(tree, topic.documents) }))
      for (const entry of stats) {
        if (entry.sourceLinks && !entry.documentsCited) throw new Error(`${topic.id}/${entry.tree}: none of its ${entry.sourceLinks} source links names one of the topic's ${topic.documents.length} documents, so it was compiled from documents pushed under other ids. Push corpus/${topic.id}/docs under the ids of its manifest.json (sources/<sourceId>.md) and compile again.`)
      }
      treeStats.set(topic.id, stats)
      trees.set(topic.id, held.length || options.dryRun ? candidates : adoptUpstreamTrees({ from: exportDir, to: runTrees, topicId: topic.id }))
    }
  }
  /** The trees an arm C cell searches, or null when the cell cannot be asked. */
  const cellTrees = (topic, rep) => treesFor({ scope: options.kbScope, topic, corpus, trees, rep })
  const skippedTopics = options.arms.includes('C') ? corpus.filter((topic) => !cellTrees(topic, 1)).map((topic) => topic.id) : []

  const sanityPath = runDir ? join(runDir, 'judge-sanity.json') : null
  const sanityDone = () => Boolean(sanityPath) && existsSync(sanityPath) && JSON.parse(readFileSync(sanityPath, 'utf8')).n === questionTotal
  /** Another run's judge check stands for this one only if it was the same judge under the same instructions. */
  const reusableSanity = () => {
    if (!options.reuseFrom) return null
    const directory = join(options.resultsDir, options.reuseFrom)
    try {
      const core = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')).core
      if (core.models.judge !== options.judgeModel || core.prompts.judgeSystemSha256 !== sha256(JUDGE_SYSTEM)) return null
      return JSON.parse(readFileSync(join(directory, 'judge-sanity.json'), 'utf8')).n === questionTotal ? join(directory, 'judge-sanity.json') : null
    } catch { return null }
  }

  if (options.dryRun) {
    const cells = corpus.reduce((sum, topic) => sum + topic.questions.length, 0)
    const skippedCells = corpus.filter((topic) => skippedTopics.includes(topic.id)).reduce((sum, topic) => sum + topic.questions.length, 0)
    const plain = cells * options.arms.filter((arm) => !ARMS[arm].pages).length * options.reps
    const withPages = (cells - skippedCells) * options.arms.filter((arm) => ARMS[arm].pages).length * options.reps
    const sanityCalls = ['all', 'sanity'].includes(options.stage) && !sanityDone() && !reusableSanity() ? questionTotal * 2 : 0
    const upper = plain * ESTIMATE_CNY.answerRun + withPages * ESTIMATE_CNY.answerRunWithPages + (plain + withPages) * ESTIMATE_CNY.judge + sanityCalls * ESTIMATE_CNY.sanity
    const elsewhere = spentElsewhere(options.resultsDir, options.runId)
    console.log(JSON.stringify({
      runId: options.runId, kbScope: options.kbScope, topics: corpus.map((topic) => topic.id), questions: cells, arms: options.arms, reps: options.reps,
      answerRuns: plain + withPages, judgeCalls: plain + withPages, judgeSanityCalls: sanityCalls,
      ...(options.arms.includes('C') ? { upstreamPages: {
        exportDir, heldByRun,
        trees: Object.fromEntries(corpus.map((topic) => [topic.id, treeStats.get(topic.id).map((entry) => `${entry.tree}: ${entry.pages} pages, ${entry.besideClaims} source links beside claims, ${entry.present}/${entry.besideClaimsWithQuotation} quotations found in the named document`)])),
        topicsSkipped: skippedTopics, answerRunsSkipped: skippedCells * options.reps,
      } } : {}),
      estimatedUpperBoundCny: Number(upper.toFixed(2)),
      spentInOtherRunsCny: Number(elsewhere.toFixed(2)),
      capForThisRunCny: Number(Math.min(options.budget, options.totalCap - elsewhere).toFixed(2)),
      ...(otherSettings ? { refused: `${configPath} was written with different settings: a run under this id needs --force-config, or a new --run-id` } : {}),
    }, null, 2))
    return
  }

  const plan = {
    reps: options.reps, arms: options.arms, topics: corpus.map((topic) => topic.id), questionsPerTopic: options.questionsPerTopic, budgetCny: options.budget, totalCapCny: options.totalCap, concurrency: options.concurrency,
    ...(options.arms.includes('C') ? { upstreamTrees: Object.fromEntries(corpus.map((topic) => [topic.id, trees.get(topic.id).map((tree) => ({ tree: tree.name, pages: tree.pages.length, sha256: tree.sha256 }))])) } : {}),
  }
  mkdirSync(runDir, { recursive: true })
  writeFileSync(configPath, `${JSON.stringify({ core: config, plan, startedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  for (const topic of skippedTopics) console.log(`arm C skipped for ${topic}: ${pooled ? 'the pooled project needs a tree of every topic and one is missing' : `no tree under ${join(exportDir, topic)}/rep<N>/`}`)

  const ledgerPath = join(runDir, 'calls.jsonl')
  const elsewhere = spentElsewhere(options.resultsDir, options.runId)
  const cap = Math.min(options.budget, options.totalCap - elsewhere)
  const llm = createLlm({ apiKey, ledgerPath, budget: cap })
  console.log(`run ${options.runId}: spent so far CNY ${ledgerTotal(ledgerPath).toFixed(4)} here, ${elsewhere.toFixed(4)} in other runs; cap for this run CNY ${cap.toFixed(2)}`)
  let stopped = false

  // --- the judge's sanity check ------------------------------------------------------------------------------------------
  async function judgeSanity() {
    const reusable = sanityDone() ? null : reusableSanity()
    if (reusable) cpSync(reusable, sanityPath)
    if (sanityDone()) return
    const rows = []
    const tasks = fullCorpus.flatMap((topic) => topic.questions.map((question) => ({ topic: topic.id, question })))
    const failures = await runPool(tasks, options.concurrency, async ({ topic, question }) => {
      const reference = question.reference.keyPoints.map((point) => `- ${point.text}`).join('\n')
      const empty = 'The knowledge base does not contain this information.'
      const [ref, none] = await Promise.all([
        judgeAnswer({ llm, model: options.judgeModel, question, answer: reference, label: `sanity:reference:${topic}/${question.id}` }),
        judgeAnswer({ llm, model: options.judgeModel, question, answer: empty, label: `sanity:empty:${topic}/${question.id}` }),
      ])
      rows.push({ topic, id: question.id, reference: ref.score, empty: none.score })
    }, () => stopped)
    if (failures.some((failure) => failure.budget)) stopped = true
    const complete = rows.filter((row) => row.reference != null && row.empty != null)
    if (complete.length === questionTotal) {
      const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
      writeFileSync(sanityPath, `${JSON.stringify({ n: complete.length, referenceMean: mean(complete.map((row) => row.reference)), emptyMean: mean(complete.map((row) => row.empty)), rows: complete }, null, 2)}\n`, 'utf8')
      console.log(`judge sanity: reference answers ${mean(complete.map((row) => row.reference)).toFixed(3)}, empty answers ${mean(complete.map((row) => row.empty)).toFixed(3)}`)
    } else console.log(`judge sanity incomplete (${complete.length}/${questionTotal}); ${failures.length} failures`)
  }

  // --- answer and judge ---------------------------------------------------------------------------------------------------
  const runsPath = join(runDir, 'runs.jsonl')
  const latest = latestByKey(readJsonl(runsPath))
  const indexCache = new Map()
  /** One index per distinct knowledge base: the documents of a project and, for arm C, the trees of that repetition. */
  function indexFor(topic, arm, rep, chosen) {
    const pages = chosen ? Object.entries(chosen).map(([id, tree]) => `${id}:${tree.name}`).join(',') : 'docs'
    const key = `${pooled ? 'pooled' : topic.id}/${pages}`
    if (!indexCache.has(key)) indexCache.set(key, buildKnowledgeBase({ scope: options.kbScope, arm, topic, corpus, trees, rep }))
    return indexCache.get(key)
  }
  const allDocuments = corpus.flatMap((topic) => topic.documents)

  async function runRep(rep) {
    const ready = []
    for (const topic of corpus) {
      for (const question of topic.questions) {
        for (const arm of options.arms) {
          const key = runKey(topic.id, question.id, arm, rep)
          const existing = latest.get(key)
          if (existing?.stage === 'judged' && existing.judge?.ok) continue
          const chosen = ARMS[arm].pages ? cellTrees(topic, rep) : null
          if (ARMS[arm].pages && !chosen) continue
          ready.push({ key, topic, question, arm, rep, chosen })
        }
      }
    }
    if (!ready.length) return 0
    let finished = 0
    const failures = await runPool(ready, options.concurrency, async (task) => {
      const { topic, question, arm, chosen } = task
      const resolve = (id) => { const document = (pooled ? allDocuments : topic.documents).find((entry) => entry.sourceId === id); return document ? { text: document.text } : null }
      let record = latest.get(task.key)
      if (!record?.answered) {
        const started = Date.now()
        const result = await answerQuestion({ llm, model: options.answerModel, arm, question: question.question, index: indexFor(topic, arm, task.rep, chosen), label: `answer:${task.key}`, temperature: options.temperature, thinking: options.thinking, seed: seedOf(task.key), meta: { key: task.key } })
        record = {
          key: task.key, topic: topic.id, questionId: question.id, kind: question.kind, arm, rep: task.rep, stage: 'answered', answered: true,
          // Which tree of each topic the knowledge base held: trees are reused in order when a topic has fewer than there are repetitions.
          ...(chosen ? { pages: Object.fromEntries(Object.entries(chosen).map(([id, tree]) => [id, tree.name])) } : {}),
          answer: result.answer, finished: result.finished, toolCalls: result.toolCalls, searches: result.searches, tokens: result.tokens, cost: result.cost,
          citations: checkAnswerCitations(result.answer, resolve), durationMs: Date.now() - started, finishedAt: new Date().toISOString(),
        }
        appendJsonl(runsPath, record)
        latest.set(task.key, record)
      }
      const judged = await judgeAnswer({ llm, model: options.judgeModel, question, answer: record.answer, label: `judge:${task.key}`, meta: { key: task.key } })
      const final = { ...record, stage: 'judged', judge: { ok: judged.ok, malformed: judged.malformed, points: judged.points, tokens: judged.tokens, cost: judged.cost }, score: judged.score }
      appendJsonl(runsPath, final)
      latest.set(task.key, final)
      finished += 1
      if (finished % 10 === 0) console.log(`rep${rep}: ${finished}/${ready.length} done, spend CNY ${llm.spent.toFixed(3)}`)
    }, () => stopped)
    if (failures.some((failure) => failure.budget)) stopped = true
    for (const failure of failures.filter((entry) => !entry.budget)) console.error(`task failed: ${failure.key}: ${failure.message}`)
    return failures.length
  }

  if (options.stage === 'sanity' || options.stage === 'all') await judgeSanity()
  if (options.stage === 'run' || options.stage === 'all') {
    for (let rep = 1; rep <= options.reps && !stopped; rep += 1) await runRep(rep)
  }
  if (stopped) console.log(`STOPPED at the budget cap (spend CNY ${llm.spent.toFixed(3)} of ${cap.toFixed(2)}). Everything finished is saved; run the same command again after raising --budget to continue.`)

  writeSummary({ runDir, runId: options.runId, corpus, reps: options.reps, arms: options.arms, config })
}

main().catch((error) => {
  console.error(`run_eval failed: ${String(error?.message ?? error).slice(0, 500)}`)
  process.exit(1)
})
