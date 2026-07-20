package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.sentum.evidencecomprehensive.domain.es.PaperIndex;
import com.sentum.evidencecomprehensive.domain.mongo.GuideIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.mongo.HtaIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.mongo.HtaReport;
import com.sentum.evidencecomprehensive.domain.mongo.PaperIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.vo.req.HtaReportSearchRequest;
import com.sentum.evidencecomprehensive.service.PharmacySearchService;
import com.sentum.evidencecomprehensive.utils.ReleaseMongoUtil;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.index.query.IdsQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/4/1
 */
@Slf4j
@Service
public class PharmacySearchServiceImpl implements PharmacySearchService {

    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    
    @Override
    public List<HtaReport> searchHtaReport(HtaReportSearchRequest htaReportSearchRequest) {
        List<HtaReport> result = new ArrayList<>();
        
        List<String> ids = htaReportSearchRequest.getIds();
        if (CollUtil.isNotEmpty(ids)) {
            try {
                result = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(ids)), HtaReport.class);
            } catch (Exception e) {
                log.error(e.getMessage(), e);
            }            
        }  
        return result;
    }

    @Override
    public List<PaperIncludeOrExclude> searchPaperInclude(String id, Integer status, Integer includeType, Integer type) {

        if (StrUtil.isNotBlank(id)) {
            AtomicBoolean economyInclude = new AtomicBoolean(false);
            AtomicBoolean effectInclude = new AtomicBoolean(false);
           
            if (Objects.nonNull(includeType)) {
               return mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1).and("type").is(includeType)), PaperIncludeOrExclude.class);
            }
            if (type == 2) {
                return mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);
            }      
            List<PaperIncludeOrExclude> paperIncludeOrExcludes = mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), PaperIncludeOrExclude.class);
            if (CollUtil.isNotEmpty(paperIncludeOrExcludes)) {

                IdsQueryBuilder idsQueryBuilder = QueryBuilders.idsQuery().addIds(paperIncludeOrExcludes.stream().map(PaperIncludeOrExclude::getPaperId).toArray(String[]::new));
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(idsQueryBuilder);
                nativeSearchQuery.setMaxResults(500);
                SearchHits<PaperIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, PaperIndex.class);
                List<SearchHit<PaperIndex>> searchHits = search.getSearchHits();
                if (CollUtil.isNotEmpty(searchHits)) {

                    searchHits.stream().map(SearchHit::getContent).forEach(paperIndex -> {
                        List<Integer> lastNewType = paperIndex.getLastNewType();
                        if (CollUtil.isNotEmpty(lastNewType) && lastNewType.size() == 1 && lastNewType.contains(12)) {
                            economyInclude.set(true);
                        }
                        if (CollUtil.isNotEmpty(lastNewType)) {
                            if (!lastNewType.contains(12) || lastNewType.size() == 2) {
                                effectInclude.set(true);
                            }
                        }
                    });
                }      
            }
            
            if (type == 1) {
                if (economyInclude.get()) {
                    return paperIncludeOrExcludes;
                } else {
                    return Collections.emptyList();
                }
            }     
            
            if (type == 0) {
                if (effectInclude.get()) {
                    return paperIncludeOrExcludes;
                } else {
                    return Collections.emptyList();
                }
            }     
        }
        return Collections.emptyList();
    }

    @Override
    public List<GuideIncludeOrExclude> searchGuideInclude(String id, int status) {
        
        if (StrUtil.isNotBlank(id)) {
            return mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), GuideIncludeOrExclude.class);
        }
        return Collections.emptyList();
    }

    @Override
    public List<HtaIncludeOrExclude> searchHtaInclude(String id, int status) {
        
        if (StrUtil.isNotBlank(id)) {
            return mongoTemplate.find(new Query(Criteria.where("conditionId").is(id).and("status").is(1)), HtaIncludeOrExclude.class);
        }
        return Collections.emptyList();
    }
}
