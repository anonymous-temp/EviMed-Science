"""
M1-M6 模块 Prompt 配置汇总文件
参考PromptUtil.java风格重写 - 深度机制分析、核心矛盾识别、转化路径探索
"""

# ==================== M1: 科研问题全景分析 ====================
M1_PROBLEM_LANDSCAPE_PROMPT = """你是一位科研能力卓越的临床医生与医学科学家，在{query_context}相关领域具有深厚积累，擅长从复杂临床现象中提炼核心科学问题。

## 研究主题
{query_context}

## 文献数据
- 时间跨度: {min_year} - {max_year}
- 年度发文趋势: {trend_data}
- 核心主题分布: {theme_list}
- 研究设计构成: {design_distribution}

---

## 分析任务

### 一、科学张力识别（Scientific Tensions）
从以下维度识别该领域最核心的"解释张力"——即现象与理论之间的认知缺口：

1. **疗效-机制张力**
   - 临床观察到的疗效现象与已知作用机制之间的不匹配
   - 疗效个体差异的生物学基础未明

2. **证据-实践张力**
   - 指南推荐与真实世界临床实践之间的落差
   - 现有证据在特定人群中的外推性局限

3. **短期-长期张力**
   - 短期疗效与长期安全性/预后之间的平衡难题
   - 急性期干预对慢性病程的深远影响未知

### 二、问题空间结构化（Problem Space Tree）
构建三层问题架构：

**顶层科学问题**（决定研究方向的根本问题）
- 该领域最核心的3-5个待解科学问题
- 每个问题标注：已被稳定回答/存在争议/尚未形成解释框架

**机制层子问题**（通路、细胞、分子层级）
- 药物-靶器官交互的分子机制
- 免疫调节网络的级联效应
- 器官损伤与修复的动态平衡

**应用层问题**（临床转化层级）
- 精准分层治疗的生物标志物体系
- 个体化给药方案的决策模型
- 疗效预测与风险预警的整合策略

### 三、科研范式阶段判断
基于主题演化轨迹和研究类型变迁，判断领域处于：
- **发现期**：机制探索为主，假说快速迭代
- **整合期**：零散发现向系统理论凝聚
- **转化推进期**：基础成果向临床方案转化
- **平台/瓶颈期**：研究量大但突破性进展缓慢

### 四、研究重心迁移的逻辑解释
分析研究热点的时空演化：
- 技术驱动型迁移：新技术（如单细胞测序）带来的研究视角转变
- 机制瓶颈型迁移：现有理论无法解释的现象催生的新方向
- 临床需求型迁移：未满足的医疗需求引导的研究聚焦

---

## 输出要求

输出JSON格式：
{{
  "domain_stage": "发现期/整合期/转化推进期/平台或瓶颈期",
  "stage_reasoning": "判断依据（200字）",
  "scientific_tensions": [
    {{
      "tension_id": "T1",
      "tension_type": "疗效-机制/证据-实践/短期-长期",
      "description": "张力描述（具体现象与理论的冲突）",
      "manifestation": "在文献中的具体表现",
      "underlying_cause": "深层原因分析（生物学/方法学层面）"
    }}
  ],
  "problem_space_tree": {{
    "top_level": [
      {{
        "problem_id": "P1",
        "problem_statement": "核心科学问题陈述",
        "level": "顶层",
        "status": "已被稳定回答/存在争议/尚未形成解释框架",
        "evidence_strength": "强/中/弱",
        "research_frontier": "该问题在学科前沿中的位置"
      }}
    ],
    "mechanism_level": [
      {{
        "problem_id": "M1",
        "problem_statement": "机制层问题",
        "pathway_focus": "关键通路/靶点",
        "knowledge_gap": "机制认知缺口"
      }}
    ],
    "application_level": [
      {{
        "problem_id": "A1",
        "problem_statement": "应用层问题",
        "clinical_scenario": "临床应用场景",
        "translation_barrier": "转化障碍"
      }}
    ]
  }},
  "research_evolution": {{
    "early_stage": {{
      "period": "早期时间段",
      "focus": "研究焦点",
      "driving_factor": "推动因素"
    }},
    "mid_stage": {{
      "period": "中期时间段",
      "shift": "转向焦点",
      "catalyst": "转折点"
    }},
    "current": {{
      "period": "当前",
      "hot_topics": "当前热点",
      "saturated_areas": "已饱和领域"
    }},
    "emerging": {{
      "trends": "正在浮现的趋势",
      "emerging_questions": "新兴科学问题"
    }}
  }},
  "deep_analysis": "综合科学解释（600-800字，禁止泛泛而谈，必须有具体机制阐释和矛盾分析）"
}}

---

## 严格禁止
1. 禁止出现"需要更多研究"等无实质内容的表述
2. 禁止简单罗列"缺RCT、缺队列研究"等研究类型缺失
3. 禁止模板化、套路化表述
4. 必须有具体的机制阐释和矛盾分析
5. **所有字段值必须使用中文输出，包括 deep_analysis 字段**
"""
M2_RESEARCH_ECOSYSTEM_PROMPT = """你是一位科学计量学与科研生态分析专家，擅长从知识生产结构角度解读学科发展态势，能够从作者网络、期刊分布、机构合作中识别领域创新生态特征。

## 研究主题
{query_context}

## 数据信息
- 总文献数: {evidence_count}
- 研究热点分布: {hotspot_distribution}
- 核心作者分布: {top_authors}
- 主要发文期刊: {top_journals}
- 合作网络密度: {network_density}
- 知识社区数量: {community_count}

---

## 分析任务

### 一、研究热点解析
基于研究热点分布数据，深度分析该领域的研究重心：
- **各热点方向的相对比重**：哪些方向文献最密集、哪些方向存在空白
- **治疗/干预研究特征**：药物/手术/新疗法的主流方向和争议
- **诊断/检测研究特征**：当前主流诊断工具及生物标志物进展
- **病理机制研究特征**：分子机制研究的深度及转化潜力
- **热点演变趋势**：结合时间维度，分析哪些方向处于上升或饱和阶段

### 二、知识生产结构类型判断
识别该领域知识生产的组织形态：

**集中型结构的特征与影响**
- 少数核心团队主导研究议程
- 理论框架和方法论的同质化风险

**分散型结构的特征与影响**
- 研究议题碎片化，缺乏系统性整合
- 多中心独立探索带来的创新多样性

**协同网络型结构的特征与影响**
- 跨机构、跨国合作的密集程度
- 知识流动的网络拓扑特征

### 三、知识网络成熟度评估
- 主题共现网络的连通性与聚类特征
- 研究议题的离散程度（是否存在孤立主题）
- 跨热点方向整合的活跃程度

### 四、生态结构对创新的深层影响
- 当前热点格局如何塑造研究问题的选择
- 哪些研究方向存在明显空白可供突破
- 突破现有范式的切入点可能在哪里

---

## 输出要求

输出JSON格式：
{{
  "research_structure": {{
    "structure_type": "集中型/分散型/协同网络型",
    "structural_features": "结构特征描述",
    "innovation_implications": "对创新的深层影响（300字）"
  }},
  "dominance_analysis": {{
    "has_dominant_group": true/false,
    "core_authors": ["作者1", "作者2"],
    "influence_mechanism": "影响力作用机制",
    "cognitive_lock_in_risk": "认知锁定风险评估"
  }},
  "journal_structure": {{
    "primary_level": "基础机制层/临床转化层/技术方法层",
    "journal_concentration": "期刊集中度",
    "implication": "研究层级判断依据"
  }},
  "knowledge_network": {{
    "maturity": "成熟/发展中/碎片化",
    "integration_degree": "高/中/低",
    "island_phenomenon": "是否存在议题孤岛",
    "cross_theme_bridges": "跨主题连接点"
  }},
  "ecological_bottlenecks": [
    {{
      "bottleneck_type": "结构瓶颈类型",
      "manifestation": "具体表现",
      "impact_on_innovation": "如何影响突破性创新"
    }}
  ],
  "deep_analysis": "综合科学解释（600-800字，聚焦结构如何塑造知识生产）"
}}

---

## 严格禁止
1. 禁止简单计量描述（如"张三发了10篇"）
2. 禁止无关的结构分析
3. 必须解释结构对科研进展的"因果含义"
4. **所有字段值必须使用中文输出，包括 deep_analysis 字段**
"""


# ==================== M3: 证据体系结构诊断 ====================
M3_EVIDENCE_SYSTEM_PROMPT = """你是一位转化医学与循证医学专家，擅长诊断知识转化链条中的结构性瓶颈，能够从证据分布中识别"机制-临床"断裂点。

## 研究主题
{query_context}

## 证据体系数据
- 证据金字塔分布: {pyramid}
- 证据链路各环节：
  * 机制研究: {mechanism_count}篇 (强度: {mechanism_strength})
  * 动物研究: {animal_count}篇 (强度: {animal_strength})
  * 人群观察: {human_count}篇 (强度: {human_strength})
  * 临床终点: {clinical_count}篇 (强度: {clinical_strength})
- 主题-研究类型矩阵: {matrix}

---

## 分析任务

### 一、证据链路的结构性分析
构建"机制→动物→人群→临床终点→长期预后"的完整证据链：

**各环节的证据成熟度评估**
- 体外机制研究的深度与可转化性
- 动物模型的临床相关性（face validity, construct validity）
- 人群研究的代表性偏倚风险
- 临床终点研究的硬终点覆盖率

**链条连通性判断**
- 相邻环节之间的逻辑连接是否顺畅
- 知识流动的"断点"位置
- 断裂的类型（机制孤岛/临床黑箱/桥接缺失/结局短视）

### 二、结构性断裂类型识别
识别该领域证据体系的断裂模式：

**机制孤岛型**
- 特征：机制研究丰富但无法走向临床
- 原因：缺乏临床相关的生物标志物；机制与临床表型的对应关系不明

**临床黑箱型**
- 特征：临床疗效明确但机制解释薄弱
- 原因：多因素混杂；观察性研究无法确证因果关系

**桥接缺失型**
- 特征：基础与临床之间存在证据断层
- 原因：缺乏转化研究平台；中间验证环节缺失

**结局短视型**
- 特征：短期终点多，长期预后数据匮乏
- 原因：随访难度大；研究周期与资助周期不匹配

### 三、跨域接口信号识别
针对每种断裂类型，识别可能引入的外部知识体系：

| 断裂类型 | 可能引入的外部知识 |
|---------|------------------|
| 机制孤岛 | 系统生物学、代谢组学、免疫组学 |
| 临床黑箱 | 多组学因果推断、数字孪生、真实世界证据 |
| 桥接缺失 | 成像技术、液体活检、类器官模型 |
| 结局短视 | 健康经济学、长期队列、生存分析新方法 |

---

## 输出要求

输出JSON格式：
{{
  "evidence_chain": {{
    "mechanism": {{
      "exists": true/false,
      "maturity": "高/中/低",
      "translatability": "可转化性评估",
      "connected_to_next": true/false
    }},
    "animal": {{
      "exists": true/false,
      "model_validity": "模型有效性",
      "clinical_relevance": "临床相关性"
    }},
    "human_observational": {{
      "exists": true/false,
      "representativeness": "代表性",
      "bias_risk": "偏倚风险"
    }},
    "clinical_endpoint": {{
      "exists": true/false,
      "hard_endpoint_coverage": "硬终点覆盖度"
    }}
  }},
  "chain_completeness": 0.0,
  "fracture_type": "机制孤岛型/临床黑箱型/桥接缺失型/结局短视型",
  "fracture_analysis": {{
    "fracture_location": "断裂位置",
    "fracture_mechanism": "断裂形成机制",
    "impact_on_translation": "对转化的影响"
  }},
  "cross_domain_signals": [
    {{
      "bottleneck": "瓶颈描述",
      "external_knowledge": "可引入的外部知识",
      "integration_pathway": "整合路径"
    }}
  ],
  "deep_analysis": "综合科学解释（600-800字，聚焦证据链断裂的深层原因）"
}}

---

## 严格禁止
1. 禁止简单罗列"缺RCT、缺队列研究"等
2. 禁止"需要更多研究"等无实质内容表述
3. 必须指出"结构卡在哪里"以及"为什么卡住"
4. **所有字段值必须使用中文输出，包括 deep_analysis 字段**
"""


# ==================== M4: 科学争议与矛盾分析 ====================
M4_SCIENTIFIC_CONTRADICTION_PROMPT = """你是一位循证医学批判性研究者和科学哲学专家，擅长识别证据体系中的结构性冲突，能够从"答案不一致"中发现科研突破的契机。

## 研究主题
{query_context}

## 证据数据
- 研究设计分布: {design_distribution}
- 可核对的文献标题与摘要（每条含PMID和研究设计）:
{evidence_context}

---

## 分析任务

### 一、结构性证据冲突识别
最多识别3个核心科学矛盾。只有上方证据库中存在两组可核对的直接冲突证据时才能输出；
如果没有真实冲突，必须输出空数组，不得为了满足数量而构造矛盾。可考虑以下维度：

**1. 机制-临床冲突**
- 表现：体外/动物实验支持的机制与临床观察结果不一致
- 典型案例：机制通路激活但临床无效，或临床有效但机制不明

**2. 观察-干预冲突**
- 表现：队列研究显示关联但RCT未能验证因果关系
- 可能原因：未测量的混杂因素；适应性设计缺陷

**3. 人群异质性冲突**
- 表现：不同亚组（年龄、疾病分期、基因型）结果相反
- 意义：提示"一刀切"治疗方案的局限性

**4. 短期-长期冲突**
- 表现：短期疗效与长期预后方向相反
- 典型案例：症状改善但长期并发症增加

### 二、矛盾的结构性来源分析
对每个矛盾，深入分析其产生根源：

**人群异质性来源**
- 疾病内型（endotype）的生物学差异
- 遗传背景对治疗反应的影响
- 合并症与多重用药的交互作用

**方法学偏倚来源**
- 观察性研究的残余混杂
- RCT的入选标准与真实世界差异
- 结局指标定义的不一致性

**机制解释缺失来源**
- 现有理论模型的简化假设
- 多通路交互作用的复杂性
- 非线性效应与阈值效应

### 三、矛盾的科研含义阐释
解释这些矛盾对学科发展的意义：

- **是否揭示精准医学机会**：亚组特异性治疗的潜在价值
- **是否提示研究范式调整**：从平均效应到个体化效应的转变
- **是否指向理论缺陷**：现有机制模型是否需要修正

### 四、矛盾转化为突破路径
为每个核心矛盾设计"最短解决路径"：

- **机制-临床冲突**：设计机制桥接标志物研究，建立生物标志物-临床疗效关联
- **观察-RCT冲突**：开展目标试验模拟（target trial emulation）或实用性RCT
- **亚组冲突**：构建分层因果模型，识别效应修饰因子
- **结局冲突**：设计复合终点或序贯终点研究

---

## 输出要求

输出JSON格式：
{{
  "contradictions": [
    {{
      "contradiction_id": "C1",
      "contradiction_type": "机制-临床/观察-干预/人群异质性/短期-长期",
      "title": "矛盾标题（15字内，用于图表和章节标题，如：NSAIDs疗效与前列腺素假说的冲突）",
      "description": "矛盾描述（30字内，简洁明确）",
      "manifestation": "在文献中的具体表现",
      "evidence_A": "支持观点A的证据",
      "evidence_A_pmids": ["仅限上方证据库中的PMID"],
      "evidence_B": "支持观点B的证据",
      "evidence_B_pmids": ["仅限上方证据库中的PMID"],
      "structural_sources": ["人群异质性", "方法学偏倚", "机制缺失"],
      "root_cause": "根本原因分析（300字）",
      "scientific_implication": "对科研的启示",
      "resolution_path": "最短解决路径（具体研究设计）",
      "intensity": 0.8
    }}
  ],
  "knowledge_fractures": [
    {{
      "fracture_id": "F1",
      "location": "知识断裂位置",
      "description": "断裂描述",
      "bridging_opportunity": "桥接机会"
    }}
  ],
  "paradigm_shift_signal": "是否提示范式转换",
  "precision_medicine_opportunity": "精准医学机会分析",
  "deep_analysis": "综合科学解释（600-800字，聚焦矛盾如何指向突破）"
}}

---

## 严格禁止
1. 禁止"需要更多研究"等泛化结论
2. 禁止简单描述不一致现象而不分析原因
3. 每个矛盾必须对应具体的突破路径
4. intensity 字段必须为 0-1 之间的小数，反映该矛盾的证据冲突激烈程度：
   - 0.8-1.0：大量直接证据互相矛盾，临床影响显著
   - 0.5-0.8：有明确证据冲突但存在解释空间
   - 0.2-0.5：间接冲突，证据有限
5. **所有字段值必须使用中文输出，包括 deep_analysis 字段**
6. evidence_A_pmids 和 evidence_B_pmids 必须各至少含1个不同的真实PMID，且文献摘要必须直接支持对应叙述
7. 不得写证据库中未出现的试验名、数据库、生物标志物、机制或结局；不得使用“一致否定”、“已证实”等绝对措辞
"""


# ==================== M5: 跨域知识关联分析 ====================
M5_BREAKTHROUGH_OPPORTUNITY_PROMPT = """你是一位跨学科科研创新战略专家，擅长从成熟学科向本领域引入新理论、新技术、新方法，能够构建"当前领域瓶颈→外部知识体系→桥接假说→验证路径"的完整创新链条。

## 研究主题
{query_context}

## 输入信号
- 已识别的结构瓶颈: {bridge_gaps}
- 已识别的科学矛盾: {contradictions}

## 可核对证据库
{evidence_context}

---

## 分析任务

### 一、跨域知识坐标映射
可以从机制、技术/方法、系统层级、研究范式等维度寻找外部成熟体系，但必须由上方证据库中的标题/摘要触发。
示例技术或机制不是待选清单；如果证据未出现铁死亡、肠-肾轴、空间组学等概念，就不得将它们写成已有发现或优先方向。
优先迁移证据中已有信号直接指向的方法，例如临床试验、因果推断、模型引导给药或真实世界证据。

### 二、桥接假说生成
针对每个识别出的瓶颈，构建连接当前领域与外部知识的桥接假说：

**桥接假说的要素**：
1. **当前瓶颈**：本领域卡在哪里（具体、精确）
2. **外部成熟体系**：哪个领域的什么知识/技术
3. **理论连接点**：两者在机制/结构上的关联依据
4. **科学合理性**：为什么这个迁移是合理的（文献支持）
5. **创新预期**：成功后的理论/临床价值

**示例**（仅供参考格式，请根据实际研究主题生成）：
- 瓶颈：某药物疗效个体差异机制不清
- 外部体系：铁死亡调控网络（已成熟于肿瘤领域）
- 连接点：靶细胞代谢重编程影响药物敏感性，铁死亡调控因子可能参与
- 假说：该药物通过调节靶细胞铁死亡敏感性影响疗效

### 三、突破机会详细设计
为每个桥接假说设计完整的突破路径：

**突破机会要素**：
- **假说标题**：简洁有力的表述
- **科学创新点**：与现有研究的本质区别
- **理论支撑**：跨域知识迁移的依据
- **验证路径**：具体实验/临床研究设计
- **预期影响**：成功后的学术和临床价值
- **风险因素**：可能失败的原因及应对

---

## 输出要求

输出JSON格式：
{{
  "cross_domain_mapping": {{
    "mechanism_axis": ["铁死亡", "铜死亡", "代谢重编程", "免疫代谢"],
    "technology_axis": ["空间组学", "单细胞测序", "类器官", "AI算法"],
    "system_axis": ["器官互作", "微环境", "时间维度"],
    "paradigm_axis": ["因果推断", "系统生物学", "真实世界证据"]
  }},
  "bridge_hypotheses": [
    {{
      "hypothesis_id": "H1",
      "current_bottleneck": "当前瓶颈（精确描述）",
      "external_domain": "外部成熟领域",
      "external_knowledge": "具体知识/技术",
      "theoretical_connection": "理论连接点（机制关联）",
      "bridge_hypothesis": "桥接假说（可验证的科学陈述）",
      "scientific_basis": "科学依据（文献支持）",
      "expected_breakthrough": "预期突破点"
    }}
  ],
  "breakthrough_opportunities": [
    {{
      "opportunity_id": "BOM1",
      "title": "突破机会标题",
      "type": "机制迁移/技术迁移/范式迁移",
      "bridge_hypothesis_id": "关联假说ID",
      "scientific_innovation": "科学创新点（与现有研究的本质区别）",
      "theoretical_foundation": "理论基础（跨域迁移的合理性）",
      "validation_pathway": "验证路径（具体研究设计，分阶段）",
      "expected_impact": {{
        "theoretical": "理论贡献",
        "clinical": "临床价值",
        "methodological": "方法学贡献"
      }},
      "risk_assessment": "风险因素与应对",
      "evidence_pmids": ["必须来自上方证据库的PMID"],
      "support_level": "direct/indirect/speculative",
      "priority_score": 0.0,
      "feasibility_score": 0.0,
      "novelty_score": 0.0,
      "clinical_impact_score": 0.0
    }}
  ],
  "deep_analysis": "综合科学解释（800-1000字，深度阐述跨域创新的逻辑与前景）"
}}

---

## 严格禁止
1. **绝对禁止**仅在本领域内部找空白
2. **必须**跨至少两个知识维度进行联想
3. **必须**生成具体的、可验证的桥接假说
4. **禁止**泛泛的"建议引入XX技术"而无具体假说
5. 每个突破机会必须给出至少1个真实PMID；不得编造PMID，不得引用证据库以外的具体研究发现
6. 间接或推测性证据必须显式标注为“待验证假说”，禁止使用“已证实”“最新研究表明”等措辞
7. **所有字段值必须使用中文输出，包括 deep_analysis 字段**
"""


# ==================== M6: 研究议程与选题规划 ====================
M6_RESEARCH_AGENDA_PROMPT = """你是一位资深临床研究设计师和科研战略顾问，擅长将前沿科学发现转化为可执行的研究项目，能够设计具有发表潜力和临床影响力的研究方案。

## 研究主题
{query_context}

## 证据基础
- 文献总量: {evidence_count}篇
- 临床研究占比: {clinical_ratio:.1%}

## 突破机会
{opportunities}

---

## 分析任务

### 一、高价值研究选题设计
基于上方"突破机会"列表，为每个突破机会设计1个对应的高质量研究选题（突破机会有几个就设计几个选题，一一对应，不得遗漏）：

每个选题必须在标题和 source_opportunity_id 字段中明确标注来源于哪个突破机会（BOM1/BOM2/BOM3...），体现"突破机会→具体选题"的逻辑链条，让读者能直接看出对应关系。

**选题设计标准**：

1. **科学创新性**
   - 解决明确的知识缺口或科学矛盾
   - 引入新理论、新技术或新视角
   - 形成可证伪、可复核的新增证据

2. **临床相关性**
   - 回应未满足的临床需求
   - 结果可直接或间接改善患者结局
   - 如果后续证据足够，可为指南讨论提供依据

3. **可行性**
   - 样本量可及
   - 技术平台可获取
   - 时间框架合理

4. **发表可行性**
   - 目标期刊仅作为候选，投稿前必须核对当前收稿范围
   - 不预测影响因子或中稿结果
   - 客观说明方法学贡献与主要限制

**每个选题的完整要素**：
- **标题**：符合顶刊发表规范的表述
- **核心假说**：可证伪的科学陈述
- **研究设计**：具体类型及理由
- **PICO结构**：
  * P (Population)：精确的人群定义与入排标准
  * I (Intervention)：详细的干预措施描述
  * C (Comparison)：对照选择的依据
  * O (Outcome)：主要终点与次要终点，测量方法
- **样本量**：只能作为规划性假设，必须明示“需用先导数据与预注册主要结局正式重算”；不得伪称具体发生率来自未引用文献
- **创新卖点**：3个核心创新点
- **发表策略**：目标期刊、文章类型、关键信息

### 二、研究议程分层规划
构建短期-中期-长期的研究路线图：

**短期（0-12个月）**
- 可行性验证与预实验
- 伦理审批与注册
- 团队组建与协作网络搭建

**中期（1-3年）**
- 主要数据收集
- 中期分析与调整
- 初步结果发表

**长期（3-5年）**
- 最终分析与主论文发表
- 后续研究拓展
- 临床转化推进

### 三、资源配置与风险管理
**关键资源**：
- 核心合作者（跨学科专家）
- 技术平台（组学、影像、计算）
- 资助策略（国自然、重点研发、国际合作）

**风险识别与缓解**：
- 技术风险：备用方案
- 入组风险：多中心策略
- 竞争风险：快速发表与持续创新

---

## 输出要求

输出JSON格式：
{{
  "research_topics": [
    {{
      "topic_id": "R1",
      "title": "研究标题（顶刊风格）",
      "source_opportunity_id": "BOM1",
      "source_opportunity_title": "对应的突破机会标题（与第6章完全一致）",
      "source_evidence_pmids": ["从突破机会原样复制，不得新增"],
      "support_level": "direct/indirect/speculative",
      "priority": "高/中/低",
      "priority_score": 0.0,
      "feasibility_score": 0.0,
      "novelty_score": 0.0,
      "hypothesis": "核心假说",
      "study_design": {{
        "type": "研究类型",
        "rationale": "设计选择的依据"
      }},
      "pico": {{
        "population": "精确人群定义",
        "intervention": "详细干预描述",
        "comparison": "对照及选择依据",
        "outcome": "主要/次要终点"
      }},
      "sample_size": {{
        "estimated_n": "样本量",
        "calculation_basis": "估算依据"
      }},
      "innovation_points": ["创新点1", "创新点2", "创新点3"],
      "publication_strategy": {{
        "target_journals": ["期刊1", "期刊2"],
        "article_type": "Article/Review/Letter",
        "key_selling_points": ["卖点1", "卖点2"],
        "expected_impact_factor": "预期IF范围"
      }},
      "timeline": "预期时间框架",
      "resource_requirements": "关键资源需求"
    }}
  ],
  "research_roadmap": {{
    "short_term": {{
      "duration": "0-12个月",
      "objectives": ["目标1", "目标2"],
      "key_tasks": ["任务1", "任务2"],
      "deliverables": ["交付物1", "交付物2"]
    }},
    "medium_term": {{
      "duration": "1-3年",
      "objectives": ["目标1", "目标2"],
      "key_tasks": ["任务1", "任务2"],
      "deliverables": ["交付物1", "交付物2"]
    }},
    "long_term": {{
      "duration": "3-5年",
      "objectives": ["目标1", "目标2"],
      "key_tasks": ["任务1", "任务2"],
      "deliverables": ["交付物1", "交付物2"]
    }}
  }},
  "resource_plan": {{
    "key_collaborators": ["合作者类型1", "合作者类型2"],
    "technical_platforms": ["平台1", "平台2"],
    "funding_strategy": "资助申请策略"
  }},
  "risk_management": [
    {{
      "risk": "风险描述",
      "likelihood": "高/中/低",
      "impact": "高/中/低",
      "mitigation": "缓解策略"
    }}
  ],
  "deep_analysis": "综合科学解释（600-800字，阐述研究议程的学术逻辑）"
}}

---

## 严格禁止
1. 禁止泛泛的"建议开展XX研究"而无具体设计
2. 禁止脱离前期分析的孤立选题
3. 必须有具体的PICO和发表策略
4. source_evidence_pmids 和 support_level 必须从对应突破机会原样复制，不得编造新PMID
5. support_level 为 speculative 时，标题和假说必须明示“待验证”，不得写成已被证实的机制
6. **所有字段值必须使用中文输出，包括 deep_analysis 字段**
7. 所有选题的 hypothesis 都必须以“待验证：”开头；不得使用“首次”、“改写指南”、“开启新纪元”、“必然”等宣传或绝对措辞
8. 不得声称尚未提供的模型“已训练”、数据共享“已完成”或伦理审批“已获得”
"""


# ==================== 字段说明汇总 ====================
FIELD_MAPPINGS = {
    "M1": {
        "fields": ["domain_stage", "scientific_tensions", "problem_space_tree", "research_evolution", "deep_analysis"],
        "focus": "科学张力识别与问题空间结构化"
    },
    "M2": {
        "fields": ["research_structure", "dominance_analysis", "journal_structure", "knowledge_network", "deep_analysis"],
        "focus": "知识生产结构与创新生态"
    },
    "M3": {
        "fields": ["evidence_chain", "chain_completeness", "fracture_type", "cross_domain_signals", "deep_analysis"],
        "focus": "证据链断裂与跨域接口"
    },
    "M4": {
        "fields": ["contradictions", "knowledge_fractures", "paradigm_shift_signal", "precision_medicine_opportunity", "deep_analysis"],
        "focus": "科学矛盾与突破路径"
    },
    "M5": {
        "fields": ["cross_domain_mapping", "bridge_hypotheses", "breakthrough_opportunities", "deep_analysis"],
        "focus": "跨域桥接假说与突破机会"
    },
    "M6": {
        "fields": ["research_topics", "research_roadmap", "resource_plan", "risk_management", "deep_analysis"],
        "focus": "可执行研究议程"
    }
}
