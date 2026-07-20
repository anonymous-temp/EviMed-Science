package com.sentum.service.impl;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.infrastructure.config.ThreadPoolConfig;
import com.sentum.constants.CommonConstants;
import com.sentum.enums.CacheNameEnum;
import com.sentum.enums.ContentTagEnum;
import com.sentum.enums.TraditionalPromptEnum;
import com.sentum.feign.FormulaFeign;
import com.sentum.feign.ManageFeign;
import com.sentum.pojo.DrugContent;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.DrugPrice;
import com.sentum.pojo.dto.*;
import com.sentum.pojo.vo.*;
import com.sentum.service.LxGptService;
import com.sentum.service.TraditionalGptAppService;
import com.sentum.service.TraditionalGptService;
import com.sentum.service.TraditionalMedicineService;
import com.sentum.util.*;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.index.query.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Sort;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;
import org.springframework.stereotype.Service;

import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

@Service()
@Slf4j
public class TraditionalMedicineServiceImpl implements TraditionalMedicineService {

    @Autowired
    private ManageFeign manageFeign;

    @Autowired
    private TraditionalGptService traditionalGptService;

    @Autowired
    private TraditionalGptAppService traditionalGptAppService;

    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private RedisTemplate redisTemplate;

    @Autowired
    private LxGptService lxGptService;

    @Qualifier(ThreadPoolConfig.MAIN_GPTANALYSIS_THREAD_POOL_NAME)
    @Autowired
    ThreadPoolTaskExecutor gptAnalysisThreadPool;
    
    @Autowired
    private FormulaFeign formulaFeign;

    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;

    @Autowired
    EvaluationServiceImpl evaluationService;




    public Object guideOnAnalysisV2App(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom, String drugId, String searchId) {
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品遴选");
            dataJson.put("module", "药学");
            dataJson.put("report_name", drugName + "治疗" + disease);
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }

        Object report = guidePanelV2App(priceId, drugId, id);
        return report;
    }

    public Object guidePanelV2App(String priceId, String drugId, String id) {
        TrChoosexDto trChoosexDto = mongoTemplate.findOne(new Query(Criteria.where("priceId").is(priceId).and("drugId").is(drugId)), TrChoosexDto.class, "drug_info_tra_v2_app");

        if (ObjectUtil.isEmpty(trChoosexDto)){
            trChoosexDto = new TrChoosexDto();
        }
        //获得所有信息
        DrugInfoNew drugInfo = getDrugInfo(drugId, null);
        ArrayList<String> strings = new ArrayList<>();
        int step = 0;
        TrInheritanceEvaluationDto trInheritanceEvaluationDto = new TrInheritanceEvaluationDto();
        TrClinicalEvaluationDto trClinicalEvaluationDto = new TrClinicalEvaluationDto();
        trClinicalEvaluationDto.setClinicalDemandOption(trChoosexDto.getClinicalDemandOption());
        TrSafetyEvaluationDto trSafetyEvaluationDto = new TrSafetyEvaluationDto();
        TrTechnologyEvaluationDto trPolicyEvaluationDto = new TrTechnologyEvaluationDto();
        trPolicyEvaluationDto.setPackagingSpecificationOption(trChoosexDto.getPackagingSpecificationOption());
        trPolicyEvaluationDto.setLargePackageAdoptionOption(trChoosexDto.getLargePackageAdoptionOption());
        trPolicyEvaluationDto.setSingleDoseOption(trChoosexDto.getSingleDoseOption());
        TrMarketEvaluationDto trMarketEvaluationDto = new TrMarketEvaluationDto();
        trMarketEvaluationDto.setMarketUniquenessOption(trChoosexDto.getMarketUniquenessOption());
        trMarketEvaluationDto.setEconomicOption(trChoosexDto.getEconomicOption());
        String title = drugInfo.getDrugName() + "-" + drugInfo.getSpecifications() + "-" + drugInfo.getManufacturer();
        
        List<TrInfoDto> trInfoDtos = null;
        if ("1".equals(isDev)){
            // trInfoDtos= ChangeMongoUtil.mongo.find(new Query(Criteria.where("title").is(title)), TrInfoDto.class, "evaluation_tr_cache_app");

        }else {
            trInfoDtos = mongoTemplate.find(new Query(Criteria.where("title").is(title)), TrInfoDto.class, "evaluation_tr_cache_app");

        }

        //缓存

        //缓存
//
        if (CollUtil.isNotEmpty(trInfoDtos)){
            TrInfoDto trInfoDto = trInfoDtos.get(0);

            trInfoDto.getTrClinicalEvaluationDto().setClinicalDemandOption(trChoosexDto.getClinicalDemandOption());

            trInfoDto.getTrTechnologyEvaluationDto().setPackagingSpecificationOption(trChoosexDto.getPackagingSpecificationOption());

            trInfoDto.getTrTechnologyEvaluationDto().setLargePackageAdoptionOption(trChoosexDto.getLargePackageAdoptionOption());

            trInfoDto.getTrTechnologyEvaluationDto().setSingleDoseOption(trChoosexDto.getSingleDoseOption());

            trInfoDto.getTrMarketEvaluationDto().setMarketUniquenessOption(trChoosexDto.getMarketUniquenessOption());

            trInfoDto.getTrMarketEvaluationDto().setEconomicOption(trChoosexDto.getEconomicOption());


            //替换
            for (String s : trInfoDto.getContent()) {

                if (CacheNameEnum.hasCache(s)){

                    step = putNew(id, step, s, trInfoDto, strings);

                }else {
                    addProcess(id,step++,s,strings);
                }

            }


            trInfoDto.getTrInheritanceEvaluationDto().setDiseaseCombinationScore();
            trInfoDto.getTrInheritanceEvaluationDto().setTheorySupportScore();
            trInfoDto.getTrInheritanceEvaluationDto().setTotalScore();

            trInfoDto.getTrClinicalEvaluationDto().setTotalScore();

            trInfoDto.getTrSafetyEvaluationDto().setCrowdRestrictionScore();
            trInfoDto.getTrSafetyEvaluationDto().setSafetyInfoScore();
            trInfoDto.getTrSafetyEvaluationDto().setTotalScore();


            trInfoDto.getTrTechnologyEvaluationDto().setSuitabilityScore();
            trInfoDto.getTrTechnologyEvaluationDto().setAdditionalZodiacScore();
            trInfoDto.setTotalScore();

            trInfoDto.getTrMarketEvaluationDto().setEconomicScore();
            trInfoDto.getTrMarketEvaluationDto().setTotalScore();

            trInfoDto.setTotalScore();





            //将trInfoDto转为json格式
            String json = JSONUtil.toJsonStr(trInfoDto);
            log.info("trInfoDto:{}", json);
            mongoTemplate.save(trInfoDto);
            addScore(trInfoDto);
            TrInfoAppVo trInfoAppVo = new TrInfoAppVo();
            trInfoAppVo.setDrugName(drugInfo.getDrugName());
            trInfoAppVo.setId(id);
            trInfoAppVo.setDrugId(drugId);
            trInfoAppVo.setTitle(title);
            trInfoAppVo.setTotalScore(trInfoDto.getTotalScore());
            trInfoAppVo.setTrInheritanceEvaluationScore(trInfoDto.getTrInheritanceEvaluationDto().getTotalScore());
            trInfoAppVo.setTrClinicalEvaluationScore(trInfoDto.getTrClinicalEvaluationDto().getTotalScore());
            trInfoAppVo.setTrSafetyEvaluationScore(trInfoDto.getTrSafetyEvaluationDto().getTotalScore());
            trInfoAppVo.setTrTechnologyEvaluationScore(trInfoDto.getTrTechnologyEvaluationDto().getTotalScore());
            trInfoAppVo.setTrMarketEvaluationScore(trInfoDto.getTrMarketEvaluationDto().getTotalScore());


            String drugName = drugInfo.getDrugName();
            JSONObject jsonObject = (JSONObject) JSONObject.toJSON(trInfoDto);
            String reportId = UUID.randomUUID().toString();
            jsonObject.put("reportId", id);
            jsonObject.getJSONObject("trInheritanceEvaluationDto").put("trInheritanceEvaluationScore", drugName + "在传承评价的得分为：" + trInfoDto.getTrInheritanceEvaluationDto().getTotalScore() + "分");
            jsonObject.getJSONObject("trClinicalEvaluationDto").put("trClinicalEvaluationScore", drugName + "在临床评价的得分为：" + trInfoDto.getTrClinicalEvaluationDto().getTotalScore() + "分");
            jsonObject.getJSONObject("trSafetyEvaluationDto").put("trSafetyEvaluationScore", drugName + "在安全性评价的得分为：" + trInfoDto.getTrSafetyEvaluationDto().getTotalScore() + "分");
            jsonObject.getJSONObject("trTechnologyEvaluationDto").put("trTechnologyEvaluationScore", drugName + "在技术评价的得分为：" + trInfoDto.getTrTechnologyEvaluationDto().getTotalScore() + "分");
            jsonObject.getJSONObject("trMarketEvaluationDto").put("trMarketEvaluationScore", drugName + "在市场评价的得分为：" + trInfoDto.getTrMarketEvaluationDto().getTotalScore() + "分");
            SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
            Date date = new Date();
            String format = simpleDateFormat.format(date);
            jsonObject.put("time", format);
            jsonObject.put("simpleTitle", drugName + "药品综合评价报告");
            mongoTemplate.save(jsonObject, "tr_info_score_v2");
            trInfoAppVo.setReportId(id);
            return trInfoAppVo;
        }




        //第一部分，传承评价
        step = traditionalGptAppService.getTrInheritanceEvaluationDto(drugInfo, id, strings, step, trInheritanceEvaluationDto);
        step = traditionalGptAppService.getTrClinicalEvaluationDto(drugInfo, id, strings, step, trClinicalEvaluationDto);
        step = traditionalGptAppService.getTrSafetyEvaluationDto(drugInfo, id, strings, step, trSafetyEvaluationDto);
        step = traditionalGptAppService.getTrTechnologyEvaluationDto(drugInfo, id, strings, step, trPolicyEvaluationDto);
        step = traditionalGptAppService.getTrMarketEvaluationDto(drugInfo, id, strings, step, trMarketEvaluationDto);



        TrInfoDto trInfoDto = new TrInfoDto(null, trInheritanceEvaluationDto, trClinicalEvaluationDto, trSafetyEvaluationDto, trPolicyEvaluationDto, trMarketEvaluationDto, 0.0
                , drugInfo.getDrugName(), drugId, title,strings);
        //将trInfoDto转为json格式
        String json = JSONUtil.toJsonStr(trInfoDto);
        log.info("trInfoDto:{}", json);
        int maxRetries = 3;  // 最大重试次数
        long timeoutMillis = 5000; // 5秒超时

        for (int retry = 0; retry <= maxRetries; retry++) {
            try {
                mongoTemplate.save(trInfoDto);
                if (retry > 0) {
                    log.info("MongoDB 保存操作重试成功，重试次数: {}", retry);
                }
                break; // 成功保存，跳出循环
            } catch (Exception e) {
                // 检查是否是超时异常或者达到最大重试次数
                if (retry == maxRetries) {
                    log.error("MongoDB 保存操作经过 {} 次重试后仍然失败", maxRetries, e);
                    throw new RuntimeException("数据库操作失败，请稍后重试", e);
                }

                log.warn("MongoDB 保存操作失败，第 {} 次重试，错误: {}", retry + 1, e.getMessage());

                try {
                    // 等待一段时间后重试（指数退避策略）
                    Thread.sleep(Math.min(1000 * (retry + 1), timeoutMillis));
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw new RuntimeException("保存操作被中断", ie);
                }
            }
        }
        addScore(trInfoDto);
        TrInfoAppVo trInfoAppVo = new TrInfoAppVo();
        trInfoAppVo.setDrugName(drugInfo.getDrugName());
        trInfoAppVo.setId(id);
        trInfoAppVo.setDrugId(drugId);
        trInfoAppVo.setTitle(title);
        trInfoAppVo.setTotalScore(trInfoDto.getTotalScore());
        trInfoAppVo.setTrInheritanceEvaluationScore(trInfoDto.getTrInheritanceEvaluationDto().getTotalScore());
        trInfoAppVo.setTrClinicalEvaluationScore(trInfoDto.getTrClinicalEvaluationDto().getTotalScore());
        trInfoAppVo.setTrSafetyEvaluationScore(trInfoDto.getTrSafetyEvaluationDto().getTotalScore());
        trInfoAppVo.setTrTechnologyEvaluationScore(trInfoDto.getTrTechnologyEvaluationDto().getTotalScore());
        trInfoAppVo.setTrMarketEvaluationScore(trInfoDto.getTrMarketEvaluationDto().getTotalScore());


        String drugName = drugInfo.getDrugName();
        JSONObject jsonObject = (JSONObject) JSONObject.toJSON(trInfoDto);
        String reportId = UUID.randomUUID().toString();
        jsonObject.put("reportId", id);
        jsonObject.getJSONObject("trInheritanceEvaluationDto").put("trInheritanceEvaluationScore", drugName + "在传承评价的得分为：" + trInfoDto.getTrInheritanceEvaluationDto().getTotalScore() + "分");
        jsonObject.getJSONObject("trClinicalEvaluationDto").put("trClinicalEvaluationScore", drugName + "在临床评价的得分为：" + trInfoDto.getTrClinicalEvaluationDto().getTotalScore() + "分");
        jsonObject.getJSONObject("trSafetyEvaluationDto").put("trSafetyEvaluationScore", drugName + "在安全性评价的得分为：" + trInfoDto.getTrSafetyEvaluationDto().getTotalScore() + "分");
        jsonObject.getJSONObject("trTechnologyEvaluationDto").put("trTechnologyEvaluationScore", drugName + "在技术评价的得分为：" + trInfoDto.getTrTechnologyEvaluationDto().getTotalScore() + "分");
        jsonObject.getJSONObject("trMarketEvaluationDto").put("trMarketEvaluationScore", drugName + "在市场评价的得分为：" + trInfoDto.getTrMarketEvaluationDto().getTotalScore() + "分");
        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
        Date date = new Date();
        String format = simpleDateFormat.format(date);
        jsonObject.put("time", format);
        jsonObject.put("simpleTitle", drugName + "药品综合评价报告");
        if ("1".equals(isDev)){
            ChangeMongoUtil.mongo.save(jsonObject,"evaluation_tr_cache_app");
        }else {
            mongoTemplate.save(jsonObject,"evaluation_tr_cache_app");
        }

        mongoTemplate.save(jsonObject, "tr_info_score_v2");
        trInfoAppVo.setReportId(id);
        return trInfoAppVo;
    }












    @Override
    public Object getDataTalPuls(String disease, String searchId, String drugIds) {
        //中间有效性部分
        //最后的其他内容
        //指南list

        ArrayList<TraditionalDataVo> drugDisDatas = new ArrayList<>();
        String[] ids = drugIds.split(",");

        HashMap<String, CompletableFuture<Boolean>> threadMap = new HashMap<>();

        HashMap<String, String> indicationMap = new HashMap<>();
        HashMap<String, String> indicationMap2 = new HashMap<>();


        long startTime = System.currentTimeMillis();
        for (String drugId : ids) {
            DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
            if (ObjectUtil.isEmpty(drugInfo1)) {
                throw new RuntimeException("未找到药品信息");
            }

            String register = drugInfo1.getRegister();
            if (register != null) {
                DrugInst approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInst.class);
                if (ObjectUtil.isNotEmpty(approveCode)) {
                    if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                        drugInfo1.setIndications(delHTMLTag(approveCode.getIndication()));
                    }
                    if (approveCode.getDosage() != null && !approveCode.getDosage().isEmpty()) {
                        drugInfo1.setUsageAndDosage(delHTMLTag(approveCode.getDosage()));
                    }
                    if (approveCode.getUseInPregLact() != null && !approveCode.getUseInPregLact().isEmpty()) {
                        drugInfo1.setPregnantWomen(delHTMLTag(approveCode.getUseInPregLact()));
                    }
                    if (approveCode.getUseInChildren() != null && !approveCode.getUseInChildren().isEmpty()) {
                        drugInfo1.setChildrenMedicine(delHTMLTag(approveCode.getUseInChildren()));
                    }
                    if (approveCode.getUseInElderly() != null && !approveCode.getUseInElderly().isEmpty()) {
                        drugInfo1.setGeriatricMedicine(delHTMLTag(approveCode.getUseInElderly()));
                    }
                    if (approveCode.getAdverseReactions() != null && !approveCode.getAdverseReactions().isEmpty()) {
                        drugInfo1.setAdverseReaction(delHTMLTag(approveCode.getAdverseReactions()));
                    }
                    if (approveCode.getPrecautions() != null && !approveCode.getPrecautions().isEmpty()) {
                        drugInfo1.setNotes(delHTMLTag(approveCode.getPrecautions()));
                    }
                    if (approveCode.getDrugInteractions() != null && !approveCode.getDrugInteractions().isEmpty()) {
                        drugInfo1.setDrugInteraction(delHTMLTag(approveCode.getDrugInteractions()));
                    }
                    if (approveCode.getMechanismAction() != null && !approveCode.getMechanismAction().isEmpty()) {
                        drugInfo1.setPharmacology(delHTMLTag(approveCode.getMechanismAction()));
                    }
                    if (approveCode.getPharmacokinetics() != null && !approveCode.getPharmacokinetics().isEmpty()) {
                        drugInfo1.setPharmacokinetics(delHTMLTag(approveCode.getPharmacokinetics()));
                    }
                    if (approveCode.getStorage() != null && !approveCode.getStorage().isEmpty()) {
                        drugInfo1.setStorage(delHTMLTag(approveCode.getStorage()));
                    }
                    if (approveCode.getPack() != null && !approveCode.getPack().isEmpty()) {
                        drugInfo1.setPack(delHTMLTag(approveCode.getPack()));
                    }
                    if (approveCode.getPeriod() != null && !approveCode.getPeriod().isEmpty()) {
                        drugInfo1.setIndate(delHTMLTag(approveCode.getPeriod()));
                    }
                    if (approveCode.getComponent() != null && !approveCode.getComponent().isEmpty()) {
                        drugInfo1.setIngredient(delHTMLTag(approveCode.getComponent()));
                    }

                    if (approveCode.getPdf() != null && !approveCode.getPdf().isEmpty()) {
                        drugInfo1.setPdf(approveCode.getPdf());
                    }
                }
            }

            String isAdverseReactions = "0";
            // 合理用药
            if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh()) || ObjectUtil.isNotEmpty(drugInfo1.getDrugSynonymZh())) {
                JSONObject evaluationMedicine = evaluationService.getHeliYongYao(drugInfo1.getDrugZh());
                if (ObjectUtil.isNotEmpty(evaluationMedicine)) {
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("commonAdverseReactions"))) {
                        drugInfo1.setCommonAdverseReactions(getTxt(evaluationMedicine.getJSONArray("commonAdverseReactions")));

                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("seriousAdverseRactions"))) {
                        drugInfo1.setSeriousAdverseRactions(getTxt(evaluationMedicine.getJSONArray("seriousAdverseRactions")));

                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction"))) {
                        drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction")));
                    }
                    if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency"))) {
                        drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency")));
                    }

                    if (StringUtils.isNotEmpty(drugInfo1.getPregnantWomen()) &&
                            (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("pregnancyGrade")) ||
                                    CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("medicationDuringPregnancy")))) {
                        drugInfo1.setPregnantWomen(getTxt(evaluationMedicine.getJSONArray("pregnancyGrade")) + getTxt(evaluationMedicine.getJSONArray("medicationDuringPregnancy")));
                    }

                    if (StringUtils.isNotEmpty(evaluationMedicine.getString("geneticsReproductionCarcinogenicity"))) {
                        drugInfo1.setGeneticsReproductionCarcinogenicity(getTxt(evaluationMedicine.getJSONArray("geneticsReproductionCarcinogenicity")));
                    }

                    if (StringUtils.isNotEmpty(evaluationMedicine.getString("warning"))) {
                        drugInfo1.setBlackBoxWaringOfFDA(getTxt(evaluationMedicine.getJSONArray("warningwarning")));
                    }


                }
            }

            DrugAddDto drugAdd = null;
            if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
                drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
            }
            if (ObjectUtil.isNotEmpty(drugAdd)) {
                BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
                StringBuilder usageAndDosage = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                    usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                    usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
                    usageAndDosage.append("孕妇及哺乳期妇女用药:" + drugAdd.getPregnantWomen() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine())) {
                    usageAndDosage.append("儿童用药:" + drugAdd.getChildrenMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getGeriatricMedicine())) {
                    usageAndDosage.append("老年用药:" + drugAdd.getGeriatricMedicine() + "\n");
                }
                if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                    usageAndDosage.append("肾功能异常者:" + drugAdd.getKidneyPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾病是否可用：" + drugAdd.getKidneyPatients());
                    drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(drugAdd.getKidneyPatients());
                }
                if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                    usageAndDosage.append("肝功能异常者:" + drugAdd.getLiverPatients() + "\n");
                    drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝病是否可用：" + drugAdd.getLiverPatients());
                    drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(drugAdd.getLiverPatients());
                }
                if (usageAndDosage.length() > 0) {
                    drugInfo1.setUsageAndDosage(usageAndDosage.toString());
                }
                StringBuilder adverseReaction = new StringBuilder();
                if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                    adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                    drugInfo1.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
                }
                if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                    adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                    drugInfo1.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
                }
                if (adverseReaction.length() > 0) {
                    drugInfo1.setAdverseReaction(adverseReaction.toString());
                }
            }
            if (StringUtils.isEmpty(drugInfo1.getPharmacology())) {

                try {
                    String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugInfo1.getDrugName() + "的药理作用是什么", "药理作用");
                    drugInfo1.setPharmacology(s);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }

            }
            if (StringUtils.isEmpty(drugInfo1.getPharmacokinetics())) {

                try {
                    String s = com.sentum.util.HttpUtil.SearchWebFromBing(drugInfo1.getDrugName() + "的药代动力学是什么", "药代动力学");
                    drugInfo1.setPharmacokinetics(s);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }

            }


            String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
            InstructionDataVo instructionDataVo;

            TraditionalDataVo traditionalDataVo = new TraditionalDataVo();
            //说明书
            {
                TraditionalInstructionVo traditionalInstructionVo = new TraditionalInstructionVo();
                if (drugInfo1.getAdverseReaction() != null) {
                    traditionalInstructionVo.setAdverseReaction(drugInfo1.getAdverseReaction());
                } else {
                    String s = null;
                    try {
                        s = gptServiceImpl.getGpt("请总结根据以下材料：*******" + drugInfo1.toString() + "*******抽取总结" + drugNameDetail + "的不良反应。注意，如果没有则返回：说明书中未提及不良反应相关信息", "","");
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                    traditionalInstructionVo.setAdverseReaction(s);
                }

                if (drugInfo1.getChildrenMedicine() != null) {
                    traditionalInstructionVo.setChildren(drugInfo1.getChildrenMedicine());
                } else {

                    String s = "";
                    try {
                        s = gptServiceImpl.getGpt("请总结根据以下材料：*******" + drugInfo1 + "*******抽取总结" + drugNameDetail + "的儿童用药相关注意事项。注意，如果没有则返回：说明书中未提及儿童用药相关信息", "","");
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                    traditionalInstructionVo.setChildren(s);
                }

                if (drugInfo1.getGeriatricMedicine() != null) {
                    traditionalInstructionVo.setElderly(drugInfo1.getGeriatricMedicine());
                } else {

                    String s = "";
                    try {
                        s = gptServiceImpl.getGpt("请总结根据以下材料：*******" + drugInfo1 + "*******抽取总结" + drugNameDetail + "的老年人用药相关注意。注意，如果没有则返回：说明书中未提及老年人用药相关信息", "","");
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                    traditionalInstructionVo.setElderly(s);
                }

                if (drugInfo1.getPregnantWomen() != null) {
                    traditionalInstructionVo.setPregnant(drugInfo1.getPregnantWomen());
                } else {
                    String s = "";
                    try {
                        s = gptServiceImpl.getGpt("请总结根据以下材料：*******" + drugInfo1 + "*******抽取总结" + drugNameDetail + "的孕妇以及哺乳期用药相关注意事项。注意，如果没有则返回：说明书中未提及孕妇及哺乳期用药相关信息", "","");
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                    traditionalInstructionVo.setPregnant(s);


                }

                if (drugInfo1.getDoseAdjustmentPatientsWithLiverDysfunction() != null) {
                    traditionalInstructionVo.setLiver(drugInfo1.getDoseAdjustmentPatientsWithLiverDysfunction());
                } else {
                    String s = "";
                    try {
                        s = gptServiceImpl.getGpt("请总结根据以下材料：*******" + drugInfo1 + "*******抽取总结" + drugNameDetail + "的肝功能异常者用药相关注意事项。注意，如果没有则返回：说明书中未提及肝功能异常者用药相关信息", "","");
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                    traditionalInstructionVo.setLiver(s);
                }

                if (drugInfo1.getDoseAdjustmentPatientsWithRenalInsufficiency() != null) {
                    traditionalInstructionVo.setKidney(drugInfo1.getDoseAdjustmentPatientsWithRenalInsufficiency());
                } else {
                    String s = "";
                    try {
                        s = gptServiceImpl.getGpt("请总结根据以下材料：*******" + drugInfo1 + "*******抽取总结" + drugNameDetail + "的肾功能异常者用药相关注意事项。注意，如果没有则返回：说明书中未提及肾功能异常者用药相关信息", "","");
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                    traditionalInstructionVo.setKidney(s);
                }
                traditionalDataVo.setInstruction(traditionalInstructionVo);
                traditionalDataVo.setPharmacological(drugInfo1.getPharmacology());
            }

            traditionalDataVo.setManufacturer(drugInfo1.getManufacturer());
            //其他项prompt
            {
                // 安全性评价
                indicationMap2.put(drugId + TraditionalPromptEnum.SHOW_SAFETY_EVALUATION.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_SAFETY_EVALUATION.getDefaultPrompt(), drugInfo1));

//                // 古代经典名方目录
//                indicationMap.put(drugId + TraditionalPromptEnum.SHOW_CLASSIC.getKey(),
//                        PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_CLASSIC.getDefaultPrompt(), drugInfo1));

                // 创建一个列表来存储所有的 or 条件
                List<Criteria> orConditions = new ArrayList<>();

// 添加第一个 or 条件
                orConditions.add(Criteria.where("name").regex(drugInfo1.getDrugZh()));

// 添加第二个 or 条件
                orConditions.add(Criteria.where("name").regex(drugInfo1.getDrugName()));

// 使用 orOperator 将所有 or 条件组合成一个 Criteria
                Criteria orCriteria = new Criteria().orOperator(orConditions.toArray(new Criteria[0]));

// 构建查询
                Query query = new Query(orCriteria);

                List<JSONObject> jsonObjects = mongoTemplate.find(query, JSONObject.class, "prescript");
                if (CollUtil.isNotEmpty(jsonObjects)) {
                    traditionalDataVo.setClassic(drugInfo1.getDrugName() + "收录在了《古代经典名方》目录中。来源：" + jsonObjects.get(0).getString("source") + "。");
                } else {
                    traditionalDataVo.setClassic(drugInfo1.getDrugName() + "未收录在《古代经典名方》目录中。");
                }

                String drugZh = drugInfo1.getDrugZh();
                ArrayList<String> drugZhs = new ArrayList<>();
                drugZhs.add(drugZh);
                drugZhs.addAll(drugInfo1.getDrugSynonymZh());
                drugZhs.remove("");
                drugZhs.add(drugInfo1.getDrugName());

                //指纹图谱文献
                {
                    StringBuilder stringBuilder = new StringBuilder();
                    StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题");
                    stringBuilder1.append(" AND ");
                    StringBuilder stringBuilder2 = PromptUtil.montageForPaper(stringBuilder1, "指纹", "标题");
                    JSONObject jsonObject = new JSONObject();
                    jsonObject.put("query", stringBuilder2.toString());
                    jsonObject.put("type", "1");
                    String retrievalStr = formulaFeign.retrieval(jsonObject);
                    WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
                    QueryBuilder queryBuilder = QueryBuilders.boolQuery().must(wrapperQueryBuilder);
                    NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(queryBuilder);
                    SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);


                    if (literatureSearchHits.getTotalHits() > 0) {
                        StringBuilder literature1 = new StringBuilder();
                        int count = 0;
                        for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                            String title = literatureSearchHit.getContent().getTitle();
                            String count1 = "(" + (count + 1) + ")";
                            literature1.append(count1 + "《" + title + "》").append("\n");
//                            literature1.append("摘要:"+literatureSearchHit.getContent().getSummary());
                            literature1.append((StringUtils.isNotEmpty(literatureSearchHit.getContent().getTldr()) ?
                                    literatureSearchHit.getContent().getTldr() : literatureSearchHit.getContent().getSummary())).append("\n");
                            count++;

                            if (count > 5) {
                                break;
                            }
                        }
                        traditionalDataVo.setFingerprint(literature1.toString());

//                        indicationMap.put(drugId + TraditionalPromptEnum.SHOW_FINGERPRINTx.getKey(),
//                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_FINGERPRINTx.getDefaultPrompt(), drugInfo1, literature1.toString()));

                    } else {
                        indicationMap.put(drugId + TraditionalPromptEnum.SHOW_FINGERPRINT.getKey(),
                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_FINGERPRINT.getDefaultPrompt(), drugInfo1));
                    }
                }


                {
                    StringBuilder stringBuilder = new StringBuilder();
                    StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题");
                    stringBuilder1.append(" AND ");
                    ArrayList<String> strings = new ArrayList<>();
                    strings.add("有效");
                    strings.add("疗效");
                    StringBuilder stringBuilder2 = PromptUtil.montageForPaper(stringBuilder1, strings, "标题");
                    JSONObject jsonObject = new JSONObject();
                    jsonObject.put("query", stringBuilder2.toString());
                    jsonObject.put("type", "1");
                    String retrievalStr = formulaFeign.retrieval(jsonObject);
                    WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
                    TermQueryBuilder termQueryBuilder = QueryBuilders.termQuery("lastNewType", 0);
                    BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
                    boolQueryBuilder.must().add(wrapperQueryBuilder);
                    boolQueryBuilder.must().add(termQueryBuilder);
                    NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
                    SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);

                    BoolQueryBuilder boolQueryBuilder1 = new BoolQueryBuilder();
                    BoolQueryBuilder boolQueryBuilder2 = new BoolQueryBuilder();
                    boolQueryBuilder2.should().add(QueryBuilders.termQuery("lastNewType", 3));
                    boolQueryBuilder2.should().add(QueryBuilders.termQuery("lastNewType", 4));
                    boolQueryBuilder2.should().add(QueryBuilders.termQuery("lastNewType", 6));
                    boolQueryBuilder2.should().add(QueryBuilders.termQuery("lastNewType", 7));
                    boolQueryBuilder1.must().add(wrapperQueryBuilder);
                    boolQueryBuilder1.must().add(boolQueryBuilder2);
                    NativeSearchQuery nativeSearchQuery1 = new NativeSearchQuery(boolQueryBuilder1);
                    SearchHits<Literature> literatureSearchHits1 = this.elasticsearchRestTemplate.search(nativeSearchQuery1, Literature.class);


                    if (literatureSearchHits.getTotalHits() > 0) {
                        StringBuilder literature1 = new StringBuilder();

                        int count = 0;
                        for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                            String title = literatureSearchHit.getContent().getTitle();
                            Literature literature = literatureSearchHit.getContent();
                            String count1 = "(" + (count + 1) + ")";
                            literature1.append(count1 + "《" + title + "》").append("\n");
//                            literature1.append("摘要:"+literatureSearchHit.getContent().getSummary());
                            literature1.append((StringUtils.isNotEmpty(literatureSearchHit.getContent().getTldr()) ?
                                    literatureSearchHit.getContent().getTldr() : literatureSearchHit.getContent().getSummary())).append("\n");
                            count++;
                            if (count > 5) {
                                break;
                            }
                        }
                        traditionalDataVo.setValidity(literature1.toString());
//                        indicationMap.put(drugId + TraditionalPromptEnum.SHOW_VALIDITY_EVALUATIONx.getKey(),
//                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_VALIDITY_EVALUATIONx.getDefaultPrompt(), drugInfo1, literature1.toString()));

                    }

                    if (StringUtils.isEmpty(traditionalDataVo.getValidity()) && literatureSearchHits1.getTotalHits() > 0) {
                        StringBuilder literature1 = new StringBuilder();
                        int count = 0;
                        for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                            String title = literatureSearchHit.getContent().getTitle();


                            String count1 = "(" + (count + 1) + ")";
                            literature1.append(count1 + "《" + title + "》").append("\n");
//                            literature1.append("摘要:"+literatureSearchHit.getContent().getSummary());
                            literature1.append((StringUtils.isNotEmpty(literatureSearchHit.getContent().getTldr()) ?
                                    literatureSearchHit.getContent().getTldr() : literatureSearchHit.getContent().getSummary())).append("\n");
                            count++;
                            if (count > 5) {
                                break;
                            }
                        }
                        traditionalDataVo.setValidity(literature1.toString());
                    }


                    if (StringUtils.isEmpty(traditionalDataVo.getValidity())) {
                        // 有效性评价
                        indicationMap2.put(drugId + TraditionalPromptEnum.SHOW_VALIDITY_EVALUATION.getKey(),
                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_VALIDITY_EVALUATION.getDefaultPrompt(), drugInfo1));

                    }

                }
                {
                    StringBuilder stringBuilder = new StringBuilder();
                    StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题");
                    stringBuilder1.append(" AND ");
                    StringBuilder stringBuilder2 = PromptUtil.montageForPaper(stringBuilder1, "测定", "标题");
                    JSONObject jsonObject = new JSONObject();
                    jsonObject.put("query", stringBuilder2.toString());
                    jsonObject.put("type", "1");
                    String retrievalStr = formulaFeign.retrieval(jsonObject);
                    WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
                    QueryBuilder queryBuilder = QueryBuilders.boolQuery().must(wrapperQueryBuilder);
                    NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(queryBuilder);
                    SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);


                    if (literatureSearchHits.getTotalHits() > 0) {
                        StringBuilder literature1 = new StringBuilder();
                        int count = 0;
                        for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                            String title = literatureSearchHit.getContent().getTitle();
                            String count1 = "(" + (count + 1) + ")";
                            literature1.append(count1 + "《" + title + "》").append("\n");
//                            literature1.append("摘要:"+literatureSearchHit.getContent().getSummary());
                            literature1.append((StringUtils.isNotEmpty(literatureSearchHit.getContent().getTldr()) ?
                                    literatureSearchHit.getContent().getTldr() : literatureSearchHit.getContent().getSummary())).append("\n");
                            count++;
                            if (count > 5) {
                                break;
                            }
                        }
                        traditionalDataVo.setContent(literature1.toString());
//                        indicationMap2.put(drugId + TraditionalPromptEnum.SHOW_CONTENT_DETECTIONx.getKey(),
//                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_CONTENT_DETECTIONx.getDefaultPrompt(), drugInfo1, literature1.toString()));
                    } else {
                        indicationMap2.put(drugId + TraditionalPromptEnum.SHOW_CONTENT_DETECTION.getKey(),
                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_CONTENT_DETECTION.getDefaultPrompt(), drugInfo1));
                    }

                    // 含量测定方法

                }
                // 专利、所获奖项
                indicationMap2.put(drugId + TraditionalPromptEnum.SHOW_PATENT.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_PATENT.getDefaultPrompt(), drugInfo1));

                // 企业状况
                indicationMap.put(drugId + TraditionalPromptEnum.SHOW_MANUFACTURERS.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_MANUFACTURERS.getDefaultPrompt(), drugInfo1));


            }


            //同义词
            ArrayList<String> drugNames = new ArrayList<>();
            GetSynonymsDrugName(drugInfo1.getDrugName(), drugNames, drugInfo1);


            traditionalDataVo.setDrugId(drugInfo1.getId());
            traditionalDataVo.setTitle(drugNameDetail);

            ArrayList<GuidelinesVo> guidelinesVos = new ArrayList<>();
            traditionalDataVo.setGuide(guidelinesVos);
            DrugInfoNew finalDrugInfo = drugInfo1;
//                CompletableFuture<Boolean> guideResult = CompletableFuture.supplyAsync(() -> {
            long l = System.currentTimeMillis();
            try {
//                    String drugZh = drugInfo1.getDrugZh();
//                    ArrayList<String> drugZhs = new ArrayList<>();
//                    drugZhs.add(drugZh);
//                    drugZhs.addAll(drugInfo1.getDrugSynonymZh());
//                    drugZhs.remove("");
//                    drugZhs.add(drugInfo1.getDrugName());
                List<GuideVO> guideVOList = lxGptService.queryGuideByDrugAndDisease(drugNames, finalDrugInfo.getDrugZh(), new ArrayList<>(), "");
//                    StringBuilder stringBuilder = new StringBuilder();
//                    StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "");
//                    JSONObject jsonObject = new JSONObject();
//                    jsonObject.put("query", stringBuilder1.toString());
//                    jsonObject.put("type", "2");
//                    String retrievalStr = formulaFeign.retrieval(jsonObject);
//                    WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
//                    QueryBuilder queryBuilder = QueryBuilders.boolQuery().must(wrapperQueryBuilder);
//                    NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(queryBuilder);
//                    nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "dateTs"));
//                    SearchHits<GuideVO> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, GuideVO.class);
//                    ArrayList<GuideVO> guideVOList = new ArrayList<>();
//                    for (SearchHit<GuideVO> literatureSearchHit : literatureSearchHits) {
//                        guideVOList.add(literatureSearchHit.getContent());
//                        if (guideVOList.size() > 5){
//                            break;
//                        }
//                    }
                if (CollUtil.isNotEmpty(guideVOList)) {
                    for (GuideVO guideVO : guideVOList) {
                        GuidelinesVo guidelinesVo = new GuidelinesVo();
                        guidelinesVo.setContent(guideVO.getPdf_txt());
                        guidelinesVo.setZdz(guideVO.getZdz());
                        guidelinesVo.setTitle(guideVO.getTitle());
                        guidelinesVo.setFdaDate(guideVO.getFbdate());
                        guidelinesVo.setType("1");
                        guidelinesVo.setId(guideVO.getId());
                        guidelinesVo.setIsPaper(guideVO.getIsPaper());
                        guidelinesVo.setShowField(guideVO.getTitle() + "-" + guideVO.getZdz() + "-" + guideVO.getFbdate());
                        guidelinesVos.add(guidelinesVo);
                    }

                }
            } catch (Exception e) {
                log.error("xiaoling error", e);
            }
            long k = System.currentTimeMillis();
            System.out.println("********************************************耗时1：" + (k - l));
//                    return true;
//                }, gptAnalysisThreadPool);


            ArrayList<GuidelinesVo> guidelinesVos1 = new ArrayList<>();
            traditionalDataVo.setLiterature(guidelinesVos1);
//                CompletableFuture<Boolean> literatureResult = CompletableFuture.supplyAsync(() -> {
            long l2 = System.currentTimeMillis();
            // List<Literature> literatureList = lxGptService.queryLiterature(drugInfo1.getDrugZh(), drugNames, s, diseases);

            String drugZh = drugInfo1.getDrugZh();
            ArrayList<String> drugZhs = new ArrayList<>();
            drugZhs.add(drugZh);
            drugZhs.addAll(drugInfo1.getDrugSynonymZh());
            drugZhs.remove("");
            drugZhs.add(drugInfo1.getDrugName());
//                    List<GuideVO> guideVOList = lxGptService.queryGuideByDrugAndDisease(drugNames, finalDrugInfo.getDrugZh(), new ArrayList<>(), "");
            StringBuilder stringBuilder = new StringBuilder();
            StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("query", stringBuilder1.toString());
            jsonObject.put("type", "1");
            String retrievalStr = formulaFeign.retrieval(jsonObject);
            WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
            QueryBuilder queryBuilder = QueryBuilders.boolQuery().must(wrapperQueryBuilder);
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(queryBuilder);
            nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "year"));
            SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
            List<Literature> literatureList = new ArrayList<>();
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                literatureList.add(literatureSearchHit.getContent());
            }

            if (CollUtil.isNotEmpty(literatureList)) {
                for (Literature literature : literatureList) {
                    GuidelinesVo guidelinesVo = new GuidelinesVo();
                    guidelinesVo.setContent(literature.getTldr());
                    if (StringUtils.isEmpty(guidelinesVo.getContent())) {
                        guidelinesVo.setContent(literature.getSummary());
                    }
                    guidelinesVo.setZdz(literature.getJournal());
                    guidelinesVo.setTitle(literature.getTitle());
                    guidelinesVo.setFdaDate(literature.getYear());
                    guidelinesVo.setType("2");
                    guidelinesVo.setId(literature.getId());
                    guidelinesVo.setIsPaper(0);
                    guidelinesVo.setAuthor(literature.getAuthor());
                    StringBuilder partition = new StringBuilder();
                    if ("zh".equals(literature.getLanguage())) {
                        List<String> recognizedKernelJournals = literature.getJournalDivision();
                        if (CollUtil.isNotEmpty(recognizedKernelJournals) && recognizedKernelJournals.size() >= 2) {
                            for (String recognizedKernelJournal : recognizedKernelJournals) {
                                switch (recognizedKernelJournal) {
                                    case "Technology":
                                        partition.append("科技核心、");
                                        break;
                                    case "Peking University":
                                        partition.append("北大核心、");
                                        break;
                                    case "Nanjing University":
                                        partition.append("南大核心、");
                                        break;
                                    case "CSCD":
                                        partition.append("CSCD、");
                                        break;
                                    default:
                                        break;
                                }
                            }
                            if (partition.length() > 0) {
                                partition.delete(partition.length() - 1, partition.length());
                            }

                            String s = literature.getTitle() + "-" + literature.getJournal() + "-" + literature.getYear();
                            if (partition.length() > 0) {
                                guidelinesVo.setShowField(s + " (" + partition + ")");
                            }
                        } else {
                            continue;
                        }
                        if (guidelinesVos1.size() >= 5) {
                            break;
                        }
                    }
//                        String s = literature.getTitle() + "-" + literature.getJournal() + "-" + literature.getYear();
//                        if (StringUtils.isEmpty(guidelinesVo.getShowField())){
//                            guidelinesVo.setShowField(s);
//                        }
                    guidelinesVos1.add(guidelinesVo);
                }
                traditionalDataVo.setLiterature(guidelinesVos1);
            }


//                    return true;
//                }, gptAnalysisThreadPool);

//                threadMap.put("guideResult" + drugId + disease, guideResult);
//                threadMap.put("literatureResult" + drugId, literatureResult);
            traditionalDataVo.setDrugName(drugInfo1.getDrugName());
            drugDisDatas.add(traditionalDataVo);


        }


//            String query = "请根据知识库分析" + drugInfo1.getManufacturer() + "的生产企业状况，该企业在制药企业和工信部医药工业百强榜企业中的排名情况";
        //            indicationMap.put(drugInfo1.getManufacturer() + "ma", query);


        HashMap<String, String> Mapx = new HashMap<>();
        AtomicInteger x = new AtomicInteger(1);
        HashMap<String, String> promptR = new HashMap<>();
        StringBuilder stringBuilder = new StringBuilder();
        stringBuilder.append("请根据以下提示，分析以下这些问题（不同序号问题之间没有关联性）：\n");
        indicationMap.forEach((k, v) -> {
            String key = "问题" + x;
            String prompt = key + "：" + v + "回答时请不要带标题’问题几‘的字样\n";
            stringBuilder.append(prompt);
            String title = "question" + x;
            promptR.put(title, "###" + key + "###的答案");
            Mapx.put(k, title);
            x.incrementAndGet();

        });
        JSONObject responseFormat = getResponseFormat(promptR);


        HashMap<String, String> Mapx2 = new HashMap<>();
        AtomicInteger x2 = new AtomicInteger(1);
        HashMap<String, String> promptR2 = new HashMap<>();
        StringBuilder stringBuilder2 = new StringBuilder();
        stringBuilder2.append("请根据以下提示，分析以下这些问题（不同序号问题之间没有关联性（返回一定要跟序号对应），存在必要的换行使用$$代替）：\n");
        indicationMap2.forEach((k, v) -> {
            String key = "问题" + x2;
            String prompt = key + "：" + v + "回答时请不要带标题’问题几的答案‘的字样，注意：返回对应字段" + key + "\n";
            stringBuilder2.append(prompt);
            String title = "问题" + x2;
            promptR2.put(title, "###" + key + "###的答案");
            Mapx2.put(k, title);
            x2.incrementAndGet();

        });
        JSONObject responseFormat2 = getResponseFormat(promptR2);


        //创建子线程执行
        CompletableFuture<Boolean> total = CompletableFuture.supplyAsync(() -> {
            JSONObject jsonObject = lxGptService.executeGptPlus(stringBuilder.toString(), "检索所有项目", responseFormat, "","");
            JSONObject jsonObject2 = lxGptService.executeGptPlus(stringBuilder2.toString(), "检索所有项目", responseFormat2, "gpt-4o-2024-08-06","");
            log.info(jsonObject.toJSONString());
            log.info(jsonObject2.toJSONString());
            for (TraditionalDataVo drugDisData : drugDisDatas) {
                String drugId = drugDisData.getDrugId();
                try {
//                    String maKey = drugDisData.getManufacturer() + "ma";
//                    String ma = Mapx.get(maKey);
//                    if (ma != null) {
//                        String s = jsonObject.getString(ma).replaceAll("\\$\\$", "\n");
//                        drugDisData.setManufacturers(s);
//                    } else {
//                        drugDisData.setManufacturers("暂无");
//                    }
                    String que = drugDisData.getManufacturer() + "企业在制药企业和工信部医药工业百强榜企业中的排名情况";
                    String s = com.sentum.util.HttpUtil.SearchWebFromBing(que, que);
                    drugDisData.setManufacturers(s);
                } catch (Exception e) {
                    drugDisData.setManufacturers("暂无");
                    e.printStackTrace();
                }

                //安全性评价
                try {
                    String in = Mapx2.get(drugId + TraditionalPromptEnum.SHOW_SAFETY_EVALUATION.getKey());
                    if (in != null) {
                        String s = jsonObject2.getString(in).replaceAll("\\$\\$", "\n");
                        drugDisData.setSafety(s);
                    } else {
                        drugDisData.setSafety("暂无");
                    }
                } catch (Exception e) {
                    drugDisData.setSafety("暂无");
                    e.printStackTrace();
                }
                //指纹图谱研究
                try {
                    String clKey = drugId + TraditionalPromptEnum.SHOW_FINGERPRINT.getKey();
                    String cl = Mapx.get(clKey);
                    if (cl != null) {
                        String s = jsonObject.getString(cl).replaceAll("\\$\\$", "\n");
                        drugDisData.setFingerprint(s);

                    } else {
//                            drugDisData.setFingerprint("暂无");
                    }
                } catch (Exception e) {
                    drugDisData.setFingerprint("暂无");
                    e.printStackTrace();
                }

//                //古代经典名方目录
//                    try {
//                        String glKey = drugId + TraditionalPromptEnum.SHOW_CLASSIC.getKey();
//                        String gl = Mapx.get(glKey);
//                        if (gl != null) {
//                            String s = jsonObject.getString(gl).replaceAll("\\$\\$", "\n");
//                            drugDisData.setClassic(s);
//                        } else {
//                            drugDisData.setClassic("暂无");
//                        }
//                    } catch (Exception e) {
//                        drugDisData.setClassic("暂无");
//                        e.printStackTrace();
//                    }

                //专利、所获奖项
                try {
                    String glKey = drugId + TraditionalPromptEnum.SHOW_PATENT.getKey();
                    String gl = Mapx2.get(glKey);
                    if (gl != null) {
                        String s = jsonObject2.getString(gl).replaceAll("\\$\\$", "\n");
                        drugDisData.setPatent(s);
                    } else {
                        drugDisData.setPatent("暂无");
                    }
                } catch (Exception e) {
                    drugDisData.setPatent("暂无");
                    e.printStackTrace();
                }
                //内容检测
                try {
                    String glKey = drugId + TraditionalPromptEnum.SHOW_CONTENT_DETECTION.getKey();
                    String gl = Mapx2.get(glKey);
                    if (gl != null) {
                        String s = jsonObject2.getString(gl).replaceAll("\\$\\$", "\n");
                        drugDisData.setContent(s);
                    } else {
//                            drugDisData.setContent("暂无");
                    }
                } catch (Exception e) {
                    drugDisData.setContent("暂无");
                    e.printStackTrace();
                }
                //有效性再评价
                try {
                    String glKey = drugId + TraditionalPromptEnum.SHOW_VALIDITY_EVALUATION.getKey();
                    String gl = Mapx2.get(glKey);
                    if (gl != null) {
                        String s = jsonObject2.getString(gl).replaceAll("\\$\\$", "\n");
                        drugDisData.setValidity(s);
                    } else {
//                            drugDisData.setValidity("暂无");
                    }
                } catch (Exception e) {
                }

            }

            return true;
        }, gptAnalysisThreadPool);

        threadMap.put("total", total);

        long endTime = System.currentTimeMillis();
        System.out.println("********************************************总耗时：" + (endTime - startTime));
        CompletableFuture.allOf(threadMap.values().toArray(new CompletableFuture[threadMap.size()]))
                .exceptionally(ex -> {
                    log.error("子线程处理过程中出现异常: {}", ex.getMessage(), ex);
                    return null;
                }).join();


        return drugDisDatas;
    }

    @Autowired
    private LxGptService gptServiceImpl;

    @Override
    public Object guideOnAnalysis(String drugName, String disease, String specifications, String id, String priceId,
                                  long userId, String isCustom, String drugId, String searchId) {
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品遴选");
            dataJson.put("module", "药学");
            dataJson.put("report_name", drugName + "治疗" + disease);
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }

        Object report = guidePanel(drugName, disease, specifications, id, priceId, userId, isCustom, drugId, searchId);
        return report;
    }


    public Object guideOnAnalysisV2(String drugName, String disease, String specifications, String id, String priceId,
                                    long userId, String isCustom, String drugId, String searchId) {
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品遴选");
            dataJson.put("module", "药学");
            dataJson.put("report_name", drugName + "治疗" + disease);
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }

        Object report = guidePanelV2(drugName, disease, specifications, id, priceId, userId, isCustom, drugId, searchId);
        return report;
    }


    @Value("${sys.isDev}")
    private String isDev;


    private Object guidePanelV2(String drugName, String disease, String specifications, String id, String priceId, long userId, String isCustom, String drugId, String searchId) {
        JSONObject one = mongoTemplate.findOne(new Query().addCriteria(Criteria.where("priceId").is(priceId)), JSONObject.class, "drug_info_tra_v2");
        JSONArray jsonArray = one.getJSONArray("list");
        for (JSONObject o1 : jsonArray.toJavaList(JSONObject.class)) {
            log.info("o1 = {}", o1);
            JSONArray jsonArray1 = o1.getJSONObject("trClinicalEvaluationDto").getJSONArray("evidenceItems");
            log.info("jsonArray1 = {}", jsonArray1);
            o1.getJSONObject("trClinicalEvaluationDto").put("evidenceItems", new JSONArray());

            TrInfoDto o = JSONObject.toJavaObject(o1, TrInfoDto.class);
            List<TrClinicalEvaluationDto.EvidenceItem> evidenceItems = new ArrayList<>();
            jsonArray1.forEach(jsonObject -> {
                try {
                    String s = JSON.toJSONString(jsonObject);
                    JSONObject jsonObject1 = JSONObject.parseObject(s);
                    TrClinicalEvaluationDto.EvidenceItem evidenceItem = new TrClinicalEvaluationDto.EvidenceItem(jsonObject1.getString("title"), jsonObject1.getString("content"));
                    evidenceItems.add(evidenceItem);
                } catch (Exception e) {
                    log.error("解析异常", e);
                }
            });
            addScore(o);
            o.getTrClinicalEvaluationDto().setEvidenceItems(evidenceItems);
            if (drugId.equals(o.getDrugId())) {

                JSONObject jsonObject = addProcessx(o, id);
                String reportId = UUID.randomUUID().toString();
                jsonObject.put("reportId", reportId);
                TrInfoScoreVo trInfoScoreVo = new TrInfoScoreVo();
                trInfoScoreVo.setTotalScore(o.getTotalScore() + "");
                trInfoScoreVo.setDrugId(o.getDrugId());
                trInfoScoreVo.setDrugName(o.getDrugName());
                trInfoScoreVo.setTitle(o.getTitle());
                trInfoScoreVo.setReportId(id);
                trInfoScoreVo.setSearchId(o.getSearchId());
                trInfoScoreVo.setTrClinicalEvaluationScore(doubleToString(o.getTrClinicalEvaluationDto().getTotalScore()));
                trInfoScoreVo.setTrInheritanceEvaluationScore(doubleToString(o.getTrInheritanceEvaluationDto().getTotalScore()));
                trInfoScoreVo.setTrMarketEvaluationScore(doubleToString(o.getTrMarketEvaluationDto().getTotalScore()));
                trInfoScoreVo.setTrSafetyEvaluationScore(doubleToString(o.getTrSafetyEvaluationDto().getTotalScore()));
                trInfoScoreVo.setTrTechnologyEvaluationScore(doubleToString(o.getTrTechnologyEvaluationDto().getTotalScore()));
                mongoTemplate.save(jsonObject, "tr_info_score_v2");
                trInfoScoreVo.setReportId(reportId);
                return trInfoScoreVo;
            }
        }
        return null;
    }


    private void addScore(TrInfoDto trInfoDto) {
        trInfoDto.getTrClinicalEvaluationDto().setTotalScore();
        trInfoDto.getTrMarketEvaluationDto().setPolicyAttributeScore();
        trInfoDto.getTrMarketEvaluationDto().setTotalScore();
        trInfoDto.getTrInheritanceEvaluationDto().setTotalScore();
        trInfoDto.getTrSafetyEvaluationDto().setCrowdRestrictionScore();
        trInfoDto.getTrSafetyEvaluationDto().setSafetyInfoScore();
        trInfoDto.getTrSafetyEvaluationDto().setTotalScore();
        trInfoDto.getTrTechnologyEvaluationDto().setSuitabilityScore();
        trInfoDto.getTrTechnologyEvaluationDto().setAdditionalZodiacScore();
        trInfoDto.getTrTechnologyEvaluationDto().setTotalScore();
        trInfoDto.setTotalScore();


    }


    private String doubleToString(double x) {
        String s = String.valueOf(x);
        if (s.contains(".0")) {
            return s.substring(0, s.length() - 2);
        } else if (s.contains(".00")) {
            return s.substring(0, s.length() - 3);
        } else if (s.contains(".") && s.endsWith("0")) {
            return s.substring(0, s.length() - 1);
        }
        return s;
    }


    //拼分析页面
    private JSONObject addProcessx(TrInfoDto trInfoDto, String id) {
        ArrayList<String> stringBuilder = new ArrayList<>();

        JSONObject jsonObject = (JSONObject) JSONObject.toJSON(trInfoDto);
        TrInheritanceEvaluationDto inheritanceEvaluation = trInfoDto.getTrInheritanceEvaluationDto();
        TrClinicalEvaluationDto clinicalEvaluation = trInfoDto.getTrClinicalEvaluationDto();
        TrSafetyEvaluationDto safetyEvaluation = trInfoDto.getTrSafetyEvaluationDto();
        TrTechnologyEvaluationDto technologyEvaluation = trInfoDto.getTrTechnologyEvaluationDto();
        TrMarketEvaluationDto marketEvaluation = trInfoDto.getTrMarketEvaluationDto();
        int step = 0;
        String drugName = trInfoDto.getDrugName();
        addProcessx(id, step++, "<p class='text_title'>基于河北省公立医疗机构中成药遴选评价表，对" + trInfoDto.getTitle() + "进行临床综合评价：</p>", stringBuilder);
        addProcessx(id, step++, "<b>1、传承评价</b>", stringBuilder);
        addProcessx(id, step++, "<b>1.1 组方来源</b>", stringBuilder);
        addProcess(id, step++, trInfoDto.getTrInheritanceEvaluationDto().getRecipeSourceContent(), stringBuilder);
        addProcessx(id, step++, "<b>1.2 理论支撑</b>", stringBuilder);
        addProcess(id, step++, trInfoDto.getTrInheritanceEvaluationDto().getTheorySupportContent(), stringBuilder);
        addProcessx(id, step++, "<b>1.3 病证结合</b>", stringBuilder);
        addProcess(id, step++, trInfoDto.getTrInheritanceEvaluationDto().getDiseaseCombinationContent(), stringBuilder);
        jsonObject.getJSONObject("trInheritanceEvaluationDto").put("trInheritanceEvaluationScore", drugName + "在传承评价的得分为：" + inheritanceEvaluation.getTotalScore() + "分");
        // 临床评价
        addProcessx(id, step++, "<b>2、临床评价</b>", stringBuilder);
        addProcessx(id, step++, "<b>2.1 临床定位</b>", stringBuilder);
        addProcess(id, step++, clinicalEvaluation.getClinicalPositioningContent(), stringBuilder);
        addProcessx(id, step++, "<b>2.2 临床研究</b>", stringBuilder);
        addProcess(id, step++, clinicalEvaluation.getClinicalResearchContent(), stringBuilder);
        addProcessx(id, step++, "<b>2.3 证据推荐</b>", stringBuilder);
        List<TrClinicalEvaluationDto.EvidenceItem> evidenceItems = clinicalEvaluation.getEvidenceItems();
        if (CollUtil.isEmpty(evidenceItems)) {
            addProcessx(id, step++, "未找到相关指南", stringBuilder);
        } else {
            int x = 1;
            for (TrClinicalEvaluationDto.EvidenceItem evidenceItem : evidenceItems) {
                addProcessx(id, step++, x + ")" + evidenceItem.getTitle(), stringBuilder);
                addProcess(id, step++, evidenceItem.getContent(), stringBuilder);
                x++;
            }
        }
        addProcessx(id, step++, "<b>2.4 临床需求</b>", stringBuilder);
        if (StringUtils.isNotEmpty(clinicalEvaluation.getClinicalDemandOption())) {
            switch (clinicalEvaluation.getClinicalDemandOption()) {
                case "1":
                    clinicalEvaluation.setClinicalDemandOption("填补本院用药目录空白");
                    break;
                case "2":
                    clinicalEvaluation.setClinicalDemandOption("可推动本院中医优势病种发展或可纳入临床路径");
                    break;
                case "3":
                    clinicalEvaluation.setClinicalDemandOption("可为收治患者提供多种用药选择");
                    break;
            }
        } else {
            clinicalEvaluation.setClinicalDemandOption("暂无内容");
        }

        addProcess(id, step++, clinicalEvaluation.getClinicalDemandOption(), stringBuilder);
        jsonObject.put("trClinicalEvaluationDto", clinicalEvaluation);
        jsonObject.getJSONObject("trClinicalEvaluationDto").put("trClinicalEvaluationScore", drugName + "在临床评价的得分为：" + clinicalEvaluation.getTotalScore() + "分");

        // 安全评价
        addProcessx(id, step++, "<b>3、安全评价</b>", stringBuilder);
        addProcessx(id, step++, "<b>3.1 安全信息评价</b>", stringBuilder);
        addProcessx(id, step++, "<b>3.1.1 不良反应、禁忌等描述</b>", stringBuilder);
        addProcess(id, step++, safetyEvaluation.getAdverseReactionContent(), stringBuilder);
        addProcessx(id, step++, "<b>3.1.2 说明书中警示语或注意事项</b>", stringBuilder);
        addProcess(id, step++, safetyEvaluation.getWarningNoteContent(), stringBuilder);
        addProcessx(id, step++, "<b>3.1.3 辅料</b>", stringBuilder);
        addProcess(id, step++, String.valueOf(safetyEvaluation.getExcipient()), stringBuilder);
        addProcessx(id, step++, "<b>3.1.4 安全性再评价</b>", stringBuilder);
        addProcess(id, step++, safetyEvaluation.getSafetyReevaluationContent(), stringBuilder);
        addProcessx(id, step++, "<b>3.2 人群限制</b>", stringBuilder);
        addProcessx(id, step++, "<b>3.2.1 儿童用药</b>", stringBuilder);
        addProcess(id, step++, safetyEvaluation.getPediatricDrugUseContent(), stringBuilder);
        addProcessx(id, step++, "<b>3.2.2 妊娠期妇女用药</b>", stringBuilder);
        addProcess(id, step++, safetyEvaluation.getPregnancyDrugUseContent(), stringBuilder);
        addProcessx(id, step++, "<b>3.2.3 哺乳期妇女用药</b>", stringBuilder);
        addProcess(id, step++, safetyEvaluation.getLactationDrugUseContent(), stringBuilder);
        addProcessx(id, step++, "<b>3.2.4 肝功能异常者用药</b>", stringBuilder);
        addProcess(id, step++, safetyEvaluation.getLiverDysfunctionDrugUseContent(), stringBuilder);
        addProcessx(id, step++, "<b>3.2.5 肾功能异常者用药</b>", stringBuilder);
        addProcess(id, step++, safetyEvaluation.getKidneyDysfunctionDrugUseContent(), stringBuilder);
        addProcessx(id, step++, "<b>3.2.6 运动员用药</b>", stringBuilder);
        addProcess(id, step++, safetyEvaluation.getAthleteDrugUseContent(), stringBuilder);
        addProcessx(id, step++, "<b>3.3 不良反应分级</b>", stringBuilder);
        addProcessx(id, step++, safetyEvaluation.getAdverseReactionStratificationContent(), stringBuilder);
        jsonObject.getJSONObject("trSafetyEvaluationDto").put("trSafetyEvaluationScore", drugName + "在安全性评价的得分为：" + safetyEvaluation.getTotalScore() + "分");
        // 技术评价
        addProcessx(id, step++, "<b>4、技术评价</b>", stringBuilder);
        addProcessx(id, step++, "<b>4.1 适宜性</b>", stringBuilder);
        addProcessx(id, step++, "<b>4.1.1 给药频次</b>", stringBuilder);
        addProcess(id, step++, technologyEvaluation.getAdministrationFrequencyContent(), stringBuilder);

        if (StringUtils.isNotEmpty(technologyEvaluation.getPackagingSpecificationOption())) {
            switch (technologyEvaluation.getPackagingSpecificationOption()) {
                case "1":
                    technologyEvaluation.setPackagingSpecificationOption("包装规格与临床常用日剂量适配(两者比值为整数)");
                    break;
                case "2":
                    technologyEvaluation.setPackagingSpecificationOption("包装规格与临床常用日剂量适配(两者比值为非整数)");
                    break;

            }
        } else {
            technologyEvaluation.setPackagingSpecificationOption("暂无内容");
        }


        addProcessx(id, step++, "<b>4.1.2 包装规格</b>", stringBuilder);
        addProcess(id, step++, technologyEvaluation.getPackagingSpecificationOption(), stringBuilder);

        if (StringUtils.isNotEmpty(technologyEvaluation.getLargePackageAdoptionOption())) {
            switch (technologyEvaluation.getLargePackageAdoptionOption()) {
                case "1":
                    technologyEvaluation.setLargePackageAdoptionOption("最小包装使用人次数高于对照药");
                    break;
                case "2":
                    technologyEvaluation.setLargePackageAdoptionOption("最小包装使用人次数低于对照药");
                    break;
            }
        } else {
            technologyEvaluation.setLargePackageAdoptionOption("暂无内容");
        }

        addProcessx(id, step++, "<b>4.1.3 采用大包装</b>", stringBuilder);
        addProcess(id, step++, technologyEvaluation.getLargePackageAdoptionOption(), stringBuilder);

        if (StringUtils.isNotEmpty(technologyEvaluation.getSingleDoseOption())) {
            switch (technologyEvaluation.getSingleDoseOption()) {
                case "1":
                    technologyEvaluation.setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值为1)");
                    break;
                case "2":
                    technologyEvaluation.setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值>1)");
                    break;
                case "3":
                    technologyEvaluation.setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值<1)");
                    break;
            }
        } else {
            technologyEvaluation.setSingleDoseOption("暂无内容");
        }

        addProcessx(id, step++, "<b>4.1.4 单次用量</b>", stringBuilder);
        addProcess(id, step++, technologyEvaluation.getSingleDoseOption(), stringBuilder);
        addProcessx(id, step++, "<b>4.1.5 疗程</b>", stringBuilder);
        addProcess(id, step++, technologyEvaluation.getCourseOfTreatmentContent(), stringBuilder);
        addProcessx(id, step++, "<b>4.1.6 贮藏</b>", stringBuilder);
        addProcess(id, step++, technologyEvaluation.getStorageContent(), stringBuilder);
        addProcessx(id, step++, "<b>4.1.7 有效期</b>", stringBuilder);
        addProcess(id, step++, String.valueOf(technologyEvaluation.getValidityPeriodContent()), stringBuilder);
        addProcessx(id, step++, "<b>4.2 国家中药保护品种</b>", stringBuilder);
        addProcess(id, step++, String.valueOf(technologyEvaluation.getNationalTraditionalChineseMedicineProtectionContent()), stringBuilder);
        addProcessx(id, step++, "<b>4.3 附加属性</b>", stringBuilder);
        addProcessx(id, step++, "<b>4.3.1 中国药典</b>", stringBuilder);
        addProcess(id, step++, String.valueOf(technologyEvaluation.getChinesePharmacopoeiaContent()), stringBuilder);
        addProcessx(id, step++, "<b>4.3.2 专利</b>", stringBuilder);
        addProcess(id, step++, technologyEvaluation.getPatentNumber(), stringBuilder);
        addProcessx(id, step++, "<b>4.3.3 独家品种</b>", stringBuilder);
        addProcess(id, step++, technologyEvaluation.getExclusiveVarietyInfo(), stringBuilder);
        addProcessx(id, step++, "<b>4.4 生产企业状况</b>", stringBuilder);
        addProcess(id, step++, String.valueOf(technologyEvaluation.getProductionEnterpriseStatusContent()), stringBuilder);
        jsonObject.put("trTechnologyEvaluationDto", technologyEvaluation);
        jsonObject.getJSONObject("trTechnologyEvaluationDto").put("trTechnologyEvaluationScore", drugName + "在技术评价的得分为：" + technologyEvaluation.getTotalScore() + "分");
        // 市场评价
        addProcess(id, step++, "<b>5、市场评价</b>", stringBuilder);

        if (StringUtils.isNotEmpty(marketEvaluation.getMarketUniquenessOption())) {
            switch (marketEvaluation.getMarketUniquenessOption()) {
                case "1":
                    marketEvaluation.setMarketUniquenessOption("具有不可替代的唯一性或填补市场空白");
                    break;
                case "2":
                    marketEvaluation.setMarketUniquenessOption("与已上市的同类药品相比具有独特优势");
                    break;
                case "3":
                    marketEvaluation.setMarketUniquenessOption("市面上有同类药品");
                    break;
            }
        } else {
            marketEvaluation.setMarketUniquenessOption("暂无内容");
        }

        addProcessx(id, step++, "<b>5.1 市场独特性</b>", stringBuilder);
        addProcess(id, step++, marketEvaluation.getMarketUniquenessOption(), stringBuilder);

        if (StringUtils.isNotEmpty(marketEvaluation.getEconomicOption())) {
            switch (marketEvaluation.getEconomicOption()) {
                case "1":
                    marketEvaluation.setEconomicOption("日均治疗费用较同类中成药价格较低，且具有明显的药物经济学优势");
                    break;
                case "2":
                    marketEvaluation.setEconomicOption("日均治疗费用较同类中成药价格相当，且具有明显的药物经济学优势");
                    break;
                case "3":
                    marketEvaluation.setEconomicOption("日均治疗费用较同类中成药价格较低");
                    break;
                case "4":
                    marketEvaluation.setEconomicOption("日均治疗费用较同类中成药价格相当");
                    break;
                case "5":
                    marketEvaluation.setEconomicOption("日均治疗费用较同类中成药价格高");
                    break;
            }
        } else {
            marketEvaluation.setEconomicOption("暂无内容");
        }

        addProcessx(id, step++, "<b>5.2 经济性</b>", stringBuilder);
        addProcess(id, step++, marketEvaluation.getEconomicOption(), stringBuilder);
        addProcessx(id, step++, "<b>5.3 政策属性</b>", stringBuilder);
        addProcessx(id, step++, "<b>5.3.1 国家基本药物</b>", stringBuilder);
        addProcess(id, step++, marketEvaluation.getNationalEssentialDrugsRequirement(), stringBuilder);
        addProcessx(id, step++, "<b>5.3.2 国家医保药品</b>", stringBuilder);
        addProcess(id, step++, marketEvaluation.getNationalMedicalInsuranceDrugsPaymentRequirement(), stringBuilder);
        addProcessx(id, step++, "<b>5.3.3 集中带量采购药品或国家谈判品种（协议期内）</b>", stringBuilder);
        addProcess(id, step++, marketEvaluation.getCentralizedVolumePurchasingDrugsSource(), stringBuilder);
        addProcess(id, step++, "-END-", stringBuilder);
        jsonObject.put("trMarketEvaluationDto", marketEvaluation);
        jsonObject.getJSONObject("trMarketEvaluationDto").put("trMarketEvaluationScore", drugName + "在市场评价的得分为：" + marketEvaluation.getTotalScore() + "分");
        Date date = new Date();
        SimpleDateFormat simpleDateFormat = new SimpleDateFormat("yyyy-MM-dd");
        String format = simpleDateFormat.format(date);
        jsonObject.put("time", format);
        jsonObject.put("simpleTitle", drugName + "药品综合评价报告");
        return jsonObject;


    }


    @Override
    public Object guideOnAnalysisApp(String drugName, String disease, String specifications, String id, String priceId,
                                     long userId, String isCustom, String drugId, String searchId) {
        try {
            JSONObject dataJson = new JSONObject();
            dataJson.put("report_id", id);
            dataJson.put("user_id", userId);
            dataJson.put("function", "药品遴选");
            dataJson.put("module", "药学");
            dataJson.put("report_name", drugName + "治疗" + disease);
            dataJson.put("report_time", DateUtil.formatDateTime(new Date()));
            manageFeign.addReportInfo(dataJson);
        } catch (Exception e) {
            e.printStackTrace();
            log.error("科研选题添加机构汇总异常" + e.getCause());
        }


        Object report = guidePanelApp(id, priceId, drugId, searchId);
        return report;
    }


    private JSONObject getResponseFormat(Map<String, String> format) {
        JSONObject responseFormat = new JSONObject();
        JSONObject json_schema = new JSONObject();
        JSONObject schema = new JSONObject();
        JSONObject properties = new JSONObject();
        responseFormat.put("type", "json_schema");   //gpt未说明   固定
        responseFormat.put("json_schema", json_schema);  //gpt未说明   固定
        json_schema.put("name", "reasoning_schema");   //gpt未说明   固定
        json_schema.put("strict", true);  //开启固定格式

        schema.put("additionalProperties", false);
        ArrayList<String> strings = new ArrayList<>();//此对象包含的字段
        format.forEach((k, v) -> {                  //组装此对象的所有字段
            JSONObject propertie = new JSONObject();
            propertie.put("type", "string");   //这里默认认为字符串类型
            propertie.put("description", v);   // 此字段的描述
            properties.put(k, propertie);   // 此字段作为json的key，对应值为
            strings.add(k);
        });
        schema.put("properties", properties);
        schema.put("required", strings);  //此对象包含的字段
        schema.put("type", "object");
        json_schema.put("schema", schema);
        return responseFormat;

    }

    private boolean isEnglishOrDigit(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    }

    private boolean isChineseCharacter(char c) {
        return c >= '\u4e00' && c <= '\u9fa5';
    }

    public String calculateScoreAndTruncate(String input) {
        if (input == null || input.isEmpty()) {
            return "";
        }

        StringBuilder result = new StringBuilder();
        int score = 0;

        for (char c : input.toCharArray()) {
            if (isChineseCharacter(c)) {
                score += 2;
            } else if (isEnglishOrDigit(c)) {
                score += 1;
            } else {
                score += 1;
            }

            if (score > 140) {
                break;
            }

            result.append(c);
        }

        return result.toString();
    }

    private String formatInfo(String info) {
        if (ObjectUtil.isNotNull(info)) {
            int length = info.length();
            if (length > 50) {
                info = info.replaceAll("</br>", "");
                info = calculateScoreAndTruncate(info) + "...";
            }
        }
        return info;
    }

    private void addProcess(String id, int step, String msg, List<String> stringBuilder) {
        if (StrUtil.isBlank(msg)) {
            msg = "";
        }
        log.info(msg);
        msg = formatInfo(msg);
        stringBuilder.add(msg);
        redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
    }


    @Override
    public JSONObject guideOnline(String id) {
        JSONObject drugAnalyzeData = mongoTemplate.findOne(new Query(Criteria.where("reportId").is(id)), JSONObject.class, "drug_data_tra");
        if (drugAnalyzeData != null) {
            return drugAnalyzeData;
        }
        return new JSONObject();
    }

    @Override
    public Object guidePanel(String drugName, String disease, String specifications, String id, String priceId,
                             long userId, String isCustom, String drugId, String searchId) {

        BulletinBoardVo bulletinBoardVo = new BulletinBoardVo();
        //获取药品条件
        DrugInfoNew drugInfo1 = getDrugInfoNew(drugId, searchId);

        TraditionalInfoDto traditionalInfoDto = getFormat(drugInfo1, priceId);

        Map<String, Future<Boolean>> futureResult = new HashMap<>();

        HashMap<String, String> stringStringHashMap = new HashMap<>();

        useThreadPoolExecutePrompt(traditionalInfoDto, futureResult, stringStringHashMap);
        int step = 0;
        ArrayList<String> stringBuilder = new ArrayList<>();
        String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
        addProcess(id, step++, "<p class='text_title'>基于中成药量表，对" + drugNameDetail + "进行临床综合评价：</p>", stringBuilder);
        addProcess(id, step++, "<b>1、安全性</b>", stringBuilder);
        addProcessx(id, step++, "重点考察待遴选药品在临床应用的安全属性，主要从药品的不良反应分级或依据CTCAE分级（5分）、特殊人群用药限制（5分）、安全性评价（5分）和其他（3分）等方面考察药品的安全性。", stringBuilder);
        addProcess(id, step++, "<b>1.1 不良反应分级</b>", stringBuilder);
        step = traditionalGptService.setEffective(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);
        step = traditionalGptService.setEffective1(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);
        step = traditionalGptService.setMoneyRelevant(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);
        step = traditionalGptService.setDrugCharacteristic(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);
        step = traditionalGptService.setApplicability(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);
        step = traditionalGptService.setPolicyAdmission(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);


        BulletinBoardVo bulletinBoardVo1 = new BulletinBoardVo();
        double totalScore = 0.0;
        ArrayList<JSONObject> jsonObjects = new ArrayList<>();
        try {
            bulletinBoardVo1.setSecurity(JSONObject.parseObject(bulletinBoardVo.getSecurity().toString()).getString("score"));
            totalScore += Double.parseDouble(bulletinBoardVo1.getSecurity().toString());
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 18);
            jsonObject.put("name", "安全性");
            jsonObject.put("value", bulletinBoardVo1.getSecurity());
            jsonObjects.add(jsonObject);
        } catch (Exception e) {
            bulletinBoardVo1.setSecurity("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 18);
            jsonObject.put("name", "安全性");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

        try {
            bulletinBoardVo1.setApplicability(JSONObject.parseObject(bulletinBoardVo.getApplicability().toString()).getString("score"));
            totalScore += Double.parseDouble(bulletinBoardVo1.getApplicability().toString());
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 11);
            jsonObject.put("name", "适用性");
            jsonObject.put("value", bulletinBoardVo1.getApplicability());
            jsonObjects.add(jsonObject);
        } catch (Exception e) {
            bulletinBoardVo1.setApplicability("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 11);
            jsonObject.put("name", "适用性");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

        try {
            bulletinBoardVo1.setEffectiveness(JSONObject.parseObject(bulletinBoardVo.getEffectiveness().toString()).getString("score"));
            totalScore += Double.parseDouble(bulletinBoardVo1.getEffectiveness().toString());
            JSONObject jsonObject = new JSONObject();

            jsonObject.put("max", 20);
            jsonObject.put("name", "有效性");
            jsonObject.put("value", bulletinBoardVo1.getEffectiveness());
            jsonObjects.add(jsonObject);
        } catch (Exception e) {
            bulletinBoardVo1.setEffectiveness("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 20);
            jsonObject.put("name", "有效性");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

        Object economicViability = bulletinBoardVo.getEconomicViability();
        String jsonString = JSONObject.toJSONString(economicViability);
        JSONObject economicViability1 = JSONObject.parseObject(jsonString);
        try {
            bulletinBoardVo1.setEconomicViability(economicViability1.getString("score"));
            totalScore += Double.parseDouble(economicViability1.getString("score"));
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 15);
            jsonObject.put("name", "经济性");
            jsonObject.put("value", Double.parseDouble(economicViability1.getString("score")));
            jsonObjects.add(jsonObject);

        } catch (Exception e) {
            bulletinBoardVo1.setEconomicViability("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 15);
            jsonObject.put("name", "经济性");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

        try {
            bulletinBoardVo1.setPharmacy(JSONObject.parseObject(bulletinBoardVo.getPharmacy().toString()).getString("score"));
            totalScore += Double.parseDouble(bulletinBoardVo1.getPharmacy().toString());
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 14);
            jsonObject.put("name", "药学特性");
            jsonObject.put("value", bulletinBoardVo1.getPharmacy());
            jsonObjects.add(jsonObject);
        } catch (Exception e) {
            bulletinBoardVo1.setPharmacy("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 14);
            jsonObject.put("name", "药学特性");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

        try {
            bulletinBoardVo1.setPolicy(JSONObject.parseObject(bulletinBoardVo.getPolicy().toString()).getString("score"));
            totalScore += Double.parseDouble(bulletinBoardVo1.getPolicy().toString());

            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 22);
            jsonObject.put("name", "政策准入");
            jsonObject.put("value", bulletinBoardVo1.getPolicy());
            jsonObjects.add(jsonObject);

        } catch (Exception e) {
            bulletinBoardVo1.setPolicy("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 22);
            jsonObject.put("name", "政策准入");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

// 设置总分
        bulletinBoardVo1.setTotalScore(String.valueOf(totalScore));
        bulletinBoardVo.setReportId(id);
        bulletinBoardVo1.setReportId(id);

        JSONObject jsonObject = JSONObject.parseObject(JSON.toJSONString(bulletinBoardVo));
        JSONObject jsonObject1 = new JSONObject();
        jsonObject1.put("drugName", drugInfo1.getDrugName());
        jsonObject1.put("drugNameDetail", drugNameDetail);
        jsonObject1.put("dimensionDiagram", jsonObjects);
        jsonObject1.put("totalScore", totalScore);
        jsonObject1.put("title", drugInfo1.getDrugName() + "临床综合评价");
        //时间
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd");
        jsonObject1.put("time", format.format(new Date()));
        jsonObject.put("total", jsonObject1);
        addProcess(id, step++, "-END-", stringBuilder);
        NumberUtils.removeTrailingZeros(jsonObject);
        mongoTemplate.save(jsonObject, "drug_data_tra");
        return bulletinBoardVo1;
    }

    private void addProcessx(String id, int step, String msg, List<String> stringBuilder) {
        if (StrUtil.isBlank(msg)) {
            msg = "";
        }
        log.info(msg);
        stringBuilder.add(msg);
        this.redisTemplate.opsForValue().set("gpt:" + id + ":" + step, msg + "</br>", 1, TimeUnit.HOURS);
    }


    public Object guidePanelApp(String id, String priceId,
                                String drugId, String searchId) {

        BulletinBoardVo bulletinBoardVo = new BulletinBoardVo();
        //获取药品条件
        DrugInfoNew drugInfo1 = getDrugInfoNew(drugId, searchId);

        TraditionalInfoDto traditionalInfoDto = getFormatApp(drugInfo1, priceId);

        ConcurrentHashMap<String, Future<Boolean>> futureResult = new ConcurrentHashMap<>();

        ConcurrentHashMap<String, String> stringStringHashMap = new ConcurrentHashMap<>();

        useThreadPoolExecutePromptApp(traditionalInfoDto, futureResult, stringStringHashMap, drugInfo1);
        int step = 0;
        ArrayList<String> stringBuilder = new ArrayList<>();
        String drugNameDetail = drugInfo1.getDrugName() + (StringUtils.isNotEmpty(drugInfo1.getCommunityNameZh()) ? "(" + drugInfo1.getCommunityNameZh() + ")" : "") + "-" + drugInfo1.getSpecifications() + "-" + drugInfo1.getManufacturer();
        addProcess(id, step++, "<p class='text_title'>基于中成药量表，对" + drugNameDetail + "进行临床综合评价：</p>", stringBuilder);
        addProcess(id, step++, "<b>1、安全性</b>", stringBuilder);
        addProcessx(id, step++, "重点考察待遴选药品在临床应用的安全属性，主要从药品的不良反应分级或依据CTCAE分级（5分）、特殊人群用药限制（5分）、安全性评价（5分）和其他（3分）等方面考察药品的安全性。", stringBuilder);
        addProcess(id, step++, "<b>1.1 不良反应分级</b>", stringBuilder);
        step = traditionalGptService.setEffective(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);
        step = traditionalGptService.setEffective1App(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);
        step = traditionalGptService.setMoneyRelevant(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);
        step = traditionalGptService.setDrugCharacteristic(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);
        step = traditionalGptService.setApplicability(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);
        step = traditionalGptService.setPolicyAdmission(drugInfo1, futureResult, step, id, stringBuilder, stringStringHashMap, bulletinBoardVo, traditionalInfoDto);


        BulletinBoardVo bulletinBoardVo1 = new BulletinBoardVo();
        double totalScore = 0.0;
        ArrayList<JSONObject> jsonObjects = new ArrayList<>();
        try {
            bulletinBoardVo1.setSecurity(JSONObject.parseObject(bulletinBoardVo.getSecurity().toString()).getString("score"));
            totalScore += Double.parseDouble(bulletinBoardVo1.getSecurity().toString());
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 18);
            jsonObject.put("name", "安全性");
            jsonObject.put("value", bulletinBoardVo1.getSecurity());
            jsonObjects.add(jsonObject);
        } catch (Exception e) {
            bulletinBoardVo1.setSecurity("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 18);
            jsonObject.put("name", "安全性");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

        try {
            bulletinBoardVo1.setApplicability(JSONObject.parseObject(bulletinBoardVo.getApplicability().toString()).getString("score"));
            totalScore += Double.parseDouble(bulletinBoardVo1.getApplicability().toString());
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 11);
            jsonObject.put("name", "适用性");
            jsonObject.put("value", bulletinBoardVo1.getApplicability());
            jsonObjects.add(jsonObject);
        } catch (Exception e) {
            bulletinBoardVo1.setApplicability("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 11);
            jsonObject.put("name", "适用性");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

        try {
            bulletinBoardVo1.setEffectiveness(JSONObject.parseObject(bulletinBoardVo.getEffectiveness().toString()).getString("score"));
            totalScore += Double.parseDouble(bulletinBoardVo1.getEffectiveness().toString());
            JSONObject jsonObject = new JSONObject();

            jsonObject.put("max", 20);
            jsonObject.put("name", "有效性");
            jsonObject.put("value", bulletinBoardVo1.getEffectiveness());
            jsonObjects.add(jsonObject);
        } catch (Exception e) {
            bulletinBoardVo1.setEffectiveness("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 20);
            jsonObject.put("name", "有效性");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

        Object economicViability = bulletinBoardVo.getEconomicViability();
        String jsonString = JSONObject.toJSONString(economicViability);
        JSONObject economicViability1 = JSONObject.parseObject(jsonString);
        try {
            bulletinBoardVo1.setEconomicViability(economicViability1.getString("score"));
            totalScore += Double.parseDouble(economicViability1.getString("score"));
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 15);
            jsonObject.put("name", "经济性");
            jsonObject.put("value", Double.parseDouble(economicViability1.getString("score")));
            jsonObjects.add(jsonObject);

        } catch (Exception e) {
            bulletinBoardVo1.setEconomicViability("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 15);
            jsonObject.put("name", "经济性");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

        try {
            bulletinBoardVo1.setPharmacy(JSONObject.parseObject(bulletinBoardVo.getPharmacy().toString()).getString("score"));
            totalScore += Double.parseDouble(bulletinBoardVo1.getPharmacy().toString());
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 14);
            jsonObject.put("name", "药学特性");
            jsonObject.put("value", bulletinBoardVo1.getPharmacy());
            jsonObjects.add(jsonObject);
        } catch (Exception e) {
            bulletinBoardVo1.setPharmacy("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 14);
            jsonObject.put("name", "药学特性");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

        try {
            bulletinBoardVo1.setPolicy(JSONObject.parseObject(bulletinBoardVo.getPolicy().toString()).getString("score"));
            totalScore += Double.parseDouble(bulletinBoardVo1.getPolicy().toString());

            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 22);
            jsonObject.put("name", "政策准入");
            jsonObject.put("value", bulletinBoardVo1.getPolicy());
            jsonObjects.add(jsonObject);

        } catch (Exception e) {
            bulletinBoardVo1.setPolicy("0");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("max", 22);
            jsonObject.put("name", "政策准入");
            jsonObject.put("value", 0);
            jsonObjects.add(jsonObject);
        }

// 设置总分
        bulletinBoardVo1.setTotalScore(String.valueOf(totalScore));
        bulletinBoardVo.setReportId(id);
        bulletinBoardVo1.setReportId(id);

        JSONObject jsonObject = JSONObject.parseObject(JSON.toJSONString(bulletinBoardVo));
        JSONObject jsonObject1 = new JSONObject();
        jsonObject1.put("drugName", drugInfo1.getDrugName());
        jsonObject1.put("drugNameDetail", drugNameDetail);
        jsonObject1.put("dimensionDiagram", jsonObjects);
        jsonObject1.put("totalScore", totalScore);
        jsonObject1.put("title", drugInfo1.getDrugName() + "临床综合评价");
        //时间
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd");
        jsonObject1.put("time", format.format(new Date()));
        jsonObject.put("total", jsonObject1);
        addProcess(id, step++, "-END-", stringBuilder);
        NumberUtils.removeTrailingZeros(jsonObject);
        mongoTemplate.save(jsonObject, "drug_data_tra");
        return bulletinBoardVo1;
    }


    @Override
    public String saveDrugPrice(DrugPriceDto saveDrugPriceDto) {
        List<DrugPrice> list = saveDrugPriceDto.getList();
        String priceId = UUID.randomUUID().toString();
        for (DrugPrice saveDrugPrice : list) {
            saveDrugPrice.setId(UUID.randomUUID().toString());
            saveDrugPrice.setPriceId(priceId);
        }
        try {
            mongoTemplate.insert(list, DrugPrice.class);
            return priceId;
        } catch (Exception e) {
            e.printStackTrace();
            return "-1";
        }
    }


    private TraditionalInfoDto getFormat(DrugInfoNew drugInfo1, String priceId) {
        TraditionalInfoDto traditionalInfoDto = new TraditionalInfoDto();
        List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("priceId").is(priceId)), JSONObject.class, "drug_info_tra");
        if (jsonObjects.size() > 0) {
            JSONObject jsonObject = jsonObjects.get(0);
            JSONArray o = jsonObject.getJSONArray("list");
            for (JSONObject o1 : o.toJavaList(JSONObject.class)) {
                if (drugInfo1.getId().equals(o1.getString("drugId"))) {
                    JSONObject o2 = o1.getJSONObject("instruction");
                    String string = o2.getString("adverseReaction");
                    traditionalInfoDto.setAdverseReaction(string);
                    String string1 = o2.getString("children");
                    traditionalInfoDto.setChildrenMedicine(string1);
                    String string2 = o2.getString("pregnant");
                    traditionalInfoDto.setPregnantWomen(string2);
                    String string3 = o2.getString("elderly");
                    traditionalInfoDto.setGeriatricMedicine(string3);
                    String string4 = o2.getString("liver");
                    traditionalInfoDto.setDoseAdjustmentPatientsWithLiverDysfunction(string4);
                    String string5 = o2.getString("kidney");
                    traditionalInfoDto.setDoseAdjustmentPatientsWithRenalInsufficiency(string5);
                    String string6 = o1.getString("pharmacological");
                    traditionalInfoDto.setPharmacology(string6);
                    String string7 = o1.getString("manufacturers");
                    traditionalInfoDto.setManufacturers(string7);
                    String patent = o1.getString("patent");
                    traditionalInfoDto.setPatent(patent);
                    String content = o1.getString("content");
                    traditionalInfoDto.setContent(content);
                    traditionalInfoDto.setDescription(drugInfo1.getDescription());
                    List<GuidelinesVo> javaList = o1.getJSONArray("guide").toJavaList(GuidelinesVo.class);
                    traditionalInfoDto.setGuide(javaList);
                    List<GuidelinesVo> javaList1 = o1.getJSONArray("literature").toJavaList(GuidelinesVo.class);
                    traditionalInfoDto.setLiterature(javaList1);
                    String validity = o1.getString("validity");
                    traditionalInfoDto.setValidity(validity);
                    traditionalInfoDto.setIndate(drugInfo1.getIndate());
                    String classic = o1.getString("classic");
                    traditionalInfoDto.setClassic(classic);
                    String safety = o1.getString("safety");
                    traditionalInfoDto.setSafety(safety);
                    String economyradio = o1.getString("economyradio");
                    traditionalInfoDto.setEconomyradion(economyradio);
                    String string8 = o1.getString("fingerprint");
                    traditionalInfoDto.setFingerprint(string8);
                    traditionalInfoDto.setDrugName(drugInfo1.getDrugName());
                    //##
                    traditionalInfoDto.setIngredient(drugInfo1.getIngredient());
                    traditionalInfoDto.setDescription(drugInfo1.getDescription());
                    traditionalInfoDto.setStorage(drugInfo1.getStorage());
                    traditionalInfoDto.setIndications(drugInfo1.getIndications());

                    if (ObjectUtil.isNotEmpty(drugInfo1.getAdverseReaction()) || ObjectUtil.isNotEmpty(drugInfo1.getContraindications())) {
                        String contraindications = "";
                        if (StringUtils.isNotEmpty(drugInfo1.getContraindications())) {
                            contraindications = drugInfo1.getContraindications().replaceAll("\n", "");
                        }
                        String adverseReaction = "";
                        if (StringUtils.isNotEmpty(drugInfo1.getAdverseReaction())) {
                            adverseReaction = drugInfo1.getAdverseReaction().replaceAll("\n", "");
                        }
                        String contraindicationsx = (StringUtils.isNotEmpty(contraindications) ? "禁忌症：" + contraindications : "") +
                                (StringUtils.isNotEmpty(adverseReaction) ? "不良反应：" + adverseReaction : "");
                        traditionalInfoDto.setContraindications(contraindicationsx);
                    }


                }
            }
        }


        return traditionalInfoDto;
    }


    private TraditionalInfoDto getFormatApp(DrugInfoNew drugInfo1, String priceId) {
        TraditionalInfoDto traditionalInfoDto = new TraditionalInfoDto();

        List<JSONObject> jsonObjects = mongoTemplate.find(new Query(Criteria.where("priceId").is(priceId)), JSONObject.class, "evaluation_drug_price");
        if (jsonObjects.size() > 0) {
            Integer string = jsonObjects.get(0).getInteger("priceLevel");
            traditionalInfoDto.setEconomyradion(string.toString());
        }
        traditionalInfoDto.setAdverseReaction(drugInfo1.getAdverseReaction());

        traditionalInfoDto.setChildrenMedicine(drugInfo1.getChildrenMedicine());

        traditionalInfoDto.setPregnantWomen(drugInfo1.getPregnantWomen());

        traditionalInfoDto.setGeriatricMedicine(drugInfo1.getGeriatricMedicine());

        traditionalInfoDto.setDoseAdjustmentPatientsWithLiverDysfunction(drugInfo1.getDoseAdjustmentPatientsWithLiverDysfunction());

        traditionalInfoDto.setDoseAdjustmentPatientsWithRenalInsufficiency(drugInfo1.getDoseAdjustmentPatientsWithRenalInsufficiency());

        traditionalInfoDto.setPharmacology(drugInfo1.getPharmacology());
        ;
        traditionalInfoDto.setIndate(drugInfo1.getIndate());
        traditionalInfoDto.setDrugName(drugInfo1.getDrugName());
        //##
        traditionalInfoDto.setIngredient(drugInfo1.getIngredient());
        traditionalInfoDto.setDescription(drugInfo1.getDescription());
        traditionalInfoDto.setStorage(drugInfo1.getStorage());
        traditionalInfoDto.setIndications(drugInfo1.getIndications());

        if (ObjectUtil.isNotEmpty(drugInfo1.getAdverseReaction()) || ObjectUtil.isNotEmpty(drugInfo1.getContraindications())) {
            String contraindications = drugInfo1.getContraindications().replaceAll("\n", "");
            String adverseReaction = drugInfo1.getAdverseReaction().replaceAll("\n", "");
            String contraindicationsx = (StringUtils.isNotEmpty(contraindications) ? "禁忌症：" + contraindications : "") +
                    (StringUtils.isNotEmpty(adverseReaction) ? "不良反应：" + adverseReaction : "");
            traditionalInfoDto.setContraindications(contraindicationsx);
        }


        return traditionalInfoDto;
    }

    private void useThreadPoolExecutePrompt(TraditionalInfoDto
                                                    traditionalInfoDto, Map<String, Future<Boolean>> futureResult, Map<String, String> map) {


        HashMap<String, String> indicationMap1 = new HashMap<>();
        HashMap<String, String> indicationMap2 = new HashMap<>();
        HashMap<String, String> indicationMap3 = new HashMap<>();


        {
            indicationMap1.put(TraditionalPromptEnum.ADVERSEREACTION_RATING.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.ADVERSEREACTION_RATING.getDefaultPrompt(), traditionalInfoDto));


            // 特殊人群-儿童
            indicationMap1.put(TraditionalPromptEnum.SPECIAL_CROWD_CHILDREN.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.SPECIAL_CROWD_CHILDREN.getDefaultPrompt(), traditionalInfoDto));

            // 特殊人群-孕妇
            indicationMap1.put(TraditionalPromptEnum.SPECIAL_CROWD_PREGNANT_WOMEN.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.SPECIAL_CROWD_PREGNANT_WOMEN.getDefaultPrompt(), traditionalInfoDto));

            // 特殊人群-老年
            indicationMap1.put(TraditionalPromptEnum.SPECIAL_CROWD_GERIATRIC.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.SPECIAL_CROWD_GERIATRIC.getDefaultPrompt(), traditionalInfoDto));

            // 特殊人群-肝功能
            indicationMap1.put(TraditionalPromptEnum.SPECIAL_CROWD_LIVER.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.SPECIAL_CROWD_LIVER.getDefaultPrompt(), traditionalInfoDto));

            // 特殊人群-肾功能
            indicationMap1.put(TraditionalPromptEnum.SPECIAL_CROWD_RENKONG.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.SPECIAL_CROWD_RENKONG.getDefaultPrompt(), traditionalInfoDto));

            indicationMap1.put(TraditionalPromptEnum.SAFETY_EVALUATION.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.SAFETY_EVALUATION.getDefaultPrompt(), traditionalInfoDto));
        }


        {

            // 药物组成
            indicationMap2.put(TraditionalPromptEnum.DRUG_COMPOSITION.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.DRUG_COMPOSITION.getDefaultPrompt(), traditionalInfoDto));

            // 现代研究-药理作用
            indicationMap2.put(TraditionalPromptEnum.MODERN_RESEARCH_PHARMACOLOGY.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.MODERN_RESEARCH_PHARMACOLOGY.getDefaultPrompt(), traditionalInfoDto));

            // 指纹图谱研究
            indicationMap2.put(TraditionalPromptEnum.MODERN_RESEARCH_FINGERPRINT.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.MODERN_RESEARCH_FINGERPRINT.getDefaultPrompt(), traditionalInfoDto));

            // 现代研究-有效性
            indicationMap2.put(TraditionalPromptEnum.MODERN_RESEARCH_EFFECTIVENESS.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.MODERN_RESEARCH_EFFECTIVENESS.getDefaultPrompt(), traditionalInfoDto));

            // 现代研究-含量测定法
            indicationMap2.put(TraditionalPromptEnum.MODERN_RESEARCH_CONTENT_DETECTION.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.MODERN_RESEARCH_CONTENT_DETECTION.getDefaultPrompt(), traditionalInfoDto));


        }


        {

            // 贮存
            indicationMap3.put(TraditionalPromptEnum.STORAGE.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.STORAGE.getDefaultPrompt(), traditionalInfoDto));

            // 有效期
            indicationMap3.put(TraditionalPromptEnum.VALIDITY.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.VALIDITY.getDefaultPrompt(), traditionalInfoDto));

            // 药物选择
            indicationMap3.put(TraditionalPromptEnum.DRUG_CHOICE.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.DRUG_CHOICE.getDefaultPrompt(), traditionalInfoDto));

            // 说明书-主治功能
            indicationMap3.put(TraditionalPromptEnum.INSTRUCTION_ATTRIBUTE.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.INSTRUCTION_ATTRIBUTE.getDefaultPrompt(), traditionalInfoDto));

            // 说明书-性状
            indicationMap3.put(TraditionalPromptEnum.INSTRUCTION_ADVERSE_REACTION.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.INSTRUCTION_ADVERSE_REACTION.getDefaultPrompt(), traditionalInfoDto));

            // 专利、奖金或专项
            indicationMap3.put(TraditionalPromptEnum.PATENT.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.PATENT.getDefaultPrompt(), traditionalInfoDto));

            //企业状况
            indicationMap3.put(TraditionalPromptEnum.MANUFACTURERS.getKey(),
                    PromptUtil.replacePrompt(TraditionalPromptEnum.MANUFACTURERS.getDefaultPrompt(), traditionalInfoDto));

        }


        HashMap<String, String> Map1 = new HashMap<>();
        AtomicInteger x1 = new AtomicInteger(1);
        HashMap<String, String> prompt1 = new HashMap<>();
        StringBuilder stringBuilder1 = new StringBuilder();
        stringBuilder1.append("针对药品：" + traditionalInfoDto.getDrugName() + "回答，问题之间没有关联\n");
        indicationMap1.forEach((k, v) -> {
            String key = "问题" + x1;
            String prompt = key + "：" + v + "回答时请不要带标题’问题几‘的字样\n";
            stringBuilder1.append(prompt);
            String title = "question" + x1;
            prompt1.put(title, "###" + key + "###的打分（只能返回阿拉伯数字）");
            Map1.put(k, title);
            x1.incrementAndGet();

        });


        HashMap<String, String> Map2 = new HashMap<>();
        AtomicInteger x2 = new AtomicInteger(1);
        HashMap<String, String> prompt2 = new HashMap<>();
        StringBuilder stringBuilder2 = new StringBuilder();
        stringBuilder2.append("针对药品：" + traditionalInfoDto.getDrugName() + "回答，问题之间没有关联\n");
        indicationMap2.forEach((k, v) -> {
            String key = "问题" + x2;
            String prompt = key + "：" + v + "回答时请不要带标题’问题几‘的字样\n";
            stringBuilder2.append(prompt);
            String title = "question" + x2;
            prompt2.put(title, "###" + key + "###的打分（只能返回阿拉伯数字）");
            Map2.put(k, title);
            x2.incrementAndGet();

        });


        HashMap<String, String> Map3 = new HashMap<>();
        AtomicInteger x3 = new AtomicInteger(1);
        HashMap<String, String> prompt3 = new HashMap<>();
        StringBuilder stringBuilder3 = new StringBuilder();
        stringBuilder3.append("针对药品：" + traditionalInfoDto.getDrugName() + "回答，问题之间没有关联\n");
        indicationMap3.forEach((k, v) -> {
            String key = "问题" + x3;
            String prompt = key + "：" + v + "回答时请不要带标题’问题几‘的字样\n";
            stringBuilder3.append(prompt);
            String title = "question" + x3;
            prompt3.put(title, "###" + key + "###的打分（只能返回阿拉伯数字）");
            Map3.put(k, title);
            x3.incrementAndGet();

        });
        JSONObject responseFormat1 = getResponseFormat(prompt1);
        JSONObject responseFormat2 = getResponseFormat(prompt2);
        JSONObject responseFormat3 = getResponseFormat(prompt3);


        CompletableFuture<Boolean> total1 = CompletableFuture.supplyAsync(() -> {
            JSONObject jsonObject = lxGptService.executeGptPlus(stringBuilder1.toString(), "检索所有项目", responseFormat1, "","");
            String key1 = Map1.get(TraditionalPromptEnum.ADVERSEREACTION_RATING.getKey());
            String key2 = Map1.get(TraditionalPromptEnum.SPECIAL_CROWD_CHILDREN.getKey());
            String key3 = Map1.get(TraditionalPromptEnum.SPECIAL_CROWD_PREGNANT_WOMEN.getKey());
            String key4 = Map1.get(TraditionalPromptEnum.SPECIAL_CROWD_GERIATRIC.getKey());
            String key5 = Map1.get(TraditionalPromptEnum.SPECIAL_CROWD_LIVER.getKey());
            String key6 = Map1.get(TraditionalPromptEnum.SPECIAL_CROWD_RENKONG.getKey());
            String key7 = Map1.get(TraditionalPromptEnum.SAFETY_EVALUATION.getKey());
            map.put(TraditionalPromptEnum.ADVERSEREACTION_RATING.getKey(), jsonObject.getString(key1));
            map.put(TraditionalPromptEnum.SPECIAL_CROWD_CHILDREN.getKey(), jsonObject.getString(key2));
            map.put(TraditionalPromptEnum.SPECIAL_CROWD_PREGNANT_WOMEN.getKey(), jsonObject.getString(key3));
            map.put(TraditionalPromptEnum.SPECIAL_CROWD_GERIATRIC.getKey(), jsonObject.getString(key4));
            map.put(TraditionalPromptEnum.SPECIAL_CROWD_LIVER.getKey(), jsonObject.getString(key5));
            map.put(TraditionalPromptEnum.SPECIAL_CROWD_RENKONG.getKey(), jsonObject.getString(key6));
            map.put(TraditionalPromptEnum.SAFETY_EVALUATION.getKey(), jsonObject.getString(key7));
            return true;
        }, gptAnalysisThreadPool);

        CompletableFuture<Boolean> total2 = CompletableFuture.supplyAsync(() -> {
            JSONObject jsonObject = lxGptService.executeGptPlus(stringBuilder2.toString(), "检索所有项目", responseFormat2, "","");
            String s = Map2.get(TraditionalPromptEnum.DRUG_COMPOSITION.getKey());
            String s1 = Map2.get(TraditionalPromptEnum.MODERN_RESEARCH_PHARMACOLOGY.getKey());
            String s2 = Map2.get(TraditionalPromptEnum.MODERN_RESEARCH_FINGERPRINT.getKey());
            String s3 = Map2.get(TraditionalPromptEnum.MODERN_RESEARCH_EFFECTIVENESS.getKey());
            String s4 = Map2.get(TraditionalPromptEnum.MODERN_RESEARCH_CONTENT_DETECTION.getKey());
            map.put(TraditionalPromptEnum.DRUG_COMPOSITION.getKey(), jsonObject.getString(s));
            map.put(TraditionalPromptEnum.MODERN_RESEARCH_PHARMACOLOGY.getKey(), jsonObject.getString(s1));
            map.put(TraditionalPromptEnum.MODERN_RESEARCH_FINGERPRINT.getKey(), jsonObject.getString(s2));
            map.put(TraditionalPromptEnum.MODERN_RESEARCH_EFFECTIVENESS.getKey(), jsonObject.getString(s3));
            map.put(TraditionalPromptEnum.MODERN_RESEARCH_CONTENT_DETECTION.getKey(), jsonObject.getString(s4));


            return true;
        }, gptAnalysisThreadPool);


        CompletableFuture<Boolean> total3 = CompletableFuture.supplyAsync(() -> {

            JSONObject jsonObject = lxGptService.executeGptPlus(stringBuilder3.toString(), "检索所有项目", responseFormat3, "","");
            String s = Map3.get(TraditionalPromptEnum.STORAGE.getKey());
            String s1 = Map3.get(TraditionalPromptEnum.VALIDITY.getKey());

            String s3 = Map3.get(TraditionalPromptEnum.INSTRUCTION_ATTRIBUTE.getKey());
            String s4 = Map3.get(TraditionalPromptEnum.INSTRUCTION_ADVERSE_REACTION.getKey());
            String s5 = Map3.get(TraditionalPromptEnum.PATENT.getKey());
            String s6 = Map3.get(TraditionalPromptEnum.MANUFACTURERS.getKey());
            map.put(TraditionalPromptEnum.STORAGE.getKey(), jsonObject.getString(s));
            map.put(TraditionalPromptEnum.VALIDITY.getKey(), jsonObject.getString(s1));
            map.put(TraditionalPromptEnum.INSTRUCTION_ATTRIBUTE.getKey(), jsonObject.getString(s3));
            map.put(TraditionalPromptEnum.INSTRUCTION_ADVERSE_REACTION.getKey(), jsonObject.getString(s4));
            map.put(TraditionalPromptEnum.PATENT.getKey(), jsonObject.getString(s5));
            map.put(TraditionalPromptEnum.MANUFACTURERS.getKey(), jsonObject.getString(s6));

            return true;
        }, gptAnalysisThreadPool);

        CompletableFuture<Boolean> total4 = CompletableFuture.supplyAsync(() -> {
            String DRUGCHOICE = lxGptService.getGpt(PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_DRUG_CHOICE.getDefaultPrompt(), traditionalInfoDto), "","");
            traditionalInfoDto.setDrugChoice(DRUGCHOICE);
            String gpt = lxGptService.getGpt(PromptUtil.replacePrompt(TraditionalPromptEnum.DRUG_CHOICE.getDefaultPrompt(), traditionalInfoDto), "","");
            map.put(TraditionalPromptEnum.DRUG_CHOICE.getKey(), gpt);

            //是否有不明确的地方
            if (StringUtils.isEmpty(traditionalInfoDto.getContraindications())) {
                String gpt1 = lxGptService.getGpt(PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_DRUG_CONTRAINDICATIONS.getDefaultPrompt(), traditionalInfoDto), "","");
                traditionalInfoDto.setContraindications(gpt1);
            }
            String gpt1 = lxGptService.getGpt(PromptUtil.replacePrompt(TraditionalPromptEnum.CONTRAINDICATIONS.getDefaultPrompt(), traditionalInfoDto), "","");
            map.put(TraditionalPromptEnum.CONTRAINDICATIONS.getKey(), gpt1);
            return true;
        }, gptAnalysisThreadPool);

        futureResult.put("total1", total1);
        futureResult.put("total2", total2);
        futureResult.put("total3", total3);
        futureResult.put("total4", total4);

    }


    private String getTxt(JSONArray list) {
        StringBuilder stringBuilder = new StringBuilder();
        if (CollUtil.isNotEmpty(list)) {
            for (JSONObject drugContent : list.toJavaList(JSONObject.class)) {
                if (ContentTagEnum.TXT.getType().equals(drugContent.getString("tag"))) {
                    stringBuilder.append(drugContent.getString("content"));
                    stringBuilder.append("\n");
                }
            }
//            if (stringBuilder.length() >= 2) {
//                stringBuilder.delete(stringBuilder.length() - 2, stringBuilder.length());
//            }
            return stringBuilder.toString();
        } else {
            return "";
        }
    }


    private String delHTMLTag(List<DrugContent> list) {
        StringBuilder stringBuilder = new StringBuilder();
        if (CollUtil.isNotEmpty(list)) {
            try {
                for (DrugContent drugContent : list) {
                    if (ContentTagEnum.TXT.getType().equals(drugContent.getTag())) {
                        stringBuilder.append(drugContent.getContent());
                        stringBuilder.append("\n");
                    }
                }
            } catch (Exception e) {
                log.error("*****************delHTMLTag error:{}*************", list.toString());
                return "";
            }
//            if (stringBuilder.length() >= 2) {
//                stringBuilder.delete(stringBuilder.length() - 2, stringBuilder.length());
//            }
            return stringBuilder.toString();
        } else {
            return "";
        }


    }


    private DrugInfoNew getDrugInfoNew(String drugId, String searchId) {
        DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
        DrugAddDto drugAdd = null;
        if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
            drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
        }
        String register = drugInfo1.getRegister();
        if (register != null) {
            DrugInst approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInst.class);
            if (ObjectUtil.isNotEmpty(approveCode)) {
                if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                    drugInfo1.setIndications(delHTMLTag(approveCode.getIndication()));
                }
                if (approveCode.getDosage() != null && !approveCode.getDosage().isEmpty()) {
                    drugInfo1.setUsageAndDosage(delHTMLTag(approveCode.getDosage()));
                }
                if (approveCode.getUseInPregLact() != null && !approveCode.getUseInPregLact().isEmpty()) {
                    drugInfo1.setPregnantWomen(delHTMLTag(approveCode.getUseInPregLact()));
                }
                if (approveCode.getUseInChildren() != null && !approveCode.getUseInChildren().isEmpty()) {
                    drugInfo1.setChildrenMedicine(delHTMLTag(approveCode.getUseInChildren()));
                }
                if (approveCode.getUseInElderly() != null && !approveCode.getUseInElderly().isEmpty()) {
                    drugInfo1.setGeriatricMedicine(delHTMLTag(approveCode.getUseInElderly()));
                }
                if (approveCode.getAdverseReactions() != null && !approveCode.getAdverseReactions().isEmpty()) {
                    drugInfo1.setAdverseReaction(delHTMLTag(approveCode.getAdverseReactions()));
                }
                if (approveCode.getPrecautions() != null && !approveCode.getPrecautions().isEmpty()) {
                    drugInfo1.setNotes(delHTMLTag(approveCode.getPrecautions()));
                }
                if (approveCode.getDrugInteractions() != null && !approveCode.getDrugInteractions().isEmpty()) {
                    drugInfo1.setDrugInteraction(delHTMLTag(approveCode.getDrugInteractions()));
                }
                if (approveCode.getMechanismAction() != null && !approveCode.getMechanismAction().isEmpty()) {
                    drugInfo1.setPharmacology(delHTMLTag(approveCode.getMechanismAction()));
                }
                if (approveCode.getPharmacokinetics() != null && !approveCode.getPharmacokinetics().isEmpty()) {
                    drugInfo1.setPharmacokinetics(delHTMLTag(approveCode.getPharmacokinetics()));
                }
                if (approveCode.getStorage() != null && !approveCode.getStorage().isEmpty()) {
                    drugInfo1.setStorage(delHTMLTag(approveCode.getStorage()));
                }
                if (approveCode.getPack() != null && !approveCode.getPack().isEmpty()) {
                    drugInfo1.setPack(delHTMLTag(approveCode.getPack()));
                }
                if (approveCode.getPeriod() != null && !approveCode.getPeriod().isEmpty()) {
                    drugInfo1.setIndate(delHTMLTag(approveCode.getPeriod()));
                }
                if (approveCode.getComponent() != null && !approveCode.getComponent().isEmpty()) {
                    drugInfo1.setIngredient(delHTMLTag(approveCode.getComponent()));
                }
                if (approveCode.getPoison() != null && !approveCode.getPoison().isEmpty()) {
                    drugInfo1.setPoison(delHTMLTag(approveCode.getPoison()));
                }
                if (approveCode.getDrugWarning() != null && !approveCode.getDrugWarning().isEmpty()) {
                    drugInfo1.setDrugWarning(delHTMLTag(approveCode.getDrugWarning()));
                }
                if (approveCode.getDescription() != null && !approveCode.getDescription().isEmpty()) {
                    drugInfo1.setDescription(delHTMLTag(approveCode.getDescription()));
                }
                if (approveCode.getContraindications() != null && !approveCode.getContraindications().isEmpty()) {
                    drugInfo1.setContraindications(delHTMLTag(approveCode.getContraindications()));
                }

            }
        }

        // 合理用药
        if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh())) {
            JSONObject evaluationMedicine = evaluationService.getHeliYongYao(drugInfo1.getDrugZh());
            if (ObjectUtil.isEmpty(evaluationMedicine)) {
                List<JSONObject> evaluationMedicines = mongoTemplate.find(new Query(Criteria.where("drugName").in(drugInfo1.getDrugSynonymZh())), JSONObject.class, CommonConstants.REASONABLE_DRUG_TABLE_NAME);
                if (CollUtil.isNotEmpty(evaluationMedicines)) {
                    evaluationMedicine = evaluationMedicines.get(0);
                }
            }
            if (ObjectUtil.isNotEmpty(evaluationMedicine)) {
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("commonAdverseReactions"))) {
                    drugInfo1.setCommonAdverseReactions(getTxt(evaluationMedicine.getJSONArray("commonAdverseReactions")));
                }
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("seriousAdverseRactions"))) {
                    drugInfo1.setSeriousAdverseRactions(getTxt(evaluationMedicine.getJSONArray("seriousAdverseRactions")));
                }
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction"))) {
                    drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction")));
                }
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency"))) {
                    drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency")));
                }

                if (StringUtils.isNotEmpty(drugInfo1.getPregnantWomen()) &&
                        (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("medicationDuringLactation")) ||
                                CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("medicationDuringPregnancy")))) {
                    drugInfo1.setPregnantWomen(getTxt(evaluationMedicine.getJSONArray("medicationDuringLactation")) + getTxt(evaluationMedicine.getJSONArray("medicationDuringPregnancy")));
                }


                if (StringUtils.isNotEmpty(evaluationMedicine.getString("geneticsReproductionCarcinogenicity"))) {
                    drugInfo1.setGeneticsReproductionCarcinogenicity(getTxt(evaluationMedicine.getJSONArray("geneticsReproductionCarcinogenicity")));
                }

                if (StringUtils.isNotEmpty(evaluationMedicine.getString("warning"))) {
                    drugInfo1.setBlackBoxWaringOfFDA(getTxt(evaluationMedicine.getJSONArray("warning")));
                }


            }
        }
        //药品添加说明书
        if (ObjectUtil.isNotEmpty(drugAdd)) {
            BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
            StringBuilder usageAndDosage = new StringBuilder();
            if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
            }
            if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
            }
            if (StringUtils.isNotEmpty(drugAdd.getIndication())) {
                drugInfo1.setIndications(drugAdd.getIndication());
            }

            if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(drugAdd.getKidneyPatients());
                drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾功能异常者：" + drugAdd.getKidneyPatients());
            }
            if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(drugAdd.getLiverPatients());
                drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝功能异常者：" + drugAdd.getLiverPatients());
            }
            if (usageAndDosage.length() > 0) {
                drugInfo1.setUsageAndDosage(usageAndDosage.toString());
            }
            StringBuilder adverseReaction = new StringBuilder();
            if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                drugInfo1.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
            }
            if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                drugInfo1.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
            }
            if (adverseReaction.length() > 0) {
                drugInfo1.setAdverseReaction(adverseReaction.toString());
            }

            if (StringUtils.isNotEmpty(drugAdd.getAccessory())) {
                String s = drugInfo1.getIngredient().replaceAll("\\n$", "");
                drugInfo1.setIngredient(s + "\n辅料：" + drugAdd.getAccessory());
            }

        }
        return drugInfo1;
    }


    private void GetSynonymsDrugName(String drugName, List<String> drugs, DrugInfoNew drugInfoNew) {
        long startTime = System.currentTimeMillis();
        drugs.add(drugName);
        Map<String, String> drugTransMap = new HashMap<>();
//        drugTransMap.put(drugName, lxGptService.getTransDeepl(drugName));
//        List<DrugInfoNew> drugInfos = mongoTemplate.find(new Query(Criteria.where("drugName").in(drugs)), DrugInfoNew.class);
        List<String> drugsCopy = new ArrayList<>();

        if (StrUtil.isNotBlank(drugInfoNew.getDrugEn())) {
            drugsCopy.add(drugInfoNew.getDrugEn());
        }
        if (StrUtil.isNotBlank(drugInfoNew.getDrugZh())) {
            drugsCopy.add(drugInfoNew.getDrugZh());
        }
        if (CollUtil.isNotEmpty(drugInfoNew.getDrugSynonymEn())) {
            drugsCopy.addAll(drugInfoNew.getDrugSynonymEn());
        }
        if (CollUtil.isNotEmpty(drugInfoNew.getDrugSynonymZh())) {
            drugsCopy.addAll(drugInfoNew.getDrugSynonymZh());
        }
        ;
        drugs.addAll(drugsCopy.stream().distinct().collect(Collectors.toList()));
        // 获取完同义词
        boolean isUseTransDrug = GetSynonymUtil.getSynonym(drugName, drugs, drugs);
//        if (!isUseTransDrug) {
//            //翻译词的同义词
//            if (StrUtil.isNotBlank(drugTransMap.get(drugName))) {
//                drugs.add(drugTransMap.get(drugName));
//                List<String> synonymTrans = GetSynonymUtil.getSynonymTrans(drugTransMap.get(drugName));
//                drugs.addAll(synonymTrans);
//            }
//        }
        drugs = drugs.stream().distinct().collect(Collectors.toList());
        long endTime = System.currentTimeMillis();
        log.info("#############################获取药品同义词时间{}#########################", endTime - startTime);
    }

    private void alone(TraditionalPromptEnum traditionalPromptEnum, ConcurrentHashMap map, TraditionalInfoDto traditionalInfoDto) {
        String gpt = lxGptService.getGpt(PromptUtil.replacePrompt(traditionalPromptEnum.getDefaultPrompt() + "****要求返回阿拉伯数字，不要其他任何字符***", traditionalInfoDto), "","");
        map.put(traditionalPromptEnum.getKey(), gpt);
    }


    private void useThreadPoolExecutePromptApp(TraditionalInfoDto
                                                       traditionalInfoDto, ConcurrentHashMap<String, Future<Boolean>> futureResult,
                                               ConcurrentHashMap<String, String> map, DrugInfoNew drugInfoNew) {


        HashMap<String, String> indicationMap1 = new HashMap<>();
        HashMap<String, String> indicationMap2 = new HashMap<>();
        HashMap<String, String> indicationMap3 = new HashMap<>();


        CompletableFuture<Boolean> total1 = CompletableFuture.supplyAsync(() -> {

            Map<String, String> promptMap = new HashMap();
            //说明书
            {

                if (StringUtils.isEmpty(traditionalInfoDto.getAdverseReaction())) {
                    promptMap.put("ad", "抽取总结" + traditionalInfoDto.getDrugName() + "的不良反应。（字面意思相关就总结返回）注意：如果没有则返回：说明书中未提及不良反应相关信息");
                }

                if (StringUtils.isEmpty(traditionalInfoDto.getChildrenMedicine())) {
                    promptMap.put("ch", "抽取总结" + traditionalInfoDto.getDrugName() + "说明书中所有与儿童用药相关的不良反应、使用方法、禁忌、注意事项等信息，若无儿童相关数据，请不要返回数据。注意，如果说明书中没有提到儿童相关信息时则需要返回：说明书中未提及儿童用药相关信息");
                }

                if (StringUtils.isEmpty(traditionalInfoDto.getGeriatricMedicine())) {
                    promptMap.put("ge", "抽取总结" + traditionalInfoDto.getDrugName() + "的与老年人用药相关的不良反应、使用方法、禁忌、注意事项信息（重点关注老人用药、不良反应、禁忌和注意事项等字段），无关信息不要返回。注意，如果没有则返回：说明书中未提及老年人用药相关信息");
                }

                if (StringUtils.isEmpty(traditionalInfoDto.getPregnantWomen())) {
                    promptMap.put("pr", "抽取总结" + traditionalInfoDto.getDrugName() + "的与孕妇以及哺乳期用药相关的不良反应、使用方法、禁忌、注意事项信息（重点关注孕妇用药、不良反应、禁忌和注意事项等字段），无关信息不要返回。注意，如果没有则返回：说明书中未提及孕妇及哺乳期用药相关信息");
                }

                if (StringUtils.isEmpty(traditionalInfoDto.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                    promptMap.put("li", "抽取总结" + traditionalInfoDto.getDrugName() + "的与肝功能异常者用药相关的不良反应、使用方法、禁忌、注意事项信息（重点关注肝肾功能用药、不良反应、禁忌和注意事项等字段），无关信息不要返回。注意，如果没有则返回：说明书中未提及肝功能异常者用药相关信息");
                }

                if (StringUtils.isEmpty(traditionalInfoDto.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
                    promptMap.put("re", "抽取总结" + traditionalInfoDto.getDrugName() + "的与肾功能异常者用药相关不良反应、使用方法、禁忌、注意事项的信息（重点关注肝肾功能用药、不良反应、禁忌和注意事项等字段），无关信息不要返回。注意，如果没有则返回：说明书中未提及肾功能异常者用药相关信息");
                }
            }
            BatchGetGpt batchGetGpt = new BatchGetGpt(promptMap, lxGptService);
            batchGetGpt.setDrugInfoNew(drugInfoNew);
            Map<String, String> execute = batchGetGpt.execute();
            if (StringUtils.isEmpty(traditionalInfoDto.getAdverseReaction())) {
                traditionalInfoDto.setAdverseReaction(execute.get("ad"));
            }
            if (StringUtils.isEmpty(traditionalInfoDto.getChildrenMedicine())) {
                traditionalInfoDto.setChildrenMedicine(execute.get("ch"));
            }
            if (StringUtils.isEmpty(traditionalInfoDto.getGeriatricMedicine())) {
                traditionalInfoDto.setGeriatricMedicine(execute.get("ge"));
            }
            if (StringUtils.isEmpty(traditionalInfoDto.getPregnantWomen())) {
                traditionalInfoDto.setPregnantWomen(execute.get("pr"));
            }
            if (StringUtils.isEmpty(traditionalInfoDto.getDoseAdjustmentPatientsWithLiverDysfunction())) {
                traditionalInfoDto.setDoseAdjustmentPatientsWithLiverDysfunction(execute.get("li"));
            }
            if (StringUtils.isEmpty(traditionalInfoDto.getDoseAdjustmentPatientsWithRenalInsufficiency())) {
                traditionalInfoDto.setDoseAdjustmentPatientsWithRenalInsufficiency(execute.get("re"));
            }

            {

                indicationMap1.put(TraditionalPromptEnum.ADVERSEREACTION_RATING.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.ADVERSEREACTION_RATING.getDefaultPrompt(), traditionalInfoDto));


                // 特殊人群-儿童
                indicationMap1.put(TraditionalPromptEnum.SPECIAL_CROWD_CHILDREN.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SPECIAL_CROWD_CHILDREN.getDefaultPrompt(), traditionalInfoDto));

                // 特殊人群-孕妇
                indicationMap1.put(TraditionalPromptEnum.SPECIAL_CROWD_PREGNANT_WOMEN.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SPECIAL_CROWD_PREGNANT_WOMEN.getDefaultPrompt(), traditionalInfoDto));

                // 特殊人群-老年
                indicationMap1.put(TraditionalPromptEnum.SPECIAL_CROWD_GERIATRIC.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SPECIAL_CROWD_GERIATRIC.getDefaultPrompt(), traditionalInfoDto));

                // 特殊人群-肝功能
                indicationMap1.put(TraditionalPromptEnum.SPECIAL_CROWD_LIVER.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SPECIAL_CROWD_LIVER.getDefaultPrompt(), traditionalInfoDto));

                // 特殊人群-肾功能
                indicationMap1.put(TraditionalPromptEnum.SPECIAL_CROWD_RENKONG.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SPECIAL_CROWD_RENKONG.getDefaultPrompt(), traditionalInfoDto));


            }


            HashMap<String, String> Map1 = new HashMap<>();
            AtomicInteger x1 = new AtomicInteger(1);
            HashMap<String, String> prompt1 = new HashMap<>();
            StringBuilder stringBuilder1 = new StringBuilder();
            stringBuilder1.append("针对药品：" + traditionalInfoDto.getDrugName() + "回答，问题之间没有关联\n");
            indicationMap1.forEach((k, v) -> {
                String key = "问题" + x1;
                String prompt = key + "：" + v + "回答时请不要带标题’问题几‘的字样\n";
                stringBuilder1.append(prompt);
                String title = "question" + x1;
                prompt1.put(title, "###" + key + "###的打分（只能返回阿拉伯数字）");
                Map1.put(k, title);
                x1.incrementAndGet();

            });
            JSONObject responseFormat1 = getResponseFormat(prompt1);

            JSONObject jsonObject = lxGptService.executeGptPlus(stringBuilder1.toString(), "检索所有项目", responseFormat1, "","");
            String key1 = Map1.get(TraditionalPromptEnum.ADVERSEREACTION_RATING.getKey());
            String key2 = Map1.get(TraditionalPromptEnum.SPECIAL_CROWD_CHILDREN.getKey());
            String key3 = Map1.get(TraditionalPromptEnum.SPECIAL_CROWD_PREGNANT_WOMEN.getKey());
            String key4 = Map1.get(TraditionalPromptEnum.SPECIAL_CROWD_GERIATRIC.getKey());
            String key5 = Map1.get(TraditionalPromptEnum.SPECIAL_CROWD_LIVER.getKey());
            String key6 = Map1.get(TraditionalPromptEnum.SPECIAL_CROWD_RENKONG.getKey());

            map.put(TraditionalPromptEnum.ADVERSEREACTION_RATING.getKey(), jsonObject.getString(key1));
            map.put(TraditionalPromptEnum.SPECIAL_CROWD_CHILDREN.getKey(), jsonObject.getString(key2));
            map.put(TraditionalPromptEnum.SPECIAL_CROWD_PREGNANT_WOMEN.getKey(), jsonObject.getString(key3));
            map.put(TraditionalPromptEnum.SPECIAL_CROWD_GERIATRIC.getKey(), jsonObject.getString(key4));
            map.put(TraditionalPromptEnum.SPECIAL_CROWD_LIVER.getKey(), jsonObject.getString(key5));
            map.put(TraditionalPromptEnum.SPECIAL_CROWD_RENKONG.getKey(), jsonObject.getString(key6));

            return true;
        }, gptAnalysisThreadPool);


        CompletableFuture<Boolean> total2 = CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isEmpty(traditionalInfoDto.getPharmacology())) {

                try {
                    String s = com.sentum.util.HttpUtil.SearchWebFromBing(traditionalInfoDto.getDrugName() + "的药理作用是什么", "药理作用");
                    traditionalInfoDto.setPharmacology(s);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }

            }


            HashMap<String, CompletableFuture<Boolean>> threadMap = new HashMap<>();

            HashMap<String, String> indicationMap = new HashMap<>();
            HashMap<String, String> indicationMapx = new HashMap<>();

            String drugId = drugInfoNew.getId();
            //其他项prompt
            {
                // 安全性评价
                indicationMapx.put(drugId + TraditionalPromptEnum.SHOW_SAFETY_EVALUATION.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_SAFETY_EVALUATION.getDefaultPrompt(), drugInfoNew));

//                // 古代经典名方目录
//                indicationMap.put(drugId + TraditionalPromptEnum.SHOW_CLASSIC.getKey(),
//                        PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_CLASSIC.getDefaultPrompt(), drugInfo1));

                // 创建一个列表来存储所有的 or 条件
                List<Criteria> orConditions = new ArrayList<>();

// 添加第一个 or 条件
                orConditions.add(Criteria.where("name").regex(drugInfoNew.getDrugZh()));

// 添加第二个 or 条件
                orConditions.add(Criteria.where("name").regex(drugInfoNew.getDrugName()));

// 使用 orOperator 将所有 or 条件组合成一个 Criteria
                Criteria orCriteria = new Criteria().orOperator(orConditions.toArray(new Criteria[0]));

// 构建查询
                Query query = new Query(orCriteria);

                List<JSONObject> jsonObjects = mongoTemplate.find(query, JSONObject.class, "prescript");
                if (CollUtil.isNotEmpty(jsonObjects)) {
                    traditionalInfoDto.setClassic(traditionalInfoDto.getDrugName() + "收录在了《古代经典名方》目录中。来源：" + jsonObjects.get(0).getString("source") + "。");
                } else {
                    traditionalInfoDto.setClassic(traditionalInfoDto.getDrugName() + "未收录在《古代经典名方》目录中。");
                }

                String drugZh = drugInfoNew.getDrugZh();
                ArrayList<String> drugZhs = new ArrayList<>();
                drugZhs.add(drugZh);
                drugZhs.addAll(drugInfoNew.getDrugSynonymZh());
                drugZhs.remove("");
                drugZhs.add(drugInfoNew.getDrugName());

                //指纹图谱文献
                {
                    StringBuilder stringBuilder = new StringBuilder();
                    StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题");
                    stringBuilder1.append(" AND ");
                    StringBuilder stringBuilder2 = PromptUtil.montageForPaper(stringBuilder1, "指纹", "标题");
                    JSONObject jsonObject = new JSONObject();
                    jsonObject.put("query", stringBuilder2.toString());
                    jsonObject.put("type", "1");
                    String retrievalStr = formulaFeign.retrieval(jsonObject);
                    WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
                    QueryBuilder queryBuilder = QueryBuilders.boolQuery().must(wrapperQueryBuilder);
                    NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(queryBuilder);
                    SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);


                    if (literatureSearchHits.getTotalHits() > 0) {
                        StringBuilder literature1 = new StringBuilder();
                        int count = 0;
                        for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                            String title = literatureSearchHit.getContent().getTitle();
                            String count1 = "(" + (count + 1) + ")";
                            literature1.append(count1 + "《" + title + "》").append("\n");
//                            literature1.append("摘要:"+literatureSearchHit.getContent().getSummary());
                            literature1.append((StringUtils.isNotEmpty(literatureSearchHit.getContent().getTldr()) ?
                                    literatureSearchHit.getContent().getTldr() : literatureSearchHit.getContent().getSummary())).append("\n");
                            count++;

                            if (count > 5) {
                                break;
                            }
                        }
                        traditionalInfoDto.setFingerprint(literature1.toString());

//                        indicationMap.put(drugId + TraditionalPromptEnum.SHOW_FINGERPRINTx.getKey(),
//                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_FINGERPRINTx.getDefaultPrompt(), drugInfo1, literature1.toString()));

                    } else {
                        indicationMap.put(drugId + TraditionalPromptEnum.SHOW_FINGERPRINT.getKey(),
                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_FINGERPRINT.getDefaultPrompt(), drugInfoNew));
                    }
                }


                {
                    StringBuilder stringBuilder = new StringBuilder();
                    StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题");
                    stringBuilder1.append(" AND ");
                    ArrayList<String> strings = new ArrayList<>();
                    strings.add("有效");
                    strings.add("疗效");
                    StringBuilder stringBuilder2 = PromptUtil.montageForPaper(stringBuilder1, strings, "标题");
                    JSONObject jsonObject = new JSONObject();
                    jsonObject.put("query", stringBuilder2.toString());
                    jsonObject.put("type", "1");
                    String retrievalStr = formulaFeign.retrieval(jsonObject);
                    WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
                    TermQueryBuilder termQueryBuilder = QueryBuilders.termQuery("lastNewType", 0);
                    BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
                    boolQueryBuilder.must().add(wrapperQueryBuilder);
                    boolQueryBuilder.must().add(termQueryBuilder);
                    NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
                    SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);

                    BoolQueryBuilder boolQueryBuilder1 = new BoolQueryBuilder();
                    BoolQueryBuilder boolQueryBuilder2 = new BoolQueryBuilder();
                    boolQueryBuilder2.should().add(QueryBuilders.termQuery("lastNewType", 3));
                    boolQueryBuilder2.should().add(QueryBuilders.termQuery("lastNewType", 4));
                    boolQueryBuilder2.should().add(QueryBuilders.termQuery("lastNewType", 6));
                    boolQueryBuilder2.should().add(QueryBuilders.termQuery("lastNewType", 7));
                    boolQueryBuilder1.must().add(wrapperQueryBuilder);
                    boolQueryBuilder1.must().add(boolQueryBuilder2);
                    NativeSearchQuery nativeSearchQuery1 = new NativeSearchQuery(boolQueryBuilder1);
                    SearchHits<Literature> literatureSearchHits1 = this.elasticsearchRestTemplate.search(nativeSearchQuery1, Literature.class);


                    if (literatureSearchHits.getTotalHits() > 0) {
                        StringBuilder literature1 = new StringBuilder();

                        int count = 0;
                        for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                            String title = literatureSearchHit.getContent().getTitle();
                            Literature literature = literatureSearchHit.getContent();
                            String count1 = "(" + (count + 1) + ")";
                            literature1.append(count1 + "《" + title + "》").append("\n");
//                            literature1.append("摘要:"+literatureSearchHit.getContent().getSummary());
                            literature1.append((StringUtils.isNotEmpty(literatureSearchHit.getContent().getTldr()) ?
                                    literatureSearchHit.getContent().getTldr() : literatureSearchHit.getContent().getSummary())).append("\n");
                            count++;
                            if (count > 5) {
                                break;
                            }
                        }
                        traditionalInfoDto.setValidity(literature1.toString());
//                        indicationMap.put(drugId + TraditionalPromptEnum.SHOW_VALIDITY_EVALUATIONx.getKey(),
//                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_VALIDITY_EVALUATIONx.getDefaultPrompt(), drugInfo1, literature1.toString()));

                    }

                    if (StringUtils.isEmpty(traditionalInfoDto.getValidity()) && literatureSearchHits1.getTotalHits() > 0) {
                        StringBuilder literature1 = new StringBuilder();
                        int count = 0;
                        for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                            String title = literatureSearchHit.getContent().getTitle();


                            String count1 = "(" + (count + 1) + ")";
                            literature1.append(count1 + "《" + title + "》").append("\n");
//                            literature1.append("摘要:"+literatureSearchHit.getContent().getSummary());
                            literature1.append((StringUtils.isNotEmpty(literatureSearchHit.getContent().getTldr()) ?
                                    literatureSearchHit.getContent().getTldr() : literatureSearchHit.getContent().getSummary())).append("\n");
                            count++;
                            if (count > 5) {
                                break;
                            }
                        }
                        traditionalInfoDto.setValidity(literature1.toString());
                    }


                    if (StringUtils.isEmpty(traditionalInfoDto.getValidity())) {
                        // 有效性评价
                        indicationMapx.put(drugId + TraditionalPromptEnum.SHOW_VALIDITY_EVALUATION.getKey(),
                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_VALIDITY_EVALUATION.getDefaultPrompt(), drugInfoNew));

                    }

                }
                {
                    StringBuilder stringBuilder = new StringBuilder();
                    StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题");
                    stringBuilder1.append(" AND ");
                    StringBuilder stringBuilder2 = PromptUtil.montageForPaper(stringBuilder1, "测定", "标题");
                    JSONObject jsonObject = new JSONObject();
                    jsonObject.put("query", stringBuilder2.toString());
                    jsonObject.put("type", "1");
                    String retrievalStr = formulaFeign.retrieval(jsonObject);
                    WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
                    QueryBuilder queryBuilder = QueryBuilders.boolQuery().must(wrapperQueryBuilder);
                    NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(queryBuilder);
                    SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);


                    if (literatureSearchHits.getTotalHits() > 0) {
                        StringBuilder literature1 = new StringBuilder();
                        int count = 0;
                        for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                            String title = literatureSearchHit.getContent().getTitle();
                            String count1 = "(" + (count + 1) + ")";
                            literature1.append(count1 + "《" + title + "》").append("\n");
//                            literature1.append("摘要:"+literatureSearchHit.getContent().getSummary());
                            literature1.append((StringUtils.isNotEmpty(literatureSearchHit.getContent().getTldr()) ?
                                    literatureSearchHit.getContent().getTldr() : literatureSearchHit.getContent().getSummary())).append("\n");
                            count++;
                            if (count > 5) {
                                break;
                            }
                        }
                        traditionalInfoDto.setContent(literature1.toString());
//                        indicationMap2.put(drugId + TraditionalPromptEnum.SHOW_CONTENT_DETECTIONx.getKey(),
//                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_CONTENT_DETECTIONx.getDefaultPrompt(), drugInfo1, literature1.toString()));
                    } else {
                        indicationMapx.put(drugId + TraditionalPromptEnum.SHOW_CONTENT_DETECTION.getKey(),
                                PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_CONTENT_DETECTION.getDefaultPrompt(), drugInfoNew));
                    }

                    // 含量测定方法

                }
                // 专利、所获奖项
                indicationMapx.put(drugId + TraditionalPromptEnum.SHOW_PATENT.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_PATENT.getDefaultPrompt(), drugInfoNew));

                // 企业状况
                indicationMap.put(drugId + TraditionalPromptEnum.SHOW_MANUFACTURERS.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_MANUFACTURERS.getDefaultPrompt(), drugInfoNew));


            }


            //同义词
            ArrayList<String> drugNames = new ArrayList<>();
            GetSynonymsDrugName(drugInfoNew.getDrugName(), drugNames, drugInfoNew);


            ArrayList<GuidelinesVo> guidelinesVos = new ArrayList<>();
            traditionalInfoDto.setGuide(guidelinesVos);
            DrugInfoNew finalDrugInfo = drugInfoNew;
//                CompletableFuture<Boolean> guideResult = CompletableFuture.supplyAsync(() -> {
            long l = System.currentTimeMillis();
            try {
//                    String drugZh = drugInfo1.getDrugZh();
//                    ArrayList<String> drugZhs = new ArrayList<>();
//                    drugZhs.add(drugZh);
//                    drugZhs.addAll(drugInfo1.getDrugSynonymZh());
//                    drugZhs.remove("");
//                    drugZhs.add(drugInfo1.getDrugName());
                List<GuideVO> guideVOList = lxGptService.queryGuideByDrugAndDisease(drugNames, finalDrugInfo.getDrugZh(), new ArrayList<>(), "");
//                    StringBuilder stringBuilder = new StringBuilder();
//                    StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "");
//                    JSONObject jsonObject = new JSONObject();
//                    jsonObject.put("query", stringBuilder1.toString());
//                    jsonObject.put("type", "2");
//                    String retrievalStr = formulaFeign.retrieval(jsonObject);
//                    WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
//                    QueryBuilder queryBuilder = QueryBuilders.boolQuery().must(wrapperQueryBuilder);
//                    NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(queryBuilder);
//                    nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "dateTs"));
//                    SearchHits<GuideVO> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, GuideVO.class);
//                    ArrayList<GuideVO> guideVOList = new ArrayList<>();
//                    for (SearchHit<GuideVO> literatureSearchHit : literatureSearchHits) {
//                        guideVOList.add(literatureSearchHit.getContent());
//                        if (guideVOList.size() > 5){
//                            break;
//                        }
//                    }
                if (CollUtil.isNotEmpty(guideVOList)) {
                    for (GuideVO guideVO : guideVOList) {
                        GuidelinesVo guidelinesVo = new GuidelinesVo();
                        guidelinesVo.setContent(guideVO.getPdf_txt());
                        guidelinesVo.setZdz(guideVO.getZdz());
                        guidelinesVo.setTitle(guideVO.getTitle());
                        guidelinesVo.setFdaDate(guideVO.getFbdate());
                        guidelinesVo.setType("1");
                        guidelinesVo.setId(guideVO.getId());
                        guidelinesVo.setIsPaper(guideVO.getIsPaper());
                        guidelinesVo.setShowField(guideVO.getTitle() + "-" + guideVO.getZdz() + "-" + guideVO.getFbdate());
                        guidelinesVos.add(guidelinesVo);
                    }

                }
            } catch (Exception e) {
                log.error("xiaoling error", e);
            }
            long kl = System.currentTimeMillis();
            System.out.println("********************************************耗时1：" + (kl - l));
//                    return true;
//                }, gptAnalysisThreadPool);


            ArrayList<GuidelinesVo> guidelinesVos1 = new ArrayList<>();
            traditionalInfoDto.setLiterature(guidelinesVos1);
//                CompletableFuture<Boolean> literatureResult = CompletableFuture.supplyAsync(() -> {
            long l2 = System.currentTimeMillis();
            // List<Literature> literatureList = lxGptService.queryLiterature(drugInfo1.getDrugZh(), drugNames, s, diseases);

            String drugZh = drugInfoNew.getDrugZh();
            ArrayList<String> drugZhs = new ArrayList<>();
            drugZhs.add(drugZh);
            drugZhs.addAll(drugInfoNew.getDrugSynonymZh());
            drugZhs.remove("");
            drugZhs.add(drugInfoNew.getDrugName());
//                    List<GuideVO> guideVOList = lxGptService.queryGuideByDrugAndDisease(drugNames, finalDrugInfo.getDrugZh(), new ArrayList<>(), "");
            StringBuilder stringBuilder = new StringBuilder();
            StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilder, drugZhs, "标题");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("query", stringBuilder1.toString());
            jsonObject.put("type", "1");
            String retrievalStr = formulaFeign.retrieval(jsonObject);
            WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
            QueryBuilder queryBuilder = QueryBuilders.boolQuery().must(wrapperQueryBuilder);
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(queryBuilder);
            nativeSearchQuery.addSort(Sort.by(Sort.Direction.DESC, "year"));
            SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
            List<Literature> literatureList = new ArrayList<>();
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                literatureList.add(literatureSearchHit.getContent());
            }

            if (CollUtil.isNotEmpty(literatureList)) {
                for (Literature literature : literatureList) {
                    GuidelinesVo guidelinesVo = new GuidelinesVo();
                    guidelinesVo.setContent(literature.getTldr());
                    if (StringUtils.isEmpty(guidelinesVo.getContent())) {
                        guidelinesVo.setContent(literature.getSummary());
                    }
                    guidelinesVo.setZdz(literature.getJournal());
                    guidelinesVo.setTitle(literature.getTitle());
                    guidelinesVo.setFdaDate(literature.getYear());
                    guidelinesVo.setType("2");
                    guidelinesVo.setId(literature.getId());
                    guidelinesVo.setIsPaper(0);
                    guidelinesVo.setAuthor(literature.getAuthor());
                    StringBuilder partition = new StringBuilder();
                    if ("zh".equals(literature.getLanguage())) {
                        List<String> recognizedKernelJournals = literature.getJournalDivision();
                        if (CollUtil.isNotEmpty(recognizedKernelJournals) && recognizedKernelJournals.size() >= 2) {
                            for (String recognizedKernelJournal : recognizedKernelJournals) {
                                switch (recognizedKernelJournal) {
                                    case "Technology":
                                        partition.append("科技核心、");
                                        break;
                                    case "Peking University":
                                        partition.append("北大核心、");
                                        break;
                                    case "Nanjing University":
                                        partition.append("南大核心、");
                                        break;
                                    case "CSCD":
                                        partition.append("CSCD、");
                                        break;
                                    default:
                                        break;
                                }
                            }
                            if (partition.length() > 0) {
                                partition.delete(partition.length() - 1, partition.length());
                            }

                            String s = literature.getTitle() + "-" + literature.getJournal() + "-" + literature.getYear();
                            if (partition.length() > 0) {
                                guidelinesVo.setShowField(s + " (" + partition + ")");
                            }
                        } else {
                            continue;
                        }
                        if (guidelinesVos1.size() >= 5) {
                            break;
                        }
                    }
//                        String s = literature.getTitle() + "-" + literature.getJournal() + "-" + literature.getYear();
//                        if (StringUtils.isEmpty(guidelinesVo.getShowField())){
//                            guidelinesVo.setShowField(s);
//                        }
                    guidelinesVos1.add(guidelinesVo);
                }
                traditionalInfoDto.setLiterature(guidelinesVos1);
            }


//                    return true;
//                }, gptAnalysisThreadPool);

//                threadMap.put("guideResult" + drugId + disease, guideResult);
//                threadMap.put("literatureResult" + drugId, literatureResult);


//            String query = "请根据知识库分析" + drugInfo1.getManufacturer() + "的生产企业状况，该企业在制药企业和工信部医药工业百强榜企业中的排名情况";
            //            indicationMap.put(drugInfo1.getManufacturer() + "ma", query);


            HashMap<String, String> Mapx = new HashMap<>();
            AtomicInteger x = new AtomicInteger(1);
            HashMap<String, String> promptR = new HashMap<>();
            StringBuilder stringBuilderx1 = new StringBuilder();
            stringBuilderx1.append("请根据以下提示，分析以下这些问题（不同序号问题之间没有关联性）：\n");
            indicationMap.forEach((k, v) -> {
                String key = "问题" + x;
                String prompt = key + "：" + v + "回答时请不要带标题’问题几‘的字样\n";
                stringBuilderx1.append(prompt);
                String title = "question" + x;
                promptR.put(title, "###" + key + "###的答案");
                Mapx.put(k, title);
                x.incrementAndGet();

            });
            JSONObject responseFormat = getResponseFormat(promptR);


            HashMap<String, String> Mapx2 = new HashMap<>();
            AtomicInteger x2 = new AtomicInteger(1);
            HashMap<String, String> promptR2 = new HashMap<>();
            StringBuilder stringBuilderx2 = new StringBuilder();
            stringBuilderx2.append("请根据以下提示，分析以下这些问题（不同序号问题之间没有关联性（返回一定要跟序号对应），存在必要的换行使用$$代替）：\n");
            indicationMapx.forEach((k, v) -> {
                String key = "问题" + x2;
                String prompt = key + "：" + v + "回答时请不要带标题’问题几的答案‘的字样，注意：返回对应字段" + key + "\n";
                stringBuilderx2.append(prompt);
                String title = "问题" + x2;
                promptR2.put(title, "###" + key + "###的答案");
                Mapx2.put(k, title);
                x2.incrementAndGet();

            });
            JSONObject responseFormat2 = getResponseFormat(promptR2);


            //创建子线程执行

            JSONObject jsonObjectx1 = lxGptService.executeGptPlus(stringBuilderx1.toString(), "检索所有项目", responseFormat, "","");
            JSONObject jsonObjectx2 = lxGptService.executeGptPlus(stringBuilderx2.toString(), "检索所有项目", responseFormat2, "gpt-4o-2024-08-06","");
            log.info(jsonObjectx1.toJSONString());
            log.info(jsonObjectx2.toJSONString());

            try {
//                    String maKey = drugDisData.getManufacturer() + "ma";
//                    String ma = Mapx.get(maKey);
//                    if (ma != null) {
//                        String s = jsonObject.getString(ma).replaceAll("\\$\\$", "\n");
//                        drugDisData.setManufacturers(s);
//                    } else {
//                        drugDisData.setManufacturers("暂无");
//                    }
                String que = drugInfoNew.getManufacturer() + "企业在制药企业和工信部医药工业百强榜企业中的排名情况";
                String s = com.sentum.util.HttpUtil.SearchWebFromBing(que, que);
                traditionalInfoDto.setManufacturers(s);
            } catch (Exception e) {
                traditionalInfoDto.setManufacturers("暂无");
                e.printStackTrace();
            }

            //安全性评价
            try {
                String in = Mapx2.get(drugId + TraditionalPromptEnum.SHOW_SAFETY_EVALUATION.getKey());
                if (in != null) {
                    String s = jsonObjectx2.getString(in).replaceAll("\\$\\$", "\n");
                    traditionalInfoDto.setSafety(s);
                } else {
                    traditionalInfoDto.setSafety("暂无");
                }
            } catch (Exception e) {
                traditionalInfoDto.setSafety("暂无");
                e.printStackTrace();
            }
            //指纹图谱研究
            try {
                String clKey = drugId + TraditionalPromptEnum.SHOW_FINGERPRINT.getKey();
                String cl = Mapx.get(clKey);
                if (cl != null) {
                    String s = jsonObjectx1.getString(cl).replaceAll("\\$\\$", "\n");
                    traditionalInfoDto.setFingerprint(s);

                } else {
//                            drugDisData.setFingerprint("暂无");
                }
            } catch (Exception e) {
                traditionalInfoDto.setFingerprint("暂无");
                e.printStackTrace();
            }

//                //古代经典名方目录
//                    try {
//                        String glKey = drugId + TraditionalPromptEnum.SHOW_CLASSIC.getKey();
//                        String gl = Mapx.get(glKey);
//                        if (gl != null) {
//                            String s = jsonObject.getString(gl).replaceAll("\\$\\$", "\n");
//                            drugDisData.setClassic(s);
//                        } else {
//                            drugDisData.setClassic("暂无");
//                        }
//                    } catch (Exception e) {
//                        drugDisData.setClassic("暂无");
//                        e.printStackTrace();
//                    }

            //专利、所获奖项
            try {
                String glKey = drugId + TraditionalPromptEnum.SHOW_PATENT.getKey();
                String gl = Mapx2.get(glKey);
                if (gl != null) {
                    String s = jsonObjectx2.getString(gl).replaceAll("\\$\\$", "\n");
                    traditionalInfoDto.setPatent(s);
                } else {
                    traditionalInfoDto.setPatent("暂无");
                }
            } catch (Exception e) {
                traditionalInfoDto.setPatent("暂无");
                e.printStackTrace();
            }
            //内容检测
            try {
                String glKey = drugId + TraditionalPromptEnum.SHOW_CONTENT_DETECTION.getKey();
                String gl = Mapx2.get(glKey);
                if (gl != null) {
                    String s = jsonObjectx2.getString(gl).replaceAll("\\$\\$", "\n");
                    traditionalInfoDto.setContent(s);
                } else {
//                            drugDisData.setContent("暂无");
                }
            } catch (Exception e) {
                traditionalInfoDto.setContent("暂无");
                e.printStackTrace();
            }
            //有效性再评价
            try {
                String glKey = drugId + TraditionalPromptEnum.SHOW_VALIDITY_EVALUATION.getKey();
                String gl = Mapx2.get(glKey);
                if (gl != null) {
                    String s = jsonObjectx2.getString(gl).replaceAll("\\$\\$", "\n");
                    traditionalInfoDto.setValidity(s);
                } else {
//                            drugDisData.setValidity("暂无");
                }
            } catch (Exception e) {
            }


            {
                indicationMap2.put(TraditionalPromptEnum.SAFETY_EVALUATION.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.SAFETY_EVALUATION.getDefaultPrompt(), traditionalInfoDto));

                // 药物组成
                indicationMap2.put(TraditionalPromptEnum.DRUG_COMPOSITION.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.DRUG_COMPOSITION.getDefaultPrompt(), traditionalInfoDto));

                // 现代研究-药理作用
                indicationMap2.put(TraditionalPromptEnum.MODERN_RESEARCH_PHARMACOLOGY.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.MODERN_RESEARCH_PHARMACOLOGY.getDefaultPrompt(), traditionalInfoDto));

                // 指纹图谱研究
                indicationMap2.put(TraditionalPromptEnum.MODERN_RESEARCH_FINGERPRINT.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.MODERN_RESEARCH_FINGERPRINT.getDefaultPrompt(), traditionalInfoDto));

                // 现代研究-有效性
                indicationMap2.put(TraditionalPromptEnum.MODERN_RESEARCH_EFFECTIVENESS.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.MODERN_RESEARCH_EFFECTIVENESS.getDefaultPrompt(), traditionalInfoDto));

                // 现代研究-含量测定法
                indicationMap2.put(TraditionalPromptEnum.MODERN_RESEARCH_CONTENT_DETECTION.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.MODERN_RESEARCH_CONTENT_DETECTION.getDefaultPrompt(), traditionalInfoDto));


            }

            HashMap<String, String> Map2 = new HashMap<>();
            AtomicInteger x3 = new AtomicInteger(1);
            HashMap<String, String> prompt2 = new HashMap<>();
            StringBuilder stringBuilder2 = new StringBuilder();
            stringBuilder2.append("针对药品：" + traditionalInfoDto.getDrugName() + "回答，问题之间没有关联\n");
            indicationMap2.forEach((k, v) -> {
                String key = "问题" + x3;
                String prompt = key + "：" + v + "回答时请不要带标题’问题几‘的字样\n";
                stringBuilder2.append(prompt);
                String title = "question" + x3;
                prompt2.put(title, "###" + key + "###的打分（只能返回阿拉伯数字）");
                Map2.put(k, title);
                x3.incrementAndGet();

            });

            JSONObject responseFormat3 = getResponseFormat(prompt2);

            JSONObject jsonObject3 = lxGptService.executeGptPlus(stringBuilder2.toString(), "检索所有项目", responseFormat3, "gpt-4o-2024-08-06","");
            String s = Map2.get(TraditionalPromptEnum.DRUG_COMPOSITION.getKey());
            String s1 = Map2.get(TraditionalPromptEnum.MODERN_RESEARCH_PHARMACOLOGY.getKey());
            String s2 = Map2.get(TraditionalPromptEnum.MODERN_RESEARCH_FINGERPRINT.getKey());
            String s3 = Map2.get(TraditionalPromptEnum.MODERN_RESEARCH_EFFECTIVENESS.getKey());
            String s4 = Map2.get(TraditionalPromptEnum.MODERN_RESEARCH_CONTENT_DETECTION.getKey());
            String key7 = Map2.get(TraditionalPromptEnum.SAFETY_EVALUATION.getKey());
            map.put(TraditionalPromptEnum.SAFETY_EVALUATION.getKey(), jsonObject3.getString(key7));
            map.put(TraditionalPromptEnum.DRUG_COMPOSITION.getKey(), jsonObject3.getString(s));
            map.put(TraditionalPromptEnum.MODERN_RESEARCH_PHARMACOLOGY.getKey(), jsonObject3.getString(s1));
            map.put(TraditionalPromptEnum.MODERN_RESEARCH_FINGERPRINT.getKey(), jsonObject3.getString(s2));
            map.put(TraditionalPromptEnum.MODERN_RESEARCH_EFFECTIVENESS.getKey(), jsonObject3.getString(s3));
            map.put(TraditionalPromptEnum.MODERN_RESEARCH_CONTENT_DETECTION.getKey(), jsonObject3.getString(s4));


            return true;
        }, gptAnalysisThreadPool);

        futureResult.put("total1", total1);
        futureResult.put("total2", total2);
        CompletableFuture<Boolean> storage = CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isEmpty(traditionalInfoDto.getStorage())) {
                try {
                    String s = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "的贮存条件", "现代研究");
                    traditionalInfoDto.setStorage(s);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            }
            alone(TraditionalPromptEnum.STORAGE, map, traditionalInfoDto);
            return true;
        }, gptAnalysisThreadPool);
        futureResult.put("storage", storage);


        CompletableFuture<Boolean> validity = CompletableFuture.supplyAsync(() -> {
            if (StringUtils.isEmpty(traditionalInfoDto.getIndate())) {
                try {
                    String s = HttpUtil.SearchWebFromBing(drugInfoNew.getDrugName() + "的药品有效期", "现代研究");
                    traditionalInfoDto.setIndate(s);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            }
            alone(TraditionalPromptEnum.VALIDITY, map, traditionalInfoDto);
            return true;
        }, gptAnalysisThreadPool);
        futureResult.put("validity", validity);

        CompletableFuture<Boolean> total3 = CompletableFuture.supplyAsync(() -> {

            futureResult.forEach((s, future) -> {
                try {
                    if (s.equals("total2")) {
                        future.get();
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }
            });

            {

//                // 贮存
//                indicationMap3.put(TraditionalPromptEnum.STORAGE.getKey(),
//                        PromptUtil.replacePrompt(TraditionalPromptEnum.STORAGE.getDefaultPrompt(), traditionalInfoDto));

//                // 有效期
//                indicationMap3.put(TraditionalPromptEnum.VALIDITY.getKey(),
//                        PromptUtil.replacePrompt(TraditionalPromptEnum.VALIDITY.getDefaultPrompt(), traditionalInfoDto));

                // 药物选择
                indicationMap3.put(TraditionalPromptEnum.DRUG_CHOICE.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.DRUG_CHOICE.getDefaultPrompt(), traditionalInfoDto));

                // 说明书-主治功能
                indicationMap3.put(TraditionalPromptEnum.INSTRUCTION_ATTRIBUTE.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.INSTRUCTION_ATTRIBUTE.getDefaultPrompt(), traditionalInfoDto));

                // 说明书-性状
                indicationMap3.put(TraditionalPromptEnum.INSTRUCTION_ADVERSE_REACTION.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.INSTRUCTION_ADVERSE_REACTION.getDefaultPrompt(), traditionalInfoDto));

                // 专利、奖金或专项
                indicationMap3.put(TraditionalPromptEnum.PATENT.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.PATENT.getDefaultPrompt(), traditionalInfoDto));

                //企业状况
                indicationMap3.put(TraditionalPromptEnum.MANUFACTURERS.getKey(),
                        PromptUtil.replacePrompt(TraditionalPromptEnum.MANUFACTURERS.getDefaultPrompt(), traditionalInfoDto));

            }


            HashMap<String, String> Map3 = new HashMap<>();
            AtomicInteger x3 = new AtomicInteger(1);
            HashMap<String, String> prompt3 = new HashMap<>();
            StringBuilder stringBuilder3 = new StringBuilder();
            stringBuilder3.append("针对药品：" + traditionalInfoDto.getDrugName() + "回答，问题之间没有关联\n");
            indicationMap3.forEach((k, v) -> {
                String key = "问题" + x3;
                String prompt = key + "：" + v + "回答时请不要带标题’问题几‘的字样\n";
                stringBuilder3.append(prompt);
                String title = "question" + x3;
                prompt3.put(title, "###" + key + "###的打分（只能返回阿拉伯数字）");
                Map3.put(k, title);
                x3.incrementAndGet();

            });


            JSONObject responseFormat3 = getResponseFormat(prompt3);

            JSONObject jsonObject = lxGptService.executeGptPlus(stringBuilder3.toString(), "检索所有项目", responseFormat3, "","");
//            String s = Map3.get(TraditionalPromptEnum.STORAGE.getKey());
//            String s1 = Map3.get(TraditionalPromptEnum.VALIDITY.getKey());

            String s3 = Map3.get(TraditionalPromptEnum.INSTRUCTION_ATTRIBUTE.getKey());
            String s4 = Map3.get(TraditionalPromptEnum.INSTRUCTION_ADVERSE_REACTION.getKey());
            String s5 = Map3.get(TraditionalPromptEnum.PATENT.getKey());
            String s6 = Map3.get(TraditionalPromptEnum.MANUFACTURERS.getKey());
//            map.put(TraditionalPromptEnum.STORAGE.getKey(), jsonObject.getString(s));
//            map.put(TraditionalPromptEnum.VALIDITY.getKey(), jsonObject.getString(s1));
            map.put(TraditionalPromptEnum.INSTRUCTION_ATTRIBUTE.getKey(), jsonObject.getString(s3));
            map.put(TraditionalPromptEnum.INSTRUCTION_ADVERSE_REACTION.getKey(), jsonObject.getString(s4));
            map.put(TraditionalPromptEnum.PATENT.getKey(), jsonObject.getString(s5));
            map.put(TraditionalPromptEnum.MANUFACTURERS.getKey(), jsonObject.getString(s6));

            return true;
        }, gptAnalysisThreadPool);

        CompletableFuture<Boolean> total4 = CompletableFuture.supplyAsync(() -> {
            String DRUGCHOICE = lxGptService.getGpt(PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_DRUG_CHOICE.getDefaultPrompt(), drugInfoNew), "","");
            traditionalInfoDto.setDrugChoice(DRUGCHOICE);
            String gpt = lxGptService.getGpt(PromptUtil.replacePrompt(TraditionalPromptEnum.DRUG_CHOICE.getDefaultPrompt(), drugInfoNew), "","");
            map.put(TraditionalPromptEnum.DRUG_CHOICE.getKey(), gpt);

            //是否有不明确的地方
            if (StringUtils.isEmpty(traditionalInfoDto.getContraindications())) {
                String gpt1 = lxGptService.getGpt(PromptUtil.replacePrompt(TraditionalPromptEnum.SHOW_DRUG_CONTRAINDICATIONS.getDefaultPrompt(), drugInfoNew), "","");
                traditionalInfoDto.setContraindications(gpt1);
            }
            String gpt1 = lxGptService.getGpt(PromptUtil.replacePrompt(TraditionalPromptEnum.CONTRAINDICATIONS.getDefaultPrompt(), drugInfoNew), "","");
            map.put(TraditionalPromptEnum.CONTRAINDICATIONS.getKey(), gpt1);
            return true;
        }, gptAnalysisThreadPool);


        futureResult.put("total3", total3);
        futureResult.put("total4", total4);

    }


    private DrugInfoNew getDrugInfo(String drugId, String searchId) {
        long startTime = System.currentTimeMillis();

        DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
        if (ObjectUtil.isEmpty(drugInfo1)) {
            throw new RuntimeException("未找到药品信息");
        }

        String register = drugInfo1.getRegister();
        if (register != null) {
            DrugInst approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInst.class);
            if (ObjectUtil.isNotEmpty(approveCode)) {
                if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                    drugInfo1.setIndications(delHTMLTag(approveCode.getIndication()));
                }
                if (approveCode.getDosage() != null && !approveCode.getDosage().isEmpty()) {
                    drugInfo1.setUsageAndDosage(delHTMLTag(approveCode.getDosage()));
                }
                if (approveCode.getUseInPregLact() != null && !approveCode.getUseInPregLact().isEmpty()) {
                    drugInfo1.setPregnantWomen(delHTMLTag(approveCode.getUseInPregLact()));
                }
                if (approveCode.getUseInChildren() != null && !approveCode.getUseInChildren().isEmpty()) {
                    drugInfo1.setChildrenMedicine(delHTMLTag(approveCode.getUseInChildren()));
                }
                if (approveCode.getUseInElderly() != null && !approveCode.getUseInElderly().isEmpty()) {
                    drugInfo1.setGeriatricMedicine(delHTMLTag(approveCode.getUseInElderly()));
                }
                if (approveCode.getAdverseReactions() != null && !approveCode.getAdverseReactions().isEmpty()) {
                    drugInfo1.setAdverseReaction(delHTMLTag(approveCode.getAdverseReactions()));
                }
                if (approveCode.getPrecautions() != null && !approveCode.getPrecautions().isEmpty()) {
                    drugInfo1.setNotes(delHTMLTag(approveCode.getPrecautions()));
                }
                if (approveCode.getDrugInteractions() != null && !approveCode.getDrugInteractions().isEmpty()) {
                    drugInfo1.setDrugInteraction(delHTMLTag(approveCode.getDrugInteractions()));
                }
                if (approveCode.getMechanismAction() != null && !approveCode.getMechanismAction().isEmpty()) {
                    drugInfo1.setPharmacology(delHTMLTag(approveCode.getMechanismAction()));
                }
                if (approveCode.getPharmacokinetics() != null && !approveCode.getPharmacokinetics().isEmpty()) {
                    drugInfo1.setPharmacokinetics(delHTMLTag(approveCode.getPharmacokinetics()));
                }
                if (approveCode.getStorage() != null && !approveCode.getStorage().isEmpty()) {
                    drugInfo1.setStorage(delHTMLTag(approveCode.getStorage()));
                }
                if (approveCode.getPack() != null && !approveCode.getPack().isEmpty()) {
                    drugInfo1.setPack(delHTMLTag(approveCode.getPack()));
                }
                if (approveCode.getPeriod() != null && !approveCode.getPeriod().isEmpty()) {
                    drugInfo1.setIndate(delHTMLTag(approveCode.getPeriod()));
                }
                if (approveCode.getComponent() != null && !approveCode.getComponent().isEmpty()) {
                    drugInfo1.setIngredient(delHTMLTag(approveCode.getComponent()));
                }

                if (approveCode.getContraindications() != null && !approveCode.getContraindications().isEmpty()) {
                    log.info("approveCode.getContraindications()={}", approveCode.getContraindications());
                    drugInfo1.setContraindications(delHTMLTag(approveCode.getContraindications()));
                    log.info("drugInfo1.getContraindications()={}", drugInfo1.getContraindications());
                }
                if (approveCode.getDrugWarning() != null && !approveCode.getDrugWarning().isEmpty()) {
                    drugInfo1.setDrugWarning(delHTMLTag(approveCode.getDrugWarning()));
                }
                if (approveCode.getPdf() != null && !approveCode.getPdf().isEmpty()) {
                    drugInfo1.setPdf(approveCode.getPdf());
                }
            }
        }

        String isAdverseReactions = "0";
        // 合理用药
        if (ObjectUtil.isNotEmpty(drugInfo1.getDrugZh()) || ObjectUtil.isNotEmpty(drugInfo1.getDrugSynonymZh())) {
            JSONObject evaluationMedicine = evaluationService.getHeliYongYao(drugInfo1.getDrugZh());
            if (ObjectUtil.isEmpty(evaluationMedicine)) {
                List<JSONObject> evaluationMedicines = mongoTemplate.find(new Query(Criteria.where("drugName").in(drugInfo1.getDrugSynonymZh())), JSONObject.class, CommonConstants.REASONABLE_DRUG_TABLE_NAME);
                if (CollUtil.isNotEmpty(evaluationMedicines)) {
                    evaluationMedicine = evaluationMedicines.get(0);
                }
            }
            if (ObjectUtil.isNotEmpty(evaluationMedicine)) {
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("commonAdverseReactions"))) {
                    drugInfo1.setCommonAdverseReactions(getTxt(evaluationMedicine.getJSONArray("commonAdverseReactions")));

                }
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("seriousAdverseRactions"))) {
                    drugInfo1.setSeriousAdverseRactions(getTxt(evaluationMedicine.getJSONArray("seriousAdverseRactions")));

                }
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction"))) {
                    drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithLiverDysfunction")));
                }
                if (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency"))) {
                    drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(getTxt(evaluationMedicine.getJSONArray("doseAdjustmentPatientsWithRenalInsufficiency")));
                }

                if (StringUtils.isNotEmpty(drugInfo1.getPregnantWomen()) &&
                        (CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("pregnancyGrade")) ||
                                CollUtil.isNotEmpty(evaluationMedicine.getJSONArray("medicationDuringPregnancy")))) {
                    drugInfo1.setPregnantWomen(getTxt(evaluationMedicine.getJSONArray("pregnancyGrade")) + getTxt(evaluationMedicine.getJSONArray("medicationDuringPregnancy")));
                }

                if (StringUtils.isNotEmpty(evaluationMedicine.getString("geneticsReproductionCarcinogenicity"))) {
                    drugInfo1.setGeneticsReproductionCarcinogenicity(getTxt(evaluationMedicine.getJSONArray("geneticsReproductionCarcinogenicity")));
                }

                if (StringUtils.isNotEmpty(evaluationMedicine.getString("warning"))) {
                    drugInfo1.setBlackBoxWaringOfFDA(getTxt(evaluationMedicine.getJSONArray("warningwarning")));
                }


            }
        }

        DrugAddDto drugAdd = null;
        if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
            drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
        }
        if (ObjectUtil.isNotEmpty(drugAdd)) {
            BeanUtil.copyPropertiesIgnoreNull(drugAdd, drugInfo1);
            StringBuilder usageAndDosage = new StringBuilder();
            if (StringUtils.isNotEmpty(drugAdd.getDosageAdministered())) {
                usageAndDosage.append("给药剂量:" + drugAdd.getDosageAdministered() + "\n");
            }
            if (StringUtils.isNotEmpty(drugAdd.getDosageFrequency())) {
                usageAndDosage.append("给药频次:" + drugAdd.getDosageFrequency() + "\n");
            }
            if (StringUtils.isNotEmpty(drugAdd.getPregnantWomen())) {
                usageAndDosage.append("孕妇及哺乳期妇女用药:" + drugAdd.getPregnantWomen() + "\n");
            }
            if (StringUtils.isNotEmpty(drugAdd.getChildrenMedicine())) {
                usageAndDosage.append("儿童用药:" + drugAdd.getChildrenMedicine() + "\n");
            }
            if (StringUtils.isNotEmpty(drugAdd.getGeriatricMedicine())) {
                usageAndDosage.append("老年用药:" + drugAdd.getGeriatricMedicine() + "\n");
            }
            if (StringUtils.isNotEmpty(drugAdd.getKidneyPatients())) {
                usageAndDosage.append("肾功能异常者:" + drugAdd.getKidneyPatients() + "\n");
                drugInfo1.setNotes(drugInfo1.getNotes() + "\n肾病是否可用：" + drugAdd.getKidneyPatients());
                drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(drugAdd.getKidneyPatients());
            }
            if (StringUtils.isNotEmpty(drugAdd.getLiverPatients())) {
                usageAndDosage.append("肝功能异常者:" + drugAdd.getLiverPatients() + "\n");
                drugInfo1.setNotes(drugInfo1.getNotes() + "\n肝病是否可用：" + drugAdd.getLiverPatients());
                drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(drugAdd.getLiverPatients());
            }
            if (usageAndDosage.length() > 0) {
                drugInfo1.setUsageAndDosage(usageAndDosage.toString());
            }
            StringBuilder adverseReaction = new StringBuilder();
            if (StringUtils.isNotEmpty(drugAdd.getModerateAdverseReaction())) {
                adverseReaction.append("中度不良反应:" + drugAdd.getModerateAdverseReaction() + "\n");
                drugInfo1.setCommonAdverseReactions(drugAdd.getModerateAdverseReaction());
            }
            if (StringUtils.isNotEmpty(drugAdd.getSevereAdverseReaction())) {
                adverseReaction.append("重度不良反应:" + drugAdd.getSevereAdverseReaction() + "\n");
                drugInfo1.setSeriousAdverseRactions(drugAdd.getSevereAdverseReaction());
            }
            if (adverseReaction.length() > 0) {
                drugInfo1.setAdverseReaction(adverseReaction.toString());
            }
        }

        return drugInfo1;
    }

    @Override
    public Object getDataTalPulsV2(String searchId, String drugIds) {
        ArrayList<TrInfoDto> drugDisDatas = new ArrayList<>();
        String[] ids = drugIds.split(",");

        for (String id : ids) {
            //获得所有信息
            DrugInfoNew drugInfo = getDrugInfo(id, searchId);
            //第一部分，传承评价
            TrInheritanceEvaluationDto trInheritanceEvaluationDto = traditionalGptService.getTrInheritanceEvaluationDto(drugInfo);
            TrClinicalEvaluationDto trClinicalEvaluationDto = traditionalGptService.getTrClinicalEvaluationDto(drugInfo);
            TrSafetyEvaluationDto trSafetyEvaluationDto = traditionalGptService.getTrSafetyEvaluationDto(drugInfo);
            TrTechnologyEvaluationDto trPolicyEvaluationDto = traditionalGptService.getTrTechnologyEvaluationDto(drugInfo);
            TrMarketEvaluationDto trMarketEvaluationDto = traditionalGptService.getTrMarketEvaluationDto(drugInfo);
            Double totalScore = trInheritanceEvaluationDto.getTotalScore() + trClinicalEvaluationDto.getTotalScore() + trSafetyEvaluationDto.getTotalScore() + trPolicyEvaluationDto.getTotalScore() + trMarketEvaluationDto.getTotalScore();

            String title = drugInfo.getDrugName() + "-" + drugInfo.getSpecifications() + "-" + drugInfo.getManufacturer();
            TrInfoDto trInfoDto = new TrInfoDto(searchId, trInheritanceEvaluationDto, trClinicalEvaluationDto, trSafetyEvaluationDto, trPolicyEvaluationDto, trMarketEvaluationDto, totalScore
                    , drugInfo.getDrugName(), id, title,null);
            //将trInfoDto转为json格式
            String json = JSONUtil.toJsonStr(trInfoDto);
            log.info("trInfoDto:{}", json);
            mongoTemplate.save(trInfoDto);
            drugDisDatas.add(trInfoDto);

        }


        return drugDisDatas;
    }


    
    private int putNew(String id,int step,String s, TrInfoDto trInfoDto,List<String> strings) {


        if (CacheNameEnum.CACHE_Clinical.getName().equals(s)){
            if (StringUtils.isNotEmpty(trInfoDto.getTrClinicalEvaluationDto().getClinicalDemandOption())) {
                switch (trInfoDto.getTrClinicalEvaluationDto().getClinicalDemandOption()) {
                    case "1":
                        trInfoDto.getTrClinicalEvaluationDto().setClinicalDemandOption("填补本院用药目录空白");
                        trInfoDto.getTrClinicalEvaluationDto().setClinicalDemandScore(5.0);
                        break;
                    case "2":
                        trInfoDto.getTrClinicalEvaluationDto().setClinicalDemandOption("可推动本院中医优势病种发展或可纳入临床路径");
                        trInfoDto.getTrClinicalEvaluationDto().setClinicalDemandScore(3.0);
                        break;
                    case "3":
                        trInfoDto.getTrClinicalEvaluationDto().setClinicalDemandOption("可为收治患者提供多种用药选择");
                        trInfoDto.getTrClinicalEvaluationDto().setClinicalDemandScore(1.0);
                        break;
                }
            } else {
                trInfoDto.getTrClinicalEvaluationDto().setClinicalDemandOption("暂无内容");
            }

            addProcess(id, step++, trInfoDto.getTrClinicalEvaluationDto().getClinicalDemandOption(),strings);
        }



        if (CacheNameEnum.CACHE_Packaging.getName().equals(s)){
            if (StringUtils.isNotEmpty(trInfoDto.getTrTechnologyEvaluationDto().getPackagingSpecificationOption())) {
                switch (trInfoDto.getTrTechnologyEvaluationDto().getPackagingSpecificationOption()) {
                    case "1":
                        trInfoDto.getTrTechnologyEvaluationDto().setPackagingSpecificationOption("包装规格与临床常用日剂量适配(两者比值为整数)");
                        trInfoDto.getTrTechnologyEvaluationDto().setPackagingSpecificationScore(1.0);
                        break;
                    case "2":
                        trInfoDto.getTrTechnologyEvaluationDto().setPackagingSpecificationOption("包装规格与临床常用日剂量适配(两者比值为非整数)");
                        trInfoDto.getTrTechnologyEvaluationDto().setPackagingSpecificationScore(0.5);
                        break;

                }
            } else {
                trInfoDto.getTrTechnologyEvaluationDto().setPackagingSpecificationOption("暂无内容");
            }
            addProcess(id,step++,trInfoDto.getTrTechnologyEvaluationDto().getPackagingSpecificationOption(),strings);

        }


        if (CacheNameEnum.CACHE_LARGE_PACKAGING.getName().equals(s)){

            if (StringUtils.isNotEmpty(trInfoDto.getTrTechnologyEvaluationDto().getLargePackageAdoptionOption())) {
                switch (trInfoDto.getTrTechnologyEvaluationDto().getLargePackageAdoptionOption()) {
                    case "1":
                        trInfoDto.getTrTechnologyEvaluationDto().setLargePackageAdoptionOption("最小包装使用人次数高于对照药");
                        trInfoDto.getTrTechnologyEvaluationDto().setLargePackageAdoptionScore(1.0);
                        break;
                    case "2":
                        trInfoDto.getTrTechnologyEvaluationDto().setLargePackageAdoptionOption("最小包装使用人次数低于对照药");
                        trInfoDto.getTrTechnologyEvaluationDto().setLargePackageAdoptionScore(0.0);
                        break;
                }
            } else {
                trInfoDto.getTrTechnologyEvaluationDto().setLargePackageAdoptionOption("暂无内容");
            }

            addProcess(id,step++,trInfoDto.getTrTechnologyEvaluationDto().getLargePackageAdoptionOption(),strings);
        }


        if (CacheNameEnum.SINGLE_MEDICATION.getName().equals(s)){

            if (StringUtils.isNotEmpty(trInfoDto.getTrTechnologyEvaluationDto().getSingleDoseOption())) {
                switch (trInfoDto.getTrTechnologyEvaluationDto().getSingleDoseOption()) {
                    case "1":
                        trInfoDto.getTrTechnologyEvaluationDto().setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值为1)");
                        trInfoDto.getTrTechnologyEvaluationDto().setSingleDoseScore(1.0);
                        break;
                    case "2":
                        trInfoDto.getTrTechnologyEvaluationDto().setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值>1)");
                        trInfoDto.getTrTechnologyEvaluationDto().setSingleDoseScore(0.8);
                        break;
                    case "3":
                        trInfoDto.getTrTechnologyEvaluationDto().setSingleDoseOption("临床常用单次用量与药品规格适配(两者比值<1)");
                        trInfoDto.getTrTechnologyEvaluationDto().setSingleDoseScore(0.5);
                        break;
                }
            } else {
                trInfoDto.getTrTechnologyEvaluationDto().setSingleDoseOption("暂无内容");
            }
            addProcess(id,step++,trInfoDto.getTrTechnologyEvaluationDto().getSingleDoseOption(),strings);
        }


        if (CacheNameEnum.ECONOMY_TITLE.getName().equals(s)){

            if (StringUtils.isNotEmpty(trInfoDto.getTrMarketEvaluationDto().getMarketUniquenessOption())) {
                switch (trInfoDto.getTrMarketEvaluationDto().getMarketUniquenessOption()) {
                    case "1":
                        trInfoDto.getTrMarketEvaluationDto().setMarketUniquenessOption("具有不可替代的唯一性或填补市场空白");
                        trInfoDto.getTrMarketEvaluationDto().setMarketUniquenessScore(3.0);
                        break;
                    case "2":
                        trInfoDto.getTrMarketEvaluationDto().setMarketUniquenessOption("与已上市的同类药品相比具有独特优势");
                        trInfoDto.getTrMarketEvaluationDto().setMarketUniquenessScore(2.0);
                        break;
                    case "3":
                        trInfoDto.getTrMarketEvaluationDto().setMarketUniquenessOption("市面上有同类药品");
                        trInfoDto.getTrMarketEvaluationDto().setMarketUniquenessScore(1.0);
                        break;
                }
            } else {
                trInfoDto.getTrMarketEvaluationDto().setMarketUniquenessOption("暂无内容");
            }

            addProcess(id,step++,trInfoDto.getTrMarketEvaluationDto().getMarketUniquenessOption(),strings);
        }


        if (CacheNameEnum.ECONOMY.getName().equals(s)) {
            if (StringUtils.isNotEmpty(trInfoDto.getTrMarketEvaluationDto().getEconomicOption())) {
                switch (trInfoDto.getTrMarketEvaluationDto().getEconomicOption()) {

                    case "1":
                        trInfoDto.getTrMarketEvaluationDto().setDailyTreatmentCostOption("日均治疗费用较同类中成药价格较低");
                        trInfoDto.getTrMarketEvaluationDto().setDailyTreatmentCostScore(3.0);
                        break;
                    case "2":
                        trInfoDto.getTrMarketEvaluationDto().setDailyTreatmentCostOption("日均治疗费用较同类中成药价格相当");
                        trInfoDto.getTrMarketEvaluationDto().setDailyTreatmentCostScore(2.0);
                        break;
                    case "3":
                        trInfoDto.getTrMarketEvaluationDto().setDailyTreatmentCostOption("日均治疗费用较同类中成药价格高");
                        trInfoDto.getTrMarketEvaluationDto().setDailyTreatmentCostScore(1.0);
                        break;
                }
            } else {
                trInfoDto.getTrMarketEvaluationDto().setEconomicOption("暂无内容");
            }

            addProcess(id, step++, trInfoDto.getTrMarketEvaluationDto().getEconomicOption(), strings);
        }

        return step;
    }





}
