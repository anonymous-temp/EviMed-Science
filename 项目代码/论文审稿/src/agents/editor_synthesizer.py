"""
Editor Synthesizer Agent - Final report generation and synthesis

Enhanced for Plan-Retrieve-Argue architecture:
- Receives ReviewPlan and MaterialSnippet[] as input
- Implements Evidence Gate constraint
- Produces controlled, evidence-based reports
"""
from typing import List, Dict, Optional, Tuple
from collections import defaultdict

from ..schemas.rubric import BlockReviewResult, RubricItemOutputSchema, SeverityLevel, VerdictType
from ..schemas.reports import (
    AuthorReport, EditorReport, IssueItem,
    MultiDimensionalScore, UncertaintyMetrics, FusedDecision, DecisionRationale
)
from ..schemas.review_state import SecurityAlert
from ..schemas.cognitive_review import CognitiveReviewResult
from ..schemas.plan_retrieve_argue import (
    ReviewPlan, MaterialSnippet, MaterialStatus, CoverageSummary,
    EvidenceGateResult
)
from ..services.llm_gateway import LLMGateway, ModelTier


class EditorSynthesizerAgent:
    """
    Final synthesis agent that aggregates all review results and generates reports.

    Enhanced for Plan-Retrieve-Argue architecture:
    - Accepts ReviewPlan and MaterialSnippet[] for guided synthesis
    - Implements Evidence Gate: verdicts must be supported by materials
    - Produces controlled, evidence-based reports with coverage notes
    """

    def __init__(self, llm_gateway: LLMGateway):
        self.llm = llm_gateway

    async def synthesize_with_plan(
        self,
        job_id: str,
        manuscript_title: str,
        review_plan: ReviewPlan,
        materials: List[MaterialSnippet],
        coverage_summary: CoverageSummary,
        review_results: List[BlockReviewResult],
        security_alerts: List[SecurityAlert],
        cognitive_result: Optional[CognitiveReviewResult] = None,
        language: str = "en",
        full_rubric_items: Optional[Dict[str, str]] = None,
    ) -> Tuple[AuthorReport, EditorReport]:
        """
        Enhanced synthesis using Plan-Retrieve-Argue architecture.

        Key differences from legacy synthesize():
        1. Uses ReviewPlan to guide report focus
        2. Uses MaterialSnippet[] for evidence-based writing
        3. Applies Evidence Gate before finalizing verdicts
        4. Includes coverage summary in output
        5. full_rubric_items: {item_id -> official question} for complete compliance table
        """
        # Step 1: Apply Evidence Gate to review results
        gated_results = self._apply_evidence_gate(review_results, materials, coverage_summary)

        # Step 2: Generate coverage note for reports
        coverage_note = coverage_summary.generate_coverage_note() if coverage_summary else ""

        # Step 3: Use legacy synthesize with gated results
        # Extract unique rubric names from plan materials (e.g. "PRISMA_6" -> "PRISMA")
        rubric_names = list(dict.fromkeys(
            m.split("_")[0] for m in review_plan.rubric_materials_to_use
            if m and "_" in m
        ))

        # Fallback 1: extract from actual review result item IDs
        if not rubric_names:
            rubric_names = list(dict.fromkeys(
                item.item_id.split("_")[0]
                for block in gated_results
                for item in block.results
                if item.item_id and "_" in item.item_id
            ))

        # Fallback 2: map study types to known rubric names
        if not rubric_names:
            _type_to_rubric = {
                "systematic review": "PRISMA", "meta-analysis": "PRISMA",
                "rct": "CONSORT", "randomized": "CONSORT",
                "cohort": "STROBE", "case-control": "STROBE", "cross-sectional": "STROBE",
                "diagnostic": "STARD", "guideline": "PRISMA", "protocol": "PRISMA",
            }
            for st in review_plan.study_types:
                st_lower = st.lower()
                for key, rubric in _type_to_rubric.items():
                    if key in st_lower and rubric not in rubric_names:
                        rubric_names.append(rubric)

        # Final fallback: label as generic reporting guideline
        if not rubric_names:
            rubric_names = ["报告规范"] if language == "zh" else ["Reporting Guidelines"]

        author_report, editor_report = await self.synthesize(
            job_id=job_id,
            manuscript_title=manuscript_title,
            study_types=review_plan.study_types,
            checklists_applied=rubric_names,
            review_results=gated_results,
            security_alerts=security_alerts,
            cognitive_result=cognitive_result,
            language=language
        )

        # Step 4: Rebuild all_rubric_items with official question text and complete item list
        if full_rubric_items:
            # Build verdict lookup from gated results
            verdict_map: Dict[str, str] = {}
            for block in gated_results:
                for item in block.results:
                    verdict_val = item.verdict.value if hasattr(item.verdict, "value") else str(item.verdict)
                    verdict_map[item.item_id] = verdict_val

            complete_items = [
                {
                    "item_id": iid,
                    "question": question,
                    "verdict": verdict_map.get(iid, "UNCERTAIN"),
                }
                for iid, question in full_rubric_items.items()
            ]
            editor_report = editor_report.model_copy(update={"all_rubric_items": complete_items})

        # Step 5: Append coverage note to reports
        author_report.introduction = f"{author_report.introduction}\n\n{coverage_note}"

        return author_report, editor_report

    def _apply_evidence_gate(
        self,
        review_results: List[BlockReviewResult],
        materials: List[MaterialSnippet],
        coverage_summary: Optional[CoverageSummary]
    ) -> List[BlockReviewResult]:
        """
        Apply Evidence Gate: Ensure FAIL verdicts are supported by evidence.

        Rules:
        1. FAIL verdict requires Material with status=NOT_FOUND
        2. If Material status=UNCLEAR, downgrade FAIL to UNCERTAIN
        3. If section not parsed (coverage gap), downgrade FAIL to UNCERTAIN
        """
        # Build material lookup by item_id
        material_by_item = {m.rubric_item_id: m for m in materials}

        # Build parsed sections set from coverage summary
        parsed_sections = set()
        if coverage_summary:
            for section in coverage_summary.sections_found:
                if section.is_present:
                    parsed_sections.add(section.section_name.lower())

        gated_results = []

        for block in review_results:
            gated_items = []

            for item in block.results:
                gated_item = self._apply_gate_to_item(
                    item, material_by_item, parsed_sections
                )
                gated_items.append(gated_item)

            gated_results.append(BlockReviewResult(
                block_id=block.block_id,
                block_name=block.block_name,
                results=gated_items,
                execution_time_seconds=block.execution_time_seconds,
                error_log=block.error_log
            ))

        return gated_results

    def _apply_gate_to_item(
        self,
        item: RubricItemOutputSchema,
        material_by_item: Dict[str, MaterialSnippet],
        parsed_sections: set
    ) -> RubricItemOutputSchema:
        """Apply Evidence Gate to a single item"""

        # Only gate FAIL verdicts
        if not hasattr(item, 'verdict') or item.verdict != VerdictType.FAIL:
            return item

        # Check if we have material for this item
        material = material_by_item.get(item.item_id)

        # Gate 1: If no material, downgrade to UNCERTAIN
        if not material:
            return self._downgrade_verdict(
                item, VerdictType.UNCERTAIN,
                "No material gathered for this item; cannot confirm absence"
            )

        # Gate 2: If material status is UNCLEAR, downgrade to UNCERTAIN
        if material.status == MaterialStatus.UNCLEAR:
            return self._downgrade_verdict(
                item, VerdictType.UNCERTAIN,
                "Evidence is ambiguous; cannot confirm absence"
            )

        # Gate 3: Check if relevant section was parsed
        evidence_location = item.evidence_location[0] if item.evidence_location else ""
        section_name = evidence_location.split(".")[0].lower() if evidence_location else ""

        if section_name and section_name not in parsed_sections:
            return self._downgrade_verdict(
                item, VerdictType.UNCERTAIN,
                f"Section '{section_name}' was not parsed; cannot confirm absence"
            )

        # Gate 4: Material confirms NOT_FOUND - FAIL is valid
        if material.status == MaterialStatus.NOT_FOUND:
            return item

        # Default: Keep original verdict
        return item

    def _downgrade_verdict(
        self,
        item: RubricItemOutputSchema,
        new_verdict: VerdictType,
        reason: str
    ) -> RubricItemOutputSchema:
        """Create a new item with downgraded verdict"""
        # Create a copy with modified verdict
        return RubricItemOutputSchema(
            item_id=item.item_id,
            status=item.status,
            verdict=new_verdict,
            score=item.score,
            confidence=min(item.confidence, 0.5),  # Lower confidence for downgraded verdicts
            severity=SeverityLevel.NONE if new_verdict == VerdictType.UNCERTAIN else item.severity,
            evidence_spans=item.evidence_spans,
            evidence_quote=item.evidence_quote,
            evidence_location=item.evidence_location,
            missing_detail=f"{item.missing_detail or ''} [Evidence Gate: {reason}]",
            risk_reason=item.risk_reason,
            actionable_fix=item.actionable_fix,
            what_would_change_verdict=item.what_would_change_verdict,
            confidence_score=min(item.confidence_score, 0.5),
            context_quality=item.context_quality,
            search_strategy=item.search_strategy
        )

    async def synthesize(
        self,
        job_id: str,
        manuscript_title: str,
        study_types: List[str],
        checklists_applied: List[str],
        review_results: List[BlockReviewResult],
        security_alerts: List[SecurityAlert],
        cognitive_result: Optional[CognitiveReviewResult] = None,
        language: str = "en"
    ) -> tuple[AuthorReport, EditorReport]:
        """
        Enhanced synthesis with fused decision-making.

        Args:
            job_id: Unique job identifier
            manuscript_title: Title of the manuscript
            study_types: Identified study methodology types
            checklists_applied: Names of checklists that were applied
            review_results: Results from all reviewer agents
            security_alerts: Security and ethics alerts
            cognitive_result: Optional high-level cognitive review result

        Returns:
            Tuple of (AuthorReport, EditorReport)
        """
        # Step 1: Calculate multi-dimensional scores
        scores = self._calculate_multidimensional_scores(review_results, cognitive_result)

        # Step 2: Calculate uncertainty metrics
        uncertainty_metrics = self._calculate_uncertainty_metrics(review_results)

        # Step 3: Aggregate and categorize findings
        all_findings = self._aggregate_findings(review_results)
        unique_findings = self._deduplicate_findings(all_findings)

        # Categorize by severity (for author report)
        critical_findings = [f for f in unique_findings if f.severity == SeverityLevel.CRITICAL]
        major_findings = [f for f in unique_findings if f.severity == SeverityLevel.MAJOR]
        minor_findings = [f for f in unique_findings if f.severity == SeverityLevel.MINOR]

        # Categorize by type (for editor report)
        reporting_issues, methodological_issues = self._categorize_issues(unique_findings)

        # Step 4: Make fused decision
        decision_rationale = self._make_fused_decision(
            scores,
            review_results,
            cognitive_result,
            len(critical_findings),
            len(major_findings),
            language=language
        )

        # Step 5: Extract cognitive assessments
        if cognitive_result:
            novelty_assessment = cognitive_result.originality_analysis
            contribution_assessment = cognitive_result.contribution_analysis
            key_strengths = [s.description for s in cognitive_result.key_strengths]
            key_weaknesses = [w.description for w in cognitive_result.key_weaknesses]
            fatal_flaws = [f.description for f in cognitive_result.fatal_flaws]
        else:
            novelty_assessment = "Cognitive review not available"
            contribution_assessment = "Cognitive review not available"
            key_strengths = []
            key_weaknesses = []
            fatal_flaws = []

        # Step 5.5: Generate methodology assessment
        methodology_assessment = self._generate_methodology_assessment(
            review_results, scores, critical_count=len(critical_findings),
            major_count=len(major_findings), language=language
        )

        # Step 6: Generate compliance summary
        compliance_summary = self._generate_compliance_summary(review_results, checklists_applied, language=language)

        # Step 7: Generate Author Report (detailed, constructive)
        author_report = await self._generate_author_report(
            job_id=job_id,
            manuscript_title=manuscript_title,
            checklists_applied=checklists_applied,
            critical_findings=critical_findings,
            major_findings=major_findings,
            minor_findings=minor_findings,
            language=language
        )

        # Step 8: Build EditorReport with new structure
        # Collect all rubric items (including PASS) for compliance table
        all_rubric_items = []
        seen_ids = set()
        for block_result in review_results:
            for item in block_result.results:
                if item.item_id not in seen_ids:
                    seen_ids.add(item.item_id)
                    all_rubric_items.append({
                        "item_id": item.item_id,
                        "question": item.missing_detail or "",
                        "verdict": item.verdict.value if hasattr(item.verdict, 'value') else str(item.verdict),
                    })

        editor_report = EditorReport(
            job_id=job_id,
            manuscript_title=manuscript_title,
            language=language,
            scores=scores,
            compliance_summary=compliance_summary,
            reporting_issues=reporting_issues,
            methodological_issues=methodological_issues,
            all_rubric_items=all_rubric_items,
            methodology_assessment=methodology_assessment,
            novelty_assessment=novelty_assessment,
            contribution_assessment=contribution_assessment,
            key_strengths=key_strengths,
            key_weaknesses=key_weaknesses,
            fatal_flaws=fatal_flaws,
            decision_rationale=decision_rationale,
            uncertainty_metrics=uncertainty_metrics,
            # Legacy fields for backward compatibility
            recommendation=decision_rationale.decision.value,
            executive_summary=decision_rationale.primary_reason,
            critical_risks=[f"{f.item_id}: {f.risk_reason or f.missing_detail or 'Issue identified'}" for f in critical_findings[:5]],
            major_risks=[f"{f.item_id}: {f.risk_reason or f.missing_detail or 'Issue identified'}" for f in major_findings[:5]],
            study_types_identified=study_types,
            checklists_applied=checklists_applied,
            total_issues=len(unique_findings),
            critical_count=len(critical_findings),
            major_count=len(major_findings),
            minor_count=len(minor_findings),
            overall_quality_score=(scores.reporting + scores.rigor) / 2,  # Legacy
            reporting_completeness_score=scores.reporting,  # Legacy
            methodological_rigor_score=scores.rigor,  # Legacy
            security_alerts=[alert.evidence for alert in security_alerts]
        )

        return author_report, editor_report

    def _aggregate_findings(self, review_results: List[BlockReviewResult]) -> List[RubricItemOutputSchema]:
        """Collect all findings from all review blocks"""
        all_findings = []

        for block_result in review_results:
            for item_result in block_result.results:
                # Only include findings that are not fully met (score < 2)
                if item_result.score < 2 and item_result.severity != SeverityLevel.NONE:
                    all_findings.append(item_result)

        return all_findings

    def _deduplicate_findings(self, findings: List[RubricItemOutputSchema]) -> List[RubricItemOutputSchema]:
        """
        Remove duplicate findings.

        In production, this would use more sophisticated similarity detection.
        For now, we just deduplicate by item_id.
        """
        seen_ids = set()
        unique = []

        for finding in findings:
            if finding.item_id not in seen_ids:
                unique.append(finding)
                seen_ids.add(finding.item_id)

        return unique

    async def _generate_author_report(
        self,
        job_id: str,
        manuscript_title: str,
        checklists_applied: List[str],
        critical_findings: List[RubricItemOutputSchema],
        major_findings: List[RubricItemOutputSchema],
        minor_findings: List[RubricItemOutputSchema],
        language: str = "en"
    ) -> AuthorReport:
        """Generate detailed author-facing report with constructive feedback"""

        # Convert findings to IssueItems
        critical_issues = [self._finding_to_issue(f) for f in critical_findings]
        major_issues = [self._finding_to_issue(f) for f in major_findings]
        minor_issues = [self._finding_to_issue(f) for f in minor_findings]

        total_issues = len(critical_issues) + len(major_issues) + len(minor_issues)

        # Use LLM to generate polished introduction and conclusion if there are issues
        if total_issues > 0:
            summary_prompt = self._build_author_summary_prompt(
                manuscript_title,
                critical_issues,
                major_issues,
                minor_issues,
                language
            )

            try:
                result = await self.llm.call_with_retry(
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a constructive, supportive academic editor helping authors improve their manuscript." + (" 请全程使用中文回复，不得混入英文。" if language == "zh" else "")
                        },
                        {
                            "role": "user",
                            "content": summary_prompt
                        }
                    ],
                    model_tier=ModelTier.ADVANCED,
                    temperature=0.5,
                    max_tokens=1000
                )

                intro_and_conclusion = result["content"]
                # Parse into intro and conclusion (simple split for now)
                parts = intro_and_conclusion.split("---CONCLUSION---")
                introduction = parts[0].strip() if parts else AuthorReport.model_fields["introduction"].default
                conclusion = parts[1].strip() if len(parts) > 1 else AuthorReport.model_fields["conclusion"].default

            except Exception:
                # Fallback to defaults
                introduction = AuthorReport.model_fields["introduction"].default
                conclusion = AuthorReport.model_fields["conclusion"].default
        else:
            if language == "zh":
                introduction = "恭喜！本次自动预审未发现您稿件中存在显著问题。"
                conclusion = "您的稿件已符合主要报告规范要求，祝同行评审顺利！"
            else:
                introduction = "Congratulations! Our automated pre-review found no significant issues with your manuscript."
                conclusion = "Your manuscript appears to meet all major reporting standards. Good luck with peer review!"

        return AuthorReport(
            job_id=job_id,
            manuscript_title=manuscript_title,
            language=language,
            critical_issues=critical_issues,
            major_issues=major_issues,
            minor_issues=minor_issues,
            total_issues=total_issues,
            checklists_applied=checklists_applied,
            introduction=introduction,
            conclusion=conclusion
        )

    async def _generate_editor_report(
        self,
        job_id: str,
        manuscript_title: str,
        study_types: List[str],
        checklists_applied: List[str],
        critical_findings: List[RubricItemOutputSchema],
        major_findings: List[RubricItemOutputSchema],
        minor_findings: List[RubricItemOutputSchema],
        security_alerts: List[SecurityAlert]
    ) -> EditorReport:
        """Generate concise editor-facing report with decision recommendation"""

        # Determine recommendation based on findings
        recommendation = self._determine_recommendation(
            len(critical_findings),
            len(major_findings),
            security_alerts
        )

        # Generate executive summary using LLM
        summary_prompt = self._build_editor_summary_prompt(
            manuscript_title,
            recommendation,
            critical_findings,
            major_findings
        )

        try:
            result = await self.llm.call_with_retry(
                messages=[
                    {
                        "role": "system",
                        "content": "You are a senior journal editor writing a concise pre-review assessment." + (" 请全程使用中文回复，不得混入英文。" if language == "zh" else "")
                    },
                    {
                        "role": "user",
                        "content": summary_prompt
                    }
                ],
                model_tier=ModelTier.ADVANCED,
                temperature=0.4,
                max_tokens=500
            )

            executive_summary = result["content"]

        except Exception:
            # Fallback summary
            executive_summary = f"Manuscript identified as {', '.join(study_types)}. Found {len(critical_findings)} critical and {len(major_findings)} major methodological issues."

        # Extract risk summaries
        critical_risks = [f"{f.item_id}: {f.risk_reason}" for f in critical_findings if f.risk_reason][:5]
        major_risks = [f"{f.item_id}: {f.risk_reason}" for f in major_findings if f.risk_reason][:5]

        # Security alert summaries
        security_alert_texts = [f"{a.alert_type.value}: {a.evidence[:100]}" for a in security_alerts]

        # Calculate quantitative scores
        scores = self._calculate_quality_scores(
            critical_findings,
            major_findings,
            minor_findings,
            security_alerts
        )

        return EditorReport(
            job_id=job_id,
            manuscript_title=manuscript_title,
            recommendation=recommendation,
            executive_summary=executive_summary,
            critical_risks=critical_risks,
            major_risks=major_risks,
            study_types_identified=study_types,
            checklists_applied=checklists_applied,
            total_issues=len(critical_findings) + len(major_findings) + len(minor_findings),
            critical_count=len(critical_findings),
            major_count=len(major_findings),
            minor_count=len(minor_findings),
            security_alerts=security_alert_texts,
            overall_quality_score=scores["overall"],
            reporting_completeness_score=scores["reporting"],
            methodological_rigor_score=scores["methodology"]
        )

    def _finding_to_issue(self, finding: RubricItemOutputSchema) -> IssueItem:
        """Convert RubricItemOutputSchema to IssueItem for report"""
        # Extract category from item_id (e.g., "CONSORT_8a" -> "Randomization")
        # This is a simplified version; in production, maintain a proper mapping
        category = finding.item_id.split("_")[0] if "_" in finding.item_id else "General"

        return IssueItem(
            category=category,
            severity=finding.severity,
            description=finding.missing_detail or "Issue identified",
            evidence=finding.evidence_quote,
            recommendation=finding.actionable_fix or "Please review this section.",
            checklist_reference=finding.item_id
        )

    def _calculate_quality_scores(
        self,
        critical_findings: List[RubricItemOutputSchema],
        major_findings: List[RubricItemOutputSchema],
        minor_findings: List[RubricItemOutputSchema],
        security_alerts: List[SecurityAlert]
    ) -> Dict[str, float]:
        """
        Calculate quantitative quality scores (0-100 scale).

        Scoring formula:
        - Start with 100 points
        - Deduct points for issues: Critical (-10), Major (-5), Minor (-2)
        - Security alerts: Critical (-15), Major (-10)
        - Floor score at 0
        """
        # Calculate overall quality score
        overall_score = 100.0
        overall_score -= len(critical_findings) * 10
        overall_score -= len(major_findings) * 5
        overall_score -= len(minor_findings) * 2

        # Deduct for security issues
        critical_security = sum(1 for a in security_alerts if a.severity == "CRITICAL")
        major_security = sum(1 for a in security_alerts if a.severity == "MAJOR")
        overall_score -= critical_security * 15
        overall_score -= major_security * 10

        overall_score = max(0, overall_score)

        # Calculate reporting completeness score (focus on reporting items)
        reporting_score = 100.0
        reporting_score -= len(critical_findings) * 12
        reporting_score -= len(major_findings) * 6
        reporting_score -= len(minor_findings) * 2
        reporting_score = max(0, reporting_score)

        # Calculate methodological rigor score (focus on methods quality)
        method_score = 100.0
        method_score -= len(critical_findings) * 8
        method_score -= len(major_findings) * 4
        method_score -= len(minor_findings) * 1
        method_score = max(0, method_score)

        return {
            "overall": round(overall_score, 1),
            "reporting": round(reporting_score, 1),
            "methodology": round(method_score, 1)
        }

    def _determine_recommendation(
        self,
        critical_count: int,
        major_count: int,
        security_alerts: List[SecurityAlert]
    ) -> str:
        """Determine editorial recommendation based on findings"""

        # Check for critical security issues
        has_critical_security = any(a.severity == "CRITICAL" for a in security_alerts)

        if has_critical_security:
            return "REJECT"
        elif critical_count >= 3:
            return "REJECT"
        elif critical_count >= 1 or major_count >= 5:
            return "MAJOR_REVISION"
        elif major_count >= 1:
            return "MINOR_REVISION"
        else:
            return "SEND_FOR_REVIEW"

    def _build_author_summary_prompt(
        self,
        title: str,
        critical_issues: List[IssueItem],
        major_issues: List[IssueItem],
        minor_issues: List[IssueItem],
        language: str = "en"
    ) -> str:
        """Build prompt for generating author report introduction and conclusion"""
        if language == "zh":
            return f"""请为一份自动稿件预审报告撰写简短的开篇介绍和结语，使用中文。

稿件："{title}"
发现问题：严重问题 {len(critical_issues)} 个，重要问题 {len(major_issues)} 个，次要问题 {len(minor_issues)} 个

请撰写：
1. 温暖、鼓励性的2-3句开篇介绍，感谢作者投稿并说明本次自动预审的目的
2. 然后写：---CONCLUSION---
3. 然后用2-3句话写结语，鼓励作者修改并提供后续步骤

语气：专业、建设性、支持性，不要苛刻或令人沮丧。
"""
        return f"""
Write a brief, constructive introduction and conclusion for an automated manuscript review report.

Manuscript: "{title}"
Issues found: {len(critical_issues)} critical, {len(major_issues)} major, {len(minor_issues)} minor

Write:
1. A warm, encouraging 2-3 sentence introduction thanking the authors and explaining the purpose of the automated review
2. Then write: ---CONCLUSION---
3. Then a brief 2-3 sentence conclusion encouraging revision and providing next steps

Tone: Professional, constructive, supportive. Not harsh or discouraging.
"""

    def _build_editor_summary_prompt(
        self,
        title: str,
        recommendation: str,
        critical_findings: List[RubricItemOutputSchema],
        major_findings: List[RubricItemOutputSchema]
    ) -> str:
        """Build prompt for generating editor executive summary"""
        findings_text = ""
        if critical_findings:
            findings_text += f"\nCritical issues: {', '.join([f.item_id for f in critical_findings[:3]])}"
        if major_findings:
            findings_text += f"\nMajor issues: {', '.join([f.item_id for f in major_findings[:3]])}"

        return f"""
Write a concise executive summary (3-4 sentences) for a journal editor about this manuscript pre-review.

Manuscript: "{title}"
Recommendation: {recommendation}
{findings_text}

Summarize the key findings and why this recommendation was made. Be objective and professional.
"""

    def _calculate_multidimensional_scores(
        self,
        review_results: List[BlockReviewResult],
        cognitive_result: Optional[CognitiveReviewResult]
    ) -> MultiDimensionalScore:
        """Calculate multi-dimensional scores from rubric and cognitive review"""

        # Count verdicts for rubric-based scores
        total_items = 0
        pass_count = 0
        fail_count = 0
        partial_count = 0

        critical_count = 0
        major_count = 0

        for block in review_results:
            for item in block.results:
                total_items += 1

                # Count verdicts
                if hasattr(item, 'verdict'):
                    if item.verdict == VerdictType.PASS:
                        pass_count += 1
                    elif item.verdict == VerdictType.FAIL:
                        fail_count += 1
                    elif item.verdict == VerdictType.PARTIAL:
                        partial_count += 1
                else:
                    # Fallback to score
                    if item.score == 2:
                        pass_count += 1
                    elif item.score == 1:
                        partial_count += 1
                    else:
                        fail_count += 1

                # Count severity
                if item.severity == SeverityLevel.CRITICAL:
                    critical_count += 1
                elif item.severity == SeverityLevel.MAJOR:
                    major_count += 1

        # Calculate reporting score (0-100)
        # Based on pass rate, penalized by failures
        if total_items > 0:
            pass_rate = pass_count / total_items
            partial_rate = partial_count / total_items
            reporting = (pass_rate * 100 + partial_rate * 50)
        else:
            reporting = 50.0

        # Calculate rigor score (0-100)
        # Based on pass rate, heavily penalized by critical/major issues
        if total_items > 0:
            rigor = reporting - (critical_count * 10) - (major_count * 5)
            rigor = max(0.0, min(100.0, rigor))
        else:
            rigor = 50.0

        # Extract novelty and contribution from cognitive review
        if cognitive_result:
            # Convert 0-10 scale to 0-100 scale
            novelty = cognitive_result.novelty_score * 10
            contribution = cognitive_result.contribution_score * 10
        else:
            novelty = 50.0
            contribution = 50.0

        return MultiDimensionalScore(
            reporting=reporting,
            rigor=rigor,
            novelty=novelty,
            contribution=contribution
        )

    def _calculate_uncertainty_metrics(
        self,
        review_results: List[BlockReviewResult]
    ) -> UncertaintyMetrics:
        """Calculate uncertainty metrics for false positive protection"""

        total_items = 0
        uncertain_count = 0
        stage3_count = 0
        unlocated_items = []
        low_confidence_items = []

        for block in review_results:
            for item in block.results:
                total_items += 1

                # Count UNCERTAIN verdicts
                if hasattr(item, 'verdict') and item.verdict == VerdictType.UNCERTAIN:
                    uncertain_count += 1
                    unlocated_items.append(item.item_id)

                # Count Stage 3 fallback
                if hasattr(item, 'search_strategy') and item.search_strategy == "full_text_scan":
                    stage3_count += 1

                # Count low confidence
                confidence = getattr(item, 'confidence', getattr(item, 'confidence_score', 1.0))
                if confidence < 0.5:
                    low_confidence_items.append(item.item_id)

        uncertain_percentage = (uncertain_count / total_items * 100) if total_items > 0 else 0.0

        # Generate warning if uncertainty is high
        warning = None
        if uncertain_percentage > 20:
            warning = f"High uncertainty detected ({uncertain_percentage:.1f}%). Many items could not be confidently evaluated. Manual review strongly recommended."
        elif uncertain_percentage > 10:
            warning = f"Moderate uncertainty detected ({uncertain_percentage:.1f}%). Some items may represent retrieval failures rather than confirmed deficiencies."

        return UncertaintyMetrics(
            total_items_evaluated=total_items,
            uncertain_count=uncertain_count,
            uncertain_percentage=uncertain_percentage,
            stage3_fallback_count=stage3_count,
            unlocated_items=unlocated_items,
            low_confidence_items=low_confidence_items,
            warning_message=warning
        )

    def _categorize_issues(
        self,
        findings: List[RubricItemOutputSchema]
    ) -> tuple[List[IssueItem], List[IssueItem]]:
        """Categorize issues into reporting vs methodological"""

        reporting_issues = []
        methodological_issues = []

        reporting_keywords = ['reporting', 'description', 'clarity', 'documentation', 'presentation']
        methodological_keywords = ['method', 'design', 'statistic', 'analysis', 'validation', 'bias', 'randomization']

        for finding in findings:
            issue = self._finding_to_issue(finding)

            # Categorize based on category and item_id
            category_lower = finding.category.lower() if hasattr(finding, 'category') else ""
            item_id_lower = finding.item_id.lower()

            is_reporting = any(kw in category_lower or kw in item_id_lower for kw in reporting_keywords)
            is_methodological = any(kw in category_lower or kw in item_id_lower for kw in methodological_keywords)

            if is_reporting and not is_methodological:
                reporting_issues.append(issue)
            else:
                methodological_issues.append(issue)

        return reporting_issues, methodological_issues

    def _make_fused_decision(
        self,
        scores: MultiDimensionalScore,
        review_results: List[BlockReviewResult],
        cognitive_result: Optional[CognitiveReviewResult],
        critical_count: int,
        major_count: int,
        language: str = "zh"
    ) -> DecisionRationale:
        """Make fused decision using rules + evidence"""
        zh = language == "zh"

        decision_rules = []
        supporting_factors = []
        rubric_evidence = []
        cognitive_evidence = []

        # Extract evidence
        if critical_count > 0:
            rubric_evidence.append(f"规范核查发现 {critical_count} 个严重问题" if zh else f"{critical_count} critical issues identified in rubric evaluation")
        if major_count > 0:
            rubric_evidence.append(f"规范核查发现 {major_count} 个重要问题" if zh else f"{major_count} major issues identified in rubric evaluation")

        if cognitive_result:
            if cognitive_result.fatal_flaws:
                cognitive_evidence.append(f"认知审查发现 {len(cognitive_result.fatal_flaws)} 个致命缺陷（详见下方致命缺陷章节）" if zh else f"{len(cognitive_result.fatal_flaws)} fatal flaws identified")

        # Rule 1: Fatal flaws + low rigor → REJECT
        if cognitive_result and cognitive_result.fatal_flaws and scores.rigor < 40:
            return DecisionRationale(
                decision=FusedDecision.REJECT,
                primary_reason="存在致命方法学缺陷且严谨性得分过低" if zh else "Fatal methodological flaws with low rigor score",
                supporting_factors=[
                    f"方法严谨性得分：{scores.rigor:.1f}/100" if zh else f"Rigor score: {scores.rigor:.1f}/100",
                    f"致命缺陷：{len(cognitive_result.fatal_flaws)} 项（详见下方致命缺陷章节）" if zh else f"Fatal flaws: {len(cognitive_result.fatal_flaws)} (see Fatal Flaws section below)",
                    "研究有效性存在根本性问题" if zh else "Study validity is compromised"
                ],
                rubric_evidence=rubric_evidence,
                cognitive_evidence=cognitive_evidence,
                decision_rules_applied=["规则1：方法严谨性 < 40 且存在致命缺陷 → 拒稿" if zh else "Rule 1: Rigor < 40 AND fatal_flaws → REJECT"]
            )

        # Rule 2: Multiple critical issues + low rigor → MAJOR_REVISION
        if scores.rigor < 60 and critical_count > 2:
            return DecisionRationale(
                decision=FusedDecision.MAJOR_REVISION,
                primary_reason="存在多个严重方法学问题，需大幅修改" if zh else "Multiple critical methodological issues require major revision",
                supporting_factors=[
                    f"方法严谨性得分：{scores.rigor:.1f}/100" if zh else f"Rigor score: {scores.rigor:.1f}/100",
                    f"严重问题数：{critical_count}" if zh else f"Critical issues: {critical_count}",
                    "需要对方法学进行实质性改进" if zh else "Substantial methodological improvements needed"
                ],
                rubric_evidence=rubric_evidence,
                cognitive_evidence=cognitive_evidence,
                decision_rules_applied=["规则2：方法严谨性 < 60 且严重问题 > 2 → 大修" if zh else "Rule 2: Rigor < 60 AND critical_issues > 2 → MAJOR_REVISION"]
            )

        # Rule 3: Incremental work (high reporting but low novelty/contribution) → REJECT
        if scores.reporting > 70 and scores.novelty < 40 and scores.contribution < 40:
            return DecisionRationale(
                decision=FusedDecision.REJECT,
                primary_reason="报告规范性尚可，但研究新颖性与科学贡献度不足" if zh else "Well-reported but incremental work with limited scientific contribution",
                supporting_factors=[
                    f"报告规范性：{scores.reporting:.1f}/100" if zh else f"Reporting: {scores.reporting:.1f}/100",
                    f"研究新颖性：{scores.novelty:.1f}/100" if zh else f"Novelty: {scores.novelty:.1f}/100",
                    f"科学贡献度：{scores.contribution:.1f}/100" if zh else f"Contribution: {scores.contribution:.1f}/100",
                    "对现有知识的推进不足" if zh else "Insufficient advancement of knowledge"
                ],
                rubric_evidence=rubric_evidence,
                cognitive_evidence=cognitive_evidence,
                decision_rules_applied=["规则3：报告规范性高但新颖性与贡献度低 → 拒稿" if zh else "Rule 3: High reporting BUT low novelty/contribution → REJECT"]
            )

        # Rule 4: High novelty but poor reporting → MAJOR_REVISION
        if scores.novelty > 80 and scores.reporting < 60:
            return DecisionRationale(
                decision=FusedDecision.MAJOR_REVISION,
                primary_reason="研究具有较高新颖性，但报告规范性存在明显不足，需大幅修改" if zh else "Novel and valuable work but significant reporting gaps must be addressed",
                supporting_factors=[
                    f"研究新颖性：{scores.novelty:.1f}/100" if zh else f"Novelty: {scores.novelty:.1f}/100",
                    f"报告规范性：{scores.reporting:.1f}/100" if zh else f"Reporting: {scores.reporting:.1f}/100",
                    "科学价值较高，但需完善报告规范" if zh else "Strong scientific value but needs better documentation"
                ],
                rubric_evidence=rubric_evidence,
                cognitive_evidence=cognitive_evidence,
                decision_rules_applied=["规则4：新颖性 > 80 且报告规范性 < 60 → 大修" if zh else "Rule 4: Novelty > 80 AND Reporting < 60 → MAJOR_REVISION"]
            )

        # Rule 5: High quality across all dimensions → ACCEPT
        if all(score > 70 for score in [scores.reporting, scores.rigor, scores.novelty, scores.contribution]):
            if critical_count == 0:
                return DecisionRationale(
                    decision=FusedDecision.ACCEPT,
                    primary_reason="各维度质量均较高，无严重问题" if zh else "High quality across all dimensions with no critical issues",
                    supporting_factors=[
                        f"报告规范性：{scores.reporting:.1f}/100" if zh else f"Reporting: {scores.reporting:.1f}/100",
                        f"方法严谨性：{scores.rigor:.1f}/100" if zh else f"Rigor: {scores.rigor:.1f}/100",
                        f"研究新颖性：{scores.novelty:.1f}/100" if zh else f"Novelty: {scores.novelty:.1f}/100",
                        f"科学贡献度：{scores.contribution:.1f}/100" if zh else f"Contribution: {scores.contribution:.1f}/100",
                        "符合发表标准" if zh else "Meets publication standards"
                    ],
                    rubric_evidence=rubric_evidence,
                    cognitive_evidence=cognitive_evidence,
                    decision_rules_applied=["规则5：所有维度 > 70 且无严重问题 → 接受" if zh else "Rule 5: All scores > 70 AND no critical issues → ACCEPT"]
                )

        # Default: MINOR_REVISION for moderate quality
        avg_score = (scores.reporting + scores.rigor + scores.novelty + scores.contribution) / 4

        if avg_score >= 60:
            decision = FusedDecision.MINOR_REVISION
            reason = "稿件整体质量尚可，需处理若干次要问题" if zh else "Generally sound manuscript with minor issues to address"
        else:
            decision = FusedDecision.MAJOR_REVISION
            reason = "多个维度存在明显不足，需大幅修改" if zh else "Significant improvements needed across multiple dimensions"

        return DecisionRationale(
            decision=decision,
            primary_reason=reason,
            supporting_factors=[
                f"综合平均分：{avg_score:.1f}/100" if zh else f"Average score: {avg_score:.1f}/100",
                f"严重问题数：{critical_count}" if zh else f"Critical issues: {critical_count}",
                f"重要问题数：{major_count}" if zh else f"Major issues: {major_count}"
            ],
            rubric_evidence=rubric_evidence,
            cognitive_evidence=cognitive_evidence,
            decision_rules_applied=["默认规则：基于综合平均分与问题数量" if language == "zh" else "Default: Based on average score and issue counts"]
        )

    def _generate_compliance_summary(
        self,
        review_results: List[BlockReviewResult],
        checklists_applied: List[str],
        language: str = "zh"
    ) -> str:
        """Generate summary of rubric compliance"""
        zh = language == "zh"

        total_items = sum(len(block.results) for block in review_results)
        pass_count = 0

        for block in review_results:
            for item in block.results:
                if hasattr(item, 'verdict') and item.verdict == VerdictType.PASS:
                    pass_count += 1
                elif hasattr(item, 'score') and item.score == 2:
                    pass_count += 1

        pass_rate = (pass_count / total_items * 100) if total_items > 0 else 0.0
        checklist_str = '、'.join(checklists_applied) if zh else ', '.join(checklists_applied)

        if zh:
            summary = f"本稿件依据 {checklist_str} 报告规范进行评估。共核查 {total_items} 个条目，其中 {pass_count} 个（{pass_rate:.1f}%）完全符合要求。"
            if pass_rate >= 80:
                summary += "稿件整体报告规范性较强。"
            elif pass_rate >= 60:
                summary += "稿件报告规范性良好，部分条目有待改进。"
            elif pass_rate >= 40:
                summary += "稿件报告规范性一般，存在若干需要补充的内容。"
            else:
                summary += "稿件报告规范性存在明显不足，需重点改进。"
        else:
            summary = f"The manuscript was evaluated against {checklist_str} reporting guidelines. "
            summary += f"Out of {total_items} items evaluated, {pass_count} ({pass_rate:.1f}%) fully met the criteria. "
            if pass_rate >= 80:
                summary += "The manuscript demonstrates strong compliance with reporting standards."
            elif pass_rate >= 60:
                summary += "The manuscript shows good compliance with some areas needing improvement."
            elif pass_rate >= 40:
                summary += "The manuscript has moderate compliance with several reporting gaps to address."
            else:
                summary += "The manuscript has significant reporting deficiencies that require attention."

        return summary

    def _generate_methodology_assessment(
        self,
        review_results: List[BlockReviewResult],
        scores: MultiDimensionalScore,
        critical_count: int,
        major_count: int,
        language: str = "zh"
    ) -> str:
        """Generate methodology professionalism and writing standards assessment"""
        zh = language == "zh"

        # Collect method-related findings
        method_issues = []
        writing_issues = []
        method_keywords = ["method", "statistic", "analysis", "design", "bias", "randomiz", "sample", "population"]
        writing_keywords = ["report", "description", "clarity", "abstract", "title", "conclusion", "discussion"]

        for block in review_results:
            for item in block.results:
                if item.severity in (SeverityLevel.CRITICAL, SeverityLevel.MAJOR):
                    item_lower = item.item_id.lower()
                    detail = item.missing_detail or ""
                    if any(kw in item_lower or kw in detail.lower() for kw in method_keywords):
                        method_issues.append(detail)
                    elif any(kw in item_lower or kw in detail.lower() for kw in writing_keywords):
                        writing_issues.append(detail)

        if zh:
            parts = []
            # Methodology professionalism
            if scores.rigor >= 70:
                parts.append("本稿件方法学设计整体规范，研究流程描述较为清晰，具备基本的可重复性。")
            elif scores.rigor >= 40:
                parts.append("本稿件方法学存在一定不足，部分研究流程描述不够详尽，可重复性有待提升。")
            else:
                parts.append("本稿件方法学存在明显缺陷，研究设计、执行或分析过程描述不完整，严重影响可重复性。")

            if method_issues:
                parts.append(f"主要方法学问题包括：{method_issues[0][:100]}{'...' if len(method_issues[0]) > 100 else ''}")
                if len(method_issues) > 1:
                    parts.append(f"此外还发现 {len(method_issues)-1} 项其他方法学问题，详见详细审查结果。")

            # Writing standards
            if scores.reporting >= 70:
                parts.append("论文撰写规范性较好，结构完整，各部分内容基本符合国际医学期刊投稿要求。")
            elif scores.reporting >= 40:
                parts.append("论文撰写规范性一般，部分章节内容缺失或表述不清，建议参照相关报告规范（如PRISMA、CONSORT等）进行完善。")
            else:
                parts.append("论文撰写规范性较差，多个关键章节内容缺失，与国际医学期刊报告规范存在较大差距，需系统性修改。")

            if writing_issues:
                parts.append(f"主要撰写规范问题：{writing_issues[0][:100]}{'...' if len(writing_issues[0]) > 100 else ''}")

            return "\n".join(parts)
        else:
            parts = []
            if scores.rigor >= 70:
                parts.append("The manuscript demonstrates sound methodological design with clear procedural descriptions and adequate reproducibility.")
            elif scores.rigor >= 40:
                parts.append("The manuscript has some methodological gaps; procedural descriptions lack sufficient detail for full reproducibility.")
            else:
                parts.append("The manuscript has significant methodological deficiencies affecting reproducibility and validity.")

            if method_issues:
                parts.append(f"Key methodological concern: {method_issues[0][:100]}{'...' if len(method_issues[0]) > 100 else ''}")

            if scores.reporting >= 70:
                parts.append("Writing standards are generally good with complete structure meeting international reporting requirements.")
            elif scores.reporting >= 40:
                parts.append("Writing standards need improvement; some sections are incomplete or unclear relative to reporting guidelines.")
            else:
                parts.append("Writing standards are poor with multiple key sections missing; systematic revision against reporting guidelines is needed.")

            return "\n".join(parts)
