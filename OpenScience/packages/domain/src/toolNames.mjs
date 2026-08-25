/**
 * Tool names, in one place.
 *
 * Hidden knowledge: two naming worlds meet here. The MCP server is mounted
 * under the server name `evimed`, and DSH exposes an MCP tool to the model as
 * `mcp__<server>__<tool>`. Carrying the historical `evimed_` prefix on the raw
 * MCP tool names would produce `mcp__evimed__evimed_literature_search` — the
 * prefix twice, and 38 characters of it. So the raw MCP names drop the prefix
 * and the socket's own tools keep it: a name starting with `evimed_` is ours,
 * a name starting with `mcp__evimed__` is the research server's.
 *
 * Every consumer that needs a tool name derives it from here: the SKILL.md
 * rewrite script, the runtime-leakage banned-word list, the capability
 * manifest validator, the run ledger's tool matcher, and the narration table.
 */

/** MCP server name as mounted by the runtime (decision record 2026-08-22 #4). */
export const MCP_SERVER_NAME = 'evimed'

/**
 * The name the same MCP server is registered under in `opencode.json`'s `mcp`
 * map. It predates `MCP_SERVER_NAME` and is a different string on purpose —
 * changing it now would rename a live entry a running deployment's session
 * history already refers to by the old name. OpenCode reports a tool call in
 * session history as `<this>_<published-tool-name>`, which is a third naming
 * convention `mcpToolBaseName` has to unwrap, distinct from both DSH's prefix
 * and the bare name the server itself publishes.
 */
export const OPENCODE_MCP_SERVER_NAME = 'evimed-research'

/** Prefix DSH gives every tool of that server on the model-visible surface. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** DSH publishes an MCP tool as `${serverName}__${rawName}` — the server name,
 *  two underscores, the tool's own name. Distinct from the single-underscore
 *  spelling below, and the difference is not cosmetic: stripping `evimed_` off
 *  `evimed__literature_search` leaves `_literature_search`, which matches
 *  nothing, so every research tool call parsed as "not one of ours". */
export const DSH_MCP_TOOL_PREFIX = `${MCP_SERVER_NAME}__`

/** Prefix OpenCode gives every tool call it reports from this server in session history. */
export const OPENCODE_MCP_TOOL_PREFIX = `${OPENCODE_MCP_SERVER_NAME}_`

/**
 * The 26 research tools the MCP server publishes, without any prefix.
 * Order is the routing-table order of the design (§21.2), not alphabetical,
 * so a reader can see the subgroups.
 */
export const MCP_TOOL_BASE_NAMES = Object.freeze([
  // retrieval (public + private adapters)
  'literature_search',
  'guideline_search',
  'clinical_trial_search',
  'patent_search',
  'biomedical_source_search',
  // full text and pages
  'open_access_full_text',
  'official_page_fetch',
  'web_search',
  // pharmacy data
  'drug_label_search',
  'pharmacy_reference_search',
  'adr_case_query',
  'adr_signal_analysis',
  'drug_term_normalize',
  // deterministic compilation
  'offlabel_evidence_packet',
  'comprehensive_drug_evaluation',
  'drug_selection_evaluation',
  // managed jobs (specialist engines)
  'meta_analysis',
  'mendelian_randomization',
  'bibliometric_analysis',
  'research_topic_selection',
  'peer_review',
  'drug_safety_analysis',
  // local tools
  'data_source_catalog',
  'evidence_deduplicate',
  'term_normalize',
  'health',
])

/** Model-visible MCP tool names. */
export const MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_BASE_NAMES.map((name) => `${MCP_TOOL_PREFIX}${name}`))

/**
 * The six managed-job tools. They start a specialist engine and then need
 * polling, which is why §21.7 wraps exactly these in a DSH job.
 */
export const MCP_MANAGED_JOB_BASE_NAMES = Object.freeze([
  'meta_analysis',
  'mendelian_randomization',
  'bibliometric_analysis',
  'research_topic_selection',
  'peer_review',
  'drug_safety_analysis',
])

/** The socket's own tools, registered by the agent-scope plugins (§5.3). */
export const SOCKET_TOOL_NAMES = Object.freeze({
  plan: 'evimed_plan',
  delegate: 'evimed_delegate',
  submitDeliverable: 'evimed_submit_deliverable',
  completeRun: 'evimed_complete_run',
  capsuleRecall: 'evimed_capsule_recall',
  capsuleNote: 'evimed_capsule_note',
  screenBatch: 'evimed_screen_batch',
  reviewRun: 'evimed_review_run',
})

/** Flat list of socket tool names. */
/** @type {readonly string[]} */
export const SOCKET_TOOL_NAME_LIST = Object.freeze(Object.values(SOCKET_TOOL_NAMES))

/** The umbrella retrieval tools the root orchestrator sees (§9.7). */
export const ROOT_VISIBLE_MCP_BASE_NAMES = Object.freeze([
  'literature_search',
  'web_search',
  'open_access_full_text',
  'term_normalize',
  'data_source_catalog',
])

/** @param {string} baseName @returns {string} */
export function mcpToolName(baseName) {
  return `${MCP_TOOL_PREFIX}${baseName}`
}

/**
 * Accepts any spelling of an MCP tool and returns the base name, or null.
 *
 * One tool has four names, depending on who is looking and when, and all four
 * have to resolve or a run ledger written under one kernel — or written before
 * a rename — becomes unreadable:
 *
 *   `literature_search`                       what the server publishes, and
 *                                             what a kernel that does not
 *                                             prefix MCP tools (OpenCode)
 *                                             shows the model
 *   `mcp__evimed__literature_search`           what DSH shows the model
 *   `evimed-research_literature_search`        what OpenCode's own session
 *                                             history reports a tool call
 *                                             as — `<server registration
 *                                             name>_<published name>`,
 *                                             a third, independent prefix
 *   `evimed_literature_search`                 the historic published
 *                                             spelling, still in old run
 *                                             ledgers, recorded eval
 *                                             artifacts, and — because
 *                                             OpenCode's history prefix
 *                                             wraps whatever name the
 *                                             server happened to publish
 *                                             at the time —
 *                                             `evimed-research_evimed_literature_search`
 *
 * The bare spelling is the one that is easy to forget, because it is the only
 * one without a marker — and it is also the one the ledger sees today under the
 * rollback kernel.
 *
 * @param {string} name @returns {string | null}
 */
export function mcpToolBaseName(name) {
  let text = String(name ?? '')
  // OpenCode's history prefix wraps whatever the server published at the time,
  // so it is stripped first and the rest re-checked against every other known
  // spelling — including the historic one, for history recorded before a rename.
  if (text.startsWith(OPENCODE_MCP_TOOL_PREFIX)) {
    text = text.slice(OPENCODE_MCP_TOOL_PREFIX.length)
  }
  if (text.startsWith(MCP_TOOL_PREFIX)) {
    const base = text.slice(MCP_TOOL_PREFIX.length)
    return MCP_TOOL_BASE_NAMES.includes(base) ? base : null
  }
  // Checked before the single-underscore spelling, which would otherwise
  // consume the first of the two and leave a leading underscore behind.
  if (text.startsWith(DSH_MCP_TOOL_PREFIX)) {
    const base = text.slice(DSH_MCP_TOOL_PREFIX.length)
    return MCP_TOOL_BASE_NAMES.includes(base) ? base : null
  }
  if (text.startsWith('evimed_')) {
    const base = text.slice('evimed_'.length)
    return MCP_TOOL_BASE_NAMES.includes(base) ? base : null
  }
  return MCP_TOOL_BASE_NAMES.includes(text) ? text : null
}

/** @param {string} name @returns {boolean} */
export function isMcpToolName(name) {
  return mcpToolBaseName(name) != null
}

/** @param {string} name @returns {boolean} */
export function isSocketToolName(name) {
  return SOCKET_TOOL_NAME_LIST.includes(String(name ?? ''))
}

/**
 * A tool name belongs to EviMed when either world claims it. The run ledger
 * uses this to tell "the run called one of our tools" from "the run called a
 * framework tool", which is how a specialist run proves it did real work.
 * @param {string} name @returns {boolean}
 */
export function isEviMedToolName(name) {
  return isMcpToolName(name) || isSocketToolName(name)
}

/**
 * Substrings that must never appear in report prose: naming a tool or a
 * gateway in a deliverable is retrieval leakage. Both spellings are listed
 * because a model that has seen the legacy prefix in an old skill file will
 * reproduce it.
 */
export const RUNTIME_LEAKAGE_TOOL_TOKENS = Object.freeze([
  MCP_TOOL_PREFIX,
  'evimed_',
  ...MCP_TOOL_NAMES,
  ...SOCKET_TOOL_NAME_LIST,
])
