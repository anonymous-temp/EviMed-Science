// Pure logic of the knowledge-pages evaluation. No network: every model is a scripted fake.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { sourceCitationReferences } from '@evimed/domain'
import { answerQuestion, renderHits } from '../lib/answer.mjs'
import { QUOTE_LIMITS, checkAnswerCitations, checkCitation, parseMarkers, sourceMarker, stripMarkers } from '../lib/citations.mjs'
import { QUESTIONS_PER_TOPIC, checkCorpus, checkTopic, collapse, loadCorpus, loadRunCorpus, loadTopic, sourceIdFor } from '../lib/corpus.mjs'
import { PAGE_ARM_IDS, THRESHOLDS, decide } from '../lib/decide.mjs'
import { judgeAnswer, parseJudgement, scoreJudgement } from '../lib/judge.mjs'
import { buildKnowledgeBase, treesFor } from '../lib/kb.mjs'
import { BudgetExceeded, PRICES, createLlm, ledgerTotal, priceCall, readUsage } from '../lib/llm.mjs'
import { ANSWER_SYSTEM, ARMS, ARM_B_REMOVED, DECOMPOSITION_GUIDANCE, JUDGE_SYSTEM, sha256 } from '../lib/prompts.mjs'
import { Bm25Index, buildIndex, chunkText, stem, tokenize } from '../lib/retrieval.mjs'
import { BOOTSTRAP_SEED, mean, pairedBootstrap, percentile, seededRandom } from '../lib/stats.mjs'
import { summarizeRunDirectory } from '../lib/store.mjs'
import { ARM_IDS, RUNNABLE_ARM_IDS, renderTable, summarize } from '../lib/summary.mjs'
import { adoptUpstreamTrees, readUpstreamTrees, rewriteSourceLinks, treeForRep, upstreamPageRecords, upstreamTreeStats } from '../lib/upstream.mjs'

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

test('a page read by blocks keeps a sentence with the source link under it, a table and a list each whole', () => {
  const text = '# Page\n\nA sentence written over\ntwo lines\n([Doc](viking://x "the quote")).\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n- two\n'
  const blocks = chunkText(text, { maxChars: 40, splitLongLines: false, blocks: true })
  for (const chunk of blocks) assert.equal(text.slice(chunk.start, chunk.end), chunk.text)
  assert.deepEqual(blocks.map((chunk) => chunk.text), ['# Page', 'A sentence written over\ntwo lines\n([Doc](viking://x "the quote")).', '| a | b |\n| --- | --- |\n| 1 | 2 |', '- one\n- two'])
  assert.ok(chunkText(text, { maxChars: 40, splitLongLines: false }).some((chunk) => chunk.text.includes('two lines') && !chunk.text.includes('the quote')), 'by lines, the sentence and its source part')
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

test('a marker the harness writes reads back as written, and the quotation limits are the ones the recorded runs used', () => {
  const quote = 'A quotation with "quotes", <angle> brackets and an arrow --> inside.'
  const written = sourceMarker(A, quote)
  assert.ok(!written.slice(4, -3).includes('-->') && !written.slice(4, -3).includes('<'))
  assert.deepEqual(parseMarkers(`Fact. ${written}`), [{ sourceId: A, quote }])
  assert.deepEqual(QUOTE_LIMITS, { minChars: 10, maxChars: 600 })
  assert.equal(checkCitation({ sourceId: A, quote: 'x'.repeat(601) }, resolve).status, 'quote_invalid')
  assert.equal(checkCitation({ sourceId: A, quote: '   Apixaban   ' }, resolve).status, 'quote_invalid')
  assert.equal(checkCitation({ sourceId: A, quote: 'Apixaban reduced major bleeding' }, resolve).status, 'verified')
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

/** The passing summary with its page arm renamed: what a run of A, A′ and `arm` hands `decide`. */
function passingSummaryFor(arm) {
  const summary = passingSummary()
  for (const kind of ['synthesis', 'single']) {
    summary.categories[kind].diffs = Object.fromEntries(Object.entries(summary.categories[kind].diffs).map(([name, value]) => [name.replace(/^B-/, `${arm}-`), value]))
  }
  const { A: a, Aprime, B: page } = summary.citations.overall
  summary.citations.overall = { A: a, Aprime, [arm]: page }
  return summary
}

test('the same rule, with the same constants, decides arm C on its own comparisons and citation rate', () => {
  assert.deepEqual(PAGE_ARM_IDS, ['B', 'C'])
  const verdict = decide(passingSummaryFor('C'), 'C')
  assert.equal(verdict.open, true, verdict.reasons.join('\n'))
  assert.ok(verdict.reasons.some((reason) => reason.startsWith("pass: synthesis C - A' lower bound")))
  const trivial = passingSummaryFor('C')
  trivial.categories.synthesis.diffs['C-Aprime'] = diff(0.04, 0.01, 0.07)
  assert.ok(decide(trivial, 'C').reasons.some((reason) => /^FAIL: synthesis C - A' mean 0\.040 is below 0\.05/.test(reason)))
  const citing = passingSummaryFor('C')
  citing.citations.overall.C.verifiedRate = 0.87
  assert.ok(decide(citing, 'C').reasons.some((reason) => /citation verified rate C 0\.870 is more than 0\.03 below A' 0\.910/.test(reason)))
  // B's numbers say nothing about C, nor C's about B; and the rule is about an arm that searches pages.
  assert.equal(decide(passingSummaryFor('C'), 'B').inconclusive, true)
  assert.equal(decide(passingSummary(), 'C').inconclusive, true)
  assert.throws(() => decide(passingSummary(), 'Aprime'), /arm that searches pages/)
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

const TREE_STATS = Object.freeze({ pages: 3, typedPages: 3, sourceLinks: 6, inSourceList: 1, besideClaims: 5, besideClaimsWithQuotation: 4, present: 2, absent: 1, noQuotation: 0, sourceMissing: 2 })

/** Runs of A, A′ and C on two topics, three repetitions; `withTree`: the topics C has a tree for (C's cells of the others were not asked). */
function upstreamRuns(withTree) {
  const corpus = [
    { id: 't', questions: [{ id: 's1', kind: 'synthesis' }, { id: 's2', kind: 'synthesis' }, { id: 'f1', kind: 'single' }] },
    { id: 'u', questions: [{ id: 's3', kind: 'synthesis' }, { id: 's4', kind: 'synthesis' }, { id: 'f2', kind: 'single' }] },
  ]
  const scores = { A: 0.6, Aprime: 0.6, C: 0.8 }
  const runs = []
  for (const topic of corpus) for (const question of topic.questions) for (const arm of ['A', 'Aprime', 'C']) for (let rep = 1; rep <= 3; rep += 1) {
    if (arm === 'C' && !withTree.includes(topic.id)) continue
    runs.push({
      key: `${topic.id}/${question.id}/${arm}/${rep}`, topic: topic.id, questionId: question.id, arm, rep, stage: 'judged', judge: { ok: true }, score: scores[arm],
      tokens: { total: 1000 }, toolCalls: 2, cost: 0.01, citations: { markerCount: 2, verified: 2, byStatus: { verified: 2 }, pageCited: 0 },
      // Two trees for a topic, three repetitions: the first tree is searched again by the third.
      ...(arm === 'C' ? { pages: { [topic.id]: rep === 2 ? 'rep2' : 'rep1' } } : {}),
    })
  }
  const upstreamTrees = withTree.flatMap((topic) => ['rep1', 'rep2'].map((tree) => ({ topic, tree, sha256: `${topic}-${tree}`, stats: TREE_STATS })))
  return { corpus, runs, upstreamTrees }
}

test('a run of A, A prime and C is summarized with C\'s comparisons, C\'s verdict, and what each tree held and which repetitions searched it', () => {
  const { corpus, runs, upstreamTrees } = upstreamRuns(['t', 'u'])
  const summary = summarize({ runs, compiles: [], upstreamTrees, ledger: [], corpus, judgeSanity: { n: 6, referenceMean: 1, emptyMean: 0 }, iterations: 300, arms: ['A', 'Aprime', 'C'] })
  assert.deepEqual(summary.arms, ['A', 'Aprime', 'C'])
  assert.deepEqual(Object.keys(summary.categories.synthesis.diffs), ['C-Aprime', 'C-A', 'Aprime-A'])
  assert.ok(Math.abs(summary.categories.synthesis.diffs['C-Aprime'].mean - 0.2) < 1e-9)
  assert.deepEqual(Object.keys(summary.citations.diffs), ['C-Aprime', 'C-A', 'Aprime-A'])
  assert.deepEqual(summary.coverageByArm, { A: { expectedCells: 6, completeCells: 6 }, Aprime: { expectedCells: 6, completeCells: 6 }, C: { expectedCells: 6, completeCells: 6 } })
  assert.deepEqual(summary.upstreamPages.perTopic.t.trees.map((tree) => [tree.tree, tree.reps, tree.presentShare]), [['rep1', [1, 3], 0.5], ['rep2', [2], 0.5]])
  assert.deepEqual(summary.upstreamPages.topicsWithoutTree, [])
  assert.deepEqual([summary.upstreamPages.overall.trees, summary.upstreamPages.overall.besideClaims, summary.upstreamPages.overall.present], [4, 20, 8])
  assert.deepEqual(Object.keys(summary.decisions), ['C'])
  assert.equal(summary.decision, undefined, 'the field the 2026-10-12 summaries call decision is arm B\'s verdict, and this run has no B')
  assert.equal(summary.decisions.C.open, true, summary.decisions.C.reasons.join('\n'))
  assert.match(renderTable(summary), /DECISION for arm C \(upstream knowledge pages \+ kb_search\): the thresholds are met/)
})

test('a topic with no tree leaves arm C\'s cells there unasked: the topic is named, and the verdict on C is withheld, not made', () => {
  const { corpus, runs, upstreamTrees } = upstreamRuns(['t'])
  const summary = summarize({ runs, compiles: [], upstreamTrees, ledger: [], corpus, judgeSanity: { n: 6, referenceMean: 1, emptyMean: 0 }, iterations: 300, arms: ['A', 'Aprime', 'C'] })
  assert.deepEqual(summary.coverageByArm.C, { expectedCells: 6, completeCells: 3 })
  assert.deepEqual(summary.upstreamPages.topicsWithoutTree, ['u'])
  assert.equal(summary.upstreamPages.perTopic.u, undefined)
  const verdict = summary.decisions.C
  assert.deepEqual([verdict.open, verdict.inconclusive], [false, true])
  assert.ok(verdict.reasons.some((reason) => reason.includes('15 of 18 (question, arm) cells are complete')), verdict.reasons.join(' | '))
  assert.ok(verdict.reasons.some((reason) => reason.includes('arm C has no upstream pages for u')), verdict.reasons.join(' | '))
  assert.match(renderTable(summary), /u +no tree: arm C was not asked this topic's questions/)
})

test('summarizing a recorded run again reproduces its committed summary: every number, the verdict and the order of the fields', async () => {
  for (const runId of ['2026-10-12-three-arm', '2026-10-12-three-arm-pooled', '2026-10-12-pilot']) {
    const runDir = fileURLToPath(new URL(`../results/${runId}/`, import.meta.url))
    const committed = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'))
    const { core, plan } = JSON.parse(readFileSync(join(runDir, 'config.json'), 'utf8'))
    const again = summarizeRunDirectory({ runDir, runId, corpus: await loadRunCorpus(plan.topics, plan.questionsPerTopic), reps: plan.reps, arms: plan.arms, config: core })
    for (const key of Object.keys(committed)) if (key !== 'generatedAt') assert.deepEqual(again[key], committed[key], `${runId}: ${key}`)
    assert.deepEqual(Object.keys(again).filter((key) => key in committed), Object.keys(committed), `${runId}: the fields keep their order`)
    assert.deepEqual(Object.keys(again).filter((key) => !(key in committed)), ['arms', 'coverageByArm', 'decisions'], `${runId}: fields are only added`)
    assert.deepEqual(again.decisions.B, committed.decision)
  }
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

test('every arm shares one answering prompt, the recorded runs\' prompts unchanged, and only A prime adds the decomposition sentence', () => {
  for (const arm of ['A', 'B', 'C']) assert.equal(`${ANSWER_SYSTEM}${ARMS[arm].systemSuffix}`, ANSWER_SYSTEM)
  assert.equal(`${ANSWER_SYSTEM}${ARMS.Aprime.systemSuffix}`, `${ANSWER_SYSTEM}\n\n${DECOMPOSITION_GUIDANCE}`)
  assert.ok(!ANSWER_SYSTEM.includes('sub-questions'))
  assert.ok(ANSWER_SYSTEM.includes('evimed-source') && ANSWER_SYSTEM.includes('never cite the page itself'))
  // A run of arm C asks and grades exactly as the runs of 2026-10-12 did.
  const recorded = JSON.parse(readFileSync(new URL('../results/2026-10-12-three-arm/config.json', import.meta.url), 'utf8')).core.prompts
  assert.equal(sha256(ANSWER_SYSTEM), recorded.answerSystemSha256)
  assert.equal(sha256(JUDGE_SYSTEM), recorded.judgeSystemSha256)
  assert.equal(DECOMPOSITION_GUIDANCE, recorded.decompositionSentence)
})

test('arm B is on record only: a new run cannot ask it, and building its knowledge base says why', () => {
  assert.deepEqual(ARM_IDS, ['A', 'Aprime', 'B', 'C'])
  assert.deepEqual(RUNNABLE_ARM_IDS, ['A', 'Aprime', 'C'])
  const topic = { id: 't', documents: [{ sourceId: A, title: 'T', text: 'alpha beta gamma.' }] }
  assert.throws(() => buildKnowledgeBase({ scope: 'topic', arm: 'B', topic, corpus: [topic], rep: 1 }), (error) => error.message === ARM_B_REMOVED)
  assert.match(ARM_B_REMOVED, /removed on 2026-10-13/)
  assert.match(ARM_B_REMOVED, /results\/2026-10-12-\*/)
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

// --- arm C: pages compiled upstream ---------------------------------------------------------------------------------------

const FIXTURE = fileURLToPath(new URL('./fixtures/upstream/', import.meta.url))
const AF = 'af-doac-warfarin'
const RELY = 'src_8a669b066c4cb002e5224ef48c9a8550'
const documentsOf = (topic) => (id) => { const document = topic.documents.find((entry) => entry.sourceId === id); return document ? { text: document.text } : null }

test('an exported tree is every Markdown file under it, hidden files and the engine\'s listing aside, in a fixed order', () => {
  const trees = readUpstreamTrees(FIXTURE, AF)
  assert.deepEqual(trees.map((tree) => tree.name), ['rep1', 'rep2'])
  assert.deepEqual(trees[0].pages.map((page) => page.path), ['comparison/doac-vs-warfarin.md', 'entity/re-ly.md', 'index.md'])
  assert.match(trees[0].sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(readUpstreamTrees(FIXTURE, 'sglt2-hf-ckd'), [])
})

test('trees are the directories rep<N> with a page, in numeric order, reused in that order when repetitions outnumber them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kp-trees-'))
  try {
    for (const name of ['rep10', 'rep2', 'rep1', 'rep0', 'drafts', 'rep3']) {
      mkdirSync(join(dir, 't', name), { recursive: true })
      if (name !== 'rep3') writeFileSync(join(dir, 't', name, 'index.md'), `# ${name}\n`)
    }
    const trees = readUpstreamTrees(dir, 't')
    assert.deepEqual(trees.map((tree) => tree.name), ['rep1', 'rep2', 'rep10'], 'rep0 and drafts are not trees, an empty rep3 has no page')
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((rep) => treeForRep(trees, rep).name), ['rep1', 'rep2', 'rep10', 'rep1', 'rep2', 'rep10', 'rep1'])
    assert.equal(treeForRep([], 1), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a source link becomes its words and the citation marker an answer copies; other links lose only an address that means nothing to a reader', async () => {
  const topic = await loadTopic(AF)
  const ids = new Set(topic.documents.map((document) => document.sourceId))
  const [comparison, entity] = readUpstreamTrees(FIXTURE, AF)[0].pages
  const shown = rewriteSourceLinks(entity.content, ids)
  assert.ok(shown.startsWith('---\ntype: entity\n'), 'the front matter stays as written')
  assert.ok(shown.includes(`(Dabigatran versus warfarin in patients with atrial fibrillation ${sourceMarker(RELY, 'The primary outcome was stroke or systemic embolism.')}).`))
  assert.ok(shown.includes(`- Dabigatran versus warfarin in patients with atrial fibrillation (document id: ${RELY})`), 'a link with no quotation names its document in words')
  assert.ok(shown.includes('[comparison page](../comparison/doac-vs-warfarin.md)'), 'a relative link between pages stays')
  const other = rewriteSourceLinks(comparison.content, ids)
  assert.ok(!other.includes('viking://'))
  assert.ok(other.includes('(Another record),'), 'a document of no topic here keeps its words only')
  assert.ok(other.includes('and so is the RE-LY page when'), 'a page addressed absolutely keeps its words only')
  assert.ok(other.includes('| Dabigatran | [RE-LY](../entity/re-ly.md) |'))
  assert.deepEqual(parseMarkers(other).map((marker) => marker.quote), [
    'In patients with atrial fibrillation, apixaban was superior to warfarin in preventing stroke or systemic embolism, caused less bleeding, and resulted in lower mortality.',
    'Apixaban halved every bleeding event in every subgroup of the trial.',
  ], 'a link without .md is a source link too, and a quotation wrapped over two lines is one line in the marker')
  assert.ok(!rewriteSourceLinks(entity.content, new Set()).includes('evimed-source'), 'a document of another topic is not a source here')
})

test('a tree is counted after the fact as the platform counts it: pages, typed pages, links beside claims, quotations found', async () => {
  const topic = await loadTopic(AF)
  const [first, second] = readUpstreamTrees(FIXTURE, AF)
  assert.deepEqual(upstreamTreeStats(first, topic.documents), {
    ...TREE_STATS, characters: first.pages.reduce((sum, page) => sum + page.content.length, 0), documentsCited: 2, documents: 8,
  })
  const stats = upstreamTreeStats(second, topic.documents)
  assert.deepEqual([stats.pages, stats.besideClaimsWithQuotation, stats.present, stats.documentsCited], [1, 1, 1, 1])
  // Read against another topic's documents, no link names a document: the case a run refuses before it copies a tree.
  const misplaced = upstreamTreeStats(first, (await loadTopic('sglt2-hf-ckd')).documents)
  assert.deepEqual([misplaced.documentsCited, misplaced.present, misplaced.sourceMissing], [0, 0, 6])
  // What a page shows the model checks out against the documents as the platform counted: two quotations found, one not.
  const shown = upstreamPageRecords(first, { documentIds: new Set(topic.documents.map((document) => document.sourceId)) }).map((record) => record.text).join('\n')
  assert.deepEqual(checkAnswerCitations(shown, documentsOf(topic)).byStatus, { verified: 2, quote_not_found: 1 })
})

test('arm C searches its tree\'s pages beside the documents, a sentence and its source in one passage; A and A prime never see a page', async () => {
  const topic = await loadTopic(AF)
  const trees = new Map([[AF, readUpstreamTrees(FIXTURE, AF)]])
  const idsOf = (index) => new Set(index.chunks.map((chunk) => chunk.docId))
  for (const arm of ['A', 'Aprime']) assert.deepEqual([...new Set(buildKnowledgeBase({ scope: 'topic', arm, topic, corpus: [topic], trees, rep: 1 }).chunks.map((chunk) => chunk.kind))], ['document'])
  const first = buildKnowledgeBase({ scope: 'topic', arm: 'C', topic, corpus: [topic], trees, rep: 1 })
  assert.deepEqual([...idsOf(first)].filter((id) => id.startsWith('page:')).sort(), ['page:comparison/doac-vs-warfarin.md', 'page:entity/re-ly.md', 'page:index.md'])
  for (const document of topic.documents) assert.ok(idsOf(first).has(document.sourceId))
  const hit = first.search('RE-LY composite end point primary outcome', 5).find((entry) => entry.kind === 'page')
  assert.deepEqual([hit.docId, hit.title], ['page:entity/re-ly.md', 'RE-LY'])
  assert.ok(hit.text.includes('The primary outcome was stroke or\nsystemic embolism') && hit.text.includes(sourceMarker(RELY, 'The primary outcome was stroke or systemic embolism.')), hit.text)
  assert.match(renderHits('q', [hit], 1), /Knowledge page: RE-LY — page id: page:entity\/re-ly\.md/)
  // The second repetition searches the second tree, the third the first again.
  const second = buildKnowledgeBase({ scope: 'topic', arm: 'C', topic, corpus: [topic], trees, rep: 2 })
  assert.ok(idsOf(second).has('page:concept/time-in-therapeutic-range.md') && !idsOf(second).has('page:entity/re-ly.md'))
  assert.deepEqual(idsOf(buildKnowledgeBase({ scope: 'topic', arm: 'C', topic, corpus: [topic], trees, rep: 3 })), idsOf(first))
})

test('a pooled project holds every topic\'s documents and pages, the topic in the page id; without a tree of every topic there is no arm C cell', async () => {
  const af = await loadTopic(AF)
  const other = { id: 'u', documents: [{ sourceId: `src_${'d'.repeat(32)}`, title: 'Aspirin trial', text: 'Aspirin raised major bleeding in older adults.' }] }
  const otherTree = { name: 'rep1', pages: [{ path: 'entity/re-ly.md', content: '---\ntype: entity\ntitle: Aspirin\n---\n\n# Aspirin\n\nAspirin bled.\n' }] }
  const trees = new Map([[AF, readUpstreamTrees(FIXTURE, AF)], ['u', [otherTree]]])
  const pooled = buildKnowledgeBase({ scope: 'pooled', arm: 'C', topic: af, corpus: [af, other], trees, rep: 1 })
  const ids = new Set(pooled.chunks.map((chunk) => chunk.docId))
  assert.ok(ids.has(`page:${AF}/entity/re-ly.md`) && ids.has('page:u/entity/re-ly.md'), 'two topics may each have a page of the same path')
  assert.ok(ids.has(other.documents[0].sourceId) && ids.has(RELY))
  const chosen = treesFor({ scope: 'pooled', topic: af, corpus: [af, other], trees, rep: 2 })
  assert.deepEqual([chosen[AF].name, chosen.u.name], ['rep2', 'rep1'], 'each topic reuses its own trees')
  const missing = new Map([[AF, trees.get(AF)]])
  assert.equal(buildKnowledgeBase({ scope: 'pooled', arm: 'C', topic: af, corpus: [af, other], trees: missing, rep: 1 }), null)
  assert.equal(buildKnowledgeBase({ scope: 'topic', arm: 'C', topic: other, corpus: [af, other], trees: missing, rep: 1 }), null)
  assert.ok(buildKnowledgeBase({ scope: 'topic', arm: 'A', topic: other, corpus: [af, other], trees: missing, rep: 1 }))
})

test('a run copies the trees it searches into its own directory once, and from then on reads only that copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kp-adopt-'))
  try {
    const exported = join(dir, 'export')
    const runTrees = join(dir, 'run', 'upstream')
    cpSync(FIXTURE, exported, { recursive: true })
    const first = adoptUpstreamTrees({ from: exported, to: runTrees, topicId: AF })
    assert.deepEqual(first.map((tree) => tree.name), ['rep1', 'rep2'])
    assert.deepEqual(first.map((tree) => tree.sha256), readUpstreamTrees(FIXTURE, AF).map((tree) => tree.sha256))
    rmSync(join(exported, AF, 'rep2'), { recursive: true })
    writeFileSync(join(exported, AF, 'rep1', 'index.md'), '# changed\n')
    assert.deepEqual(adoptUpstreamTrees({ from: exported, to: runTrees, topicId: AF }).map((tree) => tree.sha256), first.map((tree) => tree.sha256))
    assert.deepEqual(adoptUpstreamTrees({ from: exported, to: runTrees, topicId: 'sglt2-hf-ckd' }), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
