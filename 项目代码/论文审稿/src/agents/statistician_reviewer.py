"""
Statistician Reviewer Agent - Specialized statistical methodology review
"""
from typing import List
import time

from ..schemas.document_ir import DocumentIR, EvidenceMap
from ..schemas.rubric import RubricBlock, RubricItemOutputSchema, BlockReviewResult
from ..services.llm_gateway import LLMGateway
from .methodology_reviewer import MethodologyReviewerAgent


class StatisticianReviewerAgent(MethodologyReviewerAgent):
    """
    Specialized reviewer for statistical methodology.

    Extends MethodologyReviewerAgent with statistics-focused prompts and evaluation.
    Focuses on:
    - Statistical test selection and appropriateness
    - Sample size calculations
    - Multiple comparisons handling
    - Model validation (for predictive models)
    - P-values and confidence intervals
    """

    def __init__(self, llm_gateway: LLMGateway):
        super().__init__(llm_gateway)

    async def review_statistics(
        self,
        document_ir: DocumentIR,
        evidence_map: EvidenceMap
    ) -> BlockReviewResult:
        """
        Perform specialized statistical review.

        This method focuses on extracted statistical information rather than
        processing a predefined rubric block.
        """
        start_time = time.time()

        # Extract key statistical information from DocumentIR
        stats_info = self._extract_statistical_info(document_ir)

        # Build a focused statistical review prompt
        prompt = self._build_statistics_review_prompt(stats_info)

        try:
            result = await self.llm.call_with_json_response(
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert biostatistician reviewing medical research. Evaluate statistical methodology for appropriateness, rigor, and potential issues." + (" 请全程使用中文回复，不得混入英文。" if document_ir.language == "zh" else "")
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                model_tier="standard",
                temperature=0.2,
                max_tokens=3000
            )

            evaluation = result["parsed_json"]
            results = self._parse_statistics_evaluation(evaluation)

            execution_time = time.time() - start_time

            return BlockReviewResult(
                block_id="statistics_review",
                block_name="Statistical_Methods_Review",
                results=results,
                execution_time_seconds=execution_time,
                error_log=[]
            )

        except Exception as e:
            execution_time = time.time() - start_time
            return BlockReviewResult(
                block_id="statistics_review",
                block_name="Statistical_Methods_Review",
                results=[],
                execution_time_seconds=execution_time,
                error_log=[f"Statistics review failed: {str(e)}"]
            )

    def _extract_statistical_info(self, document_ir: DocumentIR) -> dict:
        """Extract key statistical information from DocumentIR"""
        return {
            "sample_size": document_ir.methods.sample_size.text,
            "statistical_methods": document_ir.methods.statistics.text,
            "results_outcomes": document_ir.results.outcomes.text,
            "extracted_metadata": document_ir.extracted_info
        }

    def _build_statistics_review_prompt(self, stats_info: dict) -> str:
        """Build specialized prompt for statistical review with structured verdict"""
        return f"""
Review the statistical methodology of this manuscript and identify potential issues.

**SAMPLE SIZE AND POWER:**
{chr(10).join(stats_info.get("sample_size", []))}

**STATISTICAL METHODS:**
{chr(10).join(stats_info.get("statistical_methods", []))}

**RESULTS:**
{chr(10).join(stats_info.get("results_outcomes", [])[:5])}  # Limit to first 5 paragraphs

Evaluate the following aspects and return as JSON array of issues:

{{
  "issues": [
    {{
      "aspect": "<sample_size|test_selection|assumptions|multiple_comparisons|effect_sizes|confidence_intervals|model_validation|pseudoreplication|circular_analysis>",
      "verdict": "<PASS|FAIL|PARTIAL|UNCERTAIN>",
      // PASS = Aspect adequately addressed
      // FAIL = Clear deficiency confirmed
      // PARTIAL = Some information present but incomplete
      // UNCERTAIN = Cannot determine from provided text

      "confidence": <0.0 to 1.0>,
      // Your confidence in this verdict

      "severity": "<CRITICAL|MAJOR|MINOR|NONE>",
      "description": "detailed description of the issue",
      "evidence": ["quote1", "quote2"],
      // REQUIRED: Must provide at least 1 quote

      "recommendation": "specific fix",
      "what_would_change_verdict": "what information would make this PASS"
      // For verdict != PASS: What specific information is needed
    }}
  ]
}}

**Focus on:**
1. Sample size justification and power calculation
2. Appropriateness of statistical tests for data type and study design
3. Handling of missing data
4. Multiple comparisons correction (if applicable)
5. Reporting of effect sizes with confidence intervals
6. Model validation methods (if predictive modeling used)
7. Assumptions checking (normality, proportional hazards, etc.)
8. P-value interpretation and potential p-hacking
9. Pseudoreplication: Are units of analysis truly independent? Are technical replicates treated as biological replicates? Are multiple measurements from the same subject treated as independent? Check if n is defined as biological units vs. measurements.
10. Circular analysis / Double-dipping / HARKing: Was the same dataset used for both feature selection and hypothesis testing? Are subgroup analyses post-hoc without correction? Are exploratory analyses presented as confirmatory? Is there evidence the hypothesis was generated after seeing the results?

**CRITICAL RULES:**
- Default to UNCERTAIN if evidence is weak, NOT FAIL
- Only use FAIL if you can confirm the deficiency after thorough review
- Always provide at least 1 evidence quote for any verdict
- For UNCERTAIN: Provide the most relevant text found and explain why insufficient

Return empty array if no statistical issues identified.
"""

    def _parse_statistics_evaluation(self, evaluation: dict) -> List[RubricItemOutputSchema]:
        """Parse statistics evaluation into standardized results with new verdict structure"""
        from ..schemas.rubric import ItemStatus, SeverityLevel, VerdictType

        results = []
        issues = evaluation.get("issues", [])

        for idx, issue in enumerate(issues):
            # Parse verdict
            verdict_str = issue.get("verdict", "UNCERTAIN")
            try:
                verdict = VerdictType[verdict_str.upper()]
            except KeyError:
                verdict = VerdictType.UNCERTAIN

            # Map verdict to legacy score
            verdict_to_score = {
                VerdictType.PASS: 2,
                VerdictType.PARTIAL: 1,
                VerdictType.FAIL: 0,
                VerdictType.UNCERTAIN: 0
            }
            score = verdict_to_score.get(verdict, 0)

            # Parse severity
            severity_str = issue.get("severity", "NONE")
            try:
                severity = SeverityLevel[severity_str.upper()]
            except KeyError:
                severity = SeverityLevel.NONE

            # Get confidence
            confidence = issue.get("confidence", 0.85)

            # Ensure evidence is provided
            evidence = issue.get("evidence", [])
            if not evidence:
                if verdict == VerdictType.UNCERTAIN:
                    evidence = ["[No clear evidence found for this statistical aspect]"]
                elif verdict == VerdictType.FAIL:
                    evidence = ["[Confirmed deficiency in statistical methodology]"]
                else:
                    evidence = ["[Evidence not properly extracted]"]

            result = RubricItemOutputSchema(
                item_id=f"STATS_{issue['aspect'].upper()}",
                status=ItemStatus.COMPLETED,
                verdict=verdict,
                score=score,  # Legacy field
                confidence=confidence,
                severity=severity,
                evidence_quote=evidence,
                evidence_location=["methods.statistics", "results.outcomes"],
                missing_detail=issue.get("description"),
                risk_reason=f"Statistical concern regarding {issue['aspect']}",
                actionable_fix=issue.get("recommendation"),
                what_would_change_verdict=issue.get("what_would_change_verdict"),
                confidence_score=confidence,  # Legacy field
                context_quality="exact",  # Statistics review uses extracted sections
                search_strategy="structure_based"
            )
            results.append(result)

        return results
