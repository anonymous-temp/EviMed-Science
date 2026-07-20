package com.sentum.evidencecomprehensive.service.adapter;

import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.domain.dto.WordStatus;

import java.util.List;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/2/24
 */
public class SynonymGenerateAdapter {
    
    public static void buildSynonymByDrug(JSONObject synonym, Drug drug) {
        if (Objects.nonNull(synonym)) {
            JSONObject zhSynonym = synonym.getJSONObject("zh");
            if (Objects.nonNull(zhSynonym)) {
                drug.setZhWord(zhSynonym.getString("name"));
                List<String> synonymListZh = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                });
                drug.setZhSynonym(synonymListZh.stream().map(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    return wordStatus;
                }).collect(Collectors.toList()));
            }
            JSONObject enSynonym = synonym.getJSONObject("en");
            if (Objects.nonNull(enSynonym)) {
                drug.setEnWord(enSynonym.getString("name"));
                List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                });
                drug.setEnSynonym(synonymListEn.stream().map(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    return wordStatus;
                }).collect(Collectors.toList()));
            }
            JSONObject otherSynonym = synonym.getJSONObject("other");
            if (Objects.nonNull(enSynonym)) {
                List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(otherSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                });
                drug.setOtherSynonym(synonymListOther.stream().map(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    return wordStatus;
                }).collect(Collectors.toList()));
            }
        }
    }

    public static void buildSynonymByDisease(JSONObject synonym, Disease disease) {
        if (Objects.nonNull(synonym)) {
            JSONObject zhSynonym = synonym.getJSONObject("zh");
            if (Objects.nonNull(zhSynonym)) {
                disease.setZhWord(zhSynonym.getString("name"));
                List<String> synonymListZh = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                });
                disease.setZhSynonym(synonymListZh.stream().map(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    return wordStatus;
                }).collect(Collectors.toList()));
            }
            JSONObject enSynonym = synonym.getJSONObject("en");
            if (Objects.nonNull(enSynonym)) {
                disease.setEnWord(enSynonym.getString("name"));
                List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                });
                disease.setEnSynonym(synonymListEn.stream().map(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    return wordStatus;
                }).collect(Collectors.toList()));
            }
            JSONObject otherSynonym = synonym.getJSONObject("other");
            if (Objects.nonNull(enSynonym)) {
                List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(otherSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                });
                disease.setOtherSynonym(synonymListOther.stream().map(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    return wordStatus;
                }).collect(Collectors.toList()));
            }
        }
    }

    public static void buildSynonymByCOrO(JSONObject synonym, InterventionAndOutcome interventionAndOutcome) {
        if (Objects.nonNull(synonym)) {
            JSONObject zhSynonym = synonym.getJSONObject("zh");
            if (Objects.nonNull(zhSynonym)) {
                interventionAndOutcome.setZhWord(zhSynonym.getString("name"));
                List<String> synonymListZh = JSON.parseObject(JSON.toJSONString(zhSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                });
                interventionAndOutcome.setZhSynonym(synonymListZh.stream().map(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    return wordStatus;
                }).collect(Collectors.toList()));
            }
            JSONObject enSynonym = synonym.getJSONObject("en");
            if (Objects.nonNull(enSynonym)) {
                interventionAndOutcome.setEnWord(enSynonym.getString("name"));
                List<String> synonymListEn = JSON.parseObject(JSON.toJSONString(enSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                });
                interventionAndOutcome.setEnSynonym(synonymListEn.stream().map(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    return wordStatus;
                }).collect(Collectors.toList()));
            }
            JSONObject otherSynonym = synonym.getJSONObject("other");
            if (Objects.nonNull(enSynonym)) {
                List<String> synonymListOther = JSON.parseObject(JSON.toJSONString(otherSynonym.getJSONArray("synonym")), new TypeReference<List<String>>() {
                });
                interventionAndOutcome.setOtherSynonym(synonymListOther.stream().map(o -> {
                    WordStatus wordStatus = new WordStatus();
                    wordStatus.setName(o);
                    wordStatus.setChecked(true);
                    return wordStatus;
                }).collect(Collectors.toList()));
            }
        }
    }
}
