package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.mongodb.client.result.DeleteResult;
import com.mongodb.client.result.UpdateResult;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.dto.*;
import com.sentum.evidencecomprehensive.domain.mongo.*;
import com.sentum.evidencecomprehensive.domain.vo.req.GuideInitialRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.GuideSearchRequest;
import com.sentum.evidencecomprehensive.domain.es.GuideIndex;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;
import com.sentum.evidencecomprehensive.domain.vo.resp.GuideResponse;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.service.GuideService;
import com.sentum.evidencecomprehensive.service.RetrievalService;
import com.sentum.evidencecomprehensive.service.adapter.SynonymGenerateAdapter;
import com.sentum.evidencecomprehensive.utils.*;
import com.sentum.evidencecomprehensive.utils.operateyl.AIRequestUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.DefaultIncludeUtils;
import lombok.extern.slf4j.Slf4j;
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

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Slf4j
@Service
public class GuideServiceImpl implements GuideService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private DefaultIncludeUtils defaultIncludeUtils;
    @Autowired
    private RetrievalService retrievalService;

    @Override
    public JSONObject initial(GuideInitialRequest guideInitialRequest) {
        Condition condition = mongoTemplate.findById(guideInitialRequest.getId(), Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        
        GuideConditionDTO guideConditionDTO = guideInitialRequest.getGuideConditionDTO();
        if (StrUtil.isNotBlank(guideConditionDTO.getCondition())) {
            condition.setGuideWipeDiseases(null);
            alterCondition(guideConditionDTO, condition);
        }
        
        JSONObject result = new JSONObject();
        JSONArray zdz = new JSONArray();
        BoolQueryBuilder guideQuery = QueryBuilders.boolQuery();
        
        Integer operateType = guideInitialRequest.getOperateType();
        if (operateType == 1) {
            List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(guideInitialRequest.getId()).and("status").is(1)), GuideIncludeOrExclude.class);
            guideQuery.must().add(QueryBuilders.idsQuery().addIds(guideIncludeOrExcludes.stream().map(GuideIncludeOrExclude::getGuideId).toArray(String[]::new)));
        } else {
            BoolQueryBuilder guideConditionQuery = QueryUtils.createGuideQuery(condition);
//        condition.setDrugs(new ArrayList<>());
            guideQuery.must().add(guideConditionQuery);

            guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));
            guideQuery.mustNot().add(QueryBuilders.termQuery("isPaper", 1));

            String guideStartYear = condition.getGuideStartYear();
            String guideEndYear = condition.getGuideEndYear();
            RangeQueryBuilder ysarRangeQueryBuilder = QueryBuilders.rangeQuery("ysar");
            if (StrUtil.isNotBlank(guideStartYear)) {
                ysarRangeQueryBuilder.gte(guideStartYear);
            }
            if (StrUtil.isNotBlank(guideEndYear)) {
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
        
        NativeSearchQuery nativeSearchQuery= new NativeSearchQuery(guideQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("zdz").field("zdz.keyword").size(200);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
        Aggregations aggregations = search.getAggregations();
        if (aggregations != null){
            Aggregation aggregation = aggregations.get("zdz");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                String key = bucket.getKey().toString();
                if (StrUtil.isNotBlank(key)) {
                    // 存放制定者
                    Map<String, Long> map = new HashMap<>();
                    long docCount = bucket.getDocCount();
                    map.put(key, docCount);
                    zdz.add(map);
                }
            }
        }
        result.put("zdz", zdz);
        // 条件回显
        result.put("echo", condition.getGuideEchoData());
        return result;
    }
    
    @Override
    public PageVo<GuideResponse> list(GuideSearchRequest guideSearchRequest, Long userId) {
        String id = guideSearchRequest.getId();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        BoolQueryBuilder guideQuery = QueryBuilders.boolQuery();
        Integer operateType = guideSearchRequest.getOperateType();
        if (operateType == 1) {
            List<GuideIncludeOrExclude> guideIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("status").is(1)), GuideIncludeOrExclude.class);
            guideQuery.must().add(QueryBuilders.idsQuery().addIds(guideIncludeOrExcludes.stream().map(GuideIncludeOrExclude::getGuideId).toArray(String[]::new)));
        }
        // 条件查询组装
        NativeSearchQuery nativeSearchQuery = buildSearchCondition(guideSearchRequest, guideQuery, condition);
        //开始查询
        SearchHits<GuideIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
        List<GuideResponse> list = new ArrayList<>();
        Object objectStopWord = RedisUtil.redis.opsForValue().get("jieba_word");
        List<String> stopWord = ObjectToListUtil.objToList(objectStopWord, String.class);
        for (SearchHit<GuideIndex> searchHit : searchHits) {
            GuideIndex content = searchHit.getContent();
            // 高亮处理
            manageHighlight(searchHit, content, stopWord, condition, guideSearchRequest);
            // 组装返回参数
            GuideResponse guideResponse = FormatUtil.formatGuide(content);
            // 判断纳入、排除、收藏情况
            Criteria criteria = Criteria.where("guideId").is(content.getId()).and("userId").is(userId).and("conditionId").is(guideSearchRequest.getId());
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
        int pages = (int) (totalHits % guideSearchRequest.getPageSize() == 0 ? totalHits / guideSearchRequest.getPageSize() : totalHits / guideSearchRequest.getPageSize() + 1);
        PageVo<GuideResponse> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(guideSearchRequest.getPageSize());
        page.setPageNum(guideSearchRequest.getPageNum());
        return page;
    }

    private void manageHighlight(SearchHit<GuideIndex> searchHit, GuideIndex content, List<String> stopWord, Condition condition, GuideSearchRequest guideSearchRequest) {
        //高亮
        List<String> titleList = searchHit.getHighlightField("title");
        List<String> nrjsList = searchHit.getHighlightField("nrjs");
        StringBuilder titleBuilder = new StringBuilder();
        StringBuilder nrjsBuilder = new StringBuilder();
        if (CollUtil.isNotEmpty(titleList)) {
            titleList.forEach(titleBuilder::append);
        }
        if (CollUtil.isNotEmpty(nrjsList)) {
            nrjsList.forEach(nrjsBuilder::append);
        }
        content.setTitle(StringUtils.isBlank(titleBuilder.toString()) ? content.getTitle() : highLight(HighLightUtils.repairContent(titleBuilder.toString(), content.getTitle(), stopWord), content.getTitle(), condition, guideSearchRequest.getSearch()));
        content.setNrjs(StringUtils.isBlank(nrjsBuilder.toString()) ? content.getNrjs() : highLight(HighLightUtils.repairContent(nrjsBuilder.toString(), content.getNrjs(), stopWord), content.getNrjs(), condition, guideSearchRequest.getSearch()));
    }

    private NativeSearchQuery buildSearchCondition(GuideSearchRequest guideSearchRequest, BoolQueryBuilder guideQuery, Condition condition) {
        NativeSearchQuery nativeSearchQuery;
        
        guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));
//        guideQuery.mustNot().add(QueryBuilders.termQuery("isPaper", 1));
        guideQuery.must().add(QueryBuilders.termsQuery("isPaper", "0", "1"));
        
        //语言类型
        Integer language = guideSearchRequest.getLanguage();
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
        List<String> authors = guideSearchRequest.getAuthors();
        if (CollUtil.isNotEmpty(authors)) {
            guideQuery.must().add(QueryBuilders.termsQuery("zdz.keyword", authors));
        }
        
        // 年份
        String startSearchYear;
        String endSearchYear;
        String guideStartYear = condition.getGuideStartYear();
        String guideEndYear = condition.getGuideEndYear();
        Integer startYear = guideSearchRequest.getStartYear();
        if (startYear != null) {
            if (startYear >= Integer.parseInt(guideStartYear) && startYear <= Integer.parseInt(guideEndYear)) {
                startSearchYear = startYear.toString();
            } else {
                startSearchYear = guideStartYear;
            }
        } else {
            startSearchYear = guideStartYear;
        }
        Integer endYear = guideSearchRequest.getEndYear();
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
        if (startSearchYear == null) startSearchYear = "1900";
        if (endSearchYear == null) endSearchYear = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyy"));
        guideQuery.must().add(QueryBuilders.rangeQuery("fbdate").gte(startSearchYear + "-00-00"));
        guideQuery.must().add(QueryBuilders.rangeQuery("fbdate").lte(endSearchYear + "-12-30 24:00:00"));

        //二次搜索条件
        String search = guideSearchRequest.getSearch();
        if (StringUtils.isNotBlank(search)) {
            BoolQueryBuilder searchBool = new BoolQueryBuilder();
            searchBool.should().add(QueryBuilders.matchPhraseQuery("title", search));
            searchBool.should().add(QueryBuilders.matchPhraseQuery("nrjs", search));
            searchBool.should().add(QueryBuilders.matchPhraseQuery("fbdate", search));
            searchBool.should().add(QueryBuilders.matchPhraseQuery("zdz", search));
            guideQuery.must().add(searchBool);
        }
        
        //排序-分页
        Integer sortType = guideSearchRequest.getSortType();
        Integer sortDirection = guideSearchRequest.getSortDirection();
        PageRequest pageRequest = PageRequest.of(guideSearchRequest.getPageNum() - 1, guideSearchRequest.getPageSize());
        if (sortType == 1){
            //发布时间
            Sort.Direction direction = Sort.Direction.ASC;
            if (sortDirection == 0) {
                direction = Sort.Direction.DESC;
            }
            pageRequest = PageRequest.of(guideSearchRequest.getPageNum() - 1, guideSearchRequest.getPageSize(), Sort.by(direction, "dateTs"));
        } else if (sortType == 0) {
            pageRequest = PageRequest.of(guideSearchRequest.getPageNum() - 1, guideSearchRequest.getPageSize());
        }

        BoolQueryBuilder guideConditionQuery;
        ConditionGuideAlter conditionGuideAlter = condition.getConditionGuideAlter();
        if (Objects.nonNull(conditionGuideAlter)) {
            guideConditionQuery = QueryUtils.createGuideQuery(conditionGuideAlter);
        } else {
            guideConditionQuery = QueryUtils.createGuideQuery(condition);
        }
        guideQuery.must().add(guideConditionQuery);
        
        if (guideSearchRequest.getSortType() == 0) {
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
        highlightBuilder.numOfFragments(10);
        highlightBuilder.requireFieldMatch(true);
        nativeSearchQuery.setHighlightQuery(new HighlightQuery(highlightBuilder));
        
        return nativeSearchQuery;
    }



    @Override
    public Boolean operate(OperateRequest OperateRequest, Long userId) {
        String conditionId = OperateRequest.getId();
        List<String> ids = OperateRequest.getIds();
        //操作的命令，1-纳入；2-取消纳入；3-排除；4-取消排除；5-收藏；6-取消收藏
        Integer operate = OperateRequest.getOperate();
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
                if (includeList.size() > 0) {
                    Collection<GuideIncludeOrExclude> insert = mongoTemplate.insert(includeList, GuideIncludeOrExclude.class);
                    if (CollUtil.isNotEmpty(insert)){
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
                if (excludeList.size() > 0){
                    Collection<GuideIncludeOrExclude> insert = mongoTemplate.insert(excludeList, GuideIncludeOrExclude.class);
                    if (CollUtil.isNotEmpty(insert)){
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
                    if (CollUtil.isNotEmpty(insert)){
                        flag = true;
                    }
                }
                break;
            default:
                break;
        }
        return flag;
    }

    @Override
    public Boolean defaultInclusion(String id, Long userId) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        List<String> drugs = new ArrayList<>();
        List<String> diseases = new ArrayList<>();
        List<Drug> drugList = condition.getDrugs();
        for (Drug drug : drugList) {
            String word = drug.getWord();
            drugs.add(word);
            String enWord = drug.getEnWord();
            if (StringUtils.isNotBlank(enWord)) {
                drugs.add(enWord);
            }
            List<WordStatus> enSynonym = drug.getEnSynonym();
            if (CollUtil.isNotEmpty(enSynonym)) {
                for (WordStatus wordStatus : enSynonym) {
                    if (wordStatus.getChecked()) {
                        drugs.add(wordStatus.getName());
                    }
                }
            }
            String zhWord = drug.getZhWord();
            if (StringUtils.isNotBlank(zhWord)) {
                drugs.add(zhWord);
            }
            List<WordStatus> zhSynonym = drug.getZhSynonym();
            if (CollUtil.isNotEmpty(zhSynonym)) {
                for (WordStatus wordStatus : zhSynonym) {
                    if (wordStatus.getChecked()) {
                        drugs.add(wordStatus.getName());
                    }
                }
            }
            String expandSynonym = drug.getExpandSynonym();
            if (StringUtils.isNotBlank(expandSynonym)) {
                expandSynonym = expandSynonym.replaceAll("；", ";");
                String[] expandSynonymSplit = expandSynonym.split(";");
                for (String txt : expandSynonymSplit) {
                    if (StringUtils.isNotBlank(txt)) {
                        drugs.add(txt.toLowerCase());
                    }
                }
            }
        }
        List<Disease> diseaseList = condition.getDiseases();
        if (CollUtil.isNotEmpty(diseaseList)) {
            for (Disease disease : diseaseList) {
                String word = disease.getWord();
                diseases.add(word);
                String enWord = disease.getEnWord();
                if (StringUtils.isNotBlank(enWord)) {
                    diseases.add(enWord);
                }
                List<WordStatus> enSynonym = disease.getEnSynonym();
                if (CollUtil.isNotEmpty(enSynonym)) {
                    for (WordStatus wordStatus : enSynonym) {
                        if (wordStatus.getChecked()) {
                            diseases.add(wordStatus.getName());
                        }
                    }
                }
                String zhWord = disease.getZhWord();
                if (StringUtils.isNotBlank(zhWord)) {
                    diseases.add(zhWord);
                }
                List<WordStatus> zhSynonym = disease.getZhSynonym();
                if (CollUtil.isNotEmpty(zhSynonym)) {
                    for (WordStatus wordStatus : zhSynonym) {
                        if (wordStatus.getChecked()) {
                            diseases.add(wordStatus.getName());
                        }
                    }
                }

                List<WordStatus> otherSynonym = disease.getOtherSynonym();
                if (CollUtil.isNotEmpty(otherSynonym)){
                    for (WordStatus wordStatus : otherSynonym) {
                        String name = wordStatus.getName();
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            diseases.add(name);
                        }
                    }
                }

                String expandSynonym = disease.getExpandSynonym();
                if (StringUtils.isNotBlank(expandSynonym)) {
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] expandSynonymSplit = expandSynonym.split(";");
                    for (String txt : expandSynonymSplit) {
                        if (StringUtils.isNotBlank(txt)) {
                            diseases.add(txt.toLowerCase());
                        }
                    }
                }
            }
        }        
        
        List<String> ids = new ArrayList<>();
        BoolQueryBuilder guideQuery = QueryUtils.createGuideQuery(condition);
        guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(guideQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        long count = elasticsearchRestTemplate.count(nativeSearchQuery, GuideIndex.class);
        log.info("指南默认纳入查询{}篇", count);
        int num = (int) (count%20==0?count/20:count/20+1);
        for (int i = 0; i < num; i++) {
            nativeSearchQuery.setPageable(PageRequest.of(i, 20));
            SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
            for (SearchHit<GuideIndex> guideIndexSearchHit : search) {
                GuideIndex content = guideIndexSearchHit.getContent();
                String pdfTxt = content.getPdf_txt();
                List<String> mainGuideInfo = getMainGuideInfo(pdfTxt, drugs, diseases);
                if (CollUtil.isNotEmpty(mainGuideInfo)) {
                    ids.add(content.getId());
                    if (ids.size() >= 5) {
                        break;
                    }
                }
            }
        }
        //补齐5篇的逻辑
        /*if (ids.size() < 5) {
            if (CollUtil.isNotEmpty(ids)) {
                guideQuery.mustNot().add(QueryBuilders.idsQuery().addIds(ids.toArray(new String[0])));
            }
            NativeSearchQuery innerNative = new NativeSearchQuery(guideQuery);
            innerNative.setPageable(PageRequest.of(0, 5 - ids.size()));
            SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(innerNative, GuideIndex.class);
            search.forEach(guideIndexSearchHit -> ids.add(guideIndexSearchHit.getId()));
        }*/
        if (CollUtil.isNotEmpty(ids)) {
            OperateRequest OperateRequest = new OperateRequest(id, ids, 1);
            operate(OperateRequest, userId);
            return true;
        }
        return false;
    }

    @Override
    public PageVo<GuideResponse> showGuideCollect(Long userId, String searchWord, Integer pageSize, Integer pageNum) {
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
        List<GuideResponse> list = new ArrayList<>();
        Object objectStopWord = RedisUtil.redis.opsForValue().get("jieba_word");
        List<String> repairContent = ObjectToListUtil.objToList(objectStopWord, String.class);
        for (SearchHit<GuideIndex> searchHit : searchHits) {
            GuideIndex content = searchHit.getContent();
            //高亮
            List<String> titleList = searchHit.getHighlightField("title");
            List<String> nrjsList = searchHit.getHighlightField("nrjs");
            StringBuilder titleBuilder = new StringBuilder();
            StringBuilder nrjsBuilder = new StringBuilder();
            if (CollUtil.isNotEmpty(titleList)) {
                titleList.forEach(titleBuilder::append);
            }
            if (CollUtil.isNotEmpty(nrjsList)) {
                nrjsList.forEach(nrjsBuilder::append);
            }
            content.setTitle(StringUtils.isBlank(titleBuilder.toString()) ? content.getTitle() : HighLightUtils.repairContent(titleBuilder.toString(), content.getTitle(), repairContent));
            content.setNrjs(StringUtils.isBlank(nrjsBuilder.toString()) ? content.getNrjs() : HighLightUtils.repairContent(nrjsBuilder.toString(), content.getNrjs(), repairContent));
            GuideResponse guideResponse = FormatUtil.formatGuide(content);
            list.add(guideResponse);
        }
        long totalHits = searchHits.getTotalHits();
        int pages = (int) (totalHits % pageSize == 0 ? totalHits / pageSize : totalHits / pageSize + 1);
        PageVo<GuideResponse> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(pageSize);
        page.setPageNum(pageNum);
        return page;
    }

    /**
     * 根据药品和疾病获取指南中重要的信息数据
     * @param pdfTxt 指南原文
     * @param drugNames 药品名称及其同义词
     * @param diseases 疾病名称及其同义词
     * @return 获取到的指南的关键性信息
     */
    public List<String> getMainGuideInfo(String pdfTxt, List<String> drugNames, List<String> diseases){
        Set<String> resultSet = new HashSet<>();
        List<String> realDrugs = new ArrayList<>();
        List<String> realDiseases = new ArrayList<>();

        drugNames.forEach(drug -> {
            if (StringUtils.isNotBlank(drug)) {
                Pattern pattern = Pattern.compile(Pattern.quote(drug));
                Matcher matcher = pattern.matcher(pdfTxt);
                while (matcher.find()) {
                    String group = matcher.group();
                    realDrugs.add(group);
                }
            }
        });

        diseases.forEach(disease -> {
            if (StringUtils.isNotBlank(disease)) {
                Pattern pattern = Pattern.compile(Pattern.quote(disease));
                Matcher matcher = pattern.matcher(pdfTxt);
                while (matcher.find()) {
                    String group = matcher.group();
                    if (StrUtil.isNotBlank(group)) {
                        realDiseases.add(group);
                    }
                }
            }
        });

        String innerTxt = pdfTxt;
        String drugInnerTxt = pdfTxt;
        for (String realDrug : realDrugs) {
            int indexOf1 = innerTxt.indexOf(realDrug);

            for (String realDisease : realDiseases) {
                int indexOf2 = innerTxt.indexOf(realDisease);
                if (indexOf2 == -1){
                    continue;
                }
                int maxIndex = Math.max(indexOf1, indexOf2);
                int minIndex = Math.min(indexOf1, indexOf2);
                int abs = maxIndex - minIndex;
                //System.out.printf("indexOf1={%s}，indexOf2={%s}，abs={%s}", indexOf1, indexOf2, abs);
                //System.out.println();
                if (abs > 150) {
                    //将indexOf2破坏掉
                    String innerTxt1 = innerTxt.substring(indexOf2 + 1);
                    String innerTxt2 = innerTxt.substring(0, indexOf2);
                    innerTxt = innerTxt2 + "@" + innerTxt1;
                    continue;
                }
                if (minIndex > 150) {
                    minIndex = minIndex - 150;
                }
                if (maxIndex + 150 < innerTxt.length()) {
                    maxIndex = maxIndex + 150;
                }
                //将原有结构破坏掉
                String txt;
                try {
                    txt = pdfTxt.substring(minIndex, maxIndex);
                } catch (Exception e) {
                    continue;
                }
                resultSet.add(txt);
                String innerTxt1 = innerTxt.substring(indexOf2 + 1);
                String innerTxt2 = innerTxt.substring(0, indexOf2);
                innerTxt = innerTxt2 + "@" + innerTxt1;
            }
            //System.out.println("----------------------------------------------");
            //药品检索结束后破坏药品名称 将indexOf1破坏掉
            if (indexOf1 == -1){
                continue;
            }
            String innerTxt1 = drugInnerTxt.substring(indexOf1 + 1);
            String innerTxt2 = drugInnerTxt.substring(0, indexOf1);
            drugInnerTxt = innerTxt2 + "@" + innerTxt1;
            innerTxt = drugInnerTxt;
        }
        return new ArrayList<>(resultSet);
    }

    /**
     * 根据药品和疾病获取指南中重要的信息数据
     * @param pdfTxt 指南原文
     * @param drugNames 药品名称及其同义词
     * @param diseases 疾病名称及其同义词
     * @return 获取到的指南的关键性信息
     */
    public List<String> getGuideInfo(String pdfTxt, List<String> drugNames, List<String> diseases){
        Set<String> resultSet = new HashSet<>();
        List<String> realDrugs = new ArrayList<>();
        List<String> realDiseases = new ArrayList<>();

        drugNames.forEach(drug -> {
            if (StringUtils.isNotBlank(drug)) {
                Pattern pattern = Pattern.compile(Pattern.quote(drug));
                Matcher matcher = pattern.matcher(pdfTxt);
                while (matcher.find()) {
                    String group = matcher.group();
                    realDrugs.add(group);
                }
            }
        });

        diseases.forEach(disease -> {
            if (StringUtils.isNotBlank(disease)) {
                Pattern pattern = Pattern.compile(Pattern.quote(disease));
                Matcher matcher = pattern.matcher(pdfTxt);
                while (matcher.find()) {
                    String group = matcher.group();
                    if (StrUtil.isNotBlank(group)) {
                        realDiseases.add(group);
                    }
                }
            }
        });

        String innerTxt = pdfTxt;
        String drugInnerTxt = pdfTxt;
        for (String realDrug : realDrugs) {
            int indexOf1 = innerTxt.indexOf(realDrug);

            for (String realDisease : realDiseases) {
                int indexOf2 = innerTxt.indexOf(realDisease);
                if (indexOf2 == -1){
                    continue;
                }
                int maxIndex = Math.max(indexOf1, indexOf2);
                int minIndex = Math.min(indexOf1, indexOf2);
                int abs = maxIndex - minIndex;
                //System.out.printf("indexOf1={%s}，indexOf2={%s}，abs={%s}", indexOf1, indexOf2, abs);
                //System.out.println();
                if (abs > 150) {
                    //将indexOf2破坏掉
                    String innerTxt1 = innerTxt.substring(indexOf2 + 1);
                    String innerTxt2 = innerTxt.substring(0, indexOf2);
                    innerTxt = innerTxt2 + "@" + innerTxt1;
                    continue;
                }
                if (minIndex > 150) {
                    minIndex = minIndex - 150;
                }
                if (maxIndex + 150 < innerTxt.length()) {
                    maxIndex = maxIndex + 150;
                }
                //将原有结构破坏掉
                String txt;
                try {
                    txt = pdfTxt.substring(minIndex, maxIndex);
                } catch (Exception e) {
                    continue;
                }
                resultSet.add(txt);
                String innerTxt1 = innerTxt.substring(indexOf2 + 1);
                String innerTxt2 = innerTxt.substring(0, indexOf2);
                innerTxt = innerTxt2 + "@" + innerTxt1;
            }
            //System.out.println("----------------------------------------------");
            //药品检索结束后破坏药品名称 将indexOf1破坏掉
            if (indexOf1 == -1){
                continue;
            }
            String innerTxt1 = drugInnerTxt.substring(indexOf1 + 1);
            String innerTxt2 = drugInnerTxt.substring(0, indexOf1);
            drugInnerTxt = innerTxt2 + "@" + innerTxt1;
            innerTxt = drugInnerTxt;
        }
        return new ArrayList<>(resultSet);
    }

    private List<List<String>> assemblySynonym(Condition condition) {
        List<List<String>> wordList = new ArrayList<>();
        if (Objects.nonNull(condition)) {
            List<Drug> drugs = condition.getDrugs();
            if (CollUtil.isNotEmpty(drugs)) {
                for (Drug drug : drugs) {
                    List<String> currList = new ArrayList<>();
                    String word = drug.getWord();
                    String zhWord = drug.getZhWord();
                    List<WordStatus> zhSynonym = drug.getZhSynonym();
                    String enWord = drug.getEnWord();
                    List<WordStatus> enSynonym = drug.getEnSynonym();
                    String expandSynonym = drug.getExpandSynonym();
                    if (StrUtil.isNotBlank(word)) {
                        currList.add(word);
                    }
                    if (StrUtil.isNotBlank(zhWord)) {
                        currList.add(zhWord);
                    }
                    if (StrUtil.isNotBlank(enWord)) {
                        currList.add(enWord);
                    }
                    currList.addAll(zhSynonym.stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                    currList.addAll(enSynonym.stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                    currList.add(expandSynonym);
                    currList = currList.stream().filter(StrUtil::isNotBlank).distinct().collect(Collectors.toList()); // 去重判空
                    List<String> newCurrList = new ArrayList<>();
                    if (CollUtil.isNotEmpty(currList)) {
                        for (String s : currList) {
                            if (!s.startsWith("e")) {
                                newCurrList.add(s);
                            }
                        }
                    }
                    wordList.add(newCurrList);
                }
            }

            List<Disease> diseases = condition.getDiseases();
            if (CollUtil.isNotEmpty(diseases)) {
                for (Disease disease : diseases) {
                    List<String> currList = new ArrayList<>();
                    String word = disease.getWord();
                    String zhWord = disease.getZhWord();
                    List<WordStatus> zhSynonym = disease.getZhSynonym();
                    String enWord = disease.getEnWord();
                    List<WordStatus> enSynonym = disease.getEnSynonym();
                    String expandSynonym = disease.getExpandSynonym();
                    if (StrUtil.isNotBlank(word)) currList.add(word);
                    if (StrUtil.isNotBlank(zhWord)) currList.add(zhWord);
                    if (StrUtil.isNotBlank(enWord)) currList.add(enWord);
                    currList.addAll(zhSynonym.stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                    currList.addAll(enSynonym.stream().filter(WordStatus::getChecked).map(WordStatus::getName).collect(Collectors.toList()));
                    currList.add(expandSynonym);
                    currList = currList.stream().filter(StrUtil::isNotBlank).distinct().collect(Collectors.toList()); // 去重判空
                    wordList.add(currList);
                }
            }
        }
        return wordList;
    }    
    @Override
    public Boolean guidInclude(Condition condition, Long userId) {
        // 进行文献精筛 zgm 接口
        PaperAndGuideIncludeDTO guideIncludeDTO = new PaperAndGuideIncludeDTO();
        guideIncludeDTO.setScreenId(condition.getId());
        guideIncludeDTO.setSearchQuery(defaultIncludeUtils.createSearchQuery(condition));
        guideIncludeDTO.setQuery(QueryUtils.createGuideQuery(condition).toString());
        guideIncludeDTO.setWordList(assemblySynonym(condition));
        guideIncludeDTO.setType(2);
        guideIncludeDTO.setLanguage(null);
        guideIncludeDTO.setStatus(2);
        
        List<String> ids = defaultIncludeUtils.paperAndGuideInclude(guideIncludeDTO);
        log.info("指南默认纳入查询到{}篇", ids.size());
        JSONObject guideBlocks = defaultIncludeUtils.getGuideBlocks(condition.getId());
        
        String guideStartYear = "1000";
        if (StrUtil.isNotBlank(condition.getGuideStartYear())) {
            guideStartYear = condition.getGuideStartYear();
            if ("不限".equals(guideStartYear)) {
                guideStartYear = "1000";
            }
        }
        String guideEndYear = String.valueOf(LocalDate.now().getYear());
        if (StrUtil.isNotBlank(condition.getGuideEndYear())) {
            guideEndYear = condition.getGuideEndYear();
            if ("不限".equals(guideEndYear)) {
                guideEndYear = String.valueOf(LocalDate.now().getYear());
            }
        }
        
        JSONArray guideInfo = new JSONArray();
        if (CollUtil.isNotEmpty(ids)) {
            List<String> filterIds = new ArrayList<>();
            IdsQueryBuilder idsQueryBuilder = new IdsQueryBuilder();
            idsQueryBuilder.addIds(ids.toArray(new String[0]));
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
            nativeSearchQuery.setMaxResults(50);
            SearchHits<GuideIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, GuideIndex.class);
            List<SearchHit<GuideIndex>> searchHits = search.getSearchHits();
            for (SearchHit<GuideIndex> searchHit : searchHits) {
                JSONObject guide = new JSONObject();

                GuideIndex content = searchHit.getContent();
                try {
                    String year = content.getYsar();
                    if (StrUtil.isNotBlank(year)) {
                        if (!(Integer.parseInt(year) >= Integer.parseInt(guideStartYear) && Integer.parseInt(year) <= Integer.parseInt(guideEndYear))) {
                            continue;
                        }
                    }
                    guide.put("id", content.getId());
                    guide.put("title", content.getTitle());
                    guide.put("block", guideBlocks.getString(content.getId()));
                    guideInfo.add(guide);

                    filterIds.add(content.getId());
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            }
            log.info("指南默认纳入经过年份限制查询到{}篇", filterIds.size());
            List<String> finalIds = new ArrayList<>();
            String searchQuery = defaultIncludeUtils.createSearchQuery(condition);

            int circulCount = guideInfo.size() % 10 == 0 ? guideInfo.size() / 10 : guideInfo.size() / 10 + 1;
            for (int i = 0; i < circulCount; i++) {
                List<Object> guideInfoSub  =  i == circulCount - 1 ? guideInfo.subList(i * 10, guideInfo.size()) : guideInfo.subList(i * 10, i * 10 + 10);

                String question = "  请你作为一名专业的医学领域专家，非常的善于查找、总结指南/共识方面的内容。" +
                        "\n" +
                        "  请你根据提供的指南和指南的资料（指南与资料一一对应，有的指南可能未提供资料）进行如下的操作。" +
                        "\n" +
                        "  1、如果只提供了指南，首选请进行深度的搜索，找到该篇指南并对该篇指南的内容深度理解，找到是否有和"+ searchQuery +"相关的内容，如果有请对这部分进行细致的总结，如果没有相关的内容则需要淘汰该篇指南；" +
                        "\n" +
                        "  2、如果提供了指南标题和对应的资料，首选请进行深度的搜索，找到该篇指南并对该篇指南的内容深度理解，然和在结合提供的资料和该篇指南的全文内容，找到是否有和"+ searchQuery +"相关的内容，如果有请对这部分进行细致的总结，如果没有相关的内容则需要淘汰该篇指南；" +
                        "\n" +
                        "\n" +
                        "  最终的返回结果的指南的内容需要与" + searchQuery +"的相关性最高，返回数量不做限制，如果不相关请不要返回。" +
                        "\n" +
                        "\n" +
                        " `注意` 总结内容请使用中文进行回答\n" +
                        " `注意` 请将结果按照JSON格式返回，返回的JSON字段中只能有一个属性：result。`result指的是提供的资料中的id值，只能返回id，且可以返回多个id值，使用中文`-`进行连接`。\n" +
                        "\n" +
                        "\n" +
                        "  提供的资料（其中id为唯一标识（需要返回），title为指南标题，block为相应标题对应的资料）如下：{"+ JSON.toJSONString(guideInfoSub) + "}";

                try {
                    String resultAs = AIRequestUtils.modelStudio(question, Constants.QWEN3_235B_A22B_INSTRUCT_2507);

                    if (StrUtil.isNotBlank(resultAs)) {
                        int start = resultAs.indexOf('{');
                        int end = resultAs.lastIndexOf('}');
                        JSONObject obj = JSONObject.parseObject(resultAs.substring(start, end + 1));
                        String[] ids4oMini = obj.getString("result").split("-");

                        for (String id : ids4oMini) {
                            if (filterIds.contains(id)) {
                                finalIds.add(id);
                            }
                        }

                        String[] ids4o = obj.getString("result").split(";");
                        for (String id : ids4o) {
                            if (filterIds.contains(id)) {
                                finalIds.add(id);
                            }
                        }
                        finalIds = finalIds.stream().distinct().collect(Collectors.toList());
                    } 
                } catch (Exception e) {
                    log.error(e.getMessage(), e);
                }
            }
            log.info("指南默认纳入{}篇", finalIds.size());
            if (CollUtil.isNotEmpty(finalIds)) {
                OperateRequest OperateRequest = new OperateRequest(condition.getId(), finalIds, 1);
                operate(OperateRequest, userId);
                return true;
            }
        }
        return false;
    }

    @Override
    public List<Map<String, String>> secondGenerationInclude(Condition condition) {
        String guideStartYear = "1000";
        if (StrUtil.isNotBlank(condition.getGuideStartYear())) {
            guideStartYear = condition.getGuideStartYear();
            if ("不限".equals(guideStartYear)) {
                guideStartYear = "1000";
            }
        }
        String guideEndYear = String.valueOf(LocalDate.now().getYear());
        if (StrUtil.isNotBlank(condition.getGuideEndYear())) {
            guideEndYear = condition.getGuideEndYear();
            if ("不限".equals(guideEndYear)) {
                guideEndYear = String.valueOf(LocalDate.now().getYear());
            }
        }

        BoolQueryBuilder guideQuery = QueryBuilders.boolQuery();
        guideQuery.must().add(QueryBuilders.termQuery("getFlag", 1));

        BoolQueryBuilder guideQueryBool = QueryUtils.createGuideQuery(condition);
        List<String> drugSynonym = handleDrugToSynonym(condition.getDrugs());
        List<String> diseaseSynonym = handleDiseaseToSynonym(condition.getDiseases());
        ConditionGuideAlter conditionGuideAlter = condition.getConditionGuideAlter();
        if (Objects.nonNull(conditionGuideAlter)) {
            drugSynonym = handleDrugToSynonym(conditionGuideAlter.getDrugs());
            diseaseSynonym = handleDiseaseToSynonym(conditionGuideAlter.getDiseases());
            guideQueryBool = QueryUtils.createGuideQuery(conditionGuideAlter);
        }
        guideQuery.must().add(guideQueryBool);
       
        // 构建 function_score 查询
        FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[3];
        String scriptStr = "Math.log1p(_score + 1)*0.5";
        Script script = new Script(scriptStr);
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
        FieldValueFactorFunctionBuilder factorFunctionBuilder2 = new FieldValueFactorFunctionBuilder("allWeight");
        filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
        filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(factorFunctionBuilder2);
        Script script1 = new Script(buildScriptByDrugAndDisease(drugSynonym, diseaseSynonym));
        ScriptScoreFunctionBuilder scriptScoreFunctionBuilder1 = new ScriptScoreFunctionBuilder(script1);
        filterFunctionBuilders[2] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder1);
        
        FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
        functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
        functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
        NativeSearchQuery nativeSearchQuery;
        nativeSearchQuery = new NativeSearchQuery(guideQuery);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));

        List<Map<String, String>> guideInfo = new ArrayList<>();
        long mayIncludeCount = elasticsearchRestTemplate.count(nativeSearchQuery, GuideIndex.class);
        if (mayIncludeCount > 0) {
            int cycle = (int) (mayIncludeCount % 10 == 0 ? mayIncludeCount / 10 : mayIncludeCount / 10 + 1);
            if (cycle > 10) {
                cycle = 10;
            }
            for (int i = 0; i < cycle; i++) {
                NativeSearchQuery innerNativeSearchQuery;
                FunctionScoreQueryBuilder innerFunctionScoreQueryBuilder = QueryBuilders.functionScoreQuery(guideQuery, filterFunctionBuilders);
                innerFunctionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
                innerFunctionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
                innerNativeSearchQuery = new NativeSearchQuery(innerFunctionScoreQueryBuilder);
                innerNativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
                innerNativeSearchQuery.setPageable(PageRequest.of(i, 10));
                //开始查询
                SearchHits<GuideIndex> searchHits = elasticsearchRestTemplate.search(innerNativeSearchQuery, GuideIndex.class);
                for (SearchHit<GuideIndex> searchHit : searchHits.getSearchHits()) {
                    Map<String, String> guide = new HashMap<>();
                    GuideIndex content = searchHit.getContent();
                    try {
                        String year = content.getYsar();
                        if (StrUtil.isNotBlank(year)) {
                            year = year.trim();
                            if (!(Integer.parseInt(year) >= Integer.parseInt(guideStartYear) && Integer.parseInt(year) <= Integer.parseInt(guideEndYear))) {
                                continue;
                            }
                        }
                        guide.put("id", content.getId());
                        guide.put("title", content.getTitle());
                        guideInfo.add(guide);
                    } catch (Exception e) {
                        log.error(e.getMessage(), e);
                    }
                }
            }
        }
        return guideInfo;
    }


    private List<String> handleDiseaseToSynonym(List<Disease> diseases) {
        Set<String> set = new HashSet<>();
        for (Disease disease : diseases) {
            Integer status = disease.getStatus();
            if (status == 1){
                set.add(disease.getWord().toLowerCase());
                set.add(disease.getWord());

                String enWord = disease.getEnWord();
                enWord = enWord.replaceAll("([+\\'])", "\\\\$1");
                if (StrUtil.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

//                List<WordStatus> enSynonym = disease.getEnSynonym();
//                if (CollUtil.isNotEmpty(enSynonym)){
//                    for (WordStatus wordStatus : enSynonym) {
//                        String name = wordStatus.getName();
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            set.add(name);
//                        }
//                    }
//                }

                String zhWord = disease.getZhWord();
                zhWord = zhWord.replaceAll("([+\\'])", "\\\\$1");
                if (StrUtil.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

//                List<WordStatus> zhSynonym = disease.getZhSynonym();
//                if (CollUtil.isNotEmpty(zhSynonym)){
//                    for (WordStatus wordStatus : zhSynonym) {
//                        String name = wordStatus.getName();
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            set.add(name);
//                        }
//                    }
//                }

//                List<WordStatus> otherSynonym = disease.getOtherSynonym();
//                if (CollUtil.isNotEmpty(otherSynonym)){
//                    for (WordStatus wordStatus : otherSynonym) {
//                        String name = wordStatus.getName();
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            set.add(name);
//                        }
//                    }
//                }

                //补充同义词
                String expandSynonym = disease.getExpandSynonym();
                if (StrUtil.isNotBlank(expandSynonym)) {
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StrUtil.isNotBlank(txt)) {
                            txt = txt.replaceAll("([+\\'])", "\\\\$1");
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
                enWord = enWord.replaceAll("([+\\'])", "\\\\$1");
                if (StrUtil.isNotBlank(enWord)){
                    set.add(enWord.toLowerCase());
                    set.add(enWord);
                }

//                List<WordStatus> enSynonym = drug.getEnSynonym();
//                if (CollUtil.isNotEmpty(enSynonym)){
//                    for (WordStatus wordStatus : enSynonym) {
//                        String name = wordStatus.getName();
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            set.add(name);
//                        }
//                    }
//                }

                String zhWord = drug.getZhWord();
                zhWord = zhWord.replaceAll("([+\\'])", "\\\\$1");
                if (StrUtil.isNotBlank(zhWord)){
                    set.add(zhWord.toLowerCase());
                    set.add(zhWord);
                }

//                List<WordStatus> zhSynonym = drug.getZhSynonym();
//                if (CollUtil.isNotEmpty(zhSynonym)){
//                    for (WordStatus wordStatus : zhSynonym) {
//                        String name = wordStatus.getName();
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            set.add(name);
//                        }
//                    }
//                }

//                List<WordStatus> otherSynonym = drug.getOtherSynonym();
//                if (CollUtil.isNotEmpty(otherSynonym)){
//                    for (WordStatus wordStatus : otherSynonym) {
//                        String name = wordStatus.getName();
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            set.add(name);
//                        }
//                    }
//                }

                //补充同义词
                String expandSynonym = drug.getExpandSynonym();
                if (StrUtil.isNotBlank(expandSynonym)) {
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StrUtil.isNotBlank(txt)) {
                            txt = txt.replaceAll("([+\\'])", "\\\\$1");
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

    private String buildScriptByDrugAndDisease(List<String> drugSynonym, List<String> diseaseSynonym) {
        StringBuilder result = new StringBuilder();
        result.append("def baseScore = 0; def diseaseScore = 0.0; def drugScore = 0.0;");

        if (CollUtil.isNotEmpty(diseaseSynonym)) {
            result.append("if (doc['name'].value != null) { def nameLower = doc['name'].value.toLowerCase(); ");
            result.append("if (");
            for (int i = 0; i < diseaseSynonym.size(); i++) {
                result.append("nameLower.contains('").append(diseaseSynonym.get(i)).append("')");
                if (i < diseaseSynonym.size() - 1) {
                    result.append(" || ");
                }
            }
            result.append(") { diseaseScore = 1; }}");
        }

        if (CollUtil.isNotEmpty(drugSynonym)) {
            result.append("if (doc['name'].value != null) { def nameLower = doc['name'].value.toLowerCase(); ");
            result.append("if (");
            for (int i = 0; i < drugSynonym.size(); i++) {
                result.append("nameLower.contains('").append(drugSynonym.get(i)).append("')");
                if (i < drugSynonym.size() - 1) {
                    result.append(" || ");
                }
            }
            result.append(") { drugScore = 1; }}");
        }
        result.append("return 1000 * diseaseScore + 300 * Math.sqrt(drugScore) + baseScore;");
        return result.toString();
    }

    private void alterCondition(GuideConditionDTO guideConditionDTO, Condition condition) {
        ConditionGuideAlter conditionGuideAlter = new ConditionGuideAlter();
        if (Objects.nonNull(guideConditionDTO)) {
            String criteria = guideConditionDTO.getCondition();
            List<String> drugAndDisease = Collections.emptyList();
            if (StrUtil.isNotBlank(criteria)) {
                drugAndDisease = Arrays.stream(criteria.split("[^\\u4e00-\\u9fa5a-zA-Z0-9\\-/\\\\]+")).collect(Collectors.toList());
            }
            List<Drug> drugs = new ArrayList<>();
            List<Disease> diseases = new ArrayList<>();
            if (CollUtil.isNotEmpty(drugAndDisease)) {
                if (drugAndDisease.size() == 1) {
                    for (int i = 0; i < drugAndDisease.size(); i++) {
                        String word = drugAndDisease.get(i);
                        assembleDrug(word, 1, drugs, i, drugAndDisease.size());
                    }
                    conditionGuideAlter.setDiseases(Collections.emptyList());
                } else {
                    String regardAsDisease = drugAndDisease.get(drugAndDisease.size() - 1);
                    drugAndDisease.remove(drugAndDisease.size() - 1);
                    for (int i = 0; i < drugAndDisease.size(); i++) {
                        String word = drugAndDisease.get(i);
                        assembleDrug(word, 1, drugs, i, drugAndDisease.size());
                    }
                    assembleDisease(regardAsDisease, diseases, 0, 1);
                    conditionGuideAlter.setDiseases(diseases);
                }
            }
            conditionGuideAlter.setDrugs(drugs);
            // 数据补全（商品名、五级中英文）
            retrievalService.dataCompletion(conditionGuideAlter);
            condition.setConditionGuideAlter(conditionGuideAlter);
            condition.setGuideEchoData(criteria);
            mongoTemplate.findAndReplace(Query.query(Criteria.where("id").is(condition.getId())), condition);
        }

    }

    private void assembleDrug(String word, int type, List<Drug> drugs, int i, int size) {
        Drug drug = new Drug();
        drug.setWord(word);
        drug.setStatus(1);
        JSONObject synonym = retrievalService.synonym(word, type, 1);
        SynonymGenerateAdapter.buildSynonymByDrug(synonym, drug);
        drugs.add(drug);
        if (i != size - 1) {
            Drug status = new Drug();
            status.setStatus(2);
            drugs.add(status);
        }
    }

    private void assembleDisease(String word, List<Disease> diseases, int i, int size) {
        Disease disease = new Disease();
        disease.setWord(word);
        disease.setStatus(1);
        JSONObject synonym = retrievalService.synonym(word, 2, 1);
        SynonymGenerateAdapter.buildSynonymByDisease(synonym, disease);
        diseases.add(disease);
        if (i != size - 1) {
            Disease status = new Disease();
            status.setStatus(2);
            diseases.add(status);
        }
    }


    /***
     * 修复es中缺失标点符号问题
     * 美化高亮 1 禁止停用词高亮 2 当存在较长的高亮时取出单个字符的高亮
     * @param highTarget 原文
     * @param highResult es检索后高亮
     * @param condition 检索条件
     * @param search 二次检索高亮显示
     * @return 修复后的摘要显示
     */
    public String highLight(String highTarget, String highResult, Condition condition, String search) {
        //获取药品+参比药物的集合
        Set<String> drugSet = new HashSet<>();
        //获取疾病+结局指标的集合
        Set<String> diseaseSet = new HashSet<>();
        
        ConditionGuideAlter conditionGuideAlter = condition.getConditionGuideAlter();
        List<Drug> drugs = condition.getDrugs();
        List<InterventionAndOutcome> interventions = condition.getInterventions();
        List<Disease> diseases = condition.getDiseases();
        // 去定语之后的
        List<Disease> literatureWipeDiseases = condition.getLiteratureWipeDiseases();
        // 结局指标
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();
        if (Objects.nonNull(conditionGuideAlter)) {
            drugs = conditionGuideAlter.getDrugs();
            interventions = conditionGuideAlter.getInterventions();
            diseases = conditionGuideAlter.getDiseases();
            outcomes = conditionGuideAlter.getOutcomes();
            literatureWipeDiseases = conditionGuideAlter.getLiteratureWipeDiseases();
        }

        JSONArray array = new JSONArray();
        array.add(drugs);
        if (CollUtil.isNotEmpty(interventions)) {
            array.add(interventions);
        }
        for (int i = 0; i < array.size(); i++) {
            JSONArray innerArr = array.getJSONArray(i);
            if (CollUtil.isNotEmpty(innerArr)) {
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject json = innerArr.getJSONObject(i1);
                    Integer status = json.getInteger("status");
                    if (status == 1) {
                        String word = json.getString("word").toLowerCase();
                        drugSet.add(word.toLowerCase());
                        drugSet.add(word);

                        String enWord = json.getString("enWord");
                        if (StringUtils.isNotBlank(enWord)) {
                            drugSet.add(enWord.toLowerCase());
                        }

                        JSONArray enSynonym = json.getJSONArray("enSynonym");
                        if (CollUtil.isNotEmpty(enSynonym)) {
                            for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    drugSet.add(name);
                                }
                            }
                        }

                        String zhWord = json.getString("zhWord");
                        if (StringUtils.isNotBlank(zhWord)) {
                            drugSet.add(zhWord.toLowerCase());
                        }

                        JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                        if (CollUtil.isNotEmpty(zhSynonym)) {
                            for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    drugSet.add(name);
                                }
                            }
                        }

                        JSONArray otherSynonym = json.getJSONArray("otherSynonym");
                        if (CollUtil.isNotEmpty(otherSynonym)){
                            for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    drugSet.add(name);
                                }
                            }
                        }

                        //补充同义词
                        String expandSynonym = json.getString("expandSynonym");
                        if (StrUtil.isNotBlank(expandSynonym)) {
                            expandSynonym = expandSynonym.replaceAll("；", ";");
                            String[] split = expandSynonym.split(";");
                            for (String txt : split) {
                                if (StringUtils.isNotBlank(txt)) {
                                    drugSet.add(txt.toLowerCase());
                                }
                            }
                        }

                        // 增加商品名
                        JSONArray commodityNames = json.getJSONArray("commodityNames");
                        if (CollUtil.isNotEmpty(commodityNames)) {
                            List<String> collect = commodityNames.stream().map(String::valueOf).collect(Collectors.toList());
                            collect = collect.stream().distinct().collect(Collectors.toList());
                            drugSet.addAll(collect);
                        }

                        // 药品表中 五级同义词
                        JSONArray zhDrugNames = json.getJSONArray("zhDrugNames");
                        if (CollUtil.isNotEmpty(zhDrugNames)) {
                            drugSet.addAll(zhDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                        }
                        JSONArray enDrugNames = json.getJSONArray("enDrugNames");
                        if (CollUtil.isNotEmpty(enDrugNames)) {
                            drugSet.addAll(enDrugNames.stream().map(Object::toString).collect(Collectors.toList()));
                        }
                    }
                }
            }
        }
        JSONArray otherArray = new JSONArray();
        if (CollUtil.isNotEmpty(diseases)) {
            otherArray.add(diseases);
        }

        if (CollUtil.isNotEmpty(outcomes)) {
            otherArray.add(outcomes);
        }
        int wipeDiseaseSize = 0;
        for (int i = 0; i < otherArray.size(); i++) {
            JSONArray innerArr = otherArray.getJSONArray(i);
            if (CollUtil.isNotEmpty(innerArr)) {
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject json = innerArr.getJSONObject(i1);
                    Integer status = json.getInteger("status");
                    if (status == 1) {
                        String word = json.getString("word").toLowerCase();
                        diseaseSet.add(word);

                        String enWord = json.getString("enWord");
                        if (StringUtils.isNotBlank(enWord)) {
                            diseaseSet.add(enWord.toLowerCase());
                        }

                        JSONArray enSynonym = json.getJSONArray("enSynonym");
                        if (CollUtil.isNotEmpty(enSynonym)) {
                            for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    diseaseSet.add(name);
                                }
                            }
                        }

                        String zhWord = json.getString("zhWord");
                        if (StringUtils.isNotBlank(zhWord)) {
                            diseaseSet.add(zhWord.toLowerCase());
                        }

                        JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                        if (CollUtil.isNotEmpty(zhSynonym)) {
                            for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    diseaseSet.add(name);
                                }
                            }
                        }

                        JSONArray otherSynonym = json.getJSONArray("otherSynonym");
                        if (CollUtil.isNotEmpty(otherSynonym)){
                            for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    diseaseSet.add(name);
                                }
                            }
                        }

                        //补充同义词
                        String expandSynonym = json.getString("expandSynonym");
                        if (StrUtil.isNotBlank(expandSynonym)) {
                            expandSynonym = expandSynonym.replaceAll("；", ";");
                            String[] split = expandSynonym.split(";");
                            for (String txt : split) {
                                if (StringUtils.isNotBlank(txt)) {
                                    diseaseSet.add(txt.toLowerCase());
                                }
                            }
                        }

                        try {
                            Disease disease = literatureWipeDiseases.get(wipeDiseaseSize++);

                            String word_ = disease.getWord();
                            diseaseSet.add(word_.toLowerCase());
                            diseaseSet.add(word_);

                            String enWord_ = disease.getEnWord();
                            if (StringUtils.isNotBlank(enWord_)){
                                diseaseSet.add(enWord_.toLowerCase());
                                diseaseSet.add(enWord_);
                            }

                            List<WordStatus> enSynonym_ = disease.getEnSynonym();
                            if (CollUtil.isNotEmpty(enSynonym_)){
                                for (WordStatus wordStatus : enSynonym_) {
                                    String name = wordStatus.getName();
                                    Boolean checked = wordStatus.getChecked();
                                    if (checked) {
                                        diseaseSet.add(name.toLowerCase());
                                        diseaseSet.add(name);
                                    }
                                }
                            }

                            String zhWord_ = disease.getZhWord();
                            if (StringUtils.isNotBlank(zhWord_)){
                                diseaseSet.add(zhWord_.toLowerCase());
                                diseaseSet.add(zhWord_);
                            }

                            List<WordStatus> zhSynonym_ = disease.getZhSynonym();
                            if (CollUtil.isNotEmpty(zhSynonym_)){
                                for (WordStatus wordStatus : zhSynonym_) {
                                    String name = wordStatus.getName();
                                    Boolean checked = wordStatus.getChecked();
                                    if (checked) {
                                        diseaseSet.add(name.toLowerCase());
                                        diseaseSet.add(name);
                                    }
                                }
                            }

                            List<WordStatus> otherSynonym_ = disease.getOtherSynonym();
                            if (CollUtil.isNotEmpty(otherSynonym_)){
                                for (WordStatus wordStatus : otherSynonym_) {
                                    String name = wordStatus.getName();
                                    Boolean checked = wordStatus.getChecked();
                                    if (checked) {
                                        diseaseSet.add(name.toLowerCase());
                                        diseaseSet.add(name);
                                    }
                                }
                            }
                        } catch (Exception e) {
                            log.error("结局指标没有去定语!!!");
                        }
                    }
                }
            }
        }
        //正在获得全部需要高亮的数据
        highTarget = highTarget.replaceAll("<b>", "卍").replaceAll("</b>", "卐");
        Pattern pattern = Pattern.compile("卍.*?卐", Pattern.CASE_INSENSITIVE);
        Matcher matcher = pattern.matcher(highTarget);
        Set<String> set = new HashSet<>();
        while (matcher.find()) {
            String group = matcher.group();
            if (group.indexOf("卍") == group.lastIndexOf("卍") && group.indexOf("卐") == group.lastIndexOf("卐") && (group.length() != 1)) {
                set.add(group);
            }
        }
        for (String s : set) {
            s = s.replaceAll("卍", "");
            s = s.replaceAll("卐", "");
            String pre = "";
            String tag = "";
            for (String s1 : drugSet) {
                if (s1.length() == 1) {
                    continue;
                }
                if (s.toLowerCase().contains(s1.toLowerCase())) {
                    pre = "<b>";
                    tag = "</b>";
                    break;
                }
            }
            for (String s1 : diseaseSet) {
                if (s1.length() == 1) {
                    continue;
                }
                if (s.toLowerCase().contains(s1.toLowerCase())) {
                    pre = "<i>";
                    tag = "</i>";
                    break;
                }
            }
            if (StringUtils.isNotBlank(search)) {
                if (s.toLowerCase().contains(search.toLowerCase())) {
                    pre = "<strong>";
                    tag = "</strong>";
                }
            }
            if (StringUtils.isNotBlank(pre)) {
                highResult = highResult.replaceAll(s, pre + s + tag);
            }
        }
        highResult = highResult.replaceAll("卍", "");
        highResult = highResult.replaceAll("卐", "");
        return highResult;
    }
}
