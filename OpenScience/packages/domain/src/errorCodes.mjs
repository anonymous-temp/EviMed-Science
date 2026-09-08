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
  // A caller-selected id already exists in this project. The request is safe
  // and the job did not start; choosing a fresh id is sufficient, so this must
  // not fail a run that completes its evidence work through another path.
  "specialist_job_id_conflict",
  // "This deployment does not offer that tool", which is the deployment's
  // shape and not the run's mistake — the same class as an unconfigured
  // adapter, and recoverable for the same reason: the run notes the capability
  // it did not have and finishes with the sources it does.
  "tool_disabled",
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
  "mr_input_remote_auth_required",
  "mr_input_remote_metadata_unavailable",
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
  "specialist_input_invalid",
  "specialist_input_path_invalid",
  // Declared local MR inputs need correction or a fresh job. Missing clumping
  // evidence must never be repaired by inventing a preclumped declaration.
  "mr_input_invalid",
  "mr_input_path_invalid",
  "mr_input_changed",
  "mr_input_size_limit",
  "mr_input_clumping_required",
  "mr_input_manifest_invalid",
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
 * Every code the control plane can write onto a *finished run* — the one place
 * a code is read by a researcher rather than by a tool loop.
 *
 * It is enumerated separately because the coverage arithmetic over
 * `ALL_ERROR_CODES` answers the wrong question: of the 253 codes there, the
 * overwhelming majority are tool-boundary codes that `terminalFromMessages`
 * collapses into `runtime_tool_error` long before anyone sees them, while
 * fifteen codes that really do end runs — `runtime_monitor_stalled`,
 * `specialist_deliverable_not_accepted`, `superseded_by_dispatch` and the rest
 * of this list — were in no registry at all. The browser filled the gap with a
 * twenty-key table of its own whose default sentence was 「运行未通过核验。」,
 * so a run killed on a fifteen-minute stall timer told the researcher their
 * evidence had failed quality control. Every member here therefore carries an
 * *exact* sentence (the family fallback is not good enough for a verdict) and
 * an outcome class, and the test holds that line.
 *
 * Not a closed set at runtime, and deliberately not treated as one:
 * `sanitizeErrorCode` admits any well-formed lowercase identifier, and the run
 * monitor's catch forwards whatever code the runtime controller's `HttpError`
 * carried. That is why `errorCodeOutcome` and `errorCodeMessage` must both be
 * total. This list is what we promise to explain by name.
 */
export const RUN_VERDICT_ERROR_CODES = Object.freeze([
  // The platform stopped the run. None of these is a judgment about the work.
  'runtime_canceled',
  'runtime_stopped',
  'runtime_session_error',
  'runtime_tool_error',
  'runtime_turn_end_unknown',
  'runtime_deliverable_never_submitted',
  'runtime_monitor_stalled',
  'runtime_monitor_timeout',
  'runtime_monitor_failed',
  'runtime_prompt_rejected',
  // Manufactured by `sanitizeErrorCode` for a code that is not a well-formed
  // identifier. The system invents it for itself, so it has to be able to
  // explain it: it used to reach the browser's table, miss, and be reported as
  // a failed verification.
  'runtime_error',
  'superseded_by_dispatch',
  // Refused by the delivery gate. The package is on disk and the issues are
  // actionable inside it — every sentence for these says so, because "your
  // files are gone" is what 28 of 179 production runs looked like.
  'specialist_deliverable_not_accepted',
  'specialist_receipt_digest_mismatch',
  'specialist_required_output_missing',
  'specialist_required_output_stale',
  'specialist_required_skill_missing',
  'specialist_contract_unavailable',
  'specialist_citation_invalid',
  'specialist_citation_integrity_failed',
  'specialist_cited_source_unrecorded',
  'specialist_delegated_evidence_read',
  'specialist_evidence_snapshot_missing',
  'specialist_evidence_snapshot_invalid',
  'specialist_evidence_snapshot_empty',
  'specialist_evidence_traceability_failed',
  'specialist_evidence_provenance_failed',
  'specialist_evidence_integrity_failed',
  'specialist_evidence_repair_failed',
  'specialist_evidence_repair_snapshot_failed',
  'specialist_question_coverage_missing',
  // The named defects `clinicalEvidencePackageErrorCode` returns.
  'specialist_question_coverage_invalid',
  'specialist_question_coverage_unsupported',
  'specialist_question_coverage_gap_overstated',
  'specialist_question_coverage_understated',
  'specialist_screening_ledger_mismatch',
  'practical_emergency_trigger_conditioned_on_medication_response',
  'regulatory_article_without_official_source',
  'declared-appraisal-must-execute',
])

/**
 * Codes a person meets outside a run's verdict: a refusal before anything
 * starts, and the autopilot verification episode's own outcomes.
 *
 * These never reach `run.errorCode`, but they do reach a human — a 402 at the
 * moment they press Send, a 423 while their own proactive research holds the
 * runtime, a claim card saying an independent check could not be completed —
 * and each was previously rendered as its raw English identifier or swallowed
 * entirely.
 */
export const CONTROL_PLANE_ERROR_CODES = Object.freeze([
  'usage_budget_exceeded',
  'runtime_reserved_for_autopilot',
  'runtime_busy',
  'runtime_limit_exceeded',
  'agent_run_active',
  'agent_run_limit_reached',
  'illegal_state_transition',
  'verification_run_failed',
  'verification_result_missing',
  'verification_result_unreadable',
  'verification_result_schema_invalid',
  'verification_verdict_invalid',
  'verification_verdict_missing',
])

/**
 * Every code this build knows, so a mapping test can prove a new code was
 * classified rather than silently inheriting a default.
 *
 * De-duplicated, because the lists above overlap on purpose: a run verdict is
 * also a runtime code, and stating it twice — once as "what the kernel can
 * return" and once as "what a researcher can be shown" — is what keeps the
 * second list from being derived by accident and drifting.
 */
export const ALL_ERROR_CODES = Object.freeze([...new Set([
  ...RUNTIME_ERROR_CODES,
  ...SOCKET_TOOL_ERROR_CODES,
  ...ANALYSIS_ERROR_CODES,
  ...CREDIT_ERROR_CODES,
  ...RUN_VERDICT_ERROR_CODES,
  ...CONTROL_PLANE_ERROR_CODES,
  ...repairableEvidencePackageErrorCodes,
  ...recoverableEvidenceSourceErrorCodes,
  ...terminalEvidenceSourceErrorCodes,
])])

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
  // Was 「查看运行树中标红的节点」. The run tree is not on the router — it lives
  // under an unreachable page — so the sentence sent the reader to a screen
  // that does not exist. Say what is true and reachable instead.
  runtime_tool_error: '一次工具调用被拒绝或失败，运行没能继续。这不是对成果的质量判断；已经写出的文件仍在工作区里，可以重试或把题面缩小一些。',
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
  credits_daily_limit_reached: '今日额度上限已到，这次请求没有开始。窗口重置后自动恢复，也可以在「账户与额度」调高上限。',
  credits_weekly_limit_reached: '本周额度上限已到，这次请求没有开始。下一个计费周期自动恢复，也可以在「账户与额度」调高上限。',
  usage_metering_unavailable: '计量暂时不可用，本次用量稍后补记。',
  illegal_state_transition: '状态变更不合法，已拒绝。',

  // ——— Run verdicts: the platform stopped the run ———
  //
  // Every sentence below is written under one rule: a run the platform stopped
  // must never be described as work that failed quality control. That was the
  // single most damaging string in the product — the browser's own table
  // answered 「运行未通过核验。」 for a stall timer, a cancel and a supersede
  // alike — and the rule is what these entries exist to carry.
  runtime_monitor_stalled:
    '运行连续很长时间没有产生新的消息或工具调用，已按「无进展」中断收尾。'
    + '这不是质量问题；已经写出的文件仍在工作区里，可以回到这个会话让它从中断处继续。',
  runtime_monitor_timeout:
    '运行超过了本次任务的总时长上限，已中止。'
    + '这不是质量问题；已经写出的文件仍在工作区里，把题面拆小后重跑通常能跑完。',
  runtime_monitor_failed:
    '平台在监控这次运行时自身出错，运行按失败收尾。'
    + '这是我们这边的问题，与你的题面和已经产出的内容无关，请重试；反复出现时把这条运行的编号发给管理员。',
  // No claim about billing here, unlike the ceiling messages below: the prompt
  // is refused before the turn is accepted, but this file cannot promise what
  // the gateway did or did not charge, and a sentence that promises it would be
  // one more thing the product says without guaranteeing.
  runtime_prompt_rejected: '运行时拒绝了这次提问，任务没有开始。稍后重试；反复出现请联系管理员。',
  runtime_error: '运行以一个本版本无法识别的原因结束，已记录待排查。这不是对成果的质量判断。',
  superseded_by_dispatch:
    '这次运行被你随后发出的新任务取代，已按取消收尾。'
    + '接着做同一件事的是列表里更靠前的那一条运行。',

  // ——— Run verdicts: refused by the delivery gate ———
  //
  // The package exists. Each sentence says where the work is and what the
  // repair is, because 28 of 179 production runs ended here with a finished
  // report on disk and a screen that said 「暂无交付物。」
  specialist_deliverable_not_accepted:
    '交付物已经写好，但没有通过交付契约校验，因此没有作为成果发布。'
    + '文件没有被删除，仍在本次运行的工作区里；按退回意见修好后可以重新提交。',
  specialist_receipt_digest_mismatch:
    '写下交付回执之后文件又被改动过，盘上的这一版没有经过质量门判定，因此不能当作已核验的成果发布。'
    + '文件仍在工作区里，可以自行取用；若这是有意的收尾修改，请让运行在最后一次修改之后再提交一次。',
  specialist_required_output_missing:
    '这项能力约定必须产出的文件里，有一个没有写出来，因此这份成果不完整、没有通过质量门。'
    + '已经写好的部分仍在工作区里。',
  specialist_required_output_stale:
    '必须产出的文件是上一次运行留下的旧文件，不是这次的成果，因此不能作为这次的交付物。'
    + '请让运行用这次的工作重新生成它。',
  specialist_required_skill_missing:
    '这次运行没有加载本项能力约定必须使用的方法说明，因此无法确认结论是按该方法做出来的。'
    + '这不是对结论对错的判断，重新发起一次即可。',
  specialist_contract_unavailable:
    '这次运行所依据的能力契约在服务端已经更新或不再提供，无法据此核验产出。请重新发起。',
  specialist_citation_invalid:
    '报告里有读者打不开的引用地址（需要登录、或指向内部地址），这些引用无法作为可核对的证据。'
    + '成果仍在，换成公开可访问的出处即可。',
  specialist_citation_integrity_failed:
    '报告里的引文与它标注的来源对不上，引用链没有通过核验。成果仍在，逐条订正引文或改标出处即可。',
  specialist_cited_source_unrecorded:
    '报告引用了没有登记在证据快照（evidence-snapshot.json）里的来源，证据链缺了一环。'
    + '把该来源补登为已检索，或去掉依赖它的那句结论即可。',
  specialist_evidence_snapshot_missing:
    '这份成果缺少证据快照 evidence-snapshot.json —— 报告所引每一条来源的冻结记录，因此证据链无法核验。其余文件都已写好。',
  specialist_evidence_snapshot_invalid: '证据快照 evidence-snapshot.json 不是合法的来源记录，证据链无法核验。',
  specialist_evidence_snapshot_empty: '证据快照 evidence-snapshot.json 里没有登记任何来源地址，证据链无法核验。',
  specialist_evidence_traceability_failed:
    '成果的证据链有对不上的地方：引用、检索记录与来源清单之间不一致，因此没有通过质量门。'
    + '报告和其余文件都在工作区里，按退回意见逐条订正即可，不需要重做。',
  specialist_evidence_provenance_failed:
    '来源清单里列出的文件，没有任何检索工具在这次运行中报告保存过，因此这些来源的出处无法证实。'
    + '只列检索工具在本次运行中实际返回的来源路径即可。',
  specialist_evidence_integrity_failed:
    '保存下来的原始来源与检索时写下的内容已经不一致，从中摘出的引文不能算作原文。'
    + '不要改动、截断或重排已保存的来源；确需更新时重新检索一次。',
  specialist_delegated_evidence_read:
    '这份成果里有一部分证据是分工子任务读取的，主运行没有亲自核对，因此标注为「未完成核验」。'
    + '成果可以正常查看，引用前请自行复核这部分。',
  specialist_evidence_repair_failed:
    '按退回意见做的修复没能完成，成果保持未通过状态。已经写好的文件仍在工作区里，可以自行取用或重新发起。',
  specialist_evidence_repair_snapshot_failed:
    '进入修复前没能把已完成的成果备份到工作区之外，为免改坏原件，这次没有开始修复。文件仍在工作区里。',
  specialist_question_coverage_missing:
    '题面逐问核对台账（question-coverage.json）没有写，因此无法证明每一问都答到了。'
    + '其余成果都已写好，补上这份台账即可交付。',
  specialist_question_coverage_invalid: '题面逐问核对台账的格式无效，无法据此核对每一问是否答到。其余成果都已写好。',
  specialist_question_coverage_unsupported: '题面逐问核对台账里的条目指向了不存在的报告位置或论据，核对不成立。',
  specialist_question_coverage_gap_overstated: '题面逐问核对台账把报告其实已经答到的问题登记成了缺口。',
  specialist_question_coverage_understated: '题面里有问题在逐问核对台账中没有任何条目，等于没有交代它。',
  specialist_screening_ledger_mismatch:
    '检索筛选流程里的数字与最终纳入的来源对不上（或参考文献条目数与正文引用不一致），这份台账不能自证。',
  practical_emergency_trigger_conditioned_on_medication_response:
    '临床实践要点把「就医／急救」的触发条件写成了取决于用药后的反应，这在安全上不成立：就医指征必须是无条件的。'
    + '这是必须改的一处，其余成果都在。',
  regulatory_article_without_official_source:
    '报告以条款级方式引用了法规，却没有给出官方出处，不能这样发布。补上官方文件的出处，或把表述降为概述即可。',
  'declared-appraisal-must-execute':
    '报告声明做了证据分级，但 GRADE 等级与降级理由不自洽，等于分级没有真正执行。补齐或订正分级理由即可。',

  // ——— Refusals a person meets before anything runs ———
  usage_budget_exceeded: '这次请求会超出账户设定的用量上限，因此没有开始，也没有产生费用。可在「账户与额度」查看已用与上限。',
  runtime_reserved_for_autopilot:
    '这个项目的运行时正在执行你自己设定的主动研究任务，暂时不接受交互提问。'
    + '等这一轮结束后即可继续，或在「主动研究」里先暂停它。',
  runtime_busy: '这个项目的运行时正被另一次任务占用，稍后会自动重试。',
  runtime_limit_exceeded: '运行时的并发或用量上限已到，这次请求没有被受理。稍后重试。',
  agent_run_active: '这个研究会话已经有一次运行在进行中。等它结束，或先取消它，再发起新的。',
  agent_run_limit_reached: '这个项目同时进行的研究运行已达上限。等其中一次结束后再发起。',

  // ——— The autopilot's independent-check episode ———
  //
  // "The check could not be completed" is not "the claim was refuted", and the
  // two must never read alike: one is our infrastructure, the other is a
  // finding about the user's own adopted conclusion.
  verification_run_failed: '独立复核这一次没能跑完，因此还没有复核结论。这不代表原来的结论被推翻。',
  verification_result_missing: '独立复核跑完了但没有写出结论文件，因此这次没有复核结果。原结论未被推翻。',
  verification_result_unreadable: '独立复核的结论文件读不出来，因此这次没有复核结果。原结论未被推翻。',
  verification_result_schema_invalid: '独立复核的结论文件格式与约定不符，这次不采信它。原结论未被推翻。',
  verification_verdict_invalid: '独立复核给出的结论不在允许的取值范围内，这次不采信它。原结论未被推翻。',
  verification_verdict_missing: '独立复核没有给出结论。原结论未被推翻。',

  // ——— Tool-boundary codes that have no family and would otherwise be bare ———
  tool_disabled: '这个部署没有开放这项工具，运行会绕开它继续。',
  unknown_tool: '调用了一个不存在的工具。',
  invalid_input: '这次工具调用的参数不符合要求。',
  upstream_failed: '下游服务这次没能完成。',
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
/**
 * Exported so a test can walk it, and so a caller can tell "we have a sentence
 * for this family" from "we have nothing". It was module-private, which meant
 * the registry's coverage could only be measured by re-typing these patterns
 * somewhere else — and the copy is what goes stale.
 * @type {ReadonlyArray<readonly [RegExp, string]>}
 */
export const ERROR_CODE_FAMILIES = Object.freeze([
  [/^full_text_/, '这篇文献的全文取不到。报告会把它记为限制，而不是当作读过。'],
  [/^official_page_/, '这个官方页面取不到。报告会把它记为限制。'],
  [/^public_source_/, '公共数据源这次没能给出结果。'],
  [/^web_search_/, '网页检索这次没能完成。'],
  [/^adapter_/, '专有数据接口这次没能给出结果。'],
  // Added because 64 codes matched no family and no entry, so they rendered as
  // a bare English identifier in a Simplified-Chinese interface. They are
  // tool-boundary codes a run handles internally, which is why they get a
  // family and not 64 sentences: a table that size is the table nobody keeps
  // current, which is the failure the family mechanism exists to prevent.
  [/^geo_probe_/, '生成式检索的可见度探测这次没能完成，报告会把它记为限制。'],
  [/^science_connector_/, '科学数据连接器这次没能给出结果。'],
  [/^mr_input_/, '孟德尔随机化的本地输入需要更正后才能继续。'],
  [/^pharmacy_reference_/, '药学参考数据这次没能给出结果。'],
  [/^evimed_evidence_/, '专有证据接口这次没能给出结果。'],
  [/^invalid_assessment/, '这次评估请求的格式不符合要求。'],
  [/^verification_/, '独立复核这次没能给出结论。原来的结论未被推翻。'],
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
 * The sentence this build actually has for a code, or `null` when it has none.
 *
 * Split out of `errorCodeMessage` so a caller can tell "the registry answered"
 * from "the registry fell back" without comparing the answer against the code,
 * which is what every substitute dictionary in the browser had to do. A caller
 * with a better fallback of its own — one that can read the run's own facts —
 * uses this; a caller with nothing better uses `errorCodeMessage`.
 * @param {string} code @returns {string | null}
 */
export function knownErrorCodeMessage(code) {
  const text = String(code ?? '')
  const exact = ERROR_CODE_MESSAGES[/** @type {keyof typeof ERROR_CODE_MESSAGES} */ (text)]
  if (exact) return exact
  for (const [pattern, message] of ERROR_CODE_FAMILIES) {
    if (pattern.test(text)) return message
  }
  return null
}

/**
 * The sentence shown for a code, always.
 *
 * The exact entry wins, then the family, then an honest fallback that says only
 * what is true of every unrecognized code — that the run did not finish and
 * that we do not have an explanation for this one — and carries the raw code
 * inside it.
 *
 * Falling through to the bare code was the old behaviour and it lost twice: the
 * one surface that rendered it showed 「失败原因：runtime_monitor_stalled」 to a
 * Chinese-reading researcher, and the surfaces that refused to show an English
 * identifier substituted a *specific* sentence instead — 「运行未通过核验。」 —
 * which is a false accusation about the researcher's own work whenever the
 * cause was a timer, a cancel or an outage. Neither half of that trade is
 * necessary: a sentence that declines to guess the cause is honest, and keeping
 * the code inside it keeps the one handle support has for finding the run. The
 * fallback deliberately makes no claim about quality, delivery or files.
 * @param {string} code @returns {string}
 */
export function errorCodeMessage(code) {
  const text = String(code ?? '')
  const known = knownErrorCodeMessage(text)
  if (known) return known
  if (!text) return '这次没有完成，系统没有记下原因。'
  return `这次没有完成，本版本还没有为这个原因准备说明。把这个代号交给管理员即可定位：${text}`
}

/**
 * How an outcome should be read, so a surface can group and act on codes
 * without keeping a table of its own.
 *
 *   delivered  the work shipped and every check that could run, ran clean
 *   qualified  the work shipped with something the reader must check
 *              themselves: a check that did not run, or one that ran and found
 *              something the package cannot self-prove. Named `qualified`
 *              rather than `reserved` or `unverified` because both of those are
 *              already values of other vocabularies in this domain, and this
 *              package's rule is that no two things share a name
 *   gated      a finished package the delivery gate refused; the files exist
 *              and the issues are repairable inside them
 *   stopped    the platform ended the run — a timer, a cancel, a supersede, an
 *              outage. Never a statement about the work
 *   capped     refused before anything started: a spend ceiling, a concurrency
 *              limit, a hold. Nothing was produced and nothing was charged
 *   upstream   the problem was at a source, connector, tool or downstream
 *              service boundary rather than in the package or the platform.
 *              `classifyEvidenceSourceError` draws the finer line inside this
 *              class — whether the run may carry on or must stop
 *   unknown    a code this build does not recognize
 *
 * Six classes and not more, because each one implies a different next action —
 * read it, read it and check the stated part, repair it, resume it, wait or
 * raise the ceiling, try another source — and a class nobody would act on
 * differently is a class that only splits the copy.
 */
export const RUN_OUTCOME_KINDS = Object.freeze([
  'delivered',
  'qualified',
  'gated',
  'stopped',
  'capped',
  'upstream',
  'unknown',
])

/**
 * Codes whose class cannot be read off their prefix. Everything else is derived
 * below, so this table holds only the exceptions — a derived classification
 * that is 90% table is a table.
 * @type {Readonly<Record<string, typeof RUN_OUTCOME_KINDS[number]>>}
 */
const ERROR_CODE_OUTCOMES = Object.freeze({
  // `specialist_*` and `meta_*` are gate codes by prefix (below), but these
  // three name a downstream service or a subagent that did not answer, which is
  // the same fact as an unreachable source.
  specialist_agent_unavailable: 'upstream',
  specialist_execution_failed: 'upstream',
  meta_agent_execution_failed: 'upstream',
  // Prefixed `runtime_`, but nothing ran: they are holds and ceilings, and the
  // action is to wait or to raise the ceiling, not to retry immediately.
  runtime_reserved_for_autopilot: 'capped',
  runtime_busy: 'capped',
  runtime_limit_exceeded: 'capped',
  agent_run_active: 'capped',
  agent_run_limit_reached: 'capped',
  usage_budget_exceeded: 'capped',
  // The gate's own named defects, which carry no recognizable prefix.
  'declared-appraisal-must-execute': 'gated',
  practical_emergency_trigger_conditioned_on_medication_response: 'gated',
  regulatory_article_without_official_source: 'gated',
  // Socket tool codes that are neither a gate refusal nor a platform stop.
  budget_exhausted: 'capped',
  attempt_limit_reached: 'capped',
  capsule_unavailable: 'upstream',
  review_unavailable: 'upstream',
  subagent_failed: 'upstream',
  // The autopilot's independent check could not be completed. Ours, not the
  // user's, and emphatically not a verdict about their adopted claim.
  verification_run_failed: 'stopped',
  verification_result_missing: 'stopped',
  verification_result_unreadable: 'stopped',
  verification_result_schema_invalid: 'stopped',
  verification_verdict_invalid: 'stopped',
  verification_verdict_missing: 'stopped',
  illegal_state_transition: 'stopped',
  // Prefixed like a ceiling, but nothing was refused: the run went ahead and
  // the usage is recorded late. Calling it `capped` would tell a reader to wait
  // for a window that is not holding anything.
  usage_metering_unavailable: 'upstream',
})

/**
 * The outcome class of a code. Total by construction: an unrecognized code is
 * `unknown`, never a guess, because `sanitizeErrorCode` admits any well-formed
 * identifier and the run monitor forwards whatever code the runtime controller
 * raised — so the vocabulary is open however carefully this file is maintained.
 *
 * `delivered` and `qualified` are never returned here: a run that shipped
 * carries no error code at all (on the degraded path the gate clears
 * `errorCode` and marks `verification` instead), so those two classes can only
 * be reached from the run record. See `runOutcomeKind`.
 * @param {string} code @returns {typeof RUN_OUTCOME_KINDS[number]}
 */
export function errorCodeOutcome(code) {
  const text = String(code ?? '')
  if (!text) return 'unknown'
  const explicit = ERROR_CODE_OUTCOMES[text]
  if (explicit) return explicit
  // The two source sets first: they are enumerated, and a `specialist_worker_*`
  // or `meta_agent_*` code inside them is a source problem, not a gate verdict.
  if (recoverableEvidenceSourceErrorCodes.has(text) || terminalEvidenceSourceErrorCodes.has(text)) return 'upstream'
  if (repairableEvidencePackageErrorCodes.has(text)) return 'gated'
  if (ANALYSIS_ERROR_CODES.includes(text)) return 'upstream'
  if (CREDIT_ERROR_CODES.includes(text) || /^credits_/.test(text) || /^usage_/.test(text)) return 'capped'
  if (/^verification_/.test(text)) return 'stopped'
  if (/^(specialist|meta)_/.test(text)) return 'gated'
  if (/^runtime_/.test(text)) return 'stopped'
  if (text === 'superseded_by_dispatch') return 'stopped'
  if (SOCKET_TOOL_ERROR_CODES.includes(text)) return 'gated'
  return 'unknown'
}

/**
 * The outcome class of a finished run, which is the code's class except in the
 * one case a code cannot express: a run that shipped its package and could not
 * fully prove it. That run succeeds with `errorCode: null` and a `verification`
 * of `unverified` or `unchecked`, and reporting it as a plain success is what
 * let 「已交付，但未完成核验」 and 「暂无交付物。」 sit six lines apart in the
 * same card.
 *
 * Total for any shape, including a record from an older ledger that predates a
 * field: an unrecognized status with no code is `unknown`, never `delivered`.
 * @param {{ status?: string | null, errorCode?: string | null, verification?: string | null }} run
 * @returns {typeof RUN_OUTCOME_KINDS[number]}
 */
export function runOutcomeKind(run) {
  const status = String(run?.status ?? '')
  const code = run?.errorCode == null ? '' : String(run.errorCode)
  if (code) return errorCodeOutcome(code)
  if (status === 'succeeded') {
    const verification = String(run?.verification ?? '')
    return verification === 'unverified' || verification === 'unchecked' ? 'qualified' : 'delivered'
  }
  if (status === 'canceled') return 'stopped'
  return 'unknown'
}

/**
 * What a refusal is allowed to tell the client beyond its code and sentence.
 *
 * Declared here, in the domain, because both ends need the same list: the
 * control plane filters an outgoing body against it (`errorDetailShapes` in
 * `apps/server/src/security.mjs`, which must derive its acceptors from this
 * table rather than restate them) and the browser decides whether to look for
 * numbers at all. They were restated, and the copies disagreed: only
 * `usage_budget_exceeded` was declared, so the two codes the deployment
 * actually raises — `credits_daily_limit_reached` and
 * `credits_weekly_limit_reached` — reached the browser with the amount, the
 * ceiling and the reset time computed, filtered out, and thrown away, leaving
 * 「请重试」 as the advice for a ceiling that retrying cannot clear.
 *
 * A value is either `'number'` (finite) or a frozen array of the exact strings
 * allowed. Nothing here may be an open string: this channel's safety is that
 * no caller-supplied text can leave through it.
 * @type {Readonly<Record<string, Readonly<Record<string, 'number' | readonly string[]>>>>}
 */
export const ERROR_DETAIL_FIELDS = Object.freeze({
  usage_budget_exceeded: Object.freeze({
    window: Object.freeze(['day', 'week', 'run']),
    limit: 'number',
    committed: 'number',
    requested: 'number',
    currency: Object.freeze(['CNY']),
  }),
  // `assertSpendWithinLimits` already holds every one of these — the window it
  // refused on, the ceiling, what has been spent, the currency, and how long
  // until it frees up — and passed only `retryAfterSeconds`, which the browser
  // never read because it arrives as a header.
  credits_daily_limit_reached: Object.freeze({
    window: Object.freeze(['day']),
    limit: 'number',
    committed: 'number',
    currency: Object.freeze(['CNY']),
    retryAfterSeconds: 'number',
  }),
  credits_weekly_limit_reached: Object.freeze({
    window: Object.freeze(['week']),
    limit: 'number',
    committed: 'number',
    currency: Object.freeze(['CNY']),
    retryAfterSeconds: 'number',
  }),
})
