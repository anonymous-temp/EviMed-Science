"""
Meta Reviewer Agent - 融合多个规范的审稿结果
"""
from typing import List, Dict, Any
from ..schemas.document_ir import DocumentIR, StudyProfile
from ..schemas.rubric import BlockReviewResult, VerdictType
from ..schemas.meta_review import MetaReviewResult, ConsolidatedIssue, RubricIssue
from ..schemas.cognitive_review import CognitiveReviewResult
from ..services.llm_gateway import LLMGateway, ModelTier


class MetaReviewerAgent:
    """融合多个规范的审稿结果，选择最相关的判断"""

    def __init__(self, llm_gateway: LLMGateway):
        self.llm = llm_gateway

    async def synthesize_multi_rubric_results(
        self,
        document_ir: DocumentIR,
        multi_rubric_results: Dict[str, List[BlockReviewResult]],
        cognitive_result: CognitiveReviewResult,
        study_profile: StudyProfile = None
    ) -> MetaReviewResult:
        """融合多个规范的结果"""

        try:
            # ── 调试指纹：确认当前 system prompt 版本 ──
            _sp = self._get_system_prompt()
            print(f"  → [MetaReviewer·指纹] "
                  f"规范匹配检查={'Y' if '研究类型规范匹配检查' in _sp else 'N'} | "
                  f"存在性幻觉检查={'Y' if '存在性幻觉检查' in _sp else 'N'} | "
                  f"辩护律师={'Y' if '辩护律师' in _sp else 'N'} | "
                  f"时间锚2026={'Y' if '2026年' in _sp else 'N'}")

            # 提取所有规范中的问题条目
            all_issues = self._extract_issues_from_all_rubrics(multi_rubric_results)

            print(f"  → 提取到 {len(all_issues)} 个问题条目")

            # 【新增】硬性代码级幻觉过滤
            all_issues = self._hard_filter_hallucinations(all_issues, document_ir, study_profile)
            print(f"  → 过滤后剩余 {len(all_issues)} 个问题条目")

            # 构建融合 prompt
            prompt = self._build_meta_review_prompt(document_ir, all_issues, cognitive_result, study_profile)

            # 调用 LLM 进行融合（最多重试2次）
            max_retries = 2
            for attempt in range(max_retries + 1):
                try:
                    result = await self.llm.call_with_json_response(
                        messages=[
                            {"role": "system", "content": self._get_system_prompt()},
                            {"role": "user", "content": prompt}
                        ],
                        model_tier=ModelTier.ADVANCED,
                        temperature=0.0,
                        max_tokens=6000,
                        timeout_sec=600
                    )

                    # Pydantic 模型校验
                    parsed_result = self._parse_result(result["parsed_json"])

                    # 幻觉防护断言：检查 evidence 字段
                    validated_result = self._validate_evidence(parsed_result, document_ir)

                    return validated_result

                except Exception as e:
                    if attempt < max_retries:
                        print(f"  → Meta审查失败 (尝试 {attempt + 1}/{max_retries + 1}): {e}，重试中...")
                        continue
                    else:
                        raise e

        except Exception as e:
            print(f"  → Meta审查失败: {e}")
            raise RuntimeError("Meta-review synthesis failed; no review was produced") from e

    def _extract_issues_from_all_rubrics(
        self,
        multi_rubric_results: Dict[str, List[BlockReviewResult]]
    ) -> List[RubricIssue]:
        """从所有规范中提取问题条目"""
        issues = []

        for rubric_name, blocks in multi_rubric_results.items():
            for block in blocks:
                for item in block.results:
                    # 提取 FAIL、PARTIAL 和 UNCERTAIN
                    verdict = item.verdict.value if hasattr(item.verdict, "value") else str(item.verdict)
                    if verdict in ["FAIL", "PARTIAL", "UNCERTAIN"]:
                        # 使用正确的字段名：missing_detail / actionable_fix（不截断）
                        missing  = getattr(item, "missing_detail", None) or ""
                        fix      = getattr(item, "actionable_fix",  None) or ""
                        severity = item.severity.value if hasattr(item.severity, "value") else str(item.severity)
                        # question 字段在 RubricItemOutputSchema 中不存在，从 item_id 推断
                        question = getattr(item, "question", item.item_id)
                        issues.append(RubricIssue(
                            rubric_name=rubric_name,
                            item_id=item.item_id,
                            item_question=question,
                            verdict=verdict,
                            evidence=missing,  # 不截断，保留完整信息
                            reasoning=fix,     # 不截断，保留完整信息
                            severity=severity
                        ))
                        print(f"  → 提取问题: {rubric_name} - {item.item_id} - {verdict} [{severity}]")

        return issues

    def _hard_filter_hallucinations(
        self,
        issues: List[RubricIssue],
        document_ir: DocumentIR,
        study_profile=None
    ) -> List[RubricIssue]:
        """硬性代码级幻觉过滤 - 物理防线

        采用双轨过滤策略：
        1. item_id 映射过滤（主要，最可靠）：根据规范条目ID直接判断
        2. 关键词文本过滤（备用）：检查 evidence/reasoning 字段中的关键词
        """

        # 构建全文文本用于关键词检索
        if document_ir.fulltext:
            full_text = document_ir.fulltext.lower()
        else:
            full_text_parts = []
            if document_ir.title:
                full_text_parts.append(document_ir.title)
            if document_ir.abstract and hasattr(document_ir.abstract, 'text'):
                full_text_parts.extend(document_ir.abstract.text)
            if document_ir.introduction and hasattr(document_ir.introduction, 'text'):
                full_text_parts.extend(document_ir.introduction.text or [])
            if document_ir.methods and hasattr(document_ir.methods, 'full_text') and document_ir.methods.full_text:
                full_text_parts.extend(document_ir.methods.full_text.text or [])
            if document_ir.results and hasattr(document_ir.results, 'full_text') and document_ir.results.full_text:
                full_text_parts.extend(document_ir.results.full_text.text or [])
            if document_ir.discussion and hasattr(document_ir.discussion, 'full_text') and document_ir.discussion.full_text:
                full_text_parts.extend(document_ir.discussion.full_text.text or [])
            if document_ir.conclusion and hasattr(document_ir.conclusion, 'text'):
                full_text_parts.extend(document_ir.conclusion.text or [])
            full_text = " ".join(full_text_parts).lower()
        title_text = (document_ir.title or "").lower()

        # ── 判断文章类型（用于叙述性综述 PRISMA 过滤）──
        is_systematic_review = False
        is_narrative_review = False
        _st_sources = []
        if study_profile and hasattr(study_profile, 'study_types'):
            _st_sources = [t.lower() for t in (study_profile.study_types or [])]
        if not _st_sources:
            extracted = getattr(document_ir, 'extracted_info', {}) or {}
            _st_sources = [t.lower() for t in extracted.get('study_types', [])]
        if _st_sources:
            is_systematic_review = any(
                'systematic' in t or 'scoping' in t or 'meta-analysis' in t or 'meta analysis' in t
                for t in _st_sources
            )
            is_narrative_review = (
                any('review' in t or 'narrative' in t or 'literature' in t for t in _st_sources)
                and not is_systematic_review
            )
        # 兜底：检查全文中的 "article types:review" 标记
        if not is_narrative_review and not is_systematic_review:
            _ft_compact = full_text.replace(' ', '').replace('\n', '')
            if 'articletypes:review' in _ft_compact or 'articletype:review' in _ft_compact:
                is_narrative_review = True
        # 兜底2：通过标题特征识别叙述性综述（最可靠的二次防线）
        if not is_narrative_review and not is_systematic_review:
            _title_l = title_text.lower()
            _narrative_title_signals = [
                'recent advances', 'a review', 'review of', 'review on',
                'current perspectives', 'current understanding', 'an overview',
                'advances in', 'update on', 'overview of', 'insights into',
                'progress in', 'emerging', 'new insights'
            ]
            _systematic_title_signals = ['systematic review', 'meta-analysis', 'scoping review']
            if (any(k in _title_l for k in _narrative_title_signals)
                    and not any(k in _title_l for k in _systematic_title_signals)):
                is_narrative_review = True
                print(f"  → [硬性过滤] 通过标题识别为叙述性综述: '{document_ir.title[:60]}'")
        if is_narrative_review:
            print(f"  → [硬性过滤] 识别为叙述性综述，将过滤 PRISMA 系统综述特定要求")

        # ============================================================
        # item_id 到"存在性检查函数"的映射表（主要防线）
        # 每条规则：(item_id关键词列表, 存在性检查函数, 说明)
        # 检查函数返回 True 表示原文已有该内容 → 驳回幻觉指控
        # 注意：实际 item_id 格式为大写（如 PRISMA_SCR_1），代码会先 .lower() 转换
        # ============================================================
        ITEM_ID_EXISTENCE_RULES = [
            # 标题含 Scoping Review（PRISMA-ScR Item 1）
            (["prisma_scr_1"],
             lambda ft, tt: "scoping review" in tt or "scoping review" in ft[:500],
             "标题包含 Scoping Review"),

            # 结构化摘要（PRISMA-ScR Item 2）
            (["prisma_scr_2"],
             lambda ft, tt: any(k in ft[:2000] for k in [
                 "background", "methods", "findings", "interpretation",
                 "结论", "目的", "方法", "结果", "背景"
             ]),
             "原文有结构化摘要"),

            # 方法选择理由（PRISMA-ScR Item 3）
            (["prisma_scr_3"],
             lambda ft, tt: any(k in ft for k in [
                 "scoping review", "范围综述", "rather than", "而非系统", "scoping"
             ]),
             "原文有方法选择理由"),

            # PCC框架（PRISMA-ScR Item 4）
            (["prisma_scr_4"],
             lambda ft, tt: any(k in ft for k in [
                 "pcc", "population", "concept", "context", "table 2", "表2", "表 2"
             ]),
             "原文有PCC框架"),

            # 纳入排除标准（PRISMA-ScR Item 6）
            (["prisma_scr_6"],
             lambda ft, tt: any(k in ft for k in [
                 "eligibility", "inclusion", "exclusion", "纳入标准", "排除标准", "纳入", "排除"
             ]),
             "原文有纳入排除标准"),

            # 检索式/布尔逻辑（PRISMA-ScR Item 8）
            (["prisma_scr_8"],
             lambda ft, tt: any(k in ft for k in [
                 " and ", " or ", "table 1", "检索式", "query", "布尔", "boolean"
             ]),
             "原文有布尔检索式"),

            # 双人独立筛选（PRISMA-ScR Item 9）
            (["prisma_scr_9"],
             lambda ft, tt: any(k in ft for k in [
                 "2名", "两名", "独立", "independent", "two reviewers",
                 "two researchers", "两位", "2位"
             ]),
             "原文有双人独立筛选"),

            # 双人独立提取（PRISMA-ScR Item 10）
            (["prisma_scr_10"],
             lambda ft, tt: any(k in ft for k in [
                 "2名", "两名", "独立", "independent", "two reviewers",
                 "two researchers", "两位", "2位"
             ]),
             "原文有双人独立提取"),

            # 数据提取变量清单（PRISMA-ScR Item 11）
            (["prisma_scr_11"],
             lambda ft, tt: any(k in ft for k in [
                 "data charting", "data extraction", "提取变量",
                 "charting fields", "信息提取表", "提取表", "table 3", "表3", "表 3"
             ]),
             "原文有数据提取表"),

            # PRISMA流程图（PRISMA-ScR Item 14/17）
            (["prisma_scr_14", "prisma_scr_17"],
             lambda ft, tt: any(k in ft for k in [
                 "流程图", "flowchart", "图1", "图 1", "figure 1",
                 "fig. 1", "fig 1", "筛选流程"
             ]),
             "原文有流程图"),
        ]

        print(f"  → [硬性过滤] 开始过滤 {len(issues)} 个问题，全文字数: {len(full_text)}")

        filtered_issues = []
        for issue in issues:
            item_id_lower = issue.item_id.lower()
            is_hallucination = False

            # ---- 叙述性综述：PRISMA 系统综述要求不适用 ----
            if is_narrative_review and any(
                pat in item_id_lower
                for pat in ['prisma_scr', 'prisma_2020', 'prisma_', 'prospero']
            ):
                is_hallucination = True
                print(f"  → [硬性过滤·叙述综述] 拦截: {issue.item_id} - 叙述性综述不适用PRISMA要求")

            # ---- 主要防线：item_id 映射检查（不依赖 evidence 字段内容）----
            if not is_hallucination:
                for id_patterns, existence_fn, reason in ITEM_ID_EXISTENCE_RULES:
                    if any(pat in item_id_lower for pat in id_patterns):
                        try:
                            if existence_fn(full_text, title_text):
                                is_hallucination = True
                                print(f"  → [硬性过滤·item_id] 拦截: {issue.item_id} - {reason}")
                        except Exception:
                            pass
                        break  # 每个 issue 只匹配第一条命中的规则

            # ---- 备用防线：文本关键词检查（evidence/reasoning 有内容时）----
            if not is_hallucination:
                evidence_text = (issue.evidence or "").lower()
                reasoning_text = (issue.reasoning or "").lower()
                combined_text = evidence_text + " " + reasoning_text

                if combined_text.strip():  # 只有字段非空才做文本匹配
                    # 拦截"没有方法/结果/讨论"
                    if any(k in combined_text for k in [
                        "缺乏讨论部分", "没有讨论", "无讨论", "未提供方法部分", "没有方法部分", "无方法"
                    ]):
                        if any(k in full_text for k in [
                            "讨论", "discussion", "方法", "methods"
                        ]):
                            is_hallucination = True
                            print(f"  → [硬性过滤·文本] 拦截: {issue.item_id} - 方法/讨论已存在")

                    # 拦截"没有统计结果展示"
                    if not is_hallucination and any(k in combined_text for k in [
                        "未展示统计结果", "统计分析仅停留概念", "缺乏统计结果", "无统计分析", "没有统计分析", "缺乏统计分析"
                    ]):
                        if any(k in full_text for k in [
                            "χ²", "p值", "p<", "p >", "卡方", "chi-square", "fisher", "χ2", "p ="
                        ]):
                            is_hallucination = True
                            print(f"  → [硬性过滤·文本] 拦截: {issue.item_id} - 统计结果已存在")

                    # 拦截"没有检索策略"
                    if not is_hallucination and any(k in combined_text for k in [
                        "未提供检索策略", "没有检索策略", "缺少检索式", "无检索策略", "未报告检索策略"
                    ]):
                        if any(k in full_text for k in [
                            "检索策略", "检索式", "search strategy", "pubmed", "cnki", "web of science", "embase"
                        ]):
                            is_hallucination = True
                            print(f"  → [硬性过滤·文本] 拦截: {issue.item_id} - 检索策略已存在")

                    # 拦截"没有纳入排除标准"
                    if not is_hallucination and any(k in combined_text for k in [
                        "未说明纳入", "没有纳入标准", "缺少排除标准", "无纳入排除", "未报告纳入"
                    ]):
                        if any(k in full_text for k in [
                            "纳入标准", "排除标准", "inclusion criteria", "exclusion criteria", "纳入", "排除"
                        ]):
                            is_hallucination = True
                            print(f"  → [硬性过滤·文本] 拦截: {issue.item_id} - 纳入排除标准已存在")

                    # 拦截"没有利益冲突声明"
                    if not is_hallucination and any(k in combined_text for k in [
                        "未声明资助", "未声明利益冲突", "缺少利益冲突声明", "无利益冲突声明",
                        "no conflict of interest", "no funding statement"
                    ]):
                        if any(k in full_text for k in [
                            "利益冲突", "conflict of interest", "funding", "资助",
                            "声明不存在", "no conflict", "no competing"
                        ]):
                            is_hallucination = True
                            print(f"  → [硬性过滤·文本] 拦截: {issue.item_id} - 利益冲突声明已存在")

                    # 拦截"摘要缺失"
                    if not is_hallucination and any(k in combined_text for k in [
                        "摘要缺失", "缺少摘要", "没有摘要", "无摘要", "abstract is missing", "no abstract", "缺乏摘要"
                    ]):
                        if any(k in full_text[:3000] for k in [
                            "abstract", "摘要", "background", "objective", "purpose", "aim"
                        ]):
                            is_hallucination = True
                            print(f"  → [硬性过滤·文本] 拦截: {issue.item_id} - 摘要已存在")

                    # 拦截"结论章节缺失"
                    if not is_hallucination and any(k in combined_text for k in [
                        "结论章节缺失", "没有结论", "无结论", "缺少结论章节", "conclusion is missing",
                        "结论部分缺失", "未提供结论", "无结论章节"
                    ]):
                        if any(k in full_text for k in [
                            "conclusion", "结论", "in summary", "in conclusion", "总结", "7.", "7、"
                        ]):
                            is_hallucination = True
                            print(f"  → [硬性过滤·文本] 拦截: {issue.item_id} - 结论章节已存在")

                    # 拦截"作者贡献声明缺失"
                    if not is_hallucination and any(k in combined_text for k in [
                        "作者贡献缺失", "未声明作者贡献", "缺少作者贡献", "author contributions missing"
                    ]):
                        if any(k in full_text for k in [
                            "author contributions", "作者贡献", "contributions:", "writing—original"
                        ]):
                            is_hallucination = True
                            print(f"  → [硬性过滤·文本] 拦截: {issue.item_id} - 作者贡献声明已存在")

                    # 叙述性综述特有：拦截"未提供PRISMA流程图/检索式/PROSPERO注册"
                    if not is_hallucination and is_narrative_review:
                        if any(k in combined_text for k in [
                            "prisma流程图", "flowchart", "筛选流程图", "prospero", "注册号",
                            "双人独立筛选", "kappa", "dual reviewer", "布尔逻辑",
                            "检索式", "boolean", "mesh term", "检索策略不完整"
                        ]):
                            is_hallucination = True
                            print(f"  → [硬性过滤·叙述综述文本] 拦截: {issue.item_id} - 叙述性综述不需要此要求")

            if not is_hallucination:
                filtered_issues.append(issue)

        print(f"  → [硬性过滤] 完成：保留 {len(filtered_issues)} 个，过滤 {len(issues) - len(filtered_issues)} 个幻觉")
        return filtered_issues

    def _get_system_prompt(self) -> str:
        """系统提示"""
        return """【Meta层核心职责：研究类型一致性检查与幻觉过滤】

你是主编，负责对底层审稿意见进行质量把关。你的目标是：保留所有真实的、有依据的批评，只过滤明确的幻觉（即文章里明确写了但审查说没有的指控）。

【过滤一：研究类型规范匹配检查】

情形A——横断面研究/文献计量分析（非综述类）：
如果文章是横断面研究/文献计量分析（非范围综述，标题无"scoping review"字样），以下类型的底层意见必须全部删除：
- 任何要求PCC框架的意见
- 任何要求PICO框架的意见
- 任何批评"未声明为范围综述"的意见
- 任何要求患者/公众利益相关者参与的意见
- 任何要求GRADE推荐强度分级的意见（除非文章本身是指南）

情形B——叙述性综述/一般文献综述（Narrative Review / Literature Review）：
如果文章类型标注为 "Review"、"Narrative Review"、"Literature Review"，但不是 "Systematic Review"、"Scoping Review" 或 "Meta-Analysis"，以下意见必须全部删除：
- 任何要求PRISMA流程图（PRISMA flow diagram）的意见
- 任何要求PROSPERO预注册（protocol registration）的意见
- 任何批评"未报告完整检索式/布尔逻辑/MeSH词"的意见（叙述性综述不强制公开完整检索式）
- 任何要求双人独立筛选和Kappa值计算的意见
- 任何要求"方法部分"专门描述文献纳排标准的意见（叙述性综述通常无独立方法章节）
- 任何要求GRADE证据分级的意见
- 任何批评"未提供Boolean search expression"或"未说明single/dual reviewer screening"的意见
判断依据：研究类型字段含 "Narrative Review"、"Literature Review"、"Review" 且不含 "Systematic"/"Scoping"/"Meta"；或标题含 "Recent Advances"/"A Review"/"Review of"/"Overview of"/"Advances in"。

【过滤二：存在性幻觉检查（只过滤A类幻觉）】
只有当底层意见属于以下明确幻觉时才删除：
- 底层说"无统计数据/无表格"，但原文有"表""Table""p<""χ²"等字眼 → 删除
- 底层说"无方法/结果/讨论/结论章节"，但原文有对应章节编号或关键词 → 删除
- 底层说"无摘要"，但原文有 Abstract/摘要 段落 → 删除
- 底层说"无检索策略"，但原文有数据库名称 → 删除
- 底层说"无纳入排除标准"，但原文有对应标题 → 删除
- 底层说"无利益冲突声明"，但原文末尾有相关声明 → 删除
- 底层说"无资金来源声明"，但原文有 Funding/资助 段落 → 删除
- 底层说"无作者贡献声明"，但原文有 Author Contributions/作者贡献 段落 → 删除

注意：C类问题（有该内容但不符合规范要求）必须保留，例如：有检索策略但缺MeSH词、有样本量但无计算依据、有统计分析但未校正多重比较。这些是真实的学术缺陷，不是幻觉。

【过滤三：参考文献与声明一致性核查（重要）】
在审阅问题时，注意以下特殊类型的学术错误（不是幻觉，而是真实缺陷，应保留为 major 级别问题）：
- 动物实验研究被引用为人群临床研究：正文声称"一项前瞻性队列研究（n=XXX名孕妇/患者）"，但传入的参考文献列表显示对应文献是小鼠/大鼠实验 → 这是引用错误（citation mismatch），标记为 major 级别问题保留。
- 正文中具体数据（n值、p值、效应量、置信区间）无法从所引文献中得到支撑 → 标记为数据核实问题，保留。
- 同一内容在不同章节被重复描述（如相同机制、相同数据出现两次）→ 标记为冗余，保留为 minor 级别。

【系统时间设定】当前真实世界时间为 2026年。任何发生在 2026 年及以前的研究、检索日期、发表日期都是完全合法且正常的。绝对禁止以'时间发生在未来'为由批评任何 2026 年的日期！

你是一位严格的主编。你的任务是精准区分三类底层意见：

判断类型：
A类（幻觉批评）：原文中明确存在被批评的内容，底层 Agent 没有读到。→ 标记为 hallucination_rejected，丢弃。
B类（真实缺失）：原文中确实没有该内容。→ 标记为 verified_missing，保留。
C类（实质性不足）：原文有该内容，但内容不满足规范要求（如有检索策略但无 MeSH 词、有样本量描述但无统计效能计算、有随机化但分配隐藏未报告）。→ 标记为 verified_insufficient，保留，并说明不足之处。

你的三步推理流程：

第一步：规范适用性裁决（Rubric Arbitration）
- 判断每个规范是否真正适用于该文章的研究类型
- 如果某个规范不适用（例如用 PRISMA 2020 评估叙述性综述，或用 CONSORT 评估观察性研究），标记为"不适用"，不得将其意见纳入最终报告
- 如果多个规范对同一问题有不同判断，采纳更适用规范的意见

第二步：交叉事实核查（Anti-Hallucination Verification）

对于每一条底层批评意见，执行以下核查：

**核查1：存在性核查（只针对A类）**
底层批评文章"完全缺少 X 内容"时，确认原文是否真的完全没有：
- 如果文章方法部分明确写了"两名研究人员独立筛选"，则删除"未说明双人筛选"的批评。
- 如果文章提供了检索式（即使格式不标准），则将"未提供任何检索策略"改为"检索式不够规范"（降为C类，保留）。
- 如果文章已有流程图，则删除"缺少流程图"的批评。
- 如果文章末尾有 Conflict of Interest / Funding / Author Contributions 段落，则删除声称这些缺失的批评。

**核查2：质量核查（针对C类，保留）**
底层批评内容"存在但不规范"时，这属于C类，必须保留：
- 有样本量但无效能计算依据 → 保留（C类）
- 有统计分析但多重比较未校正 → 保留（C类）
- 有随机化描述但分配隐藏不清 → 保留（C类）
- 有讨论但局限性分析不充分 → 保留（C类）
- 有参考文献但引用不准确/过时/与文中声明的研究类型不符 → 保留（C类）

**核查3：时间合理性核查**
如果底层批评文章的日期"不合理"，请先核查：
- 该日期是否在文章所声明的研究时间范围内？
- 如果合理（如检索截止日期与论文撰写时间一致），删除该批评。

第三步：问题聚类与严重度分级
- 将通过核查的问题按维度聚类：方法学透明度、研究设计完整性、结果呈现、写作质量
- 每个聚类下标注严重度：fatal / major / minor
- 每个问题必须包含：standard_reference（违反的具体规范条目）、location_in_paper（问题在原文的位置）

【输出丰富度要求】
一个合格的预审报告应包含 8-15 个具体的、有标准依据的方法学或学术缺陷。
如果 verified_issues 列表少于 6 条，你必须重新审视底层意见，检查是否有C类问题被错误地当作A类过滤掉了。
不要过度合并相似问题导致问题数量减少，每个独立的方法学缺陷应作为独立条目保留。

【强制要求：认知评审的 Fatal Flaw 必须纳入 verified_issues】
传入的【认知审查结果】中包含了高层次的致命缺陷（fatal_flaws）分析。这些缺陷是由专家级认知评审独立发现的，具有极高可信度。
你必须执行以下操作：
- 如果【认知审查结果·致命缺陷详情】中有内容（非"无"），必须将其作为 fatal 级别问题加入 verified_issues，不得过滤！
- 如果【认知审查结果·方法论深度分析】中指出了方法学缺陷，必须将其作为 major 级别问题加入 verified_issues。
- 这些问题不需要在底层规范条目中找到对应项，直接基于认知评审的分析结论生成条目即可。

【重要例外：叙述性综述免于系统评价要求】
若文章研究类型含"Narrative Review"、"Literature Review"、"Review"（不含Systematic/Scoping/Meta），
或文章标题含"Recent Advances"/"A Review"/"Review of"/"Overview"/"Advances in"/"Current Perspectives"等综述类标志词，
则认知审查结果中以下类型的致命缺陷/方法学问题，不得纳入 verified_issues（必须过滤）：
- 未提供PRISMA流程图（PRISMA flow diagram）
- 未进行PROSPERO/OSF预注册（protocol registration）
- 未提供完整布尔逻辑检索式/MeSH词/检索策略
- 未进行双人独立筛选（two reviewers）
- 未进行Kappa值/评分者间信度计算
- 未使用偏倚风险评估工具（ROBINS-I / SYRCLE / Cochrane RoB）
- 未进行GRADE证据分级
- 未报告完整纳入排除标准或方法学章节
以上内容仅适用于系统综述/范围综述，叙述性综述不强制要求，不得作为缺陷列出。

输出中文。"""

    def _build_meta_review_prompt(
        self,
        document_ir: DocumentIR,
        all_issues: List[RubricIssue],
        cognitive_result: CognitiveReviewResult,
        study_profile: StudyProfile = None
    ) -> str:
        """构建融合 prompt（包含原文用于事实核查）"""

        # 按规范分组，universal_rubric 优先排在最前面，保证不被截断
        issues_by_rubric = {}
        for issue in all_issues:
            if issue.rubric_name not in issues_by_rubric:
                issues_by_rubric[issue.rubric_name] = []
            issues_by_rubric[issue.rubric_name].append(issue)

        rubric_order = ["universal_rubric"] + [
            k for k in issues_by_rubric if k != "universal_rubric"
        ]

        # 构建问题列表（提供完整信息给 Meta 层）
        issues_text = ""
        for rubric_name in rubric_order:
            if rubric_name not in issues_by_rubric:
                continue
            issues = issues_by_rubric[rubric_name]
            issues_text += f"\n【{rubric_name}】发现 {len(issues)} 个问题：\n"
            for issue in issues[:20]:  # 每个规范最多20个
                issues_text += f"- [{issue.verdict}][{issue.severity}] {issue.item_id}: {issue.item_question}\n"
                if issue.evidence:
                    issues_text += f"  缺失内容: {issue.evidence}\n"
                if issue.reasoning:
                    issues_text += f"  改进建议: {issue.reasoning}\n"

        # 提取 DocumentIR 关键内容用于事实核查
        if document_ir.abstract and hasattr(document_ir.abstract, 'text') and document_ir.abstract.text:
            doc_abstract = ' '.join(document_ir.abstract.text[:3])[:1000]
        elif document_ir.fulltext:
            # DocumentIR 未识别到 abstract，但全文中有，用正则提取
            import re as _re_abs
            _m = _re_abs.search(r'(?i)(?:^|\n)\s*abstract\s*\n', document_ir.fulltext)
            if _m:
                _after = document_ir.fulltext[_m.end():_m.end() + 2000]
                _end = _re_abs.search(r'\n\s*(?:#{1,3}\s|\d+\.?\s*(?:introduction|keywords|1\s))', _after, _re_abs.IGNORECASE)
                doc_abstract = (_after[:_end.start()] if _end else _after[:1500]).strip()[:1000]
            else:
                doc_abstract = document_ir.fulltext[:1000]
        else:
            doc_abstract = "无摘要"

        # 提取主要章节内容（安全链式访问，防止中间层为 None）
        doc_sections = ""
        try:
            if document_ir.introduction and hasattr(document_ir.introduction, 'text') and document_ir.introduction.text:
                doc_sections += f"- 引言: {' '.join(document_ir.introduction.text[:2])[:200]}...\n"
        except Exception:
            pass
        try:
            methods_text = getattr(getattr(getattr(document_ir, 'methods', None), 'full_text', None), 'text', None)
            if methods_text:
                doc_sections += f"- 方法: {' '.join(methods_text[:2])[:200]}...\n"
        except Exception:
            pass
        try:
            results_text = getattr(getattr(getattr(document_ir, 'results', None), 'full_text', None), 'text', None)
            if results_text:
                doc_sections += f"- 结果: {' '.join(results_text[:2])[:200]}...\n"
        except Exception:
            pass
        try:
            discussion_text = getattr(getattr(getattr(document_ir, 'discussion', None), 'full_text', None), 'text', None)
            if discussion_text:
                doc_sections += f"- 讨论: {' '.join(discussion_text[:2])[:200]}...\n"
        except Exception:
            pass
        try:
            if document_ir.conclusion and hasattr(document_ir.conclusion, 'text') and document_ir.conclusion.text:
                doc_sections += f"- 结论: {' '.join(document_ir.conclusion.text[:2])[:200]}...\n"
        except Exception:
            pass

        # 提取声明类字段（COI / Funding / Author Contributions）供事实核查
        extracted = getattr(document_ir, 'extracted_info', {}) or {}
        coi_text    = extracted.get('conflicts_of_interest', '') or ''
        funding_text = extracted.get('funding_source', '')       or ''
        declarations_section = ""
        if coi_text:
            declarations_section += f"- 利益冲突声明: {coi_text[:200]}\n"
        if funding_text:
            declarations_section += f"- 资金来源声明: {funding_text[:200]}\n"
        # 如果 extracted_info 未捕获，尝试从 fulltext 末尾搜索
        if not declarations_section and document_ir.fulltext:
            tail = document_ir.fulltext[-2000:].lower()
            if any(k in tail for k in ['conflict of interest', '利益冲突', 'competing interest']):
                declarations_section += "- 利益冲突声明: Y 存在于文末\n"
            if any(k in tail for k in ['funding', '资助', 'supported by', 'grant']):
                declarations_section += "- 资金来源声明: Y 存在于文末\n"
            if any(k in tail for k in ['author contributions', '作者贡献']):
                declarations_section += "- 作者贡献声明: Y 存在于文末\n"

        # 构建已确认存在章节的硬约束（防幻觉）
        confirmed_section_lines = []
        confirmed = (document_ir.extracted_info or {}).get('confirmed_sections', {})
        for _key, info in confirmed.items():
            if info.get("exists"):
                line = f"- {info['display_name']}: 已确认存在"
                if info.get("preview"):
                    line += f"。内容预览: \"{info['preview']}\""
                confirmed_section_lines.append(line)
        confirmed_sections_text = "\n".join(confirmed_section_lines) if confirmed_section_lines else "（未检测到）"

        # 提取参考文献片段（用于引用一致性核查）
        refs_snippet = ""
        if hasattr(document_ir, 'references') and document_ir.references:
            refs_list = document_ir.references[:15]  # 前15条
            refs_snippet = "\n".join(refs_list)[:1500]

        # 从 study_profile 获取研究类型（优先），否则从 document_ir 兜底
        if study_profile and hasattr(study_profile, 'study_types') and study_profile.study_types:
            study_types_str = ', '.join(study_profile.study_types)
        elif hasattr(document_ir, 'study_profile') and document_ir.study_profile and hasattr(document_ir.study_profile, 'study_types'):
            study_types_str = ', '.join(document_ir.study_profile.study_types)
        else:
            study_types_str = '未知'

        return f"""
稿件标题: {document_ir.title}
研究类型: {study_types_str}

【DocumentIR 原文摘要（用于事实核查）】
{doc_abstract}

【DocumentIR 主要章节（用于事实核查）】
{doc_sections}

【文末声明（COI / Funding / 作者贡献）——用于判断相关批评是否为幻觉】
{declarations_section if declarations_section else "（未从extracted_info提取到，请以全文为准）"}

【已确认存在的章节（代码正则检测，确定性结论——绝对不得声称以下章节缺失！）】
{confirmed_sections_text}

【参考文献列表片段（前15条，用于引用一致性核查）】
{refs_snippet if refs_snippet else "（无参考文献数据）"}

【认知审查结果】
- 新颖性: {cognitive_result.novelty_score}/10
- 贡献度: {cognitive_result.contribution_score}/10
- 致命缺陷数: {len(cognitive_result.fatal_flaws)}
- 致命缺陷详情: {'; '.join([f.description[:150] for f in cognitive_result.fatal_flaws]) if cognitive_result.fatal_flaws else '无'}
- 方法论深度分析: {cognitive_result.methodological_depth_analysis[:300] if cognitive_result.methodological_depth_analysis else '无'}
- 推荐: {cognitive_result.overall_recommendation}

【多规范条目审查结果】
{issues_text[:8000]}

任务: 执行三步推理并输出JSON:
{{
  "applied_rubrics": ["prisma_scr", "universal_rubric"],
  "rejected_rubrics": [{{"rubric": "prisma_2020", "reason": "文章为Scoping Review，非系统评价"}}],
  "verified_issues": [
    {{
      "issue_type": "flow_diagram_missing",
      "title": "缺少PRISMA-ScR流程图",
      "description": "在方法部分（第4页），作者未提供 PRISMA-ScR 所要求的文献筛选流程图。这使得读者无法追溯从初始检索到最终纳入的文献数量变化，影响了研究的透明度。建议：补充 PRISMA-ScR 流程图，展示各阶段文献数量及排除原因。",
      "severity": "major",
      "source_rubrics": ["prisma_scr"],
      "source_items": ["PRISMA-ScR_17"],
      "evidence_quotes": ["方法部分未提及流程图"],
      "confidence": 0.9,
      "standard_reference": "PRISMA-ScR 第17条：应提供文献筛选流程图",
      "location_in_paper": "方法部分，第4页"
    }}
  ],
  "hallucination_rejected": [
    {{"original_claim": "未提供完整检索式", "rejection_reason": "DocumentIR 摘要中提到'检索策略见Table 1'，已提供"}}
  ],
  "fatal_issues": [...],
  "major_issues": [...],
  "minor_issues": [...],
  "key_strengths": ["研究设计合理", "样本覆盖面广"],
  "overall_assessment": "本文是一项Scoping Review，研究问题具有价值...",
  "recommendation": "major_revision",
  "confidence": 0.85
}}

要求:
1. 必须对照 DocumentIR 原文核查每个问题，驳回不成立的意见
2. 如果【文末声明】段落显示 COI/Funding/Author Contributions 已存在，必须驳回声称这些内容缺失的批评
3. 核查参考文献：如正文引用某文献作为人群研究依据，但参考文献标题显示该文献是动物研究（mice/rats/mouse model等），标记为引用不一致（citation mismatch），作为 major 问题保留
4. 每个问题必须包含 standard_reference 和 location_in_paper
5. description 必须具体、可操作，不泛泛而谈
6. 严禁编造原文中不存在的数字或方法
7. 【叙述性综述强制检查】如果研究类型字段含"Narrative Review"/"Literature Review"/"Review"（不含Systematic/Scoping/Meta），或标题含"Recent Advances"/"A Review"/"Review of"/"Overview"/"Advances in"，则以下类型的任何问题必须全部驳回（hallucination_rejected），不得进入 verified_issues：
   - 要求PRISMA流程图的问题
   - 要求PROSPERO/OSF注册的问题
   - 要求完整布尔逻辑检索式/MeSH词的问题
   - 要求双人独立筛选/Kappa值的问题
   - 要求ROBINS-I/SYRCLE等偏倚风险评估工具的问题
   - 要求GRADE证据分级的问题
   - 要求独立方法章节描述纳排标准的问题
"""

    def _parse_result(self, data: dict) -> MetaReviewResult:
        """解析 LLM 返回结果（支持新的 verified_issues 结构）"""
        def _parse_issues(raw_list: list) -> List[ConsolidatedIssue]:
            issues = []
            for item in raw_list:
                try:
                    # 确保必填字段有值
                    item.setdefault("issue_type", "unknown")
                    item.setdefault("title", "未知问题")
                    item.setdefault("description", "")
                    item.setdefault("severity", "major")
                    item.setdefault("source_rubrics", [])
                    item.setdefault("source_items", [])
                    item.setdefault("evidence_quotes", [])
                    item.setdefault("confidence", 0.7)
                    item.setdefault("standard_reference", "")
                    item.setdefault("location_in_paper", "")
                    issues.append(ConsolidatedIssue(**item))
                except Exception as e:
                    print(f"  → 解析问题条目失败: {e}, 原始数据: {item}")
            return issues

        # 优先使用 verified_issues，如果不存在则使用旧格式
        verified_issues = data.get("verified_issues", [])
        if verified_issues:
            # 按 severity 分组
            fatal_issues = [i for i in _parse_issues(verified_issues) if i.severity == "fatal"]
            major_issues = [i for i in _parse_issues(verified_issues) if i.severity == "major"]
            minor_issues = [i for i in _parse_issues(verified_issues) if i.severity == "minor"]
        else:
            # 兜底：使用旧格式
            fatal_issues = _parse_issues(data.get("fatal_issues", []))
            major_issues = _parse_issues(data.get("major_issues", []))
            minor_issues = _parse_issues(data.get("minor_issues", []))

        print(f"  → 解析结果: 致命={len(fatal_issues)}, 主要={len(major_issues)}, 次要={len(minor_issues)}")

        # 记录被驳回的幻觉问题
        hallucination_rejected = data.get("hallucination_rejected", [])
        if hallucination_rejected:
            print(f"  → 驳回幻觉问题 {len(hallucination_rejected)} 个")

        return MetaReviewResult(
            fatal_issues=fatal_issues,
            major_issues=major_issues,
            minor_issues=minor_issues,
            key_strengths=data.get("key_strengths", []),
            overall_assessment=data.get("overall_assessment", ""),
            recommendation=data.get("recommendation", "major_revision"),
            confidence=data.get("confidence", 0.5),
            applied_rubrics=data.get("applied_rubrics", []),
            rejected_rubrics=data.get("rejected_rubrics", []),
            hallucination_rejected=hallucination_rejected
        )

    def _validate_evidence(
        self,
        meta_result: MetaReviewResult,
        document_ir: DocumentIR
    ) -> MetaReviewResult:
        """幻觉防护断言：检查问题的 evidence 字段是否为空，降级处理"""

        def validate_issues(issues):
            validated = []
            for issue in issues:
                if not issue.evidence_quotes or all(not eq.strip() for eq in issue.evidence_quotes):
                    # evidence 为空，降低置信度并标记
                    issue.confidence = min(issue.confidence * 0.5, 0.3)
                    issue.description = f"[待核实] {issue.description}"
                    print(f"  → 警告：问题 '{issue.title}' 缺少证据引用，已降级")
                validated.append(issue)
            return validated

        meta_result.fatal_issues = validate_issues(meta_result.fatal_issues)
        meta_result.major_issues = validate_issues(meta_result.major_issues)
        meta_result.minor_issues = validate_issues(meta_result.minor_issues)

        return meta_result
