// The platform's medication-question bank (flywheel F22): sixty neutral questions by drug class, and the numbers a month of them makes.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GEO_QUESTION_BANK,
  GEO_QUESTION_BANK_CLASSES,
  GEO_QUESTION_BANK_CLASS_LABELS_ZH,
  geoQuestionBankClassOf,
  geoQuestionBankMonth,
  summarizeQuestionBank,
} from '../index.mjs'

test('the bank is about sixty questions by drug class, each a plain question with a class and no brand', () => {
  assert.ok(GEO_QUESTION_BANK.length >= 50 && GEO_QUESTION_BANK.length <= 70, `${GEO_QUESTION_BANK.length} questions`)
  assert.equal(new Set(GEO_QUESTION_BANK.map((question) => question.id)).size, GEO_QUESTION_BANK.length, 'ids are unique')
  assert.equal(new Set(GEO_QUESTION_BANK.map((question) => question.text)).size, GEO_QUESTION_BANK.length, 'no question twice')
  for (const question of GEO_QUESTION_BANK) {
    assert.ok(GEO_QUESTION_BANK_CLASSES.includes(question.class), question.id)
    assert.match(question.text, /[？?]$/, `${question.id} is a question`)
    assert.ok(question.text.length >= 8 && question.text.length <= 40, `${question.id}: wording as a person asks, ${question.text.length} characters`)
  }
  for (const key of GEO_QUESTION_BANK_CLASSES) {
    assert.ok(GEO_QUESTION_BANK.filter((question) => question.class === key).length >= 5, `${key} has at least five questions`)
    assert.ok(GEO_QUESTION_BANK_CLASS_LABELS_ZH[key], key)
  }
  // Not about a brand: none of the well-known trade names a person might type is in the bank (class and generic names are the point).
  const brands = ['拜新同', '络活喜', '波立维', '立普妥', '阿卡波糖片拜糖平', '泰诺', '芬必得', '诺和', '诺和灵', '达菲', '力比泰', '信尔美', '氯雷他定片开瑞坦', '拜阿司匹灵', '络活', '倍他乐克', '可定', '代文', '络欣平', '耐信']
  for (const question of GEO_QUESTION_BANK) for (const brand of brands) assert.ok(!question.text.includes(brand), `${question.id} names ${brand}`)
  // And nothing in it recommends or sells: a question is a question.
  for (const question of GEO_QUESTION_BANK) assert.doesNotMatch(question.text, /推荐|哪个牌子|哪家|购买|多少钱/, question.id)
})

test('a bank question is found by its text, and a month is a calendar month in the time zone', () => {
  assert.equal(geoQuestionBankClassOf(' 普通感冒需要吃抗生素吗？ '), 'antibiotic')
  assert.equal(geoQuestionBankClassOf('一个不在题库里的问题？'), null)
  assert.equal(geoQuestionBankMonth(new Date('2026-10-31T17:00:00Z'), 'Asia/Shanghai'), '2026-11', 'half past midnight on the first in Shanghai is November')
  assert.equal(geoQuestionBankMonth(new Date('2026-10-31T17:00:00Z'), 'UTC'), '2026-10')
})

const answer = (/** @type {Record<string, any>} */ over) => ({ class: 'antibiotic', engine: 'deepseek', status: 'valid', judged: true, statements: [], citations: [], ...over })

test('a class rate is correct over correct plus wrong among the specified information; other topics and the undecided stand apart', () => {
  const summary = summarizeQuestionBank({
    publicHost: 'evimed.example.org',
    answers: [
      answer({ statements: [{ topic: 'dosage', verdict: 'correct' }, { topic: 'contraindication', verdict: 'wrong' }, { topic: 'other', verdict: 'wrong' }, { topic: 'indication', verdict: 'unverifiable' }] }),
      answer({ engine: 'doubao', statements: [{ topic: 'adverse_reaction', verdict: 'correct' }, { topic: 'dosage', verdict: 'correct' }] }),
      answer({ class: 'hormone', statements: [{ topic: 'dosage', verdict: 'unverifiable' }] }),
    ],
  })
  const antibiotic = summary.classes.find((entry) => entry.class === 'antibiotic')
  assert.deepEqual([antibiotic?.answers, antibiotic?.correct, antibiotic?.wrong, antibiotic?.decided, antibiotic?.otherDecided], [2, 3, 1, 4, 1])
  assert.equal(antibiotic?.rate, 0.75)
  assert.equal(antibiotic?.label, '抗菌药')
  const hormone = summary.classes.find((entry) => entry.class === 'hormone')
  assert.equal(hormone?.rate, null, 'nothing decided is not a zero')
  assert.equal(summary.classes.find((entry) => entry.class === 'psychotropic')?.answers, 0, 'a class nobody answered is present and empty')
  assert.equal(summary.overall.answers, 3)
  assert.deepEqual(Object.keys(summary.engines), ['deepseek', 'doubao'], 'engines in name order: nothing is ranked')
  assert.deepEqual(summary.classes.map((entry) => entry.class), [...GEO_QUESTION_BANK_CLASSES], 'classes in the bank order')
})

test('the share citing an EviMed page is by host, over the answers that cited anything; refusals and unjudged answers are counted as what they are', () => {
  const summary = summarizeQuestionBank({
    publicHost: 'Evimed.Example.org',
    answers: [
      answer({ citations: [{ url: 'https://evimed.example.org/evidence/c/ec_abc' }, { url: 'https://other.example.com/a' }] }),
      answer({ citations: [{ url: 'https://other.example.com/evimed.example.org/page' }, { url: 'https://evimed.example.org.evil.test/x' }] }),
      answer({ citations: [] }),
      answer({ status: 'refusal', judged: true }),
      answer({ judged: false }),
    ],
  })
  const row = summary.classes.find((entry) => entry.class === 'antibiotic')
  assert.deepEqual([row?.answers, row?.cited, row?.citedEviMed], [5, 2, 1])
  assert.equal(row?.eviMedCitedShare, 0.5, 'a page of another site that mentions ours is not ours; an answer citing nothing does not dilute')
  assert.deepEqual([row?.refusals, row?.unjudged, row?.judged], [1, 1, 4])
  assert.equal(summarizeQuestionBank({ answers: [answer({ citations: [{ url: 'https://evimed.example.org/x' }] })] }).overall.citedEviMed, 0, 'with no public host nothing is ours')
  assert.equal(summarizeQuestionBank({ answers: [], publicHost: 'x.test' }).overall.eviMedCitedShare, null)
})
