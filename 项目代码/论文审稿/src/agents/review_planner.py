"""
Review Planner Agent - Strategic review planning based on study type

This agent generates a targeted review plan by:
1. Analyzing the study type and risk areas
2. Identifying 3-6 key focus points
3. Mapping evidence slots to gather
4. Selecting relevant rubric materials

The plan guides downstream material gathering and report synthesis.
"""

from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime

from ..schemas.document_ir import DocumentIR, StudyProfile
from ..schemas.plan_retrieve_argue import ReviewPlan, ReviewFocus, CoverageSummary
from ..services.llm_gateway import LLMGateway, ModelTier


class ReviewPlannerAgent:
    """
    Strategic review planner that generates a focused review plan.

    Instead of blindly applying all rubric items, this agent:
    1. Understands the study type (RCT, Meta-Analysis, Cohort, etc.)
    2. Identifies high-risk methodological areas
    3. Generates 3-6 targeted focus points
    4. Maps each focus to specific evidence slots
    """

    # Study type to risk area mapping
    STUDY_TYPE_RISKS = {
        "RCT": [
            ("Randomization Integrity", "Selection bias if randomization not properly implemented"),
            ("Allocation Concealment", "Selection bias if allocation not concealed"),
            ("Blinding", "Performance and detection bias if blinding inadequate"),
            ("Outcome Assessment", "Potential bias in outcome measurement"),
            ("ITT Analysis", "Attrition bias if per-protocol only"),
        ],
        "Systematic Review": [
            ("Search Completeness", "Publication bias if search incomplete"),
            ("Study Selection", "Selection bias if criteria not rigorous"),
            ("Quality Assessment", "Integration of low-quality studies"),
            ("Data Extraction", "Errors in extracted data"),
            ("Synthesis Method", "Inappropriate synthesis approach"),
        ],
        "Meta-Analysis": [
            ("Heterogeneity", "Invalid pooling if substantial heterogeneity"),
            ("Publication Bias", "Overestimation of effect if present"),
            ("Transitivity", "Indirect comparison validity in NMA"),
            ("Statistical Methods", "Inappropriate pooling methods"),
            ("Sensitivity Analysis", "Robustness of conclusions"),
        ],
        "Cohort Study": [
            ("Selection Bias", "Non-representative cohort"),
            ("Confounding", "Uncontrolled confounding variables"),
            ("Follow-up Completeness", "Attrition bias if loss to follow-up high"),
            ("Outcome Ascertainment", "Misclassification bias"),
            ("Exposure Assessment", "Measurement error in exposure"),
        ],
        "Case-Control Study": [
            ("Selection of Controls", "Selection bias if controls not representative"),
            ("Recall Bias", "Differential recall between cases and controls"),
            ("Confounding", "Inadequate matching or adjustment"),
            ("Exposure Measurement", "Misclassification of exposure"),
        ],
        "Diagnostic Study": [
            ("Reference Standard", "Imperfect gold standard"),
            ("Spectrum Bias", "Narrow patient spectrum"),
            ("Blinding", "Interpretation bias if not blinded"),
            ("Verification Bias", "Partial verification"),
            ("Clinical Applicability", "Applicability to target population"),
        ],
        "Prognostic Model": [
            ("Model Development", "Overfitting if sample small"),
            ("Predictor Selection", "Data-driven selection bias"),
            ("Internal Validation", "Optimism in performance"),
            ("External Validation", "Generalizability concerns"),
            ("Calibration", "Miscalibration in predictions"),
        ],
        "AI": [
            ("Data Quality", "Bias in training data"),
            ("Model Transparency", "Black-box interpretability"),
            ("External Validation", "Generalizability to new populations"),
            ("Clinical Integration", "Feasibility in clinical workflow"),
            ("Fairness", "Algorithmic bias across subgroups"),
        ],
    }

    # Focus to evidence slot mapping
    FOCUS_EVIDENCE_SLOTS = {
        "Randomization Integrity": ["methods.randomization", "results.participant_flow"],
        "Allocation Concealment": ["methods.randomization", "methods.blinding"],
        "Blinding": ["methods.blinding", "results.outcomes"],
        "Search Completeness": ["methods.full_text", "appendix", "supplementary"],
        "Heterogeneity": ["results.full_text", "tables", "forest_plot"],
        "Publication Bias": ["results.full_text", "funnel_plot", "methods.statistics"],
        "Confounding": ["methods.statistics", "tables", "results.baseline"],
        "Model Development": ["methods.model_development", "methods.statistics"],
        "External Validation": ["methods.model_validation", "results.outcomes"],
    }

    # Focus to rubric material mapping
    FOCUS_RUBRIC_MATERIALS = {
        # CONSORT (RCT)
        "Randomization Integrity": ["CONSORT_8a", "CONSORT_8b"],
        "Allocation Concealment": ["CONSORT_9"],
        "Blinding": ["CONSORT_11a", "CONSORT_11b"],
        "Outcome Assessment": ["CONSORT_6a", "CONSORT_6b"],
        "ITT Analysis": ["CONSORT_16"],
        "Sample Size": ["CONSORT_7a"],
        # PRISMA 2020 (Systematic Review / Meta-Analysis) — item IDs match prisma_2020.yaml
        "Search Completeness": ["PRISMA_6", "PRISMA_7", "PRISMA_8"],
        "Study Selection": ["PRISMA_8", "PRISMA_9", "PRISMA_16"],
        "Quality Assessment": ["PRISMA_11", "PRISMA_15", "PRISMA_18"],
        "Data Extraction": ["PRISMA_9", "PRISMA_10"],
        "Heterogeneity": ["PRISMA_13", "PRISMA_20"],
        "Publication Bias": ["PRISMA_14", "PRISMA_21"],
        "Reporting Completeness": ["PRISMA_1", "PRISMA_2", "PRISMA_4", "PRISMA_5"],
        "Statistical Validity": ["PRISMA_12", "PRISMA_13", "PRISMA_20"],
        "Methodological Rigor": ["PRISMA_11", "PRISMA_13", "PRISMA_14", "PRISMA_15"],
        # STROBE (Observational)
        "Confounding": ["STROBE_12a", "STROBE_12b"],
        "Exposure Assessment": ["STROBE_11"],
        "Outcome Measurement": ["STROBE_12a"],
        # TRIPOD (Prediction Model)
        "Model Development": ["TRIPOD_10a", "TRIPOD_10b"],
        "External Validation": ["TRIPOD_11", "TRIPOD_13"],
        # Generic fallback
        "Ethics Reporting": ["PRISMA_24", "PRISMA_25"],
        "Conflict of Interest": ["PRISMA_26"],
    }

    def __init__(self, llm_gateway: LLMGateway):
        self.llm = llm_gateway

    async def generate_plan(
        self,
        document_ir: DocumentIR,
        study_profile: StudyProfile,
        coverage_summary: CoverageSummary,
        journal_context: Optional[str] = None
    ) -> ReviewPlan:
        """
        Generate a strategic review plan.

        Args:
            document_ir: Structured document representation
            study_profile: Study type classification
            coverage_summary: Document parsing coverage
            journal_context: Optional target journal context

        Returns:
            ReviewPlan with 3-6 targeted focus points
        """
        # Step 1: Identify primary study types
        study_types = study_profile.study_types or ["Unknown"]

        # Step 2: Determine high-risk areas based on study type
        high_risk_areas = self._identify_high_risk_areas(study_types)

        # Step 3: Generate focus points (rule-based + LLM refinement)
        focus_points = await self._generate_focus_points(
            document_ir, study_profile, study_types, high_risk_areas
        )

        # Step 4: Map evidence slots and rubric materials
        for focus in focus_points:
            focus.evidence_slots = self._get_evidence_slots(focus.topic)
            focus.rubric_materials = self._get_rubric_materials(focus.topic)

        # Step 5: Collect all rubric materials to use
        all_materials = []
        for focus in focus_points:
            all_materials.extend(focus.rubric_materials)
        all_materials = list(set(all_materials))  # Deduplicate

        # Step 6: Generate overall strategy description
        strategy = self._generate_strategy_description(study_types, focus_points)

        return ReviewPlan(
            plan_id=f"plan-{uuid.uuid4().hex[:8]}",
            created_at=datetime.now(),
            study_types=study_types,
            journal_context=journal_context,
            review_focus=focus_points,
            overall_strategy=strategy,
            high_risk_areas=[area for area, _ in high_risk_areas[:5]],
            confidence_requirements={f.topic: 0.7 for f in focus_points},
            rubric_materials_to_use=all_materials
        )

    def _identify_high_risk_areas(self, study_types: List[str]) -> List[tuple]:
        """Identify high-risk areas based on study types"""
        risks = []

        for study_type in study_types:
            # Normalize study type name
            normalized = self._normalize_study_type(study_type)
            if normalized in self.STUDY_TYPE_RISKS:
                risks.extend(self.STUDY_TYPE_RISKS[normalized])

        # Deduplicate while preserving order
        seen = set()
        unique_risks = []
        for risk in risks:
            if risk[0] not in seen:
                seen.add(risk[0])
                unique_risks.append(risk)

        return unique_risks

    def _normalize_study_type(self, study_type: str) -> str:
        """Normalize study type to match our risk mapping keys"""
        study_type_lower = study_type.lower()

        # Map variations to canonical names
        mappings = {
            "rct": "RCT",
            "randomized controlled trial": "RCT",
            "randomised controlled trial": "RCT",
            "cluster rct": "RCT",
            "pragmatic rct": "RCT",
            "systematic review": "Systematic Review",
            "meta-analysis": "Meta-Analysis",
            "network meta-analysis": "Meta-Analysis",
            "cohort study": "Cohort Study",
            "cohort": "Cohort Study",
            "case-control study": "Case-Control Study",
            "case-control": "Case-Control Study",
            "diagnostic study": "Diagnostic Study",
            "diagnostic accuracy": "Diagnostic Study",
            "prognostic model": "Prognostic Model",
            "prediction model": "Prognostic Model",
            "ai": "AI",
            "machine learning": "AI",
            "deep learning": "AI",
        }

        for key, value in mappings.items():
            if key in study_type_lower:
                return value

        return study_type

    async def _generate_focus_points(
        self,
        document_ir: DocumentIR,
        study_profile: StudyProfile,
        study_types: List[str],
        high_risk_areas: List[tuple]
    ) -> List[ReviewFocus]:
        """Generate 3-6 focus points using rules and LLM refinement"""

        # Start with rule-based focus points from high-risk areas
        focus_points = []

        for i, (topic, rationale) in enumerate(high_risk_areas[:4]):
            focus_points.append(ReviewFocus(
                topic=topic,
                rationale=rationale,
                evidence_slots=[],  # Will be filled later
                rubric_materials=[],  # Will be filled later
                must_have_evidence=True,
                priority=i + 1
            ))

        # If fewer than 3 focus points, add study-type-specific defaults
        if len(focus_points) < 3:
            default_focuses = [
                ReviewFocus(
                    topic="Reporting Completeness",
                    rationale="Complete reporting is essential for reproducibility and assessment",
                    evidence_slots=["methods.full_text", "results.full_text"],
                    rubric_materials=[],
                    must_have_evidence=True,
                    priority=len(focus_points) + 1
                ),
                ReviewFocus(
                    topic="Statistical Validity",
                    rationale="Sound statistical methods are fundamental to valid conclusions",
                    evidence_slots=["methods.statistics", "results.outcomes"],
                    rubric_materials=[],
                    must_have_evidence=True,
                    priority=len(focus_points) + 2
                ),
            ]
            focus_points.extend(default_focuses[:3 - len(focus_points)])

        # Use LLM to refine and add manuscript-specific focus points
        if document_ir.abstract.text:
            refined_focuses = await self._refine_focus_with_llm(
                document_ir, study_types, focus_points
            )
            if refined_focuses:
                focus_points = refined_focuses

        # Ensure we have at least 3 focus points (required by ReviewPlan schema)
        if len(focus_points) < 3:
            # Add default focuses to reach minimum of 3
            default_focuses = [
                ReviewFocus(
                    topic="Reporting Completeness",
                    rationale="Complete reporting is essential for reproducibility and assessment",
                    evidence_slots=["methods.full_text", "results.full_text"],
                    rubric_materials=[],
                    must_have_evidence=True,
                    priority=len(focus_points) + 1
                ),
                ReviewFocus(
                    topic="Statistical Validity",
                    rationale="Sound statistical methods are fundamental to valid conclusions",
                    evidence_slots=["methods.statistics", "results.outcomes"],
                    rubric_materials=[],
                    must_have_evidence=True,
                    priority=len(focus_points) + 2
                ),
                ReviewFocus(
                    topic="Methodological Rigor",
                    rationale="Rigorous methodology ensures reliable and reproducible results",
                    evidence_slots=["methods.full_text"],
                    rubric_materials=[],
                    must_have_evidence=True,
                    priority=len(focus_points) + 3
                ),
            ]
            # Add only as many as needed to reach 3
            focus_points.extend(default_focuses[:3 - len(focus_points)])

        # Ensure 3-6 focus points (truncate if over 6)
        return focus_points[:6] if len(focus_points) > 6 else focus_points

    async def _refine_focus_with_llm(
        self,
        document_ir: DocumentIR,
        study_types: List[str],
        initial_focuses: List[ReviewFocus]
    ) -> Optional[List[ReviewFocus]]:
        """Use LLM to refine focus points based on manuscript content"""

        # Build context from abstract and methods
        abstract_text = "\n".join(document_ir.abstract.text[:3])
        methods_text = "\n".join(document_ir.methods.full_text.text[:5]) if document_ir.methods.full_text.text else ""

        initial_topics = [f.topic for f in initial_focuses]

        prompt = f"""
You are reviewing a {', '.join(study_types)} manuscript.

ABSTRACT:
{abstract_text[:1500]}

METHODS (excerpt):
{methods_text[:1500]}

---

Initial review focus areas identified: {initial_topics}

Based on the manuscript content, refine these focus areas and identify if there are any ADDITIONAL critical areas to review that are specific to this manuscript.

Return JSON:
{{
  "refined_focuses": [
    {{
      "topic": "Focus topic name",
      "rationale": "Why this is a risk point for THIS specific manuscript",
      "priority": 1-5 (1=highest),
      "must_have_evidence": true/false
    }}
  ]
}}

RULES:
- MUST return between 3-6 focus points (minimum 3 is required)
- Be specific to THIS manuscript, not generic
- Priority 1 = most critical methodological risk
- Rationale should cite specific aspects of the manuscript
- If the initial focus areas are fewer than 3, add more relevant areas
"""

        try:
            result = await self.llm.call_with_json_response(
                messages=[
                    {"role": "system", "content": "You are an expert medical research methodologist. Return valid JSON only."},
                    {"role": "user", "content": prompt}
                ],
                model_tier=ModelTier.STANDARD,
                max_tokens=1500,
                temperature=0.0
            )

            parsed = result.get("parsed_json", {})
            refined_list = parsed.get("refined_focuses", [])

            if refined_list:
                return [
                    ReviewFocus(
                        topic=f.get("topic", "Unknown"),
                        rationale=f.get("rationale", ""),
                        evidence_slots=[],
                        rubric_materials=[],
                        must_have_evidence=f.get("must_have_evidence", True),
                        priority=f.get("priority", 3)
                    )
                    for f in refined_list[:6]
                ]
        except Exception as e:
            print(f"LLM focus refinement failed: {e}")

        return None

    def _get_evidence_slots(self, topic: str) -> List[str]:
        """Get evidence slots for a focus topic"""
        # Try exact match first
        if topic in self.FOCUS_EVIDENCE_SLOTS:
            return self.FOCUS_EVIDENCE_SLOTS[topic]

        # Fuzzy match
        topic_lower = topic.lower()
        for key, slots in self.FOCUS_EVIDENCE_SLOTS.items():
            if key.lower() in topic_lower or topic_lower in key.lower():
                return slots

        # Default slots
        return ["methods.full_text", "results.full_text"]

    def _get_rubric_materials(self, topic: str) -> List[str]:
        """Get rubric material IDs for a focus topic"""
        # Try exact match first
        if topic in self.FOCUS_RUBRIC_MATERIALS:
            return self.FOCUS_RUBRIC_MATERIALS[topic]

        # Fuzzy match
        topic_lower = topic.lower()
        for key, materials in self.FOCUS_RUBRIC_MATERIALS.items():
            if key.lower() in topic_lower or topic_lower in key.lower():
                return materials

        # Return empty - will use default materials
        return []

    def _generate_strategy_description(
        self,
        study_types: List[str],
        focus_points: List[ReviewFocus]
    ) -> str:
        """Generate a human-readable strategy description"""
        study_type_str = ", ".join(study_types) if study_types else "研究"
        focus_topics = [f.topic for f in focus_points[:3]]

        return (
            f"本次审稿针对{study_type_str}类型论文，重点评估以下方法学风险区域："
            f"{', '.join(focus_topics)}。"
            f"审稿将优先检查这些领域的证据完整性和报告质量。"
        )


# Type alias for backwards compatibility
ReviewPlanner = ReviewPlannerAgent
