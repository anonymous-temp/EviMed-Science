import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTRACT_KINDS,
  COMPUTED_CONTRACT_KINDS,
  UNREVIEWED_CONTRACT_KINDS,
  acceptReplyVerdicts,
  deliverableReviewTier,
  mentionedMedicines,
  replyCheckCounts,
  replyCitedSentences,
  replyReviewTier,
} from '../index.mjs'

test('every contract kind has a tier or is named as unreviewed, and the names are real kinds', () => {
  for (const kind of [...COMPUTED_CONTRACT_KINDS, ...UNREVIEWED_CONTRACT_KINDS]) assert.ok(CONTRACT_KINDS.includes(/** @type {any} */ (kind)), `${kind} is not a contract kind`)
  for (const kind of CONTRACT_KINDS) {
    const { tier } = deliverableReviewTier(kind)
    assert.ok(tier === null ? UNREVIEWED_CONTRACT_KINDS.includes(kind) : ['L2', 'L3'].includes(tier), kind)
  }
  assert.deepEqual(deliverableReviewTier('clinical-evidence-report'), { tier: 'L2', safety: true })
  assert.deepEqual(deliverableReviewTier('mendelian-randomization-report'), { tier: 'L3', safety: false })
  assert.deepEqual(deliverableReviewTier('meta-analysis-report'), { tier: 'L3', safety: true }, 'computed and clinical')
  assert.deepEqual(deliverableReviewTier('peer-review-report'), { tier: 'L2', safety: false }, 'a review of a manuscript states no computed result')
  assert.deepEqual(deliverableReviewTier('method-candidate'), { tier: null, safety: false })
})

test('a greeting and a plain answer are L0; a citation or a medicine makes a reply L1', () => {
  assert.equal(replyReviewTier('你好！有什么可以帮你？').tier, 'L0')
  assert.equal(replyReviewTier('Cohort studies follow people forward in time.').tier, 'L0')
  assert.deepEqual(replyReviewTier('见 https://pubmed.ncbi.nlm.nih.gov/30153985/').tier, 'L1')
  assert.equal(replyReviewTier('结论见 [1]。').tier, 'L1')
  const drug = replyReviewTier('服用华法林期间避免合用布洛芬。')
  assert.equal(drug.tier, 'L1')
  assert.equal(drug.cites, false)
  assert.deepEqual(drug.medicines.sort(), ['华法林', '布洛芬'].sort())
})

test('one medicine is one name, whatever vocabulary and language named it', () => {
  assert.deepEqual(mentionedMedicines('Metformin（二甲双胍）与 metformin ER'), ['二甲双胍'])
  assert.deepEqual(mentionedMedicines('艾司西酞普兰'), ['艾司西酞普兰'], 'escitalopram is not also citalopram')
  assert.deepEqual(mentionedMedicines('老年患者，肾功能不全'), [], 'scenes are not medicines')
})

const reply = [
  '二甲双胍可使 HbA1c 降低约 1% [1]。',
  '与安慰剂相比，心衰住院减少 [2, 3]。这句没有引用。',
  '华法林与 NSAID 合用增加出血风险 [4]。',
  '',
  '## 参考文献',
  '1. Metformin trial. doi:10.1000/a',
  '2. Heart failure trial. PMID: 30153985',
  '3. Another. https://example.org/paper',
  '4. Warfarin interactions. doi:10.1000/w',
].join('\n')

test('the cited sentences of a reply and the entries they cite are read, uncited ones are not', () => {
  const { sentences, references } = replyCitedSentences(reply)
  assert.deepEqual(sentences.map((sentence) => [sentence.index, sentence.numbers]), [[0, [1]], [1, [2, 3]], [2, [4]]])
  assert.deepEqual(sentences[2].medicines.sort(), ['华法林', '非甾体抗炎药'].sort(), 'NSAID is the class concept\'s English name')
  assert.deepEqual(references.map((reference) => [reference.number, reference.dois, reference.pmids, reference.urls]), [
    [1, ['10.1000/a'], [], []],
    [2, [], ['30153985'], []],
    [3, [], [], ['https://example.org/paper']],
    [4, ['10.1000/w'], [], []],
  ])
})

test('a reviewer verdict stands only on words of the source; an unreadable source is unresolvable whatever the model said', () => {
  const { sentences } = replyCitedSentences(reply)
  const readable = new Map([
    [1, 'Metformin reduced HbA1c by 1.1% versus placebo.'],
    [4, 'Concomitant NSAID use increased major bleeding in warfarin users.'],
  ])
  const verdicts = acceptReplyVerdicts({
    verdicts: [
      { sentence: 0, verdict: 'supported', reason: '一致', evidence: 'reduced HbA1c by 1.1%', safety: 'none' },
      { sentence: 1, verdict: 'supported', reason: '看起来对', evidence: 'anything', safety: 'none' },
      { sentence: 2, verdict: 'unsupported', reason: '来源说的是大出血', evidence: 'this is not in the source', safety: 'contradicted' },
    ],
  }, { sentences, readable })
  assert.deepEqual(verdicts.map((verdict) => [verdict.sentence, verdict.verdict, verdict.safety]), [
    [0, 'supported', 'none'],
    [1, 'unresolvable', 'none'],
    [2, 'uncertain', 'none'],
  ], 'an unlocated contradiction never reaches an inbox')
  assert.deepEqual(replyCheckCounts(verdicts), { supported: 1, partial: 0, unsupported: 0, unresolvable: 1, uncertain: 1, contradictedSafety: 0 })
})
