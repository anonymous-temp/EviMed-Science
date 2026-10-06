// A report that cites one of EviMed's own evidence-card pages as a source (flywheel plan §4.3 rule 2): what is
// recognised, in what words it is said, and that it is a notice — in no blocking tier, never a reason to withhold.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTRACT_KINDS,
  PLATFORM_CARD_CITATION_SENTENCE,
  GATE_CHECK_IDS,
  GATE_CHECK_TITLES_ZH,
  GATE_CODE_TITLES_ZH,
  citationUrlDefects,
  isPlatformCardAddress,
  platformCardCitations,
  platformCardCitationsByLine,
  runGate,
} from '../index.mjs'
import { CLINICAL_CHECK_TIERS, clinicalCheckTier } from '../src/clinicalEvidence.mjs'

const CARD = 'ec_0123456789abcdef0123456789abcdef'
const ZONE = 'ez_0123456789abcdef0123456789abcdef'

test('a card or zone page is recognised by its path on any host, and so is the in-app page', () => {
  for (const address of [
    `https://www.evimed.com/evidence/c/${CARD}`,
    `https://www.evimed.com/evidence/c/${CARD}?view=clinical`,
    `http://203.0.113.9:8787/evidence/c/${CARD}`,
    `https://anything.example/evidence/z/${ZONE}`,
    `https://anything.example/evidence/z/${ZONE}/changes`,
    `https://anything.example/app/frontier/zones/${ZONE}/evidence/${CARD}`,
  ]) assert.equal(isPlatformCardAddress(address), true, address)
  for (const address of [
    'https://www.evimed.com/evidence/about',
    'https://www.evimed.com/evidence/c/',
    'https://www.evimed.com/evidence/c/x',
    'https://www.evimed.com/evidence/',
    'https://professional.heart.org/evidence/3',
    `https://example.org/news/evidence/c/${CARD}`,
    'https://doi.org/10.1056/NEJMoa2600001',
    'not a url',
    '',
  ]) assert.equal(isPlatformCardAddress(address), false, address)
})

test('the configured public URL adds the pages under its own path prefix, and only on its own host', () => {
  const prefixed = `https://public.example/ev/evidence/c/${CARD}`
  assert.equal(isPlatformCardAddress(prefixed), false, 'a prefix nobody told us about is not guessed')
  assert.equal(isPlatformCardAddress(prefixed, { publicUrl: 'https://public.example/ev/' }), true)
  assert.equal(isPlatformCardAddress(`https://other.example/ev/evidence/c/${CARD}`, { publicUrl: 'https://public.example/ev/' }), false)
  assert.equal(isPlatformCardAddress(`https://public.example/evidence/c/${CARD}`, { publicUrl: 'https://public.example/ev/' }), true, 'the root path stays recognised')
})

test('links in running text are found by line, absolute and root-relative, each once per line', () => {
  const text = [
    '# 报告',
    `见 [证据卡](/evidence/c/${CARD}) 与 https://www.evimed.com/evidence/c/${CARD}，再见 https://www.evimed.com/evidence/c/${CARD}。`,
    `在应用里 /app/frontier/zones/${ZONE}/evidence/${CARD} 也一样。`,
    '原始来源 https://doi.org/10.1056/NEJMoa2600001 与 https://www.evimed.com/evidence/about 不算。',
  ].join('\n')
  assert.deepEqual(platformCardCitations(text), [
    { line: 2, url: `https://www.evimed.com/evidence/c/${CARD}` },
    { line: 2, url: `/evidence/c/${CARD}` },
    { line: 3, url: `/app/frontier/zones/${ZONE}/evidence/${CARD}` },
  ])
  const [first] = platformCardCitationsByLine('report.md', text)
  assert.ok(first.message.startsWith(PLATFORM_CARD_CITATION_SENTENCE), 'the reader-facing sentence comes first')
  assert.match(first.message, /report\.md 第 2 行/)
  assert.deepEqual(platformCardCitations('没有链接，只有 https://doi.org/10.1/x'), [])
})

test('the sentence a reader is shown is the one the issue asks for', () => {
  assert.equal(PLATFORM_CARD_CITATION_SENTENCE, '这是 EviMed 自己的证据卡，请改引原始来源')
})

test('a card citation is a notice on the manifest\'s citation check, and the plain-HTTP and unreachable findings are unchanged', () => {
  const report = [
    '# 评价',
    `依据 https://www.evimed.com/evidence/c/${CARD} 的结论。`,
    '公开记录 http://example.org/label 可以打开。',
  ].join('\n')
  const verdict = runGate({ contractKind: 'drug-evaluation-report', files: new Map([['r.md', report]]), expectedOutputs: [{ path: 'r.md', required: true }], checks: ['citationsResolvable'] })
  const found = verdict.issues.filter((entry) => entry.check === 'citations-resolvable' || entry.check === 'platform-card-citation')
    .map((entry) => [entry.code, entry.severity, entry.check, entry.line])
  assert.deepEqual(found, [
    ['citation_plain_http', 'advisory', 'citations-resolvable', 3],
    ['platform_card_cited', 'advisory', 'platform-card-citation', 2],
  ])
  assert.equal(verdict.ok, true, 'a notice withholds nothing')
  const without = runGate({ contractKind: 'drug-evaluation-report', files: new Map([['r.md', report]]), expectedOutputs: [{ path: 'r.md', required: true }] })
  assert.equal(without.issues.some((entry) => entry.check === 'platform-card-citation'), false, 'a kind that does not declare the check does not raise it')
  assert.deepEqual(citationUrlDefects(report).blocking, [], 'the address is public, so it is not an unreachable one')
})

test('the check has a title, a code title and no tier: it can only advise', () => {
  assert.ok(GATE_CHECK_IDS.includes('platform-card-citation'))
  assert.ok(GATE_CHECK_TITLES_ZH['platform-card-citation'])
  assert.ok(GATE_CODE_TITLES_ZH.platform_card_cited)
  assert.equal(CLINICAL_CHECK_TIERS['platform-card-citation'], undefined)
  assert.equal(clinicalCheckTier('platform-card-citation'), 'advisory')
  assert.ok(CONTRACT_KINDS.length > 0)
})
