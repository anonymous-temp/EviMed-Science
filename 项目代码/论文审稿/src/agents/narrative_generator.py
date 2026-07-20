"""
Narrative Report Generator - 生成自然语言审稿报告
"""
from typing import Dict, Any
from ..schemas.document_ir import DocumentIR
from ..schemas.meta_review import MetaReviewResult, NarrativeReport
from ..schemas.cognitive_review import CognitiveReviewResult
from ..services.llm_gateway import LLMGateway, ModelTier
from datetime import datetime
import re
import logging

logger = logging.getLogger(__name__)


# 目标报告字数（总体评价 + 修改意见 + 推荐意见）
_TARGET_CHARS = 8000
# 二次扩写触发阈值：首轮生成低于此字数且问题数量足够时才扩写
_EXPAND_THRESHOLD = 3000
# 触发扩写所需的最少问题数
_EXPAND_MIN_ISSUES = 3


class NarrativeReportGenerator:
    """生成自然语言审稿报告，模仿真实审稿人"""

    def __init__(self, llm_gateway: LLMGateway):
        self.llm = llm_gateway

    # ──────────────────────────────────────────────
    # 工具方法
    # ──────────────────────────────────────────────

    def _clean_internal_tags(self, text: str) -> str:
        """过滤掉报告中的内部规范标签，如 universal_rubric:URVAR_METHOD_03 等"""
        if not text:
            return ""
        patterns = [
            r'[a-zA-Z0-9_]+_rubric:[A-Z0-9_]+',
            r'[A-Z0-9_]+_rubric(?=\s|[，。、：]|$)',
            r'URVAR_[A-Z0-9_]+',
            r'PRISMA_[A-Z0-9_]+',
            r'CONSORT_[A-Z0-9_]+',
            r'STROBE_[A-Z0-9_]+',
            r'TRIPOD_[A-Z0-9_]+'
        ]
        cleaned = text
        for p in patterns:
            cleaned = re.sub(p, '', cleaned)
        cleaned = re.sub(r'\(\s*\)', '', cleaned)
        # 只压缩行内多余空格，保留换行符
        cleaned = re.sub(r'[^\S\n]{2,}', ' ', cleaned).strip()
        return cleaned

    def _strip_minor_from_issues(self, text: str) -> tuple:
        """
        从 critical_issues_narrative 中剥离 LLM 越界写入的次要建议段落。
        返回 (主体内容, 次要建议内容) 两部分。
        """
        if not text:
            return text, ""
        # 先规范化换行符：将字面量 \\n 转为真实换行
        text = text.replace('\\n', '\n').replace('\\r', '')
        # 匹配 ## 次要建议 / ### 次要建议 / **次要建议** 等各种标题变体
        pattern = r'\n+(?:#{1,3}\s*次要建议|\*{1,2}次要建议\*{1,2}|次要建议[:：]).*'
        m = re.search(pattern, text, flags=re.DOTALL)
        if m:
            main_part  = text[:m.start()].strip()
            minor_part = re.sub(r'^(?:#{1,3}\s*次要建议|\*{1,2}次要建议\*{1,2}|次要建议[:：])\s*', '',
                                text[m.start():].strip(), flags=re.MULTILINE).strip()
            return main_part, minor_part
        return text, ""

    def _split_prose_to_numbered(self, text: str) -> str:
        """
        后处理：将散文段落的修改意见强制转为数字编号分点。
        如果 LLM 已经输出了编号（1. 2. 3.），则直接返回。
        如果是散文，则按句号/分号拆分为多个段落，每段加编号。
        章节标题行（## 开头）保留不处理。
        """
        if not text:
            return text

        # 检查是否已经有编号格式（1、 或 1. 或 ① 等）
        already_numbered = bool(re.search(r'(?:^|\n)\s*(?:\d+[、.．]\s*|[①②③④⑤⑥⑦⑧⑨⑩])', text))
        if already_numbered:
            # 统一将 "1." / "1．" 格式转换为 "1、"（顿号不被 Markdown 识别为列表）
            text = re.sub(r'(?m)^\s*(\d+)[.．]\s*', r'\1、', text)
            # 确保每个编号前有空行分隔（章节标题前不插入）
            text = re.sub(r'(?m)(?<!^)(?=^\d+、)', '\n', text, flags=re.MULTILINE)
            return re.sub(r'\n{3,}', '\n\n', text).strip()

        # 散文模式：按段落拆分（双换行或"首先/其次/此外/最后/另外/值得"等连接词）
        # 先尝试按双换行拆
        paragraphs = [p.strip() for p in re.split(r'\n{2,}', text) if p.strip()]

        # 如果只有一个段落（整段散文），按"首先|其次|此外|更为|更重要|尤其|最后|另外|值得关注"拆分
        if len(paragraphs) <= 1:
            split_pattern = r'(?<=[。；])\s*(?=首先|其次|此外|更为|更重要|尤其|最后|另外|值得关注|在写作|在表述|在次要)'
            parts = re.split(split_pattern, text)
            paragraphs = [p.strip() for p in parts if p.strip() and len(p.strip()) > 20]

        # 如果还是只有一个段落，按句号强制拆（每2-3句为一点）
        if len(paragraphs) <= 1:
            sentences = re.split(r'(?<=[。！？])', text)
            sentences = [s.strip() for s in sentences if s.strip() and len(s.strip()) > 10]
            # 每3句合并为一点
            merged = []
            for i in range(0, len(sentences), 3):
                chunk = ''.join(sentences[i:i+3])
                if chunk:
                    merged.append(chunk)
            paragraphs = merged if merged else paragraphs

        if not paragraphs:
            return text

        # 加编号（使用 "1、" 格式，不被Markdown识别为列表）
        # 过滤章节标题行（## 开头），只保留实质内容段落
        numbered_lines = []
        counter = 1
        for para in paragraphs:
            if para.startswith('##') or para.startswith('###'):
                continue  # 丢弃二级/三级标题，不输出
            numbered_lines.append(f"{counter}、{para}")
            counter += 1

        return '\n\n'.join(numbered_lines)

    def _merge_minor_into_issues(self, critical: str, minor: str) -> str:
        """将次要建议合并到修改意见末尾（如果次要建议有实质内容）"""
        if not minor or len(minor.strip()) < 20:
            return critical

        # 计算当前最大编号（支持 "1、" 格式）
        nums = re.findall(r'(?:^|\n)\s*(\d+)[、.]', critical)
        next_num = (max(int(n) for n in nums) + 1) if nums else 1

        # 将次要建议段落也拆分并追加
        minor_paragraphs = [p.strip() for p in re.split(r'\n{2,}', minor) if p.strip()]
        if not minor_paragraphs:
            minor_paragraphs = [minor.strip()]

        appended = critical.rstrip()
        for para in minor_paragraphs:
            # 跳过已经是编号格式的行（支持 "1、" 格式）
            if re.match(r'^\d+[、.]', para):
                appended += f"\n\n{para}"
            else:
                appended += f"\n\n{next_num}、{para}"
                next_num += 1

        return appended

    def _get_report_outline(self, study_types: str) -> str:
        """根据研究类型返回报告大纲结构（仅用于组织报告格式，不对外展示）"""
        st = study_types.lower()
        if any(k in st for k in ['systematic', 'meta', 'review', '系统', '综述', 'meta-analysis']):
            return (
                "## 一、检索策略与文献筛选\n"
                "## 二、纳入研究的质量评估\n"
                "## 三、异质性分析与合并方法\n"
                "## 四、结果报告规范性\n"
                "## 五、讨论与结论质量\n"
                "## 六、写作与语言表达"
            )
        elif any(k in st for k in ['rct', 'randomized', 'randomised', 'trial', '随机', '临床试验']):
            return (
                "## 一、随机化与盲法设计\n"
                "## 二、统计分析与样本量\n"
                "## 三、结果报告完整性\n"
                "## 四、安全性与不良事件报告\n"
                "## 五、讨论与结论质量\n"
                "## 六、写作与语言表达"
            )
        elif any(k in st for k in ['ai', 'machine learning', 'deep learning', 'prediction', '预测', '机器学习']):
            return (
                "## 一、数据集与特征工程\n"
                "## 二、模型设计与验证\n"
                "## 三、过拟合与泛化能力\n"
                "## 四、结果解释与临床意义\n"
                "## 五、报告规范符合度（TRIPOD-AI）\n"
                "## 六、写作与语言表达"
            )
        else:
            # 通用大纲（观察性研究、横断面、病例对照等）
            return (
                "## 一、研究设计与方法学\n"
                "## 二、统计分析与数据处理\n"
                "## 三、结果报告规范性\n"
                "## 四、讨论与结论质量\n"
                "## 五、报告规范符合度\n"
                "## 六、写作与语言表达"
            )

    async def _verify_issues_with_llm(
        self,
        issues: list,
        document_ir: DocumentIR,
    ) -> list:
        """
        用 LLM 逐批核查所有问题是否真实存在于论文中。
        每批 30 条，出错时保守保留全部。
        返回通过核查的问题列表（严重性排序不变）。
        """
        if not issues:
            return issues

        # 构建文档上下文（标题 + 摘要 + 方法节选 + 结果节选）
        doc_parts = []
        if document_ir.title:
            doc_parts.append(f"标题：{document_ir.title}")
        if document_ir.abstract and hasattr(document_ir.abstract, 'text'):
            doc_parts.append("摘要：" + ' '.join(document_ir.abstract.text[:5])[:1200])
        if document_ir.methods and hasattr(document_ir.methods, 'full_text') and document_ir.methods.full_text:
            methods_text = ' '.join((document_ir.methods.full_text.text or [])[:3])[:800]
            if methods_text:
                doc_parts.append(f"方法（节选）：{methods_text}")
        if document_ir.results and hasattr(document_ir.results, 'full_text') and document_ir.results.full_text:
            results_text = ' '.join((document_ir.results.full_text.text or [])[:3])[:600]
            if results_text:
                doc_parts.append(f"结果（节选）：{results_text}")
        doc_context = '\n'.join(doc_parts)

        BATCH_SIZE = 30
        verified = []

        for batch_start in range(0, len(issues), BATCH_SIZE):
            batch = issues[batch_start:batch_start + BATCH_SIZE]

            issues_list = ""
            for i, issue in enumerate(batch):
                desc_short = (issue.description or "")[:200]
                issues_list += f"{i}: [{issue.severity}] {issue.title}\n   {desc_short}\n"

            prompt = f"""你是论文审稿核查助手。以下是一篇论文的关键内容和针对该论文提出的审稿意见。
请逐条判断每条意见所指出的问题是否在该论文中真实存在。

【论文内容】
{doc_context}

【待核查的审稿意见（编号: 严重性 标题 / 描述）】
{issues_list}

【核查规则】
1. 若该问题与论文研究类型完全不符（如对叙述性综述要求PRISMA检索流程图、对综述要求动物伦理批号），标记为不存在。
2. 若该问题指出的缺陷在上述摘要/方法/结果中已有明确内容覆盖，标记为不存在。
3. 若无法从提供的内容判断，默认标记为存在（保守原则）。
4. 若问题描述合理且与论文研究类型相符，标记为存在。

返回 JSON：{{"confirmed": [确认存在的问题编号列表，如 [0, 1, 3, 5]]}}"""

            try:
                result = await self.llm.call_with_json_response(
                    messages=[
                        {"role": "system", "content": "你是严格的论文审稿核查助手，只输出JSON。"},
                        {"role": "user", "content": prompt}
                    ],
                    model_tier=ModelTier.STANDARD,
                    temperature=0.0,
                    max_tokens=500,
                    timeout_sec=120
                )
                confirmed_indices = result.get("parsed_json", {}).get("confirmed", None)
                if not isinstance(confirmed_indices, list):
                    # 解析失败，保守保留全批
                    logger.warning(f"IssueVerifier 批次 {batch_start//BATCH_SIZE+1} 返回格式异常，保守保留全部")
                    verified.extend(batch)
                    continue
                kept = 0
                for idx in confirmed_indices:
                    if isinstance(idx, int) and 0 <= idx < len(batch):
                        verified.append(batch[idx])
                        kept += 1
                print(f"  → [IssueVerifier] 批次 {batch_start//BATCH_SIZE+1}: 保留 {kept}/{len(batch)} 条")
            except Exception as e:
                logger.error(f"IssueVerifier 批次核查失败，保守保留全部: {e}", exc_info=True)
                print(f"  → [IssueVerifier] 批次核查失败，保守保留全部 {len(batch)} 条: {e}")
                verified.extend(batch)

        return verified

    async def _expand_issues(
        self,
        issues_text: str,
        overall_eval: str,
        document_ir: DocumentIR,
    ) -> str:
        """
        二次扩写：对已生成的修改意见逐条补充原文引证和具体建议，
        使报告达到目标字数。
        仅在首轮内容过少时触发。
        """
        # 提取原文摘要用于事实核查
        if document_ir.abstract and hasattr(document_ir.abstract, 'text'):
            doc_abstract = ' '.join(document_ir.abstract.text[:3])[:800]
        else:
            doc_abstract = "无摘要"

        expand_prompt = f"""你是一位资深医学审稿专家。以下是已初步生成的审稿修改意见，但内容较为简短，需要你逐条进行扩写。

【原文摘要（用于事实核查，禁止捏造原文不存在的内容）】
{doc_abstract}

【需要扩写的修改意见】
{issues_text}

【扩写要求】
1. 保持原有编号顺序和章节结构不变，不增减问题数量。
2. 每条意见扩写至不少于300字，用连贯散文段落展开，内容须涵盖：原文现状描述（引用关键词句，用引号标注）、违反的规范标准（如CONSORT第X条）、可操作修改建议（修改后应达到的可验证标准）。三者融合在流畅段落中，不使用加粗标签。
3. 只扩写内容，不改变原有判断和立场。
4. 禁止出现"评分"、"系统分析"、"AI"等暴露内部机制的词汇。
5. 直接输出扩写后的完整修改意见文本，不要输出JSON，不要添加前言后语。"""

        try:
            result = await self.llm.call_with_retry(
                messages=[
                    {"role": "system", "content": "你是资深医学期刊审稿专家，输出中文。"},
                    {"role": "user", "content": expand_prompt}
                ],
                model_tier=ModelTier.ADVANCED,
                temperature=0.5,
                max_tokens=6000,
                timeout_sec=600,
            )
            expanded = result.get("content", "").strip()
            print(f"  → [_expand_issues] 输入={len(issues_text)}字, 输出={len(expanded)}字")
            if expanded and len(expanded) > len(issues_text):
                return self._clean_internal_tags(expanded)
            else:
                print(f"  → [_expand_issues] 扩写未增加长度，返回原始内容")
        except Exception as e:
            logger.error(f"二次扩写失败（非致命）: {e}", exc_info=True)
            print(f"  → 二次扩写失败（非致命）: {e}")
        return issues_text

    async def _generate_recommendation(
        self,
        overall_eval: str,
        issues: str,
        document_ir: DocumentIR,
        meta_review: 'MetaReviewResult',
    ) -> str:
        """独立生成推荐意见（当主 LLM 输出中 recommendation_narrative 为空时调用）"""
        study_types = "未知"
        if hasattr(document_ir, 'study_profile') and document_ir.study_profile:
            study_types = ', '.join(document_ir.study_profile.study_types)

        prompt = f"""基于以下审稿意见，撰写200-300字的推荐意见段落。

稿件研究类型：{study_types}

【总体评价】
{overall_eval[:500]}

【主要修改意见摘要】
{issues[:2000]}

【要求】
1. 结构：①1-2句给出修改程度建议（如大修、小修）；②3-4句列举必须修改的核心问题（方法学、统计等关键缺陷）；③1-2句指出修改后的发表潜力与期刊适配性
2. 语气专业，不得出现评分词汇（如"8.0/10"、"评分"等）
3. 直接输出推荐意见正文，不要输出JSON，不要添加标题
4. 不得为空字符串"""

        try:
            result = await self.llm.call_with_retry(
                messages=[
                    {"role": "system", "content": "你是资深医学期刊审稿专家，输出中文。"},
                    {"role": "user", "content": prompt}
                ],
                model_tier=ModelTier.ADVANCED,
                temperature=0.5,
                max_tokens=1000,
                timeout_sec=120,
            )
            rec = result.get("content", "").strip()
            rec = self._clean_internal_tags(rec)
            rec = rec.strip().strip('；;"""\'\'')
            print(f"  → [_generate_recommendation] 独立生成成功: {len(rec)}字")
            if rec and len(rec) > 50:
                return rec
            print(f"  → [_generate_recommendation] 生成内容过短，使用兜底")
        except Exception as e:
            print(f"  → [_generate_recommendation] 独立生成失败: {e}")
        return "建议进行大修后重新评审，待补充完整内容后具备发表潜力。"

    # ──────────────────────────────────────────────
    # 主方法
    # ──────────────────────────────────────────────

    @staticmethod
    def _parse_json_from_text(text: str) -> dict:
        """从 LLM 纯文本输出中提取各字段。
        优先尝试标准 JSON 解析；失败时回退到基于字段名的正则提取。"""
        import json as _json
        import re as _re

        # ── 方法A：标准 JSON 解析 ──
        raw = text

        # 1) 尝试提取 ```json ... ``` 代码块
        if "```json" in raw:
            try:
                block = raw.split("```json", 1)[1].split("```", 1)[0].strip()
                return _json.loads(block)
            except Exception:
                pass

        # 2) 尝试直接解析裸 JSON
        start = raw.find("{")
        if start >= 0:
            candidate = raw[start:]
            # 找最后一个 } 并逐步尝试
            for end in range(len(candidate), max(0, len(candidate) - 5), -1):
                if end <= 0 or candidate[end - 1] != "}":
                    continue
                try:
                    return _json.loads(candidate[:end])
                except Exception:
                    continue

        # ── 方法B：基于字段名的正则提取（回退方案）──
        # 模型总是输出相同的字段名，按顺序提取每个字段的值
        FIELD_NAMES = [
            "outline",
            "overall_evaluation",
            "critical_issues_narrative",
            "minor_suggestions_narrative",
            "recommendation_narrative",
        ]

        result = {}
        for idx, field in enumerate(FIELD_NAMES):
            # 当前字段的模式: "field_name": "...
            # 找到下一个字段的起始位置来截取当前字段的值
            pattern = rf'"{field}"\s*:\s*"'
            match = _re.search(pattern, raw)
            if not match:
                result[field] = ""
                continue

            value_start = match.end()  # 值开始位置（跳过开头引号）

            # 值结束位置：下一个字段名开始，或 JSON 的 }
            next_field_start = len(raw)
            for next_field in FIELD_NAMES[idx + 1:]:
                next_match = _re.search(rf',\s*"{next_field}"\s*:', raw[value_start:])
                if next_match:
                    next_field_start = value_start + next_match.start()
                    break

            # 如果没有后续字段，取到 } 为止
            if next_field_start == len(raw):
                brace_pos = raw.rfind("}")
                if brace_pos > value_start:
                    next_field_start = brace_pos

            # 提取并清理值
            value = raw[value_start:next_field_start].rstrip()
            # 去掉尾部引号和逗号
            while value and value[-1] in ('"', ',', ' ', '\n', '\r', '\t'):
                value = value[:-1].rstrip()

            # 还原 JSON 转义序列
            value = value.replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"').replace('\\\\', '\\')
            # 去除首尾多余的分号和引号
            value = value.strip().strip('；;"""\'\'')
            # 清除 JSON 字符串转义残留的引号/逗号碎片（如段落间的 ", " 分隔）
            value = _re.sub(r'"\s*,\s*"', '\n\n', value)
            value = _re.sub(r'(?m)^\s*"\s*,?\s*$', '', value)
            value = _re.sub(r'(?m)^(\s*)"(\d+[、.．])', r'\1\2', value)
            value = _re.sub(r'\n{3,}', '\n\n', value).strip()
            result[field] = value

        if result:
            print(f"  → [NarrativeGen·回退解析] 成功提取字段: {list(result.keys())}")
            for k, v in result.items():
                print(f"    {k}: {len(v)}字")

        return result

    async def generate_narrative_report(
        self,
        document_ir: DocumentIR,
        meta_review: MetaReviewResult,
        cognitive_result: CognitiveReviewResult,
        technical_appendix: Dict[str, Any] = None
    ) -> NarrativeReport:
        """生成自然语言报告"""

        max_retries = 2

        # ── 调试指纹 ──
        _sp = self._get_system_prompt()
        print(f"  → [NarrativeGenerator·指纹] "
              f"时间锚2026={'Y' if '2026年' in _sp else 'N'} | "
              f"逻辑锁={'Y' if '常识性逻辑锁' in _sp else 'N'} | "
              f"禁止AI词汇={'Y' if '禁止泄露 AI 身份' in _sp else 'N'} | "
              f"绝对约束={'Y' if '绝对约束' in _sp else 'N'}")

        all_issues = meta_review.fatal_issues + meta_review.major_issues + meta_review.minor_issues

        # ── LLM 核查：过滤论文中不真实存在的问题 ──
        print(f"  → [IssueVerifier] 开始核查 {len(all_issues)} 条问题是否真实存在...")
        verified_issues = await self._verify_issues_with_llm(all_issues, document_ir)
        print(f"  → [IssueVerifier] 核查完成，保留 {len(verified_issues)}/{len(all_issues)} 条")
        print(f"  → [问题追踪] IssueVerifier后: 输入={len(all_issues)}, 保留={len(verified_issues)}, 过滤率={100*(1-len(verified_issues)/max(len(all_issues),1)):.0f}%")

        for attempt in range(max_retries + 1):
            try:
                prompt = self._build_prompt(document_ir, meta_review, cognitive_result, verified_issues)

                result = await self.llm.call_with_retry(
                    messages=[
                        {"role": "system", "content": self._get_system_prompt()},
                        {"role": "user", "content": prompt}
                    ],
                    model_tier=ModelTier.ADVANCED,
                    temperature=0.65,
                    max_tokens=8000,
                    timeout_sec=600
                )

                # 手动从文本中解析 JSON（不使用 json_object 模式，避免模型输出受限）
                content = result["content"]
                print(f"  → [NarrativeGen·原始响应] content长度={len(content)}, 前300字: {content[:300]}")
                print(f"  → [NarrativeGen·token用量] input={result.get('input_tokens', '?')}, output={result.get('output_tokens', '?')}, max=8000")
                parsed = self._parse_json_from_text(content)
                print(f"  → [NarrativeGen·解析结果] parsed keys={list(parsed.keys()) if parsed else '空'}")
                if not isinstance(parsed, dict):
                    raise ValueError(f"LLM 返回的 JSON 不是字典类型: {type(parsed)}")

                overall_eval    = self._clean_internal_tags(parsed.get("overall_evaluation", ""))
                issues_raw      = self._clean_internal_tags(parsed.get("critical_issues_narrative", ""))
                minor_raw       = self._clean_internal_tags(parsed.get("minor_suggestions_narrative", ""))
                recommendation  = self._clean_internal_tags(parsed.get("recommendation_narrative", ""))
                # 去除推荐意见首尾的分号和引号包裹
                recommendation = recommendation.strip().strip('；;"""\'\'')
                # 如果推荐意见为空或过短，发起独立 LLM 生成
                if not recommendation or len(recommendation) < 50:
                    print(f"  → recommendation_narrative 为空或过短({len(recommendation)}字)，发起独立生成...")
                    recommendation = await self._generate_recommendation(overall_eval, issues_raw, document_ir, meta_review)

                print(f"  → [NarrativeGen·原始长度] overall={len(overall_eval)}, issues={len(issues_raw)}, recommend={len(recommendation)}")
                print(f"  → [NarrativeGen·token用量] input={result.get('input_tokens', '?')}, output={result.get('output_tokens', '?')}, max=8000")

                # ── 后处理1：剥离 LLM 越界写入的次要建议段落 ──
                issues_stripped, extracted_minor = self._strip_minor_from_issues(issues_raw)

                # ── 后处理2：清除 LLM 可能输出的章节标题行（## / ###）──
                issues_stripped = re.sub(r'(?m)^#{1,3}\s+.*\n?', '', issues_stripped).strip()
                issues_stripped = re.sub(r'\n{3,}', '\n\n', issues_stripped)

                # ── 后处理3：将修改意见强制转为分点 ──
                issues_numbered = self._split_prose_to_numbered(issues_stripped)

                # ── 后处理4：将次要建议合并入修改意见末尾 ──
                combined_minor = (extracted_minor + "\n\n" + minor_raw).strip() if minor_raw else extracted_minor
                issues_final = self._merge_minor_into_issues(issues_numbered, combined_minor)

                if len(overall_eval) < 30 or len(issues_final) < 100:
                    if attempt < max_retries:
                        print(f"  → 报告内容不足 (总体:{len(overall_eval)}字, 问题:{len(issues_final)}字)，重试生成...")
                        continue
                    else:
                        print(f"  → 警告：报告长度不足")

                # ── 后处理5：二次扩写（总字数不足且问题数量足够时触发）──
                total_chars = len(overall_eval) + len(issues_final) + len(recommendation)
                if total_chars < _EXPAND_THRESHOLD and len(verified_issues) >= _EXPAND_MIN_ISSUES:
                    print(f"  → 报告字数不足 ({total_chars}字 < {_EXPAND_THRESHOLD})，触发二次扩写...")
                    issues_final = await self._expand_issues(issues_final, overall_eval, document_ir)
                    total_chars = len(overall_eval) + len(issues_final) + len(recommendation)
                    print(f"  → 扩写后字数: {total_chars}字")

                return NarrativeReport(
                    title=document_ir.title or "未知标题",
                    outline=parsed.get("outline", ""),
                    overall_evaluation=overall_eval or "研究内容待评估。",
                    key_strengths_narrative="",
                    critical_issues_narrative=issues_final or "修改意见待评估。",
                    minor_suggestions_narrative="",   # 已合并到 critical_issues_narrative
                    recommendation_narrative=recommendation or "推荐意见待评估。",
                    recommendation=meta_review.recommendation,
                    generated_at=datetime.now(),
                    technical_appendix=technical_appendix
                )

            except Exception as e:
                if attempt < max_retries:
                    logger.error(f"自然语言生成失败 (尝试 {attempt + 1}/{max_retries + 1}): {e}", exc_info=True)
                    print(f"  → 自然语言生成失败 (尝试 {attempt + 1}/{max_retries + 1}): {e}，重试中...")
                    continue
                else:
                    logger.error(f"自然语言生成全部失败: {e}", exc_info=True)
                    print(f"  → 自然语言生成失败: {e}")
                    raise RuntimeError(
                        "Narrative peer-review generation failed; no report was produced"
                    ) from e

    # ──────────────────────────────────────────────
    # Prompt 构建
    # ──────────────────────────────────────────────

    def _get_system_prompt(self) -> str:
        """系统提示"""
        return """【系统时间设定】当前真实世界时间为 2026年。任何发生在 2026 年及以前的研究、检索日期、发表日期都是完全合法且正常的。绝对禁止以'时间发生在未来'为由批评任何 2026 年的日期！

你是一位为顶级医学期刊（如 The Lancet、JAMA、BMJ）审稿的资深专家，拥有超过 15 年的同行评议经验。

你将收到一份经过主审裁决和事实核查后的结构化审稿意见，以及原始论文的关键内容摘要。请据此撰写一份完整的同行评议报告。

【常识性逻辑锁】
在撰写报告前，请对传入的意见进行最后一次常识扫描：
1. 检查是否存在自相矛盾（例如：一方面说文章没有方法部分，另一方面又批评方法部分里的检索策略不好）。如果有，直接舍弃'没有方法部分'这种荒谬的指控。
2. 严禁提及任何具体的年份错误（如 2026 年）。
3. 确保你的语气是客观、专业的学术探讨，而不是机器式的死板挑错。

【修改意见的操作性要求——每条建议必须达到"作者可直接执行"的级别】
这是最重要的写作标准，须严格执行：

A. 凡是建议"补充方法部分/文献检索策略"：
   - 必须给出具体数据库名称示例（如 PubMed、Embase、Web of Science、CNKI）
   - 必须给出一条示范检索式结构，例如：("microplastic*" OR "nanoplastic*") AND (placenta* OR "transplacental") AND (fetal OR neonat* OR newborn)
   - 必须说明应包含的时间范围参考（如 2010–2025）

B. 凡是建议"区分动物模型与人群证据"或"说明研究局限性"：
   - 必须建议作者新增具体的结构段落或小节（如"Model Limitations and Human Relevance"或"Limitations of Current Evidence"），并给出该段落应涵盖的具体内容要点（如：动物实验中所用剂量与人体实际暴露量级的差距；体外细胞模型无法复现胎盘屏障动态变化；跨物种外推的生理学差异等）

C. 凡是建议"具体化未来研究方向"：
   - 必须提出至少2-3个可直接转化为研究方案的具体假说或实验设计，例如：建立孕早期微塑料暴露生物标志物检测队列、开展灌流人胎盘模型的剂量-效应实验、比较不同聚合物类型的胎盘穿透效率差异等
   - 建议说明目标人群（如高暴露地区居民）、主要研究终点和推荐的实验模型

D. 凡是指出"引用不准确/泛化表达（如'研究显示'）"：
   - 必须要求作者全文系统检查，给出具体搜索指令（如："搜索全文中'studies show'、'research indicates'、'evidence suggests'等泛化词汇，对每处逐一标注对应参考文献编号及其研究类型"）
   - 对文中具体出现的例句给出修改前/修改后的对比示范

E. 凡涉及引用不一致（动物研究被误引为人群证据）：
   - 必须给出该处原文句子的引用方式，说明正确的表述应如何限定语气（如将"a cohort study demonstrated"改为"a mouse model study suggested"），并要求作者对全文所有引用进行同类型核查

【最高优先级禁令：禁止泄露 AI 身份与内部机制】
1. 绝对禁止在报告中出现任何类似"8.0/10"、"评分"、"认知评估结果"、"系统分析"、"根据评估"等暴露内部算法的词汇。
2. 绝对禁止在报告中出现内部规范标签（如 universal_rubric:URVAR_METHOD_03、URVAR_CONTRIB_02 等），必须用自然语言描述（如"违反了系统综述关于偏倚来源评估的规范要求"）。
3. 必须将所有内部评分转化为学术化的自然语言评价。
4. 你的语气必须 100% 像一位人类资深医学专家，不得有任何机器痕迹。

【绝对约束：所有批评必须基于传入的真实审稿意见】
- 绝对禁止捏造文章中不存在的概念或内容。
- 如果传入的意见中没有提到某个问题，绝对不能在报告中凭空添加。
- 对于文章中已经写到的内容，必须准确判断其"是否已提及"，避免指控作者没有写实际上已经写了的内容。

输出中文。"""

    def _build_prompt(
        self,
        document_ir: DocumentIR,
        meta_review: MetaReviewResult,
        cognitive_result: CognitiveReviewResult,
        verified_issues: list = None
    ) -> str:
        """构建生成 prompt"""

        # 提取文档关键信息用于事实核查
        if document_ir.abstract and hasattr(document_ir.abstract, 'text') and document_ir.abstract.text:
            doc_abstract = ' '.join(document_ir.abstract.text[:3])[:800]
        elif document_ir.fulltext:
            # DocumentIR 未识别到 abstract，但全文中有，用正则提取
            import re as _re_abstract
            _m = _re_abstract.search(r'(?i)(?:^|\n)\s*abstract\s*\n', document_ir.fulltext)
            if _m:
                _after = document_ir.fulltext[_m.end():_m.end() + 1500]
                _end = _re_abstract.search(r'\n\s*(?:#{1,3}\s|\d+\.?\s*(?:introduction|keywords|1\s))', _after, _re_abstract.IGNORECASE)
                doc_abstract = (_after[:_end.start()] if _end else _after[:1000]).strip()[:800]
            else:
                doc_abstract = document_ir.fulltext[:800]
        else:
            doc_abstract = "无摘要"

        # 提取研究类型
        study_types = "未知"
        if hasattr(document_ir, 'study_profile') and document_ir.study_profile:
            study_types = ', '.join(document_ir.study_profile.study_types)
        elif hasattr(document_ir, 'extracted_info') and 'study_types' in document_ir.extracted_info:
            study_types = ', '.join(document_ir.extracted_info.get('study_types', ['未知']))

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

        # 获取报告大纲（按研究类型选择）
        report_outline = self._get_report_outline(study_types)

        # 构建问题描述（使用 LLM 核查后的问题列表，无硬截断）
        issues_text = ""
        issues_to_use = verified_issues if verified_issues is not None else (
            meta_review.fatal_issues + meta_review.major_issues + meta_review.minor_issues
        )
        print(f"  → [NarrativeGen·素材] 问题数量: fatal={len(meta_review.fatal_issues)}, "
              f"major={len(meta_review.major_issues)}, minor={len(meta_review.minor_issues)}, "
              f"核查后使用={len(issues_to_use)}")
        for issue in issues_to_use:
            severity_label = "致命" if issue.severity == "fatal" else ("主要" if issue.severity == "major" else "次要")
            issues_text += f"\n[{severity_label}] {issue.title}\n"
            issues_text += f"描述: {issue.description}\n"
            if issue.standard_reference:
                issues_text += f"标准依据: {issue.standard_reference}\n"
            else:
                issues_text += f"标准依据: 待核实\n"
            if issue.location_in_paper:
                issues_text += f"位置: {issue.location_in_paper}\n"
            else:
                issues_text += f"位置: 全文\n"

        # 将认知评分转化为自然语言描述（不暴露数字）
        def score_to_text(score: float, dimension: str) -> str:
            if score >= 8.0:
                return f"{dimension}表现优异"
            elif score >= 6.0:
                return f"{dimension}基本合格"
            else:
                return f"{dimension}存在明显不足"

        novelty_text      = score_to_text(cognitive_result.novelty_score, "研究创新性")
        contribution_text = score_to_text(cognitive_result.contribution_score, "学术贡献度")
        method_depth_text = score_to_text(cognitive_result.methodological_depth_score, "方法论深度")
        writing_text      = score_to_text(cognitive_result.writing_quality_score, "写作质量")

        # 方案A：完整传入认知分析（去除截断）
        lit_analysis      = cognitive_result.literature_positioning_analysis or "待评估"
        method_analysis   = cognitive_result.methodological_depth_analysis    or "待评估"
        contrib_analysis  = cognitive_result.contribution_analysis            or ""
        writing_analysis  = cognitive_result.writing_quality_analysis         or ""
        operability       = cognitive_result.operability_analysis             or ""

        # 组织认知评审中的弱点列表（用于补充修改意见素材）
        weaknesses_text = ""
        for w in cognitive_result.key_weaknesses[:5]:
            weaknesses_text += f"- {w.description}（{w.evidence}）\n"

        # --- Python 3.10 compat: extract conditional texts out of f-string ---

        # 维度核查清单（根据研究类型选择）
        if any(k in study_types.lower() for k in ["review", "综述", "meta"]):
            dimension_label = "（综述类文章专用维度）"
            dimension_text = (
                "① 证据整合与文献覆盖：是否系统检索了代表性文献，有无明显遗漏\n"
                "② 引用准确性：动物研究是否被误引为人群证据，研究类型是否正确标注\n"
                "③ 推论合理性：结论是否超出所引证据的支持范围，是否存在过度外推\n"
                "④ 证据等级区分：是否区分了不同级别的证据（人群研究vs动物实验vs体外研究）\n"
                "⑤ 讨论深度：是否充分分析了现有证据的局限性与异质性\n"
                "⑥ 结构完整性：各章节是否有机衔接，是否存在未完成的句子或逻辑断裂\n"
                "⑦ 参考文献：引用格式是否一致，是否有引用过时或不相关文献\n"
                "⑧ 写作表述：摘要与正文一致性，结论是否有文献依据"
            )
        else:
            dimension_label = "（原始研究专用维度）"
            dimension_text = (
                "① 研究设计：随机化/盲法/分组/纳排标准是否完整严谨\n"
                "② 样本量与统计效能：是否有计算依据，多重比较是否校正\n"
                "③ 混杂控制：是否识别并处理主要混杂因素\n"
                "④ 结局指标：主次结局是否预先注册、是否存在结局切换\n"
                "⑤ 数据完整性：缺失数据处理方式是否报告，是否进行敏感性分析\n"
                "⑥ 效应量与置信区间：是否完整报告，临床意义是否阐明\n"
                "⑦ 偏倚来源：选择偏倚、信息偏倚、发表偏倚是否逐一讨论\n"
                "⑧ 外推性与局限：样本代表性、随访时长、研究场景是否充分讨论\n"
                "⑨ 伦理与注册：伦理批号、知情同意、临床试验注册是否明确\n"
                "⑩ 报告规范：对应规范（CONSORT/PRISMA/STROBE等）的逐条符合情况\n"
                "⑪ 参考文献：引用准确性、时效性、是否有自引膨胀\n"
                "⑫ 写作表述：摘要与正文一致性、数据自洽性、结论是否超出数据范围"
            )

        # 输出示例（根据研究类型选择）
        if any(k in study_types.lower() for k in ["review", "综述", "meta", "narrative", "literature", "scoping"]):
            example_text = (
                '"1、本文未在摘要或正文中说明文献检索的数据库范围、检索式及检索时间，读者无法判断文献覆盖的完整性。'
                '一篇规范的综述至少应检索PubMed、Embase、Web of Science等主流数据库，并在方法部分明确报告检索策略。'
                '建议作者补充：（1）检索数据库列表；（2）以PubMed为例给出完整检索式，例如 \'(microplastics OR nanoplastics) AND (placenta OR transplacental) AND (neonate OR newborn) AND (2015:2024[pdat])\'；'
                '（3）最终检索日期及命中文献数。此外，应说明文献筛选的纳入/排除标准，例如是否仅纳入人群研究还是同时纳入动物实验，以便读者评估证据基础。'
                '修改后应使本文的文献覆盖范围对任何具备检索能力的第三方读者均可复现与核查。"\n\n'
                '"2、正文引言部分写道\'existing studies have shown that microplastics can traverse the placental barrier and cause neurological damage in neonates\'，'
                '但这一陈述将动物实验结果直接等同于人类临床证据，属于典型的跨研究类型误引。'
                'Peng & He（2024）的研究对象为陆生哺乳动物，而非人类新生儿，其所观察到的神经毒性效应不能直接外推至人群。'
                '建议作者全文系统检查所有含\'studies show\'、\'research indicates\'、\'evidence demonstrates\'等泛化表达的句子（可在文档中使用查找功能逐条核对），'
                '对每处明确标注对应参考文献编号及其研究类型。具体示范：将\'studies have shown that MPs cause neurological damage\'改为'
                '\'animal model studies have suggested a possible association between MP exposure and neurological changes (Peng & He, 2024), though equivalent human cohort data remain absent\'。'
                '此类修改须覆盖全文，而非仅限于引言部分。"'
            )
        else:
            example_text = (
                '"1、在方法部分，作者仅提及\'采用随机数字表法\'进行随机化，但对随机序列的具体生成步骤、分配隐藏方案及负责实施的人员均未作说明，'
                '读者无法据此评估选择偏倚的风险。根据CONSORT 2010声明第8a-b条的要求，随机序列生成方法（包括所用软件、区组大小及分层因素）、'
                '分配隐藏机制（如密封不透明信封或中央随机化系统）以及执行分配的人员独立性，均须在方法部分明确报告。'
                '建议作者补充：（1）随机序列生成所用软件及具体参数，例如\'使用 SAS 9.4 PROC PLAN 生成随机序列，区组大小为6，按性别分层\'；'
                '（2）分配隐藏的具体方式，例如\'序贯编号的不透明密封信封（SNOSE）由独立于研究的第三方统计师持有\'；'
                '（3）生成序列与执行分配人员的独立性说明。修改后应使读者能独立确认该研究分配隐藏措施的充分性，达到Cochrane偏倚风险评估工具\'低风险\'评定标准。"\n\n'
                '"2、结果部分仅陈述\'差异有统计学意义（P<0.05）\'，未提供具体效应量、置信区间及组间绝对差值，违反CONSORT第17条关于精确报告点估计值与变异指标的要求。'
                '建议在表格及正文中补充：（1）各组均数±标准差；（2）组间均数差及95% CI；（3）所用统计检验方法（如独立样本t检验/Mann-Whitney U检验）。'
                '示范格式：\'干预组较对照组MMSE评分高2.3分（95% CI：1.1–3.5，P=0.002）\'。"'
            )

        return (
            f"\n"
            f"稿件标题: {document_ir.title}\n"
            f"研究类型: {study_types}\n"
            f"\n"
            f"【DocumentIR 摘要（用于事实核查）】\n"
            f"{doc_abstract}\n"
            f"\n"
            f"【已确认存在的章节（代码正则检测，确定性结论——绝对不得声称以下章节缺失！）】\n"
            f"{confirmed_sections_text}\n"
            f"\n"
            f"【认知评估结果（仅供参考，禁止在报告中直接引用评分数字）】\n"
            f"- {novelty_text}\n"
            f"- {contribution_text}\n"
            f"- {method_depth_text}\n"
            f"- {writing_text}\n"
            f"- 文献定位分析: {lit_analysis}\n"
            f"- 方法论深度分析: {method_analysis}\n"
            f"- 学术贡献分析: {contrib_analysis}\n"
            f"- 写作质量分析: {writing_analysis}\n"
            f"- 实用性分析: {operability}\n"
            f"\n"
            f"【认知评审发现的主要弱点（可作为修改意见补充素材）】\n"
            f"{weaknesses_text if weaknesses_text else '无'}\n"
            f"\n"
            f"【Meta审查结果】\n"
            f"- 采纳规范: {', '.join(meta_review.applied_rubrics) if meta_review.applied_rubrics else '通用规范'}\n"
            f"- 总体评价: {meta_review.overall_assessment[:1200]}\n"
            f"\n"
            f"【主要优点】\n"
            f"{chr(10).join(meta_review.key_strengths[:5])}\n"
            f"\n"
            f"【核查后的问题（已去除幻觉）】\n"
            f"{issues_text[:7000] if issues_text.strip() else meta_review.overall_assessment[:1500]}\n"
            f"\n"
            f"【审查覆盖维度（根据研究类型选择适用维度核查，有问题则写入修改意见，确认无问题则跳过）】\n"
            f"{dimension_label}\n"
            f"{dimension_text}\n"
            f"\n"
            f"任务：撰写一份严格的同行评议报告，目标总字数约8000字，不得低于6000字。输出以下 JSON 格式：\n"
            f"\n"
            + "{{\n"
            + '  "outline": "客观描述研究内容（100-150字），无任何评价词，仅供内部参考",\n'
            + "\n"
            + '  "overall_evaluation": "【总体评价】300-500字。结构：①2-3句阐述研究背景与意义；②2-3句概括研究方法与主要发现；③1-2句指出本研究的价值与局限，点明\'仍有若干方面有待完善\'。语言客观专业，禁止套话。",\n'
            + "\n"
            + '  "critical_issues_narrative": "【修改意见】使用全文连续顿号编号（1、2、3、...）分点列出所有问题，每点独立成段，段落之间用空行分隔。绝对禁止使用章节标题（##）。每条意见以连贯散文段落展开，不少于300字，内容须涵盖：①原文在此处的具体做法（引用关键词句，用引号标注）；②违反的规范标准（如CONSORT第X条的具体要求）；③可操作的修改建议——建议必须具体到作者可直接执行的程度，例如：建议补充检索式时须给出示范检索式；建议补充结构段落时须给出段落标题与内容要点示范；建议修改引用语气时须给出改写前后的对比例句；建议系统核查某类问题时须给出具体搜索词或操作指令。不能只说\'建议补充\'而不示范应补充什么。三者融合在流畅的段落叙述中，不使用加粗标签分段。方法学与统计问题优先，写作问题排后。",\n'
            + "\n"
            + '  "minor_suggestions_narrative": "",\n'
            + "\n"
            + '  "recommendation_narrative": "【推荐意见】200-300字。结构：①1-2句给出修改程度建议；②3-4句列举必须修改的核心问题（方法学、统计等关键缺陷）；③1-2句指出修改后的发表潜力与期刊适配性。语气专业，不得出现评分词汇。"\n'
            + "}}\n"
            + f"\n"
            f"【强制格式要求——这是最高优先级指令】\n"
            f"0. 【条数硬性要求】critical_issues_narrative 必须至少包含 {min(len(issues_to_use), 8)} 条独立编号的修改意见。上面传入的【核查后的问题】列表中有 {len(issues_to_use)} 个问题，你必须为每个致命/主要问题都撰写一条详细修改意见，不得只写1-2条就结束。如果问题列表超过10条，至少写8条；如果不足10条，则全部写出。\n"
            f"1. critical_issues_narrative 字段：全文连续编号（1、2、3、...），每点独立成段，段落之间用空行分隔，绝对禁止使用 \"1.\" 点号格式，绝对禁止使用 ## 章节标题，绝对禁止使用**【问题】**/**【要求】**/**【建议】**等加粗标签分段。\n"
            f"2. 每条问题用流畅散文段落展开，将现状描述、规范差距、修改建议融合在一段连贯文字中。每条意见不少于300字。\n"
            f"3. minor_suggestions_narrative 字段：必须输出空字符串\"\"。\n"
            f"4. 所有字段中绝对禁止出现 URVAR_、_rubric: 等内部标签。\n"
            f"5. 字数要求：overall_evaluation 不少于300字，每条修改意见不少于300字，recommendation_narrative 不少于200字。critical_issues_narrative 总字数不得低于5000字。\n"
            f"6. recommendation_narrative 字段不得为空字符串，必须撰写完整的推荐意见（200-300字）。\n"
            f"\n"
            f"【输出示例——散文段落格式，含具体示范（必须严格遵循）】\n"
            f"{example_text}\n"
        )
