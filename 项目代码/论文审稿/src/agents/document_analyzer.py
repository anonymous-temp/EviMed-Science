"""
Document Analyzer Agent - Enhanced with Coverage Meter and deterministic parsing

This agent converts raw manuscript text into structured DocumentIR.
Key improvements in Plan-Retrieve-Argue architecture:

1. Deterministic Markdown parsing for section identification
2. LLM only for metadata extraction (study types, outcomes, etc.)
3. Coverage Meter tracking what was successfully parsed
4. Better table and figure extraction from Markdown
"""

import re
from typing import Tuple, Dict, Any, List, Optional

from ..schemas.document_ir import (
    DocumentIR, StudyProfile, EvidenceMap,
    SectionText, MethodsSection, ResultsSection, DiscussionSection,
    TableData, FigureData,
    RECOGNIZED_STUDY_TYPES
)
from ..schemas.plan_retrieve_argue import (
    CoverageSummary, ParsedSection, ParsedTable, ParsedFigure
)
from ..services.llm_gateway import LLMGateway, ModelTier


class DocumentAnalyzerAgent:
    """
    Agent responsible for converting raw manuscript text into structured DocumentIR.

    Architecture:
    1. Deterministic parsing (Python-based) for sections and structure
    2. LLM-assisted metadata extraction (minimal tokens)
    3. Coverage tracking for downstream Evidence Gate
    """

    # Standard section names to look for
    STANDARD_SECTIONS = [
        "abstract", "introduction", "background", "methods", "methodology",
        "materials and methods", "results", "findings", "discussion",
        "conclusion", "conclusions", "references", "acknowledgements",
        "supplementary", "appendix"
    ]

    # Section aliases mapping
    SECTION_ALIASES = {
        "background": "introduction",
        "methodology": "methods",
        "materials and methods": "methods",
        "findings": "results",
        "conclusions": "conclusion",
    }

    def __init__(self, llm_gateway: LLMGateway):
        self.llm = llm_gateway

    async def analyze(self, manuscript_text: str, parse_metadata: Optional[Dict] = None
    ) -> Tuple[DocumentIR, StudyProfile, EvidenceMap, CoverageSummary]:
        """
        Perform hybrid analysis of manuscript.

        Args:
            manuscript_text: Raw text extracted from manuscript file (Markdown preferred)
            parse_metadata: Optional metadata from document parser

        Returns:
            Tuple of (DocumentIR, StudyProfile, EvidenceMap, CoverageSummary)
        """
        # Phase 1: Deterministic section parsing
        sections_text, section_info = self._parse_sections_deterministic(manuscript_text)

        # Phase 2: Extract tables and figures from Markdown
        tables = self._extract_tables_from_markdown(manuscript_text)
        figures = self._extract_figures_from_markdown(manuscript_text)

        # Phase 3: LLM-assisted metadata extraction (minimal tokens)
        analysis = await self._extract_metadata_with_llm(manuscript_text, sections_text)

        # Phase 4: Build structured outputs
        document_ir = self._build_document_ir(sections_text, analysis, tables, figures, manuscript_text)
        document_ir.language = self._detect_language(manuscript_text)

        # Phase 4b: Deterministic section detection (anti-hallucination hardening)
        confirmed_sections = self._detect_confirmed_sections(manuscript_text)
        document_ir.extracted_info['confirmed_sections'] = confirmed_sections

        study_profile = self._build_study_profile(analysis)
        evidence_map = self._build_evidence_map(document_ir, manuscript_text)

        # Phase 5: Build coverage summary
        coverage_summary = self._build_coverage_summary(
            sections_text, section_info, tables, figures, parse_metadata
        )

        return document_ir, study_profile, evidence_map, coverage_summary

    @staticmethod
    def _detect_confirmed_sections(text: str) -> dict:
        """
        确定性正则检测学术论文标准章节的存在性。
        不依赖 LLM，直接扫描原始文本中的章节标题。
        返回 {section_name: {"exists": bool, "preview": str}} 字典。
        用于注入 prompt 防止下游 agent 幻觉声称某章节缺失。
        """
        import re as _re

        # (内部key, 显示名, 正则模式列表)
        SECTION_RULES = [
            ("abstract", "摘要(Abstract)", [
                r'(?im)^#{0,3}\s*abstract\s*$',
                r'(?:^|\n)\s*abstract\s*\n',
            ]),
            ("introduction", "引言(Introduction)", [
                r'(?im)^#{0,3}\s*\d*\.?\s*introduction\s*$',
                r'(?:^|\n)\s*introduction\s*\n',
            ]),
            ("methods", "方法(Methods)", [
                r'(?im)^#{0,3}\s*\d*\.?\s*(?:methods?|methodology|materials?\s+and\s+methods?)\s*$',
                r'(?:^|\n)\s*\d*\.?\s*(?:methods?|methodology|materials?\s+and\s+methods?)\s*\n',
            ]),
            ("results", "结果(Results)", [
                r'(?im)^#{0,3}\s*\d*\.?\s*results?\s*$',
                r'(?:^|\n)\s*\d*\.?\s*results?\s*\n',
            ]),
            ("discussion", "讨论(Discussion)", [
                r'(?im)^#{0,3}\s*\d*\.?\s*discussion\s*$',
                r'(?:^|\n)\s*\d*\.?\s*discussion\s*\n',
            ]),
            ("conclusion", "结论(Conclusion/Conclusions)", [
                r'(?im)^#{0,3}\s*\d*\.?\s*conclusions?\s*$',
                r'(?:^|\n)\s*\d*\.?\s*conclusions?\s*\n',
            ]),
            ("coi", "利益冲突声明(Conflict of Interest)", [
                r'(?im)conflict\s+of\s+interest',
                r'(?im)competing\s+interest',
                r'(?im)利益冲突',
            ]),
            ("funding", "资金来源(Funding)", [
                r'(?im)^#{0,3}\s*funding\s*$',
                r'(?:^|\n)\s*funding\s*\n',
                r'(?im)funding\s+(?:source|statement)',
                r'(?im)资金来源|资助',
            ]),
            ("author_contributions", "作者贡献(Author Contributions)", [
                r'(?im)author\s+contributions?',
                r'(?im)作者贡献',
            ]),
            ("ethics", "伦理声明(Ethics)", [
                r'(?im)ethics\s+(?:approval|statement|committee)',
                r'(?im)institutional\s+review\s+board',
                r'(?im)informed\s+consent',
                r'(?im)伦理\s*(?:声明|审查|委员会)|知情同意',
            ]),
            ("data_availability", "数据可用性声明(Data Availability)", [
                r'(?im)data\s+(?:availability|sharing|access)',
                r'(?im)data\s+will\s+be\s+(?:made\s+)?available',
                r'(?im)数据可用|数据共享',
            ]),
            ("acknowledgements", "致谢(Acknowledgements)", [
                r'(?im)acknowledgement?s?\s*$',
                r'(?im)致谢',
            ]),
            ("references", "参考文献(References)", [
                r'(?im)^#{0,3}\s*references?\s*$',
                r'(?:^|\n)\s*references?\s*\n',
            ]),
        ]

        result = {}
        for key, display_name, patterns in SECTION_RULES:
            found = False
            preview = ""
            for pattern in patterns:
                match = _re.search(pattern, text)
                if match:
                    found = True
                    # 提取标题后的内容预览（跳过标题行本身）
                    after = text[match.end():match.end() + 300].strip()
                    # 取到第一个换行或句号
                    lines = after.split('\n', 2)
                    content_line = ""
                    for line in lines:
                        stripped = line.strip()
                        if stripped and not _re.match(r'^#{0,3}\s*\d', stripped):
                            content_line = stripped
                            break
                    preview = content_line[:150] if content_line else ""
                    break
            result[key] = {"exists": found, "preview": preview, "display_name": display_name}

        # 打印检测摘要
        exist_list = [k for k, v in result.items() if v["exists"]]
        print(f"  → [章节检测] 确认存在: {', '.join(exist_list)}")

        return result

    def _parse_sections_deterministic(self, text: str) -> Tuple[Dict[str, str], Dict[str, Dict]]:
        """
        Parse sections using deterministic rules.

        Strategy:
        1. Look for Markdown headings (# or ##)
        2. Look for keyword-based section markers
        3. Build section spans

        Returns:
            Tuple of (sections_text dict, section_info dict)
        """
        sections_text = {
            "title": "",
            "abstract": "",
            "introduction": "",
            "methods": "",
            "results": "",
            "discussion": "",
            "conclusion": "",
            "references": ""
        }
        section_info = {}

        # Strategy 1: Parse Markdown headings
        heading_pattern = r'^(#{1,3})\s+(.+)$'

        # Find all headings and their positions
        headings = []
        for match in re.finditer(heading_pattern, text, re.MULTILINE):
            level = len(match.group(1))
            title = match.group(2).strip()
            start = match.end()
            headings.append({
                "level": level,
                "title": title,
                "title_lower": title.lower(),
                "start": start
            })

        # Identify sections based on heading titles
        for i, heading in enumerate(headings):
            # Find end position (start of next heading or end of text)
            end = headings[i + 1]["start"] - len(headings[i + 1]["title"]) - headings[i + 1]["level"] - 2 if i + 1 < len(headings) else len(text)
            section_text = text[heading["start"]:end].strip()

            # Match heading to standard section
            section_name = self._match_section_name(heading["title_lower"])
            if section_name and section_name in sections_text:
                # Append if section already has content (e.g., multiple subsections)
                if sections_text[section_name]:
                    sections_text[section_name] += "\n\n" + section_text
                else:
                    sections_text[section_name] = section_text

                section_info[section_name] = {
                    "found": True,
                    "heading": heading["title"],
                    "char_count": len(section_text)
                }
            elif section_name is None and section_text:
                # 未识别的章节（综述类论文的主题章节，如"Mechanisms of..."）
                # 跳过参考文献/声明类章节
                _t = heading["title_lower"]
                _skip_titles = ['reference', 'acknowledgement', 'appendix',
                                'supplement', 'author', 'conflict', 'funding',
                                'declaration', 'abbreviation', 'figure', 'table']
                if not any(k in _t for k in _skip_titles):
                    # 综述正文内容：优先归入 introduction（全文正文），不够则归入 discussion
                    if sections_text["introduction"]:
                        sections_text["introduction"] += f"\n\n[{heading['title']}]\n" + section_text
                    else:
                        sections_text["discussion"] += (
                            (f"\n\n[{heading['title']}]\n" + section_text)
                            if sections_text["discussion"]
                            else (f"[{heading['title']}]\n" + section_text)
                        )

        # Strategy 2: Fallback to keyword-based parsing if Markdown parsing found little
        total_parsed = sum(len(v) for v in sections_text.values())
        if total_parsed < len(text) * 0.3:  # Less than 30% coverage
            sections_text, section_info = self._parse_sections_keyword_fallback(text, sections_text, section_info)

        # Extract title from beginning of text if not found
        if not sections_text["title"]:
            sections_text["title"] = self._extract_title(text)

        return sections_text, section_info

    def _match_section_name(self, heading_lower: str) -> Optional[str]:
        """Match a heading to a standard section name"""
        # Direct match
        for section in self.STANDARD_SECTIONS:
            if section in heading_lower:
                # Apply aliases
                return self.SECTION_ALIASES.get(section, section)

        # Fuzzy match for common variations
        if any(kw in heading_lower for kw in ["method", "material", "procedure"]):
            return "methods"
        if any(kw in heading_lower for kw in ["result", "finding", "outcome"]):
            return "results"
        if any(kw in heading_lower for kw in ["discuss", "interpretation"]):
            return "discussion"
        if any(kw in heading_lower for kw in ["conclud", "summary"]):
            return "conclusion"
        if any(kw in heading_lower for kw in ["abstract", "summary"]) and "conclusion" not in heading_lower:
            return "abstract"
        if any(kw in heading_lower for kw in ["intro", "background"]):
            return "introduction"
        if any(kw in heading_lower for kw in ["reference", "bibliography"]):
            return "references"

        return None

    def _parse_sections_keyword_fallback(
        self, text: str, sections_text: Dict[str, str], section_info: Dict
    ) -> Tuple[Dict[str, str], Dict]:
        """Fallback: Parse sections using keyword detection"""
        text_lower = text.lower()

        # Define section markers and their search patterns
        section_markers = [
            ("abstract", r'\babstract\b'),
            ("introduction", r'\bintroduction\b'),
            ("methods", r'\b(methods?|materials?\s+and\s+methods?|methodology)\b'),
            ("results", r'\bresults?\b'),
            ("discussion", r'\bdiscussion\b'),
            ("conclusion", r'\bconclusion'),
            ("references", r'\breferences?\b'),
        ]

        # Find positions of section markers
        positions = []
        for section, pattern in section_markers:
            for match in re.finditer(pattern, text_lower):
                # Check if this is likely a section header (near start of line)
                line_start = text.rfind('\n', 0, match.start()) + 1
                chars_before = match.start() - line_start
                if chars_before < 20:  # Header likely at start of line
                    positions.append((match.start(), section))

        # Sort by position
        positions.sort(key=lambda x: x[0])

        # Extract section content
        for i, (pos, section) in enumerate(positions):
            end_pos = positions[i + 1][0] if i + 1 < len(positions) else len(text)
            section_content = text[pos:end_pos].strip()

            # Remove section header from content
            lines = section_content.split('\n')
            if len(lines) > 1:
                section_content = '\n'.join(lines[1:]).strip()

            if (not sections_text.get(section)
                    or len(section_content) > len(sections_text.get(section, ''))):
                sections_text[section] = section_content
                section_info[section] = {
                    "found": True,
                    "heading": section.title(),
                    "char_count": len(section_content)
                }

        return sections_text, section_info

    def _extract_title(self, text: str) -> str:
        """Extract title from beginning of text"""
        skip_patterns = [
            "original article", "research article", "case report", "review article",
            "systematic review", "meta-analysis", "letter to the editor", "editorial",
            "brief communication", "short communication", "clinical trial",
            "original research", "study protocol", "correspondence",
        ]
        # Chinese keywords that indicate non-title content
        skip_zh_keywords = ["摘要", "目的", "方法", "结果", "结论", "背景", "前言", "引言"]
        lines = text.strip().split('\n')
        for line in lines[:10]:  # Check first 10 lines
            line = line.strip()
            # Remove markdown bold markers for length check
            clean = re.sub(r'\*+', '', line).strip()
            if not clean or len(clean) <= 10 or len(clean) >= 200:
                continue
            # Skip lines starting with 【 or [ (Chinese abstract/section markers)
            if clean.startswith('【') or clean.startswith('['):
                continue
            # Skip lines starting with closing paren — indicates mid-sentence fragment
            if clean.startswith('）') or clean.startswith(')'):
                continue
            # Skip lines containing Chinese comma (，) — title shouldn't contain commas
            if '，' in clean:
                continue
            # Skip lines starting with digits followed by dot (numbered list)
            if re.match(r'^\d+[\.、]', clean):
                continue
            if any(kw in clean.lower() for kw in ["abstract", "introduction", "methods"]):
                continue
            if any(kw in clean for kw in skip_zh_keywords):
                continue
            if any(clean.lower().strip().startswith(p) or clean.lower().strip() == p for p in skip_patterns):
                continue
            return re.sub(r'^#+\s*', '', re.sub(r'\*+', '', line).strip())
        return "Unknown Title"

    def _extract_tables_from_markdown(self, text: str) -> List[TableData]:
        """Extract tables from Markdown text"""
        tables = []

        # Pattern for Markdown tables
        table_pattern = r'(?:\*\*Table\s+(\d+)[:\.]?\s*(.*?)\*\*\s*)?\n(\|[^\n]+\|\n\|[-:\s|]+\|(?:\n\|[^\n]+\|)+)'

        for match in re.finditer(table_pattern, text, re.IGNORECASE):
            table_num = int(match.group(1)) if match.group(1) else len(tables) + 1
            caption = match.group(2).strip() if match.group(2) else ""
            table_content = match.group(3)

            # Parse table rows
            lines = table_content.strip().split('\n')
            headers = []
            rows = []

            for i, line in enumerate(lines):
                cells = [c.strip() for c in line.split('|')[1:-1]]  # Remove empty first/last
                if i == 0:
                    headers = cells
                elif not all(c in ['-', ':', ' ', ''] for c in cells):  # Skip separator
                    rows.append(cells)

            tables.append(TableData(
                table_number=table_num,
                caption=caption,
                headers=headers,
                rows=rows
            ))

        return tables

    def _extract_figures_from_markdown(self, text: str) -> List[FigureData]:
        """Extract figure references from text"""
        figures = []

        # Pattern for figure captions
        figure_patterns = [
            r'\*\*Figure\s+(\d+)[:\.]?\s*(.*?)\*\*',
            r'Fig(?:ure)?\.?\s+(\d+)[:\.]?\s*([^\n]+)',
        ]

        for pattern in figure_patterns:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                fig_num = int(match.group(1))
                caption = match.group(2).strip() if match.group(2) else ""

                # Avoid duplicates
                if not any(f.figure_number == fig_num for f in figures):
                    figures.append(FigureData(
                        figure_number=fig_num,
                        caption=caption,
                        description=""
                    ))

        return figures

    async def _extract_metadata_with_llm(
        self, full_text: str, sections_text: Dict[str, str]
    ) -> Dict[str, Any]:
        """
        Use LLM for metadata extraction only (not structure).

        This is a focused, token-efficient call that extracts:
        - Study types
        - Primary/secondary outcomes
        - Sample size
        - Statistical methods
        - Registration ID
        """
        # Build a concise prompt with key sections
        context_parts = []

        if sections_text.get("abstract"):
            context_parts.append(f"ABSTRACT:\n{sections_text['abstract'][:2000]}")

        if sections_text.get("methods"):
            context_parts.append(f"METHODS:\n{sections_text['methods'][:3000]}")

        if sections_text.get("results"):
            context_parts.append(f"RESULTS:\n{sections_text['results'][:1500]}")

        if sections_text.get("conclusion"):
            context_parts.append(f"CONCLUSION:\n{sections_text['conclusion'][:1000]}")

        # 提取文档尾部文本（含 COI / Funding / Author Contributions）
        # 这些内容通常出现在文末，不属于任何主要章节
        if full_text and len(full_text) > 2000:
            tail_text = full_text[-3000:]
            # 只包含尾部内容（过滤掉与已提取章节重复的部分）
            tail_keywords = ['conflict of interest', 'funding', 'author contribution',
                             '利益冲突', '资助', '作者贡献', 'acknowledgement', 'acknowledgment']
            if any(k in tail_text.lower() for k in tail_keywords):
                context_parts.append(f"DOCUMENT TAIL (COI/Funding/Contributions):\n{tail_text[:2000]}")

        context = "\n\n".join(context_parts)

        prompt = f"""
Extract key metadata from this medical research manuscript.

{context}

---
Return JSON with ONLY these fields:
{{
  "study_types": ["list of study types from the list below"],
  "metadata": {{
    "primary_outcome": "main outcome measure or null",
    "secondary_outcomes": ["list or empty"],
    "sample_size": "N=X or null",
    "sample_size_calculation": "brief description or null",
    "statistical_methods": ["list of methods used"],
    "registration_id": "NCT/PROSPERO number or null",
    "funding_source": "funding info or null",
    "conflicts_of_interest": "COI statement or null"
  }}
}}

RECOGNIZED STUDY TYPES (choose ALL that apply):
{chr(10).join(f'  - {t}' for t in RECOGNIZED_STUDY_TYPES)}

IMPORTANT:
- For study_types, choose ALL that apply from the list above
- CRITICAL: Distinguish review articles (Systematic Review, Scoping Review) from bibliometric/cross-sectional analyses.
  A study that counts/analyzes published papers WITHOUT following PRISMA is likely "Bibliometric Study" or "Cross-Sectional Analysis", NOT "Systematic Review".
  A study that proposes a classification system or scoring framework is "Framework Paper" or "Methodology Paper".
- Be concise in metadata values
"""

        try:
            result = await self.llm.call_with_json_response(
                messages=[
                    {"role": "system", "content": "You are a medical research metadata extractor. Return valid JSON only."},
                    {"role": "user", "content": prompt}
                ],
                model_tier=ModelTier.FAST,
                max_tokens=1500,
                temperature=0.0,
                timeout_sec=120
            )
            parsed = result.get("parsed_json", {})
            # ── 调试指纹：打印识别出的研究类型 ──
            detected_types = parsed.get("study_types", [])
            print(f"  → [DocumentAnalyzer·指纹] 识别到研究类型: {detected_types} | "
                  f"含文献计量={'Y' if any('Bibliometric' in t or 'Cross-Sectional Analysis' in t for t in detected_types) else 'N'} | "
                  f"含框架类型={'Y' if any(t in detected_types for t in ['Framework Paper', 'Methodology Paper', 'Scoping Review']) else 'N'}")
            return parsed
        except Exception as e:
            print(f"LLM metadata extraction failed: {e}")
            return {"study_types": [], "metadata": {}}

    @staticmethod
    def _detect_language(text: str) -> str:
        """Detect manuscript language based on Chinese character ratio."""
        if not text:
            return "en"
        chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
        ratio = chinese_chars / len(text)
        return "zh" if ratio > 0.08 else "en"

    def _build_document_ir(
        self,
        sections_text: Dict[str, str],
        analysis: Dict[str, Any],
        tables: List[TableData],
        figures: List[FigureData],
        full_text: str
    ) -> DocumentIR:
        """Build DocumentIR from parsed sections and extracted data"""

        def to_section_text(text: str) -> SectionText:
            if not text:
                return SectionText(text=[])
            # Split by double newlines for paragraph-level indexing
            paragraphs = [p.strip() for p in text.split('\n\n') if p.strip()]
            return SectionText(text=paragraphs)

        # Build Methods section with subsections
        methods_text = sections_text.get("methods", "")
        methods = MethodsSection(
            study_design=to_section_text(self._extract_subsection(methods_text, ["study design", "design"])),
            participants=to_section_text(self._extract_subsection(methods_text, ["participant", "patient", "subject", "population"])),
            eligibility=to_section_text(self._extract_subsection(methods_text, ["eligib", "inclusion", "exclusion"])),
            randomization=to_section_text(self._extract_subsection(methods_text, ["random", "allocation"])),
            blinding=to_section_text(self._extract_subsection(methods_text, ["blind", "mask"])),
            interventions=to_section_text(self._extract_subsection(methods_text, ["intervention", "treatment", "procedure"])),
            outcomes=to_section_text(self._extract_subsection(methods_text, ["outcome", "endpoint", "measure"])),
            sample_size=to_section_text(self._extract_subsection(methods_text, ["sample size", "power"])),
            statistics=to_section_text(self._extract_subsection(methods_text, ["statistic", "analysis", "analys"])),
            ethics=to_section_text(self._extract_subsection(methods_text, ["ethic", "irb", "consent"])),
            model_development=to_section_text(self._extract_subsection(methods_text, ["model", "machine learning", "algorithm"])),
            model_validation=to_section_text(self._extract_subsection(methods_text, ["validation", "calibration", "external"])),
            full_text=to_section_text(methods_text)
        )

        # Build Results section
        results_text = sections_text.get("results", "")
        results = ResultsSection(
            participant_flow=to_section_text(self._extract_subsection(results_text, ["flow", "enrollment", "screened"])),
            baseline=to_section_text(self._extract_subsection(results_text, ["baseline", "characteristic"])),
            outcomes=to_section_text(self._extract_subsection(results_text, ["outcome", "primary", "main"])),
            adverse_events=to_section_text(self._extract_subsection(results_text, ["adverse", "safety", "harm"])),
            full_text=to_section_text(results_text)
        )

        # Build Discussion section
        discussion_text = sections_text.get("discussion", "")
        discussion = DiscussionSection(
            limitations=to_section_text(self._extract_subsection(discussion_text, ["limitation", "weakness"])),
            generalizability=to_section_text(self._extract_subsection(discussion_text, ["generaliz", "external validity"])),
            interpretation=to_section_text(self._extract_subsection(discussion_text, ["interpret", "implication"])),
            full_text=to_section_text(discussion_text)
        )

        # Build DocumentIR
        return DocumentIR(
            title=sections_text.get("title", ""),
            abstract=to_section_text(sections_text.get("abstract", "")),
            keywords=[],  # Could be extracted separately
            introduction=to_section_text(sections_text.get("introduction", "")),
            methods=methods,
            results=results,
            discussion=discussion,
            conclusion=to_section_text(sections_text.get("conclusion", "")),
            references=sections_text.get("references", "").split('\n') if sections_text.get("references") else [],
            tables=tables,
            figures=figures,
            extracted_info=analysis.get("metadata", {}),
            fulltext=full_text
        )

    def _extract_subsection(self, text: str, keywords: List[str]) -> str:
        """Extract subsection content based on keywords"""
        if not text:
            return ""

        # Find paragraphs containing keywords
        paragraphs = text.split('\n\n')
        relevant = []

        for para in paragraphs:
            para_lower = para.lower()
            if any(kw in para_lower for kw in keywords):
                relevant.append(para)

        return '\n\n'.join(relevant)

    def _build_study_profile(self, analysis: Dict[str, Any]) -> StudyProfile:
        """Build StudyProfile from LLM analysis"""
        return StudyProfile(
            study_types=analysis.get("study_types", []),
            metadata=analysis.get("metadata", {})
        )

    def _build_evidence_map(self, document_ir: DocumentIR, original_text: str) -> EvidenceMap:
        """Build evidence map by indexing key medical terms"""
        term_locations: Dict[str, List[str]] = {}

        # Key terms to index
        key_terms = [
            "p-value", "p value", "confidence interval", "ci", "hazard ratio", "odds ratio",
            "randomization", "randomisation", "random sequence", "allocation concealment",
            "blinding", "masking", "double-blind", "single-blind",
            "informed consent", "ethics committee", "irb", "institutional review board",
            "sample size", "power calculation", "statistical significance",
            "primary outcome", "secondary outcome", "endpoint",
            "intention-to-treat", "itt", "per-protocol",
            "adverse event", "serious adverse event", "sae",
            "sensitivity", "specificity", "auc", "roc",
            "regression", "logistic regression", "cox regression",
            "machine learning", "deep learning", "neural network", "random forest",
            "validation", "external validation", "internal validation", "cross-validation",
            "consort", "prisma", "strobe", "tripod"
        ]

        # Index in each section (guard against None sections)
        if document_ir.abstract and hasattr(document_ir.abstract, 'text'):
            self._index_section(term_locations, document_ir.abstract.text, "abstract", key_terms)
        if document_ir.methods and hasattr(document_ir.methods, 'full_text') and document_ir.methods.full_text:
            self._index_section(term_locations, document_ir.methods.full_text.text, "methods", key_terms)
        if document_ir.results and hasattr(document_ir.results, 'full_text') and document_ir.results.full_text:
            self._index_section(term_locations, document_ir.results.full_text.text, "results", key_terms)
        if document_ir.discussion and hasattr(document_ir.discussion, 'full_text') and document_ir.discussion.full_text:
            self._index_section(term_locations, document_ir.discussion.full_text.text, "discussion", key_terms)

        return EvidenceMap(term_locations=term_locations)

    def _index_section(
        self,
        term_locations: Dict[str, List[str]],
        paragraphs: List[str],
        section_name: str,
        key_terms: List[str]
    ):
        """Index key terms in a section"""
        for idx, para in enumerate(paragraphs):
            para_lower = para.lower()
            for term in key_terms:
                if term.lower() in para_lower:
                    location = f"{section_name}.text[{idx}]"
                    term_key = term.lower()
                    if term_key not in term_locations:
                        term_locations[term_key] = []
                    if location not in term_locations[term_key]:
                        term_locations[term_key].append(location)

    def _build_coverage_summary(
        self,
        sections_text: Dict[str, str],
        section_info: Dict[str, Dict],
        tables: List[TableData],
        figures: List[FigureData],
        parse_metadata: Optional[Dict]
    ) -> CoverageSummary:
        """Build coverage summary for Evidence Gate"""

        # Build section coverage
        sections_found = []
        sections_missing = []

        standard_sections = ["abstract", "introduction", "methods", "results", "discussion"]

        for section in standard_sections:
            if sections_text.get(section):
                sections_found.append(ParsedSection(
                    section_name=section,
                    is_present=True,
                    paragraph_count=len(sections_text[section].split('\n\n')),
                    character_count=len(sections_text[section])
                ))
            else:
                sections_missing.append(section)

        # Build table coverage
        tables_parsed = [
            ParsedTable(
                table_number=t.table_number,
                caption=t.caption,
                row_count=len(t.rows),
                column_count=len(t.headers)
            )
            for t in tables
        ]

        # Build figure coverage
        figures_parsed = [
            ParsedFigure(
                figure_number=f.figure_number,
                caption=f.caption,
                has_description=bool(f.description)
            )
            for f in figures
        ]

        # Determine parse quality
        parse_method = parse_metadata.get("parse_method", "unknown") if parse_metadata else "unknown"
        parse_quality = parse_metadata.get("parse_quality", "medium") if parse_metadata else "medium"

        return CoverageSummary(
            total_pages=parse_metadata.get("page_count", 0) if parse_metadata else 0,
            total_characters=sum(len(v) for v in sections_text.values()),
            sections_found=sections_found,
            sections_missing=sections_missing,
            tables_parsed=tables_parsed,
            figures_parsed=figures_parsed,
            supplementary_parsed=False,  # TODO: Add supplementary detection
            parse_method=parse_method if parse_method in ["marker", "pypdf", "docx", "fallback"] else "fallback",
            parse_quality=parse_quality if parse_quality in ["high", "medium", "low"] else "medium"
        )
