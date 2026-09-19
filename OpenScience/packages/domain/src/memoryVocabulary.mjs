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
