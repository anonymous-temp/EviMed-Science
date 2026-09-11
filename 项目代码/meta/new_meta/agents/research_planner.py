"""Research Planner agent — converts natural language question to PICO + research protocol."""

import json
from new_meta.core.agent_base import BaseAgent
from new_meta.core.method_planning import (
    ProtocolInputRequired, method_catalogue, normalize_protocol_method_fields,
    validate_protocol_method,
)
from new_meta.core.method_registry import MethodInputError
from new_meta.core.llm import LLMOutputError, parse_source_json
from new_meta.core.primary_analysis_alignment import digest
from new_meta.core.protocol_scope import (
    protocol_hash, scope_fields, scope_receipt,
)
from new_meta.core.protocol_scope_sources import (
    SOURCE_ASSESSOR, SCOPE_BATCH_SIZE, compose_scope_batch, evaluate_scope_references,
    source_catalogue, source_prompt_catalogue, scope_source_provenance,
    validate_scope_source_provenance,
)
from new_meta.schemas.protocol import ProtocolScopeAssessment, ProtocolScopeReferenceEnvelope
from pydantic import ValidationError
from new_meta.schemas.protocol import ResearchProtocol, PICO
from new_meta.prompts import planner_prompts


SCOPE_DIAGNOSTIC_MAX_ATTEMPTS = 32
SCOPE_DIAGNOSTIC_MAX_BYTES = 256 * 1024
SCOPE_ASSESSMENT_MAX_BYTES = 64 * 1024
_UNOBSERVED = object()


class _ScopeDiagnostics:
    """Bound typed checker evidence, without retaining provider response objects."""

    def __init__(self):
        self.attempts = []
        self.omitted = 0

    def add(self, record, *, reference_response=_UNOBSERVED, resolved_assessment=_UNOBSERVED, raw_content=_UNOBSERVED):
        for key, assessment in (("reference_response", reference_response), ("resolved_assessment", resolved_assessment)):
            if assessment is _UNOBSERVED:
                continue
            payload = assessment.model_dump(mode="json") if hasattr(assessment, "model_dump") else assessment
            encoded = json.dumps(payload, ensure_ascii=False).encode()
            record[key + "_sha256"] = digest(payload)
            record[key + "_size_bytes"] = len(encoded)
            if len(encoded) <= SCOPE_ASSESSMENT_MAX_BYTES:
                record[key] = payload
            else:
                record[key + "_omitted"] = "diagnostic_size_limit"
        if raw_content is not _UNOBSERVED:
            encoded = raw_content.encode() if isinstance(raw_content, str) else b"" if raw_content is None else json.dumps(raw_content).encode()
            record["raw_sha256"] = digest(raw_content)
            record["raw_size_bytes"] = len(encoded)
            if len(encoded) <= SCOPE_ASSESSMENT_MAX_BYTES:
                record["raw_content"] = raw_content
            else:
                record["raw_content_omitted"] = "diagnostic_size_limit"
        self.attempts.append(record)
        while (len(self.attempts) > SCOPE_DIAGNOSTIC_MAX_ATTEMPTS
               or len(json.dumps(self.attempts, ensure_ascii=False).encode()) > SCOPE_DIAGNOSTIC_MAX_BYTES):
            self.attempts.pop(0)
            self.omitted += 1

    def collect(self, error):
        data = error.phase.data if isinstance(error, ProtocolInputRequired) else getattr(error, "scope_check_data", {})
        self.omitted += data.get("scope_check_attempts_omitted", 0)
        for record in data.get("scope_check_attempts", []):
            self.add(record)

    def attach(self, error):
        if isinstance(error, ProtocolInputRequired):
            data = error.phase.data
        else:
            data = error.scope_check_data = {}
        data["scope_check_attempts"] = list(self.attempts)
        if self.omitted:
            data["scope_check_attempts_omitted"] = self.omitted
        return error


def _correction_feedback(error):
    """Replanning needs actionable conflicts, not accumulated checker quotations."""
    feedback = {"error_code": error.phase.error_code, "summary": error.phase.summary[:1600]}
    findings = [finding for issue in error.phase.issues
                for finding in issue.context.get("scope_findings", [])]
    if findings:
        feedback["scope_findings"] = [
            {key: str(finding.get(key, ""))[:1000] for key in ("field", "status", "basis", "rationale")}
            for finding in findings[:16]
        ]
        if len(findings) > 16:
            feedback["additional_findings"] = len(findings) - 16
    return json.dumps(feedback, ensure_ascii=False)


class ResearchPlanner(BaseAgent):
    def __init__(self, model: str = None):
        super().__init__("research_planner", planner_prompts.SYSTEM_PROMPT, model=model)

    def run(self, question: str) -> ResearchProtocol:
        """Plan and independently check scope within the existing bounded attempts."""
        prompt = planner_prompts.PICO_EXTRACTION_PROMPT.format(
            question=question, method_catalogue=json.dumps(method_catalogue(), ensure_ascii=False))
        return self._plan(question, prompt)

    def _plan(self, question, prompt):
        original_prompt = prompt
        last_error = None
        scope_diagnostics = _ScopeDiagnostics()
        for attempt in range(3):
            protocol = None
            try:
                protocol = self.call_llm_structured(prompt, ResearchProtocol, max_tokens=8192)
                self._normalize_supported_databases(protocol)
                self._apply_effect_measure_rules(protocol, question)
                normalize_protocol_method_fields(protocol)
                validate_protocol_method(protocol)
                protocol._scope_receipt = self.check_scope(question, protocol)
                self.log(f"Protocol generated — PICO: P={protocol.pico.population}, "
                         f"I={protocol.pico.intervention}, C={protocol.pico.comparator}, "
                         f"O={protocol.pico.outcome_primary}")
                return protocol
            except MethodInputError as exc:
                last_error = ProtocolInputRequired(str(exc), context=exc.context, protocol=protocol)
            except ProtocolInputRequired as exc:
                last_error = exc
                exc.phase.data["original_question"] = question
                scope_diagnostics.collect(exc)
                scope_diagnostics.attach(exc)
                if exc.phase.error_code == "protocol_scope_unverified":
                    # An invalid checker response is not evidence of proposal drift.
                    raise
            except Exception as exc:
                # Provider/internal faults retain their failure semantics.
                last_error = exc
                scope_diagnostics.collect(exc)
                scope_diagnostics.attach(exc)
                self.log(f"PICO extraction attempt {attempt + 1} failed: {exc}", level="warning")
                continue
            last_error.phase.data["original_question"] = question
            scope_diagnostics.attach(last_error)
            self.log(f"PICO proposal attempt {attempt + 1} requires correction: {last_error}", level="warning")
            prompt = original_prompt + "\n\nValidation feedback (not new user intent):\n" + _correction_feedback(last_error)
            prompt += ("\nRepair only representation or scope drift relative to the ORIGINAL question. "
                       "Never drop unsupported requested designs or other explicit requirements to pass validation.")
        if isinstance(last_error, ProtocolInputRequired):
            raise last_error
        raise scope_diagnostics.attach(RuntimeError(f"PICO extraction failed after 3 attempts: {last_error}")) from last_error

    def check_scope(self, question, protocol):
        """Observe every provider response before any retry can replace a judgment."""
        snapshot = ResearchProtocol.model_validate(protocol.model_dump())
        snapshot_hash = protocol_hash(snapshot)
        topic_hash = digest(question)
        catalogue = source_catalogue(question, snapshot)
        catalogue_hash = digest(catalogue)
        inventory = list(scope_fields(snapshot).items())
        diagnostics = _ScopeDiagnostics()
        verified = []
        responses = []
        field_origins = {}

        def unverified(message):
            return diagnostics.attach(ProtocolInputRequired(
                "Independent scope assessment is incomplete or unanchored: " + message,
                code="protocol_scope_unverified", protocol=protocol))

        for offset in range(0, len(inventory), SCOPE_BATCH_SIZE):
            batch = dict(inventory[offset:offset + SCOPE_BATCH_SIZE])
            batch_number = offset // SCOPE_BATCH_SIZE + 1
            original_prompt = planner_prompts.SCOPE_CHECK_PROMPT.format(
                question=question, protocol=snapshot.model_dump_json(indent=2),
                sources=json.dumps(source_prompt_catalogue(question, catalogue), ensure_ascii=False),
                field_count=len(batch),
                fields=json.dumps(batch, ensure_ascii=False))
            prompt = original_prompt
            retained_conflicts = {}
            retained_origins = {}
            for attempt in range(1, 3):
                state = {"count": 0}

                def observe(observation):
                    content = observation["content"]
                    ordinal = observation["provider_response_ordinal"]
                    finish_reason = observation["finish_reason"]
                    origin = {"batch": batch_number, "attempt": attempt, "provider_response_ordinal": ordinal}
                    provider_record = {**origin, "finish_reason": finish_reason,
                                       "raw_content": content, "raw_sha256": digest(content)}
                    responses.append(provider_record)
                    record = {**origin, "finish_reason": finish_reason, "expected_fields": list(batch),
                              "topic_sha256": topic_hash, "protocol_sha256": snapshot_hash,
                              "catalogue_version": catalogue["version"], "catalogue_sha256": catalogue_hash}
                    payload = _UNOBSERVED
                    evaluated = None
                    reason = {"code": "scope_observer_failed", "message": "The provider response could not be verified."}
                    try:
                        if type(ordinal) is not int or ordinal != state["count"] + 1:
                            raise LLMOutputError("Scope provider response ordinal is invalid")
                        state["count"] += 1
                        if content is None or (isinstance(content, str) and not content.strip()):
                            provider_record["response_unavailable"] = "missing_content" if content is None else "empty_content"
                            record["response_unavailable"] = provider_record["response_unavailable"]
                            reason = {"code": "scope_response_missing_content", "message": "The provider response contained no assessment text."}
                            state.update(reason=reason, provider_record=provider_record)
                            return
                        try:
                            payload = parse_source_json(content)
                        except (ValueError, TypeError) as exc:
                            reason = {"code": "scope_source_json_invalid", "message": "The exact source response is not unambiguous valid JSON."}
                            raise LLMOutputError(reason["message"]) from exc
                        provider_record.update(response=payload, response_sha256=digest(payload))
                        if protocol_hash(protocol) != snapshot_hash:
                            reason = {"code": "protocol_scope_proposal_changed", "message": "Protocol changed during independent scope assessment"}
                            raise LLMOutputError(reason["message"])
                        evaluated = evaluate_scope_references(question, catalogue, payload, batch)
                        for field, judgment in evaluated.conflicts.items():
                            if field not in retained_conflicts:
                                retained_conflicts[field] = judgment
                                retained_origins[field] = dict(origin)
                        reason = evaluated.reason
                        if reason is None and finish_reason not in {"stop", "completed"}:
                            reason = {"code": "scope_response_incomplete", "message": "A completed provider response is required."}
                        if reason is None:
                            composed, origins = compose_scope_batch(
                                question, evaluated.resolved, retained_conflicts, batch, batch_number,
                                attempt, ordinal, retained_origins)
                            record["field_origins"] = origins
                            retained = [field for field in retained_conflicts if retained_origins[field] != origin]
                            if retained:
                                record["retained_nonmatch_fields"] = retained
                            state.update(composed=composed, origins=origins)
                        state.update(reason=reason, provider_record=provider_record)
                    finally:
                        record["validation"] = reason or {"code": "scope_batch_verified"}
                        record["source_metadata"] = evaluated.source_metadata if evaluated is not None else []
                        diagnostics.add(record, raw_content=content, reference_response=payload,
                                        resolved_assessment=evaluated.resolved if evaluated is not None else _UNOBSERVED)

                try:
                    response = self.llm.structured_output(
                        [{"role": "system", "content": planner_prompts.SCOPE_CHECK_SYSTEM},
                         {"role": "user", "content": prompt}],
                        ProtocolScopeReferenceEnvelope, max_tokens=16384,
                        source_faithful=True, on_raw_response=observe)
                except LLMOutputError as exc:
                    message = diagnostics.attempts[-1].get("validation", {}).get("message") if diagnostics.attempts else None
                    raise unverified(message or "An actual provider response could not be observed or verified.") from exc
                except ValueError as exc:
                    if isinstance(exc, ValidationError) or isinstance(exc.__cause__, (ValidationError, json.JSONDecodeError)):
                        raise unverified("The observed source response did not have the required envelope.") from exc
                    raise diagnostics.attach(exc)
                except Exception as exc:
                    raise diagnostics.attach(exc)
                if not state["count"] or "provider_record" not in state:
                    diagnostics.add({"batch": batch_number, "attempt": attempt, "topic_sha256": topic_hash,
                        "protocol_sha256": snapshot_hash, "validation": {"code": "scope_response_unobserved"}})
                    raise unverified("No actual provider response was observed.")
                payload = response.model_dump(mode="json") if hasattr(response, "model_dump") else response
                if digest(payload) != digest(state["provider_record"].get("response")):
                    raise unverified("The returned envelope differs from the actual observed response.")
                reason = state["reason"]
                if reason is None:
                    verified.extend(state["composed"].fields)
                    field_origins.update(state["origins"])
                    break
                if attempt == 2:
                    raise unverified(reason["message"])
                prompt = original_prompt + "\n\nChecker validation feedback:\n" + json.dumps(reason, ensure_ascii=False)
                prompt += ("\nReassess only this batch using the SAME full question and protocol above. "
                           "Correct the response format or source_id; preserve honest mismatch or uncertain judgments. "
                           "Do not change the proposed protocol or infer that validation requires a match.")
        try:
            if protocol_hash(protocol) != snapshot_hash:
                raise ValueError("Protocol changed during independent scope assessment")
            merged = ProtocolScopeAssessment(fields=verified)
            receipt = scope_receipt(question, snapshot, merged)
            provenance = scope_source_provenance(catalogue, responses, field_origins)
            validate_scope_source_provenance(question, snapshot, merged, provenance)
            receipt.update(assessor=SOURCE_ASSESSOR, source_provenance=provenance)
            return receipt
        except ProtocolInputRequired as exc:
            raise diagnostics.attach(exc)
        except (ValidationError, ValueError, TypeError) as exc:
            raise unverified(str(exc)) from exc

    def refine(self, current_protocol: ResearchProtocol, user_input: str, *, original_question: str = "") -> ResearchProtocol:
        """Refinement cannot replace the original objective; changed objectives restart."""
        if not original_question.strip():
            raise ProtocolInputRequired("The original question is required for refinement; restart with the intended question.",
                                        code="protocol_scope_original_missing", protocol=current_protocol)
        prompt = planner_prompts.PICO_REFINEMENT_PROMPT.format(
            current_protocol=current_protocol.model_dump_json(indent=2), user_input=user_input,
            question=original_question, method_catalogue=json.dumps(method_catalogue(), ensure_ascii=False))
        return self._plan(original_question, prompt)

    @staticmethod
    def _normalize_supported_databases(protocol: ResearchProtocol) -> None:
        """Keep protocol database names aligned with the implemented search stack."""
        protocol.databases = ["Internal literature database", "PubMed"]

    @staticmethod
    def _apply_effect_measure_rules(protocol: ResearchProtocol, question: str = "") -> None:
        """Use deterministic endpoint semantics for effect-measure choice.

        LLM planning can default composite cardiovascular endpoints to RR even
        when source trials report time-to-event hazard ratios. Keep ordinary
        binary mortality endpoints untouched, but force HR for explicit
        time-to-event/survival wording and HF cardiovascular death/hospitalization
        composites where the published benchmark source effect is HR.
        """
        if ResearchPlanner._endpoint_prefers_hr(protocol, question):
            protocol.effect_measure = "HR"

    @staticmethod
    def _apply_language_scope_rules(protocol: ResearchProtocol, question: str = "") -> None:
        """Do not let the planner invent a publication-language exclusion."""
        text = str(question or "").casefold()
        explicit_markers = (
            "english language",
            "english-language",
            "in english",
            "chinese language",
            "chinese-language",
            "in chinese",
            "英文文献",
            "英语文献",
            "中文文献",
            "中文发表",
            "限英文",
            "限中文",
        )
        if not any(marker in text for marker in explicit_markers):
            protocol.language = "No language restriction"

    @staticmethod
    def _endpoint_prefers_hr(protocol: ResearchProtocol, question: str = "") -> bool:
        text = " ".join([
            question or "",
            protocol.research_question or "",
            protocol.pico.outcome_primary or "",
            " ".join(protocol.pico.outcomes_secondary or []),
        ]).lower()
        explicit_time_to_event = (
            "time-to-event",
            "time to event",
            "time-to-first",
            "time to first",
            "time until",
            "hazard ratio",
            "hazard ratios",
            "survival",
            "overall survival",
            "progression-free survival",
            "event-free survival",
            "disease-free survival",
        )
        if any(marker in text for marker in explicit_time_to_event):
            return True

        death_terms = ("cardiovascular death", "cv death", "death from cardiovascular")
        hf_event_terms = (
            "hospitalization for heart failure",
            "hospitalisation for heart failure",
            "heart failure hospitalization",
            "heart failure hospitalisation",
            "worsening heart failure",
            "first hospitalization",
            "first hospitalisation",
        )
        if any(term in text for term in death_terms) and any(term in text for term in hf_event_terms):
            return True
        return False

    def get_advice(self, stage: str, count: int, protocol: ResearchProtocol) -> str:
        """Generate LLM-powered advice when results are few at a pipeline checkpoint."""
        stage_labels = {
            "search": "literature search (PubMed)",
            "ta_screening": "title/abstract screening",
            "ft_screening": "full-text screening",
        }
        stage_label = stage_labels.get(stage, stage)
        prompt = (
            f"You are a meta-analysis methodologist. A systematic review pipeline "
            f"just completed the {stage_label} stage and found only {count} result(s).\n\n"
            f"Research question: {protocol.research_question}\n"
            f"Population: {protocol.pico.population}\n"
            f"Intervention: {protocol.pico.intervention}\n"
            f"Comparator: {protocol.pico.comparator}\n"
            f"Primary outcome: {protocol.pico.outcome_primary}\n"
            f"Study design: {protocol.study_design}\n"
            f"Inclusion criteria: {'; '.join(protocol.inclusion_criteria)}\n"
            f"Exclusion criteria: {'; '.join(protocol.exclusion_criteria)}\n\n"
            f"Briefly analyze why results may be few and suggest 2-3 concrete actions "
            f"the researcher could take to improve the yield (e.g., broaden population, "
            f"add synonym terms, relax study design criteria). Be concise (3-5 sentences)."
        )
        return self.call_llm(prompt, max_tokens=512)

    @staticmethod
    def display_protocol(protocol: ResearchProtocol) -> str:
        """Format protocol for CLI display."""
        lines = [
            "=" * 60,
            "RESEARCH PROTOCOL",
            "=" * 60,
            f"Research Question: {protocol.research_question}",
            "",
            "PICO Framework:",
            f"  Population:    {protocol.pico.population}",
            f"  Intervention:  {protocol.pico.intervention}",
            f"  Comparator:    {protocol.pico.comparator}",
            f"  Primary Outcome: {protocol.pico.outcome_primary}",
        ]
        if protocol.pico.outcomes_secondary:
            lines.append(f"  Secondary:     {', '.join(protocol.pico.outcomes_secondary)}")
        lines += [
            "",
            f"Study Design: {protocol.study_design}",
            f"Effect Measure: {protocol.effect_measure}",
            f"Model: {protocol.model_preference} effects",
            "",
            "Inclusion Criteria:",
        ]
        for c in protocol.inclusion_criteria:
            lines.append(f"  + {c}")
        lines.append("Exclusion Criteria:")
        for c in protocol.exclusion_criteria:
            lines.append(f"  - {c}")
        if protocol.subgroup_variables:
            lines.append(f"\nSubgroup Variables: {', '.join(protocol.subgroup_variables)}")
        lines.append("=" * 60)
        return "\n".join(lines)
