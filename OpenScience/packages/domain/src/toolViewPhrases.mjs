/**
 * What one tool call says in a conversation: a Chinese verb phrase and the
 * thing it was about.
 *
 * Hidden knowledge: this is not `narration.mjs` a second time. Narration
 * renders a finished sentence for a ledger, from a table of functions with
 * branches in them (「读摘要：12 篇 PubMed 记录」). A conversation row is drawn
 * inside the kernel's page, where **no function of ours can travel** — the
 * frame bodies reach the browser as serialized text and may import nothing, so
 * the only thing that crosses is data (`FRAME_VOCABULARY`). So the row's words
 * are a table: a verb, and the argument keys its subject may be read from, in
 * the order they are tried.
 *
 * Why this table exists at all: a running conversation showed
 * `mcp__evimed__drug_label_search` and `Bash · Count competitor aliases…` —
 * the tool's wire name and the model's English note, on the screen a clinician
 * watches while the work happens (融合方案 §8.2, appendix B §3.1 calls it the
 * least medical-looking screen in the product). The row now reads
 * 「检索说明书 · 玛仕度肽」, and the name, the arguments and the raw result stay
 * one tab away in 「运行」.
 *
 * The keys are derived, never hand-listed: `toolViewPhraseTable()` walks
 * `MCP_TOOL_BASE_NAMES` and `KERNEL_TOOL_VIEW_NAMES`, and `PHRASES` is checked
 * against them by `packages/domain/test/toolViewPhrases.test.mjs` — a tool
 * added to `toolNames.mjs` without a phrase here is a red test, not a row that
 * silently falls back to its wire name in production.
 *
 * Three rules the entries follow, from §5.10 (文案):
 *
 *  - The verb says what a researcher did, never what the platform did: 检索,
 *    读, 核对, 编译 — not 调用, 请求, 网关.
 *  - The subject is the researcher's own words (a query, a drug, a term), read
 *    from the call's arguments. Never a path, an id, a code or a tool name.
 *  - A URL subject is shown as its host and nothing else (`subjectKind:
 *    'host'`): 「读网页 · pubmed.ncbi.nlm.nih.gov」. A full address in a
 *    conversation body is machinery, and a long one pushes the verb off the
 *    row.
 *
 * @module @evimed/domain/src/toolViewPhrases
 */

import { MCP_TOOL_BASE_NAMES, mcpToolName } from './toolNames.mjs'

/**
 * Kernel-mounted tools whose conversation row this product draws itself.
 *
 * Only `bash` today. It is the one kernel tool a research run calls in the
 * open — computing a number, converting a table, driving a script the run
 * wrote — and the kernel's own row for it is the command and its output, in
 * whatever language the model wrote them. The others a run touches (`read`,
 * `write`, `edit`, `glob`, `grep`) are file work the kernel already draws as a
 * path, and a path is not something a reader acts on; they keep the kernel's
 * rows.
 *
 * A name here is a TAKEOVER of an entry the kernel ships (`SHIPPED_TOOL_VIEW_KEYS`
 * in `runtimeUiSlots.mjs`), so the frame registers it below the shipped one.
 */
export const KERNEL_TOOL_VIEW_NAMES = /** @type {readonly string[]} */ (Object.freeze(['bash']))

/**
 * @typedef {object} ToolViewPhrase
 * @property {string} verb        the Chinese verb phrase, alone on the row when nothing names a subject
 * @property {readonly string[]} subject argument keys tried in order for the subject
 * @property {'text' | 'host'} [subjectKind] how the subject is read; `host` keeps only a URL's host
 */

/** @param {string} verb @param {readonly string[]} [subject] @param {'text' | 'host'} [subjectKind] @returns {ToolViewPhrase} */
function phrase(verb, subject = [], subjectKind = 'text') {
  return Object.freeze({ verb, subject: Object.freeze([...subject]), subjectKind })
}

/**
 * The words, by bare tool name (an MCP tool's published name, or a kernel
 * tool's own). Order follows `MCP_TOOL_BASE_NAMES` so the two read side by
 * side.
 *
 * @type {Readonly<Record<string, ToolViewPhrase>>}
 */
const PHRASES = Object.freeze({
  // retrieval
  literature_search: phrase('检索文献', ['query']),
  reference_list: phrase('查参考文献', ['identifier', 'doi', 'pmid', 'query']),
  guideline_search: phrase('检索指南', ['query']),
  clinical_trial_search: phrase('检索临床试验', ['query']),
  patent_search: phrase('检索专利', ['query']),
  biomedical_source_search: phrase('检索生物医学来源', ['query']),
  // full text and pages
  open_access_full_text: phrase('取全文', ['identifier', 'doi', 'pmid']),
  web_read: phrase('读网页', ['url'], 'host'),
  web_search: phrase('检索网页', ['query']),
  // claim work over preserved sources
  locate_quote: phrase('核对引文', ['quote']),
  // measured visibility
  geo_visibility_probe: phrase('测 AI 可见度', ['question', 'query', 'brand']),
  geo_read: phrase('读取 GEO 数据'),
  geo_write: phrase('写入 GEO 数据'),
  social_posts_search: phrase('采集社媒真实问法', ['query']),
  // pharmacy data
  drug_label_search: phrase('检索说明书', ['drug', 'query']),
  pharmacy_reference_search: phrase('查药学参考', ['query']),
  adr_case_query: phrase('查不良反应个例', ['drug', 'query']),
  adr_signal_analysis: phrase('做不良反应信号分析', ['drug', 'query']),
  drug_term_normalize: phrase('规范药物术语', ['term', 'terms']),
  // deterministic compilation
  offlabel_evidence_packet: phrase('编写超说明书证据包'),
  comprehensive_drug_evaluation: phrase('编写药品综合评价'),
  drug_selection_evaluation: phrase('编写药品遴选评价'),
  // managed jobs (specialist engines)
  meta_analysis: phrase('做 Meta 分析'),
  mendelian_randomization: phrase('做孟德尔随机化分析'),
  bibliometric_analysis: phrase('做文献计量分析'),
  research_topic_selection: phrase('做科研选题分析'),
  peer_review: phrase('做论文审稿'),
  drug_safety_analysis: phrase('做药物安全分析'),
  // first-party science connectors
  search_papers: phrase('检索论文', ['query']),
  search_biomedical_records: phrase('检索生物医学记录', ['query']),
  search_materials: phrase('检索材料数据', ['formula', 'query']),
  get_fred_series: phrase('取经济时间序列'),
  get_space_weather_alerts: phrase('查空间天气预警'),
  get_weather: phrase('查天气', ['location', 'city']),
  get_usgs_water_data: phrase('查水文数据'),
  // local tools
  data_source_catalog: phrase('查看可用数据源'),
  evidence_deduplicate: phrase('给证据去重'),
  term_normalize: phrase('规范术语', ['term', 'terms']),
  health: phrase('检查数据服务状态'),
  // the researcher's own documents, and the feed
  kb_search: phrase('检索知识库', ['query']),
  frontier_search: phrase('查前沿动态', ['q', 'query']),
  // the kernel's own
  bash: phrase('运行脚本'),
})

/**
 * Every tool whose conversation row this product draws, by the name the row is
 * keyed on: an MCP tool by its model-visible name (`mcp__evimed__…`), a kernel
 * tool by its own.
 *
 * Derived from `toolNames.mjs`. A name whose phrase is missing is omitted
 * rather than given a guessed verb — the kernel's own row is a worse row, but
 * it is not a wrong sentence — and the domain test makes the omission
 * impossible to ship.
 *
 * @returns {Record<string, ToolViewPhrase & { shipped: boolean }>}
 */
export function toolViewPhraseTable() {
  /** @type {Record<string, ToolViewPhrase & { shipped: boolean }>} */
  const table = {}
  for (const base of MCP_TOOL_BASE_NAMES) {
    const entry = PHRASES[base]
    if (entry) table[mcpToolName(base)] = { ...entry, shipped: false }
  }
  for (const name of KERNEL_TOOL_VIEW_NAMES) {
    const entry = PHRASES[name]
    // `shipped` marks a key the kernel already draws, which a takeover must be
    // registered below (`occupy` refuses it otherwise).
    if (entry) table[name] = { ...entry, shipped: true }
  }
  return table
}

/** The bare names this table gives words to, for the completeness test. */
export const TOOL_VIEW_PHRASE_NAMES = /** @type {readonly string[]} */ (Object.freeze(Object.keys(PHRASES)))

/** One tool's words, by any spelling of its name, or null. @param {string} name @returns {ToolViewPhrase | null} */
export function toolViewPhrase(name) {
  const table = toolViewPhraseTable()
  const entry = table[String(name ?? '')]
  return entry ? Object.freeze({ verb: entry.verb, subject: entry.subject, subjectKind: entry.subjectKind }) : null
}
