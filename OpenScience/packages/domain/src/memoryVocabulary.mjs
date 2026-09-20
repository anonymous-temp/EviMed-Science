/**
 * What the platform itself writes into a conversation, and what it calls its
 * own machinery — the two closed vocabularies a memory write is checked against
 * in code.
 *
 * Hidden knowledge: why a list of tags rather than a pattern. On 2026-09-19 the
 * acceptance account held 54 memories and 30 of them were about the platform —
 * gates, quotes, artifacts, deliverables — not about the researcher. Part of the
 * cause was the extractor's injection filter, which recognised four
 * `<evimed-*>` markers while the platform emitted eighteen: an autopilot
 * episode's prompt, a budget marker, a verification brief all reached it as
 * "something the user said". A marker the platform writes is a closed
 * vocabulary we control, so recognising one is a structural check (principle
 * 5); a pattern like `<evimed-[a-z-]+>` would also be one, and would silently
 * start treating a tag nobody reviewed as machine text. So every tag is named
 * here with the file that writes it, and `memoryVocabulary.test.mjs` walks the
 * source tree and fails on a tag emitted anywhere that this list does not name.
 *
 * Whether a sentence is *about* the platform — "the gate rejected the package
 * twice" — is language, and belongs to the extraction model's instructions.
 * What code may check is only the closed half: tool names, workspace paths,
 * contract kinds — identifiers no researcher types as research.
 *
 * @module @evimed/domain/memoryVocabulary
 */

import { CONTRACT_KINDS } from './contractKinds.mjs'
import { KERNEL_MOUNTED_TOOL_NAMES, MCP_TOOL_BASE_NAMES, MCP_TOOL_PREFIX, SOCKET_TOOL_NAME_LIST } from './toolNames.mjs'
import { workspaceLayout } from './workspaceLayout.mjs'

/**
 * Every `<evimed-*>` tag the platform writes into a conversation.
 *
 * `role` says what a message carrying the tag is:
 *  - `injected` — machine text in the user slot (a brief, a recalled memory, a
 *    budget notice). Nothing in such a message is the researcher's own words.
 *  - `user-wrapper` — the researcher's own words, wrapped by us so a compaction
 *    keeps them (`POST /api/agent-runs/:id/steer`). The wrapper is removed and
 *    the words are kept: a correction typed mid-run is the most direct thing a
 *    researcher ever tells the system.
 *
 * `emitters` names where the tag is written, so the test that holds this list
 * complete can say which file added a tag nobody listed. `legacy` marks a tag
 * no current code writes but older transcripts still carry.
 *
 * @type {readonly { tag: string, role: 'injected' | 'user-wrapper', emitters: readonly string[], legacy?: string }[]}
 */
export const PLATFORM_CONTEXT_TAGS = Object.freeze([
  { tag: 'evimed-brief', role: 'injected', emitters: ['packages/socket/plugins/run-policy.mjs'] },
  { tag: 'evimed-capsule', role: 'injected', emitters: ['packages/socket/plugins/run-policy.mjs'] },
  // A 「试用一次」 conversation's borrowed capsule, in its dispatch context.
  { tag: 'evimed-capsule-trial', role: 'injected', emitters: ['apps/server/src/capsuleService.mjs'] },
  { tag: 'evimed-agenda', role: 'injected', emitters: ['packages/socket/plugins/run-policy.mjs'] },
  { tag: 'evimed-budget', role: 'injected', emitters: ['packages/socket/plugins/run-policy.mjs'] },
  { tag: 'evimed-run', role: 'injected', emitters: ['packages/socket/plugins/run-policy.mjs'] },
  { tag: 'evimed-skill', role: 'injected', emitters: ['packages/socket/plugins/guidance.mjs', 'apps/server/src/researchContext.mjs'] },
  { tag: 'evimed-orchestration', role: 'injected', emitters: ['packages/socket/src/guidanceText.mjs'] },
  { tag: 'evimed-delegated', role: 'injected', emitters: ['packages/socket/src/guidanceText.mjs'] },
  { tag: 'evimed-memory', role: 'injected', emitters: ['apps/server/src/researchContext.mjs'] },
  {
    tag: 'evimed-knowledge', role: 'injected', emitters: [],
    legacy: 'the knowledge-base excerpts every dispatch used to carry, retired 2026-09-20 when kb_search became a tool the model chooses; transcripts from before still carry it',
  },
  { tag: 'evimed-specialist', role: 'injected', emitters: ['apps/server/src/researchContext.mjs'] },
  { tag: 'evimed-autopilot-episode', role: 'injected', emitters: ['apps/server/src/server.mjs'] },
  { tag: 'evimed-autopilot-verification', role: 'injected', emitters: ['apps/server/src/server.mjs'] },
  { tag: 'evimed-budget-scope', role: 'injected', emitters: ['apps/server/src/modelGateway.mjs'] },
  { tag: 'evimed-claim', role: 'injected', emitters: ['apps/server/src/autopilotService.mjs'] },
  { tag: 'evimed-claim-source', role: 'injected', emitters: ['apps/server/src/autopilotService.mjs'] },
  { tag: 'evimed-claim-effect', role: 'injected', emitters: ['apps/server/src/autopilotService.mjs'] },
  { tag: 'evimed-correction', role: 'user-wrapper', emitters: ['apps/server/src/server.mjs'] },
  {
    tag: 'evimed-context',
    role: 'injected',
    emitters: [],
    legacy: 'the dispatch context block before it moved into context.md; transcripts from that time still carry it',
  },
])

/** @param {string} value @returns {string} */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** @param {'injected' | 'user-wrapper'} role */
function tagPattern(role) {
  const names = PLATFORM_CONTEXT_TAGS.filter((entry) => entry.role === role).map((entry) => entry.tag)
    // Longest first, so `evimed-claim-source` is never read as `evimed-claim`.
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
  // An opening tag may carry attributes (`<evimed-memory index="1" …>`).
  return new RegExp(`</?(?:${names.join('|')})(?=[\\s>/])[^>]*>`, 'g')
}

/**
 * Whether a text carries a block the platform injected.
 * @param {unknown} text @returns {boolean}
 */
export function carriesPlatformContext(text) {
  return tagPattern('injected').test(String(text ?? ''))
}

/**
 * The text with every user-wrapper tag removed and its content kept.
 * @param {unknown} text @returns {string}
 */
export function unwrapUserWrappers(text) {
  return String(text ?? '').replace(tagPattern('user-wrapper'), '').trim()
}

/**
 * The text with every platform tag removed — for display of a record that was
 * stored before the extractor could recognise them. Never a summary: what is
 * left is what was stored, minus envelopes nobody typed.
 * @param {unknown} text @returns {string}
 */
export function stripPlatformTags(text) {
  return String(text ?? '').replace(tagPattern('injected'), '').replace(tagPattern('user-wrapper'), '').trim()
}

/**
 * The platform's own identifiers: what its tools, files and contracts are
 * called. Identifier-shaped on purpose — a name with an underscore, a leading
 * dot, a file extension or a contract kind of three or more joined words —
 * because those are the ones no researcher writes as research. A bare English
 * word the platform also happens to use is language and stays with the model:
 * `health` is an MCP tool and a word in half the questions this product is
 * asked, `analysis-plan` is a contract kind and a phrase, `deliverable` and
 * `gate` are how anyone would describe the machinery in prose.
 */
const PLATFORM_IDENTIFIERS = Object.freeze([...new Set([
  ...SOCKET_TOOL_NAME_LIST,
  ...MCP_TOOL_BASE_NAMES.filter((name) => name.includes('_')),
  ...KERNEL_MOUNTED_TOOL_NAMES.filter((name) => name.includes('_')),
  ...CONTRACT_KINDS.filter((kind) => kind.split('-').length >= 3),
  workspaceLayout.briefDir,
  workspaceLayout.runStateDir,
  workspaceLayout.capsuleDir,
  workspaceLayout.sourcesDir,
  workspaceLayout.knowledgeDir,
  workspaceLayout.planFile,
  workspaceLayout.receiptFile,
  workspaceLayout.deliverySummaryFile,
  workspaceLayout.revisionNotesFile,
])].sort((left, right) => right.length - left.length))

/** Prefixes that make whatever follows them ours. */
const PLATFORM_PREFIXES = Object.freeze([MCP_TOOL_PREFIX, 'evimed_'])

const IDENTIFIER_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${PLATFORM_IDENTIFIERS.map(escapeRegExp).join('|')})(?![A-Za-z0-9_-])`
    + `|(?<![A-Za-z0-9_-])(?:${PLATFORM_PREFIXES.map(escapeRegExp).join('|')})[A-Za-z0-9_]+`,
  'g',
)

/**
 * The platform identifiers a text names, in order of first appearance.
 *
 * Used where a memory is written: a value that names `evimed_submit_deliverable`
 * or `.evimed-run/` is a note the system took about itself, and it has no place
 * in what the platform remembers about a researcher.
 * @param {unknown} text @returns {string[]}
 */
export function platformIdentifiersIn(text) {
  /** @type {string[]} */
  const found = []
  for (const match of String(text ?? '').matchAll(IDENTIFIER_PATTERN)) {
    if (!found.includes(match[0])) found.push(match[0])
  }
  return found
}

/**
 * The words this platform uses for its own machinery, in Chinese.
 *
 * Hidden knowledge: on 2026-09-20 the production account's 「项目档案」 held
 * sixteen rows and every one of them was the run talking about itself — a
 * ledger's field name, what the gate had asked for, which artifact had been
 * written. `platformIdentifiersIn` could not see any of it, because it only
 * knows identifiers we ship (`evimed_*`, `.evimed-run/`), and a run narrating
 * its own bookkeeping does it in prose: 「台账」, 「门禁」, 「交付物」.
 *
 * Enumerated, not patterned, for the same reason `PLATFORM_CONTEXT_TAGS` is:
 * this is a closed vocabulary we control (principle 5), and each entry names
 * where the platform itself says it, so a reader can check that it is our word
 * and not the researcher's. Terms a pharmacologist might plausibly write about
 * medicine — 证据, 评价, 方案 — are deliberately absent: whether prose is
 * *about* the machinery is language, and it belongs to the extraction
 * instructions.
 *
 * @type {readonly { term: string, saidIn: string }[]}
 */
export const PLATFORM_JARGON_ZH = Object.freeze([
  { term: '控制面', saidIn: 'the control plane, in our own architecture prose' },
  { term: '门禁', saidIn: 'the delivery gate (`gateIssueText.mjs`)' },
  { term: '台账', saidIn: 'the run ledger and the coverage ledger' },
  { term: '交付物', saidIn: 'a deliverable (`contractKinds.mjs`, the plan card)' },
  { term: '运行账本', saidIn: 'the run ledger' },
  { term: '运行环境', saidIn: 'a project runtime (`runtimeManager.mjs`)' },
  { term: '工作区', saidIn: 'the run workspace (`workspaceLayout.mjs`)' },
  { term: '提示词', saidIn: 'the system prompt' },
  { term: '内核', saidIn: 'the DSH kernel' },
  { term: '子任务', saidIn: 'a delegated child run (`runtimeUiToolviews.mjs`)' },
  { term: '回执', saidIn: 'the run receipt (`receipt.mjs`)' },
  { term: '预检', saidIn: "a capability's `preflight.py`" },
  { term: '自检', saidIn: "a package's self-declared quality checks" },
  { term: '召回', saidIn: 'memory recall (`memoryRecall.mjs`)' },
])

const JARGON_PATTERN = new RegExp(
  PLATFORM_JARGON_ZH.map((entry) => escapeRegExp(entry.term))
    .sort((left, right) => right.length - left.length)
    .join('|'),
  'g',
)

/**
 * Identifier shapes a researcher does not type as research: a field name in
 * camelCase (`referenceNumber`), a file name with one of the extensions a run
 * writes, or a dotted/slashed path. A format check, like a DOI or a PMID —
 * decidable from the token itself, with no opinion about what it means.
 *
 * `[A-Za-z]` only: a Chinese sentence quoting one still trips, which is the
 * point — 「ledger 的 referenceNumber 字段是…」 is the run's bookkeeping in the
 * researcher's language.
 */
const CODE_SHAPE_PATTERN = new RegExp(
  // camelCase or PascalCase with a lower→upper hump, at least two segments
  '(?<![A-Za-z0-9_-])[A-Za-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+(?![A-Za-z0-9_-])'
  // a file name with an extension a run writes
  + '|(?<![A-Za-z0-9_-])[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:md|json|jsonl|ya?ml|csv|tsv|py|mjs|js|ts|bib|xlsx|docx|ipynb|log|txt|sh|R)(?![A-Za-z0-9])',
  'g',
)

/**
 * What a text says that makes it the run's own bookkeeping rather than
 * something known about the researcher — our Chinese jargon and identifier
 * shapes, in order of first appearance.
 *
 * Both halves are closed or structural on purpose. The decision this feeds is
 * "refuse to store", which is an engineering boundary (principle 14) and has
 * to be decidable; every judgement about whether a sentence is *about* the
 * machinery stays with the extraction model.
 *
 * @param {unknown} text @returns {string[]}
 */
export function runBookkeepingIn(text) {
  const value = String(text ?? '')
  /** @type {string[]} */
  const found = []
  for (const pattern of [JARGON_PATTERN, CODE_SHAPE_PATTERN]) {
    for (const match of value.matchAll(pattern)) {
      if (!found.includes(match[0])) found.push(match[0])
    }
  }
  return found
}
