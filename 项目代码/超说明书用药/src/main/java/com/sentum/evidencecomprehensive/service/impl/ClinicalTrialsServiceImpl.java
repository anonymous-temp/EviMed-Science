package com.sentum.evidencecomprehensive.service.impl;

import com.mongodb.client.result.DeleteResult;
import com.mongodb.client.result.UpdateResult;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import com.sentum.evidencecomprehensive.pojo.bo.es.ClinicalIndex;
import com.sentum.evidencecomprehensive.pojo.bo.es.ThreeClinicalIndex;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.ClinicalTrialRegistration;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.ClinicalTrialsIncludeOrExclude;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.ThreeClinicalTrial;
import com.sentum.evidencecomprehensive.pojo.dto.ClinicalTrialsOperateDto;
import com.sentum.evidencecomprehensive.pojo.dto.ClinicalTrialsSearchDto;
import com.sentum.evidencecomprehensive.pojo.dto.ThreeClinicalTrialsSearchDto;
import com.sentum.evidencecomprehensive.pojo.vo.ClinicalTrialsVo;
import com.sentum.evidencecomprehensive.pojo.vo.PageVo;
import com.sentum.evidencecomprehensive.pojo.vo.ThreeClinicalTrialsVo;
import com.sentum.evidencecomprehensive.service.ClinicalTrialsService;
import com.sentum.evidencecomprehensive.utils.FormatUtil;
import com.sentum.evidencecomprehensive.utils.QueryUtils;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import org.apache.commons.collections.CollectionUtils;
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

import java.time.LocalDate;
import java.util.*;

@Service
public class ClinicalTrialsServiceImpl implements ClinicalTrialsService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private FineScreenFeign fineScreenFeign;

    @Override
    public PageVo<ThreeClinicalTrialsVo> threeList(ThreeClinicalTrialsSearchDto searchDto) {
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
        if (CollectionUtils.isNotEmpty(source)) {
            threeInstructionQuery.must().add(QueryBuilders.termsQuery("source", source));
        }

        // 语言
        List<String> language = searchDto.getLanguage();
        if (CollectionUtils.isNotEmpty(language)) {
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
            nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize()));
        }

        nativeSearchQuery.setTrackTotalHits(true);
//        nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize()));
        SearchHits<ThreeClinicalIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, ThreeClinicalIndex.class);
        List<ThreeClinicalTrialsVo> list = new ArrayList<>();
        for (SearchHit<ThreeClinicalIndex> clinicalIndexSearchHit : search) {
            ThreeClinicalIndex threeClinicalIndex = clinicalIndexSearchHit.getContent();
            ThreeClinicalTrial threeClinicalTrial = ReleaseMongoUtil.mongo.findById(threeClinicalIndex.getId(), ThreeClinicalTrial.class);

            ThreeClinicalTrialsVo threeClinicalTrialsVo = FormatUtil.formClinicalTrials(threeClinicalIndex);

            if (Objects.nonNull(threeClinicalTrial)) {
                threeClinicalTrialsVo.setJournal(StringUtils.isNotBlank(threeClinicalTrial.getJournal()) ? threeClinicalTrial.getJournal() : "Not application");
                threeClinicalTrialsVo.setPublicationType(CollectionUtils.isNotEmpty(threeClinicalTrial.getPublicationType()) ? threeClinicalTrial.getPublicationType() : Collections.emptyList());
                List<String> url = threeClinicalTrial.getUrl();
                if (CollectionUtils.isNotEmpty(url)) {
                    threeClinicalTrialsVo.setUrl(url.get(0));
                }
            }
            list.add(threeClinicalTrialsVo);
        }

        long totalHits = search.getTotalHits();
        int pages = (int) (totalHits % searchDto.getPageSize() == 0 ? totalHits / searchDto.getPageSize() : totalHits / searchDto.getPageSize() + 1);
        PageVo<ThreeClinicalTrialsVo> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(searchDto.getPageSize());
        page.setPageNum(searchDto.getPageNum());
        return page;
    }


    @Override
    public PageVo<ClinicalTrialsVo> list(ClinicalTrialsSearchDto searchDto, Long userId) {
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
                if (searchDto.getStartRegistrationTime().length() == 4) {
                    registerDate.gte(searchDto.getStartRegistrationTime() + "-00-00");
                } else {
                    registerDate.gte(LocalDate.now().getYear() + 10 + "-00-00");
                }
            }
            if (searchDto.getEndRegistrationTime() != null) {
                if (searchDto.getEndRegistrationTime().length() == 4) {
                    registerDate.lte(searchDto.getEndRegistrationTime() + "-12-31");
                } else {
                    registerDate.lte("1000-12-31");
                }
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
        if (CollectionUtils.isNotEmpty(searchDto.getRecruitmentStatus()) && change == 1) {
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
        if (CollectionUtils.isNotEmpty(searchDto.getTestPhase())) {
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
        if (CollectionUtils.isNotEmpty(searchDto.getAssociatedArticles()) && change == 1) {
            List<Integer> associatedArticles = searchDto.getAssociatedArticles();
            if (associatedArticles.size() == 1) {
                Integer integer = associatedArticles.get(0);
                TermsQueryBuilder termsQueryBuilder = QueryBuilders.termsQuery("reference", integer.toString());
                clinicalTrialsQuery.must().add(termsQueryBuilder);
            }
        }
        //研究类型
        if (CollectionUtils.isNotEmpty(searchDto.getStudyType()) && change == 0) {
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
        nativeSearchQuery.setTrackTotalHits(true);
        //按照注册时间排序
        Integer registrationTimeSort = searchDto.getRegistrationTimeSort();
        if (registrationTimeSort != null) {
            if (registrationTimeSort == 1) {
                nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize(), Sort.by(Sort.Direction.ASC, "registerDate")));
            } else {
                nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize(), Sort.by(Sort.Direction.DESC, "registerDate")));
            }
        } else {
            nativeSearchQuery.setPageable(PageRequest.of(searchDto.getPageNum() - 1, searchDto.getPageSize()));
        }
        SearchHits<ClinicalIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, ClinicalIndex.class);
        List<String> ids = new ArrayList<>();
        for (SearchHit<ClinicalIndex> clinicalIndexSearchHit : search) {
            String registerId = clinicalIndexSearchHit.getContent().getId();
            ids.add(registerId);
        }
        List<ClinicalTrialsVo> list = new ArrayList<>();
        for (String s : ids) {
//            ClinicalTrialRegistration registration = fineScreenFeign.clinicalTrials(s);
            ClinicalTrialRegistration registration = ReleaseMongoUtil.mongo.findById(s, ClinicalTrialRegistration.class);
            if (registration != null) {
                ClinicalTrialsVo clinicalTrialsVo = FormatUtil.formClinicalTrials(registration);
                //判断纳排情况
                ClinicalTrialsIncludeOrExclude includeOrExclude = mongoTemplate.findOne(new Query(Criteria.where("registerNo").is(clinicalTrialsVo.getRegisterNo()).and("userId").is(userId).and("conditionId").is(id)), ClinicalTrialsIncludeOrExclude.class);
                if (includeOrExclude != null) {
                    clinicalTrialsVo.setInclusionStatus(includeOrExclude.getStatus());
                }
                list.add(clinicalTrialsVo);
            }
        }
        /*List<ClinicalTrialRegistration> registrations = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(ids)), ClinicalTrialRegistration.class);
        for (ClinicalTrialRegistration registration : registrations) {
            ClinicalTrialsVo clinicalTrialsVo = FormatUtil.formClinicalTrials(registration);
            //判断纳排情况
            ClinicalTrialsIncludeOrExclude includeOrExclude = mongoTemplate.findOne(new Query(Criteria.where("registerNo").is(clinicalTrialsVo.getRegisterNo()).and("userId").is(userId).and("conditionId").is(id)), ClinicalTrialsIncludeOrExclude.class);
            if (includeOrExclude != null){
                clinicalTrialsVo.setInclusionStatus(includeOrExclude.getStatus());
            }
            list.add(clinicalTrialsVo);
        }*/
        long totalHits = search.getTotalHits();
        int pages = (int) (totalHits % searchDto.getPageSize() == 0 ? totalHits / searchDto.getPageSize() : totalHits / searchDto.getPageSize() + 1);
        PageVo<ClinicalTrialsVo> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(searchDto.getPageSize());
        page.setPageNum(searchDto.getPageNum());
        return page;
    }

    @Override
    public Boolean operate(ClinicalTrialsOperateDto operateDto, Long userId) {
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
                    if (CollectionUtils.isNotEmpty(insert)){
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
                    if (CollectionUtils.isNotEmpty(insert)){
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
        //暂定默认取值10条
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(clinicalTrialsQuery);
        nativeSearchQuery.setMaxResults(100);
        SearchHits<ClinicalIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, ClinicalIndex.class);
        List<String> ids = new ArrayList<>();
        for (SearchHit<ClinicalIndex> clinicalIndexSearchHit : search) {
            String registerId = clinicalIndexSearchHit.getContent().getId();
            ids.add(registerId);
        }
        //暂时使用正式环境mongo
//        ids.forEach(o -> result.add(fineScreenFeign.clinicalTrials(o)));
        List<ClinicalTrialRegistration> registrations = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(ids)), ClinicalTrialRegistration.class);
        if (CollectionUtils.isNotEmpty(registrations)) {
            result.addAll(registrations);
        }
        return result;
    }

    @Override
    public void defaultInclusion(String id, Long userId) {
        ClinicalTrialsSearchDto zhSearchDto = new ClinicalTrialsSearchDto();
        zhSearchDto.setId(id);
        zhSearchDto.setChange(0);
        ClinicalTrialsSearchDto enSearchDto = new ClinicalTrialsSearchDto();
        enSearchDto.setId(id);
        enSearchDto.setChange(1);
        PageVo<ClinicalTrialsVo> zhList = list(zhSearchDto, userId);
        PageVo<ClinicalTrialsVo> enList = list(enSearchDto, userId);
        List<String> ids = new ArrayList<>();
        zhList.getList().forEach(clinicalTrialsVo -> ids.add(clinicalTrialsVo.getRegisterNo()));
        enList.getList().forEach(clinicalTrialsVo -> ids.add(clinicalTrialsVo.getRegisterNo()));
        if (CollectionUtils.isNotEmpty(ids)) {
            ClinicalTrialsOperateDto operateDto = new ClinicalTrialsOperateDto(id, ids, 1);
            operate(operateDto, userId);
        }
    }
}
