// Pure logic of the knowledge-pages evaluation. No network: every model is a scripted fake.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KNOWLEDGE_PAGE_LIMITS, parseKnowledgePage, sourceCitationReferences, verifyKnowledgePage } from '@evimed/domain'
import { answerQuestion, renderHits } from '../lib/answer.mjs'
import { checkAnswerCitations, parseMarkers, stripMarkers } from '../lib/citations.mjs'
import { buildCompileInput, compileTopic, settlePatch } from '../lib/compile.mjs'
import { QUESTIONS_PER_TOPIC, checkCorpus, checkTopic, collapse, loadCorpus, loadTopic, sourceIdFor } from '../lib/corpus.mjs'
import { THRESHOLDS, decide } from '../lib/decide.mjs'
import { judgeAnswer, parseJudgement, scoreJudgement } from '../lib/judge.mjs'
import { BudgetExceeded, PRICES, createLlm, ledgerTotal, priceCall, readUsage } from '../lib/llm.mjs'
import { ANSWER_SYSTEM, ARMS, DECOMPOSITION_GUIDANCE } from '../lib/prompts.mjs'
import { Bm25Index, buildIndex, chunkText, stem, tokenize } from '../lib/retrieval.mjs'
import { BOOTSTRAP_SEED, mean, pairedBootstrap, percentile, seededRandom } from '../lib/stats.mjs'
import { summarize } from '../lib/summary.mjs'

const A = `src_${'a'.repeat(32)}`
const B = `src_${'b'.repeat(32)}`

// --- tokenizing and retrieval --------------------------------------------------------------------------------------------

test('the tokenizer lowercases, stems, drops stop words and keeps decimals', () => {
  assert.deepEqual(tokenize('The bleeding rates were 0.79 and 0·69'), ['bleed', 'rat', '0.79', '0.69'])
  for (const [left, right] of [['rate', 'rates'], ['reduce', 'reduced'], ['hemorrhage', 'hemorrhages'], ['bleed', 'bleeding'], ['trial', 'trials']]) assert.equal(stem(left), stem(right), `${left}/${right}`)
  assert.equal(stem('studies'), 'study')
  assert.equal(stem('class'), 'class')
})

test('the tokenizer reads Chinese as characters and neighbouring pairs, beside English words', () => {
  const tokens = tokenize('出血风险 and apixaban')
  assert.ok(['出', '血', '风', '险', '出血', '血风', '风险', 'apixaban'].every((token) => tokens.includes(token)), tokens.join(','))
})

test('a chunk is a slice of the text at its offsets, and a page line is never cut', () => {
  const text = `Title line\nSecond line with words.\n\n${'First sentence is here. '.repeat(60)}\nLast line`
  const chunks = chunkText(text, { maxChars: 300 })
  assert.ok(chunks.length > 3)
  for (const chunk of chunks) {
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text)
    assert.ok(chunk.text.length <= 300 * 1.5 + 1, `chunk of ${chunk.text.length}`)
  }
  const page = `# Page\n\n- ${'a long claim '.repeat(80)} <!-- evimed-source:{"sourceId":"${A}","quote":"x"} -->\n- short`
  const pieces = chunkText(page, { maxChars: 400, splitLongLines: false })
  assert.ok(pieces.some((piece) => piece.text.includes('<!-- evimed-source') && piece.text.includes('-->')), 'a marker stays whole')
})

test('BM25 ranks the passage that holds the rare query terms first, deterministically', () => {
  const index = buildIndex([
    { id: A, kind: 'document', title: 'Apixaban versus warfarin', text: 'Apixaban reduced major bleeding.\nThe median follow-up was 1.8 years.' },
    { id: B, kind: 'document', title: 'Edoxaban', text: 'Edoxaban lowered hemorrhagic stroke.\nTime in therapeutic range was 68.4%.' },
  ])
  const first = index.search('therapeutic range of warfarin control', 3)
  assert.equal(first[0].docId, B)
  assert.deepEqual(index.search('therapeutic range of warfarin control', 3), first)
  assert.deepEqual(index.search('', 3), [])
  assert.deepEqual(new Bm25Index().search('anything'), [])
  assert.equal(index.search('apixaban bleeding', 1)[0].docId, A)
})

test('a Chinese query finds a Chinese passage', () => {
  const index = buildIndex([
    { id: A, kind: 'document', title: '出血', text: '阿哌沙班降低大出血风险。' },
    { id: B, kind: 'document', title: '肾', text: '达格列净延缓肾功能下降。' },
  ])
  assert.equal(index.search('大出血', 2)[0].docId, A)
  assert.equal(index.search('肾功能', 2)[0].docId, B)
})

test('a search hit shows pages and documents by their ids', () => {
  const text = renderHits('major bleeding', [
    { docId: A, kind: 'document', title: 'Doc A', text: 'first' },
    { docId: 'page:warfarin', kind: 'page', title: 'Warfarin', text: 'second' },
  ], 2)
  assert.match(text, /Search 2 of 6/)
  assert.match(text, new RegExp(`Doc A — document id: ${A}`))
  assert.match(text, /Knowledge page: Warfarin — page id: page:warfarin/)
})

// --- the corpus ----------------------------------------------------------------------------------------------------------

test('the committed corpus checks out: three topics, 27 questions, every reference quote verbatim', async () => {
  const report = await checkCorpus()
  assert.deepEqual(report.issues, [])
  assert.ok(report.topics >= 3)
  assert.equal(report.questions, report.topics * (QUESTIONS_PER_TOPIC.synthesis + QUESTIONS_PER_TOPIC.single))
  const corpus = await loadCorpus()
  for (const topic of corpus) {
    assert.ok(topic.documents.length >= 5 && topic.documents.length <= 10)
    for (const document of topic.documents) {
      assert.match(document.sourceId, /^src_[a-f0-9]{32}$/)
      assert.equal(document.sourceId, sourceIdFor(topic.id, document.pmid))
      assert.ok(document.text.length < 3000)
    }
  }
})

test('the corpus check catches a quote that is not in its document, a wrong id and a one-document synthesis question', async () => {
  const topic = structuredClone(await loadTopic('af-doac-warfarin'))
  topic.questions[0].reference.keyPoints[0].support[0].quote = 'a sentence that no abstract in this topic contains at all'
  assert.ok(checkTopic(topic).some((issue) => issue.includes('not verbatim')))
  const wrongId = structuredClone(await loadTopic('af-doac-warfarin'))
  wrongId.documents[0].sourceId = `src_${'0'.repeat(32)}`
  assert.ok(checkTopic(wrongId).some((issue) => issue.includes('not the derived one')))
  const narrow = structuredClone(await loadTopic('af-doac-warfarin'))
  narrow.questions[0].reference.keyPoints = [narrow.questions[0].reference.keyPoints[0]]
  assert.ok(checkTopic(narrow).some((issue) => issue.includes('at least two documents')))
})

test('every quote of a reference is verbatim by plain substring, whitespace aside', async () => {
  for (const topic of await loadCorpus()) {
    const byKey = new Map(topic.documents.map((document) => [document.key, collapse(document.text)]))
    for (const question of topic.questions) for (const point of question.reference.keyPoints) for (const support of point.support) {
      assert.ok(byKey.get(support.doc).includes(collapse(support.quote)), `${question.id}/${point.id}`)
    }
  }
})

// --- citations -----------------------------------------------------------------------------------------------------------

const TEXTS = new Map([[A, 'Apixaban reduced major bleeding compared with warfarin (hazard ratio 0.69). The arrow A --> B is a symbol.'], [B, 'Edoxaban was noninferior to warfarin for stroke prevention.']])
const resolve = (id) => (TEXTS.has(id) ? { text: TEXTS.get(id) } : null)
const marker = (sourceId, quote) => `<!-- evimed-source:${JSON.stringify({ sourceId, quote }).replace(/>/g, '\\u003e')} -->`

test('answer markers are checked against the documents they name', () => {
  const answer = [
    `Apixaban bleeds less. ${marker(A, 'Apixaban reduced major bleeding compared with warfarin')}`,
    `Edoxaban was not worse. ${marker(B, 'Edoxaban was noninferior to warfarin for stroke prevention')}`,
    `A made-up number. ${marker(A, 'Apixaban reduced major bleeding by 40% compared with warfarin')}`,
    `Wrong document. ${marker(B, 'Apixaban reduced major bleeding compared with warfarin')}`,
    `A page. ${marker('page:warfarin', 'Apixaban reduced major bleeding compared with warfarin')}`,
    `Too short. ${marker(A, 'Apixaban')}`,
    `Unknown id. ${marker(`src_${'c'.repeat(32)}`, 'Apixaban reduced major bleeding compared with warfarin')}`,
  ].join('\n')
  const result = checkAnswerCitations(answer, resolve)
  assert.equal(result.markerCount, 7)
  assert.equal(result.verified, 2)
  assert.equal(result.pageCited, 1)
  assert.deepEqual(result.byStatus, { verified: 2, quote_not_found: 2, quote_invalid: 2, source_unavailable: 1 })
  assert.ok(Math.abs(result.verifiedRate - 2 / 7) < 1e-12)
})

test('an answer with no marker has no rate, and a quote holding "-->" still parses', () => {
  const none = checkAnswerCitations('Plain prose only.', resolve)
  assert.equal(none.markerCount, 0)
  assert.equal(none.verifiedRate, null)
  const tricky = `Symbol. ${marker(A, 'The arrow A --> B is a symbol.')}`
  assert.equal(parseMarkers(tricky)[0].quote, 'The arrow A --> B is a symbol.')
  assert.equal(checkAnswerCitations(tricky, resolve).verified, 1)
})

test('the marker parser agrees with the platform parser on well-formed markers, and stripping leaves the prose', () => {
  const answer = `One. ${marker(A, 'Apixaban reduced major bleeding compared with warfarin')}\nTwo. ${marker(B, 'Edoxaban was noninferior to warfarin')}`
  assert.deepEqual(parseMarkers(answer), sourceCitationReferences(answer))
  assert.equal(stripMarkers(answer), 'One.\nTwo.')
})

// --- scoring -------------------------------------------------------------------------------------------------------------

test('a score is covered plus half of partial over the points, and a contradicted point is zero', () => {
  assert.equal(scoreJudgement([{ verdict: 'covered', contradicted: false }, { verdict: 'partial', contradicted: false }, { verdict: 'missing', contradicted: false }, { verdict: 'covered', contradicted: true }]), 0.375)
  assert.equal(scoreJudgement([]), null)
  assert.equal(scoreJudgement([{ verdict: 'covered', contradicted: false }]), 1)
})

test('the judge reply is read leniently and a missing point is missing, not an error', () => {
  const points = [{ id: 'kp1' }, { id: 'kp2' }]
  const fenced = parseJudgement('```json\n{"points":[{"id":"kp1","verdict":"covered","contradicted":false},{"id":"kp2","verdict":"partial","contradicted":true}]}\n```', points)
  assert.equal(fenced.ok, true)
  assert.deepEqual(fenced.points.map((point) => point.verdict), ['covered', 'partial'])
  assert.equal(fenced.points[1].contradicted, true)
  const partial = parseJudgement('{"points":[{"id":"kp1","verdict":"covered"}]}', points)
  assert.equal(partial.malformed, true)
  assert.deepEqual(partial.points.map((point) => point.verdict), ['covered', 'missing'])
  assert.equal(parseJudgement('not json', points).ok, false)
  assert.equal(parseJudgement('{"points":"no"}', points).ok, false)
})

function fakeLlm(script, log = []) {
  let call = 0
  return {
    log,
    async chat(request) {
      log.push(structuredClone(request))
      const step = script[Math.min(call, script.length - 1)]
      call += 1
      const message = typeof step === 'function' ? step(request, call) : step
      return { message, finishReason: message.tool_calls ? 'tool_calls' : 'stop', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, hit: 0, miss: 100 }, cost: 0.001, model: request.model }
    },
  }
}

test('the judge sees the answer without its citation comments, retries one unreadable reply, and scores in code', async () => {
  const question = { question: 'Q?', reference: { keyPoints: [{ id: 'kp1', text: 'point one' }, { id: 'kp2', text: 'point two' }] } }
  const llm = fakeLlm([{ content: 'garbage' }, { content: '{"points":[{"id":"kp1","verdict":"covered","contradicted":false},{"id":"kp2","verdict":"missing","contradicted":false}]}' }])
  const result = await judgeAnswer({ llm, model: 'deepseek-v4-pro', question, answer: `Fact. ${marker(A, 'Apixaban reduced major bleeding compared with warfarin')}`, label: 'judge:test' })
  assert.equal(result.ok, true)
  assert.equal(result.score, 0.5)
  assert.equal(llm.log.length, 2)
  assert.equal(llm.log[0].temperature, 0)
  assert.ok(!llm.log[0].messages[1].content.includes('evimed-source'))
  const broken = await judgeAnswer({ llm: fakeLlm([{ content: 'x' }]), model: 'm', question, answer: 'a', label: 'judge:test' })
  assert.equal(broken.ok, false)
  assert.equal(broken.score, null)
})

// --- statistics ----------------------------------------------------------------------------------------------------------

test('the bootstrap is deterministic for a seed, differs for another, and collapses when every difference is the same', () => {
  const differences = [0.1, 0.3, -0.1, 0.25, 0.05, 0.2, 0, 0.15]
  const first = pairedBootstrap(differences)
  assert.deepEqual(pairedBootstrap(differences), first)
  assert.notDeepEqual(pairedBootstrap(differences, { seed: BOOTSTRAP_SEED + 1 }), first)
  assert.equal(first.iterations, 10000)
  assert.ok(first.ciLow < first.mean && first.mean < first.ciHigh)
  assert.ok(Math.abs(first.mean - mean(differences)) < 1e-12)
  const flat = pairedBootstrap([0.2, 0.2, 0.2, 0.2])
  assert.ok(Math.abs(flat.ciLow - 0.2) < 1e-9 && Math.abs(flat.ciHigh - 0.2) < 1e-9)
  assert.equal(pairedBootstrap([]).mean, null)
  assert.ok(pairedBootstrap([0.3, 0.4, 0.35, 0.5, 0.45, 0.38]).ciLow > 0)
  assert.ok(pairedBootstrap([0.3, -0.4, 0.05, -0.5, 0.45, -0.38]).ciLow < 0)
})

test('the random generator and the percentile are what they say', () => {
  const one = seededRandom(7)
  const two = seededRandom(7)
  assert.deepEqual([one(), one(), one()], [two(), two(), two()])
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(percentile([1, 2], 0.5), 1.5)
})

// --- the decision --------------------------------------------------------------------------------------------------------

const diff = (m, lo, hi, n = 15) => ({ n, mean: m, ciLow: lo, ciHigh: hi })
function passingSummary() {
  return {
    coverage: { expectedCells: 81, completeCells: 81, minRepsPerCell: 3 },
    judgeSanity: { n: 27, referenceMean: 0.97, emptyMean: 0.01 },
    categories: {
      synthesis: { diffs: { 'B-Aprime': diff(0.12, 0.03, 0.2), 'B-A': diff(0.15, 0.05, 0.25), 'Aprime-A': diff(0.03, -0.05, 0.1) } },
      single: { diffs: { 'B-Aprime': diff(-0.01, -0.06, 0.04, 12), 'B-A': diff(0, -0.04, 0.04, 12) } },
    },
    citations: { overall: { A: { verifiedRate: 0.9 }, Aprime: { verifiedRate: 0.91 }, B: { verifiedRate: 0.9 } } },
  }
}

test('the thresholds are the ones written in the README', () => {
  assert.equal(THRESHOLDS.minRepsPerCell, 3)
  assert.equal(THRESHOLDS.synthesis.bVsAprimeCiLowerAbove, 0)
  assert.equal(THRESHOLDS.synthesis.bVsAprimeMeanAtLeast, 0.05)
  assert.equal(THRESHOLDS.synthesis.bVsAMeanAbove, 0)
  assert.equal(THRESHOLDS.single.meanAtLeast, -0.05)
  assert.equal(THRESHOLDS.single.ciLowerAtLeast, -0.10)
  assert.equal(THRESHOLDS.citation.verifiedRateDropAtMost, 0.03)
  assert.equal(THRESHOLDS.judgeSanity.referenceMeanAtLeast, 0.9)
  assert.equal(THRESHOLDS.judgeSanity.emptyMeanAtMost, 0.1)
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const needle of ['≥ 0.05', '≥ −0.05', '≥ −0.10', '≥ that of A′ − 0.03', '≥ 3 judged repetitions', '≥ 0.90']) assert.ok(readme.includes(needle), needle)
})

test('decide opens the feature only when every threshold holds', () => {
  const verdict = decide(passingSummary())
  assert.equal(verdict.open, true, verdict.reasons.join('\n'))
  assert.ok(verdict.reasons.every((reason) => reason.startsWith('pass: ')))
})

test('each threshold on its own closes the feature, and says which', () => {
  const cases = [
    ['synthesis interval touches zero', (s) => { s.categories.synthesis.diffs['B-Aprime'] = diff(0.12, 0, 0.2) }, /synthesis B - A' lower bound/],
    ['synthesis gain is trivial', (s) => { s.categories.synthesis.diffs['B-Aprime'] = diff(0.04, 0.01, 0.07) }, /synthesis B - A' mean 0\.040/],
    ['B does not beat the status quo', (s) => { s.categories.synthesis.diffs['B-A'] = diff(0, -0.1, 0.1) }, /synthesis B - A mean/],
    ['single-fact mean regresses', (s) => { s.categories.single.diffs['B-Aprime'] = diff(-0.06, -0.08, 0) }, /single-fact B - A' regresses/],
    ['single-fact interval too wide', (s) => { s.categories.single.diffs['B-A'] = diff(-0.02, -0.11, 0.05) }, /single-fact B - A regresses/],
    ['citations drop against A prime', (s) => { s.citations.overall.B.verifiedRate = 0.87 }, /citation verified rate B 0\.870 is more than 0\.03 below A' 0\.910/],
    ['citations drop against A', (s) => { s.citations.overall.A.verifiedRate = 0.95; s.citations.overall.Aprime.verifiedRate = 0.9 }, /below A 0\.950/],
    ['the judge fails its sanity check', (s) => { s.judgeSanity.referenceMean = 0.8 }, /judge sanity/],
  ]
  for (const [name, mutate, pattern] of cases) {
    const summary = passingSummary()
    mutate(summary)
    const verdict = decide(summary)
    assert.equal(verdict.open, false, name)
    assert.ok(verdict.reasons.some((reason) => reason.startsWith('FAIL: ') && pattern.test(reason)), `${name}: ${verdict.reasons.join(' | ')}`)
  }
})

test('the boundary values of the thresholds are on the open side', () => {
  const summary = passingSummary()
  summary.categories.synthesis.diffs['B-Aprime'] = diff(0.05, 0.0001, 0.1)
  summary.categories.single.diffs['B-Aprime'] = diff(-0.05, -0.1, 0)
  summary.citations.overall.B.verifiedRate = 0.88
  assert.equal(decide(summary).open, true, decide(summary).reasons.join('\n'))
})

test('incomplete data is inconclusive, not a verdict', () => {
  const partial = passingSummary()
  partial.coverage = { expectedCells: 81, completeCells: 60, minRepsPerCell: 3 }
  const verdict = decide(partial)
  assert.deepEqual([verdict.open, verdict.inconclusive], [false, true])
  const fewReps = passingSummary()
  fewReps.coverage = { expectedCells: 81, completeCells: 81, minRepsPerCell: 1 }
  assert.equal(decide(fewReps).inconclusive, true)
  const noSanity = passingSummary()
  noSanity.judgeSanity = null
  assert.equal(decide(noSanity).open, false)
})

// --- aggregation ---------------------------------------------------------------------------------------------------------

function syntheticRuns() {
  const corpus = [{ id: 't', questions: [{ id: 's1', kind: 'synthesis' }, { id: 's2', kind: 'synthesis' }, { id: 's3', kind: 'synthesis' }, { id: 'f1', kind: 'single' }, { id: 'f2', kind: 'single' }] }]
  const scores = { A: 0.5, Aprime: 0.6, B: 0.8 }
  const runs = []
  for (const question of corpus[0].questions) {
    for (const arm of ['A', 'Aprime', 'B']) {
      for (let rep = 1; rep <= 3; rep += 1) {
        const wobble = (rep - 2) * 0.1
        runs.push({
          key: `t/${question.id}/${arm}/${rep}`, topic: 't', questionId: question.id, arm, rep, stage: 'judged', judge: { ok: true }, score: Math.min(1, scores[arm] + wobble + (question.kind === 'single' ? 0.1 : 0)),
          tokens: { total: 1000 }, toolCalls: 2, cost: 0.01, citations: { markerCount: 4, verified: arm === 'B' ? 3 : 4, byStatus: { verified: arm === 'B' ? 3 : 4, quote_not_found: arm === 'B' ? 1 : 0 }, pageCited: 0 },
        })
      }
    }
  }
  return { corpus, runs }
}

test('the summary averages repetitions per question, pairs arms by question and pools citations by marker', () => {
  const { corpus, runs } = syntheticRuns()
  const summary = summarize({ runs, compiles: [], ledger: [{ label: 'answer:x', cost: 0.5 }, { label: 'judge:x', cost: 0.25 }], corpus, judgeSanity: { n: 5, referenceMean: 1, emptyMean: 0 }, iterations: 2000 })
  assert.deepEqual(summary.coverage, { expectedCells: 15, completeCells: 15, minRepsPerCell: 3, judgedRuns: 45, runsRecorded: 45 })
  assert.ok(Math.abs(summary.categories.synthesis.arms.A.correctness - 0.5) < 1e-9)
  assert.ok(Math.abs(summary.categories.single.arms.B.correctness - 0.9) < 1e-9)
  const d = summary.categories.synthesis.diffs['B-Aprime']
  assert.ok(Math.abs(d.mean - 0.2) < 1e-4 && d.n === 3 && d.ciLow <= d.mean && d.mean <= d.ciHigh)
  assert.equal(summary.citations.overall.A.verifiedRate, 1)
  assert.equal(summary.citations.overall.B.verifiedRate, 0.75)
  assert.equal(summary.citations.overall.B.byStatus.quote_not_found, 15)
  assert.equal(summary.cost.totalCny, 0.75)
  assert.equal(summary.cost.byKind.judge, 0.25)
  assert.equal(summary.decision.open, false)
  assert.ok(summary.decision.reasons.some((reason) => reason.includes('citation verified rate')))
})

test('a cell with fewer than three judged repetitions is left out of the pairing and the verdict is withheld', () => {
  const { corpus, runs } = syntheticRuns()
  const trimmed = runs.filter((run) => !(run.questionId === 's1' && run.arm === 'B' && run.rep === 3))
  const summary = summarize({ runs: trimmed, compiles: [], ledger: [], corpus, judgeSanity: { n: 5, referenceMean: 1, emptyMean: 0 }, iterations: 500 })
  assert.equal(summary.coverage.completeCells, 14)
  assert.equal(summary.categories.synthesis.diffs['B-A'].n, 2)
  assert.equal(summary.decision.inconclusive, true)
})

// --- the client ----------------------------------------------------------------------------------------------------------

test('prices follow the reference list', () => {
  assert.deepEqual(PRICES['deepseek-v4-flash'], { hit: 0.04, miss: 2, output: 8 })
  assert.deepEqual(PRICES['deepseek-v4-pro'], { hit: 0.3, miss: 9, output: 27 })
  assert.ok(Math.abs(priceCall('deepseek-v4-flash', { hit: 1_000_000, miss: 1_000_000, completionTokens: 1_000_000 }) - 10.04) < 1e-9)
  assert.ok(Math.abs(priceCall('deepseek-v4-pro', { hit: 0, miss: 1_000_000, completionTokens: 0 }) - 9) < 1e-9)
  assert.deepEqual(readUsage({ prompt_tokens: 50, completion_tokens: 5 }), { promptTokens: 50, completionTokens: 5, hit: 0, miss: 50, totalTokens: 55 })
})

function fakeFetch(status, body, seen = []) {
  return async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), headers: init.headers })
    return { ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
  }
}
const okBody = { choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600 } }

test('the client records each call, resumes its spend from the ledger and refuses a call the budget cannot cover', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kp-llm-'))
  try {
    const ledgerPath = join(dir, 'calls.jsonl')
    const seen = []
    const llm = createLlm({ apiKey: 'sk-test-key-0123456789', ledgerPath, budget: 0.06, fetchImpl: fakeFetch(200, okBody, seen), sleep: async () => {} })
    const result = await llm.chat({ label: 'answer:one', model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x' }], temperature: 0.7 })
    assert.equal(result.message.content, 'hi')
    const expected = (400 * 0.04 + 600 * 2 + 100 * 8) / 1_000_000
    assert.ok(Math.abs(llm.spent - expected) < 1e-9)
    assert.ok(Math.abs(ledgerTotal(ledgerPath) - expected) < 1e-6)
    assert.equal(seen[0].body.thinking.type, 'disabled')
    assert.equal(seen[0].headers.authorization, 'Bearer sk-test-key-0123456789')
    assert.ok(!readFileSync(ledgerPath, 'utf8').includes('sk-test'))
    await assert.rejects(() => llm.chat({ label: 'compile:big', model: 'deepseek-v4-flash', messages: [] }), BudgetExceeded)
    assert.equal(seen.length, 1, 'a refused call is never sent')
    const resumed = createLlm({ apiKey: 'k', ledgerPath, budget: 10, fetchImpl: fakeFetch(200, okBody), sleep: async () => {} })
    assert.ok(Math.abs(resumed.spent - expected) < 1e-6)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an API error never carries the key, and a retryable one is retried', async () => {
  const key = 'sk-secret-0123456789abcdef'
  const failing = createLlm({ apiKey: key, budget: 1, fetchImpl: fakeFetch(401, `invalid key ${key}`), sleep: async () => {} })
  await assert.rejects(() => failing.chat({ label: 'answer:x', model: 'deepseek-v4-flash', messages: [] }), (error) => !error.message.includes(key) && error.message.includes('401'))
  let attempts = 0
  const flaky = createLlm({ apiKey: key, budget: 1, retries: 3, sleep: async () => {}, fetchImpl: async () => { attempts += 1; return attempts < 3 ? { ok: false, status: 503, text: async () => 'busy' } : { ok: true, status: 200, text: async () => JSON.stringify(okBody) } } })
  assert.equal((await flaky.chat({ label: 'answer:x', model: 'deepseek-v4-flash', messages: [] })).message.content, 'hi')
  assert.equal(attempts, 3)
  const broken = createLlm({ apiKey: key, budget: 1, retries: 1, sleep: async () => {}, fetchImpl: async () => { throw new Error(`socket closed for ${key}`) } })
  await assert.rejects(() => broken.chat({ label: 'answer:x', model: 'deepseek-v4-flash', messages: [] }), (error) => !error.message.includes(key))
})

// --- answering -----------------------------------------------------------------------------------------------------------

test('the three arms share one answering prompt, and only A prime adds the decomposition sentence', () => {
  assert.equal(`${ANSWER_SYSTEM}${ARMS.A.systemSuffix}`, `${ANSWER_SYSTEM}${ARMS.B.systemSuffix}`)
  assert.equal(`${ANSWER_SYSTEM}${ARMS.Aprime.systemSuffix}`, `${ANSWER_SYSTEM}\n\n${DECOMPOSITION_GUIDANCE}`)
  assert.ok(!ANSWER_SYSTEM.includes('sub-questions'))
  assert.ok(ANSWER_SYSTEM.includes('evimed-source') && ANSWER_SYSTEM.includes('never cite the page itself'))
})

test('answering searches, reads the result and answers; at most six searches are served', async () => {
  const index = buildIndex([{ id: A, kind: 'document', title: 'Apixaban trial', text: 'Apixaban reduced major bleeding compared with warfarin.' }])
  const call = (id, query) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'kb_search', arguments: JSON.stringify({ query }) } }] })
  const llm = fakeLlm([call('c1', 'apixaban bleeding'), { content: `Apixaban bled less. ${marker(A, 'Apixaban reduced major bleeding compared with warfarin')}` }])
  const result = await answerQuestion({ llm, model: 'm', arm: 'A', question: 'Does apixaban bleed less?', index, label: 'answer:t' })
  assert.equal(result.toolCalls, 1)
  assert.equal(result.finished, true)
  assert.match(result.answer, /Apixaban bled less/)
  assert.equal(llm.log.length, 2)
  const toolMessage = llm.log[1].messages.find((message) => message.role === 'tool')
  assert.ok(toolMessage.content.includes(`document id: ${A}`) && toolMessage.content.includes('Search 1 of 6'))
  assert.equal(result.tokens.calls, 2)

  const greedy = fakeLlm([(request) => (request.toolChoice === 'none' ? { content: 'enough' } : call(`c${request.messages.length}`, 'apixaban'))])
  const capped = await answerQuestion({ llm: greedy, model: 'm', arm: 'Aprime', question: 'Q?', index, label: 'answer:t' })
  assert.equal(capped.toolCalls, 6)
  assert.equal(capped.answer, 'enough')
  assert.equal(greedy.log.at(-1).toolChoice, 'none')
  assert.ok(greedy.log[0].messages[0].content.includes(DECOMPOSITION_GUIDANCE))
})

test('several calls in one reply are each served, those past the limit are refused in words', async () => {
  const index = buildIndex([{ id: A, kind: 'document', title: 'T', text: 'alpha beta gamma.' }])
  const many = { role: 'assistant', content: '', tool_calls: Array.from({ length: 8 }, (_, position) => ({ id: `c${position}`, type: 'function', function: { name: 'kb_search', arguments: JSON.stringify({ query: 'alpha' }) } })) }
  const llm = fakeLlm([many, { content: 'done' }])
  const result = await answerQuestion({ llm, model: 'm', arm: 'B', question: 'Q?', index, label: 'answer:t' })
  assert.equal(result.toolCalls, 6)
  const tools = llm.log[1].messages.filter((message) => message.role === 'tool')
  assert.equal(tools.length, 8)
  assert.ok(tools.slice(6).every((message) => message.content.includes('limit of 6 searches')))
})

// --- compiling -----------------------------------------------------------------------------------------------------------

const QUOTE_A = 'Apixaban reduced major bleeding compared with warfarin'
const QUOTE_B = 'Edoxaban was noninferior to warfarin for stroke prevention'
const miniTopic = { id: 't', documents: [
  { key: 'pmid-1', sourceId: A, title: 'Apixaban trial', text: `${TEXTS.get(A)}` },
  { key: 'pmid-2', sourceId: B, title: 'Edoxaban trial', text: `${TEXTS.get(B)}` },
] }

const goodPatch = () => ({
  schemaVersion: 1,
  pages: [
    { op: 'create', slug: 'anticoagulants', type: 'topic', title: 'Anticoagulants in atrial fibrillation', related: ['apixaban', 'gone'],
      sections: [{ heading: 'Bleeding and stroke', claims: [
        { text: 'Apixaban lowered major bleeding versus warfarin.', kind: 'direct', evidence: [{ sourceId: A, quote: QUOTE_A }] },
        { text: 'Edoxaban was not worse than warfarin.', kind: 'direct', evidence: [{ sourceId: B, quote: QUOTE_B }] },
        { text: 'Both agents match or beat warfarin.', kind: 'synthesized', confidence: 'moderate', evidence: [{ sourceId: A, quote: QUOTE_A }, { sourceId: B, quote: QUOTE_B }] },
        { text: 'Apixaban cut bleeding by 40%.', kind: 'direct', evidence: [{ sourceId: A, quote: 'Apixaban reduced major bleeding by 40% compared with warfarin' }] },
        { text: 'A synthesis from one document.', kind: 'synthesized', confidence: 'low', evidence: [{ sourceId: A, quote: QUOTE_A }] },
        { text: 'No evidence at all.', kind: 'direct', evidence: [] },
      ] }] },
    { op: 'create', slug: 'apixaban', type: 'entity', title: 'Apixaban', sections: [{ heading: 'Trial', claims: [{ text: 'A made-up claim.', kind: 'direct', evidence: [{ sourceId: A, quote: 'Apixaban cures everything in every patient' }] }] }] },
    { op: 'create', slug: 'BAD SLUG', type: 'topic', title: 'x', sections: [] },
  ],
})

test('settling a patch keeps what the documents confirm, holds the rest with reasons and writes only pages that stand', () => {
  const settled = settlePatch(goodPatch(), miniTopic.documents)
  assert.deepEqual(settled.pages.map((page) => page.slug), ['anticoagulants'])
  assert.equal(settled.counts.claims, 7)
  assert.equal(settled.counts.kept, 3)
  assert.equal(settled.counts.held, 4)
  assert.equal(settled.counts.heldByReason.quote_not_found, 2)
  assert.equal(settled.counts.heldByReason.single_document, 1)
  assert.equal(settled.counts.heldByReason.no_evidence, 1)
  assert.deepEqual(settled.skipped.map((entry) => `${entry.slug}:${entry.reason}`).sort(), ['BAD SLUG:invalid_slug', 'apixaban:no_claim_stands'])
  const page = settled.pages[0]
  assert.deepEqual(page.content.related, [], 'links to pages that were not written are dropped')
  const parsed = parseKnowledgePage(page.markdown)
  const verification = verifyKnowledgePage(parsed, (id) => ({ text: TEXTS.get(id) }), { pages: new Set(['anticoagulants']) })
  assert.deepEqual(verification.counts, { claims: 3, verified: 3, unverified: 0, unsupported: 0 })
  assert.ok(parseKnowledgePage(page.markdown).units.some((unit) => unit.claimMeta?.kind === 'synthesized' && unit.claimMeta.confidence === 'moderate'), 'the statement across documents carries its kind and confidence')
  assert.match(settled.indexMarkdown, /\[\[anticoagulants\|Anticoagulants in atrial fibrillation\]\] · 3 条 · 2 份资料/)
  assert.equal(page.verification.verified, 3)
})

test('the compile input has the shape of the platform job', () => {
  const input = buildCompileInput(miniTopic)
  assert.equal(input.schemaVersion, 1)
  assert.deepEqual(input.pages, [])
  assert.deepEqual(input.limits, KNOWLEDGE_PAGE_LIMITS)
  assert.deepEqual(Object.keys(input.sources[0]), ['sourceId', 'title', 'generation', 'textSha256', 'text'])
  assert.match(input.sources[0].textSha256, /^[a-f0-9]{64}$/)
})

test('compiling sends the method as the system prompt, repairs in place with the specific messages, then settles', async () => {
  const flawed = goodPatch()
  const llm = fakeLlm([{ content: JSON.stringify(flawed) }, (request) => {
    const repair = request.messages.at(-1).content
    assert.match(repair, /not in document/)
    assert.match(repair, /Change only these places/)
    const fixed = goodPatch()
    fixed.pages[0].sections[0].claims[3].evidence[0].quote = QUOTE_A
    return { content: JSON.stringify(fixed) }
  }, { content: JSON.stringify(goodPatch()) }])
  const result = await compileTopic({ llm, model: 'm', topic: miniTopic, skillText: 'SKILL TEXT', label: 'x' })
  assert.equal(llm.log[0].messages[0].content, 'SKILL TEXT')
  assert.equal(llm.log[0].json, true)
  assert.ok(llm.log[0].messages[1].content.includes(`"sourceId":"${A}"`))
  assert.equal(result.stats.rounds, 3, 'issues remain after each round, so both repair rounds are used and then it stops')
  assert.equal(llm.log.length, 3)
  assert.ok(result.stats.roundDetails[0].advisory >= 1)
  assert.equal(result.stats.pages, 1)
  assert.equal(result.stats.verifyMismatch, 0)
})

test('a clean first patch needs no repair, and an unreadable reply is asked for again', async () => {
  const clean = { schemaVersion: 1, pages: [{ op: 'create', slug: 'apixaban', type: 'entity', title: 'Apixaban', sections: [{ heading: 'Bleeding', claims: [{ text: 'Apixaban bled less.', kind: 'direct', evidence: [{ sourceId: A, quote: QUOTE_A }] }] }] }] }
  const once = fakeLlm([{ content: JSON.stringify(clean) }])
  const done = await compileTopic({ llm: once, model: 'm', topic: miniTopic, skillText: 's', label: 'x' })
  assert.equal(once.log.length, 1)
  assert.equal(done.stats.held, 0)
  const twice = fakeLlm([{ content: '{ not json' }, { content: JSON.stringify(clean) }])
  const recovered = await compileTopic({ llm: twice, model: 'm', topic: miniTopic, skillText: 's', label: 'x' })
  assert.equal(twice.log.length, 2)
  assert.match(twice.log[1].messages.at(-1).content, /not a single valid JSON object/)
  assert.equal(recovered.stats.pages, 1)
  const never = await compileTopic({ llm: fakeLlm([{ content: 'nope' }]), model: 'm', topic: miniTopic, skillText: 's', label: 'x' })
  assert.equal(never.stats.unreadablePatch, true)
  assert.equal(never.stats.pages, 0)
})

test('a compiled page is what the retrieval index serves for arm B: the markers survive whole in a search hit', () => {
  const settled = settlePatch(goodPatch(), miniTopic.documents)
  const index = buildIndex([
    ...miniTopic.documents.map((document) => ({ id: document.sourceId, kind: 'document', title: document.title, text: document.text })),
    { id: 'page:anticoagulants', kind: 'page', title: 'Anticoagulants in atrial fibrillation', text: settled.pages[0].markdown },
  ])
  const hits = index.search('Edoxaban noninferior warfarin', 5)
  const pageHit = hits.find((hit) => hit.kind === 'page')
  assert.ok(pageHit, 'the page is searchable')
  assert.ok(pageHit.text.includes('<!-- evimed-source:') && pageHit.text.includes('-->'))
})
