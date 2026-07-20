package com.sentum.excel.manager;

import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import com.sentum.excel.bean.DrugInfoExcelBean;
import com.sentum.pojo.DrugAndIndicationIndex;
import com.sentum.pojo.DrugInfo;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.elasticsearch.core.ElasticsearchRestTemplate;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

import static com.lowagie.text.xml.simpleparser.EntitiesToUnicode.map;

/**
 * @Description:
 */
@Slf4j
@Component
public class DrugInfoImportManager {
    
    private final MongoTemplate mongoTemplate;
    private final ElasticsearchRestTemplate elasticsearchRestTemplate;
    
    public DrugInfoImportManager(MongoTemplate mongoTemplate, ElasticsearchRestTemplate elasticsearchRestTemplate) {
        this.mongoTemplate = mongoTemplate;
        this.elasticsearchRestTemplate = elasticsearchRestTemplate;
    }
    
    public void saveDrugInfo(List<DrugInfoExcelBean> drugExcelBeanInfos) {
        // 导入的数据量
        int size = drugExcelBeanInfos.size();
        //mongo
        List<DrugInfo> drugInfos = new ArrayList<>();
        //es
        List<DrugAndIndicationIndex> indexList = new ArrayList<>();
        int num = 0;
        long startTime = System.currentTimeMillis();
        if (CollUtil.isNotEmpty(drugExcelBeanInfos)) {
//            drugExcelBeanInfos.forEach(drugInfoExcelBean -> {
            
            for (DrugInfoExcelBean drugInfoExcelBean : drugExcelBeanInfos) {
                DrugInfo drugInfo = new DrugInfo();
                DrugAndIndicationIndex index = new DrugAndIndicationIndex();
                String id = UUID.randomUUID().toString();
                drugInfo.setId(id);
                index.setId(id);
                
                //产品名称
                String drugName = drugInfoExcelBean.getDrugName();
                if (StrUtil.isBlank(drugName)) {
                    continue;
                }
                drugInfo.setDrugName(drugName);
                index.setZhDrugName(drugName);
                
                List<String> symbolList = Arrays.asList("-", "--", "---", "----", "-----", "------", "－－－－", "—", "——", "————", "/");
                //剂型
                String dosageForm = drugInfoExcelBean.getDosageForm();
                if (StrUtil.isNotBlank(dosageForm)) {
                    if (CollUtil.contains(symbolList, dosageForm)) {
                        dosageForm = "";
                    }
                }
                drugInfo.setDosageForm(dosageForm);
                index.setDosageForm(dosageForm);
                
                //药品厂家
                String manufacturer = drugInfoExcelBean.getManufacturer();
                if (StrUtil.isBlank(manufacturer)) {
                    manufacturer = "";
                }
                drugInfo.setManufacturer(manufacturer);
                index.setManufacturer(manufacturer);

                //国药准字/注册账号
                String register = drugInfoExcelBean.getRegister();
                if (StrUtil.isBlank(register)) {
                    register = "";
                }
                drugInfo.setRegister(register);
                
                //药品规格
                String specifications = drugInfoExcelBean.getSpecifications();
                if (StrUtil.isBlank(specifications)) {
                    specifications = "";
                }
                if (CollUtil.contains(symbolList, specifications)) {
                    specifications = "";
                }
                drugInfo.setSpecifications(specifications);
                index.setSpecifications(specifications);
                
                // 商品名添加
                String commodityNameZh = drugInfoExcelBean.getCommodityNameZh();
                if (StrUtil.isBlank(commodityNameZh)) {
                    commodityNameZh = "";
                }
                index.setCommodityNameZh(commodityNameZh);
                drugInfo.setCommunityNameZh(commodityNameZh);
                
                String commodityNameEn = drugInfoExcelBean.getCommodityNameEn();
                if (StrUtil.isBlank(commodityNameEn)) {
                    commodityNameEn = "";
                }
                index.setCommodityNameEn(commodityNameEn);
                drugInfo.setCommunityNameEn(commodityNameEn);

                //一级到四级的中英文
                String oneNameZh = drugInfoExcelBean.getOneNameZh();
                if (StrUtil.isBlank(oneNameZh)){
                    oneNameZh = "";
                }
                drugInfo.setOneNameZh(oneNameZh);
                
                String oneNameEn = drugInfoExcelBean.getOneNameEn();
                if (StrUtil.isBlank(oneNameEn)){
                    oneNameEn = "";
                }
                drugInfo.setOneNameEn(oneNameEn);

                String twoNameZh = drugInfoExcelBean.getTwoNameZh();
                if (StrUtil.isBlank(twoNameZh)){
                    twoNameZh = "";
                }
                drugInfo.setTwoNameZh(twoNameZh);

                String twoNameEn= drugInfoExcelBean.getTwoNameEn();
                if (StrUtil.isBlank(twoNameEn)){
                    twoNameEn = "";
                }
                drugInfo.setTwoNameEn(twoNameEn);

                String threeNameZh = drugInfoExcelBean.getThreeNameZh();
                if (StrUtil.isBlank(threeNameZh)){
                    threeNameZh = "";
                }
                drugInfo.setThreeNameZh(threeNameZh);

                String threeNameEn = drugInfoExcelBean.getThreeNameEn();
                if (StrUtil.isBlank(threeNameEn)){
                    threeNameEn = "";
                }
                drugInfo.setThreeNameEn(threeNameEn);

                String fourNameZh = drugInfoExcelBean.getFourNameZh();
                if (StrUtil.isBlank(fourNameZh)){
                    fourNameZh = "";
                }
                drugInfo.setFourNameZh(fourNameZh);

                String fourNameEn = drugInfoExcelBean.getFourNameEn();
                if (StrUtil.isBlank(fourNameEn)){
                    fourNameEn = "";
                }
                drugInfo.setFourNameEn(fourNameEn);
                
                //五级编码
                String fiveCoding = drugInfoExcelBean.getFiveCoding();
                if (StrUtil.isBlank(fiveCoding)){
                    fiveCoding = "";
                }
                drugInfo.setFiveCoding(fiveCoding);
                
                //es药品检索
                List<String> drugNames = new ArrayList<>();
                //检索字段
                drugNames.add(drugName.toLowerCase());
                List<String> zhDrugNames = new ArrayList<>();
                List<String> enDrugNames = new ArrayList<>();
                //五级英文
                String drugEn = drugInfoExcelBean.getDrugEn();
                if (StrUtil.isBlank(drugEn)){
                    drugEn = "";
                }
                drugInfo.setDrugEn(drugEn);
                if (StrUtil.isNotBlank(drugEn)){
                    drugNames.add(drugEn.toLowerCase());
                    enDrugNames.add(drugEn.toLowerCase());
                }
                //五级英文同义词
                List<String> drugSynonymEnList = new ArrayList<>();
                String drugSynonymEn = drugInfoExcelBean.getDrugSynonymEn();
                if (StrUtil.isNotBlank(drugSynonymEn)){
                    String[] split = drugSynonymEn.split("卍");
                    drugSynonymEnList.addAll(Arrays.asList(split));
                }
                drugInfo.setDrugSynonymEn(drugSynonymEnList);
                if (CollUtil.isNotEmpty(drugSynonymEnList)){
                    for (String s : drugSynonymEnList) {
                        drugNames.add(s.toLowerCase());
                        drugNames.add(s);
                    }
                }
                //五级中文
                String drugZh = drugInfoExcelBean.getDrugZh();
                if (StrUtil.isBlank(drugZh)){
                    drugZh = "";
                }
                drugInfo.setDrugZh(drugZh);
                if (StrUtil.isNotBlank(drugZh)){
                    drugNames.add(drugZh.toLowerCase());
                    zhDrugNames.add(drugZh.toLowerCase());
                }
                //五级中文同义词
                List<String> drugSynonymZhList = new ArrayList<>();
                String drugSynonymZh = drugInfoExcelBean.getDrugSynonymZh();
                if (StrUtil.isNotBlank(drugSynonymZh)){
                    String[] split = drugSynonymZh.split("卍");
                    drugSynonymZhList.addAll(Arrays.asList(split));
                }
                drugInfo.setDrugSynonymZh(drugSynonymZhList);
                if (CollUtil.isNotEmpty(drugSynonymZhList)){
                    for (String s : drugSynonymZhList) {
                        drugNames.add(s);
                        drugNames.add(s.toLowerCase());
                    }
                }
                index.setDrugName(drugNames);
                index.setZhDrugNames(zhDrugNames);
                index.setEnDrugNames(enDrugNames);

                //医保情况
                String medicalInsurance = drugInfoExcelBean.getMedicalInsurance();
                if (StrUtil.isBlank(medicalInsurance)) {
                    medicalInsurance = "";
                }
                drugInfo.setMedicalInsurance(medicalInsurance);
                index.setMedicalInsurance(medicalInsurance);
                
                //支付范围
                String paymentScope = drugInfoExcelBean.getPaymentScope();
                if (StrUtil.isBlank(paymentScope)) {
                    paymentScope = "";
                }
                drugInfo.setPaymentScope(paymentScope);
                
                //是否是国家基本药物
                String essentialMedicines = drugInfoExcelBean.getEssentialMedicines();
                if (StrUtil.isBlank(essentialMedicines)) {
                    essentialMedicines = "";
                }
                drugInfo.setEssentialMedicines(essentialMedicines);
                
                //是否有△要求
                String essentialType = drugInfoExcelBean.getEssentialType();
                if (StrUtil.isBlank(essentialType)) {
                    essentialType = "";
                }
                drugInfo.setEssentialType(essentialType);
                
                //适应症
                String indication = drugInfoExcelBean.getIndication();
                if (StrUtil.isBlank(indication)) {
                    indication = "";
                }
                drugInfo.setIndication(indication);
                if (StrUtil.isNotBlank(indication)) {
                    index.setIndication(indication);
                }

                List<String> disease = new ArrayList<>();
                //中文疾病名称
                List<String> diseaseZh = new ArrayList<>();
                String indicationZh = drugInfoExcelBean.getIndicationZh();
                if (StrUtil.isNotBlank(indicationZh)){
                    String[] split = indicationZh.split("###");
                    for (String txt : split) {
                        if (!"-".equals(txt)){
                            diseaseZh.add(txt);
                        }
                    }
                }
                drugInfo.setDiseaseZh(diseaseZh);
                index.setDiseaseZh(diseaseZh);
                if (CollUtil.isNotEmpty(diseaseZh)){
                    disease.addAll(diseaseZh);
                }
                
                //英文疾病名称
                List<String> diseaseEn = new ArrayList<>();
                drugInfo.setDiseaseEn(diseaseEn);
                index.setDiseaseEn(diseaseEn);
                if (CollUtil.isNotEmpty(diseaseEn)){
                    disease.addAll(diseaseEn);
                }
                
                //疾病同义词
                List<String> diseaseSynonym = new ArrayList<>();
                drugInfo.setDiseaseSynonym(diseaseSynonym);
                index.setDisease(disease);
                if (CollUtil.isNotEmpty(diseaseSynonym)){
                    disease.addAll(diseaseSynonym);
                }
                
                //皮试情况
                String skinTest = drugInfoExcelBean.getSkinTest();
                if (StrUtil.isBlank(skinTest)) {
                    skinTest = "";
                }
                drugInfo.setSkinTest(skinTest);
                
                //集中采药情况
                String drugCollection = drugInfoExcelBean.getDrugCollection();
                if (StrUtil.isBlank(drugCollection)) {
                    drugCollection = "";
                }
                drugInfo.setDrugCollection(drugCollection);
        
                // 药学特性部分
                // 药理作用 -- 药理作用
                String pharmacology = drugInfoExcelBean.getPharmacology();
                if (StrUtil.isBlank(pharmacology)) {
                    pharmacology = "";
                }
                drugInfo.setPharmacology(pharmacology);
                
                // 药代动力学 -- 体内过程
                String pharmacokinetics = drugInfoExcelBean.getPharmacokinetics();
                if (StrUtil.isBlank(pharmacokinetics)) {
                    pharmacokinetics = "";
                }
                drugInfo.setPharmacokinetics(pharmacokinetics);
                
                // 用法用量 -- 药剂学与使用方法
                String usageAndDosage = drugInfoExcelBean.getUsageAndDosage();
                if (StrUtil.isBlank(usageAndDosage)) {
                    usageAndDosage = "";
                }else {
                    index.setUsageAndDosage(usageAndDosage);
                }
                drugInfo.setUsageAndDosage(usageAndDosage);

                
                // 贮藏 -- 贮藏条件
                String storage = drugInfoExcelBean.getStorage();
                if (StrUtil.isBlank(storage)) {
                    storage = "";
                }
                drugInfo.setStorage(storage);
                
                // 有效期 -- 有效期
                String indate = drugInfoExcelBean.getIndate();
                if (StrUtil.isBlank(indate)) {
                    indate = "";
                }
                drugInfo.setIndate(indate);
        
                // 有效性部分
                // 主治/适应症
                String indications = drugInfoExcelBean.getIndications();
                if (StrUtil.isBlank(indications)) {
                    indications = "";
                }
                drugInfo.setIndications(indications);
        
                // 安全性部分
                // 不良反应
                String adverseReaction = drugInfoExcelBean.getAdverseReaction();
                if (StrUtil.isBlank(adverseReaction)) {
                    adverseReaction = "";
                }else {
                    index.setAdverseReaction(adverseReaction);
                }
                drugInfo.setAdverseReaction(adverseReaction);

                // 孕妇及哺乳期妇女
                String pregnantWomen = drugInfoExcelBean.getPregnantWomen();
                if (StrUtil.isBlank(pregnantWomen)) {
                    pregnantWomen = "";
                }
                drugInfo.setPregnantWomen(pregnantWomen);
                // 儿童用药
                String childrenMedicine = drugInfoExcelBean.getChildrenMedicine();
                if (StrUtil.isBlank(childrenMedicine)) {
                    childrenMedicine = "";
                }
                drugInfo.setChildrenMedicine(childrenMedicine);
                // 老年用药
                String geriatricMedicine = drugInfoExcelBean.getGeriatricMedicine();
                if (StrUtil.isBlank(geriatricMedicine)) {
                    geriatricMedicine = "";
                }
                drugInfo.setGeriatricMedicine(geriatricMedicine);
                // 药物相互作用
                String drugInteraction = drugInfoExcelBean.getDrugInteraction();
                if (StrUtil.isBlank(drugInteraction)) {
                    drugInteraction = "";
                }
                drugInfo.setDrugInteraction(drugInteraction);
        
                // 其他属性
                // 原研药
                String originalDrug = drugInfoExcelBean.getOriginalDrug();
                if (StrUtil.isBlank(originalDrug)) {
                    originalDrug = "";
                }
                drugInfo.setOriginalDrug(originalDrug);
                // 参比药品
                String referenceDrug = drugInfoExcelBean.getReferenceDrug();
                if (StrUtil.isBlank(referenceDrug)) {
                    referenceDrug = "";
                }
                drugInfo.setReferenceDrug(referenceDrug);
                // 一致性评价药品
                String consistencyDrug = drugInfoExcelBean.getConsistencyDrug();
                if (StrUtil.isBlank(consistencyDrug)) {
                    consistencyDrug = "";
                }
                drugInfo.setConsistencyDrug(consistencyDrug);
        
                // 成分
                String ingredient = drugInfoExcelBean.getIngredient();
                if (StrUtil.isBlank(ingredient)) {
                    ingredient = "";
                }
                drugInfo.setIngredient(ingredient);

                //注意事项
                String notes = drugInfoExcelBean.getNotes();
                if (StrUtil.isBlank(notes)){
                    notes = "";
                }
                drugInfo.setNotes(notes);

                //禁忌
                String taboo = drugInfoExcelBean.getTaboo();
                if (StrUtil.isBlank(taboo)){
                    taboo = "";
                }
                drugInfo.setTaboo(taboo);

                //单位
                String unit = drugInfoExcelBean.getUnit();
                if (StrUtil.isBlank(unit)){
                    unit = "";
                }
                drugInfo.setUnit(unit);

                //单位价格
                String unitPrice = drugInfoExcelBean.getUnitPrice();
                if (StrUtil.isBlank(unitPrice)){
                    unitPrice = "";
                }
                drugInfo.setUnitPrice(unitPrice);

                //价格
                String price = drugInfoExcelBean.getPrice();
                if (StrUtil.isBlank(price)){
                    price = "";
                }
                drugInfo.setPrice(price);

                //转换比
                String ratio = drugInfoExcelBean.getRatio();
                if (StrUtil.isBlank(ratio)){
                    ratio = "";
                }
                drugInfo.setRatio(ratio);

                //集采药品中标价格（元）
                String outbidPrice = drugInfoExcelBean.getOutbidPrice();
                if (StrUtil.isBlank(outbidPrice)){
                    outbidPrice = "";
                }
                drugInfo.setOutbidPrice(outbidPrice);

                //包装
                String pack = drugInfoExcelBean.getPack();
                if (StrUtil.isBlank(pack)){
                    pack = "";
                }
                drugInfo.setPack(pack);


                //规格-说明书的
                String specificationsIns = drugInfoExcelBean.getSpecificationsIns();
                if (StrUtil.isBlank(specificationsIns)){
                    specificationsIns = "";
                }
                drugInfo.setSpecificationsIns(specificationsIns);

                String insSource = drugInfoExcelBean.getInsSource();
                if (StrUtil.isBlank(insSource)){
                    insSource = "";
                }
                drugInfo.setInsSource(insSource);

                String drugType = drugInfoExcelBean.getDrugType();
                if (StrUtil.isBlank(drugType)){
                    drugType = "";
                }
                drugInfo.setDrugType(drugType);

                //增加中英文对照拼接词
                List<String> zhAndEn = new ArrayList<>();
//                if (CollectionUtil.isNotEmpty(diseaseZh)){
//                    for (int i1 = 0; i1 < diseaseZh.size(); i1++) {
//                        String zh = diseaseZh.get(i1);
//                        if (i1 < diseaseEn.size()) {
//                            String en = diseaseEn.get(i1);
//                            zhAndEn.add(zh + "=" + en);
//                        }else {
//                            zhAndEn.add(zh);
//                        }
//                    }
//                }

                index.setZhAndEn(zhAndEn);
                drugInfos.add(drugInfo);
                indexList.add(index);
                num++;
                if (num%500 == 0 || num == size){
                    log.info("第[{}]写入500条数据", num/500);
                    if (num == size){
                        log.info("写入完成");
                    }
                    mongoTemplate.insert(drugInfos, DrugInfo.class);
                    elasticsearchRestTemplate.save(indexList);
                    //mongo
                    drugInfos = new ArrayList<>();
                    //es
                    indexList = new ArrayList<>();
                }
            };
            log.info("共用时[{}]", System.currentTimeMillis() - startTime);
        }
        
    }
}
