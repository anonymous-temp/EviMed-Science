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


/** Prefix OpenCode gives every tool call it reports from this server in session history. */
export const OPENCODE_MCP_TOOL_PREFIX = `${OPENCODE_MCP_SERVER_NAME}_`

/**
 * The research tools the MCP server publishes, without any prefix — exactly
 * `server.py`'s `TOOL_DEFINITIONS`, which `apps/server/test/evimedMcp.test.mjs`
 * asks the server for rather than counting here (a count in this comment said
 * 26 while the list held 34). Order is the routing-table order of the design
 * (§21.2), not alphabetical, so a reader can see the subgroups.
 */
export const MCP_TOOL_BASE_NAMES = Object.freeze([
  // retrieval (public + private adapters)
  'literature_search',
  // a paper's reference list, or its citing papers (Europe PMC, 2026-09-23):
  // the deterministic half of tracing a field's landmark trials
  'reference_list',
  'guideline_search',
  'clinical_trial_search',
  'patent_search',
  'biomedical_source_search',
  // linked identifiers, a trial's record with its history, and a US label by
  // version (2026-10-04, N04): each preserves what it read and names how the
  // retrieval ended (source_outcome.py)
  'identifier_resolve',
  'clinical_trial_snapshot',
  'dailymed_label',
  // The NCBI Gene Expression Omnibus workflow (2026-10-04, N17): a series preserved and identity-checked, and the
  // differential-expression computation the platform's engine does, never the model (gene_expression_tools.py).
  // Not 「循证 GEO」: those are geo_read / geo_write below.
  'gene_expression_series',
  'gene_expression_differential',
  // full text and pages
  'open_access_full_text',
  'web_read',
  'web_search',
  // claim work over preserved sources (the gate's own quotation check)
  'locate_quote',
  // measured visibility (the consumer LLM front-ends, not the record)
  'geo_visibility_probe',
  // 「循证 GEO」: the project's own data through the control plane's GEO
  // gateway, and the social channel real phrasings are collected from
  // (geo_platform.py; build spec 2026-09-25 §4)
  'geo_read',
  'geo_write',
  'social_posts_search',
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
  // first-party science connectors (mounted from science_connectors.py)
  'search_papers',
  'search_biomedical_records',
  'search_materials',
  'get_fred_series',
  'get_space_weather_alerts',
  'get_weather',
  'get_usgs_water_data',
  // local tools
  'data_source_catalog',
  'evidence_deduplicate',
  'term_normalize',
  'health',
  // the researcher's own knowledge base, through the server's index
  // (kb_search.py, 2026-09-20)
  'kb_search',
  // the same knowledge base as a tree to find one's way through — the documents, the wiki compiled from them and the
  // knowledge graph — through the server's browse gateway (kb_browse.py, 2026-10-13): read-only, an index into the
  // documents and never evidence of its own
  'kb_browse',
  // the feed of recent medical developments, 「前沿动态」, through the server's
  // gateway (frontier_search.py, 2026-09-22): leads, never evidence
  'frontier_search',
  // 「虚拟临床研究」: the study's own data through the control plane's VCR gateway,
  // the deterministic engine behind a submit/poll pair, a trial registry
  // record as structured fields, and the meta engine's direct pooling entry
  // (vcr_platform.py; build plan 2026-09-28 §11.2). None of them computes in
  // the model: `vcr_simulate` queues a frozen scenario and answers with a job.
  'vcr_read',
  'vcr_write',
  'vcr_simulate',
  'trial_registry_record',
  // a published Kaplan-Meier figure read into curve points by the platform's deterministic
  // digitizer: the run states a calibration and never a coordinate (vcr_platform.py)
  'curve_digitize',
  'evidence_pool',
  'research_calculate',
  // what a project's datasets mean — the recorded interpretation, its exact source versions and the deterministic
  // data checks — through the control plane's ledger; offered to the two capabilities that start from a
  // researcher's own data (dataset_semantics, data_semantics.py; plan 2026-10-02 §11.3 N03)
  'dataset_semantics',
  // A scheduled task made and changed from a conversation (N-13, 2026-10-09): the form's twin, through the control plane's own
  // task service — the platform's default budgets, started at once, nothing to approve (task_tools.py → taskToolsGateway.mjs).
  // The account and the project are the runtime token's; a conversation never names either.
  'schedule_task',
  'update_task',
])

/** Model-visible MCP tool names. */
export const MCP_TOOL_NAMES = Object.freeze(MCP_TOOL_BASE_NAMES.map((name) => `${MCP_TOOL_PREFIX}${name}`))

/**
 * Names a research tool had before it was renamed, and the name it has now.
 * Resolved by `mcpToolBaseName` and nothing else, so a run ledger, a
 * transcript or an eval trace written before a rename still reads as the tool
 * it recorded — never offered, never advertised.
 *
 * `official_page_fetch` became `web_read` on 2026-09-20 when it stopped being
 * limited to allowlisted official pages (plan §3.5).
 */
export const RETIRED_MCP_TOOL_NAMES = Object.freeze({
  official_page_fetch: 'web_read',
})

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
  // Delegation returns a handle and does not wait; this is where the parent
  // collects (2026-09-18).
  await: 'evimed_await',
  reviseDeliverable: 'evimed_revise_deliverable',
  submitDeliverable: 'evimed_submit_deliverable',
  // The same verdict as a submission, without spending one. A run learned the
  // contract by failing submissions because nothing else could tell it where it
  // stood (2026-09-18 review, appendix E §1.3).
  packageCheck: 'evimed_package_check',
  // Claim-level evidence work for a deliverable that carries an evidence
  // matrix: one claim written and judged by the gate's own rules at a time,
  // and the report's numbering and reference list made to agree with it —
  // what runs did with scripts they wrote themselves (2026-09-18 review,
  // appendix E §1; plan §9.1). Never required steps: cheaper than a script,
  // nothing more.
  claimUpsert: 'evimed_claim_upsert',
  renderReport: 'evimed_render_report',
  capsuleRecall: 'evimed_capsule_recall',
  capsuleNote: 'evimed_capsule_note',
  screenBatch: 'evimed_screen_batch',
  reviewRun: 'evimed_review_run',
  compactRequest: 'evimed_compact_request',
})

/** Flat list of socket tool names. */
/** @type {readonly string[]} */
export const SOCKET_TOOL_NAME_LIST = Object.freeze(Object.values(SOCKET_TOOL_NAMES))

/**
 * Socket tools no plugin registers any more, kept for the transcripts that
 * still carry their calls. `evimed_complete_run` was deleted on 2026-09-20: a
 * conversation turn ending is the run ending, and nothing the model calls may
 * be able to refuse it. Named here so a run recorded before then still reads
 * as 「结束运行」 in its narration and as a delivery step in its phases; kept
 * out of `SOCKET_TOOL_NAME_LIST`, so it is not a tool a skill may call, a
 * tool the ledger credits, or a name the vocabulary claims is mounted.
 */
export const RETIRED_SOCKET_TOOL_NAMES = Object.freeze({
  completeRun: 'evimed_complete_run',
})

/**
 * The research tools the root session sees; every other `mcp__evimed__*` tool
 * is visible only where a capability asks for it — to a delegated child, or to
 * the root itself once its plan names that capability.
 *
 * The root is the conversation, and the conversation is a general one: it
 * writes, builds files, codes, analyses data and looks things up. So the list
 * starts with what any task may need — the open web, the person's own
 * documents, exact calculation, scheduling — and then holds the evidence
 * tools, which the evidence method (`open-domain-answer`, a skill the model
 * loads when the question is medical or asks what the literature shows) names
 * and a plain medical question must be able to call without a delegation.
 * Until 2026-10-12 the comment here read the other way round: the root was
 * "the answer line", its tools were "the answer persona's declared tools", and
 * the web search was listed as a research umbrella tool.
 *
 * The evidence tools stay mounted rather than appearing with the method. The
 * kernel can narrow and widen a session's tools between requests (it is how a
 * planned capability's tools arrive), but a second restriction keyed on the
 * method would have to be lifted on every path a capability reaches the root
 * by, and a miss there hides `literature_search` from a clinical run — the
 * 2026-09-27 class of defect. Their descriptions say what they search.
 *
 * The rest — the specialist engines, the deterministic compilers, the science
 * connectors — would ride every root request (56 schemas, ~95 K characters)
 * and are a capability's work.
 *
 * `socket.test.mjs` holds this list against the conversation's `agent.yaml`,
 * the guidance text and the evidence method, so a tool added to any of them is
 * a red test here rather than a silent refusal in production.
 */
export const ROOT_VISIBLE_MCP_BASE_NAMES = Object.freeze([
  // What any task may need. The open web: a page can be the primary source for
  // a software, policy or market question.
  'web_search',
  'web_read',
  // The person's own documents (plan §3.2; model-chosen, never forced).
  'kb_search',
  // So is "what does my knowledge base hold" and a question that spans several documents: the conversation finds its
  // way by the wiki's contents, a page, the graph (model-chosen, never forced).
  'kb_browse',
  'research_calculate',
  // "每周五帮我看看……" is said in any conversation, and "改到每周一 8 点" in a task's own
  // conversation: a tool the root is not shown would fail exactly the sentence it exists for (model-chosen, never forced).
  'schedule_task',
  'update_task',
  // The evidence tools: what the evidence method names, and what a medical or
  // literature question is answered with.
  'literature_search',
  'open_access_full_text',
  'guideline_search',
  'clinical_trial_search',
  'biomedical_source_search',
  'drug_label_search',
  'pharmacy_reference_search',
  'drug_term_normalize',
  'term_normalize',
  'evidence_deduplicate',
  'data_source_catalog',
  // "what is new in X": the method's optional feed lookup
  // (frontier plan 2026-09-21 §4.8; model-chosen, never forced).
  'frontier_search',
])

/** @param {string} baseName @returns {string} */
export function mcpToolName(baseName) {
  return `${MCP_TOOL_PREFIX}${baseName}`
}

/**
 * The official OpenViking memory plugin's tools (`@openviking/dsh-memory-plugin`, built into the runtime image; on only for an
 * account on the native memory engine). The plugin mounts an MCP server named `openviking`, so the model sees them as
 * `mcp__openviking__<tool>`. They are not the research server's: no `mcp__evimed__` rule applies to them, a run that called
 * one has not thereby done research work (`isEviMedToolName` stays false), and the root narrowing that hides the research
 * server's specialist tools never touches them.
 *
 * Exactly these five are admitted. The memory gateway answers `tools/list` with these and nothing else (its descriptions,
 * its argument guards), and the plugin's server advertises twenty — add a resource, add a skill, a file write — that would
 * reach the model if the gateway were ever bypassed or changed. The root session is denied every other `mcp__openviking__*`
 * tool the registry holds (`rootHiddenMcpTools`), so a sixth tool is a red test here before it is a capability in a run.
 */
export const OPENVIKING_MCP_SERVER_NAME = 'openviking'
export const OPENVIKING_MCP_TOOL_PREFIX = `mcp__${OPENVIKING_MCP_SERVER_NAME}__`
export const OPENVIKING_MEMORY_TOOL_BASE_NAMES = Object.freeze(['search', 'read', 'list', 'remember', 'forget'])
export const OPENVIKING_MEMORY_TOOL_NAMES = Object.freeze(OPENVIKING_MEMORY_TOOL_BASE_NAMES.map((name) => `${OPENVIKING_MCP_TOOL_PREFIX}${name}`))

/** @param {string} name @returns {boolean} one of the five memory tools, under the name the model sees */
export function isOpenVikingMemoryToolName(name) {
  return OPENVIKING_MEMORY_TOOL_NAMES.includes(String(name ?? ''))
}

/** @param {string} name @returns {boolean} any tool of the plugin's MCP server, admitted or not */
export function isOpenVikingToolName(name) {
  return String(name ?? '').startsWith(OPENVIKING_MCP_TOOL_PREFIX)
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
  /** @param {string} base */
  const known = (base) => {
    const current = Object.hasOwn(RETIRED_MCP_TOOL_NAMES, base) ? RETIRED_MCP_TOOL_NAMES[/** @type {keyof typeof RETIRED_MCP_TOOL_NAMES} */ (base)] : base
    return MCP_TOOL_BASE_NAMES.includes(current) ? current : null
  }
  if (text.startsWith(MCP_TOOL_PREFIX)) return known(text.slice(MCP_TOOL_PREFIX.length))
  if (text.startsWith('evimed_')) return known(text.slice('evimed_'.length))
  return known(text)
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

/**
 * Kernel tools this composition mounts, as distinct from the ones we register.
 *
 * Hidden knowledge: this list is a literal rather than something derived from
 * the preset, and that is deliberate. The preset names *plugin packages*
 * (`@deepseek-ai/dsh-tool-fs`); the tools those packages register are a
 * different vocabulary, and deriving one from the other would be a guess
 * wearing the costume of a check. It lived in `scripts/dev/vendor-community-
 * skills.mjs` while community intake was the only thing that needed it. Method
 * distillation needs the same closed set — a learned method that instructs the
 * model to call an unmounted tool degrades the run silently, exactly the
 * failure the intake check exists to prevent — so it moved here, where both
 * callers read one definition.
 */
export const KERNEL_MOUNTED_TOOL_NAMES = Object.freeze([
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'list', 'skill', 'task',
  'fs_read', 'fs_write', 'fs_edit', 'fs_search', 'job_run', 'job_status',
  // `workflow` and the subagent-control tools left with their rows
  // (2026-09-18): a method telling a run to call one would degrade it.
  'ask_user',
  // The kernel's own pieces for general multi-step work, mounted 2026-10-12:
  // the step list, the one-shot sub-agent, the file hand-over, and the
  // question tool under the name the kernel registers it by.
  'todo_write', 'subagent', 'present', 'ask_user_question',
])

/**
 * The tools that are the platform's own choreography of a run, not the person's work: planning, delegating and awaiting, the
 * delivery submission, the package check, the revision and rendering helpers, the capsule and screening and review helpers (every
 * socket tool, and the ones retired but still in old transcripts), and the kernel's step list, question tool, sub-agent and file
 * hand-over. A routine is what the work did, so a trajectory digest (`trajectoryDigest.mjs`) removes these in code before a model
 * sees the run's tool order; they were left to a sentence in the distillation prompt until 2026-10-23, and the learned methods of
 * the one account that taught the platform were all about submit, anchor and receipt.
 *
 * A literal built from the two closed lists above and the kernel's own names; a tool added to either list is choreography by
 * default, which is the safe side: a missing name leaks a step into a lesson, an extra one only hides it.
 */
export const PLATFORM_CHOREOGRAPHY_TOOL_NAMES = Object.freeze([...new Set([
  ...SOCKET_TOOL_NAME_LIST,
  ...Object.values(RETIRED_SOCKET_TOOL_NAMES),
  'todo_write', 'todo', 'present', 'ask_user', 'ask_user_question', 'ask-user', 'subagent', 'task',
])])

/** @param {string} name @returns {boolean} */
export function isPlatformChoreographyTool(name) {
  return PLATFORM_CHOREOGRAPHY_TOOL_NAMES.includes(String(name ?? ''))
}

/**
 * Every tool name a skill body may legally call: the kernel's plus ours.
 * MCP tools are not here because a skill body calls them by their prefixed
 * model-visible name, which `isMcpToolName` already recognises.
 */
export const MOUNTED_TOOL_NAMES = Object.freeze([
  ...KERNEL_MOUNTED_TOOL_NAMES,
  ...SOCKET_TOOL_NAME_LIST,
])

/**
 * Identifier-shaped call sites in a skill body: `some_tool(`, in prose or in a
 * fence. Two-part snake_case only — a single lowercase word followed by `(` is
 * far more often ordinary prose or shell than a tool call, and flagging those
 * would bury the real finding.
 */
const TOOL_CALL_PATTERN = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(/g

/**
 * Distinct snake_case call sites a skill body names.
 * @param {string} body
 * @returns {string[]}
 */
export function referencedToolNames(body) {
  const source = String(body ?? '')
  return [...new Set([...source.matchAll(TOOL_CALL_PATTERN)].map((match) => match[1]))]
}

/**
 * The call sites in this body that this composition does not mount.
 *
 * `extra` is for a skill that legitimately brings its own tools with it — the
 * community intake path passes a source's `requiresTools`. A method never has
 * any: it is text mounted into a run whose tool surface is already fixed.
 * @param {string} body
 * @param {readonly string[]} [extra]
 * @returns {string[]}
 */
export function unmountedToolReferences(body, extra = []) {
  const allowed = new Set([...MOUNTED_TOOL_NAMES, ...extra])
  return referencedToolNames(body).filter((tool) => !allowed.has(tool) && !isMcpToolName(tool))
}
