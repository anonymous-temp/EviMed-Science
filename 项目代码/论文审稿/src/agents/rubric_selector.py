"""
Rubric Selector Agent - 用 LLM 智能选择最适用的审稿规范

取代 MultiRubricOrchestrator 中的 RUBRIC_PRIORITY 硬编码映射表 + 模糊匹配逻辑。
"""
import logging
from typing import List

from ..schemas.document_ir import DocumentIR, StudyProfile
from ..services.llm_gateway import LLMGateway, ModelTier

logger = logging.getLogger(__name__)


# 可用规范及其适用场景描述（与 src/rubrics/ 目录对齐）
AVAILABLE_RUBRICS: dict = {
    "universal_rubric": "通用学术论文规范，适用于所有类型研究，覆盖创新性、方法学严谨性、报告完整性",
    "prisma_2020":      "系统综述/Meta分析报告规范（PRISMA 2020），要求完整检索策略、文献筛选流程图、偏倚评估。仅适用于 Systematic Review / Meta-Analysis",
    "prisma_scr":       "Scoping Review 报告规范（PRISMA-ScR），要求 PCC 框架和文献筛选流程。仅适用于 Scoping Review",
    "consort_2010":     "随机对照试验报告规范（CONSORT 2010），要求随机化、盲法、样本量计算、CONSORT 流程图。仅适用于 RCT",
    "strobe":           "观察性流行病学研究报告规范（STROBE），适用于队列研究、病例对照研究、横断面研究等原始观察性研究。不适用于综述类文章",
    "stard":            "诊断准确性研究报告规范（STARD），仅适用于诊断试验研究",
    "tripod_ai":        "预测模型/AI 研究报告规范（TRIPOD+AI），仅适用于机器学习模型、临床预测模型研究",
    "arrive":           "动物实验报告规范（ARRIVE 2.0），仅适用于以动物为主要研究对象的原始研究",
    "grade":            "证据等级评价规范（GRADE），适用于临床指南制定或系统综述的证据分级",
    "care":             "病例报告规范（CARE），仅适用于单一病例或小系列病例报告",
    "cheers_2022":      "卫生经济学评价规范（CHEERS 2022），仅适用于成本-效益分析研究",
    "coreq":            "定性研究报告规范（COREQ），仅适用于访谈、焦点小组等定性研究",
}


class RubricSelectorAgent:
    """
    根据论文标题、摘要和初步识别的研究类型，通过 LLM 选择最适用的审稿规范。
    始终包含 universal_rubric，额外最多选 1 个专项规范。
    """

    def __init__(self, llm_gateway: LLMGateway):
        self.llm = llm_gateway

    async def select(
        self,
        document_ir: DocumentIR,
        study_profile: StudyProfile,
    ) -> List[str]:
        """
        返回适用于本篇论文的规范列表（含 universal_rubric，总数 ≤ 2）。
        失败时回退到 ["universal_rubric"]。
        """
        # 构建论文上下文
        title = document_ir.title or "未知标题"
        if document_ir.abstract and hasattr(document_ir.abstract, 'text'):
            abstract = ' '.join(document_ir.abstract.text[:5])[:1000]
        else:
            abstract = "无摘要"
        study_types = ', '.join(study_profile.study_types) if study_profile.study_types else "未知"

        # 构建规范列表说明
        rubric_list = "\n".join(
            f"- {name}: {desc}"
            for name, desc in AVAILABLE_RUBRICS.items()
        )

        prompt = f"""你是医学论文审稿规范专家。请根据以下论文信息，从可用规范列表中为该论文选择最合适的审稿规范。

【论文信息】
标题：{title}
摘要：{abstract}
初步识别的研究类型：{study_types}

【可用规范列表】
{rubric_list}

【选择规则】
1. universal_rubric 必须始终包含。
2. 在此基础上，最多再选 1 个最适合该研究类型的专项规范。
3. 如果论文是叙述性综述（Narrative Review）、文献综述（Literature Review）或"Recent Advances/Overview/A Review of..."类文章，只选 universal_rubric，不得添加任何专项规范。
4. 只根据论文实际研究类型选择，不要因为论文提到动物数据或引用某类研究就选择对应规范（例如：综述文章引用了动物实验，不应选 arrive）。
5. 如果研究类型不明确，只选 universal_rubric。

返回 JSON 格式：
{{"selected": ["universal_rubric", "strobe"], "reasoning": "一句话说明选择理由"}}
或（仅通用规范时）：
{{"selected": ["universal_rubric"], "reasoning": "一句话说明选择理由"}}"""

        try:
            result = await self.llm.call_with_json_response(
                messages=[
                    {"role": "system", "content": "你是医学论文审稿规范选择专家，只输出JSON。"},
                    {"role": "user", "content": prompt}
                ],
                model_tier=ModelTier.FAST,
                temperature=0.0,
                max_tokens=200,
                timeout_sec=60
            )
            parsed = result.get("parsed_json", {})
            selected = parsed.get("selected", [])
            reasoning = parsed.get("reasoning", "")

            # 校验：必须是列表，每项必须是已知规范
            if not isinstance(selected, list) or not selected:
                raise ValueError(f"返回格式异常: {selected}")
            selected = [r for r in selected if r in AVAILABLE_RUBRICS]
            if not selected:
                raise ValueError("返回规范均不在可用列表中")

            # 强制包含 universal_rubric
            if "universal_rubric" not in selected:
                selected.insert(0, "universal_rubric")

            # 最多 2 个（universal_rubric + 1 个专项）
            if len(selected) > 2:
                # 保留 universal_rubric 和得分最高的第一个专项
                non_universal = [r for r in selected if r != "universal_rubric"]
                selected = ["universal_rubric", non_universal[0]]

            print(f"  → [RubricSelector] 选择规范: {selected} | 理由: {reasoning}")
            return selected

        except Exception as e:
            logger.error(f"RubricSelector 失败，回退到 universal_rubric: {e}", exc_info=True)
            print(f"  → [RubricSelector] 失败，回退到 universal_rubric: {e}")
            return ["universal_rubric"]
