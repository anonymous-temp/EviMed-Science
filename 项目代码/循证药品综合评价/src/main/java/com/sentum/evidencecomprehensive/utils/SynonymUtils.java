package com.sentum.evidencecomprehensive.utils;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.es.DrugAndIndicationIndex;
import com.sentum.evidencecomprehensive.domain.es.EvidenceClinicalTrials;
import com.sentum.evidencecomprehensive.domain.mongo.*;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.index.query.QueryBuilders;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;

import java.util.*;

/**
 * 循证综合评价同义词工具类
 * @author zgm
 */
public class SynonymUtils {

    /**
     * 根据是否需要翻译检索当前词的中英文同义词
     * @param word 检索词
     * @param range 1-药品；2-疾病；3-参比药物；4-结局指标
     * @param isTranslate 是否需要翻译 1翻译 2不翻译
     * @param translate 查表之后的翻译
     * @return 中英文同义词
     */
    public static JSONObject synonym(String word, Integer range, Integer isTranslate, String translate){
        JSONObject result = new JSONObject();
        result.put("zh", new JSONObject());
        result.put("en", new JSONObject());
        result.put("other", new JSONObject());
        
        String chinese = "";
        String english = "";
        boolean judgeChinese = word.getBytes().length != word.length();
        if (isTranslate == 2){
            //不翻译
            if (judgeChinese){
                chinese = word;
            }else {
                english = word;
            }
        }else {
            //翻译
            String trans = "";
            if (StrUtil.isNotBlank(translate)) {
                trans = translate;
            } else {
                String innerTrans = getTrans(word, range);
                if (StrUtil.isNotBlank(innerTrans)) {
                    trans = innerTrans.toLowerCase();
                }
            }
            if (judgeChinese){
                chinese = word;
                english = trans;
            }else {
                english = word;
                chinese = trans;
            }
        }
        chinese = chinese.toLowerCase();
        english = english.toLowerCase();
        
        List<EvidenceMesh> evidenceMeshes = new ArrayList<>();
        Set<String> setZh = new HashSet<>();
        Set<String> setEn = new HashSet<>();
        Set<String> setOther = new HashSet<>();
        
        if (StringUtils.isNotBlank(chinese)) {
            List<EvidenceCMesh> cMeshes = ReleaseMongoUtil.mongo.find(new Query(new Criteria().orOperator(Criteria.where("zhEntryTerms").is(chinese.toLowerCase()), Criteria.where("otherEntryTerms").is(chinese.toLowerCase()))), EvidenceCMesh.class);
            if (CollUtil.isNotEmpty(cMeshes)) {
                for (EvidenceCMesh cMesh : cMeshes) {
                    String nameEn = cMesh.getNameEn();
                    if (StrUtil.isNotBlank(nameEn)) {
                        List<EvidenceMesh> meshes = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("entryTerms").is(nameEn.toLowerCase())), EvidenceMesh.class);
                        if (CollUtil.isNotEmpty(meshes)) {
                            evidenceMeshes.addAll(meshes);
                        }
                    }
                }
            }
            
            for (EvidenceCMesh cMesh : cMeshes) {
                List<String> zhEntryTerms = cMesh.getZhEntryTerms();
                setZh.addAll(zhEntryTerms);

                List<String> enEntryTerms = cMesh.getEnEntryTerms();
                setEn.addAll(enEntryTerms);

                List<String> otherEntryTerms = cMesh.getOtherEntryTerms();
                setOther.addAll(otherEntryTerms);
            }
        }
        
        if (StringUtils.isNotBlank(english)) {
            List<EvidenceMesh> meshes = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("entryTerms").is(english.toLowerCase())), EvidenceMesh.class);
            meshes.addAll(evidenceMeshes);
            for (EvidenceMesh mesh : meshes) {
                List<String> entryTerms = mesh.getEntryTerms();
                setEn.addAll(entryTerms);
            }
            //补充疾病的简写
            JSONObject one = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("englishWord").is(english.toLowerCase())), JSONObject.class, "simple_disease");
            if (one != null) {
                String simpleWord = one.getString("simpleWord");
                if (StringUtils.isNotBlank(simpleWord)) {
                    setEn.add(simpleWord.toLowerCase());
                }
            }
        }
        JSONObject zh = result.getJSONObject("zh");
        zh.put("name", chinese);
        setZh.remove(chinese.toLowerCase());
        zh.put("synonym", setZh);
        
        JSONObject en = result.getJSONObject("en");
        en.put("name", english);
        setEn.remove(english.toLowerCase());
        en.put("synonym", setEn);

        JSONObject other = result.getJSONObject("other");
        other.put("name", "");
        other.put("synonym", setOther);
        
        return result;
    }
    

    /**
     * 查询到word的翻译词
     * @param word 需要找寻翻译的word
     * @param range 1-药品；2-疾病；3-参比药物；4-结局指标
     * @return 翻译词
     */
    public static String getTrans(String word, Integer range){
        String trans = "";
        boolean judgeChinese = word.getBytes().length != word.length();
        if (1 == range){
            //药品
            String searchName;
            if (judgeChinese){
                searchName = "zhWord";
            }else {
                searchName = "enWord";
            }
            Criteria criteria = Criteria.where(searchName).is(word.toLowerCase());
            EvidenceAct evidenceAct = ReleaseMongoUtil.mongo.findOne(new Query(criteria), EvidenceAct.class);
            if (evidenceAct != null){
                if (judgeChinese){
                    String enWord = evidenceAct.getEnWord();
                    if (StringUtils.isNotBlank(enWord)){
                        trans = enWord;
                    }
                }else {
                    String zhWord = evidenceAct.getZhWord();
                    if (StringUtils.isNotBlank(zhWord)){
                        trans = zhWord;
                    }
                }
            }
        }else if (2 == range) {
            //疾病 = 疾病名称中英文对照 + ICD10
            //疾病名称中英文对照
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(QueryBuilders.matchPhraseQuery("zhAndEn", word));
            SearchHit<DrugAndIndicationIndex> drugAndIndicationIndexSearchHit = EsUtil.es.searchOne(nativeSearchQuery, DrugAndIndicationIndex.class);
            if (drugAndIndicationIndexSearchHit != null){
                DrugAndIndicationIndex content = drugAndIndicationIndexSearchHit.getContent();
                List<String> zhAndEn = content.getZhAndEn();
                if (CollUtil.isNotEmpty(zhAndEn)){
                    for (String txt : zhAndEn) {
                        String[] split = txt.split("=");
                        for (int i = 0; i < split.length; i++) {
                            if(word.equalsIgnoreCase(split[i])){
                                if (i == 0 && split.length == 2){
                                    trans = split[1];
                                }else if (i == 1){
                                    trans = split[0];
                                }
                                break;
                            }
                        }
                    }
                }
            }
            //使用fears库进行中英文匹配
            if (StringUtils.isBlank(trans)) {
                String searchRange;
                if (judgeChinese) {
                    searchRange = "adrs_ch";
                } else {
                    searchRange = "adrs_en";
                }
                JSONObject fearsVigiAdrs = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where(searchRange).is(word.toLowerCase())), JSONObject.class, "fears_vigi_adrs");
                if (fearsVigiAdrs != null) {
                    if (judgeChinese) {
                        trans = fearsVigiAdrs.getString("adrs_en");
                    } else {
                        trans = fearsVigiAdrs.getString("adrs_ch");
                    }
                }
            }
            //ICD10
            if (StringUtils.isBlank(trans)){
                String searchName;
                if (judgeChinese){
                    searchName = "diagnosisChinese";
                }else {
                    searchName = "diagnosisEnglish";
                }
                Icd10 icd10 = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where(searchName).is(word.toLowerCase())), Icd10.class);
                if (icd10 != null){
                    if (judgeChinese){
                        if (StringUtils.isNotBlank(icd10.getDiagnosisEnglish())){
                            trans = icd10.getDiagnosisEnglish();
                        }
                    }else {
                        if (StringUtils.isNotBlank(icd10.getDiagnosisChinese())){
                            trans = icd10.getDiagnosisChinese();
                        }
                    }
                }
            }
        }else if (3 == range){
            //参比药物 = ATC + 临床试验
            //ATC
            String searchName;
            if (judgeChinese){
                searchName = "zhWord";
            }else {
                searchName = "enWord";
            }
            EvidenceAct evidenceAct = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where(searchName).is(word.toLowerCase())), EvidenceAct.class);
            if (evidenceAct != null){
                if (judgeChinese){
                    if (StringUtils.isNotBlank(evidenceAct.getEnWord())){
                        trans = evidenceAct.getEnWord();
                    }
                }else {
                    if (StringUtils.isNotBlank(evidenceAct.getZhWord())){
                        trans = evidenceAct.getZhWord();
                    }
                }
            }
            if (StringUtils.isBlank(trans)){
                NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(QueryBuilders.matchPhraseQuery("intervention", word));
                SearchHit<EvidenceClinicalTrials> evidenceClinicalTrialsSearchHit = EsUtil.es.searchOne(nativeSearchQuery, EvidenceClinicalTrials.class);
                if (evidenceClinicalTrialsSearchHit != null){
                    EvidenceClinicalTrials content = evidenceClinicalTrialsSearchHit.getContent();
                    List<String> intervention = content.getIntervention();
                    if (CollUtil.isNotEmpty(intervention)){
                        for (String txt : intervention) {
                            String[] split = txt.split("卐");
                            for (int i = 0; i < split.length; i++) {
                                if(word.equalsIgnoreCase(split[i])){
                                    if (i == 0 && split.length == 2){
                                        trans = split[1];
                                    }else if (i == 1){
                                        trans = split[0];
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }else if (4 == range){
            //结局指标 = 临床试验
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(QueryBuilders.matchPhraseQuery("outcome", word));
            SearchHit<EvidenceClinicalTrials> evidenceClinicalTrialsSearchHit = EsUtil.es.searchOne(nativeSearchQuery, EvidenceClinicalTrials.class);
            if (evidenceClinicalTrialsSearchHit != null){
                EvidenceClinicalTrials content = evidenceClinicalTrialsSearchHit.getContent();
                List<String> outcome = content.getOutcome();
                if (CollUtil.isNotEmpty(outcome)){
                    for (String txt : outcome) {
                        String[] split = txt.split("卐");
                        for (int i = 0; i < split.length; i++) {
                            if(word.equalsIgnoreCase(split[i])){
                                if (i == 0 && split.length == 2){
                                    trans = split[1];
                                }else if (i == 1){
                                    trans = split[0];
                                }
                                break;
                            }
                        }
                    }
                }
            }
        }
        if (StringUtils.isBlank(trans)){
            //cMesh中判定
            String searchName;
            if (judgeChinese){
                searchName = "nameZh";
            }else {
                searchName = "nameEn";
            }
            EvidenceCMesh evidenceCMesh = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where(searchName).is(word.toLowerCase())), EvidenceCMesh.class);
            if (evidenceCMesh != null){
                if (judgeChinese){
                    if (StringUtils.isNotBlank(evidenceCMesh.getNameEn())){
                        trans = evidenceCMesh.getNameEn();
                    }
                }else {
                    if (StringUtils.isNotBlank(evidenceCMesh.getNameZh())){
                        trans = evidenceCMesh.getNameZh();
                    }
                }
            }
        }
        if (StringUtils.isBlank(trans)){
            //直接调用翻译进行翻译
            trans = TransUtil.trans(word);
        }
        if (StringUtils.isBlank(trans)){
            return word;
        }
        return trans;
    }
}
