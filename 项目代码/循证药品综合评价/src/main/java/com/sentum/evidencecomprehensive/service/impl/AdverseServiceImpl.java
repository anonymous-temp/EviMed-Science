package com.sentum.evidencecomprehensive.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.*;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.es.AdverseForCaseIndex;
import com.sentum.evidencecomprehensive.domain.es.AdverseIndex;
import com.sentum.evidencecomprehensive.domain.mongo.ClinicalTrialRegistration;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.domain.mongo.MedicineInfo;
import com.sentum.evidencecomprehensive.domain.mongo.MedicineInstructionUse;
import com.sentum.evidencecomprehensive.feign.CalculateAdverseFeign;
import com.sentum.evidencecomprehensive.domain.dto.DrugFormatDataBo;
import com.sentum.evidencecomprehensive.domain.vo.req.SafeInfoRequest;
import com.sentum.evidencecomprehensive.domain.dto.Disease;
import com.sentum.evidencecomprehensive.domain.dto.Drug;
import com.sentum.evidencecomprehensive.domain.dto.InterventionAndOutcome;
import com.sentum.evidencecomprehensive.domain.dto.WordStatus;
import com.sentum.evidencecomprehensive.feign.MedicineFeign;
import com.sentum.evidencecomprehensive.service.AdverseService;
import com.sentum.evidencecomprehensive.service.ClinicalTrialsService;
import com.sentum.evidencecomprehensive.utils.*;
import com.sentum.evidencecomprehensive.utils.operateyl.DefaultIncludeUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.RedisUtils;
import com.sentum.evidencecomprehensive.utils.operateyl.RetryUtils;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.apache.lucene.search.join.ScoreMode;
import org.elasticsearch.index.query.*;
import org.elasticsearch.search.aggregations.Aggregation;
import org.elasticsearch.search.aggregations.AggregationBuilders;
import org.elasticsearch.search.aggregations.Aggregations;
import org.elasticsearch.search.aggregations.bucket.terms.ParsedTerms;
import org.elasticsearch.search.aggregations.bucket.terms.Terms;
import org.elasticsearch.search.aggregations.bucket.terms.TermsAggregationBuilder;
import org.elasticsearch.search.aggregations.metrics.ParsedSum;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

@Slf4j
@Service
public class AdverseServiceImpl implements AdverseService {
    
    @Autowired
    private MongoTemplate mongoTemplate;
    @Autowired
    private ElasticsearchRestTemplate elasticsearchRestTemplate;
    @Autowired
    private ClinicalTrialsService clinicalTrialsService;
    @Autowired
    private DefaultIncludeUtils defaultIncludeUtils;
    @Autowired
    private CalculateAdverseFeign calculateAdverseFeign;
    @Autowired
    private MedicineFeign medicineFeign;
    
    @Override
    public JSONObject info(String id) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        
        List<Drug> drugs = condition.getDrugs();
        List<Drug> drugAnd = new ArrayList<>();
        List<Drug> drugNot = new ArrayList<>();
        assembleDrug(drugs, drugAnd, drugNot);
        // 返回结果
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
        String requestForDrugSafeInfoZx = "";
        try {
            requestForDrugSafeInfoZx = defaultIncludeUtils.getRequestForDrugSafeInfoZx(condition);
        } catch (Exception e) {
            log.error(e.getMessage(), e);
            try {
                Thread.sleep(1000);
                requestForDrugSafeInfoZx = defaultIncludeUtils.getRequestForDrugSafeInfoZx(condition);
            } catch (Exception e1) {
                log.error(e1.getMessage(), e1);
                try {
                    Thread.sleep(1000);
                    requestForDrugSafeInfoZx = defaultIncludeUtils.getRequestForDrugSafeInfoZx(condition);
                } catch (Exception e2) {
                    log.error(e2.getMessage(), e2);
                }
            }
        }
        if (StrUtil.isNotBlank(requestForDrugSafeInfoZx)) {
            JSONObject drugSafeInfoZx = JSON.parseObject(requestForDrugSafeInfoZx, JSONObject.class);
            
            // 严重不良反应
            JSONArray outc_cod_list = drugSafeInfoZx.getJSONArray("outc_cod_list");
            if (CollUtil.isNotEmpty(outc_cod_list)) {
                JSONArray seriousAdverse = new JSONArray();
                outc_cod_list.forEach(o -> {
                    JSONArray array = JSONArray.parseArray(JSON.toJSONString(o));
                    //List list = JSON.parseObject(JSON.toJSONString(o), new TypeReference<List>() {});
                    JSONObject innerJson = new JSONObject();
                    innerJson.put("num", array.get(2));
                    innerJson.put("name", array.get(1));
                    seriousAdverse.add(innerJson);
                });
                result.getJSONObject("adverse").put("seriousAdverse", seriousAdverse);
            }
            // 适应症
            JSONArray indi_pt_list = drugSafeInfoZx.getJSONArray("indi_pt_list");
            JSONArray indi_pt_list_result = new JSONArray();
            if (CollUtil.isNotEmpty(indi_pt_list)) {
                for (Object o : indi_pt_list) {
                    JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                    indi_pt_list_result.add(jsonArray);
                }
                if (indi_pt_list.size() > 20) {
                    result.getJSONObject("adverse").put("adverse", indi_pt_list.subList(0, 20));
                } else {
                    result.getJSONObject("adverse").put("adverse", indi_pt_list_result);
                }
            }

            // 不良反应
            JSONArray ptList = drugSafeInfoZx.getJSONArray("pt_list");
            JSONArray ptList_result = new JSONArray();
            if (Objects.nonNull(ptList)) {
                for (Object o : ptList) {
                    JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(o), JSONArray.class);
                    ptList_result.add(jsonArray);
                    if (ptList_result.size() == 20) {
                        break;
                    }            
                }
                result.getJSONObject("adverse").put("ptList", ptList_result);
            } else {
                result.getJSONObject("adverse").put("ptList", new JSONArray());
            }

            // 典型信号
            JSONObject signal_dict = drugSafeInfoZx.getJSONObject("signal_dict");
            if (Objects.nonNull(signal_dict) && Objects.nonNull(signal_dict.getJSONObject("data"))) {
                JSONObject data = signal_dict.getJSONObject("data");
                JSONArray resultJSON = new JSONArray();
                Map<String, List> entryMaps = JSON.parseObject(JSON.toJSONString(data), new TypeReference<Map<String, List>>() {});
                for (Map.Entry<String, List> innerEntry : entryMaps.entrySet()) {
                    String soc = innerEntry.getKey();
                    List value = innerEntry.getValue();
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
                List<Object> ic = resultJSON.stream().sorted(Comparator.comparing(o -> Double.parseDouble(JSON.parseObject(JSON.toJSONString(o), JSONObject.class).getString("ror")), Comparator.reverseOrder())).collect(Collectors.toList());
                if (ic.size() > 20) {
                    ic = ic.subList(0, 20);
                }
                JSONArray jsonArray = JSON.parseObject(JSON.toJSONString(ic), JSONArray.class);
                JSONObject calculateTypicalSignals = new JSONObject();
                calculateTypicalSignals.put("data", jsonArray);
                calculateTypicalSignals.put("info", "");
                //calculateTypicalSignals.put("total", signal_dict.getInteger("total"));
                calculateTypicalSignals.put("total", signal_dict.getInteger("psTotal"));
                calculateTypicalSignals.put("outcome", signal_dict.getBoolean("outcome"));
                result.getJSONObject("adverse").put("calculateTypicalSignals", calculateTypicalSignals);
            }
        }
       
        //临床试验相关信息
        result.put("clinicalTrials", new JSONArray());
        List<ClinicalTrialRegistration> infoForAdverse = clinicalTrialsService.getInfoForAdverse(id);
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
            if (CollUtil.isNotEmpty(intervention)) {
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
                if (CollUtil.isNotEmpty(seriousAdverseEvents)) {
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
                if (CollUtil.isNotEmpty(adverseEventsJSONArray)) {
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

    public void searchFullInstruction(JSONArray instruction, List<Drug> drugAnd) {
        // 用药助手说明书数据
        for (Drug drug : drugAnd) {
            Integer status = drug.getStatus();
            if (status == 1) {
                String word = drug.getWord();
                if (StrUtil.isBlank(word)) {
                    continue;
                }

                String xunZhengDrugInfo = "xunzheng:report:" + word;
                JSONObject redisDrugInfoObj = JSON.parseObject(RedisUtils.getStr(xunZhengDrugInfo));
                
                if (Objects.isNull(redisDrugInfoObj)) {
                    JSONObject drugInfoObj = new JSONObject();
                    // 用药助手数据
                    Query query = new Query();
                    query.addCriteria(Criteria.where("drugName").is(word));
                    List<MedicineInfo> medicineInfos = ReleaseMongoUtil.mongo.find(query, MedicineInfo.class);
                    MedicineInfo medicineInfo = null;
                    if (CollUtil.isNotEmpty(medicineInfos)) {
                        medicineInfo = medicineInfos.get(0);
                    }

                    // 用药助手说明书数据
                    Query queryInstruction = new Query();
                    List<Criteria> orCriteriaList = new ArrayList<>();
//                    orCriteriaList.add(Criteria.where("innName").regex(word, "i"));
                    orCriteriaList.add(Criteria.where("innName").is(word));
                    orCriteriaList.add(Criteria.where("commonName").is(word));
                    queryInstruction.addCriteria(new Criteria().orOperator(orCriteriaList.toArray(new Criteria[0])));
                    queryInstruction.limit(3);
                    List<MedicineInstructionUse> medicineInstructionUses = ReleaseMongoUtil.mongo.find(queryInstruction, MedicineInstructionUse.class);
                    int maxInstructionDataFlag = 0;
                    String instructionUseMongoId = "";
                    if (CollUtil.isNotEmpty(medicineInstructionUses)) {
                        for (MedicineInstructionUse medicineInstructionUse : medicineInstructionUses) {
                            int numData = 0;
                            //禁忌
                            List<DrugFormatDataBo> tabooInd = medicineInstructionUse.getContraindications();
                            if (CollUtil.isNotEmpty(tabooInd)) {
                                numData++;
                            }
                            //妇女
                            List<DrugFormatDataBo> pregnantWomenInd = medicineInstructionUse.getUseInPregLact();
                            if (CollUtil.isNotEmpty(pregnantWomenInd)) {
                                numData++;
                            }
                            //儿童用药
                            List<DrugFormatDataBo> childrenMedicineInd = medicineInstructionUse.getUseInChildren();
                            if (CollUtil.isNotEmpty(childrenMedicineInd)) {
                                numData++;
                            }
                            //老年用药
                            List<DrugFormatDataBo> geriatricMedicineInd = medicineInstructionUse.getUseInElderly();
                            if (CollUtil.isNotEmpty(geriatricMedicineInd)) {
                                numData++;
                            }
                            //用法用量
                            List<DrugFormatDataBo> usageAndDosageInd = medicineInstructionUse.getDosage();
                            if (CollUtil.isNotEmpty(usageAndDosageInd)) {
                                numData++;
                            }
                            //不良反应
                            List<DrugFormatDataBo> adverseReactionInd = medicineInstructionUse.getAdverseReactions();
                            if (CollUtil.isNotEmpty(adverseReactionInd)) {
                                numData++;
                            }
                            //适应症
                            List<DrugFormatDataBo> indicationsInd = medicineInstructionUse.getIndication();
                            if (CollUtil.isNotEmpty(indicationsInd)) {
                                numData++;
                            }
                            //注意事项 notes
                            List<DrugFormatDataBo> notes = medicineInstructionUse.getPrecautions();
                            if (CollUtil.isNotEmpty(notes)) {
                                numData++;
                            }
                            //相互作用
                            List<DrugFormatDataBo> interaction = medicineInstructionUse.getDrugInteractions();
                            if (CollUtil.isNotEmpty(interaction)) {
                                numData++;
                            }
                            // 药理作用
                            List<DrugFormatDataBo> pharmacology = medicineInstructionUse.getMechanismAction();
                            if (CollUtil.isNotEmpty(pharmacology)) {
                                numData++;
                            }
                            // 药代动力学
                            List<DrugFormatDataBo> pharmacokinetics = medicineInstructionUse.getPharmacokinetics();
                            if (CollUtil.isNotEmpty(pharmacokinetics)) {
                                numData++;
                            }
                            //黑框警告
                            List<DrugFormatDataBo> warning = medicineInstructionUse.getDrugWarning();
                            if (CollUtil.isNotEmpty(warning)) {
                                numData++;
                            }
                            //贮藏
                            List<DrugFormatDataBo> storage = medicineInstructionUse.getStorage();
                            if (CollUtil.isNotEmpty(storage)) {
                                numData++;
                            }
                            if (maxInstructionDataFlag < numData) {
                                maxInstructionDataFlag = numData;
                                instructionUseMongoId = medicineInstructionUse.getId();
                            }
                        }
                    }
                    MedicineInstructionUse medicineInstructionUse = ReleaseMongoUtil.mongo.findById(instructionUseMongoId, MedicineInstructionUse.class);
                    
                    drugInfoObj.put("name", word);

                    if (Objects.nonNull(medicineInstructionUse)) {
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getIndication())) {
                            drugInfoObj.put("indications", medicineInstructionUse.getIndication());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getDosage())) {
                            drugInfoObj.put("usageAndDosage", medicineInstructionUse.getDosage());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getMechanismAction())) {
                            drugInfoObj.put("pharmacology", medicineInstructionUse.getMechanismAction());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getPharmacokinetics())) {
                            drugInfoObj.put("pharmacokinetics", medicineInstructionUse.getPharmacokinetics());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getUseInChildren())) {
                            drugInfoObj.put("children", medicineInstructionUse.getUseInChildren());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getUseInElderly())) {
                            drugInfoObj.put("geriatric", medicineInstructionUse.getUseInElderly());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getUseInPregLact())) {
                            drugInfoObj.put("pregnantWomen", medicineInstructionUse.getUseInPregLact());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getAdverseReactions())) {
                            drugInfoObj.put("adverse", medicineInstructionUse.getAdverseReactions());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getDrugWarning())) {
                            drugInfoObj.put("warning", medicineInstructionUse.getDrugWarning());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getPrecautions())) {
                            drugInfoObj.put("notes", medicineInstructionUse.getPrecautions());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getContraindications())) {
                            drugInfoObj.put("taboo", medicineInstructionUse.getContraindications());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getStorage())) {
                            drugInfoObj.put("storage", medicineInstructionUse.getStorage());
                        }
                        if (CollUtil.isNotEmpty(medicineInstructionUse.getDrugInteractions())) {
//                            drugInfoObj.put("interaction", medicineInstructionUse.getDrugInteractions());
                            drugInfoObj.put("adverseReaction", medicineInstructionUse.getDrugInteractions());
                        }
                    }
                    
                    if (Objects.nonNull(medicineInfo)) {
                        if (CollUtil.isNotEmpty(medicineInfo.getNotes())) {
                            drugInfoObj.put("notes", medicineInfo.getNotes());
                        }
                        
                        if (CollUtil.isNotEmpty(medicineInfo.getIndicationsDosage())) {
                            drugInfoObj.put("type", 1);
                            drugInfoObj.put("indicationsDosage", medicineInfo.getIndicationsDosage());
                        }
                        
                        if (CollUtil.isNotEmpty(medicineInfo.getPharmacology())) {
                            drugInfoObj.put("pharmacology", medicineInfo.getPharmacology());
                        }
                        
                        if (CollUtil.isNotEmpty(medicineInfo.getPharmacokinetics())) {
                            drugInfoObj.put("pharmacokinetics", medicineInfo.getPharmacokinetics());
                        }   
                        
                        if (CollUtil.isNotEmpty(medicineInfo.getWarning())) {
                            drugInfoObj.put("warning", medicineInfo.getWarning());
                        }
                        
                        if (CollUtil.isNotEmpty(medicineInfo.getChildren())) {
                            drugInfoObj.put("children", medicineInfo.getChildren());
                        }
                        
                        if (CollUtil.isNotEmpty(medicineInfo.getTaboo())) {
                            drugInfoObj.put("taboo", medicineInfo.getTaboo());
                        }
                        
                        if (CollUtil.isNotEmpty(medicineInfo.getStorage())) {
                            drugInfoObj.put("storage", medicineInfo.getStorage());
                        }

                        if (CollUtil.isNotEmpty(medicineInfo.getAdverseReaction())) {
                            drugInfoObj.put("adverse", medicineInfo.getAdverseReaction());
                        }
                        
                        // 妊娠期&哺乳期
                        List<DrugFormatDataBo> medication = new ArrayList<>();
                        List<DrugFormatDataBo> medicationDuringLactation = medicineInfo.getMedicationDuringLactation();
                        List<DrugFormatDataBo> medicationDuringPregnancy = medicineInfo.getMedicationDuringPregnancy();
                        if (CollUtil.isNotEmpty(medicationDuringLactation)) {
                            medication.addAll(medicationDuringLactation);
                        }
                        if (CollUtil.isNotEmpty(medicationDuringPregnancy)) {
                            medication.addAll(medicationDuringPregnancy);
                        }
                        drugInfoObj.put("pregnantWomen", medication);
                    }
                    // 说明书信息补全
                    instructionInfoComplemented(drugInfoObj);
                    RedisUtils.set(xunZhengDrugInfo, JSON.toJSONString(drugInfoObj), 60 * 60 * 6, TimeUnit.SECONDS);
                }
                redisDrugInfoObj = JSON.parseObject(RedisUtils.getStr(xunZhengDrugInfo));
                if (Objects.nonNull(redisDrugInfoObj)) {
                    instruction.add(redisDrugInfoObj);
                }
            }
        }
    }

    private void instructionInfoComplemented(JSONObject drugInfoObj) {
        String drugName = drugInfoObj.getString("name");

        JSONObject result = new JSONObject();

        String question_1 = "请你作为一名专业的临床药理学专家，根据提供的药品进行深度搜索和分析。" +
                "\n\n## 任务要求：" +
                "\n分析以下药品的完整信息并进行总结：" +
                "\n- 药理作用（作用机制、药效学）" +
                "\n- 药代动力学" +
                "\n- 适应证" +
                "\n- 用法用量" +
                "\n- 禁忌" +
                "\n- 注意事项" +
                "\n- 不良反应" +
                "\n- 贮藏条件" +
                "\n- 药物相互作用" +
                "\n\n## 检索优先级：" +
                "\n1. 优先使用药品说明书中的信息" +
                "\n2. 参考学术期刊和医学研究文章" +
                "\n3. 补充专业医疗网站信息（如WebMD、MedlinePlus等）" +
                "\n\n## 输出格式要求：" +
                "\n1. 必须严格按照JSON格式返回" +
                "\n2. 使用中文回答" +
                "\n3. 返回格式如下：" +
                "\n```json" +
                "\n{" +
                "\n  \"result\": {" +
                "\n    \"pharmacology\": \"药理作用总结内容\"," +
                "\n    \"pharmacokinetics\": \"药代动力学总结内容\"," +
                "\n    \"indications\": \"适应证总结内容\"," +
                "\n    \"usageAndDosage\": \"用法用量总结内容\"," +
                "\n    \"taboo\": \"禁忌总结内容\"," +
                "\n    \"notes\": \"注意事项总结内容\"," +
                "\n    \"adverse\": \"不良反应总结内容\"," +
                "\n    \"storage\": \"贮藏总结内容\"," +
                "\n    \"adverseReaction\": \"药物相互作用总结内容\"" +
                "\n  }" +
                "\n}" +
                "\n```" +
                "\n\n## 注意事项：" +
                "\n- 内容如需分段可使用\\n进行换行" +
                "\n- 确保返回内容为有效的JSON格式" +
                "\n- 每个字段内容应详细且准确" +
                "\n\n请分析以下药品：{" + drugName + "}";
        try {
            String resultAs = RetryUtils.executeWithRetry(question_1, Constants.QWEN3_235B_A22B_INSTRUCT_2507, String.class, "说明书信息补全");
            if (StrUtil.isNotBlank(resultAs)) {
                int start = resultAs.indexOf('{');
                int end = resultAs.lastIndexOf('}');
                String subResult = resultAs.substring(start, end + 1);
                JSONObject obj = JSON.parseObject(subResult);
                result = obj.getJSONObject("result");

            }
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }


        // 药理作用
        JSONArray pharmacology = drugInfoObj.getJSONArray("pharmacology");
        if (CollUtil.isEmpty(pharmacology)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(result.getString("pharmacology"));
            drugInfoObj.put("pharmacology", Collections.singletonList(drugFormatDataBo));
        }

        // 药代动力学
        JSONArray pharmacokinetics = drugInfoObj.getJSONArray("pharmacokinetics");
        if (CollUtil.isEmpty(pharmacokinetics)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(result.getString("pharmacokinetics"));
            drugInfoObj.put("pharmacokinetics", Collections.singletonList(drugFormatDataBo));
        }

        // 适应证
        JSONArray indications = drugInfoObj.getJSONArray("indications");
        if (CollUtil.isEmpty(indications)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(result.getString("indications"));
            drugInfoObj.put("indications", Collections.singletonList(drugFormatDataBo));
        }

        // 用法用量
        JSONArray usageAndDosage = drugInfoObj.getJSONArray("usageAndDosage");
        if (CollUtil.isEmpty(usageAndDosage)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(result.getString("usageAndDosage"));
            drugInfoObj.put("usageAndDosage", Collections.singletonList(drugFormatDataBo));
        }

        // 禁忌
        JSONArray taboo = drugInfoObj.getJSONArray("taboo");
        if (CollUtil.isEmpty(taboo)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(result.getString("taboo"));
            drugInfoObj.put("taboo", Collections.singletonList(drugFormatDataBo));
        }

        // 注意事项
        JSONArray notes = drugInfoObj.getJSONArray("notes");
        if (CollUtil.isEmpty(notes)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(result.getString("notes"));
            drugInfoObj.put("notes", Collections.singletonList(drugFormatDataBo));
        }

        // 不良反应
        JSONArray adverse = drugInfoObj.getJSONArray("adverse");
        if (CollUtil.isEmpty(adverse)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(result.getString("adverse"));
            drugInfoObj.put("adverse", Collections.singletonList(drugFormatDataBo));
        }

        // 贮藏
        JSONArray storage = drugInfoObj.getJSONArray("storage");
        if (CollUtil.isEmpty(storage)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(result.getString("storage"));
            drugInfoObj.put("storage", Collections.singletonList(drugFormatDataBo));
        }

        // 相互作用
        JSONArray adverseReaction = drugInfoObj.getJSONArray("adverseReaction");
        if (CollUtil.isEmpty(adverseReaction)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(result.getString("adverseReaction"));
            drugInfoObj.put("adverseReaction", Collections.singletonList(drugFormatDataBo));
        }

        JSONObject specialResult = new JSONObject();
        String question_2 = "请你作为一名专业的临床药理学专家，根据提供的药品进行深度搜索和分析。" +
                "\n\n## 任务要求：" +
                "\n分析以下药品对特殊人群的用药要求和注意事项：" +
                "\n- 儿童用药的特殊要求" +
                "\n- 老年人用药的特殊要求" +
                "\n- 孕妇及哺乳期妇女用药的特殊要求" +
                "\n\n## 检索优先级：" +
                "\n1. 优先使用药品说明书中的特殊人群用药信息" +
                "\n2. 参考学术期刊和医学研究文章" +
                "\n3. 补充专业医疗网站信息（如WebMD、MedlinePlus等）" +
                "\n\n## 输出格式要求：" +
                "\n1. 必须严格按照JSON格式返回" +
                "\n2. 使用中文回答" +
                "\n3. 返回格式如下：" +
                "\n```json" +
                "\n{" +
                "\n  \"result\": {" +
                "\n    \"children\": \"儿童用药方面的特殊要求和注意事项\"," +
                "\n    \"geriatric\": \"老年人用药方面的特殊要求和注意事项\"," +
                "\n    \"pregnantWomen\": \"孕妇及哺乳期妇女用药方面的特殊要求和注意事项\"" +
                "\n  }" +
                "\n}" +
                "\n```" +
                "\n\n## 注意事项：" +
                "\n- 内容如需分段可使用\\n进行换行" +
                "\n- 确保返回内容为有效的JSON格式" +
                "\n- 每个字段应详细说明该人群的用药安全性、剂量调整、禁忌情况等" +
                "\n- 如果某个特殊人群缺乏相关数据，请明确说明" +
                "\n\n请分析以下药品：{" + drugName + "}";
        try {
            String resultAs = RetryUtils.executeWithRetry(question_2, Constants.QWEN3_235B_A22B_INSTRUCT_2507, String.class, "说明书信息补全");
            if (StrUtil.isNotBlank(resultAs)) {
                int start = resultAs.indexOf('{');
                int end = resultAs.lastIndexOf('}');
                String subResult = resultAs.substring(start, end + 1);
                JSONObject obj = JSON.parseObject(subResult);
                specialResult = obj.getJSONObject("result");

            }
        } catch (Exception e) {
            log.error(e.getMessage(), e);
        }

        // 儿童用药
        JSONArray children = drugInfoObj.getJSONArray("children");
        if (CollUtil.isEmpty(children)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(specialResult.getString("children"));
            drugInfoObj.put("children", Collections.singletonList(drugFormatDataBo));
        }

        // 老人用药
        JSONArray geriatric = drugInfoObj.getJSONArray("geriatric");
        if (CollUtil.isEmpty(geriatric)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(specialResult.getString("geriatric"));
            drugInfoObj.put("geriatric", Collections.singletonList(drugFormatDataBo));
        }

        // 妇女用药
        JSONArray pregnantWomen = drugInfoObj.getJSONArray("pregnantWomen");
        if (CollUtil.isEmpty(pregnantWomen)) {
            DrugFormatDataBo drugFormatDataBo = new DrugFormatDataBo();
            drugFormatDataBo.setTag("text");
            drugFormatDataBo.setContent(specialResult.getString("pregnantWomen"));
            drugInfoObj.put("pregnantWomen", Collections.singletonList(drugFormatDataBo));
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

            if (StrUtil.isNotBlank(title)) {
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
//                                "\n" + "原文链接：" + url;
                                "\n" + url;
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
//                            "\n" + "原文链接：" + url;
                            "\n" + url;
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
                if (CollUtil.isNotEmpty(titleS)) {
                    synopsis = titleS;
                }
                List<String> array = new ArrayList<>();
                if (CollUtil.isNotEmpty(synopsis)) {
                    for (int i = 0; i < synopsis.size(); i++) {
                        array.add(StrUtil.trim(synopsis.getString(i)));
                    }
                    array = array.stream().distinct().collect(Collectors.toList());
                }
                if (CollUtil.isNotEmpty(array)) {
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
//                                    "\n" + "原文链接：" + url;
                                    "\n" + url;

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
                if (StrUtil.isNotBlank(belong)) {
                    if (belong.contains("ema")) {
                        JSONObject inner = new JSONObject();
                        inner.put("title", StrUtil.isNotBlank(transTitle) ? transTitle : "");
                        inner.put("dataTime", dataTime);
                        inner.put("url", url);
                        inner.put("content", StrUtil.isNotBlank(transContent) ? transContent : "");
                        inner.put("number", "(" + innerEma++ + ")");

                        // word 使用
                        String cont_word = transTitle +
                                " (发布时间：" + dataTime + ")" +
//                                "\n" + "原文链接：" + url +
                                "\n" + url +
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
                        inner.put("title", StrUtil.isNotBlank(transTitle) ? transTitle : "");
                        inner.put("dataTime", dataTime);
                        inner.put("url", url);
                        inner.put("content", StrUtil.isNotBlank(transContent) ? transContent : "");
                        inner.put("number", "(" + innerFda++ + ")");

                        // word 使用
                        String cont_word = transTitle + " (发布时间：" + dataTime + ")" +
//                                "\n" + "原文链接：" + url +
                                "\n" + url +
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
        if (CollUtil.isNotEmpty(contentsNmpaBySort)) {
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
        if (CollUtil.isNotEmpty(contentsEmaBySort)) {
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
        if (CollUtil.isNotEmpty(contentsFdaBySort)) {
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

        if (CollUtil.isNotEmpty(contentsNmpaWordArrayCopy)) {
            ywjjinner.put("nmpaWord", contentsNmpaWordArrayCopy);
        } else {
            if (CollUtil.isNotEmpty(contentsNmpaWordBySort)) {
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

        if (CollUtil.isNotEmpty(contentsEmaWordArrayCopy)) {
            ywjjinner.put("emaWord", contentsEmaWordArrayCopy);
        } else {
            if (CollUtil.isNotEmpty(contentsEmaWordBySort)) {
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

        if (CollUtil.isNotEmpty(contentsFdaWordArrayCopy)) {
            ywjjinner.put("fdaWord", contentsFdaWordArrayCopy);
        } else {
            if (CollUtil.isNotEmpty(contentsFdaWordBySort)) {
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
        if (CollUtil.isNotEmpty(reportBySort)) {
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

        if (CollUtil.isNotEmpty(reportWordArrayCopy)) {
            reportInner.put("contentsWordArray", reportWordArrayCopy);
        } else {
            if (CollUtil.isNotEmpty(reportWordBySort)) {
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
        if (CollUtil.isNotEmpty(reviseBySort)) {
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

        if (CollUtil.isNotEmpty(reviseWordArrayCopy)) {
            reviseInner.put("contentsWordArray", reviseWordArrayCopy);
        } else {
            if (CollUtil.isNotEmpty(reviseWordBySort)) {
                reviseInner.put("contentsWordArray", reviseWordBySort);
            }
        }
        result.getJSONObject("policy").put("revise", reviseInner);
    }

    @Override
    public List<String> indication(SafeInfoRequest safeInfoRequest) {
        List<String> result = new ArrayList<>();
        //根据外来数据开始构建检索条件
        Condition condition = new Condition();
        //药品
        List<Drug> drugs = new ArrayList<>();
        String userDrugNames = safeInfoRequest.getUserDrugNames();
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
            List<WordStatus> zhSynonym = new ArrayList<>();
            for (int i1 = 0; i1 < strings.length; i1++) {
                if (i1 == 0) {
                    drug.setWord(strings[i1]);
                } else {
                    WordStatus wordStatus = new WordStatus(strings[i1], true);
                    zhSynonym.add(wordStatus);
                }
            }
            drug.setZhSynonym(zhSynonym);
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
        String userADRS = safeInfoRequest.getUserADRS();
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
        int typeDrug = 2;
        String drugNamesAccurate = safeInfoRequest.getDrugNamesAccurate();
        if ("false".equals(drugNamesAccurate)) {
            typeDrug = 1;
        }
        int typeOutcome = 2;
        String adrsAccurate = safeInfoRequest.getADRSAccurate();
        if ("false".equals(adrsAccurate)) {
            typeOutcome = 1;
        }
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, isADRs);
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("indicationPt").field("indicationPt.keyword").size(20));
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        Aggregations aggregations = search.getAggregations();
        if (aggregations != null) {
            Aggregation aggregation = aggregations.get("indicationPt");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (Terms.Bucket bucket : buckets) {
                result.add(bucket.getKey().toString());
            }
        }
        return result;
    }

    @Override
    public JSONObject drugSafeInfo(SafeInfoRequest safeInfoRequest) {
        long start = System.currentTimeMillis();
        JSONObject result = new JSONObject();
        //根据外来数据开始构建检索条件
        Condition condition = new Condition();
        //药品
        List<Drug> drugs = new ArrayList<>();
        List<String> drugName = new ArrayList<>();
        String userDrugNames = safeInfoRequest.getUserDrugNames();
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
            List<WordStatus> zhSynonym = new ArrayList<>();
            for (int i1 = 0; i1 < strings.length; i1++) {
                if (i1 == 0) {
                    drug.setWord(strings[i1]);
                    drugName.add(strings[i1].toLowerCase());
                } else {
                    drugName.add(strings[i1].toLowerCase());
                    WordStatus wordStatus = new WordStatus(strings[i1], true);
                    zhSynonym.add(wordStatus);
                }
            }
            drug.setZhSynonym(zhSynonym);
            if (i > 0) {
                Drug inner = new Drug();
                inner.setStatus(2);
                drugs.add(inner);
            }
            drugs.add(drug);
        }
        condition.setDrugs(drugs);
        //疾病（适应症）
        String userIndications = safeInfoRequest.getUserIndications();
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
        boolean isADRs = false;
        String userADRS = safeInfoRequest.getUserADRS();
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
        int typeDrug = 2;
        String drugNamesAccurate = safeInfoRequest.getDrugNamesAccurate();
        if ("false".equals(drugNamesAccurate)) {
            typeDrug = 1;
        }
        int typeOutcome = 2;
        String adrsAccurate = safeInfoRequest.getADRSAccurate();
        if ("false".equals(adrsAccurate)) {
            typeOutcome = 1;
        }
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, isADRs);
        BoolQueryBuilder adverseCaseQuery = QueryUtils.createAdverseQuery(condition, typeDrug, typeOutcome, isADRs);
        //时间
        if (StringUtils.isNotBlank(safeInfoRequest.getBeginDate())) {
            adverseQuery.must().add(QueryBuilders.rangeQuery("time").gte(safeInfoRequest.getBeginDate()));
            adverseCaseQuery.must().add(QueryBuilders.rangeQuery("time").gte(safeInfoRequest.getBeginDate()));
        }
        if (StringUtils.isNotBlank(safeInfoRequest.getEndDate())) {
            adverseQuery.must().add(QueryBuilders.rangeQuery("time").lte(safeInfoRequest.getEndDate()));
            adverseCaseQuery.must().add(QueryBuilders.rangeQuery("time").lte(safeInfoRequest.getEndDate()));
        }
        //药品在报告中的作用
        String roleCode = safeInfoRequest.getRoleCode();
        if (!"-1".equals(roleCode)) {
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
                boolQueryBuilder2.should().add(QueryBuilders.prefixQuery("roleCods.drug",s));
                boolQueryBuilder2.should().add(QueryBuilders.prefixQuery("roleCods.prodAi",s));
            }
                    boolQueryBuilder.must().add(QueryBuilders.termsQuery("roleCods.role",realRole));
                    boolQueryBuilder.must().add(boolQueryBuilder2);
                    NestedQueryBuilder boolQueryBuilder1 = QueryBuilders.nestedQuery("roleCods",boolQueryBuilder, ScoreMode.Avg);
                    adverseQuery.must().add(boolQueryBuilder1);
                    adverseCaseQuery.must().add(QueryBuilders.termsQuery("roleCode",realRole));

        }
        //严重不良反应结局
        String outcCode = safeInfoRequest.getOutcCode();
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
                }
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("outcomeCod", realOutcomeCode));
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("outcomeCod", realOutcomeCode));
        }
        //报告者职业
        String occpCode = safeInfoRequest.getOccpCode();
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
                }
            }
            adverseQuery.must().add(QueryBuilders.termsQuery("occupationalCod", realOccupationalCod));
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("occupationalCod", realOccupationalCod));
        }
        //患者性别
        String sex = safeInfoRequest.getSex();
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
            adverseCaseQuery.must().add(QueryBuilders.termsQuery("sex", realSex));
        }
        //患者年龄
        String age = safeInfoRequest.getAge();
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
        //indi_pt_list 适应症分布
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("indicationPt").field("indicationPt.keyword").size(30));
        result.put("indi_pt_list", new JSONArray());
        //pt_list 不良反应分布
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("ptList").field("ptList.keyword").size(30));
        //聚合计算ptList的总数
        nativeSearchQuery.addAggregation(AggregationBuilders.sum("ptListNum").field("ptListNum"));
        result.put("pt_list", new JSONArray());
        //signal_dict 不良反应信号分析
        JSONObject calculateTypicalSignals = calculateTypicalSignalsForSafe(condition, adverseQuery);
        result.put("signal_dict", new JSONObject());
        //outc_cod_num 不良反应总数
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("outcomeCodNum").field("outcomeCodNum"));
        result.put("outc_cod_count", new JSONObject());
        //outc_cod_list 严重不良反应
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("outcomeCod").field("outcomeCod").size(30));
        result.put("outc_cod_list", new JSONArray());
        //dechal 重新使用药物反应是否再次出现
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("dechal").field("dechal").size(4));
        result.put("dechal", new JSONArray());
        //rechal 停药或减药后反应是否减轻或消失
        nativeSearchQuery.addAggregation(AggregationBuilders.terms("rechal").field("rechal").size(4));
        result.put("rechal", new JSONArray());
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        long totalHits = search.getTotalHits();
        //SearchHits<AdverseForCaseIndex> caseSearch = testElasticsearchRestTemplate.search(caseNativeSearchQuery, AdverseForCaseIndex.class);
        SearchHits<AdverseForCaseIndex> caseSearch = elasticsearchRestTemplate.search(caseNativeSearchQuery, AdverseForCaseIndex.class);
        long caseTotalHits = caseSearch.getTotalHits();
        Aggregations caseAggregations = caseSearch.getAggregations();
        if (caseAggregations != null) {
            //doseForm
            Aggregation doseForm = caseAggregations.get("doseForm");
            List<? extends Terms.Bucket> doseFormBuckets = ((ParsedTerms) doseForm).getBuckets();
            for (int i = 0; i < doseFormBuckets.size(); i++) {
                Terms.Bucket bucket = doseFormBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
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
            for (int i = 0; i < routeBuckets.size(); i++) {
                Terms.Bucket bucket = routeBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                JSONObject one = mongoTemplate.findOne(new Query(Criteria.where("route_en").is(key)), JSONObject.class, "route_translate");
                String routeCh = "";
                if (one != null) {
                    routeCh = one.getString("route_ch");
                } else if ("unknown".equals(key)) {
                    routeCh = "未知";
                }
                array.add(routeCh);
                result.getJSONArray("route_list").add(array);
            }
            //doseAmtCombine
            Aggregation doseAmtCombine = caseAggregations.get("doseAmtCombine");
            List<? extends Terms.Bucket> doseAmtCombineBuckets = ((ParsedTerms) doseAmtCombine).getBuckets();
            for (int i = 0; i < doseAmtCombineBuckets.size(); i++) {
                Terms.Bucket bucket = doseAmtCombineBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(caseTotalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                result.getJSONArray("dose_amt_list").add(array);
            }
        }
        Aggregations aggregations = search.getAggregations();
        if (aggregations != null) {
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
                array.add(i);
                String key = bucket.getKey().toString();
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
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
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
                result.getJSONArray("sex_m_f").add(unknownArray);
            }
            //age
            Aggregation ageList = aggregations.get("age");
            List<? extends Terms.Bucket> ageBuckets = ((ParsedTerms) ageList).getBuckets();
            for (int i = 0; i < ageBuckets.size(); i++) {
                Terms.Bucket bucket = ageBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
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
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
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
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
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
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                result.getJSONArray("cut_dt_list").add(array);
            }
            //indicationPt
            Aggregation indicationPt = aggregations.get("indicationPt");
            List<? extends Terms.Bucket> indicationPtBuckets = ((ParsedTerms) indicationPt).getBuckets();
            for (int i = 0; i < indicationPtBuckets.size(); i++) {
                Terms.Bucket bucket = indicationPtBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                JSONObject ptAllData = mongoTemplate.findOne(new Query(Criteria.where("pt_en").is(key)), JSONObject.class, "pt_all_data");
                String ptCh = "";
                if (ptAllData != null) {
                    ptCh = ptAllData.getString("pt_ch");
                } else if ("unknown".equals(key)) {
                    ptCh = "未知";
                }
                array.add(ptCh);
                result.getJSONArray("indi_pt_list").add(array);
            }
            //dechal
            Aggregation dechal = aggregations.get("dechal");
            List<? extends Terms.Bucket> dechalBuckets = ((ParsedTerms) dechal).getBuckets();
            for (int i = 0; i < dechalBuckets.size(); i++) {
                Terms.Bucket bucket = dechalBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                result.getJSONArray("dechal").add(array);
            }
            //rechal
            Aggregation rechal = aggregations.get("rechal");
            List<? extends Terms.Bucket> rechalBuckets = ((ParsedTerms) rechal).getBuckets();
            for (int i = 0; i < rechalBuckets.size(); i++) {
                Terms.Bucket bucket = rechalBuckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                result.getJSONArray("rechal").add(array);
            }
            //ptListNum
            ParsedSum ptListNum = aggregations.get("ptListNum");
            double ptTotal = ptListNum.getValue();
            //ptList
            Aggregation ptList = aggregations.get("ptList");
            List<? extends Terms.Bucket> ptListBuckets = ((ParsedTerms) ptList).getBuckets();
            for (int i = 0; i < ptListBuckets.size(); i++) {
                Terms.Bucket bucket = ptListBuckets.get(i);
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
                result.getJSONArray("pt_list").add(array);
            }
            //outcomeCodNum 严重不良反应总数
            long sumNum = 0;
            long sumNoNum = 0;
            Aggregation outcomeCodNum = aggregations.get("outcomeCodNum");
            List<? extends Terms.Bucket> outcomeCodNumBuckets = ((ParsedTerms) outcomeCodNum).getBuckets();
            for (Terms.Bucket bucket : outcomeCodNumBuckets) {
                String key = bucket.getKey().toString();
                long docCount = bucket.getDocCount();
                sumNum += docCount;
                if ("0".equals(key)) {
                    sumNoNum = docCount;
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
            Boolean outcome = calculateTypicalSignals.getBoolean("outcome");
            JSONObject signalDict = result.getJSONObject("signal_dict");
            signalDict.put("outcome", outcome);
            if (!outcome) {
                JSONArray data = calculateTypicalSignals.getJSONArray("data");
                JSONObject inner = new JSONObject();
                for (int i = 0; i < data.size(); i++) {
                    JSONArray array = new JSONArray();
                    JSONObject json = data.getJSONObject(i);
                    String en = json.getString("en");
                    array.add(en);
                    Integer num = json.getInteger("num");
                    array.add(num);
                    array.add(BigDecimal.valueOf(num).divide(BigDecimal.valueOf(totalHits), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
                    String ror = json.getString("ror");
                    array.add(ror);
                    String ebgm = json.getString("ebgm");
                    array.add(ebgm);
                    String ic = json.getString("ic");
                    array.add(ic);
                    String zh = json.getString("zh");
                    array.add(zh);
                    String soc = json.getString("soc");
                    if (!inner.containsKey(soc)) {
                        inner.put(soc, new JSONArray());
                    }
                    inner.getJSONArray(soc).add(array);
                }
                signalDict.put("data", inner);
            } else {
                //用户输入不良反应
                JSONArray illustrate = calculateTypicalSignals.getJSONArray("illustrate");
                signalDict.put("data", illustrate);
            }
        }
        log.info("药品安全性分析计算完成，用时[{}]", System.currentTimeMillis() - start);
        return result;
    }


    /**
     * 计算典型信号
     * @param condition 检索条件
     * @return 计算后的典型信号信息
     */
    private JSONObject calculateTypicalSignals(Condition condition) {
        JSONObject result = new JSONObject();
        result.put("outcome", false);
        JSONArray data = new JSONArray();
//        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, 2, 2, false);
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery_bak(condition, 1, "adverse_index");
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
                if (CollUtil.isNotEmpty(enSynonym)) {
                    for (WordStatus wordStatus : enSynonym) {
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            inner.add(wordStatus.getName());
                        }
                    }
                }
                List<WordStatus> zhSynonym = outcome.getZhSynonym();
                if (CollUtil.isNotEmpty(zhSynonym)) {
                    for (WordStatus wordStatus : zhSynonym) {
                        Boolean checked = wordStatus.getChecked();
                        if (checked) {
                            inner.add(wordStatus.getName());
                        }
                    }
                }
                //补充同义词
                String expandSynonym = outcome.getExpandSynonym();
                if (StrUtil.isNotBlank(expandSynonym)) {
                    expandSynonym = expandSynonym.replaceAll("；", ";");
                    String[] split = expandSynonym.split(";");
                    for (String txt : split) {
                        if(StringUtils.isNotBlank(txt)) {
                            inner.add(txt.toLowerCase());
                        }
                    }
                }              
                outComeList.add(inner);
            }
        }
        if (CollUtil.isNotEmpty(outComeList)) {
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
        Set<Map.Entry<List<String>, Long>> entries = top20Map.entrySet();
        for (Map.Entry<List<String>, Long> entry : entries) {
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
            //是这个药但没这个不良反应的报告数
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
            //String calculate = calculateAdverseFeign.calculate(String.valueOf(a), String.valueOf(b), String.valueOf(c), String.valueOf(d));
            String calculate = getRequest(String.valueOf(a), String.valueOf(b), String.valueOf(c), String.valueOf(d));
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
     * @param condition 检索条件
     * @return 计算后的典型信号信息
     */
    private JSONObject calculateTypicalSignalsForSafe(Condition condition, BoolQueryBuilder adverseQuery) {
        JSONObject result = new JSONObject();
        result.put("outcome", false);
        JSONArray data = new JSONArray();
        //BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery(condition, 2, 2, false);

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
                    if (CollUtil.isNotEmpty(enSynonym)) {
                        for (WordStatus wordStatus : enSynonym) {
                            Boolean checked = wordStatus.getChecked();
                            if (checked) {
                                inner.add(wordStatus.getName());
                            }
                        }
                    }
                    List<WordStatus> zhSynonym = outcome.getZhSynonym();
                    if (CollUtil.isNotEmpty(zhSynonym)) {
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
        if (CollUtil.isNotEmpty(outComeList)) {
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
        Set<Map.Entry<List<String>, Long>> entries = top20Map.entrySet();
        for (Map.Entry<List<String>, Long> entry : entries) {
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
            //String calculate = calculateAdverseFeign.calculate(String.valueOf(a), String.valueOf(b), String.valueOf(c), String.valueOf(d));
            String calculate = getRequest(String.valueOf(a), String.valueOf(b), String.valueOf(c), String.valueOf(d));
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

    /**
     * 计算严重不良反应
     * @param condition 检索条件
     * @return 严重不良反应的柱状图
     */
    private JSONArray seriousAdverse(Condition condition) {
        JSONArray result = new JSONArray();
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery_bak(condition, 1, "adverse_index");
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("outcomeCod").field("outcomeCod").size(10);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        SearchHits<AdverseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseIndex.class);
        Aggregations aggregations = search.getAggregations();
        if (aggregations != null){
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
     * @param condition 检索条件
     * @return 不良反应列表
     */
    private JSONArray adverse(Condition condition) {
        JSONArray result = new JSONArray();
        BoolQueryBuilder adverseQuery = QueryUtils.createAdverseQuery_bak(condition, 1, "adverse_case_index");
        NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(adverseQuery);
        nativeSearchQuery.setTrackTotalHits(true);
        nativeSearchQuery.setPageable(PageRequest.of(0, 1));
        TermsAggregationBuilder aggregationBuilder = AggregationBuilders.terms("indicationPt").field("indicationPt.keyword").size(21);
        nativeSearchQuery.addAggregation(aggregationBuilder);
        //聚合计算ptList的总数
        long totalCount = elasticsearchRestTemplate.count(nativeSearchQuery, AdverseForCaseIndex.class);
        SearchHits<AdverseForCaseIndex> search = elasticsearchRestTemplate.search(nativeSearchQuery, AdverseForCaseIndex.class);
        Aggregations aggregations = search.getAggregations();
        if (aggregations != null){
            //ptListNum
            Aggregation aggregation = aggregations.get("indicationPt");
            List<? extends Terms.Bucket> buckets = ((ParsedTerms) aggregation).getBuckets();
            for (int i = 0; i < buckets.size(); i++) {
                if (result.size() == 20) break;
                Terms.Bucket bucket = buckets.get(i);
                JSONArray array = new JSONArray();
                array.add(i);
                String key = bucket.getKey().toString();
                if ("未知".equals(key)) continue;
                array.add(key);
                long docCount = bucket.getDocCount();
                array.add(docCount);
                //计算百分比
                array.add(BigDecimal.valueOf(docCount).divide(BigDecimal.valueOf(totalCount), 4, RoundingMode.HALF_UP).multiply(BigDecimal.valueOf(100)).doubleValue() + "%");
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
     * @param condition 检索条件
     * @return 模板数据
     */
    private String getInfo(Condition condition) {
        StringBuilder info = new StringBuilder();
        List<Drug> drugs = condition.getDrugs();
        if (drugs.size() > 1) {
            info.append("在");
        }
        if (CollUtil.isNotEmpty(drugs)){
            for (Drug drug : drugs) {
                Integer status = drug.getStatus();
                if (status == 1){
                    info.append(drug.getWord());
                } else if (status == 2){
                    //与
                    info.append("联合");
                }else {
                    //非
                    info.append("排除");
                }
            }
        }
        List<Disease> diseases = condition.getDiseases();
        if (CollUtil.isNotEmpty(diseases)) {
            info.append("治疗");
            for (Disease disease : diseases) {
                Integer status = disease.getStatus();
                if (status == 1){
                    info.append(disease.getWord());
                }else if (status == 2){
                    //与
                    info.append("合并");
                }else {
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
     * @param id 检索id
     * @return 拼接后的检索语句
     */
    private Criteria createPolicyCriteria(String id) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        StringBuilder query = new StringBuilder();
        List<Drug> drugs = condition.getDrugs();
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();
        JSONArray array = new JSONArray();
        array.add(drugs);
        if (CollUtil.isNotEmpty(outcomes)) {
            array.add(outcomes);
        }

        StringBuilder inner = new StringBuilder();
        inner.append("(");
        for (int i = 0; i < array.size(); i++) {
            JSONArray innerArr = array.getJSONArray(i);
            if (CollUtil.isNotEmpty(innerArr)){
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject json = innerArr.getJSONObject(i1);
                    Integer status = json.getInteger("status");
                    if (status == 1){
                        Set<String> set = new HashSet<>();
                        String word = json.getString("word").toLowerCase();
                        set.add(word);
                        String enWord = json.getString("enWord");
                        if (StringUtils.isNotBlank(enWord)){
                            set.add(enWord.toLowerCase());
                        }
                        JSONArray enSynonym = json.getJSONArray("enSynonym");
                        if (CollUtil.isNotEmpty(enSynonym)){
                            for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(jsonObject.getString("name"));
                                }
                            }
                        }
                        String zhWord = json.getString("zhWord");
                        if (StringUtils.isNotBlank(zhWord)){
                            set.add(zhWord.toLowerCase());
                        }
                        JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                        if (CollUtil.isNotEmpty(zhSynonym)){
                            for (int i2 = 0; i2 < zhSynonym.size(); i2++) {
                                JSONObject jsonObject = zhSynonym.getJSONObject(i2);
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(jsonObject.getString("name"));
                                }
                            }
                        }

                        JSONArray otherSynonym = json.getJSONArray("otherSynonym");
                        if (CollUtil.isNotEmpty(otherSynonym)){
                            for (int i2 = 0; i2 < otherSynonym.size(); i2++) {
                                JSONObject jsonObject = otherSynonym.getJSONObject(i2);
                                String name = jsonObject.getString("name");
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(name);
                                }
                            }
                        }
                        
                        //补充同义词
                        String expandSynonym = json.getString("expandSynonym");
                        if (StrUtil.isNotBlank(expandSynonym)) {
                            expandSynonym = expandSynonym.replaceAll("；", ";");
                            String[] split = expandSynonym.split(";");
                            for (String txt : split) {
                                if(StringUtils.isNotBlank(txt)) {
                                    set.add(txt.toLowerCase());
                                }
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
     * 获取药品的输入词 中英文 以及中英文同义词
     * @param id 检索id
     */
    private List<String> acquireDrugAllSynonym(String id) {
        Condition condition = mongoTemplate.findById(id, Condition.class);
        if (condition == null){
            throw new RuntimeException("检索id异常");
        }
        List<String> drugAllSynonym = new ArrayList<>();
        Set<String> set = new HashSet<>();
        List<Drug> drugs = condition.getDrugs();
        List<InterventionAndOutcome> outcomes = condition.getOutcomes();
        JSONArray array = new JSONArray();
        array.add(drugs);
        if (CollUtil.isNotEmpty(outcomes)) {
            array.add(outcomes);
        }
        for (int i = 0; i < array.size(); i++) {
            JSONArray innerArr = array.getJSONArray(i);
            if (CollUtil.isNotEmpty(innerArr)){
                for (int i1 = 0; i1 < innerArr.size(); i1++) {
                    JSONObject json = innerArr.getJSONObject(i1);
                    Integer status = json.getInteger("status");
                    if (status == 1){
                        String word = json.getString("word").toLowerCase();
                        set.add(word);
                        String enWord = json.getString("enWord");
                        if (StringUtils.isNotBlank(enWord)){
                            set.add(enWord.toLowerCase());
                        }
                        JSONArray enSynonym = json.getJSONArray("enSynonym");
                        if (CollUtil.isNotEmpty(enSynonym)){
                            for (int i2 = 0; i2 < enSynonym.size(); i2++) {
                                JSONObject jsonObject = enSynonym.getJSONObject(i2);
                                Boolean checked = jsonObject.getBoolean("checked");
                                if (checked) {
                                    set.add(jsonObject.getString("name"));
                                }
                            }
                        }
                        String zhWord = json.getString("zhWord");
                        if (StringUtils.isNotBlank(zhWord)){
                            set.add(zhWord.toLowerCase());
                        }
                        JSONArray zhSynonym = json.getJSONArray("zhSynonym");
                        if (CollUtil.isNotEmpty(zhSynonym)){
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
                            if(StringUtils.isNotBlank(txt)) {
                                set.add(txt.toLowerCase());
                            }
                        }
                    }
                }
            }
            drugAllSynonym.addAll(set);
        }
        return drugAllSynonym;
    }

    private String getRequest(String a, String b, String c, String d) {
        return calculateAdverseFeign.calculate(a, b, c, d);
    }

    /**
     * 拼接药品 如 二甲双胍联合二甲苯
     */
    private void assembleDrug(List<Drug> drugs,  List<Drug> drugAnd, List<Drug> drugNot) {
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
