package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HtmlUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.google.common.reflect.TypeToken;
import com.google.gson.Gson;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.domain.es.GuideIndex;
import com.sentum.evidencecomprehensive.domain.mongo.ConditionGuideAlter;
import com.sentum.evidencecomprehensive.domain.mongo.MongoLiterature;
import com.sentum.evidencecomprehensive.domain.es.PaperIndex;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.WordStatus;
import com.sentum.evidencecomprehensive.service.AiSearchLGService;
import com.sentum.evidencecomprehensive.utils.operateyl.AIRequestUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.mapping.IndexCoordinates;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Service;

import java.lang.reflect.Type;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;


/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/10/28
 */
@Slf4j
@Service
public class AiSearchLGServiceImpl implements AiSearchLGService {
    
    @Autowired
    MongoTemplate mongoTemplate;
    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private FineScreenFeign fineScreenFeign;

    // 定义线程池参数
    int corePoolSize = 3; // 核心线程数
    int maximumPoolSize = 5; // 最大线程数
    long keepAliveTime = 5000; // 空闲线程存活时间，单位毫秒
    TimeUnit unit = TimeUnit.MILLISECONDS; // 时间单位
    BlockingQueue<Runnable> workQueue = new LinkedBlockingQueue<>(42); // 任务队列
    // 创建自定义线程池
    ThreadPoolExecutor executor = new ThreadPoolExecutor(
            corePoolSize,
            maximumPoolSize,
            keepAliveTime,
            unit,
            workQueue,
            new ThreadPoolExecutor.CallerRunsPolicy()
    );

    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) {
            return "";
        }
        content = content.replaceAll(oldChar, newChar);
        return content;
    }

    @Override
    public List<String> aiSplitDisease(JSONObject json) {
        List<String> drug = json.getJSONArray("drug").stream().map(Object::toString).collect(Collectors.toList());
        List<String> disease = json.getJSONArray("disease").stream().map(Object::toString).collect(Collectors.toList());

        List<String> resultSplitDisease = new ArrayList<>();

        Map<Integer, AtomicReference<String>> map = new HashMap<>(16);

        ExecutorService executorService = Executors.newFixedThreadPool(disease.size());

        List<CompletableFuture<Void>> allCompletableFuture = new ArrayList<>();
        for (int i = 0; i < disease.size(); i++) {
            int number = i;
            allCompletableFuture.add(CompletableFuture.runAsync(() -> {
                String splitPrompt = "请作为权威医学术语处理专家，执行以下操作：\n"
                        + "1. 对输入疾病术语\"{"+ disease.get(number) +"}\"执行标准化处理\n"
                        + "2. 标准化规则优先级：\n"
                        + "   (1) 医学词典校验：\n"
                        + "       - 使用SNOMED CT 2024术语集校验拼写\n"
                        + "       - 修正显性错别字（如：疱\"诊\"→疱\"疹\"）\n"
                        + "       - 自动修复大小写错误\n"
                        + "   (2) 解构终止条件：\n"
                        + "       - 当剩余词素长度≤2个汉字时自动终止\n"
                        + "       - 当解构结果已存在于ICD-11第7章时终止\n"
                        + "       - 当解构结果不再是原词的子字符串时终止\n"
                        + "3. 修饰词去除非必须符合：\n"
                        + "   - 只去除明确属于以下类别的成分：\n"
                        + "     * 疾病活动状态（缓解期/活动性）\n"
                        + "     * 病理特征描述（伴/不伴XXX）\n"
                        + "     * 临床分期（I期/早期等）\n"
                        + "     * 地域限定词（东方型/热带型）\n"
                        + "   - 特殊保留：\n"
                        + "     * 疾病亚型特征（溃疡性/克罗恩）必须保留\n"
                        + "     * 解剖部位限定词（直肠/全结肠）必须保留\n\n"
                        + "输出要求：\n"
                        + "   {\n"
                        + "     \"original\": \"原输入疾病术语\",\n"
                        + "     \"corrected\": \"拼写修正后的术语\",\n"
                        + "     \"standardized\": \"标准化结果\",\n"
                        + "     \"modifications\": [\n"
                        + "       {\"action\": \"修正拼写\", \"detail\": \"原[疱诊]→修正[疱疹]\"}\n"
                        + "       {\"action\": \"去除修饰\", \"removed\": \"活动性\"}\n"
                        + "     ],\n"
                        + "     \"termination_criterion\": \"触发终止条件\"\n"
                        + "   }\n"
                        + "请只返回JSON格式数据体"
                        + "验证机制：\n"
                        + "1. 所有输出必须通过ICD-11术语验证接口\n"
                        + "2. 修正后的术语必须存在于SNOMED CT最新版本\n"
                        + "3. 解构路径必须符合WHO Adverse Drug Reaction Terminology规范\n"
                        + "关键检查点：\n"
                        + "• 当不可再简化时保留原始术语（如：化疗）\n"
                        + "• 多词素疾病必须保持词素完整性（如：炎症性肠病）\n"
                        + "• 自动拒绝非法修改（如：克罗恩病→肠病）\n"
                        + "• 显性错别字优先修正（如：幽门罗门氏菌→幽门螺杆菌）";
                long startTime = System.currentTimeMillis();

                int retryCount = 0;
                int maxRetryCount = 6;
                while (retryCount < maxRetryCount) {
                    try {
                        String searchDrugEachResult = AIRequestUtils.modelStudio(splitPrompt, Constants.QWEN3_235B_A22B_INSTRUCT_2507);
                        String splitDisease = "";
                        if (StrUtil.isNotBlank(searchDrugEachResult)) {
                            int start = searchDrugEachResult.indexOf('{');
                            int end = searchDrugEachResult.lastIndexOf('}');
                            Gson gson = new Gson();
                            Type jsonObject = new TypeToken<JSONObject>(){}.getType();
                            JSONObject aiResult = gson.fromJson(searchDrugEachResult.substring(start, end + 1), jsonObject);
                            splitDisease = aiResult.getString("standardized");
                        }
                        map.put(number, new AtomicReference<>(splitDisease));
                        log.info("第 {} 个疾病分析定语时间为{}", number, System.currentTimeMillis() - startTime);
                        return;
                    } catch (Exception e) {
                        log.error("去除修饰词发生错误{}", e.getMessage(), e);
                    }
                    retryCount++;
                }
            }, executorService));
        }

        List<Void> allFutureComplete = allCompletableFuture.stream()
                .map(CompletableFuture::join)
                .collect(Collectors.toList());

        executorService.shutdown();
        while (!executorService.isTerminated()) {
            try {
                Thread.sleep(1);
            } catch (InterruptedException e) {
                log.error(e.getMessage(), e);
            }
        }

        if (CollUtil.isNotEmpty(map)) {
            List<AtomicReference<String>> atomicListBySorted = map.entrySet().stream().sorted(Comparator.comparingInt(Map.Entry::getKey)).map(Map.Entry::getValue).collect(Collectors.toList());
            for (AtomicReference<String> atomicReference : atomicListBySorted) {
                resultSplitDisease.add(atomicReference.get());
            }
        }
        return resultSplitDisease;
    }

    @Override
    public void secondGenerationInclude(Condition condition, List<Map<String, String>> searchGuide, Map<String, String> guideTitleToText1, List<String> includeIds) {
        // 指南的筛选开始 ｜ 结束 时间
        Integer startYear = Integer.parseInt(StrUtil.isNotBlank(condition.getGuideStartYear()) ? condition.getGuideStartYear() : "1949");
        Integer endYear = Integer.parseInt(StrUtil.isNotBlank(condition.getGuideEndYear()) ? condition.getGuideEndYear() : "2024");
        // 药物和疾病的同义词
        List<Drug> drugs = condition.getDrugs();
        List<Disease> diseases = condition.getDiseases();
        List<Disease> guideWipeDiseases = condition.getGuideWipeDiseases();
        List<String> drugSynonym = handleDrugToSynonym(drugs);
        List<String> diseaseSynonym = handleDiseaseToSynonym(diseases);
        ConditionGuideAlter conditionGuideAlter = condition.getConditionGuideAlter();
        if (Objects.nonNull(conditionGuideAlter)) {
            drugs = conditionGuideAlter.getDrugs();
            diseases = conditionGuideAlter.getDiseases();
            guideWipeDiseases = conditionGuideAlter.getGuideWipeDiseases();
            drugSynonym = handleDrugToSynonym(drugs);
            diseaseSynonym = handleDiseaseToSynonym(diseases);
        }
        if (CollUtil.isNotEmpty(guideWipeDiseases)) {
            diseaseSynonym.addAll(handleWipeDiseaseToSynonym(guideWipeDiseases));
        }
        searchEvidenceGuideInclude(searchGuide, startYear, endYear, drugSynonym, diseaseSynonym, guideTitleToText1, includeIds);
    }

    private void assemblyBibliography(JSONObject data) {
        JSONObject bibliography = data.getJSONObject("bibliography");
        data.put("bibliography", bibliography);

        JSONArray bibliographys3 = new JSONArray();
        if (Objects.nonNull(data.get("literaturesListMap"))) {
            // 之前所有关于文献内容的 名称与序号[count] 对应关系
            HashMap<String, Integer> literaturesListMap = JSON.parseObject(JSON.toJSONString(data.get("literaturesListMap")), new TypeReference<HashMap<String, Integer>>() {
            });

            // literaturesList 之前所有文献文内容
            JSONArray literaturesList = data.getJSONArray("literaturesList");
            List<Map.Entry<String, Integer>> literaturesListFilter = literaturesListMap.entrySet().stream().sorted(Map.Entry.comparingByValue()).collect(Collectors.toList());
            for (Map.Entry<String, Integer> entry : literaturesListFilter) {
                // 文献名称
                String key = entry.getKey();
                // 文献序号
                Integer value = entry.getValue();
                if (Objects.nonNull(literaturesList) && !literaturesList.isEmpty()) {
                    for (Object o : literaturesList) {
                        MongoLiterature mongoLiterature = JSON.parseObject(JSON.toJSONString(o), MongoLiterature.class);
                        String author = "";
                        if (CollUtil.isNotEmpty(mongoLiterature.getAuthor())) {
                            author = mongoLiterature.getAuthor().get(0);
                        }
                        String year = "";
                        if (StrUtil.isNotBlank(mongoLiterature.getYear())) {
                            year = mongoLiterature.getYear();
                        }

                        String title = "";
                        if (StrUtil.isNotBlank(mongoLiterature.getTitle())) {
                            title = mongoLiterature.getTitle();
                        }

                        StringBuilder key_1 = new StringBuilder().append(author).append(" ").append(year).append(" ").append(title);
                        if (StrUtil.equals(key, key_1.toString())) {
                            //封装参考文献
                            this.refrenceBuilder(mongoLiterature, bibliographys3, "["+value+"]");
                            break;
                        }
                    }
                }
            }
        }
        bibliography.put("bibliographys3", bibliographys3);
    }

    private void refrenceBuilder(MongoLiterature mongoLiterature, JSONArray bibliographys, String value) {
        StringBuilder literatureBuilder = new StringBuilder();
        literatureBuilder.append(value);
        literatureBuilder.append(" ");
        literatureBuilder.append(StrUtil.isBlank(getThreeAuthorStr(mongoLiterature.getAuthor())) ? "" : getThreeAuthorStr(mongoLiterature.getAuthor()) + ".");
        literatureBuilder.append(StrUtil.isBlank(mongoLiterature.getTitle()) ? "" : HtmlUtil.cleanHtmlTag(mongoLiterature.getTitle()) + ".");
        literatureBuilder.append(StringUtils.isBlank(mongoLiterature.getJournal()) ? "" : (mongoLiterature.getJournal()));
        if (StrUtil.isNotBlank(mongoLiterature.getYear())) {
            literatureBuilder.append(",").append(mongoLiterature.getYear());
        }
        if (Objects.nonNull(mongoLiterature.getVolume()) && CollUtil.isNotEmpty(mongoLiterature.getVolume())) {
            literatureBuilder.append(",").append(mongoLiterature.getVolume().get(0));
            if (Objects.nonNull(mongoLiterature.getIssue()) && CollUtil.isNotEmpty(mongoLiterature.getIssue())) {
                literatureBuilder.append("(").append(mongoLiterature.getVolume().get(0)).append(")");
                if (Objects.nonNull(mongoLiterature.getPages()) && StrUtil.isNotBlank(mongoLiterature.getPages())) {
                    literatureBuilder.append(":").append(mongoLiterature.getPages()).append(".");
                } else {
                    literatureBuilder.append(".");
                }
            } else {
                if (Objects.nonNull(mongoLiterature.getPages()) && StrUtil.isNotBlank(mongoLiterature.getPages())) {
                    literatureBuilder.append(":").append(mongoLiterature.getPages()).append(".");
                } else {
                    literatureBuilder.append(".");
                }
            }
        } else {
            if (Objects.nonNull(mongoLiterature.getIssue()) && CollUtil.isNotEmpty(mongoLiterature.getIssue())) {
                literatureBuilder.append(",").append("(").append(mongoLiterature.getIssue().get(0)).append(")");
                if (Objects.nonNull(mongoLiterature.getPages()) && StrUtil.isNotBlank(mongoLiterature.getPages())) {
                    literatureBuilder.append(":").append(mongoLiterature.getPages()).append(".");
                } else {
                    literatureBuilder.append(".");
                }
            } else {
                if (Objects.nonNull(mongoLiterature.getPages()) && StrUtil.isNotBlank(mongoLiterature.getPages())) {
                    literatureBuilder.append(":").append(mongoLiterature.getPages()).append(".");
                } else {
                    literatureBuilder.append(".");
                }
            }
        }
        bibliographys.add(literatureBuilder.toString());
    }

    private String getThreeAuthorStr(List<String> author) {
        StringBuilder stringBuilder = new StringBuilder();
        if (CollUtil.isNotEmpty(author)) {
            for (int i = 0; i < author.size(); i++) {
                stringBuilder.append(",").append(author.get(i));
                if (i == 2) {
                    break;
                }
            }
        }
        return stringBuilder.length() == 0 ? "" : stringBuilder.substring(1, stringBuilder.length());
    }



    private int assembleGuide(Map<String, String> guideTitleToText, List<String> includeIds, Map<String, String> guideTitleToYear, Map<String, String> guideTitleToCC, Map<String, String> guideTitleToZdz, AtomicInteger guideCount, JSONArray guideInfo, int literatureCount, JSONArray duplicateGuide) {
        if (CollUtil.isNotEmpty(includeIds)) {
            List<String> ids = JSON.parseObject(JSON.toJSONString(includeIds), new TypeReference<List<String>>() {
            });
            for (String guideId : ids) {
                BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
                boolQueryBuilder.must().add(QueryBuilders.idsQuery().addIds(guideId));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
                SearchHit<GuideIndex> guideIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, GuideIndex.class);
                if (Objects.nonNull(guideIndexSearchHit)) {
                    GuideIndex guide = guideIndexSearchHit.getContent();

                    JSONObject inner = new JSONObject();

                    String title = guide.getTitle();
                    title = title.replaceAll("\\.+", " ");
                    String guideNumber = "[" + literatureCount + "]";
                    String zdz = guideTitleToZdz.get(title);
                    if (StrUtil.isNotBlank(zdz)) {
                        guideNumber += " " + zdz.replaceAll("\n", " ") + ".";
                    }
                    guideNumber += title + "[J].";
                    String cc = guideTitleToCC.get(title);
                    if (StrUtil.isNotBlank(cc)) {
                        guideNumber += cc + ".";
                    }
                    String year = guideTitleToYear.get(title);
                    if (StrUtil.isNotBlank(year)) {
                        guideNumber += year + ".";
                    }
                    duplicateGuide.add(guideNumber);

                    String block = "";
                    if (CollUtil.isNotEmpty(guideTitleToText) && guideTitleToText.containsKey(title)) {
                        block = guideTitleToText.get(title);
                    } else {
                        continue;
                    }
                    
                    if (StrUtil.isNotBlank(block)) {
                        inner.put("title", "《" + title + "》[" + literatureCount + "]指出：");
//                            boolean english = block.matches(".*[a-zA-Z].*");
                        boolean english = block.getBytes().length == block.length();
                        if (english) {
                            JSONObject jsonObject = new JSONObject();
                            jsonObject.put("word", block);
                            String deeplResult = "";
                            try {
                                deeplResult = fineScreenFeign.deepl(jsonObject);
                                block += "\n（ 翻译版本：" + deeplResult + "）";
                                inner.put("data", block);
                            } catch (Exception e) {
                                inner.put("data", block);
                            }
                        } else {
                            inner.put("data", block);
                        }
                    } else {
                        inner.put("title", "《" + title + "》[" + literatureCount + "]");
                        inner.put("data", block);
                    }
                    literatureCount++;
                    guideInfo.add(inner);
                    guideCount.getAndIncrement();
                }
            }
        }
        return literatureCount;
    }

    private void searchEvidence(List<Map<String, String>> guideEvidence, Integer startYear, Integer endYear, List<String> drugSynonym, List<String> diseaseSynonym, JSONArray guideNeedFilter, Map<String, String> guideTitleToText1, Map<String, String> guideTitleToText2, Map<String, String> guideTitleToText3, Map<String, String> guideTitleToText4, Map<String, String> guideTitleToYear, Map<String, String> guideTitleToCC, Map<String, String> guideTitleToZdz) {
        log.info("指南/共识 查找共四次，根据日志看出，此次查找{}篇", guideEvidence.size());
        
        Set<String> guideIds = new HashSet<>();
        Map<String, String> guideIdToText = guideEvidence.stream().distinct().filter(guideMap -> guideIds.add(guideMap.get("id"))).collect(Collectors.toMap(guideMap -> guideMap.get("id"), guideMap -> guideMap.get("text")));
        List<Map<String, String>> collect = guideEvidence.stream().distinct().collect(Collectors.toList());
        List<String> ids = guideEvidence.stream().distinct().map(guideMap -> guideMap.get("id")).distinct().collect(Collectors.toList());
        if (CollUtil.isNotEmpty(guideEvidence)) {
            int loop = guideEvidence.size() % 50 == 0 ? guideEvidence.size() / 50 : guideEvidence.size() / 50 + 1;
            for (int i = 0; i < loop; i++) {
                BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
                boolQueryBuilder.must().add(QueryBuilders.idsQuery().addIds(guideEvidence.stream().skip(i * 50L).limit(50).map(guideMap -> guideMap.get("id")).distinct().toArray(String[]::new)));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
                nativeSearchQuery.setMaxResults(50);
                SearchHits<GuideIndex> guideIndexSearchHits = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
                long totalHits = guideIndexSearchHits.getTotalHits();
                if (totalHits > 0) {
                    for (SearchHit<GuideIndex> searchHit : guideIndexSearchHits.getSearchHits()) {
                        GuideIndex content = searchHit.getContent();
                        String ysar = content.getYsar();
                        // 空年份直接过滤
                        if (StrUtil.isBlank(ysar)) {
                            continue;
                        }

                        try {
                            // 不在检索范围年份直接过滤
                            if (!(Integer.parseInt(ysar) >= startYear && Integer.parseInt(ysar) <= endYear)) {
                                continue;
                            }
                        } catch (Exception e) {
                            log.error(e.getMessage(), e);
                            continue;
                        }
                       

                        JSONObject guide = new JSONObject();
                        guide.put("id", content.getId());
                        guide.put("title", content.getTitle());
                        List<String> blocks = new ArrayList<>();
                        List<String> isEmpty = guideEvidence.stream().filter(guideMap -> guideMap.get("id").equals(content.getId())).map(guideMap -> guideMap.get("text")).collect(Collectors.toList());
                        if (CollUtil.isNotEmpty(isEmpty)) {
                            blocks = isEmpty;
                        }
                        guide.put("block", blocks);
                        String blockStr = String.join(";", blocks);

                        if (checkFullWordContain(content.getTitle(), drugSynonym)
                                && checkFullWordContain(content.getTitle(), diseaseSynonym)) {
                            guideTitleToText1.put(content.getTitle(), blockStr);
                            
                            guideTitleToYear.put(content.getTitle(), content.getYsar());
                            guideTitleToCC.put(content.getTitle(), content.getCc());
                            guideTitleToZdz.put(content.getTitle(), content.getZdz());
                            continue;
                        }

                        if (guideIdToText.containsKey(content.getId())) {
                            if (checkFullWordContain(blockStr, drugSynonym)
                                    && checkFullWordContain(blockStr, diseaseSynonym)) {
                                guideTitleToText2.put(content.getTitle(), blockStr);

                                guideTitleToYear.put(content.getTitle(), content.getYsar());
                                guideTitleToCC.put(content.getTitle(), content.getCc());
                                guideTitleToZdz.put(content.getTitle(), content.getZdz());

                                guideNeedFilter.add(guide);
                                continue;
                            }
                        }                            
                            

                        if (checkFullWordContain(content.getTitle(), drugSynonym)
                                || checkFullWordContain(content.getTitle(), diseaseSynonym)) {
                            guideTitleToText3.put(content.getTitle(), blockStr);
                            
                            guideTitleToYear.put(content.getTitle(), content.getYsar());
                            guideTitleToCC.put(content.getTitle(), content.getCc());
                            guideTitleToZdz.put(content.getTitle(), content.getZdz());

                            guideNeedFilter.add(guide);
                            continue;
                        }

                        if (guideIdToText.containsKey(content.getId())) {
                            if (checkFullWordContain(blockStr, drugSynonym)
                                    || checkFullWordContain(blockStr, diseaseSynonym)) {
                                guideTitleToText4.put(content.getTitle(), blockStr);

                                guideTitleToYear.put(content.getTitle(), content.getYsar());
                                guideTitleToCC.put(content.getTitle(), content.getCc());
                                guideTitleToZdz.put(content.getTitle(), content.getZdz());

//                            guide.put("block",guideIdToText.get(content.getId()));

                                guideNeedFilter.add(guide);
                            }
                        }
                    }
                }
            }
        }
//        log.info("最终标题同时含有p & i 的指南/共识保留{}篇", guideTitleToText1.size() + guideTitleToText2.size() + guideTitleToText3.size() + guideTitleToText4.size());
    }

    private void searchEvidenceGuideInclude(List<Map<String, String>> guideEvidence, Integer startYear, Integer endYear, List<String> drugSynonym, List<String> diseaseSynonym, Map<String, String> guideTitleToText1, List<String> includeIds) {
        List<String> oneLevel = new ArrayList<>();
        List<String> twoLevel = new ArrayList<>();
        List<String> threeLevel = new ArrayList<>();
        List<String> fourLevel = new ArrayList<>();
        List<String> ids = guideEvidence.stream().distinct().map(guideMap -> guideMap.get("id")).filter(str -> !str.contains("_")).distinct().collect(Collectors.toList());
        if (CollUtil.isNotEmpty(ids)) {
            int cycle = ids.size() % 50 == 0 ? ids.size() / 50 : ids.size() / 50 + 1;
            for (int i = 0; i < cycle; i++) {
                int size1 = CollectionUtil.union(oneLevel, twoLevel, threeLevel, fourLevel).size();
                if (size1 >= 50) {
                    break;
                }
                BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
                boolQueryBuilder.must().add(QueryBuilders.idsQuery().addIds(ids.stream().skip(i * 50L).limit(50).toArray(String[]::new)));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
                nativeSearchQuery.setMaxResults(50);
                SearchHits<GuideIndex> guideIndexSearchHits = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
                long totalHits = guideIndexSearchHits.getTotalHits();
                if (totalHits > 0) {
                    ExecutorService executorService = Executors.newFixedThreadPool(4);
                    List<CompletableFuture<Void>> futures = new ArrayList<>();
                    for (SearchHit<GuideIndex> searchHit : guideIndexSearchHits.getSearchHits()) {
                        int size = CollectionUtil.union(oneLevel, twoLevel, threeLevel, fourLevel).size();
                        if (size >= 50) {
                            break;
                        }
                        GuideIndex content = searchHit.getContent();
                        String ysar = content.getYsar();
                        // 空年份直接过滤
                        if (StrUtil.isBlank(ysar)) {
                            continue;
                        }
                        try {
                            ysar = ysar.trim();
                            // 不在检索范围年份直接过滤
                            if (!(Integer.parseInt(ysar) >= startYear && Integer.parseInt(ysar) <= endYear)) {
                                continue;
                            }
                        } catch (Exception e) {
                            log.error(e.getMessage(), e);
                            continue;
                        }

                        futures.add(CompletableFuture.runAsync(() -> {
                            try {
                                try {
                                    log.info("任务 {}, 正在执行，线程名: {}", content.getTitle(), Thread.currentThread().getName());
                                    String language = content.getLanguage();
                                    String title = content.getTitle();
                                    title = title.replaceAll("\\.+", " ");
                                    // 标题同时含有 第一优先级
                                    if (checkFullWordContain(title, drugSynonym)
                                            && checkFullWordContain(title, diseaseSynonym)) {
                                        List<String> blocks = searchBlock(content.getId(), language, drugSynonym, diseaseSynonym);
                                        if (CollUtil.isEmpty(blocks)) {
                                            return;
                                        }
                                        String block = blocks.get(0);
                                        guideTitleToText1.put(title, block);
                                        oneLevel.add(content.getId());
                                    } else if (checkFullWordContain(title, diseaseSynonym)) { // 标题包含病  第二优先级
                                        List<String> blocks = searchBlock(content.getId(), language, drugSynonym, diseaseSynonym);
                                        if (CollUtil.isEmpty(blocks)) {
                                            return;
                                        }
                                        String block = blocks.get(0);
                                        guideTitleToText1.put(title, block);
                                        twoLevel.add(content.getId());
                                    } else if (checkFullWordContain(title, drugSynonym)) {// 标题包含药 第三优先级
                                        List<String> blocks = searchBlock(content.getId(), language, drugSynonym, diseaseSynonym);
                                        if (CollUtil.isEmpty(blocks)) {
                                            return;
                                        }
                                        String block = blocks.get(0);
                                        guideTitleToText1.put(title, block);
                                        threeLevel.add(content.getId());
                                    } else {
                                        // 文本块包含第四优先级
                                        List<String> blocks = searchBlock(content.getId(), language, drugSynonym, diseaseSynonym);
                                        if (CollUtil.isNotEmpty(blocks)) {
                                            String block = blocks.get(0);
                                            guideTitleToText1.put(title, block);
                                            fourLevel.add(content.getId());
                                        }
                                    }

                                    try {
                                        Thread.sleep(1000);
                                    } catch (InterruptedException e) {
                                        Thread.currentThread().interrupt();
                                    }
                                    log.info("任务 {}, 执行完毕!!!", content.getTitle());
                                } catch (Exception e) {
                                    log.error(e.getMessage(), e);
                                }
                            } catch (Exception e) {
                                log.error(e.getMessage(), e);
                            }
                        }, executorService));
                    }

                    try {
                        CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
                    } catch (CompletionException e) {
                        log.error(e.getMessage(), e);
                    }
                    executorService.shutdown();
                    try {
                        if (!executorService.awaitTermination(30, TimeUnit.SECONDS)) {
                            executorService.shutdownNow();
                        }
                    } catch (InterruptedException e) {
                        executorService.shutdownNow();
                        Thread.currentThread().interrupt();
                    }
                }
            }
            includeIds.addAll(oneLevel);
            includeIds.addAll(twoLevel);
            includeIds.addAll(threeLevel);
            includeIds.addAll(fourLevel);
        }
    }

    @Override
    public List<String> searchBlock(String id, String language, List<String> drugSynonym, List<String> diseaseSynonym) {
        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        boolQueryBuilder.must().add(QueryBuilders.termQuery("guideId", id));
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        nativeSearchQuery.setMaxResults(100 * 3);
        SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class, IndexCoordinates.of("guide_block_index"));
        List<SearchHit<GuideIndex>> searchHits = search.getSearchHits();
        if (CollUtil.isNotEmpty(searchHits)) {
            List<String> blocks = new ArrayList<>();
            for (SearchHit<GuideIndex> searchHit : searchHits) {
                GuideIndex guideIndex = searchHit.getContent();
                String block = guideIndex.getBlock();
                if (checkFullWordContain(block, drugSynonym) &&
                        checkFullWordContain(block, diseaseSynonym)) {
                    blocks.add(block);
                }                
            }
            if (CollUtil.isNotEmpty(blocks)) {
                if (blocks.size() == 1) {
                    return new ArrayList<>(Collections.singleton(blocks.get(0)));
                }
                String question_1 = "请根据提供的资料内容进行专业总结分析。" +
                        "\n\n## 任务要求：" +
                        "\n根据资料内容生成结构化的总结，直接呈现核心信息和关键内容。" +
                        "\n\n## 内容格式要求：" +
                        "\n- 使用换行符(\\n)和适当缩进创建层次结构" +
                        "\n- 内容应具有清晰的逻辑层次" +
                        "\n- 直接进入主要内容，避免引言性语句" +
                        "\n\n## 输出格式要求：" +
                        "\n1. 必须严格按照JSON格式返回" +
                        "\n2. 使用单一的result字段接收所有内容" +
                        "\n3. 返回格式如下：" +
                        "\n```json" +
                        "\n{" +
                        "\n  \"result\": \"结构化的总结内容，使用\\n进行分层\"" +
                        "\n}" +
                        "\n```" +
                        "\n\n## 内容禁忌：" +
                        "\n- 开头禁止使用：'提供的资料'、'主要涉及'等引言句式" +
                        "\n- 内容中禁止出现：'总结'、'资料涉及'等摘要性词汇" +
                        "\n- 直接呈现实质性内容和分析结果" +
                        "\n\n## 注意事项：" +
                        "\n- 确保JSON格式正确且可解析" +
                        "\n- 保持内容的专业性和准确性" +
                        "\n- 合理使用换行和缩进增强可读性" +
                        "\n\n资料内容：{" + String.join(";", blocks) + "}";
                String block = "";
                try {
                    String summary = AIRequestUtils.modelStudio(question_1, Constants.QWEN3_235B_A22B_INSTRUCT_2507);
                    log.info("总结内容为 {}", summary);
                    if (StrUtil.isNotBlank(summary)) {
                        try {
                            int start = summary.indexOf('{');
                            int end = summary.lastIndexOf('}');
                            JSONObject obj = JSONObject.parseObject(summary.substring(start, end + 1));
                            if (Objects.nonNull(obj)) {
                                block = wiffOfContent(obj.getString("result"), "\n\n", "\n");
                            }
                            Thread.sleep(1000);
                        } catch (InterruptedException e) {
                            throw new RuntimeException(e);
                        }
                    }
                } catch (Exception e) {
                    block = blocks.get(0);
                    log.error("gpt4o接口未调通！！！");
                }
                return new ArrayList<>(Collections.singleton(block));
            }
        }
        return new ArrayList<>();
    }


    private Integer assembleLiterature(List<MongoLiterature> literatures, Map<String, Integer> literaturesListMap, Integer literatureCount, List<MongoLiterature> literaturesList, StringBuilder safetyConclusion, StringBuilder safetyConclusionResult, JSONObject safety, String drugUseForDisease, String typeName, String zhTypeName) {
        boolean typeExists = false;
        int literatureCountL = literatureCount;
        if (CollUtil.isNotEmpty(literatures)) {
            typeExists = true;
            for (MongoLiterature mongoLiterature : literatures) {
                
                // 作者
                List<String> authorList = mongoLiterature.getAuthor();
                String author = "";
                if (CollUtil.isNotEmpty(authorList)) {
                    author = authorList.get(0);
                }
                
                // 发表年份
                String year = "";
                if (StrUtil.isNotBlank(mongoLiterature.getYear())) {
                    year = mongoLiterature.getYear();
                }

                String title = "";
                if (StrUtil.isNotBlank(mongoLiterature.getTitle())) {
                    title = mongoLiterature.getTitle();
                }
                
                // 重复key
                String key = author + " " + year + " " + title;
                // 存在相同 key 不能进行覆盖  但是 存在一种情况是 虽说第一作者和 year相同 但是确是不是同一篇文献 暂不考虑这种情况 
                if (!literaturesListMap.containsKey(key)) {
                    literaturesList.add(mongoLiterature);
                    literaturesListMap.put(key, literatureCount);
                } else {
                    Integer integer = literaturesListMap.get(key);
                }

                // 需要总结的东西
                safetyConclusion.append(mongoLiterature.getSummary()).append("；");
                safetyConclusionResult.append(mongoLiterature.getResult()).append("；").append(mongoLiterature.getConclusion()).append("；");
                
                literatureCount++;
            }

            int literatureCountR = literatureCount - 1;
            // 先组每种类型的标题的一段显示内容
            String title = "";
            if (literatureCountL == literatureCountR) {
                title = "有"+ literatures.size() +"篇"+ zhTypeName +"["+ literatureCountL +"]证据显示：";
            } else {
                title = "有"+ literatures.size() +"篇"+ zhTypeName +"["+ literatureCountL + "-" + literatureCountR +"]证据显示：";
            }
            String titleContent = "";
            
            safety.put(typeName + "Title", title);
            safety.put(typeName + "TitleContent", titleContent);
            
            // 模型总结内容(将全部系统综述/Meta 分析的摘要内容发给模型，用模型总结，Propmpt可为：
            String questionMeta = "请你作为一名专业的数据分析师，对提供的文献内容进行深度分析。" +
                    "\n\n## 任务要求：" +
                    "\n基于文献内容，针对{" + drugUseForDisease + "}进行专业分析，重点阐述其有效性。" +
                    "\n\n## 分析重点：" +
                    "\n- 深度阅读和理解文献内容" +
                    "\n- 提取关于有效性的关键信息" +
                    "\n- 生成概括性的专业评述" +
                    "\n- 重点关注疗效数据、临床表现、治疗结果等" +
                    "\n\n## 输出格式要求：" +
                    "\n1. 使用中文回答" +
                    "\n2. 严格按照JSON格式返回" +
                    "\n3. 返回格式如下：" +
                    "\n```json" +
                    "\n{" +
                    "\n  \"result\": \"基于文献分析的有效性评述内容\"" +
                    "\n}" +
                    "\n```" +
                    "\n\n## 内容要求：" +
                    "\n- 内容应具有专业性和客观性" +
                    "\n- 基于证据进行分析，避免主观推测" +
                    "\n- 如需分段可使用\\n进行换行" +
                    "\n- 确保JSON格式正确且可解析" +
                    "\n\n## 注意事项：" +
                    "\n- 重点关注有效性相关的数据和结论" +
                    "\n- 保持分析的科学性和准确性" +
                    "\n- 避免过度解读或夸大效果" +
                    "\n\n文献内容：{" + safetyConclusion.toString() + "}";

            try {
                String resultAs = AIRequestUtils.modelStudio(questionMeta, Constants.QWEN3_235B_A22B_INSTRUCT_2507);
                if (StrUtil.isNotBlank(resultAs)) {
                    int start = resultAs.indexOf('{');
                    int end = resultAs.lastIndexOf('}');
                    JSONObject obj = JSONObject.parseObject(resultAs.substring(start, end + 1));
                    titleContent = obj.getString("result");
                    safety.put(typeName + "TitleContent", titleContent);
                } 
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
        safety.put(typeName + "Exists", typeExists);
        return literatureCount;
    }


    private void classifyLiterature(PaperIndex content, List<MongoLiterature> metaLiterat, List<MongoLiterature> rctLiterat, List<MongoLiterature> observeLiterat, List<MongoLiterature> economyLiterat, List<MongoLiterature> otherLiterat) {
        MongoLiterature mongoLiterature = fineScreenFeign.paper(content.getId());
//        MongoLiterature mongoLiterature = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("_id").is(content.getId())), MongoLiterature.class, "mongo_literature_" + Math.abs(content.getId().hashCode()) % 10);
        if (Objects.nonNull(mongoLiterature)) {
                // 过滤掉仅是经济性类型文献
                if (mongoLiterature.getLastNewType().size() == 1 && mongoLiterature.getLastNewType().contains(12)) {
                    economyLiterat.add(mongoLiterature);
                    return;
                }
                if (mongoLiterature.getLastNewType().contains(0)) {
                    metaLiterat.add(mongoLiterature);
                    if (mongoLiterature.getLastNewType().contains(12)) {
                        economyLiterat.add(mongoLiterature);
                    }
                    return;
                }
                // rct + 临床试验 
                if (mongoLiterature.getLastNewType().contains(2) || mongoLiterature.getType().contains(7)) {
                    rctLiterat.add(mongoLiterature);
                    if (mongoLiterature.getLastNewType().contains(12)) {
                        economyLiterat.add(mongoLiterature);
                    }
                    return;
                }

                if (mongoLiterature.getLastNewType().contains(4)
                        || mongoLiterature.getLastNewType().contains(3)
                        || mongoLiterature.getLastNewType().contains(5)
                        || mongoLiterature.getLastNewType().contains(6)
                        || mongoLiterature.getLastNewType().contains(7)) {
                    observeLiterat.add(mongoLiterature);
                    if (mongoLiterature.getLastNewType().contains(12)) {
                        economyLiterat.add(mongoLiterature);
                    }
                    return;
                }

                if (mongoLiterature.getLastNewType().contains(12)) {
                    economyLiterat.add(mongoLiterature);
                }
                otherLiterat.add(mongoLiterature);
        }
    }

    private List<String> handleWipeDiseaseToSynonym(List<Disease> diseases) {
        Set<String> set = new HashSet<>();
        for (Disease disease : diseases) {
            String word = disease.getWord();
            if (StrUtil.isNotBlank(word)){
                set.add(word.toLowerCase());
                set.add(disease.getWord());
            }
            
            String enWord = disease.getEnWord();
            if (StrUtil.isNotBlank(enWord)){
                set.add(enWord.toLowerCase());
                set.add(enWord);
            }

            List<WordStatus> enSynonym = disease.getEnSynonym();
            if (CollUtil.isNotEmpty(enSynonym)){
                for (WordStatus wordStatus : enSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked) {
                        set.add(name);
                    }
                }
            }

            String zhWord = disease.getZhWord();
            if (StrUtil.isNotBlank(zhWord)){
                set.add(zhWord.toLowerCase());
                set.add(zhWord);
            }

            List<WordStatus> zhSynonym = disease.getZhSynonym();
            if (CollUtil.isNotEmpty(zhSynonym)){
                for (WordStatus wordStatus : zhSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked) {
                        set.add(name);
                    }
                }
            }

            List<WordStatus> otherSynonym = disease.getOtherSynonym();
            if (CollUtil.isNotEmpty(otherSynonym)){
                for (WordStatus wordStatus : otherSynonym) {
                    String name = wordStatus.getName();
                    Boolean checked = wordStatus.getChecked();
                    if (checked) {
                        set.add(name);
                    }
                }
            }
        }
        return new ArrayList<>(set);

    }
    
    private List<String> handleDiseaseToSynonym(List<Disease> diseases) {
        Set<String> set = new HashSet<>();
        for (Disease disease : diseases) {
            Integer status = disease.getStatus();
            if (status == 1){
                set.add(disease.getWord().toLowerCase());
                set.add(disease.getWord());

                String enWord = disease.getEnWord();
                if (StrUtil.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

                List<WordStatus> enSynonym = disease.getEnSynonym();
                if (CollUtil.isNotEmpty(enSynonym)){
                    for (WordStatus wordStatus : enSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                String zhWord = disease.getZhWord();
                if (StrUtil.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

                List<WordStatus> zhSynonym = disease.getZhSynonym();
                if (CollUtil.isNotEmpty(zhSynonym)){
                    for (WordStatus wordStatus : zhSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                List<WordStatus> otherSynonym = disease.getOtherSynonym();
                if (CollUtil.isNotEmpty(otherSynonym)){
                    for (WordStatus wordStatus : otherSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                //补充同义词
                String expandSynonym = disease.getExpandSynonym();
                if (StrUtil.isNotBlank(expandSynonym)) {
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StrUtil.isNotBlank(txt)) {
                            set.add(txt.toLowerCase());
                            set.add(txt);
                        }
                    }
                }
            }
        }
        return new ArrayList<>(set);
        
    }

    private List<String> handleDrugToSynonym(List<Drug> drugs) {
        Set<String> set = new HashSet<>();
        for (Drug drug : drugs) {
            Integer status = drug.getStatus();
            if (status == 1){
                set.add(drug.getWord().toLowerCase());
                set.add(drug.getWord());
                
                String enWord = drug.getEnWord();
                if (StrUtil.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

                List<WordStatus> enSynonym = drug.getEnSynonym();
                if (CollUtil.isNotEmpty(enSynonym)){
                    for (WordStatus wordStatus : enSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                String zhWord = drug.getZhWord();
                if (StrUtil.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

                List<WordStatus> zhSynonym = drug.getZhSynonym();
                if (CollUtil.isNotEmpty(zhSynonym)){
                    for (WordStatus wordStatus : zhSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                List<WordStatus> otherSynonym = drug.getOtherSynonym();
                if (CollUtil.isNotEmpty(otherSynonym)){
                    for (WordStatus wordStatus : otherSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }
                
                //补充同义词
                String expandSynonym = drug.getExpandSynonym();
                if (StrUtil.isNotBlank(expandSynonym)) {
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StrUtil.isNotBlank(txt)) {
                            set.add(txt.toLowerCase());
                            set.add(txt);
                        }
                    }
                }
            }
        }

        if (CollUtil.isNotEmpty(set)) {
            set = set.stream().filter(s -> {
                boolean english = s.length() == s.getBytes().length;
                return !english || s.length() >= 2;
            }).collect(Collectors.toSet());
        }
       
        return new ArrayList<>(set);
        
    }


    private String handleDataToLiteratureQuestion(List<Drug> drugs, List<Disease> diseases) {
        StringBuilder drugAndNotStr = new StringBuilder();
        StringBuilder diseaseAndNotStr = new StringBuilder();

        if (CollUtil.isNotEmpty(drugs)) {
            boolean isRejected = false;
            for (Drug drug : drugs) {
                if (drug.getStatus() == 1) {
                    drugAndNotStr.append(drug.getWord());
                    if (isRejected) {
                        isRejected = false;
                    }
                }
                if (drug.getStatus() == 2) {
                    drugAndNotStr.append("联合");
                }
                if (drug.getStatus() == 3) {
                    isRejected = true;
                }
            }
        }
        String drug = drugAndNotStr.toString();
        drugAndNotStr.append("治疗");

        if (CollUtil.isNotEmpty(diseases)) {
            boolean isRejected = false;
            for (Disease disease : diseases) {
                if (disease.getStatus() == 1) {
                    if (!isRejected) {
                        diseaseAndNotStr.append(disease.getWord());
                    } else {
                        isRejected = false;
                        diseaseAndNotStr.append(disease.getWord());
                    }
                }
                if (disease.getStatus() == 2) {
                    diseaseAndNotStr.append("合并");
                }
                if (disease.getStatus() == 3) {
                    isRejected = true;
                }
            }
        }


        String question = drugAndNotStr.append(diseaseAndNotStr).toString();
        if (question.startsWith("治疗")) {
            question = question.substring(question.indexOf("治疗") + 2);
        }
//        question = "假如你是一名医学领域专家，请查找几篇相关度较高的关于" + question + "相关的临床指南/共识，需要同时包含其中的病和药。";
        question = "请查找关于" + question + "相关度较高的文献，但是注意，需要尽量同时的包含提供的药与病。\n" +
                "提供的药：{"+ drug + "}，\n" +
                "提供的病：{"+ diseaseAndNotStr + "}";;

        return question;
    }

    private String handleDataToQuestion(List<Drug> drugs, List<Disease> diseases) {
        StringBuilder drugAndNotStr = new StringBuilder();
        StringBuilder diseaseAndNotStr = new StringBuilder();

        if (CollUtil.isNotEmpty(drugs)) {
            boolean isRejected = false;
            for (Drug drug : drugs) {
                if (drug.getStatus() == 1) {
                    drugAndNotStr.append(drug.getWord());
                    if (isRejected) {
                        isRejected = false;
                    }
                }
                if (drug.getStatus() == 2) {
                    drugAndNotStr.append("联合");
                }
                if (drug.getStatus() == 3) {
                    isRejected = true;
                }
            }
        }

        drugAndNotStr.append("治疗");
                
        if (CollUtil.isNotEmpty(diseases)) {
            boolean isRejected = false;
            for (Disease disease : diseases) {
                if (disease.getStatus() == 1) {
                    if (!isRejected) {
                        diseaseAndNotStr.append(disease.getWord());
                    } else {
                        isRejected = false;
                        diseaseAndNotStr.append(disease.getWord());
                    }
                }
                if (disease.getStatus() == 2) {
                    diseaseAndNotStr.append("合并");
                }
                if (disease.getStatus() == 3) {
                    isRejected = true;
                }
            }
        }


        String question = drugAndNotStr.append(diseaseAndNotStr).toString();
        if (question.startsWith("治疗")) {
            question = question.substring(question.indexOf("治疗") + 2);
        }
//        question = "假如你是一名医学领域专家，请查找几篇相关度较高的关于" + question + "相关的临床指南/共识，需要同时包含其中的病和药。";
//        question = "关于" + question + "的临床指南/共识。";

        return question;
    }

    public static boolean checkFullWordContain(String text, List<String> synonym) {
        boolean match = false;

        text = text.replaceAll("\n", "");
        boolean chinese = text.matches(".*[\u4e00-\u9fff].*");
        boolean english = text.matches(".*[a-zA-Z].*");
        if (english) {
            for (String word : synonym) {
                // 对特殊字符进行转义
                word = word.replaceAll("([+\\-\\[\\]{}()*^$.|?])", "\\\\$1");
                // 使用正则表达式来匹配完整的单词
                String pattern = "\\b" + word + "\\b";
                Pattern compiledPattern = Pattern.compile(pattern, Pattern.CASE_INSENSITIVE);
                Matcher matcher = compiledPattern.matcher(text);
                if (matcher.find()) {
                    match = true;
                    break;
                }
//                if (text.matches(".*" + pattern + ".*")) {
//                    match = true;
//                    break;
//                }
            }
            if (chinese) {
                match = StrUtil.containsAnyIgnoreCase(text, synonym.toArray(new String[0]));
            }
        } else {
            match = StrUtil.containsAnyIgnoreCase(text, synonym.toArray(new String[0]));
        }        
        return match;
    }
}
