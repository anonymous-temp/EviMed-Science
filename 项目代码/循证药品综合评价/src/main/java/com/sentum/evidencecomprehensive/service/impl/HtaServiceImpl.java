package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HttpUtil;
import com.mongodb.client.result.DeleteResult;
import com.mongodb.client.result.UpdateResult;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.*;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.WordStatus;
import com.sentum.evidencecomprehensive.domain.es.HtaReportIndex;
import com.sentum.evidencecomprehensive.domain.mongo.*;
import com.sentum.evidencecomprehensive.domain.vo.CountryVo;
import com.sentum.evidencecomprehensive.domain.vo.HtaInitialVo;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.domain.vo.req.HTASearchRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;
import com.sentum.evidencecomprehensive.domain.vo.resp.HtaReportResponse;
import com.sentum.evidencecomprehensive.service.HtaService;
import com.sentum.evidencecomprehensive.utils.*;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.common.lucene.search.function.CombineFunction;
import org.elasticsearch.common.lucene.search.function.FunctionScoreQuery;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.IdsQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.elasticsearch.index.query.functionscore.FieldValueFactorFunctionBuilder;
import org.elasticsearch.index.query.functionscore.FunctionScoreQueryBuilder;
import org.elasticsearch.index.query.functionscore.ScriptScoreFunctionBuilder;
import org.elasticsearch.script.Script;
import org.elasticsearch.script.ScriptType;
import org.elasticsearch.search.aggregations.Aggregation;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.elasticsearch.search.fetch.subphase.highlight.HighlightBuilder;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
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

import java.io.File;
import java.time.Duration;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Description: hta报告 业务实现类
 */

@Slf4j
@Service
public class HtaServiceImpl implements HtaService {

    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Value("${file.server.hta.pdf.url}")
    private String htaPdfUrl;
    @Value("${file.server.hta.pdf.trans.url}")
    private String transHtaPdfUrl;
    
    @Override
    public HtaInitialVo getInitialData(String id, long userId) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        BoolQueryBuilder htaQuery = QueryUtils.createHtaQuery(condition);
        // 来源 , "CADTH", "AWMSG", "NICE", "EUnetHTA")
        BoolQueryBuilder sourceBoolQueryBuilder = new BoolQueryBuilder();
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "NICE"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "SMC"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "AWMSG"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "CADTH"));
        sourceBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("source.keyword", "IQWlG"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "EUnetHTA"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "INAHTA"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "PBAC"));
        htaQuery.must().add(sourceBoolQueryBuilder);
        // 必须有 pdf 的才展示
        htaQuery.must().add(QueryBuilders.termQuery("existsFlag", 1));
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(htaQuery);
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("sourceFull").field("sourceFull").size(24));
        SearchHits<HtaReportIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, HtaReportIndex.class);
        Aggregations aggregations = search.getAggregations();
        HtaInitialVo htaInitialVo = new HtaInitialVo();
        // 国家聚合结果
        if (aggregations != null) {
            //year
            Aggregation country = aggregations.get("sourceFull");
            List<? extends Terms.Bucket> countryBuckets = ((ParsedTerms) country).getBuckets();
            List<CountryVo> countries = new ArrayList<>();
            for (Terms.Bucket bucket : countryBuckets) {
                String key = bucket.getKey().toString();
                long docCount = bucket.getDocCount();
                countries.add(new CountryVo(key, docCount));
            }
            htaInitialVo.setCountries(countries);
        }
        return htaInitialVo;
    }

    /**
     * 查询hta报告 list
     */
    @Override
    public PageVo<HtaReportResponse> list(HTASearchRequest htaSearchRequest, long userId) {
        String id = htaSearchRequest.getId();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) throw new RuntimeException("检索id异常");

        BoolQueryBuilder htaQuery = QueryBuilders.boolQuery();
//                QueryUtils.createHtaQuery(condition);
        Integer operateType = htaSearchRequest.getOperateType();
        if (operateType == 1) {
            List<HtaIncludeOrExclude> htaIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(htaSearchRequest.getId()).and("status").is(1)), HtaIncludeOrExclude.class);
            htaQuery.must().add(QueryBuilders.idsQuery().addIds(htaIncludeOrExcludes.stream().map(HtaIncludeOrExclude::getHtaId).toArray(String[]::new)));
        } else {
            // 必须有 pdf 的才展示
            htaQuery.must().add(QueryBuilders.termQuery("existsFlag", 1));

            // 来源 , "CADTH", "AWMSG", "NICE", "EUnetHTA")
            BoolQueryBuilder sourceBoolQueryBuilder = new BoolQueryBuilder();
            sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "NICE"));
            sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "SMC"));
            sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "AWMSG"));
            sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "CADTH"));
            sourceBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("source.keyword", "IQWlG"));
            sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "EUnetHTA"));
            sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "INAHTA"));
            sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "PBAC"));
            htaQuery.must().add(sourceBoolQueryBuilder);
        }

        BoolQueryBuilder countryBool = new BoolQueryBuilder();
        // 筛选条件-国家
        if (CollUtil.isNotEmpty(htaSearchRequest.getCountry())) {
            for (String country : htaSearchRequest.getCountry()) {
                countryBool.should().add(QueryBuilders.matchQuery("sourceFull", country));
            }
        }
        htaQuery.must().add(countryBool);

        htaQuery.must().add(QueryUtils.createHtaQuery(condition));

        //搜索框-发表年份
        Integer startYear = htaSearchRequest.getStartYear();
//        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        if (startYear != null) {
            htaQuery.must().add(QueryBuilders.rangeQuery("publishTime").gte(startYear + "-00-00"));
        }
        Integer endYear = htaSearchRequest.getEndYear();
        if (endYear != null) {
            htaQuery.must().add(QueryBuilders.rangeQuery("publishTime").lte(endYear + "-12-30 24:00:00"));
        }
        // 筛选条件-输入框
        if (StrUtil.isNotBlank(htaSearchRequest.getSearch())) {
            htaQuery.must().add(QueryBuilders.termQuery("title.keyword", htaSearchRequest.getSearch()));
        }
       
        //排序-分页
        Integer sortType = htaSearchRequest.getSortType();
        Integer sortDirection = htaSearchRequest.getSortDirection();
        PageRequest pageRequest = PageRequest.of(htaSearchRequest.getPageNum() - 1, htaSearchRequest.getPageSize());
        if (sortType == 1) { // 发表时间
            Sort.Direction direction = Sort.Direction.ASC;
            if (sortDirection == 0) {
                direction = Sort.Direction.DESC;
            }
            pageRequest = PageRequest.of(htaSearchRequest.getPageNum() - 1, htaSearchRequest.getPageSize(), Sort.by(direction, "publishTimeDateTs"));
        } else if (sortType == 0) {
            Sort.Direction direction = Sort.Direction.DESC;
            pageRequest = PageRequest.of(htaSearchRequest.getPageNum() - 1, htaSearchRequest.getPageSize(), Sort.by(direction, "_score", "publishTimeDateTs"));
        }

//        Integer operateType = htaSearchRequest.getOperateType();
//        if (operateType == 1) {
//            List<HtaIncludeOrExclude> htaIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("status").is(1)), HtaIncludeOrExclude.class);
//            htaQuery.must().add(QueryBuilders.idsQuery().addIds(htaIncludeOrExcludes.stream().map(HtaIncludeOrExclude::getHtaId).toArray(String[]::new)));
//        }
        NativeSearchQuery nativeSearchQuery;
        if (sortType == 0) {
            List<String> drugSynonym = handleDrugToSynonym(condition.getDrugs());
            List<String> diseaseSynonym = handleDiseaseToSynonym(condition.getDiseases());

            FunctionScoreQueryBuilder.FilterFunctionBuilder[] filterFunctionBuilders = new FunctionScoreQueryBuilder.FilterFunctionBuilder[2];
            
            String scriptStr = "Math.log1p(_score + 1)*0.5";
            Script script = new Script(scriptStr);
            ScriptScoreFunctionBuilder scriptScoreFunctionBuilder = new ScriptScoreFunctionBuilder(script);
            filterFunctionBuilders[0] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(scriptScoreFunctionBuilder);
            
            filterFunctionBuilders[1] = new FunctionScoreQueryBuilder.FilterFunctionBuilder(new ScriptScoreFunctionBuilder(new Script(buildScriptByDrugAndDisease(drugSynonym, diseaseSynonym))));
            FunctionScoreQueryBuilder functionScoreQueryBuilder = QueryBuilders.functionScoreQuery(htaQuery, filterFunctionBuilders);
            functionScoreQueryBuilder.scoreMode(FunctionScoreQuery.ScoreMode.SUM);
            functionScoreQueryBuilder.boostMode(CombineFunction.REPLACE);
            nativeSearchQuery = new NativeSearchQuery(functionScoreQueryBuilder);
            nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "_score"));
        } else {
            nativeSearchQuery = new NativeSearchQuery(htaQuery);
        }
        nativeSearchQuery.setPageable(pageRequest);
        // 获取符合条件的hta报告总数
        long total_count = elasticsearchRestTemplate.count(nativeSearchQuery, HtaReportIndex.class);
        // 高亮查询
        String preTag = "<b>";
        String postTag = "</b>";
        HighlightBuilder highlightBuilder = new HighlightBuilder();
        highlightBuilder.field("title");
        highlightBuilder.preTags(preTag);
        highlightBuilder.postTags(postTag);
        highlightBuilder.fragmentSize(1024 * 10);
        highlightBuilder.numOfFragments(0);
        highlightBuilder.requireFieldMatch(false);
        nativeSearchQuery.setHighlightQuery(new HighlightQuery(highlightBuilder));
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setTrackScores(true);
        SearchHits<HtaReportIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, HtaReportIndex.class);
        // 存放纳入的 hta
        List<HtaReportResponse> result = new ArrayList<>();
        Object objectStopWord = RedisUtil.redis.opsForValue().get("jieba_word");
        List<String> stopWord = ObjectToListUtil.objToList(objectStopWord, String.class);
        for (SearchHit<HtaReportIndex> searchHit : search.getSearchHits()) {
            HtaReportResponse htaReportResponse = new HtaReportResponse();
            HtaReportIndex htaReportIndex = searchHit.getContent();
            BeanUtils.copyProperties(htaReportIndex, htaReportResponse);
            //高亮显示情况
            List<String> titleList = searchHit.getHighlightField("title");
            StringBuilder titleBuilder = new StringBuilder();
            if (CollUtil.isNotEmpty(titleList)) {
                titleList.forEach(titleBuilder::append);
            }
            htaReportResponse.setTitle(StringUtils.isBlank(titleBuilder.toString()) ? htaReportResponse.getTitle() : HighLightUtils.highLight(HighLightUtils.repairContent(titleBuilder.toString(), htaReportIndex.getTitle(), stopWord), htaReportResponse.getTitle(), condition, htaSearchRequest.getSearch()));
            String source = htaReportIndex.getSource();
            String pdfName = htaReportIndex.getPdfName();
            // pdf 
            if (StrUtil.isNotBlank(source) && StrUtil.isNotBlank(pdfName) && htaReportIndex.getExistsFlag() == 1) {
                String htaPdfUrl_ = htaPdfUrl + source + Constants.PAD_LEFT_SLASH + pdfName + ".pdf";
                htaReportResponse.setPdfNameUrl(htaPdfUrl_);
                if ("PBAC".equals(source)) {
                    htaReportResponse.setTransPdfUrl(transHtaPdfUrl + "word_translated" + Constants.PAD_LEFT_SLASH + pdfName + ".docx");
                } 
                if (Constants.TRANS_PDF_SOURCES.contains(source)) {
                    htaReportResponse.setTransPdfUrl(transHtaPdfUrl + "hta_translated" + Constants.PAD_LEFT_SLASH + source + Constants.PAD_LEFT_SLASH + pdfName + "_zh.html");
                }
            }
            HtaIncludeOrExclude htaIncludeOrExclude = mongoTemplate.findOne(new Query(Criteria.where("conditionId").is(id).and("htaId").is(htaReportResponse.getId()).and("userId").is(userId)), HtaIncludeOrExclude.class);
            if (Objects.nonNull(htaIncludeOrExclude)) {
                Integer status = htaIncludeOrExclude.getStatus();
                if (status == 1) {
                    htaReportResponse.setInclusion(1);
                }
                if (status == 2) {
                    htaReportResponse.setInclusion(2);
                }
            }
            HtaCollect htaCollect = mongoTemplate.findOne(new Query(Criteria.where("htaId").is(htaReportResponse.getId()).and("userId").is(userId).and("conditionId").is(id)), HtaCollect.class);
            if (Objects.nonNull(htaCollect)) {
                htaReportResponse.setCollect(1);
            }
            result.add(htaReportResponse);
        }
        PageVo<HtaReportResponse> pageVo = new PageVo<>();
        pageVo.setPageNum(htaSearchRequest.getPageNum());
        pageVo.setPageSize(htaSearchRequest.getPageSize());
        pageVo.setTotal(total_count);
        pageVo.setPages((int) (total_count % htaSearchRequest.getPageSize() == 0 ? total_count / htaSearchRequest.getPageSize() : total_count / htaSearchRequest.getPageSize() + 1));
        pageVo.setList(result);
        return pageVo;
    }
    
    
    @Override
    public PageVo<HtaReport> getCollect(HTASearchRequest htaSearchRequest, long userId) {
        List<HtaReport> result = new ArrayList<>();

        List<HtaCollect> htaCollects = mongoTemplate.find(new Query(Criteria.where("userId").is(userId)), HtaCollect.class);
        List<String> collectIds = new ArrayList<>();
        if (CollUtil.isNotEmpty(htaCollects)) {
            collectIds = htaCollects.stream().map(HtaCollect::getHtaId).distinct().collect(Collectors.toList());
        }
        IdsQueryBuilder idsQueryBuilder = new IdsQueryBuilder();
        idsQueryBuilder.addIds(collectIds.toArray(new String[0]));
        
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
        nativeSearchQuery.setPageable(PageRequest.of(htaSearchRequest.getPageNum() - 1, htaSearchRequest.getPageSize()));
        nativeSearchQuery.setTrackTotalHits(true);
        long total_count = elasticsearchRestTemplate.count(nativeSearchQuery, HtaReportIndex.class);
        SearchHits<HtaReportIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, HtaReportIndex.class);
        List<SearchHit<HtaReportIndex>> searchHits = search.getSearchHits();

        for (SearchHit<HtaReportIndex> searchHit : searchHits) {
            HtaReportIndex content = searchHit.getContent();
            HtaReport htaReport = new HtaReport();
            BeanUtils.copyProperties(content, htaReport);
            String source = htaReport.getSource();
            String pdfName = htaReport.getPdfName();
            if (StrUtil.isNotBlank(source) && StrUtil.isNotBlank(pdfName)) {
                String htaPdfUrl_ = htaPdfUrl + source + Constants.PAD_LEFT_SLASH + pdfName + ".pdf";
                htaReport.setPdfNameUrl(htaPdfUrl_);
            }
            result.add(htaReport);
        }
        PageVo<HtaReport> pageVo = new PageVo<>();
        pageVo.setPageNum(htaSearchRequest.getPageNum());
        pageVo.setPageSize(htaSearchRequest.getPageSize());
        pageVo.setTotal(total_count);
        pageVo.setPages((int) (total_count % htaSearchRequest.getPageSize() == 0 ? total_count / htaSearchRequest.getPageSize() : total_count / htaSearchRequest.getPageSize() + 1));
        pageVo.setList(result);
        return pageVo;
    }

    @Override
    public String getPdfBase64(String id) {
        String res = "";
        HtaReport htaReport = ReleaseMongoUtil.mongo.findById(id, HtaReport.class);
        if (Objects.nonNull(htaReport)) {
            String source = htaReport.getSource();
            String pdfName = htaReport.getPdfName();
            if (StrUtil.isNotBlank(source) && StrUtil.isNotBlank(pdfName) && "1".equals(htaReport.getExistsFlag() + "")) {//todo 这里需要确认是否可以拿出来数据
                res = HttpUtil.get("staic.evimed.com:8080/pichelper-api/hta?fileName=" + source + Constants.PAD_LEFT_SLASH + pdfName + Constants.FILE_EXT_NAME_PDF);
            }
        }
        return res;
    }

    @Override
    public Boolean defaultInclusion(String id, Long userId) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) {
            throw new RuntimeException("检索id异常");
        }
        List<String> ids = new ArrayList<>();

        BoolQueryBuilder htaQuery = QueryUtils.createHtaQuery(condition);
        // 必须有 pdf 
        htaQuery.must().add(QueryBuilders.termQuery("existsFlag", 1));
        // 来源 , "CADTH", "AWMSG", "NICE", "EUnetHTA")
        BoolQueryBuilder sourceBoolQueryBuilder = new BoolQueryBuilder();
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "NICE"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "SMC"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "AWMSG"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "CADTH"));
        sourceBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("source.keyword", "IQWlG"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "EUnetHTA"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "INAHTA"));
        sourceBoolQueryBuilder.should().add(QueryBuilders.termQuery("source.keyword", "PBAC"));
        htaQuery.must().add(sourceBoolQueryBuilder);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(htaQuery);
        nativeSearchQuery.setMaxResults(50);
        SearchHits<HtaReportIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, HtaReportIndex.class);
        int hitTotals = search.getSearchHits().size();
        log.info("hta默认查询{}篇", hitTotals);
        if (hitTotals > 0) {
            ids.addAll(search.stream().map(SearchHit::getContent).map(HtaReportIndex::getId).collect(Collectors.toList()));
        }
        if (CollUtil.isNotEmpty(ids)) {
            // 只纳入有标注内容的 也就是pdf_tag_list & pdf_data_list  ！= null & 空的
            List<HtaReport> htaReports = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(ids)), HtaReport.class);
            if (CollUtil.isNotEmpty(htaReports)) {
                ids = htaReports.stream().filter(resultHtaReport ->
                                CollUtil.isNotEmpty(resultHtaReport.getPdfTagList())
                                        && CollUtil.isNotEmpty(resultHtaReport.getWordCleanImagePdfDataGptVerList())
                                        && CollUtil.isNotEmpty(resultHtaReport.getCleanImagePdfDataGptVerList()))
                        .map(HtaReport::getId)
                        .collect(Collectors.toList());
                if (CollUtil.isNotEmpty(ids)) {
                    OperateRequest OperateRequest = new OperateRequest(id, ids, 1);
                    operate(OperateRequest, userId);
                    log.info("HTA最终纳入{}篇", ids.size());
                    return true;
                }
            }
        }
        return false;
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
                DeleteResult deleteInclude = mongoTemplate.remove(new Query(Criteria.where("htaId").in(ids).and("userId").is(userId).and("conditionId").is(conditionId)), HtaIncludeOrExclude.class);
                flag = deleteInclude.getDeletedCount() > 0;
                break;
            case 6:
                DeleteResult deleteCollet = mongoTemplate.remove(new Query(Criteria.where("htaId").in(ids).and("userId").is(userId).and("conditionId").is(conditionId)), HtaCollect.class);
                flag = deleteCollet.getDeletedCount() > 0;
                break;
            case 1:
                boolean includeFlag1 = false;
                boolean includeFlag2 = false;
                List<HtaIncludeOrExclude> includeList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("htaId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    HtaIncludeOrExclude include = mongoTemplate.findOne(query, HtaIncludeOrExclude.class);
                    if (include != null) {
                        Integer status = include.getStatus();
                        if (status == 2) {
                            //修改为纳入
                            Update update = new Update();
                            update.set("status", 1);
                            update.set("timeStamp", System.currentTimeMillis());
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, HtaIncludeOrExclude.class);
                            includeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    } else {
                        includeList.add(new HtaIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 1, userId, System.currentTimeMillis()));
                    }
                }
                if (!includeList.isEmpty()) {
                    Collection<HtaIncludeOrExclude> insert = mongoTemplate.insert(includeList, HtaIncludeOrExclude.class);
                    if (CollUtil.isNotEmpty(insert)) {
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
                List<HtaIncludeOrExclude> excludeList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("htaId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    HtaIncludeOrExclude exclude = mongoTemplate.findOne(query, HtaIncludeOrExclude.class);
                    if (exclude != null) {
                        Integer status = exclude.getStatus();
                        if (status == 1) {
                            //修改为排除
                            Update update = new Update();
                            update.set("status", 2);
                            update.set("timeStamp", System.currentTimeMillis());
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, HtaIncludeOrExclude.class);
                            excludeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    } else {
                        excludeList.add(new HtaIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 2, userId, System.currentTimeMillis()));
                    }
                }
                if (!excludeList.isEmpty()) {
                    Collection<HtaIncludeOrExclude> insert = mongoTemplate.insert(excludeList, HtaIncludeOrExclude.class);
                    if (CollUtil.isNotEmpty(insert)) {
                        excludeFlag2 = true;
                    }
                }
                if (excludeFlag1 || excludeFlag2) {
                    flag = true;
                }
                break;
            case 5:
                List<HtaCollect> collectList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("htaId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    boolean exists = mongoTemplate.exists(query, HtaCollect.class);
                    if (!exists) {
                        collectList.add(new HtaCollect(UUID.randomUUID().toString(), conditionId, id, userId, System.currentTimeMillis()));
                    }
                }
                if (!collectList.isEmpty()) {
                    Collection<HtaCollect> insert = mongoTemplate.insert(collectList, HtaCollect.class);
                    if (CollUtil.isNotEmpty(insert)) {
                        flag = true;
                    }
                }
                break;
            default:
                break;
        }
        return flag;
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
//                        name = name.replaceAll("([+\\'])", "\\\\$1");
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
//                        name = name.replaceAll("([+\\'])", "\\\\$1");
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
//                        name = name.replaceAll("([+\\'])", "\\\\$1");
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
//                        name = name.replaceAll("([+\\'])", "\\\\$1");
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
//        String result = "double score=_score;double disScore="+CollUtil.isEmpty(diseaseSynonym)+"?0:";
//        if (CollUtil.isNotEmpty(diseaseSynonym)) {
//            StringBuilder scriptStr1 = new StringBuilder();
//            for (String dis : diseaseSynonym) {
//                scriptStr1.append("doc['name'].getValue().toLowerCase().contains('").append(dis).append("')||");
//            }
//            String scriptStr1String = scriptStr1.toString();
//            scriptStr1String = scriptStr1String.substring(0, scriptStr1String.lastIndexOf("||"));
//            scriptStr1String += "?1:0;";
//            result += scriptStr1String;
//        }
//
//        result += "double drugScore="+CollUtil.isEmpty(drugSynonym)+"?0:";
//        if (CollUtil.isNotEmpty(drugSynonym)) {
//            StringBuilder scriptStr2 = new StringBuilder();
//            for (String drug : drugSynonym) {
//                scriptStr2.append("doc['name'].getValue().toLowerCase().contains('").append(drug).append("')||");
//            }
//            String scriptStr2String = scriptStr2.toString();
//            scriptStr2String = scriptStr2String.substring(0, scriptStr2String.lastIndexOf("||"));
//            scriptStr2String += "?1:0;";
//            result += scriptStr2String;
//        }
//        return result + "return 1000*disScore+300*Math.sqrt(drugScore)+score";
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
}
