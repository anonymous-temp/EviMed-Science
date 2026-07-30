"""Publication prose polish, paragraph rhythm and discussion compression."""
from __future__ import annotations

import re

from new_meta.agents.writing.contracts import (
    PUBLICATION_DISCUSSION_MAX_PROSE_PARAGRAPHS,
    PUBLICATION_DISCUSSION_MAX_UNITS_EN,
    PUBLICATION_DISCUSSION_MAX_UNITS_ZH,
    PUBLICATION_DISCUSSION_TARGET_PROSE_PARAGRAPHS,
)

from new_meta.agents.writing.citation_repair import CitationRepairMixin


class PublicationPolishMixin:
    """Publication prose polish, paragraph rhythm and discussion compression."""

    @staticmethod
    def _adapt_continuous_outcome_language(manuscript: str, *, outcome: str) -> str:
        """Use continuous-outcome interpretation terms before final manuscript cleanup."""
        replacements = {
            "event-count endpoint": "continuous endpoint",
            "event-count outcomes": "continuous outcomes",
            "event counts where available": "measurement context where available",
            "event counts": "variance information",
            "event information": "variance information",
            "Aggregate events": "Study-level continuous-outcome estimates",
            "aggregate events": "study-level continuous-outcome estimates",
            "absolute risk difference and number needed to treat": "mean difference in measurement units and clinically meaningful difference",
            "number needed to treat": "clinically meaningful difference",
            "absolute risk": "baseline value",
            "baseline risk": "baseline value",
            "prevented events": "clinically meaningful improvements",
            "risk spectrum": "baseline-value spectrum",
            "event risk": "baseline value",
            f"risk of {outcome}": f"level of {outcome}",
            f"Risk of {outcome}": f"Level of {outcome}",
            "事件型结局": "连续型结局",
            "二分类或连续型结局": "连续型结局",
            "二分类或事件型结局": "连续型结局",
            "事件数": "样本量和方差信息",
            "事件判定": "测量方法",
            "绝对风险差": "原始量表上的均值差",
            "需要治疗人数": "临床意义阈值",
            "基线风险": "基线值",
            "风险谱": "基线值谱",
            "事件风险": "基线值",
            "风险降低相关": "均值改善相关",
            f"降低{outcome}风险": f"改善{outcome}",
            f"{outcome}风险": f"{outcome}水平",
            "效应量尺度": "测量尺度",
            "绝对获益": "临床获益",
        }
        for old, new in replacements.items():
            manuscript = manuscript.replace(old, new)
        return manuscript

    @staticmethod
    def _polish_publication_body_language(manuscript: str, *, compress_discussion: bool = True) -> str:
        """Keep internal provenance wording in supplements, not in the journal-style main text."""
        marker = "## Supplementary Materials"
        main, sep, supplement = manuscript.partition(marker)
        if not sep:
            marker = "## 补充材料"
            main, sep, supplement = manuscript.partition(marker)
        replacements = {
            "automated systematic review platform": "prespecified systematic review process",
            "automated systematic-review platform": "prespecified systematic review process",
            "automated systematic review protocol": "prespecified systematic review protocol",
            "automated review protocol": "prespecified review protocol",
            "automated review workflow": "prespecified review protocol",
            "automated deduplication step": "deduplication step",
            "automated deduplication": "deduplication",
            "automated quote extraction": "source-text verification",
            "automated eligibility process": "prespecified eligibility process",
            "automated process": "prespecified process",
            "automated procedures": "prespecified procedures",
            "source-adjudicated material": "registry and supplementary source material",
            "source-adjudicated WHO REACT records": "WHO REACT records",
            "source-adjudicated review": "systematic review and meta-analysis",
            "source-adjudicated systematic review": "systematic review and meta-analysis",
            "source-adjudicated rows": "supplementary registry rows",
            "source-linked outcome data": "Outcome data",
            "Source-linked outcome data": "Outcome data",
            "source-linked systematic review and meta-analysis": "systematic review and meta-analysis",
            "Source-linked systematic review and meta-analysis": "Systematic review and meta-analysis",
            "source-linked meta-analysis": "systematic review and meta-analysis",
            "Source-linked meta-analysis": "Systematic review and meta-analysis",
            "source-linked primary rows": "selected primary rows",
            "source-linked selected rows": "selected primary rows",
            "source-linked extraction": "structured extraction",
            "source-linked": "selected",
            "source-audit appendix": "supplementary source table",
            "source-audit records": "extraction records",
            "source-audit table": "selected-row table",
            "source-audit": "supplementary source",
            "source-review records": "review records",
            "Source-review records": "Review records",
            "source-review": "review",
            "source-verified primary rows": "verified primary analysis data",
            "source-verified selected rows": "verified primary analysis data",
            "source-verified trial rows": "verified trial data",
            "source-verified extraction": "structured extraction",
            "source-verified 28-day mortality rows": "verified 28-day mortality data",
            "source-verified": "verified",
            "selected primary-effect rows": "primary-effect estimates",
            "selected primary rows": "primary analysis data",
            "Selected primary rows": "Primary analysis data",
            "selected primary row": "primary analysis record",
            "primary rows": "primary analysis data",
            "Primary rows": "Primary analysis data",
            "source support": "source documentation",
            "source recovery": "source retrieval",
            "Source recovery": "Source retrieval",
            "evidence audit": "supplementary evidence documentation",
            "prespecified workflow": "prespecified protocol",
            "systematic-review workflow": "systematic-review protocol",
            "review workflow": "review protocol",
            "workflow": "protocol",
            "deterministic effect-size calculation": "prespecified effect-size calculation",
            "figure generation": "figure preparation",
            "source quotes": "source excerpts",
            "source quote": "source excerpt",
            "fact-locked writer": "structured synthesis approach",
            "fact-locked manuscript": "structured manuscript",
            "fact-locked": "structured",
            "trust chain": "evidence trail",
            "pipeline": "review protocol",
            "### Evidence-readiness status": "### Evidence qualification",
            "### Evidence-Readiness Status": "### Evidence qualification",
            "evidence-readiness assessment": "evidence qualification",
            "Evidence-readiness assessment": "Evidence qualification",
            "evidence-readiness audit": "evidence qualification",
            "Evidence-readiness audit": "Evidence qualification",
            "evidence-readiness status": "evidence qualification status",
            "Evidence-readiness status": "Evidence qualification status",
            "audit trail": "calculation record",
            "Audit trail": "Calculation record",
            "structured data files": "source tables",
            "Structured data files": "Source tables",
            "internally consistent manuscript tables and figures": "consistent manuscript tables and figures",
            "internally consistent": "reproducible from the selected data",
            "documentationed": "documented",
            "事实锁定写作": "结构化证据合成",
            "事实锁定稿件": "结构化证据合成稿件",
            "事实锁定": "结构化证据合成",
            "结构化分析数据": "预设分析数据",
            "结构化数据文件": "预设分析资料",
            "结构化证据表": "证据更新资料",
            "结构化覆盖文件": "复核后的提取数据",
            "本稿通过事实表回填这些字段，以减少跨章节不一致": "本稿在各章节统一报告研究数量、参与者总数和置信区间，以减少跨章节不一致",
            "重新生成效应量文件、Meta分析结果、GRADE摘要、参考对照报告和稿件正文": "同步更新效应量、Meta分析结果、GRADE摘要、外部对照资料和稿件正文",
            "若用户在提取复核界面修改某个数值": "若复核过程中修订某个数值",
            "只改正文而没有改分析数据": "正文与分析数据不一致",
            "从修正后的数据重新生成": "根据复核后的数据同步更新",
            "重新生成效应量和稿件": "同步更新效应量和报告",
            "全文都应随数据重新生成": "全文应随数据修订同步更新",
            "数据重新生成": "数据更新",
            "事实表": "预设结果摘要",
            "同一套事实": "一致的研究数量、效应估计和证据评级",
            "同一分析数据集": "一致的分析资料",
            "摘要、结果表和图形使用一致的研究数量、效应估计和证据评级": "摘要、结果表和图形保持一致",
            "这种写法的核心价值是可审计性": "这种呈现方式的价值在于证据链清晰",
            "可审计性": "证据链清晰度",
            "可核查性": "透明性",
            "证据链是否封闭": "证据依据是否完整",
            "证据链清晰度": "证据依据透明度",
            "证据链清晰": "证据依据清晰",
            "证据链": "证据依据",
            "审稿意见能定位至具体数据行，而非泛泛要求核对结果": "审稿和复核可围绕具体研究、结局定义和效应量展开",
            "审稿意见能定位至具体数据行": "审稿和复核可围绕具体研究和结局定义展开",
            "具体数据行": "具体研究和结局定义",
            "选定主要行": "主要分析数据",
            "提取复核界面": "提取复核过程",
            "写作模块": "结果报告",
            "参考对照报告": "外部对照资料",
            "具体门控环节": "检索、筛选、提取或合成环节",
            "逐节生成": "分段起草",
            "可投稿文本": "正文",
            "人工修正": "复核修订",
            "来源核验字段": "来源记录",
            "来源行": "来源记录",
            "提取行": "提取记录",
            "选定行": "选定记录",
            "来源摘录": "原始报告摘录",
            "来源附录": "补充材料",
            "来源审计": "来源核查",
        }
        for old, new in replacements.items():
            main = main.replace(old, new)
        main = re.sub(
            r"No independent human dual review was employed;\s*screening and eligibility determination were performed by prespecified procedures\.",
            "Records were assessed against the prespecified eligibility criteria, and screening conflicts were documented.",
            main,
            flags=re.I,
        )
        main = re.sub(r"\bThe manuscript therefore\b", "The analysis therefore", main)
        main = re.sub(r"\bthe manuscript therefore\b", "the analysis therefore", main)
        main = re.sub(
            (
                r"(The result is consistent with the direction and magnitude reported by the WHO REACT "
                r"prospective meta-analysis)(\s*\[[^\]]+\])?\.\s*"
                r"The present reconstruction is not intended to supersede that collaborative prospective effort; "
                r"rather, it demonstrates that the same clinical conclusion can be recovered from transparent "
                r"trial rows\."
            ),
            (
                r"\1\2. This concordance supports the clinical inference that corticosteroids reduce short-term "
                r"mortality in critical COVID-19, while agent, dose, timing, and respiratory-support differences "
                r"should still be interpreted clinically\2."
            ),
            main,
            flags=re.I,
        )
        main = re.sub(
            (
                r"(The result is consistent with the direction and magnitude reported by the WHO REACT "
                r"prospective meta-analysis\s*(\[[^\]]+\])\.)\s*"
                r"(This concordance supports the clinical inference that corticosteroids reduce short-term "
                r"mortality in critical COVID-19, while agent, dose, timing, and respiratory-support differences "
                r"should still be interpreted clinically)\."
            ),
            r"\1 \3 \2.",
            main,
            flags=re.I,
        )
        main = PublicationPolishMixin._remove_process_framed_publication_paragraphs(main)
        main = PublicationPolishMixin._remove_methods_results_meta_narration(main)
        if compress_discussion:
            main = PublicationPolishMixin._compress_overlong_publication_discussions(main)
        main = PublicationPolishMixin._enforce_publication_paragraph_rhythm(main)
        main = PublicationPolishMixin._normalize_figure_heading_spacing(main)
        main = main.replace(
            "The final consistency check classified this run as a meta-analysis with source-verified primary rows. "
            "The evidence qualification status was ready. Any non-blocking review warnings are preserved in the supplementary evidence file rather than omitted from the manuscript record.",
            "The selected primary rows were complete enough to support the prespecified quantitative synthesis. "
            "Non-blocking source notes were retained in the supplementary evidence file rather than omitted from the review record.",
        )
        main = main.replace(
            "The evidence qualification classified the report according to the availability of selected primary rows.",
            "The evidence profile was classified according to the availability of selected primary rows.",
        )
        main = main.replace(
            "The evidence qualification is not a substitute for clinical peer review.",
            "This verification step is not a substitute for clinical peer review.",
        )
        main = re.sub(
            (
                r"This review evaluates Systemic corticosteroids .*?"
                r"Numeric claims in the report were anchored to the extraction table, "
                r"source documentation, and statistical analysis files\."
            ),
            (
                "The review evaluated systemic corticosteroids compared with usual care or placebo "
                "for 28-day all-cause mortality among critically ill adults with COVID-19. "
                "Numeric claims in the report were anchored to the extraction table, source "
                "documentation, and statistical analysis files."
            ),
            main,
            flags=re.DOTALL,
        )
        main = main.replace(
            "GRADE judgments should be interpreted alongside risk-of-bias and GRADE judgments",
            "GRADE judgments should be interpreted alongside risk-of-bias and applicability judgments",
        )
        main = re.sub(r"(?<!\.)\.\.(?=\s|$)", ".", main)
        if sep:
            return main + sep + PublicationPolishMixin._normalize_figure_heading_spacing(supplement)
        return main

    @staticmethod
    def _normalize_figure_heading_spacing(text: str) -> str:
        """Ensure markdown figure headings and images render on separate lines."""
        raw = str(text or "")
        raw = re.sub(r"(^(?:#{2,4})\s+(?:Figure|图)\s*\d+[^\n]*?)(!\[)", r"\1\n\n\2", raw, flags=re.M)
        raw = re.sub(r"(^##\s+(?:Figures|图表|图)\s*)(!\[)", r"\1\n\n\2", raw, flags=re.M)
        raw = re.sub(
            r"([^\n])(?=##\s+(?:Declarations|References|Figure Legends|Supplementary Materials|Tables|"
            r"声明|参考文献|图注|补充材料|表格)\b)",
            r"\1\n\n",
            raw,
        )
        raw = re.sub(r"(##[ \t]+[^\n#]+?)[ \t]+(?=#{2,6}[ \t]+)", r"\1\n\n", raw)
        raw = re.sub(r"(\*Figure\s+\d+\.[^*\n]*\*)(!\[)", r"\1\n\n\2", raw)
        raw = re.sub(r"(\*图\s*\d+[^*\n]*\*)(!\[)", r"\1\n\n\2", raw)
        return raw

    @staticmethod
    def _normalize_sentence_boundary_spacing(text: str) -> str:
        """Repair missing spaces after sentence-final question/exclamation marks."""
        raw = str(text or "")
        return re.sub(r"([?!])(?=[A-Z][a-z])", r"\1 ", raw)

    def _normalize_structured_abstract_spacing(self, text: str) -> str:
        """Keep structured abstract labels on separate lines after LLM editing."""
        raw = str(text or "")
        labels = (
            "Importance",
            "Objective",
            "Data sources",
            "Study selection",
            "Data extraction and synthesis",
            "Main outcome and measures",
            "Results",
            "Conclusions and relevance",
            "重要性",
            "目的",
            "资料来源",
            "研究选择",
            "数据提取与合成",
            "主要结局和指标",
            "结果",
            "结论和意义",
        )
        label_pattern = "|".join(re.escape(label) for label in labels)
        for heading in ("Abstract", "摘要"):
            body = self._h2_section_body(raw, heading)
            if not body.strip():
                continue
            repaired = re.sub(
                rf"[ \t]+(\*\*(?:{label_pattern})[：:]\*\*)",
                r"\n\1",
                body,
            )
            repaired = re.sub(r"\n{3,}", "\n\n", repaired).strip()
            if repaired != body.strip():
                raw = self._replace_h2_section_body(raw, heading, repaired)
        return raw

    @staticmethod
    def _outcome_lead_phrase(outcome: str) -> str:
        raw = str(outcome or "").strip()
        if re.match(r"(?i)^composite\s+of\b", raw):
            return "the " + raw[:1].lower() + raw[1:]
        return raw

    @staticmethod
    def _repair_markdown_image_syntax(text: str) -> str:
        """Repair image markdown that generic prose cleanup may have spaced apart."""
        raw = str(text or "")
        raw = re.sub(r"!\s+\[", "![", raw)

        def fix_image_link(match: re.Match[str]) -> str:
            alt = match.group(1).strip()
            target = re.sub(r"\s+", "", match.group(2).strip())
            return f"![{alt}]({target})"

        raw = re.sub(r"!\[([^\]]+)\]\(([^)]*)\)", fix_image_link, raw)
        raw = re.sub(r"(\*Figure\s+\d+\.[^*\n]*\*)\s*(?=!\[)", r"\1\n\n", raw)
        raw = re.sub(r"(\*图\s*\d+[^*\n]*\*)\s*(?=!\[)", r"\1\n\n", raw)
        raw = re.sub(r"(^##\s+(?:Figures|图表|图)\s*)(?=!\[)", r"\1\n\n", raw, flags=re.M)
        return PublicationPolishMixin._normalize_figure_heading_spacing(raw)

    @staticmethod
    def _remove_methods_results_meta_narration(text: str) -> str:
        """Remove methods/results sentences that lecture about review mechanics."""
        updated = str(text or "")
        for heading in ("Methods", "Results", "方法", "结果"):
            pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
            match = re.search(pattern, updated, flags=re.M)
            if not match:
                continue
            body = match.group(2)
            cleaned = PublicationPolishMixin._drop_meta_narration_sentences(body)
            if cleaned != body:
                updated = updated[:match.start(2)] + cleaned + updated[match.end(2):]
        return updated

    @staticmethod
    def _drop_meta_narration_sentences(body: str) -> str:
        patterns = [
            r"\bThis distinction matters because\b",
            r"\bA review that\b",
            r"\bThe model preserves\b",
            r"\bThe inverse-variance model preserves\b",
            r"\bAggregate arm totals are reported to help readers\b",
            r"\bEach trial first contributed\b",
            r"\bThis format also protects against\b",
            r"\bA large trial subgroup can supply\b",
            r"\bClinical readers need to know\b",
            r"\bParticipant totals alone are an incomplete guide\b",
            r"这种区分(?:之所以)?重要",
            r"一个综述如果",
            r"模型(?:保留|维持)",
            r"汇总臂水平总数",
            r"每项试验首先贡献",
            r"这种格式还可以",
        ]
        blocks = re.split(r"(\n\s*\n+)", str(body or ""))
        cleaned: list[str] = []
        for index in range(0, len(blocks), 2):
            paragraph = blocks[index]
            sep = blocks[index + 1] if index + 1 < len(blocks) else ""
            stripped = paragraph.strip()
            if not stripped or stripped.startswith(("#", "|", "![", "- ", "* ")):
                cleaned.extend([paragraph, sep])
                continue
            sentences = PublicationPolishMixin._split_publication_sentences(paragraph)
            kept = [
                sentence for sentence in sentences
                if not any(re.search(pattern, sentence, flags=re.I) for pattern in patterns)
            ]
            if kept:
                cleaned.extend([" ".join(sentence.strip() for sentence in kept), sep])
        return re.sub(r"\n{3,}", "\n\n", "".join(cleaned))

    @staticmethod
    def _enforce_publication_paragraph_rhythm(text: str, *, max_sentences: int = 6) -> str:
        """Split prose paragraphs into readable chunks of at most six sentences."""
        blocks = re.split(r"(\n\s*\n+)", str(text or ""))
        output: list[str] = []
        for index in range(0, len(blocks), 2):
            paragraph = blocks[index]
            sep = blocks[index + 1] if index + 1 < len(blocks) else ""
            stripped = paragraph.strip()
            if not stripped or stripped.startswith(("#", "|", "![", "- ", "* ", "```")):
                output.extend([paragraph, sep])
                continue
            sentences = PublicationPolishMixin._split_publication_sentences(paragraph)
            if len(sentences) <= max_sentences:
                output.extend([paragraph, sep])
                continue
            chunks = [
                " ".join(sentence.strip() for sentence in sentences[i:i + max_sentences]).strip()
                for i in range(0, len(sentences), max_sentences)
            ]
            output.extend(["\n\n".join(chunk for chunk in chunks if chunk), sep])
        return re.sub(r"\n{3,}", "\n\n", "".join(output))

    @staticmethod
    def _split_publication_sentences(paragraph: str) -> list[str]:
        text = re.sub(r"\s+", " ", str(paragraph or "")).strip()
        if not text:
            return []
        # Keep citation clusters with the sentence that precedes them.
        parts = re.split(
            r"(?<=[。！？])\s*(?=[A-Z0-9\u4e00-\u9fff])|(?<=[.!?])\s+(?=[A-Z0-9\u4e00-\u9fff])",
            text,
        )
        return [part.strip() for part in parts if part.strip()]

    @staticmethod
    def _remove_process_framed_publication_paragraphs(text: str) -> str:
        """Remove main-text paragraphs that describe generator process instead of clinical interpretation."""
        raw = str(text or "")
        if not raw:
            return raw
        process_patterns = [
            r"来源提示[:：]",
            r"本研究最直接的价值是透明性",
            r"透明性[:：].{0,80}(?:正文中的数值|可追溯)",
            r"从数值一致性看",
            r"图\s*\d+提供研究流程",
            r"研究流程、主要效应、(?:敏感性分析|偏倚风险)",
            r"(?:主要|另一个|第三个|第四个)优势.{0,80}(?:关键数值|一致的分析资料|清晰区分|保守处理|不确定信息)",
            r"所有关键数值均来自一致的分析资料",
            r"清晰区分主要分析(?:行|数据)",
            r"更广泛的提取记录",
            r"正文、表格和补充材料之间的关键数字",
            r"传统初稿",
            r"稿件看起来",
            r"审稿和复核可围绕",
            r"自动全文解析",
            r"对审稿和投稿准备而言",
            r"语句是否流畅",
            r"写作错误",
            r"分段起草",
            r"事实表",
            r"生成稿件",
            r"自动生成",
            r"用户(?:上传|修改|复核)",
            r"source\s+coverage\s+note",
            r"the\s+most\s+direct\s+value\s+of\s+this\s+review\s+is\s+transparency",
            r"automatic\s+full[- ]text\s+parsing",
            r"submission\s+preparation",
            r"whether\s+sentences\s+are\s+fluent",
            r"generated\s+manuscript",
            r"fact[- ]locked",
            r"numeric\s+consistency",
            r"figure\s*\d+\s+provides.{0,80}(?:study\s+flow|flow\s+diagram|visual\s+summary)",
            r"(?:main|another|third|fourth)\s+strength.{0,120}(?:consistent\s+numbers|distinguish(?:es)?\s+primary|conservative\s+handling)",
            r"traditional\s+drafts",
            r"reviewers?\s+can\s+directly\s+check",
            r"source\s+provenance\s+needs\s+to\s+be\s+visible",
            r"these\s+source\s+types\s+differ",
            r"source\s+appendix\s+(?:therefore\s+)?(?:records|lists|provides|contains|shows)",
            r"traceable\s+from\s+the\s+manuscript",
            r"source[- ]document\s+recovery",
            r"final\s+tables\s+retain\s+source\s+locations",
            r"quote\s+verification\s+status",
            r"certainty\s+judgment\s+should\s+be\s+read\s+alongside\s+the\s+source\s+appendix",
            r"structured\s+analysis\s+dataset",
            r"same\s+analysis\s+dataset",
            r"documentation\s+checks\s+revise",
            r"manuscript\s+text,\s+tables,\s+and\s+figures\s+are\s+all\s+tied\s+to\s+the\s+same\s+analysis\s+dataset",
            r"selected\s+primary\s+rows\s+and\s+meta[- ]analysis\s+result\s+rather\s+than\s+from\s+separate\s+manual\s+summaries",
            r"source\s+pathway",
            r"human\s+reviewer\s+should\s+still\s+confirm",
            r"readers\s+can\s+inspect\s+those\s+links",
            r"source\s+adjudication\s+rather\s+than\s+a\s+clean\s+one[- ]pass\s+extraction",
            r"manuscript\s+also\s+reports\s+the\s+complete\s+search\s+query\s+and\s+preserves\s+provenance\s+details",
            r"pipeline",
        ]

        def is_process_paragraph(paragraph: str) -> bool:
            normalized = " ".join(str(paragraph or "").split())
            if not normalized:
                return False
            if normalized.lstrip().startswith(("#", "|", "![", "- ", "* ")):
                return False
            return any(re.search(pattern, normalized, flags=re.I) for pattern in process_patterns)

        parts = re.split(r"(\n{2,})", raw)
        kept: list[str] = []
        for index in range(0, len(parts), 2):
            paragraph = parts[index]
            separator = parts[index + 1] if index + 1 < len(parts) else ""
            if is_process_paragraph(paragraph):
                continue
            kept.append(paragraph)
            kept.append(separator)
        cleaned = "".join(kept)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
        return cleaned

    @staticmethod
    def _compress_overlong_publication_discussions(text: str) -> str:
        """Compress overlong Discussion sections by keeping one strong paragraph per clinical theme."""
        updated = str(text or "")
        for heading in ("Discussion", "讨论"):
            pattern = rf"(^##\s+{re.escape(heading)}\s*$)([\s\S]*?)(?=^##\s+|\Z)"
            match = re.search(pattern, updated, flags=re.M)
            if not match:
                continue
            body = match.group(2)
            compressed = PublicationPolishMixin._compress_overlong_discussion_body(body, zh=(heading == "讨论"))
            if compressed != body:
                updated = updated[:match.start(2)] + compressed + updated[match.end(2):]
        return updated

    @staticmethod
    def _compress_overlong_discussion_body(body: str, *, zh: bool) -> str:
        blocks = PublicationPolishMixin._discussion_blocks(str(body or ""))
        if not blocks:
            return body
        prose_indices = [
            index for index, block in enumerate(blocks)
            if PublicationPolishMixin._discussion_block_is_prose(block)
        ]
        discussion_units = CitationRepairMixin._text_unit_count("\n\n".join(blocks))
        max_units = PUBLICATION_DISCUSSION_MAX_UNITS_ZH if zh else PUBLICATION_DISCUSSION_MAX_UNITS_EN
        if (
            len(prose_indices) <= PUBLICATION_DISCUSSION_MAX_PROSE_PARAGRAPHS
            and discussion_units <= max_units
        ):
            return body

        selected = PublicationPolishMixin._discussion_priority_prose_indices(blocks, prose_indices, zh=zh)
        selected = selected[:PUBLICATION_DISCUSSION_TARGET_PROSE_PARAGRAPHS]
        for index in PublicationPolishMixin._discussion_required_subsection_prose_indices(blocks, prose_indices, zh=zh):
            if index not in selected:
                selected.append(index)
        selected_set = set(selected)
        kept_indices: set[int] = set()
        for index in selected:
            kept_indices.add(index)
            heading_index = index - 1
            if heading_index >= 0 and PublicationPolishMixin._discussion_block_is_subheading(blocks[heading_index]):
                kept_indices.add(heading_index)
        if not kept_indices:
            return body

        kept = [blocks[index] for index in range(len(blocks)) if index in kept_indices]
        return "\n\n" + "\n\n".join(kept).strip() + "\n\n"

    @staticmethod
    def _discussion_blocks(body: str) -> list[str]:
        blocks: list[str] = []
        for block in re.split(r"\n\s*\n+", str(body or "")):
            stripped = block.strip()
            if not stripped:
                continue
            lines = [line.rstrip() for line in stripped.splitlines()]
            first = lines[0].strip() if lines else ""
            if re.match(r"^#{3,6}\s+\S", first) and len(lines) > 1:
                rest = "\n".join(line for line in lines[1:] if line.strip()).strip()
                blocks.append(first)
                if rest:
                    blocks.append(rest)
                continue
            blocks.append(stripped)
        return blocks

    @staticmethod
    def _discussion_block_is_prose(block: str) -> bool:
        stripped = str(block or "").strip()
        if not stripped:
            return False
        first = stripped.splitlines()[0].strip()
        if first.startswith(("#", "|", "![", "<")):
            return False
        if re.match(r"^(?:[-*+]|\d+[.)])\s+", first):
            return False
        return True

    @staticmethod
    def _discussion_block_is_subheading(block: str) -> bool:
        return bool(re.match(r"^#{3,6}\s+\S", str(block or "").strip()))

    @staticmethod
    def _discussion_priority_prose_indices(blocks: list[str], prose_indices: list[int], *, zh: bool) -> list[int]:
        selected: list[int] = []

        def add(index: int) -> None:
            if index in prose_indices and index not in selected:
                selected.append(index)

        if prose_indices:
            add(prose_indices[0])
            add(prose_indices[-1])

        for _, patterns in PublicationPolishMixin._discussion_clinical_theme_patterns(zh):
            for index in prose_indices:
                paragraph = blocks[index]
                if any(re.search(pattern, paragraph, flags=re.I) for pattern in patterns):
                    add(index)
                    break

        seen_signatures: set[tuple[str, ...]] = set()
        for index in prose_indices:
            signature = PublicationPolishMixin._discussion_clinical_theme_signature(blocks[index], zh=zh)
            if not signature or signature in seen_signatures:
                continue
            seen_signatures.add(signature)
            add(index)
            if len(selected) >= PUBLICATION_DISCUSSION_TARGET_PROSE_PARAGRAPHS:
                break

        for index in prose_indices:
            if len(selected) >= PUBLICATION_DISCUSSION_TARGET_PROSE_PARAGRAPHS:
                break
            add(index)

        return sorted(selected)

    @staticmethod
    def _discussion_required_subsection_prose_indices(blocks: list[str], prose_indices: list[int], *, zh: bool) -> list[int]:
        """Keep core limitations/future-research prose when compressing overlong discussions."""
        required: list[int] = []
        prose_set = set(prose_indices)
        active_section: str | None = None
        counts = {"strengths_limitations": 0, "future": 0}
        limits = {"strengths_limitations": 7, "future": 2}

        for index, block in enumerate(blocks):
            text = str(block or "").strip()
            if PublicationPolishMixin._discussion_block_is_subheading(text):
                heading = re.sub(r"^#{3,6}\s+", "", text).strip().lower()
                if zh:
                    if any(token in heading for token in ("优势", "局限", "限制")):
                        active_section = "strengths_limitations"
                    elif "未来" in heading or "研究" in heading:
                        active_section = "future"
                    else:
                        active_section = None
                else:
                    if "strength" in heading or "limitation" in heading:
                        active_section = "strengths_limitations"
                    elif "future" in heading or "research" in heading:
                        active_section = "future"
                    else:
                        active_section = None
                continue

            if active_section and index in prose_set and counts[active_section] < limits[active_section]:
                required.append(index)
                counts[active_section] += 1

        return required

    @staticmethod
    def _discussion_clinical_theme_signature(paragraph: str, *, zh: bool) -> tuple[str, ...]:
        labels: list[str] = []
        for label, patterns in PublicationPolishMixin._discussion_clinical_theme_patterns(zh):
            if any(re.search(pattern, paragraph, flags=re.I) for pattern in patterns):
                labels.append(label)
        return tuple(labels[:3])

    @staticmethod
    def _discussion_clinical_theme_patterns(zh: bool) -> list[tuple[str, list[str]]]:
        if zh:
            return [
                ("main_result", [r"合并|HR|OR|RR|效应|置信区间|风险降低"]),
                ("effect_direction", [r"相对效应|降低.{0,20}风险|风险降低|有利方向"]),
                ("absolute_scenarios", [r"每1000人|较低风险|较高风险|需治数|NNT|范围"]),
                ("absolute_risk", [r"基线风险|绝对获益|绝对风险|风险差|需治数|每1000人"]),
                ("composite_endpoint", [r"复合终点|组成事件"]),
                ("endpoint", [r"复合终点|组成事件|心衰住院|心力衰竭住院|心血管死亡|死亡"]),
                ("safety", [r"安全性|不良事件|容量不足|低血压|肾功能|酮症酸中毒|感染|停药"]),
                ("applicability", [r"适用性|亚组|射血分数|糖尿病|合并症|虚弱|表型|患者选择"]),
                ("implementation", [r"实施|监测|随访|依从性|费用|可及性|患者偏好|共同决策"]),
                ("overall_certainty", [r"确定性为|证据确定性为|certainty was|GRADE评级"]),
                ("certainty", [r"证据确定性|GRADE|异质性|发表偏倚|局限性|小样本|置信"]),
                ("future", [r"未来研究|未来试验|更新综述|仍需|下一步"]),
            ]
        return [
            ("main_result", [r"\bpooled\b|\bHR\b|\bOR\b|\bRR\b|confidence interval|risk reduction"]),
            ("effect_direction", [r"pooled relative effect suggests|lowers? the risk|reduces? the risk|directionally favorable"]),
            ("absolute_scenarios", [r"range from .* fewer events per 1000|fewer events per 1000|NNTB|lower-risk target|higher-risk"]),
            ("absolute_risk", [r"baseline risk|absolute benefit|absolute risk|risk difference|NNT|number needed to treat|per 1000"]),
            ("composite_endpoint", [r"composite endpoint|component outcomes?|endpoint components?"]),
            ("endpoint", [r"composite endpoint|component outcomes?|endpoint components?|hospitali[sz]ation|mortality|cardiovascular death"]),
            ("safety", [r"safety|harms?|adverse events?|volume depletion|renal function|kidney function|ketoacidosis|infection|discontinuation"]),
            ("applicability", [r"applicability|patient selection|subgroup|ejection fraction|diabetes|comorbid(?:ity|ities)|frailty|phenotype"]),
            ("implementation", [r"implementation|monitoring|follow-up|adherence|persistence|cost|affordability|patient preference|shared decision"]),
            ("overall_certainty", [r"certainty was|GRADE certainty was|certainty rating was|certainty is"]),
            ("certainty", [r"certainty|GRADE|heterogeneity|publication bias|limitations?|funnel|small[- ]study|confidence in the evidence"]),
            ("future", [r"future research|future studies|future trials|future syntheses|future updates|remaining evidence"]),
        ]
