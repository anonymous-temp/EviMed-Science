package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.alibaba.fastjson.TypeReference;
import com.sentum.evidencecomprehensive.constants.RedisKeyConstant;
import com.sentum.evidencecomprehensive.feign.CalculateAdverseFeign;
import com.sentum.evidencecomprehensive.pojo.*;
import com.sentum.evidencecomprehensive.pojo.bo.DrugParamBo;
import com.sentum.evidencecomprehensive.pojo.bo.es.AdverseForCaseIndex;
import com.sentum.evidencecomprehensive.pojo.bo.es.AdverseIndex;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.*;
import com.sentum.evidencecomprehensive.pojo.dto.SafeInfoDto;
import com.sentum.evidencecomprehensive.pojo.info.Disease;
import com.sentum.evidencecomprehensive.pojo.info.Drug;
import com.sentum.evidencecomprehensive.pojo.info.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.pojo.info.WordStatus;
import com.sentum.evidencecomprehensive.pojo.vo.AdverseForCaseIndexJd;
import com.sentum.evidencecomprehensive.pojo.vo.AdverseIndexJd;
import com.sentum.evidencecomprehensive.service.AdverseService;
import com.sentum.evidencecomprehensive.service.ClinicalTrialsService;
import com.sentum.evidencecomprehensive.utils.*;
import com.sentum.evidencecomprehensive.utils.operateyl.RedisUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections.CollectionUtils;
import org.apache.commons.collections.MapUtils;
import org.apache.commons.lang.StringUtils;
import org.apache.commons.lang3.ObjectUtils;
import org.apache.lucene.search.join.ScoreMode;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.NestedQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.elasticsearch.index.query.TermsQueryBuilder;
import org.elasticsearch.search.aggregations.Aggregation;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.elasticsearch.search.aggregations.bucket.terms.TermsAggregationBuilder;
import org.elasticsearch.search.aggregations.metrics.ParsedSum;
import org.springframework.beans.BeanUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.Map.Entry;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

@Slf4j
@Service
public class AdverseServiceImpl implements AdverseService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private CalculateAdverseFeign calculateAdverseFeign;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private ClinicalTrialsService clinicalTrialsService;
    @Autowired
    private RetrievalServiceImpl retrievalService;



    @Override
    public JSONObject info(String id) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) {
            throw new RuntimeException("检索id异常");
        }
        
        List<Drug> drugs = condition.getDrugs();
        List<Drug> drugAnd = new ArrayList<>();
        List<Drug> drugNot = new ArrayList<>();
        assembleDrug(drugs, drugAnd, drugNot);
        
        JSONObject result = new JSONObject();

        //说明书相关信息
        JSONArray instruction = new JSONArray();
        result.put("instruction", instruction);
        searchFullInstruction(instruction, drugAnd);
        
        //政策相关信息
        result.put("policy", new JSONObject());
        List<JSONObject> yaoWuJingJie = ReleaseMongoUtil.mongo.find(new Query(createPolicyCriteria(id)), JSONObject.class, "pharmacovigilance_new");
        handlePharmacovigilanceInfo(result, yaoWuJingJie, drugAnd, drugNot);
        
        //不良反应相关信息
        result.put("adverse", new JSONObject());
        if (CollectionUtils.isNotEmpty(drugAnd)) { // 放一个联合用药的名称
            String drugAndWord = drugAnd.stream().map(Drug::getWord).collect(Collectors.joining("联合"));
            if (StringUtils.isNotBlank(drugAndWord)) {
                result.getJSONObject("adverse").put("drugName", drugAndWord);
            } else {
                result.getJSONObject("adverse").put("drugName", "");
            }
        }
        log.info("调用安全分析分析 不良反应典型信号 、适应症～～～");
        
        Date date = new Date();
        String requestForDrugSafeInfoZx = "";
        
        Condition copyCondition = new Condition();
        BeanUtils.copyProperties(condition, copyCondition);
        copyCondition.setDrugs(copyCondition.getDrugs().subList(0, 1));
        try {
            JSONObject drugSafeInfoZx = drugSafeInfo(new SafeInfoDto(), copyCondition);
            requestForDrugSafeInfoZx = JSON.toJSONString(drugSafeInfoZx);
        } catch (Exception e) {
            try {
                JSONObject drugSafeInfoZx = drugSafeInfo(new SafeInfoDto(), copyCondition);
                requestForDrugSafeInfoZx =  JSON.toJSONString(drugSafeInfoZx);
            } catch (Exception e1) {
                try {
                    JSONObject drugSafeInfoZx = drugSafeInfo(new SafeInfoDto(), copyCondition);
                    requestForDrugSafeInfoZx =  JSON.toJSONString(drugSafeInfoZx);
                } catch (Exception e2) {
                    log.error(e.getMessage(), e2);
                }
                log.error(e.getMessage(), e1);
            }
        }
        log.info("调用安全分析分析 不良反应典型信号 、适应症～～～.用时{}", new Date().getTime() - date.getTime());
        if (StringUtils.isNotBlank(requestForDrugSafeInfoZx)) {
            JSONObject drugSafeInfoZx = null;
            try {
                // 这里可能出现 远程接口报错的情况
                drugSafeInfoZx = JSON.parseObject(requestForDrugSafeInfoZx, JSONObject.class);
            } catch (Exception e) {
                log.error("调用安全分析分析 不良反应典型信号 、适应症～～～转换异常");
            }
            if (Objects.nonNull(drugSafeInfoZx)) {
                // 不良反应
                JSONArray ptList = drugSafeInfoZx.getJSONArray("pt_list");
                if (Objects.nonNull(ptList)) {
                    result.getJSONObject("adverse").put("ptList", ptList);
                }

                // 严重不良反应
                JSONArray outc_cod_list = drugSafeInfoZx.getJSONArray("outc_cod_list");
                JSONArray seriousAdverse = new JSONArray();
                if (CollectionUtils.isNotEmpty(outc_cod_list)) {
                    outc_cod_list.forEach(o -> {
                        List list = JSON.parseObject(JSON.toJSONString(o), new TypeReference<List>() {});
                        JSONObject innerJson = new JSONObject();
                        innerJson.put("num", list.get(2));
                        innerJson.put("name", list.get(1));
                        innerJson.put("percent", list.get(3));
                        seriousAdverse.add(innerJson);
                    });
                }
                result.getJSONObject("adverse").put("seriousAdverse", seriousAdverse);
                
                // 适应症
                JSONArray indi_pt_list = drugSafeInfoZx.getJSONArray("indi_pt_list");
                JSONArray indi_pt_list_result = new JSONArray();
                if (CollectionUtils.isNotEmpty(indi_pt_list)) {
                    for (Object o : indi_pt_list) {
                        JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                        indi_pt_list_result.add(jsonArray);
                    }
                    if (indi_pt_list_result.size() > 20) {
                        result.getJSONObject("adverse").put("adverse", indi_pt_list_result.subList(0, 20));
                    } else {
                        result.getJSONObject("adverse").put("adverse", indi_pt_list);
                    }
                }

                // 典型信号
                JSONObject signal_dict = drugSafeInfoZx.getJSONObject("signal_dict");

                List<Object> ror = new ArrayList<>();
                if (Objects.nonNull(signal_dict)) {

                    JSONObject data = signal_dict.getJSONObject("data");

                    JSONArray resultJSON = new JSONArray();
                    Map<String, JSONArray> entryMaps = JSON.parseObject(JSON.toJSONString(data), new TypeReference<Map<String, JSONArray>>() {
                    });

                    if (MapUtils.isNotEmpty(entryMaps)) {
                        for (Map.Entry<String, JSONArray> innerEntry : entryMaps.entrySet()) {
                            String soc = innerEntry.getKey();
                            JSONArray value = innerEntry.getValue();
                            for (Object o : value) {
                                JSONArray list = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                                JSONObject jsonObject = new JSONObject();
                                jsonObject.put("soc", soc);
                                jsonObject.put("en", list.get(0));
                                jsonObject.put("num", list.get(1));
                                jsonObject.put("ror", list.get(3));
                                jsonObject.put("ebgm", list.get(4));
                                jsonObject.put("ic", list.get(5));
                                jsonObject.put("zh", list.get(6));
                                jsonObject.put("seven", list.get(7));
                                jsonObject.put("eight", list.get(8));
                                jsonObject.put("nine", list.get(9));
                                jsonObject.put("ten", list.get(10));
                                resultJSON.add(jsonObject);
                            }
                        }

                        ror = resultJSON.stream().sorted(Comparator.comparing(o -> Double.parseDouble(JSON.parseObject(JSON.toJSONString(o), JSONObject.class).getString("ror")), Comparator.reverseOrder())).collect(Collectors.toList());
                        if (ror.size() > 20) {
                            ror = ror.subList(0, 20);
                        }
                    }
                }
                
                JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(ror), JSONArray.class);
                JSONObject calculateTypicalSignals = new JSONObject();
                calculateTypicalSignals.put("data", jsonArray);
                calculateTypicalSignals.put("info", "");
                calculateTypicalSignals.put("total", drugSafeInfoZx.getInteger("psTotal"));
                calculateTypicalSignals.put("outcome", signal_dict.getBoolean("outcome"));
                result.getJSONObject("adverse").put("calculateTypicalSignals", calculateTypicalSignals);
                
            } else {
                result.getJSONObject("adverse").put("calculateTypicalSignals", new JSONObject());
                result.getJSONObject("adverse").put("seriousAdverse", new JSONArray());
                result.getJSONObject("adverse").put("adverse", new JSONArray());
            }
        } 
//        else {
//            result.getJSONObject("adverse").put("calculateTypicalSignals", calculateTypicalSignals(condition));
//            result.getJSONObject("adverse").put("seriousAdverse", seriousAdverse(condition));
//            result.getJSONObject("adverse").put("adverse", adverse(condition));
//        }



        //临床试验相关信息
        result.put("clinicalTrials", new JSONArray());
        log.info("调用临床试验中严重不良反应～～～");
        Date date1 = new Date();
        List<ClinicalTrialRegistration> infoForAdverse = clinicalTrialsService.getInfoForAdverse(id);
        log.info("调用临床试验中严重不良反应～～～.用时{}", new Date().getTime() - date1.getTime());
        for (ClinicalTrialRegistration clinicalTrialRegistration : infoForAdverse) {
            JSONObject inner = new JSONObject();
            //注册号
            String registerNo = clinicalTrialRegistration.getRegisterNo();
            //标题
            String publicTitle = clinicalTrialRegistration.getPublicTitle();
            //原文连接
            String belong = clinicalTrialRegistration.getBelong();
            String url = "";
            if("chictr".equals(belong)){
                String registerUrl = clinicalTrialRegistration.getRegisterUrl();
                if (StringUtils.isNotBlank(registerUrl)) {
                    url = registerUrl;
                }
            }else {
                url = "https://www.clinicaltrials.gov/ct2/show/" + registerNo;
            }
            //干预措施
            List<Map<String, Object>> intervention = clinicalTrialRegistration.getIntervention();
            StringBuilder interventionBuilder = new StringBuilder();
            if (CollectionUtils.isNotEmpty(intervention)) {
                if("chictr".equals(belong)){
                    for (int i = 0; i < intervention.size() - 1; i++) {
                        interventionBuilder.append(intervention.get(i).get("intervention").toString()).append("，");
                    }
                    interventionBuilder.append(intervention.get(intervention.size() - 1).get("intervention").toString());
                }else {
                    for (int i = 0; i < intervention.size() - 1; i++) {
                        interventionBuilder.append(intervention.get(i).get("intervention_name").toString()).append("，");
                    }
                    interventionBuilder.append(intervention.get(intervention.size() - 1).get("intervention_name").toString());
                }
            }
            //最后一次更新时间
            String lastUpdateDate = clinicalTrialRegistration.getLastUpdateDate();
            inner.put("registerNo", registerNo);
            inner.put("publicTitle", publicTitle);
            inner.put("url", url);
            inner.put("intervention", interventionBuilder.toString());
            inner.put("lastUpdateDate", lastUpdateDate);
            //inner.put("adverseEvents", new JSONArray());
            //表格（展示临床试验中的原始数据即可）不良反应事件
            JSONObject adverseEvents = clinicalTrialRegistration.getAdverseEvents();
            JSONObject object = new JSONObject();
            if (adverseEvents != null) {
                //SERIOUS ADVERSE EVENTS
                JSONArray seriousAdverseEvents = adverseEvents.getJSONArray("SERIOUS ADVERSE EVENTS");
                if (CollectionUtils.isNotEmpty(seriousAdverseEvents)) {
                    object.put("SERIOUS ADVERSE EVENTS", new JSONArray());
                    JSONObject adverseEventReportingDescription = adverseEvents.getJSONObject("ADVERSE EVENT REPORTING DESCRIPTION");
                    JSONArray stats = adverseEventReportingDescription.getJSONArray("stats");
                    JSONObject titleJson = new JSONObject();
                    titleJson.put("Arm/Group Title", new JSONArray());
                    JSONArray array1 = new JSONArray();
                    JSONArray array2 = new JSONArray();
                    for (int i = 0; i < stats.size(); i++) {
                        JSONObject jsonObject = stats.getJSONObject(i);
                        array1.add(jsonObject.getString("Arm/Group Title"));
                        array2.add("Affected / at Risk (%)");
                    }
                    titleJson.getJSONArray("Arm/Group Title").add(array1);
                    titleJson.getJSONArray("Arm/Group Title").add(array2);
                    object.getJSONArray("SERIOUS ADVERSE EVENTS").add(titleJson);
                    for (int i = 0; i < seriousAdverseEvents.size(); i++) {
                        titleJson = new JSONObject();
                        JSONObject jsonObject = seriousAdverseEvents.getJSONObject(i);
                        if (i != 0) {
                            String organSystem = jsonObject.getString("organ_system");
                            titleJson.put(organSystem, new JSONArray());
                            object.getJSONArray("SERIOUS ADVERSE EVENTS").add(titleJson);
                            titleJson = new JSONObject();
                        }
                        String term = jsonObject.getString("term");
                        titleJson.put(term, new JSONArray());
                        JSONArray dataStats = jsonObject.getJSONArray("stats");
                        for (int i1 = 0; i1 < dataStats.size(); i1++) {
                            JSONObject dataStatsJson = dataStats.getJSONObject(i1);
                            String formatText = dataStatsJson.getString("format_text");
                            titleJson.getJSONArray(term).add(formatText);
                        }
                        object.getJSONArray("SERIOUS ADVERSE EVENTS").add(titleJson);

                    }
                }
                //OTHER (NOT INCLUDING SERIOUS) ADVERSE EVENTS
                JSONArray adverseEventsJSONArray = adverseEvents.getJSONArray("OTHER (NOT INCLUDING SERIOUS) ADVERSE EVENTS");
                if (CollectionUtils.isNotEmpty(adverseEventsJSONArray)) {
                    object.put("OTHER (NOT INCLUDING SERIOUS) ADVERSE EVENTS", new JSONArray());
                    String frequency = adverseEvents.getString("Frequency Threshold for Reporting Other Adverse Events");
                    JSONObject otherJson = new JSONObject();
                    otherJson.put("Frequency Threshold for Reporting Other Adverse Events", frequency);
                    object.getJSONArray("OTHER (NOT INCLUDING SERIOUS) ADVERSE EVENTS").add(otherJson);
                    for (int i = 0; i < adverseEventsJSONArray.size(); i++) {
                        otherJson = new JSONObject();
                        JSONObject jsonObject = adverseEventsJSONArray.getJSONObject(i);
                        if (i != 0) {
                            String organSystem = jsonObject.getString("organ_system");
                            otherJson.put(organSystem, new JSONArray());
                            object.getJSONArray("OTHER (NOT INCLUDING SERIOUS) ADVERSE EVENTS").add(otherJson);
                            otherJson = new JSONObject();
                        }
                        String term = jsonObject.getString("term");
                        otherJson.put(term, new JSONArray());
                        JSONArray dataStats = jsonObject.getJSONArray("stats");
                        for (int i1 = 0; i1 < dataStats.size(); i1++) {
                            JSONObject dataStatsJson = dataStats.getJSONObject(i1);
                            String formatText = dataStatsJson.getString("format_text");
                            otherJson.getJSONArray(term).add(formatText);
                        }
                        object.getJSONArray("OTHER (NOT INCLUDING SERIOUS) ADVERSE EVENTS").add(otherJson);
                    }
                }
            }
            inner.put("table", object);
            result.getJSONArray("clinicalTrials").add(inner);
        }
        return result;
    }

//    public void searchFullInstruction(String id, JSONArray instruction, List<Drug> drugAnd) {
//        for (Drug drug : drugAnd) {
//            Integer status = drug.getStatus();
//            if (status == 1) {
//                Set<String> drugList = new HashSet<>();
//                String word = drug.getWord();
//                if (StrUtil.isBlank(word)) {
//                    continue;
//                }
//                drugList.add(word);
//                String enWord = drug.getEnWord();
//                if (org.apache.commons.lang.StringUtils.isNotBlank(enWord)) {
//                    drugList.add(enWord.toLowerCase());
//                }
//                String zhWord = drug.getZhWord();
//                if (org.apache.commons.lang.StringUtils.isNotBlank(zhWord)) {
//                    drugList.add(zhWord.toLowerCase());
//                }
//                List<WordStatus> enSynonym = drug.getEnSynonym();
//                if (CollectionUtils.isNotEmpty(enSynonym)) {
//                    for (WordStatus wordStatus : enSynonym) {
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            drugList.add(wordStatus.getName().toLowerCase());
//                        }
//                    }
//                }
//                List<WordStatus> zhSynonym = drug.getZhSynonym();
//                if (CollectionUtils.isNotEmpty(zhSynonym)) {
//                    for (WordStatus wordStatus : zhSynonym) {
//                        Boolean checked = wordStatus.getChecked();
//                        if (checked) {
//                            drugList.add(wordStatus.getName().toLowerCase());
//                        }
//                    }
//                }
//
//                String csmsMongoId = "chaoshuomingshu:report:" + id + ":" + word;
//                Object oldCSMSMongoId = RedisUtil.redis.opsForValue().get(csmsMongoId);
//                Map<String, String> drugInfosIdMap = new HashMap<>();
//                List<String> filterIds = new ArrayList<>();
//
//                if (Objects.isNull(oldCSMSMongoId)) {
//                    Query query = new Query();
//                    query.addCriteria(Criteria.where("drugName").is(word));
//                    List<MedicineInfo> medicineInfos = ReleaseMongoUtil.mongo.find(query, MedicineInfo.class);
//                    if (CollectionUtils.isNotEmpty(medicineInfos)) {
//                        MedicineInfo medicineInfo = medicineInfos.get(0);
//                        RedisUtil.redis.opsForValue().set(csmsMongoId, medicineInfo.getId());
//                    } else {
//                        //拼接检索条件
//                        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
//                        for (String s1 : drugList) {
//                            MultiMatchQueryBuilder multiMatchQueryBuilder = QueryBuilders.multiMatchQuery(s1, "drugName", "commodityNameZh", "commodityNameEn");
//                            multiMatchQueryBuilder.type(MultiMatchQueryBuilder.Type.PHRASE);
//                            multiMatchQueryBuilder.operator(Operator.AND);
//                            boolQueryBuilder.should().add(multiMatchQueryBuilder);
//                        }
//                        //NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(QueryBuilders.termQuery("drugName.keyword", drugList));
//                        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
//                        nativeSearchQuery.setPageable(PageRequest.of(0, 20));
//                        SearchHits<DrugAndIndicationIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, DrugAndIndicationIndex.class);
//                        long totalHits = search.getTotalHits();
//                        List<DrugInfo> drugInfos = new ArrayList<>();
//                        if (totalHits > 0) {
//                            List<String> ids = search.getSearchHits().stream().map(SearchHit::getContent).map(DrugAndIndicationIndex::getId).collect(Collectors.toList());
//                            drugInfos = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(ids)), DrugInfo.class);
//                        }
//                        int maxDataFlag = 0;
//                        String instructionMongoId = "";
//                        if (CollectionUtils.isNotEmpty(drugInfos)) {
//                            for (DrugInfo drugInfo : drugInfos) {
//                                String drugInfoId = drugInfo.getId();
//                                String drugZh = drugInfo.getDrugZh();
//                                if (StringUtils.isNotBlank(drugZh)) {
////                                drugInfosIdMap.put(drugZh, drugInfoId);
//                                    drugInfosIdMap.put(drugInfoId, drugZh);
//                                }
//                            }
//                        }
//
//                        if (MapUtil.isNotEmpty(drugInfosIdMap)) {
//                            for (Map.Entry<String, String> entry : drugInfosIdMap.entrySet()) {
//                                String key = entry.getKey();
//                                String value = entry.getValue();
//                                if (drug.getWord().contains(value)) {
//                                    filterIds.add(key);
//                                }
//                            }
//                        }
//                        if (CollectionUtils.isNotEmpty(filterIds)) {
//                            drugInfos = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("_id").in(filterIds)), DrugInfo.class);
//                        }
//
//                        if (CollectionUtils.isNotEmpty(drugInfos)) {
//                            for (DrugInfo drugInfo : drugInfos) {
//                                int numData = 0;
//                                //禁忌
//                                List<DrugParamBo> tabooInd = drugInfo.getTabooInd();
//                                if (CollectionUtils.isNotEmpty(tabooInd)) {
//                                    numData++;
//                                }
//                                //孕妇及哺乳期妇女用药
//                                List<DrugParamBo> pregnantWomenInd = drugInfo.getPregnantWomenInd();
//                                if (CollectionUtils.isNotEmpty(pregnantWomenInd)) {
//                                    numData++;
//                                }
//                                //儿童用药
//                                List<DrugParamBo> childrenMedicineInd = drugInfo.getChildrenMedicineInd();
//                                if (CollectionUtils.isNotEmpty(childrenMedicineInd)) {
//                                    numData++;
//                                }
//                                //老年用药
//                                List<DrugParamBo> geriatricMedicineInd = drugInfo.getGeriatricMedicineInd();
//                                if (CollectionUtils.isNotEmpty(geriatricMedicineInd)) {
//                                    numData++;
//                                }
//                                //用法用量
//                                List<DrugParamBo> usageAndDosageInd = drugInfo.getUsageAndDosageInd();
//                                if (CollectionUtils.isNotEmpty(usageAndDosageInd)) {
//                                    numData++;
//                                }
//                                //不良反应
//                                List<DrugParamBo> adverseReactionInd = drugInfo.getAdverseReactionInd();
//                                if (CollectionUtils.isNotEmpty(adverseReactionInd)) {
//                                    numData++;
//                                }
//                                //适应症
//                                List<DrugParamBo> indicationsInd = drugInfo.getIndicationsInd();
//                                if (CollectionUtils.isNotEmpty(indicationsInd)) {
//                                    numData++;
//                                }
//                                //注意事项 notes
//                                List<DrugParamBo> notesInd = drugInfo.getNotesInd();
//                                if (CollectionUtils.isNotEmpty(notesInd)) {
//                                    numData++;
//                                }
//                                //药理作用 pharmacology
//                                List<DrugParamBo> pharmacologyInd = drugInfo.getPharmacologyInd();
//                                if (CollectionUtils.isNotEmpty(pharmacologyInd)) {
//                                    numData++;
//                                }
//                                //黑框警告
//                                List<DrugParamBo> warningInd = drugInfo.getWarningInd();
//                                if (CollectionUtils.isNotEmpty(warningInd)) {
//                                    numData++;
//                                }
//                                if (maxDataFlag < numData) {
//                                    maxDataFlag = numData;
//                                    instructionMongoId = drugInfo.getId();
//                                }
//                            }
//                            RedisUtil.redis.opsForValue().set(csmsMongoId, instructionMongoId);
//                        } else {
//                            // -1 代表没有说明书
//                            RedisUtil.redis.opsForValue().set(csmsMongoId, "-1");
//                        }
//                    }
//                }
//
//                oldCSMSMongoId = RedisUtil.redis.opsForValue().get(csmsMongoId);
//                if (Objects.nonNull(oldCSMSMongoId) && !"-1".equals(oldCSMSMongoId.toString())) {
//                    // 优先用药助手
//                    MedicineInfo medicineInfo  = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("_id").is(oldCSMSMongoId.toString())), MedicineInfo.class);
//                    DrugInfo drugInfo = ReleaseMongoUtil.mongo.findById(oldCSMSMongoId.toString(), DrugInfo.class);
//                    if (Objects.nonNull(medicineInfo)) {
//                        // 存放说明书信息
//                        JSONObject drugInfoJson = new JSONObject();
//                        drugInfoJson.put("type", 1);
//                        drugInfoJson.put("name", word);
//                        drugInfoJson.put("indicationsDosage", CollectionUtils.isNotEmpty(medicineInfo.getIndicationsDosage()) ? medicineInfo.getIndicationsDosage() : "");
//                        drugInfoJson.put("notes", CollectionUtils.isNotEmpty(medicineInfo.getNotes()) ? medicineInfo.getNotes() : "");
//                        drugInfoJson.put("taboo", CollectionUtils.isNotEmpty(medicineInfo.getTaboo()) ? medicineInfo.getTaboo() : "");
//                        drugInfoJson.put("pharmacology", CollectionUtils.isNotEmpty(medicineInfo.getPharmacology()) ? medicineInfo.getPharmacology() : "");
//                        drugInfoJson.put("adverse", CollectionUtils.isNotEmpty(medicineInfo.getIndicationsDosage()) ? medicineInfo.getIndicationsDosage() : "");
//                        JSONObject special = new JSONObject();
//                        special.put("childrenAndOld", CollectionUtils.isNotEmpty(medicineInfo.getChildrenAndGeriatricMedicine()) ? medicineInfo.getChildrenAndGeriatricMedicine() : "");
//                        // 妊娠期&哺乳期
//                        List<DrugParamBo> medication = new ArrayList<>();
//                        List<DrugParamBo> medicationDuringLactation = medicineInfo.getMedicationDuringLactation();
//                        List<DrugParamBo> medicationDuringPregnancy = medicineInfo.getMedicationDuringPregnancy();
//                        if (CollectionUtils.isNotEmpty(medicationDuringLactation)) {
//                            medication.addAll(medicationDuringLactation);
//                        }
//                        if (CollectionUtils.isNotEmpty(medicationDuringPregnancy)) {
//                            medication.addAll(medicationDuringPregnancy);
//                        }
//                        special.put("women", CollectionUtils.isNotEmpty(medication) ? medication : "");
//                        drugInfoJson.put("special", special);
//                        instruction.add(drugInfoJson);
//                    } else {
//                        if (Objects.nonNull(drugInfo)) {
//                            // 存放说明书信息
//                            JSONObject drugInfoJson = new JSONObject();
//                            drugInfoJson.put("type", 0);
//                            drugInfoJson.put("name", word);
//                            drugInfoJson.put("indications", CollectionUtils.isNotEmpty(drugInfo.getIndicationsInd()) ? drugInfo.getIndicationsInd() : "");
//                            drugInfoJson.put("notes", CollectionUtils.isNotEmpty(drugInfo.getNotesInd()) ? drugInfo.getNotesInd() : "");
//                            drugInfoJson.put("taboo", CollectionUtils.isNotEmpty(drugInfo.getTabooInd()) ? drugInfo.getTabooInd() : "");
//                            drugInfoJson.put("pharmacology", CollectionUtils.isNotEmpty(drugInfo.getPharmacologyInd()) ? drugInfo.getPharmacologyInd() : "");
//                            drugInfoJson.put("adverse", CollectionUtils.isNotEmpty(drugInfo.getAdverseReactionInd()) ? drugInfo.getAdverseReactionInd() : "");
//                            drugInfoJson.put("usageAndDosage", CollectionUtils.isNotEmpty(drugInfo.getUsageAndDosageInd()) ? drugInfo.getUsageAndDosageInd() : "");
//                            JSONObject special = new JSONObject();
//                            special.put("children", CollectionUtils.isNotEmpty(drugInfo.getChildrenMedicineInd()) ? drugInfo.getChildrenMedicineInd() : "");
//                            special.put("old", CollectionUtils.isNotEmpty(drugInfo.getGeriatricMedicineInd()) ? drugInfo.getGeriatricMedicineInd() : "");
//                            special.put("women", CollectionUtils.isNotEmpty(drugInfo.getPregnantWomenInd()) ? drugInfo.getPregnantWomenInd() : "");
//                            drugInfoJson.put("special", special);
//                            instruction.add(drugInfoJson);
//                        }
//                    }
//                }
//            }
//        }
//    }

    public void searchFullInstruction(JSONArray instruction, List<Drug> drugAnd) {
        
        if (CollectionUtils.isNotEmpty(drugAnd)) {
            Drug drug = drugAnd.get(0);
            String word = drug.getWord();

            String instructionInfoKey = RedisKeyConstant.getKey(RedisKeyConstant.INSTRUCTION_INFO, word);

            JSONObject redisDrugInfoObj = JSON.parseObject(RedisUtils.getStr(instructionInfoKey));

            if (Objects.isNull(redisDrugInfoObj)) {
                JSONObject drugInfoObj = new JSONObject();
                // 合理用药说明书数据  2000 多条
                Query query = new Query();
                query.addCriteria(Criteria.where("drugName").is(word));
                List<MedicineInfo> medicineInfos = ReleaseMongoUtil.mongo.find(query, MedicineInfo.class);
                MedicineInfo medicineInfo = null;
                if (CollectionUtils.isNotEmpty(medicineInfos)) {
                    medicineInfo = medicineInfos.get(0);
                }

                // 说明书原文数据 7万多条
                Query queryInstruction = new Query();
                List<Criteria> orCriteriaList = new ArrayList<>();
                orCriteriaList.add(Criteria.where("innName").regex(word, "i"));
                orCriteriaList.add(Criteria.where("commonName").regex(word, "i"));
                queryInstruction.addCriteria(new Criteria().orOperator(orCriteriaList.toArray(new Criteria[0])));
                queryInstruction.limit(3);

                List<MedicineInstructionUse> medicineInstructionUses = ReleaseMongoUtil.mongo.find(queryInstruction, MedicineInstructionUse.class);

                // 说明书原文数据最全的一个
                MedicineInstructionUse bestMedicineInstructionUse = null;
                int maxFieldCount = 0;
                for (MedicineInstructionUse medicineInstructionUse : medicineInstructionUses) {
                    int fieldCount = countNonEmptyFields(medicineInstructionUse);
                    if (fieldCount > maxFieldCount) {
                        maxFieldCount = fieldCount;
                        bestMedicineInstructionUse = medicineInstructionUse;
                    }
                }
                drugInfoObj.put("name", word);

                // 使用最全的数据进行 新对象的赋值
                if (Objects.nonNull(bestMedicineInstructionUse)) {
                    populateDrugInfo(bestMedicineInstructionUse, drugInfoObj);
                }

                // 合理用药数据 对新对象赋值
                if (Objects.nonNull(medicineInfo)) {
                    populateMedicineInfo(medicineInfo, drugInfoObj);
                }

                RedisUtils.set(instructionInfoKey, JSON.toJSONString(drugInfoObj), 60 * 60 * 6, TimeUnit.SECONDS);
            }
            redisDrugInfoObj = JSON.parseObject(RedisUtils.getStr(instructionInfoKey));
            if (Objects.nonNull(redisDrugInfoObj)) {
                instruction.add(redisDrugInfoObj);
            }
        }
    }

    private void populateMedicineInfo(MedicineInfo source, JSONObject drugInfoObj) {
        // 常规字段处理
        putIfNotEmpty(drugInfoObj, "notes", source.getNotes());
        putIfNotEmpty(drugInfoObj, "pharmacology", source.getPharmacology());
        putIfNotEmpty(drugInfoObj, "pharmacokinetics", source.getPharmacokinetics());
        putIfNotEmpty(drugInfoObj, "warning", source.getWarning());
        putIfNotEmpty(drugInfoObj, "children", source.getChildren());
        putIfNotEmpty(drugInfoObj, "taboo", source.getTaboo());
        putIfNotEmpty(drugInfoObj, "storage", source.getStorage());
        putIfNotEmpty(drugInfoObj, "adverse", source.getAdverseReaction());

        // 特殊处理：indicationsDosage 需要额外设置 type
        if (CollectionUtils.isNotEmpty(source.getIndicationsDosage())) {
            drugInfoObj.put("type", 1);
            drugInfoObj.put("indicationsDosage", source.getIndicationsDosage());
        }

        // 特殊处理：合并妊娠期和哺乳期数据
        List<DrugParamBo> pregnantWomen = mergeLists(
                source.getMedicationDuringLactation(),
                source.getMedicationDuringPregnancy()
        );
        if (CollectionUtils.isNotEmpty(pregnantWomen)) {
            drugInfoObj.put("pregnantWomen", pregnantWomen);
        }
    }

    private List<DrugParamBo> mergeLists(List<DrugParamBo>... lists) {
        List<DrugParamBo> result = new ArrayList<>();
        for (List<DrugParamBo> list : lists) {
            if (CollectionUtils.isNotEmpty(list)) {
                result.addAll(list);
            }
        }
        return result;
    }

    private void putIfNotEmpty(Map<String, Object> map, String key, Object value) {
        if (value instanceof Collection && CollectionUtils.isNotEmpty((Collection<?>) value)) {
            map.put(key, value);
        } else if (value != null && !(value instanceof Collection)) {
            map.put(key, value);
        }
    }

    // 抽取计数逻辑为独立方法
    private int countNonEmptyFields(MedicineInstructionUse medicineInstructionUse) {
        int count = 0;

        // 使用数组简化重复代码
        List<DrugParamBo>[] fieldsToCheck = new List[] {
                medicineInstructionUse.getContraindications(),      // 禁忌
                medicineInstructionUse.getUseInPregLact(),         // 妇女
                medicineInstructionUse.getUseInChildren(),         // 儿童用药
                medicineInstructionUse.getUseInElderly(),          // 老年用药
                medicineInstructionUse.getDosage(),                // 用法用量
                medicineInstructionUse.getAdverseReactions(),      // 不良反应
                medicineInstructionUse.getIndication(),            // 适应症
                medicineInstructionUse.getPrecautions(),           // 注意事项
                medicineInstructionUse.getDrugInteractions(),      // 相互作用
                medicineInstructionUse.getMechanismAction(),       // 药理作用
                medicineInstructionUse.getPharmacokinetics(),      // 药代动力学
                medicineInstructionUse.getDrugWarning(),           // 黑框警告
                medicineInstructionUse.getStorage()                // 贮藏
        };

        for (List<DrugParamBo> field : fieldsToCheck) {
            if (CollectionUtils.isNotEmpty(field)) {
                count++;
            }
        }

        return count;
    }

    private void populateDrugInfo(MedicineInstructionUse source, JSONObject drugInfoObj) {
        putIfNotEmpty(drugInfoObj, "indications", source.getIndication());
        putIfNotEmpty(drugInfoObj, "usageAndDosage", source.getDosage());
        putIfNotEmpty(drugInfoObj, "pharmacology", source.getMechanismAction());
        putIfNotEmpty(drugInfoObj, "pharmacokinetics", source.getPharmacokinetics());
        putIfNotEmpty(drugInfoObj, "children", source.getUseInChildren());
        putIfNotEmpty(drugInfoObj, "geriatric", source.getUseInElderly());
        putIfNotEmpty(drugInfoObj, "pregnantWomen", source.getUseInPregLact());
        putIfNotEmpty(drugInfoObj, "adverse", source.getAdverseReactions());
        putIfNotEmpty(drugInfoObj, "warning", source.getDrugWarning());
        putIfNotEmpty(drugInfoObj, "notes", source.getPrecautions());
        putIfNotEmpty(drugInfoObj, "taboo", source.getContraindications());
        putIfNotEmpty(drugInfoObj, "storage", source.getStorage());
        putIfNotEmpty(drugInfoObj, "adverseReaction", source.getDrugInteractions());
    }

    private void putIfNotEmpty(JSONObject drugInfoObj, String key, List<DrugParamBo> value) {
        if (CollectionUtils.isNotEmpty(value)) {
            drugInfoObj.put(key, value);
        }
    }


    private void handlePharmacovigilanceInfo(JSONObject result, List<JSONObject> yaoWuJingJie, List<Drug> drugAnd, List<Drug> drugNot) {
        SimpleDateFormat simpleDateFormat_year_month_day = new SimpleDateFormat("yyyy-MM-dd");
        // 通报
        Map<Long, JSONObject> mapReport = new HashMap<>();
        Map<Long, String> mapWordReport = new HashMap<>();
        // 修订
        Map<Long, JSONObject> mapRevise = new HashMap<>();
        Map<Long, String> mapWordRevise = new HashMap<>();
        // 药物警戒 nmpa
        Map<Long, JSONObject> mapNmpa = new HashMap<>();
        // 药物警戒 ema
        Map<Long, JSONObject> mapEma = new HashMap<>();
        // 药物警戒 fda
        Map<Long, JSONObject> mapFda = new HashMap<>();

        Map<Long, String> mapWordNmpa = new HashMap<>();
        Map<Long, String> mapWordEma = new HashMap<>();
        Map<Long, String> mapWordFda = new HashMap<>();

        int innerNmpa = 1;
        int innerFda = 1;
        int innerEma = 1;
        // 通报计数
        int innerReportNum = 1;
        // 修订计数
        int innerReviseNum = 1;
        for (JSONObject jsonObject : yaoWuJingJie) {
            String dataTime = jsonObject.getString("data_time");
            String title = jsonObject.getString("title");
            if (StrUtil.isBlank(title)) { // 这里是去除 belong = ema 中没有 title 的数据
                continue;
            }
            String url = jsonObject.getString("title_url");
            String transTitle = jsonObject.getString("trans_title");
            String transContent = jsonObject.getString("trans_content");
            String belong = jsonObject.getString("belong");

            if (StringUtils.isNotBlank(title)) {
                // 通报
                if (title.contains("通报")) {
                    if (StrUtil.containsAny(title, drugAnd.stream().map(Drug::getWord).toArray(String[]::new))
                            && !StrUtil.containsAny(title, drugNot.stream().map(Drug::getWord).toArray(String[]::new))) {
                        JSONObject inner = new JSONObject();
                        inner.put("title", title);
                        inner.put("dataTime", dataTime);
                        inner.put("url", url);
                        inner.put("content", "");
                        inner.put("number", "(" + innerReportNum++ + ")");

                        // word 使用
                        String cont_word = title +
                                " (发布时间：" + dataTime + ")" +
                                "\n" + "原文链接：" + url;
                        try {
                            long time = simpleDateFormat_year_month_day.parse(dataTime).getTime();
                            mapReport.put(time, inner);
                            mapWordReport.put(time, cont_word);
                        } catch (ParseException e) {
                            log.error(e.getMessage(), e);
                        }
                    }
                    continue;
                }
            }

            // 修订
            if (title.contains("修订")) {
                if (StrUtil.containsAny(title, drugAnd.stream().map(Drug::getWord).toArray(String[]::new))
                        && !StrUtil.containsAny(title, drugNot.stream().map(Drug::getWord).toArray(String[]::new))) {
                    JSONObject inner = new JSONObject();
                    inner.put("title", title);
                    inner.put("dataTime", dataTime);
                    inner.put("url", url);
                    inner.put("content", "");
                    inner.put("number", "(" + innerReviseNum++ + ")");

                    // word 使用
                    String cont_word = title +
                            " (发布时间：" + dataTime + ")" +
                            "\n" + "原文链接：" + url;
                    try {
                        long time = simpleDateFormat_year_month_day.parse(dataTime).getTime();
                        mapRevise.put(time, inner);
                        mapWordRevise.put(time, cont_word);
                    } catch (ParseException e) {
                        log.error(e.getMessage(), e);
                    }
                    continue;
                }
            }

            // 药物警戒
            if (title.contains("药物警戒")) {
                JSONArray titleS = jsonObject.getJSONArray("synopsis");
                JSONArray synopsis = new JSONArray();
                if (CollectionUtils.isNotEmpty(titleS)) {
                    synopsis = titleS;
                }
                List<String> array = new ArrayList<>();
                if (CollectionUtils.isNotEmpty(synopsis)) {
                    for (int i = 0; i < synopsis.size(); i++) {
                        array.add(StrUtil.trim(synopsis.getString(i)));
                    }
                    array = array.stream().distinct().collect(Collectors.toList());
                }
                if (CollectionUtils.isNotEmpty(array)) {
                    for (String con : array) {
                        if ("内容提要".equals(con)) { // 不需要内容提要
                            continue;
                        }
                        if (StrUtil.containsAny(con, drugAnd.stream().map(Drug::getWord).toArray(String[]::new))
                                && !StrUtil.containsAny(con, drugNot.stream().map(Drug::getWord).toArray(String[]::new))) {
                            JSONObject inner = new JSONObject();
                            inner.put("title", title);
                            inner.put("dataTime", dataTime);
                            inner.put("url", url);

                            // 前端使用
//                        String cont = title +
//                                " -" + con +
//                                " (发布时间：" + dataTime + ")" +
//                                "\n" + "原文链接：" + url;
                            inner.put("content", con);
                            inner.put("number", "(" + innerNmpa++ + ")");

                            // word 使用
                            String cont_word = title +
                                    " -" + con +
                                    " (发布时间：" + dataTime + ")" +
                                    "\n" + "原文链接：" + url;

                            try {
                                long time = simpleDateFormat_year_month_day.parse(dataTime).getTime();
                                mapNmpa.put(time, inner);
                                mapWordNmpa.put(time, cont_word);
                            } catch (ParseException e) {
                                log.error(e.getMessage(), e);
                            }
                        }
                    }
                }
            } else {  // title 中不包含药物警戒的  其来源可能是 ema /fda  判断 belong  其符合之后都归为药物警戒
                if (StringUtils.isNotBlank(belong)) {
                    if (belong.contains("ema")) {
                        JSONObject inner = new JSONObject();
                        inner.put("title", StringUtils.isNotBlank(transTitle) ? transTitle : "");
                        inner.put("dataTime", dataTime);
                        inner.put("url", url);
                        inner.put("content", StringUtils.isNotBlank(transContent) ? transContent : "");
                        inner.put("number", "(" + innerEma++ + ")");

                        // word 使用
                        String cont_word = transTitle +
                                " (发布时间：" + dataTime + ")" +
                                "\n" + "原文链接：" + url +
                                "\n" + transContent;;

                        try {
                            long time = simpleDateFormat_year_month_day.parse(dataTime).getTime();
                            mapEma.put(time, inner);
                            mapWordEma.put(time, cont_word);
                        } catch (ParseException e) {
                            log.error(e.getMessage(), e);
                        }
                    }

                    if (belong.contains("fda")) {
                        JSONObject inner = new JSONObject();
                        inner.put("title", StringUtils.isNotBlank(transTitle) ? transTitle : "");
                        inner.put("dataTime", dataTime);
                        inner.put("url", url);
                        inner.put("content", StringUtils.isNotBlank(transContent) ? transContent : "");
                        inner.put("number", "(" + innerFda++ + ")");

                        // word 使用
                        String cont_word = transTitle + " (发布时间：" + dataTime + ")" +
                                "\n" + "原文链接：" + url +
                                "\n" + transContent;

                        try {
                            long time = simpleDateFormat_year_month_day.parse(dataTime).getTime();
                            mapFda.put(time, inner);
                            mapWordFda.put(time, cont_word);
                        } catch (ParseException e) {
                            log.error(e.getMessage(), e);
                        }
                    }
                }
            }



        }

        // 药物警戒  nmpa
        List<JSONObject> contentsNmpaBySort = mapNmpa.entrySet().stream().sorted(Comparator.comparingLong((k) -> {
            Map<Long, JSONObject> innerMap = JSON.parseObject(JSON.toJSONString(k), new TypeReference<Map<Long, JSONObject>>() {
            });
            Long[] array = innerMap.keySet().toArray(new Long[0]);
            return array[0];
        }).reversed()).map(Map.Entry::getValue).collect(Collectors.toList());
        if (CollectionUtils.isNotEmpty(contentsNmpaBySort)) {
            if (contentsNmpaBySort.size() == 1) {
                JSONObject jsonObject = contentsNmpaBySort.get(0);
                jsonObject.put("number", "");
            } else {
                int count = 1;
                for (JSONObject jsonObject : contentsNmpaBySort) {
                    jsonObject.put("number", "(" + count++ + ")");
                }
            }
        }

        // 药物警戒  ema
        List<JSONObject> contentsEmaBySort = mapEma.entrySet().stream().sorted(Comparator.comparingLong((k) -> {
            Map<Long, JSONObject> innerMap = JSON.parseObject(JSON.toJSONString(k), new TypeReference<Map<Long, JSONObject>>() {
            });
            Long[] array = innerMap.keySet().toArray(new Long[0]);
            return array[0];
        }).reversed()).map(Map.Entry::getValue).collect(Collectors.toList());
        if (CollectionUtils.isNotEmpty(contentsEmaBySort)) {
            if (contentsEmaBySort.size() == 1) {
                JSONObject jsonObject = contentsEmaBySort.get(0);
                jsonObject.put("number", "");
            } else {
                int count = 1;
                for (JSONObject jsonObject : contentsEmaBySort) {
                    jsonObject.put("number", "(" + count++ + ")");
                }
            }
        }

        // 药物警戒  fda
        List<JSONObject> contentsFdaBySort = mapFda.entrySet().stream().sorted(Comparator.comparingLong((k) -> {
            Map<Long, JSONObject> innerMap = JSON.parseObject(JSON.toJSONString(k), new TypeReference<Map<Long, JSONObject>>() {
            });
            Long[] array = innerMap.keySet().toArray(new Long[0]);
            return array[0];
        }).reversed()).map(Map.Entry::getValue).collect(Collectors.toList());
        if (CollectionUtils.isNotEmpty(contentsFdaBySort)) {
            if (contentsFdaBySort.size() == 1) {
                JSONObject jsonObject = contentsFdaBySort.get(0);
                jsonObject.put("number", "");
            } else {
                int count = 1;
                for (JSONObject jsonObject : contentsFdaBySort) {
                    jsonObject.put("number", "(" + count++ + ")");
                }
            }
        }
        JSONObject ywjjinner = new JSONObject();
        ywjjinner.put("nmpa", contentsNmpaBySort);
        ywjjinner.put("ema", contentsEmaBySort);
        ywjjinner.put("fda", contentsFdaBySort);

        String drugName = drugAnd.stream().map(Drug::getWord).collect(Collectors.joining("联合"));
        ywjjinner.put("drugName", drugName);

        List<String> contentsNmpaWordBySort = mapWordNmpa.entrySet().stream().sorted(Comparator.comparingLong((k) -> {
            Map<Long, String> innerMap = JSON.parseObject(JSON.toJSONString(k), new TypeReference<Map<Long, String>>() {
            });
            Long[] array = innerMap.keySet().toArray(new Long[0]);
            return array[0];
        }).reversed()).map(Map.Entry::getValue).collect(Collectors.toList());

        JSONArray contentsNmpaWordArrayCopy = new JSONArray();
        if (contentsNmpaWordBySort.size() > 1) {
            int num = 0;
            for (int i = 0; i < contentsNmpaWordBySort.size(); i++) {
                String circleNumber = String.valueOf((char) (0x2460 + num++));
                String con = contentsNmpaWordBySort.get(i);
                con = circleNumber + " " + con;
                contentsNmpaWordArrayCopy.add(con);
            }
        }

        if (CollectionUtils.isNotEmpty(contentsNmpaWordArrayCopy)) {
            ywjjinner.put("nmpaWord", contentsNmpaWordArrayCopy);
        } else {
            if (CollectionUtils.isNotEmpty(contentsNmpaWordBySort)) {
                ywjjinner.put("nmpaWord", contentsNmpaWordBySort);
            }
        }

        List<String> contentsEmaWordBySort = mapWordEma.entrySet().stream().sorted(Comparator.comparingLong((k) -> {
            Map<Long, String> innerMap = JSON.parseObject(JSON.toJSONString(k), new TypeReference<Map<Long, String>>() {
            });
            Long[] array = innerMap.keySet().toArray(new Long[0]);
            return array[0];
        }).reversed()).map(Map.Entry::getValue).collect(Collectors.toList());
        JSONArray contentsEmaWordArrayCopy = new JSONArray();
        if (contentsEmaWordBySort.size() > 1) {
            int num = 0;
            for (int i = 0; i < contentsEmaWordBySort.size(); i++) {
                String circleNumber = String.valueOf((char) (0x2460 + num++));
                String con = contentsEmaWordBySort.get(i);
                con = circleNumber + " " + con;
                contentsEmaWordArrayCopy.add(con);
            }
        }

        if (CollectionUtils.isNotEmpty(contentsEmaWordArrayCopy)) {
            ywjjinner.put("emaWord", contentsEmaWordArrayCopy);
        } else {
            if (CollectionUtils.isNotEmpty(contentsEmaWordBySort)) {
                ywjjinner.put("emaWord", contentsEmaWordBySort);
            }
        }

        List<String> contentsFdaWordBySort = mapWordFda.entrySet().stream().sorted(Comparator.comparingLong((k) -> {
            Map<Long, String> innerMap = JSON.parseObject(JSON.toJSONString(k), new TypeReference<Map<Long, String>>() {
            });
            Long[] array = innerMap.keySet().toArray(new Long[0]);
            return array[0];
        }).reversed()).map(Map.Entry::getValue).collect(Collectors.toList());
        JSONArray contentsFdaWordArrayCopy = new JSONArray();
        if (contentsFdaWordBySort.size() > 1) {
            int num = 0;
            for (int i = 0; i < contentsFdaWordBySort.size(); i++) {
                String circleNumber = String.valueOf((char) (0x2460 + num++));
                String con = contentsFdaWordBySort.get(i);
                con = circleNumber + " " + con;
                contentsFdaWordArrayCopy.add(con);
            }
        }

        if (CollectionUtils.isNotEmpty(contentsFdaWordArrayCopy)) {
            ywjjinner.put("fdaWord", contentsFdaWordArrayCopy);
        } else {
            if (CollectionUtils.isNotEmpty(contentsFdaWordBySort)) {
                ywjjinner.put("fdaWord", contentsFdaWordBySort);
            }
        }

        result.getJSONObject("policy").put("newsFlash", ywjjinner);

        // 通报
        List<JSONObject> reportBySort = mapReport.entrySet().stream().sorted(Comparator.comparingLong((k) -> {
            Map<Long, JSONObject> innerMap = JSON.parseObject(JSON.toJSONString(k), new TypeReference<Map<Long, JSONObject>>() {
            });
            Long[] array = innerMap.keySet().toArray(new Long[0]);
            return array[0];
        }).reversed()).map(Map.Entry::getValue).collect(Collectors.toList());
        if (CollectionUtils.isNotEmpty(reportBySort)) {
            if (reportBySort.size() == 1) {
                JSONObject jsonObject = reportBySort.get(0);
                jsonObject.put("number", "");
            } else {
                int count = 1;
                for (JSONObject jsonObject : reportBySort) {
                    jsonObject.put("number", "(" + count++ + ")");
                }
            }
        }

        JSONObject reportInner = new JSONObject();
        reportInner.put("contentsArray", reportBySort);
        reportInner.put("drugName", drugName);

        List<String> reportWordBySort = mapWordReport.entrySet().stream().sorted(Comparator.comparingLong((k) -> {
            Map<Long, String> innerMap = JSON.parseObject(JSON.toJSONString(k), new TypeReference<Map<Long, String>>() {
            });
            Long[] array = innerMap.keySet().toArray(new Long[0]);
            return array[0];
        }).reversed()).map(Map.Entry::getValue).collect(Collectors.toList());
        JSONArray reportWordArrayCopy = new JSONArray();
        if (reportWordBySort.size() > 1) {
            int num = 0;
            for (int i = 0; i < reportWordBySort.size(); i++) {
                String circleNumber = String.valueOf((char) (0x2460 + num++));
                String con = reportWordBySort.get(i);
                con = circleNumber + " " + con;
                reportWordArrayCopy.add(con);
            }
        }

        if (CollectionUtils.isNotEmpty(reportWordArrayCopy)) {
            reportInner.put("contentsWordArray", reportWordArrayCopy);
        } else {
            if (CollectionUtils.isNotEmpty(reportWordBySort)) {
                reportInner.put("contentsWordArray", reportWordBySort);
            }
        }
        result.getJSONObject("policy").put("report", reportInner);


        // 修订
        List<JSONObject> reviseBySort = mapRevise.entrySet().stream().sorted(Comparator.comparingLong((k) -> {
            Map<Long, JSONObject> innerMap = JSON.parseObject(JSON.toJSONString(k), new TypeReference<Map<Long, JSONObject>>() {
            });
            Long[] array = innerMap.keySet().toArray(new Long[0]);
            return array[0];
        }).reversed()).map(Map.Entry::getValue).collect(Collectors.toList());
        if (CollectionUtils.isNotEmpty(reviseBySort)) {
            if (reviseBySort.size() == 1) {
                JSONObject jsonObject = reviseBySort.get(0);
                jsonObject.put("number", "");
            } else {
                int count = 1;
                for (JSONObject jsonObject : reviseBySort) {
                    jsonObject.put("number", "(" + count++ + ")");
                }
            }
        }

        JSONObject reviseInner = new JSONObject();
        reviseInner.put("contentsArray", reviseBySort);
        reviseInner.put("drugName", drugName);

        List<String> reviseWordBySort = mapWordRevise.entrySet().stream().sorted(Comparator.comparingLong((k) -> {
            Map<Long, String> innerMap = JSON.parseObject(JSON.toJSONString(k), new TypeReference<Map<Long, String>>() {
            });
            Long[] array = innerMap.keySet().toArray(new Long[0]);
            return array[0];
        }).reversed()).map(Map.Entry::getValue).collect(Collectors.toList());
        JSONArray reviseWordArrayCopy = new JSONArray();
        if (reviseWordBySort.size() > 1) {
            int num = 0;
            for (int i = 0; i < reviseWordBySort.size(); i++) {
                String circleNumber = String.valueOf((char) (0x2460 + num++));
                String con = reviseWordBySort.get(i);
                con = circleNumber + " " + con;
                reviseWordArrayCopy.add(con);
            }
        }

        if (CollectionUtils.isNotEmpty(reviseWordArrayCopy)) {
            reviseInner.put("contentsWordArray", reviseWordArrayCopy);
        } else {
            if (CollectionUtils.isNotEmpty(reviseWordBySort)) {
                reviseInner.put("contentsWordArray", reviseWordBySort);
            }
        }
        result.getJSONObject("policy").put("revise", reviseInner);
    }

    @Override
    public List<JSONObject> indication(SafeInfoDto safeInfoDto) {
        List<JSONObject> result = new ArrayList<>();
        //根据外来数据开始构建检索条件
        Condition condition = new Condition();
        //药品
        List<Drug> drugs = new ArrayList<>();
        String userDrugNames = safeInfoDto.getUserDrugNames();
        String[] split = userDrugNames.split("\\|\\|");
        for (int i = 0; i < split.length; i++) {
            Drug drug = new Drug();
            drug.setStatus(1);
            /*if (i % 2 == 0) {
                drug.setStatus(1);
            } else {
                drug.setStatus(2);
            }*/
            String s = split[i];
            String[] strings = s.split("&&");
            ArrayList<String> drugNameAlias = new ArrayList<>();
            for (int i1 = 0; i1 < strings.length; i1++) {
                if (i1 == 0) {
                    drug.setWord(strings[i1]);
                } else {
                    drugNameAlias.add(strings[i1].toLowerCase());
                }
            }
            drug.setDrugNameAlias(drugNameAlias);
            if (i > 0) {
                Drug inner = new Drug();
                inner.setStatus(2);
                drugs.add(inner);
            }
            drugs.add(drug);
        }
        condition.setDrugs(drugs);
        //不良反应列表
        boolean isADRs = false;
        String userADRS = safeInfoDto.getUserADRS();
        if (StringUtils.isNotBlank(userADRS)) {
            isADRs = true;
            List<InterventionAndOutcome> outcomes = new ArrayList<>();
            String[] splitOutcome = userADRS.split("\\|\\|");
            for (int i = 0; i < splitOutcome.length; i++) {
                InterventionAndOutcome outcome = new InterventionAndOutcome();
                if (i % 2 == 0) {
                    outcome.setStatus(1);
                } else {
                    outcome.setStatus(2);
                }
                String s = splitOutcome[i];
                String[] strings = s.split("&&");
                List<WordStatus> zhSynonym = new ArrayList<>();
                for (int i1 = 0; i1 < strings.length; i1++) {
                    if (i1 == 0) {
                        outcome.setWord(strings[i1]);
                    } else {
                        WordStatus wordStatus = new WordStatus(strings[i1], true);
                        zhSynonym.add(wordStatus);
                    }
                }
                outcome.setZhSynonym(zhSynonym);
                outcomes.add(outcome);
            }
            condition.setOutcomes(outcomes);
        }
        int typeDrug = 1;
        String drugNamesAccurate = safeInfoDto.getDrugNamesAccurate();
        if ("true".equals(drugNamesAccurate)) {
            typeDrug = 2;
        }
        int typeOutcome = 1;
        String adrsAccurate = safeInfoDto.getADRSAccurate();
        if ("true".equals(adrsAccurate)) {
            typeOutcome = 2;
        }
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, isADRs);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("indicationPt").field("indicationPt.keyword").size(20));
        SearchHits<AdverseForCaseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseForCaseIndex.class);

        Aggregations aggregations = search.getAggregations();

        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("indicationPt");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                JSONObject jsonObject = new JSONObject();
                String key = bucket.getKey().toString();
                if (StringUtils.isEmpty(key)){
                    continue;
                }
                jsonObject.put("ptEn", key);
                JSONObject ptAllData = mongoTemplate.findOne(new Query(Criteria.where("pt_en").is(key)), JSONObject.class, "pt_all_data");
                String ptCh = "";
                if (ptAllData != null) {
                    ptCh = ptAllData.getString("pt_ch");
                } else if ("unknown".equals(key)) {
                    ptCh = "未知";
                    if ("0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                }
                jsonObject.put("ptCh", ptCh);
                result.add(jsonObject);
            }
        }
        return result;
    }


    public JSONObject ptCount() {
        JSONObject result = new JSONObject();
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(new BoolQueryBuilder());
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("indicationPt").field("indicationPt.keyword").size(200000000));
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        Aggregations aggregations = search.getAggregations();
        int size1 = 0;
        int size2 = 0;
        int size3 = 0;
        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("indicationPt");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                String key = bucket.getKey().toString();
                size1++;
                Boolean x = mongoTemplate.exists(new Query(Criteria.where("pt_en").is(key)), JSONObject.class, "pt_all_data");
                if (x) {
                    size2++;
                }
                if (isPhraseOfThreeWords(key)) {
                    size3++;
                }
            }
            result.put("size1", size1);
            result.put("size2", size2);
            result.put("size3", size3);
        }
        return result;


    }


    @Override
    public List<JSONObject> indicationJd(SafeInfoDto safeInfoDto) {
        List<JSONObject> result = new ArrayList<>();
        //根据外来数据开始构建检索条件
        Condition condition = new Condition();
        //药品
        List<Drug> drugs = new ArrayList<>();
        String userDrugNames = safeInfoDto.getUserDrugNames();
        String[] split = userDrugNames.split("\\|\\|");
        for (int i = 0; i < split.length; i++) {
            Drug drug = new Drug();
            drug.setStatus(1);
            /*if (i % 2 == 0) {
                drug.setStatus(1);
            } else {
                drug.setStatus(2);
            }*/
            String s = split[i];
            String[] strings = s.split("&&");
            ArrayList<String> drugNameAlias = new ArrayList<>();
            for (int i1 = 0; i1 < strings.length; i1++) {
                if (i1 == 0) {
                    drug.setWord(strings[i1]);
                } else {
                    drugNameAlias.add(strings[i1].toLowerCase());
                }
            }
            drug.setDrugNameAlias(drugNameAlias);
            if (i > 0) {
                Drug inner = new Drug();
                inner.setStatus(2);
                drugs.add(inner);
            }
            drugs.add(drug);
        }
        condition.setDrugs(drugs);
        //不良反应列表
        boolean isADRs = false;
        String userADRS = safeInfoDto.getUserADRS();
        if (StringUtils.isNotBlank(userADRS)) {
            isADRs = true;
            List<InterventionAndOutcome> outcomes = new ArrayList<>();
            String[] splitOutcome = userADRS.split("\\|\\|");
            for (int i = 0; i < splitOutcome.length; i++) {
                InterventionAndOutcome outcome = new InterventionAndOutcome();
                if (i % 2 == 0) {
                    outcome.setStatus(1);
                } else {
                    outcome.setStatus(2);
                }
                String s = splitOutcome[i];
                String[] strings = s.split("&&");
                List<WordStatus> zhSynonym = new ArrayList<>();
                for (int i1 = 0; i1 < strings.length; i1++) {
                    if (i1 == 0) {
                        outcome.setWord(strings[i1]);
                    } else {
                        WordStatus wordStatus = new WordStatus(strings[i1], true);
                        zhSynonym.add(wordStatus);
                    }
                }
                outcome.setZhSynonym(zhSynonym);
                outcomes.add(outcome);
            }
            condition.setOutcomes(outcomes);
        }
        int typeDrug = 1;
        String drugNamesAccurate = safeInfoDto.getDrugNamesAccurate();
        if ("true".equals(drugNamesAccurate)) {
            typeDrug = 2;
        }
        int typeOutcome = 1;
        String adrsAccurate = safeInfoDto.getADRSAccurate();
        if ("true".equals(adrsAccurate)) {
            typeOutcome = 2;
        }
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, isADRs);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("indicationPt").field("indicationPt.keyword").size(20));
        SearchHits<AdverseForCaseIndexJd> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseForCaseIndexJd.class);

        Aggregations aggregations = search.getAggregations();

        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("indicationPt");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                JSONObject jsonObject = new JSONObject();
                String key = bucket.getKey().toString();
                jsonObject.put("ptEn", key);
                JSONObject ptAllData = ReleaseMongoUtil.mongo.findOne(new Query(Criteria.where("pt_en").is(key)), JSONObject.class, "pt_jd_data");
                String ptCh = "";
                if (ptAllData != null) {
                    ptCh = ptAllData.getString("pt_ch");
                } else if ("unknown".equals(key)) {
                    ptCh = "未知";
                    if ("0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                }else {
                    String trans = DeeplApi.trans(key);
                    ptCh = trans;
                    JSONObject jsonObject1 = new JSONObject();
                    jsonObject1.put("pt_en", key);
                    jsonObject1.put("pt_ch", ptCh);
                    ReleaseMongoUtil.mongo.save(jsonObject1, "pt_jd_data");
                }
                jsonObject.put("ptCh", ptCh);
                result.add(jsonObject);
            }
        }
        return result;
    }


    public static boolean isPhraseOfThreeWords(String phrase) {
        // Splitting the string by spaces and filtering out empty strings
        String[] words = phrase.trim().split("\\s+");
        // Check if the array of words has exactly three elements
        return words.length >= 3;
    }


    @Override
    @Retryable(
            value = {java.net.SocketTimeoutException.class,
                     org.springframework.dao.DataAccessResourceFailureException.class,
                     java.util.concurrent.CompletionException.class},
            maxAttempts = 2,
            backoff = @Backoff(delay = 3000, multiplier = 1.0)
    )
    public JSONObject drugSafeInfo(SafeInfoDto safeInfoDto, Condition conditionx) {
        String cacheKey = "safeInfoX:" + safeInfoDto.hashCode() + conditionx.hashCode();
        Object o = RedisUtil.redis.opsForValue().get(cacheKey);
        log.info("外部调用入参{}", safeInfoDto.toString() + conditionx.toString());
        if (ObjectUtils.isNotEmpty(o)) {
            return JSONObject.parseObject(o.toString());
        }

        long start = System.currentTimeMillis();
        JSONObject result = new JSONObject();
        Condition condition = new Condition();
        boolean isADRs = false;
        List<String> drugName = new ArrayList<>();
        boolean isInfo = false;
//        if (StringUtils.isEmpty(safeInfoDto.getUserDrugNames())){
//            safeInfoDto.setUserDrugNames(conditionx.getDrugs().get(0).getEnWord());
//        }
        //是否是联合用药
        Boolean isUnion = false;

        if (StringUtils.isNotEmpty(safeInfoDto.getUserDrugNames())) {
            //根据外来数据开始构建检索条件
            //药品
            isInfo = true;
            List<Drug> drugs = new ArrayList<>();
            String userDrugNames = safeInfoDto.getUserDrugNames();
            String[] split = userDrugNames.split("\\|\\|");
            for (int i = 0; i < split.length; i++) {
                Drug drug = new Drug();
                drug.setStatus(1);
            /*if (i % 2 == 0) {
                drug.setStatus(1);
            } else {
                drug.setStatus(2);
            }*/
                String s = split[i];
                String[] strings = s.split("&&");
                ArrayList<String> drugNameAlias = new ArrayList<>();
                for (int i1 = 0; i1 < strings.length; i1++) {
                    if (i1 == 0) {
                        drug.setWord(strings[i1]);
                        drugName.add(strings[i1].toLowerCase());
                    } else {
                        drugName.add(strings[i1].toLowerCase());
                        drugNameAlias.add(strings[i1].toLowerCase());
                    }
                }
                drug.setDrugNameAlias(drugNameAlias);
                if (i > 0) {
                    Drug inner = new Drug();
                    inner.setStatus(2);
                    drugs.add(inner);
                }
                drugs.add(drug);
            }
            condition.setDrugs(drugs);
            //疾病（适应症）
            String userIndications = safeInfoDto.getUserIndications();
            if (StringUtils.isNotBlank(userIndications)) {
                List<Disease> diseases = new ArrayList<>();
                String[] splitIndications = userIndications.split("\\|\\|");
                for (int i = 0; i < splitIndications.length; i++) {
                    Disease disease = new Disease();
                    if (i % 2 == 0) {
                        disease.setStatus(1);
                    } else {
                        disease.setStatus(2);
                    }
                    String s = splitIndications[i];
                    String[] strings = s.split("&&");
                    List<WordStatus> zhSynonym = new ArrayList<>();
                    for (int i1 = 0; i1 < strings.length; i1++) {
                        if (i1 == 0) {
                            disease.setWord(strings[i1]);
                        } else {
                            WordStatus wordStatus = new WordStatus(strings[i1], true);
                            zhSynonym.add(wordStatus);
                        }
                    }
                    disease.setZhSynonym(zhSynonym);
                    diseases.add(disease);
                }
                condition.setDiseases(diseases);
            }
            //不良反应列表
            String userADRS = safeInfoDto.getUserADRS();
            if (StringUtils.isNotBlank(userADRS)) {
                isADRs = true;
                List<InterventionAndOutcome> outcomes = new ArrayList<>();
                String[] splitOutcome = userADRS.split("\\|\\|");
                for (int i = 0; i < splitOutcome.length; i++) {
                    InterventionAndOutcome outcome = new InterventionAndOutcome();
                    if (i % 2 == 0) {
                        outcome.setStatus(1);
                    } else {
                        outcome.setStatus(2);
                    }
                    String s = splitOutcome[i];
                    String[] strings = s.split("&&");
                    List<WordStatus> zhSynonym = new ArrayList<>();
                    for (int i1 = 0; i1 < strings.length; i1++) {
                        if (i1 == 0) {
                            outcome.setWord(strings[i1]);
                        } else {
                            WordStatus wordStatus = new WordStatus(strings[i1], true);
                            zhSynonym.add(wordStatus);
                        }
                    }
                    outcome.setZhSynonym(zhSynonym);
                    outcomes.add(outcome);
                }
                condition.setOutcomes(outcomes);
            }

        } else {
            List<Drug> drugs = conditionx.getDrugs();
            ArrayList<Drug> drugs1 = new ArrayList<>();
            for (int i = 0; i < drugs.size(); i++) {
                if (StringUtils.isNotEmpty(drugs.get(i).getWord())){
                Drug drug = new Drug();
                drug.setStatus(1);
            /*if (i % 2 == 0) {
                drug.setStatus(1);
            } else {
                drug.setStatus(2);
            }*/
                ArrayList<String> drugNameAlias = new ArrayList<>();

                if (StringUtils.isNotEmpty(drugs.get(i).getEnWord())) {
                    drugNameAlias.add(drugs.get(i).getEnWord().toLowerCase());
                    drugName.add(drugs.get(i).getEnWord().toLowerCase());
                    if (drugs.get(i).getEnWord().contains(",") || drugs.get(i).getEnWord().contains(";")) {
                        String[] split = drugs.get(i).getEnWord().split("(,|;)");
                        for (int i1 = 0; i1 < split.length; i1++) {
                            drugNameAlias.add(split[i1].toLowerCase());
                            drugName.add(split[i1].toLowerCase());
                        }
                    }
                }
                        if (StringUtils.isNotEmpty(drugs.get(i).getWord())){
                            drugName.add(drugs.get(i).getWord().toLowerCase());
                            drugNameAlias.add(drugs.get(i).getWord().toLowerCase());
                            String lowerCase = retrievalService.innerSynonym(drugs.get(i).getWord()).toLowerCase();
                            if (StringUtils.isNotBlank(lowerCase)){
                                drug.setWord(lowerCase);
                                drugName.add(lowerCase);
                            }else {
                                drug.setWord(drugs.get(i).getWord());
                            }

                        }

                drug.setDrugNameAlias(drugNameAlias);
                if (i > 0) {
                    Drug inner = new Drug();
                    inner.setStatus(2);
                    drugs1.add(inner);
                    isUnion = true;
                }

                drugs1.add(drug);
            }}
            condition.setDrugs(drugs1);
        }

        int typeDrug = 1;
        String drugNamesAccurate = safeInfoDto.getDrugNamesAccurate();
        if ("true".equals(drugNamesAccurate)) {
            typeDrug = 2;
        }
        int typeOutcome = 1;
        String adrsAccurate = safeInfoDto.getADRSAccurate();
        if ("true".equals(adrsAccurate)) {
            typeOutcome = 2;
        }
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, isADRs);
        Condition condition1 = new Condition();
        condition1.setDrugs(condition.getDrugs());
        BoolQueryBuilder adverseQuery1 = QueryUtils.createAdverseQuery(condition1, typeDrug, typeOutcome, false);
        condition1.setOutcomes(condition.getOutcomes());
        BoolQueryBuilder adverseQuery2 = QueryUtils.createAdverseQuery(condition1, typeDrug, typeOutcome, isADRs);
        BoolQueryBuilder adverseCaseQuery = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, isADRs);

        //时间
        if (StringUtils.isNotBlank(safeInfoDto.getBeginDate())) {
            adverseQuery.must().add(QueryBuilders.rangeQuery("date").gte(safeInfoDto.getBeginDate()));
            adverseCaseQuery.must().add(QueryBuilders.rangeQuery("date").gte(safeInfoDto.getBeginDate()));
            adverseQuery1.must().add(QueryBuilders.rangeQuery("date").gte(safeInfoDto.getBeginDate()));
            adverseQuery2.must().add(QueryBuilders.rangeQuery("date").gte(safeInfoDto.getBeginDate()));
        }
        if (StringUtils.isNotBlank(safeInfoDto.getEndDate())) {
            adverseQuery.must().add(QueryBuilders.rangeQuery("date").lte(safeInfoDto.getEndDate()));
            adverseCaseQuery.must().add(QueryBuilders.rangeQuery("date").lte(safeInfoDto.getEndDate()));
            adverseQuery1.must().add(QueryBuilders.rangeQuery("date").lte(safeInfoDto.getEndDate()));
            adverseQuery2.must().add(QueryBuilders.rangeQuery("date").lte(safeInfoDto.getEndDate()));
        }

        List<String> total = getTotal(adverseQuery2, drugName,adverseQuery1);
        result.put("titleCount", total);

        //药品在报告中的作用
        String roleCode = safeInfoDto.getRoleCode();
        if (isInfo && !"-1".equals(roleCode)) {
            List<String> realRole = new ArrayList<>();
            char[] chars = roleCode.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = false;
                if (aChar == '1') {
                    flag = true;
                }
                switch (i) {
                    case 0:
                        if (flag) {
                            realRole.add("PS");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realRole.add("SS");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realRole.add("C");
                        }
                        break;
                    case 3:
                        if (flag) {
                            realRole.add("I");
                        }
                        break;
                }
            }
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder4 = QueryBuilders.boolQuery();
            for (String s : drugName) {
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
                boolQueryBuilder4.should().add(QueryBuilders.matchQuery("drugName",s));
            }
            boolQueryBuilder.must().add(QueryBuilders.termsQuery("roleCods.role", realRole));
            boolQueryBuilder.must().add(boolQueryBuilder2);
            NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
            adverseQuery.must().add(boolQueryBuilder1);
            BoolQueryBuilder boolQueryBuilder3 = QueryBuilders.boolQuery();
            for (String s : realRole) {
                boolQueryBuilder3.should().add(QueryBuilders.matchQuery("roleCod", s));
            }
            adverseCaseQuery.must().add(boolQueryBuilder3);
            adverseCaseQuery.must().add(boolQueryBuilder4);
        }else if(!isInfo && !isUnion){
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder4 = QueryBuilders.boolQuery();
            for (String s : drugName) {
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
                boolQueryBuilder4.should().add(QueryBuilders.matchQuery("drugName",s));
            }
            boolQueryBuilder.must().add(QueryBuilders.termQuery("roleCods.role", "PS"));
            boolQueryBuilder.must().add(boolQueryBuilder2);
            NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
            adverseQuery.must().add(boolQueryBuilder1);
            BoolQueryBuilder boolQueryBuilder3 = QueryBuilders.boolQuery();
            boolQueryBuilder3.should().add(QueryBuilders.matchQuery("roleCod", "PS"));

            adverseCaseQuery.must().add(boolQueryBuilder3);
            adverseCaseQuery.must().add(boolQueryBuilder4);
        }

        //严重不良反应结局
        String outcCode = safeInfoDto.getOutcCode();
        if (isInfo && !"-1".equals(outcCode)) {
            List<String> realOutcomeCode = new ArrayList<>();
            char[] chars = outcCode.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = false;
                if (aChar == '1') {
                    flag = true;
                }
                switch (i) {
                    case 0:
                        if (flag) {
                            realOutcomeCode.add("死亡");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realOutcomeCode.add("危及生命");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realOutcomeCode.add("住院初次或长期");
                        }
                        break;
                    case 3:
                        if (flag) {
                            realOutcomeCode.add("残疾");
                        }
                        break;
                    case 4:
                        if (flag) {
                            realOutcomeCode.add("先天性异常或出生缺陷");
                        }
                        break;
                    case 5:
                        if (flag) {
                            realOutcomeCode.add("永久的损伤/伤害");
                        }
                        break;
                    case 6:
                        if (flag) {
                            realOutcomeCode.add("其他严重 (重大医疗事件)");
                        }
                        break;
                    case 7:
                        if (flag) {
                            realOutcomeCode.add("未报告结局指标");
                        }
                }
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("outcomeCod", realOutcomeCode));
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("outcomeCod", realOutcomeCode));
        }
        //报告者职业
        String occpCode = safeInfoDto.getOccpCode();
        if (isInfo && !"-1".equals(occpCode)) {
            List<String> realOccupationalCod = new ArrayList<>();
            char[] chars = occpCode.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = aChar == '1';
                switch (i) {
                    case 0:
                        if (flag) {
                            realOccupationalCod.add("医生");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realOccupationalCod.add("药师");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realOccupationalCod.add("其他健康专家");
                        }
                        break;
                    case 3:
                        if (flag) {
                            realOccupationalCod.add("律师");
                        }
                        break;
                    case 4:
                        if (flag) {
                            realOccupationalCod.add("消费者");
                        }
                        break;
                    case 5:
                        if (flag) {
                            realOccupationalCod.add("未知");
                        }
                }
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("occupationalCod", realOccupationalCod));
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("occupationalCod", realOccupationalCod));
        }
        //患者性别
        String sex = safeInfoDto.getSex();
        if (isInfo && !"-1".equals(sex)) {
            List<String> realSex = new ArrayList<>();
            char[] chars = sex.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = aChar == '1';
                switch (i) {
                    case 0:
                        if (flag) {
                            realSex.add("男");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realSex.add("女");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realSex.add("未知");
                        }
                        break;
                }
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("sex", realSex));
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("sex", realSex));
        }
        //患者年龄
        String age = safeInfoDto.getAge();
        if (isInfo && !"-1".equals(age)) {
            List<String> realAge = new ArrayList<>();
            char[] chars = age.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = aChar == '1';
                switch (i) {
                    case 0:
                        if (flag) {
                            realAge.add("≤18岁");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realAge.add("18＜年龄＜65");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realAge.add("≥65岁");
                        }
                        break;
                }
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("age", realAge));
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("age", realAge));
        }


        //开始计算相关数据
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        //case
        NativeSearchQuery caseNativeSearchQuery = new NativeSearchQuery(adverseCaseQuery);
        caseNativeSearchQuery.setTrackTotalHits(true);
        caseNativeSearchQuery.setPageable(PageRequest.of(1, 1));
        if (isInfo){
            //year_list 年份分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("year").field("year").size(30));
            result.put("year_list", new JSONArray());
            //reporter_country_list 地区分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("reporterCountryName").field("reporterCountryName").size(30));
            result.put("reporter_country_list", new JSONArray());
            //occp_cod 职业分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("occupationalCod").field("occupationalCod").size(30));
            result.put("occp_cod", new JSONArray());
            //sex_m_f 性别分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("sex").field("sex").size(30));
            result.put("sex_m_f", new JSONArray());
            //age_list 年龄分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("age").field("age").size(30));
            result.put("age_list", new JSONArray());
            //wt_list 体重分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("weight").field("weight").size(30));
            result.put("wt_list", new JSONArray());
            //drug_num_list 给药方案
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("singleDrug").field("singleDrug").size(30));
            result.put("drug_num_list", new JSONArray());
            //dose_form_list 剂型分布
            caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("doseForm").field("doseForm").size(30));
            result.put("dose_form_list", new JSONArray());
            //route_list 给药途径分布
            caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("route").field("route").size(30));
            result.put("route_list", new JSONArray());
            //dose_amt_list 计量分布
            caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("doseAmtCombine").field("doseAmtCombine").size(30));
            result.put("dose_amt_list", new JSONArray());
            //dur_list 治疗持续时间分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("dur").field("dur").size(30));
            result.put("dur_list", new JSONArray());
            //cut_dt_list 不良反应发生时间分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("reactionOfTime").field("reactionOfTime").size(30));
            result.put("cut_dt_list", new JSONArray());

            //dechal 重新使用药物反应是否再次出现
            caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("dechal").field("dechal").size(4));
            result.put("dechal", new JSONArray());
            //rechal 停药或减药后反应是否减轻或消失
            caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("rechal").field("rechal").size(4));
            result.put("rechal", new JSONArray());

        }


        //indi_pt_list 适应症分布
        caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("indicationPt").field("indicationPt.keyword").size(30));
        result.put("indi_pt_list", new JSONArray());
        //pt_list 不良反应分布
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("ptList").field("ptList.keyword").size(100000));
        //聚合计算ptList的总数
        nativeSearchQuery.addAggregation(AggregationBuilders.sum("ptListNum").field("ptListNum"));
        result.put("pt_list", new JSONArray());
        //signal_dict 不良反应信号分析
//        JSONObject calculateTypicalSignals = calculateTypicalSignalsForSafe(condition, adverseQuery);
        result.put("signal_dict", new JSONObject());
        //outc_cod_num 不良反应总数
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("outcomeCodNum").field("outcomeCodNum"));
        result.put("outc_cod_count", new JSONObject());
        //outc_cod_list 严重不良反应
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("outcomeCod").field("outcomeCod").size(30));
        result.put("outc_cod_list", new JSONArray());



        CompletableFuture<SearchHits<AdverseIndex>> searchFuture = CompletableFuture.supplyAsync(
                () -> elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class));
        CompletableFuture<SearchHits<AdverseForCaseIndex>> caseSearchFuture = CompletableFuture.supplyAsync(
                () -> elasticsearchRestTemplate.search(caseNativeSearchQuery, AdverseForCaseIndex.class));
        SearchHits<AdverseIndex> search = searchFuture.join();
        SearchHits<AdverseForCaseIndex> caseSearch = caseSearchFuture.join();

        long totalHits = search.getTotalHits();
        long caseTotalHits = caseSearch.getTotalHits();
        Aggregations caseAggregations = caseSearch.getAggregations();
        Aggregations aggregations = search.getAggregations();

        if (caseAggregations != null&& aggregations != null&&totalHits>0) {
            if (isInfo){
                Aggregation doseForm = caseAggregations.get("doseForm");
                List<? extends Terms.Bucket> doseFormBuckets = ((ParsedTerms) doseForm).getBuckets();
                ArrayList<List> lists = new ArrayList<>();
                long unknown = totalHits;
                for (int i = 0; i < doseFormBuckets.size(); i++) {
                    Terms.Bucket bucket = doseFormBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("unknown".equals(key) ) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    unknown -= docCount;
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }catch (Exception e){
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    lists.add(array);
                }
                if (!"0".equals(safeInfoDto.getIsShowUnknown())){
                    JSONArray array = new JSONArray();
                    array.add(doseFormBuckets.size());
                    array.add("unknown");
                    array.add(unknown);
                    try {
                        array.add(BigDecimal.valueOf(unknown).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");

                    }catch (Exception e){
                        array.add(BigDecimal.valueOf(unknown).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    lists.add(array);
                }



                result.getJSONArray("dose_form_list").addAll(lists);


                //route
                Aggregation route = caseAggregations.get("route");
                ArrayList<List> lists1 = new ArrayList<>();
                long unknown1 = totalHits;
                List<? extends Terms.Bucket> routeBuckets = ((ParsedTerms) route).getBuckets();
                for (int i = 0; i < routeBuckets.size(); i++) {
                    Terms.Bucket bucket = routeBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("unknown".equals(key) ) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    unknown1 -= docCount;
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    JSONObject one = mongoTemplate.findOne(new Query(Criteria.where("route_en").is(key)), JSONObject.class, "route_translate");
                    String routeCh = "";
                    if (one != null) {
                        routeCh = one.getString("route_ch");
                    } else if ("unknown".equals(key)) {
                        routeCh = "未知";
                    }
                    array.add(routeCh);
                    lists1.add(array);
                }
                if (!"0".equals(safeInfoDto.getIsShowUnknown())){
                    JSONArray array = new JSONArray();
                    array.add(routeBuckets.size());
                    array.add("unknown");

                    array.add(unknown1);
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(unknown1).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(unknown1).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    String routeCh = "未知";
                    array.add(routeCh);
                    lists1.add(array);
                }

                result.getJSONArray("route_list").addAll(lists1);



                //doseAmtCombine
                Aggregation doseAmtCombine = caseAggregations.get("doseAmtCombine");
                List<? extends Terms.Bucket> doseAmtCombineBuckets = ((ParsedTerms) doseAmtCombine).getBuckets();
                ArrayList<List> lists2 = new ArrayList<>();
                long unknown2 = totalHits;

                for (int i = 0; i < doseAmtCombineBuckets.size(); i++) {
                    Terms.Bucket bucket = doseAmtCombineBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("unknown".equals(key) ) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    unknown2 -= docCount;
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    lists2.add(array);
                }
                if (!"0".equals(safeInfoDto.getIsShowUnknown())){
                    JSONArray array = new JSONArray();
                    array.add(doseAmtCombineBuckets.size());
                    array.add("unknown");
                    array.add(unknown2);
                    try {
                        array.add(BigDecimal.valueOf(unknown2).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(unknown2).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    lists2.add(array);
                }
                result.getJSONArray("dose_amt_list").addAll(lists2);
                //year
                Aggregation year = aggregations.get("year");
                List<? extends Terms.Bucket> yearBuckets = ((ParsedTerms) year).getBuckets();
                for (int i = 0; i < yearBuckets.size(); i++) {
                    Terms.Bucket bucket = yearBuckets.get(i);
                    JSONArray array = new JSONArray();
                    array.add(i);
                    String key = bucket.getKey().toString();
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("year_list").add(array);
                }
                //reporterCountry
                Aggregation reporterCountry = aggregations.get("reporterCountryName");
                List<? extends Terms.Bucket> reporterCountryBuckets = ((ParsedTerms) reporterCountry).getBuckets();
                for (int i = 0; i < reporterCountryBuckets.size(); i++) {
                    Terms.Bucket bucket = reporterCountryBuckets.get(i);
                    JSONArray array = new JSONArray();
                    String key = bucket.getKey().toString();
                    if ("未知".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("reporter_country_list").add(array);
                }
                //occupationalCod
                Aggregation occupationalCod = aggregations.get("occupationalCod");
                List<? extends Terms.Bucket> occupationalCodBuckets = ((ParsedTerms) occupationalCod).getBuckets();
                for (int i = 0; i < occupationalCodBuckets.size(); i++) {
                    Terms.Bucket bucket = occupationalCodBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("未知".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("occp_cod").add(array);
                }
                //sex
                Aggregation sexList = aggregations.get("sex");
                Map<String, Long> sexMap = new HashMap<>();
                List<? extends Terms.Bucket> sexCodBuckets = ((ParsedTerms) sexList).getBuckets();
                for (Terms.Bucket bucket : sexCodBuckets) {
                    String key = bucket.getKey().toString();
                    if (!"男".equals(key) && !"女".equals(key)) {
                        key = "未知";
                        if ("0".equals(safeInfoDto.getIsShowUnknown())) {
                            continue;
                        }
                    }
                    long docCount = bucket.getDocCount();
                    if (sexMap.containsKey(key)) {
                        sexMap.put(key, sexMap.get(key) + docCount);
                    } else {
                        sexMap.put(key, docCount);
                    }
                }
                if (sexMap.size() > 0) {
                    //男
                    Long manLong = sexMap.get("男");
                    if (manLong == null) {
                        manLong = 0L;
                    }
                    JSONArray manArray = new JSONArray();
                    manArray.add(0);
                    manArray.add("男");
                    manArray.add(manLong);
                    if (totalHits == 0) {
                        manArray.add(0 + "%");
                    } else {
                        try {
                            manArray.add(BigDecimal.valueOf(manLong).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                        } catch (Exception e) {
                            manArray.add(BigDecimal.valueOf(manLong).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                        }
                    }
                    result.getJSONArray("sex_m_f").add(manArray);
                    //女
                    Long womanLong = sexMap.get("女");
                    if (womanLong == null) {
                        womanLong = 0L;
                    }
                    JSONArray womanArray = new JSONArray();
                    womanArray.add(1);
                    womanArray.add("女");
                    womanArray.add(womanLong);
                    if (totalHits == 0) {
                        manArray.add(0 + "%");
                    } else {
                        try {
                            womanArray.add(BigDecimal.valueOf(womanLong).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                        } catch (Exception e) {
                            womanArray.add(BigDecimal.valueOf(womanLong).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                        }
                    }
                    result.getJSONArray("sex_m_f").add(womanArray);
                    //未知
                    Long unknownLong = sexMap.get("未知");
                    if (unknownLong == null) {
                        unknownLong = 0L;
                    }
                    JSONArray unknownArray = new JSONArray();
                    unknownArray.add(2);
                    unknownArray.add("未知");
                    unknownArray.add(unknownLong);
                    try {
                        unknownArray.add(BigDecimal.valueOf(unknownLong).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        unknownArray.add(BigDecimal.valueOf(unknownLong).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    if (!"0".equals(safeInfoDto.getIsShowUnknown())) {
                        result.getJSONArray("sex_m_f").add(unknownArray);
                    }

                }
                //age
                Aggregation ageList = aggregations.get("age");
                List<? extends Terms.Bucket> ageBuckets = ((ParsedTerms) ageList).getBuckets();
                for (int i = 0; i < ageBuckets.size(); i++) {
                    Terms.Bucket bucket = ageBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("未知".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("age_list").add(array);
                }
                //weight
                Aggregation weight = aggregations.get("weight");
                List<? extends Terms.Bucket> weightBuckets = ((ParsedTerms) weight).getBuckets();
                for (int i = 0; i < weightBuckets.size(); i++) {
                    Terms.Bucket bucket = weightBuckets.get(i);

                    String key = bucket.getKey().toString();
                    if ("未知".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("wt_list").add(array);
                }
                //singleDrug
                Aggregation singleDrug = aggregations.get("singleDrug");
                List<? extends Terms.Bucket> singleDrugBuckets = ((ParsedTerms) singleDrug).getBuckets();
                for (int i = 0; i < singleDrugBuckets.size(); i++) {
                    Terms.Bucket bucket = singleDrugBuckets.get(i);
                    JSONArray array = new JSONArray();
                    array.add(i);
                    String key = bucket.getKey().toString();
                    if ("1".equals(key)) {
                        array.add("联合用药");
                    } else {
                        array.add("单药");
                    }
                    //array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("drug_num_list").add(array);
                }

                //dur
                Aggregation dur = aggregations.get("dur");
                List<? extends Terms.Bucket> durBuckets = ((ParsedTerms) dur).getBuckets();
                for (int i = 0; i < durBuckets.size(); i++) {
                    Terms.Bucket bucket = durBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("unknown".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("dur_list").add(array);
                }
                //reactionOfTime
                Aggregation reactionOfTime = aggregations.get("reactionOfTime");
                List<? extends Terms.Bucket> reactionOfTimeBuckets = ((ParsedTerms) reactionOfTime).getBuckets();
                for (int i = 0; i < reactionOfTimeBuckets.size(); i++) {
                    Terms.Bucket bucket = reactionOfTimeBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("unknown".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("cut_dt_list").add(array);
                }
                //indicationPt

                //dechal
                Aggregation dechal = caseAggregations.get("dechal");
                ArrayList<String> strings1 = new ArrayList<>();
                strings1.add("未知");
                strings1.add("不适用");
                strings1.add("去激发阳性（减轻、消失）");
                strings1.add("去激发阴性（未消失或减轻）");
                List<? extends Terms.Bucket> dechalBuckets = ((ParsedTerms) dechal).getBuckets();
                for (int i = 0; i < dechalBuckets.size(); i++) {
                    Terms.Bucket bucket = dechalBuckets.get(i);
                    JSONArray array = new JSONArray();
                    array.add(i);
                    String key = bucket.getKey().toString();
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    for (int j = 0; j < strings1.size(); j++) {
                        if (strings1.get(j).equals(key)) {
                            strings1.remove(j);
                        }
                    }
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("dechal").add(array);
                }
                for (String string : strings1) {
                    JSONArray array = new JSONArray();
                    array.add(0);
                    array.add(string);
                    array.add(0);
                    array.add(0);
                    result.getJSONArray("dechal").add(array);
                }
                //rechal
                Aggregation rechal = caseAggregations.get("rechal");
                ArrayList<String> strings = new ArrayList<>();
                strings.add("未知");
                strings.add("不适用");
                strings.add("去激发阳性（减轻、消失）");
                strings.add("去激发阴性（未消失或减轻）");
                List<? extends Terms.Bucket> rechalBuckets = ((ParsedTerms) rechal).getBuckets();
                for (int i = 0; i < rechalBuckets.size(); i++) {
                    Terms.Bucket bucket = rechalBuckets.get(i);
                    JSONArray array = new JSONArray();
                    array.add(i);
                    String key = bucket.getKey().toString();
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    for (int j = 0; j < strings.size(); j++) {
                        if (strings.get(j).equals(key)) {
                            strings.remove(j);
                        }
                    }
                    //计算百分比
                    try {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    } catch (Exception e) {
                        array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("rechal").add(array);
                }
                for (String string : strings) {
                    JSONArray array = new JSONArray();
                    array.add(0);
                    array.add(string);
                    array.add(0);
                    array.add(0);
                    result.getJSONArray("rechal").add(array);
                }
            }
            Aggregation indicationPt = caseAggregations.get("indicationPt");
            List<? extends Terms.Bucket> indicationPtBuckets = ((ParsedTerms) indicationPt).getBuckets();
            // 批量查询 indicationPt 翻译
            List<String> indicationPtKeys = indicationPtBuckets.stream()
                    .map(b -> b.getKey().toString()).filter(k -> !StringUtils.isEmpty(k)).collect(Collectors.toList());
            Map<String, String> indicationPtChMap = mongoTemplate.find(
                    new Query(Criteria.where("pt_en").in(indicationPtKeys)), JSONObject.class, "pt_all_data")
                    .stream().collect(Collectors.toMap(j -> j.getString("pt_en"), j -> j.getString("pt_ch"), (a, b) -> a));
            for (int i = 0; i < indicationPtBuckets.size(); i++) {
                Terms.Bucket bucket = indicationPtBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                if (StringUtils.isEmpty(key)){
                    continue;
                }
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                try {
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                } catch (Exception e) {
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                }
                String ptCh = indicationPtChMap.getOrDefault(key, "");
                if (ptCh.isEmpty() && "unknown".equals(key)) {
                    ptCh = "未知";
                    if ("0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                }
                array.add(ptCh);
                result.getJSONArray("indi_pt_list").add(array);
            }
            //doseForm

            //ptListNum
            ParsedSum ptListNum = aggregations.get("ptListNum");
            double ptTotal = ptListNum.getValue();
            //ptList
            Aggregation ptList = aggregations.get("ptList");
            List<? extends Terms.Bucket> ptListBuckets = ((ParsedTerms) ptList).getBuckets();
            // 批量查询 ptList 翻译
            int ptLimit = Math.min(50, ptListBuckets.size());
            List<String> ptKeys = ptListBuckets.subList(0, ptLimit).stream()
                    .map(b -> b.getKey().toString()).collect(Collectors.toList());
            Map<String, String> ptChMap = mongoTemplate.find(
                    new Query(Criteria.where("pt_en").in(ptKeys)), JSONObject.class, "pt_all_data")
                    .stream().collect(Collectors.toMap(j -> j.getString("pt_en"), j -> j.getString("pt_ch"), (a, b) -> a));
            for (int i = 0; i < ptLimit; i++) {
                Terms.Bucket bucket = ptListBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                try {
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(ptTotal), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                } catch (Exception e) {
                    array.add("0%");
                }
                String ptCh = ptChMap.getOrDefault(key, "");
                if (ptCh.isEmpty() && "unknown".equals(key)) {
                    ptCh = "未知";
                    if ("0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                }
                array.add(ptCh);
                result.getJSONArray("pt_list").add(array);
            }

            result.put("ptNum",ptListBuckets.size());
            //outcomeCodNum 严重不良反应总数
            long sumNum = 0;
            long sumNoNum = 0;
            Aggregation outcomeCodNum = aggregations.get("outcomeCodNum");
            List<? extends Terms.Bucket> outcomeCodNumBuckets = ((ParsedTerms) outcomeCodNum).getBuckets();
            for (Terms.Bucket bucket : outcomeCodNumBuckets) {
                String key = bucket.getKey().toString();
                long docCount = bucket.getDocCount();
                if ("未报告结局指标".equals(key)) {
                    sumNoNum = docCount;
                } else {
                    sumNum += docCount;
                }
            }
            //outcomeCod 严重不良反应
            Aggregation outcomeCod = aggregations.get("outcomeCod");
            List<? extends Terms.Bucket> outcomeCodBuckets = ((ParsedTerms) outcomeCod).getBuckets();


            for (int i = 0; i < outcomeCodBuckets.size(); i++) {
                Terms.Bucket bucket = outcomeCodBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                if ("未报告结局指标".equals(key)) {
                    sumNoNum = bucket.getDocCount();
                    continue;
                }
                array.add(key);
                long docCount = bucket.getDocCount();
                //sumNum += docCount;
                array.add(docCount);
                //计算百分比
                try {
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(sumNum), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                } catch (Exception e) {
                    array.add("0%");
                }
                result.getJSONArray("outc_cod_list").add(array);
            }
            result.getJSONObject("outc_cod_count").put("yes", sumNum - sumNoNum);
            result.getJSONObject("outc_cod_count").put("no", sumNoNum);
            //不良反应信号分析
//            Boolean outcome = calculateTypicalSignals.getBoolean("outcome");
            JSONObject signalDict = result.getJSONObject("signal_dict");
            signalDict.put("outcome", StringUtils.isNotBlank(safeInfoDto.getUserADRS()));
            //安全性分析提供总数量



            result.put("total", total.get(0));
            if (!isUnion){
                result.put("psTotal", total.get(1));
            }
            List<String> list = new ArrayList<>();
            if (!StringUtils.isNotBlank(safeInfoDto.getUserADRS())) {
//                JSONArray data = calculateTypicalSignals.getJSONArray("data");
                try {
                    String[] split = safeInfoDto.getUserDrugNames().split("\\|\\|");
                    String[] split1 = split[0].split("&&");
                    list = Arrays.stream(split1).collect(Collectors.toList());
                } catch (NullPointerException e) {
                        list.addAll(drugName);

                }

                List<Adrs> adrs = getAdrs(list);
                JSONObject inner = new JSONObject();
                JSONObject innerOld = new JSONObject();
                JSONObject inner2 = new JSONObject();
                JSONObject inner3 = new JSONObject();
                JSONObject inner4 = new JSONObject();
                final Condition conditionF = condition;
                final SafeInfoDto safeInfoDtoF = safeInfoDto;
                final List<String> drugNameF = drugName;
                final boolean isInfoF = isInfo;
                final boolean isUnionF = isUnion;
                CompletableFuture<List<SignalBean>> f0 = CompletableFuture.supplyAsync(() -> getSignalBeans(conditionF, safeInfoDtoF, drugNameF, isInfoF, isUnionF, 0));
                CompletableFuture<List<SignalBean>> f1 = CompletableFuture.supplyAsync(() -> getSignalBeans(conditionF, safeInfoDtoF, drugNameF, isInfoF, isUnionF, 1));
                CompletableFuture<List<SignalBean>> f2 = CompletableFuture.supplyAsync(() -> getSignalBeans(conditionF, safeInfoDtoF, drugNameF, isInfoF, isUnionF, 2));
                CompletableFuture<List<SignalBean>> f3 = CompletableFuture.supplyAsync(() -> getSignalBeans(conditionF, safeInfoDtoF, drugNameF, isInfoF, isUnionF, 3));
                List<SignalBean> adrsList = f0.join();
                List<SignalBean> adrsListic = f1.join();
                List<SignalBean> adrsListgps = f2.join();
                List<SignalBean> adrsListnum = f3.join();
                for (int i = 0; (i<50)&&(i < adrsList.size()); i++) {
                    SignalBean bean = adrsList.get(i);
                    try {
                        String en = bean.getPt();
                        Long num = bean.getNum();
                        String pct = totalHits == 0 ? "0%" :
                                BigDecimal.valueOf(num).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%";
                        String ror = bean.getRor().toString();
                        if (StringUtils.isNotEmpty(ror) && ror.contains(".")) ror = ror.substring(0, ror.indexOf(".") + 3);
                        String ebgm = bean.getGps().toString();
                        if (StringUtils.isNotEmpty(ebgm) && ebgm.contains(".")) ebgm = ebgm.substring(0, ebgm.indexOf(".") + 3);
                        String ic = bean.getIc().toString();
                        if (StringUtils.isNotEmpty(ic) && ic.contains(".")) ic = ic.substring(0, ic.indexOf(".") + 3);
                        String zh = bean.getZh();
                        String soc = bean.getSoc();

                        // inner: en,num,pct,ror,ebgm,ic,rorLift,rorRight,icLift,icRight,zh
                        JSONArray arr1 = new JSONArray();
                        arr1.add(en); arr1.add(num); arr1.add(pct); arr1.add(ror); arr1.add(ebgm); arr1.add(ic);
                        arr1.add(bean.getRorLift()); arr1.add(bean.getRorRight()); arr1.add(bean.getIcLift()); arr1.add(bean.getIcRight());
                        arr1.add(zh);
                        if (!inner.containsKey(soc)) inner.put(soc, new JSONArray());
                        inner.getJSONArray(soc).add(arr1);

                        // innerOld: en,num,pct,ror,ebgm,ic,zh,rorLift,rorRight,icLift,icRight
                        JSONArray arr2 = new JSONArray();
                        arr2.add(en); arr2.add(num); arr2.add(pct); arr2.add(ror); arr2.add(ebgm); arr2.add(ic);
                        arr2.add(zh);
                        arr2.add(bean.getRorLift()); arr2.add(bean.getRorRight()); arr2.add(bean.getIcLift()); arr2.add(bean.getIcRight());
                        if (!innerOld.containsKey(soc)) innerOld.put(soc, new JSONArray());
                        innerOld.getJSONArray(soc).add(arr2);
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                }

                for (int i = 0; (i<50)&&(i < adrsListic.size()); i++) {
                    JSONArray array = new JSONArray();
                    try {

                        String en = adrsListic.get(i).getPt();
                        array.add(en);
                        Long num = adrsListic.get(i).getNum();
                        array.add(num);
                        if (totalHits == 0) {
                            array.add("0%"); // 当总次数为零时，添加默认值到数组中
                        } else {
                            array.add(BigDecimal.valueOf(num).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                        }
                        String ror = adrsListic.get(i).getRor().toString();
                        if (StringUtils.isNotEmpty(ror) && ror.contains(".")) {
                            ror = ror.substring(0, ror.indexOf(".") + 3);
                        }
                        array.add(ror);

                        String ebgm = adrsListic.get(i).getGps().toString();
                        if (StringUtils.isNotEmpty(ebgm) && ebgm.contains(".")) {
                            ebgm = ebgm.substring(0, ebgm.indexOf(".") + 3);
                        }
                        array.add(ebgm);
                        String ic = adrsListic.get(i).getIc().toString();

                        if (StringUtils.isNotEmpty(ic) && ic.contains(".")) {
                            ic = ic.substring(0, ic.indexOf(".") + 3);
                        }
                        array.add(ic);
                        array.add(adrsList.get(i).getRorLift());
                        array.add(adrsList.get(i).getRorRight());
                        array.add(adrsList.get(i).getIcLift());
                        array.add(adrsList.get(i).getIcRight());
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                    String zh = adrsListic.get(i).getZh();
                    array.add(zh);
                    String soc = adrsListic.get(i).getSoc();
                    if (!inner2.containsKey(soc)) {
                        inner2.put(soc, new JSONArray());
                    }
                    inner2.getJSONArray(soc).add(array);
                }


                for (int i = 0; (i<50)&&(i < adrsListgps.size()); i++) {
                    JSONArray array = new JSONArray();
                    try {

                        String en = adrsListgps.get(i).getPt();
                        array.add(en);
                        Long num = adrsListgps.get(i).getNum();
                        array.add(num);
                        if (totalHits == 0) {
                            array.add("0%"); // 当总次数为零时，添加默认值到数组中
                        } else {
                            array.add(BigDecimal.valueOf(num).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                        }
                        String ror = adrsListgps.get(i).getRor().toString();
                        if (StringUtils.isNotEmpty(ror) && ror.contains(".")) {
                            ror = ror.substring(0, ror.indexOf(".") + 3);
                        }
                        array.add(ror);

                        String ebgm =   adrsListgps.get(i).getGps().toString();
                        if (StringUtils.isNotEmpty(ebgm) && ebgm.contains(".")) {
                            ebgm = ebgm.substring(0, ebgm.indexOf(".") + 3);
                        }
                        array.add(ebgm);
                        String ic = adrsListgps.get(i).getIc().toString();

                        if (StringUtils.isNotEmpty(ic) && ic.contains(".")) {
                            ic = ic.substring(0, ic.indexOf(".") + 3);
                        }
                        array.add(ic);
                        array.add(adrsList.get(i).getRorLift());
                        array.add(adrsList.get(i).getRorRight());
                        array.add(adrsList.get(i).getIcLift());
                        array.add(adrsList.get(i).getIcRight());
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                    String zh = adrsListgps.get(i).getZh();
                    array.add(zh);
                    String soc = adrsListgps.get(i).getSoc();
                    if (!inner3.containsKey(soc)) {
                        inner3.put(soc, new JSONArray());
                    }
                    inner3.getJSONArray(soc).add(array);
                }

                for (int i = 0; (i<50)&&(i < adrsListnum.size()); i++) {
                    JSONArray array = new JSONArray();
                    try {

                        String en = adrsListnum.get(i).getPt();
                        array.add(en);
                        Long num = adrsListnum.get(i).getNum();
                        array.add(num);
                        if (totalHits == 0) {
                            array.add("0%"); // 当总次数为零时，添加默认值到数组中
                        } else {
                            array.add(BigDecimal.valueOf(num).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                        }
                        String ror = adrsListnum.get(i).getRor().toString();
                        if (StringUtils.isNotEmpty(ror) && ror.contains(".")) {
                            ror = ror.substring(0, ror.indexOf(".") + 3);
                        }
                        array.add(ror);

                        String ebgm = adrsListnum.get(i).getGps().toString();
                        if (StringUtils.isNotEmpty(ebgm) && ebgm.contains(".")) {
                            ebgm = ebgm.substring(0, ebgm.indexOf(".") + 3);
                        }
                        array.add(ebgm);
                        String ic = adrsListnum.get(i).getIc().toString();

                        if (StringUtils.isNotEmpty(ic) && ic.contains(".")) {
                            ic = ic.substring(0, ic.indexOf(".") + 3);
                        }
                        array.add(ic);
                        array.add(adrsList.get(i).getRorLift());
                        array.add(adrsList.get(i).getRorRight());
                        array.add(adrsList.get(i).getIcLift());
                        array.add(adrsList.get(i).getIcRight());
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                    String zh = adrsListnum.get(i).getZh();
                    array.add(zh);
                    String soc = adrsListnum.get(i).getSoc();
                    if (!inner4.containsKey(soc)) {
                        inner4.put(soc, new JSONArray());
                    }
                    inner4.getJSONArray(soc).add(array);
                }


                result.put("dataTotal", adrsList.size());
                signalDict.put("data1", inner);
                signalDict.put("data", innerOld);
                signalDict.put("data2", inner2);
                signalDict.put("data3", inner3);
                signalDict.put("data4", inner4);
            } else {
                //用户输入不良反应
//                JSONArray illustrate = calculateTypicalSignals.getJSONArray("illustrate");
                JSONArray illustrate = new JSONArray();
                signalDict.put("data", illustrate);
            }
        }
        log.info("药品安全性分析计算完成，用时[{}]", System.currentTimeMillis() - start);
        //缓存
        RedisUtil.redis.opsForValue().set(cacheKey, result, 60 * 60 * 24, TimeUnit.SECONDS);
        return result;
    }

    @Override
    @Retryable(
            value = {java.net.SocketTimeoutException.class,
                     org.springframework.dao.DataAccessResourceFailureException.class,
                     java.util.concurrent.CompletionException.class},
            maxAttempts = 2,
            backoff = @Backoff(delay = 3000, multiplier = 1.0)
    )
    public JSONObject drugSafeInfoJd(SafeInfoDto safeInfoDto) {
        String cacheKeyJd = "safeInfoJd:" + safeInfoDto.hashCode();
        Object o = RedisUtil.redis.opsForValue().get(cacheKeyJd);
        log.info("外部调用入参{}", safeInfoDto.toString());
        if (ObjectUtils.isNotEmpty(o)) {
            return JSONObject.parseObject(o.toString());
        }

        long start = System.currentTimeMillis();
        JSONObject result = new JSONObject();
        Condition condition = new Condition();
        boolean isADRs = false;
        List<String> drugName = new ArrayList<>();
        boolean isInfo = false;
//        if (StringUtils.isEmpty(safeInfoDto.getUserDrugNames())){
//            safeInfoDto.setUserDrugNames(conditionx.getDrugs().get(0).getEnWord());
//        }
        //是否是联合用药
        Boolean isUnion = false;

//        if (StringUtils.isNotEmpty(safeInfoDto.getUserDrugNames())) {
            //根据外来数据开始构建检索条件
            //药品
            isInfo = true;
            List<Drug> drugs = new ArrayList<>();
            String userDrugNames = safeInfoDto.getUserDrugNames();
            String[] split = userDrugNames.split("\\|\\|");
            for (int i = 0; i < split.length; i++) {
                Drug drug = new Drug();
                drug.setStatus(1);
            /*if (i % 2 == 0) {
                drug.setStatus(1);
            } else {
                drug.setStatus(2);
            }*/
                String s = split[i];
                String[] strings = s.split("&&");
                ArrayList<String> drugNameAlias = new ArrayList<>();
                for (int i1 = 0; i1 < strings.length; i1++) {
                    if (i1 == 0) {
                        drug.setWord(strings[i1]);
                        drugName.add(strings[i1].toLowerCase());
                    } else {
                        drugName.add(strings[i1].toLowerCase());
                        drugNameAlias.add(strings[i1].toLowerCase());
                    }
                }
                drug.setDrugNameAlias(drugNameAlias);
                if (i > 0) {
                    Drug inner = new Drug();
                    inner.setStatus(2);
                    drugs.add(inner);
                }
                drugs.add(drug);
            }
            condition.setDrugs(drugs);
            //疾病（适应症）
            String userIndications = safeInfoDto.getUserIndications();
            if (StringUtils.isNotBlank(userIndications)) {
                List<Disease> diseases = new ArrayList<>();
                String[] splitIndications = userIndications.split("\\|\\|");
                for (int i = 0; i < splitIndications.length; i++) {
                    Disease disease = new Disease();
                    if (i % 2 == 0) {
                        disease.setStatus(1);
                    } else {
                        disease.setStatus(2);
                    }
                    String s = splitIndications[i];
                    String[] strings = s.split("&&");
                    List<WordStatus> zhSynonym = new ArrayList<>();
                    for (int i1 = 0; i1 < strings.length; i1++) {
                        if (i1 == 0) {
                            disease.setWord(strings[i1]);
                        } else {
                            WordStatus wordStatus = new WordStatus(strings[i1], true);
                            zhSynonym.add(wordStatus);
                        }
                    }
                    disease.setZhSynonym(zhSynonym);
                    diseases.add(disease);
                }
                condition.setDiseases(diseases);
            }
            //不良反应列表
            String userADRS = safeInfoDto.getUserADRS();
            if (StringUtils.isNotBlank(userADRS)) {
                isADRs = true;
                List<InterventionAndOutcome> outcomes = new ArrayList<>();
                String[] splitOutcome = userADRS.split("\\|\\|");
                for (int i = 0; i < splitOutcome.length; i++) {
                    InterventionAndOutcome outcome = new InterventionAndOutcome();
                    if (i % 2 == 0) {
                        outcome.setStatus(1);
                    } else {
                        outcome.setStatus(2);
                    }
                    String s = splitOutcome[i];
                    String[] strings = s.split("&&");
                    List<WordStatus> zhSynonym = new ArrayList<>();
                    for (int i1 = 0; i1 < strings.length; i1++) {
                        if (i1 == 0) {
                            outcome.setWord(strings[i1]);
                        } else {
                            WordStatus wordStatus = new WordStatus(strings[i1], true);
                            zhSynonym.add(wordStatus);
                        }
                    }
                    outcome.setZhSynonym(zhSynonym);
                    outcomes.add(outcome);
                }
                condition.setOutcomes(outcomes);
            }

//        } else {
//            List<Drug> drugs = conditionx.getDrugs();
//            ArrayList<Drug> drugs1 = new ArrayList<>();
//            for (int i = 0; i < drugs.size(); i++) {
//                if (StringUtils.isNotEmpty(drugs.get(i).getWord())){
//                    Drug drug = new Drug();
//                    drug.setStatus(1);
//            /*if (i % 2 == 0) {
//                drug.setStatus(1);
//            } else {
//                drug.setStatus(2);
//            }*/
//                    ArrayList<String> drugNameAlias = new ArrayList<>();
//
//                    if (StringUtils.isNotEmpty(drugs.get(i).getEnWord())) {
//                        drugNameAlias.add(drugs.get(i).getEnWord().toLowerCase());
//                        drugName.add(drugs.get(i).getEnWord().toLowerCase());
//                        if (drugs.get(i).getEnWord().contains(",") || drugs.get(i).getEnWord().contains(";")) {
//                            String[] split = drugs.get(i).getEnWord().split("(,|;)");
//                            for (int i1 = 0; i1 < split.length; i1++) {
//                                drugNameAlias.add(split[i1].toLowerCase());
//                                drugName.add(split[i1].toLowerCase());
//                            }
//                        }
//                    }
//                    if (StringUtils.isNotEmpty(drugs.get(i).getWord())){
//                        drugName.add(drugs.get(i).getWord().toLowerCase());
//                        drugNameAlias.add(drugs.get(i).getWord().toLowerCase());
//                        String lowerCase = retrievalService.innerSynonym(drugs.get(i).getWord()).toLowerCase();
//                        if (StringUtils.isNotBlank(lowerCase)){
//                            drug.setWord(lowerCase);
//                            drugName.add(lowerCase);
//                        }else {
//                            drug.setWord(drugs.get(i).getWord());
//                        }
//
//                    }
//
//                    drug.setDrugNameAlias(drugNameAlias);
//                    if (i > 0) {
//                        Drug inner = new Drug();
//                        inner.setStatus(2);
//                        drugs1.add(inner);
//                        isUnion = true;
//                    }
//
//                    drugs1.add(drug);
//                }}
//            condition.setDrugs(drugs1);
//        }

        int typeDrug = 2;
        String drugNamesAccurate = safeInfoDto.getDrugNamesAccurate();
        if ("true".equals(drugNamesAccurate)) {
            typeDrug = 2;
        }
        int typeOutcome = 1;
        String adrsAccurate = safeInfoDto.getADRSAccurate();
        if ("true".equals(adrsAccurate)) {
            typeOutcome = 2;
        }
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, isADRs);
        Condition condition1 = new Condition();
        condition1.setDrugs(condition.getDrugs());
        BoolQueryBuilder adverseQuery1 = QueryUtils.createAdverseQuery(condition1, typeDrug, typeOutcome, false);
        condition1.setOutcomes(condition.getOutcomes());
        BoolQueryBuilder adverseQuery2 = QueryUtils.createAdverseQuery(condition1, typeDrug, typeOutcome, isADRs);
        BoolQueryBuilder adverseCaseQuery = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, isADRs);

        BoolQueryBuilder boolQueryBuilder4 = new BoolQueryBuilder();
        //时间
        if (StringUtils.isNotBlank(safeInfoDto.getBeginDate())) {
            adverseQuery.must().add(QueryBuilders.rangeQuery("date").gte(safeInfoDto.getBeginDate().substring(0,4)));
            adverseCaseQuery.must().add(QueryBuilders.rangeQuery("date").gte(safeInfoDto.getBeginDate().substring(0,4)));
            adverseQuery1.must().add(QueryBuilders.rangeQuery("date").gte(safeInfoDto.getBeginDate().substring(0,4)));
            adverseQuery2.must().add(QueryBuilders.rangeQuery("date").gte(safeInfoDto.getBeginDate().substring(0,4)));
            boolQueryBuilder4.must().add(QueryBuilders.rangeQuery("date").gte(safeInfoDto.getBeginDate().substring(0,4)));
        }
        if (StringUtils.isNotBlank(safeInfoDto.getEndDate())) {
            adverseQuery.must().add(QueryBuilders.rangeQuery("date").lte(safeInfoDto.getEndDate().substring(0,4)));
            adverseCaseQuery.must().add(QueryBuilders.rangeQuery("date").lte(safeInfoDto.getEndDate().substring(0,4)));
            adverseQuery1.must().add(QueryBuilders.rangeQuery("date").lte(safeInfoDto.getEndDate().substring(0,4)));
            adverseQuery2.must().add(QueryBuilders.rangeQuery("date").lte(safeInfoDto.getEndDate().substring(0,4)));
            boolQueryBuilder4.must().add(QueryBuilders.rangeQuery("date").lte(safeInfoDto.getEndDate().substring(0,4)));
        }

        NativeSearchQuery nativeSearchQuery1 = new NativeSearchQuery(boolQueryBuilder4);
        long count = elasticsearchRestTemplate.count(nativeSearchQuery1, AdverseIndexJd.class);

        result.put("adeTotle", count);
        List<String> total = getTotalJd(adverseQuery2, drugName,adverseQuery1);
        result.put("titleCount", total);
        //药品在报告中的作用
        String roleCode = safeInfoDto.getRoleCode();
        if (isInfo && !"-1".equals(roleCode)) {
            List<String> realRole = new ArrayList<>();
            String[] split1 = roleCode.split(",");
            for (String s : split1) {
                realRole.add(s);
            }

            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
            for (String s : drugName) {
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
            }
            boolQueryBuilder.must().add(QueryBuilders.termsQuery("roleCods.role", realRole));
            boolQueryBuilder.must().add(boolQueryBuilder2);
            NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
            adverseQuery.must().add(boolQueryBuilder1);
            BoolQueryBuilder boolQueryBuilder3 = QueryBuilders.boolQuery();
            for (String s : realRole) {
                boolQueryBuilder3.should().add(QueryBuilders.matchQuery("roleCod", s));
            }
            adverseCaseQuery.must().add(boolQueryBuilder3);
        }else if(!isInfo && !isUnion){
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
            for (String s : drugName) {
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
            }
            boolQueryBuilder.must().add(QueryBuilders.termQuery("roleCods.role", "PS"));
            boolQueryBuilder.must().add(boolQueryBuilder2);
            NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
            adverseQuery.must().add(boolQueryBuilder1);
            BoolQueryBuilder boolQueryBuilder3 = QueryBuilders.boolQuery();
            boolQueryBuilder3.should().add(QueryBuilders.matchQuery("roleCod", "PS"));
            adverseCaseQuery.must().add(boolQueryBuilder3);
        }

        //严重不良反应结局
        String outcCode = safeInfoDto.getOutcCode();
        if (isInfo && !"-1".equals(outcCode)) {
            List<String> realOutcomeCode = new ArrayList<>();
            String[] split1 = outcCode.split(",");
            for (String s : split1) {
                realOutcomeCode.add(s);
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("outcomeCod", realOutcomeCode));
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("outcomeCod", realOutcomeCode));
        }
        //报告者职业
        String occpCode = safeInfoDto.getOccpCode();
        if (isInfo && !"-1".equals(occpCode)) {
            List<String> realOccupationalCod = new ArrayList<>();
            String[] split1 = occpCode.split(",");
            for (String s : split1) {
                realOccupationalCod.add(s);
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("occupationalCod", realOccupationalCod));
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("occupationalCod", realOccupationalCod));
        }
        //患者性别
        String sex = safeInfoDto.getSex();
        if (isInfo && !"-1".equals(sex)) {
            List<String> realSex = new ArrayList<>();
            String[] split1 = sex.split(",");
            for (String s : split1) {
                realSex.add(s);
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("sex", realSex));
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("sex", realSex));
        }
        //患者年龄
        String age = safeInfoDto.getAge();
        if (isInfo && !"-1".equals(age)) {
            List<String> realAge = new ArrayList<>();
            String[] split1 = age.split(",");
            for (String s : split1) {
                realAge.add(s);
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("age", realAge));
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("age", realAge));
        }


        //开始计算相关数据
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        //case
        NativeSearchQuery caseNativeSearchQuery = new NativeSearchQuery(adverseCaseQuery);
        caseNativeSearchQuery.setTrackTotalHits(true);
        caseNativeSearchQuery.setPageable(PageRequest.of(0, 1));
        if (isInfo){
            //year_list 年份分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("year").field("year").size(30));
            result.put("year_list", new JSONArray());
            //reporter_country_list 地区分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("reporterCountry").field("reporterCountry").size(30));
            result.put("reporter_country_list", new JSONArray());
            //occp_cod 职业分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("occupationalCod").field("occupationalCod").size(30));
            result.put("occp_cod", new JSONArray());
            //sex_m_f 性别分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("sex").field("sex").size(30));
            result.put("sex_m_f", new JSONArray());
            //age_list 年龄分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("age").field("age").size(30));
            result.put("age_list", new JSONArray());
            //wt_list 体重分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("weight").field("weight").size(30));
            result.put("wt_list", new JSONArray());
            //drug_num_list 给药方案
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("singleDrug").field("singleDrug").size(30));
            result.put("drug_num_list", new JSONArray());
            //dose_form_list 剂型分布
            caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("doseForm").field("doseForm").size(30));
            result.put("dose_form_list", new JSONArray());
            //route_list 给药途径分布
            caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("route").field("route").size(30));
            result.put("route_list", new JSONArray());
            //dose_amt_list 计量分布
            caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("doseAmtCombine").field("doseAmtCombine").size(30));
            result.put("dose_amt_list", new JSONArray());
            //dur_list 治疗持续时间分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("dur").field("dur").size(30));
            result.put("dur_list", new JSONArray());
            //cut_dt_list 不良反应发生时间分布
            nativeSearchQuery.addAggregation(AggregationBuilders.terms("reactionOfTime").field("reactionOfTime").size(30));
            result.put("cut_dt_list", new JSONArray());


            nativeSearchQuery.addAggregation(AggregationBuilders.terms("reportType").field("reportType").size(4));
            result.put("reportType", new JSONArray());

        }


        //indi_pt_list 适应症分布
        caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("indicationPt").field("indicationPt.keyword").size(30));
        result.put("indi_pt_list", new JSONArray());
        //pt_list 不良反应分布
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("ptList").field("ptList.keyword").size(100000));
        //聚合计算ptList的总数
        nativeSearchQuery.addAggregation(AggregationBuilders.sum("ptListNum").field("ptListNum"));
        result.put("pt_list", new JSONArray());
        //signal_dict 不良反应信号分析
//        JSONObject calculateTypicalSignals = calculateTypicalSignalsForSafe(condition, adverseQuery);
        result.put("signal_dict", new JSONObject());
        //outc_cod_num 不良反应总数
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("outcomeCodNum").field("outcomeCodNum"));
        result.put("outc_cod_count", new JSONObject());
        //outc_cod_list 严重不良反应
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("outcomeCod").field("outcomeCod").size(30));
        result.put("outc_cod_list", new JSONArray());

        caseNativeSearchQuery.addAggregation(AggregationBuilders.terms("disposeOf").field("disposeOf").size(30));
        result.put("disposeOf", new JSONArray());

        CompletableFuture<SearchHits<AdverseIndexJd>> searchFutureJd = CompletableFuture.supplyAsync(
                () -> elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndexJd.class));
        CompletableFuture<SearchHits<AdverseForCaseIndexJd>> caseSearchFutureJd = CompletableFuture.supplyAsync(
                () -> elasticsearchRestTemplate.search(caseNativeSearchQuery, AdverseForCaseIndexJd.class));
        SearchHits<AdverseIndexJd> search = searchFutureJd.join();
        long totalHits = search.getTotalHits();
        SearchHits<AdverseForCaseIndexJd> caseSearch = caseSearchFutureJd.join();


        if (totalHits == 0){
           return result;
        }
        long caseTotalHits = caseSearch.getTotalHits();
        Aggregations caseAggregations = caseSearch.getAggregations();
        Aggregations aggregations = search.getAggregations();
        if (caseAggregations != null&& aggregations != null) {
            if (isInfo){
                Aggregation doseForm = caseAggregations.get("doseForm");
                List<? extends Terms.Bucket> doseFormBuckets = ((ParsedTerms) doseForm).getBuckets();
                for (int i = 0; i < doseFormBuckets.size(); i++) {
                    Terms.Bucket bucket = doseFormBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("unknown".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("dose_form_list").add(array);
                }
                //route
                Aggregation route = caseAggregations.get("route");
                List<? extends Terms.Bucket> routeBuckets = ((ParsedTerms) route).getBuckets();
                // 批量查询route翻译
                List<String> routeKeys = routeBuckets.stream().map(b -> b.getKey().toString()).collect(Collectors.toList());
                Map<String, String> routeChMap = mongoTemplate.find(
                        new Query(Criteria.where("route_en").in(routeKeys)), JSONObject.class, "route_translate")
                        .stream().collect(Collectors.toMap(j -> j.getString("route_en"), j -> j.getString("route_ch"), (a, b) -> a));
                for (int i = 0; i < routeBuckets.size(); i++) {
                    Terms.Bucket bucket = routeBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("unknown".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    String routeCh = routeChMap.getOrDefault(key, "unknown".equals(key) ? "未知" : "");
                    array.add(routeCh);
                    result.getJSONArray("route_list").add(array);
                }
                //doseAmtCombine
                Aggregation doseAmtCombine = caseAggregations.get("doseAmtCombine");
                List<? extends Terms.Bucket> doseAmtCombineBuckets = ((ParsedTerms) doseAmtCombine).getBuckets();
                for (int i = 0; i < doseAmtCombineBuckets.size(); i++) {
                    Terms.Bucket bucket = doseAmtCombineBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("unknown".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("dose_amt_list").add(array);
                }

                //year
                Aggregation year = aggregations.get("year");
                List<? extends Terms.Bucket> yearBuckets = ((ParsedTerms) year).getBuckets();
                for (int i = 0; i < yearBuckets.size(); i++) {
                    Terms.Bucket bucket = yearBuckets.get(i);
                    JSONArray array = new JSONArray();
                    array.add(i);
                    String key = bucket.getKey().toString();
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("year_list").add(array);
                }
                //reporterCountry
                Aggregation reporterCountry = aggregations.get("reporterCountry");
                List<? extends Terms.Bucket> reporterCountryBuckets = ((ParsedTerms) reporterCountry).getBuckets();
                for (int i = 0; i < reporterCountryBuckets.size(); i++) {
                    Terms.Bucket bucket = reporterCountryBuckets.get(i);
                    JSONArray array = new JSONArray();
                    String key = bucket.getKey().toString();
                    if ("未知".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("reporter_country_list").add(array);
                }
                //occupationalCod
                Aggregation occupationalCod = aggregations.get("occupationalCod");
                List<? extends Terms.Bucket> occupationalCodBuckets = ((ParsedTerms) occupationalCod).getBuckets();
                for (int i = 0; i < occupationalCodBuckets.size(); i++) {
                    Terms.Bucket bucket = occupationalCodBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("未知".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("occp_cod").add(array);
                }
                //
                Aggregation reportType = aggregations.get("reportType");
                List<? extends Terms.Bucket> reportTypeCodBuckets = ((ParsedTerms) reportType).getBuckets();
                for (int i = 0; i < reportTypeCodBuckets.size(); i++) {
                    Terms.Bucket bucket = reportTypeCodBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if (("未知".equals(key)||StringUtils.isEmpty(key)) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("reportType").add(array);
                }


                //sex
                Aggregation sexList = aggregations.get("sex");
                Map<String, Long> sexMap = new HashMap<>();
                List<? extends Terms.Bucket> sexCodBuckets = ((ParsedTerms) sexList).getBuckets();
                for (Terms.Bucket bucket : sexCodBuckets) {
                    String key = bucket.getKey().toString();
                    if ("男性".equals(key)){
                        key = "男";
                    }else if("女性".equals(key)){
                        key = "女";
                    }
                    if (!"男".equals(key) && !"女".equals(key)) {
                        key = "未知";
                        if ("0".equals(safeInfoDto.getIsShowUnknown())) {
                            continue;
                        }
                    }
                    long docCount = bucket.getDocCount();
                    if (sexMap.containsKey(key)) {
                        sexMap.put(key, sexMap.get(key) + docCount);
                    } else {
                        sexMap.put(key, docCount);
                    }
                }
                if (sexMap.size() > 0) {
                    //男
                    Long manLong = sexMap.get("男");
                    if (manLong == null) {
                        manLong = 0L;
                    }
                    JSONArray manArray = new JSONArray();
                    manArray.add(0);
                    manArray.add("男");
                    manArray.add(manLong);
                    if (totalHits == 0) {
                        manArray.add(0 + "%");
                    } else {
                        manArray.add(BigDecimal.valueOf(manLong).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("sex_m_f").add(manArray);
                    //女
                    Long womanLong = sexMap.get("女");
                    if (womanLong == null) {
                        womanLong = 0L;
                    }
                    JSONArray womanArray = new JSONArray();
                    womanArray.add(1);
                    womanArray.add("女");
                    womanArray.add(womanLong);
                    if (totalHits == 0) {
                        manArray.add(0 + "%");
                    } else {
                        womanArray.add(BigDecimal.valueOf(womanLong).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    result.getJSONArray("sex_m_f").add(womanArray);
                    //未知
                    Long unknownLong = sexMap.get("未知");
                    if (unknownLong == null) {
                        unknownLong = 0L;
                    }
                    JSONArray unknownArray = new JSONArray();
                    unknownArray.add(2);
                    unknownArray.add("未知");
                    unknownArray.add(unknownLong);
                    if (totalHits == 0) {
                        manArray.add(0 + "%");
                    } else {
                        unknownArray.add(BigDecimal.valueOf(unknownLong).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    }
                    if (!"0".equals(safeInfoDto.getIsShowUnknown())) {
                        result.getJSONArray("sex_m_f").add(unknownArray);
                    }

                }
                //age
                Aggregation ageList = aggregations.get("age");
                List<? extends Terms.Bucket> ageBuckets = ((ParsedTerms) ageList).getBuckets();
                for (int i = 0; i < ageBuckets.size(); i++) {
                    Terms.Bucket bucket = ageBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("未知".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("age_list").add(array);
                }
                //weight
                Aggregation weight = aggregations.get("weight");
                List<? extends Terms.Bucket> weightBuckets = ((ParsedTerms) weight).getBuckets();
                for (int i = 0; i < weightBuckets.size(); i++) {
                    Terms.Bucket bucket = weightBuckets.get(i);

                    String key = bucket.getKey().toString();
                    if ("未知".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("wt_list").add(array);
                }
                //singleDrug
                Aggregation singleDrug = aggregations.get("singleDrug");
                List<? extends Terms.Bucket> singleDrugBuckets = ((ParsedTerms) singleDrug).getBuckets();
                for (int i = 0; i < singleDrugBuckets.size(); i++) {
                    Terms.Bucket bucket = singleDrugBuckets.get(i);
                    JSONArray array = new JSONArray();
                    array.add(i);
                    String key = bucket.getKey().toString();
                    if ("1".equals(key)) {
                        array.add("联合用药");
                    } else {
                        array.add("单药");
                    }
                    //array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("drug_num_list").add(array);
                }

                //dur
                Aggregation dur = aggregations.get("dur");
                List<? extends Terms.Bucket> durBuckets = ((ParsedTerms) dur).getBuckets();
                for (int i = 0; i < durBuckets.size(); i++) {
                    Terms.Bucket bucket = durBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("unknown".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("dur_list").add(array);
                }
                //reactionOfTime
                Aggregation reactionOfTime = aggregations.get("reactionOfTime");
                List<? extends Terms.Bucket> reactionOfTimeBuckets = ((ParsedTerms) reactionOfTime).getBuckets();
                for (int i = 0; i < reactionOfTimeBuckets.size(); i++) {
                    Terms.Bucket bucket = reactionOfTimeBuckets.get(i);
                    String key = bucket.getKey().toString();
                    if ("unknown".equals(key) && "0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                    JSONArray array = new JSONArray();
                    array.add(i);
                    array.add(key);
                    long docCount = bucket.getDocCount();
                    array.add(docCount);
                    //计算百分比
                    array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    result.getJSONArray("cut_dt_list").add(array);
                }
                //indicationPt

                //dechal

            }
            Aggregation indicationPt = caseAggregations.get("indicationPt");
            List<? extends Terms.Bucket> indicationPtBuckets = ((ParsedTerms) indicationPt).getBuckets();
            // 批量查询indicationPt翻译
            List<String> indiPtKeys = indicationPtBuckets.stream().map(b -> b.getKey().toString()).collect(Collectors.toList());
            Map<String, String> indiPtChMap = mongoTemplate.find(
                    new Query(Criteria.where("pt_en").in(indiPtKeys)), JSONObject.class, "pt_all_data")
                    .stream().collect(Collectors.toMap(j -> j.getString("pt_en"), j -> j.getString("pt_ch"), (a, b) -> a));
            for (int i = 0; i < indicationPtBuckets.size(); i++) {
                Terms.Bucket bucket = indicationPtBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                String ptCh = indiPtChMap.getOrDefault(key, "");
                if (ptCh.isEmpty() && "unknown".equals(key)) {
                    ptCh = "未知";
                    if ("0".equals(safeInfoDto.getIsShowUnknown())) {
                        continue;
                    }
                }
                array.add(ptCh);
                result.getJSONArray("indi_pt_list").add(array);
            }
            //doseForm

            //ptListNum
            ParsedSum ptListNum = aggregations.get("ptListNum");
            double ptTotal = ptListNum.getValue();
            //ptList
            Aggregation ptList = aggregations.get("ptList");
            List<? extends Terms.Bucket> ptListBuckets = ((ParsedTerms) ptList).getBuckets();
            // 批量查询ptList翻译
            int ptLimitJd = Math.min(50, ptListBuckets.size());
            List<String> ptKeysJd = ptListBuckets.subList(0, ptLimitJd).stream()
                    .map(b -> b.getKey().toString()).collect(Collectors.toList());
            Map<String, String> ptChMapJd = mongoTemplate.find(
                    new Query(Criteria.where("pt_en").in(ptKeysJd)), JSONObject.class, "pt_dj_data")
                    .stream().collect(Collectors.toMap(j -> j.getString("pt_en"), j -> j.getString("pt_ch"), (a, b) -> a));
            for (int i = 0; i < ptLimitJd; i++) {
                Terms.Bucket bucket = ptListBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(ptTotal), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                String ptCh = ptChMapJd.getOrDefault(key, "");
                if (ptCh.isEmpty()) {
                    if ("unknown".equals(key)) {
                        ptCh = "未知";
                        if ("0".equals(safeInfoDto.getIsShowUnknown())) {
                            continue;
                        }
                    } else {
                        String trans = DeeplApi.trans(key);
                        ptCh = trans;
                        JSONObject jsonObject1 = new JSONObject();
                        jsonObject1.put("pt_en", key);
                        jsonObject1.put("pt_ch", ptCh);
                        ReleaseMongoUtil.mongo.save(jsonObject1, "pt_jd_data");
                    }
                }
                array.add(ptCh);
                result.getJSONArray("pt_list").add(array);
            }

            result.put("ptNum",ptListBuckets.size());
            //outcomeCodNum 严重不良反应总数
            long sumNum = 0;
            long sumNoNum = 0;
            Aggregation outcomeCodNum = aggregations.get("outcomeCodNum");
            List<? extends Terms.Bucket> outcomeCodNumBuckets = ((ParsedTerms) outcomeCodNum).getBuckets();
            for (Terms.Bucket bucket : outcomeCodNumBuckets) {
                String key = bucket.getKey().toString();
                long docCount = bucket.getDocCount();
                if ("未报告结局指标".equals(key)) {
                    sumNoNum = docCount;
                } else {
                    sumNum += docCount;
                }
            }
            //处置
            Aggregation disposeOf = caseAggregations.get("disposeOf");
            List<? extends Terms.Bucket> disposeOfBuckets = ((ParsedTerms) disposeOf).getBuckets();
            for (int i = 0; i < disposeOfBuckets.size(); i++) {
                String key = disposeOfBuckets.get(i).getKey().toString();
                JSONArray array = new JSONArray();
                array.add(i);
                array.add(key);
                long docCount = disposeOfBuckets.get(i).getDocCount();
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                result.getJSONArray("disposeOf").add(array);
            }


            //outcomeCod 严重不良反应
            Aggregation outcomeCod = aggregations.get("outcomeCod");
            List<? extends Terms.Bucket> outcomeCodBuckets = ((ParsedTerms) outcomeCod).getBuckets();
            for (int i = 0; i < outcomeCodBuckets.size(); i++) {
                Terms.Bucket bucket = outcomeCodBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                if ("未报告结局指标".equals(key)) {
                    sumNoNum = bucket.getDocCount();
                    continue;
                }
                array.add(key);
                long docCount = bucket.getDocCount();
                //sumNum += docCount;
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(sumNum), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                result.getJSONArray("outc_cod_list").add(array);
            }
            result.getJSONObject("outc_cod_count").put("yes", sumNum - sumNoNum);
            result.getJSONObject("outc_cod_count").put("no", sumNoNum);
            //不良反应信号分析
//            Boolean outcome = calculateTypicalSignals.getBoolean("outcome");
            JSONObject signalDict = result.getJSONObject("signal_dict");
            signalDict.put("outcome", StringUtils.isNotBlank(safeInfoDto.getUserADRS()));
            //安全性分析提供总数量


            signalDict.put("total", total.get(0));
            signalDict.put("psTotal", total.get(1));

            result.put("total", total.get(0));
            if (!isUnion){
                result.put("psTotal", total.get(1));
            }
            List<String> list = new ArrayList<>();
            if (!StringUtils.isNotBlank(safeInfoDto.getUserADRS())) {
//                JSONArray data = calculateTypicalSignals.getJSONArray("data");
                try {
                    String[] splits = safeInfoDto.getUserDrugNames().split("\\|\\|");
                    String[] split1 = splits[0].split("&&");
                    list = Arrays.stream(split1).collect(Collectors.toList());
                } catch (NullPointerException e) {
                    list.addAll(drugName);

                }

                List<Adrs> adrs = getAdrs(list);
                JSONObject inner = new JSONObject();
                List<SignalBean> adrsList = getSignalBeansJd(condition,safeInfoDto, drugName, isInfo,isUnion);
                for (int i = 0; (i<50)&&(i < adrsList.size()); i++) {
                    JSONArray array = new JSONArray();
                    try {
                        //                    JSONObject json = data.getJSONObject(i);
//                    String en = json.getString("en");
                        String en = adrsList.get(i).getPt();
                        array.add(en);
//                    Integer num = json.getInteger("num");
                        Long num = adrsList.get(i).getNum();
                        array.add(num);
                        if (totalHits == 0) {
                            array.add("0%"); // 当总次数为零时，添加默认值到数组中
                        } else {
                            array.add(BigDecimal.valueOf(num).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                        }//                    String ror = json.getString("ror");
                        String ror = adrsList.get(i).getRor().toString();
                        if (StringUtils.isNotEmpty(ror) && ror.contains(".")) {
                            ror = ror.substring(0, ror.indexOf(".") + 3);
                        }
                        array.add(ror);
//                    String ebgm = json.getString("ebgm");
                        String ebgm = adrsList.get(i).getGps().toString();
                        if (StringUtils.isNotEmpty(ebgm) && ebgm.contains(".")) {
                            ebgm = ebgm.substring(0, ebgm.indexOf(".") + 3);
                        }
                        array.add(ebgm);
//                    String ic = json.getString("ic");
                        String ic = adrsList.get(i).getIc().toString();

                        if (StringUtils.isNotEmpty(ic) && ic.contains(".")) {
                            ic = ic.substring(0, ic.indexOf(".") + 3);
                        }
                        array.add(ic);

                    } catch (Exception e) {
                        e.printStackTrace();
                    }

//                    String zh = json.getString("zh");
                    String zh = adrsList.get(i).getZh();

                    array.add(zh);
//                    String soc = json.getString("soc");
                    String soc = adrsList.get(i).getSoc();
                    if (!inner.containsKey(soc)) {
                        inner.put(soc, new JSONArray());
                    }
                    array.add(adrsList.get(i).getRorLift());
                    array.add(adrsList.get(i).getRorRight());
                    array.add(adrsList.get(i).getIcLift());
                    array.add(adrsList.get(i).getIcRight());
                    inner.getJSONArray(soc).add(array);
                }
                result.put("dataTotal", adrsList.size());
                signalDict.put("data", inner);
            } else {
                //用户输入不良反应
//                JSONArray illustrate = calculateTypicalSignals.getJSONArray("illustrate");
                JSONArray illustrate = new JSONArray();
                signalDict.put("data", illustrate);
            }
        }
        log.info("药品安全性分析计算完成，用时[{}]", System.currentTimeMillis() - start);
        //缓存
        RedisUtil.redis.opsForValue().set(cacheKeyJd, result, 60 * 60 * 24, TimeUnit.SECONDS);
        return result;
    }















    private List<SignalBean> getSignalBeans(Condition condition,SafeInfoDto safeInfoDto, List<String> drugName, Boolean isInfo, Boolean isUnion,int type ) {
        BoolQueryBuilder adverseQuery;
        if (isInfo) {
            adverseQuery = getQuery(safeInfoDto);
        } else {
            adverseQuery = QueryBuilders.boolQuery();
        }

        NativeSearchQuery nativeSearchQuery2 = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery2.setTrackTotalHits(true);
        SearchHits<AdverseIndex> search2 = elasticsearchRestTemplate.search(nativeSearchQuery2, AdverseIndex.class);
        long total = search2.getTotalHits();
        String roleCode = safeInfoDto.getRoleCode();
        if (isInfo && !"-1".equals(roleCode)) {
            List<String> realRole = new ArrayList<>();
            char[] chars = roleCode.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = false;
                if (aChar == '1') {
                    flag = true;
                }
                switch (i) {
                    case 0:
                        if (flag) {
                            realRole.add("PS");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realRole.add("SS");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realRole.add("C");
                        }
                        break;
                    case 3:
                        if (flag) {
                            realRole.add("I");
                        }
                        break;
                }
            }
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
            for (String s : drugName) {
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
            }
            boolQueryBuilder.must().add(QueryBuilders.termsQuery("roleCods.role", realRole));
            boolQueryBuilder.must().add(boolQueryBuilder2);
            NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
            adverseQuery.must().add(boolQueryBuilder1);

        }else if (!isInfo&&!isUnion){ BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
            for (String s : drugName) {
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
            }
            boolQueryBuilder.must().add(QueryBuilders.termQuery("roleCods.role", "PS"));
            boolQueryBuilder.must().add(boolQueryBuilder2);
            NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
            adverseQuery.must().add(boolQueryBuilder1);

        }else {
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            for (String s : drugName) {
                boolQueryBuilder.should().add(QueryBuilders.matchQuery("drugName.keyword", s));
                boolQueryBuilder.should().add(QueryBuilders.matchQuery("prodAi.keyword", s));
            }

            adverseQuery.must().add(boolQueryBuilder);
        }
        int typeDrug = 1;
        String drugNamesAccurate = safeInfoDto.getDrugNamesAccurate();
        if ("true".equals(drugNamesAccurate)) {
            typeDrug = 2;
        }
        int typeOutcome = 1;
        String adrsAccurate = safeInfoDto.getADRSAccurate();
        if ("true".equals(adrsAccurate)) {
            typeOutcome = 2;
        }
        BoolQueryBuilder adverseQuerys = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, false);
        adverseQuery.must().add(adverseQuerys);
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("ptList").field("ptList.keyword").size(100000);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        nativeSearchQuery.setTrackTotalHits(true);
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        adverseQuery.must().add(QueryBuilders.termQuery("isSerious", 1));
        long totalHits = search.getTotalHits();
        Aggregations aggregations = search.getAggregations();
        ArrayList<String> pts = new ArrayList<>();
        HashMap<String, SignalBean> signalBeanHashMap = new HashMap<>();
        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("ptList");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            log.info("计算的总共数量{}", buckets.size());
            for (Terms.Bucket bucket : buckets) {
                if (bucket.getDocCount() > 3) {
                    pts.add(bucket.getKeyAsString());
                    signalBeanHashMap.put(bucket.getKeyAsString(), new SignalBean(bucket.getKeyAsString(), bucket.getDocCount(), totalHits - bucket.getDocCount(),bucket.getDocCount()));
                }
            }
            log.info("真正计算的数量{}", signalBeanHashMap.size());

            BoolQueryBuilder adverseQuery1;
            if (isInfo) {
                adverseQuery1 = getQuery(safeInfoDto);
            } else {
                adverseQuery1 = QueryBuilders.boolQuery();
            }
            if (isInfo && !"-1".equals(roleCode)) {
                List<String> realRole = new ArrayList<>();
                char[] chars = roleCode.toCharArray();
                for (int i = 0; i < chars.length; i++) {
                    char aChar = chars[i];
                    boolean flag = false;
                    if (aChar == '1') {
                        flag = true;
                    }
                    switch (i) {
                        case 0:
                            if (flag) {
                                realRole.add("PS");
                            }
                            break;
                        case 1:
                            if (flag) {
                                realRole.add("SS");
                            }
                            break;
                        case 2:
                            if (flag) {
                                realRole.add("C");
                            }
                            break;
                        case 3:
                            if (flag) {
                                realRole.add("I");
                            }
                            break;
                    }
                }
                BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
                BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
                for (String s : drugName) {
                    boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                    boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
                }
                boolQueryBuilder.must().add(QueryBuilders.termsQuery("roleCods.role", realRole));
                boolQueryBuilder.must().add(boolQueryBuilder2);
                NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
                adverseQuery1.mustNot().add(boolQueryBuilder1);

            }else  if (!isInfo&&!isUnion){ BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
                BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
                for (String s : drugName) {
                    boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                    boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
                }
                boolQueryBuilder.must().add(QueryBuilders.termQuery("roleCods.role", "PS"));
                boolQueryBuilder.must().add(boolQueryBuilder2);
                NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
                adverseQuery1.mustNot().add(boolQueryBuilder1);

            }else{
                BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
                for (String s : drugName) {
                    boolQueryBuilder.should().add(QueryBuilders.matchQuery("drugName.keyword", s));
                    boolQueryBuilder.should().add(QueryBuilders.matchQuery("prodAi.keyword", s));
                }
                adverseQuery1.mustNot().add(boolQueryBuilder);
            }
            TermsQueryBuilder termsQueryBuilder = QueryBuilders.termsQuery("ptList.keyword", pts);
            adverseQuery1.must().add(termsQueryBuilder);
            adverseQuery1.mustNot().add(adverseQuerys);
            NativeSearchQuery nativeSearchQuery1 = new NativeSearchQuery(adverseQuery1);
            TermsAggregationBuilder aggregationBuilder1 = AggregationBuilders.terms("ptList").field("ptList.keyword").size(100000);
            nativeSearchQuery1.addAggregation(aggregationBuilder1);
            nativeSearchQuery1.setTrackTotalHits(true);
            SearchHits<AdverseIndex> search1 = elasticsearchRestTemplate.search(nativeSearchQuery1, AdverseIndex.class);
            Aggregations aggregations1 = search1.getAggregations();
            if (aggregations1 != null) {
                Aggregation aggregation1 = aggregations1.get("ptList");
                List<? extends Terms.Bucket> buckets1 = ((ParsedTerms) aggregation1).getBuckets();
                for (Terms.Bucket bucket : buckets1) {
                    SignalBean signalBean = signalBeanHashMap.get(bucket.getKeyAsString());
                    if (signalBean != null) {
                        signalBean.setC(bucket.getDocCount());
                        signalBean.setD(total - bucket.getDocCount() - totalHits);
                    }
                }

            }
            HashMap<SignalBean, Double> doubleHashMap = new HashMap<>();
            signalBeanHashMap.forEach((k, v) -> {
                try {
                    BigDecimal rorBigDecimal = ReportingOddsRatio.calculateROR(BigDecimal.valueOf(v.getA()),BigDecimal.valueOf( v.getB()),
                            BigDecimal.valueOf(v.getC()), BigDecimal.valueOf(v.getD()));


                    double ror = rorBigDecimal.doubleValue();
                    double gps = GPS.GPS(v.getA().intValue(), v.getB().intValue(), v.getC().intValue(), v.getD().intValue());
                    double ic = BCPNNScoreCalculator.calculateIC(v.getA(), v.getB(), v.getC(), v.getD());

                    BigDecimal[] bigDecimals1 = ReportingOddsRatio.calculateIC95Interval(v.getA(), v.getB(), v.getC(), v.getD(), BigDecimal.valueOf(ic));
                    v.setIcLift(bigDecimals1[1].setScale(2, RoundingMode.HALF_UP).toString());
                    v.setIcRight(bigDecimals1[0].setScale(2, RoundingMode.HALF_UP).toString());



                    v.setGps(gps);
                    v.setRor(ror);
                    v.setIc(ic);
                    BigDecimal[] bigDecimals = ReportingOddsRatio.calculate95CI(BigDecimal.valueOf(v.getA()), BigDecimal.valueOf(v.getB()),
                            BigDecimal.valueOf(v.getC()), BigDecimal.valueOf(v.getD()), rorBigDecimal);
                    v.setRorLift(bigDecimals[0].setScale(2, RoundingMode.HALF_UP).toString());
                    v.setRorRight(bigDecimals[1].setScale(2, RoundingMode.HALF_UP).toString());

                    if (ic>2&&ror>3&&gps>0) {
                        if (type == 0){
                            doubleHashMap.put(v,ror);
                        }else if (type == 1){
                            doubleHashMap.put(v,ic);
                        }else if (type == 2){
                            doubleHashMap.put(v,gps);
                        }else if (type == 3){
                            doubleHashMap.put(v,v.getA().doubleValue());
                        }

                    }
                } catch (NullPointerException e) {
                    log.info("abcd出现错误");
                }

            });
            List<Entry<SignalBean, Double>> sortedEntries = doubleHashMap.entrySet()
                    .stream()
                    .sorted(Entry.<SignalBean, Double>comparingByValue().reversed())
                    .collect(Collectors.toList());

            ArrayList<SignalBean> signalBeans = new ArrayList<>();
            ArrayList<String> strings = new ArrayList<>();
            for (Entry<SignalBean, Double> sortedEntry : sortedEntries) {
                SignalBean v = sortedEntry.getKey();
//                double v1 = BCPNNScoreCalculator.calculateIC(v.getA(), v.getB(), v.getC(), v.getD());
//                double  = ReportingOddsRatio.calculateROR(v.getA().intValue(), v.getB().intValue(), v.getC().intValue(), v.getD().intValue(), null);
//                if (gps > 3 && v > 0) {
//                    key.setGps(gps);
//                    key.setRor(v);
                    signalBeans.add(v);
//                }
                strings.add(v.getPt());
//                if (signalBeans.size() >= 50) {
//                    break;
//                }
            }
            List<JSONObject> jsonObjects = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("pt_en").in(strings)), JSONObject.class, "pt_all_data");
            for (SignalBean signalBean : signalBeans) {
                for (JSONObject jsonObject : jsonObjects) {
                    if (jsonObject.getString("pt_en").equals(signalBean.getPt())){
                        signalBean.setZh(jsonObject.getString("pt_ch"));
                        signalBean.setSoc(jsonObject.getString("main_soc_organ"));
                    }
//                    if (signalBean.getZh() == null){
//                        signalBean.setZh("-");
//                    }
                }
                if ( signalBean.getSoc() == null){
                    signalBean.setSoc("");
                }
            }
//            for (SignalBean signalBean : signalBeans) {
//                System.out.println("    soc："+signalBean.getSoc()+"    pt："+signalBean.getPt()+"     zh："+signalBean.getZh()+"    a："+signalBean.getA()+"   b："+signalBean.getB()+"    c："+signalBean.getC()+"    d："+signalBean.getD()+"    gps："+signalBean.getGps()+"    ic："+signalBean.getIc()+"    ror："+signalBean.getRor());
//            }

            for (SignalBean signalBean : signalBeans) {
                if (StringUtils.isEmpty(signalBean.getZh())){
                    signalBean.setZh(TransUtil.trans(signalBean.getPt()));
                    JSONObject jsonObject = new JSONObject();
                    jsonObject.put("pt_en", signalBean.getPt());
                    jsonObject.put("pt_ch", signalBean.getZh());
                    jsonObject.put("isNew", "1");
                    ReleaseMongoUtil.mongo.save(jsonObject, "pt_all_data");
                }
            }


            return signalBeans;
        }
        return null;
    }
    private List<SignalBean> getSignalBeansJd(Condition condition,SafeInfoDto safeInfoDto, List<String> drugName, Boolean isInfo, Boolean isUnion) {
        BoolQueryBuilder adverseQuery;
        if (isInfo) {
            adverseQuery = getQuery(safeInfoDto);
        } else {
            adverseQuery = QueryBuilders.boolQuery();
        }

        NativeSearchQuery nativeSearchQuery2 = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery2.setTrackTotalHits(true);
        SearchHits<AdverseIndexJd> search2 = elasticsearchRestTemplate.search(nativeSearchQuery2, AdverseIndexJd.class);
        long total = search2.getTotalHits();
        String roleCode = safeInfoDto.getRoleCode();
        if (isInfo && !"-1".equals(roleCode)) {
            List<String> realRole = new ArrayList<>();
            String[] split1 = roleCode.split(",");
            realRole.addAll(Arrays.asList(split1));
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
            for (String s : drugName) {
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
            }
            boolQueryBuilder.must().add(QueryBuilders.termsQuery("roleCods.role", realRole));
            boolQueryBuilder.must().add(boolQueryBuilder2);
            NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
            adverseQuery.must().add(boolQueryBuilder1);

        }else if (!isInfo&&!isUnion){ BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
            for (String s : drugName) {
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
            }
            boolQueryBuilder.must().add(QueryBuilders.termQuery("roleCods.role", "PS"));
            boolQueryBuilder.must().add(boolQueryBuilder2);
            NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
            adverseQuery.must().add(boolQueryBuilder1);

        }else {
            BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
            for (String s : drugName) {
                boolQueryBuilder.should().add(QueryBuilders.matchQuery("drugName.keyword", s));
                boolQueryBuilder.should().add(QueryBuilders.matchQuery("prodAi.keyword", s));
            }

            adverseQuery.must().add(boolQueryBuilder);
        }
        int typeDrug = 1;
        String drugNamesAccurate = safeInfoDto.getDrugNamesAccurate();
        if ("true".equals(drugNamesAccurate)) {
            typeDrug = 2;
        }
        int typeOutcome = 1;
        String adrsAccurate = safeInfoDto.getADRSAccurate();
        if ("true".equals(adrsAccurate)) {
            typeOutcome = 2;
        }
        BoolQueryBuilder adverseQuerys = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, false);
        adverseQuery.must().add(adverseQuerys);
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("ptList").field("ptList.keyword").size(100000);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        nativeSearchQuery.setTrackTotalHits(true);
        SearchHits<AdverseIndexJd> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndexJd.class);
        adverseQuery.must().add(QueryBuilders.termQuery("isSerious", 1));
        long totalHits = search.getTotalHits();
        Aggregations aggregations = search.getAggregations();
        ArrayList<String> pts = new ArrayList<>();
        HashMap<String, SignalBean> signalBeanHashMap = new HashMap<>();
        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("ptList");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            log.info("计算的总共数量{}", buckets.size());
            for (Terms.Bucket bucket : buckets) {
                if (bucket.getDocCount() > 3) {
                    pts.add(bucket.getKeyAsString());
                    signalBeanHashMap.put(bucket.getKeyAsString(), new SignalBean(bucket.getKeyAsString(), bucket.getDocCount(), totalHits - bucket.getDocCount(),bucket.getDocCount()));
                }
            }
            log.info("真正计算的数量{}", signalBeanHashMap.size());

            BoolQueryBuilder adverseQuery1;
            if (isInfo) {
                adverseQuery1 = getQuery(safeInfoDto);
            } else {
                adverseQuery1 = QueryBuilders.boolQuery();
            }
            if (isInfo && !"-1".equals(roleCode)) {
                List<String> realRole = new ArrayList<>();
                String[] split1 = roleCode.split(",");
                realRole.addAll(Arrays.asList(split1));
                BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
                BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
                for (String s : drugName) {
                    boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                    boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
                }
                boolQueryBuilder.must().add(QueryBuilders.termsQuery("roleCods.role", realRole));
                boolQueryBuilder.must().add(boolQueryBuilder2);
                NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
                adverseQuery1.mustNot().add(boolQueryBuilder1);

            }else  if (!isInfo&&!isUnion){ BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
                BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
                for (String s : drugName) {
                    boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
                    boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
                }
                boolQueryBuilder.must().add(QueryBuilders.termQuery("roleCods.role", "PS"));
                boolQueryBuilder.must().add(boolQueryBuilder2);
                NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
                adverseQuery1.mustNot().add(boolQueryBuilder1);

            }else{
                BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
                for (String s : drugName) {
                    boolQueryBuilder.should().add(QueryBuilders.matchQuery("drugName.keyword", s));
                    boolQueryBuilder.should().add(QueryBuilders.matchQuery("prodAi.keyword", s));
                }
                adverseQuery1.mustNot().add(boolQueryBuilder);
            }
            TermsQueryBuilder termsQueryBuilder = QueryBuilders.termsQuery("ptList.keyword", pts);
            adverseQuery1.must().add(termsQueryBuilder);
            adverseQuery1.mustNot().add(adverseQuerys);
            NativeSearchQuery nativeSearchQuery1 = new NativeSearchQuery(adverseQuery1);
            TermsAggregationBuilder aggregationBuilder1 = AggregationBuilders.terms("ptList").field("ptList.keyword").size(100000);
            nativeSearchQuery1.addAggregation(aggregationBuilder1);
            nativeSearchQuery1.setTrackTotalHits(true);
            SearchHits<AdverseIndexJd> search1 = elasticsearchRestTemplate.search(nativeSearchQuery1, AdverseIndexJd.class);
            Aggregations aggregations1 = search1.getAggregations();
            if (aggregations1 != null) {
                Aggregation aggregation1 = aggregations1.get("ptList");
                List<? extends Terms.Bucket> buckets1 = ((ParsedTerms) aggregation1).getBuckets();
                for (Terms.Bucket bucket : buckets1) {
                    SignalBean signalBean = signalBeanHashMap.get(bucket.getKeyAsString());
                    if (signalBean != null) {
                        signalBean.setC(bucket.getDocCount());
                        signalBean.setD(total - bucket.getDocCount() - totalHits);
                    }
                }

            }
            HashMap<SignalBean, Double> doubleHashMap = new HashMap<>();
            signalBeanHashMap.forEach((k, v) -> {
                try {
                    BigDecimal rorBigDecimal = ReportingOddsRatio.calculateROR(BigDecimal.valueOf(v.getA()),BigDecimal.valueOf( v.getB()),
                            BigDecimal.valueOf(v.getC()), BigDecimal.valueOf(v.getD()));
                    double ror = rorBigDecimal.doubleValue();
                    double gps = GPS.GPS(v.getA().intValue(), v.getB().intValue(), v.getC().intValue(), v.getD().intValue());
                    double ic = BCPNNScoreCalculator.calculateIC(v.getA(), v.getB(), v.getC(), v.getD());

                    BigDecimal[] bigDecimals1 = ReportingOddsRatio.calculateIC95Interval(v.getA(), v.getB(), v.getC(), v.getD(), BigDecimal.valueOf(ic));
                    v.setIcLift(bigDecimals1[0].setScale(2, RoundingMode.HALF_UP).toString());
                    v.setIcRight(bigDecimals1[1].setScale(2, RoundingMode.HALF_UP).toString());
                    v.setGps(gps);
                    v.setRor(ror);
                    v.setIc(ic);
                    BigDecimal[] bigDecimals = ReportingOddsRatio.calculate95CI(BigDecimal.valueOf(v.getA()), BigDecimal.valueOf(v.getB()),
                            BigDecimal.valueOf(v.getC()), BigDecimal.valueOf(v.getD()), rorBigDecimal);
                    v.setRorLift(bigDecimals[0].setScale(2, RoundingMode.HALF_UP).toString());
                    v.setRorRight(bigDecimals[1].setScale(2, RoundingMode.HALF_UP).toString());


                    if (ic>2&&ror>3&&gps>0) {
                        doubleHashMap.put(v,ror);
                    }
                } catch (NullPointerException e) {
                    log.info("abcd出现错误");
                }

            });
            List<Entry<SignalBean, Double>> sortedEntries = doubleHashMap.entrySet()
                    .stream()
                    .sorted(Entry.<SignalBean, Double>comparingByValue().reversed())
                    .collect(Collectors.toList());

            ArrayList<SignalBean> signalBeans = new ArrayList<>();
            ArrayList<String> strings = new ArrayList<>();
            for (Entry<SignalBean, Double> sortedEntry : sortedEntries) {
                SignalBean v = sortedEntry.getKey();
//                double v1 = BCPNNScoreCalculator.calculateIC(v.getA(), v.getB(), v.getC(), v.getD());
//                double  = ReportingOddsRatio.calculateROR(v.getA().intValue(), v.getB().intValue(), v.getC().intValue(), v.getD().intValue(), null);
//                if (gps > 3 && v > 0) {
//                    key.setGps(gps);
//                    key.setRor(v);
                signalBeans.add(v);
//                }
                strings.add(v.getPt());
//                if (signalBeans.size() >= 50) {
//                    break;
//                }
            }
            ArrayList<String> strings1 = new ArrayList<>();
            List<JSONObject> jsonObjects = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("pt_en").in(strings)), JSONObject.class, "race_jp_zh");
            for (SignalBean signalBean : signalBeans) {
                for (JSONObject jsonObject : jsonObjects) {
                    if (jsonObject.getString("pt_en").equals(signalBean.getPt())){
                        signalBean.setZh(jsonObject.getString("pt_ch"));
                        strings1.add(jsonObject.getString("pt_en"));
                    }
                }

               try {
                   if (StringUtils.isEmpty(signalBean.getZh())) {
                       signalBean.setZh(TransUtil.trans(signalBean.getPt()));
                       if (StringUtils.isNotEmpty(signalBean.getZh())) {
                           JSONObject jsonObject = new JSONObject();
                           jsonObject.put("pt_en", signalBean.getPt());
                           jsonObject.put("pt_ch", signalBean.getZh());
                           jsonObject.put("isNew", "1");
                           ReleaseMongoUtil.mongo.insert(jsonObject, "race_jp_zh");
                       }
                   }
               }catch (Exception e){
                   log.info("trans出现错误");
               }
            }


            List<JSONObject> jsonObjects1 = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("pt_ch").in(strings1)), JSONObject.class, "pt_all_data");
            for (SignalBean signalBean : signalBeans) {
                for (JSONObject jsonObject : jsonObjects1) {
                    if (jsonObject.getString("pt_ch").equals(signalBean.getPt())){
                        signalBean.setZh(jsonObject.getString("main_soc_organ"));
                    }
                }
                if ( signalBean.getSoc() == null){
                    signalBean.setSoc("");
                }
            }



//            for (SignalBean signalBean : signalBeans) {
//                System.out.println("    soc："+signalBean.getSoc()+"    pt："+signalBean.getPt()+"     zh："+signalBean.getZh()+"    a："+signalBean.getA()+"   b："+signalBean.getB()+"    c："+signalBean.getC()+"    d："+signalBean.getD()+"    gps："+signalBean.getGps()+"    ic："+signalBean.getIc()+"    ror："+signalBean.getRor());
//            }
            return signalBeans;
        }
        return null;
    }











    @Deprecated
    private List<SignalBean> getSignalBeansCase(SafeInfoDto safeInfoDto, List<String> drugName, Boolean isInfo) {
        BoolQueryBuilder adverseQuery;
        if (isInfo) {
            adverseQuery = getQuery(safeInfoDto);
        } else {
            adverseQuery = QueryBuilders.boolQuery();
        }


        NativeSearchQuery nativeSearchQuery2 = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery2.setTrackTotalHits(true);
        SearchHits<AdverseForCaseIndex> search2 = elasticsearchRestTemplate.search(nativeSearchQuery2, AdverseForCaseIndex.class);
        long total = search2.getTotalHits();
        String roleCode = safeInfoDto.getRoleCode();
        if (isInfo && !"-1".equals(roleCode)) {
            List<String> realRole = new ArrayList<>();
            char[] chars = roleCode.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = false;
                if (aChar == '1') {
                    flag = true;
                }
                switch (i) {
                    case 0:
                        if (flag) {
                            realRole.add("PS");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realRole.add("SS");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realRole.add("C");
                        }
                        break;
                    case 3:
                        if (flag) {
                            realRole.add("I");
                        }
                        break;
                }
            }
            BoolQueryBuilder boolQueryBuilder3 = QueryBuilders.boolQuery();
            for (String s : realRole) {
                boolQueryBuilder3.should().add(QueryBuilders.matchQuery("roleCod", s));
            }
            adverseQuery.must().add(boolQueryBuilder3);

        }
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        TermsQueryBuilder termsQueryBuilder = QueryBuilders.termsQuery("drugName.keyword", drugName);
        TermsQueryBuilder termsQueryBuilderz = QueryBuilders.termsQuery("prodAi.keyword", drugName);
        boolQueryBuilder.should().add(termsQueryBuilder);
        boolQueryBuilder.should().add(termsQueryBuilderz);
        adverseQuery.must().add(boolQueryBuilder);

        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("ptList").field("ptList.keyword").size(100000);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        nativeSearchQuery.setTrackTotalHits(true);
        SearchHits<AdverseForCaseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseForCaseIndex.class);
        long totalHits = search.getTotalHits();
        Aggregations aggregations = search.getAggregations();
        ArrayList<String> pts = new ArrayList<>();
        HashMap<String, SignalBean> signalBeanHashMap = new HashMap<>();
        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("ptList");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            log.info("计算的总共数量{}", buckets.size());
            for (Terms.Bucket bucket : buckets) {
                if (bucket.getDocCount() > 3) {
                    pts.add(bucket.getKeyAsString());
                    signalBeanHashMap.put(bucket.getKeyAsString(), new SignalBean(bucket.getKeyAsString(), bucket.getDocCount(), totalHits - bucket.getDocCount(),bucket.getDocCount()));
                }
            }
            log.info("真正计算的数量{}", signalBeanHashMap.size());

            BoolQueryBuilder adverseQuery1;
            if (isInfo) {
                adverseQuery1 = getQuery(safeInfoDto);
            } else {
                adverseQuery1 = QueryBuilders.boolQuery();
            }
            if (isInfo && !"-1".equals(roleCode)) {
                List<String> realRole = new ArrayList<>();
                char[] chars = roleCode.toCharArray();
                for (int i = 0; i < chars.length; i++) {
                    char aChar = chars[i];
                    boolean flag = false;
                    if (aChar == '1') {
                        flag = true;
                    }
                    switch (i) {
                        case 0:
                            if (flag) {
                                realRole.add("PS");
                            }
                            break;
                        case 1:
                            if (flag) {
                                realRole.add("SS");
                            }
                            break;
                        case 2:
                            if (flag) {
                                realRole.add("C");
                            }
                            break;
                        case 3:
                            if (flag) {
                                realRole.add("I");
                            }
                            break;
                    }
                }
                BoolQueryBuilder boolQueryBuilder3 = QueryBuilders.boolQuery();
                for (String s : realRole) {
                    boolQueryBuilder3.should().add(QueryBuilders.matchQuery("roleCod", s));
                }

                adverseQuery1.mustNot().add(boolQueryBuilder3);

            }
            TermsQueryBuilder termsQueryBuilder1 = QueryBuilders.termsQuery("ptList.keyword", pts);
            adverseQuery1.must().add(termsQueryBuilder1);
            NativeSearchQuery nativeSearchQuery1 = new NativeSearchQuery(adverseQuery1);
            TermsAggregationBuilder aggregationBuilder1 = AggregationBuilders.terms("ptList").field("ptList.keyword").size(100000);
            nativeSearchQuery1.addAggregation(aggregationBuilder1);
            nativeSearchQuery1.setTrackTotalHits(true);
            SearchHits<AdverseForCaseIndex> search1 = elasticsearchRestTemplate.search(nativeSearchQuery1, AdverseForCaseIndex.class);
            Aggregations aggregations1 = search1.getAggregations();
            if (aggregations1 != null) {
                Aggregation aggregation1 = aggregations1.get("ptList");
                List<? extends Terms.Bucket> buckets1 = ((ParsedTerms) aggregation1).getBuckets();
                for (Terms.Bucket bucket : buckets1) {
                    SignalBean signalBean = signalBeanHashMap.get(bucket.getKeyAsString());
                    if (signalBean != null) {
                        signalBean.setC(bucket.getDocCount());
                        signalBean.setD(total - bucket.getDocCount() - totalHits);
                    }
                }

            }
            HashMap<SignalBean, Double> doubleHashMap = new HashMap<>();
            signalBeanHashMap.forEach((k, v) -> {
                try {
                    BigDecimal rorBigDecimal = ReportingOddsRatio.calculateROR(BigDecimal.valueOf(v.getA()),BigDecimal.valueOf( v.getB()),
                            BigDecimal.valueOf(v.getC()), BigDecimal.valueOf(v.getD()));
                    double ror = rorBigDecimal.doubleValue();
                    double gps = GPS.GPS(v.getA().intValue(), v.getB().intValue(), v.getC().intValue(), v.getD().intValue());
                    double v1 = BCPNNScoreCalculator.calculateIC(v.getA(), v.getB(), v.getC(), v.getD());
                    v.setGps(gps);
                    v.setRor(ror);
                    v.setIc(v1);
                    doubleHashMap.put(v, v.getNum().doubleValue());
                } catch (NullPointerException e) {
                    doubleHashMap.put(v, 0.0);
                }

            });
            List<Entry<SignalBean, Double>> sortedEntries = doubleHashMap.entrySet()
                    .stream()
                    .sorted(Entry.<SignalBean, Double>comparingByValue().reversed())
                    .collect(Collectors.toList());

            ArrayList<SignalBean> signalBeans = new ArrayList<>();
            for (Entry<SignalBean, Double> sortedEntry : sortedEntries) {
                SignalBean v = sortedEntry.getKey();
//                double v1 = BCPNNScoreCalculator.calculateIC(v.getA(), v.getB(), v.getC(), v.getD());
//                double  = ReportingOddsRatio.calculateROR(v.getA().intValue(), v.getB().intValue(), v.getC().intValue(), v.getD().intValue(), null);
//                if (gps > 3 && v > 0) {
//                    key.setGps(gps);
//                    key.setRor(v);
                signalBeans.add(v);
//                }
                if (signalBeans.size() >= 50) {
                    break;
                }
            }
            return signalBeans;
        }
        return null;
    }



    private BoolQueryBuilder getQuery(SafeInfoDto safeInfoDto) {
        BoolQueryBuilder adverseQuery = QueryBuilders.boolQuery();
        //时间
        if (StringUtils.isNotBlank(safeInfoDto.getBeginDate())) {
            adverseQuery.must().add(QueryBuilders.rangeQuery("date").gte(safeInfoDto.getBeginDate()));
        }
        if (StringUtils.isNotBlank(safeInfoDto.getEndDate())) {
            adverseQuery.must().add(QueryBuilders.rangeQuery("date").lte(safeInfoDto.getEndDate()));
        }

        //药品在报告中的作用


        //严重不良反应结局
        String outcCode = safeInfoDto.getOutcCode();
        if (!"-1".equals(outcCode)) {
            List<String> realOutcomeCode = new ArrayList<>();
            char[] chars = outcCode.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = false;
                if (aChar == '1') {
                    flag = true;
                }
                switch (i) {
                    case 0:
                        if (flag) {
                            realOutcomeCode.add("死亡");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realOutcomeCode.add("危及生命");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realOutcomeCode.add("住院初次或长期");
                        }
                        break;
                    case 3:
                        if (flag) {
                            realOutcomeCode.add("残疾");
                        }
                        break;
                    case 4:
                        if (flag) {
                            realOutcomeCode.add("先天性异常或出生缺陷");
                        }
                        break;
                    case 5:
                        if (flag) {
                            realOutcomeCode.add("永久的损伤/伤害");
                        }
                        break;
                    case 6:
                        if (flag) {
                            realOutcomeCode.add("其他严重 (重大医疗事件)");
                        }
                        break;
                    case 7:
                        if (flag) {
                            realOutcomeCode.add("未报告结局指标");
                        }
                }
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("outcomeCod", realOutcomeCode));
        }
        //报告者职业
        String occpCode = safeInfoDto.getOccpCode();
        if (!"-1".equals(occpCode)) {
            List<String> realOccupationalCod = new ArrayList<>();
            char[] chars = occpCode.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = false;
                if (aChar == '1') {
                    flag = true;
                }
                switch (i) {
                    case 0:
                        if (flag) {
                            realOccupationalCod.add("医生");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realOccupationalCod.add("药师");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realOccupationalCod.add("其他健康专家");
                        }
                        break;
                    case 3:
                        if (flag) {
                            realOccupationalCod.add("律师");
                        }
                        break;
                    case 4:
                        if (flag) {
                            realOccupationalCod.add("消费者");
                        }
                        break;
                    case 5:
                        if (flag) {
                            realOccupationalCod.add("未知");
                        }
                }
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("occupationalCod", realOccupationalCod));
        }
        //患者性别
        String sex = safeInfoDto.getSex();
        if (!"-1".equals(sex)) {
            List<String> realSex = new ArrayList<>();
            char[] chars = sex.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = false;
                if (aChar == '1') {
                    flag = true;
                }
                switch (i) {
                    case 0:
                        if (flag) {
                            realSex.add("男");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realSex.add("女");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realSex.add("未知");
                        }
                        break;
                }
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("sex", realSex));
        }
        //患者年龄
        String age = safeInfoDto.getAge();
        if (!"-1".equals(age)) {
            List<String> realAge = new ArrayList<>();
            char[] chars = age.toCharArray();
            for (int i = 0; i < chars.length; i++) {
                char aChar = chars[i];
                boolean flag = false;
                if (aChar == '1') {
                    flag = true;
                }
                switch (i) {
                    case 0:
                        if (flag) {
                            realAge.add("≤18岁");
                        }
                        break;
                    case 1:
                        if (flag) {
                            realAge.add("18＜年龄＜65");
                        }
                        break;
                    case 2:
                        if (flag) {
                            realAge.add("≥65岁");
                        }
                        break;
                }
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("age", realAge));
        }
        return adverseQuery;
    }

    private List<String> getTotal(BoolQueryBuilder adverseQuery, List<String> drugName,BoolQueryBuilder adverseQuery1) {
        BoolQueryBuilder boolQueryBuilder4 = QueryBuilders.boolQuery();
        boolQueryBuilder4.must().add(adverseQuery);
        ArrayList<String> longs = new ArrayList<>();
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        long totalHits = search.getTotalHits();
        longs.add(totalHits + "");
        NativeSearchQuery nativeSearchQuery1 = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery1.setTrackTotalHits(true);
        nativeSearchQuery1.setPageable(PageRequest.of(0, 1));
        nativeSearchQuery1.addAggregation(AggregationBuilders.terms("year").field("year").size(30));
        SearchHits<AdverseIndex> search1 = elasticsearchRestTemplate.search(nativeSearchQuery1, AdverseIndex.class);
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
        for (String s : drugName) {
            boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
            boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
        }
        boolQueryBuilder.must().add(QueryBuilders.termsQuery("roleCods.role", "PS"));
        boolQueryBuilder.must().add(boolQueryBuilder2);
        NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
        boolQueryBuilder4.must().add(boolQueryBuilder1);
        NativeSearchQuery nativeSearchQuery3 = new NativeSearchQuery(boolQueryBuilder4);
        nativeSearchQuery3.setTrackTotalHits(true);
        nativeSearchQuery3.setPageable(PageRequest.of(0, 1));
        nativeSearchQuery3.addAggregation(AggregationBuilders.terms("year").field("year").size(30));
        SearchHits<AdverseIndex> search2 = elasticsearchRestTemplate.search(nativeSearchQuery3, AdverseIndex.class);
        long totalHits2 = search2.getTotalHits();
        Aggregations aggregations = search1.getAggregations();
        Aggregations aggregations1 = search2.getAggregations();
        String key = "";
        long count = 0;
        if (aggregations != null) {
            //year
            Aggregation year = aggregations.get("year");
            List<? extends Terms.Bucket> yearBuckets = ((ParsedTerms) year).getBuckets();
            for (int i = 0; i < yearBuckets.size(); i++) {
                Terms.Bucket bucket = yearBuckets.get(i);

                long docCount = bucket.getDocCount();
                if (docCount > count) {
                    key = bucket.getKey().toString();
                    count = docCount;
                }
            }
        }
        String key1 = "";
        long count1 = 0;
        if (aggregations1 != null) {
            //year
            Aggregation year = aggregations1.get("year");
            List<? extends Terms.Bucket> yearBuckets = ((ParsedTerms) year).getBuckets();
            for (int i = 0; i < yearBuckets.size(); i++) {
                Terms.Bucket bucket = yearBuckets.get(i);

                long docCount = bucket.getDocCount();
                if (docCount > count1) {
                    key1 = bucket.getKey().toString();
                    count1 = docCount;
                }
            }
        }
        BoolQueryBuilder boolQueryBuilder5 = QueryBuilders.boolQuery();
        boolQueryBuilder5.must().add(adverseQuery1);
        boolQueryBuilder5.must().add(boolQueryBuilder1);
        NativeSearchQuery nativeSearchQuery2 = new NativeSearchQuery(boolQueryBuilder5);
        nativeSearchQuery2.setTrackTotalHits(true);
        nativeSearchQuery2.setPageable(PageRequest.of(0, 1));
        SearchHits<AdverseIndex> search3 = elasticsearchRestTemplate.search(nativeSearchQuery2, AdverseIndex.class);
        long totalHits3 = search3.getTotalHits();

        longs.add(totalHits2 + "");
        longs.add(key);
        longs.add(count + "");
        longs.add(key1);
        longs.add(count1 + "");
        longs.add(totalHits3 + "");
        return longs;
    }



    private List<String> getTotalJd(BoolQueryBuilder adverseQuery, List<String> drugName,BoolQueryBuilder adverseQuery1) {
        BoolQueryBuilder boolQueryBuilder4 = QueryBuilders.boolQuery();
        boolQueryBuilder4.must().add(adverseQuery);
        ArrayList<String> longs = new ArrayList<>();
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        SearchHits<AdverseIndexJd> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndexJd.class);
        long totalHits = search.getTotalHits();
        longs.add(totalHits + "");
        NativeSearchQuery nativeSearchQuery1 = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery1.setTrackTotalHits(true);
        nativeSearchQuery1.setPageable(PageRequest.of(0, 1));
        nativeSearchQuery1.addAggregation(AggregationBuilders.terms("year").field("year").size(30));
        SearchHits<AdverseIndexJd> search1 = elasticsearchRestTemplate.search(nativeSearchQuery1, AdverseIndexJd.class);
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        BoolQueryBuilder boolQueryBuilder2 = QueryBuilders.boolQuery();
        for (String s : drugName) {
            boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.drug", s));
            boolQueryBuilder2.should().add(QueryBuilders.matchQuery("roleCods.prodAi", s));
        }
        boolQueryBuilder.must().add(QueryBuilders.termsQuery("roleCods.role", "怀疑药物"));
        boolQueryBuilder.must().add(boolQueryBuilder2);
        NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods", boolQueryBuilder, ScoreMode.Avg);
        boolQueryBuilder4.must().add(boolQueryBuilder1);
        NativeSearchQuery nativeSearchQuery3 = new NativeSearchQuery(boolQueryBuilder4);
        nativeSearchQuery3.setTrackTotalHits(true);
        nativeSearchQuery3.setPageable(PageRequest.of(0, 1));
        nativeSearchQuery3.addAggregation(AggregationBuilders.terms("year").field("year").size(30));
        SearchHits<AdverseIndexJd> search2 = elasticsearchRestTemplate.search(nativeSearchQuery3, AdverseIndexJd.class);
        long totalHits2 = search2.getTotalHits();
        Aggregations aggregations = search1.getAggregations();
        Aggregations aggregations1 = search2.getAggregations();
        String key = "";
        long count = 0;
        if (aggregations != null) {
            //year
            Aggregation year = aggregations.get("year");
            List<? extends Terms.Bucket> yearBuckets = ((ParsedTerms) year).getBuckets();
            for (int i = 0; i < yearBuckets.size(); i++) {
                Terms.Bucket bucket = yearBuckets.get(i);

                long docCount = bucket.getDocCount();
                if (docCount > count) {
                    key = bucket.getKey().toString();
                    count = docCount;
                }
            }
        }
        String key1 = "";
        long count1 = 0;
        if (aggregations1 != null) {
            //year
            Aggregation year = aggregations1.get("year");
            List<? extends Terms.Bucket> yearBuckets = ((ParsedTerms) year).getBuckets();
            for (int i = 0; i < yearBuckets.size(); i++) {
                Terms.Bucket bucket = yearBuckets.get(i);

                long docCount = bucket.getDocCount();
                if (docCount > count1) {
                    key1 = bucket.getKey().toString();
                    count1 = docCount;
                }
            }
        }
        BoolQueryBuilder boolQueryBuilder5 = QueryBuilders.boolQuery();
        boolQueryBuilder5.must().add(adverseQuery1);
        boolQueryBuilder5.must().add(boolQueryBuilder1);
        NativeSearchQuery nativeSearchQuery2 = new NativeSearchQuery(boolQueryBuilder5);
        nativeSearchQuery2.setTrackTotalHits(true);
        nativeSearchQuery2.setPageable(PageRequest.of(0, 1));
        SearchHits<AdverseIndexJd> search3 = elasticsearchRestTemplate.search(nativeSearchQuery2, AdverseIndexJd.class);
        long totalHits3 = search3.getTotalHits();

        longs.add(totalHits2 + "");
        longs.add(key);
        longs.add(count + "");
        longs.add(key1);
        longs.add(count1 + "");
        longs.add(totalHits3 + "");
        return longs;
    }


    /**
     * 计算典型信号
     *
     * @param condition 检索条件
     * @return 计算后的典型信号信息
     */
    private JSONObject calculateTypicalSignals(Condition condition) {
        JSONObject result = new JSONObject();
        result.put("outcome", false);
        JSONArray data = new JSONArray();
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, 2, 2, false);
        //保存总数
        long total = 0;

        //假如用户输入的为α药并检索出a药共有123三种不良反应，
        // 对不良反应1来说取a（是这个药且有1不良反应的病例数）
        // b（是这个药但没这个1不良反应的病例数）
        // c（不是这个药但是有这个不良反应的病例数）
        // d（不是这个药也不是这个不良反应的病例数）
        // 共四个值传给py用模型计算出来的

        //判断用户是否输入了结局指标
        boolean flag = false;
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();
        List<List<String>> outComeList = new ArrayList<>();
        for (InterventionAndOutcome outcome : outcomes) {
            Integer status = outcome.getStatus();
            if (status == 1) {
                List<String> inner = new ArrayList<>();
                String word = outcome.getWord();
                if (StringUtils.isNotBlank(word)) {
                    inner.add(word);
                }
                String enWord = outcome.getEnWord();
                if (StringUtils.isNotBlank(enWord)) {
                    inner.add(enWord);
                }
                String zhWord = outcome.getZhWord();
                if (StringUtils.isNotBlank(zhWord)) {
                    inner.add(zhWord);
                }
                List<WordStatus> enSynonym = outcome.getEnSynonym();
                if (CollectionUtils.isNotEmpty(enSynonym)) {
                    for (WordStatus wordStatus : enSynonym) {
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            inner.add(wordStatus.getName());
                        }
                    }
                }
                List<WordStatus> zhSynonym = outcome.getZhSynonym();
                if (CollectionUtils.isNotEmpty(zhSynonym)) {
                    for (WordStatus wordStatus : zhSynonym) {
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            inner.add(wordStatus.getName());
                        }
                    }
                }
                
                //补充同义词
                String expandSynonym = outcome.getExpandSynonym();
                expandSynonym = expandSynonym.replaceAll("；", ";");
                String[] split = expandSynonym.split(";");
                for (String txt : split) {
                    if (StringUtils.isNotBlank(txt)) {
                        inner.add(txt.toLowerCase());
                    }
                }
                outComeList.add(inner);
            }
        }
        if (CollectionUtils.isNotEmpty(outComeList)) {
            flag = true;
        }
        //取top20的不良反应
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("ptList").field("ptList.keyword").size(20);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        //聚合sum drugName总数
        //SumAggregationBuilder field = AggregationBuilders.sum("sum").field("num");
        //nativeSearchQuery.addAggregation(field);
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        long totalHits = search.getTotalHits();
        total = totalHits;
        Aggregations aggregations = search.getAggregations();
        Map<List<String>, Long> top20Map = new HashMap<>();
        //double value = 0;
        if (!flag) {
            if (aggregations != null) {
                Aggregation aggregation = aggregations.get("ptList");
                List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
                for (Terms.Bucket bucket : buckets) {
                    String key = bucket.getKey().toString();
                    long docCount = bucket.getDocCount();
                    top20Map.put(Collections.singletonList(key), docCount);
                }
                //计算原始总数
                //Sum sumAggregation = aggregations.get("sum");
                //value = sumAggregation.getValue();
            }
        } else {
            for (List<String> list : outComeList) {
                BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
                boolQueryBuilder.must().add(adverseQuery);
                boolQueryBuilder.must().add(QueryBuilders.termsQuery("pt.keyword", list));
                NativeSearchQuery inner = new NativeSearchQuery(boolQueryBuilder);
                inner.setTrackTotalHits(true);
                inner.setPageable(PageRequest.of(0, 1));
                long count = elasticsearchRestTemplate.count(nativeSearchQuery, AdverseIndex.class);
                total += count;
                top20Map.put(list, count);
            }
        }
        //不是这个药但是有这个不良反应的病例数
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        boolQueryBuilder.mustNot().add(adverseQuery);
        NativeSearchQuery allQuery = new NativeSearchQuery(boolQueryBuilder);
        allQuery.setTrackTotalHits(true);
        //不是这个药的报告总数即 c + d
        long count = elasticsearchRestTemplate.count(allQuery, AdverseIndex.class);
        Set<Entry<List<String>, Long>> entries = top20Map.entrySet();
        for (Entry<List<String>, Long> entry : entries) {
            JSONObject json = new JSONObject();
            List<String> key = entry.getKey();
            //查询SOC与对应的中文翻译
            JSONObject ptAllData = mongoTemplate.findOne(new Query(Criteria.where("pt_en").is(key.get(0))), JSONObject.class, "pt_all_data");
            json.put("soc", "");
            json.put("en", key.get(0));
            json.put("zh", "");
            //json.put("sum", value);
            if (ptAllData != null) {
                String mainSocOrgan = ptAllData.getString("main_soc_organ");
                if (StringUtils.isNotBlank(mainSocOrgan)) {
                    json.put("soc", mainSocOrgan);
                }
                String ptCh = ptAllData.getString("pt_ch");
                if (StringUtils.isNotBlank(ptCh)) {
                    json.put("zh", ptCh);
                }
            }
            //是这个药且有当前不良反应的病例数
            long a = entry.getValue();
            json.put("num", a);
            //是这个药但没这个不良反应的病例数
            long b = totalHits - a;
            BoolQueryBuilder innerBoolQueryBuilder = QueryBuilders.boolQuery();
            innerBoolQueryBuilder.mustNot().add(adverseQuery);
            innerBoolQueryBuilder.must().add(QueryBuilders.termsQuery("ptList.keyword", key));
            NativeSearchQuery cQuery = new NativeSearchQuery(innerBoolQueryBuilder);
            cQuery.setTrackTotalHits(true);
            //不是这个药但是有这个不良反应的病例数
            long c = elasticsearchRestTemplate.count(cQuery, AdverseIndex.class);
            //不是这个药也不是这个不良反应的病例数
            long d = count - c;
            json.put("ror", "");
            json.put("ebgm", "");
            json.put("ic", "");
            json.put("typical", false);
            String calculate = calculateAdverseFeign.calculate(String.valueOf(a), String.valueOf(b), String.valueOf(c), String.valueOf(d));
            if (StringUtils.isNotBlank(calculate)) {
                JSONObject jsonObject = JSONObject.parseObject(calculate);
                Integer integer = jsonObject.getInteger("result");
                if (integer == 1) {
                    try {
                        String ror = String.valueOf(BigDecimal.valueOf(jsonObject.getDouble("ror")).setScale(2, BigDecimal.ROUND_HALF_UP).doubleValue());
                        json.put("ror", ror);
                    } catch (Exception e) {
                        json.put("ror", "Infinity");
                    }
                    try {
                        String ebgm = String.valueOf(BigDecimal.valueOf(jsonObject.getDouble("ebgm")).setScale(2, BigDecimal.ROUND_HALF_UP).doubleValue());
                        json.put("ebgm", ebgm);
                    } catch (Exception e) {
                        json.put("ebgm", "Infinity");
                    }
                    try {
                        String ic = String.valueOf(BigDecimal.valueOf(jsonObject.getDouble("ic")).setScale(2, BigDecimal.ROUND_HALF_UP).doubleValue());
                        json.put("ic", ic);
                    } catch (Exception e) {
                        json.put("ic", "Infinity");
                    }
                    String indicator = jsonObject.getString("indicator");
                    json.put("typical", !"-".equals(indicator));
                }
            }
            //json.put("a", a);
            //json.put("b", b);
            //json.put("c", c);
            //json.put("d", d);
            data.add(json);
        }
        String info = getInfo(condition);
        if (flag) {
            result.put("info", info + "得出以下结论");
            result.put("outcome", true);
            result.put("illustrate", new JSONArray());
            JSONArray illustrate = result.getJSONArray("illustrate");
            String drugInfo = getInfo(condition);
            for (int i = 0; i < data.size(); i++) {
                JSONObject jsonObject = data.getJSONObject(i);
                List<String> list = outComeList.get(i);
                String outComeName = list.get(0);
                Boolean typical = jsonObject.getBoolean("typical");
                illustrate.add(drugInfo + outComeName + (typical ? "属于" : "不属于") + "典型不良反应；");
            }
        } else {
            result.put("info", info + "TOP20典型信号");
            result.put("data", data);
        }
        //总数
        result.put("total", total);
        return result;
    }

    /**
     * 计算典型信号
     *
     * @param condition 检索条件
     * @return 计算后的典型信号信息
     */
    private JSONObject calculateTypicalSignalsForSafe(Condition condition, BoolQueryBuilder adverseQuery) {
        JSONObject result = new JSONObject();
        result.put("outcome", false);
        JSONArray data = new JSONArray();
        //BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, 2, 2, false);

        //假如用户输入的为α药并检索出a药共有123三种不良反应，
        // 对不良反应1来说取 a（是这个药且有1不良反应的病例数）
        // b（是这个药但没这个1不良反应的病例数）
        // c（不是这个药但是有这个不良反应的病例数）
        // d（不是这个药也不是这个不良反应的病例数）
        // 共四个值传给py用模型计算出来的

        //判断用户是否输入了结局指标
        boolean flag = false;
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();
        List<List<String>> outComeList = new ArrayList<>();
        if (outcomes != null) {
            for (InterventionAndOutcome outcome : outcomes) {
                Integer status = outcome.getStatus();
                if (status == 1) {
                    List<String> inner = new ArrayList<>();
                    String word = outcome.getWord();
                    if (StringUtils.isNotBlank(word)) {
                        inner.add(word);
                    }
                    String enWord = outcome.getEnWord();
                    if (StringUtils.isNotBlank(enWord)) {
                        inner.add(enWord);
                    }
                    String zhWord = outcome.getZhWord();
                    if (StringUtils.isNotBlank(zhWord)) {
                        inner.add(zhWord);
                    }
                    List<WordStatus> enSynonym = outcome.getEnSynonym();
                    if (CollectionUtils.isNotEmpty(enSynonym)) {
                        for (WordStatus wordStatus : enSynonym) {
                            Boolean checked = wordStatus.getChecked();
                            if (checked) {
                                inner.add(wordStatus.getName());
                            }
                        }
                    }
                    List<WordStatus> zhSynonym = outcome.getZhSynonym();
                    if (CollectionUtils.isNotEmpty(zhSynonym)) {
                        for (WordStatus wordStatus : zhSynonym) {
                            Boolean checked = wordStatus.getChecked();
                            if (checked) {
                                inner.add(wordStatus.getName());
                            }
                        }
                    }
                    //补充同义词
                    String expandSynonym = outcome.getExpandSynonym();
                    if (StringUtils.isNotBlank(expandSynonym)) {
                        expandSynonym = expandSynonym.replaceAll("；", ";");
                        String[] split = expandSynonym.split(";");
                        for (String txt : split) {
                            if (StringUtils.isNotBlank(txt)) {
                                inner.add(txt.toLowerCase());
                            }
                        }
                    }
                    outComeList.add(inner);
                }
            }
        }
        if (CollectionUtils.isNotEmpty(outComeList)) {
            flag = true;
        }
        //取top20的不良反应
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("ptList").field("ptList.keyword").size(50);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        //聚合sum drugName总数
        //SumAggregationBuilder field = AggregationBuilders.sum("sum").field("num");
        //nativeSearchQuery.addAggregation(field);
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        long totalHits = search.getTotalHits();
        Aggregations aggregations = search.getAggregations();
        Map<List<String>, Long> top20Map = new HashMap<>();
        //double value = 0;
        if (!flag) {
            if (aggregations != null) {
                Aggregation aggregation = aggregations.get("ptList");
                List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
                for (Terms.Bucket bucket : buckets) {
                    String key = bucket.getKey().toString();
                    long docCount = bucket.getDocCount();
                    top20Map.put(Collections.singletonList(key), docCount);
                }
                //计算原始总数
                //Sum sumAggregation = aggregations.get("sum");
                //value = sumAggregation.getValue();
            }
        } else {
            for (List<String> list : outComeList) {
                BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
                boolQueryBuilder.must().add(adverseQuery);
                boolQueryBuilder.must().add(QueryBuilders.termsQuery("pt.keyword", list));
                NativeSearchQuery inner = new NativeSearchQuery(boolQueryBuilder);
                inner.setTrackTotalHits(true);
                inner.setPageable(PageRequest.of(0, 1));
                long count = elasticsearchRestTemplate.count(nativeSearchQuery, AdverseIndex.class);
                top20Map.put(list, count);
            }
        }
        //不是这个药但是有这个不良反应的病例数
        BoolQueryBuilder boolQueryBuilder = QueryBuilders.boolQuery();
        boolQueryBuilder.mustNot().add(adverseQuery);
        NativeSearchQuery allQuery = new NativeSearchQuery(boolQueryBuilder);
        allQuery.setTrackTotalHits(true);
        //不是这个药的报告总数即 c + d
        long count = elasticsearchRestTemplate.count(allQuery, AdverseIndex.class);
        Set<Entry<List<String>, Long>> entries = top20Map.entrySet();
        for (Entry<List<String>, Long> entry : entries) {
            JSONObject json = new JSONObject();
            List<String> key = entry.getKey();
            //查询SOC与对应的中文翻译
            JSONObject ptAllData = mongoTemplate.findOne(new Query(Criteria.where("pt_en").is(key.get(0))), JSONObject.class, "pt_all_data");
            json.put("soc", "");
            json.put("en", key.get(0));
            json.put("zh", "");
            //json.put("sum", value);
            if (ptAllData != null) {
                String mainSocOrgan = ptAllData.getString("main_soc_organ");
                if (StringUtils.isNotBlank(mainSocOrgan)) {
                    json.put("soc", mainSocOrgan);
                }
                String ptCh = ptAllData.getString("pt_ch");
                if (StringUtils.isNotBlank(ptCh)) {
                    json.put("zh", ptCh);
                }
            }
            //是这个药且有当前不良反应的病例数
            long a = entry.getValue();
            json.put("num", a);
            //是这个药但没这个不良反应的病例数
            long b = totalHits - a;
            BoolQueryBuilder innerBoolQueryBuilder = QueryBuilders.boolQuery();
            innerBoolQueryBuilder.mustNot().add(adverseQuery);
            innerBoolQueryBuilder.must().add(QueryBuilders.termsQuery("ptList.keyword", key));
            NativeSearchQuery cQuery = new NativeSearchQuery(innerBoolQueryBuilder);
            cQuery.setTrackTotalHits(true);
            //不是这个药但是有这个不良反应的病例数
            long c = elasticsearchRestTemplate.count(cQuery, AdverseIndex.class);
            //不是这个药也不是这个不良反应的病例数
            long d = count - c;
            json.put("ror", "");
            json.put("ebgm", "");
            json.put("ic", "");
            json.put("typical", false);
            String calculate = calculateAdverseFeign.calculate(String.valueOf(a), String.valueOf(b), String.valueOf(c), String.valueOf(d));
            if (StringUtils.isNotBlank(calculate)) {
                JSONObject jsonObject = JSONObject.parseObject(calculate);
                Integer integer = jsonObject.getInteger("result");
                if (integer == 1) {
                    try {
                        String ror = String.valueOf(BigDecimal.valueOf(jsonObject.getDouble("ror")).setScale(3, BigDecimal.ROUND_HALF_UP).doubleValue());
                        json.put("ror", ror);
                    } catch (Exception e) {
                        json.put("ror", "Infinity");
                    }
                    try {
                        String ebgm = String.valueOf(BigDecimal.valueOf(jsonObject.getDouble("ebgm")).setScale(3, BigDecimal.ROUND_HALF_UP).doubleValue());
                        json.put("ebgm", ebgm);
                    } catch (Exception e) {
                        json.put("ebgm", "Infinity");
                    }
                    try {
                        String ic = String.valueOf(BigDecimal.valueOf(jsonObject.getDouble("ic")).setScale(3, BigDecimal.ROUND_HALF_UP).doubleValue());
                        json.put("ic", ic);
                    } catch (Exception e) {
                        json.put("ic", "Infinity");
                    }
                    String indicator = jsonObject.getString("indicator");
                    json.put("typical", !"-".equals(indicator));
                }
            }
            //json.put("a", a);
            //json.put("b", b);
            //json.put("c", c);
            //json.put("d", d);
            data.add(json);
        }
        String info = getInfo(condition);
        if (flag) {
            result.put("info", info + "得出以下结论");
            result.put("outcome", true);
            result.put("illustrate", new JSONArray());
            JSONArray illustrate = result.getJSONArray("illustrate");
            String drugInfo = getInfo(condition);
            for (int i = 0; i < data.size(); i++) {
                JSONObject jsonObject = data.getJSONObject(i);
                List<String> list = outComeList.get(i);
                String outComeName = list.get(0);
                Boolean typical = jsonObject.getBoolean("typical");
                illustrate.add(drugInfo + outComeName + (typical ? "属于" : "不属于") + "典型不良反应；");
            }
        } else {
            result.put("info", info + "TOP20典型信号");
            result.put("data", data);
        }
        return result;
    }


    private List<Adrs> getAdrs(List<String> drugs) {
        //测试环境
        Criteria criteria = new Criteria().orOperator(
                Criteria.where("drugName").in(drugs)
        );
        Criteria countCriteria = Criteria.where("count").gt(3);
        Criteria countCriteria2 = Criteria.where("indicator").is("+");
        Criteria finalCriteria = new Criteria().andOperator(
                Criteria.where("database").is("fda"),
                criteria,
                countCriteria,
                countCriteria2
        );
        Sort sort = Sort.by(Sort.Direction.DESC, "ic");
        List<Adrs> adrsx = ReleaseMongoUtil.mongo.find(new Query(finalCriteria).with(sort).limit(80), Adrs.class);
        HashSet<Adrs> adrs = new HashSet<>(adrsx);
        ArrayList<String> strings = new ArrayList<>();
        for (Adrs adrs1 : adrs) {
            strings.add(adrs1.getEn());
        }
        List<JSONObject> jsonObjects = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("pt_en").in(strings)), JSONObject.class, "pt_all_data");
        List<JSONObject> jsonObjects1 = ReleaseMongoUtil.mongo.find(new Query(Criteria.where("adrs_en").in(strings)), JSONObject.class, "fears_vigi_adrs");
        for (JSONObject jsonObject : jsonObjects) {
            String en = jsonObject.getString("pt_en");
            for (Adrs adrs1 : adrs) {
                if (en.equals(adrs1.getEn())) {
                    adrs1.setSoc(jsonObject.getString("main_soc_organ"));
                }
            }
        }
        for (JSONObject jsonObject : jsonObjects1) {
            String en = jsonObject.getString("adrs_en");
            for (Adrs adrs1 : adrs) {
                if (en.equals(adrs1.getEn())) {
                    adrs1.setZh(jsonObject.getString("adrs_ch"));
                }
            }
        }
        ArrayList<Adrs> adrs1 = new ArrayList<>(adrs);
        adrs1.sort(Comparator.comparing(Adrs::getIc, (ic1Str, ic2Str) -> {
            try {
                double ic1 = Double.parseDouble(ic1Str);
                double ic2 = Double.parseDouble(ic2Str);
                return Double.compare(ic1, ic2);
            } catch (NumberFormatException e) {
                return 0; // 或者根据需要抛出异常/返回特定值
            }
        }));
        return adrs1.subList(0, adrs1.size() > 50 ? 50 : adrs1.size());

    }

    /**
     * 计算严重不良反应
     *
     * @param condition 检索条件
     * @return 严重不良反应的柱状图
     */
    private JSONArray seriousAdverse(Condition condition) {
        JSONArray result = new JSONArray();
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, 2, 2, true);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("outcomeCod").field("outcomeCod").size(10);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        Aggregations aggregations = search.getAggregations();
        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("outcomeCod");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                JSONObject inner = new JSONObject();
                String key = bucket.getKey().toString();
                if (StringUtils.isBlank(key)) {
                    continue;
                }
                long docCount = bucket.getDocCount();
                inner.put("name", key);
                inner.put("num", docCount);
                result.add(inner);
            }
        }
        return result;
    }

    /**
     * 计算不良反应数据
     *
     * @param condition 检索条件
     * @return 不良反应列表
     */
    private JSONArray adverse(Condition condition) {
        JSONArray result = new JSONArray();
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, 2, 2, true);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("ptList").field("ptList.keyword").size(10);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        //聚合计算ptList的总数
        nativeSearchQuery.addAggregation(AggregationBuilders.sum("ptListNum").field("ptListNum"));
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        Aggregations aggregations = search.getAggregations();
        if (aggregations != null) {
            //ptListNum
            ParsedSum ptListNum = aggregations.get("ptListNum");
            double ptTotal = ptListNum.getValue();
            Aggregation aggregation = aggregations.get("ptList");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (int i = 0; i < buckets.size(); i++) {
                Terms.Bucket bucket = buckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(ptTotal), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                JSONObject ptAllData = mongoTemplate.findOne(new Query(Criteria.where("pt_en").is(key)), JSONObject.class, "pt_all_data");
                String ptCh = "";
                if (ptAllData != null) {
                    ptCh = ptAllData.getString("pt_ch");
                } else if ("unknown".equals(key)) {
                    ptCh = "未知";
                }
                array.add(ptCh);
                result.add(array);
            }
        }
        return result;
    }

    /**
     * 根据检索条件获取模板数据  在XX（药名）治疗XX（病名）
     *
     * @param condition 检索条件
     * @return 模板数据
     */
    private String getInfo(Condition condition) {
        StringBuilder info = new StringBuilder();
        List<Drug> drugs = condition.getDrugs();
        if (drugs.size() > 1) {
            info.append("在");
        }
        if (CollectionUtils.isNotEmpty(drugs)) {
            for (Drug drug : drugs) {
                Integer status = drug.getStatus();
                if (status == 1) {
                    info.append(drug.getWord());
                } else if (status == 2) {
                    //与
                    info.append("联合");
                } else {
                    //非
                    info.append("排除");
                }
            }
        }
        List<Disease> diseases = condition.getDiseases();
        if (CollectionUtils.isNotEmpty(diseases)) {
            info.append("治疗");
            for (Disease disease : diseases) {
                Integer status = disease.getStatus();
                if (status == 1) {
                    info.append(disease.getWord());
                } else if (status == 2) {
                    //与
                    info.append("合并");
                } else {
                    //非
                    info.append("排除");
                }
            }
        }
        info.append("的所有上报数据中，");
        return info.toString();
    }

    /**
     * 拼接政策查询相关检索语句
     *
     * @param id 检索id
     * @return 拼接后的检索语句
     */
    private Criteria createPolicyCriteria(String id) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null) {
            throw new RuntimeException("检索id异常");
        }
        StringBuilder query = new StringBuilder();
        List<Drug> drugs = condition.getDrugs();
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();
        JSONArray array = new JSONArray();
        array.add(drugs);
        if (CollectionUtils.isNotEmpty(outcomes)) {
            array.add(outcomes);
        }
        
        StringBuilder inner = new StringBuilder();
        inner.append("(");
        
        for (int i = 0; i < array.size(); i++) {
            JSONArray innerArr = array.getJSONArray(i);
            if (CollectionUtils.isNotEmpty(innerArr)) {
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject json = innerArr.getJSONObject(i1);
                    Integer status = json.getInteger("status");
                    if (status == 1) {
                        Set<String> set = new HashSet<>();
                        String word = json.getString("word").toLowerCase();
                        set.add(word);
                        String enWord = json.getString("enWord");
                        if (StringUtils.isNotBlank(enWord)) {
                            set.add(enWord.toLowerCase());
                        }
                        JSONArray enSynonym = json.getJSONArray("enSynonym");
                        if (CollectionUtils.isNotEmpty(enSynonym)) {
                            for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(jsonObject.getString("name"));
                                }
                            }
                        }
                        String zhWord = json.getString("zhWord");
                        if (StringUtils.isNotBlank(zhWord)) {
                            set.add(zhWord.toLowerCase());
                        }
                        JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                        if (CollectionUtils.isNotEmpty(zhSynonym)) {
                            for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(jsonObject.getString("name"));
                                }
                            }
                        }
                        //补充同义词
                        String expandSynonym = json.getString("expandSynonym");
                        expandSynonym = expandSynonym.replaceAll("；", ";");
                        String[] split = expandSynonym.split(";");
                        for (String txt : split) {
                            if (StringUtils.isNotBlank(txt)) {
                                set.add(txt.toLowerCase());
                            }
                        }
                        //开始拼接检索条件
                        List<String> searchWord = new ArrayList<>(set);
                        
                        for (int i2 = 0; i2 < searchWord.size() - 1; i2++) {
                            String s = searchWord.get(i2).replaceAll("\\(", "").replaceAll("\\)", "");
                            inner.append(s).append("|");
                        }
                        String s = searchWord.get(searchWord.size() - 1).replaceAll("\\(", "").replaceAll("\\)", "");
                        inner.append(s);
                    }
                }
            }
        }
        inner.append(")");
//        query.append("(?=.*").append(inner).append(")");
        query.append(inner);
        return new Criteria().orOperator(Criteria.where("synopsis").regex(query.toString(), "i"), Criteria.where("title").regex(query.toString(), "i"));
    }


    /**
     * 拼接药品 如 二甲双胍联合二甲苯
     */
    private void assembleDrug(List<Drug> drugs, List<Drug> drugAnd, List<Drug> drugNot) {
        if (CollUtil.isEmpty(drugs)) return;
        boolean isRejected = false;
        for (Drug drug : drugs) {
            if (drug.getStatus() == 1) {
                if (!isRejected) {
                    drugAnd.add(drug);
                } else {
                    drugNot.add(drug);
                    isRejected = false;
                }
            }
            if (drug.getStatus() == 2) {
                continue;
            }
            if (drug.getStatus() == 3) {
                isRejected = true;
            }
        }
    }
}
