package com.sentum.util;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONException;
import com.alibaba.fastjson.JSONObject;
import com.sentum.enums.ContentTagEnum;
import com.sentum.enums.MongoTableNameEnum;
import com.sentum.feign.FormulaFeign;
import com.sentum.pojo.DrugContent;
import com.sentum.pojo.DrugInfoNew;
import com.sentum.pojo.dto.DrugAddDto;
import com.sentum.pojo.vo.DrugInst;
import com.sentum.pojo.vo.GuideVO;
import com.sentum.pojo.vo.Literature;
import com.sentum.service.EvaluationService;
import com.sentum.service.LxGptService;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.collections4.CollectionUtils;
import org.apache.commons.lang.StringUtils;
import org.elasticsearch.index.query.BoolQueryBuilder;
import org.elasticsearch.index.query.QueryBuilders;
import org.elasticsearch.index.query.TermsQueryBuilder;
import org.elasticsearch.index.query.WrapperQueryBuilder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.elasticsearch.core.SearchHit;
import org.springframework.data.elasticsearch.core.SearchHits;
import org.springframework.data.elasticsearch.core.query.NativeSearchQuery;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;

import java.lang.reflect.Field;
import java.util.*;

@Slf4j
@Component
public class DrugInfoUtil {

    @Autowired
    private MongoTemplate mongoTemplate;

    @Autowired
    private EvaluationService evaluationService;

    @Autowired
    private FormulaFeign formulaFeign;


    @Autowired
    ElasticsearchRestTemplate elasticsearchRestTemplate;

    @Autowired
    LxGptService lxGptService;

    @Value("${gpt.isNew}")
    private boolean isNew;


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

    public DrugInfoNew getDrugInfo(String drugId, String searchId) {

        DrugInfoNew drugInfo1 = mongoTemplate.findOne(new Query(Criteria.where("_id").is(drugId)), DrugInfoNew.class);
        if (drugInfo1 == null) return null;

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


        String register = drugInfo1.getRegister();
        if (register != null) {
            DrugInst approveCode = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), DrugInst.class);
//            JSONObject approveCode1 = mongoTemplate.findOne(new Query(Criteria.where("approveCode").is(register)), JSONObject.class, MongoTableNameEnum.INSTRUCTION.getName());
//            log.info("*****************approveCode1:{}*************", approveCode1);
//
//            if (ObjectUtil.isEmpty(approveCode)) {
//                List<DrugInst> approveCodes = mongoTemplate.find(new Query(Criteria.where("commonName").is(drugInfo1.getDrugName())), DrugInst.class);
//                if (CollUtil.isNotEmpty(approveCodes)) {
//                    approveCode = approveCodes.get(0);
//                }
//            }

            if (approveCode != null) {
                List<DrugContent> pharmacology = approveCode.getPharmacology();
                if (CollectionUtils.isNotEmpty(pharmacology)) {
                    drugInfo1.setPharmacology(delHTMLTag(pharmacology));
                }
                List<DrugContent> mechanismAction = approveCode.getMechanismAction();
                if (CollectionUtils.isNotEmpty(mechanismAction)) {
                    drugInfo1.setMechanismAction(delHTMLTag(mechanismAction));
                }
                List<DrugContent> toxicological = approveCode.getToxicological();
                if (CollectionUtils.isNotEmpty(toxicological)) {
                    drugInfo1.setToxicological(delHTMLTag(toxicological));
                }


                if (approveCode.getIndication() != null && !approveCode.getIndication().isEmpty()) {
                    drugInfo1.setIndications(delHTMLTag(approveCode.getIndication()));
                }
                if (approveCode.getDosage() != null && !approveCode.getDosage().isEmpty()) {
                    drugInfo1.setUsageAndDosage(delHTMLTag(approveCode.getDosage()));
                }
                if (approveCode.getUseInPregLact() != null && !approveCode.getUseInPregLact().isEmpty()) {
                    drugInfo1.setPregnantWomen(delHTMLTag(approveCode.getUseInPregLact()));
                }

//                String yunfu = getAllDrugContentLists(approveCode, "孕妇,妇女,哺乳");
//                if (StringUtils.isNotEmpty(yunfu) && StringUtils.isEmpty(drugInfo1.getPregnantWomen())) {
//                    drugInfo1.setPregnantWomen(yunfu);
//                }

                if (approveCode.getUseInChildren() != null && !approveCode.getUseInChildren().isEmpty()) {
                    drugInfo1.setChildrenMedicine(delHTMLTag(approveCode.getUseInChildren()));
                }
//                String ertong = getAllDrugContentLists(approveCode1, "儿童");
//                if (StringUtils.isNotEmpty(ertong) && StringUtils.isEmpty(drugInfo1.getChildrenMedicine())) {
//                    drugInfo1.setChildrenMedicine(ertong);
//                }

                if (approveCode.getUseInElderly() != null && !approveCode.getUseInElderly().isEmpty()) {
                    drugInfo1.setGeriatricMedicine(delHTMLTag(approveCode.getUseInElderly()));
                }
//                String laonian = getAllDrugContentLists(approveCode1, "老年");
//                if (StringUtils.isNotEmpty(laonian) && StringUtils.isEmpty(drugInfo1.getGeriatricMedicine())) {
//                    drugInfo1.setGeriatricMedicine(laonian);
//                }

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
//                String gan = getAllDrugContentLists(approveCode1, "肝");
//                if (StringUtils.isNotEmpty(gan)) {
//                    drugInfo1.setDoseAdjustmentPatientsWithLiverDysfunction(gan);
//                }
//                String shen = getAllDrugContentLists(approveCode1, "肾");
//                if (StringUtils.isNotEmpty(shen)) {
//                    drugInfo1.setDoseAdjustmentPatientsWithRenalInsufficiency(shen);
//                }

//                //致畸性  致癌性
//                String zhizhuang = getAllDrugContentLists(approveCode1, "致畸,致癌");
//                if (StringUtils.isNotEmpty(zhizhuang)) {
//                    drugInfo1.setGeneticsReproductionCarcinogenicity(zhizhuang);
//                }


            }
        }


        DrugAddDto drugAdd = null;
        if (StringUtils.isNotEmpty(drugId) && StringUtils.isNotEmpty(searchId)) {
            drugAdd = mongoTemplate.findOne(new Query(Criteria.where("drugId").is(drugId).and("searchId").is(searchId)), DrugAddDto.class);
        }
        if (Objects.nonNull(drugAdd)) {
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


    public static String laozihao = "2024中药老字号品牌TOP50\n" +
            "排名\t品牌\t品牌持有人\n" +
            "1\t同仁堂牌\t中国北京同仁堂(集团)有限责任公司\n" +
            "2\t云南白药\t云南白药集团股份有限公司\n" +
            "3\t片仔癀\t漳州片仔癀药业股份有限公司\n" +
            "4\t东阿\t东阿阿胶股份有限公司\n" +
            "5\t王老吉\t广州王老吉药业股份有限公司\n" +
            "6\t达仁堂\t津药达仁堂集团股份有限公司达仁堂制药厂\n" +
            "7\t云昆牌\t昆明中药厂有限公司\n" +
            "8\t雷允上\t雷允上药业集团有限公司\n" +
            "9\t马应龙\t马应龙药业集团股份有限公司\n" +
            "10\t九芝堂\t九芝堂股份有限公司\n" +
            "11\t桐君阁\t重庆桐君阁股份有限公司\n" +
            "12\t乐家老铺\t南京同仁堂药业有限责任公司\n" +
            "13\t中一\t广州白云山中一药业有限公司\n" +
            "14\t中国中药\t中国中药有限公司\n" +
            "15\t陈李济\t广州白云山陈李济药厂有限公司\n" +
            "16\t健民\t健民药业集团股份有限公司\n" +
            "17\t敖东\t吉林敖东药业集团股份有限公司\n" +
            "18\t广誉远\t山西广誉远国药有限公司\n" +
            "19\t三金\t桂林三金药业股份有限公司\n" +
            "20\t昆药\t昆药集团股份有限公司\n" +
            "21\t仲景\t仲景宛西制药股份有限公司\n" +
            "22\t雷氏\t上海雷允上药业有限公司\n" +
            "23\t剑门\t太极集团四川绵阳制药有限公司\n" +
            "24\t佛慈\t兰州佛慈制药股份有限公司\n" +
            "25\t宏济堂\t山东宏济堂制药集团股份有限公司\n" +
            "26\t伍舒芳\t重庆希尔安药业有限公司\n" +
            "27\t世一堂\t哈药集团世一堂制药厂\n" +
            "28\t中华\t广西梧州制药(集团)股份有限公司\n" +
            "29\t福字牌\t山东福牌阿胶股份有限公司\n" +
            "30\t寿仙谷\t金华寿仙谷药业有限公司\n" +
            "31\t药都\t江西药都樟树制药有限公司\n" +
            "32\t腾药\t云南腾药制药股份有限公司\n" +
            "33\t余良卿号\t安徽安科余良卿药业有限公司\n" +
            "34\t同济堂\t国药集团同济堂(贵州)制药有限公司\n" +
            "35\t古汉\t古汉中药有限公司\n" +
            "36\t复盛公\t山西复盛公药业集团有限公司\n" +
            "37\t潘高寿\t广州白云山潘高寿药业股份有限公司\n" +
            "38\t乐仁堂\t津药达仁堂集团股份有限公司乐仁堂制药厂\n" +
            "39\t童涵春堂\t上海童涵春堂中药饮片有限公司\n" +
            "40\t禾穗牌\t广州白云山光华制药股份有限公司\n" +
            "41\t隆顺榕\t津药达仁堂集团股份有限公司隆顺榕制药厂\n" +
            "42\t广盛原\t广盛原中医药有限公司\n" +
            "43\t梓橦宫\t四川梓橦宫药业股份有限公司\n" +
            "44\t胡庆余堂\t杭州胡庆余堂国药号有限公司\n" +
            "45\t冯了性\t国药集团冯了性(佛山)药业有限公司\n" +
            "46\t鼎炉\t厦门中药厂有限公司\n" +
            "47\t京万红\t津药达仁堂京万红(天津)药业有限公司\n" +
            "48\t玉林\t广西玉林制药集团有限责任公司\n" +
            "49\t朱养心\t杭州朱养心药业有限公司\n" +
            "50\t群星\t广州白云山星群(药业)股份有限公司";


    public static String baiqiang = "2023年度中国医药工业百强企业：\n" +
            "序号\t企业名称\n" +
            "\n" +
            "1\t中国医药集团有限公司\n" +
            "2\t华润医药控股有限公司\n" +
            "3\t齐鲁制药集团有限公司\n" +
            "4\t上海复星医药（集团）股份有限公司\n" +
            "5\t中国远大集团有限责任公司\n" +
            "6\t石药控股集团有限公司\n" +
            "7\t广州医药集团有限公司\n" +
            "8\t上海医药（集团）有限公司\n" +
            "9\t扬子江药业集团有限公司\n" +
            "10\t修正药业集团股份有限公司\n" +
            "11\t江苏恒瑞医药股份有限公司\n" +
            "12\t正大天晴药业集团股份有限公司\n" +
            "13\t诺和诺德（中国）制药有限公司\n" +
            "14\t拜耳医药保健有限公司\n" +
            "15\t四川科伦药业股份有限公司\n" +
            "16\t江西济民可信集团有限公司\n" +
            "17\t晖致制药（大连）有限公司\n" +
            "18\t阿斯利康制药有限公司\n" +
            "19\t长春高新技术产业（集团）股份有限公司\n" +
            "20\t威高集团有限公司\n" +
            "21\t山东步长制药股份有限公司\n" +
            "22\t新和成控股集团有限公司\n" +
            "23\t珠海联邦制药股份有限公司\n" +
            "24\t人福医药集团股份公司\n" +
            "25\t丽珠医药集团股份有限公司\n" +
            "26\t赛诺菲（中国）投资有限公司\n" +
            "27\t西安杨森制药有限公司\n" +
            "28\t北京诺华制药有限公司\n" +
            "29\t杭州默沙东制药有限公司\n" +
            "30\t石家庄以岭药业股份有限公司\n" +
            "31\t鲁南制药集团股份有限公司\n" +
            "32\t华北制药集团有限责任公司\n" +
            "33\t江苏济川控股集团有限公司\n" +
            "34\t深圳市东阳光实业发展有限公司\n" +
            "35\t江苏豪森药业集团有限公司\n" +
            "36\t普洛药业股份有限公司\n" +
            "37\t天津市医药集团有限公司\n" +
            "38\t上海罗氏制药有限公司\n" +
            "39\t浙江华海药业股份有限公司\n" +
            "40\t山东新华制药股份有限公司\n" +
            "41\t江苏鱼跃医疗设备股份有限公司\n" +
            "42\t沈阳三生制药有限责任公司\n" +
            "43\t天士力医药集团股份有限公司\n" +
            "44\t费森尤斯卡比（中国）投资有限公司\n" +
            "45\t云南白药集团股份有限公司\n" +
            "46\t成都倍特药业股份有限公司\n" +
            "47\t乐普（北京）医疗器械股份有限公司\n" +
            "48\t山东鲁抗医药股份有限公司\n" +
            "49\t信达生物制药（苏州）有限公司\n" +
            "50\t浙江康恩贝制药股份有限公司\n" +
            "51\t石家庄四药有限公司\n" +
            "52\t默克制药（江苏）有限公司\n" +
            "53\t葵花药业集团股份有限公司\n" +
            "54\t浙江海正药业股份有限公司\n" +
            "55\t浙江医药股份有限公司\n" +
            "56\t青峰医药集团有限公司\n" +
            "57\t深圳市海普瑞药业集团股份有限公司\n" +
            "58\t浙江九洲药业股份有限公司\n" +
            "59\t华兰生物工程股份有限公司\n" +
            "60\t哈药集团有限公司\n" +
            "61\t天津红日药业股份有限公司\n" +
            "62\t先声药业有限公司\n" +
            "63\t瑞阳制药股份有限公司\n" +
            "64\t江苏康缘药业股份有限公司\n" +
            "65\t东北制药集团股份有限公司\n" +
            "66\t北京泰德制药股份有限公司\n" +
            "67\t神威药业集团有限公司\n" +
            "68\t漳州片仔癀药业股份有限公司\n" +
            "69\t东富龙科技集团股份有限公司\n" +
            "70\t辰欣科技集团有限公司\n" +
            "71\t烟台绿叶医药控股（集团）有限公司\n" +
            "72\t上海创诺医药集团有限公司\n" +
            "73\t上海莱士血液制品股份有限公司\n" +
            "74\t四川好医生攀西药业有限责任公司\n" +
            "75\t江苏恩华药业股份有限公司\n" +
            "76\t楚天科技股份有限公司\n" +
            "77\t四川新绿色药业科技发展有限公司\n" +
            "78\t浙江仙琚制药股份有限公司\n" +
            "79\t悦康药业集团股份有限公司\n" +
            "80\t厦门万泰沧海生物技术有限公司\n" +
            "81\t成都康弘药业集团股份有限公司\n" +
            "82\t浙江京新药业股份有限公司\n" +
            "83\t健康元药业集团股份有限公司\n" +
            "84\t上海勃林格殷格翰药业有限公司\n" +
            "85\t玉溪沃森生物技术有限公司\n" +
            "86\t贵州健兴药业有限公司\n" +
            "87\t山东齐都药业有限公司\n" +
            "88\t仁和（集团）发展有限公司\n" +
            "89\t江苏苏中健康科技有限公司\n" +
            "90\t南京健友生化制药股份有限公司\n" +
            "91\t山东金城医药集团股份有限公司\n" +
            "92\t海思科医药集团股份有限公司\n" +
            "93\t朗致集团有限公司\n" +
            "94\t中国医药健康产业股份有限公司\n" +
            "95\t河南羚锐制药股份有限公司\n" +
            "96\t深圳信立泰药业股份有限公司\n" +
            "97\t烟台东诚药业集团股份有限公司\n" +
            "98\t山西亚宝投资集团有限公司\n" +
            "99\t卫材（中国）投资有限公司\n" +
            "100\t郑州安图生物工程股份有限公司\n";


    public static final String zhongyaobaiqiang = "2023年度中国中药企业TOP100排行榜\n" +
            "序号\t企业名称\n" +
            "1\t广州医药集团有限公司\n" +
            "2\t华润三九医药股份有限公司\n" +
            "3\t中国中药控股有限公司\n" +
            "4\t步长制药\n" +
            "5\t云南白药集团股份有限公司\n" +
            "6\t北京同仁堂股份有限公司\n" +
            "7\t石家庄以岭药业股份有限公司\n" +
            "8\t济川药业集团有限公司\n" +
            "9\t天士力医药集团股份有限公司\n" +
            "10\t天津市医药集团有限公司\n" +
            "11\t太极集团有限公司\n" +
            "12\t浙江康恩贝制药股份有限公司\n" +
            "13\t葵花药业集团股份有限公司\n" +
            "14\t江苏康缘药业股份有限公司\n" +
            "15\t仁和药业股份有限公司\n" +
            "16\t漳州片仔癀药业股份有限公司\n" +
            "17\t天津红日药业股份有限公司\n" +
            "18\t东阿阿胶股份有限公司\n" +
            "19\t神威药业集团有限公司\n" +
            "20\t华润江中制药集团有限责任公司\n" +
            "21\t河南羚锐制药股份有限公司\n" +
            "22\t康臣药业集团有限公司\n" +
            "23\t广东众生药业股份有限公司\n" +
            "24\t好医生药业集团有限公司\n" +
            "25\t九芝堂股份有限公司\n" +
            "26\t黑龙江珍宝岛药业股份有限公司\n" +
            "27\t上海和黄药业有限公司\n" +
            "28\t西藏奇正藏药股份有限公司\n" +
            "29\t桂林三金药业股份有限公司\n" +
            "30\t广西梧州中恒集团股份有限公司\n" +
            "31\t株洲千金药业股份有限公司\n" +
            "32\t江西青峰药业有限公司\n" +
            "33\t吉林敖东药业集团股份有限公司\n" +
            "34\t苏中药业集团股份有限公司\n" +
            "35\t雷允上药业集团有限公司\n" +
            "36\t南京同仁堂药业有限责任公司\n" +
            "37\t亚宝药业集团股份有限公司\n" +
            "38\t健民药业集团股份有限公司\n" +
            "39\t贵州益佰制药股份有限公司\n" +
            "40\t海南葫芦娃药业集团股份有限公司\n" +
            "41\t马应龙药业集团股份有限公司\n" +
            "42\t吉林万通药业集团有限公司\n" +
            "43\t成都地奥制药集团有限公司\n" +
            "44\t仲景宛西制药股份有限公司\n" +
            "45\t山东福牌阿胶股份有限公司\n" +
            "46\t京都念慈总厂有限公司\n" +
            "47\t山东宏济堂制药集团股份有限公司\n" +
            "48\t浙江佐力药业股份有限公司\n" +
            "49\t广州市香雪制药股份有限公司\n" +
            "50\t上海凯宝药业股份有限公司\n" +
            "51\t贵州三力制药股份有限公司\n" +
            "52\t精华制药集团股份有限公司\n" +
            "53\t河南太龙药业股份有限公司\n" +
            "54\t重庆希尔安药业有限公司\n" +
            "55\t湖南方盛制药股份有限公司\n" +
            "56\t上海绿谷制药有限公司\n" +
            "57\t中山市中智药业集团有限公司\n" +
            "58\t九信中药集团有限公司\n" +
            "59\t哈尔滨市康隆药业有限责任公司\n" +
            "60\t上海神奇制药投资管理股份有限公司\n" +
            "61\t真奥药业集团有限公司\n" +
            "62\t山东凤凰制药股份有限公司\n" +
            "63\t山西广誉远国药有限公司\n" +
            "64\t特一药业集团股份有限公司\n" +
            "65\t兰州佛慈制药股份有限公司\n" +
            "66\t西安世纪盛康药业有限公司\n" +
            "67\t广西金嗓子有限责任公司\n" +
            "68\t湖南汉森制药股份有限公司\n" +
            "69\t贵阳新天药业股份有限公司\n" +
            "70\t山东沃华医药科技股份有限公司\n" +
            "71\t甘肃陇神戎发药业股份有限公司\n" +
            "72\t吉林华康药业股份有限公司\n" +
            "73\t吉林省集安益盛药业股份有限公司\n" +
            "74\t万邦德医药控股集团股份有限公司\n" +
            "75\t山东孔圣堂药业集团有限公司\n" +
            "76\t成都百裕制药股份有限公司\n" +
            "77\t金花企业(集团)股份有限公司西安金花制药厂\n" +
            "78\t南京圣和药业股份有限公司\n" +
            "79\t江西汇仁药业股份有限公司\n" +
            "80\t广西壮族自治区花红药业集团股份公司\n" +
            "81\t云南植物药业有限公司\n" +
            "82\t陕西汉王药业股份有限公司\n" +
            "83\t天地恒一制药股份有限公司\n" +
            "84\t广东罗浮山国药股份有限公司\n" +
            "85\t陕西盘龙药业集团股份有限公司\n" +
            "86\t安徽九华华源药业有限公司\n" +
            "87\t重庆华森制药股份有限公司\n" +
            "88\t翔宇药业股份有限公司\n" +
            "89\t云南生物谷药业股份有限公司\n" +
            "90\t浙江维康药业股份有限公司\n" +
            "91\t金诃藏药股份有限公司\n" +
            "92\t华佗国药股份有限公司\n" +
            "93\t红云制药集团股份有限公司\n" +
            "94\t广州诺金制药有限公司\n" +
            "95\t启迪药业集团股份公司\n" +
            "96\t贵州威门药业股份有限公司\n" +
            "97\t广东嘉应制药股份有限公司\n" +
            "98\t上海黄海制药有限责任公司\n" +
            "99\t江西百神药业股份有限公司\n" +
            "100\t李时珍医药集团有限公司\n";


    public String qiyeScore(String text) {
        if (containsKeywordWithoutSuffix(baiqiang, text) || containsKeywordWithoutSuffix(laozihao, text)) {
            return "3";
        } else if (containsKeywordWithoutSuffix(zhongyaobaiqiang, text)) {
            return "2";
        } else {
            return "";
        }

    }


    /**
     * 检查文本中是否包含指定字段（去除常见企业后缀后）
     *
     * @param text    要检查的文本
     * @param keyword 要匹配的关键词（企业名称）
     * @return 如果文本包含去除后缀后的关键词，则返回true，否则返回false
     */
    public boolean containsKeywordWithoutSuffix(String text, String keyword) {
        if (StringUtils.isEmpty(text) || StringUtils.isEmpty(keyword)) {
            return false;
        }

        // 定义需要去除的企业名称后缀列表
        String[] suffixes = {
                "制药有限公司",
                "有限公司",
                "药业股份有限公司",
                "药业有限公司",
                "集团股份有限公司",
                "股份有限公司",
                "生物医药科技股份有限公司",
                "中药厂有限公司",
                "生物医药科技有限公司",
                "药业集团有限公司",
                "医药股份有限公司",
                "生物科技有限公司",
                "制药股份有限公司",
                "生物制药有限公司",
                "药业有限责任公司",
                "制药厂有限公司",
                "科技开发有限公司",
                "医药科技有限公司",
                "制药有限责任公司",
                "股份有限公司同仁堂制药厂",
                "有限责任公司",
                "生物股份有限公司制药厂",
                "制药厂",
                "医疗制品有限公司",
                "制药集团有限公司",
                "发展股份有限公司制药厂",
                "生物医药有限公司",
                "生物技术有限公司",
                "生物工程有限公司",
                "生物医药科技有限责任公司",
                "集团股份公司",
                "股份有限公司同仁堂药酒厂",
                "中药厂",
                "股份公司",
                "股份有限公司西安金花制药厂",
                "中药股份有限公司",
                "研究所",
                "生物科技发展有限公司",
                "生物科技股份公司",
                "股份有限公司金山蒙药厂",
                "生物工程技术有限公司",
                "药物研究院",
                "药厂",
                "股份有限公司制药厂",
                "股份有限公司星湖生化制药厂",
                "大药厂",
                "生物医药科技园有限公司"
        };

        // 去除后缀得到核心企业名称
        String coreKeyword = keyword;
        for (String suffix : suffixes) {
            if (keyword.endsWith(suffix)) {
                coreKeyword = keyword.substring(0, keyword.length() - suffix.length());
                break;
            }
        }

        // 检查文本是否包含核心企业名称
        return text.contains(coreKeyword);
    }


    public String getTxt(DrugInfoNew drugInfo, String searchText, String s, String types) {


        try {
            ArrayList<String> strings1 = new ArrayList<>();
            strings1.add(drugInfo.getDrugName());
            ArrayList<String> strings2 = new ArrayList<>();
            String[] split2 = s.split(",");
            for (String split : split2) {
                strings2.add(split);
            }
            List<GuideVO> guideVOS = lxGptService.queryGuideByDrugAndDisease1(strings1, drugInfo.getDrugName(), strings2, strings2.get(0));

            if (CollUtil.isNotEmpty(guideVOS)) {
                String gptTxt = "";
                if (guideVOS != null && guideVOS.size() > 0) {
                    for (GuideVO guideVO : guideVOS) {
                        gptTxt += "标题：" + guideVO.getTitle() + "\n";
                        gptTxt += "发布机构：" + guideVO.getZdz() + "\n";
                        gptTxt += "内容：" + guideVO.getPdf_txt() + "\n";

                    }
                }
                if (gptTxt.length() > 10000) {
                    gptTxt = gptTxt.substring(0, 10000);
                }
                String prompt = "你是一位专业的医药信息分析助手。现在需要你分析关于药品 **{{" + drugInfo.getDrugName() + "}}** 在“" + searchText + "”患者中使用的信息。\n" +
                        "### 任务要求\n" +
                        "请严格根据我提供的 **指南资料** 完成以下三个任务：\n" +
                        "1.  **信息提取：**\n" +
                        "    *   如果资料中包含 **{{" + drugInfo.getDrugName() + "}}** 的 **" + searchText + "患者用药（如年龄限制、剂量、用法、安全性、有效性、禁忌症等）** 的具体描述：\n" +
                        "        *   请返回包含该信息的 **资料标题**。\n" +
                        "        *   请返回发布该资料的 **机构名称**。\n" +
                        "        *   请 **直接引用** 描述儿童用药的关键原文片段（确保引用内容完整、准确反映" + searchText + "患者用药信息）。\n" +
                        "2.  **可用性判断：**\n" +
                        "    *   基于提取的信息，明确判断 **{{" + drugInfo.getDrugName() + "}}** 在 **" + searchText + "患者** 中是否 **可用**。\n" +
                        "    *   如果 **不可用**：\n" +
                        "        *   必须明确指出存在哪些 **具体的使用限制**（例如：禁用年龄段、特定疾病禁忌）或 **特殊的注意事项**（例如：需谨慎使用、需监测特定指标、缺乏数据等）。请清晰列出。\n" +
                        "3.  **信息标注：**\n" +
                        "    *   明确说明 **任务1中提取的信息** 具体来源于哪一篇资料。\n" +
                        "        *   格式：`资料标题 - 发布机构`。\n" +
                        "*   **重要：** 如果你仔细检查了提供的所有资料，确认 **没有任何一篇资料** 包含 **{{" + drugInfo.getDrugName() + "}}** 在 **" + searchText + "患者用药** 方面的具体信息（包括提及但无实质内容），则在任务1、2、3的所有相关位置都返回 `无相关内容`。\n" +
                        "### 输出要求\n" +
                        "*   请按 **任务1、任务2、任务3** 的顺序 **清晰、结构化地输出** 结果。\n" +
                        "*   对于任务1：如果没有相关信息，输出 `无相关内容`。\n" +
                        "*   对于任务2：必须给出明确判断（可用/不可用），如果不可用必须清晰列出限制/注意点。如果没有相关信息，输出 `根据提供资料无法判断`。\n" +
                        "*   对于任务3：明确标注信息来源（资料标题+发布机构）\n" +
                        "*   确保你的回答 **严格基于且仅基于** 提供的指南内容，不要引入外部知识或进行推测。\n" +
                        "### 指南内容\n" +
                        "以下是我提供的官方指南资料内容，请仅基于这些内容进行分析：" +
                        "指南内容：*******" +
                        gptTxt + "*******";

                if (StringUtils.isEmpty(gptTxt)) {
                    return "";
                }

                String gpt = "";
                if (isNew) {
                    gpt = lxGptService.getGpt(prompt, "qwen3-235b-a22b-instruct-2507", "");
                } else {
                    gpt = lxGptService.getGpt(prompt, "gpt-4.1-nano", "");
                }

                if (!gpt.contains("无相关内容")) {
                    return gpt;
                }

            }

            ArrayList<String> drugZhs = new ArrayList<>();
            drugZhs.add(drugInfo.getDrugName());
            StringBuilder stringBuilderx = new StringBuilder();
            StringBuilder stringBuilder1 = PromptUtil.montageForPaper(stringBuilderx, drugZhs, "标题");
            stringBuilder1.append(" AND ");
            ArrayList<String> strings = new ArrayList<>();
            String[] split = s.split(",");
            for (int i = 0; i < split.length; i++) {
                strings.add(split[i]);
            }
            StringBuilder stringBuilder2 = PromptUtil.montageForPaper(stringBuilder1, strings, "");
            JSONObject jsonObject = new JSONObject();
            jsonObject.put("query", stringBuilder2.toString());
            jsonObject.put("type", "1");
            String retrievalStr = formulaFeign.retrieval(jsonObject);
            WrapperQueryBuilder wrapperQueryBuilder = QueryBuilders.wrapperQuery(retrievalStr);
            // ArrayList<String> strings3 = new ArrayList<>();
            BoolQueryBuilder boolQueryBuilder = new BoolQueryBuilder();
            // if (StringUtils.isNotEmpty( types)){
            // String[] split1 = types.split(",");
            // for (int i = 0; i < split1.length; i++) {
            //     strings3.add(split1[i]);
            // }
            // TermsQueryBuilder termQueryBuilder = QueryBuilders.termsQuery("lastNewType",strings3 );
            //     boolQueryBuilder.must().add(termQueryBuilder);
            // }
            boolQueryBuilder.must().add(wrapperQueryBuilder);
            NativeSearchQuery nativeSearchQuery = new NativeSearchQuery(boolQueryBuilder);
            SearchHits<Literature> literatureSearchHits = this.elasticsearchRestTemplate.search(nativeSearchQuery, Literature.class);
            String gptTxt1 = "";
            for (SearchHit<Literature> literatureSearchHit : literatureSearchHits) {
                gptTxt1 += "标题：" + literatureSearchHit.getContent().getTitle() + "\n";
                gptTxt1 += "摘要：" + literatureSearchHit.getContent().getSummary() + "\n";
                gptTxt1 += "内容：" + literatureSearchHit.getContent().getTldr() + "\n";
                gptTxt1 += "作者：" + literatureSearchHit.getContent().getAuthor() + "\n";
            }
            if (gptTxt1.length() > 10000) {
                gptTxt1 = gptTxt1.substring(0, 10000);
            }


            String prompt = "你是一位专业的医药信息分析助手。现在需要你分析关于药品 **{{" + drugInfo.getDrugName() + "}}** 在“" + searchText + "”患者中使用的信息。\n" +
                    "### 任务要求\n" +
                    "请严格根据我提供的 **指南资料** 完成以下三个任务：\n" +
                    "1.  **信息提取：**\n" +
                    "    *   如果资料中包含 **{{" + drugInfo.getDrugName() + "}}** 的 **" + searchText + "患者用药（如年龄限制、剂量、用法、安全性、有效性、禁忌症等）** 的具体描述：\n" +
                    "        *   请返回包含该信息的 **资料标题**。\n" +
                    "        *   请返回发布该资料的 **机构名称**。\n" +
                    "        *   请 **直接引用** 描述儿童用药的关键原文片段（确保引用内容完整、准确反映" + searchText + "患者用药信息）。\n" +
                    "2.  **可用性判断：**\n" +
                    "    *   基于提取的信息，明确判断 **{{" + drugInfo.getDrugName() + "}}** 在 **" + searchText + "患者** 中是否 **可用**。\n" +
                    "    *   如果 **不可用**：\n" +
                    "        *   必须明确指出存在哪些 **具体的使用限制**（例如：禁用年龄段、特定疾病禁忌）或 **特殊的注意事项**（例如：需谨慎使用、需监测特定指标、缺乏数据等）。请清晰列出。\n" +
                    "3.  **信息标注：**\n" +
                    "    *   明确说明 **任务1中提取的信息** 具体来源于哪一篇资料。\n" +
                    "        *   格式：`资料标题 - 发布机构`。\n" +
                    "*   **重要：** 如果你仔细检查了提供的所有资料，确认 **没有任何一篇资料** 包含 **{{" + drugInfo.getDrugName() + "}}** 在 **" + searchText + "患者用药** 方面的具体信息（包括提及但无实质内容），则在任务1、2、3的所有相关位置都返回 `无相关内容`。\n" +
                    "### 输出要求\n" +
                    "*   请按 **任务1、任务2、任务3** 的顺序 **清晰、结构化地输出** 结果。\n" +
                    "*   对于任务1：如果没有相关信息，输出 `无相关内容`。\n" +
                    "*   对于任务2：必须给出明确判断（可用/不可用），如果不可用必须清晰列出限制/注意点。如果没有相关信息，输出 `根据提供资料无法判断`。\n" +
                    "*   对于任务3：明确标注信息来源（资料标题+发布机构）\n" +
                    "*   确保你的回答 **严格基于且仅基于** 提供的指南内容，不要引入外部知识或进行推测。\n" +
                    "### 指南内容\n" +
                    "以下是我提供的官方指南资料内容，请仅基于这些内容进行分析：" +
                    "指南内容：*******" +
                    gptTxt1 + "*******";

            if (prompt.length() > 10000) {
                prompt = prompt.substring(0, 10000);
            }

            String gpt = "";
            if (isNew) {
                gpt = lxGptService.getGpt(prompt, "qwen3-235b-a22b-instruct-2507", "");
            } else {
                gpt = lxGptService.getGpt(prompt, "gpt-4.1-nano", "");
            }

            if (!gpt.contains("无相关内容")) {
                return gpt;
            }
        } catch (Exception e) {
            log.error("获取特殊人群用法异常", e);
        }
        return "";
    }


    public String getAllDrugContentLists(JSONObject drugInst, String search) {
        List<DrugContent> result = new ArrayList<>();

        if (ObjectUtil.isEmpty(drugInst)){
            return "";
        }
        // 获取JSONObject中所有的键
        Set<String> keys = drugInst.keySet();

        for (String key : keys) {
            try {
                // 获取键对应的值

                Object value = drugInst.get(key);
                // 检查值是否为JSONArray（对应原List）
                if (value instanceof ArrayList) {
                    JSONArray jsonArray = drugInst.getJSONArray(key);


                    // 遍历JSONArray中的元素
                    for (int i = 0; i < jsonArray.size(); i++) {
                        Object element = jsonArray.get(i);

                        // 检查元素是否为DrugContent（假设可以从JSONObject转换）
                        if (element instanceof Map) {
                            // 假设存在一个方法可以将JSONObject转换为DrugContent
                            DrugContent drugContent = convertJsonToDrugContent((Map) element);
                            result.add(drugContent);
                        }
                    }
                }
            } catch (JSONException e) {
                // 处理JSON解析异常
                e.printStackTrace();
            }
        }

        StringBuilder stringBuilder = new StringBuilder();
        // 支持多个关键词，只要包含其中一个就追加
        String[] keywords = search.split(","); // 假设关键词以逗号分隔

        for (DrugContent drugContent : result) {
            if ("text".equals(drugContent.getTag())) {
                String content = drugContent.getContent().toString();
                for (String keyword : keywords) {
                    if (content.contains(keyword)) {
                        stringBuilder.append(content);
                        break; // 避免重复添加同一内容
                    }
                }
            }
        }

        return stringBuilder.toString();
    }

    // 需要实现的辅助方法：将JSONObject转换为DrugContent对象
    private DrugContent convertJsonToDrugContent(Map jsonObject) throws JSONException {
        // 根据实际的DrugContent类结构进行转换
        DrugContent drugContent = new DrugContent();
        // 示例：假设DrugContent有tag和content字段
        drugContent.setTag((String) jsonObject.get("tag"));
        drugContent.setContent(jsonObject.get("content"));
        // 添加其他字段的转换逻辑
        return drugContent;
    }
}