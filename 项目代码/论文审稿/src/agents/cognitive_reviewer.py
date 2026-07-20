"""
Cognitive Reviewer Agent - High-level manuscript assessment

This agent performs expert-level cognitive review, going beyond checklist compliance
to assess novelty, contribution, originality, and identify fatal flaws that
checklists might miss.
"""
import time
from typing import List, Dict, Any, Optional

from ..schemas.document_ir import DocumentIR
from ..schemas.cognitive_review import CognitiveReviewResult, FatalFlaw, KeyStrength, KeyWeakness
from ..schemas.rubric import BlockReviewResult, RubricItemOutputSchema
from ..services.llm_gateway import LLMGateway, ModelTier
from ..services.evidence_retriever import EvidenceRetriever


class CognitiveReviewerAgent:
    """
    High-level cognitive reviewer that mimics expert peer review.

    Unlike checklist-based reviewers, this agent:
    - Assesses novelty and originality
    - Evaluates marginal contribution
    - Identifies fatal flaws not covered by checklists
    - Judges whether conclusions are overstated
    - Determines if work is merely incremental (dataset swap)
    """

    def __init__(self, llm_gateway: LLMGateway):
        """
        Initialize the cognitive reviewer.

        Args:
            llm_gateway: LLM gateway for making API calls
        """
        self.llm = llm_gateway
        self.evidence_retriever = EvidenceRetriever(llm_gateway)

    async def review(
        self,
        document_ir: DocumentIR,
        rubric_summary: Dict[str, Any],
        language: str = "en"
    ) -> CognitiveReviewResult:
        """
        Perform high-level cognitive review of the manuscript.

        Args:
            document_ir: Document intermediate representation with full text
            rubric_summary: Summary of rubric evaluation results (not detailed items)
            language: Manuscript language ('zh' or 'en')

        Returns:
            CognitiveReviewResult with high-level assessment
        """
        start_time = time.time()

        # ── 调试指纹：确认当前 system prompt 版本 ──
        _sp = self._get_system_prompt(language)
        print(f"  → [CognitiveReviewer·指纹] "
              f"第零步={'Y' if '第零步' in _sp else 'N'} | "
              f"防幻觉规则={'Y' if '防幻觉强制规则' in _sp else 'N'} | "
              f"横断面清单={'Y' if '横断面/文献计量研究专用审查清单' in _sp else 'N'} | "
              f"时间锚2026={'Y' if '2026年' in _sp else 'N'}")

        # Step 1: Extract key content for review
        key_content = self._extract_key_content(document_ir)

        # Step 2: Build cognitive review prompt
        prompt = self._build_cognitive_review_prompt(key_content, rubric_summary)

        # Step 3: Call LLM with advanced model for cognitive assessment
        try:
            result = await self.llm.call_with_json_response(
                messages=[
                    {
                        "role": "system",
                        "content": self._get_system_prompt(language)
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                model_tier=ModelTier.ADVANCED,  # Use advanced model for cognitive tasks
                temperature=0.0,
                max_tokens=4000
            )

            evaluation = result["parsed_json"]
            cognitive_result = self._parse_cognitive_response(evaluation)

            return cognitive_result

        except Exception as e:
            # Return a minimal result on error
            return CognitiveReviewResult(
                novelty_score=5.0,
                contribution_score=5.0,
                fit_score=5.0,
                clarity_score=5.0,
                fatal_flaws=[],
                key_strengths=[],
                key_weaknesses=[
                    KeyWeakness(
                        weakness_type="evaluation_error",
                        description=f"Cognitive review failed: {str(e)}",
                        evidence="N/A",
                        impact="Unable to complete high-level assessment",
                        severity=0.5
                    )
                ],
                originality_analysis="Unable to complete analysis due to error",
                contribution_analysis="Unable to complete analysis due to error",
                suggestions=["Manual review recommended"],
                confidence=0.0,
                overall_recommendation="major_revision",
                recommendation_rationale="Automated review incomplete"
            )

    def _get_system_prompt(self, language: str = "en") -> str:
        """Get the system prompt for cognitive review"""
        lang_instruction = "\n\nIMPORTANT: Write all narrative text fields (originality_analysis, contribution_analysis, key_strengths descriptions, key_weaknesses descriptions, fatal_flaws descriptions, suggestions) in Chinese (中文)." if language == "zh" else ""
        return f"""【第零步：强制研究类型识别——在任何审查前必须完成】

在开始任何审查前，你必须先判断文章属于以下哪种研究类型，并严格按照对应的规范进行审查。判断完成后，在你的输出中首先声明研究类型。

A. 范围综述（Scoping Review）
   识别标志：标题或摘要中明确出现"scoping review"字样，且方法学引用了PRISMA-ScR或JBI Scoping Review Manual
   适用规范：PRISMA-ScR（含PCC框架、文献筛选流程图要求）

B. 系统评价/Meta分析（Systematic Review/Meta-Analysis）
   识别标志：标题或摘要中出现"systematic review"或"meta-analysis"
   适用规范：PRISMA 2020（含PICO框架、偏倚风险评估要求）

C. 横断面研究/文献计量分析（Cross-sectional/Bibliometric Study）
   识别标志：标题中出现"横断面""文献计量""系统性分析""现状调查"，或方法学描述为"检索文献后提取特征进行描述性统计"
   适用规范：STROBE 或 PRISMA 2020（若含系统检索）
   【绝对禁止】不得要求PCC框架；不得要求PICO框架；不得批评未声明为范围综述；不得要求患者/公众利益相关者参与

D. 方法论/框架提出类文章（Methodological/Framework Paper）
   识别标志：文章核心贡献是提出新的分类框架、评估工具或指标体系
   适用规范：通用方法学规范（重点核查实证验证、IRR、框架边界清晰度）

E. 临床试验（Clinical Trial）
   适用规范：CONSORT

F. 叙述性综述/一般文献综述（Narrative Review / Literature Review）
   识别标志：标题含"Recent Advances"/"A Review of"/"Review on"/"Current Perspectives"/"Overview of"/"Advances in"/"Update on"等综述类表述，且不含"systematic"/"scoping"/"meta-analysis"；或文章类型标注为"Review"但无系统检索方法学描述
   适用规范：ICMJE一般综述写作规范（重点核查：引用准确性、推论是否超出证据范围、研究类型区分是否准确）
   【绝对禁止——以下要求对F类文章完全不适用，绝对不得批评】：
   - 任何要求PRISMA流程图（PRISMA flow diagram）的批评
   - 任何要求PROSPERO/OSF预注册（protocol registration）的批评
   - 任何要求完整布尔逻辑检索式（Boolean search string）/MeSH主题词的批评
   - 任何要求双人独立筛选（two reviewers independent screening）的批评
   - 任何要求Kappa值/评分者间信度（IRR）的批评
   - 任何要求偏倚风险评估工具（ROBINS-I / SYRCLE / Cochrane RoB）的批评
   - 任何要求GRADE证据分级的批评
   - 任何要求"独立方法章节"或PRISMA格式方法学描述的批评
   F类文章的核心审查维度应为：引用是否准确（动物研究是否被误标为人群研究）、推论是否超出证据范围、证据层级区分是否清晰、文章结构是否完整

【防幻觉强制规则】
在提出任何"缺失"批评前，必须先在原文中进行以下核查：
- 批评"无数据/无表格"前：先搜索原文是否有"表""Table""p<""χ²""P值"等字眼
- 批评"无方法/结果/讨论"前：先看原文是否有对应的章节编号
- 批评"无检索策略"前：先看原文是否有数据库名称（如PubMed、CNKI等）
- 批评"无纳入排除标准"前：先看原文是否有"纳入标准""排除标准""Inclusion criteria"等标题
- 批评"无利益冲突声明"前：先看原文末尾是否有相关声明
找到任何一个对应内容，立刻放弃该批评。

【系统时间设定】当前真实世界时间为 2026年。任何发生在 2026 年及以前的研究、检索日期、发表日期都是完全合法且正常的。绝对禁止以'时间发生在未来'为由批评任何 2026 年的日期！

你是一位以极其严苛和犀利著称的顶级医学期刊审稿人。你必须根据文章实际的研究类型进行深度批判，绝对不能生搬硬套固定模板。

【核心原则：文章可能同时属于多种类型，所有适用的批判维度都必须执行】

**如果文章提出了新框架/新指标/新分类体系（无论是否同时也是综述）**：
- 【最高优先级·致命缺陷检查】该框架/模型是否在真实数据集上进行了实证验证？
- 是否提供了评分者间信度（Inter-Rater Reliability, IRR）或 Kappa 值？
- 分类标准或风险分级是如何推导的？是基于专家共识（如 Delphi 法）还是作者主观臆断？
- 如果以上任何一项缺失，这就是 Fatal Flaw，必须列入 fatal_flaws，必须在报告中作为第一条展开。
- 注意：同时进行范围综述+提出框架的"混合型文章"，上述检查同样强制执行，不得因为"它是综述"而跳过。

**如果文章是系统综述/范围综述/文献计量类（对已有文献进行系统梳理，且标题或方法明确为"Systematic Review"/"Scoping Review"/"Meta-Analysis"/"Bibliometric"）**：
【注意：叙述性综述（F类，如"Recent Advances in..."/"A Review of..."）不属于此类，绝对不得对F类文章提以下要求】
- 本研究是否在 PROSPERO 或 OSF 等平台进行了前瞻性注册？
- 是否提供了完整的、可重复的布尔逻辑检索式（包含 MeSH 主题词）？
- 是否由两名独立研究人员进行文献筛选和数据提取，并报告了一致性检验结果（如 Kappa 值）？
- 是否对纳入文献进行了方法学质量评价？

【横断面/文献计量研究专用审查清单（研究类型C专用）】

当文章为横断面/文献计量研究时，重点核查以下问题（这些才是真正应该被指出的缺陷）：

1. 本研究自身是否在PROSPERO或OSF进行了前瞻性注册？若文章强调注册重要性但自身未注册，这是"双标"问题，必须指出。
2. 是否提供了至少一个数据库的完整布尔逻辑检索式（Boolean search string）？仅列举检索词不等于提供了完整检索式。
3. 若提及"双人独立筛选/提取"，是否报告了评分者间信度（如Cohen's Kappa值）？
4. 若进行了多组比较的统计检验（如多个卡方检验），是否说明了多重比较校正方法（如Bonferroni校正）？
5. 研究设计类型是否被明确界定，并声明了遵循的报告规范（如PRISMA 2020或STROBE）？

**如果文章包含统计分析**：
- 是否进行了多重比较校正（如 Bonferroni 校正）？
- 统计方法的选择是否与数据分布和研究设计相匹配？

【评估维度】
1. 实证验证与可重复性 (Empirical Validation & Reproducibility)
   核查要点：文章提出的框架/指标/分类（如有）是否在真实数据集上进行了测试？
   是否报告了评分者间信度（Inter-Rater Reliability, IRR）或 Kappa 系数？
   **重要**：只要文章提出了任何新的分类/评分/指标体系，就必须核查此项。

2. 方法论推导的严谨性 (Rigor of Methodological Derivation)
   核查要点：文章的分类体系、风险分级、评分标准（如有）是如何推导出来的？
   是基于专家共识（如德尔菲法）、真实数据，还是作者主观臆断？

3. 检索与抽样策略的专业度 (Professionalism of Search/Sampling Strategy)
   核查要点（仅当文章包含文献检索时）：检索式是否使用了标准医学主题词（MeSH terms）？
   布尔逻辑是否合理？

4. 数据与结果的颗粒度 (Granularity of Reported Results)
   核查要点：是否提供了详尽的数据提取表或特征提取清单（如有）？
   是否明确报告了各关键环节的数量统计？

5. 临床转化与操作壁垒 (Clinical Translation & Deployment Barriers)
   核查要点：文章提出的方法在实际应用场景中是否具有可操作性？

6. 与现有文献的对比定位 (Positioning vs. Existing Literature)
   核查要点：文章是否充分讨论了与同类研究的异同？增量贡献是否被清晰界定？

7. 写作质量与术语一致性 (Writing Quality & Terminological Consistency)
   核查要点：核心术语是否在全文一致使用？摘要是否准确反映全文核心贡献？

【最高警告】
- 你的所有批评必须基于文章真实存在的内容。
- 如果文章根本没有提出分类框架，绝对不能批评"分类框架未验证"。
- 如果文章没有进行风险分级，绝对不能批评"风险分级主观"。
- 必须先仔细阅读文章内容，再根据文章实际情况进行批判。{lang_instruction}"""

    def _extract_key_content(self, document_ir: DocumentIR) -> Dict[str, str]:
        """
        Extract key content from document for cognitive review.

        Strategy:
        - Always include: title, abstract, introduction, discussion, conclusion
        - Selectively include: key results paragraphs (use evidence retriever)
        - Limit total length to avoid token overflow
        """
        content = {}

        # Title
        content["title"] = document_ir.title or "[No title]"

        # Abstract
        if document_ir.abstract and document_ir.abstract.text:
            content["abstract"] = "\n".join(document_ir.abstract.text[:5])  # First 5 paragraphs
        else:
            content["abstract"] = "[No abstract]"

        # Introduction
        if document_ir.introduction and document_ir.introduction.text:
            content["introduction"] = "\n".join(document_ir.introduction.text[:10])  # First 10 paragraphs
        else:
            content["introduction"] = "[No introduction]"

        # Methods summary (brief)
        if document_ir.methods and hasattr(document_ir.methods, 'full_text'):
            if document_ir.methods.full_text.text:
                content["methods_summary"] = "\n".join(document_ir.methods.full_text.text[:5])
            else:
                # 检查 MethodsSection 子字段（综述论文的方法内容可能分散在子字段）
                sub_parts = []
                for attr in ['study_design', 'participants', 'eligibility', 'statistics']:
                    sub = getattr(document_ir.methods, attr, None)
                    if sub and getattr(sub, 'text', None):
                        sub_parts.extend(sub.text[:2])
                if sub_parts:
                    content["methods_summary"] = "\n".join(sub_parts)
                elif document_ir.fulltext:
                    # 综述论文：从全文中间段取方法相关内容
                    content["methods_summary"] = "[综述类文章：无独立方法章节属正常情况]"
                else:
                    content["methods_summary"] = "[No methods]"
        else:
            content["methods_summary"] = "[No methods]"

        # Key results (use evidence retriever to find most important results)
        if document_ir.results and hasattr(document_ir.results, 'full_text'):
            if document_ir.results.full_text.text:
                content["key_results"] = "\n".join(document_ir.results.full_text.text[:8])
            else:
                content["key_results"] = "[综述类文章：正文内容见introduction字段]" if document_ir.introduction and document_ir.introduction.text else "[No results]"
        else:
            content["key_results"] = "[No results]"

        # Discussion
        if document_ir.discussion and hasattr(document_ir.discussion, 'full_text'):
            if document_ir.discussion.full_text.text:
                content["discussion"] = "\n".join(document_ir.discussion.full_text.text[:10])
            else:
                content["discussion"] = "[No discussion]"
        else:
            content["discussion"] = "[No discussion]"

        # Conclusion
        if document_ir.conclusion and document_ir.conclusion.text:
            content["conclusion"] = "\n".join(document_ir.conclusion.text[:5])
        else:
            content["conclusion"] = "[No conclusion]"

        return content

    def _build_cognitive_review_prompt(
        self,
        key_content: Dict[str, str],
        rubric_summary: Dict[str, Any]
    ) -> str:
        """Build prompt for cognitive review"""

        # Extract rubric summary statistics
        total_items = rubric_summary.get("total_items", 0)
        pass_count = rubric_summary.get("pass_count", 0)
        fail_count = rubric_summary.get("fail_count", 0)
        uncertain_count = rubric_summary.get("uncertain_count", 0)
        critical_issues = rubric_summary.get("critical_issues", 0)
        major_issues = rubric_summary.get("major_issues", 0)

        return f"""
Perform a high-level cognitive review of this research manuscript.

**MANUSCRIPT CONTENT:**

**Title:**
{key_content.get('title', '[No title]')}

**Abstract:**
{key_content.get('abstract', '[No abstract]')[:1500]}

**Introduction (excerpt):**
{key_content.get('introduction', '[No introduction]')[:2000]}

**Methods (summary):**
{key_content.get('methods_summary', '[No methods]')[:1000]}

**Key Results:**
{key_content.get('key_results', '[No results]')[:2000]}

**Discussion (excerpt):**
{key_content.get('discussion', '[No discussion]')[:2000]}

**Conclusion:**
{key_content.get('conclusion', '[No conclusion]')[:1000]}

**CHECKLIST SUMMARY (for context only):**
- Total items evaluated: {total_items}
- PASS: {pass_count}, FAIL: {fail_count}, UNCERTAIN: {uncertain_count}
- Critical issues: {critical_issues}, Major issues: {major_issues}

**YOUR TASK:**

Provide a comprehensive cognitive review in JSON format:

{{
  "novelty_score": <0-10>,
  "contribution_score": <0-10>,
  "fit_score": <0-10>,
  "clarity_score": <0-10>,
  "methodological_depth_score": <0-10>,
  "operability_score": <0-10>,
  "writing_quality_score": <0-10>,
  "figure_quality_score": <0-10>,
  "ethics_completeness_score": <0-10>,
  "data_openness_score": <0-10>,

  "fatal_flaws": [
    {{
      "flaw_type": "selection_bias|confounding|overgeneralization|logical_error|...",
      "description": "detailed description",
      "evidence": "quote or reference to section",
      "impact": "why this is fatal",
      "severity": 0.0-1.0
    }}
  ],

  "key_strengths": [
    {{
      "strength_type": "novel_method|large_sample|rigorous_design|...",
      "description": "detailed description",
      "evidence": "quote or reference",
      "impact": "why this strengthens the study"
    }}
  ],

  "key_weaknesses": [
    {{
      "weakness_type": "limited_generalizability|small_sample|unclear_methods|...",
      "description": "detailed description",
      "evidence": "quote or reference",
      "impact": "how this affects validity",
      "severity": 0.0-1.0
    }}
  ],

  "originality_analysis": "Detailed analysis of originality.",
  "contribution_analysis": "Detailed analysis of marginal contribution.",
  "literature_positioning_analysis": "该研究相比同类综述/框架的增量贡献是什么？在领域中的定位如何？",
  "methodological_depth_analysis": "提出的框架/方法是否有足够的理论支撑？方法论深度评估。",
  "operability_analysis": "框架/建议是否具有实际可执行性？转化价值如何？",
  "writing_quality_analysis": "语言是否精准，结构是否清晰，表达质量评估。",
  "figure_quality_analysis": "图表是否有效传递了核心信息？设计质量如何？",
  "ethics_statement_analysis": "是否有伦理声明、资金来源、利益冲突声明？完整性评估。",
  "data_openness_analysis": "是否提供了数据共享声明或代码仓库链接？开放性评估。",

  "suggestions": ["High-level suggestion 1", "High-level suggestion 2"],
  "confidence": 0.0-1.0,
  "is_incremental_work": true/false,
  "is_conclusion_overstated": true/false,
  "has_uncovered_flaws": true/false,
  "overall_recommendation": "accept|minor_revision|major_revision|reject",
  "recommendation_rationale": "Brief rationale for recommendation"
}}

**EVALUATION DIMENSIONS (扩展评估维度):**

1. **Novelty & Contribution (创新性与贡献度)**
2. **Literature Positioning (与现有文献的对比定位)**: 该研究相比同类工作的增量贡献
3. **Methodological Depth (方法论深度)**: 理论支撑是否充分
4. **Operability & Translation (可操作性与转化价值)**: 实际可执行性
5. **Writing Quality (写作质量与表达清晰度)**: 语言精准度、结构清晰度
6. **Figure Quality (图表质量与信息密度)**: 图表有效性
7. **Ethics Statements (伦理声明与利益冲突核查)**: 资金、利益冲突、伦理审批
8. **Data Openness (数据与代码开放性)**: 数据共享、代码仓库

**IMPORTANT:**
- Be critical but fair
- Provide evidence for your judgments
- Focus on issues that checklists might miss
- Think like a senior researcher, not a checklist auditor
"""

    def _parse_cognitive_response(self, evaluation: dict) -> CognitiveReviewResult:
        """Parse LLM response into CognitiveReviewResult"""

        # Parse fatal flaws
        fatal_flaws = []
        for flaw_data in evaluation.get("fatal_flaws", []):
            fatal_flaws.append(FatalFlaw(
                flaw_type=flaw_data.get("flaw_type", "unknown"),
                description=flaw_data.get("description", ""),
                evidence=flaw_data.get("evidence", ""),
                impact=flaw_data.get("impact", ""),
                severity=flaw_data.get("severity", 0.5)
            ))

        # Parse key strengths
        key_strengths = []
        for strength_data in evaluation.get("key_strengths", []):
            key_strengths.append(KeyStrength(
                strength_type=strength_data.get("strength_type", "unknown"),
                description=strength_data.get("description", ""),
                evidence=strength_data.get("evidence", ""),
                impact=strength_data.get("impact", "")
            ))

        # Parse key weaknesses
        key_weaknesses = []
        for weakness_data in evaluation.get("key_weaknesses", []):
            key_weaknesses.append(KeyWeakness(
                weakness_type=weakness_data.get("weakness_type", "unknown"),
                description=weakness_data.get("description", ""),
                evidence=weakness_data.get("evidence", ""),
                impact=weakness_data.get("impact", ""),
                severity=weakness_data.get("severity", 0.5)
            ))

        return CognitiveReviewResult(
            novelty_score=evaluation.get("novelty_score", 5.0),
            contribution_score=evaluation.get("contribution_score", 5.0),
            fit_score=evaluation.get("fit_score", 5.0),
            clarity_score=evaluation.get("clarity_score", 5.0),
            methodological_depth_score=evaluation.get("methodological_depth_score", 5.0),
            operability_score=evaluation.get("operability_score", 5.0),
            writing_quality_score=evaluation.get("writing_quality_score", 5.0),
            figure_quality_score=evaluation.get("figure_quality_score", 5.0),
            ethics_completeness_score=evaluation.get("ethics_completeness_score", 5.0),
            data_openness_score=evaluation.get("data_openness_score", 5.0),
            fatal_flaws=fatal_flaws,
            key_strengths=key_strengths,
            key_weaknesses=key_weaknesses,
            originality_analysis=evaluation.get("originality_analysis", ""),
            contribution_analysis=evaluation.get("contribution_analysis", ""),
            literature_positioning_analysis=evaluation.get("literature_positioning_analysis", ""),
            methodological_depth_analysis=evaluation.get("methodological_depth_analysis", ""),
            operability_analysis=evaluation.get("operability_analysis", ""),
            writing_quality_analysis=evaluation.get("writing_quality_analysis", ""),
            figure_quality_analysis=evaluation.get("figure_quality_analysis", ""),
            ethics_statement_analysis=evaluation.get("ethics_statement_analysis", ""),
            data_openness_analysis=evaluation.get("data_openness_analysis", ""),
            suggestions=evaluation.get("suggestions", []),
            confidence=evaluation.get("confidence", 0.5),
            is_incremental_work=evaluation.get("is_incremental_work", False),
            is_conclusion_overstated=evaluation.get("is_conclusion_overstated", False),
            has_uncovered_flaws=evaluation.get("has_uncovered_flaws", False),
            overall_recommendation=evaluation.get("overall_recommendation", "major_revision"),
            recommendation_rationale=evaluation.get("recommendation_rationale", "")
        )

    def summarize_rubric_results(
        self,
        review_results: List[BlockReviewResult]
    ) -> Dict[str, Any]:
        """
        Summarize rubric results for cognitive reviewer (avoid token overflow).

        Args:
            review_results: List of block review results

        Returns:
            Summary dictionary with key statistics
        """
        from ..schemas.rubric import VerdictType, SeverityLevel

        total_items = 0
        pass_count = 0
        fail_count = 0
        partial_count = 0
        uncertain_count = 0
        critical_issues = 0
        major_issues = 0
        minor_issues = 0

        for block_result in review_results:
            for item_result in block_result.results:
                total_items += 1

                # Count verdicts
                if hasattr(item_result, 'verdict'):
                    if item_result.verdict == VerdictType.PASS:
                        pass_count += 1
                    elif item_result.verdict == VerdictType.FAIL:
                        fail_count += 1
                    elif item_result.verdict == VerdictType.PARTIAL:
                        partial_count += 1
                    elif item_result.verdict == VerdictType.UNCERTAIN:
                        uncertain_count += 1
                else:
                    # Fallback to score for backward compatibility
                    if item_result.score == 2:
                        pass_count += 1
                    elif item_result.score == 1:
                        partial_count += 1
                    else:
                        fail_count += 1

                # Count severity
                if item_result.severity == SeverityLevel.CRITICAL:
                    critical_issues += 1
                elif item_result.severity == SeverityLevel.MAJOR:
                    major_issues += 1
                elif item_result.severity == SeverityLevel.MINOR:
                    minor_issues += 1

        return {
            "total_items": total_items,
            "pass_count": pass_count,
            "fail_count": fail_count,
            "partial_count": partial_count,
            "uncertain_count": uncertain_count,
            "critical_issues": critical_issues,
            "major_issues": major_issues,
            "minor_issues": minor_issues
        }
