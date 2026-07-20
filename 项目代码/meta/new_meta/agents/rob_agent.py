"""Risk of Bias assessment agent — RoB 2 for RCTs, NOS for observational studies."""
from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from pydantic import BaseModel, Field

from new_meta.core.agent_base import BaseAgent
from new_meta.core.project import Project
from new_meta.schemas.risk_of_bias import (
    ResultRoBAssessment,
    RoBAssessmentStatus,
    StudyRoB,
    RoBDomain,
)
from new_meta.schemas.study import ExtractedStudy
from new_meta.prompts import rob_prompts
from new_meta.config import MAX_WORKERS
from new_meta.tools.utils import first_author_lastname as _first_author, paper_identity


class RoBQuoteRepairSelection(BaseModel):
    domain: str
    candidate_index: int = Field(ge=-1)
    revised_judgment: str = ""
    revised_support: str = ""


class RoBQuoteRepairPlan(BaseModel):
    selections: list[RoBQuoteRepairSelection] = Field(default_factory=list)


class RoBAgent(BaseAgent):
    def __init__(self, model: str = None):
        super().__init__("risk_of_bias", rob_prompts.SYSTEM_PROMPT, model=model)

    def run(
        self,
        extracted_studies: list[ExtractedStudy],
        parsed_papers: dict[str, dict],
        project: Project,
        required_study_ids: list[str] = None,
    ) -> list[StudyRoB]:
        """Assess risk of bias for traceable studies.

        Args:
            required_study_ids: IDs of direct_eligible studies that MUST have RoB entries.
                                Missing ones get synthetic "insufficient information" entries.
        """
        # Filter: only assess studies with traceable metadata
        traceable = []
        for s in extracted_studies:
            if self._is_traceable_for_rob(s, parsed_papers):
                traceable.append(s)
            else:
                c = s.characteristics
                sid = c.pmid or c.study_id or "unknown"
                self.log(f"跳过不可溯源研究的RoB2评估: {sid}", level="warning")

        if not traceable and not required_study_ids:
            self.log("无可溯源研究执行RoB2评估")
            self._save_result_level_review(project, extracted_studies, [])
            return []

        self.log(f"Assessing risk of bias for {len(traceable)} studies...")

        from new_meta.core.rob_policy import resolve_rob_policy
        from new_meta.schemas.method_policy import MethodPlan

        method_plan_payload = project.load_json("method_plan.json", subdir="analysis")
        method_plan = MethodPlan.model_validate(method_plan_payload) if method_plan_payload else None
        cache_path = self._shared_cache_path(project)
        cache = self._load_shared_cache(cache_path)
        to_assess: list[ExtractedStudy] = []
        results: list[StudyRoB] = []
        for study in traceable:
            cached = self._cached_rob_for_study(cache, study)
            policy = resolve_rob_policy(
                family=method_plan.family,
                study_design=study.characteristics.study_design,
            ) if method_plan else None
            if cached and (policy is None or self._normalized_text(cached.tool_used) == self._normalized_text(policy.tool_name)):
                results.append(cached)
                self.log(f"[{cached.study_id}] Using cached RoB assessment")
            else:
                to_assess.append(study)

        def assess_one(study):
            parsed = self._parsed_for_study(study, parsed_papers)
            policy = resolve_rob_policy(
                family=method_plan.family,
                study_design=study.characteristics.study_design,
            ) if method_plan else None
            return self._assess_single(study, parsed, rob_policy=policy)

        cache_changed = False
        if to_assess:
            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                futures = {executor.submit(assess_one, s): s for s in to_assess}
                for future in as_completed(futures):
                    study = futures[future]
                    study_sid = study.characteristics.pmid or study.characteristics.study_id
                    try:
                        result = future.result()
                        if result:
                            results.append(result)
                            if not result.is_synthetic:
                                self._store_cached_rob(cache, study, result)
                                cache_changed = True
                        else:
                            # Synthetic fallback for None results
                            results.append(self._synthetic_rob(study_sid, study.characteristics.study_design or ""))
                    except Exception as e:
                        self.log(f"RoB failed for {study_sid}: {e}", level="warning")
                        results.append(self._synthetic_rob(study_sid, study.characteristics.study_design or ""))

        if cache_changed:
            self._save_shared_cache(cache_path, cache)

        # Fill gaps: required_study_ids not yet assessed get synthetic entries
        assessed_ids = {r.study_id for r in results}
        if required_study_ids:
            # Build study_id → study_design map from extracted_studies
            design_map = {}
            for s in extracted_studies:
                study_sid = s.characteristics.pmid or s.characteristics.study_id
                if study_sid:
                    design_map[study_sid] = s.characteristics.study_design or ""
            for sid in required_study_ids:
                if sid not in assessed_ids:
                    design = design_map.get(sid, "")
                    results.append(self._synthetic_rob(sid, design))
                    self.log(f"合成RoB条目（信息不足）: {sid}", level="warning")

        self.log(f"Completed RoB assessment for {len(results)} studies")

        # Save results
        project.save_json("rob_results.json", results, subdir="risk_of_bias")

        # Save summary for visualization
        rob_summary = self._build_summary(results, extracted_studies)
        project.save_json("rob_summary.json", rob_summary, subdir="risk_of_bias")
        self._save_result_level_review(project, extracted_studies, results)

        return results

    @staticmethod
    def _save_result_level_review(
        project: Project,
        extracted_studies: list[ExtractedStudy],
        study_assessments: list[StudyRoB],
    ) -> None:
        from new_meta.core.result_rob import build_result_rob_drafts, result_rob_readiness

        method_plan = project.load_json("method_plan.json", subdir="analysis")
        drafts = build_result_rob_drafts(
            extracted_studies,
            study_assessments,
            method_plan=method_plan,
        )
        project.save_json("rob_result_assessments.json", drafts, subdir="risk_of_bias")
        project.save_json(
            "rob_result_readiness.json",
            result_rob_readiness(drafts),
            subdir="risk_of_bias",
        )

    def complete_result_level_assessments(
        self,
        *,
        project: Project,
        extracted_studies: list[ExtractedStudy],
        parsed_papers: dict[str, dict],
        study_assessments: list[StudyRoB],
        required_result_ids: list[str],
    ) -> list[ResultRoBAssessment]:
        """Produce source-grounded, result-specific RoB records for synthesis inputs.

        Study-level LLM judgments are reused only when every domain already carries
        a verbatim quote found in the supplied report. Otherwise the model is asked
        to reassess the exact outcome/estimand. Unverified projections remain
        incomplete rather than being promoted merely to satisfy a release check.
        """
        from new_meta.core.extraction_ledger import result_entity_id
        from new_meta.core.result_rob import build_result_rob_drafts, result_rob_readiness
        from new_meta.core.rob_policy import resolve_rob_policy
        from new_meta.schemas.method_policy import MethodPlan

        required = list(dict.fromkeys(str(item) for item in required_result_ids if str(item)))
        required_set = set(required)
        if not required:
            return []
        plan_payload = project.load_json("method_plan.json", subdir="analysis") or {}
        plan = MethodPlan.model_validate(plan_payload)
        study_rob = {self._normalized_text(item.study_id): item for item in study_assessments}
        target_map = {}
        for study in extracted_studies:
            for index, outcome in enumerate(study.outcomes):
                rid = result_entity_id(study, index)
                if rid in required_set:
                    target_map[rid] = (study, outcome)

        raw_existing = project.load_json("rob_result_assessments.json", subdir="risk_of_bias") or []
        existing = {}
        for item in raw_existing:
            try:
                parsed = ResultRoBAssessment.model_validate(item)
            except Exception:
                continue
            existing[parsed.result_id] = parsed
        if not existing:
            existing = {
                item.result_id: item
                for item in build_result_rob_drafts(
                    extracted_studies,
                    study_assessments,
                    method_plan=plan,
                )
            }

        for result_id in required:
            current = existing.get(result_id)
            if current and current.assessment_status in {
                RoBAssessmentStatus.COMPLETE,
                RoBAssessmentStatus.ADJUDICATED,
            } and not current.requires_adjudication:
                continue
            target = target_map.get(result_id)
            if not target:
                continue
            study, outcome = target
            parsed = self._parsed_for_study(study, parsed_papers)
            full_text = str(parsed.get("full_text") or "")
            sid = self._study_sid(study)
            policy = resolve_rob_policy(
                family=plan.family,
                study_design=study.characteristics.study_design,
            )
            base = study_rob.get(self._normalized_text(sid))
            grounded = self._grounded_study_rob(base, full_text) if base else None
            assessment_origin = "source_grounded_study_assessment"
            if grounded is None and full_text:
                grounded = self._assess_result_specific_rob(
                    study=study,
                    outcome=outcome,
                    full_text=full_text,
                    rob_policy=policy,
                )
                assessment_origin = "llm_result_specific"
            if grounded is None:
                if current:
                    existing[result_id] = current.model_copy(update={
                        "assessment_status": RoBAssessmentStatus.INSUFFICIENT_INFORMATION,
                        "requires_adjudication": True,
                        "assessment_origin": "agent_result_specific_insufficient",
                    })
                continue
            existing[result_id] = ResultRoBAssessment(
                assessment_id=f"rob:{result_id}:complete",
                result_id=result_id,
                study_id=sid,
                outcome_name=outcome.outcome_name or "Outcome",
                timepoint=str(outcome.accepted_timepoint or outcome.timepoint or ""),
                subgroup=str(outcome.subgroup or ""),
                analysis_population=(
                    "adjudicated_population"
                    if outcome.manual_adjudication or outcome.user_override_applied
                    else ""
                ),
                tool_used=policy.tool_name,
                tool_version=policy.tool_version,
                target_effect=policy.target_effect,
                assessment_status=RoBAssessmentStatus.COMPLETE,
                assessed_by="agent:source-grounded-result-rob",
                domains=grounded.domains,
                overall_judgment=grounded.overall_judgment,
                is_synthetic=False,
                assessment_origin=assessment_origin,
                requires_adjudication=False,
            )

        ordered = sorted(existing.values(), key=lambda item: item.result_id)
        project.save_json("rob_result_assessments.json", ordered, subdir="risk_of_bias")
        project.save_json(
            "rob_result_readiness.json",
            result_rob_readiness(ordered, required_result_ids=required),
            subdir="risk_of_bias",
        )
        return [item for item in ordered if item.result_id in required_set]

    def _assess_result_specific_rob(self, *, study, outcome, full_text: str, rob_policy):
        content = full_text[:50000]
        context = (
            "\n\nTARGET RESULT (assess this exact result, not the study in general):\n"
            f"Outcome: {outcome.outcome_name}\n"
            f"Timepoint: {outcome.accepted_timepoint or outcome.timepoint or 'reported primary window'}\n"
            f"Subgroup: {outcome.subgroup or 'all randomized participants'}\n"
            f"Treatment arm: {outcome.treatment_arm or study.characteristics.intervention_description}\n"
            f"Comparator arm: {outcome.reference_arm or study.characteristics.control_description}\n"
            "For every domain, source_quote must be copied verbatim from PAPER CONTENT. "
            "Do not place a paraphrase in source_quote. If a safeguard is unreported, rate it "
            "as some concerns or high risk as appropriate and quote the closest text showing "
            "what was reported. A source_quote may contain multiple exact excerpts separated by "
            "three dots, but every excerpt must occur literally in PAPER CONTENT. Never write "
            "'shows', 'suggests', 'indicates', or a similar interpretation unless that word itself "
            "appears in the report. When a judgment depends on baseline imbalance or another table, "
            "copy the relevant table header and row values exactly rather than summarizing them.\n"
        )
        base_prompt = rob_policy.prompt_template.format(paper_content=content)
        prompt = base_prompt + context
        for attempt in range(3):
            try:
                candidate = self.call_llm_structured(
                    prompt,
                    StudyRoB,
                    temperature=0.0,
                    max_tokens=6000,
                )
            except Exception as exc:
                self.log(
                    f"[{self._study_sid(study)}] result-specific RoB attempt {attempt + 1} failed: {exc}",
                    level="warning",
                )
                continue
            candidate.study_id = self._study_sid(study)
            candidate.tool_used = rob_policy.tool_name
            grounded = self._grounded_study_rob(candidate, full_text)
            if grounded is not None:
                return grounded
            repaired = self._repair_rob_quotes_from_verified_candidates(candidate, full_text)
            if repaired is not None:
                return repaired
            grounding_feedback = self._rob_grounding_feedback(candidate, full_text)
            prompt = (
                base_prompt
                + context
                + "\nThe previous response contained missing or non-verbatim source_quote values. "
                "Return the full assessment again, using short exact substrings copied from PAPER CONTENT. "
                "Change the judgment if its rationale cannot be supported by an exact excerpt. "
                "For every failed domain below, copy one of the deterministically verified candidate excerpts "
                "exactly, without joining it to a paraphrase. A candidate excerpt is only a quotation aid: use it "
                "only when it genuinely supports the domain judgment.\n\n"
                + grounding_feedback
            )
        return None

    def _repair_rob_quotes_from_verified_candidates(
        self,
        assessment: StudyRoB,
        full_text: str,
    ) -> StudyRoB | None:
        """Let the model select among exact, pre-verified report excerpts."""
        failed_rows: list[dict] = []
        candidate_map: dict[str, list[str]] = {}
        for domain in assessment.domains:
            quote = str(domain.source_quote or "").strip()
            if quote and self._quote_occurs(quote, full_text):
                continue
            candidates = self._verified_quote_candidates(full_text, domain)
            if not candidates:
                return None
            key = self._normalized_text(domain.domain)
            candidate_map[key] = candidates
            failed_rows.append({
                "domain": domain.domain,
                "current_judgment": domain.judgment,
                "current_support": domain.support,
                "rejected_quote": quote,
                "verified_candidates": [
                    {"candidate_index": index, "source_quote": candidate}
                    for index, candidate in enumerate(candidates, start=1)
                ],
            })
        if not failed_rows:
            return assessment
        prompt = (
            "Repair only the source quotations for failed risk-of-bias domains. Every candidate below has already "
            "been verified as a literal excerpt from the report. For each domain, choose the candidate_index that "
            "actually supports the judgment. If the current judgment is too strong for every candidate, choose the "
            "closest candidate and provide a more conservative revised_judgment and revised_support. Do not combine, "
            "rewrite, or paraphrase candidate quotations. Use candidate_index=-1 only when no candidate is relevant. "
            "Return one selection for every failed domain.\n\n"
            f"FAILED DOMAINS AND VERIFIED CANDIDATES:\n{json.dumps(failed_rows, ensure_ascii=False, indent=2)}"
        )
        try:
            plan = self.call_llm_structured(
                prompt,
                RoBQuoteRepairPlan,
                temperature=0.0,
                max_tokens=2500,
            )
        except Exception:
            return None
        selections = {
            self._normalized_text(item.domain): item
            for item in plan.selections
        }
        repaired_domains: list[RoBDomain] = []
        for domain in assessment.domains:
            quote = str(domain.source_quote or "").strip()
            if quote and self._quote_occurs(quote, full_text):
                repaired_domains.append(domain)
                continue
            key = self._normalized_text(domain.domain)
            selection = selections.get(key)
            candidates = candidate_map.get(key) or []
            if selection is None or not 1 <= selection.candidate_index <= len(candidates):
                return None
            update = {"source_quote": candidates[selection.candidate_index - 1]}
            if str(selection.revised_judgment or "").strip():
                update["judgment"] = str(selection.revised_judgment).strip()
            if str(selection.revised_support or "").strip():
                update["support"] = str(selection.revised_support).strip()
            repaired_domains.append(domain.model_copy(update=update))
        repaired = assessment.model_copy(update={"domains": repaired_domains})
        return self._grounded_study_rob(repaired, full_text)

    @classmethod
    def _rob_grounding_feedback(cls, assessment: StudyRoB, full_text: str) -> str:
        """Return domain-specific quote feedback without weakening exact-source checks."""
        rows: list[str] = []
        for domain in assessment.domains:
            quote = str(domain.source_quote or "").strip()
            if quote and cls._quote_occurs(quote, full_text):
                continue
            candidates = cls._verified_quote_candidates(full_text, domain)
            rows.append(f"FAILED DOMAIN: {domain.domain}")
            rows.append(f"REJECTED QUOTE: {quote or '[missing]'}")
            if candidates:
                rows.append("VERIFIED CANDIDATE EXCERPTS:")
                rows.extend(f"- {item}" for item in candidates)
            else:
                rows.append("VERIFIED CANDIDATE EXCERPTS: none; use another short literal excerpt from PAPER CONTENT")
            rows.append("")
        return "\n".join(rows).strip()

    @classmethod
    def _verified_quote_candidates(
        cls,
        full_text: str,
        domain: RoBDomain,
        *,
        limit: int = 8,
    ) -> list[str]:
        """Find short, literal report lines relevant to one RoB domain.

        PDF parsers frequently interleave two columns.  Passing the whole paper
        back to the model does not tell it which apparently fluent sentence is
        actually contiguous in parsed text.  These candidates are selected from
        literal report lines and then passed through the same fail-closed quote
        verifier used for the final assessment.
        """
        label = cls._normalized_text(domain.domain)
        if "random" in label or "domain 1" in label:
            terms = ("random", "allocat", "conceal", "baseline", "sequence")
        elif "deviation" in label or "domain 2" in label:
            terms = ("blind", "mask", "deviation", "protocol", "intervention", "adherence")
        elif "missing" in label or "domain 3" in label:
            terms = ("missing", "lost", "withdraw", "follow-up", "follow up", "intention-to-treat", "randomized")
        elif "measurement" in label or "domain 4" in label:
            terms = ("assess", "measure", "blind", "mask", "adjudicat", "diagnos")
        else:
            terms = ("registr", "protocol", "analysis", "primary", "prespec", "pre-spec", "reported")

        candidates: list[str] = []

        def add(value: str) -> None:
            item = re.sub(r"\s+", " ", str(value or "")).strip(" -\t")
            token_count = len(re.findall(r"[\w]+", item, flags=re.UNICODE))
            if not 6 <= token_count <= 36:
                return
            if item in candidates or not cls._quote_occurs(item, full_text):
                return
            candidates.append(item)

        # Preserve any individually valid fragments from the model's rejected
        # multi-fragment quote before looking for alternatives.
        for fragment in re.split(
            r"(?:\.{3,}|…+|\s*;\s+|(?<=\.)\s+(?=[A-Z]))",
            str(domain.source_quote or ""),
        ):
            add(fragment)

        relevant_lines: list[tuple[int, str]] = []
        for line_index, raw_line in enumerate(str(full_text or "").splitlines()):
            line = raw_line.strip()
            normalized = line.casefold()
            if any(term in normalized for term in terms):
                relevance = sum(
                    len(terms) - term_index
                    for term_index, term in enumerate(terms)
                    if term in normalized
                )
                relevant_lines.append((relevance * 10000 - line_index, line))
        for _, line in sorted(relevant_lines, reverse=True):
            add(line)
            if len(candidates) >= limit:
                break
        return candidates[:limit]

    @classmethod
    def _grounded_study_rob(cls, assessment: StudyRoB | None, full_text: str) -> StudyRoB | None:
        if assessment is None or assessment.is_synthetic or not assessment.domains or not full_text:
            return None
        domains = []
        for domain in assessment.domains:
            quote = str(domain.source_quote or "").strip()
            if not quote and cls._quote_occurs(domain.support, full_text):
                quote = str(domain.support or "").strip()
            if not quote or not cls._quote_occurs(quote, full_text):
                return None
            domains.append(domain.model_copy(update={"source_quote": quote}))
        if not str(assessment.overall_judgment or "").strip():
            return None
        return assessment.model_copy(update={"domains": domains, "is_synthetic": False})

    @staticmethod
    def _quote_occurs(quote: str, full_text: str) -> bool:
        """Verify quoted report fragments without trusting PDF punctuation/layout.

        Parsed PDFs routinely change line breaks, hyphenation, dash glyphs, and
        sentence punctuation.  RoB evidence is still fail-closed: every quoted
        fragment must contain a meaningful token sequence and those sequences
        must occur in the report in the same order.  Ellipses and semicolons are
        treated only as explicit separators between copied fragments; they do
        not permit paraphrases or unordered keyword matching.
        """

        def tokens(value: str) -> list[str]:
            normalized = (
                str(value or "")
                .replace("\u00ad", "")
                .replace("–", "-")
                .replace("—", "-")
                .replace("−", "-")
                .casefold()
            )
            normalized = re.sub(r"(?<=\w)-\s+(?=\w)", "", normalized)
            # Treat hyphenation as layout, not meaning: PDF parsers may emit
            # ``intention- to-treat`` or a non-breaking dash for the same words.
            return re.findall(r"[\w]+", normalized, flags=re.UNICODE)

        report_tokens = tokens(full_text)
        if not report_tokens:
            return False
        raw_fragments = [
            item.strip()
            for item in re.split(
                r"(?:\.{3,}|…+|\s*;\s+|(?<=\.)\s+(?=[A-Z]))",
                str(quote or ""),
            )
            if item.strip()
        ]
        fragments = [tokens(item) for item in raw_fragments]
        if not fragments or sum(len(item) for item in fragments) < 6:
            return False
        if any(len(item) < 3 for item in fragments):
            return False

        cursor = 0
        for fragment in fragments:
            found = -1
            for index in range(cursor, len(report_tokens)):
                if report_tokens[index] != fragment[0]:
                    continue
                report_index = index + 1
                skipped = 0
                matched = True
                for token in fragment[1:]:
                    upper = min(len(report_tokens), report_index + 80)
                    try:
                        next_index = report_tokens.index(token, report_index, upper)
                    except ValueError:
                        matched = False
                        break
                    skipped += next_index - report_index
                    if skipped > max(24, len(fragment) * 4):
                        matched = False
                        break
                    report_index = next_index + 1
                if matched:
                    found = index
                    cursor = report_index
                    break
            if found < 0:
                return False
        return True

    def _is_traceable_for_rob(self, study: ExtractedStudy, parsed_papers: dict[str, dict]) -> bool:
        c = study.characteristics
        has_id = bool(c.pmid or c.doi)
        has_title = bool(c.title and c.title.strip())
        has_author = bool(c.authors)
        has_year = bool(c.year)
        if has_id and has_title and has_author and has_year:
            return True
        if self._is_registry_or_known_source(study) and has_title and bool(c.study_id):
            return bool(self._parsed_for_study(study, parsed_papers).get("full_text"))
        return False

    @staticmethod
    def _is_registry_or_known_source(study: ExtractedStudy) -> bool:
        c = study.characteristics
        haystack = " ".join([
            c.study_id or "",
            c.source_type or "",
            c.metadata_source or "",
            c.journal or "",
        ]).lower()
        return any(marker in haystack for marker in (
            "known_source",
            "registry",
            "clinicaltrials",
            "trial_register",
            "benchmark_source",
            "who_react",
        ))

    def _parsed_for_study(self, study: ExtractedStudy, parsed_papers: dict[str, dict]) -> dict:
        if not parsed_papers:
            return {}
        for key in self._identity_candidates(study):
            if key in parsed_papers:
                parsed = parsed_papers.get(key) or {}
                if isinstance(parsed, dict):
                    return parsed

        nct_ids = self._nct_ids_for_study(study)
        if nct_ids:
            for parsed in parsed_papers.values():
                if not isinstance(parsed, dict):
                    continue
                full_text = str(parsed.get("full_text") or "")
                upper_text = full_text.upper()
                if any(nct in upper_text for nct in nct_ids):
                    return parsed

        title = self._normalized_text(study.characteristics.title)
        if len(title) >= 12:
            for parsed in parsed_papers.values():
                if not isinstance(parsed, dict):
                    continue
                full_text = self._normalized_text(parsed.get("full_text") or "")
                if title in full_text:
                    return parsed
        return {}

    @staticmethod
    def _identity_candidates(study: ExtractedStudy) -> list[str]:
        c = study.characteristics
        candidates = []
        for value in (c.pmid, c.study_id, c.doi):
            value = str(value or "").strip()
            if value:
                candidates.append(value)
        title_identity = paper_identity({
            "title": c.title,
            "pmid": c.pmid,
            "doi": c.doi,
        })
        if title_identity and title_identity != "unknown":
            candidates.append(title_identity)
        return list(dict.fromkeys(candidates))

    @staticmethod
    def _shared_cache_path(project: Project | None) -> Path | None:
        raw = os.getenv("METAAGENT_ROB_CACHE_PATH", "").strip()
        if raw:
            return Path(raw)
        base_dir = getattr(project, "base_dir", None)
        if not base_dir:
            return None
        base_dir = Path(base_dir)
        for parent in (base_dir, *base_dir.parents):
            if parent.name == "output":
                return parent / "cache" / "rob_cache_v1.json"
        return base_dir.parent / "cache" / "rob_cache_v1.json"

    @staticmethod
    def _load_shared_cache(path: Path | None) -> dict:
        if not path or not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if isinstance(data, dict) and isinstance(data.get("entries"), dict):
            return data["entries"]
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _save_shared_cache(path: Path | None, cache: dict) -> None:
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"version": 1, "entries": cache}
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            return

    def _cached_rob_for_study(self, cache: dict, study: ExtractedStudy) -> StudyRoB | None:
        for key in self._rob_cache_keys(study):
            raw = cache.get(key)
            if not isinstance(raw, dict):
                continue
            try:
                rob = StudyRoB.model_validate(raw)
            except Exception:
                continue
            data = rob.model_dump()
            data["study_id"] = self._study_sid(study)
            return StudyRoB.model_validate(data)
        return None

    def _store_cached_rob(self, cache: dict, study: ExtractedStudy, rob: StudyRoB) -> None:
        data = rob.model_dump(mode="json")
        for key in self._rob_cache_keys(study):
            cache[key] = data

    @staticmethod
    def _study_sid(study: ExtractedStudy) -> str:
        c = study.characteristics
        return str(c.pmid or c.study_id or paper_identity({"title": c.title, "pmid": c.pmid, "doi": c.doi}) or "unknown")

    def _rob_cache_keys(self, study: ExtractedStudy) -> list[str]:
        c = study.characteristics
        keys: list[str] = []
        for value in (c.doi, c.pmid, *sorted(self._nct_ids_for_study(study)), c.study_id):
            token = self._normalized_text(value)
            if token:
                keys.append(f"rob:v1:{token}")
        title_identity = paper_identity({"title": c.title, "pmid": c.pmid, "doi": c.doi})
        if title_identity and title_identity != "unknown":
            keys.append(f"rob:v1:{self._normalized_text(title_identity)}")
        return list(dict.fromkeys(keys))

    @staticmethod
    def _nct_ids_for_study(study: ExtractedStudy) -> set[str]:
        pieces = [
            study.characteristics.study_id,
            study.characteristics.title,
            study.characteristics.doi,
            study.characteristics.pmid,
            study.characteristics.source_type,
            study.characteristics.metadata_source,
        ]
        for outcome in study.outcomes:
            pieces.extend([
                outcome.outcome_name,
                outcome.source_location,
                outcome.source_quote,
                outcome.source_quote_match,
            ])
        return {
            match.upper()
            for match in re.findall(r"\bNCT\d{8}\b", "\n".join(str(piece or "") for piece in pieces), flags=re.I)
        }

    @staticmethod
    def _normalized_text(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()

    def _assess_single(self, study: ExtractedStudy, parsed: dict, *, rob_policy=None) -> StudyRoB | None:
        """Assess risk of bias for a single study."""
        full_text = parsed.get("full_text", "")
        study_id = study.characteristics.pmid or study.characteristics.study_id
        design = (study.characteristics.study_design or "").lower()
        title = (study.characteristics.title or "").lower()

        if not full_text:
            self.log(f"[{study_id}] No full text available, using synthetic RoB", level="warning")
            return self._synthetic_rob(
                study_id,
                study.characteristics.study_design or "",
                rob_policy=rob_policy,
            )

        # Truncate
        max_chars = 30000
        if len(full_text) > max_chars:
            full_text = full_text[:max_chars] + "\n\n[... truncated ...]"

        # Choose tool based on explicit design and strong text/title signals.
        # Some extraction outputs leave study_design blank even when the paper
        # title/abstract clearly says "randomized clinical trial".
        rct_signal = " ".join([design, title, full_text[:6000].lower()])
        if rob_policy is not None:
            prompt = rob_policy.prompt_template.format(paper_content=full_text)
            tool = rob_policy.tool_name
        elif any(kw in rct_signal for kw in [
            "rct",
            "randomized",
            "randomised",
            "randomly assigned",
            "randomized clinical trial",
            "randomized controlled trial",
            "randomised controlled trial",
            "随机对照",
            "随机化",
        ]):
            prompt = rob_prompts.ROB2_PROMPT.format(paper_content=full_text)
            tool = "RoB 2"
        elif any(kw in design for kw in ["cohort", "队列"]):
            prompt = rob_prompts.NOS_PROMPT.format(paper_content=full_text)
            tool = "Newcastle-Ottawa Scale (Cohort)"
        else:
            prompt = rob_prompts.NOS_PROMPT.format(paper_content=full_text)
            tool = "Newcastle-Ottawa Scale"

        rob = self.call_llm_structured(prompt, StudyRoB, max_tokens=4096)
        rob.study_id = study_id
        rob.tool_used = tool

        self.log(f"[{study_id}] RoB: {rob.overall_judgment} ({tool})")
        return rob

    def _synthetic_rob(self, study_id: str, study_design: str = "", *, rob_policy=None) -> StudyRoB:
        """Generate a synthetic RoB entry for studies with insufficient information."""
        design_lower = (study_design or "").lower()
        is_rct = any(kw in design_lower for kw in ["rct", "randomized", "randomised", "随机对照", "随机化"])

        if rob_policy is not None:
            domains = list(rob_policy.domain_names)
            tool = rob_policy.tool_name
        elif is_rct or not design_lower:
            domains = [
                "Randomization process",
                "Deviations from intended interventions",
                "Missing outcome data",
                "Measurement of the outcome",
                "Selection of the reported result",
            ]
            tool = "RoB 2"
        else:
            domains = [
                "Selection of participants",
                "Comparability of groups",
                "Assessment of outcome",
            ]
            tool = "Newcastle-Ottawa Scale"

        default_domains = [
            RoBDomain(domain=d, judgment="Insufficient information",
                      support="Full text not available for assessment")
            for d in domains
        ]
        return StudyRoB(
            study_id=study_id,
            tool_used=tool,
            domains=default_domains,
            overall_judgment="Not assessed (insufficient information)",
            is_synthetic=True,
        )

    def _build_summary(self, rob_results: list[StudyRoB], extracted_studies: list[ExtractedStudy]) -> list[dict]:
        """Build summary data for visualization."""
        # Map study_id to label
        label_map = {}
        for s in extracted_studies:
            sid = s.characteristics.pmid or s.characteristics.study_id
            first_author = _first_author(s.characteristics.authors)
            label_map[sid] = f"{first_author} {s.characteristics.year}"

        summary = []
        for rob in rob_results:
            domains_dict = {d.domain: d.judgment for d in rob.domains}
            summary.append({
                "study_id": rob.study_id,
                "study_label": label_map.get(rob.study_id, rob.study_id),
                "tool": rob.tool_used,
                "domains": domains_dict,
                "overall": rob.overall_judgment,
                "is_synthetic": rob.is_synthetic,
            })
        return summary
