"""
输入预处理与意图识别模块 V5.0
新增：输入校验、医学相关性检测、Prompt注入防护、用户引导
"""
import re
import logging
from typing import Dict, List, Optional
from models.schemas import PreprocessedInput

logger = logging.getLogger(__name__)


class InputValidationError(Exception):
    """输入校验错误 - 携带用户友好的提示信息"""

    def __init__(self, message: str, suggestions: List[str] = None):
        self.message = message
        self.suggestions = suggestions or []
        super().__init__(self.message)


class InputValidator:
    """输入校验器 - 前置守门"""

    # Prompt注入检测模式
    INJECTION_PATTERNS = [
        r'ignore\s+(previous|above|all)\s+(instructions?|prompts?)',
        r'disregard\s+(previous|above|all)',
        r'you\s+are\s+now\s+a',
        r'act\s+as\s+(if|a|an)',
        r'forget\s+(everything|all|previous)',
        r'system\s*:\s*',
        r'<\s*/?system\s*>',
        r'```\s*(system|prompt)',
        r'override\s+(instructions?|rules?)',
        r'jailbreak',
    ]

    # 医学/科研相关性信号词（中英文）
    MEDICAL_SIGNAL_WORDS = [
        # 中文
        "治疗", "疾病", "患者", "临床", "药物", "机制", "通路", "基因", "蛋白",
        "细胞", "免疫", "肿瘤", "癌", "炎症", "感染", "手术", "诊断", "预后",
        "生物标志物", "队列", "随机", "对照", "荟萃", "系统评价", "Meta",
        "发病率", "死亡率", "风险", "因素", "综合征", "并发症", "不良反应",
        "疗效", "安全性", "剂量", "给药", "靶点", "受体", "抑制剂", "激动剂",
        "抗体", "疫苗", "检测", "筛查", "影像", "病理", "组学", "测序",
        "代谢", "内分泌", "神经", "心血管", "呼吸", "消化", "肾脏", "肝脏",
        "血液", "骨科", "皮肤", "眼科", "耳鼻喉", "妇产", "儿科", "精神",
        "流行病学", "公共卫生", "护理", "康复", "中医", "针灸", "方剂",
        "研究", "实验", "分析", "综述", "文献", "选题", "课题", "科研",
        "SCI", "论文", "发表", "期刊", "影响因子",
        # 英文
        "treatment", "disease", "patient", "clinical", "drug", "mechanism",
        "pathway", "gene", "protein", "cell", "immune", "tumor", "cancer",
        "inflammation", "infection", "surgery", "diagnosis", "prognosis",
        "biomarker", "cohort", "randomized", "controlled", "meta-analysis",
        "systematic review", "efficacy", "safety", "therapy", "receptor",
        "inhibitor", "antibody", "vaccine", "assay", "screening",
        "metabolic", "cardiovascular", "respiratory", "renal", "hepatic",
        "neurological", "oncology", "hematology", "epidemiology",
        "research", "study", "trial", "experiment", "analysis",
    ]

    # 明显非医学内容的模式
    NON_MEDICAL_PATTERNS = [
        r'^(你好|hello|hi|hey|嗨|哈喽)\s*[!！.。]?\s*$',
        r'^(今天|明天|昨天).*(天气|温度|下雨)',
        r'^(帮我|请).*(写|编|做).*(作文|作业|代码|程序|网站|APP)',
        r'^(讲个|说个|来个).*(笑话|故事|段子)',
        r'^(谁是|什么是).*(总统|主席|明星|歌手|演员)',
    ]

    def validate(self, raw_input: str) -> Optional[InputValidationError]:
        """
        校验用户输入，返回None表示通过，返回Error表示不通过

        Returns:
            None if valid, InputValidationError if invalid
        """
        # 1. 空输入检查
        stripped = raw_input.strip() if raw_input else ""
        if not stripped:
            return InputValidationError(
                "输入内容为空，请输入您想要分析的医学科研问题。",
                suggestions=[
                    "示例：利妥昔单抗治疗膜性肾病的疗效与安全性",
                    "示例：PD-1抑制剂联合化疗在非小细胞肺癌中的研究进展",
                    "示例：肠道菌群与阿尔茨海默病的关系",
                ]
            )

        # 2. 过短输入检查
        # 去掉空格和标点后的有效字符数
        effective_chars = re.sub(r'[\s\W]', '', stripped)
        if len(effective_chars) < 2:
            return InputValidationError(
                f"输入内容过短，请输入您的课题方向或关键词。",
                suggestions=[
                    "示例：长新冠、甲硝唑片、CAR-T疗法",
                    "示例：二甲双胍对2型糖尿病患者心血管预后的影响",
                ]
            )

        # 3. 纯数字/纯符号检查
        if re.match(r'^[\d\s\W]+$', stripped):
            return InputValidationError(
                "输入内容不包含有效的文字信息，请输入医学科研相关的问题。",
                suggestions=[
                    "请用自然语言描述您的研究兴趣或科研问题",
                ]
            )

        # 4. Prompt注入检测
        for pattern in self.INJECTION_PATTERNS:
            if re.search(pattern, stripped, re.IGNORECASE):
                logger.warning(f"检测到可疑的Prompt注入尝试: {stripped[:100]}")
                return InputValidationError(
                    "输入内容包含不支持的指令格式，请直接输入您的医学科研问题。",
                    suggestions=[
                        "请直接描述您想研究的医学问题，例如：某药物治疗某疾病的机制研究",
                    ]
                )

        # 5. 明显非医学内容检测
        for pattern in self.NON_MEDICAL_PATTERNS:
            if re.search(pattern, stripped, re.IGNORECASE):
                return InputValidationError(
                    "本系统专注于医学科研选题分析，暂不支持非医学领域的问题。",
                    suggestions=[
                        "请输入医学/生物医学相关的科研问题",
                        "示例：SGLT2抑制剂对慢性肾脏病进展的影响",
                        "示例：CAR-T细胞治疗复发难治性B细胞淋巴瘤的研究现状",
                    ]
                )

        # 6. 医学相关性检测：只拦截明显的非医学对话句式
        NON_RESEARCH_PATTERNS = [
            r'^(你能做什么|你能干什么|你是谁|你是什么|你叫什么|介绍一下你自己)\s*[?？!！。]?\s*$',
            r'^(你好|hello|hi|hey|嗨|哈喽|早上好|下午好|晚上好)\s*[!！.。]?\s*$',
            r'^(谢谢|感谢|thanks|thank you)\s*[!！.。]?\s*$',
            r'^(好的|好|ok|okay|嗯|哦|啊|哈哈)\s*[!！.。]?\s*$',
            r'^(帮我|请).*(写|编|做).*(作文|作业|代码|程序|网站|APP)',
            r'^(今天|明天|昨天).*(天气|温度|下雨)',
            r'^(讲个|说个|来个).*(笑话|故事|段子)',
        ]
        for pattern in NON_RESEARCH_PATTERNS:
            if re.search(pattern, stripped, re.IGNORECASE):
                return InputValidationError(
                    "本系统专注于医学科研选题分析，请输入您想要分析的医学科研问题。",
                    suggestions=[
                        "请输入医学/生物医学相关的科研问题或关键词",
                        "示例：利妥昔单抗治疗膜性肾病的疗效与安全性",
                        "示例：肠道菌群与阿尔茨海默病的关系",
                        "示例：metformin type 2 diabetes cardiovascular outcomes",
                    ]
                )

        return None  # 校验通过


class IntentClassifier:
    """
    三维意图识别器
    输出三维意图的初步猜测值，作为先验知识注入LLM标准化Prompt
    """

    # 科研阶段关键词库
    STAGE_KEYWORDS = {
        'exploration': ["现状", "最近", "研究进展", "热点", "概况", "综述", "总结"],
        'gap_hunting': ["空白", "创新", "未解决", "缺乏", "不足", "缺口", "机会"],
        'idea_validation': ["可行吗", "是否可以", "有没有人做过", "值得做吗", "有意义吗"],
        'feasibility_check': ["能发SCI吗", "样本量够不够", "发表概率", "成功率", "难度"],
        'design_help': ["如何设计", "样本量", "研究方案", "分组", "怎么开展", "实验设计"],
        'publication_strategy': ["投什么期刊", "发表策略", "提高录用率", "选刊", "投稿建议"]
    }

    # 问题结构句法模式
    QUESTION_PATTERNS = {
        'association_question': ["是否影响", "是否相关", "有关联吗", "关系如何"],
        'causal_question': ["导致", "引起", "因果", "造成", "诱发"],
        'comparative_question': ["vs", "对比", "哪个更好", "比较", "优于", "差于"],
        'predictive_question': ["预测", "预后", "风险因素", "危险因素", "影响因素"],
        'mechanism_question': ["通过什么机制", "通路", "信号通路", "分子机制", "如何作用"],
        'optimization_question': ["如何提高", "优化", "改善", "增强", "降低"],
        'evidence_summary': ["现有证据", "Meta分析", "系统评价", "荟萃分析", "总结证据"],
        'uncertainty_question': ["为什么结果不一致", "争议", "矛盾", "分歧", "尚无定论"]
    }

    # 研究设计类型识别模式
    TYPE_PATTERNS = {
        'meta_analysis': [r'meta[-\s]?analysis', r'systematic\s+review', r'荟萃分析', r'系统评价'],
        'mr_study': [r'mendelian\s+randomization', r'孟德尔随机化', r'因果推断'],
        'mechanism': [r'pathway', r'signaling', r'通路', r'机制', r'RAW264\.7', r'HepG2', r'细胞实验'],
        'clinical_case': [r'患者', r'病例', r'ADR', r'不良反应', r'临床观察'],
        'paper_title': [r'induces?', r'inhibits?', r'promotes?', r'via\s+', r'through\s+']
    }

    def classify(self, text: str) -> Dict:
        """
        对输入文本进行三维意图识别
        """
        preliminary_type = self._guess_preliminary_type(text)
        stage_intent_guess = self._guess_stage(text)
        question_structure_guess = self._guess_question_structure(text)
        confidence_guess = self._calculate_confidence(text, stage_intent_guess, question_structure_guess)

        return {
            "preliminary_type": preliminary_type,
            "stage_intent_guess": stage_intent_guess,
            "question_structure_guess": question_structure_guess,
            "confidence_guess": confidence_guess
        }

    def _guess_preliminary_type(self, text: str) -> str:
        """识别研究设计类型"""
        scores = {}
        for type_name, patterns in self.TYPE_PATTERNS.items():
            matches = sum(1 for p in patterns if re.search(p, text, re.IGNORECASE))
            scores[type_name] = min(matches / len(patterns) * 1.5, 1.0)

        if not scores or max(scores.values()) < 0.3:
            return 'general_query'
        return max(scores, key=scores.get)

    def _guess_stage(self, text: str) -> str:
        """识别科研阶段意图"""
        for stage, keywords in self.STAGE_KEYWORDS.items():
            if any(kw in text for kw in keywords):
                return stage
        return "unknown"  # 返回unknown而非默认值，让后续流程知道这是猜测

    def _guess_question_structure(self, text: str) -> str:
        """识别问题结构"""
        for structure, patterns in self.QUESTION_PATTERNS.items():
            if any(p in text for p in patterns):
                return structure
        return "unknown"  # 返回unknown而非默认值

    def _calculate_confidence(self, text: str, stage: str, structure: str) -> float:
        """计算综合置信度"""
        confidence = 0.3  # 基础置信度（降低，因为unknown情况更多了）

        # 如果匹配到了明确的阶段意图
        if stage != "unknown":
            confidence += 0.2
            stage_matches = sum(1 for kw in self.STAGE_KEYWORDS.get(stage, []) if kw in text)
            if stage_matches >= 2:
                confidence += 0.1

        # 如果匹配到了明确的问题结构
        if structure != "unknown":
            confidence += 0.2
            structure_matches = sum(1 for p in self.QUESTION_PATTERNS.get(structure, []) if p in text)
            if structure_matches >= 2:
                confidence += 0.1

        # 输入长度加成
        if len(text) > 20:
            confidence += 0.1

        return min(confidence, 1.0)


class InputPreprocessor:
    """输入预处理器 V5.0 - 增加前置校验"""

    def __init__(self):
        self.validator = InputValidator()
        self.intent_classifier = IntentClassifier()

    def validate(self, raw_input: str) -> Optional[InputValidationError]:
        """
        前置校验（在process之前调用）

        Returns:
            None if valid, InputValidationError if invalid
        """
        return self.validator.validate(raw_input)

    def process(self, raw_input: str) -> PreprocessedInput:
        """
        输入预处理主流程

        Args:
            raw_input: 用户原始输入

        Returns:
            PreprocessedInput: 预处理后的输入对象
        """
        # Step 1: 基础清洗
        cleaned = self._clean_text(raw_input)

        # Step 2: 语言检测
        language = self._detect_language(cleaned)

        # Step 3: 长度归一化
        normalized = self._normalize_length(cleaned)

        # Step 4: 特殊字符处理
        sanitized = self._sanitize_special_chars(normalized)

        # Step 5: 三维意图识别
        intent_guess = self.intent_classifier.classify(sanitized)

        # 计算词数（简单按空格分割，中文按字符）
        word_count = len(sanitized.split()) if language == 'en' else len(sanitized)

        # 对unknown的意图做合理的默认映射
        stage = intent_guess['stage_intent_guess']
        if stage == "unknown":
            stage = "exploration"

        structure = intent_guess['question_structure_guess']
        if structure == "unknown":
            structure = "association_question"

        return PreprocessedInput(
            original=raw_input,
            cleaned=sanitized,
            language=language,
            char_count=len(sanitized),
            word_count=word_count,
            preliminary_type=intent_guess['preliminary_type'],
            stage_intent_guess=stage,
            question_structure_guess=structure,
            confidence_guess=intent_guess['confidence_guess']
        )

    def _clean_text(self, text: str) -> str:
        """清洗文本：去除多余空白、统一编码"""
        text = re.sub(r'\s+', ' ', text)
        text = text.strip()
        return text

    def _detect_language(self, text: str) -> str:
        """检测主要语言"""
        chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
        total_chars = len(text.replace(' ', ''))
        if total_chars == 0:
            return 'unknown'
        chinese_ratio = chinese_chars / total_chars
        return 'zh' if chinese_ratio > 0.3 else 'en'

    def _normalize_length(self, text: str, max_length: int = 5000) -> str:
        """长度归一化：超长输入截断"""
        if len(text) > max_length:
            return text[:max_length] + "..."
        return text

    def _sanitize_special_chars(self, text: str) -> str:
        """特殊字符处理"""
        text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
        return text
