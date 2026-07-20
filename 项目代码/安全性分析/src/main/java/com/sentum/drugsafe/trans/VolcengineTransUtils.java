package com.sentum.drugsafe.trans;

import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.feign.FineScreenFeign;
import com.sentum.drugsafe.pojo.DrugAndIndicationIndex;
import com.sentum.drugsafe.utils.GetMaxSimilarUtil;
import org.apache.commons.lang.StringUtils;
import org.apache.commons.lang3.ObjectUtils;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * 火山翻译工具类
 * @author zgm
 */
@Service
public class VolcengineTransUtils {

    @Autowired
    private  FineScreenFeign fineScreenFeign;

    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;


    public Map<String,String> getTransResult(List<String> strs) {
        HashMap<String, String> stringStringHashMap = new HashMap<>();
        for (String str : strs) {
            str = str.trim();
            String translate = "";

            // 利用es 查询 中英文对应的翻译词
            BoolQueryBuilder synonymBoolQueryBuilder = QueryBuilders.boolQuery();

            BoolQueryBuilder orBoolQueryBuilder = QueryBuilders.boolQuery();
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("zhDrugName.keyword", str));  // 药品名称
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugName.keyword", str)); // 同义词 五级中英文
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameZh.keyword", str));  // 商品名
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("commodityNameEn.keyword", str));  // 商品名
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugZh.keyword", str));  // 药品中文
            orBoolQueryBuilder.should().add(QueryBuilders.termQuery("drugEn.keyword", str));  // 药品英文
            synonymBoolQueryBuilder.must().add(orBoolQueryBuilder);

            BoolQueryBuilder notBlankBoolQueryBuilder = QueryBuilders.boolQuery();
            if (GetMaxSimilarUtil.judgeChinese(str)) {
                notBlankBoolQueryBuilder.must().add(QueryBuilders.existsQuery("drugEn"));
                notBlankBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("drugEn.keyword", ""));
            } else {
                notBlankBoolQueryBuilder.must().add(QueryBuilders.existsQuery("drugZh"));
                notBlankBoolQueryBuilder.mustNot().add(QueryBuilders.termQuery("drugZh.keyword", ""));
            }
            synonymBoolQueryBuilder.must().add(notBlankBoolQueryBuilder);
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(synonymBoolQueryBuilder);
            SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit = elasticsearchRestTemplate.searchOne(nativeSearchQuery, DrugAndIndicationIndex.class);
            if (Objects.nonNull(drugAndIndicationIndexSearchHit)) {
                DrugAndIndicationIndex drugInfo = drugAndIndicationIndexSearchHit.getContent();
                if (GetMaxSimilarUtil.judgeChinese(str)) {
                    translate = drugInfo.getDrugEn();
                } else {
                    translate = drugInfo.getDrugZh();
                }
            }

            if (StringUtils.isEmpty(translate)) {
                Criteria criteria2 = new Criteria();
                criteria2.orOperator(Criteria.where("adrs_en").is(str), Criteria.where("adrs_ch").is(str));
                JSONObject one = mongoTemplate.findOne(new Query(criteria2), JSONObject.class, "fears_vigi_adrs");
                if (ObjectUtils.isNotEmpty(one)) {
                    if (GetMaxSimilarUtil.judgeChinese(str)) {
                        translate = one.getString("adrs_en").toLowerCase();
                    } else {
                        translate = one.getString("adrs_ch").toLowerCase();
                    }
                }
            }

            if (StringUtils.isBlank(translate)) {
                JSONObject drug1 = mongoTemplate.findOne(new Query(Criteria.where("words").is(str)), JSONObject.class, "drug_name_words");
                if (ObjectUtils.isNotEmpty(drug1)) {
                    if (GetMaxSimilarUtil.judgeChinese(str)) {
                        translate = drug1.getString("standardName").toLowerCase();
                    } else {
                        translate = drug1.getString("zhStandardName").toLowerCase();
                    }
                }
            }
            if (StringUtils.isBlank(translate)){
                translate = translate(str).toLowerCase();
            }

            stringStringHashMap.put(str, translate);
        }
        return stringStringHashMap;

    }



    private String translate(String word) {
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("word", word);
        return fineScreenFeign.deepl(jsonObject);
    }
}
