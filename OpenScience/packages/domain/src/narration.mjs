/**
 * Deterministic narration.
 *
 * Hidden knowledge: what a tool call looks like to a clinician. The rule
 * (§23.3.6) is that narration never calls a model — a line of prose that costs
 * a model call is a line of prose that can be wrong, slow and expensive at the
 * same time. So this is a table from tool name and arguments to a verb phrase,
 * and an unknown tool falls through to "调用 {name}" and is counted rather than
 * guessed at.
 *
 * The product vocabulary rule applies here first: no session, subagent, preset
 * or MCP appears in any string this module produces.
 */

import { MCP_TOOL_PREFIX, SOCKET_TOOL_NAMES, mcpToolBaseName } from './toolNames.mjs'
import { contractKindLabel } from './contractKinds.mjs'

/** @param {unknown} value @param {number} [max] @returns {string} */
function excerpt(value, max = 40) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** @param {unknown} value @returns {number | null} */
function count(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    for (const key of ['results', 'items', 'records', 'entries', 'hits']) {
      if (Array.isArray(record[key])) return /** @type {unknown[]} */ (record[key]).length
    }
    if (typeof record.count === 'number') return record.count
  }
  return null
}

/** @type {Readonly<Record<string, (args: Record<string, any>, result: any) => string>>} */
const MCP_NARRATION = Object.freeze({
  literature_search: (args, result) => withCount(`检索文献：「${excerpt(args.query)}」`, result),
  guideline_search: (args, result) => withCount(`检索指南：「${excerpt(args.query)}」`, result),
  clinical_trial_search: (args, result) => withCount(`检索临床试验：「${excerpt(args.query)}」`, result),
  patent_search: (args, result) => withCount(`检索专利：「${excerpt(args.query)}」`, result),
  biomedical_source_search: (args, result) => withCount(`检索生物医学来源：「${excerpt(args.query)}」`, result),
  web_search: (args, result) => withCount(`检索网页：「${excerpt(args.query ?? args.queries)}」`, result),
  open_access_full_text: (args) => `取全文：${excerpt(args.identifier ?? args.doi ?? args.url, 48)}`,
  official_page_fetch: (args) => `读官方页面：${excerpt(args.url, 48)}`,
  drug_label_search: (args, result) => withCount(`查说明书：${excerpt(args.drug ?? args.query)}`, result),
  pharmacy_reference_search: (args, result) => withCount(`查药学参考：${excerpt(args.query)}`, result),
  adr_case_query: (args, result) => withCount(`查不良反应个例：${excerpt(args.drug ?? args.query)}`, result),
  adr_signal_analysis: (args) => `做不良反应信号分析：${excerpt(args.drug ?? args.query)}`,
  drug_term_normalize: (args) => `规范药物术语：${excerpt(args.term ?? args.terms)}`,
  term_normalize: (args) => `规范术语：${excerpt(args.term ?? args.terms)}`,
  evidence_deduplicate: (args, result) => withCount('证据去重', result),
  data_source_catalog: () => '查看可用数据源',
  health: () => '检查数据服务状态',
  offlabel_evidence_packet: (args) => `编译超说明书证据包：${excerpt(args.action ?? '')}`,
  comprehensive_drug_evaluation: (args) => `编译药品综合评价：${excerpt(args.action ?? '')}`,
  drug_selection_evaluation: (args) => `编译药品遴选评价：${excerpt(args.action ?? '')}`,
  meta_analysis: (args) => jobPhrase('Meta 分析', args),
  mendelian_randomization: (args) => jobPhrase('孟德尔随机化', args),
  bibliometric_analysis: (args) => jobPhrase('文献计量分析', args),
  research_topic_selection: (args) => jobPhrase('科研选题分析', args),
  peer_review: (args) => jobPhrase('论文审稿', args),
  drug_safety_analysis: (args) => jobPhrase('药物安全分析', args),
})

/** @param {string} label @param {Record<string, any>} args @returns {string} */
function jobPhrase(label, args) {
  const action = String(args?.action ?? 'start')
  if (action === 'status') return `查看${label}进度`
  if (action === 'capabilities') return `查看${label}能力`
  return `启动${label}`
}

/** @param {string} phrase @param {any} result @returns {string} */
function withCount(phrase, result) {
  const n = count(result)
  return n == null ? phrase : `${phrase} → ${n} 条`
}

/** @type {Readonly<Record<string, (args: Record<string, any>, result: any) => string>>} */
const SOCKET_NARRATION = Object.freeze({
  [SOCKET_TOOL_NAMES.plan]: (args) => (args?.action === 'status' ? '查看计划进度' : '写下计划'),
  [SOCKET_TOOL_NAMES.delegate]: (args) => `分工给 ${excerpt(args?.capability, 32)}`,
  [SOCKET_TOOL_NAMES.submitDeliverable]: (args, result) => {
    const id = excerpt(args?.deliverableId, 32)
    if (!result || typeof result !== 'object') return `提交交付物 ${id}`
    const record = /** @type {Record<string, any>} */ (result)
    if (record.ok) return `提交交付物 ${id}：通过`
    const required = Array.isArray(record.issues) ? record.issues.filter((i) => i?.severity !== 'advisory' && i?.severity !== 'optional').length : 0
    return `提交交付物 ${id}：被退回（${required} 项必修）`
  },
  [SOCKET_TOOL_NAMES.completeRun]: (args) => (args?.partial ? '以部分交付结束' : '结束运行'),
  [SOCKET_TOOL_NAMES.capsuleRecall]: (args, result) => withCount(`回忆胶囊：「${excerpt(args?.query)}」`, result),
  [SOCKET_TOOL_NAMES.capsuleNote]: (args) => `记到胶囊：${excerpt(args?.content, 32)}`,
  [SOCKET_TOOL_NAMES.screenBatch]: (args, result) => withCount('批量筛选文献', result),
  [SOCKET_TOOL_NAMES.reviewRun]: () => '跨交付物审查',
})

/** @type {Readonly<Record<string, (args: Record<string, any>, result: any) => string>>} */
const FRAMEWORK_NARRATION = Object.freeze({
  read: (args) => `读取 ${excerpt(args?.path ?? args?.file_path, 48)}`,
  write: (args) => `写入 ${excerpt(args?.path ?? args?.file_path, 48)}`,
  edit: (args) => `修改 ${excerpt(args?.path ?? args?.file_path, 48)}`,
  glob: (args) => `查找文件 ${excerpt(args?.pattern, 32)}`,
  grep: (args) => `搜索内容 ${excerpt(args?.pattern, 32)}`,
  bash: (args) => `执行命令 ${excerpt(args?.command, 48)}`,
  skill: (args) => `加载技能 ${excerpt(args?.name ?? args?.skill, 32)}`,
  subagent: (args) => `分工给 ${excerpt(args?.capability ?? args?.label ?? '一个助手', 32)}`,
  workflow: () => '运行编排脚本',
  report: () => '回报结果',
})

/**
 * @param {string} toolName
 * @param {Record<string, any>} [args]
 * @param {any} [result]
 * @returns {{ text: string, known: boolean }}
 */
export function narrateToolCall(toolName, args = {}, result = undefined) {
  const name = String(toolName ?? '')
  const base = mcpToolBaseName(name)
  if (base && MCP_NARRATION[base]) return { text: MCP_NARRATION[base](args ?? {}, result), known: true }
  if (SOCKET_NARRATION[name]) return { text: SOCKET_NARRATION[name](args ?? {}, result), known: true }
  if (FRAMEWORK_NARRATION[name]) return { text: FRAMEWORK_NARRATION[name](args ?? {}, result), known: true }
  const display = name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name
  return { text: `调用 ${display || '未知工具'}`, known: false }
}

/**
 * Narration for the non-tool things that happen in a run.
 * @param {{ type: string } & Record<string, any>} event
 * @returns {{ text: string, known: boolean }}
 */
export function narrateRunEvent(event) {
  switch (event?.type) {
    case 'plan/updated':
      return { text: `计划已更新：${event.deliverableCount ?? 0} 件交付物`, known: true }
    case 'deliverable/accepted':
      return { text: `交付物「${event.title ?? event.deliverableId}」通过（${contractKindLabel(event.contractKind)}）`, known: true }
    case 'deliverable/rejected':
      return { text: `交付物「${event.title ?? event.deliverableId}」被退回`, known: true }
    case 'subagent/started':
      return { text: `分工开始：${event.capability ?? ''}`, known: true }
    case 'subagent/finished':
      return { text: `分工结束：${event.capability ?? ''}`, known: true }
    case 'compaction':
      return { text: `已压缩早期对话（${event.replaced ?? 0} 条）`, known: true }
    case 'budget/warning':
      return { text: '预算接近上限', known: true }
    case 'context/injected':
      return { text: `系统注入了上下文：${event.what ?? '题面'}`, known: true }
    default:
      return { text: `事件 ${event?.type ?? '未知'}`, known: false }
  }
}

/** Everything the narration table knows, for the snapshot test. */
export const NARRATED_TOOL_NAMES = Object.freeze([
  ...Object.keys(MCP_NARRATION).map((base) => `${MCP_TOOL_PREFIX}${base}`),
  ...Object.keys(SOCKET_NARRATION),
  ...Object.keys(FRAMEWORK_NARRATION),
])
