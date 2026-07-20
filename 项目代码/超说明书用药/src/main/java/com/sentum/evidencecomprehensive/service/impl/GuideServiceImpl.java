package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.map.MapUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.mongodb.client.result.DeleteResult;
import com.mongodb.client.result.UpdateResult;
import com.sentum.evidencecomprehensive.pojo.bo.es.GuideIndex;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.GuideCollect;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.GuideIncludeOrExclude;
import com.sentum.evidencecomprehensive.pojo.dto.GuideOperateDto;
import com.sentum.evidencecomprehensive.pojo.dto.GuideSearchDto;
import com.sentum.evidencecomprehensive.pojo.bo.es.GuideBlockIndex;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.WordStatus;
import com.sentum.evidencecomprehensive.pojo.vo.GuideVo;
import com.sentum.evidencecomprehensive.pojo.vo.PageVo;
import com.sentum.evidencecomprehensive.pojo.vo.req.GuideInitialRequest;
import com.sentum.evidencecomprehensive.service.GuideService;
import com.sentum.evidencecomprehensive.service.handler.IndexCombinationGenerator;
import com.sentum.evidencecomprehensive.utils.*;
import com.sentum.evidencecomprehensive.utils.operateyl.AIRequestUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.common.lucene.search.function.CombineFunction;
import org.elasticsearch.common.lucene.search.function.FunctionScoreQuery;
import org.elasticsearch.index.query.*;
import org.elasticsearch.index.query.functionscore.FieldValueFactorFunctionBuilder;
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
import org.springframework.data.elasticsearch.core.query.HighlightQuery;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

import java.lang.reflect.Type;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import static com.sentum.evidencecomprehensive.utils.HighLightUtils.highLight;

@Slf4j
@Service
public class GuideServiceImpl implements GuideService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private FeignAlternativeUtils feignAlternativeUtils;

    @Override
    public JSONArray authorList(GuideInitialRequest guideInitialRequest) {
        String id = guideInitialRequest.getId();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }

        JSONArray result = new JSONArray();
        
        BoolQueryBuilder guideQuery = new BoolQueryBuilder();
        Integer operateType = guideInitialRequest.getOperateType();
        if (operateType == 1) {
            List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), GuideIncludeOrExclude.class);
            guideQuery.must().add(QueryBuilders.idsQuery().addIds(guideIncludeOrExcludes.stream().map(GuideIncludeOrExclude::getGuideId).distinct().toArray(String[]::new)));
        } else {
            // 不是历史版本
            guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));

            // 不是指南类型文献
            guideQuery.mustNot().add(QueryBuilders.termQuery("isPaper", 1));

            // query 拼接条件
            BoolQueryBuilder shouldBool = new BoolQueryBuilder();
            BoolQueryBuilder guideConditionQuery = QueryUtils.createGuideQuery(condition);
            shouldBool.should().add(guideConditionQuery);

            List<GuideIncludeOrExclude> conditionId = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id)), GuideIncludeOrExclude.class);
            shouldBool.should().add(QueryBuilders.idsQuery().addIds(conditionId.stream().map(GuideIncludeOrExclude::getGuideId).toArray(String[]::new)));

            guideQuery.must().add(shouldBool);

            // 年份
            String guideStartYear = condition.getGuideStartYear();
            String guideEndYear = condition.getGuideEndYear();
            RangeQueryBuilder ysarRangeQueryBuilder = QueryBuilders.rangeQuery("ysar");
            if (StringUtils.isNotBlank(guideStartYear)) {
                ysarRangeQueryBuilder.gte(guideStartYear);
            }
            if (StringUtils.isNotBlank(guideEndYear)) {
                ysarRangeQueryBuilder.lte(guideEndYear);
            }
            guideQuery.must().add(ysarRangeQueryBuilder);

            //二次搜索条件
            String search = guideInitialRequest.getSearch();
            if (StringUtils.isNotBlank(search)) {
                BoolQueryBuilder searchBool = new BoolQueryBuilder();
                searchBool.should().add(QueryBuilders.matchPhraseQuery("title", search));
                searchBool.should().add(QueryBuilders.matchPhraseQuery("nrjs", search));
                searchBool.should().add(QueryBuilders.matchPhraseQuery("fbdate", search));
                searchBool.should().add(QueryBuilders.matchPhraseQuery("zdz", search));
                guideQuery.must().add(searchBool);
            }
        }
       
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(guideQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("zdz").field("zdz.keyword").size(100);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
        
        Aggregations aggregations = search.getAggregations();
        if (aggregations != null){
            Aggregation aggregation = aggregations.get("zdz");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                Map<String, Long> map = new HashMap<>();
                String key = bucket.getKey().toString();
                long docCount = bucket.getDocCount();
                map.put(key, docCount);
                result.add(map);
            }
        }
        return result;
    }
    
    @Override
    public PageVo<GuideVo> list(GuideSearchDto guideSearchDto, Long userId) {
        String id = guideSearchDto.getId();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        BoolQueryBuilder guideQuery = QueryBuilders.boolQuery();
        Integer operateType = guideSearchDto.getOperateType();

        NativeSearchQuery nativeSearchQuery;
        if (operateType == 1) {
            List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("status").is(1)), GuideIncludeOrExclude.class);
            guideQuery.must().add(QueryBuilders.idsQuery().addIds(guideIncludeOrExcludes.stream().map(GuideIncludeOrExclude::getGuideId).toArray(String[]::new)));
            nativeSearchQuery = new NativeSearchQuery(guideQuery);
        } else {
            // 条件查询组装
            nativeSearchQuery = buildSearchCondition(guideSearchDto, guideQuery, condition);
        }
        //开始查询
        SearchHits<GuideIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
        List<GuideVo> list = new ArrayList<>();
        Object objectStopWord = RedisUtil.redis.opsForValue().get("jieba_word");
        List<String> stopWord = ObjectToListUtil.objToList(objectStopWord, String.class);
        for (SearchHit<GuideIndex> searchHit : searchHits) {
            GuideIndex content = searchHit.getContent();
            float score = searchHit.getScore();
            // 高亮处理
            manageHighlight(searchHit, content, stopWord, condition, guideSearchDto);
            // 组装返回参数
            GuideVo guideResponse = FormatUtil.formatGuide(content);
            // 判断纳入、排除、收藏情况
            Criteria criteria = Criteria.where("guideId").is(content.getId()).and("userId").is(userId).and("conditionId").is(guideSearchDto.getId());
            GuideIncludeOrExclude includeOrExclude = mongoTemplate.findOne(new Query(criteria), GuideIncludeOrExclude.class);
            if (includeOrExclude != null){
                Integer status = includeOrExclude.getStatus();
                guideResponse.setBringIntoOrExcludeMark(status);
            }
            GuideCollect collect = mongoTemplate.findOne(new Query(criteria), GuideCollect.class);
            if (collect != null) {
                guideResponse.setCollectionMark(1);
            }
            list.add(guideResponse);
        }
        long totalHits = searchHits.getTotalHits();
        int pages = (int) (totalHits % guideSearchDto.getPageSize() == 0 ? totalHits / guideSearchDto.getPageSize() : totalHits / guideSearchDto.getPageSize() + 1);
        PageVo<GuideVo> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(guideSearchDto.getPageSize());
        page.setPageNum(guideSearchDto.getPageNum());
        return page;
    }
    private NativeSearchQuery buildSearchCondition(GuideSearchDto guideSearchDto, BoolQueryBuilder guideQuery, Condition condition) {
        NativeSearchQuery nativeSearchQuery;

//        guideQuery.must().add(QueryBuilders.termsQuery("getFlag", "0","1"));
        guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));

        guideQuery.mustNot().add(QueryBuilders.termQuery("isPaper", 1));

        //语言类型
        Integer language = guideSearchDto.getLanguage();
        if (language != 0) {
            if (language == 1) {
                //中文
                guideQuery.must().add(QueryBuilders.termQuery("language", "zh"));
            } else {
                //英文
                guideQuery.must().add(QueryBuilders.termQuery("language", "en"));
            }
        }

        //制定者
        List<String> authors = guideSearchDto.getAuthors();
        if (CollectionUtils.isNotEmpty(authors)) {
            guideQuery.must().add(QueryBuilders.termsQuery("zdz.keyword", authors));
        }

        // 年份
        String startSearchYear;
        String endSearchYear;
        String guideStartYear = condition.getGuideStartYear();
        String guideEndYear = condition.getGuideEndYear();
        Integer startYear = guideSearchDto.getStartYear();
        if (startYear != null) {
            if (startYear >= Integer.parseInt(guideStartYear) && startYear <= Integer.parseInt(guideEndYear)) {
                startSearchYear = startYear.toString();
            } else {
                startSearchYear = guideStartYear;
            }
        } else {
            startSearchYear = guideStartYear;
        }
        Integer endYear = guideSearchDto.getEndYear();
        if (endYear != null) {
            if (endYear >= Integer.parseInt(guideStartYear) && endYear <= Integer.parseInt(guideEndYear)) {
                endSearchYear = endYear.toString();
            } else {
                endSearchYear = guideEndYear;
            }
        }else {
            endSearchYear = guideEndYear;
        }

        if (startYear != null && startYear > Integer.parseInt(guideEndYear)) {
            startSearchYear = "-1";
            endSearchYear = "-1";
        }
        if (endYear != null && endYear < Integer.parseInt(guideStartYear)) {
            startSearchYear = "-1";
            endSearchYear = "-1";
        }
        guideQuery.must().add(QueryBuilders.rangeQuery("fbdate").gte(startSearchYear + "-00-00"));
        guideQuery.must().add(QueryBuilders.rangeQuery("fbdate").lte(endSearchYear + "-12-30 24:00:00"));

        //二次搜索条件
        String search = guideSearchDto.getSearch();
        if (StringUtils.isNotBlank(search)) {
            BoolQueryBuilder searchBool = new BoolQueryBuilder();
            searchBool.should().add(QueryBuilders.matchPhraseQuery("title", search));
            searchBool.should().add(QueryBuilders.matchPhraseQuery("nrjs", search));
            searchBool.should().add(QueryBuilders.matchPhraseQuery("fbdate", search));
            searchBool.should().add(QueryBuilders.matchPhraseQuery("zdz", search));
            guideQuery.must().add(searchBool);
        }

        //排序-分页
        Integer sortType = guideSearchDto.getSortType();
        Integer sortDirection = guideSearchDto.getSortDirection();
        PageRequest pageRequest = PageRequest.of(guideSearchDto.getPageNum() - 1, guideSearchDto.getPageSize());
        if (sortType == 1){
            //发布时间
            Sort.Direction direction = Sort.Direction.ASC;
            if (sortDirection == 0) {
                direction = Sort.Direction.DESC;
            }
            pageRequest = PageRequest.of(guideSearchDto.getPageNum() - 1, guideSearchDto.getPageSize(), Sort.by(direction, "dateTs"));
        } else if (sortType == 0) {
            pageRequest = PageRequest.of(guideSearchDto.getPageNum() - 1, guideSearchDto.getPageSize());
        }

        List<String> drugSynonym = handleDrugToSynonym(condition.getDrugs());
        List<String> diseaseSynonym = handleDiseaseToSynonym(condition.getDiseases());
        // query conditon

        // query 拼接条件
        BoolQueryBuilder shouldBool = new BoolQueryBuilder();
        BoolQueryBuilder guideConditionQuery = QueryUtils.createGuideQuery(condition);
        shouldBool.should().add(guideConditionQuery);

        List<GuideIncludeOrExclude> conditionId = mongoTemplate.find(new Query(Criteria.where("conditionId").is(condition.getId())), GuideIncludeOrExclude.class);
        shouldBool.should().add(QueryBuilders.idsQuery().addIds(conditionId.stream().map(GuideIncludeOrExclude::getGuideId).toArray(String[]::new)));

        guideQuery.must().add(shouldBool);

        if (guideSearchDto.getSortType() == 0) {
            // 构建 function_score 查询
            FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[2];
            String scriptStr = "double baseScore = Math.log1p(_score + 1) * 0.5; " +
                            "String name = doc['name'].value; " +
                            "if (name != null && name.indexOf('联合') >= 0) { " +
                            "    return baseScore * 0.5; " +
                            "} " +
                            "return baseScore;";
//            String scriptStr = "Math.log1p(_score + 1)*0.5";
            Script script = new Script(scriptStr);
            ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
            // 
            FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
            
            filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
            filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
            
            FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
            functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
            functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
            nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
            nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
        } else {
            nativeSearchQuery = new NativeSearchQuery(guideQuery);
        }
        nativeSearchQuery.setPageable(pageRequest);
        nativeSearchQuery.setTrackScores(true);
        nativeSearchQuery.setTrackTotalHits(true);

        //高亮
        String preTag = "<b>";
        String postTag = "</b>";
        HighlightBuilder highlightBuilder = new HighlightBuilder();
        highlightBuilder.field("title");
        highlightBuilder.field("nrjs");
        highlightBuilder.preTags(preTag);
        highlightBuilder.postTags(postTag);
        highlightBuilder.fragmentSize(1024 * 10);
        highlightBuilder.numOfFragments(0);
        highlightBuilder.requireFieldMatch(true);
        nativeSearchQuery.setHighlightQuery(new HighlightQuery(highlightBuilder));

        return nativeSearchQuery;
    }

    @Override
    public Map<String, String> includeLatest(String id, Long userId) {
        Map<String, String> resultMap = new HashMap<>();
        
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (Objects.nonNull(condition)) {
            List<JSONObject> guideList = searchWithSynonymCombination(condition);

            List<String> includeIds = new ArrayList<>();
            
            if (CollectionUtils.isNotEmpty(guideList)) {
                for (JSONObject guide : guideList) {
                    String guideId = guide.getString("id");
                    String content = guide.getString("block");
                    
                    content = content.replaceAll("\\[","【").replaceAll("]","】");
                    
                    includeIds.add(guideId);
                    resultMap.put(guideId, content);
                }
            }
            GuideOperateDto guideOperateDto = new GuideOperateDto(id, new ArrayList<>(includeIds), 1);
            operate(guideOperateDto, userId);
        }
        return resultMap;
    }
    private List<JSONObject> searchWithSynonymCombination(Condition condition) {
        List<Disease> diseases = condition.getDiseases();

        List<JSONObject> guideList = new ArrayList<>();

        int currentRound = 0;

        // ✅ 获取每个疾病中 synonymMap 的 key 数量（排序后）
        List<Integer> lengths = diseases.stream().filter(o -> o.getStatus() == 1)
                .map(d -> {
                    List<String> keys = new ArrayList<>(d.getSynonymMap().keySet());
                    keys.sort((a, b) -> Integer.compare(b.length(), a.length()));
                    return keys.size();
                })
                .collect(Collectors.toList());

        IndexCombinationGenerator generator = new IndexCombinationGenerator(lengths);

        while (generator.hasNext()) {
            List<Integer> indices = generator.next();
            currentRound++;

            List<String> handledDrugToSynonymForSearch = handleDrugToSynonymForSearch(condition.getDrugs());
            List<String> handleDiseaseToSynonymForSearch = handleDiseaseToSynonymForCustomer(condition, indices);


            NativeSearchQuery nativeSearchQuery;

            BoolQueryBuilder guideQuery = new BoolQueryBuilder();
            guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));
            guideQuery.mustNot().add(QueryBuilders.termQuery("isPaper", 1));

            // 年份
            String startSearchYear;
            String endSearchYear;
            String guideStartYear = condition.getGuideStartYear();
            String guideEndYear = condition.getGuideEndYear();
            guideQuery.must().add(QueryBuilders.rangeQuery("fbdate").gte(guideStartYear + "-00-00"));
            guideQuery.must().add(QueryBuilders.rangeQuery("fbdate").lte(guideEndYear + "-12-30 24:00:00"));

            BoolQueryBuilder guideConditionQuery = QueryUtils.createGuideQuery(condition);
            guideQuery.must().add(guideConditionQuery);
            // 构建 function_score 查询
            FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[2];
            String scriptStr = "double baseScore = Math.log1p(_score + 1) * 0.5; " +
                    "String name = doc['name'].value; " +
                    "if (name != null && name.indexOf('联合') >= 0) { " +
                    "    return baseScore * 0.5; " +
                    "} " +
                    "return baseScore;";
            Script script = new Script(scriptStr);
            ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
            FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
            filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
            filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
            FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
            functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
            functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
            nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
            nativeSearchQuery.setMaxResults(30);
            nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
            SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
            List<SearchHit<GuideIndex>> guideSearchHits = search.getSearchHits();
            if (guideSearchHits.size() > 15) {
                guideSearchHits = guideSearchHits.subList(0, 15);
            }

            List<CompletableFuture<Void>> futures = new ArrayList<>();
            ExecutorService executorService = Executors.newFixedThreadPool(6);
            List<JSONObject> finalGuideList = new ArrayList<>();
            for (SearchHit<GuideIndex> guideSearchHit : guideSearchHits) {
                GuideIndex guideContent = guideSearchHit.getContent();
                String finalMedicine = condition.getDrugs().stream().filter(drug -> drug.getStatus() == 1).map(Drug::getWord).collect(Collectors.joining("联合"));
                String finalDisease = condition.getDiseases().stream().filter(disease -> disease.getStatus() == 1).map(Disease::getWord).collect(Collectors.joining("合并"));
                futures.add(CompletableFuture.runAsync(() -> {
                    try {
                        assembleGuide(guideContent, finalGuideList, finalMedicine, finalDisease, -1, handledDrugToSynonymForSearch, handleDiseaseToSynonymForSearch);
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
                if (!executorService.awaitTermination(100, TimeUnit.SECONDS)) {
                    executorService.shutdownNow();
                }
            } catch (InterruptedException e) {
                executorService.shutdownNow();
                Thread.currentThread().interrupt();
            }

            guideList.addAll(finalGuideList);

            if (guideList.size() >= 10) {
                log.info("指南 --- 已收集到{}条结果，提前退出组合遍历", guideList.size());
                break;
            }

//            BoolQueryBuilder guideBlockQuery = QueryUtils.createGuideBlockQuery(condition, indices);
//            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(guideBlockQuery);
//            nativeSearchQuery.setMaxResults(120);
//            SearchHits<GuideBlockIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideBlockIndex.class);
//            Map<String, String> dataMap = getStringStringMap(search);
//
//            // 查找block 块中含有药的
//            BoolQueryBuilder guideBlockQueryInDrug = QueryUtils.createGuideBlockQueryInDrug(condition, indices);
//            NativeSearchQuery nativeSearchQueryInDrug = new NativeSearchQuery(guideBlockQueryInDrug);
//            nativeSearchQueryInDrug.setMaxResults(120);
//            SearchHits<GuideBlockIndex> searchInDrug = elasticsearchRestTemplate.search(nativeSearchQueryInDrug, GuideBlockIndex.class);
//            // 过滤 标题中需要含有病的
//            Map<String, String> dataMapInDrug = getStringStringMap(searchInDrug);
//            filterGuideBlock(condition, dataMapInDrug, dataMap);
//
//            if (MapUtil.isNotEmpty(dataMap)) {
//                if (dataMap.size() > 100) dataMap = dataMap.entrySet().stream().limit(100).collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
//                filterGuide(dataMap, condition, guideList, 0, handledDrugToSynonymForSearch, handleDiseaseToSynonymForSearch);
//
//                if (guideList.size() < 20) {
//                    filterGuide(dataMap, condition, guideList, 1, handledDrugToSynonymForSearch, handleDiseaseToSynonymForSearch);
//                }
//
//                if (guideList.size() < 20) {
//                    filterGuide(dataMap, condition, guideList, 2, handledDrugToSynonymForSearch, handleDiseaseToSynonymForSearch);
//                }
//
//                if (guideList.size() < 20) {
//                    filterGuide(dataMap, condition, guideList, 3, handledDrugToSynonymForSearch, handleDiseaseToSynonymForSearch);
//                }
//            }

            log.info("指南 --- 第{}轮搜索完成，当前总数/第{}轮得到数量: {}/{}",
                    currentRound, currentRound, finalGuideList.size(), 10);
        }
        if (guideList.size() > 10) {
            guideList = guideList.subList(0, 10);
        }
        return guideList;
    }
    private void filterGuideBlock(Condition condition, Map<String, String> needFilterDataMap, Map<String, String> allDataMap) {
        for (Map.Entry<String, String> entry : needFilterDataMap.entrySet()) {
            String guideId = entry.getKey();

            BoolQueryBuilder guideSearchBool = new BoolQueryBuilder();
            guideSearchBool.must().add(QueryUtils.createGuideQueryInDisease(condition));
            guideSearchBool.must().add(QueryBuilders.idsQuery().addIds(guideId));
            guideSearchBool.must().add(QueryBuilders.termQuery("getFlag", 1));
            guideSearchBool.mustNot().add(QueryBuilders.termQuery("isPaper", 1));

            BoolQueryBuilder zdzBool = new BoolQueryBuilder();
            List<String> keywords = Arrays.asList("NCCN", "ASCO", "ESMO", "NICE", "WHO", "JSGO", "CCO");
            for (String keyword : keywords) {
                zdzBool.should().add(QueryBuilders.matchPhraseQuery("zdz", keyword));
            }
            zdzBool.minimumShouldMatch(1);
            guideSearchBool.must().add(zdzBool);

            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(guideSearchBool);
            SearchHit<GuideIndex> guideIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, GuideIndex.class);
            if (Objects.isNull(guideIndexSearchHit))  return;

            String block = entry.getValue();
            if (block.length() > 1000) {
                block = block.substring(0, 1000);
            }

            //增加逻辑如果为同一篇指南将文本块合并
            if (allDataMap.containsKey(guideId)) {
                String text = allDataMap.get(guideId);
                text = text + "\n" + block;
                allDataMap.put(guideId, text);
            } else {
                allDataMap.put(guideId, block);
            }
        }
    }
    private void filterGuide(Map<String, String> dataMap, Condition condition, List<JSONObject> guideList, int type, List<String> drugSynonym, List<String> diseaseSynonym) {
        List<CompletableFuture<Void>> futures = new ArrayList<>();

        ExecutorService executorService = Executors.newFixedThreadPool(6);
        List<String> guideIdUsed = new ArrayList<>();
        for (Map.Entry<String, String> entry : dataMap.entrySet()) {
            String finalMedicine = condition.getDrugs().stream().filter(drug -> drug.getStatus() == 1).map(Drug::getWord).collect(Collectors.joining("联合"));
            String finalDisease = condition.getDiseases().stream().filter(disease -> disease.getStatus() == 1).map(Disease::getWord).collect(Collectors.joining("合并"));
            futures.add(CompletableFuture.runAsync(() -> {
                try {
                    assembleGuide(entry, elasticsearchRestTemplate, guideList, finalMedicine, finalDisease, type, drugSynonym, diseaseSynonym, guideIdUsed);
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

        if (CollectionUtils.isNotEmpty(guideIdUsed)) {
            guideIdUsed.forEach(dataMap.keySet()::remove);
        }
    }
    
    private void assembleGuide(GuideIndex guideContent, List<JSONObject> guideList, String medicine, String disease, int type, List<String> drugSynonym, List<String> diseaseSynonym) {
//        if (guideList.size() > 20) {
//            return;
//        }
        String pdfTxt = guideContent.getPdf_txt();
        
        if (StringUtils.isBlank(pdfTxt))  return;

        boolean isUsed = false;
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("title", "");
        String title = guideContent.getTitle();
        String guideId = guideContent.getId();
        if (StringUtils.isNotBlank(title)) {
            switch (type) {
                case 0:
                    if (checkFullWordContain(title, drugSynonym) && checkFullWordContain(title, diseaseSynonym)) {
                        isUsed = true;
                    }
                    break;
                case 1:
                    if (checkFullWordContain(title, diseaseSynonym)) {
                        isUsed = true;
                    }
                    break;
                case 2:
                    if (checkFullWordContain(title, drugSynonym)) {
                        isUsed = true;
                    }
                    break;
                case 3:
                    isUsed = true;
                    break;
                default:
                    isUsed = true;
                    break;
            }

            if (isUsed) {
                jsonObject.put("id", guideId);
                jsonObject.put("title", title);
                sumUpBlock(pdfTxt, medicine, disease, guideList, jsonObject);
            }
        }
    }

    private void assembleGuide(Map.Entry<String, String> entry, ElasticsearchRestTemplate elasticsearchRestTemplate, List<JSONObject> guideList, String medicine, String disease, int type, List<String> drugSynonym, List<String> diseaseSynonym, List<String> guideIdUsed) {
        if (guideList.size() > 20) {
            return;
        }
        String guideId = entry.getKey();

        BoolQueryBuilder guideSearchBool = new BoolQueryBuilder();
        guideSearchBool.must().add(QueryBuilders.idsQuery().addIds(guideId));
        guideSearchBool.must().add(QueryBuilders.termQuery("getFlag", 1));
        guideSearchBool.mustNot().add(QueryBuilders.termQuery("isPaper", 1));
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(guideSearchBool);
        SearchHit<GuideIndex> guideIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, GuideIndex.class);
        if (Objects.isNull(guideIndexSearchHit))  return;

        boolean isUsed = false;
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("title", "");
        String title = guideIndexSearchHit.getContent().getTitle();
        if (StringUtils.isNotBlank(title)) {
            switch (type) {
                case 0:
                    if (checkFullWordContain(title, drugSynonym) && checkFullWordContain(title, diseaseSynonym)) {
                        isUsed = true;
                    }
                    break;
                case 1:
                    if (checkFullWordContain(title, diseaseSynonym)) {
                        isUsed = true;
                    }
                    break;
                case 2:
                    if (checkFullWordContain(title, drugSynonym)) {
                        isUsed = true;
                    }
                    break;
                case 3:
                    isUsed = true;
                    break;
                default:
                    isUsed = true;
                    break;
            }

            if (isUsed) {
                jsonObject.put("id", guideId);
                guideIdUsed.add(guideId);
                jsonObject.put("title", title);
                String block = entry.getValue();
                sumUpBlock(block, medicine, disease, guideList, jsonObject);
            }
        }
    }
    private void sumUpBlock(String block, String medicine, String disease, List<JSONObject> guideList, JSONObject jsonObject) {
        if(StringUtils.isNotBlank(block)) {

            String question_1 = String.format("请作为专业医学内容分析师，执行以下任务：\n" +
                    "1. 根据用户提供的资料，生成针对%s治疗%s的总结报告\n" +
                    "2. 判断原始资料与药品和疾病的相关性\n" +
                    "3. 以严格JSON格式返回结果，包含以下字段：\n" +
                    "   - summary：总结文本，控制在400字以内，直接切入主题\n" +
                    "   - relevance：布尔值，资料必须同时包含药品和疾病的具体关联证据才为true\n\n" +
                    "要求：\n" +
                    "- 保持医学专业性同时避免术语堆砌\n" +
                    "- 仅当资料明确包含药品和疾病的直接关联数据（如临床试验、药理机制等）时，relevance才为true\n" +
                    "- 彻底排除任何推测性内容和格式标签\n" +
                    "- 英文资料必须转化为中文表述\n\n" +
                    "资料内容：%s", medicine, disease, block);

//            String question_1 = String.format("请你作为一名内容整理专家，将用户提供的指南资料，将碎片化的内容转化为一段内容清晰的文本。\n " +
//                    "要求： " +
//                    "\n" +
//                    "1.总结内容请围绕提供的药品和研究疾病进行总结与论述。\n" +
//                    "2.总结文本的所有内容必须严格源于用户提供的数据，禁止额外添加信息、推测分析。\n" +
//                    "3.如果是英文数据，请使用中文进行总结，总结字符在400以内的内容。\n" +
//                    "4.总结信息开头不允许出现 `提供的资料`， `主要涉及`，这种类似 摘要、引言、结论句出现在开头部分。\n" +
//                    "药品：%s\n" +
//                    "研究疾病：%s\n" +
//                    "用户提供的资料：%s", medicine, disease, block);
            try {
                String summary = AIRequestUtils.dsStream(question_1, "deepseek-v3");
                log.info("总结内容为 {}", summary);
                if (StringUtils.isNotBlank(summary)) {
                    try {
                        int start = summary.indexOf('{');
                        int end = summary.lastIndexOf('}');
                        Gson gson = new Gson();
                        Type guideSummary = new TypeToken<JSONObject>(){}.getType();
                        JSONObject result = gson.fromJson(summary.substring(start, end + 1), guideSummary);
                        block = result.getString("summary");
                        Boolean relevance = result.getBoolean("relevance");
                        if (relevance) {
                            block = wiffOfContent(block, "\n\n", "\n");
                            jsonObject.put("block", block);
                            guideList.add(jsonObject);
                            log.info("指南纳入，当前数量为{}", guideList.size());
                        }
                        Thread.sleep(1000);
                    } catch (Exception e) {
                        log.error("总结guide block 出现问题{}", e.getMessage(), e);
                    }
                }
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }
        }
    }

    @Override
    public Boolean operate(GuideOperateDto guideOperateDto, Long userId) {
        String conditionId = guideOperateDto.getId();
        List<String> ids = guideOperateDto.getIds();
        //操作的命令，1-纳入；2-取消纳入；3-排除；4-取消排除；5-收藏；6-取消收藏
        Integer operate = guideOperateDto.getOperate();
        boolean flag = false;
        switch (operate) {
            case 2:
            case 4:
                DeleteResult deleteInclude = mongoTemplate.remove(new Query(Criteria.where("guideId").in(ids).and("userId").is(userId).and("conditionId").is(conditionId)), GuideIncludeOrExclude.class);
                flag = deleteInclude.getDeletedCount() > 0;
                break;
            case 6:
                DeleteResult deleteCollet = mongoTemplate.remove(new Query(Criteria.where("guideId").in(ids).and("userId").is(userId).and("conditionId").is(conditionId)), GuideCollect.class);
                flag = deleteCollet.getDeletedCount() > 0;
                break;
            case 1:
                boolean includeFlag1 = false;
                boolean includeFlag2 = false;
                List<GuideIncludeOrExclude> includeList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("guideId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    GuideIncludeOrExclude include = mongoTemplate.findOne(query, GuideIncludeOrExclude.class);
                    if (include != null){
                        Integer status = include.getStatus();
                        if (status == 2){
                            //修改为纳入
                            Update update = new Update();
                            update.set("status", 1);
                            update.set("timeStamp", System.currentTimeMillis());
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, GuideIncludeOrExclude.class);
                            includeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    }else {
                        includeList.add(new GuideIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 1, userId, System.currentTimeMillis()));
                    }
                }
                if (!includeList.isEmpty()) {
                    Collection<GuideIncludeOrExclude> insert = mongoTemplate.insert(includeList, GuideIncludeOrExclude.class);
                    if (CollectionUtils.isNotEmpty(insert)){
                        includeFlag2 = true;
                    }
                }
                if (includeFlag1 || includeFlag2) {
                    flag = true;
                }
                break;
            case 3:
                boolean excludeFlag1 = false;
                boolean excludeFlag2 = false;
                List<GuideIncludeOrExclude> excludeList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("guideId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    GuideIncludeOrExclude exclude = mongoTemplate.findOne(query, GuideIncludeOrExclude.class);
                    if (exclude != null){
                        Integer status = exclude.getStatus();
                        if (status == 1){
                            //修改为排除
                            Update update = new Update();
                            update.set("status", 2);
                            update.set("timeStamp", System.currentTimeMillis());
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, GuideIncludeOrExclude.class);
                            excludeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    }else {
                        excludeList.add(new GuideIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 2, userId, System.currentTimeMillis()));
                    }
                }
                if (!excludeList.isEmpty()){
                    Collection<GuideIncludeOrExclude> insert = mongoTemplate.insert(excludeList, GuideIncludeOrExclude.class);
                    if (CollectionUtils.isNotEmpty(insert)){
                        excludeFlag2 = true;
                    }
                }
                if (excludeFlag1 || excludeFlag2){
                    flag = true;
                }
                break;
            case 5:
                List<GuideCollect> collectList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("guideId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    boolean exists = mongoTemplate.exists(query, GuideCollect.class);
                    if (!exists){
                        collectList.add(new GuideCollect(UUID.randomUUID().toString(), conditionId, id, userId, System.currentTimeMillis()));
                    }
                }
                if (!collectList.isEmpty()){
                    Collection<GuideCollect> insert = mongoTemplate.insert(collectList, GuideCollect.class);
                    if (CollectionUtils.isNotEmpty(insert)){
                        flag = true;
                    }
                }
                break;
            default:
                break;
        }
        return flag;
    }
    
    public String wiffOfContent(String content, String oldChar, String newChar) {
        if (StrUtil.isBlank(content)) {
            return "";
        }
        content = content.replaceAll(oldChar, newChar);
        return content;
    }
    private static Map<String, String> getStringStringMap(SearchHits<GuideBlockIndex> search) {
        Map<String, String> dataMap = new HashMap<>();
        
        for (SearchHit<GuideBlockIndex> guideHit : search) {
            GuideBlockIndex content = guideHit.getContent();
            
            String block = content.getBlock();
            if (block.length() > 1000) {
                block = block.substring(0, 1000);
            }
            
            //增加逻辑如果为同一篇指南将文本块合并
            String guideId = content.getGuideId();
            if (dataMap.containsKey(guideId)) {
                String text = dataMap.get(guideId);
                text = text + "\n" + block;
                dataMap.put(guideId, text);
            } else {
                dataMap.put(guideId, block);
            }
        }
        return dataMap;
    }
    @Override
    public PageVo<GuideVo> showGuideCollect(Long userId, String searchWord, Integer pageSize, Integer pageNum) {
        List<GuideCollect> guideCollects = mongoTemplate.find(new Query(Criteria.where("userId").is(userId)), GuideCollect.class);
        List<String> ids = new ArrayList<>();
        guideCollects.forEach(guideCollect -> ids.add(guideCollect.getGuideId()));
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        boolQueryBuilder.must().add(QueryBuilders.idsQuery().addIds(ids.toArray(new String[0])));
        if (StringUtils.isNotBlank(searchWord)) {
            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(searchWord, "title", "nrjs", "pdf_txt");
            multiMatchQueryBuilder.operator(Operator.AND);
            multiMatchQueryBuilder.field("title", 24F);
            boolQueryBuilder.must().add(multiMatchQueryBuilder);
        }
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
        nativeSearchQuery.setPageable(PageRequest.of(pageNum - 1, pageSize));
        //高亮
        String preTag = "<b>";
        String postTag = "</b>";
        HighlightBuilder highlightBuilder = new HighlightBuilder();
        highlightBuilder.field("title");
        highlightBuilder.field("nrjs");
        highlightBuilder.preTags(preTag);
        highlightBuilder.postTags(postTag);
        highlightBuilder.fragmentSize(1024 * 10);
        highlightBuilder.numOfFragments(0);
        highlightBuilder.requireFieldMatch(false);
        nativeSearchQuery.setHighlightQuery(new HighlightQuery(highlightBuilder));
        //开始查询
        SearchHits<GuideIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
        List<GuideVo> list = new ArrayList<>();
        for (SearchHit<GuideIndex> searchHit : searchHits) {
            GuideIndex content = searchHit.getContent();
            //高亮
            List<String> titleList = searchHit.getHighlightField("title");
            List<String> nrjsList = searchHit.getHighlightField("nrjs");
            StringBuilder titleBuilder = new StringBuilder();
            StringBuilder nrjsBuilder = new StringBuilder();
            if (CollectionUtils.isNotEmpty(titleList)) {
                titleList.forEach(titleBuilder::append);
            }
            if (CollectionUtils.isNotEmpty(nrjsList)) {
                nrjsList.forEach(nrjsBuilder::append);
            }
            content.setTitle(StringUtils.isBlank(titleBuilder.toString()) ? content.getTitle() : highLight(titleBuilder.toString(), content.getTitle(), null, searchWord));
            content.setNrjs(StringUtils.isBlank(nrjsBuilder.toString()) ? content.getNrjs() : highLight(nrjsBuilder.toString(), content.getNrjs(), null, searchWord));
            GuideVo guideVo = FormatUtil.formatGuide(content);
            list.add(guideVo);
        }
        long totalHits = searchHits.getTotalHits();
        int pages = (int) (totalHits % pageSize == 0 ? totalHits / pageSize : totalHits / pageSize + 1);
        PageVo<GuideVo> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        return page;
    }
    private List<String> handleDiseaseToSynonym(List<Disease> diseases) {
        Set<String> set = new HashSet<>();
        for (Disease disease : diseases) {
            Integer status = disease.getStatus();
            if (status == 1){
                set.add(disease.getWord().toLowerCase());
                set.add(disease.getWord());

                String enWord = disease.getEnWord();
                if (StringUtils.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

                List<WordStatus> enSynonym = disease.getEnSynonym();
                if (CollectionUtils.isNotEmpty(enSynonym)){
                    for (WordStatus wordStatus : enSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                String zhWord = disease.getZhWord();
                if (StringUtils.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

                List<WordStatus> zhSynonym = disease.getZhSynonym();
                if (CollectionUtils.isNotEmpty(zhSynonym)){
                    for (WordStatus wordStatus : zhSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                List<WordStatus> otherSynonym = disease.getOtherSynonym();
                if (CollectionUtils.isNotEmpty(otherSynonym)){
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
                if (StringUtils.isNotBlank(expandSynonym)) {
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StringUtils.isNotBlank(txt)) {
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
                if (StringUtils.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

                List<WordStatus> enSynonym = drug.getEnSynonym();
                if (CollectionUtils.isNotEmpty(enSynonym)){
                    for (WordStatus wordStatus : enSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                String zhWord = drug.getZhWord();
                if (StringUtils.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

                List<WordStatus> zhSynonym = drug.getZhSynonym();
                if (CollectionUtils.isNotEmpty(zhSynonym)){
                    for (WordStatus wordStatus : zhSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                List<WordStatus> otherSynonym = drug.getOtherSynonym();
                if (CollectionUtils.isNotEmpty(otherSynonym)){
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
                if (StringUtils.isNotBlank(expandSynonym)) {
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StringUtils.isNotBlank(txt)) {
                            set.add(txt.toLowerCase());
                            set.add(txt);
                        }
                    }
                }
            }
        }

        if (CollectionUtils.isNotEmpty(set)) {
            set = set.stream().filter(s -> {
                boolean english = s.length() == s.getBytes().length;
                return !english || s.length() >= 2;
            }).collect(Collectors.toSet());
        }

        return new ArrayList<>(set);

    }
    private List<String> handleDrugToSynonymForSearch(List<Drug> drugs) {
        Set<String> set = new HashSet<>();
        for (Drug drug : drugs) {
            Integer status = drug.getStatus();
            if (status == 1){
                set.add(drug.getWord().toLowerCase());
                set.add(drug.getWord());

                String enWord = drug.getEnWord();
                enWord = enWord.replaceAll("([+'])", "\\\\$1");
                if (StringUtils.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

                List<WordStatus> enSynonym = drug.getEnSynonym();
                if (CollectionUtils.isNotEmpty(enSynonym)){
                    for (WordStatus wordStatus : enSynonym) {
                        String name = wordStatus.getName();
                        name = name.replaceAll("([+'])", "\\\\$1");
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                String zhWord = drug.getZhWord();
                zhWord = zhWord.replaceAll("([+'])", "\\\\$1");
                if (StringUtils.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

                List<WordStatus> zhSynonym = drug.getZhSynonym();
                if (CollectionUtils.isNotEmpty(zhSynonym)){
                    for (WordStatus wordStatus : zhSynonym) {
                        String name = wordStatus.getName();
                        name = name.replaceAll("([+'])", "\\\\$1");
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }

                List<WordStatus> otherSynonym = drug.getOtherSynonym();
                if (CollectionUtils.isNotEmpty(otherSynonym)){
                    for (WordStatus wordStatus : otherSynonym) {
                        String name = wordStatus.getName();
                        name = name.replaceAll("([+'])", "\\\\$1");
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            set.add(name);
                        }
                    }
                }


                //补充同义词
                String expandSynonym = drug.getExpandSynonym();
                if (StringUtils.isNotBlank(expandSynonym)) {
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StringUtils.isNotBlank(txt)) {
                            txt = txt.replaceAll("([+'])", "\\\\$1");
                            set.add(txt.toLowerCase());
                            set.add(txt);
                        }
                    }
                }
            }
        }

        if (CollectionUtils.isNotEmpty(set)) {
            set = set.stream().filter(s -> {
                boolean english = s.length() == s.getBytes().length;
                return !english || s.length() >= 2;
            }).map(str -> {
                if (StrUtil.contains(str,"*")) {
                    return str.replaceAll("\\*", "");
                }
                return str;
            }).collect(Collectors.toSet());
        }

        return new ArrayList<>(set);

    }
    private List<String> handleDiseaseToSynonymForCustomer(Condition condition, List<Integer> indices) {
        List<Disease> diseases = condition.getDiseases().stream().filter(o -> o.getStatus() == 1).collect(Collectors.toList());

        if (indices == null || indices.size() != diseases.stream().filter(o -> o.getStatus() == 1).count()) {
            throw new IllegalArgumentException("Indices size must match diseases size.");
        }

        Set<String> set = new HashSet<>();

        for (int i = 0; i < diseases.size(); i++) {

            Disease disease = diseases.get(i);

            String word = disease.getWord();
            Map<String, Set<String>> synonymMap = disease.getSynonymMap();

            if (MapUtil.isNotEmpty(synonymMap)) {
                // ✅ 按字符长度从长到短排序
                List<String> sortedKeys = new ArrayList<>(synonymMap.keySet());
                // 先移除 word
                sortedKeys.remove(word);
                // 按长度排序剩余的
                sortedKeys.sort((a, b) -> Integer.compare(b.length(), a.length()));
                // 将 word 插入到第一位
                sortedKeys.add(0, word);

                // ✅ 根据组合中当前疾病对应的索引取 key
                int index = indices.get(i) % sortedKeys.size();
                String key = sortedKeys.get(index);

                if (!key.equals(word)) {
                    set = synonymMap.get(key);
                } else {
                    set.add(word);

                    String enWord = disease.getEnWord();
                    if (StringUtils.isNotBlank(enWord)){
                        set.add(enWord.toLowerCase());
                        set.add(enWord);
                    }

                    String zhWord = disease.getZhWord();
                    if (StringUtils.isNotBlank(zhWord)){
                        set.add(zhWord.toLowerCase());
                        set.add(zhWord);
                    }

                    List<WordStatus> enSynonym = disease.getEnSynonym();
                    if (CollectionUtils.isNotEmpty(enSynonym)){
                        for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                            WordStatus wordStatus = enSynonym.get(i2);
                            String name = wordStatus.getName();
                            Boolean checked = wordStatus.getChecked();
                            if (checked) {
                                set.add(name.toLowerCase());
                                set.add(name);
                            }
                        }
                    }

                    List<WordStatus> zhSynonym = disease.getZhSynonym();
                    if (CollectionUtils.isNotEmpty(zhSynonym)){
                        for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                            WordStatus wordStatus = zhSynonym.get(i2);
                            String name = wordStatus.getName();
                            Boolean checked = wordStatus.getChecked();
                            if (checked) {
                                set.add(name.toLowerCase());
                                set.add(name);
                            }
                        }
                    }

                    List<WordStatus> otherSynonym = disease.getOtherSynonym();
                    if (CollectionUtils.isNotEmpty(otherSynonym)){
                        for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                            WordStatus wordStatus = otherSynonym.get(i2);
                            String name = wordStatus.getName();
                            Boolean checked = wordStatus.getChecked();
                            if (checked) {
                                set.add(name.toLowerCase());
                                set.add(name);
                            }
                        }
                    }

                    //补充同义词
                    String expandSynonym = disease.getExpandSynonym();
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StringUtils.isNotBlank(txt)) {
                            set.add(txt.toLowerCase());
                            set.add(txt);
                        }
                    }

//                    // 增加商品名
//                    JSONArray commodityNames = entity.getJSONArray("commodityNames");
//                    if (CollectionUtils.isNotEmpty(commodityNames)) {
//                        set.addAll(commodityNames.stream().map(String::valueOf).distinct().collect(Collectors.toList()));
//                    }
//
//                    // 药品表中 五级同义词
//                    JSONArray zhDrugNames = entity.getJSONArray("zhDrugNames");
//                    if (CollectionUtils.isNotEmpty(zhDrugNames)) {
//                        set.addAll(zhDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
//                    }
//                    JSONArray enDrugNames = entity.getJSONArray("enDrugNames");
//                    if (CollectionUtils.isNotEmpty(enDrugNames)) {
//                        set.addAll(enDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
//                    }


                    List<String> expandedWords = disease.getExpandedWords();
                    if (CollectionUtils.isNotEmpty(expandedWords)) {
                        set.addAll(expandedWords.stream().distinct().map(String::valueOf).map(String::toLowerCase).collect(Collectors.toSet()));
                    }
                }
            }
        }

        return new ArrayList<>(set);
    }
    private void manageHighlight(SearchHit<GuideIndex> searchHit, GuideIndex content, List<String> stopWord, Condition condition, GuideSearchDto guideSearchDto) {
        //高亮
        List<String> titleList = searchHit.getHighlightField("title");
        List<String> nrjsList = searchHit.getHighlightField("nrjs");
        StringBuilder titleBuilder = new StringBuilder();
        StringBuilder nrjsBuilder = new StringBuilder();
        if (CollectionUtils.isNotEmpty(titleList)) {
            titleList.forEach(titleBuilder::append);
        }
        if (CollectionUtils.isNotEmpty(nrjsList)) {
            nrjsList.forEach(nrjsBuilder::append);
        }
        content.setTitle(StringUtils.isBlank(titleBuilder.toString()) ? content.getTitle() : highLight(HighLightUtils.repairContent(titleBuilder.toString(), content.getTitle(), stopWord), content.getTitle(), condition, guideSearchDto.getSearch()));
        content.setNrjs(StringUtils.isBlank(nrjsBuilder.toString()) ? content.getNrjs() : highLight(HighLightUtils.repairContent(nrjsBuilder.toString(), content.getNrjs(), stopWord), content.getNrjs(), condition, guideSearchDto.getSearch()));
    }
    public static boolean checkFullWordContain(String text, List<String> synonym) {
        boolean match = false;

        text = text.replaceAll("\n", "");
        boolean chinese = text.matches(".*[一-\u9fff].*");
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
