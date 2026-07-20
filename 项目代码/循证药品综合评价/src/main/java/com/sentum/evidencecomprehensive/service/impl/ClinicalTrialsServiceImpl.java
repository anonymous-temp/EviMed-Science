package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.mongodb.client.result.DeleteResult;
import com.mongodb.client.result.UpdateResult;
import com.sentum.evidencecomprehensive.domain.vo.req.ClinicalTrialsSearchRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;
import com.sentum.evidencecomprehensive.domain.vo.resp.ClinicalTrialsResponse;
import com.sentum.evidencecomprehensive.domain.vo.req.ThreeClinicalTrialsRequest;
import com.sentum.evidencecomprehensive.domain.es.ClinicalIndex;
import com.sentum.evidencecomprehensive.domain.es.ThreeClinicalIndex;
import com.sentum.evidencecomprehensive.domain.mongo.*;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.domain.vo.resp.ThreeClinicalTrialsResponse;
import com.sentum.evidencecomprehensive.service.ClinicalTrialsService;
import com.sentum.evidencecomprehensive.utils.*;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.index.query.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

import java.util.*;

@Slf4j
@Service
public class ClinicalTrialsServiceImpl implements ClinicalTrialsService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;

    @Override
    public PageVo<ThreeClinicalTrialsResponse> threeList(ThreeClinicalTrialsRequest searchDto) {
        String id = searchDto.getId();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        
        BoolQueryBuilder threeInstructionQuery = QueryUtils.createThreeClinicalTrialsQueryByTitleAndKey(condition);
        
        //搜索框输入内容  支持注册证号 注册题目 干预措施 研究疾病查询
        String requestSearchData = searchDto.getSearchData();
        if (StringUtils.isNotBlank(requestSearchData)) {
            BoolQueryBuilder innerBoolQueryBuilder = QueryBuilders.boolQuery();
            MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("title", requestSearchData);
            matchQueryBuilder.operator(Operator.AND);
            innerBoolQueryBuilder.should().add(matchQueryBuilder);
            
            TermQueryBuilder registerNo = QueryBuilders.termQuery("cochraneId", requestSearchData.toLowerCase());
            innerBoolQueryBuilder.should().add(registerNo);
            threeInstructionQuery.must().add(innerBoolQueryBuilder);
        }
        // 发表时间
        if (StringUtils.isNotBlank(searchDto.getStartYear()) || StringUtils.isNotBlank(searchDto.getEndYear())) {
            RangeQueryBuilder registerDate = QueryBuilders.rangeQuery("year");
            if (StringUtils.isNotBlank(searchDto.getStartYear())) {
                registerDate.gte(searchDto.getStartYear());
            }
            if (StringUtils.isNotBlank(searchDto.getEndYear())) {
                registerDate.lte(searchDto.getEndYear());
            }
            threeInstructionQuery.must().add(registerDate);
        }
        
        // 收录来源
        List<String> source = searchDto.getSource();
        if (CollUtil.isNotEmpty(source)) {
            threeInstructionQuery.must().add(QueryBuilders.termsQuery("source", source));
        }

        // 语言
        List<String> language = searchDto.getLanguage();
        if (CollUtil.isNotEmpty(language)) {
            threeInstructionQuery.must().add(QueryBuilders.termsQuery("language", language));
        }
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(threeInstructionQuery);
        
        //按照注册时间排序
        Integer registrationTimeSort = searchDto.getRegistrationTimeSort();
        if (registrationTimeSort != null) {
            if (registrationTimeSort == 1) {
                nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize(), Sort.by(Sort.Direction.ASC, "year")));
            } else {
                nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize(), Sort.by(Sort.Direction.DESC, "year")));
            }
        } else {
            nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize(), Sort.by(Sort.Direction.DESC, "year")));
        }
        
        nativeSearchQuery.setTrackTotalHits(true);
        SearchHits<ThreeClinicalIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, ThreeClinicalIndex.class);
        List<ThreeClinicalTrialsResponse> list = new ArrayList<>();
        for (SearchHit<ThreeClinicalIndex> clinicalIndexSearchHit : search) {
            ThreeClinicalIndex threeClinicalIndex = clinicalIndexSearchHit.getContent();
            ThreeClinicalTrial threeClinicalTrial = ReleaseMongoUtil.mongo.findById(threeClinicalIndex.getId(), ThreeClinicalTrial.class);
            ThreeClinicalTrialsResponse threeClinicalTrialsResponse = FormatUtil.formClinicalTrials(threeClinicalIndex);
            if (Objects.nonNull(threeClinicalTrial)) {
                threeClinicalTrialsResponse.setJournal(StrUtil.isNotBlank(threeClinicalTrial.getJournal()) ? threeClinicalTrial.getJournal() : "Not application");
                threeClinicalTrialsResponse.setPublicationType(CollUtil.isNotEmpty(threeClinicalTrial.getPublicationType()) ? threeClinicalTrial.getPublicationType() : Collections.emptyList());
                List<String> url = threeClinicalTrial.getUrl();
                if (CollUtil.isNotEmpty(url)) {
                    threeClinicalTrialsResponse.setUrl(url.get(0));
                }
            }
            list.add(threeClinicalTrialsResponse);
        }
        long totalHits = search.getTotalHits();
        int pages = (int) (totalHits % searchDto.getPageSize() == 0 ? totalHits / searchDto.getPageSize() : totalHits / searchDto.getPageSize() + 1);
        PageVo<ThreeClinicalTrialsResponse> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(searchDto.getPageSize());
        page.setPageNum(searchDto.getPageNum());
        return page;
    }

    @Override
    public PageVo<ClinicalTrialsResponse> list(ClinicalTrialsSearchRequest searchDto, Long userId, int type) {
        String id = searchDto.getId();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        BoolQueryBuilder clinicalTrialsQuery = QueryUtils.createClinicalTrialsInclusion(condition);
        //中英文临床试验
        Integer change = searchDto.getChange();
        String belong;
        if (change == 0){
            //chictr
            belong = "chictr";
        }else {
            //clinicaltrials
            belong = "clinicaltrials";
        }
        clinicalTrialsQuery.must().add(QueryBuilders.termQuery("belong.keyword", belong));
        //搜索框输入内容
        String requestSearchData = searchDto.getSearchData();
        if (StringUtils.isNotBlank(requestSearchData)) {
            BoolQueryBuilder innerBoolQueryBuilder = QueryBuilders.boolQuery();
            MatchQueryBuilder matchQueryBuilder = QueryBuilders.matchQuery("publicTitle", requestSearchData);
            matchQueryBuilder.operator(Operator.AND);
            innerBoolQueryBuilder.should().add(matchQueryBuilder);
            MatchPhraseQueryBuilder matchPhraseQueryBuilder = QueryBuilders.matchPhraseQuery("condition", requestSearchData.toLowerCase());
            innerBoolQueryBuilder.should().add(matchPhraseQueryBuilder);
            MatchPhraseQueryBuilder intervention = QueryBuilders.matchPhraseQuery("intervention", requestSearchData.toLowerCase());
            innerBoolQueryBuilder.should().add(intervention);
            //新刷数据之后再打开搜索登记号
            TermQueryBuilder registerNo = QueryBuilders.termQuery("registerNo", requestSearchData.toLowerCase());
            innerBoolQueryBuilder.should().add(registerNo);
            clinicalTrialsQuery.must().add(innerBoolQueryBuilder);
        }
        //注册时间
        if (searchDto.getStartRegistrationTime() != null || searchDto.getEndRegistrationTime() != null) {
            RangeQueryBuilder registerDate = QueryBuilders.rangeQuery("registerDate");
            if (searchDto.getStartRegistrationTime() != null) {
                registerDate.gte(searchDto.getStartRegistrationTime() + "-00-00");
            }
            if (searchDto.getEndRegistrationTime() != null) {
                registerDate.lte(searchDto.getEndRegistrationTime() + "-12-31");
            }
            clinicalTrialsQuery.must().add(registerDate);
        }
        //样本量
        if (searchDto.getMinSampleSize() != null || searchDto.getMaxSampleSize() != null) {
            RangeQueryBuilder sampleSize = QueryBuilders.rangeQuery("sampleSize");
            if (searchDto.getMinSampleSize() != null) {
                sampleSize.gte(searchDto.getMinSampleSize());
            }
            if (searchDto.getMaxSampleSize() != null) {
                sampleSize.lte(searchDto.getMaxSampleSize());
            }
            clinicalTrialsQuery.must().add(sampleSize);
        }
        //招募状态
        if (CollUtil.isNotEmpty(searchDto.getRecruitmentStatus()) && change == 1) {
            List<String> recruitmentStatus = searchDto.getRecruitmentStatus();
            List<String> strings = new ArrayList<>();
            for (String status : recruitmentStatus) {
                int i1 = status.indexOf("/");
                if(i1 != -1) {
                    status = status.substring(0,i1);
                }
                strings.add(status.toLowerCase());
            }
            TermsQueryBuilder termsQueryBuilder = QueryBuilders.termsQuery("recruitmentStatus", strings);
            clinicalTrialsQuery.must().add(termsQueryBuilder);
        }
        //试验阶段
        if (CollUtil.isNotEmpty(searchDto.getTestPhase())) {
            List<String> testPhase = searchDto.getTestPhase();
            List<String> phases = new ArrayList<>();
            for (String phase : testPhase){
                if("其他/N/A".equals(phase)) {
                    phase = "其它";
                }
                int i1 = phase.lastIndexOf("/");
                if(i1 >= 0){
                    phase = phase.substring(0, i1);
                }
                phases.add(phase.toLowerCase());
            }
            TermsQueryBuilder termsQueryBuilder = QueryBuilders.termsQuery("studyPhase.keyword", phases);
            clinicalTrialsQuery.must().add(termsQueryBuilder);
        }
        //关联文章
        if (CollUtil.isNotEmpty(searchDto.getAssociatedArticles()) && change == 1) {
            List<Integer> associatedArticles = searchDto.getAssociatedArticles();
            if (associatedArticles.size() == 1) {
                Integer integer = associatedArticles.get(0);
                TermsQueryBuilder termsQueryBuilder = QueryBuilders.termsQuery("reference", integer.toString());
                clinicalTrialsQuery.must().add(termsQueryBuilder);
            }
        }
        //研究类型
        if (CollUtil.isNotEmpty(searchDto.getStudyType()) && change == 0) {
            List<String> studyType = searchDto.getStudyType();
            List<String> study = new ArrayList<>();
            for(String str : studyType){
                study.add(str.toLowerCase());
            }
            TermsQueryBuilder termsQueryBuilder = QueryBuilders.termsQuery("studyType", study);
            clinicalTrialsQuery.must().add(termsQueryBuilder);
        }
        //研究结果
        if ("clinicaltrials".equals(belong)) {
            TermsQueryBuilder termsQueryBuilder = QueryBuilders.termsQuery("studyResults", true);
            clinicalTrialsQuery.must().add(termsQueryBuilder);
        }
        
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(clinicalTrialsQuery);
        //按照注册时间排序
        Integer registrationTimeSort = searchDto.getRegistrationTimeSort();
        if (registrationTimeSort != null) {
            if (registrationTimeSort == 1) {
                nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize(), Sort.by(Sort.Direction.ASC, "registerDate")));
            } else {
                nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize(), Sort.by(Sort.Direction.DESC, "registerDate")));
            } 
        } else {
            nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize(), Sort.by(Sort.Direction.DESC, "registerDate")));
        }
        nativeSearchQuery.setTrackTotalHits(true);
        SearchHits<ClinicalIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, ClinicalIndex.class);
        List<String> ids = new ArrayList<>();
        for (SearchHit<ClinicalIndex> clinicalIndexSearchHit : search) {
            String registerId = clinicalIndexSearchHit.getContent().getId();
            ids.add(registerId);
        }
        List<ClinicalTrialsResponse> list = new ArrayList<>();
        for (String s : ids) {
            ClinicalTrialRegistration registration = ReleaseMongoUtil.mongo.findById(s, ClinicalTrialRegistration.class);
            if (registration != null) {
                ClinicalTrialsResponse clinicalTrialsResponse = FormatUtil.formClinicalTrials(registration);
                //判断纳排情况
                ClinicalTrialsIncludeOrExclude includeOrExclude = mongoTemplate.findOne(new Query(Criteria.where("registerNo").is(clinicalTrialsResponse.getRegisterNo()).and("userId").is(userId).and("conditionId").is(id)), ClinicalTrialsIncludeOrExclude.class);
                if (includeOrExclude != null) {
                    clinicalTrialsResponse.setInclusionStatus(includeOrExclude.getStatus());
                }
                list.add(clinicalTrialsResponse);
            }
        }
        long totalHits = search.getTotalHits();
        int pages = (int) (totalHits % searchDto.getPageSize() == 0 ? totalHits / searchDto.getPageSize() : totalHits / searchDto.getPageSize() + 1);
        PageVo<ClinicalTrialsResponse> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(searchDto.getPageSize());
        page.setPageNum(searchDto.getPageNum());
        return page;
    }

    @Override
    public Boolean operate(OperateRequest operateDto, Long userId) {
        String conditionId = operateDto.getId();
        List<String> ids = operateDto.getIds();
        Integer operate = operateDto.getOperate();
        boolean flag = false;
        switch (operate) {
            case 0:
                //取消纳排
                DeleteResult remove = mongoTemplate.remove(new Query(Criteria.where("conditionId").is(conditionId).and("registerNo").in(ids).and("userId").is(userId)), ClinicalTrialsIncludeOrExclude.class);
                flag = remove.getDeletedCount() > 0;
                break;
            case 2:
                //排除
                boolean excludeFlag1 = false;
                boolean excludeFlag2 = false;
                List<ClinicalTrialsIncludeOrExclude> excludeList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("registerNo").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    ClinicalTrialsIncludeOrExclude exclude = mongoTemplate.findOne(query, ClinicalTrialsIncludeOrExclude.class);
                    if (exclude != null){
                        Integer status = exclude.getStatus();
                        if (status == 1){
                            //修改为排除
                            Update update = new Update();
                            update.set("status", 2);
                            update.set("timeStamp", System.currentTimeMillis());
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, ClinicalTrialsIncludeOrExclude.class);
                            excludeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    }else {
                        excludeList.add(new ClinicalTrialsIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 2, userId, System.currentTimeMillis()));
                    }
                }
                if (excludeList.size() > 0){
                    Collection<ClinicalTrialsIncludeOrExclude> insert = mongoTemplate.insert(excludeList, ClinicalTrialsIncludeOrExclude.class);
                    if (CollUtil.isNotEmpty(insert)){
                        excludeFlag2 = true;
                    }
                }
                if (excludeFlag1 || excludeFlag2){
                    flag = true;
                }
                break;
            case 1:
                //纳入
                boolean includeFlag1 = false;
                boolean includeFlag2 = false;
                List<ClinicalTrialsIncludeOrExclude> includeList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("registerNo").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    ClinicalTrialsIncludeOrExclude include = mongoTemplate.findOne(query, ClinicalTrialsIncludeOrExclude.class);
                    if (include != null){
                        Integer status = include.getStatus();
                        if (status == 2){
                            //修改为纳入
                            Update update = new Update();
                            update.set("status", 1);
                            update.set("timeStamp", System.currentTimeMillis());
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, ClinicalTrialsIncludeOrExclude.class);
                            includeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    }else {
                        includeList.add(new ClinicalTrialsIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 1, userId, System.currentTimeMillis()));
                    }
                }
                if (includeList.size() > 0){
                    Collection<ClinicalTrialsIncludeOrExclude> insert = mongoTemplate.insert(includeList, ClinicalTrialsIncludeOrExclude.class);
                    if (CollUtil.isNotEmpty(insert)){
                        includeFlag2 = true;
                    }
                }
                if (includeFlag1 || includeFlag2){
                    flag = true;
                }
                break;
            default:
                break;
        }
        return flag;
    }

    @Override
    public List<ClinicalTrialRegistration> getInfoForAdverse(String id) {
        List<ClinicalTrialRegistration> result = new ArrayList<>();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        BoolQueryBuilder clinicalTrialsQuery = QueryUtils.createClinicalTrialsInclusion(condition);
        //查询clinicaltrials数据
        clinicalTrialsQuery.must().add(QueryBuilders.termsQuery("belong", "clinicaltrials"));
        //不限制数量
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(clinicalTrialsQuery);
        nativeSearchQuery.setMaxResults(100);
        SearchHits<ClinicalIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, ClinicalIndex.class);
        List<String> ids = new ArrayList<>();
        for (SearchHit<ClinicalIndex> clinicalIndexSearchHit : search) {
            String registerId = clinicalIndexSearchHit.getContent().getId();
            ids.add(registerId);
        }
        //暂时使用正式环境mongo
        List<ClinicalTrialRegistration> registrations = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(ids)), ClinicalTrialRegistration.class);
        if (CollUtil.isNotEmpty(registrations)) {
            result.addAll(registrations);
        }
        return result;
    }

    @Override
    public Boolean defaultInclusion(String id, Long userId) {
        ClinicalTrialsSearchRequest zhSearchDto = new ClinicalTrialsSearchRequest();
        zhSearchDto.setId(id);
        zhSearchDto.setChange(0);
        ClinicalTrialsSearchRequest enSearchDto = new ClinicalTrialsSearchRequest();
        enSearchDto.setId(id);
        enSearchDto.setChange(1);
//        List<ClinicalTrialsResponse> zhList = clinicalTrials(id, userId, 0);
        List<ClinicalTrialsResponse> enList = clinicalTrials(id, userId, 1);
        log.info("临床实验英文默认纳入查询{}篇", enList.size());
        // 需要对纳入的英文的临床试验 有studyResults研究结果的才进行纳入
        List<ClinicalTrialsResponse> clinicalTrialsResponses = new ArrayList<>();
        if (CollUtil.isNotEmpty(enList)) {
            for (ClinicalTrialsResponse clinicalTrialsResponse : enList) {
                if (clinicalTrialsResponses.size() == 10) break;
                String registerNo = clinicalTrialsResponse.getRegisterNo();
                if (ReleaseMongoUtil.mongo.exists(Query.query(new Criteria().andOperator(Criteria.where("register_no").is(registerNo), Criteria.where("study_results").is(true))), ClinicalTrialRegistrationWithResults.class)) {
                    clinicalTrialsResponses.add(clinicalTrialsResponse);
                }
            }
            enList = clinicalTrialsResponses;
        }
        log.info("临床实验英文默认纳入有 studyResult 的{}篇", enList.size());
        List<String> ids = new ArrayList<>();
//        zhList.forEach(clinicalTrialsVo -> ids.add(clinicalTrialsVo.getRegisterNo()));
        enList.forEach(clinicalTrialsResponse -> ids.add(clinicalTrialsResponse.getRegisterNo()));
        if (CollUtil.isNotEmpty(ids)) {
            OperateRequest operateDto = new OperateRequest(id, ids, 1);
            operate(operateDto, userId);
            return true;
        }
        return false;
    }

    private List<ClinicalTrialsResponse> clinicalTrials(String id, Long userId, int language) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        // 拼接检索条件
        BoolQueryBuilder clinicalTrialsQuery = QueryUtils.createClinicalTrialsInclusion(condition);
        // 区分中英文临床试验
        String belong;
        if (language == 0){
            //chictr
            belong = "chictr";
        }else {
            //clinicaltrials
            belong = "clinicaltrials";
        }
        clinicalTrialsQuery.must().add(QueryBuilders.termQuery("belong.keyword", belong));
//        // 研究阶段 优先取高等级
//        Map<String, Object> map = new LinkedHashMap<>();
//        map.put("studyPhase", Constants.STUDY_PHASE);
//        Script script = new Script(ScriptType.INLINE, "painless", 
//                "if(doc['studyPhase.keyword'].value == 'phase 4') return 10; " +
//                "if(doc['studyPhase.keyword'].value == 'phase 3') return 9; " +
//                "if(doc['studyPhase.keyword'].value == 'phase 2/phase 3') return 8; " +
//                "if(doc['studyPhase.keyword'].value == 'phase 2') return 7; " +
//                "if(doc['studyPhase.keyword'].value == 'phase 1/phase 2') return 6; " +
//                "if(doc['studyPhase.keyword'].value == 'phase 1') return 5; " +
//                "if(doc['studyPhase.keyword'].value == 'early phase 1') return 4; " +
//                "if(doc['studyPhase.keyword'].value == 'n/a') return 3; " +
//                "if(doc['studyPhase.keyword'].value == 'not applicable') return 2; " +
//                "return 1;", map);
//        SortBuilder<ScriptSortBuilder> sortBuilder = new ScriptSortBuilder(script, ScriptSortBuilder.ScriptSortType.NUMBER);
//        sortBuilder.order(SortOrder.DESC);
//        NativeSearchQueryBuilder queryBuilder = new NativeSearchQueryBuilder();
//        queryBuilder.withQuery(clinicalTrialsQuery); // your query here
//        queryBuilder.withSort(sortBuilder);
//        NativeSearchQuery nativeSearchQuery = queryBuilder.build();

        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(clinicalTrialsQuery);
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "registerDate"));
        nativeSearchQuery.setMaxResults(10000);
        nativeSearchQuery.setTrackTotalHits(true);
        SearchHits<ClinicalIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, ClinicalIndex.class);
        List<String> ids = new ArrayList<>();
        for (SearchHit<ClinicalIndex> clinicalIndexSearchHit : search) {
            String registerId = clinicalIndexSearchHit.getContent().getId();
            ids.add(registerId);
        }
        List<ClinicalTrialsResponse> clinicalTrialsResponses = new ArrayList<>();
        for (String s : ids) {
            ClinicalTrialRegistration registration = ReleaseMongoUtil.mongo.findById(s, ClinicalTrialRegistration.class);
            if (registration != null) {
                ClinicalTrialsResponse clinicalTrialsResponse = FormatUtil.formClinicalTrials(registration);
                //判断纳排情况
                ClinicalTrialsIncludeOrExclude includeOrExclude = mongoTemplate.findOne(new Query(Criteria.where("registerNo").is(clinicalTrialsResponse.getRegisterNo()).and("userId").is(userId).and("conditionId").is(id)), ClinicalTrialsIncludeOrExclude.class);
                if (includeOrExclude != null) {
                    clinicalTrialsResponse.setInclusionStatus(includeOrExclude.getStatus());
                }
                clinicalTrialsResponses.add(clinicalTrialsResponse);
            }
        }
        return clinicalTrialsResponses;
    }
}
