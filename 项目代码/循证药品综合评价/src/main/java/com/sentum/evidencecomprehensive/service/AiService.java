package com.sentum.evidencecomprehensive.service;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.google.common.reflect.TypeToken;
import com.google.gson.Gson;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.es.DrugAndIndicationIndex;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.feign.MedicineFeign;
import com.sentum.evidencecomprehensive.utils.operateyl.AIRequestUtils;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Service;

import java.lang.reflect.Type;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/7/30
 */
@Slf4j
@Service
public class AiService {

    @Autowired
    MongoTemplate mongoTemplate;
    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private MedicineFeign medicineFeign;
    @Autowired
    private RetrievalService retrievalService;
    
    /**
     * 基于输入词 给出其解构之后的词
     */
    public void deconWords(Condition condition) {
        List<Disease> diseases = condition.getDiseases();
        ExecutorService executorService;
        if (CollUtil.isNotEmpty(diseases)) {
            executorService = Executors.newFixedThreadPool(diseases.size());
        } else {
            executorService = Executors.newFixedThreadPool(1);
        }

        Map<Integer, AtomicReference<List<String>>> map = new HashMap<>(16);

        List<CompletableFuture<Void>> allCompletableFuture = new ArrayList<>();
        for (int i = 0; i < diseases.size(); i++) {
            Disease disease = diseases.get(i);
            String word = disease.getWord();

            if (StrUtil.isNotBlank(word)) {
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
                            "5、注意疾病名称中的英文简称\n" +
                            "对于带有英文缩写的疾病名称，例如“费城染色体阳性的急性淋巴细胞白血病（ph+all）”，需注意：定语去掉后，核心疾病名称不应带上缩写。例如，仅保留“急性淋巴细胞白血病”。\n" +
                            "应用逻辑的顺序：\n" +
                            "从修饰程度、状态到性质依次清理。\n" +
                            "每一步清理后，检查是否仍保留疾病核心含义，不影响理解。" +
                            "输出格式要求：\n" +
                            "   {\n" +
                            "     \"disease\": \"保留原始输入术语\", \n" +
                            "     \"deconstruction\": [\"其中一个疾病名称\", \"其中一个疾病名称\", ···]（请不要返回多于的解释）\n" +
                            "   }\n" +
                            "\n";
                    long startTime = System.currentTimeMillis();

                    int retryCount = 0;
                    int maxRetryCount = 6;

                    while (retryCount < maxRetryCount) {
                        try {
                            String deconWordResult = AIRequestUtils.modelStudio(deconPrompt, Constants.QWEN3_235B_A22B_INSTRUCT_2507);

                            List<String> deconWords = new ArrayList<>();
                            if (StrUtil.isNotBlank(deconWordResult)) {
                                int start = deconWordResult.indexOf('{');
                                int end = deconWordResult.lastIndexOf('}');
                                Gson gson = new Gson();
                                Type jsonObject = new TypeToken<JSONObject>(){}.getType();
                                JSONObject aiResult = gson.fromJson(deconWordResult.substring(start, end + 1), jsonObject);
                                String oriDisease = aiResult.getString("disease");
                                JSONArray diseaseDeconTerms = aiResult.getJSONArray("deconstruction");
                                diseaseDeconTerms.forEach(o -> {
                                    String decon = JSON.parseObject(JSON.toJSONString(o), String.class);
                                    if (StrUtil.isNotBlank(decon)) {
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

        if (CollUtil.isNotEmpty(map)) {
            for (Map.Entry<Integer, AtomicReference<List<String>>> entry : map.entrySet()) {
                Integer key = entry.getKey();
                AtomicReference<List<String>> value = entry.getValue();

                Disease disease = diseases.get(key);
                disease.setDeconsWords(value.get());

                Map<String, Set<String>> synonymMap = new HashMap<>();
                for (String word : value.get()) {
                    Set<String> deconsSynonym = getSynonymByKeyword(word, retrievalService, elasticsearchRestTemplate);
                    synonymMap.put(word, deconsSynonym);
                }
                disease.setSynonymMap(synonymMap);
            }
        }
        condition.setDiseases(diseases);
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
            log.error(e.getMessage(), e);
        }
        return set;
    }

    private static void searchCommodityName(String keyword, Set<String> set, String enWord, String zhWord, ElasticsearchRestTemplate elasticsearchRestTemplate) {
        String drugName = keyword.toLowerCase();
        if (StrUtil.isNotBlank(drugName)) {
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
        if (CollUtil.isNotEmpty(searchHits)) {
            searchHits.stream().map(SearchHit::getContent).forEach(drugAndIndicationIndex -> {
                String commodityNameEn = drugAndIndicationIndex.getCommodityNameEn();
                String commodityNameZh = drugAndIndicationIndex.getCommodityNameZh();
                if (StrUtil.isNotBlank(commodityNameZh)) {
                    set.add(commodityNameZh);
                }
                if (StrUtil.isNotBlank(commodityNameEn)) {
                    set.add(commodityNameEn);
                }
            });
        }
    }
}
