"""
Enhanced Statistician Reviewer Agent - 基于规则集的统计方法审查
"""
from typing import List, Dict
import time

from ..schemas.document_ir import DocumentIR, EvidenceMap
from ..schemas.statistical_review import (
    StatisticalReviewResult,
    StatisticalCheckResult,
    StatisticalCheckStatus,
    StatisticalCheckSeverity
)
from ..services.llm_gateway import LLMGateway
from ..services.evidence_retriever import EvidenceRetriever
from ..utils.statistical_rule_loader import StatisticalRuleSetLoader


class EnhancedStatisticianReviewer:
    """
    增强版统计审查器 - 基于研究类型的规则集审查

    针对不同研究类型（RCT、Meta-Analysis、Prediction Model等）
    应用相应的统计方法检查标准
    """

    def __init__(self, llm_gateway: LLMGateway, rule_set_path: str = None):
        """
        初始化审查器

        Args:
            llm_gateway: LLM网关
            rule_set_path: 规则集配置文件路径（可选）
        """
        self.llm = llm_gateway
        self.rule_loader = StatisticalRuleSetLoader(rule_set_path)
        self.rule_loader.load()
        self.evidence_retriever = EvidenceRetriever()

    async def review_statistics(
        self,
        document_ir: DocumentIR,
        evidence_map: EvidenceMap,
        study_types: List[str]
    ) -> StatisticalReviewResult:
        """
        执行统计方法审查

        Args:
            document_ir: 文档IR
            evidence_map: 证据映射
            study_types: 识别的研究类型列表

        Returns:
            StatisticalReviewResult: 统计审查结果
        """
        start_time = time.time()

        # 1. 根据研究类型获取适用的检查项
        applicable_checks = self.rule_loader.get_applicable_checks(study_types)
        required_checks = applicable_checks['required']
        recommended_checks = applicable_checks['recommended']
        not_applicable_checks = applicable_checks['not_applicable']

        # 2. 执行所有必需和推荐的检查
        check_results = []

        for check_id in required_checks:
            result = await self._perform_check(
                check_id=check_id,
                document_ir=document_ir,
                evidence_map=evidence_map,
                is_required=True
            )
            check_results.append(result)

        for check_id in recommended_checks:
            result = await self._perform_check(
                check_id=check_id,
                document_ir=document_ir,
                evidence_map=evidence_map,
                is_required=False
            )
            check_results.append(result)

        # 3. 统计汇总
        total_checks = len(check_results)
        required_checks_count = len(required_checks)

        passed_required = sum(
            1 for r in check_results
            if r.check_id in required_checks and r.status == StatisticalCheckStatus.PASS
        )
        failed_required = sum(
            1 for r in check_results
            if r.check_id in required_checks and r.status == StatisticalCheckStatus.FAIL
        )

        # 4. 按严重程度分类问题
        critical_issues = [
            r for r in check_results
            if r.status in [StatisticalCheckStatus.FAIL, StatisticalCheckStatus.PARTIAL]
            and r.severity == StatisticalCheckSeverity.CRITICAL
        ]
        major_issues = [
            r for r in check_results
            if r.status in [StatisticalCheckStatus.FAIL, StatisticalCheckStatus.PARTIAL]
            and r.severity == StatisticalCheckSeverity.MAJOR
        ]
        minor_issues = [
            r for r in check_results
            if r.status in [StatisticalCheckStatus.FAIL, StatisticalCheckStatus.PARTIAL]
            and r.severity == StatisticalCheckSeverity.MINOR
        ]

        # 5. 计算统计严谨性评分
        statistical_rigor_score = self._calculate_rigor_score(
            check_results=check_results,
            required_checks=required_checks
        )

        # 6. 生成总体评估
        overall_assessment = self._generate_overall_assessment(
            study_types=study_types,
            passed_required=passed_required,
            required_checks_count=required_checks_count,
            critical_issues=critical_issues,
            major_issues=major_issues,
            statistical_rigor_score=statistical_rigor_score
        )

        execution_time = time.time() - start_time

        return StatisticalReviewResult(
            study_types=study_types,
            check_results=check_results,
            total_checks=total_checks,
            required_checks_count=required_checks_count,
            passed_required=passed_required,
            failed_required=failed_required,
            critical_issues=critical_issues,
            major_issues=major_issues,
            minor_issues=minor_issues,
            overall_assessment=overall_assessment,
            statistical_rigor_score=statistical_rigor_score,
            execution_time_seconds=execution_time
        )

    async def _perform_check(
        self,
        check_id: str,
        document_ir: DocumentIR,
        evidence_map: EvidenceMap,
        is_required: bool
    ) -> StatisticalCheckResult:
        """
        执行单个统计检查项

        Args:
            check_id: 检查项ID
            document_ir: 文档IR
            evidence_map: 证据映射
            is_required: 是否为必需检查项

        Returns:
            StatisticalCheckResult: 检查结果
        """
        # 获取检查项定义
        check_def = self.rule_loader.get_check_definition(check_id)
        if not check_def:
            return StatisticalCheckResult(
                check_id=check_id,
                check_name=check_id,
                status=StatisticalCheckStatus.UNCERTAIN,
                confidence=0.0,
                missing_detail="Check definition not found",
                severity=StatisticalCheckSeverity.MINOR
            )

        # 1. 使用关键词检索证据
        evidence_found = []
        evidence_location = []

        for keyword in check_def.keywords:
            # 在统计方法部分搜索
            stats_text = " ".join(document_ir.methods.statistics.text)
            if keyword.lower() in stats_text.lower():
                # 找到包含关键词的句子
                sentences = stats_text.split('.')
                for sent in sentences:
                    if keyword.lower() in sent.lower():
                        evidence_found.append(sent.strip())
                        evidence_location.append("methods.statistics")
                        break

            # 在结果部分搜索
            results_text = " ".join(document_ir.results.outcomes.text)
            if keyword.lower() in results_text.lower():
                sentences = results_text.split('.')
                for sent in sentences:
                    if keyword.lower() in sent.lower():
                        evidence_found.append(sent.strip())
                        evidence_location.append("results.outcomes")
                        break

        # 2. 使用LLM进行深度评估
        llm_result = await self._llm_evaluate_check(
            check_def=check_def,
            document_ir=document_ir,
            preliminary_evidence=evidence_found
        )

        # 3. 合并结果
        status = llm_result.get('status', StatisticalCheckStatus.UNCERTAIN)
        confidence = llm_result.get('confidence', 0.5)

        # 如果LLM找到了更多证据，添加进来
        if llm_result.get('evidence'):
            evidence_found.extend(llm_result['evidence'])

        # 去重
        evidence_found = list(set(evidence_found))[:5]  # 最多保留5条证据

        missing_detail = None
        recommendation = None

        if status != StatisticalCheckStatus.PASS:
            missing_detail = llm_result.get('missing_detail', check_def.description)
            recommendation = llm_result.get('recommendation', f"Please provide {check_def.name}")

        return StatisticalCheckResult(
            check_id=check_id,
            check_name=check_def.name,
            status=status,
            confidence=confidence,
            evidence_found=evidence_found,
            evidence_location=evidence_location,
            missing_detail=missing_detail,
            recommendation=recommendation,
            severity=check_def.severity_if_missing
        )

    async def _llm_evaluate_check(
        self,
        check_def,
        document_ir: DocumentIR,
        preliminary_evidence: List[str]
    ) -> Dict:
        """
        使用LLM评估单个检查项

        Args:
            check_def: 检查项定义
            document_ir: 文档IR
            preliminary_evidence: 初步找到的证据

        Returns:
            评估结果字典
        """
        # 构建评估提示
        prompt = f"""
Evaluate whether the following statistical requirement is met in this manuscript.

**Requirement:** {check_def.name}
**Description:** {check_def.description}
**Keywords to look for:** {', '.join(check_def.keywords)}

**Statistical Methods Section:**
{chr(10).join(document_ir.methods.statistics.text[:10])}

**Sample Size Section:**
{chr(10).join(document_ir.methods.sample_size.text[:5])}

**Results Section (relevant parts):**
{chr(10).join(document_ir.results.outcomes.text[:10])}

**Preliminary Evidence Found:**
{chr(10).join(preliminary_evidence) if preliminary_evidence else "No preliminary evidence found"}

**Task:** Determine if this requirement is met. Return JSON:

{{
  "status": "PASS|FAIL|PARTIAL|UNCERTAIN",
  "confidence": 0.0-1.0,
  "evidence": ["quote1", "quote2"],
  "missing_detail": "what is missing (if not PASS)",
  "recommendation": "specific recommendation (if not PASS)"
}}

**Guidelines:**
- PASS: Requirement is clearly and adequately addressed
- FAIL: Requirement is clearly NOT addressed (confirmed absence)
- PARTIAL: Some information present but incomplete
- UNCERTAIN: Cannot determine from available text (default to this if unsure)
- Confidence: Your confidence in this assessment (0.0-1.0)
- Evidence: Direct quotes supporting your assessment (required)
"""

        try:
            result = await self.llm.call_with_json_response(
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert biostatistician. Evaluate statistical methodology requirements objectively."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                model_tier="standard",
                temperature=0.1,
                max_tokens=1000
            )

            evaluation = result["parsed_json"]

            # 解析状态
            status_str = evaluation.get('status', 'UNCERTAIN')
            try:
                status = StatisticalCheckStatus[status_str.upper()]
            except KeyError:
                status = StatisticalCheckStatus.UNCERTAIN

            return {
                'status': status,
                'confidence': evaluation.get('confidence', 0.5),
                'evidence': evaluation.get('evidence', []),
                'missing_detail': evaluation.get('missing_detail'),
                'recommendation': evaluation.get('recommendation')
            }

        except Exception as e:
            # LLM调用失败，返回不确定状态
            return {
                'status': StatisticalCheckStatus.UNCERTAIN,
                'confidence': 0.3,
                'evidence': [],
                'missing_detail': f"LLM evaluation failed: {str(e)}",
                'recommendation': "Manual review recommended"
            }

    def _calculate_rigor_score(
        self,
        check_results: List[StatisticalCheckResult],
        required_checks: List[str]
    ) -> float:
        """
        计算统计严谨性评分 (0-100)

        评分逻辑：
        - 必需检查项 PASS: +10分
        - 必需检查项 PARTIAL: +5分
        - 必需检查项 FAIL: 0分
        - 推荐检查项 PASS: +3分
        - CRITICAL问题: -15分
        - MAJOR问题: -10分
        - MINOR问题: -5分
        """
        score = 50.0  # 基础分

        for result in check_results:
            is_required = result.check_id in required_checks

            if result.status == StatisticalCheckStatus.PASS:
                score += 10 if is_required else 3
            elif result.status == StatisticalCheckStatus.PARTIAL:
                score += 5 if is_required else 1
            elif result.status == StatisticalCheckStatus.FAIL:
                if result.severity == StatisticalCheckSeverity.CRITICAL:
                    score -= 15
                elif result.severity == StatisticalCheckSeverity.MAJOR:
                    score -= 10
                elif result.severity == StatisticalCheckSeverity.MINOR:
                    score -= 5

        # 限制在 0-100 范围内
        score = max(0.0, min(100.0, score))
        return round(score, 1)

    def _generate_overall_assessment(
        self,
        study_types: List[str],
        passed_required: int,
        required_checks_count: int,
        critical_issues: List[StatisticalCheckResult],
        major_issues: List[StatisticalCheckResult],
        statistical_rigor_score: float
    ) -> str:
        """生成总体评估文本"""
        assessment_parts = []

        # 研究类型
        assessment_parts.append(
            f"Study identified as: {', '.join(study_types)}."
        )

        # 必需检查项通过率
        if required_checks_count > 0:
            pass_rate = (passed_required / required_checks_count) * 100
            assessment_parts.append(
                f"Required statistical checks: {passed_required}/{required_checks_count} passed ({pass_rate:.0f}%)."
            )

        # 严重问题
        if critical_issues:
            assessment_parts.append(
                f"CRITICAL: {len(critical_issues)} critical statistical issue(s) identified."
            )
        if major_issues:
            assessment_parts.append(
                f"MAJOR: {len(major_issues)} major statistical issue(s) identified."
            )

        # 总体评分
        if statistical_rigor_score >= 80:
            assessment_parts.append(
                f"Statistical rigor score: {statistical_rigor_score}/100 (Excellent)."
            )
        elif statistical_rigor_score >= 60:
            assessment_parts.append(
                f"Statistical rigor score: {statistical_rigor_score}/100 (Good, minor improvements needed)."
            )
        elif statistical_rigor_score >= 40:
            assessment_parts.append(
                f"Statistical rigor score: {statistical_rigor_score}/100 (Fair, major revisions recommended)."
            )
        else:
            assessment_parts.append(
                f"Statistical rigor score: {statistical_rigor_score}/100 (Poor, substantial revisions required)."
            )

        return " ".join(assessment_parts)
