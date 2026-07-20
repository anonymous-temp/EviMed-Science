package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.mongodb.client.result.DeleteResult;
import com.sentum.evidencecomprehensive.domain.es.InstructionIndex;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.domain.dto.WordStatus;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.domain.mongo.Instruction;
import com.sentum.evidencecomprehensive.domain.mongo.InstructionCollect;
import com.sentum.evidencecomprehensive.domain.vo.InstructionVo;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.feign.DrugFeign;
import com.sentum.evidencecomprehensive.service.InstructionService;
import com.sentum.evidencecomprehensive.utils.*;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.common.lucene.search.function.CombineFunction;
import org.elasticsearch.common.lucene.search.function.FunctionScoreQuery;
import org.elasticsearch.index.query.*;
import org.elasticsearch.index.query.functionscore.FunctionScoreQueryBuilder;
import org.elasticsearch.index.query.functionscore.ScriptScoreFunctionBuilder;
import org.elasticsearch.script.Script;
import org.elasticsearch.search.aggregations.Aggregation;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.elasticsearch.search.aggregations.bucket.terms.TermsAggregationBuilder;
import org.elasticsearch.search.fetch.subphase.highlight.HighlightBuilder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.mapping.IndexCoordinates;
import org.springframework.data.elasticsearch.core.query.*;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.function.ToIntFunction;
import java.util.stream.Collectors;

@Slf4j
@Service
public class InstructionServiceImpl implements InstructionService {
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private DrugFeign drugFeign;

    /**
     * 初始化说明书信息
     */
    public List<JSONObject> initInstructions(String id) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        BoolQueryBuilder instructionQuery = QueryUtils.createInstructionQuery(condition);

        BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
        BoolQueryBuilder nmpaSourceBoolQueryBuilder = new BoolQueryBuilder();
        List<String> list = Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药", "用药参考", "其它");
        nmpaSourceBoolQueryBuilder.must().add(QueryBuilders.termsQuery("source", list));
        // nmpa的只需 使用新说明书  剔除旧说明书
        nmpaSourceBoolQueryBuilder.must().add(QueryBuilders.matchPhraseQuery("medicineUsePdf", "true"));
        nmpaSourceBoolQueryBuilder.must().add(QueryBuilders.existsQuery("pdf_name"));
        nmpaSourceBoolQueryBuilder.must().add(QueryBuilders.termQuery("selected", 0));
        boolQueryBuilder.should().add(nmpaSourceBoolQueryBuilder);

        BoolQueryBuilder otherSourceBoolQueryBuilder = new BoolQueryBuilder();

        List<String> otherList = Arrays.asList("ema", "fda", "pmda");
        otherSourceBoolQueryBuilder.must().add(QueryBuilders.termsQuery("source", otherList));
        boolQueryBuilder.should().add(otherSourceBoolQueryBuilder);

        instructionQuery.must().add(boolQueryBuilder);
        
        
        // 指定需要返回的字段
//        String[] includeFields = { "revisionData", "enterpriseName", "indication", "medicineUsePdf", "pdf_name", "simpleGenericNames", "simpleTradeNames" };
        String[] includeFields = { "source" };
        String[] excludeFields = {}; // 如果有不需要的字段，可以在这里指定
        SourceFilter sourceFilter = new FetchSourceFilter(includeFields, excludeFields);
        
        // 使用 NativeSearchQueryBuilder 构建查询
        NativeSearchQueryBuilder nativeSearchQueryBuilder = new NativeSearchQueryBuilder()
                .withQuery(instructionQuery)
                .withSourceFilter(sourceFilter);
        
        TermsAggregationBuilder sourceAgg = AggregationBuilders.terms("source").field("source").size(20);
        TermsAggregationBuilder drugNameAgg = AggregationBuilders.terms("simpleGenericNames").field("simpleGenericNames.keyword").size(200);
        TermsAggregationBuilder manufacturersAgg = AggregationBuilders.terms("enterpriseName").field("enterpriseName.keyword").size(100);
        
//        String[] hitIncludeFields = { "revisionData", "enterpriseName", "indication", "medicineUsePdf", "pdf_name", "simpleGenericNames", "simpleTradeNames" };
//        TopHitsAggregationBuilder topHitsAgg = AggregationBuilders.topHits("top_hits")
//                .size(100).fetchSource(hitIncludeFields, excludeFields);
        sourceAgg.subAggregation(drugNameAgg);
        drugNameAgg.subAggregation(manufacturersAgg);
//        manufacturersAgg.subAggregation(topHitsAgg);
        nativeSearchQueryBuilder.addAggregation(sourceAgg);
        
        SearchHits<InstructionIndex> search = elasticsearchRestTemplate.search(nativeSearchQueryBuilder.build(), InstructionIndex.class, IndexCoordinates.of("instruction_data_index", "instructions_use_index"));
        Aggregations aggregations = search.getAggregations();

//        List<String> list = Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药", "用药参考", "用药助手_old");
        List<String> oneLevelList = new ArrayList<>();
        
        Map<String, List<String>> oneLevelMap = new LinkedHashMap<>();
        oneLevelMap.put("nmpa", new ArrayList<>());
        oneLevelMap.put("fda", new ArrayList<>());
        oneLevelMap.put("ema", new ArrayList<>());
        oneLevelMap.put("pmda", new ArrayList<>());
        Map<String, List<String>> twoLevelMap = new LinkedHashMap<>();
        Map<String, List<String>> threeLevelMap = new LinkedHashMap<>();

        if (aggregations != null){
            Aggregation sourceAggregation = aggregations.get("source");
            List<? extends Terms.Bucket> sourceBuckets = ((ParsedTerms) sourceAggregation).getBuckets();
            for (Terms.Bucket sourceBucket : sourceBuckets) {
                String sourceKey = sourceBucket.getKey().toString();
                if (list.contains(sourceKey)) {
                    sourceKey = "nmpa";
                }
                Aggregation simpleGenericNamesAggregation = sourceBucket.getAggregations().get("simpleGenericNames");
                List<? extends Terms.Bucket> simpleGenericNamesBuckets = ((ParsedTerms) simpleGenericNamesAggregation).getBuckets();
                List<String> simpleGenericNamesList = new ArrayList<>(); // 收集所有同一来源下的说明书名称
                for (Terms.Bucket simpleGenericNamesBucket : simpleGenericNamesBuckets) {
                    String simpleGenericNamesKey = simpleGenericNamesBucket.getKey().toString();
                    String twoLevelValue = sourceKey + "-" + simpleGenericNamesKey;
                    simpleGenericNamesList.add(twoLevelValue);

                    Aggregation enterpriseNameAggregation = simpleGenericNamesBucket.getAggregations().get("enterpriseName");
                    List<? extends Terms.Bucket> enterpriseNameBuckets = ((ParsedTerms) enterpriseNameAggregation).getBuckets();
                    List<String> enterpriseNameList = new ArrayList<>(); // 收集所有同一说明书名称下的厂家
                    for (Terms.Bucket enterpriseNameBucket : enterpriseNameBuckets) {
                        String enterpriseNameKey = enterpriseNameBucket.getKey().toString();

                        String threeLevelValue = twoLevelValue + "-" + enterpriseNameKey;
//                        // 具体的结合到厂家的数据
//                        TopHits topHits = (TopHits)enterpriseNameBucket.getAggregations().get("top_hits");
//                        org.elasticsearch.search.SearchHit[] hits = topHits.getHits().getHits();
//                        
//                        // 将数据转为json存储
                        List<String> contentJson = new ArrayList<>();
//                        for (org.elasticsearch.search.SearchHit hit : hits) {
//                            Map<String, Object> sourceAsMap = hit.getSourceAsMap();
//                            contentJson.add(JSON.toJSONString(sourceAsMap));
//                        }
                        
                        if (CollUtil.isNotEmpty(threeLevelMap.get(enterpriseNameKey))) {
                            threeLevelMap.get(enterpriseNameKey).addAll(contentJson);
                        } else {
                            threeLevelMap.put(enterpriseNameKey, contentJson);
                        }
                        
                        enterpriseNameList.add(threeLevelValue);
                    }
                    
                    if (CollUtil.isNotEmpty(twoLevelMap.get(simpleGenericNamesKey))) {
                        twoLevelMap.get(simpleGenericNamesKey).addAll(enterpriseNameList);
                    } else {
                        twoLevelMap.put(simpleGenericNamesKey, enterpriseNameList);
                    }
                }
                
                if (CollUtil.isNotEmpty(oneLevelMap.get(sourceKey))) {
                    oneLevelMap.get(sourceKey).addAll(simpleGenericNamesList);
                } else {
                    oneLevelMap.put(sourceKey, simpleGenericNamesList);
                }
                oneLevelList.add(sourceKey);
            }
        }
        
        List<JSONObject> result = new ArrayList<>();

        List<String> sourceList = Arrays.asList("fda", "ema", "pmda");

        List<String> drugWord = new ArrayList<>();
        if (CollUtil.isNotEmpty(condition.getDrugs())) {
            drugWord = condition.getDrugs().stream().filter(drug -> drug.getStatus() == 1).map(Drug::getZhWord).collect(Collectors.toList());
        }       
        for (Map.Entry<String, List<String>> oneEntry : oneLevelMap.entrySet()) {
            JSONObject oneNewInstructionVo = new JSONObject();
            String oneEntryKey = oneEntry.getKey();
            oneNewInstructionVo.put("term", oneEntryKey);
            List<String> oneEntryValue = oneEntry.getValue();

            if (sourceList.contains(oneEntryKey) && CollUtil.isEmpty(oneEntryValue)) {
                oneNewInstructionVo.put("value", new ArrayList<>());
                result.add(oneNewInstructionVo);
                continue;
            }            
            List<JSONObject> oneData = new ArrayList<>();
            List<JSONObject> currentDrugNameAllEnterpriseName = new ArrayList<>();
            for (Map.Entry<String, List<String>> twoEntry : twoLevelMap.entrySet()) {
                JSONObject twoNewInstructionVo = new JSONObject();
                String twoEntryKey = twoEntry.getKey();
                List<String> twoEntryValue = twoEntry.getValue();

                String twoJointValue = oneEntryKey + "-" + twoEntryKey;
                if (oneEntryValue.contains(twoJointValue)) {
                    twoNewInstructionVo.put("term", twoEntryKey);

                    List<JSONObject> twoData = new ArrayList<>();
                    for (Map.Entry<String, List<String>> threeEntry : threeLevelMap.entrySet()) {
                        JSONObject threeNewInstructionVo = new JSONObject();
                        String threeEntryKey = threeEntry.getKey();

                        String subJonitValue = twoJointValue + "-" + threeEntryKey;
                        if (twoEntryValue.contains(subJonitValue)) {
                            threeNewInstructionVo.put("term", threeEntryKey);
                            threeNewInstructionVo.put("value", new ArrayList<>());
                            twoData.add(threeNewInstructionVo);
                            currentDrugNameAllEnterpriseName.add(threeNewInstructionVo);
                        }
                    }
                    JSONObject threeNewInstructionVo = new JSONObject();
                    threeNewInstructionVo.put("term", "全部");
                    threeNewInstructionVo.put("value", new ArrayList<>());
                    twoData.add(0, threeNewInstructionVo);
                    
                    twoNewInstructionVo.put("value", twoData);
                    oneData.add(twoNewInstructionVo);
                }
            }
            // 药品全部下的厂家全部
            JSONObject threeNewInstructionVo = new JSONObject();
            threeNewInstructionVo.put("term", "全部");
            threeNewInstructionVo.put("value", new ArrayList<>());
            currentDrugNameAllEnterpriseName.add(0, threeNewInstructionVo);

            // 药品全部
            JSONObject twoNewInstructionVo = new JSONObject();
            twoNewInstructionVo.put("term", "全部");
            twoNewInstructionVo.put("value", currentDrugNameAllEnterpriseName.stream().distinct().collect(Collectors.toList()));

            List<String> finalDrugWord = drugWord;
            if (CollectionUtils.isNotEmpty(finalDrugWord)) {
                ToIntFunction<JSONObject> getPriority = o -> {
                    String key = o.getString("term");
                    if (key.contains("复方")) {
                        return 2;
                    } else if (StrUtil.equalsAny(key, finalDrugWord.toArray(new String[0]))) {
                        return 0; // 完全匹配
                    } else if (StrUtil.containsAny(key, finalDrugWord.toArray(new String[0]))) {
                        return 1; // 部分匹配
                    } else {
                        return 3; // 不匹配
                    }
                };
                // 按是否包含finalDrugWord中的某个元素先做分组 — 每个关键字对应一组 ，以及一个“不匹配”组
                Map<String, List<JSONObject>> groups = new LinkedHashMap<>();
                // 初始化所有关键字为空组
                for (String drug : finalDrugWord) {
                    groups.put(drug, new ArrayList<>());
                }
                // 不匹配组
                List<JSONObject> notMatchedGroup = new ArrayList<>();
                // 遍历oneData分组
                for (JSONObject o : oneData) {
                    String key = o.getString("term");
                    boolean matched = false;
                    for (String drug : finalDrugWord) {
                        if (key.contains(drug)) {
                            groups.get(drug).add(o);
                            matched = true;
                            break; // 第一个匹配的就分组到对应drug的组
                        }
                    }
                    if (!matched) {
                        notMatchedGroup.add(o);
                    }
                }

                // 对每组内部进行排序，排序规则按照优先级然后term长度
                Comparator<JSONObject> comparator = Comparator.comparingInt(getPriority)
                        .thenComparingInt(o -> o.getString("term").length());

                // 最终结果容器
                List<JSONObject> sortedList = new ArrayList<>();

                // 先对有关键字组合的组排序并添加
                for (String drug : finalDrugWord) {
                    List<JSONObject> groupList = groups.get(drug);
                    groupList.sort(comparator);
                    sortedList.addAll(groupList);
                }

                // 最后对不匹配的组排序添加
                notMatchedGroup.sort(comparator);
                sortedList.addAll(notMatchedGroup);

                oneData = sortedList;

//                oneData = oneData.stream().sorted(Comparator.comparingInt((JSONObject o) -> {
//                    String key = o.getString("term");
//                    if (key.contains("复方")) {
//                        return 2;
//                    } else if (StrUtil.equalsAny(key, finalDrugWord.toArray(new String[0]))) {
//                        return 0; // 完全匹配
//                    } else if (StrUtil.containsAny(key, finalDrugWord.toArray(new String[0]))) {
//                        return 1; // 部分匹配
//                    } else {
//                        return 3; // 不匹配
//                    }
//                }).thenComparingInt((JSONObject o) -> o.getString("term").length())).collect(Collectors.toList());
            }

            oneData.add(0, twoNewInstructionVo);
            oneNewInstructionVo.put("value", oneData);
            result.add(oneNewInstructionVo);
        }
        return result;
    }

    @Override
    public PageVo<InstructionVo> navigationList(String id, String oneLevelTerm, String twoLevelTerm, String threeLevelTerm, Integer pageSize, Integer pageNum, String search) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        
        BoolQueryBuilder instructionQuery = QueryUtils.createInstructionQuery(condition);

        if (StrUtil.isNotBlank(oneLevelTerm)) {
            if ("nmpa".equalsIgnoreCase(oneLevelTerm)) {
                List<String> list = Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药", "用药参考", "其它");
                instructionQuery.must().add(QueryBuilders.termsQuery("source", list));
                // nmpa的只需 使用新说明书  剔除旧说明书
                instructionQuery.must().add(QueryBuilders.matchPhraseQuery("medicineUsePdf", "true"));
                // 剔除重复说明书
//                instructionQuery.must().add(QueryBuilders.termQuery("duplication.keyword", 0));
                instructionQuery.must().add(QueryBuilders.existsQuery("pdf_name"));
                instructionQuery.must().add(QueryBuilders.termQuery("selected", 0));
            } else {
                instructionQuery.must().add(QueryBuilders.termQuery("source", oneLevelTerm.toLowerCase()));
            }
        }

        if (StrUtil.isNotBlank(twoLevelTerm) && !"全部".equals(twoLevelTerm)) {
            BoolQueryBuilder nameBoolQueryBuilder = new BoolQueryBuilder();
            nameBoolQueryBuilder.should().add(QueryBuilders.termQuery("simpleGenericNames.keyword", twoLevelTerm));
//            nameBoolQueryBuilder.should().add(QueryBuilders.termQuery("simpleEnglishName.keyword", twoLevelTerm));
            instructionQuery.must().add(nameBoolQueryBuilder);
        }

        if (StrUtil.isNotBlank(threeLevelTerm) && !"全部".equals(threeLevelTerm)) {
            TermQueryBuilder enterpriseName = QueryBuilders.termQuery("enterpriseName.keyword", threeLevelTerm);
            instructionQuery.must().add(enterpriseName);
        }

        NativeSearchQuery nativeSearchQuery;

        if ("全部".equals(twoLevelTerm)) {
            // 构建 function_score 查询
            FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[1];

            String scriptStr = "def baseScore = _score; if (doc['simpleGenericNames.keyword'].value.contains('复方')) { return baseScore * 0.3; } else { return baseScore * 1; } ";
            Script script = new Script(scriptStr);
            ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
            filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);

            FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(instructionQuery, filterFunctionBuilders);
            functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
            functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
            nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
        } else {
            nativeSearchQuery = new NativeSearchQuery(instructionQuery);
        }

        nativeSearchQuery.setPageable(PageRequest.of(pageNum - 1, pageSize));
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
        String preTag = "<b>";
        String postTag = "</b>";
        HighlightBuilder highlightBuilder = new HighlightBuilder();
        highlightBuilder.field("simpleGenericNames");
        highlightBuilder.field("indication");
        highlightBuilder.preTags(preTag);
        highlightBuilder.postTags(postTag);
        highlightBuilder.fragmentSize(1024 * 10);
        highlightBuilder.numOfFragments(0);
        highlightBuilder.requireFieldMatch(false);
        nativeSearchQuery.setHighlightQuery(new HighlightQuery(highlightBuilder));

        SearchHits<InstructionIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, InstructionIndex.class, IndexCoordinates.of("instruction_data_index", "instructions_use_index"));
        // 干掉高亮
        Object objectStopWord = RedisUtil.redis.opsForValue().get("jieba_word");
        List<String> stopWord = ObjectToListUtil.objToList(objectStopWord, String.class);
        List<InstructionVo> list = new ArrayList<>();
        for (SearchHit<InstructionIndex> searchHit : searchHits) {
            InstructionIndex instructionIndex = searchHit.getContent();
            //高亮
            List<String> titleList = searchHit.getHighlightField("simpleGenericNames");
            StringBuilder titleBuilder = new StringBuilder();
            if (CollUtil.isNotEmpty(titleList)) {
                titleList.forEach(titleBuilder::append);
            }
            instructionIndex.setSimpleGenericNames(StringUtils.isBlank(titleBuilder.toString()) ? instructionIndex.getSimpleGenericNames() : HighLightUtils.highLight(repairContent(titleBuilder.toString(), instructionIndex.getSimpleGenericNames(), stopWord), instructionIndex.getSimpleGenericNames(), condition, search));
            List<String> indicationList = searchHit.getHighlightField("indication");
            StringBuilder indicationBuilder = new StringBuilder();
            if (CollUtil.isNotEmpty(indicationList)) {
                indicationList.forEach(indicationBuilder::append);
            }
            instructionIndex.setIndication(StringUtils.isBlank(indicationBuilder.toString()) ? instructionIndex.getIndication() : HighLightUtils.highLight(repairContent(indicationBuilder.toString(), instructionIndex.getIndication(), stopWord), instructionIndex.getIndication(), condition, search));
            String indication = instructionIndex.getIndication();
            if (StrUtil.isNotBlank(indication)) {
                instructionIndex.setIndication(instructionIndex.getIndication().replaceAll("</?[^/?(b)][^><]*>", " "));
            }
            InstructionVo instructionVo = FormatUtil.formInstruction(instructionIndex);
            //判断收藏情况
            /*Criteria criteria = Criteria.where("instructionId").is(instructionIndex.getPdf_name()).and("userId").is(userId).and("conditionId").is(id);
            InstructionCollect collect = mongoTemplate.findOne(new Query(criteria), InstructionCollect.class);
            if (collect != null){
                instructionVo.setCollectionMark(1);
            }*/
            list.add(instructionVo);
        }
        long totalHits = searchHits.getTotalHits();
        int pages = (int) (totalHits % pageSize == 0 ? totalHits / pageSize : totalHits / pageSize + 1);
        list = list.stream().sorted(Comparator.comparing(InstructionVo::getMedicineUsePdf, Comparator.reverseOrder())).collect(Collectors.toList());
        PageVo<InstructionVo> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        return page;
    }

    @Override
    public JSONObject instructionHtml(String source, String pdfName) {
        JSONObject text = drugFeign.getText(source, pdfName);

        Integer code = text.getInteger("code");
        if (code != null && code == 200) {
            return text.getJSONObject("data");
        }
        return new JSONObject();
    }

    @Override
    public List<String> typeList(String id) {
        List<String> typeList = new ArrayList<>();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        BoolQueryBuilder instructionQuery = QueryUtils.createInstructionQuery(condition);

        BoolQueryBuilder sourceBoolQueryBuilder = new BoolQueryBuilder();
        List<String> list = Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药", "用药参考", "其它");
        sourceBoolQueryBuilder.must().add(QueryBuilders.termsQuery("source", list));
        // nmpa的只需 使用新说明书  剔除旧说明书
        sourceBoolQueryBuilder.must().add(QueryBuilders.matchPhraseQuery("medicineUsePdf", "true"));
        instructionQuery.should().add(sourceBoolQueryBuilder);

        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(instructionQuery);
        TermsAggregationBuilder source = AggregationBuilders.terms("source").field("source").size(10);
        nativeSearchQuery.addAggregation(source);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        SearchHits<InstructionIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, InstructionIndex.class, IndexCoordinates.of("instruction_data_index", "instructions_use_index"));
        Aggregations aggregations = search.getAggregations();
        Map<String, Long> typeMap = new LinkedHashMap<>();
        typeMap.put("nmpa", 0L);
        typeMap.put("fda", 0L);
        typeMap.put("ema", 0L);
        typeMap.put("pmda", 0L);
        if (aggregations != null){
            Aggregation aggregation = aggregations.get("source");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                String key = bucket.getKey().toString();
                if (list.contains(key)) {
                    key = "nmpa";
                }
                long docCount = bucket.getDocCount();
                if (typeMap.containsKey(key)){
                    typeMap.put(key, docCount);
                }
            }
        }
        Set<Map.Entry<String, Long>> entries = typeMap.entrySet();
        for (Map.Entry<String, Long> entry : entries) {
            String key = entry.getKey();
            Long value = entry.getValue();
            if (value > 0) {
                typeList.add(key);
            }
        }
        return typeList;
    }
    
    @Override
    public PageVo<InstructionVo> list(String id, String type, Integer pageSize, Integer pageNum, String search, Long userId) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        
        BoolQueryBuilder instructionQuery = QueryUtils.createInstructionQuery(condition);
        //说明书的来源
        if (StrUtil.isNotBlank(type)) {
            if ("nmpa".equalsIgnoreCase(type)) {
                List<String> list = Arrays.asList("nmpa", "药智", "39健康", "39健康网", "用药助手", "亮健好药", "用药参考", "其它");
                instructionQuery.must().add(QueryBuilders.termsQuery("source", list));
                // nmpa的只需 使用新说明书  剔除旧说明书
                instructionQuery.must().add(QueryBuilders.matchPhraseQuery("medicineUsePdf", "true"));
            } else {
                instructionQuery.must().add(QueryBuilders.termQuery("source", type.toLowerCase()));
            }
        }
        //二次搜索条件
        if (StringUtils.isNotBlank(search)){
            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(search, "simpleGenericNames", "simpleEnglishName", "simpleTradeNames", "indication", "enterpriseName");
            multiMatchQueryBuilder.operator(Operator.AND);
            multiMatchQueryBuilder.field("title", 24F);
            instructionQuery.must().add(multiMatchQueryBuilder);
        }
        
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(instructionQuery);
        nativeSearchQuery.setPageable(PageRequest.of(pageNum - 1, pageSize));
        String preTag = "<b>";
        String postTag = "</b>";
        HighlightBuilder highlightBuilder = new HighlightBuilder();
        highlightBuilder.field("simpleGenericNames");
        highlightBuilder.field("indication");
        highlightBuilder.preTags(preTag);
        highlightBuilder.postTags(postTag);
        highlightBuilder.fragmentSize(1024 * 10);
        highlightBuilder.numOfFragments(0);
        highlightBuilder.requireFieldMatch(false);
        nativeSearchQuery.setHighlightQuery(new HighlightQuery(highlightBuilder));

        SearchHits<InstructionIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, InstructionIndex.class, IndexCoordinates.of("instruction_data_index", "instructions_use_index"));
//        SearchHits<InstructionIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, InstructionIndex.class);
        // 干掉高亮
        Object objectStopWord = RedisUtil.redis.opsForValue().get("jieba_word");
        List<String> stopWord = ObjectToListUtil.objToList(objectStopWord, String.class);
        List<InstructionVo> list = new ArrayList<>();
        for (SearchHit<InstructionIndex> searchHit : searchHits) {
            InstructionIndex instructionIndex = searchHit.getContent();
            //高亮
            List<String> titleList = searchHit.getHighlightField("simpleGenericNames");
            StringBuilder titleBuilder = new StringBuilder();
            if (CollUtil.isNotEmpty(titleList)) {
                titleList.forEach(titleBuilder::append);
            }
            instructionIndex.setSimpleGenericNames(StringUtils.isBlank(titleBuilder.toString()) ? instructionIndex.getSimpleGenericNames() : HighLightUtils.highLight(repairContent(titleBuilder.toString(), instructionIndex.getSimpleGenericNames(), stopWord), instructionIndex.getSimpleGenericNames(), condition, search));
            List<String> indicationList = searchHit.getHighlightField("indication");
            StringBuilder indicationBuilder = new StringBuilder();
            if (CollUtil.isNotEmpty(indicationList)) {
                indicationList.forEach(indicationBuilder::append);
            }
            instructionIndex.setIndication(StringUtils.isBlank(indicationBuilder.toString()) ? instructionIndex.getIndication() : HighLightUtils.highLight(repairContent(indicationBuilder.toString(), instructionIndex.getIndication(), stopWord), instructionIndex.getIndication(), condition, search));
            String indication = instructionIndex.getIndication();
            if (StrUtil.isNotBlank(indication)) {
                instructionIndex.setIndication(instructionIndex.getIndication().replaceAll("</?[^/?(b)][^><]*>", " "));
            }
            InstructionVo instructionVo = FormatUtil.formInstruction(instructionIndex);
            //判断收藏情况
            /*Criteria criteria = Criteria.where("instructionId").is(instructionIndex.getPdf_name()).and("userId").is(userId).and("conditionId").is(id);
            InstructionCollect collect = mongoTemplate.findOne(new Query(criteria), InstructionCollect.class);
            if (collect != null){
                instructionVo.setCollectionMark(1);
            }*/
            list.add(instructionVo);
        }
        long totalHits = searchHits.getTotalHits();
        int pages = (int) (totalHits % pageSize == 0 ? totalHits / pageSize : totalHits / pageSize + 1);
        list = list.stream().sorted(Comparator.comparing(InstructionVo::getMedicineUsePdf, Comparator.reverseOrder())).collect(Collectors.toList());
        PageVo<InstructionVo> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        return page;
    }

    @Override
    public Boolean operate(String id, String instructionId, Long userId, Integer operate) {
        if (operate == 2){
            //取消收藏
            DeleteResult remove = mongoTemplate.remove(new Query(Criteria.where("conditionId").is(id).and("instructionId").is(instructionId).and("userId").is(userId)), InstructionCollect.class);
            return remove.getDeletedCount() > 0;
        }else {
            //收藏
            InstructionCollect collect = new InstructionCollect(UUID.randomUUID().toString(), id, instructionId, userId, System.currentTimeMillis());
            try {
                mongoTemplate.save(collect);
                return true;
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
        return false;
    }

    @Override
    public JSONArray infoForAdverse_v2(String id, Boolean hasReferenceDrug) {
        JSONArray result = new JSONArray();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        Set<String> drugNameList = new HashSet<>();
        List<Drug> drugs = condition.getDrugs();
        for (Drug drug : drugs) {
            Integer status = drug.getStatus();
            if (status == 1) {
                drugNameList.add(drug.getWord());
            }
        }
        if (hasReferenceDrug) {
            List<InterventionAndOutcome> interventions = condition.getInterventions();
            if (CollUtil.isNotEmpty(interventions)) {
                for (InterventionAndOutcome intervention : interventions) {
                    Integer status = intervention.getStatus();
                    if (status == 1) {
                        drugNameList.add(intervention.getWord());
                    }
                }
            }
        }
        for (String s : drugNameList) {
            JSONObject inner = new JSONObject();
            //禁忌
            inner.put("taboo", "");
            //特殊人群
            inner.put("special", new JSONObject());
            //不良反应
            inner.put("adverse", "");
            // 适应症
            inner.put("indications", "");
            // 用法与用量
            inner.put("usageAndDosage", "");
            // 注意事项
            inner.put("notes", "");
            // 药理作用
            inner.put("pharmacology", "");
            // 毒理作用
            inner.put("toxicological", "");
            Set<String> drugList = new HashSet<>();
            drugList.add(s);
            for (Drug drug : drugs) {
                Integer status = drug.getStatus();
                if (status == 1) {
                    String word = drug.getWord();
                    if (s.equals(word)) {
                        String enWord = drug.getEnWord();
                        if (StringUtils.isNotBlank(enWord)) {
                            drugList.add(enWord);
                        }
                        String zhWord = drug.getZhWord();
                        if (StringUtils.isNotBlank(zhWord)) {
                            drugList.add(zhWord);
                        }
                        List<WordStatus> enSynonym = drug.getEnSynonym();
                        if (CollUtil.isNotEmpty(enSynonym)) {
                            for (WordStatus wordStatus : enSynonym) {
                                Boolean checked = wordStatus.getChecked();
                                if (checked) {
                                    drugList.add(wordStatus.getName());
                                }
                            }
                        }
                        List<WordStatus> zhSynonym = drug.getZhSynonym();
                        if (CollUtil.isNotEmpty(zhSynonym)) {
                            for (WordStatus wordStatus : zhSynonym) {
                                Boolean checked = wordStatus.getChecked();
                                if (checked) {
                                    drugList.add(wordStatus.getName());
                                }
                            }
                        }
                        break;
                    }
                }
            }
            //拼接检索条件
            StringBuilder builder = new StringBuilder();
            QueryUtils.montage(builder, drugList);
            //SearchFormula searchFormula = new SearchFormula();
            List<Instruction> instructions = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                String source;
                if (i == 0) {
                    source = "nmpa";
                } else if (i == 1) {
                    source = "fda";
                } else if (i == 2) {
                    source = "ema";
                } else {
                    source = "pmda";
                }
                //BoolQueryBuilder execute = searchFormula.execute(builder.toString(), 3);
                BoolQueryBuilder execute = QueryBuilders.boolQuery();
                String formula = FormulaFeignUtil.formula(builder.toString(), 3);
                execute.must().add(QueryBuilders.wrapperQuery(formula));
                execute.must().add(QueryBuilders.termQuery("source", source));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(execute);
                nativeSearchQuery.setPageable(PageRequest.of(0, 20));
                SearchHits<InstructionIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, InstructionIndex.class);
                long totalHits = search.getTotalHits();
                if (totalHits > 0) {
                    for (SearchHit<InstructionIndex> instructionIndexSearchHit : search) {
                        InstructionIndex content = instructionIndexSearchHit.getContent();
                        String pdfName = content.getPdf_name();
                        //此处使用正式环境mongo
                        Instruction instruction = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("pdf_name").is(pdfName)), Instruction.class);
                        if (instruction != null) {
                            instructions.add(instruction);
                        }
                    }
                    break;
                }
            }
            int maxDataFlag = 0;
            for (Instruction instruction : instructions) {
                int numData = 0;
                //禁忌
                String taboo = instruction.getTaboo();
                if (StringUtils.isNotBlank(taboo)) {
                    numData++;
                }
                //孕妇及哺乳期妇女用药
                String pregnantAndLactatingWomen = instruction.getPregnantAndLactatingWomen();
                if (StringUtils.isNotBlank(pregnantAndLactatingWomen)) {
                    numData++;
                }
                //儿童用药
                String medicationInChildren = instruction.getMedicationInChildren();
                if (StringUtils.isNotBlank(medicationInChildren)) {
                    numData++;
                }
                //老年用药
                String geriatricMedications = instruction.getGeriatricMedications();
                if (StringUtils.isNotBlank(geriatricMedications)) {
                    numData++;
                }
                //用法用量
                String usage = instruction.getUsage();
                if (StringUtils.isNotBlank(usage)) {
                    numData++;
                }
                if (maxDataFlag < numData) {
                    maxDataFlag = numData;
                    //禁忌
                    if (StringUtils.isNotBlank(taboo)) {
                        inner.put("taboo", taboo);
                    }
                    //特殊人群
                    JSONObject special = inner.getJSONObject("special");
                    special.put("women", "");
                    special.put("children", "");
                    special.put("old", "");
                    if (StringUtils.isNotBlank(pregnantAndLactatingWomen)) {
                        pregnantAndLactatingWomen = pregnantAndLactatingWomen.replaceAll("\t", "&emsp;&emsp;");
                        pregnantAndLactatingWomen = pregnantAndLactatingWomen.replaceAll("\r\n", "<br/>");
                        special.put("women", pregnantAndLactatingWomen);
                    }
                    //儿童用药
                    if (StringUtils.isNotBlank(medicationInChildren)) {
                        medicationInChildren = medicationInChildren.replaceAll("\t", "&emsp;&emsp;");
                        medicationInChildren = medicationInChildren.replaceAll("\r\n", "<br/>");
                        special.put("children", medicationInChildren);
                    }
                    //老年用药
                    if (StringUtils.isNotBlank(geriatricMedications)) {
                        geriatricMedications = geriatricMedications.replaceAll("\t", "&emsp;&emsp;");
                        geriatricMedications = geriatricMedications.replaceAll("\r\n", "<br/>");
                        special.put("old", geriatricMedications);
                    }
                    //不良反应
                    if (StringUtils.isNotBlank(usage)) {
                        usage = usage.replaceAll("\t", "&emsp;&emsp;");
                        usage = usage.replaceAll("\r\n", "<br/>");
                        inner.put("adverse", usage);
                    }
                }
            }
            inner.put("name", s);
            result.add(inner);
        }
        return result;
    }

    @Override
    public JSONArray infoForAdverse(String id, Boolean hasReferenceDrug) {
        return new JSONArray();
    }
//        JSONArray result = new JSONArray();
//        Condition condition = mongoTemplate.findById(id, Condition.class);
//        if (condition == null){
//            throw new RuntimeException("检索id异常");
//        }
//        Set<String> drugNameList = new HashSet<>();
//        List<Drug> drugs = condition.getDrugs();
//        for (Drug drug : drugs) {
//            Integer status = drug.getStatus();
//            if (status == 1) {
//                drugNameList.add(drug.getWord());
//            }
//        }
//        if (hasReferenceDrug) {
//            List<InterventionAndOutcome> interventions = condition.getInterventions();
//            if (CollUtil.isNotEmpty(interventions)) {
//                for (InterventionAndOutcome intervention : interventions) {
//                    Integer status = intervention.getStatus();
//                    if (status == 1) {
//                        drugNameList.add(intervention.getWord());
//                    }
//                }
//            }
//        }
//        for (String s : drugNameList) {
//            JSONObject inner = new JSONObject();
//            //禁忌
//            inner.put("taboo", "");
//            //特殊人群
//            inner.put("special", new JSONObject());
//            //不良反应
//            inner.put("adverse", "");
//            // 适应症
//            inner.put("indications", "");
//            // 用法与用量
//            inner.put("usageAndDosage", "");
//            // 注意事项
//            inner.put("notes", "");
//            // 药理作用
//            inner.put("pharmacology", "");
//            // 毒理作用
//            //inner.put("toxicological", "");
//            Set<String> drugList = new HashSet<>();
//            drugList.add(s.toLowerCase());
//            for (Drug drug : drugs) {
//                Integer status = drug.getStatus();
//                if (status == 1) {
//                    String word = drug.getWord();
//                    if (s.equals(word)) {
//                        String enWord = drug.getEnWord();
//                        if (StringUtils.isNotBlank(enWord)) {
//                            drugList.add(enWord.toLowerCase());
//                        }
//                        String zhWord = drug.getZhWord();
//                        if (StringUtils.isNotBlank(zhWord)) {
//                            drugList.add(zhWord.toLowerCase());
//                        }
//                        List<WordStatus> enSynonym = drug.getEnSynonym();
//                        if (CollUtil.isNotEmpty(enSynonym)) {
//                            for (WordStatus wordStatus : enSynonym) {
//                                Boolean checked = wordStatus.getChecked();
//                                if (checked) {
//                                    drugList.add(wordStatus.getName().toLowerCase());
//                                }
//                            }
//                        }
//                        List<WordStatus> zhSynonym = drug.getZhSynonym();
//                        if (CollUtil.isNotEmpty(zhSynonym)) {
//                            for (WordStatus wordStatus : zhSynonym) {
//                                Boolean checked = wordStatus.getChecked();
//                                if (checked) {
//                                    drugList.add(wordStatus.getName().toLowerCase());
//                                }
//                            }
//                        }
//                        break;
//                    }
//                }
//            }
//            //拼接检索条件
//            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
//            for (String s1 : drugList) {
//                MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(s1, "drugName", "zhDrugName", "dosageForm", "enDrugNames");
//                multiMatchQueryBuilder.operator(Operator.AND);
//                boolQueryBuilder.should().add(multiMatchQueryBuilder);
//            }
//            //NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(QueryBuilders.termQuery("drugName.keyword", drugList));
//            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
//            nativeSearchQuery.setPageable(PageRequest.of(0, 20));
//            SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
//            long totalHits = search.getTotalHits();
//            List<DrugInfo> drugInfos = new ArrayList<>();
//            if (totalHits > 0) {
//                for (SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit : search) {
//                    DrugAndIndicationIndex content = drugAndIndicationIndexSearchHit.getContent();
//                    String contentId = content.getId();
//                    //此处使用正式环境mongo
//                    DrugInfo drugInfo = ReleaseMongoUtil.mongo.findById(contentId, DrugInfo.class);
//                    if (drugInfo != null) {
//                        drugInfos.add(drugInfo);
//                    }
//                }
//            }
//            int maxDataFlag = 0;
//            for (DrugInfo drugInfo : drugInfos) {
//                int numData = 0;
//                //禁忌
//                String taboo = drugInfo.getTaboo();
//                if (StringUtils.isNotBlank(taboo)) {
//                    numData++;
//                }
//                //孕妇及哺乳期妇女用药
//                String pregnantAndLactatingWomen = drugInfo.getPregnantWomen();
//                if (StringUtils.isNotBlank(pregnantAndLactatingWomen)) {
//                    numData++;
//                }
//                //儿童用药
//                String medicationInChildren = drugInfo.getChildrenMedicine();
//                if (StringUtils.isNotBlank(medicationInChildren)) {
//                    numData++;
//                }
//                //老年用药
//                String geriatricMedications = drugInfo.getGeriatricMedicine();
//                if (StringUtils.isNotBlank(geriatricMedications)) {
//                    numData++;
//                }
//                //用法用量
//                String usage = drugInfo.getUsageAndDosage();
//                if (StringUtils.isNotBlank(usage)) {
//                    numData++;
//                }
//                //不良反应
//                String adverseReaction = drugInfo.getAdverseReaction();
//                if (StringUtils.isNotBlank(adverseReaction)) {
//                    numData++;
//                }
//                //适应症
//                String indication = drugInfo.getIndication();
//                if (StringUtils.isNotBlank(indication)) {
//                    numData++;
//                }
//                //注意事项 notes
//                String notes = drugInfo.getNotes();
//                if (StringUtils.isNotBlank(notes)) {
//                    numData++;
//                }
//                //药理作用 pharmacology
//                String pharmacology = drugInfo.getPharmacology();
//                if (StringUtils.isNotBlank(pharmacology)) {
//                    numData++;
//                }
//                if (maxDataFlag < numData) {
//                    maxDataFlag = numData;
//                    //禁忌
//                    if (StringUtils.isNotBlank(taboo)) {
//                        inner.put("taboo", taboo);
//                    }
//                    //特殊人群
//                    JSONObject special = inner.getJSONObject("special");
//                    special.put("women", "");
//                    special.put("children", "");
//                    special.put("old", "");
//                    if (StringUtils.isNotBlank(pregnantAndLactatingWomen)) {
//                        pregnantAndLactatingWomen = pregnantAndLactatingWomen.replaceAll("\t", "&emsp;&emsp;");
//                        pregnantAndLactatingWomen = pregnantAndLactatingWomen.replaceAll("\r\n", "<br/>");
//                        special.put("women", pregnantAndLactatingWomen);
//                    }
//                    //儿童用药
//                    if (StringUtils.isNotBlank(medicationInChildren)) {
//                        medicationInChildren = medicationInChildren.replaceAll("\t", "&emsp;&emsp;");
//                        medicationInChildren = medicationInChildren.replaceAll("\r\n", "<br/>");
//                        special.put("children", medicationInChildren);
//                    }
//                    //老年用药
//                    if (StringUtils.isNotBlank(geriatricMedications)) {
//                        geriatricMedications = geriatricMedications.replaceAll("\t", "&emsp;&emsp;");
//                        geriatricMedications = geriatricMedications.replaceAll("\r\n", "<br/>");
//                        special.put("old", geriatricMedications);
//                    }
//                    //用法用量
//                    if (StringUtils.isNotBlank(usage)) {
//                        usage = usage.replaceAll("\t", "&emsp;&emsp;");
//                        usage = usage.replaceAll("\r\n", "<br/>");
//                        inner.put("usageAndDosage", usage);
//                    }
//                    //不良反应
//                    if (StringUtils.isNotBlank(adverseReaction)) {
//                        adverseReaction = adverseReaction.replaceAll("\t", "&emsp;&emsp;");
//                        adverseReaction = adverseReaction.replaceAll("\r\n", "<br/>");
//                        inner.put("adverse", adverseReaction);
//                    }
//                    //适应症
//                    if (StringUtils.isNotBlank(indication)) {
//                        indication = indication.replaceAll("\t", "&emsp;&emsp;");
//                        indication = indication.replaceAll("\r\n", "<br/>");
//                        inner.put("indications", indication);
//                    }
//                    //注意事项 notes
//                    if (StringUtils.isNotBlank(notes)) {
//                        notes = notes.replaceAll("\t", "&emsp;&emsp;");
//                        notes = notes.replaceAll("\r\n", "<br/>");
//                        inner.put("notes", notes);
//                    }
//                    //药理作用 pharmacology
//                    if (StringUtils.isNotBlank(pharmacology)) {
//                        pharmacology = pharmacology.replaceAll("\t", "&emsp;&emsp;");
//                        pharmacology = pharmacology.replaceAll("\r\n", "<br/>");
//                        inner.put("pharmacology", pharmacology);
//                    }
//                }
//            }
//            inner.put("name", s);
//            result.add(inner);
//        }
//        return result;
//    }

    /****
     * 修复缺失的标点并且高亮
     * @param data 数据
     * @param originalData 原始数据
     * @param stops 停用词
     * @return 处理后的数据
     */
    public String repairContent(String data, String originalData, List<String> stops) {
        try {
            data = data.replaceAll("<b>", "卍").replaceAll("</b>", "卐");
            data = data.replaceAll("卐卍", "");
            List<String> l = new ArrayList<>();
            int left = 0, right = 0;
            int maxLen = 0;
            while (right < data.length()) {
                if (data.charAt(right) == '卍') {
                    left = right;
                }
                if (data.charAt(right) == '卐') {
                    String substring = data.substring(left + 1, right);
                    if (!StrUtil.isNumeric(substring)) {
                        l.add(substring);
                    }
                }
                maxLen = Math.max(maxLen, right - left - 1);
                right++;
            }
            for (int i = 0; i < l.size(); i++) {
                if (l.get(i).length() == 1) {
                    continue;
                }
                boolean flag = true;
                for (int j = i + 1; j < l.size(); j++) {
                    if (l.get(j).contains(l.get(i))) {
                        flag = false;
                        break;
                    }
                }
                //停用词不给高亮
                if (stops.contains(l.get(i).toLowerCase())) {
                    continue;
                }
                if (flag) {
                    if (maxLen > 1 && l.get(i).length() > 1) {
                        originalData = originalData.replaceAll(l.get(i), "<b>" + l.get(i) + "</b>");
                    } else if (maxLen == 1) {
                        originalData = originalData.replaceAll(l.get(i), "<b>" + l.get(i) + "</b>");
                    }
                }
            }
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }
        return originalData;
    }
    
}
