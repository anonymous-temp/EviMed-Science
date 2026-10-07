# N2 — China 2026: GEO standards, enforcement, terminology, AI health-answer sourcing, pharma communication norms

Researched 2026-10-05. Legend: ✓ = primary page read (or the official text itself read on a mirror that reproduces it verbatim, noted); ~ = secondary only / not independently verified.
Privacy: no user identifiers used in any request.

## Q1. GEO standards and their content (2026)

### Q1a. 中国商务广告协会 (CAAC) T/CAACCHINA 001–005—2026 《生成式引擎优化（GEO）》 — primary texts read

- Consultation notice, 2026-07-28 ✓ http://www.caacchina.org/news/notice/2026/0728/523.html — drafting launched at a 2026-03-27 symposium; draft covers "GEO基础定义与业务边界、服务商准入能力、报价计价与效果测量、可信语料质量管控、服务流程合规安全五大专项标准"; motive quoted: "解决当前 GEO 行业无序竞争、虚假信息、语料不合规、计价评估无统一依据等行业痛点"; comments until 2026-08-30.
- Publication notice, 2026-09-16 ✓ http://www.caacchina.org/news/notice/2026/0916/527.html — "2026年9月14日 … 五项标准正式通过全国团体标准信息平台审核并正式对外公布". Titles (exact):
  - T/CAACCHINA 001-2026《生成式引擎优化（GEO）第1部分：通论及术语与定义》
  - T/CAACCHINA 002-2026《… 第2部分：服务商评估规范》
  - T/CAACCHINA 003-2026《… 第3部分：计价、评估与测量规范》
  - T/CAACCHINA 004-2026《… 第4部分：可信语料规范》
  - T/CAACCHINA 005-2026《… 第5部分：服务流程合规与安全要求》
  - 41 drafting units / 75 experts; 38 companies + 13 experts sent 174 comments (one commenter is 鲁南制药集团, a pharma company). Core revisions quoted: "'高风险行业'统一修订为'高合规要求行业'、服务商评估维度权重设置下限、去除国外模型相关表述、新增AEO（答案引擎优化）术语定义并厘清其与GEO的关系、全文统一'语料投毒'术语". Offline launch event announced for 2026-10-16 in Shanghai.
  - Drafters include 知乎, 搜狐, 新榜, 明略, 清蓝(PureblueAI), 科大讯飞, 微博(微梦创科), 喜马拉雅, 阳狮, 360 — i.e., content platforms + GEO vendors, no AI-assistant operator (no ByteDance/Tencent/Alibaba/Baidu/DeepSeek) and no medical body.
- **Dates on the standard covers (read from the PDFs): "2026-09-09 发布 2026-09-10 实施"** ✓ (P3/P4/P5 PDFs linked from the 09-16 notice, host aacchina.test.caacchina.org). → The widely repeated "effective 2026-10-10" (e.g., ~ https://www.sohu.com/a/1081765663_123012908) does NOT match the cover pages; treat 10-10 as unverified (the national group-standard platform listing was not checked).
- **Part 4 可信语料规范 (T/CAACCHINA 004-2026)** ✓:
  - Definition: "可信语料 … 经权威审核、来源可追溯、内容真实准确，适用于生成式人工智能检索、理解、推理与生成引用的结构化信息素材".
  - Six principles: 真实性、权威性、专业性、可追溯、动态更新 (if no update mechanism, "应提供内容的发布日期"), 中立性.
  - General source admission includes "内容可追溯到具体责任人" and "承载语料的网络内容平台对 AI 生成信息有标识".
  - **High-compliance industries explicitly include medicine**: 5.1.2 / Annex A.1 "金融理财、医疗健康、教育培训、房地产、医美、药品、医疗器械、保健食品、特殊化妆品等" — must additionally meet "相应行业主管部门的资质认定要求".
  - Annex A.2: "实行信源白名单准入、最小范围采集、100%人工复核、全链路可追溯机制"; no self-media / personal / anonymous sources.
  - Annex A.3.1 highest-trust sources: ministries/regulators' releases; national media; "行业主管机构、监管总局、标准化委员会、官方智库发布的行业标准、规范、指南、白皮书、诊疗方案、合规条文".
  - Annex A.3.2 secondary sources include "拥有执业资格认证（如三甲医院主任医师个人认证账号、行业学会认证专家账号）或机构背书的垂直领域专家" and "行业协会、学会".
  - Annex A.3.3 **absolutely banned** sources include "无资质机构发布的科普、建议、攻略、测评、分析结论" and "带有营销导向、夸大宣传、商业引流、诱导消费的行业内容" and "无法溯源、无发布主体、无时间戳、无资质背书的模糊内容".
  - Corpus trust rating 1–5 stars on 权威性/专业性/真实性/时效性/内容质量; QA of high-compliance batches 100%; sampling at 99% confidence / 3% error for high-compliance corpora; batch fails on any serious violation.
  - Annex B.4: provider must start correction "在72小时内" when placed content has a factual error or is mis-cited by AI.
- **Part 5 服务流程合规与安全要求 (T/CAACCHINA 005-2026)** ✓:
  - 黑帽 GEO defined: "以操纵、污染、伪造、欺骗或恶意竞争为目的，绕过平台安全机制恶意影响人工智能输出结果的行为" (typical: 虚假内容、异常分发、语料投毒、提示词攻击、刷量刷评、伪造信源、恶意贬损竞品). Note 2: lawful ads/PR/KOL content "在内容真实、合法且不存在欺骗性操纵的情况下，不属于…黑帽 GEO".
  - "正向优化": improve "语义清晰度、结构完整性、机器可读性和用户价值" by compliant means.
  - Service goal limited to raising "真实、合法、准确、权威信息 … 可识别性、可理解性、可引用性和推荐适配性，不应以操纵模型输出结果为目的".
  - High-compliance clients: verify "行业许可、备案文件或广告审查批准文件".
  - AI-assisted content: "未经审核的人工智能生成内容不得直接对外发布"; keep drafts, review opinions, final version, publish time; keep prompts and generation versions.
  - Paid content: "应依法显著标注'广告''商业合作'等标识".
  - No promising "绝对控制模型输出""百分之百霸屏"; contract must attach a "不可承诺事项清单".
  - Traceability: logs ≥3 years; "宜采用元数据标签、时间戳、数字水印、电子签名" for verifiable provenance.
  - Violation tiers: serious = "广告标识缺失、特殊行业宣传内容不符合监管要求、未经证明使用比较性或绝对化表述…"; major = "语料投毒、语料轰炸、伪造权威信源、恶意贬损竞品、数据造假…提示词攻击…伪造监测结果".
- **Part 3 计价、评估与测量规范 (T/CAACCHINA 003-2026)** ✓ — the first codified Chinese GEO metric set:
  - 可见率/提及率 = 命中品牌的提问次数/提问总次数 (category questions only, not brand questions; TOP1/TOP3 variants; usable as KPI).
  - AI 情感中正率 (positive+neutral share) and 情感负面率; if an AI judges sentiment, "应说明使用的模型、提示词和复核规则，并保留人工复核机制".
  - 可见份额 (share of mentions among all brands; "不宜直接作为项目考核 KPI 指标"); 平均排名 (first-mention position; not a standalone KPI).
  - 指定信息正确率 and 指定信息覆盖率 (brand/product facts expressed correctly / present).
  - 信源数量引用率 and 信源问题引用率 (share of citations / share of questions citing a designated source — e.g., 新华网, a URL, an article, an official account). Table 9 records citation positions for 豆包 APP (参考资料 before answer; 商品卡 in answer) and 元宝 Web (HY3 深度思考: 参考资料; 相关视频 after answer).
  - 语义一致性 (consistency of core facts across pages/sources/channels).
  - Measurement rules: same question set across engines; "中国市场内建议不低于 3 个城市"; "不低于 5 个" engines; any single engine ≤80% of samples; **≥30 samples per smallest analysis cell** (e.g., intent-model-week; Annex A: at n≥30 the visibility-rate SD ≤10%); record engine name/version, collection method (API / PC UI / app UI), web on/off, deep-thinking on/off, mode, sub-model (e.g., 元宝 混元 vs DeepSeek); keep raw data ≥3 years; no attribution of all change to GEO ("不应将全部变化简单归因于 GEO 服务", from Part 5).
- Medical relevance: neither the CAAC set nor its drafting list is medical-specific; medicine appears only as a 高合规要求行业 with stricter source rules.

### Q1b. AIIA/T 0277-2026 《生成式引擎优化（GEO）服务可信基本要求》 (中国信通院 / AIIA 安全治理委员会)

- Primary CAICT/AIIA page not found online (CAICT posts these on WeChat; none indexed). Everything below is ~ unless noted.
- Number "AIIA/T 0277-2026" and "2026年3月 … 中国信通院、中国泰尔实验室联合发布" appear only in vendor/secondary articles (e.g., ~ https://www.zhonghongwang.com/show-140-468267-1.html ; ~ https://www.weiyangx.com/474922.html). Secondary pieces call it "国内首个GEO行业国家级标准" — note the AIIA/T prefix marks an **alliance (group) standard**, not a national (GB) standard. One search summary also attributed a "YD/T 3980-2026" number — not corroborated anywhere; ignore.
- Structure: "管理机制要求、客户材料审核要求、优化手段要求、优化结果要求以及长远发展要求5大方面10大要求项"; 20+ drafting units under "人工智能产业发展联盟（AIIA）安全治理委员会" ~ https://news.qq.com/rain/a/20260611A0721J00 (2026-06-11, a company press item). Vendors cite "17项" check items (e.g., 360 智见 "17项全部通过" ~ https://www.sohu.com/a/1023178575_122785139).
- Content as summarized by vendors (~ https://www.sohu.com/a/1074263975_122989138, 2026-09-10): "所有优化素材源自企业真实资质与业务资料，严禁编造产品、虚构案例"; "仅支持事实增强、实体标准化、内容结构化等白帽优化，禁止伪造站点、篡改事实等黑帽行为"; "校验大模型输出内容与企业原始信源一致性，信息来源可追溯".
- Xinhua report of the AIIA 可信GEO seminar (2026-05-14, published 05-18) ✓ https://www.xinhuanet.com/digital/20260518/5b81c242155a44da9a69d69f90410c57/c.html — CAICT released 《生成式引擎优化（GEO）可信生态构建研究报告》 proposing "服务商合规自律+全产业链协同共治"; "9家企业首批通过GEO服务可信专项评测" (清蓝、360、蓝色光标、明略科技、百分点科技、克莱普斯、元力科技、森博明德、光引GEO). No medical content.
- Earlier (2026-02-03) AIIA "安全承诺" for GEO signed by 10 firms: "坚决抵制语料轰炸、关键词堆砌、潜藏隐形指令等投机手段"; medicine named among "高监管行业" ~ https://m.jiemian.com/article/14170754.html (republished promotional piece).
- Follow-on spec in drafting: 《生成式引擎优化（GEO）服务能力评估》 (AIIA seminar 2026-06-08), 9 dimensions incl. "品牌认知能力、意图识别能力、生成内容监测能力 … 可信合规保障能力" ~ https://www.cnfin.com/xy-lb/detail/20260612/4425838_1.html (2026-06-12, 中国金融信息网).

### Q1c. 中国新闻技术工作者联合会 — T/CAPT 026—2026 《生成式引擎优化（GEO）可信信息传播与信息生态治理规范》

- Status correction: the 2026-04-15 item was the **project approval** (立项评审通过 2026-04-10) ✓ https://www.news.cn/digital/20260415/33413765d7d740bcb0aab0626ee6aebc/c.html — already then: "严令禁止'语料投毒''答案霸权''提示词注入攻击'"; "三区分治 … 要求企业将事实、观点与营销表达分离".
- **Final standard: T/CAPT 026—2026, 审查通过 2026-08-09, 发布 2026-08-11** (approved by 中国新闻技术工作者联合会新闻信息标准化分会) ✓ http://www.news.cn/digital/20260812/3323a47bda40437f8a42ee135670ab2f/c.html ; **实施 2026-08-12** ✓ http://www.gxnews.com.cn/staticpages/20260813/newgx6a7daaf5-21980606.shtml (广西日报, a co-drafter, 2026-08-13).
- Lead drafters: 新华网融媒体未来研究院 + 新华社媒体融合生产技术与系统国家重点实验室第三研究部; "30余家" co-drafters (广西日报社、黑龙江日报、大众报业、复旦大学马克思主义研究院 …) ✓ (both pages).
- **三区分治 (exact)**: "将品牌知识库划分为事实库、观点库、营销表达库，分区存储、标识与使用，并明确营销表达中的事实主张必须以事实库版本为准" — purpose "从源头切断'以营销包装替代事实依据'的操作空间" ✓ (gxnews; Xinhua wording near-identical).
- Source tiers: "A/B/C/D四级来源可信度分级体系，将政府部门、权威媒体等纳入最高等级"; full-chain traceability "对内容从生成、审核、接入到发布的每个环节留痕可查" ✓ (gxnews). Prohibited: "语料投毒""答案霸权""伪共识制造""提示词注入攻击" ✓ (Xinhua 08-12). Organizational capability levels L1基础 / L2专业 / L3综合治理 ✓ (Xinhua 08-12 as summarized by fetch tool).
- Stated direction: GEO should move "从单纯追求曝光、提及和排名的技术操作，转向可信事实资产建设、合规传播控制和信息生态治理" ✓ (Xinhua 08-12). No medical-specific clause reported in either article.

### Q1d. Other 2026 GEO standards found

- 山东省品牌建设促进会 T/SDCBD 0007-2026《品牌生成式引擎优化应用规范》, effective 2026-10-01: "以品牌官方核准信息为唯一事实基准"; four monitoring indicators "多AI平台覆盖度、信源引用率、跨平台吸收效率、情感倾向分布"; "AI生成内容须经人工事实核验与合规性双重审核后方可进入分发环节" ~ https://www.163.com/dy/article/L82V8QFJ0514R9KU.html (2026-09-30, NetEase account repost).
- **Medical/pharma-specific GEO standard: none found** (searched 医疗/医药/药企/健康 + GEO + 团体标准/指南, 2026). Only vendor "医药 GEO 合规指南" blog posts exist (cnblogs/zhihu/vendor sites) — not standards. In the CAAC set, medicine is handled as a 高合规要求行业 (see Q1a).

## Q2. Enforcement and regulator statements

### Q2a. CAC 「清朗·整治AI应用乱象」 (4 months, two phases) — primary texts read

- Launch notice 2026-04-30 ✓ https://www.cac.gov.cn/2026-04/30/c_1779289298718765.htm — "为期4个月"; phase 1 "清朗·AI应用服务典型违规问题", phase 2 "清朗·整治AI信息内容乱象".
  - **GEO named in an official CAC text** — phase-1 item 4 "AI数据投毒问题": "通过篡改训练语料、伪造权威数据、使用GEO（生成式搜索引擎优化）技术恶意营销等方式实施AI数据投毒。炒作、教授AI数据投毒方法，或在电商平台兜售教程及工具。**在模型生成回答过程中，对引用信源缺乏交叉验证和风险提示机制，未标注引用信息链接。**" (the last sentence is aimed at the AI assistants themselves: they must cross-check sources, add risk prompts and show citation links).
  - Phase-1 item 5: non-compliance with 《人工智能生成合成内容标识办法》 and the mandatory labelling standard (explicit + implicit labels, cross-platform implicit-label recognition).
  - Phase-1 item 6 includes impersonation via digital humans to "提供金融咨询、医疗问答等专业服务".
  - Phase-2 item 2: "生成传播医疗、司法、金融、教育等专业领域未经科学验证或明显违背科学常识的信息".
  - Phase-2 item 7 includes "为违法违规AI应用程序等服务或课程进行营销炒作、推广引流".
- Phase-1 results 2026-07-06 ✓ https://www.cac.gov.cn/2026-07/06/c_1785081384384987.htm — "累计处置违规网站、应用程序、智能体等AI产品1.4万余款，清理违法违规信息600余万条，处置账号2.6万余个，下架违规AI商品1300余个、违规开源数据集9个"; a "涉AI应用乱象举报专区" was opened; 浙江 did rectification on "训练语料安全、AI数据投毒"; 江苏 collected tips on "AI数据投毒、未落实生成合成内容标识要求等5类"; "DeepSeek在数据采集和预处理环节嵌入异常检测算法，防止恶意样本隐蔽操控". **No GEO company named; no GEO-specific penalty figure.**
- Phase-2 results 2026-09-02 ✓ https://www.cac.gov.cn/2026-09/02/c_1790099041364574.htm — "累计清理违法违规信息561万余条，查处账号4.9万余个，处置违规网站、应用程序等2400余个"; "豆包、元宝、千问、文心一言等平台严把原始语料内容审核关，严格限制违规内容输出，强化AI生成合成内容标识要求落地"; 7 typical-case groups (魔改/虚假信息/换脸/低俗/未成年人/AI托管水军/违规智能体). Case 2 includes "打造AI数字人进行虚假宣传带货，误导老年人". **No GEO case named.**
- Unverified vendor claim to disregard: "据国家网信办2026年Q1公开通报数据，全国已有超过200家违规GEO服务商被查处" (appears in a search-result summary of vendor content; no CAC text found) — not supported.

### Q2b. SAMR (市场监管总局) 2026 — AI-generated advertising; no official SAMR text found that names "GEO"

- 《2026年全国广告监管工作要点》 (reported issued 2026-01-29) ✓ text reproduced by 中国食品安全报's site https://www.cfsn.cn/zcwk/detail/2163/15152.html — "(十一)整治互联网广告市场秩序。聚焦直播电商广告、引证广告、AI生成广告等互联网广告监管重点难点问题，开展集中整治"; also "修订出台《药品、医疗器械、保健食品、特殊医学用途配方食品广告审查管理办法》"; "出台…《广告引证内容执法指南》"; "开展广告领域人工智能应用情况研究". No "GEO" in the text. (Media framing "2026年，GEO将被集中整治" is commentary ~ https://news.qq.com/rain/a/20260203A06HOD00.)
- 《市场监管总局关于深化互联网广告生态治理工作的通知》 dated 2026-04-15 (announced 2026-04-23) ✓ full text on MOFCOM policy mirror https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=106022 — "加快完善直播电商中的广告、植入广告、人工智能生成式广告、引证广告等方面的监管规则"; "强化医疗、药品、医疗器械、保健食品、特殊医学用途配方食品、金融理财、教育培训等重点民生领域广告监管执法，严厉打击在广告中利用人工智能冒充或者虚构专家、学者、知名企业家、名老中医、明星、艺人等违法行为". **No mention of GEO, AI search, AI answers or answer placement.**
- Companion 《互联网广告市场秩序整治重点任务》: "为期半年"; six tasks incl. "强化对人工智能生成式广告的监管" and "加大对'矩阵式'互联网广告投放行为的规范力度" ✓ (as quoted by 中新网 2026-04-23 https://www.chinanews.com/cj/2026/04-23/10609404.shtml; the task list itself not read on samr.gov.cn).
- **《广告引证内容执法指南》 — SAMR 公告2026年第20号, 成文 2026-06-03, 发布 2026-06-12** ✓ https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/ggjgs/art/2026/art_8962fc1e4eb44a87b93d265af43b6940.html (28 articles). Directly relevant to "evidence cards" when used in advertising:
  - Art. 7: quoted abstracts/quotations "应当与原文意思表达一致，其引自的文献资料应当真实存在且可查询".
  - Art. 8: must state the source — institution/author or document title + author; "引自期刊的，应当表明期刊名称、期号、刊次等信息。引自互联网网页的，应当表明访问路径。相关互联网内容或者访问路径变更的，应当对广告内容作出相应调整或者停止广告发布".
  - Art. 9: state applicability conditions/validity periods (lab-only conditions, sample-only results, region/industry scope, validity).
  - Art. 14: false/misleading if "通过篡改、部分引用、歪曲结论等方式，夸大对广告主有利的内容或者隐瞒对广告主不利的内容" or "引用的数据、结论等已被修正，但未按照修正后的数据、结论等更改广告内容".
  - Art. 16: if an advertiser publishes via "有偿新闻、学术造假" and then cites the result, regulators notify press/science authorities.
  - Art. 17: "广告中使用人工智能（AI）、深度合成等技术手段生成、合成的数据、资料、结论等内容" count as **自证内容** (the advertiser's own claims, burden of proof on it).
- Local: 成都市市场监管局《AI生成广告合规指引》 (2026-09-18) — AI ads must be labelled "广告" plus AI labels ("本广告由AI技术生成" etc.); stricter review encouraged for "医疗、药品、医疗器械、保健食品…"; no mention of GEO/AI answers ~ https://news.qq.com/rain/a/20260918A0B7JC00.

### Q2c. Named GEO cases / penalties in 2026

- **CCTV 3·15 晚会 (2026-03-15)** — segment "谁在给AI'投毒'" ✓(video page only) https://tv.cctv.com/2026/03/15/VIDEmX0VdYf9DeKI87GYEfqF260315.shtml; details ~ 36氪 https://www.36kr.com/p/3724411683895943: "力擎GEO优化系统" (operator reported as 北京力思文化传媒有限公司 ~ Sina 2026-03-15) made a fictitious "Apollo-9智能手环" (claims incl. "无需采血测血糖") recommended by mainstream assistants after 11 fake articles in 3 days; DeepSeek、豆包、元宝、千问、文心一言、Kimi … "无一幸免"; vendor claimed "一年服务了200多个客户，遍布医疗、教培、机器人等各行各业"; annual fees 2,980–16,980 元.
- **Beijing 朝阳区市场监管局 fined 北京百付科技 5万元 (June 2026)** — a GEO vendor: fake honour plaques ("中国GEO行业最具影响力品牌" etc.), fabricated "综合评分99.6、市场占有率49%、续费率99%"; "使用豆包、元宝等AI工具加工生成宣传文稿，交由媒体中介全网投放", "达到合同约定的AI搜索结果排名前三或者前五"; violation of 《网络反不正当竞争暂行规定》 and new 《反不正当竞争法》第九条; company apologised 2026-06-28 ~ 每日经济新闻 https://www.nbd.com.cn/articles/2026-06-28/4439705.html (2026-06-28). Penalty record reportedly on 朝阳区 publicity portal http://www.bjchy.gov.cn/robot/shuanggongshi.xz_cf.do?m=showCfView&id=8a24dabe9eb5f247019eed5819440daf&page=1 (not opened).
- 上海嘉定警方 case (2026-03-05): suspect "累计发布不实文章70余万篇次，非法获利8万余元" ~ 北京网络举报 via 中国互联网联合辟谣平台 https://www.piyao.org.cn/20260403/ad5ea72461a34cd3bf9a27d7f252fa3e/c.html (2026-04-03) — framed as AI-poisoning rumor mill; article notes "在医疗、金融等低容错领域，AI推荐的虚假信息甚至可能危及生命财产安全".
- No CAC-announced GEO-company case found in the 07-06 or 09-02 bulletins (see Q2a).

### Q2d. NHC / NMPA / joint texts on AI-generated health information

- **NHC + 国家中医药局 + 国家疾控局 《医务人员互联网健康科普负面行为清单（试行）》, dated 2025-10-31** ✓ (official repost, 福建省卫健委 2025-11-07) https://wjw.fujian.gov.cn/xxgk/gzdt/mtbd/202511/t20251107_7031386.htm. Ten items, incl.: (2) "不得以健康科普形式违法违规发布各类广告、导流导诊，或通过直播带货等形式推销和销售医药产品、养生课程、保健食品等牟利"; (4) no content "超出本人专业领域"; (5) "不得发布未经科学验证、虚假错误内容，不得断章取义曲解专业指南、行业标准等"; (7) "**不得滥用人工智能技术，发布未经核准真实性、科学性，或未添加显著人工智能生成合成标识的健康科普内容**"; (9) accounts using hospital/position identity must be reported to the hospital (hospitals keep a 台账 and spot-check).
- **中央网信办秘书局 + NHC + SAMR + 国家中医药局 《关于规范"自媒体"医疗科普行为的通知》 (2025-08-01)** ✓ key-points repost on a government site https://www.xingning.gov.cn/zfjg/xnswsjkj/ywgl/zcfg/content/post_2799838.html: platforms must verify and display credentials (licence names, specialty, hospital department, "是否在职，签约的MCN机构名称"); "借助人工智能技术生成合成医疗科普信息 … 需严格标注信息来源或生成合成内容标识"; "严禁无资质账号生产发布专业医疗科普内容" (unverified accounts 2 months to certify); no disguised ads for drugs/devices/health foods and no shop links/contacts on the same page; clean up "利用AI编造发布涉医领域同质化文案、编造健康故事售卖商品或药品".
- NMPA 《关于"人工智能+药品监管"的实施意见》 国药监综〔2026〕6号 (2026-04-02) ✓ https://www.gov.cn/zhengce/zhengceku/202604/content_7064591.htm — internal regulatory AI; relevant lines: upgrade "'两品一械'网络销售安全风险监测和舆情监测体系"; "加快研究制定人工智能在医药产业规范应用的指导原则". Nothing on AI assistants' drug answers.
- NHC et al. 《关于促进和规范"人工智能+医疗卫生"应用发展的实施意见》 国卫办规划发〔2025〕30号 (2025-10) ✓ https://policy.mofcom.gov.cn/claw/clawContent.shtml?id=104035 — encourages "个性化智能健康知识推送" and "合理用药、慢性病管理等健康知识咨询和宣传"; no rule on consumer AI assistants' answers.

## Q3. Terminology after 3·15 and the CAC action

- **"GEO" was not abandoned; it was qualified.** Every 2026 official/semi-official text keeps the word and adds a trust qualifier:
  - CAC itself uses "GEO（生成式搜索引擎优化）" — but only as a means of "AI数据投毒" ("使用GEO…技术恶意营销") ✓ https://www.cac.gov.cn/2026-04/30/c_1779289298718765.htm.
  - CAICT/AIIA: "可信GEO", "GEO服务可信" ✓ https://www.xinhuanet.com/digital/20260518/5b81c242155a44da9a69d69f90410c57/c.html; CAICT's 巫彤宁: "合规治理、可信合规已经成为GEO长期发展的必答题" ✓ (Xinhua 2026-05-10 http://www.news.cn/digital/20260510/bbe1c58d1a1c407abf806e20f1c38985/c.html).
  - Xinhua launched its own "新华GEO智能体平台" (2026-05-09) with vocabulary "可信传播 / 权威信源 / 可信合规", "推动行业从流量驱动向信任驱动转型" ✓ (same Xinhua URL). The CSTJ standard is titled "可信信息传播与信息生态治理" ✓.
  - CAAC standard: "白帽" vs "黑帽 GEO", "正向优化", "可信语料"; added **"AEO（答案引擎优化）"** as a defined term ✓ http://www.caacchina.org/news/notice/2026/0916/527.html.
  - Vendors: "科学GEO" (清蓝/PureblueAI), "白盒化" (third-party monitoring of the service chain), "分层可信知识库" ✓ (Xinhua 2026-05-10 https://www.news.cn/digital/20260510/96286caede9148a7ace32d976478cef8/c.html).
- Practitioner reframing (21世纪经济报道 column 竞争秩序场, 2026-07-20, republished by 安全内参) ✓ https://www.secrss.com/articles/92325: GEO as "AI时代的品牌基础设施，目标是建立权威性"; "意图运营"; clients now ask "AI有没有抓取公司的负面信息、AI会不会引用或生成错误信息"; "尤其是医药、金融这些高风险行业，现在已经不敢再冒险使用低价竞争的小服务商了，而是非常看重操作是否合规"; delivered KPIs "提及率、前段位推荐率、信息准确性"; "现阶段没有任何AI平台披露全域流量数据，只能抽样统计".
- Words in common use in 2026 (from the standards and media above): "AI可见度/可见率/可见份额" (CAAC Part 3), "AI搜索", "品牌认知" (AIIA 能力评估 dimension "品牌认知能力" ~ https://www.cnfin.com/xy-lb/detail/20260612/4425838_1.html), "信源建设"/"权威信源", "可信传播". I found **no** official or widely used rename such as "AI品牌认知管理"; "生成式引擎可信传播" appears only as the CSTJ title pattern.
- Black-market rebranding: after 3·15 the named Taobao listings were removed, "但目前记者仍能在淘宝搜索'Geo优化'找到类似服务" ~ (search-result summary of 澎湃/21世纪 reports, 2026-03-16, e.g., https://m.thepaper.cn/newsDetail_forward_32773464). A Zhihu thread title "315 曝光「AI 投毒」后 GEO 换马甲生意照做" ~ https://www.zhihu.com/question/2016981407864414269 — anecdotal.
- Pharma usage: trade media and agencies say "医药GEO" / "医药AI搜索合规"; 赛柏蓝 course copy (via 医药魔方, 2026-05-01) ~ https://bydrug.pharmcube.com/news/detail/60cbb05bdb6ab54bde996d5059ec9246: "AI 搜索已成用户找品种、查品牌、选产品的主要入口，GEO 生成式引擎优化已经成为医药健康行业新的营销突破口". **No named pharma company was found publicly describing its own "GEO" programme in 2026**; MNCs talk about AI for "学术沟通、销售培训、疾病教育" (e.g., 礼来 on 火山引擎, ~ search-result summary, unverified).
- Physician channel context: 丁香园 + 麦肯锡 《2026中国医生AI行为与态度调研报告》 (released 2026-07-28; n=4,150 doctors): "专业医学平台和医学文献仍是医生查询药品信息的主要渠道，AI渠道使用率为24%" ✓ (中国日报网 2026-07-31 report on the release) https://cn.chinadaily.com.cn/a/202607/31/WS6a6c0e96a310d709c2fc0b79.html — also "近80%的医生已在工作场景中使用AI", "约75%的医生每日固定使用AI工具", "31%的医生仍会通过医药代表/医学联络官获取相关信息" (report itself not read).

## Q4. How Chinese AI assistants source health/medical answers (2025–2026)

### Platform announcements (all lean on authoritative institutions + credentialed doctors; none says it ranks pharma content)

- **千问 App (Alibaba) — 2026-07-08** ✓ 中新网 https://www.chinanews.com.cn/cj/2026/07-08/10655201.shtml: connected "五大权威医学知识库" = "国家药监局全量药品说明书、中国营养学会知识库、最新临床指南、千万级医学文献、超万部医学出版物"; "健康溯源": "每条建议均可追溯至具体文献、教材或药品说明书原文", "每个关键信息都会高亮标注出处，点一下就能看到原文"; whitelist: "优先采信权威机构、三甲医院发布内容"; evidence order "先看最新临床指南，再补核心文献"、"多来源交叉印证"; encyclopedia content "要经过三审三校，由三甲医院医生参与编审". (Also: 千问 published a 《2026 AI健康助手使用指南》 on 2026-06-05 ~ NetEase repost.)
- **夸克健康大模型 (Alibaba/Quark) — 2025-07-23** ~ 量子位 https://www.qbitai.com/2025/07/311863.html: "通过中国12门核心学科的主任医师笔试评测"; built on 通义千问; "千人规模的专业医师标注团队，其中超过400名均为副主任医师及以上"; live in 夸克AI搜索 via 深度搜索; ">200万" monthly active medical students.
- **蚂蚁阿福 (Ant Group)**: 2026-06-15 "医生把关" — user can ask a 三甲医院皮肤科 doctor to review the AI answer; ~15% of users choose it ✓ 央广网 https://tech.cnr.cn/techph/20260615/t20260615_527661263.shtml (other figures — ">90% agreement", "~2 minutes", "3 free/day" — from secondary reposts ~). 2026-08-12 "阿福医生版" (upgraded 好大夫医生版): "超6000万医学文献、医学指南、顶刊资源", "超14万药品说明书", "实名注册医生规模已超30万", app "用户数已突破1亿" ✓ 网易科技 https://www.163.com/tech/article/L44L0ACD00098IEO.html. 2026-08-28 strategic deal with 威科集团 (Wolters Kluwer): 28 journals (JCO, Annals of Surgery…) on 阿福医生版; exploring UpToDate ~ https://news.qq.com/rain/a/20260828A076F300. 2026-09-11 profile: "一个App有1.5亿用户，每天被问2000万次"; "暂不考虑商业化"; future revenue "对应保险公司风控与药企效率两类场景"; "三线及以下城市用户占55%，老年用户占25%" ~ https://news.qq.com/rain/a/20260911A0CZQD00.
- **百度健康 / 文心** ✓ 健康中国传播社 2025-08-01 http://www.jkzgnews.com/cx/innovate/2025-08-01/1711.html: 2025-07-30 "满天星公益计划" — "联合10万名医生共建超1亿条AIGC权威科普，打造100个头部专家IP"; three-tier review (AI reviewer → 百度健康医学审核中心 → external practicing doctors, "由同科室、同疾病的医生进行内容审阅，且不允许跨科室审阅"); "**目前百度医疗搜索上80%的结果均由上述三层模式共同生产**"; "百度日均3亿次的健康检索", "30余万专业医生入驻". (2026 claims "文心健康管家月活超4000万 / 36万医生参与标注" only in secondary summaries ~.)
- **腾讯 (元宝 / 腾讯医典 / 腾讯健康)**: 腾讯医典 content "携手公立三甲名医资源", "经过三审三校流程严格把控内容质量", "医学百科词条数达几十万量级", offered to third parties "通过API快速接入" ✓ https://healthcare.tencent.com/production/16. 元宝 search draws on 微信搜一搜/搜狗 and 公众号 content ~ (search summary). Precedent of pharma inside an assistant: 华润三九 "三舅健康管家" agent built on 腾讯医疗大模型, usable "通过腾讯元宝APP或'999会员中心'小程序" ✓ https://healthcare.tencent.com/news/1615 (2024-09-05).
- **豆包 / 小荷 / 抖音 (ByteDance)**: "豆包现在每天承载的健康咨询的体量，超过2000万人次" — said by 百川 founder 王小川 (a competitor's estimate, not ByteDance data) ✓ 第一财经 2026-08-05 https://www.yicai.com/news/103305790.html. 小荷AI医生 "日均交互5000万次，承接豆包、抖音、头条…健康咨询" and "基于权威来源，不能编造医学结论" ~ (财联社 via NetEase, 2026-09-28 https://www.163.com/dy/article/L7UICSM405198CJN.html). 抖音 disease entries / medical Q&A come from 小荷医典; 抖音 "3.5万认证医生" (2023 figure) ~. ByteDance's public line on incidents: AI content "仅供参考" ~. **Gap: no ByteDance statement found on how 豆包 selects health sources** (小荷AI医生 launched 2025 on the 豆包 model; a 小荷 VP is quoted claiming attending-physician level on common diseases ~ search summary; the 36氪 piece https://36kr.com/p/3825663816897155 returned a bot check and was not read).
- **DeepSeek in hospitals**: "目前全国已有20多个省份的百余家医院实现DeepSeek本地化部署"; 《医疗机构部署DeepSeek专家共识》 (北京卫生法学会大数据互联网人工智能医疗专委会 + 中国生物医学工程学会医学人工智能分会法律伦理专家组), five dimensions incl. "数据质量保障" and "法律伦理合规" ✓ 新华网 2025-04-02 http://www.news.cn/tech/20250402/f02b65e2bed64001ae8f2d892bcf1c96/c.html. These are in-hospital deployments on hospital data, not the public DeepSeek app. DeepSeek's own public consumer app has no announced medical-source programme; CAC (2026-07-06) credits it with anomaly detection against poisoned samples ✓ (Q2a).
- Platform-side regulation pushes the same way: the 2025-08 four-department notice obliges platforms to verify and display doctors' credentials and bars unverified accounts from professional medical science (Q2d); CAC requires assistants to cross-verify sources and show citation links (Q2a).

### Observed sourcing (vendor measurement — treat as indicative)

- 新榜 (a CAAC drafter) AI-source study, Aug 2026, 6 platforms (豆包、DeepSeek、Kimi、元宝、千问、百度AI), daily real prompts ✓(article read; vendor data) https://news.qq.com/rain/a/20260910A08BU400: health sector — "**医疗赛道风控严格、信源门槛最高。最该做的不是铺量，而是立资质：专家署名、参考文献、资质说明**"; 元宝 and 千问 both cite 39健康网; 豆包/Kimi/百度AI favour content with expert signature, references, credentials.
- Generic vendor claims (unverified ~): 豆包 >60% of citations from ByteDance platforms (头条/抖音/快懂百科…); 元宝 favours 公众号; Kimi favours 知乎; DeepSeek favours authoritative media (e.g., https://zhuanlan.zhihu.com/p/2019820201454117898).

### Published audits / tests

- 张俊丽等, 《电子与信息学报》 (online 2026-02-11): 豆包/Kimi/DeepSeek on 10 chemotherapy questions; overall 4.05/4.17/4.19 (5-pt, P=0.004); DeepSeek best on doctor-rated accuracy (4.117), Kimi best on patient-rated readability; "患者评分与医生评分存在差异错位，未来可探索分层呈现或双重验证机制" ✓ https://jeit.ac.cn/cn/article/doi/10.11999/JEIT251056?viewType=HTML.
- 贝壳财经 (新京报) test, 2026-01-23: same thyroid report to 7 health apps (小荷AI医生、蚂蚁阿福、夸克健康、平安好医生、讯飞晓医、百度文心健康、京东健康); one app misread TSH as HCG and suggested checking for pregnancy ✓(NetEase repost) https://www.163.com/dy/article/KK02183T055284JB.html.
- Exam-style benchmarks (2025–2026, PMC): e.g., pharmacist licensing exam — Kimi 89.58%, 豆包 88.96%, DeepSeek 87.29% ~ https://pmc.ncbi.nlm.nih.gov/articles/PMC13383037/ (summary only). These test knowledge, not citation sourcing.
- 中国消费者协会 2026-08-25 AI consumer tip ✓ https://www.chinanews.com.cn/cj/2026/08-25/10683628.shtml — about inaccurate AI answers in finance/legal/customer service; **no medical-specific audit**. 中消协 "618" report (2026-06-27): AI-generated fake reviews rising ~ http://health.people.com.cn/n1/2026/0627/c14739-40748648.html.
- Not found: any 南方都市报 / 中消协 audit of AI assistants' **medical citation sources** in 2025–2026; no regulator-published accuracy audit of consumer AI health answers.

## Q5. Pharma public communication norms — SKIPPED on the coordinator's instruction (covered by another researcher)

No section was researched to completion. Only the primary texts I had already opened before the instruction arrived are listed, so they are not lost; nothing below was re-checked or extended.

- 《广告法》(2021) 第十五条: 处方药 "只能在国务院卫生行政部门和国务院药品监督管理部门共同指定的医学、药学专业刊物上作广告"; 第十六条: drug ads must not contain "表示功效、安全性的断言或者保证 / 说明治愈率或者有效率 / …比较 / 利用广告代言人作推荐、证明", must match the approved label; 第十九条: no disguised drug ads "以介绍健康、养生知识等形式" ✓ https://scjgj.beijing.gov.cn/cxfw/flfgcxfw/ggl/202204/t20220401_2646388.html
- 《互联网广告管理办法》(SAMR 令第72号, effective 2023-05-01) **第六条** (not 第七条, as some summaries say): "禁止利用互联网发布处方药广告，法律、行政法规另有规定的，依照其规定"; 第八条: health/wellness knowledge pages may not carry the seller's "地址、联系方式、购物链接" ✓ https://www.gov.cn/gongbao/2023/issue_10506/202306/content_6885261.html
- **New in 2026 — SAMR draft 《药品、医疗器械、保健食品、特殊医学用途配方食品广告审查管理办法（征求意见稿）》, 2026-05-15, comments to 2026-06-15** ✓ https://www.samr.gov.cn/hd/zjdc/art/2026/art_2a99498546434468b1fada4203fdc7ce.html (both attached PDFs read): ads must not "含有说明书以外的理论引用、观点表述等内容"; must not use "科研单位、学术机构、行业协会、消费者组织或者专家、学者、医师、药师、临床营养师、患者等的名义或者形象作推荐、证明"; "不得利用处方药名称为各种活动冠名进行广告宣传"; links/QR codes inside an ad — "由广告主对其链接内容的真实性和合法性负责"; objectively showing name/label/price on the company's own sales pages "无需申请广告审查". Draft only — final text not found.
- 中国医药报 (NMPA's newspaper) 2026-01-20, legal commentary by 中伦 lawyers ✓ http://bk.cnpharm.com/zgyyb/2026/01/20/app_323452.html: doctor science content risks being treated as an ad when "内容由药企提供或主导创作，医务人员仅作为'出镜人'按脚本录制", when it names/implies a brand, carries purchase links, or is "标注'由某企业支持'"; "标注'由某企业支持''某企业学术支持''合作推广'等字样，通常不能豁免广告性质，反而可能印证内容具有商业推广属性". Refers to NMPA 《互联网药品医疗器械信息服务备案管理规定》 (公告2025年第123号, 2025-12-19 ~).
- RDPAC 行业行为准则 (2022 修订版, effective 2023-04-01) ✓ https://www.ifpma.org/wp-content/uploads/2022/12/RDPAC_Code-of-Practice_2023.pdf: the code "不适用于…直接针对一般公众所进行的处方药推广 (即 DTC 广告)"; Art. 11 on patient organisations — "必须尊重患者组织的独立性", no exclusive funding, written agreements.
- Not done: patient-education programme practice (患者教育/患者支持项目) and any NMPA text on public drug information.

## Implications (for the plan)

- **(a) Naming.** In 2026 "GEO" is the word CAC attaches to "AI数据投毒…恶意营销" and CCTV attached to fake products; the standards bodies kept it only with a trust qualifier (可信GEO / 可信信息传播 / 可信语料 / 白帽·正向优化). Medicine is a named 高合规要求行业 where "带有营销导向…的行业内容" is a banned source class, and Part 5 says the goal must not be "操纵模型输出结果". A pharma-and-doctor module is safer named for what the standards reward — e.g., 循证 + 可信传播 / 信源 / 证据传播 — with "GEO" at most a sub-label tied to the standard numbers. No official or common replacement term (such as "AI品牌认知管理") exists to borrow.
- **(b) Labelling and traceability.** Mirror 三区分治 in the data model: fact store (quote-anchored claims) / opinion store / marketing-expression store, with every outward claim bound to a fact version. Each published item should carry: named responsible author + credential; source with journal/issue or web access path; publish date and version; scope/limits of the cited evidence; AI-generated mark plus the human verification record; "广告/商业合作" mark when sponsored (a "学术支持" mark does not make it non-commercial). Keep prompts, drafts, review opinions and placement logs ≥3 years; correct within 72 h when a placed item or an AI citation of it is wrong, and when the underlying study is corrected. What defines poisoning in the texts is false content, bulk/matrix posting and forged authority — so cap volume and never auto-distribute.
- **(c) Where doctor-authored content helps.** Every platform that published its method leans on credentialed doctors and authoritative bodies: 百度 (80% of medical search results through doctor review), 千问 (whitelist: authoritative institutions, 三甲 hospitals; guidelines first, then literature; NMPA label database), 腾讯医典 (三甲 + 三审三校), 阿福 (doctor review; journals; 140k labels); 新榜's sampling says the medical lane rewards "专家署名、参考文献、资质说明", not volume. CAAC Annex A lists certified 三甲主任医师 / 学会认证专家 accounts as compliant sources and bans unqualified self-media. So doctor authorship helps most for unbranded disease education and evidence interpretation on verified accounts — written independently, inside the doctor's specialty, account reported to the hospital, no product push or purchase path. Product facts travel best through the label, guidelines and consensus papers the assistants already ingest; the academic layer belongs in professional channels.
- **(d) What to measure.** Adopt the CAAC Part 3 definitions but re-rank them for medicine: lead with 指定信息正确率 (label-consistent indication, dose, contraindication, adverse reaction), 指定信息覆盖率, 信源问题引用率 / 信源数量引用率 split by source tier (label / guideline / journal / certified doctor / media / self-media), and 语义一致性 across the owner's own channels; keep 可见率 / 可见份额 / 平均排名 as analysis on disease-level questions only, not as a KPI. Method per the standard: same question set across ≥5 engines and ≥3 cities, ≥30 samples per smallest cell, record engine/version/port/mode/web/deep-thinking/sub-model, keep raw answers ≥3 years, disclose judge model + prompt + human recheck, and never attribute all movement to the module. Medical additions worth having: off-label statements, missing safety information, and whether a cited link exists and says what the answer claims.

## Caveats and gaps

- AIIA/T 0277-2026: no primary text or CAICT page was readable; number, date and "17 items" rest on vendor/secondary articles.
- CAAC Part 1 (terms) is a scanned PDF and Part 2 was not opened; Part 1 definitions are known only as quoted inside Parts 3–5. The 编制说明 was not opened.
- CAAC effective date: covers say 2026-09-10; "2026-10-10" could not be traced to a primary page (the national group-standard platform listing was not checked).
- T/CAPT 026—2026 full text was not found; content is from Xinhua and a co-drafter's newspaper. The A/B/C/D tier definitions beyond "政府部门、权威媒体 = top tier" are unknown.
- 豆包: no first-party statement on health-source selection; the 20-million/day figure is a competitor's estimate.
- Source-preference percentages for assistants are vendor sampling, not audits.
- Q5 was not completed (see above).
- Method note: several official pages serve plain HTTP only or block the fetch tool, so they were read with curl and parsed in memory; a first scratch download (one HTML file under /tmp/link-research/) was deleted immediately. No user identifier was sent in any request.
