package com.evimed.agent.evidence.agentevidencebased.infrastructure.util;

import cn.hutool.core.bean.BeanUtil;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HttpUtil;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.evimed.agent.evidence.agentevidencebased.entity.index.*;

import com.evimed.agent.evidence.agentevidencebased.entity.mongo.Condition;
import com.evimed.agent.evidence.agentevidencebased.entity.mongo.Drug;
import io.milvus.client.MilvusServiceClient;
import io.milvus.common.clientenum.ConsistencyLevelEnum;
import io.milvus.grpc.SearchResults;
import io.milvus.param.MetricType;
import io.milvus.param.R;
import io.milvus.param.dml.SearchParam;
import io.milvus.response.SearchResultsWrapper;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.action.get.GetRequest;
import org.elasticsearch.action.get.GetResponse;
import org.elasticsearch.action.search.SearchRequest;
import org.elasticsearch.action.search.SearchResponse;
import org.elasticsearch.client.RequestOptions;
import org.elasticsearch.index.query.*;
import org.elasticsearch.search.SearchHit;
import org.elasticsearch.search.builder.SearchSourceBuilder;
import org.elasticsearch.search.collapse.CollapseBuilder;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * 证据处理方法类
 * @author zgm 20251105
 */
@Slf4j
public class EvidenceUtils {

    private static final String embeddingUrl = "https://image.evimed.com/vector/embedding?user_input=";
    private static List<String> allTypeList = Arrays.asList("0", "11", "1", "2", "14", "3", "4", "5", "6", "7", "12", "8", "9", "10", "13");
    private static List<String> nameList = Arrays.asList("系统综述/Meta分析", "指南/共识", "传统综述", "随机对照试验", "临床试验", "队列研究", "病例对照研究", "横断面研究", "病例系列", "病例报告", "经济学评价", "专家意见和评价", "动物实验", "体外实验", "其他");
    private static Map<String, String> typeMap = new HashMap<>();
    static {
        for (int i = 0; i < allTypeList.size(); i++) {
            typeMap.put(allTypeList.get(i), nameList.get(i));
        }
    }

    /**
     * 获取文献文本块（公开入口，带 PICO 分组过滤词）
     * 过滤规则：每个非空 PICO 组至少命中一个词（AND across groups，OR within group）
     *
     * @param moduleQuery 查询向量原文
     * @param picoGroups  PICO 分组关键词 {"p":[...], "i":[...], "c":[...], "o":[...]}；为空则降级宽松 OR
     */
    public static List<Map<String, String>> getPaperBlockPublic(String moduleQuery,
                                                                Map<String, List<String>> picoGroups) throws IOException {
        return getPaperBlock(moduleQuery, picoGroups);
    }

    /**
     * 获取文献文本块核心实现
     */
    public static List<Map<String, String>> getPaperBlock(String moduleQuery,
                                                           Map<String, List<String>> picoGroups) throws IOException {
        List<Map<String, String>> knowledge = new ArrayList<>();

        Set<String> processedDbIds = new HashSet<>();

        // 过滤模式：有 PICO 分组 → AND 逻辑；无分组 → 降级 OR 过滤（从 query 提取关键词）
        boolean usePicoAndFilter = picoGroups != null && !picoGroups.isEmpty();
        List<String> fallbackKeywords = usePicoAndFilter ? Collections.emptyList() : extractKeywords(moduleQuery);

        boolean chinese = TransUtils.judgeChinese(moduleQuery);
        String infoChat = "";
        if (chinese) {
            infoChat = TransUtils.trans(moduleQuery);
        }

        // 生成查询向量（只生成一次）
        List<List<Float>> queryVectors = new ArrayList<>();
        String vector;
        try {
            String encodedQuery = URLEncoder.encode(moduleQuery, StandardCharsets.UTF_8);
            vector = HttpUtil.get(embeddingUrl + encodedQuery);
        } catch (Exception e) {
            e.printStackTrace();
            log.info("检索条件转向量异常。。。开始重试");
            String encodedQuery = URLEncoder.encode(moduleQuery, StandardCharsets.UTF_8);
            vector = HttpUtil.get(embeddingUrl + encodedQuery);
        }
        if (StringUtils.isNotBlank(vector)) {
            List<Float> floats = new ArrayList<>();
            String[] split = vector.split(",");
            for (String s : split) {
                floats.add(Float.valueOf(s));
            }
            queryVectors.add(floats);
        }
        if (StringUtils.isNotBlank(infoChat)) {
            String vectorEn;
            try {
                String encodedChat = URLEncoder.encode(infoChat, StandardCharsets.UTF_8);
                vectorEn = HttpUtil.get(embeddingUrl + encodedChat);
            } catch (Exception e) {
                e.printStackTrace();
                log.info("检索条件转向量异常。。。开始重试");
                String encodedChat = URLEncoder.encode(infoChat, StandardCharsets.UTF_8);
                vectorEn = HttpUtil.get(embeddingUrl + encodedChat);
            }
            if (StringUtils.isNotBlank(vectorEn)) {
                String[] splitEn = vectorEn.split(",");
                List<Float> floatsEn = new ArrayList<>();
                for (String s : splitEn) {
                    floatsEn.add(Float.valueOf(s));
                }
                queryVectors.add(floatsEn);
            }
        }
        if (CollUtil.isEmpty(queryVectors)) {
            return new ArrayList<>();
        }

        // 构建查询条件列表
        List<String> retrievalConditions = new ArrayList<>();
        retrievalConditions.add("data_type in [\"meta\", \"review\", \"rct\", \"cohort\", \"guide\", \"economic\"]");

        // 对每个查询条件进行查询
        List<String> outputFields = new ArrayList<>();
        outputFields.add("text");
        outputFields.add("abstract");
        outputFields.add("db_id");
        ZillizPaperClient client = new ZillizPaperClient();

        for (String retrieval : retrievalConditions) {
            try {
                SearchParam searchParam = SearchParam.newBuilder()
                        .withCollectionName("refinedData_4B")
                        .withVectorFieldName("vector")
                        .withVectors(queryVectors)
                        .withTopK(16)
                        .withMetricType(MetricType.COSINE)
                        .withParams("{\"nprobe\":2560}")
                        .withConsistencyLevel(ConsistencyLevelEnum.BOUNDED)
                        .withOutFields(outputFields)
                        .withExpr(retrieval).build();

                R<SearchResults> response = client.client().search(searchParam);
                SearchResultsWrapper wrapper = new SearchResultsWrapper(response.getData().getResults());

                // 处理查询结果
                for (int i = 0; i < queryVectors.size(); ++i) {
                    List<SearchResultsWrapper.IDScore> scores = wrapper.getIDScore(i);
                    for (SearchResultsWrapper.IDScore score : scores) {
                        Map<String, Object> fieldValues = score.getFieldValues();
                        if (fieldValues.get("db_id") == null) {
                            continue;
                        }

                        String dbId = fieldValues.get("db_id").toString();
                        // 去重：如果已经处理过这个 dbId，跳过
                        if (processedDbIds.contains(dbId)) {
                            continue;
                        }

                        GetRequest getRequest = new GetRequest(EsIndex.of(MongoToEsLiterature.class));
                        getRequest.id(dbId);
                        GetResponse documentFields = EsUtil.esClient.get(getRequest, RequestOptions.DEFAULT);
                        Map<String, Object> sourceAsMap = documentFields.getSourceAsMap();

                        if (sourceAsMap != null) {
                            MongoToEsLiterature mongoToEsLiterature = new MongoToEsLiterature();
                            BeanUtil.copyProperties(sourceAsMap, mongoToEsLiterature, false);
                            if (mongoToEsLiterature.getIsIncomplete() == 1) {
                                continue;
                            }

                            Map<String, String> inner = new HashMap<>();
                            inner.put("id", UUID.randomUUID().toString());

                            String year = mongoToEsLiterature.getYear();
                            String innerTitle = mongoToEsLiterature.getTitle();
                            String journalDivision = String.join(",", CollUtil.isNotEmpty(mongoToEsLiterature.getJournalDivision()) ? mongoToEsLiterature.getJournalDivision() : new ArrayList<>());
                            String journal = StringUtils.isNotBlank(mongoToEsLiterature.getJournal()) ? mongoToEsLiterature.getJournal() : "";
                            String jcr = mongoToEsLiterature.getJcr() != null ? mongoToEsLiterature.getJcr().toString() : "";
                            String language = StringUtils.isNotBlank(mongoToEsLiterature.getLanguage()) ? mongoToEsLiterature.getLanguage() : "";
                            List<Integer> oldType = mongoToEsLiterature.getType();
                            List<Integer> newType = mongoToEsLiterature.getLastNewType();
                            if (oldType.contains(7)) {
                                newType.add(14);
                            }
                            List<String> typeList = new ArrayList<>();
                            for (Integer integer : newType) {
                                typeList.add(typeMap.get(integer.toString()));
                            }

                            inner.put("title", StringUtils.isNotBlank(innerTitle) ? innerTitle : "");
                            inner.put("year", StringUtils.isNotBlank(year) ? year : "");
                            inner.put("journalDivision", journalDivision);
                            inner.put("journal", journal);
                            inner.put("jcr", jcr);
                            inner.put("language", language);
                            inner.put("type", String.join(",", typeList));
                            inner.put("summary",    StringUtils.isNotBlank(mongoToEsLiterature.getSummary())    ? mongoToEsLiterature.getSummary()    : "");
                            inner.put("result",     StringUtils.isNotBlank(mongoToEsLiterature.getResult())     ? mongoToEsLiterature.getResult()     : "");
                            inner.put("conclusion", StringUtils.isNotBlank(mongoToEsLiterature.getConclusion()) ? mongoToEsLiterature.getConclusion() : "");
                            inner.put("tldr",       StringUtils.isNotBlank(mongoToEsLiterature.getTldr())       ? mongoToEsLiterature.getTldr()       : "");

                            if (fieldValues.get("abstract") != null) {
                                String text = fieldValues.get("abstract").toString();

                                // abstract 过滤：PICO AND 逻辑 or 降级 OR 逻辑
//                                boolean passes;
//                                if (usePicoAndFilter) {
//                                    passes = abstractMatchesPicoGroups(text, picoGroups);
//                                } else {
//                                    passes = fallbackKeywords.isEmpty() || abstractMatchesKeywords(text, fallbackKeywords);
//                                }
//                                if (!passes) {
//                                    log.debug("关键词过滤跳过 dbId={}", dbId);
//                                    continue;
//                                }

                                inner.put("text", text);
                                inner.put("dbId", dbId);
                                inner.put("url", "https://www.evimed.com/details?id=" + dbId);
                                knowledge.add(inner);
                                processedDbIds.add(dbId);
                            }
                        } 
//                        else {
//                            // ES反查无结果：直接使用向量库摘要，标记为不可引用
//                            if (fieldValues.get("abstract") != null) {
//                                String text = fieldValues.get("abstract").toString();
//                                boolean passes;
//                                if (usePicoAndFilter) {
//                                    passes = abstractMatchesPicoGroups(text, picoGroups);
//                                } else {
//                                    passes = fallbackKeywords.isEmpty() || abstractMatchesKeywords(text, fallbackKeywords);
//                                }
//                                if (!passes) {
//                                    log.debug("关键词过滤跳过（无ES元数据）dbId={}", dbId);
//                                    continue;
//                                }
//                                Map<String, String> inner = new HashMap<>();
//                                inner.put("id", UUID.randomUUID().toString());
//                                inner.put("dbId", dbId);
//                                inner.put("title", "");
//                                inner.put("year", "");
//                                inner.put("journal", "");
//                                inner.put("type", "");
//                                inner.put("jcr", "");
//                                inner.put("language", "");
//                                inner.put("journalDivision", "");
//                                inner.put("text", text);
//                                inner.put("url", "https://www.evimed.com/details?id=" + dbId);
//                                inner.put("noCitation", "true");
//                                knowledge.add(inner);
//                                processedDbIds.add(dbId);
//                                log.debug("ES反查无数据，使用向量库摘要（无引用）: dbId={}", dbId);
//                            }
//                        }
                    }
                }

                log.debug("查询条件 '{}' 查询完成，当前累计结果: {} 条", retrieval, knowledge.size());

            } catch (Exception e) {
                log.error("查询条件 '{}' 执行异常: {}", retrieval, e.getMessage());
            }
        }

        return knowledge;
    }

    /**
     * ES BM25 文献检索（并行通道，补充向量检索的精确词匹配召回）
     * 对 title/summary/tldr/conclusion/result 做 multi-match should 查询
     * 注意：ES 索引无 abstract 字段，使用 tldr/summary 作为 snippet
     *
     * @param keywords PICO 关键词（平铺所有组，OR 语义）
     * @param size     返回条数上限
     */
    public static List<Map<String, String>> searchByEsBm25(List<String> keywords, int size) {
        List<Map<String, String>> result = new ArrayList<>();
        if (keywords == null || keywords.isEmpty()) {
            return result;
        }
        long start = System.currentTimeMillis();

        BoolQueryBuilder bool = QueryBuilders.boolQuery();
        for (String kw : keywords) {
            if (kw == null || kw.isBlank()) continue;
            bool.should().add(
                    QueryBuilders.multiMatchQuery(kw, "title", "summary", "tldr", "conclusion", "result")
            );
        }
        bool.minimumShouldMatch(1);

        SearchRequest searchRequest = new SearchRequest(EsIndex.of(MongoToEsLiterature.class));
        SearchSourceBuilder sourceBuilder = new SearchSourceBuilder();
        sourceBuilder.query(bool).size(Math.max(size, 1));
        searchRequest.source(sourceBuilder);

        SearchResponse searchResponse;
        try {
            searchResponse = EsUtil.esClient.search(searchRequest, RequestOptions.DEFAULT);
        } catch (Exception e) {
            log.warn("ES BM25 检索异常: {}", e.getMessage());
            return result;
        }

        if (searchResponse == null || searchResponse.getHits() == null
                || searchResponse.getHits().getHits().length == 0) {
            log.info("ES BM25 检索 0 条，用时 {}ms", System.currentTimeMillis() - start);
            return result;
        }

        for (SearchHit hit : searchResponse.getHits().getHits()) {
            MongoToEsLiterature lit = new MongoToEsLiterature();
            BeanUtil.copyProperties(hit.getSourceAsMap(), lit, false);
            if (lit.getIsIncomplete() != null && lit.getIsIncomplete() == 1) continue;

            String dbId = hit.getId();
            String title = StringUtils.defaultString(lit.getTitle());
            String tldr = StringUtils.defaultString(lit.getTldr());
            String summary = StringUtils.defaultString(lit.getSummary());
            // 优先 tldr 作为 snippet；次选 summary 前 600 字
            String text = !tldr.isBlank() ? tldr
                    : (summary.length() > 600 ? summary.substring(0, 600) : summary);
            if (title.isBlank() && text.isBlank()) continue;

            String year = StringUtils.defaultString(lit.getYear());
            String journal = StringUtils.defaultString(lit.getJournal());
            String jcr = lit.getJcr() != null ? lit.getJcr().toString() : "";
            String language = StringUtils.defaultString(lit.getLanguage());
            String journalDivision = String.join(",",
                    CollUtil.isNotEmpty(lit.getJournalDivision())
                            ? lit.getJournalDivision() : Collections.emptyList());

            List<Integer> oldType = lit.getType() != null ? lit.getType() : Collections.emptyList();
            List<Integer> newType = lit.getLastNewType() != null
                    ? new ArrayList<>(lit.getLastNewType()) : new ArrayList<>();
            if (oldType.contains(7)) newType.add(14);
            String typeStr = newType.stream()
                    .map(i -> typeMap.getOrDefault(i.toString(), ""))
                    .filter(s -> !s.isBlank())
                    .collect(Collectors.joining(","));

            Map<String, String> inner = new HashMap<>();
            inner.put("id", UUID.randomUUID().toString());
            inner.put("dbId", dbId);
            inner.put("title", title);
            inner.put("year", year);
            inner.put("journal", journal);
            inner.put("jcr", jcr);
            inner.put("language", language);
            inner.put("journalDivision", journalDivision);
            inner.put("type", typeStr);
            inner.put("text", text);
            inner.put("summary",    StringUtils.defaultString(lit.getSummary()));
            inner.put("result",     StringUtils.defaultString(lit.getResult()));
            inner.put("conclusion", StringUtils.defaultString(lit.getConclusion()));
            inner.put("tldr",       StringUtils.defaultString(lit.getTldr()));
            inner.put("url", "https://www.evimed.com/details?id=" + dbId);
            result.add(inner);
        }

        log.info("ES BM25 检索 {} 条，用时 {}ms", result.size(), System.currentTimeMillis() - start);
        return result;
    }

    /**
     * ES BM25 分组文献检索
     * 干预组和疾病/人群组使用 must（每组至少命中一个），话题词用 should（仅加分）
     * 确保返回文档同时包含干预措施和目标疾病，避免单词污染结果
     *
     * @param interventionKws 干预措施关键词（must：至少命中一个）
     * @param populationKws   疾病/人群关键词（must：至少命中一个）
     * @param topicKws        章节话题关键词（should：可选加分，不强制）
     * @param size            返回条数上限
     */
    public static List<Map<String, String>> searchByEsBm25Grouped(
            List<String> interventionKws,
            List<String> populationKws,
            List<String> topicKws,
            int size) {
        return searchByEsBm25Grouped(interventionKws, populationKws, topicKws, size, Collections.emptySet());
    }

    public static List<Map<String, String>> searchByEsBm25Grouped(
            List<String> interventionKws,
            List<String> populationKws,
            List<String> topicKws,
            int size,
            Collection<String> excludeIds) {
        return searchByEsBm25Grouped(interventionKws, populationKws, topicKws, Collections.emptyList(), size, excludeIds);
    }

    /**
     * BM25 分组检索（统一入口，支持可选的文献类型过滤）
     *
     * @param typeIds 文献类型码列表（如 [0,2,14]）；为空则不过滤类型，等价于原 searchByEsBm25Grouped
     */
    public static List<Map<String, String>> searchByEsBm25Grouped(
            List<String> interventionKws,
            List<String> populationKws,
            List<String> topicKws,
            List<Integer> typeIds,
            int size,
            Collection<String> excludeIds) {
        List<Map<String, String>> result = new ArrayList<>();
        boolean hasIntervention = interventionKws != null && !interventionKws.isEmpty();
        boolean hasPopulation = populationKws != null && !populationKws.isEmpty();
        // 两组都空时：有类型过滤则直接返回空；无类型过滤则降级为 topic OR 查询
        if (!hasIntervention && !hasPopulation) {
            if (typeIds != null && !typeIds.isEmpty()) return result;
            List<String> all = new ArrayList<>();
            if (topicKws != null) all.addAll(topicKws);
            return all.isEmpty() ? result : searchByEsBm25(all, size);
        }

        long start = System.currentTimeMillis();
        String[] fields = {"title", "summary", "tldr", "conclusion", "result"};
        BoolQueryBuilder bool = QueryBuilders.boolQuery();

        // must: 干预组（至少命中一个干预词）
        // 中文药名：PHRASE + slop=0，要求完整连续匹配，避免部分字符误召回
        // 英文药名：默认 match query
        if (hasIntervention) {
            BoolQueryBuilder interventionBool = QueryBuilders.boolQuery();
            for (String kw : interventionKws) {
                if (kw != null && !kw.isBlank()) {
                    boolean isChinese = kw.chars().anyMatch(c -> c >= 0x4e00 && c <= 0x9fa5);
                    if (isChinese) {
                        interventionBool.should().add(
                                QueryBuilders.multiMatchQuery(kw, fields)
                                        .type(MultiMatchQueryBuilder.Type.PHRASE));
                    } else {
                        interventionBool.should().add(QueryBuilders.multiMatchQuery(kw, fields));
                    }
                }
            }
            interventionBool.minimumShouldMatch(1);
            bool.must().add(interventionBool);
        }

        // must: 疾病/人群组（至少命中一个疾病词）
        // 中文病名：PHRASE + slop=1，覆盖"类风湿关节炎"/"类风湿性关节炎"等书写变体
        // 英文病名：默认 match query
        if (hasPopulation) {
            BoolQueryBuilder populationBool = QueryBuilders.boolQuery();
            for (String kw : populationKws) {
                if (kw != null && !kw.isBlank()) {
                    boolean isChinese = kw.chars().anyMatch(c -> c >= 0x4e00 && c <= 0x9fa5);
                    if (isChinese) {
                        populationBool.should().add(
                                QueryBuilders.multiMatchQuery(kw, fields)
                                        .type(MultiMatchQueryBuilder.Type.PHRASE)
                                        .slop(1));
                    } else {
                        populationBool.should().add(QueryBuilders.multiMatchQuery(kw, fields));
                    }
                }
            }
            populationBool.minimumShouldMatch(1);
            bool.must().add(populationBool);
        }

        // should: 话题词（仅提升排分，不强制命中）+ 扩展关键词
        if (topicKws != null && !topicKws.isEmpty()) {
            // 扩展关键词（如"老年" → "老年"+"elderly"+"aged"等）
            List<String> expandedTopics = expandKeywords(topicKws);

            // 原始关键词：高 boost
            for (String kw : topicKws) {
                if (kw != null && !kw.isBlank()) {
                    bool.should().add(QueryBuilders.multiMatchQuery(kw, fields).boost(3.0f));
                }
            }

            // 扩展关键词：中等 boost
            for (String kw : expandedTopics) {
                if (kw != null && !kw.isBlank() && !topicKws.contains(kw)) {
                    bool.should().add(QueryBuilders.multiMatchQuery(kw, fields).boost(2.0f));
                }
            }
        }

        // must_not: 排除已检索过的文献（多轮 loop 防重复）
        // 文献 ID 存储的是 ES _id，用 idsQuery 精准排除
        if (excludeIds != null && !excludeIds.isEmpty()) {
            bool.mustNot(QueryBuilders.idsQuery().addIds(excludeIds.toArray(new String[0])));
        }

        // filter: 文献类型（可选，精确匹配 lastNewType keyword 字段）
        if (typeIds != null && !typeIds.isEmpty()) {
            String[] typeStrValues = typeIds.stream().map(Object::toString).toArray(String[]::new);
            bool.filter(QueryBuilders.termsQuery("lastNewType", typeStrValues));
        }

        SearchRequest searchRequest = new SearchRequest(EsIndex.of(MongoToEsLiterature.class));
        SearchSourceBuilder sourceBuilder = new SearchSourceBuilder();
        sourceBuilder.query(bool).size(Math.max(size, 1));
        searchRequest.source(sourceBuilder);

        SearchResponse searchResponse;
        try {
            searchResponse = EsUtil.esClient.search(searchRequest, RequestOptions.DEFAULT);
        } catch (Exception e) {
            log.warn("ES BM25 分组检索异常: {}", e.getMessage());
            return result;
        }

        if (searchResponse == null || searchResponse.getHits() == null
                || searchResponse.getHits().getHits().length == 0) {
            log.info("ES BM25 分组检索 0 条，用时 {}ms", System.currentTimeMillis() - start);
            return result;
        }

        for (SearchHit hit : searchResponse.getHits().getHits()) {
            MongoToEsLiterature lit = new MongoToEsLiterature();
            BeanUtil.copyProperties(hit.getSourceAsMap(), lit, false);
            if (lit.getIsIncomplete() != null && lit.getIsIncomplete() == 1) continue;

            String dbId = hit.getId();
            String title = StringUtils.defaultString(lit.getTitle());
            String tldr = StringUtils.defaultString(lit.getTldr());
            String summary = StringUtils.defaultString(lit.getSummary());
            String text = !summary.isBlank() ? summary
                    : (tldr.length() > 600 ? tldr.substring(0, 600) : tldr);
            if (title.isBlank() && text.isBlank()) continue;

            String year = StringUtils.defaultString(lit.getYear());
            String journal = StringUtils.defaultString(lit.getJournal());
            String jcr = lit.getJcr() != null ? lit.getJcr().toString() : "";
            String language = StringUtils.defaultString(lit.getLanguage());
            String journalDivision = String.join(",",
                    CollUtil.isNotEmpty(lit.getJournalDivision())
                            ? lit.getJournalDivision() : Collections.emptyList());

            List<Integer> oldType = lit.getType() != null ? lit.getType() : Collections.emptyList();
            List<Integer> newType = lit.getLastNewType() != null
                    ? new ArrayList<>(lit.getLastNewType()) : new ArrayList<>();
            if (oldType.contains(7)) newType.add(14);
            String typeStr = newType.stream()
                    .map(i -> typeMap.getOrDefault(i.toString(), ""))
                    .filter(s -> !s.isBlank())
                    .collect(Collectors.joining(","));

            Map<String, String> inner = new HashMap<>();
            inner.put("id", UUID.randomUUID().toString());
            inner.put("dbId", dbId);
            inner.put("title", title);
            inner.put("year", year);
            inner.put("journal", journal);
            inner.put("jcr", jcr);
            inner.put("language", language);
            inner.put("journalDivision", journalDivision);
            inner.put("type", typeStr);
            inner.put("text", text);
            inner.put("summary",    StringUtils.defaultString(lit.getSummary()));
            inner.put("result",     StringUtils.defaultString(lit.getResult()));
            inner.put("conclusion", StringUtils.defaultString(lit.getConclusion()));
            inner.put("tldr",       StringUtils.defaultString(lit.getTldr()));
            inner.put("url", "https://www.evimed.com/details?id=" + dbId);
            result.add(inner);
        }

        log.info("ES BM25 分组检索 {} 条，用时 {}ms", result.size(), System.currentTimeMillis() - start);
        return result;
    }

    /**
     * 按文献类型过滤的 BM25 检索（专用于国内外文献按类型优先级收集）。
     * 在 searchByEsBm25Grouped 基础上额外添加 lastNewType 精确过滤。
     * <p>
     * lastNewType 在 ES 中为 keyword 类型，存储各文献类型对应的整数字符串，如 "0"(Meta)、"2"(RCT)。
     *
     * @param interventionKws 干预措施关键词（must：至少命中一个）
     * @param populationKws   疾病/人群关键词（must：至少命中一个）
     * @param typeIds         要过滤的 lastNewType 整数值（如 [0,1] = Meta+传统综述）
     * @param size            返回条数上限
     * @param excludeIds      已检索过的 ES _id，排除重复
     * @return 与关键词相关且类型匹配的文献 Map 列表
     */
    public static List<Map<String, String>> searchByEsBm25ByType(
            List<String> interventionKws,
            List<String> populationKws,
            List<Integer> typeIds,
            int size,
            Collection<String> excludeIds) {

        List<Map<String, String>> result = new ArrayList<>();
        if (typeIds == null || typeIds.isEmpty()) return result;

        boolean hasIntervention = interventionKws != null && !interventionKws.isEmpty();
        boolean hasPopulation   = populationKws   != null && !populationKws.isEmpty();
        if (!hasIntervention && !hasPopulation) return result;

        long start = System.currentTimeMillis();
        String[] fields = {"title", "summary", "tldr", "conclusion", "result"};
        BoolQueryBuilder bool = QueryBuilders.boolQuery();

        // must: 干预组（至少命中一个干预词）
        if (hasIntervention) {
            BoolQueryBuilder iBool = QueryBuilders.boolQuery();
            for (String kw : interventionKws) {
                if (kw != null && !kw.isBlank()) {
                    boolean isChinese = kw.chars().anyMatch(c -> c >= 0x4e00 && c <= 0x9fa5);
                    if (isChinese) {
                        iBool.should().add(
                                QueryBuilders.multiMatchQuery(kw, fields)
                                        .type(MultiMatchQueryBuilder.Type.PHRASE));
                    } else {
                        iBool.should().add(QueryBuilders.multiMatchQuery(kw, fields));
                    }
                }
            }
            iBool.minimumShouldMatch(1);
            bool.must().add(iBool);
        }

        // must: 疾病/人群组（至少命中一个疾病词）
        if (hasPopulation) {
            BoolQueryBuilder pBool = QueryBuilders.boolQuery();
            for (String kw : populationKws) {
                if (kw != null && !kw.isBlank()) {
                    boolean isChinese = kw.chars().anyMatch(c -> c >= 0x4e00 && c <= 0x9fa5);
                    if (isChinese) {
                        pBool.should().add(
                                QueryBuilders.multiMatchQuery(kw, fields)
                                        .type(MultiMatchQueryBuilder.Type.PHRASE)
                                        .slop(1));
                    } else {
                        pBool.should().add(QueryBuilders.multiMatchQuery(kw, fields));
                    }
                }
            }
            pBool.minimumShouldMatch(1);
            bool.must().add(pBool);
        }

        // filter: 文献类型（lastNewType 存储整数字符串，如 "0"、"2"）
        String[] typeStrValues = typeIds.stream().map(Object::toString).toArray(String[]::new);
        bool.filter(QueryBuilders.termsQuery("lastNewType", typeStrValues));

        // must_not: 排除已检索过的文献
        if (excludeIds != null && !excludeIds.isEmpty()) {
            bool.mustNot(QueryBuilders.idsQuery().addIds(excludeIds.toArray(new String[0])));
        }

        SearchRequest searchRequest = new SearchRequest(EsIndex.of(MongoToEsLiterature.class));
        SearchSourceBuilder sourceBuilder = new SearchSourceBuilder();
        sourceBuilder.query(bool).size(Math.max(size, 1));
        searchRequest.source(sourceBuilder);

        SearchResponse searchResponse;
        try {
            searchResponse = EsUtil.esClient.search(searchRequest, RequestOptions.DEFAULT);
        } catch (Exception e) {
            log.warn("ES BM25 类型过滤检索异常: {}", e.getMessage());
            return result;
        }

        if (searchResponse == null || searchResponse.getHits() == null
                || searchResponse.getHits().getHits().length == 0) {
            log.info("ES BM25 类型过滤检索 0 条 (types={}), 用时 {}ms",
                    typeIds, System.currentTimeMillis() - start);
            return result;
        }

        for (SearchHit hit : searchResponse.getHits().getHits()) {
            MongoToEsLiterature lit = new MongoToEsLiterature();
            BeanUtil.copyProperties(hit.getSourceAsMap(), lit, false);
            if (lit.getIsIncomplete() != null && lit.getIsIncomplete() == 1) continue;

            String dbId   = hit.getId();
            String title  = StringUtils.defaultString(lit.getTitle());
            String tldr   = StringUtils.defaultString(lit.getTldr());
            String summary= StringUtils.defaultString(lit.getSummary());
            String text = !summary.isBlank() ? summary
                    : (tldr.length() > 2000 ? tldr.substring(0, 2000) : tldr);
            if (title.isBlank() && text.isBlank()) continue;

            String year           = StringUtils.defaultString(lit.getYear());
            String journal        = StringUtils.defaultString(lit.getJournal());
            String jcr            = lit.getJcr() != null ? lit.getJcr().toString() : "";
            String language       = StringUtils.defaultString(lit.getLanguage());
            String journalDivision= String.join(",",
                    CollUtil.isNotEmpty(lit.getJournalDivision())
                            ? lit.getJournalDivision() : Collections.emptyList());

            List<Integer> oldType = lit.getType()        != null ? lit.getType()        : Collections.emptyList();
            List<Integer> newType = lit.getLastNewType() != null
                    ? new ArrayList<>(lit.getLastNewType()) : new ArrayList<>();
            if (oldType.contains(7)) newType.add(14);
            String typeStr = newType.stream()
                    .map(i -> typeMap.getOrDefault(i.toString(), ""))
                    .filter(s -> !s.isBlank())
                    .collect(Collectors.joining(","));

            Map<String, String> inner = new HashMap<>();
            inner.put("dbId",            dbId);
            inner.put("title",           title);
            inner.put("year",            year);
            inner.put("journal",         journal);
            inner.put("jcr",             jcr);
            inner.put("language",        language);
            inner.put("journalDivision", journalDivision);
            inner.put("type",            typeStr);
            inner.put("text",            text);
            inner.put("summary",    StringUtils.defaultString(lit.getSummary()));
            inner.put("result",     StringUtils.defaultString(lit.getResult()));
            inner.put("conclusion", StringUtils.defaultString(lit.getConclusion()));
            inner.put("tldr",       StringUtils.defaultString(lit.getTldr()));
            inner.put("url", "https://www.evimed.com/details?id=" + dbId);
            result.add(inner);
        }

        log.info("ES BM25 类型过滤检索 {} 条 (types={})，用时 {}ms",
                result.size(), typeIds, System.currentTimeMillis() - start);
        return result;
    }

    /**
     * 指南关键词检索（供 EvidenceRetrievalTool @Tool 调用）
     * 在 guide_block_index 上做 BM25 关键词匹配，按 guideId 折叠去重，
     * 再从 guide_data_index12 补充 title/year 元数据
     *
     * @param keywords 关键词列表（OR 语义）
     * @param size     返回指南条数上限
     */
    public static List<Map<String, String>> searchGuideByKeywords(List<String> keywords, int size) {
        List<Map<String, String>> result = new ArrayList<>();
        if (keywords == null || keywords.isEmpty()) return result;

        long start = System.currentTimeMillis();

        BoolQueryBuilder bool = QueryBuilders.boolQuery();
        for (String kw : keywords) {
            if (kw == null || kw.isBlank()) continue;
            bool.should().add(QueryBuilders.matchQuery("block", kw));
        }
        bool.minimumShouldMatch(1);

        SearchRequest searchRequest = new SearchRequest(EsIndex.of(GuideBlockIndex.class));
        SearchSourceBuilder sourceBuilder = new SearchSourceBuilder();
        sourceBuilder.query(bool).size(Math.max(size, 1));
        sourceBuilder.collapse(new CollapseBuilder("guideId"));
        searchRequest.source(sourceBuilder);

        SearchResponse searchResponse;
        try {
            searchResponse = EsUtil.esClient.search(searchRequest, RequestOptions.DEFAULT);
        } catch (Exception e) {
            log.warn("指南 BM25 检索异常: {}", e.getMessage());
            return result;
        }

        if (searchResponse == null || searchResponse.getHits() == null
                || searchResponse.getHits().getHits().length == 0) {
            log.info("指南 BM25 检索 0 条，用时 {}ms", System.currentTimeMillis() - start);
            return result;
        }

        for (SearchHit hit : searchResponse.getHits().getHits()) {
            GuideBlockIndex content = new GuideBlockIndex();
            BeanUtil.copyProperties(hit.getSourceAsMap(), content, false);
            String guideId = content.getGuideId();
            if (guideId == null || guideId.isBlank()) continue;

            String block = StringUtils.defaultString(content.getBlock());
            if (block.length() > 1000) block = block.substring(0, 1000);

            Map<String, String> map = new HashMap<>();
            map.put("year", "");
            map.put("title", "");

            // 从 guide_data_index12 补充元数据
            try {
                GetRequest getRequest = new GetRequest(EsIndex.of(GuideIndex.class), guideId);
                GetResponse docFields = EsUtil.esClient.get(getRequest, RequestOptions.DEFAULT);
                Map<String, Object> asMap = docFields.getSourceAsMap();
                if (asMap != null) {
                    GuideIndex guideIndex = new GuideIndex();
                    BeanUtil.copyProperties(asMap, guideIndex, false);
                    if (StringUtils.isNotBlank(guideIndex.getYsar())) {
                        map.put("year", guideIndex.getYsar());
                    }
                    if (StringUtils.isNotBlank(guideIndex.getTitle())) {
                        map.put("title", guideIndex.getTitle());
                    }
                }
            } catch (Exception e) {
                log.warn("获取指南元数据失败 guideId={}: {}", guideId, e.getMessage());
            }

            map.put("id", hit.getId());
            map.put("text", block);
            map.put("guideId", guideId);
            map.put("url", "https://www.evimed.com/guide-details?id=" + guideId);
            result.add(map);
        }

        log.info("指南 BM25 检索 {} 条，用时 {}ms", result.size(), System.currentTimeMillis() - start);
        return result;
    }

    /**
     * 说明书关键词检索（NMPA + FDA）
     * 对 genericNames/indication 字段做 BM25 多字段匹配，
     * 比条件驱动查询更适合自由关键词搜索场景。
     *
     * @param keywords 关键词列表（药物名、疾病名等）
     * @param size     每个来源最多返回条数
     * @return 合并 NMPA 和 FDA 结果的列表
     */
    public static List<Map<String, String>> searchInstructionsByKeywords(List<String> keywords, int size) {
        List<Map<String, String>> result = new ArrayList<>();
        if (keywords == null || keywords.isEmpty()) return result;

        long start = System.currentTimeMillis();

        // 构建公共 BM25 查询（genericNames / indication 字段 should 匹配）
        BoolQueryBuilder bool = QueryBuilders.boolQuery();
        for (String kw : keywords) {
            if (kw == null || kw.isBlank()) continue;
            bool.should().add(QueryBuilders.multiMatchQuery(kw, "genericNames", "indication"));
        }
        bool.minimumShouldMatch(1);

        // 1. 查 NMPA（instructions_use_index）：限定可信来源 + 仅使用新说明书（medicineUsePdf=true）
        List<String> nmpaSourceList = Arrays.asList(
                "nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药", "用药参考");
        BoolQueryBuilder nmpaBool = QueryBuilders.boolQuery();
        nmpaBool.must().add(bool);
        nmpaBool.must().add(QueryBuilders.termsQuery("source", nmpaSourceList));
        nmpaBool.must().add(QueryBuilders.matchPhraseQuery("medicineUsePdf", "true"));
        result.addAll(queryInstructionIndex("instructions_use_index", nmpaBool, "nmpa", size));

        // 2. 查 FDA（instruction_data_index，需额外过滤 source=fda）
        BoolQueryBuilder fdaBool = QueryBuilders.boolQuery();
        fdaBool.must().add(QueryBuilders.termQuery("source", "fda"));
        fdaBool.must().add(bool);
        result.addAll(queryInstructionIndex("instruction_data_index", fdaBool, null, size));

        log.info("说明书关键词检索 {} 条，用时 {}ms", result.size(), System.currentTimeMillis() - start);
        return result;
    }

    /**
     * 按药品名称精准获取说明书（供 fetchDrugInstruction 工具使用）。
     * 精准匹配：simpleGenericNames / simpleEnglishName 短语匹配（高权重） + simpleTradeNames.keyword 精确匹配。
     * 限定 NMPA 可信来源，只取新版说明书（medicineUsePdf=true）。
     * 同时搜索 instructions_use_index 和 instruction_data_index，最多返回 1 条。
     */
    public static List<Map<String, String>> fetchInstructionByDrugName(String drugName, String englishName) {
        List<Map<String, String>> result = new ArrayList<>();
        if (drugName == null || drugName.isBlank()) return result;

        List<String> nmpaSourceList = Arrays.asList(
                "nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药", "用药参考");

        // ── 1. NMPA：用中文名精准匹配 ─────────────────────────────────────
        try {
            MultiMatchQueryBuilder cnPhraseMatch = QueryBuilders
                    .multiMatchQuery(drugName, "simpleGenericNames", "simpleEnglishName")
                    .operator(Operator.AND)
                    .field("simpleGenericNames", 100f)
                    .field("simpleEnglishName", 0.1f)
                    .type(MultiMatchQueryBuilder.Type.PHRASE);
            TermQueryBuilder cnTradeTerm = QueryBuilders.termQuery(
                    "simpleTradeNames.keyword", drugName.toLowerCase());
            BoolQueryBuilder cnNameQuery = QueryBuilders.boolQuery();
            cnNameQuery.should().add(cnPhraseMatch);
            cnNameQuery.should().add(cnTradeTerm);
            cnNameQuery.minimumShouldMatch(1);

            BoolQueryBuilder nmpaQuery = QueryBuilders.boolQuery();
            nmpaQuery.must().add(cnNameQuery);
            nmpaQuery.must().add(QueryBuilders.termsQuery("source", nmpaSourceList));
            nmpaQuery.must().add(QueryBuilders.matchPhraseQuery("medicineUsePdf", "true"));

            SearchRequest nmpaReq = new SearchRequest("instructions_use_index");
            nmpaReq.source(new SearchSourceBuilder().query(nmpaQuery).size(1));
            SearchResponse nmpaResp = EsUtil.esClient.search(nmpaReq, RequestOptions.DEFAULT);
            if (nmpaResp != null && nmpaResp.getHits() != null) {
                for (SearchHit hit : nmpaResp.getHits().getHits()) {
                    result.add(buildInstructionMap(hit));
                }
            }
            log.info("fetchInstruction NMPA '{}': {} 条", drugName, result.size());
        } catch (Exception e) {
            log.warn("fetchInstruction NMPA 异常 [{}]: {}", drugName, e.getMessage());
        }

        // ── 2. FDA：用英文名精准匹配 ──────────────────────────────────────
        String fdaName = (englishName != null && !englishName.isBlank()) ? englishName : drugName;
        try {
            MultiMatchQueryBuilder enPhraseMatch = QueryBuilders
                    .multiMatchQuery(fdaName, "simpleGenericNames", "simpleEnglishName")
                    .operator(Operator.AND)
                    .field("simpleGenericNames", 100f)
                    .field("simpleEnglishName", 0.1f)
                    .type(MultiMatchQueryBuilder.Type.PHRASE);
            TermQueryBuilder enTradeTerm = QueryBuilders.termQuery(
                    "simpleTradeNames.keyword", fdaName.toLowerCase());
            BoolQueryBuilder enNameQuery = QueryBuilders.boolQuery();
            enNameQuery.should().add(enPhraseMatch);
            enNameQuery.should().add(enTradeTerm);
            enNameQuery.minimumShouldMatch(1);

            BoolQueryBuilder fdaQuery = QueryBuilders.boolQuery();
            fdaQuery.must().add(enNameQuery);
            fdaQuery.must().add(QueryBuilders.termQuery("source", "fda"));

            SearchRequest fdaReq = new SearchRequest("instruction_data_index");
            fdaReq.source(new SearchSourceBuilder().query(fdaQuery).size(1));
            SearchResponse fdaResp = EsUtil.esClient.search(fdaReq, RequestOptions.DEFAULT);
            if (fdaResp != null && fdaResp.getHits() != null) {
                for (SearchHit hit : fdaResp.getHits().getHits()) {
                    result.add(buildInstructionMap(hit));
                }
            }
            log.info("fetchInstruction FDA '{}': {} 条", fdaName, result.size() - (result.size() > 1 ? 1 : 0));
        } catch (Exception e) {
            log.warn("fetchInstruction FDA 异常 [{}]: {}", fdaName, e.getMessage());
        }

        return result;
    }

    private static Map<String, String> buildInstructionMap(SearchHit hit) {
        InstructionIndex content = new InstructionIndex();
        BeanUtil.copyProperties(hit.getSourceAsMap(), content, false);
        String src = StringUtils.isNotBlank(content.getSource()) ? content.getSource() : "nmpa";
        String pdfName = StringUtils.defaultString(content.getPdf_name());
        String url = StringUtils.isNotBlank(pdfName)
                ? "https://www.evimed.com/drug-details?source=" + src + "&name=" + pdfName : "";
        Map<String, String> m = new HashMap<>();
        m.put("id",           StringUtils.defaultString(content.getId()));
        m.put("genericNames", StringUtils.defaultString(content.getGenericNames()));
        m.put("indication",   StringUtils.defaultString(content.getIndication()));
        m.put("taboo",        StringUtils.defaultString(content.getTaboo()));
        m.put("usage",        StringUtils.defaultString(content.getUsage()));
        m.put("pharmacology", content.getPharmacology() != null ? content.getPharmacology() : "");
        m.put("approvalDates", StringUtils.defaultString(content.getApprovalDates()));
        m.put("source", src);
        m.put("url",    url);
        return m;
    }

    private static List<Map<String, String>> queryInstructionIndex(
            String indexName, BoolQueryBuilder query, String defaultSource, int size) {
        List<Map<String, String>> items = new ArrayList<>();
        try {
            SearchRequest searchRequest = new SearchRequest(indexName);
            SearchSourceBuilder sourceBuilder = new SearchSourceBuilder();
            sourceBuilder.query(query).size(Math.max(size, 1));
            searchRequest.source(sourceBuilder);

            SearchResponse searchResponse = EsUtil.esClient.search(searchRequest, RequestOptions.DEFAULT);
            if (searchResponse == null || searchResponse.getHits() == null
                    || searchResponse.getHits().getHits().length == 0) {
                return items;
            }

            for (SearchHit hit : searchResponse.getHits().getHits()) {
                InstructionIndex content = new InstructionIndex();
                BeanUtil.copyProperties(hit.getSourceAsMap(), content, false);

                String src = StringUtils.isNotBlank(content.getSource())
                        ? content.getSource()
                        : (defaultSource != null ? defaultSource : "");
                String pdfName = StringUtils.defaultString(content.getPdf_name());
                String url = StringUtils.isNotBlank(pdfName)
                        ? "https://www.evimed.com/drug-details?source=" + src + "&name=" + pdfName
                        : "";

                Map<String, String> map = new HashMap<>();
                map.put("id", StringUtils.defaultString(content.getId()));
                map.put("genericNames", StringUtils.defaultString(content.getGenericNames()));
                map.put("indication", StringUtils.defaultString(content.getIndication()));
                map.put("taboo", StringUtils.defaultString(content.getTaboo()));
                map.put("usage", StringUtils.defaultString(content.getUsage()));
                map.put("pharmacology", content.getPharmacology() != null ? content.getPharmacology() : "");
                map.put("approvalDates", StringUtils.defaultString(content.getApprovalDates()));
                map.put("source", src);
                map.put("url", url);
                items.add(map);
            }
        } catch (Exception e) {
            log.warn("说明书检索异常 [{}]: {}", indexName, e.getMessage());
        }
        return items;
    }

    /**
     * 从查询字符串中提取有效关键词（医学实体词）
     * <p>
     * 处理步骤：
     * 1. 先将中文多字功能词替换为空格（"患者"、"研究"、"背景" 等章节上下文词）
     * 2. 再将中文单字虚词替换为空格（在、的、中、与、和、及 等）
     * 3. 按空白/标点分割，过滤长度 < 2 的碎片
     * <p>
     * 示例："乌帕替尼在特应性皮炎患者中的研究现状与背景"
     *   → 替换后：" 乌帕替尼  特应性皮炎      "
     *   → 提取：["乌帕替尼", "特应性皮炎"]
     */
    private static final java.util.regex.Pattern ZH_MULTI_STOP =
            java.util.regex.Pattern.compile(
                    "患者|研究|背景|现状|进展|概述|综述|评价|分析|介绍|治疗|方案|效果|总结|比较|对比|相关|情况|报告");

    private static List<String> extractKeywords(String query) {
        if (query == null || query.isBlank()) return Collections.emptyList();
        // 1. 替换多字中文功能词
        String processed = ZH_MULTI_STOP.matcher(query).replaceAll(" ");
        // 2. 替换单字中文虚词
        processed = processed.replaceAll("[在的中与和及了是对于为到从被]", " ");
        // 3. 分割并过滤
        return Arrays.stream(processed.trim().split("[\\s，,、/。？！\\-_]+"))
                .map(String::trim)
                .filter(w -> w.length() >= 2)
                .map(String::toLowerCase)
                .distinct()
                .collect(Collectors.toList());
    }

    /**
     * PICO AND 过滤：每个非空 PICO 组至少命中一个词
     * 规则：(P有词 → abstract含任一P词) AND (I有词 → abstract含任一I词) AND ...
     * 任一组全部不命中则返回 false
     */
    private static boolean abstractMatchesPicoGroups(String abstractText,
                                                     Map<String, List<String>> picoGroups) {
        if (picoGroups == null || picoGroups.isEmpty()) return true;
        if (abstractText == null || abstractText.isBlank()) return true; // 无 abstract 不过滤
        String lower = abstractText.toLowerCase();
        for (List<String> groupKws : picoGroups.values()) {
            if (groupKws == null || groupKws.isEmpty()) continue; // 该 PICO 要素无值，跳过
            boolean groupHit = groupKws.stream().anyMatch(kw -> kw != null && lower.contains(kw.toLowerCase()));
            if (!groupHit) return false; // AND 失败
        }
        return true;
    }

    /**
     * 判断 abstract 是否包含至少一个关键词（OR 逻辑，降级用）
     */
    private static boolean abstractMatchesKeywords(String abstractText, List<String> keywords) {
        if (abstractText == null || abstractText.isBlank()) return true;
        String lower = abstractText.toLowerCase();
        return keywords.stream().anyMatch(kw -> kw != null && lower.contains(kw.toLowerCase()));
    }

    /**
     * 简化版指南检索：药 AND 病，在 title/block/summary 中匹配，不使用 topicKws
     * 所有逻辑内联在一个方法体内
     */
    public static List<Map<String, String>> searchGuidesSimplified(
            List<String> interventionKws,
            List<String> populationKws,
            List<String> topicKws,
            int size,
            Collection<String> excludeIds) {
        List<Map<String, String>> result = new ArrayList<>();

        // Phase 1: 药 AND 病
        if (!interventionKws.isEmpty() && !populationKws.isEmpty()) {
            BoolQueryBuilder bool = QueryBuilders.boolQuery();

            // 药词 must
            BoolQueryBuilder drugBool = QueryBuilders.boolQuery();
            for (String kw : interventionKws) {
                if (kw != null && !kw.isBlank()) {
                    BoolQueryBuilder fieldOr = QueryBuilders.boolQuery()
                            .should(QueryBuilders.matchQuery("title", kw))
                            .should(QueryBuilders.matchQuery("block", kw))
                            .should(QueryBuilders.matchQuery("summary", kw))
                            .minimumShouldMatch(1);
                    drugBool.should().add(fieldOr);
                }
            }
            drugBool.minimumShouldMatch(1);
            bool.must().add(drugBool);

            // 病词 must
            BoolQueryBuilder diseaseBool = QueryBuilders.boolQuery();
            for (String kw : populationKws) {
                if (kw != null && !kw.isBlank()) {
                    BoolQueryBuilder fieldOr = QueryBuilders.boolQuery()
                            .should(QueryBuilders.matchQuery("title", kw))
                            .should(QueryBuilders.matchQuery("block", kw))
                            .should(QueryBuilders.matchQuery("summary", kw))
                            .minimumShouldMatch(1);
                    diseaseBool.should().add(fieldOr);
                }
            }
            diseaseBool.minimumShouldMatch(1);
            bool.must().add(diseaseBool);

            // topic 词 must（如果有）
            if (topicKws != null && !topicKws.isEmpty()) {
                BoolQueryBuilder topicBool = QueryBuilders.boolQuery();
                for (String kw : topicKws) {
                    if (kw != null && !kw.isBlank()) {
                        BoolQueryBuilder fieldOr = QueryBuilders.boolQuery()
                                .should(QueryBuilders.matchQuery("title", kw))
                                .should(QueryBuilders.matchQuery("block", kw))
                                .should(QueryBuilders.matchQuery("summary", kw))
                                .minimumShouldMatch(1);
                        topicBool.should().add(fieldOr);
                    }
                }
                topicBool.minimumShouldMatch(1);
                bool.must().add(topicBool);
            }

            // 排除已返回的 ID
            if (excludeIds != null && !excludeIds.isEmpty()) {
                bool.mustNot(QueryBuilders.termsQuery("guideId", excludeIds));
            }

            // 执行查询
            try {
                SearchRequest searchRequest = new SearchRequest(EsIndex.of(GuideBlockIndex.class));
                SearchSourceBuilder sourceBuilder = new SearchSourceBuilder();
                sourceBuilder.query(bool).size(Math.max(size, 1));
                sourceBuilder.collapse(new CollapseBuilder("guideId"));
                searchRequest.source(sourceBuilder);

                SearchResponse searchResponse = EsUtil.esClient.search(searchRequest, RequestOptions.DEFAULT);
                if (searchResponse != null && searchResponse.getHits() != null
                        && searchResponse.getHits().getHits().length > 0) {

                    for (SearchHit hit : searchResponse.getHits().getHits()) {
                        GuideBlockIndex content = new GuideBlockIndex();
                        BeanUtil.copyProperties(hit.getSourceAsMap(), content, false);
                        String guideId = content.getGuideId();
                        if (guideId == null || guideId.isBlank()) continue;

                        String block = StringUtils.defaultString(content.getBlock());
                        String summary = StringUtils.defaultString(content.getSummary());
//                        if (block.length() > 1000) block = block.substring(0, 1000);

                        Map<String, String> map = new HashMap<>();
                        map.put("year", "");
                        map.put("title", "");

                        // 补充元数据
                        try {
                            GetRequest getRequest = new GetRequest(EsIndex.of(GuideIndex.class), guideId);
                            GetResponse docFields = EsUtil.esClient.get(getRequest, RequestOptions.DEFAULT);
                            Map<String, Object> asMap = docFields.getSourceAsMap();
                            if (asMap != null) {
                                GuideIndex guideIndex = new GuideIndex();
                                BeanUtil.copyProperties(asMap, guideIndex, false);
                                if (StringUtils.isNotBlank(guideIndex.getYsar()))
                                    map.put("year", guideIndex.getYsar());
                                if (StringUtils.isNotBlank(guideIndex.getTitle()))
                                    map.put("title", guideIndex.getTitle());
                                if (StringUtils.isNotBlank(guideIndex.getNrjs()))
                                    map.put("nrjs", guideIndex.getNrjs());
                            }
                        } catch (Exception e) {
                            log.warn("获取指南元数据失败 guideId={}: {}", guideId, e.getMessage());
                        }

                        map.put("id", hit.getId());
                        map.put("text", block);
                        map.put("summary", summary);
                        map.put("guideId", guideId);
                        map.put("url", "https://www.evimed.com/guide-details?id=" + guideId);
                        result.add(map);
                    }

                    log.info("指南检索（药 AND 病）命中 {} 条", result.size());
                    return result;
                }
                log.info("指南检索（药 AND 病）0 条，降级为仅药词");
            } catch (Exception e) {
                log.warn("指南 ES 查询异常: {}", e.getMessage());
            }
        }

        // Phase 2: 降级为仅药词 OR
        if (!interventionKws.isEmpty()) {
            BoolQueryBuilder fallbackBool = QueryBuilders.boolQuery();
            for (String kw : interventionKws) {
                if (kw != null && !kw.isBlank()) {
                    fallbackBool.should(QueryBuilders.matchQuery("title", kw));
                    fallbackBool.should(QueryBuilders.matchQuery("block", kw));
                    fallbackBool.should(QueryBuilders.matchQuery("summary", kw));
                }
            }
            fallbackBool.minimumShouldMatch(1);

            // topic 词 must（如果有）
            if (topicKws != null && !topicKws.isEmpty()) {
                BoolQueryBuilder topicBool = QueryBuilders.boolQuery();
                for (String kw : topicKws) {
                    if (kw != null && !kw.isBlank()) {
                        BoolQueryBuilder fieldOr = QueryBuilders.boolQuery()
                                .should(QueryBuilders.matchQuery("title", kw))
                                .should(QueryBuilders.matchQuery("block", kw))
                                .should(QueryBuilders.matchQuery("summary", kw))
                                .minimumShouldMatch(1);
                        topicBool.should().add(fieldOr);
                    }
                }
                topicBool.minimumShouldMatch(1);
                fallbackBool.must().add(topicBool);
            }

            // 排除已返回的 ID
            if (excludeIds != null && !excludeIds.isEmpty()) {
                fallbackBool.mustNot(QueryBuilders.termsQuery("guideId", excludeIds));
            }

            try {
                SearchRequest searchRequest = new SearchRequest(EsIndex.of(GuideBlockIndex.class));
                SearchSourceBuilder sourceBuilder = new SearchSourceBuilder();
                sourceBuilder.query(fallbackBool).size(Math.max(size, 1));
                sourceBuilder.collapse(new CollapseBuilder("guideId"));
                searchRequest.source(sourceBuilder);

                SearchResponse searchResponse = EsUtil.esClient.search(searchRequest, RequestOptions.DEFAULT);
                if (searchResponse != null && searchResponse.getHits() != null
                        && searchResponse.getHits().getHits().length > 0) {

                    for (SearchHit hit : searchResponse.getHits().getHits()) {
                        GuideBlockIndex content = new GuideBlockIndex();
                        BeanUtil.copyProperties(hit.getSourceAsMap(), content, false);
                        String guideId = content.getGuideId();
                        if (guideId == null || guideId.isBlank()) continue;

                        String block = StringUtils.defaultString(content.getBlock());

                        Map<String, String> map = new HashMap<>();
                        map.put("year", "");
                        map.put("title", "");

                        try {
                            GetRequest getRequest = new GetRequest(EsIndex.of(GuideIndex.class), guideId);
                            GetResponse docFields = EsUtil.esClient.get(getRequest, RequestOptions.DEFAULT);
                            Map<String, Object> asMap = docFields.getSourceAsMap();
                            if (asMap != null) {
                                GuideIndex guideIndex = new GuideIndex();
                                BeanUtil.copyProperties(asMap, guideIndex, false);
                                if (StringUtils.isNotBlank(guideIndex.getYsar()))
                                    map.put("year", guideIndex.getYsar());
                                if (StringUtils.isNotBlank(guideIndex.getTitle()))
                                    map.put("title", guideIndex.getTitle());
                            }
                        } catch (Exception e) {
                            log.warn("获取指南元数据失败 guideId={}: {}", guideId, e.getMessage());
                        }

                        map.put("id", hit.getId());
                        map.put("text", block);
                        map.put("guideId", guideId);
                        map.put("url", "https://www.evimed.com/guide-details?id=" + guideId);
                        result.add(map);
                    }

                    log.info("指南降级检索（仅药词）命中 {} 条", result.size());
                }
            } catch (Exception e) {
                log.warn("指南降级检索异常: {}", e.getMessage());
            }
        }

        return result;
    }

    private static com.evimed.agent.evidence.agentevidencebased.infrastructure.feign.SentumComprehensiveFeign sentumFeign;

    public static void setSentumFeign(com.evimed.agent.evidence.agentevidencebased.infrastructure.feign.SentumComprehensiveFeign feign) {
        sentumFeign = feign;
    }

    /**
     * 查询 FAERS 数据库（FDA 不良事件报告系统）
     */
    public static Map<String, String> fetchFaersData(String drugName, String englishName) {
        if (sentumFeign == null) {
            log.warn("SentumComprehensiveFeign 未注入，跳过 FAERS 查询");
            return Collections.emptyMap();
        }

        String primaryName = (drugName != null && !drugName.isBlank()) ? drugName : englishName;
        if (primaryName == null || primaryName.isBlank()) {
            return Collections.emptyMap();
        }

        Drug drug =
            new Drug();
        drug.setWord(primaryName);
        if (drugName != null && !drugName.isBlank()) drug.setZhWord(drugName);
        if (englishName != null && !englishName.isBlank()) drug.setEnWord(englishName);

        Condition condition =
            new Condition();
        condition.setDrugs(List.of(drug));

        try {
            JSONObject info = sentumFeign.drugSafeInfoZx(condition);
            if (info == null) return Collections.emptyMap();

            String content = formatFaersContent(info, primaryName);
            Map<String, String> result = new HashMap<>();
            result.put("content", content);
            return result;
        } catch (Exception e) {
            log.error("FAERS 查询失败 [{}]: {}, {}", primaryName, e, e.getMessage());
            return Collections.emptyMap();
        }
    }

    private static String formatFaersContent(JSONObject info, String drugName) {
        JSONObject signalDict = info.getJSONObject("signal_dict");
        JSONArray ptList = info.getJSONArray("pt_list");

        if (signalDict == null || CollUtil.isEmpty(ptList)) {
            return "暂未检索到FAERS数据库中，以" + drugName + "为主要怀疑药物的相关不良反应报告。";
        }

        StringBuilder sb = new StringBuilder();
        Integer total = info.getInteger("psTotal");
        sb.append("截止至2025-06-30，FAERS数据库上报的所有不良反应数据中，以")
          .append(drugName).append("为首要怀疑药物的ADE报告").append(total).append("例。\n\n");

        // 常见不良反应 TOP10
        JSONArray top10 = ptList.size() > 10
            ? JSON.parseArray(JSON.toJSONString(ptList.subList(0, 10)))
            : ptList;
        sb.append("常见不良反应TOP10结果如下：\n");
        sb.append("|不良反应名称（英文）|不良反应名称（中文）|报告数/例|占比|\n|---|---|---|---|\n");
        top10.forEach(item -> {
            JSONArray a = JSON.parseArray(
                JSON.toJSONString(item));
            sb.append("|").append(a.get(1)).append("|").append(a.get(4))
              .append("|").append(a.get(2)).append("|").append(a.get(3)).append("|\n");
        });
        sb.append("\n");

        // 信号挖掘 TOP10
        JSONObject signals = signalDict.getJSONObject("data");
        if (signals != null && !signals.isEmpty()) {
            sb.append("典型信号挖掘TOP10结果如下：\n");
            sb.append("|首选术语（PT）|不良事件|报告数/例|ROR值(95%CI)|EBGM值|IC值(95%CI)|\n|---|---|---|---|---|---|\n");

            List<JSONObject> rows = new ArrayList<>();
            signals.forEach((key, val) -> {
                if (key == null || key.isBlank()) return; // 跳过空 key

                JSONArray arr = JSON.parseObject(JSON.toJSONString(val), JSONArray.class);
                arr.forEach(o -> {
                    JSONArray list = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                    JSONObject row = new JSONObject();
                    row.put("en", list.get(0));
                    row.put("zh", list.get(6));
                    row.put("num", list.get(1));
                    row.put("ror", list.get(3));
                    row.put("ebgm", list.get(4));
                    row.put("ic", list.get(5));
                    row.put("ror_low", list.get(7));
                    row.put("ror_high", list.get(8));
                    row.put("ic_low", list.get(9));
                    row.put("ic_high", list.get(10));
                    rows.add(row);
                });
            });

            rows.stream()
                .sorted(Comparator.comparing(r -> Double.parseDouble(r.getString("ror")),
                        Comparator.reverseOrder()))
                .limit(10)
                .forEach(r -> sb.append("|").append(r.getString("en"))
                    .append("|").append(r.getString("zh"))
                    .append("|").append(r.getString("num"))
                    .append("|").append(r.getString("ror"))
                    .append(" [").append(r.getString("ror_low")).append(",").append(r.getString("ror_high")).append("]")
                    .append("|").append(r.getString("ebgm"))
                    .append("|").append(r.getString("ic"))
                    .append(" [").append(r.getString("ic_low")).append(",").append(r.getString("ic_high")).append("]")
                    .append("|\n"));
        }

        return sb.toString();
    }

    /**
     * 扩展关键词（配置文件 + LLM 动态扩展）
     */
    private static Map<String, List<String>> expansionCache = new ConcurrentHashMap<>();
    private static Map<String, List<String>> configExpansionMap = null;

    public static List<String> expandKeywords(List<String> keywords) {
        if (keywords == null || keywords.isEmpty()) return Collections.emptyList();

        // 懒加载配置文件
        if (configExpansionMap == null) {
            loadExpansionConfig();
        }

        Set<String> expanded = new LinkedHashSet<>();
        for (String kw : keywords) {
            expanded.add(kw);
            expanded.addAll(expandSingleKeyword(kw));
        }
        return new ArrayList<>(expanded);
    }

    private static void loadExpansionConfig() {
        try {
            InputStream is = EvidenceUtils.class.getClassLoader()
                    .getResourceAsStream("keywords-expansion.json");
            if (is != null) {
                String json = new String(is.readAllBytes(), StandardCharsets.UTF_8);
                configExpansionMap = com.alibaba.fastjson.JSON.parseObject(json,
                        new com.alibaba.fastjson.TypeReference<Map<String, List<String>>>() {});
                log.info("关键词扩展配置加载成功，共 {} 个预定义词", configExpansionMap.size());
            } else {
                configExpansionMap = new HashMap<>();
                log.warn("keywords-expansion.json 未找到，使用空配置");
            }
        } catch (Exception e) {
            log.error("加载关键词扩展配置失败: {}", e.getMessage());
            configExpansionMap = new HashMap<>();
        }
    }

    private static List<String> expandSingleKeyword(String keyword) {
        // 1. 优先查配置文件
        for (Map.Entry<String, List<String>> entry : configExpansionMap.entrySet()) {
            if (keyword.contains(entry.getKey())) {
                return entry.getValue();
            }
        }

        // 2. 查缓存
        if (expansionCache.containsKey(keyword)) {
            return expansionCache.get(keyword);
        }

        // 3. LLM 动态扩展（异步，避免阻塞）
        try {
            List<String> llmExpanded = expandByLLM(keyword);
            expansionCache.put(keyword, llmExpanded);
            return llmExpanded;
        } catch (Exception e) {
            log.warn("LLM 扩展关键词失败 [{}]: {}", keyword, e.getMessage());
            return Collections.emptyList();
        }
    }

    private static org.springframework.ai.chat.model.ChatModel llmChatModel;

    public static void setLLMChatModel(org.springframework.ai.chat.model.ChatModel chatModel) {
        llmChatModel = chatModel;
    }

    private static List<String> expandByLLM(String keyword) {
        if (llmChatModel == null) {
            log.debug("ChatModel 未注入，跳过 LLM 扩展");
            return Collections.emptyList();
        }

        String prompt = """
                请为医学检索关键词"%s"生成中英文对照和常见变体（同义词、缩写、年龄范围等）。

                输出格式：JSON 数组，例如 ["词1", "词2", "词3"]
                只输出 JSON 数组，不要任何其他内容。
                """.formatted(keyword);

        try {
            String response = llmChatModel.call(prompt);
            if (response == null || response.isBlank()) return Collections.emptyList();

            int start = response.indexOf('[');
            int end = response.lastIndexOf(']');
            if (start >= 0 && end > start) {
                String jsonArr = response.substring(start, end + 1);
                JSONArray arr = JSON.parseArray(jsonArr);
                List<String> result = new ArrayList<>();
                for (Object obj : arr) {
                    String term = obj.toString().trim();
                    if (!term.isBlank()) result.add(term);
                }
                return result;
            }
        } catch (Exception e) {
            log.warn("LLM 扩展解析失败: {}", e.getMessage());
        }

        return Collections.emptyList();
    }
}
