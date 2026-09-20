/**
 * What a run is doing, as a label over the tool calls it was seen to make.
 *
 * Hidden knowledge: the phases are not a workflow. Nothing asks the model to
 * announce a phase, and nothing orders the tools — a run may search again
 * after it has started writing, and a plain question makes no tool call at all
 * and so has no phase (principle 12). The labels exist because a researcher
 * watching a 20-minute run asks one question — "is it really working, and on
 * what?" — and the answer is already in the tool calls: which kind of source
 * work the last call was, and how many of each kind came before it.
 *
 * One implementation, so the run ledger, the runs page and the frame's
 * progress tab count the same calls the same way.
 */

import { SOCKET_TOOL_NAMES, mcpToolBaseName } from './toolNames.mjs'
import { DELIVERABLES_DIR } from './workspaceLayout.mjs'

/** The phases, in the order a deep run usually passes through them.
 *  @type {readonly RunActivityPhase[]} */
export const RUN_ACTIVITY_PHASES = Object.freeze(/** @type {const} */ (['search', 'screen', 'fulltext', 'claims', 'write', 'deliver']))

/** @typedef {'search'|'screen'|'fulltext'|'claims'|'write'|'deliver'} RunActivityPhase */

/** Chinese labels for the screen. */
export const RUN_ACTIVITY_PHASE_LABELS_ZH = Object.freeze({
  search: '检索',
  screen: '筛选',
  fulltext: '全文',
  claims: '核验',
  write: '撰写',
  deliver: '交付',
})

/** @type {ReadonlySet<string>} */
const SEARCH_TOOLS = new Set([
  'literature_search',
  'guideline_search',
  'clinical_trial_search',
  'biomedical_source_search',
  'search_papers',
  'search_biomedical_records',
  'drug_label_search',
  'pharmacy_reference_search',
])
/** @type {ReadonlySet<string>} */
const SCREEN_TOOLS = new Set([SOCKET_TOOL_NAMES.screenBatch, 'evidence_deduplicate'])
/** @type {ReadonlySet<string>} */
const FULLTEXT_TOOLS = new Set(['open_access_full_text', 'web_read'])
// Claim-level work. The socket names are listed literally rather than read
// from SOCKET_TOOL_NAMES so this table does not break while a tool is being
// introduced; an unknown name here simply never matches.
/** @type {ReadonlySet<string>} */
const CLAIM_TOOLS = new Set(['evimed_claim_upsert', 'evimed_package_check', 'locate_quote'])
/** @type {ReadonlySet<string>} */
const DELIVER_TOOLS = new Set([SOCKET_TOOL_NAMES.submitDeliverable, SOCKET_TOOL_NAMES.completeRun])
/** @type {ReadonlySet<string>} */
const WRITE_TOOLS = new Set(['write', 'edit', 'fs_write', 'fs_edit'])

/** @param {Record<string, unknown> | null | undefined} input @returns {string} */
function pathOf(input) {
  if (!input || typeof input !== 'object') return ''
  for (const key of ['filePath', 'file_path', 'path', 'target']) {
    const value = input[key]
    if (typeof value === 'string' && value) return value.replace(/\\/g, '/')
  }
  return ''
}

/** @param {string} path */
function isDeliverablePath(path) {
  const trimmed = path.replace(/^\.?\/+/, '').replace(/^workspace\//, '')
  return trimmed.startsWith(`${DELIVERABLES_DIR}/`) || path.includes(`/${DELIVERABLES_DIR}/`)
}

/**
 * The phase one tool call belongs to, or null when it belongs to none (a
 * shell command, a read, a scratch file, a plan call).
 *
 * @param {string} toolName any spelling the kernel reports (bare, `mcp__evimed__…`)
 * @param {Record<string, unknown> | null} [input] the call's arguments
 * @returns {RunActivityPhase | null}
 */
export function phaseOfToolCall(toolName, input = null) {
  const name = String(toolName ?? '')
  const base = mcpToolBaseName(name) ?? name.replace(/^mcp__[a-z0-9-]+__/, '')
  // Two search tools also read what a search found: a label by its id is
  // read in full, and abstracts fetched for chosen PubMed ids are screening.
  if (base === 'drug_label_search' && input?.labelId) return 'fulltext'
  if (base === 'literature_search' && Array.isArray(input?.pmids) && input.pmids.length > 0) return 'screen'
  if (SEARCH_TOOLS.has(base)) return 'search'
  if (SCREEN_TOOLS.has(base)) return 'screen'
  if (FULLTEXT_TOOLS.has(base)) return 'fulltext'
  if (CLAIM_TOOLS.has(base)) return 'claims'
  if (DELIVER_TOOLS.has(base)) return 'deliver'
  if (base === 'evimed_render_report') return 'write'
  if (WRITE_TOOLS.has(base) && isDeliverablePath(pathOf(input))) return 'write'
  return null
}

/**
 * Counts per phase over a sequence of calls, the phases the run actually
 * reached, and the furthest of them.
 *
 * `current` is the furthest phase reached, not the phase of the most recent
 * labelled call. A run that delivered and then made one more checking call read
 * 「核验」 for the rest of its life, and 「筛选」 read 0 on nearly every run
 * because only two tools carry that label — so the line moved backwards while
 * the run moved forwards. Phases are an order a deep run passes through, and a
 * reader watching one wants to know how far it has got.
 *
 * `reached` is that answer without the gaps: only the phases with a call behind
 * them, in order, so a surface can render what happened instead of six labels
 * of which four are zero. The counts are unchanged — they are the evidence.
 *
 * @param {Iterable<{ tool: string, input?: Record<string, unknown> | null }>} calls
 * @returns {{ counts: Record<RunActivityPhase, number>, reached: RunActivityPhase[], current: RunActivityPhase | null }}
 */
export function summarizeRunPhases(calls) {
  /** @type {Record<RunActivityPhase, number>} */
  const counts = { search: 0, screen: 0, fulltext: 0, claims: 0, write: 0, deliver: 0 }
  for (const call of calls) {
    const phase = phaseOfToolCall(call.tool, call.input ?? null)
    if (!phase) continue
    counts[phase] += 1
  }
  const reached = RUN_ACTIVITY_PHASES.filter((phase) => counts[phase] > 0)
  return { counts, reached: [...reached], current: reached.at(-1) ?? null }
}
