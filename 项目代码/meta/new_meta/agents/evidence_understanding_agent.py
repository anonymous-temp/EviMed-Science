"""Evidence Understanding agent — turns full texts into auditable clinical study intelligence."""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed

from pydantic import BaseModel, Field
from tqdm import tqdm

from new_meta.config import LLM_MAX_TOKENS_EXTRACTION, MAX_WORKERS
from new_meta.core.agent_base import BaseAgent
from new_meta.core.project import Project
from new_meta.schemas.evidence_understanding import (
    EvidenceUnderstandingReport,
    SourceBackedClaim,
    StudyIntelligenceCard,
)
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.risk_of_bias import StudyRoB
from new_meta.schemas.study import ExtractedStudy
from new_meta.tools.utils import paper_identity


SYSTEM_PROMPT = (
    "You are a senior clinical evidence reviewer. Read source text and extracted data, "
    "then produce source-grounded study intelligence for systematic-review authors. "
    "Do not write manuscript prose. Do not invent. Prefer saying 'not reported' or adding "
    "an unresolved question over filling gaps. Every manuscript-ready claim should include "
    "a source quote or be marked as indirect/unsupported."
)


class StudyUnderstandingDraft(BaseModel):
    """Structured LLM output for one source document."""

    card: StudyIntelligenceCard
    authoring_priorities: list[str] = Field(default_factory=list)
    unresolved_questions: list[str] = Field(default_factory=list)
    audit_notes: list[str] = Field(default_factory=list)


class EvidenceUnderstandingAgent(BaseAgent):
    """Create study cards, risk notes, clinical quirks, and source-backed claims."""

    def __init__(self, model: str = None):
        super().__init__("evidence_understanding", SYSTEM_PROMPT, model=model)

    def run(
        self,
        *,
        included_papers: list[dict],
        parsed_papers: dict[str, dict],
        extracted_studies: list[ExtractedStudy],
        rob_results: list[StudyRoB],
        protocol: ResearchProtocol,
        project: Project,
    ) -> EvidenceUnderstandingReport:
        """Generate and persist a project-level evidence-understanding packet."""
        self.log(f"Building evidence understanding for {len(extracted_studies)} extracted studies...")
        paper_by_key = self._paper_lookup(included_papers)
        parsed_by_key = parsed_papers or {}
        rob_by_id = {str(item.study_id or ""): item for item in rob_results or []}

        def build_one(study: ExtractedStudy) -> StudyUnderstandingDraft:
            paper = self._paper_for_study(study, paper_by_key)
            parsed = self._parsed_for_study(study, paper, parsed_by_key)
            rob = rob_by_id.get(self._study_id(study))
            return self._understand_single(study, paper, parsed, rob, protocol)

        drafts: list[StudyUnderstandingDraft] = []
        with ThreadPoolExecutor(max_workers=max(1, min(MAX_WORKERS, len(extracted_studies) or 1))) as executor:
            futures = {executor.submit(build_one, study): study for study in extracted_studies}
            for future in tqdm(as_completed(futures), total=len(futures), desc="Evidence Understanding", leave=False):
                study = futures[future]
                try:
                    drafts.append(future.result())
                except Exception as exc:
                    self.log(f"Evidence understanding failed for {self._study_id(study)}: {exc}", level="warning")
                    drafts.append(self._fallback_understanding(study, [], f"LLM understanding failed: {exc}"))

        report = EvidenceUnderstandingReport(
            status="ok",
            study_cards=[draft.card for draft in drafts],
            cross_study_claims=self._cross_study_claims(drafts, protocol),
            authoring_priorities=self._dedupe_text(
                priority for draft in drafts for priority in draft.authoring_priorities
            )[:12],
            unresolved_questions=self._dedupe_text(
                question for draft in drafts for question in draft.unresolved_questions
            )[:20],
            audit_notes=self._dedupe_text(
                note for draft in drafts for note in draft.audit_notes
            )[:20],
        )
        project.save_json("evidence_understanding.json", report, subdir="extraction")
        project.save_text("evidence_understanding.md", self.to_markdown(report), subdir="extraction")
        self.log(f"Evidence understanding complete — {len(report.study_cards)} study card(s)")
        return report

    def _understand_single(
        self,
        study: ExtractedStudy,
        paper: dict,
        parsed: dict,
        rob: StudyRoB | None,
        protocol: ResearchProtocol,
    ) -> StudyUnderstandingDraft:
        source_text = self._source_text(paper, parsed)
        extraction_summary = self._extraction_summary(study)
        prompt = (
            "Create a source-grounded clinical study card for systematic-review authoring.\n\n"
            "Rules:\n"
            "- Do not write final manuscript prose.\n"
            "- Every source_backed_claim that could appear in the main manuscript must include source_quote and source_location.\n"
            "- Clinical quirks should be concrete: endpoint hierarchy, dosing, follow-up, population boundary, missing safety data, subgroup caveats, or trial conduct details.\n"
            "- Risk notes should summarize RoB-relevant issues from the supplied RoB and source text without inventing judgments.\n"
            "- If the full text does not support a detail, leave the field blank and add an unresolved question.\n"
            "- Prefer 4-8 source-backed claims per study; mark weak claims as manuscript_use='supplement' or 'exclude'.\n\n"
            "PROTOCOL:\n"
            f"{json.dumps(protocol.model_dump(), ensure_ascii=False, indent=2)[:5000]}\n\n"
            "EXTRACTED STUDY DATA:\n"
            f"{json.dumps(extraction_summary, ensure_ascii=False, indent=2)[:9000]}\n\n"
            "RISK OF BIAS SUMMARY:\n"
            f"{json.dumps(rob.model_dump() if rob else {}, ensure_ascii=False, indent=2)[:5000]}\n\n"
            "SOURCE TEXT EXCERPT:\n"
            f"{source_text[:50000]}"
        )
        try:
            draft = self.call_llm_structured(
                prompt,
                StudyUnderstandingDraft,
                temperature=0.0,
                max_tokens=max(4096, min(LLM_MAX_TOKENS_EXTRACTION, 12000)),
            )
        except Exception as exc:
            return self._fallback_understanding(study, [], f"LLM understanding failed: {exc}")
        self._normalize_card(draft.card, study)
        return draft

    @staticmethod
    def to_markdown(report: EvidenceUnderstandingReport) -> str:
        lines = [
            "# Evidence Understanding",
            "",
            f"- Status: {report.status}",
            f"- Study cards: {len(report.study_cards)}",
            "",
        ]
        if report.authoring_priorities:
            lines.extend(["## Authoring Priorities", ""])
            lines.extend(f"- {item}" for item in report.authoring_priorities)
            lines.append("")
        for card in report.study_cards:
            lines.extend([
                f"## {card.display_name or card.study_id or 'Study'}",
                "",
                f"- Study ID: {card.study_id or 'NR'}",
                f"- Title: {card.title or 'NR'}",
                f"- Design: {card.design or 'NR'}",
                f"- Population: {card.population or 'NR'}",
                f"- Intervention: {card.intervention or 'NR'}",
                f"- Comparator: {card.comparator or 'NR'}",
                f"- Follow-up: {card.follow_up or 'NR'}",
                f"- Primary outcome: {card.primary_outcome or 'NR'}",
                f"- Distinctive feature: {card.distinctive_feature or 'NR'}",
                "",
            ])
            for label, values in (
                ("Clinical quirks", card.clinical_quirks),
                ("Risk notes", card.risk_notes),
                ("Safety notes", card.safety_notes),
                ("Applicability notes", card.applicability_notes),
                ("Unresolved questions", card.unresolved_questions),
            ):
                if values:
                    lines.extend([f"### {label}", ""])
                    lines.extend(f"- {item}" for item in values)
                    lines.append("")
            if card.source_backed_claims:
                lines.extend(["### Source-backed claims", ""])
                lines.append("| Use | Type | Claim | Source | Quote |")
                lines.append("|---|---|---|---|---|")
                for claim in card.source_backed_claims:
                    source = claim.source_location or "NR"
                    if claim.source_page:
                        source += f", p. {claim.source_page}"
                    lines.append(
                        f"| {claim.manuscript_use or 'NR'} | {claim.claim_type or 'NR'} | "
                        f"{_md_cell(claim.claim)} | {_md_cell(source)} | {_md_cell(claim.source_quote)} |"
                    )
                lines.append("")
        if report.cross_study_claims:
            lines.extend(["## Cross-study claims", ""])
            for claim in report.cross_study_claims:
                lines.append(f"- {claim.claim}")
            lines.append("")
        if report.audit_notes:
            lines.extend(["## Audit Notes", ""])
            lines.extend(f"- {item}" for item in report.audit_notes)
            lines.append("")
        return "\n".join(lines).strip() + "\n"

    @staticmethod
    def _paper_lookup(papers: list[dict]) -> dict[str, dict]:
        lookup: dict[str, dict] = {}
        for paper in papers or []:
            keys = {
                paper_identity(paper),
                str(paper.get("pmid") or "").strip(),
                str(paper.get("doi") or "").strip().lower(),
                str(paper.get("title") or "").strip().lower(),
            }
            for key in keys:
                if key:
                    lookup[key] = paper
        return lookup

    @staticmethod
    def _study_id(study: ExtractedStudy) -> str:
        c = study.characteristics
        return str(c.pmid or c.study_id or c.doi or c.title or "").strip()

    def _paper_for_study(self, study: ExtractedStudy, lookup: dict[str, dict]) -> dict:
        c = study.characteristics
        for key in (c.pmid, c.study_id, c.doi.lower() if c.doi else "", c.title.lower() if c.title else ""):
            key = str(key or "").strip()
            if key and key in lookup:
                return lookup[key]
        return {}

    def _parsed_for_study(self, study: ExtractedStudy, paper: dict, parsed: dict[str, dict]) -> dict:
        keys = [paper_identity(paper)] if paper else []
        c = study.characteristics
        keys.extend([c.pmid, c.study_id, c.doi, c.title])
        for key in keys:
            key = str(key or "").strip()
            if key and key in parsed:
                return parsed[key]
        return {}

    @staticmethod
    def _source_text(paper: dict, parsed: dict) -> str:
        parts = []
        if paper:
            parts.extend([
                f"Title: {paper.get('title') or ''}",
                f"Abstract: {paper.get('abstract') or ''}",
            ])
        if parsed:
            parts.append(str(parsed.get("full_text") or ""))
            tables = parsed.get("tables") or []
            if tables:
                parts.append("## EXTRACTED TABLES\n" + "\n\n".join(str(item) for item in tables))
        text = "\n\n".join(part for part in parts if str(part or "").strip())
        text = re.sub(r"\n{4,}", "\n\n\n", text)
        if len(text) > 60000:
            head = text[:24000]
            tail = text[-32000:]
            return head + "\n\n[... middle omitted for prompt length ...]\n\n" + tail
        return text

    @staticmethod
    def _extraction_summary(study: ExtractedStudy) -> dict:
        c = study.characteristics
        return {
            "characteristics": c.model_dump(),
            "outcomes": [
                {
                    "outcome_name": o.outcome_name,
                    "outcome_type": o.outcome_type,
                    "effect_size": o.effect_size,
                    "ci_lower": o.ci_lower,
                    "ci_upper": o.ci_upper,
                    "hazard_ratio": o.hazard_ratio,
                    "hr_ci_lower": o.hr_ci_lower,
                    "hr_ci_upper": o.hr_ci_upper,
                    "events_intervention": o.events_intervention,
                    "total_intervention": o.total_intervention,
                    "events_control": o.events_control,
                    "total_control": o.total_control,
                    "source_location": o.source_location,
                    "source_page": o.source_page,
                    "source_section": o.source_section,
                    "source_quote": o.source_quote,
                    "source_quote_verified": o.source_quote_verified,
                    "extraction_confidence": o.extraction_confidence,
                    "conflicts": [item.model_dump() for item in o.conflicts],
                    "quality_notes": study.quality_notes,
                }
                for o in study.outcomes
            ],
        }

    def _fallback_understanding(
        self,
        study: ExtractedStudy,
        claims: list[SourceBackedClaim],
        note: str,
    ) -> StudyUnderstandingDraft:
        c = study.characteristics
        card = StudyIntelligenceCard(
            study_id=self._study_id(study),
            display_name=self._display_name(study),
            title=c.title,
            design=c.study_design,
            country_or_setting=c.country,
            population=c.population_description,
            intervention=c.intervention_description,
            comparator=c.control_description,
            follow_up=c.follow_up_duration,
            source_backed_claims=claims or self._claims_from_extraction(study),
            unresolved_questions=["Full-text clinical interpretation requires manual review."],
            audit_notes=[note],
        )
        return StudyUnderstandingDraft(card=card, audit_notes=[note])

    def _claims_from_extraction(self, study: ExtractedStudy) -> list[SourceBackedClaim]:
        claims: list[SourceBackedClaim] = []
        for outcome in study.outcomes:
            if not outcome.source_quote:
                continue
            value = outcome.effect_size if outcome.effect_size is not None else outcome.hazard_ratio
            if value is None and outcome.events_intervention is None and outcome.events_control is None:
                continue
            claim_text = f"{outcome.outcome_name} was reported with source-linked quantitative data."
            claims.append(SourceBackedClaim(
                claim=claim_text,
                claim_type="result",
                support_level="direct" if outcome.source_quote_verified else "indirect",
                manuscript_use="main" if outcome.source_quote_verified else "supplement",
                source_location=outcome.source_location,
                source_page=outcome.source_page,
                source_quote=outcome.source_quote,
            ))
        return claims[:8]

    @staticmethod
    def _normalize_card(card: StudyIntelligenceCard, study: ExtractedStudy) -> None:
        c = study.characteristics
        if not card.study_id:
            card.study_id = str(c.pmid or c.study_id or c.doi or "")
        if not card.display_name:
            card.display_name = EvidenceUnderstandingAgent._display_name(study)
        if not card.title:
            card.title = c.title
        if not card.design:
            card.design = c.study_design
        if not card.population:
            card.population = c.population_description
        if not card.intervention:
            card.intervention = c.intervention_description
        if not card.comparator:
            card.comparator = c.control_description
        if not card.follow_up:
            card.follow_up = c.follow_up_duration

    @staticmethod
    def _display_name(study: ExtractedStudy) -> str:
        c = study.characteristics
        year = str(c.year) if c.year else ""
        author = ""
        if c.authors:
            author = str(c.authors[0]).split()[-1]
        elif c.title:
            author = str(c.title).split()[0]
        return " ".join(part for part in (author, year) if part).strip() or c.title or c.pmid or c.study_id or "Study"

    @staticmethod
    def _cross_study_claims(
        drafts: list[StudyUnderstandingDraft],
        protocol: ResearchProtocol,
    ) -> list[SourceBackedClaim]:
        cards = [draft.card for draft in drafts]
        if len(cards) < 2:
            return []
        interventions = [card.intervention for card in cards if card.intervention]
        outcome_windows = [card.outcome_window or card.follow_up for card in cards if card.outcome_window or card.follow_up]
        claims: list[SourceBackedClaim] = []
        if interventions:
            claims.append(SourceBackedClaim(
                claim=(
                    f"Contributing studies evaluated interventions within the review intervention class "
                    f"({'; '.join(interventions[:4])}) for {protocol.pico.outcome_primary}."
                ),
                claim_type="interpretation",
                support_level="interpretive",
                manuscript_use="main",
            ))
        if outcome_windows:
            claims.append(SourceBackedClaim(
                claim="Outcome timing and follow-up should be considered when interpreting the pooled estimate.",
                claim_type="applicability",
                support_level="interpretive",
                manuscript_use="main",
            ))
        return claims[:4]

    @staticmethod
    def _dedupe_text(items) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for item in items:
            text = re.sub(r"\s+", " ", str(item or "")).strip()
            if not text:
                continue
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(text)
        return out


def _md_cell(value: str) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = text.replace("|", "\\|")
    return text[:500]

