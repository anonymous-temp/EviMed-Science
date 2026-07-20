package com.evimed.agent.evidence.agentevidencebased.service;

import com.evimed.agent.evidence.agentevidencebased.agent.deepresearch.EvidenceDeepResearchAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.drugsafety.DrugSafetyAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.evidencereport.KBEvidenceReportAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.evidencereport.MedicalEvidenceReportAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.generalresearch.GeneralDeepResearchAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.medicalqa.MedicalQAReactAgent;
import com.evimed.agent.evidence.agentevidencebased.agent.messaging.AgentSink;
import com.evimed.agent.evidence.agentevidencebased.agent.report.MedicalReportPlanAgent;
import com.evimed.agent.evidence.agentevidencebased.entity.AgentSession;
import com.evimed.agent.evidence.agentevidencebased.tools.EvidenceRetrievalTool;
import com.evimed.agent.evidence.agentevidencebased.enums.AgentType;
import com.evimed.agent.evidence.agentevidencebased.infrastructure.OssReportUploader;
import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.HttpClientStreamableHttpTransport;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.mcp.SyncMcpToolCallbackProvider;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.http.HttpRequest;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;

/**
 * Agent 路由器
 *
 * 路由三步走：
 *   ① 前端明确指定类型（agentType != MEDICAL_QA）→ 直接使用
 *   ② 默认类型 → 查历史记录（sessionId），延续上一轮 agent 类型
 *   ③ 无历史 → LLM 语义分类（当前 force-kb=true 固定走 KB，后续放开）
 *
 * 显式路由（无 default 分支）：
 *   MEDICAL_QA(1)         → GeneralDeepResearchAgent（通用深度研究）
 *   DEEP_RESEARCH(4)      → KBEvidenceReportAgent（循证深度研究）
 *   KB_EVIDENCE_REPORT(5) → KBEvidenceReportAgent（知识库循证报告）
 *   DRUG_SAFETY(6)        → DrugSafetyAgent（药品安全性分析，下游 Python ADR agent）
 *   FILE_UPLOAD(2)/PPT(3) → 待实现
 */
@Slf4j
@Service
public class AgentDispatcher implements InitializingBean {

    private final ChatModel chatModel;
    private final AgentTaskManager agentTaskManager;
    private final AiSessionService aiSessionService;

    /** 可选：OSS 上传（不注入则 finish 发空 URL） */
    @Autowired(required = false)
    private OssReportUploader ossReportUploader;

    /** 可选：知识库检索工具（不注入则 KB Agent 不可用） */
    @Autowired(required = false)
    private EvidenceRetrievalTool evidenceRetrievalTool;

    @Value("${tavily.api-key}")
    private String tavilyApiKey;

    @Value("${tavily.mcp-url}")
    private String tavilyMcpUrl;

    @Value("${agent.medical-qa.max-rounds:8}")
    private int maxRounds;

    /** 强制走 KB 模式（true=固定返回 KB_EVIDENCE_REPORT，false=启用 LLM 语义分类） */
    @Value("${agent.classification.force-kb:true}")
    private boolean forceKbMode;

    /** 下游药品安全性分析（ADR）Python agent 的 base URL */
    @Value("${drug-safety.agent-url:http://localhost:6010}")
    private String drugSafetyAgentUrl;

    /** 启动时初始化，请求时复用 */
    private ToolCallback[] toolCallbacks;

    public AgentDispatcher(ChatModel chatModel,
                           AgentTaskManager agentTaskManager,
                           AiSessionService aiSessionService) {
        this.chatModel = chatModel;
        this.agentTaskManager = agentTaskManager;
        this.aiSessionService = aiSessionService;
    }

    @Override
    public void afterPropertiesSet() {
        if (tavilyApiKey == null || tavilyApiKey.isBlank()) {
            log.warn("tavily.api-key is blank; Tavily search tools are disabled (agents will run without web-search tools)");
            toolCallbacks = new ToolCallback[0];
            return;
        }
        try {
            log.info("Initializing Tavily tool callbacks...");
            initTavilyToolCallbacks();
            log.info("Tavily tool callbacks initialized, tool count: {}", toolCallbacks.length);
        } catch (Exception e) {
            log.warn("Tavily MCP init failed, falling back to no search tools: {}", e.getMessage());
            toolCallbacks = new ToolCallback[0];
        }
    }

    /**
     * 手动初始化 Tavily MCP 客户端（与 LLmentor 保持一致）
     */
    private void initTavilyToolCallbacks() throws Exception {
        String authorizationHeader = "Bearer " + tavilyApiKey;

        HttpRequest.Builder requestBuilder = HttpRequest.newBuilder()
                .header("Authorization", authorizationHeader);

        HttpClientStreamableHttpTransport transport = HttpClientStreamableHttpTransport
                .builder(tavilyMcpUrl)
                .requestBuilder(requestBuilder)
                .build();

        McpSyncClient tavilyMcp = McpClient.sync(transport)
                .requestTimeout(Duration.ofSeconds(120))
                .build();
        tavilyMcp.initialize();

        SyncMcpToolCallbackProvider provider = SyncMcpToolCallbackProvider.builder()
                .mcpClients(List.of(tavilyMcp))
                .build();

        toolCallbacks = provider.getToolCallbacks();
    }

    /**
     * 按请求懒初始化医学问答 Agent
     */
    private MedicalQAReactAgent initMedicalQAAgent() {
        log.info("初始化医学问答 Agent: tools={}", toolCallbacks.length);
        MedicalQAReactAgent agent = new MedicalQAReactAgent(
                chatModel, Arrays.asList(toolCallbacks), maxRounds);
        agent.setTaskManager(agentTaskManager);
        agent.setSessionService(aiSessionService);
        return agent;
    }

    /**
     * 按请求懒初始化循证报告 Agent（旧版，保留备用）
     */
    private MedicalReportPlanAgent initReportAgent() {
        log.info("初始化循证报告 Agent: tools={}", toolCallbacks.length);
        MedicalReportPlanAgent agent = new MedicalReportPlanAgent(
                chatModel, Arrays.asList(toolCallbacks));
        agent.setTaskManager(agentTaskManager);
        agent.setSessionService(aiSessionService);
        return agent;
    }

    /**
     * 按请求初始化医学循证报告 Agent（六阶段线性链 + 内层搜索循环）
     */
    private MedicalEvidenceReportAgent initMedicalEvidenceReportAgent() {
        log.info("初始化医学循证报告 Agent: tools={}", toolCallbacks.length);
        MedicalEvidenceReportAgent agent = new MedicalEvidenceReportAgent(
                chatModel, Arrays.asList(toolCallbacks));
        agent.setTaskManager(agentTaskManager);
        agent.setSessionService(aiSessionService);
        agent.setOssReportUploader(ossReportUploader);
        return agent;
    }

    /**
     * 按请求初始化循证深度研究 Agent（Plan-Execute-Critique + Scheme C 报告生成）
     */
    private EvidenceDeepResearchAgent initDeepResearchAgent() {
        log.info("初始化循证深度研究 Agent: tools={}", toolCallbacks.length);
        EvidenceDeepResearchAgent agent = new EvidenceDeepResearchAgent(
                chatModel, Arrays.asList(toolCallbacks));
        agent.setTaskManager(agentTaskManager);
        agent.setSessionService(aiSessionService);
        agent.setOssReportUploader(ossReportUploader);
        return agent;
    }

    /**
     * 按请求初始化通用深度研究 Agent（LLMentor PlanExecuteAgent 移植版）
     */
    private GeneralDeepResearchAgent initGeneralDeepResearchAgent() {
        log.info("初始化通用深度研究 Agent: tools={}", toolCallbacks.length);
        GeneralDeepResearchAgent agent = new GeneralDeepResearchAgent(
                chatModel, Arrays.asList(toolCallbacks));
        agent.setTaskManager(agentTaskManager);
        agent.setSessionService(aiSessionService);
        return agent;
    }

    /**
     * 按请求初始化知识库循证报告 Agent（KB + LLM 混合检索）
     */
    private KBEvidenceReportAgent initKBEvidenceReportAgent() {
        if (evidenceRetrievalTool == null) {
            throw new IllegalStateException("EvidenceRetrievalTool 未注入，无法使用 KB 循证报告 Agent");
        }
        log.info("初始化知识库循证报告 Agent: KB tool available");
        KBEvidenceReportAgent agent = new KBEvidenceReportAgent(
                chatModel, evidenceRetrievalTool);
        agent.setTaskManager(agentTaskManager);
        agent.setSessionService(aiSessionService);
        agent.setOssReportUploader(ossReportUploader);
        return agent;
    }

    /**
     * 按请求初始化药品安全性分析 Agent（下游 Python ADR agent，HTTP 轮询）
     */
    private DrugSafetyAgent initDrugSafetyAgent() {
        log.info("初始化药品安全性分析 Agent: agentUrl={}", drugSafetyAgentUrl);
        DrugSafetyAgent agent = new DrugSafetyAgent(chatModel, drugSafetyAgentUrl);
        agent.setTaskManager(agentTaskManager);
        agent.setSessionService(aiSessionService);
        return agent;
    }

    /**
     * 路由并执行 Agent（阻塞，直到完成）
     *
     * 路由三步走：
     *   ① 前端明确指定类型 → 直接使用
     *   ② 默认类型 → 查历史延续上一轮 agent 类型
     *   ③ 无历史 → LLM 语义分类（当前固定 KB，后续放开）
     *
     * @param sessionId 会话ID
     * @param question  用户输入
     * @param agentType 前端传入的 Agent 类型（当前固定为 MEDICAL_QA）
     * @param sink      输出接口
     */
    public void dispatch(String sessionId, String question, AgentType agentType, AgentSink sink) {
        log.info("路由开始 → 前端传入类型={}, sessionId={}, question={}",
                agentType, sessionId, question.substring(0, Math.min(30, question.length())));

        AgentType resolvedType = agentType;

        // ① 前端明确指定了非默认类型 → 直接使用
        if (agentType == AgentType.MEDICAL_QA) {
            // ② 默认类型 → 查历史，延续上一轮 agent 类型
            AgentType fromHistory = resolveFromHistory(sessionId);
            if (fromHistory != null) {
                resolvedType = fromHistory;
            } else {
                // ③ 无历史记录 → LLM 语义分类
                resolvedType = classifyQuestionType(question);
            }
        }

        log.info("最终路由类型: {} → sessionId={}", resolvedType, sessionId);

        // ④ 显式路由，每种类型独立处理
        switch (resolvedType) {
            case MEDICAL_QA -> {
                log.info("路由至通用深度研究 Agent");
                initGeneralDeepResearchAgent().execute(sessionId, question, sink);
            }
            case DEEP_RESEARCH -> {
                log.info("路由至循证深度研究 Agent");
                initKBEvidenceReportAgent().execute(sessionId, question, sink);
            }
            case KB_EVIDENCE_REPORT -> {
                log.info("路由至知识库循证报告 Agent");
                initKBEvidenceReportAgent().execute(sessionId, question, sink);
            }
            case DRUG_SAFETY -> {
                log.info("路由至药品安全性分析 Agent");
                initDrugSafetyAgent().execute(sessionId, question, sink);
            }
            case FILE_UPLOAD, PPT -> {
                sink.error("该功能尚未实现，敬请期待");
            }
        }
    }

    // ======================== 路由辅助方法 ========================

    /**
     * 从历史会话记录中解析上一轮的 Agent 类型，用于追问场景延续同一 Agent。
     * DB 异常时返回 null，不影响主流程。
     *
     * @return 历史类型；无记录、无法识别或 DB 异常时返回 null
     */
    private AgentType resolveFromHistory(String sessionId) {
        try {
            List<AgentSession> recentSessions = aiSessionService.findRecentBySessionId(sessionId, 1);
            if (recentSessions == null || recentSessions.isEmpty()) {
                log.info("无历史会话记录: sessionId={}", sessionId);
                return null;
            }

            String lastAgentType = recentSessions.getFirst().getAgentType();
            AgentType fromHistory = AgentType.fromName(lastAgentType);
            if (fromHistory != null) {
                log.info("延续上一轮 agent 类型: {} → sessionId={}", fromHistory, sessionId);
                return fromHistory;
            }

            log.warn("历史记录中的 agent 类型无法识别: {}, sessionId={}", lastAgentType, sessionId);
            return null;
        } catch (Exception e) {
            log.warn("查询历史会话失败，跳过历史延续: sessionId={}, err={}", sessionId, e.getMessage());
            return null;
        }
    }

    /**
     * LLM 语义分类：判断用户问题应该路由到哪种 Agent。
     * <p>
     * 配置 agent.classification.force-kb=true（默认）时固定返回 KB_EVIDENCE_REPORT，
     * 改为 false 后启用 LLM 语义分类。
     */
    private AgentType classifyQuestionType(String question) {
        // 当前阶段固定走 KB，等其他 Agent 成熟后改配置放开
        if (forceKbMode) {
            log.info("语义分类（固定模式）→ KB_EVIDENCE_REPORT: {}",
                    question.substring(0, Math.min(40, question.length())));
            return AgentType.KB_EVIDENCE_REPORT;
        }

        try {
            String prompt = """
                    你是一个专业的医学问题路由分类专家。你的唯一任务是根据用户输入的问题，判断应由哪种 AI Agent 处理。
                    请严格按照以下分类标准和判断规则执行，不要做任何额外推理。

                    ═══════════════════════════════════════
                    分类一：KB_EVIDENCE_REPORT（医学循证研究）
                    ═══════════════════════════════════════

                    【定义】需要系统性检索医学文献、评价临床证据质量、生成循证医学报告的问题。

                    【核心特征】满足以下任一条即归为此类：
                    • 需要检索临床试验（RCT）、Meta 分析、系统综述等循证证据
                    • 涉及药物/治疗方案/诊断方法的有效性、安全性、获益-风险评价
                    • 需要对比不同干预措施的临床结局
                    • 涉及卫生技术评估（HTA）、药物经济学、成本-效果分析
                    • 需要依据证据等级体系（如 GRADE）给出推荐
                    • 涉及临床实践指南的证据基础分析
                    • 需要对特定医学问题进行系统性文献综述
                    • 涉及医疗器械/新技术的临床证据评价
                    • 涉及流行病学数据、发病率、死亡率的循证分析

                    【典型问题示例】
                    - "SGLT2 抑制剂对 2 型糖尿病合并慢性肾病的肾脏保护作用有哪些循证证据？"
                    - "免疫检查点抑制剂联合化疗 vs 单药化疗治疗晚期非小细胞肺癌的疗效和安全性对比"
                    - "他汀类药物导致横纹肌溶解的风险因素和发生率"
                    - "GLP-1 受体激动剂在肥胖管理中的长期心血管获益证据"
                    - "阿司匹林用于心血管疾病一级预防的获益-风险评估"
                    - "CAR-T 细胞治疗复发/难治性弥漫大 B 细胞淋巴瘤的临床证据"
                    - "达格列净 vs 恩格列净在心衰治疗中的头对头比较证据"
                    - "HPV 疫苗预防宫颈癌的长期随访数据和真实世界证据"

                    ═══════════════════════════════════════
                    分类二：DEEP_RESEARCH（深度研究）
                    ═══════════════════════════════════════

                    【定义】需要多维度深入分析但不以循证医学文献检索为核心的专业研究问题。

                    【核心特征】
                    • 需要广泛收集信息、多角度分析的专业话题
                    • 行业研究、技术趋势、市场分析
                    • 政策解读、法规分析
                    • 跨学科综合研究
                    • 医学相关但重点不在临床证据评价（如产业分析、技术原理）

                    【典型问题示例】
                    - "AI 大模型在药物研发中的应用现状和前景"
                    - "基因编辑技术 CRISPR 的伦理争议和全球监管政策"
                    - "全球生物医药产业 2024 年投融资趋势分析"
                    - "mRNA 技术平台的技术路线对比和商业化前景"
                    - "中国医保谈判制度的演变及对创新药企的影响"

                    ═══════════════════════════════════════
                    分类三：MEDICAL_QA（通用问答）
                    ═══════════════════════════════════════

                    【定义】简单直接的问答、科普、常识性问题，不需要系统性文献检索或深度研究。

                    【核心特征】
                    • 医学常识科普、概念解释、名词定义
                    • 日常健康建议、生活方式指导
                    • 简单的疾病/症状介绍
                    • 非医学领域的一般性问题

                    【典型问题示例】
                    - "什么是高血压？日常如何预防？"
                    - "感冒和流感有什么区别？"
                    - "维生素 D 的推荐每日摄入量是多少？"
                    - "最近有什么科技新闻？"
                    - "帮我写一篇会议纪要"

                    ═══════════════════════════════════════
                    分类四：DRUG_SAFETY（药品安全性 / 不良反应 / ADR 信号分析）
                    ═══════════════════════════════════════

                    【定义】需要基于 FAERS 不良事件数据库做药物警戒信号挖掘、
                    药品不良反应（ADR）安全性评价的问题。

                    【核心特征】满足以下任一条即归为此类：
                    • 明确提到"不良反应 / ADR / 不良事件 / 药物警戒"并要求分析
                    • 需要基于 FAERS 等自发呈报数据库做信号挖掘（ROR/PRR 等）
                    • 针对单个药品的安全性信号检测、风险信号评价
                    • 关注某药品与特定不良事件（如横纹肌溶解、肺炎）之间的关联信号

                    【典型问题示例】
                    - "帮我分析阿托伐他汀的ADR"
                    - "二甲双胍不良反应信号"
                    - "利妥昔单抗致肺炎的安全性分析"
                    - "基于FAERS分析奥司他韦的精神神经不良事件信号"
                    - "帮我做一个布洛芬的药物警戒信号挖掘"

                    ═══════════════════════════════════════
                    判断规则（严格按优先级执行）
                    ═══════════════════════════════════════

                    1. 【ADR 强信号关键词】问题中出现以下关键词 → DRUG_SAFETY
                       不良反应、ADR、不良事件、FAERS、药物警戒、信号挖掘、
                       自发呈报、ROR、PRR、横纹肌溶解、致肺炎、致心律失常

                    2. 【强信号关键词】问题中出现以下关键词 → KB_EVIDENCE_REPORT
                       循证、证据、系统综述、Meta 分析、RCT、随机对照试验、临床试验、
                       指南推荐、HTA、卫生技术评估、药物评价、疗效对比、安全性评估、
                       获益-风险、证据等级、GRADE、NNT、NNH、不良反应发生率、
                       真实世界研究、队列研究、病例对照、生存分析、HR/OR/RR

                    3. 【药物/治疗评价】涉及具体药物名称（通用名或商品名）+ 疗效/安全性/
                       对比/优劣/副作用/禁忌等评价性问题 → KB_EVIDENCE_REPORT

                    4. 【深度专业研究】不涉及临床证据评价，但需要广泛收集信息并进行
                       多维度深入分析的专业话题 → DEEP_RESEARCH

                    5. 【简单问答】科普、常识、定义解释、日常建议、非专业话题 → MEDICAL_QA

                    6. 【兜底规则】无法明确判断时 → KB_EVIDENCE_REPORT
                       （倾向提供更专业、更完整的循证分析）

                    ═══════════════════════════════════════

                    用户问题：
                    %s

                    请只输出一个类型名称，不要有任何解释或其他内容：
                    KB_EVIDENCE_REPORT 或 DEEP_RESEARCH 或 MEDICAL_QA 或 DRUG_SAFETY
                    """.formatted(question);

            String result = ChatClient.builder(chatModel).build()
                    .prompt()
                    .user(prompt)
                    .call()
                    .content();

            if (result != null) {
                String trimmed = result.trim().toUpperCase();
                AgentType classified = AgentType.fromName(trimmed);
                if (classified != null) {
                    log.info("LLM 语义分类结果: {} → {}",
                            classified, question.substring(0, Math.min(40, question.length())));
                    return classified;
                }
            }

            log.warn("LLM 分类结果无法解析: '{}', 降级为 KB_EVIDENCE_REPORT", result);
            return AgentType.KB_EVIDENCE_REPORT;

        } catch (Exception e) {
            log.warn("LLM 语义分类调用失败，降级为 KB_EVIDENCE_REPORT: {}", e.getMessage());
            return AgentType.KB_EVIDENCE_REPORT;
        }
    }
}
