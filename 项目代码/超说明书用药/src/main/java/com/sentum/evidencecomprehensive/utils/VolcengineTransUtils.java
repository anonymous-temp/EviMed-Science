package com.sentum.evidencecomprehensive.utils;

import com.alibaba.fastjson.JSONException;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.feign.FineScreenFeign;
import org.apache.commons.lang.StringUtils;
import org.apache.commons.lang3.ObjectUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

/**
 * 翻译工具类
 * @author zgm
 */
@Service
public class VolcengineTransUtils {

    @Autowired
    private FineScreenFeign fineScreenFeign;

    @Autowired
    private MongoTemplate mongoTemplate;

    public   String getTransResult(String s){

            String translate = "";
            Criteria criteria = new Criteria();
            criteria.orOperator(Criteria.where("drugName").regex("(?i)^" + s + "$"),
                    Criteria.where("drugZh").regex("(?i)^" + s + "$"),
                    Criteria.where("drugEn").regex("(?i)^" + s + "$"),
                    Criteria.where("drugSynonymEn").regex("(?i)^" + s + "$"),
                    Criteria.where("drugSynonymZh").regex("(?i)^" + s + "$")
            );
            Query query1 = new Query(criteria.and("drugEn").ne("").and("drugZh").ne(""));
            JSONObject drugInfo = ReleaseMongoUtil.mongo.findOne(query1, JSONObject.class, "evaluation_drug_info");
            Criteria criteriaCommunity = new Criteria();
            criteriaCommunity.orOperator(Criteria.where("communityNameEn").regex("(?i)^" + s + "$"),
                    Criteria.where("communityNameZh").regex("(?i)^" + s + "$")
            );
            JSONObject communityInfo = ReleaseMongoUtil.mongo.findOne(new Query(criteriaCommunity.and("drugEn").ne("").and("drugZh").ne("")), JSONObject.class, "evaluation_drug_info");
            if (ObjectUtils.isNotEmpty(drugInfo) || ObjectUtils.isNotEmpty(communityInfo)) {
                if (GetMaxSimilarUtil.judgeChinese(s)) {
                    if (ObjectUtils.isNotEmpty(drugInfo)) {
                        translate = drugInfo.getString("drugEn").toLowerCase();
                    } else {
                        translate = communityInfo.getString("communityNameEn").toLowerCase();
                    }
                } else {
                    if (ObjectUtils.isNotEmpty(drugInfo)) {
                        translate = drugInfo.getString("drugZh").toLowerCase();
                    } else {
                        translate = communityInfo.getString("communityNameZh").toLowerCase();
                    }
                }}
            if (StringUtils.isEmpty(translate)){
                JSONObject drug1 = mongoTemplate.findOne(new Query(Criteria.where("words").regex("(?i)^" + s + "$").orOperator( Criteria.where("tandardName").regex("(?i)^" + s + "$"), Criteria.where("zhStandardName").regex("(?i)^" + s + "$"))), JSONObject.class, "drug_name_words");
                if (ObjectUtils.isNotEmpty(drug1)) {
                    if (GetMaxSimilarUtil.judgeChinese(s)) {
                        translate = drug1.getString("standardName").toLowerCase();
                    } else {
                        translate = drug1.getString("zhStandardName").toLowerCase();
                    }
            }}
            if (StringUtils.isEmpty(translate)) {
                Criteria criteria2 = new Criteria();
                criteria2.orOperator(Criteria.where("adrs_en").is(s), Criteria.where("adrs_ch").is(s));
                JSONObject one = ReleaseMongoUtil.mongo.findOne(new Query(criteria2), JSONObject.class, "fears_vigi_adrs");
                if (ObjectUtils.isNotEmpty(one)) {
                    if (GetMaxSimilarUtil.judgeChinese(s)) {
                        translate = one.getString("adrs_en").toLowerCase();
                    } else {
                        translate = one.getString("adrs_ch").toLowerCase();
                    }
                }
            }
            if (StringUtils.isEmpty(translate)) {
                translate = translate(s);
            }
     return translate;
    }

    private String translate(String word) {
        JSONObject jsonObject = new JSONObject();
        jsonObject.put("word", word);
        try {
            return fineScreenFeign.deepl(jsonObject);
        } catch (JSONException e) {
            return "";
        }
    }
}
