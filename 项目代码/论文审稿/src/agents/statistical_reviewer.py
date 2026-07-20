"""
Statistical Deep Review Agent - 统计方法专项精查

独立于 rubric 体系，直接基于原文统计内容做专项评审。
只报告原文中可直接观察到的统计缺陷，不声称任何原文中不存在的内容。
"""
from typing import List
from ..schemas.document_ir import DocumentIR
from ..schemas.meta_review import ConsolidatedIssue
from ..services.llm_gateway import LLMGateway, ModelTier


class StatisticalDeepReviewAgent:
    """
    统计方法专项精查 Agent。

    职责：对论文的统计方法、数据呈现和结果解读做深度评审。
    输入：DocumentIR（使用 methods + results 全文）
    输出：List[ConsolidatedIssue]，直接追加到 MetaReview 问题列表
    """

    def __init__(self, llm_gateway: LLMGateway):
        self.llm = llm_gateway

    async def review(self, document_ir: DocumentIR) -> List[ConsolidatedIssue]:
        """执行统计精查，返回问题列表"""
        text = self._extract_statistical_text(document_ir)
        if not text or len(text) < 200:
            print("  → [StatReviewer] 文本不足，跳过统计精查")
            return []

        try:
            result = await self.llm.call_with_json_response(
                messages=[
                    {"role": "system", "content": self._system_prompt()},
                    {"role": "user",   "content": self._build_prompt(text, document_ir)}
                ],
                model_tier=ModelTier.ADVANCED,
                temperature=0.2,
                max_tokens=4000
            )
            issues = self._parse_result(result.get("parsed_json", {}))
            print(f"  → [StatReviewer] 精查完成，发现 {len(issues)} 条统计问题")
            return issues
        except Exception as e:
            print(f"  → [StatReviewer] 统计精查失败（非致命）: {e}")
            return []

    # ──────────────────────────────────────────────
    # 内部方法
    # ──────────────────────────────────────────────

    def _extract_statistical_text(self, document_ir: DocumentIR) -> str:
        """提取统计相关章节文本（方法 + 结果）"""
        parts = []

        def _get_texts(section) -> list:
            if section is None:
                return []
            if hasattr(section, "full_text") and section.full_text is not None:
                ft = section.full_text
                if hasattr(ft, "text") and ft.text is not None:
                    return ft.text
            if hasattr(section, "text") and section.text is not None:
                return section.text
            return []

        # 方法部分
        methods_texts = _get_texts(document_ir.methods)
        if methods_texts:
            parts.append("【方法部分】\n" + " ".join(methods_texts)[:3000])

        # 结果部分
        results_texts = _get_texts(document_ir.results)
        if results_texts:
            parts.append("【结果部分】\n" + " ".join(results_texts)[:3000])

        # 摘要（补充数据）
        if document_ir.abstract and hasattr(document_ir.abstract, "text"):
            abstract_text = " ".join(document_ir.abstract.text[:2])
            if abstract_text:
                parts.append("【摘要】\n" + abstract_text[:800])

        return "\n\n".join(parts)

    def _system_prompt(self) -> str:
        return """【系统时间设定】当前真实世界时间为 2026年。绝对禁止以'时间发生在未来'为由批评任何 2026 年的日期！

你是一位专注于生物统计方法评审的资深专家，拥有丰富的医学统计审稿经验。

【核心准则：只报告原文中可直接观察到的统计问题】
- 只分析原文中实际出现的统计方法、数据和结论
- 禁止捏造或假设原文中不存在的内容
- 如果某统计内容在原文中未提及，不得批评"缺少"该内容（除非该内容对研究类型是强制要求的）
- 批评必须有原文的直接证据支撑（引用原文词句）

【绝对禁止】
- 禁止出现评分数字（如 7/10）
- 禁止出现 AI 相关词汇
- 禁止出现内部规范标签（URVAR_、_rubric: 等）

输出中文，输出 JSON。"""

    def _build_prompt(self, text: str, document_ir: DocumentIR) -> str:
        title = document_ir.title or "未知标题"
        return f"""稿件标题：{title}

以下是论文的统计相关章节内容：

{text}

请从以下8个维度对统计方法进行专项评审。对每个发现的问题，说明原文具体表现并给出改进建议。
如果某维度在原文中已处理得当，则不需要报告问题（不要捏造问题）。

【审查维度】
1. 统计方法适配性：所用统计方法是否与研究设计和数据类型匹配
2. 效应量报告：是否报告了 OR/HR/RR/SMD/MD 等效应量及其置信区间
3. p 值使用规范：是否存在只报告"p<0.05"而不报告具体值、或将统计显著等同于临床意义
4. 多重比较处理：若存在多个假设检验，是否进行了 Bonferroni/FDR 等校正
5. 样本量与效能：样本量计算依据是否明确（效能、α错误率、预期效应量）
6. 基线特征平衡：随机化研究中是否检验并报告了基线特征的组间均衡性
7. 缺失数据处理：是否说明了缺失数据的处理方法（完整病例分析/多重插补等）
8. 结论与数据一致性：讨论或结论中是否存在夸大结果或超出数据范围的声明

输出以下 JSON 格式：
{{
  "statistical_issues": [
    {{
      "dimension": "维度名称（如'效应量报告'）",
      "title": "问题标题（15字以内）",
      "description": "问题详细描述，必须引用原文词句作为证据，200字以上",
      "standard_reference": "违反的统计规范（如CONSORT第17条、ICMJE统计指南等）",
      "location": "问题所在章节（如'结果部分第2段'）",
      "severity": "major 或 minor"
    }}
  ]
}}

如果没有发现任何统计问题，返回：{{"statistical_issues": []}}
"""

    def _parse_result(self, parsed_json: dict) -> List[ConsolidatedIssue]:
        """解析 LLM 返回的统计问题，转换为 ConsolidatedIssue 列表"""
        issues = []
        raw_issues = parsed_json.get("statistical_issues", [])
        if not isinstance(raw_issues, list):
            return []

        for item in raw_issues:
            if not isinstance(item, dict):
                continue
            title = item.get("title", "").strip()
            description = item.get("description", "").strip()
            if not title or not description or len(description) < 30:
                continue

            severity_raw = item.get("severity", "minor").lower()
            severity = "major" if severity_raw == "major" else "minor"

            issues.append(ConsolidatedIssue(
                issue_type="statistical_" + item.get("dimension", "unknown").replace(" ", "_"),
                title=title,
                description=description,
                severity=severity,
                source_rubrics=["statistical_deep_review"],
                source_items=["stat_review"],
                standard_reference=item.get("standard_reference", "统计报告规范"),
                location_in_paper=item.get("location", "统计分析部分"),
                confidence=0.85
            ))

        return issues
