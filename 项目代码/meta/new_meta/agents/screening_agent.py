"""Screening agent — title/abstract + full-text screening with PRISMA tracking."""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pydantic import BaseModel
from tqdm import tqdm

from new_meta.core.agent_base import BaseAgent
from new_meta.core.known_source_recovery import TRIAL_PUBLICATION_IDS, known_source_protocol_preferences
from new_meta.core.project import Project
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.prompts import screening_prompts
from new_meta.config import MAX_WORKERS, TA_BATCH_SIZE, BATCH_SCREENING_THRESHOLD
from new_meta.tools.utils import paper_identity


class ScreeningDecision(BaseModel):
    decision: str  # "include" / "exclude"
    priority_tier: str = "uncertain"  # "direct" / "uncertain" / "indirect"
    reason: str
    exclusion_criterion: str | None = None
    confidence: str = "medium"


class BatchScreeningResult(BaseModel):
    """Wrapper for batch screening LLM output."""
    decisions: list[dict] = []


class ScreeningAgent(BaseAgent):
    """Two-phase screening agent with dual-reviewer simulation."""

    def __init__(self, model: str = None, dual_screening: bool = True):
        super().__init__("screening", screening_prompts.SYSTEM_PROMPT, model=model)
        self.dual_screening = dual_screening

    def run(
        self,
        papers: list[dict],
        protocol: ResearchProtocol,
        parsed_papers: dict[str, dict],
        project: Project,
    ) -> list[dict]:
        """Two-phase screening: title/abstract → full-text (backward-compat wrapper).

        Args:
            papers: list of paper metadata dicts (from retriever)
            protocol: research protocol
            parsed_papers: {pmid: parsed_content} for full-text screening
            project: project instance for persistence

        Returns:
            list of included paper dicts
        """
        # Phase 1: T/A screening
        ta_included, ta_excluded = self.screen_title_abstract(papers, protocol, project)

        # Phase 2: Full-text screening
        papers_for_ft = [p for p in ta_included if p.get("pdf_path")]
        ft_included, ft_excluded = self.screen_full_text(papers_for_ft, protocol, parsed_papers, project)

        return ft_included

    # ------------------------------------------------------------------
    # Public API: separate T/A and FT screening methods
    # ------------------------------------------------------------------

    def screen_title_abstract(
        self,
        papers: list[dict],
        protocol: ResearchProtocol,
        project: Project,
    ) -> tuple[list[dict], list[dict]]:
        """Title/Abstract-only screening. Auto-selects batch vs individual.

        Returns:
            (included_papers, excluded_papers)
        """
        self.log(f"Title/Abstract screening ({len(papers)} papers)...")

        if len(papers) >= BATCH_SCREENING_THRESHOLD:
            self.log(f"Using batched screening (batch_size=5)")
            ta_results = self._screen_title_abstract_batched(papers, protocol, batch_size=5)
        elif self.dual_screening:
            ta_results = self._dual_screen_title_abstract(papers, protocol)
        else:
            ta_results = self._screen_title_abstract(papers, protocol)
        ta_results = self._retain_known_source_primary_records(ta_results, protocol)

        included_ta = [r for r in ta_results if r["decision"] == "include"]
        excluded_ta = [r for r in ta_results if r["decision"] == "exclude"]

        # Inject priority_tier into paper dicts for downstream use
        for r in included_ta:
            r["paper"]["priority_tier"] = r.get("priority_tier", "uncertain")

        project.prisma.title_abstract_screened = len(papers)
        project.prisma.title_abstract_excluded = len(excluded_ta)

        # Track exclusion reasons
        for r in excluded_ta:
            reason = r.get("exclusion_criterion") or r.get("reason", "Other")
            project.prisma.title_abstract_exclusion_reasons[reason] = (
                project.prisma.title_abstract_exclusion_reasons.get(reason, 0) + 1
            )

        n_direct = sum(1 for r in included_ta if r.get("priority_tier") == "direct")
        n_uncertain = sum(1 for r in included_ta if r.get("priority_tier") == "uncertain")
        n_indirect = sum(1 for r in included_ta if r.get("priority_tier") == "indirect")
        self.log(f"T/A screening: {len(included_ta)} included ({n_direct} direct, {n_uncertain} uncertain, {n_indirect} indirect), {len(excluded_ta)} excluded")

        # Save T/A screening results
        project.save_json("title_abstract_screening.json", ta_results, subdir="screening")
        project.save_json("prisma_flow.json", project.prisma.to_dict())

        included_papers = [r["paper"] for r in included_ta]
        excluded_papers = [r["paper"] for r in excluded_ta]
        return included_papers, excluded_papers

    @classmethod
    def _retain_known_source_primary_records(
        cls,
        ta_results: list[dict],
        protocol: ResearchProtocol,
    ) -> list[dict]:
        """Keep exact known-source trial publications available for source audit.

        Some benchmark-relevant COVID corticosteroid trials only have protocol or
        registry-first records in the normal retrieval stream, while a
        source-quoted benchmark figure supplies the arm-level mortality counts.
        These records should still be fetched and audited instead of being lost
        at title/abstract screening as "protocol without outcome data".
        """
        if not known_source_protocol_preferences(protocol):
            return ta_results
        known_pmids = {
            str(ids.get("pmid") or "").strip().lower()
            for ids in TRIAL_PUBLICATION_IDS.values()
            if ids.get("pmid")
        }
        known_dois = {
            str(ids.get("doi") or "").strip().lower()
            for ids in TRIAL_PUBLICATION_IDS.values()
            if ids.get("doi")
        }
        retained: list[dict] = []
        for result in ta_results:
            paper = result.get("paper") or {}
            pmid = str(paper.get("pmid") or "").strip().lower()
            doi = str(paper.get("doi") or "").strip().lower()
            if (
                result.get("decision") == "exclude"
                and ((pmid and pmid in known_pmids) or (doi and doi in known_dois))
            ):
                prior_reason = result.get("reason") or "Excluded by title/abstract screening."
                result = {
                    **result,
                    "decision": "include",
                    "priority_tier": "uncertain",
                    "exclusion_criterion": None,
                    "known_source_audit_retained": True,
                    "original_decision": "exclude",
                    "reason": (
                        "Retained for known-source primary-source audit despite the initial "
                        f"title/abstract exclusion. Original reason: {prior_reason}"
                    ),
                }
                if result.get("confidence") in {None, "", "low"}:
                    result["confidence"] = "medium"
            retained.append(result)
        return retained

    def screen_full_text(
        self,
        papers: list[dict],
        protocol: ResearchProtocol,
        parsed_papers: dict[str, dict],
        project: Project,
    ) -> tuple[list[dict], list[dict]]:
        """Full-text-only screening.

        Returns:
            (included_papers, excluded_papers)
        """
        # Pre-filter: remove studies with untraceable metadata (Unknown)
        # Exception: user-uploaded PDFs (pmid starts with "user_pdf_") always pass through
        valid_papers = []
        for p in papers:
            pmid = p.get("pmid", "")
            is_user_pdf = pmid.startswith("user_pdf_")
            source_type = str(p.get("source_type") or p.get("source") or "").lower()
            is_registry_record = bool(
                source_type in {"clinicaltrials", "registry_seed"}
                or p.get("trial_registration")
                or p.get("nct_id")
                or p.get("clinicaltrials_id")
            )
            has_title = bool(p.get("title", "").strip())
            has_year = bool(p.get("year"))
            has_id = bool(
                pmid
                or p.get("doi")
                or p.get("trial_registration")
                or p.get("nct_id")
                or p.get("clinicaltrials_id")
            )
            # A record identified by PMID/DOI/registration is fully traceable even
            # when its parsed authors list is empty. Large collaborative trials use
            # collective/corporate authorship (e.g. "CRASH-3 trial collaborators",
            # "RECOVERY Collaborative Group") that PubMed does not expand into an
            # author list; requiring a non-empty author list here silently dropped
            # exactly those pivotal trials from full-text screening.
            has_author = bool(p.get("authors")) or is_registry_record or has_id
            if is_user_pdf and has_title:
                valid_papers.append(p)
            elif not (has_title and has_author and has_year and has_id):
                self.log(f"排除不可溯源研究 {pmid}: 缺少标题/作者/年份/PMID/DOI", level="warning")
                reason = "该研究缺少可溯源信息（标题/作者/年份/PMID/DOI），已排除"
                project.prisma.full_text_exclusion_reasons[reason] = (
                    project.prisma.full_text_exclusion_reasons.get(reason, 0) + 1
                )
            else:
                valid_papers.append(p)
        excluded_unknown = len(papers) - len(valid_papers)
        if excluded_unknown:
            self.log(f"排除 {excluded_unknown} 篇不可溯源研究")

        self.log(f"Full-text screening ({len(valid_papers)} papers)...")
        if not valid_papers:
            return [], papers

        ft_results = self._screen_full_text(valid_papers, protocol, parsed_papers)

        included_ft = [r for r in ft_results if r["decision"] == "include"]
        excluded_ft = [r for r in ft_results if r["decision"] == "exclude"]

        project.prisma.full_text_assessed = len(papers)
        project.prisma.full_text_excluded = len(excluded_ft)

        for r in excluded_ft:
            reason = r.get("exclusion_criterion") or r.get("reason", "Other")
            project.prisma.full_text_exclusion_reasons[reason] = (
                project.prisma.full_text_exclusion_reasons.get(reason, 0) + 1
            )

        final_included = [r["paper"] for r in included_ft]
        final_excluded = [r["paper"] for r in excluded_ft]
        # Add Unknown papers to excluded list
        unknown_papers = [p for p in papers if p not in valid_papers]
        final_excluded.extend(unknown_papers)
        project.prisma.full_text_excluded = len(final_excluded)
        project.prisma.studies_included = len(final_included)

        self.log(f"Full-text screening: {len(final_included)} included, {len(final_excluded)} excluded")

        # Save FT screening results
        project.save_json("full_text_screening.json", ft_results, subdir="screening")
        project.save_json("prisma_flow.json", project.prisma.to_dict())

        return final_included, final_excluded

    # ------------------------------------------------------------------
    # Internal screening implementations
    # ------------------------------------------------------------------

    def _screen_title_abstract(self, papers: list[dict], protocol: ResearchProtocol) -> list[dict]:
        """Screen papers by title and abstract (individual, one LLM call per paper)."""
        inclusion_str = "\n".join(f"  - {c}" for c in protocol.inclusion_criteria)
        exclusion_str = "\n".join(f"  - {c}" for c in protocol.exclusion_criteria)

        def screen_one(paper):
            prompt = screening_prompts.TITLE_ABSTRACT_SCREENING_PROMPT.format(
                research_question=protocol.research_question,
                population=protocol.pico.population,
                intervention=protocol.pico.intervention,
                comparator=protocol.pico.comparator,
                outcome=protocol.pico.outcome_primary,
                study_design=protocol.study_design,
                inclusion_criteria=inclusion_str,
                exclusion_criteria=exclusion_str,
                title=paper.get("title", ""),
                abstract=paper.get("abstract", ""),
            )
            try:
                decision = self.call_llm_structured(prompt, ScreeningDecision)
                # Validate decision value
                d = "include" if decision.decision == "include" else "exclude"
                tier = decision.priority_tier if decision.priority_tier in ("direct", "uncertain", "indirect") else "uncertain"
                return {
                    "paper": paper,
                    "decision": d,
                    "priority_tier": tier,
                    "reason": decision.reason,
                    "exclusion_criterion": decision.exclusion_criterion,
                    "confidence": decision.confidence,
                }
            except Exception as e:
                self.log(f"Screening error for {paper.get('pmid')}: {e}", level="warning")
                return {
                    "paper": paper, "decision": "exclude",
                    "priority_tier": "uncertain",
                    "reason": f"LLM failed, excluded conservatively: {e}",
                    "confidence": "low",
                }

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            results = list(tqdm(executor.map(screen_one, papers), total=len(papers), desc="T/A Screening", leave=False))
        return results

    def _screen_title_abstract_batched(
        self, papers: list[dict], protocol: ResearchProtocol, batch_size: int = 5
    ) -> list[dict]:
        """Screen papers in small concurrent batches (5 papers per LLM call, all batches in parallel)."""
        inclusion_str = "\n".join(f"  - {c}" for c in protocol.inclusion_criteria)
        exclusion_str = "\n".join(f"  - {c}" for c in protocol.exclusion_criteria)

        # Split into batches of 5
        batches = []
        for i in range(0, len(papers), batch_size):
            batches.append(papers[i : i + batch_size])

        def screen_batch(batch_idx: int, batch: list[dict]) -> list[dict]:
            papers_block_parts = []
            for j, paper in enumerate(batch, 1):
                pmid = paper.get("pmid", f"unknown_{j}")
                title = paper.get("title", "")
                abstract = paper.get("abstract", "")
                papers_block_parts.append(
                    f"### Paper {j} (PMID: {pmid})\n- Title: {title}\n- Abstract: {abstract}\n"
                )
            papers_block = "\n".join(papers_block_parts)

            prompt = screening_prompts.BATCH_TITLE_ABSTRACT_SCREENING_PROMPT.format(
                research_question=protocol.research_question,
                population=protocol.pico.population,
                intervention=protocol.pico.intervention,
                comparator=protocol.pico.comparator,
                outcome=protocol.pico.outcome_primary,
                study_design=protocol.study_design,
                inclusion_criteria=inclusion_str,
                exclusion_criteria=exclusion_str,
                papers_block=papers_block,
            )

            batch_results = []
            try:
                batch_result = self.call_llm_structured(prompt, BatchScreeningResult, max_tokens=8192)
                decisions = batch_result.decisions
                pmid_to_paper = {p.get("pmid", ""): p for p in batch}
                responded_pmids: set[str] = set()

                for decision_dict in decisions:
                    pmid = decision_dict.get("pmid", "")
                    paper = pmid_to_paper.get(pmid)
                    if not paper:
                        # Strict: ignore results for unknown pmids (no title fuzzy match)
                        continue
                    responded_pmids.add(pmid)
                    # Validate decision value
                    raw_decision = decision_dict.get("decision", "exclude")
                    decision = "include" if raw_decision == "include" else "exclude"
                    # Validate priority_tier
                    raw_tier = decision_dict.get("priority_tier", "uncertain")
                    tier = raw_tier if raw_tier in ("direct", "uncertain", "indirect") else "uncertain"
                    batch_results.append({
                        "paper": paper,
                        "decision": decision,
                        "priority_tier": tier,
                        "reason": decision_dict.get("reason", ""),
                        "exclusion_criterion": decision_dict.get("exclusion_criterion"),
                        "confidence": decision_dict.get("confidence", "medium"),
                    })

                # Papers not in LLM response get individual re-screening (strict paper_id only)
                missed_papers = [p for p in batch if p.get("pmid", "") not in responded_pmids]
                if missed_papers:
                    self.log(f"Batch {batch_idx}: {len(missed_papers)} papers missed by LLM, re-screening individually", level="warning")
                    missed_results = self._screen_title_abstract(missed_papers, protocol)
                    batch_results.extend(missed_results)

            except Exception as e:
                self.log(f"Batch screening failed for batch {batch_idx}: {e}", level="warning")
                for paper in batch:
                    batch_results.append({
                        "paper": paper,
                        "decision": "exclude",
                        "priority_tier": "uncertain",
                        "reason": f"Batch error, excluded conservatively: {e}",
                        "confidence": "low",
                    })
            return batch_results

        all_results = []
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = {executor.submit(screen_batch, idx, batch): idx for idx, batch in enumerate(batches)}
            for future in tqdm(as_completed(futures), total=len(futures), desc="T/A Batch Screening", leave=False):
                try:
                    all_results.extend(future.result())
                except Exception as e:
                    self.log(f"Batch screening future error: {e}", level="warning")

        return all_results

    def _screen_full_text(
        self, papers: list[dict], protocol: ResearchProtocol, parsed_papers: dict[str, dict]
    ) -> list[dict]:
        """Screen papers by full text content."""
        inclusion_str = "\n".join(f"  - {c}" for c in protocol.inclusion_criteria)
        exclusion_str = "\n".join(f"  - {c}" for c in protocol.exclusion_criteria)

        def screen_one(paper):
            paper_id = paper_identity(paper)
            parsed = parsed_papers.get(paper_id, {})
            full_text = parsed.get("full_text", "")

            if not full_text:
                # Use abstract for screening instead of auto-including
                abstract = paper.get("abstract", "")
                if not abstract:
                    return {"paper": paper, "decision": "exclude", "reason": "No full text or abstract available for screening", "confidence": "low"}
                # Fall through to LLM screening with abstract as "full text"
                full_text = f"[Title/Abstract Only]\n\nTitle: {paper.get('title', '')}\n\nAbstract: {abstract}"

            # Truncate to avoid token limits — prioritize results/tables sections
            max_chars = 30000
            if len(full_text) > max_chars:
                full_text = self._smart_truncate(full_text, max_chars)

            prompt = screening_prompts.FULL_TEXT_SCREENING_PROMPT.format(
                research_question=protocol.research_question,
                population=protocol.pico.population,
                intervention=protocol.pico.intervention,
                comparator=protocol.pico.comparator,
                outcome=protocol.pico.outcome_primary,
                study_design=protocol.study_design,
                inclusion_criteria=inclusion_str,
                exclusion_criteria=exclusion_str,
                full_text=full_text,
            )
            try:
                decision = self.call_llm_structured(prompt, ScreeningDecision)
                d = "include" if decision.decision == "include" else "exclude"
                result = {
                    "paper": paper,
                    "decision": d,
                    "reason": decision.reason,
                    "exclusion_criterion": decision.exclusion_criterion,
                    "confidence": decision.confidence,
                }
                return self._apply_full_text_role_policy(result, paper, parsed, protocol=protocol)
            except Exception as e:
                self.log(f"Full-text screening error for {paper_id}: {e}", level="warning")
                result = {"paper": paper, "decision": "exclude", "reason": f"Error, excluded conservatively: {e}", "confidence": "low"}
                return self._apply_full_text_role_policy(result, paper, parsed, protocol=protocol)

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            results = list(tqdm(executor.map(screen_one, papers), total=len(papers), desc="Full-text Screening", leave=False))
        return results

    # ------------------------------------------------------------------
    # Dual-reviewer simulation and Cohen's kappa
    # ------------------------------------------------------------------

    def _dual_screen_title_abstract(self, papers: list[dict], protocol: ResearchProtocol) -> list[dict]:
        """Simulate dual-reviewer screening using two passes with different temperatures.

        Reviewer 1: temperature=0 (deterministic)
        Reviewer 2: temperature=0.3 (slight variation)
        Conflict resolution: include if either reviewer includes (high recall).
        """
        self.log("Dual-reviewer T/A screening...")

        # Reviewer 1 (deterministic)
        results_r1 = self._screen_title_abstract(papers, protocol)

        # Reviewer 2 (with slight temperature variation for different perspective)
        results_r2 = self._screen_ta_with_temp(papers, protocol, temperature=0.3)

        # Compute inter-rater agreement
        decisions_r1 = [r["decision"] for r in results_r1]
        decisions_r2 = [r["decision"] for r in results_r2]
        kappa = self._cohens_kappa(decisions_r1, decisions_r2)
        self.log(f"Inter-rater agreement (Cohen's kappa): {kappa:.3f}")

        # Conflict resolution: include if either reviewer includes
        merged = []
        conflicts = 0
        for r1, r2 in zip(results_r1, results_r2):
            if r1["decision"] == r2["decision"]:
                merged.append(r1)
            else:
                conflicts += 1
                # Conservative: include on disagreement (favor recall)
                merged.append({
                    "paper": r1["paper"],
                    "decision": "include",
                    "priority_tier": "uncertain",
                    "reason": f"Dual-reviewer conflict (R1={r1['decision']}, R2={r2['decision']}); included for safety",
                    "confidence": "low",
                    "kappa_note": f"Disagreement resolved by inclusion. kappa={kappa:.3f}",
                })

        self.log(f"Dual screening: {conflicts} conflicts out of {len(papers)} papers (kappa={kappa:.3f})")
        return merged

    def _screen_ta_with_temp(self, papers: list[dict], protocol: ResearchProtocol, temperature: float) -> list[dict]:
        """Screen papers with a specific temperature (for second reviewer simulation)."""
        inclusion_str = "\n".join(f"  - {c}" for c in protocol.inclusion_criteria)
        exclusion_str = "\n".join(f"  - {c}" for c in protocol.exclusion_criteria)

        def screen_one(paper):
            prompt = screening_prompts.TITLE_ABSTRACT_SCREENING_PROMPT.format(
                research_question=protocol.research_question,
                population=protocol.pico.population,
                intervention=protocol.pico.intervention,
                comparator=protocol.pico.comparator,
                outcome=protocol.pico.outcome_primary,
                study_design=protocol.study_design,
                inclusion_criteria=inclusion_str,
                exclusion_criteria=exclusion_str,
                title=paper.get("title", ""),
                abstract=paper.get("abstract", ""),
            )
            try:
                messages = [
                    {"role": "system", "content": self.system_prompt},
                    {"role": "user", "content": prompt},
                ]
                decision = self.llm.structured_output(
                    messages, ScreeningDecision, temperature=temperature
                )
                return {
                    "paper": paper,
                    "decision": decision.decision,
                    "priority_tier": decision.priority_tier,
                    "reason": decision.reason,
                    "exclusion_criterion": decision.exclusion_criterion,
                    "confidence": decision.confidence,
                }
            except Exception as e:
                return {
                    "paper": paper, "decision": "exclude",
                    "priority_tier": "uncertain",
                    "reason": f"Error: {e}", "confidence": "low",
                }

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            results = list(tqdm(executor.map(screen_one, papers), total=len(papers), desc="T/A Screen R2", leave=False))
        return results

    @staticmethod
    def _cohens_kappa(decisions_a: list[str], decisions_b: list[str]) -> float:
        """Compute Cohen's kappa inter-rater reliability coefficient."""
        if len(decisions_a) != len(decisions_b) or len(decisions_a) == 0:
            return 0.0

        n = len(decisions_a)
        categories = list(set(decisions_a + decisions_b))

        # Agreement
        agree = sum(1 for a, b in zip(decisions_a, decisions_b) if a == b)
        p_o = agree / n  # observed agreement

        # Expected agreement by chance
        p_e = 0.0
        for cat in categories:
            p_a = sum(1 for d in decisions_a if d == cat) / n
            p_b = sum(1 for d in decisions_b if d == cat) / n
            p_e += p_a * p_b

        if p_e >= 1.0:
            return 1.0
        kappa = (p_o - p_e) / (1.0 - p_e)
        return round(kappa, 4)

    @classmethod
    def _apply_full_text_role_policy(
        cls,
        result: dict,
        paper: dict,
        parsed: dict,
        *,
        protocol: ResearchProtocol | None = None,
    ) -> dict:
        """Annotate FT-screening records and keep secondary/design papers out of extraction."""
        role = cls._classify_full_text_evidence_role(paper, parsed, protocol=protocol)
        route = "primary_extraction" if role in {"primary_publication", "uncertain"} else "related_source_only"
        paper["evidence_role"] = role
        paper["analysis_route"] = route
        result["evidence_role"] = role
        result["analysis_route"] = route

        if result.get("decision") == "include" and route == "related_source_only":
            result["original_decision"] = "include"
            result["decision"] = "exclude"
            result["exclusion_criterion"] = f"{role}_not_independent_primary_publication"
            role_label = role.replace("_", " ")
            reason = result.get("reason") or ""
            result["reason"] = (
                f"{reason} Deterministic role policy classified this record as {role_label}; "
                "it is retained for audit/narrative context but is not extracted as an independent primary study."
            ).strip()
            if result.get("confidence") in {None, "", "low"}:
                result["confidence"] = "medium"
        return result

    @staticmethod
    def _classify_full_text_evidence_role(
        paper: dict,
        parsed: dict | None = None,
        *,
        protocol: ResearchProtocol | None = None,
    ) -> str:
        """Classify whether a full-text record is a primary trial publication or related source."""
        title = str(paper.get("title") or "")
        title_norm = ScreeningAgent._norm_text(title)
        outcome_norm = ScreeningAgent._norm_text((protocol.pico.outcome_primary if protocol else "") or "")

        design_patterns = [
            r"\brationale and design\b",
            r"\bstudy protocol\b",
            r"\bprotocol\b",
            r"\bdesign of\b",
            r"\bthe design of\b",
            r"\btrial design\b",
        ]
        secondary_patterns = [
            r"\bsubgroup analysis\b",
            r"\bsecondary analysis\b",
            r"\bpost hoc\b",
            r"\bpost-hoc\b",
            r"\bprespecified subgroup\b",
            r"\bpre-specified subgroup\b",
            r"\baccording to\b",
            r"\bby baseline\b",
            r"\bwith and without\b",
            r"\bby age\b",
            r"\bby glycaemic\b",
            r"\bby glycemic\b",
        ]
        surrogate_title_patterns = [
            r"\bcardiac and metabolic effects\b",
            r"\bgut microbiota\b",
            r"\bhemodynamic\b",
            r"\bhaemodynamic\b",
            r"\bpulmonary capillary wedge pressure\b",
            r"\bpcwp\b",
            r"\bkansas city cardiomyopathy questionnaire\b",
            r"\bkccq\b",
            r"\bquality of life\b",
            r"\b6-minute walk\b",
            r"\bsix-minute walk\b",
        ]
        if any(re.search(pattern, title_norm) for pattern in design_patterns):
            return "design_or_protocol"
        if any(re.search(pattern, title_norm) for pattern in secondary_patterns):
            return "secondary_analysis"
        hard_endpoint_review = bool(re.search(r"\b(?:death|mortality|hospitali[sz]ation|hospitali[sz]ations|cardiovascular)\b", outcome_norm))
        if hard_endpoint_review and any(re.search(pattern, title_norm) for pattern in surrogate_title_patterns):
            return "adjacent_outcome_trial"
        return "primary_publication"

    @staticmethod
    def _norm_text(value: str) -> str:
        return " ".join(str(value or "").lower().replace("–", "-").replace("—", "-").split())

    @staticmethod
    def _smart_truncate(text: str, max_chars: int) -> str:
        """Truncate text while prioritizing results/tables sections.

        Strategy: keep first 40% (title/abstract/methods) + last 60% (results/tables/discussion).
        """
        if len(text) <= max_chars:
            return text
        head_size = int(max_chars * 0.4)
        tail_size = max_chars - head_size - 30  # 30 chars for separator
        return text[:head_size] + "\n\n[... middle sections omitted ...]\n\n" + text[-tail_size:]
