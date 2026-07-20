package com.sentum.util;

import cn.hutool.core.collection.CollUtil;
import com.sentum.pojo.ATCDrugs;
import com.sentum.pojo.DrugAndIndicationIndex;
import org.apache.commons.lang3.StringUtils;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.MultiMatchQueryBuilder;
import org.elasticsearch.index.query.Operator;
import org.elasticsearch.index.query.QueryBuilders;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQueryBuilder;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 火山翻译工具类
 *
 * @author zgm
 */
@Component
public class VolcengineTransUtils {
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;

    public static ElasticsearchRestTemplate esTemplate;

    @PostConstruct
    public void getMongoTemplate() {
        esTemplate = this.elasticsearchRestTemplate;
    }

    @Deprecated
    public static Map<String, String> getTransResult(List<String> list) {
        VolcengineTransApi volcengineTransApi = new VolcengineTransApi();
        Map<String, String> resultMap = new HashMap<>();
        List<String> enList = new ArrayList<>();
        List<String> zhList = new ArrayList<>();
        for (String s : list) {

            BoolQueryBuilder synonymBoolQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", s));  // 药品名称
            MultiMatchQueryBuilder drugName1 = QueryBuilders.multiMatchQuery(s, "drugName");
            drugName1.operator(Operator.AND);
            drugName1.slop(0);
            drugName1.type(MultiMatchQueryBuilder.Type.PHRASE);
            orBoolQueryBuilder.should().add(drugName1); // 同义词 五级中英文
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", s));  // 商品名
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", s));  // 商品名
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugZh.keyword", s));  // 药品中文
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugEn.keyword", s));  // 药品英文
            synonymBoolQueryBuilder.must().add(orBoolQueryBuilder);

            NativeSearchQueryBuilder queryBuilder = new NativeSearchQueryBuilder();
            queryBuilder.withQuery(synonymBoolQueryBuilder);
            queryBuilder.withPageable(PageRequest.of(0, 1)); // 设置分页，只获取第一个结果

            SearchHits<DrugAndIndicationIndex> results = esTemplate.search(queryBuilder.build(), DrugAndIndicationIndex.class);
            long totalHits = results.getTotalHits();
            DrugAndIndicationIndex atcDrugs = new DrugAndIndicationIndex();
            if (totalHits != 0) {
                 atcDrugs = results.getSearchHit(0).getContent();
            }
                //优先判断act标准词表中是否有当前词的对应翻译
                if (GetSynonymUtil.judgeChinese(s)) {

                    if (results != null && StringUtils.isNotBlank(atcDrugs.getDrugEn())) {
                        resultMap.put(s, atcDrugs.getDrugEn());
                    } else {
                        zhList.add(s);
                    }
                } else {
                    if (atcDrugs != null && StringUtils.isNotBlank(atcDrugs.getDrugZh())) {
                        resultMap.put(s, atcDrugs.getDrugZh());
                    } else {
                        enList.add(s);
                    }
                }
            }

        if (CollUtil.isNotEmpty(zhList)) {
            List<String> zh = volcengineTransApi.getTransResult(zhList, "en");
            if (CollUtil.isNotEmpty(zh)) {
                for (int i = 0; i < zh.size(); i++) {
                    resultMap.put(zhList.get(i), zh.get(i));
                }
            }
        }
        if (CollUtil.isNotEmpty(enList)) {
            List<String> en = volcengineTransApi.getTransResult(enList, "zh");
            if (CollUtil.isNotEmpty(en)) {
                for (int i = 0; i < en.size(); i++) {
                    resultMap.put(enList.get(i), en.get(i));
                }
            }
        }
        return resultMap;
    }
}
