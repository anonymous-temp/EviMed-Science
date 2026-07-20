package com.evimed.agent.evidence.agentevidencebased.tools;

import java.util.List;

/**
 * 知识库搜索端口（接口）
 *
 * 隔离 EvidenceRetrievalTool 与底层搜索基础设施（Zilliz 向量库、Elasticsearch、NMPA/FDA 说明书索引）。
 * 集成方实现此接口并注入 Spring 容器即可。
 *
 * 具体实现可参考 evidence-ai-based 项目的 EvidenceUtils 工具类：
 *   - searchByVector    → EvidenceUtils.getPaperBlock()
 *   - searchPapers      → EvidenceUtils.searchByEsBm25Grouped()
 *   - searchGuides      → EvidenceUtils.searchGuideByKeywordsGrouped()
 *   - searchInstructions → EvidenceUtils.searchInstructionsByKeywords()
 *   - fetchDrugInstruction → EvidenceUtils.fetchInstructionByDrugName()
 */
public interface EvidenceSearchPort {

    /**
     * 向量语义检索文献文本块
     *
     * @param sessionId   当前会话ID，用于去重（可为 null）
     * @param query       检索语句（自然语言，英文效果更好）
     * @param drugKeywords   药物/干预词列表（用于 PICO 过滤）
     * @param diseaseKeywords 疾病/人群词列表（用于 PICO 过滤）
     * @param topN        最大返回条数
     * @return 文献列表（字段：id, title, year, type, text/snippet, url）
     */
    List<EvidenceRetrievalTool.EvidenceItem> searchByVector(
            String sessionId,
            String query,
            List<String> drugKeywords,
            List<String> diseaseKeywords,
            int topN);

    /**
     * BM25 关键词检索文献（支持按文献类型过滤）
     *
     * @param sessionId       当前会话ID，用于去重（可为 null）
     * @param drugKeywords    药物/干预词列表
     * @param diseaseKeywords 疾病/人群词列表
     * @param topicKeywords   章节话题词列表（typeIds 非空时忽略）
     * @param typeIds         文献类型码列表，如 [0,2,14]；为空则不过滤类型
     * @param topN            最大返回条数
     */
    List<EvidenceRetrievalTool.EvidenceItem> searchPapers(
            String sessionId,
            List<String> drugKeywords,
            List<String> diseaseKeywords,
            List<String> topicKeywords,
            List<Integer> typeIds,
            int topN);

    /**
     * 临床指南关键词检索（两阶段：精准 + 降级）
     */
    List<EvidenceRetrievalTool.EvidenceItem> searchGuides(
            String sessionId,
            List<String> drugKeywords,
            List<String> diseaseKeywords,
            List<String> topicKeywords,
            int topN);

    /**
     * 药品说明书关键词检索（NMPA + FDA）
     */
    List<EvidenceRetrievalTool.EvidenceItem> searchInstructions(
            List<String> keywords,
            int topN);

    /**
     * 按药名精确获取说明书结构化内容
     */
    List<EvidenceRetrievalTool.EvidenceItem> fetchDrugInstruction(
            String drugName,
            String englishName);

    /**
     * 查询 FAERS 数据库（FDA 不良事件报告系统）
     *
     * @param drugName    药物中文通用名
     * @param englishName 药物英文通用名
     * @return FAERS 数据项（包含报告数、常见不良反应 TOP10、安全信号挖掘 TOP10）
     */
    List<EvidenceRetrievalTool.EvidenceItem> searchFaers(
            String drugName,
            String englishName);
}
