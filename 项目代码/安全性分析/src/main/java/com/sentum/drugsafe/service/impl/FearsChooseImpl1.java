package com.sentum.drugsafe.service.impl;

import cn.hutool.core.collection.CollUtil;
import com.alibaba.fastjson.JSONObject;
import com.sentum.drugsafe.service.FearsChoose;
import com.sentum.drugsafe.utils.FearsMongoUtil;
import com.sentum.drugsafe.utils.JsonKeyToLower;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import java.util.HashSet;
import java.util.List;
import java.util.regex.Pattern;

@Slf4j
@Service
public  class FearsChooseImpl1 implements FearsChoose {

    @Autowired
    private FearsMongoUtil mongoUtil;

    @Async
    @Override
    public void getDrug(String databaseName) {


        for (int year = 2004; year <= 2025; year++) {
            for (int month = 1; month <= 4; month++) {
                String table =String.valueOf(year).substring(2, 4)+"Q"+month;
                String  demo = "DEMO"+table;   // ISR  primaryid
                String drug = "DRUG"+table;
                String indi = "INDI"+table;   //  DRUG_SEQ   drug_seq
                String outc  = "OUTC"+table;  //ISR  primaryid
                String reac = "REAC"+table;    //ISR  primaryid
                String ther = "THER"+table;    // ISR  primaryid

                //药品的搜索


                Criteria criteria = new Criteria();
                criteria.orOperator(
                        Criteria.where("DRUGNAME").is(Pattern.compile(Pattern.quote(databaseName), Pattern.CASE_INSENSITIVE)),
                        Criteria.where("drugname").is(Pattern.compile(Pattern.quote(databaseName), Pattern.CASE_INSENSITIVE)),
                        Criteria.where("prod_ai").is(Pattern.compile(Pattern.quote(databaseName), Pattern.CASE_INSENSITIVE))
                );
                Query query = new Query(criteria);
                log.info("{}",year+"Q"+month);

                List<JSONObject> jsonObjects = mongoUtil.mongo.find(query, JSONObject.class, drug);
                HashSet<String> strings = new HashSet<>();


                if (jsonObjects.size() == 0) {
                    continue;
                }

                for (JSONObject jsonObject : jsonObjects) {
                    if (jsonObject.containsKey("ISR")) {
                        String isrValue = jsonObject.getString("ISR");
                        if (isrValue != null) {
                            jsonObject.put("primaryid", isrValue);
                            jsonObject.remove("ISR");
                        }
                    }

                    if (jsonObject.containsKey("CASE")) {
                        String caseValue = jsonObject.getString("CASE");
                        if (caseValue != null) {
                            jsonObject.put("caseid", caseValue);
                            jsonObject.remove("CASE");
                        }
                    }

                    JsonKeyToLower.convertKeysToLowerCase(jsonObject);

                    strings.add(jsonObject.getString("primaryid"));

                }
                HashSet<String> strings2 = new HashSet<>();

                for (String string : strings) {
                    Boolean aBoolean = mongoUtil.mongo.exists(new Query(Criteria.where("primaryid").is( string)), JSONObject.class, "DEMOOnly"+year);
                    if (aBoolean){
                        strings2.add(string);
                    }
                }



                Criteria criteria1 = new Criteria();
                criteria1.orOperator(
                        Criteria.where("primaryid").in(strings2),
                        Criteria.where("ISR").in(strings2)
                );
                Query queryx = new Query(criteria1);


                List<JSONObject> jsonObjects11 = mongoUtil.mongo.find(queryx, JSONObject.class, drug);
                List<JSONObject> jsonObjects12 = getJsonObjects(jsonObjects11);
                mongoUtil.mongo.insert(jsonObjects12, "drug_" + databaseName);




                //demo
                List<JSONObject> jsonObjects1 = mongoUtil.mongo.find(queryx, JSONObject.class, demo);
                if (CollUtil.isNotEmpty(jsonObjects1)) {
                    List<JSONObject> jsonObjects2 = getJsonObjects(jsonObjects1);
                    mongoUtil.mongo.insert(jsonObjects2, "demo_" + databaseName);
                }

                //indi
                List<JSONObject> jsonObjects3 = mongoUtil.mongo.find(queryx, JSONObject.class, indi);
                if (CollUtil.isNotEmpty(jsonObjects3)) {
                    List<JSONObject> jsonObjects4 = getJsonObjects(jsonObjects3);
                    mongoUtil.mongo.insert(jsonObjects4, "indi_" + databaseName);
                }
                //outc
                List<JSONObject> jsonObjects5 = mongoUtil.mongo.find(queryx, JSONObject.class, outc);
                if (CollUtil.isNotEmpty(jsonObjects5)) {
                    List<JSONObject> jsonObjects6 = getJsonObjects(jsonObjects5);
                    mongoUtil.mongo.insert(jsonObjects6, "outc_" + databaseName);
                }
                //reac
                List<JSONObject> jsonObjects7 = mongoUtil.mongo.find(queryx, JSONObject.class, reac);
                if (CollUtil.isNotEmpty(jsonObjects7)) {
                    List<JSONObject> jsonObjects8 = getJsonObjects(jsonObjects7);
                    mongoUtil.mongo.insert(jsonObjects8, "reac_" + databaseName);
                }
                //ther
                List<JSONObject> jsonObjects9 = mongoUtil.mongo.find(queryx, JSONObject.class, ther);
                if (CollUtil.isNotEmpty(jsonObjects9)) {
                    List<JSONObject> jsonObjects10 = getJsonObjects(jsonObjects9);
                    mongoUtil.mongo.insert(jsonObjects10, "ther_" + databaseName);
                }

            }
        }
    }

    @Override
    public void getDemo(String databaseName) {

    }

    @Override
    public void getPt(String databaseName) {

    }


    private List<JSONObject> getJsonObjects(List<JSONObject> jsonObjects) {
        for (JSONObject jsonObject : jsonObjects) {
            // 创建一个新的JSONObject用于存储转换后的数据
            JSONObject newJsonObject = new JSONObject();

            // 先处理特殊字段转换
            if (jsonObject.containsKey("ISR")) {
                String isrValue = jsonObject.getString("ISR");
                if (isrValue != null) {
                    newJsonObject.put("primaryid", isrValue);
                }
            } else if (jsonObject.containsKey("primaryid")) {
                newJsonObject.put("primaryid", jsonObject.getString("primaryid"));
            }

            if (jsonObject.containsKey("CASE")) {
                String caseValue = jsonObject.getString("CASE");
                if (caseValue != null) {
                    newJsonObject.put("caseid", caseValue);
                }
            } else if (jsonObject.containsKey("caseid")) {
                newJsonObject.put("caseid", jsonObject.getString("caseid"));
            }

            // 转换所有字段名为小写
            for (String key : jsonObject.keySet()) {
                // 跳过已经处理过的字段
                if ("ISR".equals(key) || "CASE".equals(key)) {
                    continue;
                }
                // 跳过_id字段
                if ("_id".equals(key)) {
                    continue;
                }
                // 将字段名转为小写并保留值
                newJsonObject.put(key.toLowerCase(), jsonObject.get(key));
            }

            // 清空原对象并用新对象内容填充
            jsonObject.clear();
            jsonObject.putAll(newJsonObject);
        }
        return jsonObjects;
    }
}