/**
 * The cross-boundary error-code registry.
 *
 * Hidden knowledge: which failures a run can be asked to repair, which are the
 * source's fault and which are the run's own. Three subsystems used to answer
 * that question separately — the ledger, the preflight and the delivery gate —
 * and drifted apart three times. The classification now lives here, and the
 * ledger, the socket's run policy, the adapter and the browser all read it.
 *
 * §14 rule 17: every mapping function must land an unknown input on an
 * explicit `*_unknown` code and count it, never on "succeeded" or "no progress".
 */

// fix: a receipt naming the wrong path, a citation whose source was never
// recorded, a preserved file that was edited. The run has already done the
// work — the report and every deliverable are on disk — and the repair loop
// hands the specific issues back rather than regenerating anything.
//
// This used to name one code, so a package rejected for provenance was thrown
// away while an otherwise identical package rejected for traceability was
// repaired and delivered. Two production runs died that way with complete
// reports of 42 and 40 kB. The category is "the package is complete and the
// issue is actionable inside it", not any single member of it.
export const repairableEvidencePackageErrorCodes = new Set([
  "specialist_evidence_traceability_failed",
  "specialist_evidence_provenance_failed",
  "specialist_evidence_integrity_failed",
  "specialist_cited_source_unrecorded",
  "specialist_citation_invalid",
  "specialist_evidence_snapshot_missing",
  "specialist_evidence_snapshot_invalid",
  "specialist_evidence_snapshot_empty",
  // The delivery gate's own named defects (clinicalEvidencePackageErrorCode).
  // Each names one element of a finished package — a line, a number, a claim,
  // a reference — so each is repaired in place like the codes above it, never
  // regenerated. A code added there and forgotten here would silently turn a
  // repairable package into a discarded one, which is the failure this set was
  // introduced to stop.
  "practical_emergency_trigger_conditioned_on_medication_response",
  "regulatory_article_without_official_source",
  "specialist_screening_ledger_mismatch",
  "declared-appraisal-must-execute",
  // The question-coverage ledger. A package missing it is otherwise complete —
  // the report, the matrix, the search log and every citation artifact are on
  // disk — and the ledger is written from them, so this is the one missing
  // deliverable the run can supply without redoing any work. It is therefore
  // repaired rather than discarded, unlike a missing report.
  "specialist_question_coverage_missing",
  "specialist_question_coverage_invalid",
  "specialist_question_coverage_unsupported",
  "specialist_question_coverage_gap_overstated",
  "specialist_question_coverage_understated",
]);

// A source the run could not read is a limitation to report, not a defect in
// the run. These codes all mean "this document was not obtainable", which the
// skill already instructs the agent to record in failedSources and work around.
export const recoverableEvidenceSourceErrorCodes = new Set([
  "full_text_not_available",
  "full_text_upstream_unavailable",
  "official_page_upstream_unavailable",
  // The deployment simply has no Unpaywall address configured, or no gateway to
  // reach it through. That is host configuration, and failing the run for it
  // punished an agent that had handled the gap exactly as instructed: it
  // recorded the three unreadable sources, declared the limitation, and wrote
  // every required deliverable.
  "public_source_unpaywall_credential_missing",
  "public_source_managed_gateway_required",
  "public_source_managed_credential_required",
  "public_source_pdf_not_open_access",
  "public_source_gateway_upstream_unavailable",
  // An upstream that was down, slow, or rate-limiting. A search hitting one of
  // these has not found nothing — it has failed to ask, and the run goes on to
  // ask elsewhere. HTTP 502 from a single public source failed an otherwise
  // complete run.
  "public_source_http_error",
  "public_source_unavailable",
  "public_source_invalid_response",
  "public_source_response_too_large",
  "public_source_pdf_unavailable",
  "public_source_pdf_too_large",
  "public_source_gateway_upstream_error",
  "public_source_gateway_unavailable",
  "public_source_gateway_timeout",
  "public_source_gateway_rate_limited",
  "public_source_gateway_response_invalid",
  "public_source_gateway_response_too_large",
  // The specialist adapter boundary — the Python agents this platform fronts.
  // These mean the downstream service was unreachable, erroring, or absent from
  // this deployment, which is the same fact as an unreachable public source: a
  // limitation to record, not a defect in the run. A pharmacovigilance run that
  // had written both of its declared deliverables was failed here, because no
  // adapter code was classified at all and the default is to fail.
  "adapter_unavailable",
  "adapter_http_error",
  "adapter_circuit_open",
  "adapter_unconfigured",
  "adapter_workload_token_unavailable",
  // The open-web gateway's own codes. Only the MCP tool's codes were classified
  // when this was built; the gateway module was never scanned, so the deployment
  // lacking a search backend, or the aggregator being down, killed runs that had
  // found their evidence elsewhere.
  "web_search_gateway_failed",
  "web_search_gateway_token_missing",
  // The long-running specialist workers (meta-analysis, the six Python agents)
  // and the science connectors. Absent, unconfigured, or not running is this
  // deployment's state, not the run's mistake: it records that the analysis
  // could not be produced and works with what it has.
  "meta_agent_unavailable",
  "meta_agent_unconfigured",
  "meta_agent_worker_unavailable",
  "meta_agent_python_unavailable",
  "meta_model_config_unavailable",
  "specialist_agent_unavailable",
  "specialist_agent_unconfigured",
  "specialist_worker_unavailable",
  "specialist_python_unavailable",
  "specialist_model_config_unavailable",
  "pharmacy_reference_unconfigured",
  "evimed_evidence_invalid_response",
  // The open web is the one channel that is expected to be partly unreachable:
  // engines rate-limit, serve CAPTCHAs, and suspend themselves, and a
  // deployment may have no metasearch backend at all. Every one of these means
  // the run failed to ask, not that it found nothing — it carries on with the
  // bibliographic channels, which is precisely what the skill tells it to do.
  // Adding the tool without classifying its codes failed a run that had
  // produced all ten deliverables, six full texts, and sixty-seven works.
  "web_search_unconfigured",
  "web_search_unavailable",
  "web_search_rate_limited",
  "web_search_upstream_error",
  "web_search_timeout",
  "web_search_response_invalid",
  "web_search_response_too_large",
  "web_search_endpoint_invalid",
  "web_search_gateway_token_invalid",
  // Host configuration the run cannot do anything about.
  "public_source_gateway_unconfigured",
  "public_source_dataset_unconfigured",
  "public_source_managed_credential_invalid",
  "public_source_gateway_credential_profile_required",
  // A refusal is the guardrail working, not the run breaking. The fetch tool
  // answers official_page_url_forbidden when an agent asks for a page outside
  // the approved official-document set; the agent is meant to hear "not that
  // one" and go elsewhere, which is exactly what it does. Failing the run for
  // it punishes the agent for having asked: one production run explored
  // professional.heart.org/en/science-news, was refused, obeyed, and went on to
  // write a complete package that passed preflight — and was then failed for
  // that single refused request, 50 tool calls after it stopped mattering.
  // Whether the package is sound is decided by the package checks below.
  //
  // The gateway's own refusals are the same judgment, and it answers them with
  // 403: the run asked for a source outside the approved set and was told no.
  // Its 401 is the host's credential configuration, which the run can no more
  // fix than a missing Unpaywall address above.
  "official_page_url_forbidden",
  "public_source_unsupported",
  // A downstream specialist service that could not complete. It is one tool a
  // run may call among many, and calling it is not what the run is judged on:
  // a production analysis wrote all seven deliverables, then was failed because
  // the research-topic service crashed on a PubMed 429 and a missing plotting
  // library — an outage in a helper container and an upstream rate limit,
  // neither of which is a defect in the analysis. Whether the package is sound
  // is what the package checks decide.
  "specialist_execution_failed",
  "meta_agent_execution_failed",
  "upstream_failed",
  "public_source_document_path_forbidden",
  "public_source_document_request_forbidden",
  "public_source_gateway_credential_profile_forbidden",
  "public_source_gateway_graphql_forbidden",
  "public_source_gateway_url_forbidden",
  "public_source_pdf_host_forbidden",
  "public_source_gateway_token_invalid",
  // The GEO probe. Everything here means "this deployment could not put the
  // question to the vendor", which is a limitation to state in the report — a
  // brand's visibility was not measured — and never a reason to discard work
  // that is otherwise complete. `geo_probe_plaintext_forbidden` and
  // `geo_probe_unconfigured` are the operator's transport decisions, obeyed by
  // a run that did nothing wrong; failing over those would repeat the
  // official_page_url_forbidden incident exactly.
  "geo_probe_unconfigured",
  "geo_probe_endpoint_invalid",
  "geo_probe_plaintext_forbidden",
  "geo_probe_busy",
  "geo_probe_rate_limited",
  "geo_probe_timeout",
  "geo_probe_unavailable",
  "geo_probe_upstream_error",
  "geo_probe_not_found",
  "geo_probe_response_invalid",
  "geo_probe_response_too_large",
  "geo_probe_screenshot_too_large",
  "geo_probe_gateway_failed",
  "geo_probe_gateway_token_missing",
  "geo_probe_gateway_token_invalid",
  // The private evidence API is not configured for this deployment. It is host
  // configuration, like the Unpaywall case above, and the keyless public
  // sources are what the tool falls back to — failing a run over it would
  // punish an agent that did exactly what it was told.
  "evimed_evidence_unconfigured",
]);


// The other half of the same judgment, kept explicit so that neither list can
// quietly become the default. A failure here says the run's own machinery
// broke — it could not write what it fetched, or it built a request the
// gateway could not parse — and that is worth failing over even when
// deliverables exist. The gateway draws the same line by status: it refuses
// with 403 and rejects a malformed request with 400.
//
// Every code an evidence tool emits must appear in one set or the other; the
// test that enumerates the tool sources holds that line, so a code added to the
// MCP server cannot silently inherit "fails the run" by never being classified.
export const terminalEvidenceSourceErrorCodes = new Set([
  // The artifact could not be preserved, so nothing downstream can quote it.
  "full_text_workspace_invalid",
  "official_page_workspace_invalid",
  "full_text_output_invalid",
  "official_page_output_invalid",
  // A malformed request is still the run's own problem: unlike a refusal, the
  // tool never got far enough to have an opinion about the source.
  "public_source_query_invalid",
  "public_source_url_invalid",
  "public_source_dataset_invalid",
  "public_source_gateway_invalid",
  "official_page_url_invalid",
  "full_text_identifier_invalid",
  "public_source_gateway_accept_invalid",
  "public_source_gateway_body_invalid",
  "public_source_gateway_body_too_large",
  "public_source_gateway_content_type_invalid",
  "public_source_gateway_credential_profile_invalid",
  "public_source_gateway_doi_invalid",
  "public_source_gateway_evimed_request_invalid",
  "public_source_gateway_field_invalid",
  "public_source_gateway_method_invalid",
  "public_source_gateway_url_invalid",
  "public_source_gateway_variables_invalid",
  // Named like a refusal, answered as a 400: the runtime tried to supply
  // credentials itself, which it must never do. That is the runtime
  // misbehaving, not a source declining to be read.
  "public_source_gateway_credential_parameter_forbidden",
  // Retrieved, but unusable as evidence, which the run must not paper over.
  "full_text_body_missing",
  "official_page_content_missing",
  "full_text_pdf_encrypted",
  "full_text_pdf_not_machine_readable",
  "full_text_pdf_reader_missing",
  "full_text_pdf_unreadable",
  "full_text_too_large",
  "full_text_upstream_invalid",
  "full_text_xml_invalid",
  "official_page_too_large",
  "official_page_response_invalid",
  // The adapter was reached and the request or the answer was wrong. A
  // malformed call is the run's to correct; a response without provenance
  // cannot be quoted, whatever it contains.
  "adapter_url_invalid",
  "adapter_contract_invalid",
  "adapter_invalid_response",
  "adapter_redirect_forbidden",
  "adapter_missing_provenance",
  // The MCP server refusing the call itself: a tool that does not exist, input
  // that does not validate, an assessment request that is not well formed.
  "unknown_tool",
  "invalid_input",
  "invalid_assessment",
  "invalid_assessment_action",
  "invalid_assessment_requirements",
  // A search the gateway could not parse: the query, its bounds, or its size.
  // The run rewrites and asks again.
  "web_search_query_invalid",
  "web_search_request_invalid",
  "web_search_request_too_large",
  "web_search_categories_invalid",
  "web_search_language_invalid",
  "web_search_limit_invalid",
  "web_search_time_range_invalid",
  // Malformed calls into the specialist workers and the science connectors:
  // a bad action, an id that is not one, a path outside the workspace, an
  // argument the schema rejects. The run rewrites the call.
  "meta_action_invalid",
  "meta_topic_required",
  "meta_job_id_invalid",
  "meta_job_state_invalid",
  "meta_job_state_too_large",
  "meta_input_path_invalid",
  "meta_output_scope_invalid",
  "meta_workspace_invalid",
  "meta_agent_root_invalid",
  "specialist_action_invalid",
  "specialist_input_required",
  "specialist_input_path_invalid",
  "specialist_job_id_invalid",
  "specialist_job_state_invalid",
  "specialist_job_state_too_large",
  "specialist_output_scope_invalid",
  "specialist_workspace_invalid",
  "specialist_agent_root_invalid",
  "specialist_project_env_invalid",
  "science_connector_unknown",
  "science_connector_tool_invalid",
  "science_connector_site_invalid",
  "science_connector_query_invalid",
  "science_connector_request_invalid",
  "science_connector_request_too_large",
  "science_connector_schema_invalid",
  "science_connector_series_invalid",
  "science_connector_period_invalid",
  "science_connector_database_invalid",
  "science_connector_arguments_invalid",
  "science_connector_argument_required",
  "science_connector_argument_unknown",
  "science_connector_enum_invalid",
  "science_connector_integer_invalid",
  "science_connector_number_invalid",
  "science_connector_string_invalid",
  "science_connector_string_pattern_invalid",
  "science_connector_value_above_maximum",
  "science_connector_value_below_minimum",
  "pharmacy_reference_invalid",
  // The worker finished but its output does not match the evidence it claims.
  // Delivering that is exactly what this gate exists to prevent.
  "meta_source_evidence_mismatch",
  "specialist_source_evidence_mismatch",
  // The GEO probe's own 400s: the run asked for an operation, a vendor, a flag,
  // or a screenshot name outside the closed vocabulary. Unlike a refusal, that
  // is the run's own request being wrong, and the caller has to see it rather
  // than record a vendor as silent.
  "geo_probe_op_invalid",
  "geo_probe_question_invalid",
  "geo_probe_provider_invalid",
  "geo_probe_flag_invalid",
  "geo_probe_screenshot_name_invalid",
  "geo_probe_request_invalid",
  "geo_probe_request_too_large",
]);

/**
 * Kernel-boundary codes the adapter lands a DSH turn on (§6.4). `interrupted`
 * is written by the persistence backend on cold load, not by the loop, so it
 * reaches us as a stopped run rather than a failed one.
 */
export const TURN_END_ERROR_CODES = Object.freeze({
  completed: null,
  aborted: 'runtime_canceled',
  blocked: 'runtime_tool_error',
  error: 'runtime_session_error',
  'max-tokens': 'runtime_session_error',
  interrupted: 'runtime_stopped',
  unknown: 'runtime_turn_end_unknown',
})

/** Sub-codes that qualify a kernel-boundary code without multiplying the codes. */
export const TURN_END_SUB_CODES = Object.freeze({
  blocked: 'turn_blocked',
  'max-tokens': 'model_max_tokens',
})

/**
 * Runtime and transport failures the control plane raises. Every one of them
 * used to be able to look like "the run made no progress"; §14 rule 5 requires
 * that reading history or status failing lands here and is counted instead.
 */
export const RUNTIME_ERROR_CODES = Object.freeze([
  'runtime_canceled',
  'runtime_stopped',
  'runtime_session_error',
  'runtime_session_not_found',
  'runtime_tool_error',
  'runtime_turn_end_unknown',
  'runtime_history_unavailable',
  'runtime_status_unavailable',
  'runtime_event_stream_unavailable',
  'runtime_wire_protocol_mismatch',
  'runtime_seam_missing',
  'runtime_sandbox_unavailable',
  'runtime_preset_unavailable',
  'runtime_bundle_version_mismatch',
  'runtime_domain_version_mismatch',
  // A run that wrote its deliverable and then stopped without ever submitting
  // it for grading. Distinct from `runtime_stopped` on purpose: both end with
  // a container that is gone and no receipt, but one lost work to an
  // interruption and the other produced a complete package and never asked for
  // a verdict on it. Reported as the same code, the second reads as
  // infrastructure trouble and the actual cause — the run stopped short of its
  // own contract — is invisible.
  'runtime_deliverable_never_submitted',
])

/** Codes the socket's own tools return in the `{ok:false, code}` envelope (§8.1). */
export const SOCKET_TOOL_ERROR_CODES = Object.freeze([
  'deliverable_rejected',
  'deliverable_unknown',
  'deliverable_dependency_pending',
  'run_incomplete',
  'plan_missing_clarifications',
  'plan_invalid',
  'plan_absent',
  'capability_unknown',
  'capability_inputs_invalid',
  'contract_kind_unknown',
  'contract_kind_ambiguous',
  'attempt_limit_reached',
  'budget_exhausted',
  'path_guard_denied',
  'subagent_failed',
  'capsule_unavailable',
  'review_unavailable',
])

/** Codes the unified analysis layer raises (§29.4 rule 17). */
export const ANALYSIS_ERROR_CODES = Object.freeze([
  'source_unreadable',
  'parser_failed',
  'extractor_slot_missing',
  'connector_rate_limited',
  'connector_unauthorized',
  'connector_unavailable',
  'source_too_large',
  'source_duplicate',
  'source_missing',
])

/** Codes the credit and metering layer raises (§25). */
export const CREDIT_ERROR_CODES = Object.freeze([
  'credits_exhausted',
  'credits_daily_limit_reached',
  'credits_weekly_limit_reached',
  'usage_metering_unavailable',
])

/**
 * Every code this build knows, so a mapping test can prove a new code was
 * classified rather than silently inheriting a default.
 */
export const ALL_ERROR_CODES = Object.freeze([
  ...RUNTIME_ERROR_CODES,
  ...SOCKET_TOOL_ERROR_CODES,
  ...ANALYSIS_ERROR_CODES,
  ...CREDIT_ERROR_CODES,
  ...repairableEvidencePackageErrorCodes,
  ...recoverableEvidenceSourceErrorCodes,
  ...terminalEvidenceSourceErrorCodes,
])

/**
 * How a source-tool failure should be treated. A code in neither set is
 * `unknown`, which callers must handle explicitly — the point of the two sets
 * is that no code inherits a verdict by omission.
 * @param {string} code
 * @returns {'recoverable' | 'terminal' | 'unknown'}
 */
export function classifyEvidenceSourceError(code) {
  const text = String(code ?? '')
  if (recoverableEvidenceSourceErrorCodes.has(text)) return 'recoverable'
  if (terminalEvidenceSourceErrorCodes.has(text)) return 'terminal'
  return 'unknown'
}

/**
 * Maps a turn-end kind to a run error code. An unrecognized kind lands on
 * `runtime_turn_end_unknown` with the raw kind preserved, so a DSH release that
 * adds a variant shows up as a counted unknown instead of a silent success.
 * @param {string} kind
 * @returns {{ errorCode: string | null, subCode?: string, unknownKind?: string }}
 */
export function turnEndErrorCode(kind) {
  const text = String(kind ?? '')
  if (Object.prototype.hasOwnProperty.call(TURN_END_ERROR_CODES, text)) {
    const errorCode = TURN_END_ERROR_CODES[/** @type {keyof typeof TURN_END_ERROR_CODES} */ (text)]
    const subCode = TURN_END_SUB_CODES[/** @type {keyof typeof TURN_END_SUB_CODES} */ (text)]
    return subCode ? { errorCode, subCode } : { errorCode }
  }
  return { errorCode: 'runtime_turn_end_unknown', unknownKind: text }
}

/**
 * The user-facing Simplified Chinese text for a code. The rule the UI follows
 * (§23.2 rule 2) is "what happened + what you can do", so each entry carries
 * both. A code without an entry falls back to the code itself: an untranslated
 * code is visibly untranslated rather than invisibly generic.
 */
export const ERROR_CODE_MESSAGES = Object.freeze({
  runtime_canceled: '运行已被取消。可以重新发起，或从某一步分叉后继续。',
  runtime_stopped: '运行进程中断，已按中断记录收尾。重试即可继续。',
  runtime_deliverable_never_submitted:
    '运行已经写出交付文件，但没有提交校验就结束了，因此没有通过质量门、也没有可交付的成果。'
    + '文件仍在工作区里，可以重新发起让它提交；未经校验的文件不会被当作交付物。',
  runtime_session_error: '模型调用失败。稍后重试；若反复出现请缩小题面范围。',
  runtime_session_not_found: '运行时还没有这个会话，因此它还没有产生任何记录。',
  runtime_tool_error: '一次工具调用被拒绝或失败。查看运行树中标红的节点。',
  runtime_turn_end_unknown: '运行以本版本未知的方式结束，已记录待排查。',
  runtime_history_unavailable: '暂时读不到运行记录，这不代表运行没有进展。稍后刷新。',
  runtime_status_unavailable: '暂时读不到运行状态，稍后刷新。',
  runtime_event_stream_unavailable: '实时事件流断开，正在重连。',
  runtime_wire_protocol_mismatch: '运行时协议与控制面不一致，请联系管理员升级。',
  runtime_seam_missing: '运行时缺少必需组件，已拒绝启动。',
  runtime_sandbox_unavailable: '运行时沙箱不可用，命令执行已整体关闭。',
  runtime_preset_unavailable: '运行时的统一组合未装载，已拒绝启动。',
  runtime_bundle_version_mismatch: '运行时插座版本与镜像声明不一致。',
  runtime_domain_version_mismatch: '运行时与控制面的契约版本不一致。',
  deliverable_rejected: '交付物未通过契约校验，已列出必修项。',
  deliverable_unknown: '计划里没有这件交付物。',
  deliverable_dependency_pending: '这件交付物依赖的产物还没通过。',
  run_incomplete: '还有交付物未通过或缺少澄清记录，运行未结束。',
  plan_missing_clarifications: '计划里没有写下澄清或假设。',
  plan_invalid: '计划文件不符合格式要求。',
  plan_absent: '这次运行没有写计划。',
  capability_unknown: '能力目录里没有这个能力。',
  capability_inputs_invalid: '委派参数不满足能力清单的要求。',
  contract_kind_unknown: '未知的契约种类。',
  contract_kind_ambiguous: '这个能力有多种产出，需要在计划里指明契约种类。',
  attempt_limit_reached: '提交次数已用尽，请以部分交付结束。',
  budget_exhausted: '本次运行的预算已用尽。',
  path_guard_denied: '这个路径不允许写入。',
  subagent_failed: '一个分工失败了，已自动重派一次。',
  capsule_unavailable: '记忆胶囊暂不可用，本次未启用。',
  review_unavailable: '语义审查暂不可用，本次未启用。',
  source_unreadable: '这份资料读不出来，已保留原件可重试。',
  parser_failed: '解析失败，已保留原件可重试。',
  extractor_slot_missing: '这份资料缺少必填信息，补一句话即可。',
  connector_rate_limited: '网盘限速，已排队稍后继续。',
  connector_unauthorized: '网盘授权已失效，请重新授权。',
  connector_unavailable: '网盘暂时连不上，已排队重试。',
  source_too_large: '文件超过上限，请用本地代理处理。',
  source_duplicate: '这份资料已经存在。',
  source_missing: '原始库里找不到这份资料了，派生内容已保留。',
  credits_exhausted: '额度已用尽，充值后即可继续。',
  credits_daily_limit_reached: '今日额度上限已到，明天继续或调高上限。',
  credits_weekly_limit_reached: '本周额度上限已到。',
  usage_metering_unavailable: '计量暂时不可用，本次用量稍后补记。',
  illegal_state_transition: '状态变更不合法，已拒绝。',
})

/**
 * Families of source-tool codes, matched in order.
 *
 * There are 156 evidence-source codes and a table with 156 rows would be a
 * table nobody keeps current — a new code would arrive with no message and show
 * a reader a bare identifier. A family prefix means a new code inherits a
 * sentence that is true of its whole family, and the code itself is still shown
 * beside it for anyone who needs the exact one.
 */
/** @type {ReadonlyArray<readonly [RegExp, string]>} */
const ERROR_CODE_FAMILIES = Object.freeze([
  [/^full_text_/, '这篇文献的全文取不到。报告会把它记为限制，而不是当作读过。'],
  [/^official_page_/, '这个官方页面取不到。报告会把它记为限制。'],
  [/^public_source_/, '公共数据源这次没能给出结果。'],
  [/^web_search_/, '网页检索这次没能完成。'],
  [/^adapter_/, '专有数据接口这次没能给出结果。'],
  // The specific families come first: matching is in order, and
  // `specialist_question_coverage_missing` is a coverage gap, not an engine
  // failure — telling a reader to retry it would send them to the wrong place.
  [/^specialist_evidence_/, '交付物的证据链有缺口，运行会被退回修复。'],
  [/^specialist_question_coverage_/, '题面逐问核对的台账不完整，运行会被退回补齐。'],
  [/^(meta|specialist)_/, '专科引擎这次没能完成，稍后重试或缩小范围。'],
  [/^runtime_/, '运行时出现问题，稍后重试。'],
  [/^credits_/, '额度不足或已达上限。'],
])

/**
 * The reader-facing sentence for a code.
 *
 * The exact entry wins; then the family; then the code itself. Falling through
 * to the code is deliberate — an untranslated code is visibly untranslated,
 * which is a bug report, whereas a generic "an error occurred" is a dead end.
 * @param {string} code @returns {string}
 */
export function errorCodeMessage(code) {
  const text = String(code ?? '')
  const exact = ERROR_CODE_MESSAGES[/** @type {keyof typeof ERROR_CODE_MESSAGES} */ (text)]
  if (exact) return exact
  for (const [pattern, message] of ERROR_CODE_FAMILIES) {
    if (pattern.test(text)) return message
  }
  return text
}
