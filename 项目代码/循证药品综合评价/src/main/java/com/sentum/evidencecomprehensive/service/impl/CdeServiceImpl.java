package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.mongodb.client.result.DeleteResult;
import com.mongodb.client.result.UpdateResult;
import com.sentum.evidencecomprehensive.domain.mongo.CdeCollect;
import com.sentum.evidencecomprehensive.domain.mongo.CdeIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.es.CdeIndex;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;
import com.sentum.evidencecomprehensive.domain.vo.resp.CdeResponse;
import com.sentum.evidencecomprehensive.domain.vo.req.CdeRequest;
import com.sentum.evidencecomprehensive.excel.converter.service.CdeEsDtoToBoConverter;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.service.CdeService;
import com.sentum.evidencecomprehensive.utils.ObjectToListUtil;
import com.sentum.evidencecomprehensive.utils.QueryUtils;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.index.query.*;
import org.springframework.beans.BeanUtils;
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
import java.util.stream.Collectors;

/**
 * Description:  cde service
 */
@Slf4j
@Service
public class CdeServiceImpl implements CdeService {

    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    
    @Override
    public PageVo<CdeResponse> list(CdeRequest cdeRequest, Long userId) {
        String id = cdeRequest.getId();
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) {
            throw new RuntimeException("检索id异常");
        }
        BoolQueryBuilder cdeQuery = QueryUtils.createCdeQuery(condition);
        String acceptid = cdeRequest.getAcceptid();
        if (StrUtil.isNotBlank(acceptid)) {
            cdeQuery.must(QueryBuilders.termQuery("acceptid.keyword", acceptid));
        }
        String drgnamecn = cdeRequest.getDrgnamecn();
        if (StrUtil.isNotBlank(drgnamecn)) {
            cdeQuery.must(QueryBuilders.matchPhraseQuery("drgnamecn", drgnamecn));
        }
        String companys = cdeRequest.getCompanys();
        if (StrUtil.isNotBlank(companys)) {
            cdeQuery.must(QueryBuilders.matchPhraseQuery("companys", companys));
        }
        //二次搜索条件
        String searchCon = cdeRequest.getSearchCon();
        if (StringUtils.isNotBlank(searchCon)) {
            BoolQueryBuilder searchConBoolQueryBuilder = new BoolQueryBuilder();
            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(searchCon, "drgnamecn", "companys");
            multiMatchQueryBuilder.operator(Operator.AND);
            //使用精准查询
            multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
            searchConBoolQueryBuilder.should().add(multiMatchQueryBuilder);
            searchConBoolQueryBuilder.should().add(QueryBuilders.termQuery("acceptid.keyword", searchCon));
            searchConBoolQueryBuilder.should().add(QueryBuilders.termQuery("registerkind", searchCon));
            searchConBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugtype", searchCon));
//            searchConBoolQueryBuilder.should().add(QueryBuilders.("date", searchCon));
            cdeQuery.must().add(searchConBoolQueryBuilder);
        }
        //排序-分页
        Integer dateSort = cdeRequest.getDateSort();
        PageRequest pageRequest = PageRequest.of(cdeRequest.getPageNum() - 1, cdeRequest.getPageSize());
        Sort.Direction direction = Sort.Direction.ASC;
        if (dateSort == 0) {
            direction = Sort.Direction.DESC;
            pageRequest = PageRequest.of(cdeRequest.getPageNum() - 1, cdeRequest.getPageSize(), Sort.by(direction, "dateTimeDateTs"));
        }
        Integer operateType = cdeRequest.getOperateType();
        if (operateType == 1) {
            List<CdeIncludeOrExclude> cdeIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("userId").is(userId).and("status").is(1)), CdeIncludeOrExclude.class);
            cdeQuery.must().add(QueryBuilders.idsQuery().addIds(cdeIncludeOrExcludes.stream().map(CdeIncludeOrExclude::getCdeId).toArray(String[]::new)));
        }
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(cdeQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(pageRequest);
        SearchHits<CdeIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, CdeIndex.class);
        long totalHits = searchHits.getTotalHits();
        List<CdeResponse> list = new ArrayList<>();
        if (searchHits.getTotalHits() > 0) {
            for (SearchHit<CdeIndex> searchHit : searchHits) {
                CdeIndex cde = searchHit.getContent();
                CdeResponse cdeResponse = CdeEsDtoToBoConverter.INSTANCE.esDtoToVo(cde);
                if (userId != null) {
                    Criteria criteria = Criteria.where("cdeId").is(cdeResponse.getId()).and("userId").is(userId).and("conditionId").is(id);
                    //判断纳入/排除情况
                    CdeIncludeOrExclude includeOrExclude = mongoTemplate.findOne(new Query(criteria), CdeIncludeOrExclude.class);
                    if (includeOrExclude != null) {
                        Integer status = includeOrExclude.getStatus();
                        cdeResponse.setBringIntoOrExcludeMark(status);
                    }
                    //判断收藏情况
                    CdeCollect collect = mongoTemplate.findOne(new Query(criteria), CdeCollect.class);
                    if (collect != null) {
                        cdeResponse.setCollectionMark(1);
                    }
                }
                list.add(cdeResponse);
            }
        }
        int pages = (int) (totalHits % cdeRequest.getPageSize() == 0 ? totalHits / cdeRequest.getPageSize() : totalHits / cdeRequest.getPageSize() + 1);
        PageVo<CdeResponse> page = new PageVo<>();
        page.setList(list);
        page.setTotal(totalHits);
        page.setPages(pages);
        page.setPageSize(cdeRequest.getPageSize());
        page.setPageNum(cdeRequest.getPageNum());
        return page;
    }

    @Override
    public Boolean operate(OperateRequest operateRequest, Long userId) {
        String conditionId = operateRequest.getId();
        List<String> ids = operateRequest.getIds();
        //操作的命令，1-纳入；2-取消纳入；3-排除；4-取消排除；5-收藏；6-取消收藏
        Integer operate = operateRequest.getOperate();
        boolean flag = false;
        switch (operate) {
            case 2:
            case 4:
                DeleteResult deleteInclude = mongoTemplate.remove(new Query(Criteria.where("cdeId").in(ids).and("userId").is(userId).and("conditionId").is(conditionId)), CdeIncludeOrExclude.class);
                flag = deleteInclude.getDeletedCount() > 0;
                break;
            case 6:
                DeleteResult deleteCollet = mongoTemplate.remove(new Query(Criteria.where("cdeId").in(ids).and("userId").is(userId).and("conditionId").is(conditionId)), CdeCollect.class);
                flag = deleteCollet.getDeletedCount() > 0;
                break;
            case 1:
                boolean includeFlag1 = false;
                boolean includeFlag2 = false;
                List<CdeIncludeOrExclude> includeList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("cdeId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    CdeIncludeOrExclude include = mongoTemplate.findOne(query, CdeIncludeOrExclude.class);
                    if (include != null) {
                        Integer status = include.getStatus();
                        if (status == 2) {
                            //修改为纳入
                            Update update = new Update();
                            update.set("status", 1);
                            update.set("timeStamp", System.currentTimeMillis());
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, CdeIncludeOrExclude.class);
                            includeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    } else {
                        includeList.add(new CdeIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 1, userId, System.currentTimeMillis()));
                    }
                }
                if (!includeList.isEmpty()) {
                    Collection<CdeIncludeOrExclude> insert = mongoTemplate.insert(includeList, CdeIncludeOrExclude.class);
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
                List<CdeIncludeOrExclude> excludeList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("cdeId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    CdeIncludeOrExclude exclude = mongoTemplate.findOne(query, CdeIncludeOrExclude.class);
                    if (exclude != null) {
                        Integer status = exclude.getStatus();
                        if (status == 1) {
                            //修改为排除
                            Update update = new Update();
                            update.set("status", 2);
                            update.set("timeStamp", System.currentTimeMillis());
                            UpdateResult updateResult = mongoTemplate.updateFirst(query, update, CdeIncludeOrExclude.class);
                            excludeFlag1 = updateResult.getModifiedCount() > 0;
                        }
                    } else {
                        excludeList.add(new CdeIncludeOrExclude(UUID.randomUUID().toString(), conditionId, id, 2, userId, System.currentTimeMillis()));
                    }
                }
                if (!excludeList.isEmpty()) {
                    Collection<CdeIncludeOrExclude> insert = mongoTemplate.insert(excludeList, CdeIncludeOrExclude.class);
                    if (CollUtil.isNotEmpty(insert)) {
                        excludeFlag2 = true;
                    }
                }
                if (excludeFlag1 || excludeFlag2) {
                    flag = true;
                }
                break;
            case 5:
                List<CdeCollect> collectList = new ArrayList<>();
                for (String id : ids) {
                    Query query = new Query(Criteria.where("cdeId").is(id).and("userId").is(userId).and("conditionId").is(conditionId));
                    boolean exists = mongoTemplate.exists(query, CdeCollect.class);
                    if (!exists) {
                        collectList.add(new CdeCollect(UUID.randomUUID().toString(), conditionId, id, userId, System.currentTimeMillis()));
                    }
                }
                if (!collectList.isEmpty()) {
                    Collection<CdeCollect> insert = mongoTemplate.insert(collectList, CdeCollect.class);
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

    @Override
    public PageVo<CdeResponse> collect(CdeRequest cdeRequest, long userId) {
        List<CdeResponse> result = new ArrayList<>();
        List<CdeCollect> cdeCollects = mongoTemplate.find(new Query(Criteria.where("userId").is(userId)), CdeCollect.class);
        List<String> cdeCollectIds = new ArrayList<>();
        if (CollUtil.isNotEmpty(cdeCollects)) {
            cdeCollectIds = cdeCollects.stream().map(CdeCollect::getCdeId).collect(Collectors.toList());
        }

        cdeCollectIds = cdeCollectIds.stream().distinct().collect(Collectors.toList());
        IdsQueryBuilder idsQueryBuilder = new IdsQueryBuilder();
        idsQueryBuilder.addIds(cdeCollectIds.toArray(new String[0]));
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
        nativeSearchQuery.setPageable(PageRequest.of(cdeRequest.getPageNum() - 1, cdeRequest.getPageSize()));
        nativeSearchQuery.setTrackTotalHits(true);
        long total_count = elasticsearchRestTemplate.count(nativeSearchQuery, CdeIndex.class);
        SearchHits<CdeIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, CdeIndex.class);
        List<SearchHit<CdeIndex>> searchHits = search.getSearchHits();

        for (SearchHit<CdeIndex> searchHit : searchHits) {
            CdeIndex cdeIndex = searchHit.getContent();
            CdeResponse cdeResponse = new CdeResponse();
            BeanUtils.copyProperties(cdeIndex, cdeResponse);
            result.add(cdeResponse);
        }

        PageVo<CdeResponse> pageVo = new PageVo<>();
        pageVo.setPageNum(cdeRequest.getPageNum());
        pageVo.setPageSize(cdeRequest.getPageSize());
        pageVo.setTotal(total_count);
        pageVo.setPages((int) (total_count % cdeRequest.getPageSize() == 0 ? total_count / cdeRequest.getPageSize() : total_count / cdeRequest.getPageSize() + 1));
        pageVo.setList(result);
        return pageVo;
    }

//    @Override
//    public Boolean cdeInclude(Condition condition, long userId) {
//        List<String> ids = new ArrayList<>();
//
//        BoolQueryBuilder cdeQuery = QueryUtils.createCdeQuery(condition);
//        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(cdeQuery);
//        nativeSearchQuery.setTrackTotalHits(true);
//        // 开始查询
//        SearchHits<CdeIndex> searchHits = elasticsearchRestTemplate.search(nativeSearchQuery, CdeIndex.class);
//        long cdeTotal = elasticsearchRestTemplate.count(nativeSearchQuery, CdeIndex.class);
//        log.info("cde默认查询{}篇", cdeTotal);
//        if (cdeTotal > 0) {
//            nativeSearchQuery.setMaxResults(50);
//            SearchHits<CdeIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, CdeIndex.class);
//            ids.addAll(search.stream().map(SearchHit::getContent).map(CdeIndex::getId).collect(Collectors.toList()));
//        }
//        if (CollUtil.isNotEmpty(ids)) {
//            // 只纳入有标注内容的 也就是pdf_tag_list & pdf_data_list  ！= null & 空的
//            List<ResultHtaReport> resultHtaReports = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(ids)), ResultHtaReport.class);
//            if (CollUtil.isNotEmpty(resultHtaReports)) {
//                ids = resultHtaReports.stream().filter(resultHtaReport ->
//                                CollUtil.isNotEmpty(resultHtaReport.getPdfTagList())
//                                        && CollUtil.isNotEmpty(resultHtaReport.getWordCleanImagePdfDataGptVerList())
//                                        && CollUtil.isNotEmpty(resultHtaReport.getCleanImagePdfDataGptVerList()))
//                        .map(ResultHtaReport::getId)
//                        .collect(Collectors.toList());
//                if (CollUtil.isNotEmpty(ids)) { // 这次的 ids 有可能为空
//                    OperateRequest OperateRequest = new OperateRequest(id, ids, 1);
//                    operate(OperateRequest, userId);
//                    log.info("hta纳入查询到{}篇", ids.size());
//                    return true;
//                }
//            }
//        }
//        return false;
//    }
}
