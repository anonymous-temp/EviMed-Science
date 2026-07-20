package com.evimed.agent.evidence.agentevidencebased.infrastructure.util;

import com.evimed.agent.evidence.agentevidencebased.tools.EvidenceRetrievalTool;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;

import java.util.*;
import java.util.stream.Collectors;

@Slf4j
public class RerankUtil {

    private static final String RERANK_URL =
            "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank";

    /**
     * RRF（Reciprocal Rank Fusion）多路融合排序
     * 公式：RRF Score = Σ 1/(k + rank_i)，k=60
     * 适用于多个 query 变体各自的向量检索结果融合
     */
    public static List<EvidenceRetrievalTool.EvidenceItem> rrfMergeItems(
            List<List<EvidenceRetrievalTool.EvidenceItem>> rankedLists) {

        final int K = 60;
        Map<String, Double> scores = new LinkedHashMap<>();
        Map<String, EvidenceRetrievalTool.EvidenceItem> itemMap = new LinkedHashMap<>();

        for (List<EvidenceRetrievalTool.EvidenceItem> list : rankedLists) {
            for (int i = 0; i < list.size(); i++) {
                EvidenceRetrievalTool.EvidenceItem item = list.get(i);
                String id = item.getId();
                if (id == null || id.isBlank()) continue;
                double score = 1.0 / (K + i + 1);
                scores.merge(id, score, Double::sum);
                itemMap.putIfAbsent(id, item);
            }
        }

        List<EvidenceRetrievalTool.EvidenceItem> result = scores.entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                .map(e -> itemMap.get(e.getKey()))
                .filter(Objects::nonNull)
                .collect(Collectors.toList());

        log.info("RRF 融合: {} 路检索 → {} 条去重结果", rankedLists.size(), result.size());
        return result;
    }

    /**
     * 使用 qwen3-rerank 对 EvidenceItem 列表精排（支持多 key 轮询）
     * 遇到 400(欠费/Arrearage)、429(限流)、500/503 时自动切换下一个 key。
     * 所有 key 均不可用时降级返回 RRF 粗排结果（不抛异常）。
     *
     * @param items   待精排的文档列表（一般来自 RRF 粗排结果）
     * @param query   原始检索 query（用于相关性判断）
     * @param apiKeys DashScope API Key 列表
     * @param topK    返回条数
     */
    public static List<EvidenceRetrievalTool.EvidenceItem> rerankItems(
            List<EvidenceRetrievalTool.EvidenceItem> items,
            String query,
            List<String> apiKeys,
            int topK) {

        if (items == null || items.isEmpty()) return Collections.emptyList();
        if (apiKeys == null || apiKeys.isEmpty()) {
            return items.stream().limit(topK).collect(Collectors.toList());
        }

        // 构建 content 列表（标题 + snippet）
        List<String> documents = items.stream()
                .map(item -> {
                    String title   = item.getTitle()   != null ? item.getTitle()   : "";
                    String snippet = item.getSnippet() != null ? item.getSnippet() : "";
                    return title.isBlank() ? snippet : title + "\n" + snippet;
                })
                .collect(Collectors.toList());

        // content → EvidenceItem 反查映射
        Map<String, EvidenceRetrievalTool.EvidenceItem> contentToItem = new LinkedHashMap<>();
        for (int i = 0; i < items.size(); i++) {
            contentToItem.putIfAbsent(documents.get(i), items.get(i));
        }

        // 请求体所有 key 共用，只构建一次
        Map<String, Object> input = new HashMap<>();
        input.put("query", query);
        input.put("documents", documents);

        Map<String, Object> parameters = new HashMap<>();
        parameters.put("return_documents", true);
        parameters.put("top_n", Math.min(topK, documents.size()));
        parameters.put("instruct",
                "Given a medical evidence retrieval query, retrieve relevant passages that answer the query.");

        Map<String, Object> requestBody = new HashMap<>();
        requestBody.put("model", "gte-rerank-v2");
        requestBody.put("input", input);
        requestBody.put("parameters", parameters);

        RestTemplate restTemplate = new RestTemplate();
        restTemplate.setRequestFactory(new SimpleClientHttpRequestFactory() {{
            setConnectTimeout(5000);
            setReadTimeout(10000);
        }});

        // 轮询所有 key：400(欠费/Arrearage) / 429(限流) / 500 / 503 → 切换下一个
        for (int ki = 0; ki < apiKeys.size(); ki++) {
            String apiKey = apiKeys.get(ki);
            try {
                HttpHeaders headers = new HttpHeaders();
                headers.set("Authorization", "Bearer " + apiKey);
                headers.setContentType(MediaType.APPLICATION_JSON);

                ResponseEntity<Map> response = restTemplate.postForEntity(
                        RERANK_URL, new HttpEntity<>(requestBody, headers), Map.class);

                if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                    log.warn("rerank API 响应异常 (key[{}]): {}", ki + 1, response.getStatusCode());
                    continue;
                }

                return parseRerankResponse(response.getBody(), contentToItem, items, topK, ki + 1);

            } catch (HttpStatusCodeException e) {
                int statusCode = e.getStatusCode().value();
                if (isTransientRerankError(statusCode)) {
                    log.warn("rerank key[{}] 不可用 (HTTP {} / {})，切换下一个 key",
                            ki + 1, statusCode, extractApiErrorCode(e));
                    // continue to next key
                } else {
                    log.warn("rerank API 遇到不可重试错误 (HTTP {})，降级使用 RRF 结果", statusCode);
                    return items.stream().limit(topK).collect(Collectors.toList());
                }
            } catch (Exception e) {
                log.warn("rerank API 调用失败，降级使用 RRF 结果: {}", e.getMessage());
                return items.stream().limit(topK).collect(Collectors.toList());
            }
        }

        log.warn("所有 rerank key 均不可用（共 {} 个），降级使用 RRF 结果", apiKeys.size());
        return items.stream().limit(topK).collect(Collectors.toList());
    }

    /**
     * 对文献列表按 query 做 rerank，返回 itemId → relevance_score 映射。
     * 调用方根据阈值自行过滤，一篇文献可被多个 query（章节）独立打分。
     * 所有 key 不可用时返回空 Map（调用方降级处理）。
     */
    public static Map<String, Double> rerankScores(
            List<EvidenceRetrievalTool.EvidenceItem> items,
            String query,
            List<String> apiKeys) {

        if (items == null || items.isEmpty() || apiKeys == null || apiKeys.isEmpty()) {
            return Collections.emptyMap();
        }

        List<String> documents = items.stream()
                .map(item -> {
                    String title   = item.getTitle()   != null ? item.getTitle()   : "";
                    String snippet = item.getSnippet() != null ? item.getSnippet() : "";
                    return title.isBlank() ? snippet : title + "\n" + snippet;
                })
                .collect(Collectors.toList());

        Map<String, Object> input = new HashMap<>();
        input.put("query", query);
        input.put("documents", documents);

        Map<String, Object> parameters = new HashMap<>();
        parameters.put("return_documents", true);
        parameters.put("top_n", documents.size());
        parameters.put("instruct",
                "Given a medical report section description, score each passage by relevance to that section.");

        Map<String, Object> requestBody = new HashMap<>();
        requestBody.put("model", "gte-rerank-v2");
        requestBody.put("input", input);
        requestBody.put("parameters", parameters);

        RestTemplate restTemplate = new RestTemplate();
        restTemplate.setRequestFactory(new SimpleClientHttpRequestFactory() {{
            setConnectTimeout(5000);
            setReadTimeout(10000);
        }});

        for (int ki = 0; ki < apiKeys.size(); ki++) {
            String apiKey = apiKeys.get(ki);
            try {
                HttpHeaders headers = new HttpHeaders();
                headers.set("Authorization", "Bearer " + apiKey);
                headers.setContentType(MediaType.APPLICATION_JSON);

                ResponseEntity<Map> response = restTemplate.postForEntity(
                        RERANK_URL, new HttpEntity<>(requestBody, headers), Map.class);

                if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
                    log.warn("rerankScores API 响应异常 (key[{}]): {}", ki + 1, response.getStatusCode());
                    continue;
                }

                return parseScoreResponse(response.getBody(), items);

            } catch (HttpStatusCodeException e) {
                int statusCode = e.getStatusCode().value();
                if (isTransientRerankError(statusCode)) {
                    log.warn("rerankScores key[{}] 不可用 (HTTP {})，切换下一个 key", ki + 1, statusCode);
                } else {
                    log.warn("rerankScores 遇到不可重试错误 (HTTP {})，返回空分数", statusCode);
                    return Collections.emptyMap();
                }
            } catch (Exception e) {
                log.warn("rerankScores 调用失败，返回空分数: {}", e.getMessage());
                return Collections.emptyMap();
            }
        }

        log.warn("rerankScores 所有 key 均不可用，返回空分数");
        return Collections.emptyMap();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Double> parseScoreResponse(
            Map<?, ?> body,
            List<EvidenceRetrievalTool.EvidenceItem> items) {

        Map<?, ?> output = (Map<?, ?>) body.get("output");
        if (output == null) return Collections.emptyMap();

        List<Map<String, Object>> results = (List<Map<String, Object>>) output.get("results");
        if (results == null || results.isEmpty()) return Collections.emptyMap();

        // index → itemId 映射（rerank 返回的是原始 index）
        Map<Integer, String> indexToId = new HashMap<>();
        for (int i = 0; i < items.size(); i++) {
            indexToId.put(i, items.get(i).getId());
        }

        Map<String, Double> scores = new LinkedHashMap<>();
        for (Map<String, Object> entry : results) {
            Object idxObj = entry.get("index");
            if (idxObj == null) continue;
            int idx = ((Number) idxObj).intValue();
            String itemId = indexToId.get(idx);
            if (itemId == null) continue;
            double score = entry.containsKey("relevance_score")
                    ? ((Number) entry.get("relevance_score")).doubleValue()
                    : (entry.containsKey("score") ? ((Number) entry.get("score")).doubleValue() : 0.0);
            scores.put(itemId, score);
        }
        return scores;
    }

    /**
     * 是否为可通过切换 key 解决的临时性错误
     *   400 = 账户欠费 (Arrearage) 或配额耗尽
     *   429 = 限流 (Rate Limit)
     *   500 / 503 = 服务端错误
     */
    private static boolean isTransientRerankError(int statusCode) {
        return statusCode == 400 || statusCode == 429 || statusCode == 500 || statusCode == 503;
    }

    /**
     * 提取 DashScope 返回体中的业务错误码，如 "Arrearage"
     * 用于日志，不影响主流程
     */
    private static String extractApiErrorCode(HttpStatusCodeException e) {
        try {
            String body = e.getResponseBodyAsString();
            int start = body.indexOf("\"code\":");
            if (start >= 0) {
                start = body.indexOf("\"", start + 7) + 1;
                int end = body.indexOf("\"", start);
                if (end > start) return body.substring(start, end);
            }
        } catch (Exception ignored) {}
        return String.valueOf(e.getStatusCode().value());
    }

    /**
     * 解析 rerank 响应体，返回精排后的 EvidenceItem 列表
     */
    @SuppressWarnings("unchecked")
    private static List<EvidenceRetrievalTool.EvidenceItem> parseRerankResponse(
            Map<?, ?> body,
            Map<String, EvidenceRetrievalTool.EvidenceItem> contentToItem,
            List<EvidenceRetrievalTool.EvidenceItem> fallback,
            int topK,
            int keyIndex) {

        Map<?, ?> output = (Map<?, ?>) body.get("output");
        if (output == null) return fallback.stream().limit(topK).collect(Collectors.toList());

        List<Map<String, Object>> rerankedResults = (List<Map<String, Object>>) output.get("results");
        if (rerankedResults == null || rerankedResults.isEmpty()) {
            return fallback.stream().limit(topK).collect(Collectors.toList());
        }

        List<EvidenceRetrievalTool.EvidenceItem> result = new ArrayList<>();
        List<String> rankLogs = new ArrayList<>();

        for (int i = 0; i < rerankedResults.size(); i++) {
            Map<String, Object> entry = rerankedResults.get(i);
            String text = (String) ((Map<String, Object>) entry.get("document")).get("text");
            double score = entry.containsKey("relevance_score")
                    ? ((Number) entry.get("relevance_score")).doubleValue()
                    : (entry.containsKey("score") ? ((Number) entry.get("score")).doubleValue() : 0.0);

            EvidenceRetrievalTool.EvidenceItem item = contentToItem.get(text);
            if (item != null) {
                result.add(item);
                rankLogs.add(String.format("排名%d: id=%s, 分=%.4f", i + 1, item.getId(), score));
            }
        }

        if (keyIndex > 1) {
            log.info("rerank 切换到 key[{}] 成功", keyIndex);
        }
        log.info("qwen3-rerank 精排完成 ({} → {} 条): {}", fallback.size(), result.size(),
                String.join("; ", rankLogs));
        return result;
    }
}
