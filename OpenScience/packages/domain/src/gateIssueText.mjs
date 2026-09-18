/**
 * What a gate finding says to a clinician: a short Chinese title keyed by the
 * finding's identity, never by its sentence.
 *
 * Hidden knowledge: why this is keyed by `check` and `code` and not by the
 * message. The gate's messages are repair instructions written for the run —
 * 「claims[52].claim numeric fact 6 is not present in its direct support…」 —
 * and they are fed back to it verbatim, so a changed word is a changed
 * behaviour. They reached a Chinese-reading researcher's inbox as they were,
 * cut at 200 characters, and the web's grouping table matched eleven English
 * sentence shapes with regular expressions and showed the raw sentence for
 * everything else (2026-09-18 review, B §1f, §4e). A title keyed by the
 * finding's own identity is decided in code, once (principle 1), and survives
 * any rewording of the repair text; regular expressions over the prose are
 * exactly what principle 5 forbids.
 *
 * Three severities, and they are the reader's, not the gate's:
 *   - `safety` — clinical framing that could hurt somebody. Every check the
 *     clinical gate places in its safety tier, whatever it cost the run.
 *   - `must-fix` — a defect the reader cannot see for themselves: a quotation
 *     not in its source, a claim bound to nothing.
 *   - `advice` — everything else: said, never withheld on.
 *
 * `detail` is composed from the finding's parameters — which claim, which
 * file, which line — and never from its message. The message stays in the
 * record as `text` for old readers only.
 *
 * Zero dependencies beyond this package, like the rest of it: the browser and
 * the control plane read the same table.
 *
 * @module gateIssueText
 */

import { CLINICAL_CHECK_TIERS } from './clinicalEvidence.mjs'

/** The reader's three severities, most urgent first. */
export const GATE_ISSUE_SEVERITIES = Object.freeze(['safety', 'must-fix', 'advice'])

/** @typedef {'safety'|'must-fix'|'advice'} GateIssueSeverity */

/**
 * One title per check id the domain can raise (`GATE_CHECK_IDS`). A test walks
 * that list and fails on a check with no title here, so a new check cannot
 * reach a reader as a bare fallback. Each title names the defect and, where
 * it helps, what to look at; none is longer than twenty characters.
 * @type {Readonly<Record<string, string>>}
 */
export const GATE_CHECK_TITLES_ZH = Object.freeze({
  // The clinical evidence package (`clinicalEvidenceCheckIds`).
  'emergency-trigger-conditioned': '呼救条件不应以用药反应为准',
  'appraisal-declaration': '声明的质量评价未实际执行',
  'citation-closure': '引用编号与参考文献不对应',
  'attributed-stance': '所称来源立场缺少引文支撑',
  'regulatory-article': '条款级引用缺少官方原文',
  'clinical-safety-rules': '命中临床安全规则，请核对',
  'citation-integrity': '引用编号或文献条目有误',
  'manuscript-register': '报告行文夹杂过程性表述',
  'synthesized-claim': '综合结论的多源支撑不完整',
  'report-present': '缺少报告正文',
  'report-sections': '报告缺少必要的分析章节',
  'practical-section': '缺少临床实践要点章节',
  'deep-research-sections': '报告缺少规定的学术章节',
  'reference-list-order': '参考文献应在实践要点之后',
  'visible-claim-marker': '正文暴露了内部主张编号',
  'operational-failure-prose': '报告写入了检索失败过程',
  'runtime-leakage': '报告写入了检索或工具过程',
  'claim-marker-format': '主张标记格式不正确',
  'internal-api-citation': '引用了内部接口地址',
  'exclusive-safety': '把有限建议写成了绝对安全',
  'matrix-present': '缺少证据矩阵',
  'matrix-schema': '证据矩阵结构不符合要求',
  'claim-schema': '主张条目字段不完整',
  'derived-claim-inputs': '推导结论未列明依据主张',
  'claim-access-level': '主张未注明原文阅读深度',
  'claim-reference-number': '主张的文献编号无法对应',
  'claim-support-quote': '主张缺少原文引文',
  'claim-emergency-support': '急救建议未见于所引原文',
  'claim-numeric-support': '数值未出现在引文中',
  'claim-artifact-path': '引文的来源文件未被保存',
  'claim-quote-verbatim': '引文在所引来源中找不到原句',
  'claim-source-url': '来源链接无效',
  'report-claim-unresolved': '报告引用的主张不在矩阵中',
  'matrix-claim-uncited': '矩阵主张未在报告中引用',
  'derived-claim-grounding': '推导所依据的主张不存在',
  'derived-report-label': '推导结果未标注〔推导〕',
  'report-number-unanchored': '报告数值缺少引用出处',
  'report-number-unsupported': '报告数值未见于所引证据',
  'record-identifier-leak': '交付物含可识别的记录编号',
  'practical-derived-claim': '实践建议基于推导而非实测',
  'practical-claim-anchor': '实践建议缺少证据引用',
  'reference-list-duplication': '同一文献被重复编号',
  'reference-number-unresolved': '引用编号缺少文献条目',
  'claim-inline-citation': '主张未配正文编号引用',
  'advisory-notes': '写作层面的改进建议',
  // The contract registry and the per-kind contract modules.
  'required-output': '缺少必需的交付文件',
  'deliverable-json-parse': '交付文件不是有效的 JSON',
  'structured-output': '结构化产物格式有误',
  'clinical-content-trigger': '非临床交付物含临床内容',
  'clinical-high-risk-entity': '提及高警示药品，请核对',
  'topic-portfolio-schema': '选题组合结构不完整',
  'topic-evidence-lineage': '选题证据来源无法追溯',
  'topic-study-plan': '研究设计要素尚未确定',
  'topic-research-context': '研究背景前后不一致',
  'topic-publication-status': '所用证据的发表状态未核实',
  'source-understanding-schema': '文献解读结果格式有误',
  'method-candidate-schema': '方法候选格式有误',
  'method-relations-schema': '方法关系格式有误',
  'method-skill-rules': '方法技能文件不合规',
  'appraisal-json-parse': '评价表不是有效的 JSON',
  'appraisal-document-shape': '评价表结构不完整',
  'appraisal-study-identifier': '研究标识缺失或有误',
  'appraisal-study-design': '研究设计类型未说明',
  'appraisal-domain-rating': '偏倚风险各领域评级不完整',
  'appraisal-study-coverage': '纳入研究未全部评价',
  'appraisal-body-certainty': '证据确定性结论不完整',
  'appraisal-downgrade-domain': '降级理由不完整',
  'appraisal-certainty-arithmetic': '证据等级与升降级不相符',
  'appraisal-citation-coverage': '评价所引文献未入台账',
  'appraisal-table-rendered': '评价表未完整呈现',
  'dataset-profile-parse': '数据概况文件无法读取',
  'dataset-number-provenance': '报告数值无法追溯到数据',
  'manuscript-scratch-file': '交付了修改前的草稿文件',
  'grant-requirement-quote': '申报要求未引用原文',
  'grant-requirement-coverage': '申报要求未全部覆盖',
  'geo-measurement': '可见度测量记录不完整',
  'geo-probe-host': '正文含探测主机信息',
})

/**
 * Titles for findings that carry no check id, and for the platform's own
 * notices about a run. A finding with a check is titled by the check; these
 * are what a code alone can say.
 * @type {Readonly<Record<string, string>>}
 */
export const GATE_CODE_TITLES_ZH = Object.freeze({
  // Contract registry findings raised without a check.
  deliverable_rejected: '交付文件未通过格式校验',
  required_output_missing: '缺少必需的交付文件',
  required_output_empty: '交付文件是空的',
  contract_kind_unknown: '交付物类型无法识别',
  deliverable_json_unparseable: '交付文件不是有效的 JSON',
  deliverable_run_receipt_shape: '引擎运行记录格式有误',
  deliverable_run_receipt_unbound: '引擎运行记录缺少任务号',
  deliverable_run_artifact_missing: '运行记录所列文件缺失',
  deliverable_table_shape: '数据表列数前后不一致',
  deliverable_run_degraded: '分析引擎有步骤未完成',
  runtime_leakage: '报告写入了检索或工具过程',
  citation_integrity: '引用编号或文献条目有误',
  clinical_content_without_clinical_contract: '非临床交付物含临床内容',
  clinical_high_risk_entity_notice: '提及高警示药品，请核对',
  clinical_safety_rule_notice: '命中临床安全规则，请核对',
  clinical_safety_rule: '命中临床安全规则，请核对',
  clinical_evidence_issue: '证据包有一处依据需核对',
  clinical_evidence_notice: '证据包的改进建议',
  geo_surface_undeclared: '可见度测量记录不完整',
  geo_probe_log_unreadable: '可见度测量记录无法读取',
  geo_measurement_absent: '缺少可见度测量记录',
  geo_failed_round_counted: '可见度测量含失败轮次',
  geo_denominator_overstated: '可见度测量的分母偏大',
  geo_probe_host_in_prose: '正文含探测主机信息',
  grant_requirement_unquoted: '申报要求未引用原文',
  grant_requirement_unaudited: '申报要求未全部覆盖',
  topic_portfolio_invalid: '选题组合需要补充',
  topic_portfolio_notice: '选题组合的改进建议',
  manuscript_scratch_file_delivered: '交付了修改前的草稿文件',
  manuscript_claims_unreadable: '主张文件无法解析',
  manuscript_claim_unresolved: '正文主张不在主张表中',
  manuscript_claim_uncited: '主张未在正文中引用',
  manuscript_derived_unmarked: '推导结果未标注〔推导〕',
  manuscript_ledger_schema: '引文台账结构有误',
  manuscript_citation_unresolved: '正文引用没有对应文献',
  manuscript_reference_uncited: '文献未在正文中引用',
  manuscript_claim_unledgered: '主张未收入引文台账',
  manuscript_backstage_in_section: '正文夹杂修改说明',
  // Run-side tool refusals a run can surface as notices.
  deliverable_unknown: '计划中没有这件交付物',
  deliverable_dependency_pending: '依赖的交付物尚未通过',
  deliverable_attempts_spent: '这件交付物的提交次数已用完',
  deliverable_not_owned: '子任务提交了不属于它的交付物',
  run_incomplete: '运行没有完成全部交付',
  plan_missing_clarifications: '研究计划缺少必要说明',
  plan_invalid: '研究计划不完整',
  plan_absent: '没有研究计划',
  capability_unknown: '计划引用了不存在的能力',
  capability_inputs_invalid: '能力的输入参数有误',
  capability_background_only: '该能力仅供后台流程使用',
  contract_kind_ambiguous: '交付物类型不明确',
  attempt_limit_reached: '提交次数已达上限',
  budget_exhausted: '运行预算已用完',
  path_guard_denied: '写入位置被拒绝',
  subagent_failed: '子任务没有完成',
  subagent_start_failed: '子任务未能启动',
  capsule_unavailable: '方法胶囊暂不可用',
  review_unavailable: '复核服务暂不可用',
  // The server-side delivery gate's findings, by the verdict they belong to.
  specialist_required_skill_missing: '运行时未载入能力方法',
  specialist_citation_invalid: '有引用链接无法打开',
  specialist_citation_integrity_failed: '引用编号或文献条目有误',
  specialist_cited_source_unrecorded: '引用来源未记入证据快照',
  specialist_evidence_snapshot_missing: '缺少证据快照文件',
  specialist_evidence_snapshot_invalid: '证据快照文件格式有误',
  specialist_evidence_snapshot_empty: '证据快照未记录任何来源',
  specialist_evidence_traceability_failed: '有引文的来源无法追溯',
  specialist_evidence_provenance_failed: '引用了本次未保存的来源',
  specialist_evidence_integrity_failed: '保存后的来源文件被改动',
  specialist_delegated_evidence_read: '原文由子任务转述，非原句',
  specialist_required_output_missing: '缺少必需的交付文件',
  specialist_required_output_stale: '交付文件不是本次生成的',
  specialist_receipt_digest_mismatch: '回执之后交付文件被改动',
  specialist_deliverable_not_accepted: '交付物未通过验收',
  specialist_evidence_repair_failed: '修订请求未能送达运行',
  specialist_evidence_repair_snapshot_failed: '修订前未能保存已通过版本',
  citation_plain_http: '引用使用了未加密的链接',
  // A run-side gate's advisory note on an accepted package that its own gate
  // run no longer names (the receipt keeps only the sentence).
  gate_advisory: '运行内核验留下的建议',
  gate_notice: '另有核验提示',
  // The platform's own notices about a run, named where they are raised.
  run_stall_observed: '一段时间没有可观测的进展',
  run_unverified_delivery: '文件按「未核验」交付',
  run_brief_lost: '未按原始题面核对药品范围',
  run_projection_unreadable: '运行自述文件无法读取',
  run_unattributed: '无法确认交付是否通过验收',
  run_deliverable_never_submitted: '交付物已写好但未提交核验',
  run_deliverable_rejected_every_time: '交付物多次提交均未通过',
  run_deliverable_dropped: '计划中的交付物没有交付',
  run_planned_none_accepted: '计划的交付物都未通过核验',
  run_adopted_unchecked: '未匹配交付契约，未做核验',
  run_legacy_unattributed: '旧运行记录无法对应本次输入',
  run_repair_not_dispatched: '修订请求未能送达运行',
  run_report_rewritten: '修订时整篇重写了报告',
  run_report_shrunk: '修订后报告明显变短',
  run_receipt_mismatch: '回执之后交付文件被改动',
  run_revision_not_accepted: '修订版未通过核验',
  run_files_changed_after_receipt: '回执之后又改动了交付文件',
  run_resubmit_not_dispatched: '补交回执的请求未能送达',
  run_partial_read: '部分子任务的记录无法读取',
  run_side_degraded: '运行记录有缺口',
  run_side_notice: '运行过程的技术提示',
  memory_extraction_empty: '本次对话没有抽取到记忆',
  memory_pending: '新记忆暂缓生效',
  memory_conflicts: '对话改写了你确认过的记忆',
})

/** What a finding with no known identity is called, by severity. */
export const GATE_FALLBACK_TITLES_ZH = Object.freeze({
  safety: '涉及临床安全，请核对',
  'must-fix': '有一处依据需要核对',
  advice: '另有技术提示',
})

/**
 * The reader's severity for one finding.
 *
 * A severity already in the reader's vocabulary is kept. Otherwise a check the
 * clinical gate places in its safety tier is `safety` whatever the gate did
 * with it — a pharmacist-authored rule that fired on a drug evaluation is a
 * safety notice even where it is only advisory to the run — and the gate's own
 * `required` is `must-fix`; anything else is advice.
 * @param {{ severity?: unknown, check?: unknown }} issue
 * @returns {GateIssueSeverity}
 */
export function gateIssueSeverity(issue) {
  const given = String(issue?.severity ?? '')
  if (given === 'safety' || given === 'must-fix' || given === 'advice') return given
  if (typeof issue?.check === 'string' && CLINICAL_CHECK_TIERS[issue.check] === 'safety') return 'safety'
  return given === 'required' ? 'must-fix' : 'advice'
}

/**
 * The identifiers a finding's own text carries, read as formats rather than
 * as language: a matrix index (`claims[52]`), a claim id (`CLM-003`), a line
 * number in the gate's own line template. Used only to fill `detail` when the
 * raising code passed no parameter — never to decide anything.
 * @param {unknown} message
 * @returns {{ claimIndex?: number, claimId?: string, line?: number }}
 */
export function gateIssueRefs(message) {
  const text = String(message ?? '')
  /** @type {{ claimIndex?: number, claimId?: string, line?: number }} */
  const refs = {}
  const index = /\bclaims\[(\d{1,4})\]/.exec(text)
  if (index) refs.claimIndex = Number(index[1])
  const id = /\bCLM-\d{3,6}\b/.exec(text)
  if (id) refs.claimId = id[0]
  const line = /\bline (\d{1,6})\b/.exec(text) ?? /第 ?(\d{1,6}) ?行/.exec(text)
  if (line) refs.line = Number(line[1])
  return refs
}

/** @param {unknown} value */
function fileName(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const parts = text.split('/')
  return parts[parts.length - 1] ?? text
}

/**
 * The finding's parameters in Chinese: which claim, which file, which line.
 * Empty when it carries none; never a translation of its message.
 * @param {{ claimId?: unknown, file?: unknown, path?: unknown, line?: unknown, message?: unknown, text?: unknown }} issue
 * @returns {string}
 */
export function gateIssueDetail(issue) {
  const refs = gateIssueRefs(issue?.message ?? issue?.text)
  const parts = []
  const claimId = typeof issue?.claimId === 'string' && issue.claimId ? issue.claimId : refs.claimId
  if (claimId) parts.push(`主张 ${claimId}`)
  else if (Number.isSafeInteger(refs.claimIndex)) parts.push(`证据矩阵第 ${Number(refs.claimIndex) + 1} 条主张`)
  const file = fileName(issue?.file ?? issue?.path)
  const line = Number.isSafeInteger(issue?.line) && Number(issue?.line) > 0 ? Number(issue?.line) : refs.line
  if (file && line) parts.push(`${file} 第 ${line} 行`)
  else if (file) parts.push(`文件 ${file}`)
  else if (line) parts.push(`报告第 ${line} 行`)
  return parts.join('，')
}

/**
 * One finding, described for a reader.
 *
 * Accepts a `GateIssue` (`{code, message, severity, check?, path?, line?}`),
 * a stored run notice (`{code, check?, severity, text, claimId?, file?,
 * line?, detail?}`), or anything shaped like either. `detail` passed in is
 * kept only when it is the platform's own Chinese sentence (it contains CJK);
 * an English one is a message, and messages are not shown.
 *
 * @param {Record<string, any> | null | undefined} issue
 * @returns {{ code: string, check?: string, severity: GateIssueSeverity, title: string, detail?: string }}
 */
export function describeGateIssue(issue) {
  const code = String(issue?.code ?? '').trim() || 'unnamed_issue'
  const check = typeof issue?.check === 'string' && issue.check.trim() ? issue.check.trim() : undefined
  const severity = gateIssueSeverity(issue ?? {})
  const title = (check && GATE_CHECK_TITLES_ZH[check]) || GATE_CODE_TITLES_ZH[code] || GATE_FALLBACK_TITLES_ZH[severity]
  const given = typeof issue?.detail === 'string' && /[㐀-鿿]/.test(issue.detail) ? issue.detail.trim() : ''
  const detail = given || gateIssueDetail(issue ?? {})
  return { code, ...(check ? { check } : {}), severity, title, ...(detail ? { detail } : {}) }
}

/**
 * Counts and groups over a run's notices, for a body composed of numbers and
 * titles rather than sentences (the inbox, a run row's one-line summary).
 * Groups keep the most urgent first, then the largest.
 * @param {readonly Record<string, any>[]} notices described notices (`severity`, `title`)
 * @returns {{ safety: number, mustFix: number, advice: number, groups: { title: string, severity: GateIssueSeverity, count: number }[] }}
 */
export function summarizeGateNotices(notices) {
  const counts = { safety: 0, mustFix: 0, advice: 0 }
  /** @type {Map<string, { title: string, severity: GateIssueSeverity, count: number }>} */
  const groups = new Map()
  for (const notice of Array.isArray(notices) ? notices : []) {
    if (!notice || typeof notice !== 'object') continue
    const severity = gateIssueSeverity(notice)
    if (severity === 'safety') counts.safety += 1
    else if (severity === 'must-fix') counts.mustFix += 1
    else counts.advice += 1
    const title = String(notice.title ?? '') || GATE_FALLBACK_TITLES_ZH[severity]
    const key = `${severity} ${title}`
    const group = groups.get(key) ?? { title, severity, count: 0 }
    group.count += 1
    groups.set(key, group)
  }
  const rank = (/** @type {GateIssueSeverity} */ severity) => GATE_ISSUE_SEVERITIES.indexOf(severity)
  return {
    ...counts,
    groups: [...groups.values()].sort((left, right) => rank(left.severity) - rank(right.severity) || right.count - left.count),
  }
}
