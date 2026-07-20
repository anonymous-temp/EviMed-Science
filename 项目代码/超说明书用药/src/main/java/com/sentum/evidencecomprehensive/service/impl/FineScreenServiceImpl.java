package com.sentum.evidencecomprehensive.service.impl;

import com.sentum.evidencecomprehensive.pojo.bo.es.AssociationalWord;
import com.sentum.evidencecomprehensive.service.FineScreenService;
import lombok.extern.slf4j.Slf4j;
import org.elasticsearch.index.query.InnerHitBuilder;
import org.elasticsearch.index.query.PrefixQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.elasticsearch.search.collapse.CollapseBuilder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * Description:
 * DateTime: 2024/4/12
 */
@Slf4j
@Service
public class FineScreenServiceImpl implements FineScreenService {

    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;
    
    @Override
    public List<String> getAssociationalWord(String word) {
        if (word.length() > 20) {
            return new ArrayList<>();
        }
        word = word.toLowerCase();
        PrefixQueryBuilder prefixQueryBuilder = QueryBuilders.prefixQuery("word", word);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(prefixQueryBuilder);
        nativeSearchQuery.setPageable(PageRequest.of(0, 5));
        nativeSearchQuery.addSort(Sort.by(Sort.Direction.ASC, "size"));
        //尝试去重操作-需定义keyword类型的字段进行去重操作
        //CardinalityAggregationBuilder wordBuilder = AggregationBuilders.cardinality("search").field("word").precisionThreshold(100);
        CollapseBuilder collapseBuilder = new CollapseBuilder("word");
        InnerHitBuilder innerHitBuilder = new InnerHitBuilder();
        innerHitBuilder.setSize(5);
        innerHitBuilder.setName("top_search");
        collapseBuilder.setInnerHits(innerHitBuilder);
        nativeSearchQuery.setCollapseBuilder(collapseBuilder);
        //nativeSearchQuery.setAggregations(new ArrayList<>(Collections.singletonList(wordBuilder)));
        SearchHits<AssociationalWord> search = elasticsearchRestTemplate.search(nativeSearchQuery, AssociationalWord.class);
        //对数据进行处理返回给前台
        List<String> list = new ArrayList<>();
        for (org.springframework.data.elasticsearch.core.SearchHit<AssociationalWord> associationalWordSearchHit : search) {
            AssociationalWord content = associationalWordSearchHit.getContent();
            list.add(content.getWord());
        }
        return list;
    }

}
