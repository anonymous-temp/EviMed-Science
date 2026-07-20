package com.evimed.agent.evidence.agentevidencebased.tools;

import com.evimed.agent.evidence.agentevidencebased.entity.annotation.EvidenceReturnedId;
import com.evimed.agent.evidence.agentevidencebased.infrastructure.util.EvidenceUtils;
import com.evimed.agent.evidence.agentevidencebased.mapper.EvidenceReturnedIdMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.stream.Collectors;
import java.util.HashSet;
import java.util.Set;

@Slf4j
@Component
public class StubEvidenceSearchPort implements EvidenceSearchPort {

    private final EvidenceReturnedIdMapper returnedIdMapper;

    public StubEvidenceSearchPort(EvidenceReturnedIdMapper returnedIdMapper) {
        this.returnedIdMapper = returnedIdMapper;
    }

    @Override
    public List<EvidenceRetrievalTool.EvidenceItem> searchByVector(
            String sessionId, String query, List<String> drugKeywords, List<String> diseaseKeywords, int topN) {
        try {
            Map<String, List<String>> picoGroups = new HashMap<>();
            if (!drugKeywords.isEmpty()) picoGroups.put("i", drugKeywords);
            if (!diseaseKeywords.isEmpty()) picoGroups.put("p", diseaseKeywords);
            List<Map<String, String>> raw = EvidenceUtils.getPaperBlock(query, picoGroups);
            // 向量检索底层暂不支持 excludeIds，在结果层做过滤
            Set<String> excludeIds = Collections.emptySet();
            if (sessionId != null && !sessionId.isBlank()) {
                List<String> ids = returnedIdMapper.selectReturnedIds(sessionId, "BLOCK");
                excludeIds = new HashSet<>(ids);
            }
            final Set<String> finalExcludeIds = excludeIds;
            List<Map<String, String>> filtered = raw.stream()
                    .filter(m -> {
                        String id = m.get("dbId");
                        return id == null || id.isBlank() || !finalExcludeIds.contains(id);
                    })
                    .collect(Collectors.toList());
            // 保存新返回的 id
            if (sessionId != null && !sessionId.isBlank()) {
                for (Map<String, String> m : filtered) {
                    String id = m.get("dbId");
                    if (id != null && !id.isBlank()) {
                        try {
                            EvidenceReturnedId record = new EvidenceReturnedId();
                            record.setSessionId(sessionId);
                            record.setEvidenceType("BLOCK");
                            record.setEvidenceId(id);
                            returnedIdMapper.insert(record);
                        } catch (Exception ignore) { /* 忽略重复插入 */ }
                    }
                }
            }
            return filtered.stream().limit(topN).map(m -> toItem(m, "BLOCK")).collect(Collectors.toList());
        } catch (Exception e) {
            log.error("searchByVector 失败: {}", e.getMessage(), e);
            return Collections.emptyList();
        }
    }

    @Override
    public List<EvidenceRetrievalTool.EvidenceItem> searchPapers(
            String sessionId, List<String> drugKeywords, List<String> diseaseKeywords,
            List<String> topicKeywords, List<Integer> typeIds, int topN) {
        try {
            // 查询已返回的 BM25 文献 id（用于 ES 层排除）
            Set<String> excludeIds = Collections.emptySet();
            if (sessionId != null && !sessionId.isBlank()) {
                List<String> ids = returnedIdMapper.selectReturnedIds(sessionId, "ES_BM25");
                excludeIds = new HashSet<>(ids);
            }

            List<Map<String, String>> raw;
            if (typeIds != null && typeIds.size() > 1) {
                // 多类型场景：每种类型单独查询，每种返回 5~8 篇
                // 避免 ES 评分机制导致某一高分类型垄断所有结果
                int perTypeSize = Math.min(8, Math.max(5, topN));
                raw = new ArrayList<>();
                // seenIds 从 excludeIds 出发，跨类型累积，防止同一文献重复出现
                Set<String> seenIds = new HashSet<>(excludeIds);
                for (Integer typeId : typeIds) {
                    List<Map<String, String>> partial = EvidenceUtils.searchByEsBm25Grouped(
                            drugKeywords, diseaseKeywords, topicKeywords,
                            List.of(typeId), perTypeSize, seenIds);
                    partial.stream()
                            .map(m -> m.get("dbId"))
                            .filter(id -> id != null && !id.isBlank())
                            .forEach(seenIds::add);
                    raw.addAll(partial);
                }
            } else {
                // 单类型或无类型：直接查，topN 即总限制
                raw = EvidenceUtils.searchByEsBm25Grouped(
                        drugKeywords, diseaseKeywords, topicKeywords, typeIds, topN, excludeIds);
            }

            // 保存新返回的 dbId
            if (sessionId != null && !sessionId.isBlank()) {
                for (Map<String, String> m : raw) {
                    String id = m.get("dbId");
                    if (id != null && !id.isBlank()) {
                        try {
                            EvidenceReturnedId record = new EvidenceReturnedId();
                            record.setSessionId(sessionId);
                            record.setEvidenceType("ES_BM25");
                            record.setEvidenceId(id);
                            returnedIdMapper.insert(record);
                        } catch (Exception ignore) { /* 忽略重复插入 */ }
                    }
                }
            }
            return raw.stream().map(m -> toItem(m, "ES_BM25")).collect(Collectors.toList());
        } catch (Exception e) {
            log.error("searchPapers 失败: {}", e.getMessage(), e);
            return Collections.emptyList();
        }
    }

    @Override
    public List<EvidenceRetrievalTool.EvidenceItem> searchGuides(
            String sessionId, List<String> drugKeywords, List<String> diseaseKeywords,
            List<String> topicKeywords, int topN) {
        try {
            // 查询已返回的 guideId（sessionId 为空则不去重）
            List<String> excludeIds = (sessionId != null && !sessionId.isBlank())
                    ? returnedIdMapper.selectReturnedIds(sessionId, "GUIDE")
                    : Collections.emptyList();

            List<Map<String, String>> raw = EvidenceUtils.searchGuidesSimplified(
                    drugKeywords, diseaseKeywords, topicKeywords, topN, excludeIds);

            // 保存新返回的 guideId
            if (sessionId != null && !sessionId.isBlank()) {
                for (Map<String, String> m : raw) {
                    String guideId = m.get("guideId");
                    if (guideId != null && !guideId.isBlank()) {
                        try {
                            EvidenceReturnedId record = new EvidenceReturnedId();
                            record.setSessionId(sessionId);
                            record.setEvidenceType("GUIDE");
                            record.setEvidenceId(guideId);
                            returnedIdMapper.insert(record);
                        } catch (Exception ignore) { /* 忽略重复插入 */ }
                    }
                }
            }

            return raw.stream().map(m -> toGuideItem(m)).collect(Collectors.toList());
        } catch (Exception e) {
            log.error("searchGuides 失败: {}", e.getMessage(), e);
            return Collections.emptyList();
        }
    }

    @Override
    public List<EvidenceRetrievalTool.EvidenceItem> searchInstructions(List<String> keywords, int topN) {
        try {
            List<Map<String, String>> raw = EvidenceUtils.searchInstructionsByKeywords(keywords, topN);
            return raw.stream().map(m -> toInstructionItem(m)).collect(Collectors.toList());
        } catch (Exception e) {
            log.error("searchInstructions 失败: {}", e.getMessage(), e);
            return Collections.emptyList();
        }
    }

    @Override
    public List<EvidenceRetrievalTool.EvidenceItem> fetchDrugInstruction(String drugName, String englishName) {
        try {
            List<Map<String, String>> raw = EvidenceUtils.fetchInstructionByDrugName(drugName, englishName);
            return raw.stream().map(m -> toInstructionItemWithSnippet(m)).collect(Collectors.toList());
        } catch (Exception e) {
            log.error("fetchDrugInstruction 失败: {}", e.getMessage(), e);
            return Collections.emptyList();
        }
    }

    private EvidenceRetrievalTool.EvidenceItem toItem(Map<String, String> m, String source) {
        return EvidenceRetrievalTool.EvidenceItem.builder()
                .id(m.get("dbId"))
                .source(source)
                .title(m.get("title"))
                .year(m.get("year"))
                .type(m.get("type"))
                .snippet(m.get("text"))
                .summary(m.get("summary"))
                .url(m.get("url"))
                .raw(m)
                .build();
    }

    private EvidenceRetrievalTool.EvidenceItem toGuideItem(Map<String, String> m) {
        return EvidenceRetrievalTool.EvidenceItem.builder()
                .id(m.get("guideId"))
                .source("GUIDE")
                .title(m.get("title"))
                .year(m.get("year"))
                .summary(m.get("summary"))
                .nrjs(m.get("nrjs"))
                .snippet(m.get("text"))
                .url(m.get("url"))
                .raw(m)
                .build();
    }

    private EvidenceRetrievalTool.EvidenceItem toInstructionItem(Map<String, String> m) {
        return EvidenceRetrievalTool.EvidenceItem.builder()
                .id(m.get("id"))
                .source("INSTRUCTION")
                .title(m.get("genericNames"))
                .snippet(m.get("indication"))
                .url(m.get("url"))
                .raw(m)
                .build();
    }

    private EvidenceRetrievalTool.EvidenceItem toInstructionItemWithSnippet(Map<String, String> m) {
        StringBuilder sb = new StringBuilder();
        String pharmacology = m.getOrDefault("pharmacology", "");
        String indication   = m.getOrDefault("indication", "");
        String taboo        = m.getOrDefault("taboo", "");
        String usage        = m.getOrDefault("usage", "");
        if (!pharmacology.isBlank()) sb.append("**药理作用：**\n\n").append(pharmacology).append("\n\n");
        if (!indication.isBlank())   sb.append("**适应症：**\n\n").append(indication).append("\n\n");
        if (!taboo.isBlank())        sb.append("**禁忌症：**\n\n").append(taboo).append("\n\n");
        if (!usage.isBlank())        sb.append("**用法用量：**\n\n").append(usage).append("\n\n");
        return EvidenceRetrievalTool.EvidenceItem.builder()
                .id(m.get("id"))
                .source("INSTRUCTION")
                .title(m.get("genericNames"))
                .snippet(sb.toString().trim())
                .url(m.get("url"))
                .raw(m)
                .build();
    }

    @Override
    public List<EvidenceRetrievalTool.EvidenceItem> searchFaers(String drugName, String englishName) {
        try {
            String primaryName = (drugName != null && !drugName.isBlank()) ? drugName : englishName;
            if (primaryName == null || primaryName.isBlank()) {
                return Collections.emptyList();
            }
            Map<String, String> raw = EvidenceUtils.fetchFaersData(drugName, englishName);
            if (raw == null || raw.isEmpty()) {
                return Collections.emptyList();
            }
            return List.of(EvidenceRetrievalTool.EvidenceItem.builder()
                    .id("FAERS_" + primaryName.replaceAll("\\s+", "_"))
                    .source("FAERS")
                    .title("FAERS数据库分析：" + primaryName)
                    .snippet(raw.get("content"))
                    .raw(raw)
                    .build());
        } catch (Exception e) {
            log.error("searchFaers 失败: {}", e.getMessage(), e);
            return Collections.emptyList();
        }
    }

}
