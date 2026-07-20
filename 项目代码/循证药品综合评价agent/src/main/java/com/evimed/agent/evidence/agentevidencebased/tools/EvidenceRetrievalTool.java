package com.evimed.agent.evidence.agentevidencebased.tools;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.rag.Query;
import org.springframework.ai.rag.preretrieval.query.expansion.MultiQueryExpander;
import org.springframework.ai.rag.preretrieval.query.expansion.QueryExpander;
import org.springframework.ai.rag.preretrieval.query.transformation.CompressionQueryTransformer;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.stream.Collectors;

/**
 * 知识库证据检索工具（适配版）
 *
 * 原始来自 evidence-ai-based 项目的 EvidenceRetrievalTool，做如下适配：
 * 1. 去掉 ThreadLocal PICO 注入 → 改为 LLM 通过 @ToolParam 显式传递药物/疾病关键词
 * 2. LlmGateway → ChatClient（本项目标准方式）
 * 3. 搜索实现委托给 {@link EvidenceSearchPort}，由集成方注入具体实现
 *
 * LLM 调用任何 @Tool 方法时必须显式传入 drugKeywords / diseaseKeywords，
 * 系统不再从 ThreadLocal 自动注入。
 */
@Slf4j
@Component
public class EvidenceRetrievalTool {

    private static final int DEFAULT_TOP_N = 10;

    private final ChatClient chatClient;
    private final EvidenceSearchPort searchPort;

    public EvidenceRetrievalTool(ChatModel chatModel, EvidenceSearchPort searchPort) {
        this.chatClient = ChatClient.builder(chatModel).build();
        this.searchPort = searchPort;
    }

    // ==================== DTO ====================

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class EvidenceItem {
        private String id;
        private String source;   // BLOCK / ES_BM25 / GUIDE / INSTRUCTION
        private String title;
        private String year;
        private String summary;
        private String nrjs;    // 指南专用：内容摘录（其他类型为 null）
        private String type;    // 文献专用：研究设计类型（RCT/Meta分析等，其他类型为 null）
        private String snippet;
        private String url;
        private Map<String, String> raw;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class EvidenceResponse {
        private String query;
        private List<EvidenceItem> items;
        private Map<String, Integer> countsBySource;
        private String notice;
    }

    // ==================== @Tool 方法 ====================

    /**
     * 向量语义检索（文献全文文本块）
     * 适合自由文本查询，覆盖面广，适用于获取研究背景、综述型证据。
     */
    @Tool(description = "Vector semantic search for literature text blocks. " +
            "Best for free-text queries. Covers clinical studies, meta-analyses, systematic reviews. " +
            "Provide explicit drug and disease keywords for filtering.",
            returnDirect = false)
    public EvidenceResponse searchPaperBlocks(
            @ToolParam(description = "中文搜索意图描述，用于进度展示（如：检索甲氨蝶呤治疗类风湿关节炎的疗效研究）")
            String searchIntent,
            @ToolParam(description = "自然语言查询，描述需要的证据（英文效果更好，如：methotrexate efficacy rheumatoid arthritis）")
            String query,
            @ToolParam(required = false, description = "药物/干预措施关键词，逗号分隔（如：甲氨蝶呤,methotrexate,MTX）")
            String drugKeywords,
            @ToolParam(required = false, description = "疾病/适应症关键词，逗号分隔（如：类风湿关节炎,rheumatoid arthritis,RA）")
            String diseaseKeywords,
            @ToolParam(required = false, description = "最大返回条数，默认 8，最大 20")
            Integer size,
            @ToolParam(required = false, description = "当前会话ID，从上下文 <sessionid> 标签读取，用于自动过滤已返回过的重复结果")
            String sessionId) {

        if (query == null || query.isBlank()) {
            return emptyResponse(query);
        }
        int topN = (size != null && size > 0) ? size : DEFAULT_TOP_N;
        List<String> drugList    = parseKeywords(drugKeywords);
        List<String> diseaseList = parseKeywords(diseaseKeywords);

        // 1. LLM 扩展查询（HyDE + 变体）
        List<String> queries = expandQuery(query);

        // 2. 并行向量检索
        List<List<EvidenceItem>> rankedLists = new ArrayList<>();
        for (String q : queries) {
            try {
                List<EvidenceItem> hits = searchPort.searchByVector(sessionId, q, drugList, diseaseList, topN * 2);
                if (!hits.isEmpty()) rankedLists.add(hits);
            } catch (Exception e) {
                log.warn("向量检索失败，跳过 query='{}': {}", q, e.getMessage());
            }
        }

        // 3. RRF 融合 + rerank
        List<EvidenceItem> items = rrfMerge(rankedLists, query, topN);

        log.info("searchPaperBlocks: query='{}', drug={}, disease={}, {} 条",
                query, drugList.size(), diseaseList.size(), items.size());
        return EvidenceResponse.builder()
                .query(query)
                .items(items)
                .countsBySource(Map.of("BLOCK", items.size()))
                .build();
    }

    /**
     * BM25 关键词检索（文献）
     * 适合精确关键词匹配，速度快，召回确定性强。
     */
    @Tool(description = "BM25 keyword search for literature papers. " +
            "IMPORTANT: Always extract key feature keywords from searchIntent and pass to topicKeywords. " +
            "Examples: '老年患者' → topicKeywords='老年', '儿童用药' → topicKeywords='儿童', '孕妇安全性' → topicKeywords='孕妇'.",
            returnDirect = false)
    public EvidenceResponse searchPapers(
            @ToolParam(description = "中文搜索意图描述（如：检索利妥昔单抗治疗老年患者肾病综合症的RCT）")
            String searchIntent,
            @ToolParam(required = false, description = "药物/干预措施关键词，逗号分隔")
            String drugKeywords,
            @ToolParam(required = false, description = "疾病/适应症关键词，逗号分隔")
            String diseaseKeywords,
            @ToolParam(required = false, description = "关键特征词（最简形式），用于 ES 关键词精准匹配。从 searchIntent 提取核心特征，如：老年、儿童、孕妇、透析、肝功能不全等。多个词用逗号分隔")
            String topicKeywords,
            @ToolParam(required = false, description = "最大返回条数，默认 8，最大 10")
            Integer size,
            @ToolParam(required = false, description = "当前会话ID，从上下文 <sessionid> 标签读取，用于自动过滤已返回过的重复结果")
            String sessionId,
            @ToolParam(required = false, description = """
                    文献类型过滤，逗号分隔的类型编码（不填则返回所有类型）。
                    类型编码对照：0=系统综述/Meta分析, 1=传统综述, 2=随机对照试验(RCT), 3=队列研究, \
                    4=病例对照研究, 5=横断面研究, 6=病例系列, 7=病例报告, \
                    8=专家意见和评价, 12=经济学评价, 14=临床试验。
                    示例：填入 "0,2,14" 表示只检索系统综述、RCT和临床试验。""")
            String literatureTypes) {

        List<String> drugList    = parseKeywords(drugKeywords);
        List<String> diseaseList = parseKeywords(diseaseKeywords);
        List<String> topicList   = parseKeywords(topicKeywords);
        List<Integer> typeIds    = parseLiteratureTypes(literatureTypes);

        if (drugList.isEmpty() && diseaseList.isEmpty() && topicList.isEmpty()) {
            log.warn("searchPapers: 所有关键词为空");
            return emptyResponse(topicKeywords);
        }

        int topN = (size != null && size > 0) ? size : DEFAULT_TOP_N;
        try {
            List<EvidenceItem> items = searchPort.searchPapers(sessionId, drugList, diseaseList, topicList, typeIds, topN);
            log.info("searchPapers: drug={} disease={} topic='{}' types={}, {} 条",
                    drugList.size(), diseaseList.size(), topicKeywords, typeIds, items.size());
            return EvidenceResponse.builder()
                    .query("drug:" + drugList + " topic:" + topicKeywords + " types:" + typeIds)
                    .items(items)
                    .countsBySource(Map.of("ES_BM25", items.size()))
                    .build();
        } catch (Exception e) {
            log.error("searchPapers 失败: {}", e.getMessage());
            return emptyResponse(topicKeywords);
        }
    }

    /**
     * 临床指南 / 共识文件检索
     * 两阶段：先精准（药物 AND 疾病），无结果则降级为疾病 only。
     */
    @Tool(description = "Search clinical guidelines and consensus documents. " +
            "IMPORTANT: Always extract key feature keywords from searchIntent and pass to topicKeywords. " +
            "Examples: '老年患者' → topicKeywords='老年', '儿童用药' → topicKeywords='儿童', '孕妇安全性' → topicKeywords='孕妇'.",
            returnDirect = false)
    public EvidenceResponse searchGuides(
            @ToolParam(description = "中文搜索意图描述（如：检索乌帕替尼治疗类风湿关节炎的临床指南）")
            String searchIntent,
            @ToolParam(required = false, description = "药物/干预措施关键词，逗号分隔")
            String drugKeywords,
            @ToolParam(required = false, description = "疾病/适应症关键词，逗号分隔")
            String diseaseKeywords,
            @ToolParam(required = false, description = "关键特征词（最简形式），用于 ES 关键词精准匹配。从 searchIntent 提取核心特征，如：老年、儿童、孕妇、透析、肝功能不全等。多个词用逗号分隔")
            String topicKeywords,
            @ToolParam(required = false, description = "最大返回条数，默认 5，最大 15")
            Integer size,
            @ToolParam(required = false, description = "当前会话ID，从上下文 <sessionid> 标签读取，用于自动过滤已返回过的重复结果")
            String sessionId) {

        List<String> drugList    = parseKeywords(drugKeywords);
        List<String> diseaseList = parseKeywords(diseaseKeywords);
        List<String> topicList   = parseKeywords(topicKeywords);
        int topN = (size != null && size > 0) ? size : DEFAULT_TOP_N;

        try {
            List<EvidenceItem> items = searchPort.searchGuides(sessionId, drugList, diseaseList, topicList, topN);
            log.info("searchGuides: drug={} disease={} topic='{}', {} 条",
                    drugList.size(), diseaseList.size(), topicKeywords, items.size());
            return EvidenceResponse.builder()
                    .query("drug:" + drugList + " disease:" + diseaseList + " topic:" + topicKeywords)
                    .items(items)
                    .countsBySource(Map.of("GUIDE", items.size()))
                    .build();
        } catch (Exception e) {
            log.error("searchGuides 失败: {}", e.getMessage());
            return emptyResponse(searchIntent);
        }
    }

    /**
     * 药品说明书检索（NMPA + FDA）
     * 适合查询官方适应症、批准日期、监管状态。
     */
//    @Tool(description = "Search drug package inserts from NMPA (China) and FDA (USA). " +
//            "Returns official indications, approval dates, and regulatory status. " +
//            "IMPORTANT: Only call this tool ONCE per task. Do not retry if no results are found.",
//            returnDirect = false)
    public EvidenceResponse searchInstructions(
            @ToolParam(description = "中文搜索意图描述（如：检索乌帕替尼药品说明书）")
            String searchIntent,
            @ToolParam(description = "药物或疾病关键词，逗号分隔（如：乌帕替尼,upadacitinib）")
            String keywords) {

        if (keywords == null || keywords.isBlank()) {
            return emptyResponse(keywords);
        }
        List<String> kwList = parseKeywords(keywords);

        try {
            List<EvidenceItem> items = searchPort.searchInstructions(kwList, 5);
            log.info("searchInstructions: keywords='{}', {} 条", keywords, items.size());
            return EvidenceResponse.builder()
                    .query(keywords)
                    .items(items)
                    .countsBySource(Map.of("INSTRUCTION", items.size()))
                    .build();
        } catch (Exception e) {
            log.error("searchInstructions 失败: {}", e.getMessage());
            return emptyResponse(keywords);
        }
    }

    /**
     * 按药名精确获取说明书结构化内容（药理/适应症/禁忌/用法）
     * 专为报告"干预措施介绍"章节设计。
     */
    @Tool(description = "Fetch structured prescribing information for a specific drug. " +
            "Returns pharmacology, indications, contraindications, and dosage in formatted Markdown. " +
            "Use for the '干预措施介绍' section.",
            returnDirect = false)
    public EvidenceResponse fetchDrugInstruction(
            @ToolParam(description = "药物中文通用名（如：乌帕替尼）")
            String drugName,
            @ToolParam(description = "药物英文通用名（如：upadacitinib）。不确定可留空")
            String englishName) {

        if (drugName == null || drugName.isBlank()) {
            return emptyResponse(drugName);
        }
        try {
            List<EvidenceItem> items = searchPort.fetchDrugInstruction(drugName, englishName);
            log.info("fetchDrugInstruction: drug='{}' / '{}', {} 条", drugName, englishName, items.size());
            return EvidenceResponse.builder()
                    .query(drugName)
                    .items(items)
                    .countsBySource(Map.of("INSTRUCTION", items.size()))
                    .build();
        } catch (Exception e) {
            log.error("fetchDrugInstruction 失败: {}", e.getMessage());
            return emptyResponse(drugName);
        }
    }

    /**
     * 查询 FAERS 数据库（FDA 不良事件报告系统）
     * 获取指定药物的不良事件报告数量、常见不良反应 TOP10、安全信号挖掘结果。
     */
    @Tool(description = "Query FDA Adverse Event Reporting System (FAERS) database. " +
            "Returns adverse event report counts, top 10 common adverse reactions, " +
            "and safety signal mining results (ROR/EBGM/IC metrics) in Markdown tables. " +
            "Use for drug safety analysis sections.",
            returnDirect = false)
    public EvidenceResponse searchFaers(
            @ToolParam(description = "中文搜索意图描述（如：检索乌帕替尼的FAERS不良事件数据）")
            String searchIntent,
            @ToolParam(description = "药物中文通用名（如：乌帕替尼）")
            String drugName,
            @ToolParam(description = "药物英文通用名（如：upadacitinib）。不确定可留空")
            String englishName) {

        if ((drugName == null || drugName.isBlank()) && (englishName == null || englishName.isBlank())) {
            return emptyResponse(searchIntent);
        }
        try {
            List<EvidenceItem> items = searchPort.searchFaers(drugName, englishName);
            log.info("searchFaers: drug='{}' / '{}', {} 条", drugName, englishName, items.size());
            return EvidenceResponse.builder()
                    .query(drugName != null ? drugName : englishName)
                    .items(items)
                    .countsBySource(Map.of("FAERS", items.size()))
                    .build();
        } catch (Exception e) {
            log.error("searchFaers 失败: {}", e.getMessage());
            return emptyResponse(searchIntent);
        }
    }

    // ==================== 辅助方法 ====================

    /**
     * 使用 ChatClient 将原始 query 扩展为多个语义等价变体（压缩重写 + 扩展）
     * 失败时降级为只用原始 query
     */
    private List<String> expandQuery(String query) {
        try {
            Query q = Query.builder().text(query).build();

            // 1. 问题压缩重写
            CompressionQueryTransformer queryTransformer = CompressionQueryTransformer.builder()
                    .chatClientBuilder(chatClient.mutate())
                    .build();
            Query compressed = queryTransformer.transform(q);
            log.debug("压缩重写后的Query: {}", compressed.text());

            // 2. 问题扩展（3个变体 + 原始）
            QueryExpander queryExpander = MultiQueryExpander.builder()
                    .chatClientBuilder(chatClient.mutate())
                    .numberOfQueries(3)
                    .includeOriginal(true)
                    .build();
            List<Query> expandedQueries = queryExpander.expand(compressed);
            log.debug("扩展后的Query数量：{}", expandedQueries.size());

            return expandedQueries.stream()
                    .map(Query::text)
                    .filter(t -> t != null && !t.isBlank())
                    .distinct()
                    .toList();

        } catch (Exception e) {
            log.debug("query 压缩/扩展失败，仅用原始 query: {}", e.getMessage());
            return List.of(query);
        }
    }

    /**
     * RRF 融合多路排序列表，取前 topN
     */
    private List<EvidenceItem> rrfMerge(List<List<EvidenceItem>> rankedLists, String query, int topN) {
        if (rankedLists.isEmpty()) return Collections.emptyList();
        final int K = 60;
        Map<String, Double>       scores  = new LinkedHashMap<>();
        Map<String, EvidenceItem> itemMap = new LinkedHashMap<>();

        for (List<EvidenceItem> list : rankedLists) {
            for (int i = 0; i < list.size(); i++) {
                EvidenceItem item = list.get(i);
                String id = item.getId();
                if (id == null || id.isBlank()) continue;
                scores.merge(id, 1.0 / (K + i + 1), Double::sum);
                itemMap.putIfAbsent(id, item);
            }
        }

        return scores.entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                .limit(topN)
                .map(e -> itemMap.get(e.getKey()))
                .filter(Objects::nonNull)
                .collect(Collectors.toList());
    }

    private static EvidenceResponse emptyResponse(String query) {
        return EvidenceResponse.builder()
                .query(query)
                .items(Collections.emptyList())
                .countsBySource(Collections.emptyMap())
                .build();
    }


    private static List<String> parseKeywords(String s) {
        if (s == null || s.isBlank()) return Collections.emptyList();
        return Arrays.stream(s.split("[,，]"))
                .map(String::trim)
                .filter(k -> !k.isBlank())
                .distinct()
                .collect(Collectors.toList());
    }

    private static List<Integer> parseLiteratureTypes(String s) {
        if (s == null || s.isBlank()) return Collections.emptyList();
        return Arrays.stream(s.split("[,，]"))
                .map(String::trim)
                .filter(k -> !k.isBlank())
                .map(k -> {
                    try { return Integer.parseInt(k); }
                    catch (NumberFormatException e) {
                        log.warn("parseLiteratureTypes: 无效类型码 '{}'，已跳过", k);
                        return null;
                    }
                })
                .filter(Objects::nonNull)
                .distinct()
                .collect(Collectors.toList());
    }
}
