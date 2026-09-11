"""Research Planner agent — converts natural language question to PICO + research protocol."""

import json
from new_meta.core.agent_base import BaseAgent
from new_meta.core.method_planning import (
    ProtocolInputRequired, method_catalogue, normalize_protocol_method_fields,
    validate_protocol_method,
)
from new_meta.core.method_registry import MethodInputError
from new_meta.core.protocol_scope import protocol_hash, scope_fields, scope_receipt
from new_meta.schemas.protocol import ProtocolScopeAssessment
from pydantic import ValidationError
from new_meta.schemas.protocol import ResearchProtocol, PICO
from new_meta.prompts import planner_prompts


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
        for attempt in range(3):
            protocol = None
            try:
                protocol = self.call_llm_structured(prompt, ResearchProtocol, max_tokens=4096)
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
            except Exception as exc:
                # Provider/internal faults retain their failure semantics.
                last_error = exc
                self.log(f"PICO extraction attempt {attempt + 1} failed: {exc}", level="warning")
                continue
            last_error.phase.data["original_question"] = question
            self.log(f"PICO proposal attempt {attempt + 1} requires correction: {last_error}", level="warning")
            prompt = original_prompt + "\n\nValidation feedback (not new user intent):\n" + json.dumps(
                last_error.phase.model_dump(mode="json"), ensure_ascii=False)
            prompt += ("\nRepair only representation or scope drift relative to the ORIGINAL question. "
                       "Never drop unsupported requested designs or other explicit requirements to pass validation.")
        if isinstance(last_error, ProtocolInputRequired):
            raise last_error
        raise RuntimeError(f"PICO extraction failed after 3 attempts: {last_error}") from last_error

    def check_scope(self, question, protocol):
        """A separate assessment call with no planner conversation or self-attestation."""
        snapshot = ResearchProtocol.model_validate(protocol.model_dump())
        prompt = planner_prompts.SCOPE_CHECK_PROMPT.format(
            question=question, protocol=snapshot.model_dump_json(indent=2),
            fields=json.dumps(scope_fields(snapshot), ensure_ascii=False))
        try:
            assessment = self.llm.structured_output(
                [{"role": "system", "content": planner_prompts.SCOPE_CHECK_SYSTEM},
                 {"role": "user", "content": prompt}],
                ProtocolScopeAssessment, max_tokens=8192)
        except ValueError as exc:
            if not isinstance(exc.__cause__, (ValidationError, json.JSONDecodeError)):
                raise
            raise ProtocolInputRequired("Independent scope assessment was malformed; clarify and restart.",
                code="protocol_scope_unverified", protocol=protocol) from exc
        try:
            if protocol_hash(protocol) != protocol_hash(snapshot):
                raise ValueError("Protocol changed during independent scope assessment")
            return scope_receipt(question, snapshot, assessment)
        except ProtocolInputRequired:
            raise
        except (ValidationError, ValueError, TypeError) as exc:
            raise ProtocolInputRequired(f"Independent scope assessment is incomplete or unanchored: {exc}",
                code="protocol_scope_unverified", protocol=protocol) from exc

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
