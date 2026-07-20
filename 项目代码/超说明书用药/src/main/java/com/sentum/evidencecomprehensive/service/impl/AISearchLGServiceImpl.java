package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.google.common.reflect.TypeToken;
import com.google.gson.Gson;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.bo.es.DrugAndIndicationIndex;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.WordStatus;
import com.sentum.evidencecomprehensive.service.AISearchLGService;
import com.sentum.evidencecomprehensive.service.RetrievalService;
import com.sentum.evidencecomprehensive.utils.operateyl.AIRequestUtils;
import com.sentum.evidencecomprehensive.utils.QueryUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.collections.MapUtils;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Service;

import java.lang.reflect.Type;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;


/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2024/10/28
 */
@Slf4j
@Service
public class AISearchLGServiceImpl implements AISearchLGService {

    private static final Logger LOG = LoggerFactory.getLogger(QueryUtils.class);
    
    @Autowired
    MongoTemplate mongoTemplate;
    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private RetrievalService retrievalService;


    @Override
    public JSONObject searchLG(String questionId) {
        return null;
    }

    @Override
    public List<JSONObject> searchCB(List<String> needSearchDrugNames, List<String> diseases) {
        return Collections.emptyList();
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
                        String searchDrugEachResult = AIRequestUtils.modelStudio(splitPrompt, Constants.QWEN3_MAX_2025_09_23_60_PRM);
                        String splitDisease = "";
                        if (StringUtils.isNotBlank(searchDrugEachResult)) {
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
        
        if (MapUtils.isNotEmpty(map)) {
            List<AtomicReference<String>> atomicListBySorted = map.entrySet().stream().sorted(Comparator.comparingInt(Map.Entry::getKey)).map(Map.Entry::getValue).collect(Collectors.toList());
            for (AtomicReference<String> atomicReference : atomicListBySorted) {
                resultSplitDisease.add(atomicReference.get());
            }
        }
        return resultSplitDisease;
    }

    /**
     * 基于输入词 给出扩展词
     */
    public void expandedWords(Condition condition) {
        List<Disease> diseases = condition.getDiseases();
        ExecutorService executorService = Executors.newFixedThreadPool(diseases.size());

        Map<Integer, AtomicReference<List<String>>> map = new HashMap<>(16);

        List<CompletableFuture<Void>> allCompletableFuture = new ArrayList<>();
        for (int i = 0; i < diseases.size(); i++) {
            Disease disease = diseases.get(i);
            String word = disease.getWord();

            if (StringUtils.isNotBlank(word)) {
                int number = i;
                allCompletableFuture.add(CompletableFuture.runAsync(() -> {
                    String expandedPrompt = "作为医学信息处理助手，请执行以下任务：\n" +
                            "1. 解析用户输入的疾病名称{"+ word +"}，生成5种不同形式的改写关键词，包括同义词、学术术语和相关医学命名\n" +
                            "2. 基于原始疾病名称，列举3-5个细分层级扩展疾病实体，要求：\n " +
                            "   - 严格保持疾病核心概念\n " +
                            "   - 包含具体亚型/并发症/相关疾病\n " +
                            "   - 排除无关的疾病类别\n" +
                            "3. 输出严格JSON格式的结果，包含：\n " +
                            "   - disease_expanded_terms数组（每个元素包含中文关键词、英文关键词、英文简称三个字段）\n " +
                            "   - 所有扩展术语必须与原始疾病存在医学实体关联\n" +
                            "       示例输入：糖尿病\n" +
                            "       示例输出：{\"disease_expanded_terms\": " +
                            "                   [{" +
                            "                      \"ch_term\":\"糖尿病\"," +
                            "                      \"en_term\":\"Diabetes Mellitus\"," +
                            "                      \"en_abbr\":\"DM\"" +
                            "                   },\n " +
                            "                   {" +
                            "                      \"ch_term\":\"1型糖尿病\"," +
                            "                      \"en_term\":\"Type 1 Diabetes\"," +
                            "                      \"en_abbr\":\"T1DM\"" +
                            "                   },\n " +
                            "                   {" +
                            "                      \"ch_term\":\"糖尿病并发症\"," +
                            "                      \"en_term\":\"Diabetic Complications\"," +
                            "                      \"en_abbr\":\"DC\"" +
                            "                   },\n " +
                            "                   {" +
                            "                      \"ch_term\":\"糖耐量异常\"," +
                            "                      \"en_term\":\"Impaired Glucose Tolerance\"," +
                            "                      \"en_abbr\":\"IGT\"" +
                            "                   },\n " +
                            "                   {" +
                            "                      \"ch_term\":\"糖尿病肾病\"," +
                            "                      \"en_term\":\"Diabetic Nephropathy\"," +
                            "                      \"en_abbr\":\"DN\"" +
                            "                   }]\n}" +
                            "4. 请只返回JSON格式数据体。";
                    long startTime = System.currentTimeMillis();

                    int retryCount = 0;
                    int maxRetryCount = 6;

                    while (retryCount < maxRetryCount) {
                        try {
                            String expandedWordResult = AIRequestUtils.modelStudio(expandedPrompt, Constants.QWEN3_MAX_2025_09_23_60_PRM);
                            List<String> extendedWords = new ArrayList<>();
                            if (StringUtils.isNotBlank(expandedWordResult)) {
                                int start = expandedWordResult.indexOf('{');
                                int end = expandedWordResult.lastIndexOf('}');
                                Gson gson = new Gson();
                                Type jsonObject = new TypeToken<JSONObject>(){}.getType();
                                JSONObject aiResult = gson.fromJson(expandedWordResult.substring(start, end + 1), jsonObject);
                                JSONArray diseaseExpandedTerms = aiResult.getJSONArray("disease_expanded_terms");
                                diseaseExpandedTerms.forEach(o -> {
                                    JSONObject obj = JSON.parseObject(JSON.toJSONString(o), JSONObject.class);
                                    String chTerm = obj.getString("ch_term");
                                    if (StringUtils.isNotBlank(chTerm)) extendedWords.add(chTerm);
                                    String enTerm = obj.getString("en_term");
                                    if (StringUtils.isNotBlank(enTerm)) extendedWords.add(enTerm);
                                    String enAbbr = obj.getString("en_abbr");
                                    if (StringUtils.isNotBlank(enAbbr)) extendedWords.add(enAbbr);
                                });
                            }
                            map.put(number, new AtomicReference<>(extendedWords));
                            log.info("第 {} 个疾病分析扩展词时间为{}", number, System.currentTimeMillis() - startTime);
                            return;
                        } catch (Exception e) {
                            log.error("扩展词发生错误{}", e.getMessage(), e);
                        }
                        retryCount++;
                    }
                }, executorService));
            }        
        }

        allCompletableFuture.forEach(CompletableFuture::join);
        executorService.shutdown();
        while (!executorService.isTerminated()) {
            try {
                Thread.sleep(1);
            } catch (InterruptedException e) {
                log.error(e.getMessage(), e);
            }
        }

        if (MapUtils.isNotEmpty(map)) {
            for (Map.Entry<Integer, AtomicReference<List<String>>> entry : map.entrySet()) {
                Integer key = entry.getKey();
                AtomicReference<List<String>> value = entry.getValue();

                Disease disease = diseases.get(key);
                disease.setExpandedWords(value.get());
            }
        }
        
        condition.setDiseases(diseases);
    }


    /**
     * 基于输入词 给出其解构之后的词
     */
    public void deconWords(Condition condition) {
        List<Disease> diseases = condition.getDiseases();
        ExecutorService executorService = Executors.newFixedThreadPool(diseases.size());

        Map<Integer, AtomicReference<List<String>>> map = new HashMap<>(16);

        List<CompletableFuture<Void>> allCompletableFuture = new ArrayList<>();
        for (int i = 0; i < diseases.size(); i++) {
            Disease disease = diseases.get(i);
            String word = disease.getWord();

            if (StringUtils.isNotBlank(word)) {
                int number = i;
                allCompletableFuture.add(CompletableFuture.runAsync(() -> {
                    String deconPrompt = "请根据以下疾病定语清洗提炼逻辑，将疾病{"+ word +"}进行解构，并输出每一步相应的疾病名称\n" +
                            "疾病定语清洗提炼逻辑：\n" +
                            "1、优先去掉程度描述的词语\n" +
                            "去掉描述疾病严重程度的词汇，例如“轻度”“中度”“重度”“极重度”等。这些词通常是对疾病状态的修饰，不属于疾病的核心定义。\n" +
                            "2、去掉疾病状态或性质相关的词语\n" +
                            "去掉描述疾病状态的词汇，例如“活动性”“急性”“慢性”“复发性”等。这些词是对疾病时间或状态的描述，去掉后仍保留疾病的核心名称。\n" +
                            "3、去掉形容疾病特殊性质的词语\n" +
                            "去掉描述疾病性质或特定类型的词汇，例如“溃疡性”“过敏性”“感染性”等。这些词是对疾病特征的修饰，去掉后提炼出更基础的疾病名称。\n" +
                            "4、保留疾病核心名称\n" +
                            "最后保留核心疾病名称，例如“结肠炎”“肺炎”“肝炎”等，提炼出疾病的最简形式。\n" +
                            "应用逻辑的顺序：\n" +
                            "从修饰程度、状态到性质依次清理。\n" +
                            "每一步清理后，检查是否仍保留疾病核心含义，不影响理解。" +
                            "输出格式要求：\n" +
                            "   {\n" +
                            "     \"disease\": \"保留原始输入术语\", \n" +
                            "     \"deconstruction\": [\"其中一个疾病名称\", \"其中一个疾病名称\", ···]（集合元素不要重复，请不要返回多于的解释）\n" +
                            "   }\n" +
                            "\n";
                    long startTime = System.currentTimeMillis();

                    int retryCount = 0;
                    int maxRetryCount = 6;

                    while (retryCount < maxRetryCount) {
                        try {
                            String deconWordResult = AIRequestUtils.modelStudio(deconPrompt, Constants.QWEN3_MAX_2025_09_23_60_PRM);
                            List<String> deconWords = new ArrayList<>();
                            if (StringUtils.isNotBlank(deconWordResult)) {
                                int start = deconWordResult.indexOf('{');
                                int end = deconWordResult.lastIndexOf('}');
                                Gson gson = new Gson();
                                Type jsonObject = new TypeToken<JSONObject>(){}.getType();
                                JSONObject aiResult = gson.fromJson(deconWordResult.substring(start, end + 1), jsonObject);
                                JSONArray diseaseDeconTerms = aiResult.getJSONArray("deconstruction");
                                String oriDisease = aiResult.getString("disease");
                                diseaseDeconTerms.forEach(o -> {
                                    String decon = JSON.parseObject(JSON.toJSONString(o), String.class);
                                    if (StringUtils.isNotBlank(decon)) { 
                                        if (word.equals(decon) || hasMoreThanTwoChineseChars(decon)) {
                                            decon = StrUtil.removePrefix(decon, "{");
                                            decon = StrUtil.removeSuffix(decon, "}");
                                            deconWords.add(decon);
                                        }
                                    }
                                });

                                deconWords.add(0, oriDisease);
                            }
                            map.put(number, new AtomicReference<>(deconWords));
                            log.info("第 {} 个疾病解构时间为{}", number, System.currentTimeMillis() - startTime);
                            return;
                        } catch (Exception e) {
                            log.error("解构词发生错误{}", e.getMessage(), e);
                        }
                        retryCount++;
                    }
                }, executorService));
            }           
        }

        allCompletableFuture.forEach(CompletableFuture::join);
        executorService.shutdown();
        while (!executorService.isTerminated()) {
            try {
                Thread.sleep(1);
            } catch (InterruptedException e) {
                log.error(e.getMessage(), e);
            }
        }

        if (MapUtils.isNotEmpty(map)) {
            // 创建线程池
            ExecutorService syExecutorService = Executors.newFixedThreadPool(5);

            try {
                for (Map.Entry<Integer, AtomicReference<List<String>>> entry : map.entrySet()) {
                    Integer key = entry.getKey();
                    AtomicReference<List<String>> value = entry.getValue();

                    Disease disease = diseases.get(key);
                    disease.setDeconsWords(value.get());

                    // 使用 ConcurrentHashMap 保证线程安全
                    Map<String, Set<String>> synonymMap = new ConcurrentHashMap<>();

                    // 收集所有异步任务，带异常处理
                    List<CompletableFuture<Void>> futures = value.get().stream()
                            .map(word -> CompletableFuture.runAsync(() -> {
                                try {
                                    Set<String> deconsSynonym = new HashSet<>();
                                    if (word.equals(disease.getWord())) {
                                        extracted(deconsSynonym, disease);
                                    } else {
                                        deconsSynonym = getSynonymByKeyword(word, retrievalService, elasticsearchRestTemplate);
                                    }
                                    synonymMap.put(word, deconsSynonym);
                                } catch (Exception e) {
                                    // 记录日志，但不中断整个流程
                                    log.error("处理词汇 {} 的同义词时发生异常", word, e);
                                    synonymMap.put(word, new HashSet<>());
                                }
                            }, syExecutorService))
                            .collect(Collectors.toList());

                    // 等待所有任务完成，设置超时时间
                    try {
                        CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
                                .get(30, TimeUnit.SECONDS); // 设置30秒超时
                    } catch (TimeoutException e) {
                        log.warn("处理疾病 {} 的同义词映射超时", key);
                    }

                    disease.setSynonymMap(synonymMap);
                }
            } catch (Exception e) {
                log.error("多线程处理同义词映射时发生异常", e);
            } finally {
                // 关闭线程池
                shutdownExecutorService(syExecutorService);
            }
        }
    }

    // 辅助方法：安全关闭线程池
    private void shutdownExecutorService(ExecutorService executorService) {
        executorService.shutdown();
        try {
            if (!executorService.awaitTermination(60, TimeUnit.SECONDS)) {
                executorService.shutdownNow();
                if (!executorService.awaitTermination(60, TimeUnit.SECONDS)) {
                    log.warn("线程池未能正常关闭");
                }
            }
        } catch (InterruptedException e) {
            executorService.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    private static void extracted(Set<String> deconsSynonym, Disease disease) {
        deconsSynonym.add(disease.getWord());

        String enWord = disease.getEnWord();
        if (StringUtils.isNotBlank(enWord)){
            deconsSynonym.add(enWord.toLowerCase());
            deconsSynonym.add(enWord);
        }

        String zhWord = disease.getZhWord();
        if (StringUtils.isNotBlank(zhWord)){
            deconsSynonym.add(zhWord.toLowerCase());
            deconsSynonym.add(zhWord);
        }

        List<WordStatus> enSynonym = disease.getEnSynonym();
        if (CollectionUtils.isNotEmpty(enSynonym)){
            for (WordStatus wordStatus : enSynonym) {
                String name = wordStatus.getName();
                Boolean checked = wordStatus.getChecked();
                if (checked) {
                    deconsSynonym.add(name.toLowerCase());
                    deconsSynonym.add(name);
                }
            }
        }

        List<WordStatus> zhSynonym = disease.getZhSynonym();
        if (CollectionUtils.isNotEmpty(zhSynonym)){
            for (WordStatus wordStatus : zhSynonym) {
                String name = wordStatus.getName();
                Boolean checked = wordStatus.getChecked();
                if (checked) {
                    deconsSynonym.add(name.toLowerCase());
                    deconsSynonym.add(name);
                }
            }
        }

        List<WordStatus> otherSynonym = disease.getOtherSynonym();
        if (CollectionUtils.isNotEmpty(otherSynonym)){
            for (WordStatus wordStatus : otherSynonym) {
                String name = wordStatus.getName();
                Boolean checked = wordStatus.getChecked();
                if (checked) {
                    deconsSynonym.add(name.toLowerCase());
                    deconsSynonym.add(name);
                }
            }
        }

        String expandSynonym = disease.getExpandSynonym();
        if (StringUtils.isNotBlank(expandSynonym)) {
            expandSynonym = expandSynonym.replaceAll("；", ";");
            String[] split = expandSynonym.split(";");
            for (String txt : split) {
                if(StringUtils.isNotBlank(txt)) {
                    deconsSynonym.add(txt.toLowerCase());
                    deconsSynonym.add(txt);
                }
            }
        }
    }

    private static boolean hasMoreThanTwoChineseChars(String decon) {
        if (decon == null || decon.isEmpty()) {
            return false;
        }

        int chineseCount = 0;
        int englishCount = 0;
        boolean hasChinese = false;
        boolean hasEnglish = false;

        for (char c : decon.toCharArray()) {
            // 如果是中文字符
            if (c >= '\u4e00' && c <= '\u9fff') {
                chineseCount++;
                hasChinese = true;
                // 如果之前有英文字符，则中英混合
                if (hasEnglish) {
                    return true;
                }
                // 中文字符数超过2
                if (chineseCount > 1) {
                    return true;
                }
            }
            // 如果是英文字母
            else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
                englishCount++;
                hasEnglish = true;
                // 如果之前有中文字符，则混合
                if (hasChinese) {
                    return true;
                }
                // 英文字符数超过2
                if (englishCount > 1) {
                    return true;
                }
            }
        }

        // 遍历完成仍未触发true时返回false
        return false;
    }

    /**
     * 获取同义词
     */
    private static Set<String> getSynonymByKeyword(String keyword, RetrievalService retrievalService, ElasticsearchRestTemplate elasticsearchRestTemplate) {
        Set<String> set = new HashSet<>();

        String enWord = "";
        String zhWord = "";

        JSONObject synonym = retrievalService.synonym(keyword, 1, 1);

        JSONObject zhSynonym = synonym.getJSONObject("zh");
        set.add(zhSynonym.getString("name"));
        set.addAll(zhSynonym.getJSONArray("synonym").stream().map(String::valueOf).collect(Collectors.toSet()));
        zhWord = zhSynonym.getString("name");

        JSONObject enSynonym = synonym.getJSONObject("en");
        set.add(enSynonym.getString("name"));
        set.addAll(enSynonym.getJSONArray("synonym").stream().map(String::valueOf).collect(Collectors.toSet()));
        enWord = zhSynonym.getString("name");

        JSONObject otherSynonym = synonym.getJSONObject("other");
        set.add(otherSynonym.getString("name"));
        set.addAll(otherSynonym.getJSONArray("synonym").stream().map(String::valueOf).collect(Collectors.toSet()));
        set = set.stream().filter(StrUtil::isNotBlank).collect(Collectors.toSet());

        try {
            searchCommodityName(keyword, set, enWord, zhWord, elasticsearchRestTemplate);
        } catch (Exception e) {
            LOG.error(e.getMessage(), e);
        }
        return set;
    }

    private static void searchCommodityName(String keyword, Set<String> set, String enWord, String zhWord, ElasticsearchRestTemplate elasticsearchRestTemplate) {
            String drugName = keyword.toLowerCase();
            if (StringUtils.isNotBlank(drugName)) {
                // 利用es 查询 中英文对应的翻译词
                BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
                boolQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", drugName));  // 药品名称
                boolQueryBuilder.should().add(QueryBuilders.termQuery("drugName.keyword", drugName)); // 同义词 五级中英文
                boolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", drugName));  // 商品名
                boolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", drugName));  // 商品名
                boolQueryBuilder.should().add(QueryBuilders.termQuery("drugZh.keyword", drugName));  // 药品中文
                boolQueryBuilder.should().add(QueryBuilders.termQuery("drugEn.keyword", drugName));  // 药品英文
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
                SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, DrugAndIndicationIndex.class);
                if (Objects.nonNull(drugAndIndicationIndexSearchHit)) {
                    DrugAndIndicationIndex drugInfo = drugAndIndicationIndexSearchHit.getContent();
                    List<String> zhDrugNames = drugInfo.getZhDrugNames();
                    List<String> enDrugNames = drugInfo.getEnDrugNames();
                    set.addAll(zhDrugNames.stream().filter(StrUtil::isNotBlank).collect(Collectors.toList()));
                    set.addAll(enDrugNames.stream().filter(StrUtil::isNotBlank).collect(Collectors.toList()));
                }
            }

            // 增加商品名作为检索条件 
            BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
            orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("zhDrugName.keyword", zhWord, enWord));  // 药品名称
            orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("drugName.keyword", zhWord, enWord)); // 同义词 五级中英文
            orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("commodityNameZh.keyword", zhWord, enWord));  // 商品名
            orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("commodityNameEn.keyword", zhWord, enWord));  // 商品名
            orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("drugZh.keyword", zhWord, enWord));  // 药品中文
            orBoolQueryBuilder.should().add(QueryBuilders.termsQuery("drugEn.keyword", zhWord, enWord));  // 药品英文
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(orBoolQueryBuilder);
            SearchHits<DrugAndIndicationIndex> searchZh = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
            List<SearchHit<DrugAndIndicationIndex>> searchHits = searchZh.getSearchHits();
            if (CollectionUtils.isNotEmpty(searchHits)) {
                searchHits.stream().map(SearchHit::getContent).forEach(drugAndIndicationIndex -> {
                    String commodityNameEn = drugAndIndicationIndex.getCommodityNameEn();
                    String commodityNameZh = drugAndIndicationIndex.getCommodityNameZh();
                    if (StringUtils.isNotBlank(commodityNameZh)) {
                        set.add(commodityNameZh);
                    }
                    if (StringUtils.isNotBlank(commodityNameEn)) {
                        set.add(commodityNameEn);
                    }
                });
            }
        }
        
 }
