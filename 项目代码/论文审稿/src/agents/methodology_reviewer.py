"""
Material Engine Agent - Neutral evidence gathering (formerly Methodology Reviewer)

This agent is part of the Plan-Retrieve-Argue architecture.
Its role has changed from "reviewer" to "evidence gatherer":

OLD: Review rubric items and make judgments
NEW: Gather material snippets without any subjective criticism

Key principles:
1. NEUTRALITY: Never include subjective judgments
2. FACTUAL: Only report what was found/not found
3. LOCATABLE: Provide precise evidence locations
4. COMPLETE: Search all relevant sections thoroughly
"""

import asyncio
import time
from typing import List, Dict, Optional, Any
import uuid
import re

from ..schemas.document_ir import DocumentIR, EvidenceMap
from ..schemas.rubric import RubricBlock, RubricItem, RubricItemOutputSchema, BlockReviewResult, ItemStatus, SeverityLevel, VerdictType
from ..schemas.plan_retrieve_argue import (
    MaterialSnippet, MaterialStatus, ReviewFocus
)
from ..schemas.review_state import EvidenceSpan, RetrievalTrace
from ..services.llm_gateway import LLMGateway, ModelTier
from ..services.evidence_retriever import EvidenceRetriever


class MaterialEngineAgent:
    """
    Material gathering engine that collects evidence snippets.

    CRITICAL: This agent is a NEUTRAL EVIDENCE COLLECTOR.
    It must NOT include any subjective judgments, criticism, or recommendations.
    All output should be factual descriptions of what was found or not found.
    """

    def __init__(self, llm_gateway: LLMGateway):
        self.llm = llm_gateway
        self.evidence_retriever = EvidenceRetriever(llm_gateway)
        self.synonym_map = self._build_synonym_map()

    async def gather_materials(
        self,
        focus: ReviewFocus,
        document_ir: DocumentIR,
        rubric_items: List[RubricItem]
    ) -> List[MaterialSnippet]:
        """
        Gather material snippets for a review focus area.

        Args:
            focus: Review focus from the plan
            document_ir: Structured document representation
            rubric_items: Relevant rubric items for this focus

        Returns:
            List of MaterialSnippet objects (neutral, no judgments)
        """
        materials = []

        for item in rubric_items:
            material = await self._gather_material_for_item(item, document_ir, focus)
            materials.append(material)

        return materials

    async def gather_materials_batch(
        self,
        focus_list: List[ReviewFocus],
        document_ir: DocumentIR,
        rubric_items_map: Dict[str, List[RubricItem]]
    ) -> List[MaterialSnippet]:
        """
        Gather materials for multiple focus areas concurrently.

        Args:
            focus_list: List of review focus areas
            document_ir: Structured document representation
            rubric_items_map: Map of focus topic to rubric items

        Returns:
            Combined list of MaterialSnippet objects
        """
        tasks = []

        for focus in focus_list:
            items = rubric_items_map.get(focus.topic, [])
            if items:
                tasks.append(self.gather_materials(focus, document_ir, items))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        all_materials = []
        for result in results:
            if isinstance(result, list):
                all_materials.extend(result)
            elif isinstance(result, Exception):
                print(f"Material gathering failed: {result}")

        return all_materials

    async def _gather_material_for_item(
        self,
        item: RubricItem,
        document_ir: DocumentIR,
        focus: ReviewFocus
    ) -> MaterialSnippet:
        """
        Gather material for a single rubric item.

        This is a NEUTRAL evidence gathering process:
        1. Search for evidence using retriever
        2. If found, extract quote and location
        3. Provide neutral summary (NO judgments)
        """
        material_id = f"mat-{uuid.uuid4().hex[:8]}"

        # Step 1: Retrieve evidence using evidence retriever
        evidence_spans, trace = self.evidence_retriever.retrieve(
            item=item,
            document_ir=document_ir,
            mode="hybrid"
        )

        # Step 2: Determine status based on retrieval
        if evidence_spans and evidence_spans[0].score > 0.5:
            # Evidence found
            best_evidence = evidence_spans[0]
            status = MaterialStatus.FOUND

            # Generate neutral summary using LLM
            neutral_summary = await self._generate_neutral_summary(
                item, best_evidence.quote
            )

            return MaterialSnippet(
                material_id=material_id,
                rubric_item_id=item.item_id,
                status=status,
                evidence_quote=best_evidence.quote[:500],  # Limit length
                evidence_location=f"{best_evidence.section}, Page {best_evidence.page}" if best_evidence.page else best_evidence.section,
                material_summary=neutral_summary,
                search_sections=self._get_searched_sections(item, focus),
                search_keywords=self._get_search_keywords(item),
                retrieval_method=best_evidence.method,
                retrieval_confidence=best_evidence.score,
                context_quality="exact" if best_evidence.method == "structure" else "fuzzy"
            )

        elif evidence_spans:
            # Evidence found but low confidence - mark as UNCLEAR
            best_evidence = evidence_spans[0]
            status = MaterialStatus.UNCLEAR

            return MaterialSnippet(
                material_id=material_id,
                rubric_item_id=item.item_id,
                status=status,
                evidence_quote=best_evidence.quote[:500],
                evidence_location=best_evidence.section,
                material_summary=f"找到相关内容，但与 {item.item_id} 的对应关系不明确。",
                search_sections=self._get_searched_sections(item, focus),
                search_keywords=self._get_search_keywords(item),
                retrieval_method=best_evidence.method,
                retrieval_confidence=best_evidence.score,
                context_quality="fuzzy"
            )

        else:
            # No evidence found - need to confirm with full-text search
            status = await self._confirm_not_found(item, document_ir)

            return MaterialSnippet(
                material_id=material_id,
                rubric_item_id=item.item_id,
                status=status,
                evidence_quote=None,
                evidence_location=None,
                material_summary=f"在论文的 {', '.join(self._get_searched_sections(item, focus))} 章节中未找到与 {item.item_id} 相关的内容。",
                search_sections=self._get_searched_sections(item, focus),
                search_keywords=self._get_search_keywords(item),
                retrieval_method="structure",
                retrieval_confidence=0.0,
                context_quality="full_text"
            )

    async def _generate_neutral_summary(
        self,
        item: RubricItem,
        quote: str
    ) -> str:
        """
        Generate a NEUTRAL one-sentence summary of found evidence.

        CRITICAL: No subjective judgments, criticism, or recommendations.
        Only factual description of what the manuscript states.
        """
        prompt = f"""
You are a neutral evidence summarizer. Your task is to provide a ONE-SENTENCE factual summary of what the manuscript states regarding a specific criterion.

CRITERION: {item.question}

EVIDENCE FROM MANUSCRIPT:
"{quote[:800]}"

---

RULES:
1. Be STRICTLY NEUTRAL - no judgments, criticism, or evaluation
2. Only describe WHAT the manuscript states, not WHETHER it's adequate
3. Use factual language: "The manuscript describes...", "The paper states..."
4. ONE sentence only, max 50 words
5. If the evidence is unclear, say "The manuscript mentions [topic] but details are unclear."

BAD examples (DO NOT use):
- "The manuscript fails to describe..." (judgmental)
- "The randomization method is inadequately described..." (evaluative)
- "Missing information about..." (implies deficiency)

GOOD examples:
- "The manuscript describes randomization using computer-generated sequences."
- "The paper states that participants were blinded to treatment assignment."
- "The methods section mentions power calculation based on previous studies."

Return ONLY the summary sentence, nothing else.
"""

        try:
            result = await self.llm.call_with_retry(
                messages=[
                    {"role": "system", "content": "You are a neutral evidence summarizer. No judgments allowed."},
                    {"role": "user", "content": prompt}
                ],
                model_tier=ModelTier.FAST,
                max_tokens=100,
                temperature=0.0
            )
            summary = result.get("content", "").strip()
            # Remove any leading/trailing quotes
            summary = summary.strip('"\'')
            return summary
        except Exception as e:
            print(f"Neutral summary generation failed: {e}")
            return f"The manuscript contains content related to {item.item_id}."

    async def _confirm_not_found(
        self,
        item: RubricItem,
        document_ir: DocumentIR
    ) -> MaterialStatus:
        """
        Confirm that evidence is truly not found by doing a thorough search.

        Returns NOT_FOUND only if confident, otherwise UNCLEAR.
        """
        # Construct search context from full text
        if document_ir.fulltext:
            search_text = document_ir.fulltext.lower()
        else:
            # Construct from sections
            parts = []
            if document_ir.methods.full_text.text:
                parts.extend(document_ir.methods.full_text.text)
            if document_ir.results.full_text.text:
                parts.extend(document_ir.results.full_text.text)
            search_text = " ".join(parts).lower()

        # Get keywords from item
        keywords = self._get_search_keywords(item)

        # Check if ANY keyword appears in the text
        found_any = any(kw.lower() in search_text for kw in keywords)

        if found_any:
            # Some keywords found but structured search failed
            # This suggests the information might be present but not structured
            return MaterialStatus.UNCLEAR
        else:
            # No keywords found at all - confident NOT_FOUND
            return MaterialStatus.NOT_FOUND

    def _get_searched_sections(self, item: RubricItem, focus: ReviewFocus) -> List[str]:
        """Get list of sections that were searched"""
        sections = []

        # From evidence location hint
        hint = item.evidence_location_hint
        if hint:
            sections.append(hint)

        # From focus evidence slots
        sections.extend(focus.evidence_slots)

        # Deduplicate
        return list(set(sections))

    def _get_search_keywords(self, item: RubricItem) -> List[str]:
        """Extract search keywords from rubric item"""
        keywords = []

        # From question
        words = re.findall(r'\b\w{4,}\b', item.question.lower())
        stopwords = {'does', 'were', 'have', 'been', 'this', 'that', 'with', 'from',
                     'should', 'would', 'could', 'describe', 'described', 'report',
                     'reported', 'include', 'included', 'study', 'paper', 'manuscript'}
        keywords.extend([w for w in words if w not in stopwords])

        # From evaluation criteria
        criteria_words = re.findall(r'\b\w{4,}\b', item.evaluation_criteria.lower())
        keywords.extend([w for w in criteria_words if w not in stopwords])

        # Deduplicate and limit
        return list(set(keywords))[:15]

    def _build_synonym_map(self) -> dict:
        """Build a synonym mapping for common methodological terms."""
        return {
            "randomization": ["random assignment", "randomisation", "allocation", "randomized", "randomly assigned"],
            "participants": ["subjects", "patients", "individuals", "participants", "cases"],
            "blinding": ["masking", "concealment", "blinded", "masked"],
            "sample": ["sample size", "participants", "subjects", "cohort"],
            "intervention": ["treatment", "therapy", "procedure", "protocol"],
            "outcome": ["endpoint", "result", "measure", "assessment"],
            "statistical": ["analysis", "statistics", "statistical analysis", "statistical methods"],
            "ethics": ["ethical approval", "irb", "ethics committee", "institutional review"],
            "consent": ["informed consent", "consent form", "patient consent"],
            "funding": ["financial support", "grant", "sponsor", "financial disclosure"],
        }


# =============================================================================
# Legacy MethodologyReviewerAgent for backwards compatibility
# =============================================================================

class MethodologyReviewerAgent:
    """
    Stateless agent for executing methodology review of a rubric block.

    NOTE: This class maintains backwards compatibility with the old review_block API.
    For new code, prefer using MaterialEngineAgent.gather_materials().

    Each instance processes ONE rubric block containing 5-8 related evaluation items.
    Multiple instances run concurrently for different blocks.
    """

    def __init__(self, llm_gateway: LLMGateway):
        self.llm = llm_gateway
        self.synonym_map = self._build_synonym_map()
        self.evidence_retriever = EvidenceRetriever(llm_gateway)
        # Also initialize the new material engine for hybrid use
        self.material_engine = MaterialEngineAgent(llm_gateway)

    async def review_block(
        self,
        rubric_block: RubricBlock,
        document_ir: DocumentIR,
        evidence_map: EvidenceMap,
        language: str = "en"
    ) -> BlockReviewResult:
        """
        Review a single rubric block.

        Args:
            rubric_block: Block of related rubric items to evaluate
            document_ir: Structured manuscript representation
            evidence_map: Index for fast evidence lookup
            language: Manuscript language ('zh' or 'en')

        Returns:
            BlockReviewResult containing evaluation of all items in the block
        """
        start_time = time.time()
        results: List[RubricItemOutputSchema] = []
        errors: List[str] = []

        # ── 调试指纹：确认当前 system prompt 版本（每块打印一次）──
        # 通过检查已嵌入 _evaluate_item 内的 system prompt 文本来验证
        _sp_marker = "2026年"          # 时间锚
        _sp_marker2 = "同义词反向搜索"  # 反向搜索
        _sp_marker3 = "禁止无中生有"    # 防幻觉
        # 用 source 代码字符串检查（轻量，只搜索已知锚点）
        import inspect
        _src = inspect.getsource(self._evaluate_item)
        print(f"  → [MethodologyReviewer·指纹] block={rubric_block.block_name} | "
              f"时间锚2026={'Y' if _sp_marker in _src else 'N'} | "
              f"反向搜索={'Y' if _sp_marker2 in _src else 'N'} | "
              f"禁止无中生有={'Y' if _sp_marker3 in _src else 'N'} | "
              f"items={len(rubric_block.items)}")

        # Process each item in the block
        for item in rubric_block.items:
            try:
                result = await self._evaluate_item(item, document_ir, evidence_map, language, rubric_block.block_name)
                results.append(result)
            except Exception as e:
                # Record error but continue with other items
                error_msg = f"Failed to evaluate {item.item_id}: {str(e)}"
                errors.append(error_msg)

                # Add a failed result
                results.append(RubricItemOutputSchema(
                    item_id=item.item_id,
                    status=ItemStatus.EXECUTION_FAILED,
                    verdict=VerdictType.UNCERTAIN,
                    score=0,
                    confidence=0.0,
                    severity=SeverityLevel.NONE,
                    confidence_score=0.0
                ))

        execution_time = time.time() - start_time

        return BlockReviewResult(
            block_id=rubric_block.block_id,
            block_name=rubric_block.block_name,
            results=results,
            execution_time_seconds=execution_time,
            error_log=errors
        )

    async def _evaluate_item(
        self,
        item: RubricItem,
        document_ir: DocumentIR,
        evidence_map: EvidenceMap,
        language: str = "en",
        rubric_name: str = ""
    ) -> RubricItemOutputSchema:
        """Evaluate a single rubric item using evidence retrieval system"""

        # Use evidence retriever
        evidence_spans, retrieval_trace = self.evidence_retriever.retrieve(
            item=item,
            document_ir=document_ir,
            evidence_map=evidence_map,
            mode="hybrid"
        )

        # Build context from evidence spans
        if evidence_spans:
            # Use top evidence spans
            context_parts = [span.quote for span in evidence_spans[:5]]
            context_text = "\n\n".join(context_parts)

            # Determine context quality based on retrieval method
            top_method = evidence_spans[0].method
            if top_method == "structure":
                context_quality = "exact"
                search_strategy = "exact_path"
            elif top_method == "semantic":
                context_quality = "fuzzy"
                search_strategy = "keyword_search"
            else:
                context_quality = "full_text"
                search_strategy = "full_text_scan"
        else:
            # Fallback to old method if retriever returns nothing
            context_text, context_quality, search_strategy = self._get_evidence_context(item, document_ir, evidence_map)

        # Build evaluation prompt
        prompt = self._build_evaluation_prompt(item, context_text, context_quality)

        # Call LLM with JSON response format
        lang_instruction = " Write all text fields (missing_detail, risk_reason, actionable_fix, what_would_change_verdict) in Chinese (中文)." if language == "zh" else ""

        # Build rubric-specific checklist (extracted to avoid nested triple quotes in f-string for Python 3.10 compat)
        if any(k in rubric_name.lower() for k in ["prisma_scr", "prisma_2020", "scoping", "systematic"]):
            checklist_text = (
                "以下问题是范围综述中常见的真实缺陷，你必须重点核查：\n\n"
                "1. PRISMA 流程图（Item 14）：\n"
                "   核查方式：在全文中搜索是否有\"Figure\"显示文献筛选流程，以及是否报告了\"初始检索数量\"、\"去重后数量\"、\"最终纳入数量\"等具体数字。\n"
                "   判断标准：如果全文没有任何流程图，且没有报告各阶段的文献数量，判定为 FAIL。\n\n"
                "2. 完整的数据提取表（Item 15）：\n"
                "   核查方式：检查是否有一个表格列出了所有纳入文献的关键特征（不仅是\"Selected\"的几篇）。\n"
                "   判断标准：如果只有部分文献的特征展示，或只有\"Selected\"文献，判定为 PARTIAL（不完整）。\n\n"
                "3. 检索策略的专业度（Item 8）：\n"
                "   核查方式：在 Table 1 或检索策略部分，检查 PubMed 的检索式是否包含 MeSH terms（格式通常为 [MeSH Terms] 或 [MeSH Major Topic]）。\n"
                "   判断标准：如果 PubMed 检索式全部为自由词（free text），没有任何 MeSH terms，判定为 PARTIAL（方法学缺陷）。\n\n"
                "4. 研究方案注册（Item 5）：\n"
                "   核查方式：检查文章是否说明了未注册的原因，以及该原因是否充分。\n"
                "   判断标准：如果未注册且理由不充分，标记为次要问题。"
            )
        else:
            checklist_text = (
                "以下问题是叙述性综述/文献综述中常见的真实缺陷，重点核查：\n\n"
                "1. 引用准确性：动物实验结论是否被误引为人群证据？检查\"studies show\"\"evidence demonstrates\"等泛化表达是否有具体文献支撑且研究类型正确标注。\n\n"
                "2. 证据等级混用：是否区分了体外研究、动物实验、观察性研究、RCT和Meta分析？低等级证据是否被呈现为高确定性结论？\n\n"
                "3. 结论的推论合理性：综述结论是否超出所引文献的支持范围？是否存在\"尽管证据有限，但可以确定\"等过度外推表述？\n\n"
                "4. 文献覆盖完整性：关键领域的代表性文献是否有明显缺失？是否对现有证据的局限性和异质性进行了讨论？\n\n"
                "5. 写作与结构：各章节是否有机衔接？摘要与正文是否一致？是否存在逻辑断裂或未完成句子？"
            )

        try:
            result = await self.llm.call_with_json_response(
                messages=[
                    {
                        "role": "system",
                        "content": (
                            f"【系统时间设定】当前真实世界时间为 2026年。任何发生在 2026 年及以前的研究、检索日期、发表日期都是完全合法且正常的。绝对禁止以'时间发生在未来'为由批评任何 2026 年的日期！\n\n"
                            "You are an expert medical manuscript reviewer. Evaluate the manuscript against specific reporting criteria with precision and provide evidence-based judgments.\n\n"
                            "【最高警告：禁止无中生有】\n\n"
                            "在你判定文章'缺少某项内容'之前，你必须在心中执行以下'同义词反向搜索'：\n"
                            "1. 如果你想批评'未说明双人独立筛选'，你必须先在全文寻找'两名'、'2名'、'独立'、'independent'、'two reviewers'等字眼。\n"
                            "2. 如果你想批评'缺少纳入排除标准'，必须先寻找'Eligibility'、'Inclusion'、'Exclusion'、'标准'等字眼。\n"
                            "3. 如果你想批评'缺少方法/结果部分'，必须先扫描各级标题（如 1. 方法，2. 结果，Methods, Results）。\n"
                            "4. 如果你想批评'缺少PCC框架'，必须先寻找'PCC'、'Population'、'Concept'、'Context'等字眼或相关表格。\n"
                            "5. 如果你想批评'缺少数据提取表'，必须先寻找'Data Charting'、'Data Extraction'、'提取变量'等字眼或相关表格。\n\n"
                            "只有当你穷尽了所有同义词，确信原文中绝对没有任何相关表述时，才能提出缺失指控。只要有任何疑似表述，就必须判定为'已提供'（即使格式不完美）。\n\n"
                            "【最高优先级：先读后判，禁止猜测式批评】\n\n"
                            "在对文章的任何部分做出批评之前，你必须先在原文中找到明确的证据，证明该内容\"确实不存在\"或\"确实不符合要求\"。\n\n"
                            "禁止行为：\n"
                            "- 禁止因为某个章节\"看起来不完整\"就判定它违反了规范\n"
                            "- 禁止因为文章\"没有使用你期望的格式\"就判定它缺少某内容\n"
                            "- 禁止在没有读到具体文字的情况下，判定文章\"未说明\"某事项\n\n"
                            "正确流程：\n"
                            "1. 先在原文中主动寻找该规范条目要求的内容（使用同义词反向搜索）\n"
                            "2. 如果找到了（即使格式不同），则判定为\"符合\"\n"
                            "3. 只有在原文中确实找不到任何对应内容时，才判定为\"不符合\"\n\n"
                            "【实质性缺失核查清单（根据当前审查规范选择适用项）】\n\n"
                            + checklist_text + lang_instruction
                        )
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                model_tier=ModelTier.STANDARD,
                temperature=0.0,
                max_tokens=2000
            )

            # Parse and validate response
            evaluation = result["parsed_json"]

            # Add retrieval trace information to the response
            response = self._parse_evaluation_response(item, evaluation, context_quality, search_strategy)

            return response

        except Exception as e:
            raise RuntimeError(f"LLM evaluation failed for {item.item_id}: {str(e)}")

    def _get_evidence_context(
        self,
        item: RubricItem,
        document_ir: DocumentIR,
        evidence_map: EvidenceMap
    ) -> tuple[str, str, str]:
        """Extract relevant text context for evaluation with three-tier fallback mechanism."""
        hint = item.evidence_location_hint
        context_parts = []
        context_quality = "exact"
        search_strategy = "exact_path"

        try:
            # TIER 1: Exact path matching
            if "." in hint:
                parts = hint.split(".")
                current = document_ir

                for part in parts:
                    if hasattr(current, part):
                        current = getattr(current, part)
                    else:
                        current = None
                        break

                if current is not None:
                    if hasattr(current, "text") and isinstance(current.text, list):
                        context_parts.extend(current.text)
                    elif isinstance(current, list):
                        context_parts.extend(current)

            else:
                if hasattr(document_ir, hint):
                    section = getattr(document_ir, hint)
                    if hasattr(section, "text") and isinstance(section.text, list):
                        context_parts.extend(section.text)

        except Exception:
            pass

        # TIER 2: Fuzzy matching if exact match failed
        if not context_parts or len("\n\n".join(context_parts)) < 100:
            fuzzy_results = self._fuzzy_match_section(hint, document_ir)
            if fuzzy_results:
                context_parts = fuzzy_results
                context_quality = "fuzzy"
                search_strategy = "keyword_search"

        # TIER 3: Full-text fallback
        if not context_parts or len("\n\n".join(context_parts)) < 100:
            full_text = self._extract_full_text(document_ir)
            if full_text:
                context_parts = [full_text]
                context_quality = "full_text"
                search_strategy = "full_text_scan"

        context = "\n\n".join(context_parts) if context_parts else "[No relevant text found in specified location]"

        if len(context) > 8000:
            context = context[:8000] + "... [truncated]"

        return context, context_quality, search_strategy

    def _build_synonym_map(self) -> dict:
        """Build a synonym mapping for common methodological terms."""
        return {
            "randomization": ["random assignment", "randomisation", "allocation", "randomized", "randomly assigned"],
            "participants": ["subjects", "patients", "individuals", "participants", "cases"],
            "blinding": ["masking", "concealment", "blinded", "masked"],
            "sample": ["sample size", "participants", "subjects", "cohort"],
            "intervention": ["treatment", "therapy", "procedure", "protocol"],
            "outcome": ["endpoint", "result", "measure", "assessment"],
            "statistical": ["analysis", "statistics", "statistical analysis", "statistical methods"],
            "ethics": ["ethical approval", "irb", "ethics committee", "institutional review"],
            "consent": ["informed consent", "consent form", "patient consent"],
            "funding": ["financial support", "grant", "sponsor", "financial disclosure"],
        }

    def _extract_keywords(self, location_hint: str) -> list[str]:
        """Extract keywords from location hint for fuzzy matching."""
        hint = location_hint.replace("methods.", "").replace("results.", "").replace("discussion.", "")
        hint = hint.replace("introduction.", "").replace("abstract.", "").replace("conclusion.", "")

        base_keyword = hint.lower().strip()
        keywords = [base_keyword]

        if base_keyword in self.synonym_map:
            keywords.extend(self.synonym_map[base_keyword])

        return keywords

    def _fuzzy_match_section(self, location_hint: str, document_ir: DocumentIR) -> list[str]:
        """Perform fuzzy matching to find relevant sections."""
        keywords = self._extract_keywords(location_hint)
        matched_paragraphs = []

        sections = []
        if hasattr(document_ir, 'abstract') and document_ir.abstract:
            sections.append(('abstract', document_ir.abstract))
        if hasattr(document_ir, 'introduction') and document_ir.introduction:
            sections.append(('introduction', document_ir.introduction))
        if hasattr(document_ir, 'methods') and document_ir.methods:
            sections.append(('methods', document_ir.methods))
        if hasattr(document_ir, 'results') and document_ir.results:
            sections.append(('results', document_ir.results))
        if hasattr(document_ir, 'discussion') and document_ir.discussion:
            sections.append(('discussion', document_ir.discussion))
        if hasattr(document_ir, 'conclusion') and document_ir.conclusion:
            sections.append(('conclusion', document_ir.conclusion))

        for section_name, section in sections:
            paragraphs = self._extract_section_text_list(section)
            for paragraph in paragraphs:
                paragraph_lower = paragraph.lower()
                if any(keyword in paragraph_lower for keyword in keywords):
                    matched_paragraphs.append(paragraph)

        return matched_paragraphs

    def _extract_section_text_list(self, section) -> list[str]:
        """Extract text from a section as a list of paragraphs."""
        paragraphs = []

        if section is None:
            return paragraphs

        if hasattr(section, 'text'):
            if isinstance(section.text, list):
                paragraphs.extend(section.text)
            elif isinstance(section.text, str):
                paragraphs.append(section.text)
        elif hasattr(section, 'full_text'):
            if hasattr(section.full_text, 'text'):
                if isinstance(section.full_text.text, list):
                    paragraphs.extend(section.full_text.text)
                elif isinstance(section.full_text.text, str):
                    paragraphs.append(section.full_text.text)
        elif isinstance(section, str):
            paragraphs.append(section)
        elif isinstance(section, list):
            paragraphs.extend(section)

        if hasattr(section, '__dict__'):
            for attr_name, attr_value in section.__dict__.items():
                if attr_name not in ['text', 'full_text'] and attr_value is not None:
                    if hasattr(attr_value, 'text'):
                        if isinstance(attr_value.text, list):
                            paragraphs.extend(attr_value.text)
                        elif isinstance(attr_value.text, str):
                            paragraphs.append(attr_value.text)

        return paragraphs

    def _extract_full_text(self, document_ir: DocumentIR, max_length: int = 8000) -> str:
        """Extract full text from document with priority-based truncation."""
        sections = []
        current_length = 0

        priority_order = [
            ("Abstract", document_ir.abstract if hasattr(document_ir, 'abstract') else None),
            ("Methods", document_ir.methods if hasattr(document_ir, 'methods') else None),
            ("Results", document_ir.results if hasattr(document_ir, 'results') else None),
            ("Discussion", document_ir.discussion if hasattr(document_ir, 'discussion') else None),
            ("Introduction", document_ir.introduction if hasattr(document_ir, 'introduction') else None),
            ("Conclusion", document_ir.conclusion if hasattr(document_ir, 'conclusion') else None),
        ]

        for section_name, section in priority_order:
            if section is None:
                continue

            section_paragraphs = self._extract_section_text_list(section)
            section_text = "\n\n".join(section_paragraphs)

            if not section_text:
                continue

            section_with_header = f"## {section_name}\n{section_text}"
            if current_length + len(section_with_header) <= max_length:
                sections.append(section_with_header)
                current_length += len(section_with_header)
            else:
                remaining = max_length - current_length
                if remaining > 100:
                    truncated = section_text[:remaining]
                    sections.append(f"## {section_name}\n{truncated}... [truncated]")
                break

        return "\n\n".join(sections) if sections else ""

    def _build_evaluation_prompt(self, item: RubricItem, evidence_context: str, context_quality: str) -> str:
        """Build prompt for evaluating a single rubric item with structured verdict"""

        if context_quality == "exact":
            context_header = "**RELEVANT MANUSCRIPT TEXT:**"
            context_note = "\n**CONTEXT QUALITY:** exact\nThe text above is extracted from the specified location in the manuscript.\n"
        elif context_quality == "fuzzy":
            context_header = "**RELEVANT MANUSCRIPT TEXT (Fuzzy Match):**"
            context_note = "\n**CONTEXT QUALITY:** fuzzy\nThe text above was found through keyword search.\n"
        else:
            context_header = "**FULL MANUSCRIPT TEXT:**"
            context_note = "\n**CONTEXT QUALITY:** full_text\nThe complete manuscript is provided above.\n"

        return f"""
Evaluate the following manuscript excerpt against a specific reporting criterion.

**CRITERION TO EVALUATE:**
- **Checklist:** {item.checklist_name}
- **Item {item.item_number}:** {item.question}
- **Evaluation Standard:** {item.evaluation_criteria}

{context_header}
{evidence_context}
{context_note}
**YOUR TASK:**
Evaluate whether the manuscript adequately addresses this criterion. Provide your assessment in JSON format:

{{
  "verdict": "<PASS|FAIL|PARTIAL|UNCERTAIN>",
  "confidence": <0.0 to 1.0>,
  "severity": "<CRITICAL|MAJOR|MINOR|NONE>",
  "evidence_quote": ["exact quote 1", "exact quote 2"],
  "evidence_location": ["location1", "location2"],
  "missing_detail": "specific missing information or null",
  "risk_reason": "why this matters or null",
  "actionable_fix": "concrete recommendation or null",
  "what_would_change_verdict": "what would make this PASS or null"
}}

**CRITICAL RULES:**
1. Use PARTIAL for content that exists but is insufficient or not fully compliant with standards; use FAIL for confirmed absence or severe deficiency
2. Always provide at least 1 evidence_quote and 1 evidence_location
3. Be precise: Quote exact phrases, don't paraphrase
4. If the manuscript satisfies this criterion FULLY, return PASS. If it partially satisfies (exists but incomplete/non-compliant), return PARTIAL with specific description of what is insufficient. Only return UNCERTAIN when you genuinely cannot determine from the available text.
5. Return FAIL when: (a) the required information is completely absent, or (b) what is present is so deficient it cannot be considered even partial compliance
6. Do NOT give PASS just because something is mentioned briefly — check if it meets the actual standard requirement
"""

    def _parse_evaluation_response(self, item: RubricItem, evaluation: dict, context_quality: str, search_strategy: str) -> RubricItemOutputSchema:
        """Parse LLM response into RubricItemOutputSchema with new verdict structure"""

        # Parse verdict
        verdict_str = evaluation.get("verdict", "UNCERTAIN")
        if isinstance(verdict_str, str):
            try:
                verdict = VerdictType[verdict_str.upper()]
            except KeyError:
                verdict = VerdictType.UNCERTAIN
        else:
            verdict = verdict_str

        # Map verdict to legacy score for backward compatibility
        verdict_to_score = {
            VerdictType.PASS: 2,
            VerdictType.PARTIAL: 1,
            VerdictType.FAIL: 0,
            VerdictType.UNCERTAIN: 0
        }
        score = verdict_to_score.get(verdict, 0)

        # Parse severity
        severity_str = evaluation.get("severity", "NONE")
        if isinstance(severity_str, str):
            try:
                severity = SeverityLevel[severity_str.upper()]
            except KeyError:
                severity = SeverityLevel.NONE
        else:
            severity = severity_str

        confidence = evaluation.get("confidence", evaluation.get("confidence_score", 0.5))

        evidence_quote = evaluation.get("evidence_quote", [])
        evidence_location = evaluation.get("evidence_location", [])

        if not evidence_quote:
            if verdict == VerdictType.UNCERTAIN:
                evidence_quote = ["[No clear evidence found in provided text]"]
            elif verdict == VerdictType.FAIL:
                evidence_quote = ["[Confirmed absence after thorough search]"]
            else:
                evidence_quote = ["[Evidence not properly extracted]"]

        if not evidence_location:
            evidence_location = [context_quality if context_quality else "unknown"]

        what_would_change_verdict = evaluation.get("what_would_change_verdict")

        return RubricItemOutputSchema(
            item_id=item.item_id,
            status=ItemStatus.COMPLETED,
            verdict=verdict,
            score=score,
            confidence=confidence,
            severity=severity,
            evidence_quote=evidence_quote,
            evidence_location=evidence_location,
            missing_detail=evaluation.get("missing_detail"),
            risk_reason=evaluation.get("risk_reason"),
            actionable_fix=evaluation.get("actionable_fix"),
            what_would_change_verdict=what_would_change_verdict,
            confidence_score=confidence,
            context_quality=context_quality,
            search_strategy=search_strategy
        )
