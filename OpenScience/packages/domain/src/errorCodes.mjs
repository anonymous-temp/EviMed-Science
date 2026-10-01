import { DOCUMENT_EXPORT_ERROR_MESSAGES } from "./documentExport.mjs";

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
  "declared-appraisal-must-execute",
]);

// A source the run could not read is a limitation to report, not a defect in
// the run. These codes all mean "this document was not obtainable", which the
// skill already instructs the agent to record in failedSources and work around.
export const recoverableEvidenceSourceErrorCodes = new Set([
  "tooluniverse_upstream_unavailable",
  "tooluniverse_unavailable",
  "tooluniverse_busy",
  "tooluniverse_rate_limited",
  "full_text_not_available",
  "full_text_upstream_unavailable",
  // `official_page_*` is what `web_read` answered under its old name, until
  // 2026-09-20. Nothing built since emits it, and every entry stays: a
  // runtime started from an image built before the rename speaks it until that
  // runtime is replaced, and a failed tool call with a code this registry does
  // not know fails the whole run (`agentRuns.mjs`).
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
  // `reference_list` asked Europe PMC about a DOI it holds no record of. The
  // run tracing a guideline's references has learned that one list is not
  // there and goes on to the next source (2026-09-23).
  "public_source_not_found",
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
  // The token-free GWAS Catalog path (2026-09-28): the catalogue or EBI FTP did
  // not answer, a study's file is missing, unharmonised, unreadable or over the
  // stream limit, too few variants reach genome-wide significance, or the
  // configured LD reference failed. What open data could give is the fact;
  // the run records it and delivers what it has.
  "mr_open_source_unavailable",
  "mr_open_source_too_large",
  "mr_open_source_format",
  "mr_open_source_unharmonised",
  "mr_open_no_instruments",
  "mr_open_clumping_failed",
  // A MetaAgent request that failed at the same step on every allowed run: the
  // engine could not produce the review, as with meta_agent_execution_failed.
  "meta_job_attempts_exhausted",
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
  // Knowledge-base search not answering — switched off, an outage, a slow
  // index. The documents are still in the workspace to read and grep, which
  // is what the tool's own failure tells the run to do.
  "kb_search_disabled",
  "kb_search_unconfigured",
  "kb_search_unavailable",
  "kb_search_timeout",
  "kb_search_rate_limited",
  "kb_search_upstream_error",
  "kb_search_response_invalid",
  "kb_search_response_too_large",
  "kb_search_gateway_token_missing",
  "kb_search_gateway_token_invalid",
  // 「前沿动态」 search not answering — the module off or not open to this
  // account, an outage, a slow list. Its results were only ever leads; the
  // answer goes on with the literature, guideline and regulatory tools, which
  // is what the tool's own failure tells the run (frontier_search.py).
  "frontier_disabled",
  "frontier_search_unconfigured",
  "frontier_search_unavailable",
  "frontier_search_timeout",
  "frontier_search_rate_limited",
  "frontier_search_upstream_error",
  "frontier_search_response_invalid",
  "frontier_search_response_too_large",
  "frontier_search_gateway_token_missing",
  "frontier_search_gateway_token_invalid",
  // 「循证 GEO」's runtime tools (geo_platform.py → geoGateway.mjs) not
  // answering: the module off or not open to this account, a conversation
  // outside a GEO project, the social channel not configured, an outage. The
  // run records that the platform's data was not reachable and goes on with
  // what it has; a social channel that did not answer is 「无信号」, never zero.
  "geo_disabled",
  "geo_no_project",
  "geo_unconfigured",
  "geo_gateway_unreachable",
  "geo_gateway_unavailable",
  "geo_gateway_timeout",
  "geo_gateway_rate_limited",
  "geo_gateway_token_missing",
  "geo_gateway_token_invalid",
  "geo_upstream_error",
  "geo_response_invalid",
  "geo_response_too_large",
  "social_posts_unconfigured",
  // 「虚拟临研」's runtime tools (vcr_platform.py → vcrGateway.mjs) not
  // answering, read exactly like GEO's: the module off or not open to this
  // account, a conversation outside a study, an outage. The run records that
  // the study's platform data was not reachable and goes on with what it has
  // — it never writes a number the engine did not compute, and a registry it
  // could not reach is 「不可得」, never zero.
  "vcr_disabled",
  "vcr_no_study",
  "vcr_unconfigured",
  "vcr_gateway_unreachable",
  "vcr_gateway_unavailable",
  "vcr_gateway_timeout",
  "vcr_gateway_rate_limited",
  "vcr_gateway_token_missing",
  "vcr_gateway_token_invalid",
  "vcr_upstream_error",
  "vcr_response_invalid",
  "vcr_response_too_large",
  "engine_unavailable",
  "registry_unavailable",
  // The trial registry answered, or could not, in a way that is a fact about the
  // record and not about the run: not configured here, no such record, a record
  // or an answer this build cannot read. The run reports the registry item as
  // 「不可得」 and goes on — it never writes a registry field it did not read.
  "registry_not_configured",
  "registry_not_found",
  "registry_record_unreadable",
  "registry_answer_unreadable",
  // A read the data plane refused — every table withheld from this principal,
  // or a document that is not this study's: the guardrail working. The run
  // carries on without that data and says so.
  "vcr_snapshot_withheld",
  "vcr_document_not_found",
  // What a computation's status can tell a run (`vcr_simulate` `status`): the
  // engine was not there, did not answer in time, or answered with something the
  // control plane will not take as a result (a receipt that does not verify, a
  // result that does not echo the job). Each means 「这一步暂不可用」, and the
  // study's other steps stand: a number the engine did not compute is never
  // written by the run instead.
  "vcr_engine_unconfigured",
  "vcr_engine_not_composed",
  "vcr_engine_unreachable",
  "vcr_engine_timeout",
  "vcr_engine_secret_missing",
  "vcr_engine_token_file_short",
  "vcr_engine_receipt_key_file_unavailable",
  "vcr_engine_catalogue_mismatch",
  "vcr_engine_not_found",
  "vcr_engine_response_invalid",
  "vcr_engine_receipt_invalid",
  "vcr_engine_result_invalid",
  "vcr_engine_result_mismatch",
  "vcr_job_failed",
  "vcr_job_canceled",
  // Parts of the module this deployment has not opened: the data plane, the
  // evidence and matching subsystems, the access check. The T0 steps, which
  // need none of them, run as always.
  "vcr_data_plane_unavailable",
  "vcr_data_plane_not_configured",
  "vcr_data_plane_unconfigured",
  "vcr_evidence_unavailable",
  "vcr_matching_unavailable",
  "vcr_access_unavailable",
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
  "public_source_api_path_forbidden",
  "public_source_api_request_forbidden",
  "public_source_gateway_credential_profile_forbidden",
  "public_source_gateway_graphql_forbidden",
  "public_source_gateway_url_forbidden",
  "public_source_pdf_host_forbidden",
  "public_source_pdf_host_unresolved",
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
  // `locate_quote` (2026-09-18) asked about a preserved source that is not
  // there, or not text, or too large to search: the quotation stays unchecked,
  // which is what the gate would have said anyway. Nothing was fetched.
  "quote_source_not_found",
  "quote_source_unreadable",
  "quote_source_too_large",
  // The drug-label index (2026-09-18) is not shipped to this deployment, or
  // has no label under that approval number: a fact about the source, and
  // the other label connectors are still there to ask.
  "drug_label_index_unconfigured",
  "drug_label_not_found",
  // `web_read` (2026-09-20) reads any public page, so most answers it can get
  // are facts about the page: the site's robots.txt says no, the site needs a
  // browser this deployment does not have, the page is still unreadable after
  // rendering, gone, behind a login, too slow, built too deep to parse, or a
  // type nothing reads. Each is a limitation to report and another source to
  // try — a run that read eight regulator pages and hit one challenge page has
  // not failed.
  "web_read_robots_disallowed",
  "web_read_host_forbidden",
  "web_read_host_unresolved",
  "web_read_url_forbidden",
  "web_read_needs_browser",
  "web_read_unreadable",
  "web_read_page_too_complex",
  "web_read_not_found",
  "web_read_login_required",
  "web_read_upstream_error",
  "web_read_upstream_unavailable",
  "web_read_too_many_redirects",
  "web_read_content_type_unsupported",
  "web_read_document_parser_unavailable",
  "web_read_response_too_large",
  "web_read_timeout",
  "web_read_aborted",
  "web_read_busy",
  "web_read_runtime_busy",
  "web_read_host_busy",
  "web_read_page_out_of_range",
  // The deployment's own switches and the gateway being unreachable: host
  // facts, like an unconfigured web search.
  "web_read_disabled",
  "web_read_unavailable",
  "web_read_unconfigured",
  "web_read_failed",
  "web_render_unavailable",
  "web_render_disabled",
  "web_render_failed",
  "web_render_timeout",
  "web_render_busy",
  // The document parser behind a web read of a PDF: the source was reached and
  // could not be turned into text this time.
  "source_parser_unavailable",
  "source_parser_failed",
  "source_parser_timeout",
  "source_parser_response_invalid",
  "source_parser_response_too_large",
  "source_format_unsupported",
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
  "public_source_pmid_invalid",
  // `locate_quote` asked with no quote, or with a path outside the preserved
  // sources, or ran where no managed workspace exists: the run's own request
  // or the runtime's own set-up, never a fact about a source.
  "quote_invalid",
  "quote_source_invalid",
  "quote_workspace_unavailable",
  // A label id or section name the run built wrongly, a label that could not
  // be written into the workspace (so nothing downstream can quote it), or an
  // index file this server cannot trust -- as with pharmacy_reference_invalid.
  "drug_label_id_invalid",
  "drug_label_section_unknown",
  "drug_label_preservation_failed",
  "drug_label_index_invalid",
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
  // A relation query addressed with something that is not a PubTator3 concept
  // identifier, or with a relation type PubTator3 does not record. Both are the
  // run holding the instrument wrong: normalize the term again with `annotate`
  // and the identifier comes back. Nothing was asked of the source.
  "pubtator_concept_invalid",
  "pubtator_relation_invalid",
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
  // `web_read` asked with no usable URL or page number, or could not write
  // the snapshot it read (so nothing downstream can quote it), or got an
  // answer from its own gateway it could not parse.
  "web_read_url_invalid",
  "web_read_page_invalid",
  "web_read_workspace_invalid",
  "web_read_output_invalid",
  "web_read_response_invalid",
  // The adapter was reached and the request or the answer was wrong. A
  // malformed call is the run's to correct; a response without provenance
  // cannot be quoted, whatever it contains.
  "adapter_url_invalid",
  "adapter_contract_invalid",
  "engine_execution_context_invalid",
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
  // The same for a knowledge-base search the gateway could not parse.
  "kb_search_query_invalid",
  "kb_search_limit_invalid",
  "kb_search_source_ids_invalid",
  "kb_search_request_invalid",
  "kb_search_request_too_large",
  // And for a frontier search: a filter outside its closed vocabulary.
  "frontier_search_query_invalid",
  "frontier_search_lane_invalid",
  "frontier_search_specialty_invalid",
  "frontier_search_window_invalid",
  "frontier_search_mode_invalid",
  "frontier_search_limit_invalid",
  "frontier_search_request_invalid",
  "frontier_search_request_too_large",
  // And for 「循证 GEO」's tools: a `what` outside the tool's vocabulary, a
  // filter or payload the gateway cannot read, a social query it cannot send.
  // A single invalid item of a write is not one of these — it is refused in the
  // answer's `issues` while the rest are written (principle 14).
  "geo_request_invalid",
  "geo_request_too_large",
  "geo_read_what_invalid",
  "geo_read_filter_invalid",
  "geo_write_what_invalid",
  "geo_write_payload_invalid",
  "social_posts_query_invalid",
  "social_posts_platform_invalid",
  "social_posts_sort_invalid",
  "social_posts_limit_invalid",
  // And 「虚拟临研」's, on the same line: a `what` outside the vocabulary, a
  // filter or payload the gateway cannot read, a simulate action that is not
  // start or status. A single invalid item of a write is again not one of
  // these — `vcr_write` refuses it in `issues` and writes the rest.
  "vcr_request_invalid",
  "vcr_request_too_large",
  "vcr_read_what_invalid",
  "vcr_read_filter_invalid",
  "vcr_write_what_invalid",
  "vcr_write_payload_invalid",
  "vcr_simulate_action_invalid",
  "vcr_simulate_payload_invalid",
  "vcr_job_not_found",
  // The run's own request was wrong: a job the engine's protocol refuses (the
  // scenario names a key the method does not read, a design it does not
  // implement, a number out of its range), or an engine that rejected what the
  // control plane sent. And the per-item refusals of a write, which are answered
  // as `issues` beside the items that were written rather than failing the
  // call: they are here because the run's answer to each is the same — correct
  // that item and write it again — and a code no set names would inherit
  // "fails the run" by omission.
  "vcr_job_scenario_invalid",
  "vcr_job_kind_invalid",
  "vcr_engine_job_invalid",
  "vcr_engine_rejected",
  "registry_id_invalid",
  "vcr_write_empty",
  "vcr_write_field_forbidden",
  "vcr_write_refused",
  "vcr_write_value_invalid",
  "vcr_criterion_malformed",
  "vcr_evidence_unverified",
  "vcr_evaluation_input_restricted",
  "vcr_evaluation_input_changed",
  "vcr_evaluation_input_unavailable",
  "vcr_evaluation_dataset_not_found",
  "vcr_evaluation_request_invalid",
  "vcr_evaluation_holdout_unavailable",
  "vcr_matching_vocabulary_unavailable",
  "vcr_curve_provenance_unavailable",
  "vcr_method_validation_untrusted",
  "vcr_curve_provenance_invalid",
  "vcr_curve_source_changed",
  "vcr_number_format_unknown",
  "vcr_number_mcse_missing",
  "vcr_number_typed",
  "vcr_number_unbound",
  "vcr_number_unparsed",
  "vcr_interval_unnamed",
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
  // GWAS Catalog sources run one direction per job; the run starts two.
  "mr_input_direction_unsupported",
  // A catalogue identifier the run gave that resolves to no study, or a PubMed
  // id with several: the refusal lists the studies to choose from.
  "mr_open_source_invalid",
  "mr_open_source_not_found",
  "mr_open_source_ambiguous",
  // A second MetaAgent review started while one runs in the project: the answer
  // names the running job, which the run polls instead.
  "meta_job_already_running",
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

/**
 * A turn that ended in `error` because the model call itself was refused, keyed
 * by the kernel's code for that refusal. Our model gateway answers 402 for one
 * reason only — the account's or the run's spending limit refused the call
 * (usageLedger `usage_budget_exceeded`); a provider's own 402 is answered as 502.
 * Read as `runtime_session_error`, a run stopped by its budget told the reader
 * to retry, which spends nothing and changes nothing (2026-09-27: three
 * autopilot verifications with a ¥0.42 budget each, refused on their first
 * ¥1.03 reservation).
 */
export const TURN_END_WIRE_ERROR_CODES = Object.freeze({
  HTTP_402: 'runtime_spend_limit_reached',
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
  'runtime_spend_limit_reached',
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
  // The structured half of a report-shaped package, checked from its own bytes.
  // Advisory: the blocking budget is spent, so these are findings a run repairs
  // and the ledger counts, not reasons to withhold a delivery.
  'deliverable_json_unparseable',
  // A link the run's own snapshot lists and no retrieval tool of the run
  // returned: a notice until its distribution is observed (principle 4).
  'cited_source_unretrieved',
  // A link over plain HTTP: reachable, so a notice (the manifest's
  // `citationsResolvable`, applied in the run's gate since 2026-09-28).
  'citation_plain_http',
  'deliverable_run_receipt_shape',
  'deliverable_run_receipt_unbound',
  'deliverable_run_artifact_missing',
  'deliverable_table_shape',
  'deliverable_run_degraded',
  'deliverable_unknown',
  'deliverable_dependency_pending',
  'deliverable_attempts_spent',
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
  'runtime_prompt_lost',
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
  // Retired on 2026-09-17 with the question ledger and the search log they
  // judged: nothing writes them any more. Kept, with their sentences, so a run
  // recorded before then is still explained by name rather than by the
  // engine-failure fallback.
  'specialist_question_coverage_missing',
  'specialist_question_coverage_invalid',
  'specialist_question_coverage_unsupported',
  'specialist_question_coverage_gap_overstated',
  'specialist_question_coverage_understated',
  'specialist_screening_ledger_mismatch',
  // The named defects `clinicalEvidencePackageErrorCode` returns.
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
  'runtime_cleanup_required',
  'runtime_limit_exceeded',
  'agent_run_active',
  'agent_run_limit_reached',
  // 2026-09-18 (C4): the per-account project ceiling, said with its reason,
  // and the one project that can be neither archived nor deleted.
  'project_limit_reached',
  'default_project_protected',
  'illegal_state_transition',
  'verification_run_failed',
  'verification_result_missing',
  'verification_result_unreadable',
  'verification_result_schema_invalid',
  'verification_verdict_invalid',
  'verification_verdict_missing',
])

/**
 * Codes a knowledge-base intake records on a source, or answers an upload with.
 *
 * A researcher meets these on the source card and in the upload toast, never
 * in a run's verdict; they are here so each one is held to having a Chinese
 * sentence like every other code a person can read. Private: nothing outside
 * this module needs the list, only the guarantee.
 */
const sourceIntakeErrorCodes = Object.freeze([
  'source_format_unsupported',
  'source_media_unsupported',
  'source_parser_payload_too_large',
  'source_parser_input_too_large',
  'source_parser_checksum_failed',
  'source_parser_auth_failed',
  'source_parser_quota_exhausted',
  'source_parser_rate_limited',
  'source_parser_unavailable',
  'source_parser_timeout',
  'source_parser_internal_error',
  'source_parser_upstream_error',
  'source_parser_unconfigured',
  'source_parser_rejected',
  'source_parser_response_invalid',
  'source_parser_response_too_large',
  'source_changed',
  // 连接网盘 (`openListClient.mjs`): OpenList's own refusals, named so the
  // browse toast says what happened rather than a bare 502. No storage covers
  // the account's namespace; the deployment's credential was not accepted.
  'openlist_storage_missing',
  'openlist_credential_rejected',
])

/**
 * Codes the personal library answers with (`libraryService.mjs`): shown where
 * a document is added to the library, removed from it, or published from it
 * into the capsule. Private for the same reason as the intake list.
 */
const libraryErrorCodes = Object.freeze([
  'library_unavailable',
  'library_payload_invalid',
  'library_source_invalid',
  'library_item_not_found',
  'library_full',
  'library_source_removed',
  'library_understanding_missing',
  'library_capsule_unavailable',
  'library_publish_busy',
])

/**
 * Codes sharing a memory capsule answers with (`capsuleTransferService.mjs`):
 * shown in 分享与导入 where a pack is exported or opened. Private for the same
 * reason as the library list. `capsule_export_empty` was a bare 400 on the
 * owner's own account (2026-09-26 audit, M-6); it is a state with a sentence.
 */
const capsuleTransferErrorCodes = Object.freeze([
  'capsule_export_empty',
  'capsule_recipient_unknown',
  'capsule_password_required',
  // 「回到上一版」 on a learned method (`learningService.rollback`): a method
  // with one body has nothing to go back to, which is a fact about the
  // method, not 「内容已发生变化」 — what a bare 409 used to be read as.
  'method_no_earlier_version',
  'method_revision_unavailable',
])

/**
 * Codes the 「循证 GEO」 routes answer with (`geoRoutes.mjs`, `/api/geo/*`):
 * the module off, a project that is not this account's, a request the page
 * built wrong, an action whose worker is not composed. The page reads them
 * (it never shows one); they are here so each is held to a Chinese sentence
 * and so the route tests can prove every code they emit is registered.
 */
/**
 * Codes the 「虚拟临研」 routes answer with (`vcrRoutes.mjs`, `/api/vcr/*`) and
 * the codes its runtime channel answers with (`vcrGateway.mjs`,
 * `/internal/vcr/v1`). Registered here for the reason GEO's are: each is held
 * to a Chinese sentence, and the route and gateway tests can prove every code
 * they emit is a code somebody enumerated. `vcr_job_not_found` is in both
 * lists and the set below folds it; `registry_unavailable` is the one code
 * that is not the module's own — it is what a trial registry that cannot be
 * reached answers, and the run is told to carry on without it.
 */
export const VCR_ROUTE_ERROR_CODES = Object.freeze([
  'vcr_not_enabled',
  'vcr_path_invalid',
  'vcr_payload_invalid',
  'vcr_study_not_found',
  'vcr_study_paused',
  'vcr_name_invalid',
  'vcr_tier_invalid',
  'vcr_intended_use_invalid',
  'vcr_status_invalid',
  'vcr_step_invalid',
  'vcr_tab_not_found',
  'vcr_job_kind_invalid',
  'vcr_job_scenario_invalid',
  'vcr_job_not_found',
  'vcr_budget_invalid',
  'vcr_assumption_invalid',
  'vcr_review_kind_invalid',
  'vcr_decision_invalid',
  'vcr_export_kind_invalid',
  'vcr_export_not_found',
  'vcr_model_invalid',
  'vcr_member_role_invalid',
  'vcr_referral_not_found',
  'vcr_forbidden',
  'vcr_unavailable',
  'vcr_action_invalid',
  'vcr_criterion_state_invalid',
])

export const VCR_GATEWAY_ERROR_CODES = Object.freeze([
  'vcr_disabled',
  'vcr_no_study',
  'vcr_gateway_token_missing',
  'vcr_gateway_token_invalid',
  'vcr_gateway_rate_limited',
  'vcr_gateway_timeout',
  'vcr_gateway_unavailable',
  'vcr_request_invalid',
  'vcr_request_too_large',
  'vcr_read_what_invalid',
  'vcr_read_filter_invalid',
  'vcr_write_what_invalid',
  'vcr_write_payload_invalid',
  'vcr_simulate_action_invalid',
  'vcr_simulate_payload_invalid',
  'registry_unavailable',
  // What the trial registry channel answers (`trialRegistryClient.mjs`): each
  // reaches the run as itself, because 「没有这条登记」 and 「登记库没配置」 are
  // different facts and the run reports them differently.
  'registry_not_configured',
  'registry_not_found',
  'registry_id_invalid',
  'registry_record_unreadable',
  'registry_answer_unreadable',
  // A read the data plane refused: every table of the snapshot is withheld from
  // this principal, or the subject document is not this study's. The guardrail
  // working, not the run breaking — the run carries on without it.
  'vcr_snapshot_withheld',
  'vcr_document_not_found',
])

/**
 * The per-item issue codes of `vcr_write` and its report renderer (2026-09-29):
 * an item refused in `issues` while the rest of the write stands, a criterion
 * whose requirement is outside the closed grammar, an evidence citation the
 * platform could not verify against the record it names, a number in a report
 * that is typed rather than bound. The run reads them and corrects that item.
 */
export const VCR_WRITE_ISSUE_CODES = Object.freeze([
  'vcr_write_empty',
  'vcr_write_field_forbidden',
  'vcr_write_refused',
  'vcr_write_value_invalid',
  'vcr_criterion_malformed',
  'vcr_evidence_unverified',
  'vcr_curve_provenance_unavailable',
  'vcr_method_validation_untrusted',
  'vcr_curve_provenance_invalid',
  'vcr_curve_source_changed',
  'vcr_number_format_unknown',
  'vcr_number_mcse_missing',
  'vcr_number_typed',
  'vcr_number_unbound',
  'vcr_number_unparsed',
  'vcr_interval_unnamed',
])

/**
 * The rest of 「虚拟临研」's codes: refusals and states of the module's own
 * subsystems that a page shows a person (members, access to data, the data
 * plane, the engine channel, the referral ledger and its contact stop) and the
 * background loops' health. None reaches a run's verdict — the gateway hands the
 * run only the codes in `VCR_GATEWAY_ERROR_CODES` — but each is held to a
 * sentence, and the server's scan of its own sources holds every literal to
 * this list (`vcrErrorCodesRegistered.test.mjs`).
 */
export const VCR_MODULE_ERROR_CODES = Object.freeze([
  'vcr_evaluation_input_restricted', 'vcr_evaluation_input_changed', 'vcr_evaluation_input_unavailable',
  'vcr_evaluation_dataset_not_found', 'vcr_evaluation_request_invalid', 'vcr_evaluation_holdout_unavailable',
  'vcr_matching_vocabulary_unavailable', 'registry_unsupported',
  // data intake (the data tab and its routes; plan §8.1)
  'vcr_data_file_name_invalid', 'vcr_data_file_too_large', 'vcr_data_file_unreadable', 'vcr_data_format_unsupported',
  'vcr_source_file_not_found', 'vcr_source_file_frozen', 'vcr_source_file_changed',
  'vcr_field_map_invalid', 'vcr_field_map_changed', 'vcr_field_map_unconfirmed',
  'vcr_snapshot_no_tables', 'vcr_snapshot_profile_timeout', 'vcr_snapshot_profile_too_large',
  'vcr_grant_invalid', 'vcr_grant_not_found', 'vcr_grant_owner_only',
  // evidence and matching
  'vcr_asof_invalid', 'vcr_assessment_not_found', 'vcr_criteria_missing', 'vcr_pool_endpoint_key_required',
  'vcr_precedent_not_in_study', 'vcr_protocol_version_not_found',
  'vcr_assessment_save_failed', 'vcr_evaluation_failed', 'vcr_recheck_failed', 'vcr_referral_create_failed',
  // jobs, derived tables and the orchestrator's step notes
  'vcr_derived_table_missing', 'vcr_derived_table_unsupported', 'vcr_engine_table_invalid', 'vcr_job_attempts_exhausted',
  'vcr_object_unknown', 'vcr_scenario_endpoint_missing', 'vcr_scenario_grid_empty', 'vcr_scenario_unknown_fields',
  'vcr_model_not_applicable', 'vcr_model_not_found',
  // members and access to data
  'vcr_member_role_unknown',
  'vcr_member_user_required',
  'vcr_member_owner_fixed',
  'vcr_access_no_actor',
  'vcr_role_forbids',
  'vcr_no_grant',
  'vcr_source_not_found',
  'vcr_source_withdrawn',
  'vcr_purpose_not_granted',
  'vcr_outside_window',
  'vcr_field_not_granted',
  'vcr_field_sealed',
  'vcr_field_identifying',
  'vcr_snapshot_not_found',
  'vcr_snapshot_not_named',
  // the data plane
  'vcr_analysis_table_invalid',
  'vcr_artifact_outside_plane',
  'vcr_artifact_remove_failed',
  'vcr_data_plane_location_missing',
  'vcr_data_plane_location_outside',
  'vcr_data_plane_location_runtime_readable',
  'vcr_snapshot_profile_failed',
  // the engine channel and its jobs
  'vcr_engine_job_remove_failed',
  'vcr_engine_result_mismatch',
  // the referral ledger and its contact stop
  'vcr_referral_state_unknown',
  'vcr_referral_transition_invalid',
  'vcr_referral_transition_refused',
  'vcr_referral_role_forbidden',
  'vcr_referrals_contact_needs_approval',
  'vcr_contact_not_approved',
  'vcr_contact_role_forbidden',
  'vcr_contact_approval_not_per_person',
  'vcr_screen_failure_needs_criterion',
  'vcr_enrollment_needs_date',
  'vcr_exit_field_not_derivable',
  'vcr_exit_date_rewritten',
  'vcr_exit_reason_rewritten',
  'vcr_followup_kind_unknown',
  'vcr_restricted_field_not_marked',
  'vcr_site_not_found',
  'vcr_model_exists',
  // the module's own health
  'vcr_migration_failed',
  'vcr_loop_failed',
  'vcr_orchestrator_failed',
  'vcr_worker_loop_missing',
  'vcr_worker_loop_failing',
  'vcr_worker_loop_stalled',
])

/**
 * The issue codes the engine protocol's validators return
 * (`validateEngineJob`, `validateCallerInputs`, `validateScenario`,
 * `validateRowRule`, `validateRequirement`, `validateEngineResult`,
 * `validateCounts`): one per refused field, rendered to the person or model that
 * caused it. They live with the protocol in `vcrEngineJob.mjs` and
 * `vcrRules.mjs`; the test `vcrProtocolCodesRegistered` walks those sources.
 */
export const VCR_PROTOCOL_ISSUE_CODES = Object.freeze([
  // a job
  'job_not_object', 'job_field_unknown', 'job_id_invalid', 'study_id_invalid', 'protocol_version_mismatch',
  'kind_unknown', 'method_unknown', 'kind_method_mismatch', 'method_version_missing', 'method_version_mismatch',
  'seed_invalid', 'replicates_invalid', 'replicates_missing', 'cpu_limit_invalid', 'cores_invalid', 'batch_size_invalid',
  // its inputs
  'inputs_missing', 'input_not_object', 'input_kind_missing', 'input_kind_unknown', 'input_kind_caller_only',
  'input_id_invalid', 'input_version_missing', 'input_hash_invalid', 'input_hash_missing', 'input_value_source_invalid',
  'input_value_source_missing', 'input_location_invalid', 'input_location_missing', 'input_location_forbidden',
  'input_field_unknown', 'input_shape_invalid', 'input_source_not_individual', 'patient_input_required', 'snapshot_required',
  // its scenario
  'scenario_missing', 'scenario_value_invalid', 'scenario_field_unknown', 'scenario_field_missing',
  'endpoint_unknown', 'endpoint_not_supported', 'design_unknown', 'design_not_supported',
  // the two rule grammars
  'rule_op_unknown', 'rule_shape_invalid', 'rule_too_deep', 'rule_too_large', 'rule_column_unknown', 'rule_expression_forbidden',
  // a result
  'result_not_object', 'status_unknown', 'scenario_hash_invalid', 'conclusion_missing', 'conclusion_unknown',
  'conclusion_status_mismatch', 'not_estimable_rule_missing', 'not_estimable_rule_unknown', 'measures_missing',
  'measure_not_object', 'measure_name_missing', 'measure_value_invalid', 'measure_source_missing', 'measure_source_invalid',
  'mcse_missing', 'mcse_invalid', 'interval_kind_unknown', 'interval_invalid', 'table_invalid', 'model_tier_invalid',
  'model_risk_invalid', 'manifest_missing', 'manifest_field_missing', 'cpu_seconds_invalid', 'package_lock_hash_invalid',
  'output_hash_missing', 'output_hash_invalid', 'counts_not_object', 'count_invalid', 'ess_above_real',
])

/**
 * The issue codes the engine raises itself, beyond the protocol's validators
 * (`VCR_ENGINE_OWN_ISSUE_CODES` in `项目代码/vcr-engine/R/engine.R`; the engine
 * case E10d fails on a literal code in neither list). They travel inside a
 * failed or limited result's `diagnostics.issues`, never as a call failure, so
 * they are held to a sentence here and relayed by the control plane as the
 * result's reason.
 */
export const VCR_ENGINE_ISSUE_CODES = Object.freeze([
  'constraint_unsatisfiable', 'cpu_budget_exhausted', 'grid_cell_failed', 'handler_error',
  'input_format_unsupported', 'input_hash_mismatch', 'input_out_of_range', 'input_parse_failed', 'input_too_large',
  'job_invalid', 'mechanistic_engine_unknown', 'mechanistic_field_missing', 'missing_covariate',
  'model_card_field_missing', 'model_risk_unknown', 'performance_measure_unsupported', 'replicates_all_failed',
  'required_field_missing', 'twin_label_inconsistent', 'uncertainty_and_variability_conflated',
])

export const GEO_ROUTE_ERROR_CODES = Object.freeze([
  'geo_not_enabled',
  'geo_path_invalid',
  'geo_payload_invalid',
  'geo_project_not_found',
  'geo_brand_name_invalid',
  'geo_engines_invalid',
  'geo_coverage_invalid',
  'geo_tier_invalid',
  'geo_status_invalid',
  'geo_step_invalid',
  'geo_budget_invalid',
  'geo_export_kind_invalid',
  'geo_version_invalid',
  'geo_round_not_found',
  'geo_question_not_found',
  'geo_question_not_current',
  'geo_question_set_invalid',
  'geo_snapshot_not_found',
  'geo_screenshot_not_found',
  'geo_article_not_found',
  'geo_article_state_invalid',
  'geo_order_not_found',
  'geo_order_not_cancellable',
  'geo_topup_not_found',
  'geo_operator_required',
  'geo_unavailable',
  // A paused project runs nothing: 「让 AI 做」 and 导出 wait until it is resumed.
  'geo_project_paused',
])

/**
 * Codes the 灵豆 settlement routes answer with (`evimedCreditsRoutes.mjs`,
 * `/api/credits/*`, fusion plan §9.6): the module off, and a request the page
 * built wrong. They are here so each is held to a Chinese sentence and so the
 * route test can prove every code it emits is registered.
 *
 * The refusal that matters most is deliberately *not* here: a start this
 * account cannot pay for is refused with `credits_exhausted`, which
 * `CREDIT_ERROR_CODES` has carried since it was written and which
 * `usageMetering.mjs` reserved in so many words for 「a balance, which this
 * deployment does not have」. It has one now, so the reserved code is emitted
 * rather than duplicated — two codes for one fact would be two sentences to
 * keep in step.
 */
export const EVIMED_CREDITS_ROUTE_ERROR_CODES = Object.freeze([
  'evimed_credits_not_enabled',
  'evimed_credits_request_invalid',
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
  ...Object.keys(DOCUMENT_EXPORT_ERROR_MESSAGES),
  ...RUNTIME_ERROR_CODES,
  ...SOCKET_TOOL_ERROR_CODES,
  ...ANALYSIS_ERROR_CODES,
  ...CREDIT_ERROR_CODES,
  ...RUN_VERDICT_ERROR_CODES,
  ...CONTROL_PLANE_ERROR_CODES,
  ...repairableEvidencePackageErrorCodes,
  ...recoverableEvidenceSourceErrorCodes,
  ...terminalEvidenceSourceErrorCodes,
  ...sourceIntakeErrorCodes,
  ...libraryErrorCodes,
  ...capsuleTransferErrorCodes,
  ...GEO_ROUTE_ERROR_CODES,
  ...VCR_ROUTE_ERROR_CODES,
  ...VCR_GATEWAY_ERROR_CODES,
  ...VCR_WRITE_ISSUE_CODES,
  ...VCR_MODULE_ERROR_CODES,
  ...VCR_PROTOCOL_ISSUE_CODES,
  ...VCR_ENGINE_ISSUE_CODES,
  ...EVIMED_CREDITS_ROUTE_ERROR_CODES,
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
 * @param {string} [wireCode] the kernel's code for the error that ended the turn
 * @returns {{ errorCode: string | null, subCode?: string, unknownKind?: string }}
 */
export function turnEndErrorCode(kind, wireCode) {
  const text = String(kind ?? '')
  const wire = String(wireCode ?? '')
  if (text === 'error' && Object.prototype.hasOwnProperty.call(TURN_END_WIRE_ERROR_CODES, wire)) {
    return { errorCode: TURN_END_WIRE_ERROR_CODES[/** @type {keyof typeof TURN_END_WIRE_ERROR_CODES} */ (wire)] }
  }
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
  ...DOCUMENT_EXPORT_ERROR_MESSAGES,
  tooluniverse_upstream_unavailable: '补充科研数据源暂时无法访问，可继续使用其他文献和指南来源。',
  tooluniverse_unavailable: '补充科研数据源尚未配置，可继续使用其他文献和指南来源。',
  tooluniverse_busy: '补充科研数据源正忙，请稍后再试或继续使用其他来源。',
  tooluniverse_rate_limited: '补充科研数据源请求过于频繁，请稍后再试。',
  geo_project_paused: '这个项目已暂停，继续之后再让 AI 做。',
  // 「虚拟临研」's page refusals. Every one of these is permanent for the request
  // that caused it — retrying the same thing gets the same answer — so none of
  // them says 「稍后再试」, which is what the family sentence for an unknown
  // vcr_ code says and is wrong here. Each says what happened and what to do.
  vcr_study_paused: '这个研究已暂停，继续之后再让 AI 做。',
  vcr_forbidden: '你在这个研究里没有做这件事的权限。',
  vcr_unavailable: '这个操作在当前部署里还没有开放。',
  vcr_not_enabled: '这个部署没有开通虚拟临研。',
  vcr_path_invalid: '这个地址不是虚拟临研的页面；从研究列表重新进入。',
  vcr_payload_invalid: '提交的内容格式不对，没有保存；刷新页面后重新填写。',
  vcr_study_not_found: '找不到这个研究，或它不属于你的账号；从研究列表重新进入。',
  vcr_name_invalid: '研究名要写 1 到 80 个字。',
  vcr_tier_invalid: '数据档位只能选 T0 到 T3 之一。',
  vcr_intended_use_invalid: '预期用途只能选：探索、研究设计支持、指定研究分析、申报准备。',
  vcr_status_invalid: '研究状态只能是进行中、已暂停或已归档。',
  vcr_step_invalid: '没有这一步；研究的步骤是定义、证据、人群、患者、对照、试验、匹配。',
  vcr_tab_not_found: '研究页没有这个页签。',
  vcr_job_kind_invalid: '没有这种计算；请在页面上给出的计算类型里选。',
  vcr_job_scenario_invalid: '这项计算的参数不符合引擎的要求，没有排队；按提示的字段修改后再提交。',
  vcr_job_not_found: '这个研究里没有这项计算。',
  vcr_budget_invalid: '计算预算要填一个不小于 0 的数（单位是 CPU 秒）。',
  vcr_assumption_invalid: '这张假设卡填得不完整：要写参数名、取值或分布，以及它的来源。',
  vcr_review_kind_invalid: '复核类型只能是临床、统计或数据。',
  vcr_decision_invalid: '决策记录要写明决定的是什么，以及依据。',
  vcr_export_kind_invalid: '没有这种导出；可选研究包、CDE 沟通交流资料包、模拟报告、系统验证文档包。',
  vcr_export_not_found: '找不到这次导出，可能已被清理；重新导出即可。',
  vcr_model_invalid: '模型卡填得不完整：要有名字、版本和层级。',
  vcr_member_role_invalid: '成员角色只能选研究负责人、临床复核、统计复核、数据管理、招募协调员、中心或只读查看者。',
  vcr_referral_not_found: '找不到这条转诊记录。',
  // The runtime channel's write items. The run reads these in `issues` and
  // corrects the item it named.
  // Four the runtime channel already had, which fell through to the family's
  // 「稍后再试」: none is a refusal of the run's request.
  vcr_unconfigured: '虚拟临研的运行时通道在本部署里没有配置；运行会如实记下这一点，用已有的资料继续。',
  vcr_upstream_error: '虚拟临研的研究数据这次没能读写；运行会如实记下这一点，用已有的资料继续。',
  vcr_response_invalid: '虚拟临研返回的内容读不出来，这次没有采用；运行会如实记下，用已有的资料继续。',
  vcr_response_too_large: '虚拟临研返回的内容太大，这次没有采用；缩小范围再问。',
  vcr_write_empty: '这次写入没有任何内容，什么都没有保存。',
  vcr_write_field_forbidden: '这次写入里带了不允许由运行写入的字段，那一项没有保存，其余照常。',
  vcr_write_refused: '平台拒绝了这一项，原因见提示；其余各项照常保存。',
  vcr_write_value_invalid: '这一项的取值不在允许的范围里，没有保存；按提示修改后再写。',
  vcr_criterion_malformed: '这条入排条件的结构化要求不在封闭语法里，没有保存；判不了的条件写成 language 类型并保留原句。',
  vcr_curve_provenance_unavailable: '缺少已记录的曲线图像与点位来源，暂不进行这项重建；其他研究继续。',
  vcr_method_validation_untrusted: '当前方法验证来源无法核对，暂不显示验证通过；其他研究继续。',
  vcr_curve_provenance_invalid: '曲线输入没有对上已记录的来源，这项重建没有执行；其他成果保留。',
  vcr_curve_source_changed: '曲线图像在记录点位后发生变化，请提供与点位一致的来源；其他成果保留。',
  vcr_evaluation_input_restricted: '当前来源授权或封存状态不允许整份文档重放；其他研究继续。',
  vcr_evaluation_input_changed: '纠正案例的输入与冻结记录不一致，本次没有重放；已有成果保留。',
  vcr_evaluation_input_unavailable: '这个案例缺少可重放的已授权输入或版本，其他研究继续。',
  vcr_evaluation_dataset_not_found: '找不到当前研究中的这份评测集。',
  vcr_evaluation_request_invalid: '纠正案例请求格式不正确，请检查分页或评测集标识。',
  vcr_evaluation_holdout_unavailable: '这一页没有留出案例，不能据此报告留出重放结果。',
  vcr_matching_vocabulary_unavailable: '这次匹配记录的词表版本不受支持，不能按当前映射重新解释。',
  vcr_model_not_found: '所选模型的这个版本不可用，请从模型库选择确切的模型版本；其他研究继续。',
  registry_unsupported: '本部署尚未接入这个注册库，不把未查询当成没有记录。',
  vcr_evidence_unverified: '这条证据没能对上它引用的登记记录或文献原文，没有保存；重新核对原文位置后再写。',
  vcr_number_format_unknown: '报告里引用的数字格式不认识；改用平台支持的写法。',
  vcr_number_mcse_missing: '这个数字来自仿真，引用它必须带蒙特卡洛标准误。',
  vcr_number_typed: '报告里有手打的数字，已在报告中写成「未计算」；改成对结果字段的引用，由平台渲染。',
  vcr_number_unbound: '报告里引用的结果字段不存在；核对字段名。',
  vcr_number_unparsed: '报告里有读不成数字引用的 {{n:…}}；写成 {{n:路径|格式}}，格式用小写。',
  vcr_interval_unnamed: '区间没有写明是哪一种（置信、可信、预测或蒙特卡洛），补上再写。',
  // The trial registry channel.
  registry_not_configured: '本部署没有配置试验登记库，登记信息取不到；报告会写「不可得」，不会编造。',
  registry_not_found: '登记库里没有这条记录；报告会写「不可得」，不会编造。',
  registry_id_invalid: '登记号的格式不对；核对后重查。',
  registry_record_unreadable: '这条登记记录读不出来；报告会写「不可得」。',
  registry_answer_unreadable: '登记库的应答读不出来，这次没有采用；稍后可以重查。',
  // The engine channel and its jobs.
  vcr_engine_unconfigured: '本部署还没有配置计算引擎，需要计算的步骤暂不可用；其余步骤照常。',
  vcr_engine_not_composed: '本部署没有接入计算引擎，需要计算的步骤暂不可用；其余步骤照常。',
  vcr_engine_unreachable: '连不上计算引擎；这一步暂不可用，研究的其余部分照常，引擎恢复后可以重新计算。',
  vcr_engine_timeout: '计算引擎这次没有及时应答；作业会自动重试。',
  vcr_engine_secret_missing: '计算引擎的口令或回执密钥没有配置，引擎按未配置处理；请联系管理员。',
  vcr_engine_token_file_short: '计算引擎的口令文件太短（至少 32 字节），引擎按未配置处理；请联系管理员。',
  vcr_engine_receipt_key_file_unavailable: '回执密钥文件读不到，引擎按未配置处理；请联系管理员。',
  vcr_engine_catalogue_mismatch: '计算引擎和平台的方法目录对不上，已停用这个引擎；请联系管理员升级。',
  vcr_engine_not_found: '引擎里找不到这项作业，可能已被清理；重新排一次即可。',
  vcr_engine_response_invalid: '计算引擎的应答格式不对，这次没有采用；可以重新计算。',
  vcr_engine_receipt_invalid: '计算引擎的运行回执验不过，这次结果没有采用；请重新计算。',
  vcr_engine_result_invalid: '计算引擎的结果没有通过协议校验，这次没有采用；请重新计算。',
  vcr_engine_result_mismatch: '引擎返回的结果和提交的作业对不上（方法、版本、种子或情景哈希不同），这次结果没有采用。',
  vcr_engine_job_invalid: '这项计算的参数不符合引擎协议，没有提交；按提示的字段修改后再排。',
  vcr_engine_rejected: '计算引擎拒绝了这项作业，原因见作业详情；参数需要修改后再排。',
  vcr_engine_job_remove_failed: '引擎侧的作业目录没能清理；已记录，不影响研究。',
  vcr_job_failed: '这项计算没有做成；已保留能保留的部分，研究的其余部分照常。',
  vcr_job_canceled: '这项计算已取消。',
  // Parts of the module this deployment has not opened.
  vcr_data_plane_unavailable: '数据平面暂时不可用；T0（公开资料）的步骤照常。',
  vcr_data_plane_not_configured: '本部署没有配置数据平面；T0（公开资料）的步骤照常。',
  vcr_data_plane_unconfigured: '本部署未接入数据平面；T0（公开资料）的全部步骤照常。',
  vcr_evidence_unavailable: '证据模块在本部署里还没有接入。',
  vcr_matching_unavailable: '匹配与招募在本部署里还没有开放。',
  vcr_access_unavailable: '数据访问的权限检查这次没能完成，已按不允许处理；稍后再试。',
  // Members and access to data.
  vcr_member_role_unknown: '这个角色不在研究成员的角色里；换一个再加。',
  vcr_member_user_required: '添加成员要指明是哪个账号。',
  vcr_member_owner_fixed: '研究负责人是研究的创建者，不能被移除，也不能改成别的角色。',
  vcr_access_no_actor: '这次读取没有指明是谁在操作，已拒绝；从研究页里重新发起。',
  vcr_role_forbids: '你在这个研究里的角色不能读取这份数据。',
  vcr_no_grant: '这份数据还没有授权给这个研究；请数据管理员先做授权。',
  vcr_source_not_found: '找不到这个数据源，或它不属于这个研究。',
  vcr_source_withdrawn: '这个数据源已被撤回，不能再读取。',
  vcr_purpose_not_granted: '授权里没有包含这次读取的用途；请数据管理员补授权。',
  vcr_outside_window: '这次读取超出了授权的时间范围。',
  vcr_field_not_granted: '这次要读的字段不在授权范围内。',
  vcr_field_sealed: '这个字段处于封存状态：分析计划冻结之前，结局字段不向任何人开放。',
  vcr_field_identifying: '这是标识性字段，不向分析开放。',
  vcr_snapshot_not_found: '找不到这个数据快照，或它不属于这个研究。',
  vcr_snapshot_not_named: '这项计算没有指明要用哪个数据快照；先选一个已冻结的快照。',
  // The data plane.
  vcr_analysis_table_invalid: '这份分析表不符合要求（缺必填列，或取值不合理），没有登记；按提示修正后重新提交。',
  vcr_artifact_outside_plane: '这个文件不在数据平面目录里，已拒绝处理。',
  vcr_artifact_remove_failed: '数据平面里的文件没能删除；已记录，管理员可以手动清理。',
  vcr_data_plane_location_missing: '数据平面的存放目录没有配置。',
  vcr_data_plane_location_outside: '数据平面的存放目录不在允许的位置。',
  vcr_data_plane_location_runtime_readable: '数据平面目录不能放在运行时读得到的位置；请改到运行时看不到的目录。',
  vcr_snapshot_profile_failed: '这个数据快照的概况没能生成；快照本身没有受影响，可以重试。',
  // The referral ledger and its contact stop.
  vcr_referral_state_unknown: '转诊状态不在允许的范围内。',
  vcr_referral_transition_invalid: '转诊状态不能这样变化；按顺序一步步推进。',
  vcr_referral_transition_refused: '这次转诊状态变更被拒绝，原因见提示。',
  vcr_referral_role_forbidden: '你的角色不能做这一步转诊操作。',
  vcr_referrals_contact_needs_approval: '联系状态必须有具名的确认人才能保存。',
  vcr_contact_not_approved: '联系患者之前要由协调员逐人确认，这一位还没有确认。',
  vcr_contact_role_forbidden: '你的角色在这个研究里不能联系患者。',
  vcr_contact_approval_not_per_person: '联系确认必须逐人进行，不接受批量确认。',
  vcr_screen_failure_needs_criterion: '筛选失败要写明不满足的是哪一条入排标准。',
  vcr_enrollment_needs_date: '入组要写明入组日期。',
  vcr_exit_field_not_derivable: '试验期间的这个字段不可见，也不能从出组记录推出；出组日期与原因照原样保留。',
  vcr_exit_date_rewritten: '出组日期已经记录，不能改写；需要更正请新增一条说明。',
  vcr_exit_reason_rewritten: '出组原因已经记录，不能改写；需要更正请新增一条说明。',
  vcr_followup_kind_unknown: '随访类型只能是常规诊疗观察、研究专属随访或出组后观察。',
  vcr_restricted_field_not_marked: '试验期间受限的字段要标明缺失原因，不能留空。',
  vcr_site_not_found: '找不到这个中心。',
  vcr_model_exists: '这个名字和版本的模型已经存在；换一个名字或版本。',
  // The module's own health (an operator reads these).
  vcr_migration_failed: '虚拟临研的数据表升级失败，模块已停用；请联系管理员。',
  vcr_loop_failed: '虚拟临研的后台循环出错，已记录并会重试。',
  vcr_orchestrator_failed: '虚拟临研的自动编排出错，已记录并会重试。',
  vcr_worker_loop_missing: '虚拟临研的后台循环没有启动；请联系管理员。',
  vcr_worker_loop_failing: '虚拟临研的后台循环在反复出错；请联系管理员。',
  vcr_worker_loop_stalled: '虚拟临研的后台循环停住了；请联系管理员。',
  // The protocol's issues that a person or a model is told by name.
  rule_expression_forbidden: '规则里不能写表达式：入排、筛选和约束都要用封闭语法的规则对象，平台从不把它当代码执行。',
  rule_op_unknown: '规则用了封闭语法里没有的运算；可用 all、any、not、compare、between、in、not_in、missing、present。',
  rule_column_unknown: '规则里用了数据表里没有的列；核对列名。',
  rule_too_deep: '规则嵌套太深（最多 8 层）；拆成几条更简单的规则。',
  rule_too_large: '规则太大（最多 200 个节点）；拆成几条更简单的规则。',
  rule_shape_invalid: '规则的结构不符合封闭语法，位置见提示。',
  endpoint_not_supported: '这个方法不处理这种终点类型。',
  design_not_supported: '引擎没有实现这种设计和终点的组合；已拒绝，不会当成别的设计去算。',
  kind_method_mismatch: '这项计算的类型和它要用的方法对不上；已拒绝。',
  input_location_forbidden: '输入的存放位置、哈希和形态只能由平台从数据快照解析，不接受调用方给出。',
  vcr_action_invalid: '起点只能是自动，或人群、虚拟患者、对照、试验之一。',
  vcr_criterion_state_invalid: '条件的判定只能是满足、不满足、未知或待复评。',
  vcr_snapshot_withheld: '这个快照的数据表对你都不可见（封存、未授权或含标识列），没有交给计算。',
  vcr_document_not_found: '这份病历文档不属于本研究，或已不存在。',
  vcr_data_file_name_invalid: '文件名缺失或没有扩展名。',
  vcr_data_file_too_large: '文件超过了本部署允许的上传大小。',
  vcr_data_file_unreadable: '文件读不成一张表（列名重复、编码不对或不是表格）。',
  vcr_data_format_unsupported: '这种文件格式暂不支持上传；请导出为 CSV、TSV、XLSX 或 JSON。',
  vcr_source_file_not_found: '这个数据文件不存在或已删除。',
  vcr_source_file_frozen: '这个文件已被冻结进快照，不能删除。',
  vcr_source_file_changed: '文件内容与上传时记录的哈希不一致，已拒绝使用。',
  vcr_field_map_invalid: '字段映射有问题，详情见各列的提示。',
  vcr_field_map_changed: '字段映射在你确认之后又改过了；请重新确认。',
  vcr_field_map_unconfirmed: '冻结快照前需要先确认字段映射。',
  vcr_snapshot_no_tables: '这个快照还没有派生出分析表。',
  vcr_snapshot_profile_timeout: '数据画像超时了；文件可能太大。',
  vcr_snapshot_profile_too_large: '数据画像的结果超过了上限。',
  vcr_grant_invalid: '授权的内容不完整或不合法。',
  vcr_grant_not_found: '这条授权不存在。',
  vcr_grant_owner_only: '只有登记这个数据源的账号可以授权。',
  vcr_asof_invalid: '判定时点不是一个合法的日期。',
  vcr_assessment_not_found: '这个评估不属于本研究。',
  vcr_criteria_missing: '方案还没有结构化的入排条件，无法匹配。',
  vcr_pool_endpoint_key_required: '汇总证据需要指明终点。',
  vcr_precedent_not_in_study: '这个先例不在本研究的证据里。',
  vcr_protocol_version_not_found: '这个方案版本不存在。',
  vcr_assessment_save_failed: '匹配评估没有保存成功，下一轮会重试。',
  vcr_evaluation_failed: '匹配判定在这位受试者上出错，其余照常。',
  vcr_recheck_failed: '到期复评没有完成，下一轮会重试。',
  vcr_referral_create_failed: '转诊记录没有生成成功，下一轮会重试。',
  vcr_derived_table_missing: '这项计算需要的派生数据表不存在。',
  vcr_derived_table_unsupported: '这种派生数据表不能作为这项计算的输入。',
  vcr_engine_table_invalid: '统计引擎返回的数据表与它的记录对不上，已拒绝。',
  vcr_job_attempts_exhausted: '这项计算已重试到上限，不再重跑。',
  vcr_object_unknown: '研究里没有这个对象。',
  vcr_scenario_endpoint_missing: '情景没有写明终点类型。',
  vcr_scenario_grid_empty: '方案网格里没有可比较的设计或真值。',
  vcr_scenario_unknown_fields: '情景里有这项计算不读取的字段，已拒绝。',
  vcr_model_not_applicable: '这个模型的适用范围没有覆盖当前研究（终点、变量或取值范围不符）；未排队计算，换一个适用的模型或补齐条件。',
  constraint_unsatisfiable: '人群的约束条件在重抽 200 轮后仍无法同时满足；放宽或改写约束。',
  cpu_budget_exhausted: '这项计算用完了它的计算时间上限；已完成的部分作为有限结果保留。',
  grid_cell_failed: '方案网格里有一个格子没有算出来；其余格子照常给出。',
  handler_error: '统计引擎在这项计算里遇到了意外错误，没有给出任何数字。',
  input_format_unsupported: '数据文件的格式不受支持（支持 CSV、TSV、JSON、Parquet）。',
  input_hash_mismatch: '数据文件的内容和冻结快照时的哈希对不上；已拒绝读取。',
  input_out_of_range: '有一个输入值超出了这个方法允许的范围。',
  input_parse_failed: '数据文件无法解析成表格。',
  input_too_large: '数据文件超过了引擎允许读取的大小。',
  job_invalid: '这项计算不符合引擎协议，已拒绝，没有运行。',
  mechanistic_engine_unknown: '机制模型声明的计算引擎不在支持列表里。',
  mechanistic_field_missing: '机制模型缺少必需的字段。',
  missing_covariate: '有效应的协变量存在缺失值或不是数值；补齐或去掉这个协变量。',
  model_card_field_missing: '模型卡缺少必需的字段。',
  model_risk_unknown: '模型卡的风险等级不在词表里。',
  performance_measure_unsupported: '有一个性能指标这个方法算不出来，已略过。',
  replicates_all_failed: '仿真的每一次重复都失败了，没有可报告的结果。',
  required_field_missing: '缺少必需的字段。',
  twin_label_inconsistent: '「数字孪生」标签与模型的证据不一致，已拒绝。',
  uncertainty_and_variability_conflated: '模型把参数不确定性和个体变异混在了一起；分开声明。',
  input_source_not_individual: '这个方法只接受观察到的真实患者数据，不接受合成、汇总、预测或重建的数据。',
  scenario_field_unknown: '情景里有引擎不读取的键，已拒绝——被忽略的参数等于悄悄改了参数；删掉它，或核对拼写。',
  scenario_field_missing: '情景里缺少这个方法必需的键，位置见提示。',
  scenario_value_invalid: '情景里这个值的类型或范围不对，位置见提示。',
  runtime_canceled: '运行已被取消。可以重新发起，或从某一步分叉后继续。',
  runtime_stopped: '运行进程中断，已按中断记录收尾。重试即可继续。',
  runtime_deliverable_never_submitted:
    '运行已经写出交付文件，但没有提交校验就结束了，因此没有通过质量门、也没有可交付的成果。'
    + '文件仍在工作区里，可以重新发起让它提交；未经校验的文件不会被当作交付物。',
  runtime_session_error: '模型调用失败。稍后重试；若反复出现请缩小题面范围。',
  runtime_spend_limit_reached: '模型调用被用量上限拒绝：这次运行或账户的花费已到上限，已经写出的文件仍在工作区里。可在“设置 → 用量”查看已用与上限，上限恢复或调高后再继续。',
  runtime_session_not_found: '运行时还没有这个会话，因此它还没有产生任何记录。',
  // Was 「查看运行树中标红的节点」. The run tree is not on the router — it lives
  // under an unreachable page — so the sentence sent the reader to a screen
  // that does not exist. Say what is true and reachable instead.
  runtime_tool_error: '一次工具调用被拒绝或失败，运行没能继续。这不是对成果的质量判断；已经写出的文件仍在工作区里，可以重试或把题面缩小一些。',
  runtime_turn_end_unknown: '运行以本版本未知的方式结束，已记录待排查。',
  runtime_history_unavailable: '暂时无法读取会话内容，这不代表运行没有进展，请稍后刷新。',
  runtime_status_unavailable: '暂时读不到运行状态，稍后刷新。',
  runtime_event_stream_unavailable: '实时事件流断开，正在重连。',
  runtime_wire_protocol_mismatch: '运行时协议与控制面不一致，请联系管理员升级。',
  runtime_seam_missing: '运行时缺少必需组件，已拒绝启动。',
  runtime_sandbox_unavailable: '运行时沙箱不可用，命令执行已整体关闭。',
  runtime_preset_unavailable: '运行时的统一组合未装载，已拒绝启动。',
  runtime_bundle_version_mismatch: '运行时插座版本与镜像声明不一致。',
  runtime_domain_version_mismatch: '运行时与控制面的契约版本不一致。',
  deliverable_rejected: '交付物未通过契约校验，已列出必修项。',
  deliverable_json_unparseable: '交付包里的 JSON 文件无法解析，下游读不到它写的内容。',
  cited_source_unretrieved: '报告链接的来源只出现在运行自己写的证据快照里，本次运行的检索工具没有取回过它。',
  citation_plain_http: '报告里有引用使用未加密的 http 链接；来源可以打开，结论不受影响，出版方提供 https 地址时换用即可。',
  deliverable_run_receipt_shape: '引擎运行回执缺少必要字段（作业 id、终态、产物清单）。',
  deliverable_run_receipt_unbound: '引擎运行回执没有作业 id，交付包无法与产生它的那次引擎运行对上。',
  deliverable_run_artifact_missing: '运行回执点名的产物不在交付包里。',
  deliverable_table_shape: '交付的表件列数与表头不一致，无法作为表加载。',
  deliverable_run_degraded: '引擎完成了，但有步骤没做成；读者需要知道是哪几步。',
  deliverable_unknown: '计划里没有这件交付物。',
  deliverable_dependency_pending: '这件交付物依赖的产物还没通过。',
  deliverable_attempts_spent: '这件交付物的提交次数已经用完，已写出的文件会按未核验交付。',
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
  // No local agent ships, and none is planned: the connector id stayed a
  // constant nothing registers, and the page that advertised it was corrected
  // on 2026-09-07. This sentence was the last place still sending a researcher
  // to look for it.
  source_too_large: '文件超过单次上传上限。请拆分后再传，或把它放进已接入的资料目录由知识库导入。',
  source_duplicate: '这份资料已经存在。',
  source_missing: '原始库里找不到这份资料了，派生内容已保留。',
  credits_exhausted: '额度已用尽，充值后即可继续。',
  credits_daily_limit_reached: '今日额度上限已到，这次请求没有开始。窗口重置后自动恢复，也可以在“设置 → 用量”调高上限。',
  credits_weekly_limit_reached: '本周额度上限已到，这次请求没有开始。下一个计费周期自动恢复，也可以在“设置 → 用量”调高上限。',
  // 灵豆 settlement (fusion plan §9.6). A deployment that has not joined
  // EviMed's billing shows no balance at all, so the first of these is normally
  // read by a client that asked anyway rather than by a person.
  evimed_credits_not_enabled: '这个部署还没有接入灵豆计费，因此没有余额和预计消耗可看。',
  evimed_credits_request_invalid: '这次查询的参数不对，没有得到预计消耗。换一个科研工具再看即可。',
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
    '运行连续很长时间没有产生新的消息或工具调用，已按“无进展”中断收尾。'
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
  runtime_prompt_lost:
    '这次提问没有送达运行时：等了很久，运行时的记录里始终没有它，任务从未开始。'
    + '这不是质量问题，也没有产出任何内容；稍后重试即可。',
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
    '这份成果里有一部分证据是分工子任务读取的，主运行没有亲自核对，因此标注为“未完成核验”。'
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
    '临床实践要点把“就医／急救”的触发条件写成了取决于用药后的反应，这在安全上不成立：就医指征必须是无条件的。'
    + '这是必须改的一处，其余成果都在。',
  regulatory_article_without_official_source:
    '报告以条款级方式引用了法规，却没有给出官方出处，不能这样发布。补上官方文件的出处，或把表述降为概述即可。',
  'declared-appraisal-must-execute':
    '报告声明做了证据分级，但 GRADE 等级与降级理由不自洽，等于分级没有真正执行。补齐或订正分级理由即可。',

  // ——— Refusals a person meets before anything runs ———
  usage_budget_exceeded: '这次请求会超出账户设定的用量上限，因此没有开始，也没有产生费用。可在“设置 → 用量”查看已用与上限。',
  runtime_reserved_for_autopilot:
    '这个项目的运行时正在执行你自己设定的主动研究任务，暂时不接受交互提问。'
    + '等这一轮结束后即可继续，或在“主动研究”里先暂停它。',
  runtime_busy: '这个项目的运行时正被另一次任务占用，稍后会自动重试。',
  runtime_cleanup_required: '上一次任务的运行环境尚未关闭，清理完成后可继续研究。',
  runtime_limit_exceeded: '运行时的并发或用量上限已到，这次请求没有被受理。稍后重试。',
  agent_run_active: '这个研究会话已经有一次运行在进行中。等它结束，或先取消它，再发起新的。',
  agent_run_limit_reached: '这个项目同时进行的研究运行已达上限。等其中一次结束后再发起。',
  project_limit_reached: '这个账户的项目数已达上限。每个项目都有独立的存储空间和研究运行时，上限用来保证服务器资源够用。可以先导出并删除不再需要的项目，再新建。',
  default_project_protected: '“我的研究”是账户的默认项目，不能归档或删除。可以改名，或把不再需要的内容移到别的项目。',

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

  // ——— Knowledge-base intake: what a source card and an upload refusal say ———
  // The in-house parser's refusals reach a researcher on the source card, and
  // three of them (413, 415, 422) are final on the first answer, so each says
  // what to do instead of only that it failed.
  source_format_unsupported:
    '这种文件格式还不能解析。支持 PDF、Word、PPT、Excel、图片（jpg、png、bmp、gif）、EPUB、MOBI、HTML、RTF 和纯文本类文件（txt、md、csv、json 等）。',
  source_media_unsupported: '音频和视频暂时不能入库：文档解析服务还不能转写录音和视频。可以上传讲稿或逐字稿。',
  source_parser_payload_too_large: '文件超过文档解析服务 100 MB 的上限，拆分后再上传即可。',
  source_parser_input_too_large: '文件超过可解析的大小上限，拆分后再上传即可。',
  source_parser_checksum_failed: '文件在传给解析服务的途中发生了变化，校验没有通过；重新分析一次即可。',
  source_parser_auth_failed: '文档解析服务没有接受本平台的密钥，需要管理员配置解析服务密钥；纯文本类资料不受影响。',
  source_parser_quota_exhausted: '文档解析服务的可用额度已经用完，需要管理员补充额度后再重新分析。',
  source_parser_rate_limited: '文档解析服务这会儿请求太多，稍后再重新分析。',
  source_parser_unavailable: '文档解析服务暂时连不上，稍后再重新分析。',
  source_parser_timeout: '文档解析超时了。文件很大时可以拆分后再上传。',
  source_parser_internal_error: '文档解析服务这次内部出错，稍后再重新分析。',
  source_parser_upstream_error: '文档解析服务依赖的识别服务这次没有给出结果，稍后再重新分析。',
  source_parser_unconfigured: '这个部署还没有配置文档解析服务，目前只能解析纯文本类资料。',
  source_parser_rejected: '文档解析服务拒绝了这份文件；请确认文件完整、扩展名与内容一致后重新上传。',
  source_parser_response_invalid: '文档解析服务返回的结果无法使用，稍后再重新分析。',
  source_parser_response_too_large: '这份文件解析出的正文超过了可保存的上限，拆分后再上传即可。',
  source_changed: '文件在登记之后被改动过；刷新知识库后再分析。',
  openlist_storage_missing: '这个账户还没有接入网盘，无法从网盘导入。可以先直接上传文件。',
  openlist_credential_rejected: '网盘服务没有接受这个部署的凭据，暂时无法浏览网盘。请联系管理员。',
  library_unavailable: '个人资料库暂时不可用，稍后再试。',
  library_payload_invalid: '资料库请求的内容不完整，刷新页面后再试。',
  library_source_invalid: '没有找到这份资料，刷新知识库后再试。',
  library_item_not_found: '这份资料不在个人资料库里。',
  library_full: '个人资料库已满。先移出不再需要的资料，再加入新的。',
  library_source_removed: '这份资料在各个项目里都已删除，它的资料理解结果也随之删除，没有可以发布到记忆胶囊的内容；资料库里的正文副本仍然可以阅读和检索。',
  library_understanding_missing: '这份资料还没有资料理解结果。分析深度为“结构化”或“深度”的资料理解完成后，才能发布到记忆胶囊。',
  library_capsule_unavailable: '账户的主要胶囊是别人分享来的，资料只会写进你自己的胶囊。先把自己的胶囊设为主要胶囊，再发布。',
  library_publish_busy: '资料库正有一次发布到记忆胶囊的操作在进行，等它完成后再试。',
  capsule_export_empty: '还没有可以分享的内容：学到做法，或在对话里说明你的工作方式之后，就可以分享了。',
  capsule_recipient_unknown: '要分享给的账号不在这个平台上，请核对账号名。',
  capsule_password_required: '这个胶囊需要发送者设定的口令才能打开。',
  method_no_earlier_version: '这个做法没有更早的版本。',
  method_revision_unavailable: '要回到的版本已不存在，刷新后再试。',

  // ——— Tool-boundary codes that have no family and would otherwise be bare ———
  tool_disabled: '这个部署没有开放这项工具，运行会绕开它继续。',
  unknown_tool: '调用了一个不存在的工具。',
  invalid_input: '这次工具调用的参数不符合要求。',
  engine_execution_context_invalid: '这次计算的执行设置无法确认，尚未启动。',
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
  [/^web_read_/, '这个网页这次读不到。报告会把它记为限制，运行会改用其他来源。'],
  [/^web_render_/, '这个网页需要浏览器打开，云端浏览器这次没能打开它；运行会改用其他来源。'],
  [/^source_parser_/, '文档解析服务这次没能把这份文件转成文字。'],
  [/^source_format_/, '这种文件格式无法转成文字。'],
  [/^public_source_/, '公共数据源这次没能给出结果。'],
  [/^pubtator_/, '关系式检索的概念标识或关系类型不对，用 term_normalize 的 annotate 取一次标识再试。'],
  [/^web_search_/, '网页检索这次没能完成。'],
  [/^adapter_/, '专有数据接口这次没能给出结果。'],
  // Added because 64 codes matched no family and no entry, so they rendered as
  // a bare English identifier in a Simplified-Chinese interface. They are
  // tool-boundary codes a run handles internally, which is why they get a
  // family and not 64 sentences: a table that size is the table nobody keeps
  // current, which is the failure the family mechanism exists to prevent.
  [/^geo_probe_/, '生成式检索的可见度探测这次没能完成，报告会把它记为限制。'],
  // 「循证 GEO」's runtime tools, then its routes. The tool family comes first:
  // a run reading the platform's data has a different next step (go on with
  // what it has) from a person whose page action was refused (try again).
  [/^(?:geo_(?:disabled$|no_project$|unconfigured$|gateway_|upstream_|response_|request_|read_|write_)|social_posts_)/,
    '循证 GEO 的项目数据这次没能读写；运行会如实记下这一点，用已有的资料继续。'],
  [/^geo_(?!probe_)/, '循证 GEO 这次没能完成这个操作，稍后再试。'],
  // 「虚拟临研」, read the same way and for the same reason: a run whose study
  // data could not be read carries on with what it has, and a person whose
  // page action was refused tries again. The engine family is separate — a
  // computation that could not run is not a study that could not be read, and
  // the study's other steps are unaffected (plan §10.5).
  [/^vcr_(?:disabled$|no_study$|gateway_|request_|read_|write_|simulate_)/,
    '虚拟临研的研究数据这次没能读写；运行会如实记下这一点，用已有的资料继续。'],
  [/^(?:vcr_engine_|engine_unavailable$)/, '确定性计算引擎这次不可用；这一步暂不可用，研究的其余部分照常。'],
  [/^vcr_/, '虚拟临研这次没能完成这个操作，稍后再试。'],
  [/^registry_unavailable$/, '试验登记库这次取不到记录；运行会如实记下，不会编造登记信息。'],
  [/^science_connector_/, '科学数据连接器这次没能给出结果。'],
  [/^mr_input_/, '孟德尔随机化的本地输入需要更正后才能继续。'],
  [/^mr_open_/, 'GWAS Catalog 的公开汇总数据这次没能用于孟德尔随机化；报告会写明缺了什么，或改用其他研究。'],
  [/^pharmacy_reference_/, '药学参考数据这次没能给出结果。'],
  [/^drug_label_/, '药品说明书库这次没能给出结果；可以改用其他说明书来源继续。'],
  [/^quote_/, '引文核对这次没能完成；这只是一次查找，已写的报告不受影响。'],
  [/^evimed_evidence_/, '专有证据接口这次没能给出结果。'],
  [/^invalid_assessment/, '这次评估请求的格式不符合要求。'],
  [/^verification_/, '独立复核这次没能给出结论。原来的结论未被推翻。'],
  // The specific family comes first: matching is in order, and an evidence
  // defect is not an engine failure — telling a reader to retry it would send
  // them to the wrong place.
  [/^specialist_evidence_/, '交付物的证据链有缺口，运行会被退回修复。'],
  [/^(meta|specialist)_/, '专科引擎这次没能完成，稍后重试或缩小范围。'],
  [/^runtime_/, '运行时出现问题，稍后重试。'],
  [/^credits_/, '额度不足或已达上限。'],
  // A parser code this build has no exact sentence for still says what failed
  // and what the card's own button does about it.
  [/^source_parser_/, '文档解析这次没有完成，稍后再重新分析。'],
  [/^kb_search_/, '资料库检索这次没能完成；运行会直接读取知识库里的文件继续。'],
  [/^frontier_(?:disabled$|search_)/, '前沿动态检索这次没能完成；回答会改用文献、指南和监管来源继续。'],
  // The engine protocol's per-field issues (`VCR_PROTOCOL_ISSUE_CODES`), last so
  // no earlier family can take one of them. Three families, because each is
  // held by a different hand: the request a run or a page built, the inputs
  // named in it, and what the engine sent back.
  [/^(?:scenario_|rule_|endpoint_|design_|job_|study_id_|protocol_version_|kind_|method_version_|method_unknown$|seed_invalid$|replicates_|cpu_limit_|cores_|batch_size_|inputs_missing$)/,
    '这项计算的请求不符合引擎协议，已拒绝；按提示的字段修改后再提交。'],
  [/^(?:input_|patient_input_|snapshot_required$)/,
    '这项计算的输入不符合要求，已拒绝；数据只能通过研究里已授权的数据快照给出。'],
  [/^(?:result_|status_unknown$|conclusion_|not_estimable_rule_|measure|mcse_|interval_|table_invalid$|model_(?:tier|risk)_|manifest_|cpu_seconds_|package_lock_|output_hash_|counts_not_|count_invalid$|ess_above_)/,
    '计算引擎返回的结果没有通过协议校验，这次结果没有采用；可以重新计算。'],
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
  runtime_cleanup_required: 'capped',
  runtime_limit_exceeded: 'capped',
  agent_run_active: 'capped',
  agent_run_limit_reached: 'capped',
  project_limit_reached: 'capped',
  default_project_protected: 'capped',
  usage_budget_exceeded: 'capped',
  runtime_spend_limit_reached: 'capped',
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
  // The 灵豆 routes' own refusals are about the module, never about a run: one
  // says the deployment has no credits billing, the other that the question was
  // malformed. Neither is a ceiling — the ceiling is `credits_exhausted`.
  evimed_credits_not_enabled: 'upstream',
  evimed_credits_request_invalid: 'upstream',
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
  // A parse that failed or a format that was refused happened at the source
  // boundary; nothing about it is a verdict on anyone's work.
  if (sourceIntakeErrorCodes.includes(text)) return 'upstream'
  // The library's refusals are about the library, never about a run: a full
  // library and a publication already running are ceilings, and everything
  // else names a document that is not there to act on.
  if (text === 'library_full' || text === 'library_publish_busy') return 'capped'
  if (libraryErrorCodes.includes(text)) return 'upstream'
  // Sharing a capsule refuses for what the pack holds or who it is for —
  // nothing to share yet, an account that is not here, a missing password —
  // never as a verdict on a run.
  if (capsuleTransferErrorCodes.includes(text)) return 'upstream'
  // 循证 GEO's page refusals are about the module and what it holds — a
  // project, a round, an order that is not there to act on, a worker not yet
  // composed — never a verdict on a run.
  if (Object.hasOwn(DOCUMENT_EXPORT_ERROR_MESSAGES, text)) return 'upstream'
  if (GEO_ROUTE_ERROR_CODES.includes(text)) return 'upstream'
  if (VCR_ROUTE_ERROR_CODES.includes(text) || VCR_GATEWAY_ERROR_CODES.includes(text)) return 'upstream'
  // The rest of the module's codes and the protocol's per-field issues are about
  // the module, the engine channel or the shape of a computation's request —
  // never a verdict on a run.
  if (VCR_WRITE_ISSUE_CODES.includes(text) || VCR_MODULE_ERROR_CODES.includes(text) || VCR_PROTOCOL_ISSUE_CODES.includes(text)
    || VCR_ENGINE_ISSUE_CODES.includes(text)) return 'upstream'
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
