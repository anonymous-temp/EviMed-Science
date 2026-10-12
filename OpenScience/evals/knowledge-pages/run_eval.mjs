#!/usr/bin/env node
// Three-arm evaluation of knowledge pages: A (kb_search), A' (kb_search + decomposition sentence), B (pages + kb_search).
// See README.md for the design, the thresholds and how to read the results. Resumable: run the same command again.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerQuestion, MAX_TOOL_CALLS, TOP_K } from './lib/answer.mjs'
import { checkAnswerCitations } from './lib/citations.mjs'
import { compileTopic, readCompiled, writeCompiled } from './lib/compile.mjs'
import { ROOT, checkCorpus, loadCorpus } from './lib/corpus.mjs'
import { THRESHOLDS } from './lib/decide.mjs'
import { judgeAnswer } from './lib/judge.mjs'
import { BudgetExceeded, createLlm, readKeyFile, ledgerTotal } from './lib/llm.mjs'
import { ANSWER_SYSTEM, ARMS, DECOMPOSITION_GUIDANCE, JUDGE_SYSTEM, compileUserMessage, repairUserMessage, sha256 } from './lib/prompts.mjs'
import { buildIndex } from './lib/retrieval.mjs'
import { appendJsonl, latestByKey, readJsonl, runKey, spentElsewhere } from './lib/store.mjs'
import { BOOTSTRAP_ITERATIONS, BOOTSTRAP_SEED } from './lib/stats.mjs'
import { ARM_IDS, renderTable, summarize } from './lib/summary.mjs'

const RESULTS_DIR = join(ROOT, 'results')
const SKILL_PATH = join(ROOT, '..', '..', 'capabilities', 'knowledge-compile', 'SKILL.md')
const DOMAIN_PAGE_PATH = join(ROOT, '..', '..', 'packages', 'domain', 'src', 'knowledgePage.mjs')

/** Rough per-unit spend (CNY), used only by --dry-run to print an upper bound. */
const ESTIMATE_CNY = { answerRun: 0.05, judge: 0.02, compile: 0.4, sanity: 0.012 }

function parseArgs(argv) {
  const options = {
    runId: '2026-10-12-three-arm', stage: 'all', reps: 3, arms: [...ARM_IDS], topics: null, questionsPerTopic: null, budget: 15, totalCap: 20,
    concurrency: 4, answerModel: 'deepseek-v4-flash', judgeModel: 'deepseek-v4-pro', compileModel: 'deepseek-v4-flash', thinking: 'disabled',
    temperature: 0.7, compileTemperature: 0.3, dryRun: false, forceConfig: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => argv[++index]
    switch (flag) {
      case '--run-id': options.runId = next(); break
      case '--stage': options.stage = next(); break
      case '--reps': options.reps = Number(next()); break
      case '--arms': options.arms = next().split(',').map((arm) => arm.trim()); break
      case '--topics': options.topics = next().split(',').map((topic) => topic.trim()); break
      case '--questions-per-topic': options.questionsPerTopic = Number(next()); break
      case '--budget': options.budget = Number(next()); break
      case '--total-cap': options.totalCap = Number(next()); break
      case '--concurrency': options.concurrency = Number(next()); break
      case '--answer-model': options.answerModel = next(); break
      case '--judge-model': options.judgeModel = next(); break
      case '--compile-model': options.compileModel = next(); break
      case '--thinking': options.thinking = next(); break
      case '--temperature': options.temperature = Number(next()); break
      case '--dry-run': options.dryRun = true; break
      case '--force-config': options.forceConfig = true; break
      default: throw new Error(`unknown argument ${flag}`)
    }
  }
  if (!['all', 'sanity', 'compile', 'run', 'summarize'].includes(options.stage)) throw new Error(`unknown --stage ${options.stage}`)
  for (const arm of options.arms) if (!ARM_IDS.includes(arm)) throw new Error(`unknown arm ${arm}`)
  if (!Number.isInteger(options.reps) || options.reps < 1) throw new Error('--reps must be a positive integer')
  return options
}

/** The questions of a trial run: a deterministic slice with two synthesis questions for each single-fact one. */
function selectQuestions(questions, perTopic) {
  if (!perTopic || perTopic >= questions.length) return questions
  const synthesis = questions.filter((question) => question.kind === 'synthesis')
  const single = questions.filter((question) => question.kind === 'single')
  const wantSynthesis = Math.min(synthesis.length, Math.ceil((perTopic * 2) / 3))
  return [...synthesis.slice(0, wantSynthesis), ...single.slice(0, Math.min(single.length, perTopic - wantSynthesis))]
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

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const corpusReport = await checkCorpus()
  if (corpusReport.issues.length) { for (const issue of corpusReport.issues) console.error(`corpus: ${issue}`); throw new Error('the corpus does not check out; run check_corpus.mjs') }
  const corpus = (await loadCorpus(options.topics)).map((topic) => ({ ...topic, questions: selectQuestions(topic.questions, options.questionsPerTopic) }))
  const fullCorpus = await loadCorpus()
  const skillText = readFileSync(SKILL_PATH, 'utf8')
  const runDir = join(RESULTS_DIR, options.runId)
  const questionCount = corpus.reduce((sum, topic) => sum + topic.questions.length, 0)
  const tasksPerRep = questionCount * options.arms.length

  if (options.dryRun) {
    const answerRuns = tasksPerRep * options.reps
    const compiles = options.arms.includes('B') ? corpus.length * options.reps : 0
    const upper = answerRuns * (ESTIMATE_CNY.answerRun + ESTIMATE_CNY.judge) + compiles * ESTIMATE_CNY.compile + questionCount * 2 * ESTIMATE_CNY.sanity
    console.log(JSON.stringify({ runId: options.runId, topics: corpus.map((topic) => topic.id), questions: questionCount, arms: options.arms, reps: options.reps, answerRuns, judgeCalls: answerRuns, compiles, estimatedUpperBoundCny: Number(upper.toFixed(2)) }, null, 2))
    return
  }

  mkdirSync(join(runDir, 'compiled'), { recursive: true })
  const config = {
    schemaVersion: 1,
    models: { answer: options.answerModel, judge: options.judgeModel, compile: options.compileModel },
    thinking: options.thinking,
    temperature: { answer: options.temperature, compile: options.compileTemperature, judge: 0 },
    retrieval: { engine: 'bm25', topK: TOP_K, maxToolCalls: MAX_TOOL_CALLS },
    prompts: { answerSystemSha256: sha256(ANSWER_SYSTEM), decompositionSentence: DECOMPOSITION_GUIDANCE, judgeSystemSha256: sha256(JUDGE_SYSTEM), compileUserMessageSha256: sha256(compileUserMessage('<input>')), repairUserMessageSha256: sha256(repairUserMessage([{ severity: 'required', message: '<m>' }, { severity: 'advisory', message: '<m>' }])), knowledgeCompileSkillSha256: sha256(skillText) },
    domainKnowledgePageSha256: sha256(readFileSync(DOMAIN_PAGE_PATH, 'utf8')),
    thresholds: THRESHOLDS,
    bootstrap: { iterations: BOOTSTRAP_ITERATIONS, seed: BOOTSTRAP_SEED },
    arms: Object.fromEntries(Object.values(ARMS).map((arm) => [arm.id, arm.label])),
  }
  const configPath = join(runDir, 'config.json')
  if (existsSync(configPath)) {
    const previous = JSON.parse(readFileSync(configPath, 'utf8'))
    if (JSON.stringify(previous.core) !== JSON.stringify(config) && !options.forceConfig) {
      throw new Error(`${configPath} was written with different models, prompts or settings; use a new --run-id (or --force-config to keep going on purpose)`)
    }
  }
  writeFileSync(configPath, `${JSON.stringify({ core: config, plan: { reps: options.reps, arms: options.arms, topics: corpus.map((topic) => topic.id), questionsPerTopic: options.questionsPerTopic, budgetCny: options.budget, totalCapCny: options.totalCap, concurrency: options.concurrency }, startedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')

  const ledgerPath = join(runDir, 'calls.jsonl')
  const elsewhere = spentElsewhere(RESULTS_DIR, options.runId)
  const cap = Math.min(options.budget, options.totalCap - elsewhere)
  const needsLlm = options.stage !== 'summarize'
  const llm = needsLlm ? createLlm({ apiKey: readKeyFile(process.env.OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE), ledgerPath, budget: cap }) : null
  if (needsLlm) console.log(`run ${options.runId}: spent so far CNY ${ledgerTotal(ledgerPath).toFixed(4)} here, ${elsewhere.toFixed(4)} in other runs; cap for this run CNY ${cap.toFixed(2)}`)
  let stopped = false

  // --- the judge's sanity check ------------------------------------------------------------------------------------------
  const sanityPath = join(runDir, 'judge-sanity.json')
  const questionTotal = fullCorpus.reduce((sum, topic) => sum + topic.questions.length, 0)
  const sanityDone = () => existsSync(sanityPath) && JSON.parse(readFileSync(sanityPath, 'utf8')).n === questionTotal
  async function judgeSanity() {
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

  // --- compile (arm B) and run --------------------------------------------------------------------------------------------
  const compiledDir = (topic, rep) => join(runDir, 'compiled', `${topic}-rep${rep}`)
  const compiled = new Map()
  async function ensureCompiles(rep) {
    const tasks = corpus.filter((topic) => !compiled.has(`${topic.id}/${rep}`)).map((topic) => ({ topic, rep, key: `compile/${topic.id}/${rep}` }))
    const failures = await runPool(tasks, Math.min(options.concurrency, 3), async ({ topic, rep: repetition }) => {
      let result = await readCompiled(compiledDir(topic.id, repetition))
      if (!result) {
        const fresh = await compileTopic({ llm, model: options.compileModel, topic, skillText, label: `${topic.id}/rep${repetition}`, temperature: options.compileTemperature, thinking: options.thinking, meta: { topic: topic.id, rep: repetition } })
        await writeCompiled(compiledDir(topic.id, repetition), fresh)
        result = await readCompiled(compiledDir(topic.id, repetition))
        console.log(`compiled ${topic.id} rep${repetition}: ${fresh.stats.pages} pages, ${fresh.stats.kept} claims kept, ${fresh.stats.held} held, ${fresh.stats.rounds} rounds, CNY ${fresh.stats.cost.toFixed(3)}`)
      }
      compiled.set(`${topic.id}/${repetition}`, result)
    }, () => stopped)
    if (failures.some((failure) => failure.budget)) stopped = true
    for (const failure of failures.filter((entry) => !entry.budget)) console.error(`compile failed: ${failure.key}: ${failure.message}`)
  }

  const runsPath = join(runDir, 'runs.jsonl')
  const latest = latestByKey(readJsonl(runsPath))
  const baseIndexes = new Map(corpus.map((topic) => [topic.id, buildIndex(topic.documents.map((document) => ({ id: document.sourceId, kind: 'document', title: document.title, text: document.text })))]))
  const pageIndexes = new Map()
  function indexFor(topic, arm, rep) {
    if (arm !== 'B') return baseIndexes.get(topic.id)
    const key = `${topic.id}/${rep}`
    if (!pageIndexes.has(key)) {
      const result = compiled.get(key)
      const documents = topic.documents.map((document) => ({ id: document.sourceId, kind: 'document', title: document.title, text: document.text }))
      for (const page of result.pages) documents.push({ id: `page:${page.slug}`, kind: 'page', title: page.title, text: page.markdown })
      if (result.indexMarkdown) documents.push({ id: 'page:index', kind: 'page', title: '知识页目录', text: result.indexMarkdown })
      pageIndexes.set(key, buildIndex(documents))
    }
    return pageIndexes.get(key)
  }

  async function runRep(rep) {
    const tasks = []
    for (const topic of corpus) {
      for (const question of topic.questions) {
        for (const arm of options.arms) {
          const key = runKey(topic.id, question.id, arm, rep)
          const existing = latest.get(key)
          if (existing?.stage === 'judged' && existing.judge?.ok) continue
          tasks.push({ key, topic, question, arm, rep })
        }
      }
    }
    if (!tasks.length) return 0
    if (options.arms.includes('B')) await ensureCompiles(rep)
    const ready = tasks.filter((task) => task.arm !== 'B' || compiled.has(`${task.topic.id}/${task.rep}`))
    let finished = 0
    const failures = await runPool(ready, options.concurrency, async (task) => {
      const { topic, question, arm } = task
      const resolve = (id) => { const document = topic.documents.find((entry) => entry.sourceId === id); return document ? { text: document.text } : null }
      let record = latest.get(task.key)
      if (!record?.answered) {
        const started = Date.now()
        const result = await answerQuestion({ llm, model: options.answerModel, arm, question: question.question, index: indexFor(topic, arm, task.rep), label: `answer:${task.key}`, temperature: options.temperature, thinking: options.thinking, seed: seedOf(task.key), meta: { key: task.key } })
        record = {
          key: task.key, topic: topic.id, questionId: question.id, kind: question.kind, arm, rep: task.rep, stage: 'answered', answered: true,
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
  if (options.stage === 'compile') {
    for (let rep = 1; rep <= options.reps && !stopped; rep += 1) await ensureCompiles(rep)
  }
  if (options.stage === 'run' || options.stage === 'all') {
    for (let rep = 1; rep <= options.reps && !stopped; rep += 1) await runRep(rep)
  }
  if (stopped) console.log(`STOPPED at the budget cap (spend CNY ${llm.spent.toFixed(3)} of ${cap.toFixed(2)}). Everything finished is saved; run the same command again after raising --budget to continue.`)

  // --- summary ------------------------------------------------------------------------------------------------------------
  const records = [...latestByKey(readJsonl(runsPath)).values()]
  const compiles = []
  for (const topic of corpus) {
    for (let rep = 1; rep <= options.reps; rep += 1) {
      const result = await readCompiled(compiledDir(topic.id, rep))
      if (result) compiles.push({ topic: topic.id, rep, stats: result.stats })
    }
  }
  const sanity = existsSync(sanityPath) ? JSON.parse(readFileSync(sanityPath, 'utf8')) : null
  const summary = summarize({ runs: records, compiles, ledger: readJsonl(ledgerPath), corpus, judgeSanity: sanity ? { n: sanity.n, referenceMean: sanity.referenceMean, emptyMean: sanity.emptyMean } : null, config, runId: options.runId, minReps: options.reps < THRESHOLDS.minRepsPerCell ? options.reps : THRESHOLDS.minRepsPerCell })
  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`\n${renderTable(summary)}`)
}

main().catch((error) => {
  console.error(`run_eval failed: ${String(error?.message ?? error).slice(0, 500)}`)
  process.exit(1)
})
